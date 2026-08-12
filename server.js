'use strict'

const path = require('node:path')
const fs = require('node:fs')
const http = require('node:http')
const crypto = require('node:crypto')

const express = require('express')
const { WebSocketServer } = require('ws')
const dotenv = require('dotenv')
const tdl = require('tdl')
const { getTdjson } = require('prebuilt-tdlib')
const packMedia = require('./packMedia')
const packSelected = require('./packSelected')

dotenv.config()

const ROOT = __dirname
const CONFIG_PATH = path.join(ROOT, 'config.json')
const SETTINGS_PATH = path.join(ROOT, 'settings.json')
const DEFAULT_DOWNLOADS_DIR = path.join(ROOT, 'downloads')
let downloadsDir = DEFAULT_DOWNLOADS_DIR
let thumbsDir = null
const DB_DIR = path.join(ROOT, '.td_database')
const FILES_DIR = path.join(ROOT, '.td_files')
const MANAGEMENT_UPLOAD_DIR = path.join(ROOT, '.management_uploads')

function loadSettings () {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'))
    if (s && s.downloadsDir) downloadsDir = path.resolve(String(s.downloadsDir))
  } catch {}
  thumbsDir = path.join(downloadsDir, '.thumbs')
}

function saveSettings () {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify({ downloadsDir }, null, 2))
}

loadSettings()
fs.mkdirSync(downloadsDir, { recursive: true })
fs.mkdirSync(thumbsDir, { recursive: true })
fs.mkdirSync(MANAGEMENT_UPLOAD_DIR, { recursive: true })

const PORT = Number(process.env.PORT || 3000)
let CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 8))

let client = null
let ready = false
let authState = null
let lastChatOffset = { order: '9223372036854775807', chat_id: 0 }

const senderCache = new Map()
const thumbCache = new Map()
const pendingThumbs = new Map()
const webSockets = new Set()

function loadConfig () {
  const env = {
    apiId: process.env.API_ID ? Number(process.env.API_ID) : null,
    apiHash: process.env.API_HASH || null
  }
  if (env.apiId && env.apiHash) return env
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    if (c.apiId && c.apiHash) return { apiId: Number(c.apiId), apiHash: String(c.apiHash) }
  } catch {}
  return null
}

function saveConfig (apiId, apiHash) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ apiId: Number(apiId), apiHash: String(apiHash) }, null, 2))
}

function sanitize (name) {
  return String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\.+$/g, '')
    .trim()
    .slice(0, 120) || 'file'
}

function uniquePath (dir, name) {
  let p = path.join(dir, name)
  let i = 1
  while (fs.existsSync(p)) {
    const ext = path.extname(name)
    const base = path.basename(name, ext)
    p = path.join(dir, `${base} (${i})${ext}`)
    i++
  }
  return p
}

/* ------------------------------ WebSocket helpers ------------------------------ */

function send (ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
}

function sendAll (msg) {
  for (const ws of webSockets) send(ws, msg)
}

function respond (ws, id, ok, data, error) {
  send(ws, { type: 'response', id, ok, data, error: error || null })
}

/* ------------------------------ Download manager ------------------------------ */

class DownloadManager {
  constructor () {
    this.jobs = new Map()
    this.activeCount = 0
    this.lastEmit = new Map()
  }

  add (chatId, chatTitle, messageId, fileId, fileName, fileSize) {
    if (!fileId) throw new Error('No file id')
    const jobId = crypto.randomUUID()
    const job = {
      jobId,
      chatId,
      chatTitle,
      messageId,
      fileId,
      fileName,
      fileSize: fileSize || 0,
      status: 'queued',
      downloaded: 0,
      speed: 0,
      error: null,
      destPath: null,
      active: false
    }
    this.jobs.set(jobId, job)
    this.tryRun()
    return jobId
  }

  tryRun () {
    while (this.activeCount < CONCURRENCY) {
      const next = [...this.jobs.values()].find(j => j.status === 'queued')
      if (!next) break
      this.activeCount++
      this.startJob(next)
    }
  }

  async startJob (job) {
    job.status = 'downloading'
    job.active = true
    this.emitJob(job)
    try {
      const fileInfo = await client.invoke({ _: 'getFile', file_id: job.fileId }).catch(() => null)
      if (fileInfo && (fileInfo.size || fileInfo.expected_size)) {
        job.fileSize = fileInfo.size || fileInfo.expected_size
        this.emitJob(job)
      }
      const res = await client.invoke({
        _: 'downloadFile',
        file_id: job.fileId,
        priority: 32, // Increase priority to max
        offset: 0,
        limit: 0,
        synchronous: false
      })
      if (job.status === 'paused') return
      const local = res && res.local
      if (local && local.is_downloading_completed && local.path) {
        job.downloaded = job.fileSize || local.downloaded_size || 0
        this.finalize(job, local.path)
      }
    } catch (e) {
      if (job.status === 'paused') return
      job.status = 'error'
      job.error = String(e.message || e)
      this.finishJob(job)
      this.emitJob(job)
    }
  }

  onFileUpdate (file) {
    if (!file || !file.id) return
    for (const job of this.jobs.values()) {
      if (job.fileId !== file.id) continue
      const local = file.local || {}
      if (job.status === 'paused' || job.status === 'cancelled') continue
      if (local.is_downloading_active) {
        job.downloaded = local.downloaded_size || 0
        const now = Date.now()
        const last = this.lastEmit.get(job.jobId) || 0
        if (now - last > 250) {
          this.lastEmit.set(job.jobId, now)
          this.emitJob(job)
        }
        continue
      }
      if (local.is_downloading_completed && local.path && job.status === 'downloading') {
        job.downloaded = job.fileSize || local.downloaded_size || 0
        this.finalize(job, local.path)
      }
    }
  }

  async finalize (job, srcPath) {
    try {
      const chatFolder = path.join(downloadsDir, sanitize(job.chatTitle))
      fs.mkdirSync(chatFolder, { recursive: true })
      const dest = uniquePath(chatFolder, sanitize(job.fileName))
      await fs.promises.rename(srcPath, dest).catch(async () => {
        await fs.promises.copyFile(srcPath, dest)
        await fs.promises.unlink(srcPath).catch(() => {})
      })
      job.destPath = dest
      job.status = 'done'
    } catch (e) {
      job.status = 'error'
      job.error = String(e.message || e)
    }
    this.finishJob(job)
    this.emitJob(job)
  }

  finishJob (job) {
    if (job.active) {
      job.active = false
      this.activeCount = Math.max(0, this.activeCount - 1)
      this.tryRun()
    }
  }

  pause (jobId) {
    const job = this.jobs.get(jobId)
    if (!job || (job.status !== 'queued' && job.status !== 'downloading')) return false
    job.status = 'paused'
    if (job.active) {
      client.invoke({ _: 'cancelDownloadFile', file_id: job.fileId, only_if_pending: false }).catch(() => {})
      this.finishJob(job)
    }
    this.emitJob(job)
    return true
  }

  resume (jobId) {
    const job = this.jobs.get(jobId)
    if (!job || job.status !== 'paused') return false
    job.status = 'queued'
    this.tryRun()
    this.emitJob(job)
    return true
  }

  pauseAll () {
    const ids = [...this.jobs.values()].filter(j => j.status === 'queued' || j.status === 'downloading').map(j => j.jobId)
    for (const id of ids) this.pause(id)
    return ids.length
  }

  resumeAll () {
    const ids = [...this.jobs.values()].filter(j => j.status === 'paused').map(j => j.jobId)
    for (const id of ids) this.resume(id)
    return ids.length
  }

