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

function computeSelectedSave (items, chatTitle) {
  const { unique, remove } = packSelected.dedupe(items || [])
  const chatFolder = path.join(downloadsDir, sanitize(chatTitle))

  const onDisk = new Set()
  try {
    for (const f of fs.readdirSync(chatFolder)) {
      const stats = fs.statSync(path.join(chatFolder, f))
      if (!stats.isFile()) continue
      onDisk.add(`${stats.size}\u0000${f}`)
    }
  } catch {}

  const alreadyPresent = []
  const queued = []
  for (const it of unique) {
    const key = `${it.fileSize || 0}\u0000${String(it.fileName || '')}`
    if (onDisk.has(key)) { alreadyPresent.push(it); continue }
    queued.push(it)
  }

  return {
    total: (items || []).length,
    duplicates: remove.length,
    alreadyPresent: alreadyPresent.length,
    queued: queued.length
  }
}

function saveSelectedDirect (items, chatTitle, chatId) {
  const { unique } = packSelected.dedupe(items || [])
  const chatFolder = path.join(downloadsDir, sanitize(chatTitle))

  const onDisk = new Set()
  try {
    for (const f of fs.readdirSync(chatFolder)) {
      const stats = fs.statSync(path.join(chatFolder, f))
      if (!stats.isFile()) continue
      onDisk.add(`${stats.size}\u0000${f}`)
    }
  } catch {}

  for (const it of unique) {
    const key = `${it.fileSize || 0}\u0000${String(it.fileName || '')}`
    if (onDisk.has(key)) continue
    dm.add(chatId, chatTitle, it.messageId, it.fileId, it.fileName, it.fileSize)
  }

  return computeSelectedSave(items, chatTitle)
}

function saveSelectedLinks (items, chatTitle) {
  const { unique, remove } = packSelected.dedupe(items || [])
  const chatFolder = path.join(downloadsDir, sanitize(chatTitle))

  const onDisk = new Set()
  try {
    for (const f of fs.readdirSync(chatFolder)) {
      const stats = fs.statSync(path.join(chatFolder, f))
      if (!stats.isFile()) continue
      onDisk.add(`${stats.size}\u0000${f}`)
    }
  } catch {}

  const links = []
  let skippedOnDisk = 0
  for (const it of unique) {
    const key = `${it.fileSize || 0}\u0000${String(it.fileName || '')}`
    if (onDisk.has(key)) { skippedOnDisk++; continue }
    const url = `/dl/fetch/${encodeURIComponent(it.fileId)}?name=${encodeURIComponent(it.fileName || 'file')}&size=${it.fileSize || 0}`
    links.push({ name: it.fileName || 'file', url, size: it.fileSize || 0, messageId: it.messageId })
  }

  return { links, skippedOnDisk, duplicates: remove.length }
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
    lastMessage: chat.last_message ? chat.last_message.content : null
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
  const out = []
  for (const id of ids) {
    try {
      const chat = await client.invoke({ _: 'getChat', chat_id: id })
      const t = chat.type
      if (t && t._ === 'chatTypeSecret') continue
      out.push(serializeChat(chat))
    } catch (e) {}
  }
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
  const history = await client.invoke({
    _: 'getChatHistory',
    chat_id: chatId,
    from_message_id: fromMessageId || 0,
    offset: 0,
    limit,
    only_local: false
  })
  const messages = (history.messages || []).filter(m => m.sending_state === undefined)
  const out = []
  for (const m of messages) {
    const item = {
      id: m.id,
      date: m.date,
      text: m.content && m.content._ === 'messageText' ? (m.content.text?.text || '') : null,
      sender: await resolveSenderName(m),
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
    out.push(item)
  }
  out.sort((a, b) => (String(a.id) < String(b.id) ? 1 : -1))
  return { messages: out, hasMore: messages.length === limit }
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

// Stream a Telegram file to the client (for IDM / direct download).
// Downloads via TDLib to its local cache, then pipes the file over HTTP.
// Served as a single full-body 200 (no Range/206) so IDM grabs the file
// with one connection instead of opening parallel segment downloads.
const fetchLocks = new Map() // fileId -> Promise<localPath>

function getLocalPath (fileId) {
  if (fetchLocks.has(fileId)) return fetchLocks.get(fileId)
  const p = (async () => {
    let localPath = null
    const cached = await client.invoke({ _: 'getFile', file_id: fileId }).catch(() => null)
    if (cached && cached.local && cached.local.is_downloading_completed && cached.local.path) {
      return cached.local.path
    }
    localPath = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 10 * 60 * 1000)
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
        .then(r => {
          const local = r && r.local
          if (local && local.is_downloading_completed && local.path) {
            clearTimeout(timer)
            client.off('update', onUpdate)
            resolve(local.path)
          }
        })
        .catch(() => { clearTimeout(timer); client.off('update', onUpdate); resolve(null) })
    })
    return localPath
  })()
  fetchLocks.set(fileId, p)
  p.finally(() => fetchLocks.delete(fileId)).catch(() => {})
  return p
}

app.get('/dl/fetch/:fileId', async (req, res) => {
  const fileId = req.params.fileId
  const name = String(req.query.name || 'file')
  if (!client || !ready) return res.status(503).send('Not logged in')

  const safeName = sanitize(name)
  const size = parseInt(req.query.size, 10) || 0

  res.status(200)
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`)
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Accept-Ranges', 'none')
  res.setHeader('X-Accel-Buffering', 'no')
  if (size > 0) res.setHeader('Content-Length', size)
  res.flushHeaders()

  const localPath = await getLocalPath(fileId)
  if (!localPath) return res.destroy()

  if (!size) {
    try {
      const real = (await fs.promises.stat(localPath)).size
      res.setHeader('Content-Length', real)
    } catch {}
  }

  return fs.createReadStream(localPath)
    .on('error', () => { res.destroy() })
    .pipe(res)
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
        case 'save-selected-preview': {
          const items = payload.items || []
          const chatTitle = String(payload.chatTitle || 'Chat')
          return respond(ws, id, true, computeSelectedSave(items, chatTitle))
        }
        case 'save-selected-links': {
          const items = payload.items || []
          const chatTitle = String(payload.chatTitle || 'Chat')
          const { links, skippedOnDisk, duplicates } = saveSelectedLinks(items, chatTitle)
          return respond(ws, id, true, { links, skippedOnDisk, duplicates, count: links.length })
        }
        case 'save-selected-direct': {
          const items = payload.items || []
          const chatTitle = String(payload.chatTitle || 'Chat')
          const chatId = payload.chatId != null ? payload.chatId : chatTitle
          const out = saveSelectedDirect(items, chatTitle, chatId)
          return respond(ws, id, true, out)
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

server.listen(PORT, () => {
  console.log(`Tele Scraper running at http://localhost:${PORT}`)
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (client) await client.close().catch(() => {})
    process.exit(0)
  })
}