  cancelAll () {
    const ids = [...this.jobs.values()]
      .filter(j => j.status === 'queued' || j.status === 'downloading' || j.status === 'paused')
      .map(j => j.jobId)
    for (const id of ids) this.cancel(id)
    return ids.length
  }

  cancel (jobId) {
    const job = this.jobs.get(jobId)
    if (!job) return false
    if (job.status === 'queued' || job.status === 'downloading' || job.status === 'paused') {
      job.status = 'cancelled'
      if (job.active) {
        client.invoke({ _: 'cancelDownloadFile', file_id: job.fileId, only_if_pending: false }).catch(() => {})
        this.finishJob(job)
      }
      this.emitJob(job)
      return true
    }
    return false
  }

  remove (jobId) {
    return this.jobs.delete(jobId)
  }

  emitJob (job) {
    const { destPath, ...rest } = job
    sendAll({ type: 'event', event: { name: 'download-update', job: rest } })
    if (job.status === 'done') {
      sendAll({ type: 'event', event: { name: 'download-done', job: { ...rest, destPath: destPath.replace(downloadsDir, '').replace(/\\/g, '/') } } })
    }
  }

  snapshot () {
    const out = []
    for (const job of this.jobs.values()) {
      out.push({ ...job, destPath: job.destPath ? job.destPath.replace(downloadsDir, '').replace(/\\/g, '/') : null })
    }
    return out
  }
}

const dm = new DownloadManager()

/* ------------------------------ Native forward manager ------------------------------ */

const forwardHistory = new Set()

function normalizeMessageIds (ids) {
  const out = []
  const seen = new Set()
  for (const raw of ids || []) {
    const id = String(raw || '').trim()
    if (!/^\d+$/.test(id) || id === '0' || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

async function resolveDestinationChat (destination) {
  if (!client || !ready) throw new Error('Telegram session is not ready')

  if (destination && destination.chatId != null) {
    const chatId = destination.chatId
    const chat = await client.invoke({ _: 'getChat', chat_id: chatId })
    return { id: chat.id, title: chat.title || 'Destination' }
  }

  const query = String(destination && (destination.username || destination.query) || '').trim()
  if (!query) throw new Error('Choose a destination chat')

  const username = query.replace(/^@/, '')
  if (username) {
    const publicChat = await client.invoke({ _: 'searchPublicChat', username }).catch(() => null)
    if (publicChat && publicChat.id) return { id: publicChat.id, title: publicChat.title || '@' + username }
  }

  const local = await client.invoke({ _: 'searchChats', query, limit: 50 }).catch(() => null)
  for (const chatId of (local && local.chat_ids) || []) {
    const chat = await client.invoke({ _: 'getChat', chat_id: chatId }).catch(() => null)
    if (!chat) continue
    const title = String(chat.title || '')
    const usernames = chat.usernames && chat.usernames.active_usernames ? chat.usernames.active_usernames : []
    if (title.toLowerCase() === query.toLowerCase() || usernames.some(u => String(u).toLowerCase() === username.toLowerCase())) {
      return { id: chat.id, title: title || query }
    }
  }

  throw new Error('Destination chat not found')
}

async function forwardMessagesNative (sourceChatId, messageIds, destination) {
  if (!client || !ready) throw new Error('Telegram session is not ready')
  if (sourceChatId == null) throw new Error('Source chat is required')

  const ids = normalizeMessageIds(messageIds)
  if (!ids.length) throw new Error('Select at least one message to forward')
  const dest = await resolveDestinationChat(destination)
  if (String(dest.id) === String(sourceChatId)) throw new Error('Choose a different destination chat')

  const fresh = []
  const skipped = []
  for (const messageId of ids) {
    const dedupeKey = String(sourceChatId) + ':' + messageId + ':' + String(dest.id)
    if (forwardHistory.has(dedupeKey)) skipped.push(messageId)
    else fresh.push(messageId)
  }

  if (!fresh.length) {
    return { destination: dest, forwarded: [], skipped, messages: [] }
  }

  // TDLib's native forwardMessages preserves Telegram-native forwarding semantics
  // for both text and media. No download/re-upload path is involved.
  const result = await client.invoke({
    _: 'forwardMessages',
    chat_id: dest.id,
    from_chat_id: sourceChatId,
    message_ids: fresh,
    options: { _: 'messageSendOptions', disable_notification: false, from_background: false, protect_content: false },
    send_copy: false,
    remove_caption: false
  })

  const forwardedMessages = (result && result.messages) || []
  for (const messageId of fresh) {
    forwardHistory.add(String(sourceChatId) + ':' + messageId + ':' + String(dest.id))
  }

  sendAll({
    type: 'event',
    event: {
      name: 'forward-done',
      payload: {
        sourceChatId,
        destination: dest,
        forwarded: fresh,
        skipped,
        destinationMessageIds: forwardedMessages.map(m => m && m.id).filter(Boolean)
      }
    }
  })

  return { destination: dest, forwarded: fresh, skipped, messages: forwardedMessages }
}

/* ------------------------------ Media packer ------------------------------ */

let packState = null // { active, cancelled }

function startPack () {
  if (packState && packState.active) return false
  packState = { active: true, cancelled: false }
  packMedia.run(
    downloadsDir,
    (payload) => sendAll({ type: 'event', event: { name: 'pack-progress', payload } }),
    () => packState.cancelled
  )
    .then(result => {
      packState.active = false
      if (result.cancelled) {
        sendAll({ type: 'event', event: { name: 'pack-error', error: 'Packing cancelled' } })
      } else {
        sendAll({ type: 'event', event: { name: 'pack-done', payload: { zips: result.zips, removed: result.removed } } })
      }
    })
    .catch(e => {
      packState.active = false
      sendAll({ type: 'event', event: { name: 'pack-error', error: String(e.message || e) } })
    })
  return true
}

function startPackSelected (items, chatTitle) {
  if (packState && packState.active) return false
  packState = { active: true, cancelled: false }
  packSelected.runPack({
    client: client,
    items,
    chatTitle: chatTitle || 'files',
    downloadsDir,
    onProgress: (payload) => sendAll({ type: 'event', event: { name: 'pack-progress', payload } }),
    isCancelled: () => packState.cancelled
  })
    .then(result => {
      packState.active = false
      if (result.cancelled) {
        sendAll({ type: 'event', event: { name: 'pack-error', error: 'Packing cancelled' } })
      } else {
        sendAll({ type: 'event', event: { name: 'pack-done', payload: { zips: result.zips, removed: result.removed, failed: result.failed } } })
      }
    })
    .catch(e => {
      packState.active = false
      sendAll({ type: 'event', event: { name: 'pack-error', error: String(e.message || e) } })
    })
  return true
}


/* ------------------------------ Channel scanner ------------------------------ */

let scanState = null
const scanCache = new Map() // chatId -> { found, scanned, typeCounts }

function emitScan (extra = {}) {
  if (!scanState) return
  sendAll({
    type: 'event',
    event: {
      name: 'download-all-progress',
      payload: {
        mode: scanState.mode,
        chatId: scanState.chatId,
        scanned: scanState.scanned,
        found: scanState.found,
        queued: scanState.queued,
        cancelled: scanState.cancelled,
        typeCounts: scanState.typeCounts,
        ...extra
      }
    }
  })
}

async function scanChat (chatId, { queue = false, mode, returnItems = false } = {}) {
  if (scanState && scanState.active) throw new Error('A scan is already running')
  const chat = await client.invoke({ _: 'getChat', chat_id: chatId }).catch(() => ({ title: 'Chat' }))
  const chatTitle = chat.title || 'Chat'
  scanState = {
    chatId,
    active: true,
    cancelled: false,
    scanned: 0,
    found: 0,
    queued: 0,
    mode: mode || (queue ? 'download' : 'count'),
    typeCounts: { document: 0, photo: 0, video: 0, gif: 0, audio: 0, voice: 0, video_note: 0, sticker: 0 }
  }
  const items = []
  emitScan()
  try {
    let from = 0
    for (let iter = 0; iter < 100000; iter++) {
      if (scanState.cancelled) break
      const history = await client.invoke({
        _: 'getChatHistory',
        chat_id: chatId,
        from_message_id: from,
        offset: 0,
        limit: 100,
        only_local: false
      })
      const msgs = (history.messages || []).filter(m => m.sending_state === undefined)
      if (!msgs.length) break
      for (const m of msgs) {
        const media = extractMedia(m)
        if (media && media.file) {
          scanState.found++
          scanState.typeCounts[media.type] = (scanState.typeCounts[media.type] || 0) + 1
          const f = media.file
          const item = {
            key: `${chatId}:${m.id}`,
            messageId: m.id,
            chatId,
            date: m.date,
            fileId: f.id,
            name: media.name,
            fileSize: f.size || f.expected_size || 0,
            type: media.type,
            caption: media.caption || null,
            thumbFileId: media.thumb && media.thumb.photo ? media.thumb.photo.id : null,
            thumbUrl: null
          }
          if (returnItems) items.push(item)
          if (queue) {
            dm.add(chatId, chatTitle, m.id, f.id, media.name, f.size || f.expected_size || 0)
            scanState.queued++
          }
        }
      }
      scanState.scanned += msgs.length
      from = msgs[msgs.length - 1].id
      emitScan()
    }
  } finally {
    scanState.active = false
    const result = { found: scanState.found, scanned: scanState.scanned, typeCounts: scanState.typeCounts, items }
    scanCache.set(chatId, { found: result.found, scanned: result.scanned, typeCounts: result.typeCounts })
    emitScan({ done: true })
    return result
  }
}

/* ------------------------------ Thumbnails ------------------------------ */

async function copyToThumbs (fileId, src) {
  const ext = path.extname(src) || '.jpg'
  const dest = uniquePath(thumbsDir, `${fileId}-${crypto.randomBytes(4).toString('hex')}${ext}`)
  try {
    await fs.promises.copyFile(src, dest)
    thumbCache.set(fileId, dest)
    return dest
  } catch {
    return null
  }
}

function downloadThumb (fileId, thumbDir = thumbsDir) {
  if (thumbCache.has(fileId)) return thumbCache.get(fileId)
  if (pendingThumbs.has(fileId)) return pendingThumbs.get(fileId)

  const p = (async () => {
    if (!client || !ready) return null

    const cached = await client.invoke({ _: 'getFile', file_id: fileId }).catch(() => null)
    if (cached && cached.local && cached.local.is_downloading_completed && cached.local.path) {
      return copyToThumbs(fileId, cached.local.path)
    }

    const src = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 60000)
      const onUpdate = (u) => {
        if (u._ !== 'updateFile' || u.file.id !== fileId) return
        const local = u.file.local || {}
        if (local.is_downloading_completed && local.path) {
          clearTimeout(timer)
          client.off('update', onUpdate)
          resolve(local.path)
        }
      }
      client.on('update', onUpdate)
      client.invoke({ _: 'downloadFile', file_id: fileId, priority: 32, offset: 0, limit: 0, synchronous: false })
        .then(res => {
          const local = res && res.local
          if (local && local.is_downloading_completed && local.path) {
            clearTimeout(timer)
            client.off('update', onUpdate)
            resolve(local.path)
          }
        })
        .catch(() => { clearTimeout(timer); client.off('update', onUpdate); resolve(null) })
    })

    if (!src) return null
    return copyToThumbs(fileId, src)
  })()

  pendingThumbs.set(fileId, p)
  p.finally(() => pendingThumbs.delete(fileId)).catch(() => {})
  return p
}

/* ------------------------------ Auth handling ------------------------------ */

function handleAuthState (state) {
  authState = state
  if (!state) return

  if (state._ === 'authorizationStateReady') {
    ready = true
    client.invoke({ _: 'getMe' }).then(me => {
      sendAll({ type: 'event', event: { name: 'auth', payload: { status: 'ready', me: { id: me.id, name: [me.first_name, me.last_name].filter(Boolean).join(' '), username: me.username } } } })
    }).catch(() => {})
  } else if (state._ === 'authorizationStateWaitPhoneNumber') {
    ready = false
    sendAll({ type: 'event', event: { name: 'login-prompt', kind: 'phone', info: null } })
  } else if (state._ === 'authorizationStateWaitCode') {
    ready = false
    sendAll({ type: 'event', event: { name: 'login-prompt', kind: 'code', info: state.code_info || null } })
  } else if (state._ === 'authorizationStateWaitPassword') {
    ready = false
    sendAll({ type: 'event', event: { name: 'login-prompt', kind: 'password', info: { password_hint: state.password_hint, has_recovery_email_address: state.has_recovery_email_address } } })
  } else if (state._ === 'authorizationStateWaitOtherDeviceConfirmation') {
    sendAll({ type: 'event', event: { name: 'login-prompt', kind: 'other-device', info: { link: state.link } } })
  } else if (state._ === 'authorizationStateWaitRegistration') {
    sendAll({ type: 'event', event: { name: 'login-prompt', kind: 'registration', info: null } })
  }
}

async function submitLogin (kind, value) {
  if (!client) throw new Error('Client not ready')
  if (kind === 'phone') {
    await client.invoke({
      _: 'setAuthenticationPhoneNumber',
      phone_number: String(value).trim(),
      settings: {
        _: 'phoneNumberAuthenticationSettings',
        allow_flash_call: false,
        is_current_phone_number: false,
        allow_sms_retriever_api: false
      }
    })
  } else if (kind === 'code') {
    await client.invoke({ _: 'checkAuthenticationCode', code: String(value).trim() })
  } else if (kind === 'password') {
    await client.invoke({ _: 'checkAuthenticationPassword', password: String(value) })
  } else if (kind === 'registration') {
    await client.invoke({
      _: 'registerUser',
      first_name: String(value),
      last_name: ''
    })
  } else {
    throw new Error('Unknown login input kind')
  }
}

/* ------------------------------ Client init ------------------------------ */

function initClient (config) {
  if (client) return
  tdl.configure({ tdjson: getTdjson(), verbosityLevel: 2 })

  client = tdl.createClient({
    apiId: config.apiId,
    apiHash: config.apiHash,
    databaseDirectory: DB_DIR,
    filesDirectory: FILES_DIR,
    tdlibParameters: {
      use_message_database: true,
      use_secret_chats: false,
      system_language_code: 'en',
      application_version: '4.14.8',
      device_model: 'Desktop',
      system_version: 'Windows 10.0.22631'
    }
  })

  client.on('error', (err) => {
    console.error('TDLib error:', err)
    sendAll({ type: 'event', event: { name: 'error', error: String(err.message || err) } })
  })

  client.on('update', (u) => {
    if (u._ === 'updateAuthorizationState') {
      handleAuthState(u.authorization_state)
    } else if (u._ === 'updateFile') {
      dm.onFileUpdate(u.file)
    } else if (u._ === 'updateNewChat') {
      serializeChatDetailed(u.chat).then(chat => {
        sendAll({ type: 'event', event: { name: 'chat-upsert', chat } })
      }).catch(() => {})
    } else if (u._ === 'updateChatTitle' || u._ === 'updateChatPhoto' || u._ === 'updateChatLastMessage') {
      client.invoke({ _: 'getChat', chat_id: u.chat_id }).then(serializeChatDetailed).then(chat => {
        sendAll({ type: 'event', event: { name: 'chat-upsert', chat } })
      }).catch(() => {})
    } else if (u._ === 'updateChatPosition') {
      const pos = u.position || {}
      const isMain = !pos.chat_list || pos.chat_list._ === 'chatListMain'
      if (isMain && String(pos.order || '0') === '0') {
        sendAll({ type: 'event', event: { name: 'chat-remove', chatId: u.chat_id } })
      } else {
        client.invoke({ _: 'getChat', chat_id: u.chat_id }).then(serializeChatDetailed).then(chat => {
          sendAll({ type: 'event', event: { name: 'chat-upsert', chat } })
        }).catch(() => {})
      }
    }
  })
}

/* ------------------------------ Data helpers ------------------------------ */

function resolveSenderName (msg) {
  const s = msg.sender_id
  if (!s) return null
  const key = `${s._}:${s.user_id ?? s.chat_id}`
  if (senderCache.has(key)) return senderCache.get(key)

  const fetch = async () => {
    try {
      if (s._ === 'messageSenderUser') {
        const u = await client.invoke({ _: 'getUser', user_id: s.user_id })
        return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || 'User'
      }
      if (s._ === 'messageSenderChat') {
        const c = await client.invoke({ _: 'getChat', chat_id: s.chat_id })
        return c.title || 'Chat'
      }
    } catch {}
    return 'Unknown'
  }
  const name = fetch()
  senderCache.set(key, name)
  return name
}

function extractMedia (msg) {
  const c = msg.content
  if (!c) return null
  const base = { messageId: msg.id, date: msg.date, chatId: msg.chat_id }
  switch (c._) {
    case 'messageDocument':
      return { ...base, type: 'document', file: c.document.document, name: c.document.file_name || `document_${msg.id}`, mime: c.document.mime_type || 'application/octet-stream', thumb: c.document.thumbnail, caption: c.caption?.text }
    case 'messagePhoto': {
      const sizes = (c.photo.sizes || []).sort((a, b) => a.size - b.size)
      const big = sizes[sizes.length - 1]
      if (!big) return null
      return { ...base, type: 'photo', file: big.photo, name: `photo_${msg.id}.jpg`, mime: 'image/jpeg', thumb: sizes[0], caption: c.caption?.text }
    }
    case 'messageVideo':
      return { ...base, type: 'video', file: c.video.video, name: c.video.file_name || `video_${msg.id}.mp4`, mime: c.video.mime_type || 'video/mp4', thumb: c.video.thumbnail, caption: c.caption?.text }
    case 'messageAnimation':
      return { ...base, type: 'gif', file: c.animation.animation, name: c.animation.file_name || `animation_${msg.id}.gif`, mime: c.animation.mime_type || 'image/gif', thumb: c.animation.thumbnail }
    case 'messageAudio':
      return { ...base, type: 'audio', file: c.audio.audio, name: c.audio.file_name || `audio_${msg.id}.mp3`, mime: c.audio.mime_type || 'audio/mpeg', thumb: c.audio.album_cover_thumbnail }
    case 'messageVoiceNote':
      return { ...base, type: 'voice', file: c.voice_note.voice, name: `voice_${msg.id}.ogg`, mime: 'audio/ogg', thumb: null }
    case 'messageVideoNote':
      return { ...base, type: 'video_note', file: c.video_note.video, name: `video_note_${msg.id}.mp4`, mime: 'video/mp4', thumb: c.video_note.thumb }
    case 'messageSticker':
      return { ...base, type: 'sticker', file: c.sticker.sticker, name: c.sticker.set_name ? `${c.sticker.emoji || 'sticker'}.webp` : `sticker_${msg.id}.webp`, mime: 'image/webp', thumb: null }
    default:
      return null
  }
}

function serializeChat (chat) {
  const title = chat.title || 'Unknown'
  const info = {
    id: chat.id,
    title,
    order: chat.order,
    unread: chat.unread_count || 0,
    lastMessage: chat.last_message ? chat.last_message.content : null,
    username: null,
    photoFileId: chat.photo && chat.photo.small ? chat.photo.small.id : null
  }
  const t = chat.type
  if (t) {
    if (t._ === 'chatTypePrivate') info.kind = 'private'
    else if (t._ === 'chatTypeBasicGroup') info.kind = 'group'
    else if (t._ === 'chatTypeSupergroup') info.kind = t.is_channel ? 'channel' : 'supergroup'
    else info.kind = 'other'
  }
  return info
}

async function serializeChatDetailed (chat) {
  const info = serializeChat(chat)
  try {
    if (chat.type && chat.type._ === 'chatTypePrivate') {
      const user = await client.invoke({ _: 'getUser', user_id: chat.type.user_id })
      info.username = user && user.username ? user.username : null
    } else if (chat.type && chat.type._ === 'chatTypeSupergroup') {
      const group = await client.invoke({ _: 'getSupergroup', supergroup_id: chat.type.supergroup_id })
      const names = group && group.usernames && group.usernames.active_usernames
      info.username = names && names.length ? names[0] : null
    }
  } catch {}
  return info
}

async function loadChats () {
  if (!client || !ready) throw new Error('Not logged in')
  const chats = await client.invoke({
    _: 'getChats',
    chat_list: { _: 'chatListMain' },
    offset_order: lastChatOffset.order,
    offset_chat_id: lastChatOffset.chat_id,
    limit: 100
  })
  const ids = (chats.chat_ids || [])
  const out = (await Promise.all(ids.map(async (id) => {
    try {
      const chat = await client.invoke({ _: 'getChat', chat_id: id })
      const t = chat.type
      if (t && t._ === 'chatTypeSecret') return null
      return await serializeChatDetailed(chat)
    } catch (e) {
      return null
    }
  }))).filter(Boolean)
  out.sort((a, b) => (a.order < b.order ? 1 : -1))
  if (out.length) {
    lastChatOffset = { order: out[out.length - 1].order, chat_id: out[out.length - 1].id }
  } else {
    lastChatOffset = { order: '0', chat_id: 0 }
  }
  return out
}

async function loadMessages (chatId, fromMessageId, limit) {
  if (!client || !ready) throw new Error('Not logged in')
  const target = Math.max(1, Math.min(100, Number(limit) || 100))
  const raw = []
  const seen = new Set()
  let cursor = fromMessageId || 0
  let exhausted = false

  // TDLib can return a very short batch for private/contact histories while it
  // hydrates older messages. Keep paging inside this request so the UI receives
  // one useful snapshot rather than appearing to contain only one message.
  for (let attempt = 0; attempt < 8 && raw.length < target; attempt++) {
    const history = await client.invoke({
      _: 'getChatHistory',
      chat_id: chatId,
      from_message_id: cursor,
      offset: 0,
      limit: Math.min(100, target - raw.length),
      only_local: false
    })
    const batch = (history.messages || []).filter(m => m.sending_state === undefined)
    if (!batch.length) { exhausted = true; break }

    let added = 0
    for (const message of batch) {
      const key = String(message.id)
      if (seen.has(key)) continue
      seen.add(key)
      raw.push(message)
      added++
      if (raw.length >= target) break
    }

    const oldest = batch[batch.length - 1]
    const nextCursor = oldest && oldest.id
    if (!nextCursor || String(nextCursor) === String(cursor) || added === 0) {
      exhausted = true
      break
    }
    cursor = nextCursor
  }

  const out = await Promise.all(raw.map(async (m) => {
    const item = {
      id: m.id,
      date: m.date,
      text: m.content && m.content._ === 'messageText' ? (m.content.text?.text || '') : null,
      sender: await resolveSenderName(m),
      outgoing: !!m.is_outgoing,
      media: extractMedia(m)
    }
    if (item.media && item.media.file) {
      const f = item.media.file
      item.media.fileSize = f.size || f.expected_size || 0
      item.media.fileId = f.id
      if (item.media.thumb && item.media.thumb.photo && item.media.thumb.photo.id) {
        item.media.thumbUrl = null
        item.media.thumbFileId = item.media.thumb.photo.id
      }
    } else {
      item.media = null
    }
    return item
  }))

  out.sort((a, b) => (String(a.id) < String(b.id) ? 1 : -1))
  return { messages: out, hasMore: !exhausted && raw.length >= target }
}



/* ------------------------------ Telegram management ------------------------------ */

function ensureManagementReady () {
  if (!client || !ready) throw new Error('Telegram session is not ready')
}

function normalizeManagedUsername (value) {
  return String(value || '').trim().replace(/^@/, '')
}

function managedStatusLabel (status) {
  if (!status || !status._) return 'Member'
  return ({
    chatMemberStatusCreator: 'Owner',
    chatMemberStatusAdministrator: 'Administrator',
    chatMemberStatusMember: 'Member',
    chatMemberStatusRestricted: 'Restricted',
    chatMemberStatusLeft: 'Left',
    chatMemberStatusBanned: 'Banned'
  })[status._] || 'Member'
}

function managedPermissions (status, chat, kind, isSavedMessages, canGetMembers) {
  const owner = status && status._ === 'chatMemberStatusCreator'
  const administrator = status && status._ === 'chatMemberStatusAdministrator'
  const rights = (status && status.rights) || {}
  const adminFallback = administrator && Object.keys(rights).length === 0
  return {
    isOwner: !!owner,
    isAdministrator: !!(owner || administrator),
    canChangeInfo: !!(owner || rights.can_change_info || adminFallback),
    canInviteUsers: !!(owner || rights.can_invite_users || adminFallback),
    canRestrictMembers: !!(owner || rights.can_restrict_members || adminFallback),
    canDeleteForAll: !!chat.can_be_deleted_for_all_users,
    canClearHistory: !!(chat.can_be_deleted_only_for_self || chat.can_be_deleted_for_all_users),
    canLeave: kind !== 'private' && kind !== 'secret',
    canEditUsername: !!(owner && (kind === 'channel' || kind === 'supergroup')),
    canGetMembers: !!canGetMembers,
    canSetPhoto: !!((owner || rights.can_change_info || adminFallback) && kind !== 'private'),
    canMute: !isSavedMessages
  }
}

async function getManagedChatInfo (chatId) {
  ensureManagementReady()
  const chat = await client.invoke({ _: 'getChat', chat_id: chatId })
  const serialized = await serializeChatDetailed(chat)
  const type = chat.type || {}
  let status = null
  let fullInfo = null
  let groupInfo = null
  let canGetMembers = false

  if (type._ === 'chatTypeSupergroup') {
    groupInfo = await client.invoke({ _: 'getSupergroup', supergroup_id: type.supergroup_id }).catch(() => null)
    status = groupInfo && groupInfo.status
    fullInfo = await client.invoke({ _: 'getSupergroupFullInfo', supergroup_id: type.supergroup_id }).catch(() => null)
    canGetMembers = !!(fullInfo && fullInfo.can_get_members)
    if (!serialized.username && groupInfo && groupInfo.usernames && groupInfo.usernames.active_usernames && groupInfo.usernames.active_usernames.length) {
      serialized.username = groupInfo.usernames.active_usernames[0]
    }
  } else if (type._ === 'chatTypeBasicGroup') {
    groupInfo = await client.invoke({ _: 'getBasicGroup', basic_group_id: type.basic_group_id }).catch(() => null)
    status = groupInfo && groupInfo.status
    fullInfo = await client.invoke({ _: 'getBasicGroupFullInfo', basic_group_id: type.basic_group_id }).catch(() => null)
    canGetMembers = !!fullInfo
  }

  const me = await client.invoke({ _: 'getMe' }).catch(() => null)
  const isSavedMessages = !!(me && type._ === 'chatTypePrivate' && String(type.user_id) === String(me.id))
  const memberCount = type._ === 'chatTypeBasicGroup'
    ? (fullInfo && Array.isArray(fullInfo.members) ? fullInfo.members.length : (groupInfo && groupInfo.member_count) || null)
    : (fullInfo && fullInfo.member_count) || (groupInfo && groupInfo.member_count) || (type._ === 'chatTypePrivate' ? 2 : null)
  const inviteLink = fullInfo && fullInfo.invite_link && fullInfo.invite_link.invite_link
  const notification = chat.notification_settings || {}
  const muted = notification.use_default_mute_for === false && Number(notification.mute_for || 0) > 0
  const permissions = managedPermissions(status, chat, serialized.kind, isSavedMessages, canGetMembers)

  return {
    chat: {
      ...serialized,
      messageAutoDeleteTime: Number(chat.message_auto_delete_time || 0)
    },
    details: {
      description: (fullInfo && fullInfo.description) || '',
      memberCount,
      administratorCount: (fullInfo && fullInfo.administrator_count) || null,
      inviteLink: inviteLink || null,
      statusLabel: managedStatusLabel(status),
      muted,
      autoDeleteTime: Number(chat.message_auto_delete_time || 0)
    },
    permissions,
    internal: {
      supergroupId: type._ === 'chatTypeSupergroup' ? type.supergroup_id : null,
      basicGroupId: type._ === 'chatTypeBasicGroup' ? type.basic_group_id : null
    }
  }
}

async function resolveManagedUserByUsername (value) {
  ensureManagementReady()
  const username = normalizeManagedUsername(value)
  if (!username) throw new Error('Username is required')
  const chat = await client.invoke({ _: 'searchPublicChat', username }).catch(() => null)
  if (!chat || !chat.type || chat.type._ !== 'chatTypePrivate' || !chat.type.user_id) {
    throw new Error(`@${username} is not a public user account`)
  }
  return { username, userId: chat.type.user_id }
}

async function createManagedChat (payload) {
  ensureManagementReady()
  const type = payload.type === 'group' ? 'group' : 'channel'
  const title = String(payload.title || '').trim()
  const description = String(payload.description || '').trim()
  const username = normalizeManagedUsername(payload.username)
  const autoDeleteTime = Number(payload.autoDeleteTime || 0)
  if (!title || title.length > 128) throw new Error('Title must be 1-128 characters')
  if (description.length > 255) throw new Error('Description must be at most 255 characters')
  if (autoDeleteTime < 0 || autoDeleteTime > 365 * 86400 || autoDeleteTime % 86400 !== 0) throw new Error('Invalid auto-delete value')

  const chat = await client.invoke({
    _: 'createNewSupergroupChat',
    title,
    is_forum: type === 'group' && !!payload.forum,
    is_channel: type === 'channel',
    description,
    location: null,
    message_auto_delete_time: autoDeleteTime,
    for_import: false
  })

  const warnings = []
  if (username) {
    try {
      await client.invoke({ _: 'setSupergroupUsername', supergroup_id: chat.type.supergroup_id, username })
    } catch (e) {
      warnings.push(`Created chat, but @${username} could not be set: ${String(e.message || e)}`)
    }
  }

  const memberUsernames = [...new Set((payload.memberUsernames || []).map(normalizeManagedUsername).filter(Boolean))].slice(0, 20)
  if (memberUsernames.length) {
    const userIds = []
    for (const memberUsername of memberUsernames) {
      try {
        const member = await resolveManagedUserByUsername(memberUsername)
        userIds.push(member.userId)
      } catch (e) {
        warnings.push(String(e.message || e))
      }
    }
    if (userIds.length) {
      try {
        const added = await client.invoke({ _: 'addChatMembers', chat_id: chat.id, user_ids: userIds })
        const failed = added && added.failed_to_add_members
        if (Array.isArray(failed) && failed.length) warnings.push(`${failed.length} member(s) could not be added`)
      } catch (e) {
        warnings.push(`Some members could not be added: ${String(e.message || e)}`)
      }
    }
  }

  const fresh = await client.invoke({ _: 'getChat', chat_id: chat.id }).catch(() => chat)
  const serialized = await serializeChatDetailed(fresh)
  sendAll({ type: 'event', event: { name: 'chat-upsert', chat: serialized } })
  return { chat: serialized, warnings }
}

async function updateManagedChat (payload) {
  const info = await getManagedChatInfo(payload.chatId)
  const chatId = payload.chatId
  const title = payload.title == null ? null : String(payload.title).trim()
  const description = payload.description == null ? null : String(payload.description).trim()

  if ((title != null || description != null || payload.autoDeleteTime != null) && !info.permissions.canChangeInfo) {
    throw new Error('Telegram does not allow you to change this chat information')
  }
  if (title != null) {
    if (!title || title.length > 128) throw new Error('Title must be 1-128 characters')
    if (title !== info.chat.title) await client.invoke({ _: 'setChatTitle', chat_id: chatId, title })
  }
  if (description != null) {
    if (description.length > 255) throw new Error('Description must be at most 255 characters')
    if (description !== info.details.description) await client.invoke({ _: 'setChatDescription', chat_id: chatId, description })
  }
  if (payload.autoDeleteTime != null) {
    const autoDeleteTime = Number(payload.autoDeleteTime || 0)
    if (autoDeleteTime < 0 || autoDeleteTime > 365 * 86400 || autoDeleteTime % 86400 !== 0) throw new Error('Invalid auto-delete value')
    if (autoDeleteTime !== info.details.autoDeleteTime) {
      await client.invoke({ _: 'setChatMessageAutoDeleteTime', chat_id: chatId, message_auto_delete_time: autoDeleteTime })
    }
  }
  if (payload.username !== undefined) {
    if (!info.permissions.canEditUsername || !info.internal.supergroupId) throw new Error('Only the owner can change the public username')
    const username = normalizeManagedUsername(payload.username)
    await client.invoke({ _: 'setSupergroupUsername', supergroup_id: info.internal.supergroupId, username })
  }

  const fresh = await client.invoke({ _: 'getChat', chat_id: chatId })
  const serialized = await serializeChatDetailed(fresh)
  sendAll({ type: 'event', event: { name: 'chat-upsert', chat: serialized } })
  return getManagedChatInfo(chatId)
}

async function managedMembers (chatId, limit) {
  const info = await getManagedChatInfo(chatId)
  if (!info.permissions.canGetMembers) throw new Error('Telegram does not allow the member list to be viewed')
  const max = Math.max(1, Math.min(100, Number(limit) || 100))
  let members = []
  let totalCount = 0

  if (info.internal.supergroupId) {
    const result = await client.invoke({
      _: 'getSupergroupMembers',
      supergroup_id: info.internal.supergroupId,
      filter: null,
      offset: 0,
      limit: max
    })
    members = result.members || []
    totalCount = result.total_count || members.length
  } else if (info.internal.basicGroupId) {
    const full = await client.invoke({ _: 'getBasicGroupFullInfo', basic_group_id: info.internal.basicGroupId })
    members = (full.members || []).slice(0, max)
    totalCount = (full.members || []).length
  }

  const me = await client.invoke({ _: 'getMe' }).catch(() => null)
  const out = []
  for (const member of members) {
    const sender = member.member_id || {}
    if (sender._ === 'messageSenderUser' && sender.user_id) {
      const user = await client.invoke({ _: 'getUser', user_id: sender.user_id }).catch(() => null)
      const usernames = user && user.usernames && user.usernames.active_usernames
      out.push({
        userId: sender.user_id,
        name: user ? ([user.first_name, user.last_name].filter(Boolean).join(' ') || 'User') : 'User',
        username: user ? ((usernames && usernames[0]) || user.username || null) : null,
        statusLabel: managedStatusLabel(member.status),
        isSelf: !!(me && String(me.id) === String(sender.user_id))
      })
    } else if (sender._ === 'messageSenderChat' && sender.chat_id) {
      const senderChat = await client.invoke({ _: 'getChat', chat_id: sender.chat_id }).catch(() => null)
      out.push({
        userId: null,
        name: senderChat ? senderChat.title : 'Chat',
        username: null,
        statusLabel: managedStatusLabel(member.status),
        isSelf: false
      })
    }
  }
  return { members: out, totalCount }
}

async function addManagedMember (chatId, username) {
  const info = await getManagedChatInfo(chatId)
  if (!info.permissions.canInviteUsers) throw new Error('You do not have permission to add members')
  const user = await resolveManagedUserByUsername(username)
  const result = await client.invoke({ _: 'addChatMember', chat_id: chatId, user_id: user.userId, forward_limit: 0 })
  return { userId: user.userId, username: user.username, result }
}

async function removeManagedMember (chatId, userId) {
  const info = await getManagedChatInfo(chatId)
  if (!info.permissions.canRestrictMembers) throw new Error('You do not have permission to remove members')
  const me = await client.invoke({ _: 'getMe' })
  if (String(me.id) === String(userId)) throw new Error('Use Leave chat to remove yourself')
  await client.invoke({
    _: 'setChatMemberStatus',
    chat_id: chatId,
    member_id: { _: 'messageSenderUser', user_id: userId },
    status: { _: 'chatMemberStatusLeft' }
  })
  return { ok: true }
}

function managedNotificationSettings (current, muted) {
  const n = current || {}
  return {
    _: 'chatNotificationSettings',
    use_default_mute_for: false,
    mute_for: muted ? 2147483647 : 0,
    use_default_sound: n.use_default_sound !== undefined ? n.use_default_sound : true,
    sound_id: Number(n.sound_id || 0),
    use_default_show_preview: n.use_default_show_preview !== undefined ? n.use_default_show_preview : true,
    show_preview: n.show_preview !== undefined ? n.show_preview : true,
    use_default_mute_stories: n.use_default_mute_stories !== undefined ? n.use_default_mute_stories : true,
    mute_stories: !!n.mute_stories,
    use_default_story_sound: n.use_default_story_sound !== undefined ? n.use_default_story_sound : true,
    story_sound_id: Number(n.story_sound_id || 0),
    use_default_show_story_poster: n.use_default_show_story_poster !== undefined ? n.use_default_show_story_poster : true,
    show_story_poster: n.show_story_poster !== undefined ? n.show_story_poster : true,
    use_default_disable_pinned_message_notifications: n.use_default_disable_pinned_message_notifications !== undefined ? n.use_default_disable_pinned_message_notifications : true,
    disable_pinned_message_notifications: !!n.disable_pinned_message_notifications,
    use_default_disable_mention_notifications: n.use_default_disable_mention_notifications !== undefined ? n.use_default_disable_mention_notifications : true,
    disable_mention_notifications: !!n.disable_mention_notifications
  }
}


/* ------------------------------ File search ------------------------------ */

const MESSAGE_FILTERS = {
  all: null,
  document: 'messageFilterDocument',
  photo: 'messageFilterPhoto',
  video: 'messageFilterVideo',
  audio: 'messageFilterAudio',
  voice: 'messageFilterVoiceNote',
  gif: 'messageFilterAnimation',
  video_note: 'messageFilterVideoNote'
}

async function searchMedia (chatId, query, fromMessageId, limit, filter) {
  if (!client || !ready) throw new Error('Not logged in')
  const res = await client.invoke({
    _: 'searchChatMessages',
    chat_id: chatId,
    query: String(query || ''),
    from_message_id: fromMessageId || 0,
    offset: 0,
    limit: limit || 100,
    filter: MESSAGE_FILTERS[filter] ? { _: MESSAGE_FILTERS[filter] } : undefined
  })
  const raw = (res.messages || []).filter(m => m.sending_state === undefined)
  const items = []
  for (const m of raw) {
    const media = extractMedia(m)
    if (!media || !media.file) continue
    const f = media.file
    items.push({
      key: `${chatId}:${m.id}`,
      messageId: m.id,
      chatId,
      date: m.date,
      fileId: f.id,
      name: media.name,
      fileSize: f.size || f.expected_size || 0,
      type: media.type,
      caption: media.caption || null,
      thumbFileId: media.thumb && media.thumb.photo ? media.thumb.photo.id : null,
      thumbUrl: null
    })
  }
  return { items, totalCount: res.total_count || items.length, hasMore: raw.length === limit }
}

/* ------------------------------ HTTP + WS server ------------------------------ */

const app = express()
app.use(express.json())


app.post('/api/chat-photo/:chatId', express.raw({ type: 'application/octet-stream', limit: '10mb' }), async (req, res) => {
  let tempPath = null
  try {
    ensureManagementReady()
    const chatId = Number(req.params.chatId)
    if (!Number.isSafeInteger(chatId)) return res.status(400).json({ error: 'Invalid chat id' })
    const info = await getManagedChatInfo(chatId)
    if (!info.permissions.canSetPhoto) return res.status(403).json({ error: 'You do not have permission to change this chat photo' })
    const name = String(req.headers['x-file-name'] || 'photo.jpg')
    if (!/\.jpe?g$/i.test(name)) return res.status(400).json({ error: 'Chat photos must be JPEG (.jpg/.jpeg)' })
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'No image uploaded' })
    tempPath = path.join(MANAGEMENT_UPLOAD_DIR, `${crypto.randomUUID()}.jpg`)
    await fs.promises.writeFile(tempPath, req.body)
    await client.invoke({
      _: 'setChatPhoto',
      chat_id: chatId,
      photo: { _: 'inputChatPhotoStatic', photo: { _: 'inputFileLocal', path: tempPath } }
    })
    const fresh = await client.invoke({ _: 'getChat', chat_id: chatId })
    sendAll({ type: 'event', event: { name: 'chat-upsert', chat: await serializeChatDetailed(fresh) } })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  } finally {
    if (tempPath) fs.promises.unlink(tempPath).catch(() => {})
  }
})


app.use('/dl', (req, res, next) => {
  express.static(downloadsDir, { fallthrough: true, maxAge: 0, dotfiles: 'allow' })(req, res, next)
})
app.use(express.static(path.join(ROOT, 'public')))

app.get('/api/downloads', (req, res) => {
  res.json(dm.snapshot().filter(j => j.status === 'done'))
})

app.post('/api/config', (req, res) => {
  const { apiId, apiHash } = req.body || {}
  if (!apiId || !apiHash) {
    return res.status(400).json({ error: 'apiId and apiHash are required' })
  }
  try {
    saveConfig(apiId, apiHash)
    initClient({ apiId: Number(apiId), apiHash: String(apiHash) })
    res.json({ ok: true, status: 'initialized' })
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
})

const server = http.createServer(app)
const wss = new WebSocketServer({ server })

wss.on('connection', (ws) => {
  webSockets.add(ws)
  ws.on('close', () => webSockets.delete(ws))

  ws.on('message', async (raw) => {
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      return respond(ws, null, false, null, 'Invalid JSON')
    }
    const { id, type, payload } = msg
    try {
      switch (type) {
        case 'get-status': {
          const config = loadConfig()
          if (!config) return respond(ws, id, true, { status: 'need-config' })
          return respond(ws, id, true, {
            status: ready ? 'ready' : (authState ? 'waiting-input' : 'initializing'),
            ready,
            concurrency: CONCURRENCY,
            downloadsDir,
            authState: authState ? authState._ : null
          })
        }
        case 'login-input':
          await submitLogin(payload.kind, payload.value)
          return respond(ws, id, true, { ok: true })
        case 'get-chats':
          lastChatOffset = { order: '9223372036854775807', chat_id: 0 }
          return respond(ws, id, true, { chats: await loadChats() })
        case 'get-chats-more':
          return respond(ws, id, true, { chats: await loadChats() })
        case 'get-messages': {
          const r = await loadMessages(payload.chatId, payload.fromMessageId, payload.limit || 100)
          return respond(ws, id, true, r)
        }
        case 'search-media': {
          const r = await searchMedia(payload.chatId, payload.query, payload.fromMessageId, payload.limit, payload.filter)
          return respond(ws, id, true, r)
        }
        case 'search-destinations': {
          const query = String(payload.query || '').trim()
          const ids = query
            ? ((await client.invoke({ _: 'searchChats', query, limit: 50 }).catch(() => ({ chat_ids: [] }))).chat_ids || [])
            : ((await client.invoke({ _: 'getChats', chat_list: { _: 'chatListMain' }, offset_order: '9223372036854775807', offset_chat_id: 0, limit: 50 })).chat_ids || [])
          const chats = []
          for (const chatId of ids) {
            if (payload.excludeChatId != null && String(chatId) === String(payload.excludeChatId)) continue
            const chat = await client.invoke({ _: 'getChat', chat_id: chatId }).catch(() => null)
            if (!chat || (chat.type && chat.type._ === 'chatTypeSecret')) continue
            chats.push(await serializeChatDetailed(chat))
          }
          return respond(ws, id, true, { chats })
        }
        case 'forward-messages': {
          const result = await forwardMessagesNative(payload.sourceChatId, payload.messageIds, payload.destination || {})
          return respond(ws, id, true, {
            destination: result.destination,
            forwarded: result.forwarded,
            skipped: result.skipped,
            destinationMessageIds: result.messages.map(m => m && m.id).filter(Boolean)
          })
        }

        case 'get-chat-management':
          return respond(ws, id, true, await getManagedChatInfo(payload.chatId))
        case 'create-managed-chat':
          return respond(ws, id, true, await createManagedChat(payload || {}))
        case 'update-managed-chat':
          return respond(ws, id, true, await updateManagedChat(payload || {}))
        case 'get-managed-members':
          return respond(ws, id, true, await managedMembers(payload.chatId, payload.limit))
        case 'add-managed-member':
          return respond(ws, id, true, await addManagedMember(payload.chatId, payload.username))
        case 'remove-managed-member':
          return respond(ws, id, true, await removeManagedMember(payload.chatId, payload.userId))
        case 'create-managed-invite': {
          const info = await getManagedChatInfo(payload.chatId)
          if (!info.permissions.canInviteUsers) throw new Error('You do not have permission to create invite links')
          if (info.details.inviteLink) return respond(ws, id, true, { inviteLink: info.details.inviteLink })
          const link = await client.invoke({
            _: 'createChatInviteLink',
            chat_id: payload.chatId,
            name: 'Tele',
            expiration_date: 0,
            member_limit: 0,
            creates_join_request: false
          })
          return respond(ws, id, true, { inviteLink: link && link.invite_link })
        }
        case 'set-managed-muted': {
          const info = await getManagedChatInfo(payload.chatId)
          if (!info.permissions.canMute) throw new Error('Notifications cannot be changed for this chat')
          const chat = await client.invoke({ _: 'getChat', chat_id: payload.chatId })
          await client.invoke({
            _: 'setChatNotificationSettings',
            chat_id: payload.chatId,
            notification_settings: managedNotificationSettings(chat.notification_settings, !!payload.muted)
          })
          return respond(ws, id, true, { ok: true })
        }
        case 'remove-managed-photo': {
          const info = await getManagedChatInfo(payload.chatId)
          if (!info.permissions.canSetPhoto) throw new Error('You do not have permission to change this chat photo')
          await client.invoke({ _: 'setChatPhoto', chat_id: payload.chatId, photo: null })
          const fresh = await client.invoke({ _: 'getChat', chat_id: payload.chatId })
          sendAll({ type: 'event', event: { name: 'chat-upsert', chat: await serializeChatDetailed(fresh) } })
          return respond(ws, id, true, { ok: true })
        }
        case 'clear-managed-history': {
          const info = await getManagedChatInfo(payload.chatId)
          const revoke = !!payload.revoke
          if (revoke && !info.permissions.canDeleteForAll) throw new Error('Telegram does not allow deleting this history for everyone')
          if (!revoke && !info.permissions.canClearHistory) throw new Error('Telegram does not allow clearing this history')
          await client.invoke({ _: 'deleteChatHistory', chat_id: payload.chatId, remove_from_chat_list: false, revoke })
          return respond(ws, id, true, { ok: true })
        }
        case 'leave-managed-chat': {
          const info = await getManagedChatInfo(payload.chatId)
          if (!info.permissions.canLeave) throw new Error('This chat cannot be left')
          await client.invoke({ _: 'leaveChat', chat_id: payload.chatId })
          sendAll({ type: 'event', event: { name: 'chat-remove', chatId: payload.chatId } })
          return respond(ws, id, true, { ok: true })
        }
        case 'delete-managed-chat': {
          const info = await getManagedChatInfo(payload.chatId)
          if (!info.permissions.canDeleteForAll) throw new Error('Telegram does not allow you to delete this chat for everyone')
          await client.invoke({ _: 'deleteChat', chat_id: payload.chatId })
          sendAll({ type: 'event', event: { name: 'chat-remove', chatId: payload.chatId } })
          return respond(ws, id, true, { ok: true })
        }
        case 'start-download': {
          const chat = await client.invoke({ _: 'getChat', chat_id: payload.chatId }).catch(() => ({ title: 'Chat' }))
          const chatTitle = chat.title || 'Chat'
          const jobIds = []
          for (const item of payload.items || []) {
            const jid = dm.add(payload.chatId, chatTitle, item.messageId, item.fileId, item.fileName, item.fileSize)
            jobIds.push(jid)
          }
          return respond(ws, id, true, { jobIds })
        }
        case 'download-all':
          scanChat(payload.chatId, { queue: true, mode: 'download' }).catch(e => {
            sendAll({ type: 'event', event: { name: 'download-all-error', error: String(e.message || e) } })
          })
          return respond(ws, id, true, { started: true })
        case 'scan-media': {
          if (scanState && scanState.active) return respond(ws, id, true, { busy: true })
          const r = await scanChat(payload.chatId, { queue: false, mode: 'count', returnItems: payload.includeItems })
          return respond(ws, id, true, { found: r.found, scanned: r.scanned, typeCounts: r.typeCounts, items: r.items })
        }
        case 'cancel-scan':
          if (scanState) scanState.cancelled = true
          return respond(ws, id, true, { ok: true })
        case 'set-concurrency':
          CONCURRENCY = Math.max(1, Math.min(64, Number(payload.value) || CONCURRENCY))
          dm.tryRun()
          return respond(ws, id, true, { concurrency: CONCURRENCY })
        case 'set-download-dir': {
          const dir = String(payload.dir || '').trim().replace(/^"|"$/g, '')
          if (!dir) return respond(ws, id, false, null, 'Path is required')
          const resolved = path.resolve(dir)
          fs.mkdirSync(resolved, { recursive: true })
          downloadsDir = resolved
          thumbsDir = path.join(downloadsDir, '.thumbs')
          fs.mkdirSync(thumbsDir, { recursive: true })
          saveSettings()
          sendAll({ type: 'event', event: { name: 'settings-changed', downloadsDir } })
          return respond(ws, id, true, { downloadsDir })
        }
        case 'pause-job':
          return respond(ws, id, true, { ok: dm.pause(payload.jobId) })
        case 'resume-job':
          return respond(ws, id, true, { ok: dm.resume(payload.jobId) })
        case 'pause-all':
          return respond(ws, id, true, { paused: dm.pauseAll() })
        case 'resume-all':
          return respond(ws, id, true, { resumed: dm.resumeAll() })
        case 'cancel-all':
          return respond(ws, id, true, { cancelled: dm.cancelAll() })
        case 'cancel-download':
          return respond(ws, id, true, { ok: dm.cancel(payload.jobId) })
        case 'remove-download':
          return respond(ws, id, true, { ok: dm.remove(payload.jobId) })
        case 'get-downloads':
          return respond(ws, id, true, { jobs: dm.snapshot(), concurrency: CONCURRENCY })
        case 'get-thumb': {
          const p = await downloadThumb(payload.fileId)
          return respond(ws, id, true, { path: p && p.startsWith(downloadsDir) ? p.replace(downloadsDir, '').replace(/\\/g, '/') : null })
        }
        case 'pack-scan':
          return respond(ws, id, true, packMedia.scan(downloadsDir))
        case 'pack-run':
          if (!startPack()) return respond(ws, id, true, { busy: true })
          return respond(ws, id, true, { started: true })
        case 'pack-selected':
          return respond(ws, id, true, packSelected.preview(payload.items || []))
        case 'pack-selected':
          return respond(ws, id, true, packSelected.preview(payload.items || []))
        case 'pack-selected-run': {
          if (!startPackSelected(payload.items || [], String(payload.chatTitle || 'files'))) {
            return respond(ws, id, true, { busy: true })
          }
          return respond(ws, id, true, { started: true })
        }
        case 'cancel-pack':
          if (packState) packState.cancelled = true
          return respond(ws, id, true, { ok: true })
        default:
          return respond(ws, id, false, null, `Unknown type: ${type}`)
      }
    } catch (e) {
      respond(ws, id, false, null, String(e.message || e))
    }
  })
})

const config = loadConfig()
if (config) {
  initClient(config)
} else {
  console.log('No API credentials found. Open the web UI to enter api_id and api_hash.')
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Tele running at http://127.0.0.1:${PORT}`)
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (client) await client.close().catch(() => {})
    process.exit(0)
  })
}
