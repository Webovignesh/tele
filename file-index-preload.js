'use strict'

/* FileGram media index engine.
 * Uses TDLib media filters for the fast path, persists resumable gzip snapshots,
 * streams batches to browsers, patches realtime changes, and indexes known chats
 * in a low-priority background queue.
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const { promisify } = require('node:util')
const tdl = require('tdl')
const wsModule = require('ws')

const gzip = promisify(zlib.gzip)
const gunzip = promisify(zlib.gunzip)
const ROOT = __dirname
const INDEX_DIR = process.env.FILEGRAM_INDEX_DIR ? path.resolve(process.env.FILEGRAM_INDEX_DIR) : path.join(ROOT, '.filegram_index')
const PAGE_SIZE = 100
const EMIT_BATCH = 1000
const PERSIST_INTERVAL_MS = 1200
const BACKGROUND_DELAY_MS = 350

fs.mkdirSync(INDEX_DIR, { recursive: true })

const FILTERS = [
  ['photo_video', { _: 'searchMessagesFilterPhotoAndVideo' }],
  ['document', { _: 'searchMessagesFilterDocument' }],
  ['audio', { _: 'searchMessagesFilterAudio' }],
  ['voice_video_note', { _: 'searchMessagesFilterVoiceAndVideoNote' }],
  ['animation', { _: 'searchMessagesFilterAnimation' }]
]

let client = null
const sockets = new Set()
const snapshots = new Map()
const loadingSnapshots = new Map()
const jobs = new Map()
const persistTimers = new Map()
const backgroundQueue = []
const backgroundQueued = new Set()
let backgroundRunning = false

function idOf (value) { return String(value) }
function delay (ms) { return new Promise(resolve => setTimeout(resolve, ms)) }
function compareMessageIds (a, b) {
  let aa = 0n
  let bb = 0n
  try { aa = BigInt(String(a || 0)) } catch {}
  try { bb = BigInt(String(b || 0)) } catch {}
  return aa === bb ? 0 : (aa < bb ? -1 : 1)
}
function maxMessageId (a, b) { return compareMessageIds(a, b) >= 0 ? a : b }
function snapshotPath (chatId) {
  return path.join(INDEX_DIR, Buffer.from(idOf(chatId)).toString('base64url') + '.json.gz')
}
function emptyCounts () {
  return { document: 0, photo: 0, video: 0, gif: 0, audio: 0, voice: 0, video_note: 0, sticker: 0 }
}
function normalizeItem (chatId, item) {
  if (!item || item.messageId == null || !item.fileId) return null
  return {
    key: `${chatId}:${item.messageId}`,
    messageId: item.messageId,
    chatId,
    date: Number(item.date || 0),
    fileId: item.fileId,
    name: String(item.name || 'file'),
    fileSize: Number(item.fileSize || 0),
    type: String(item.type || 'document'),
    mime: String(item.mime || 'application/octet-stream'),
    caption: item.caption == null ? null : String(item.caption),
    thumbFileId: item.thumbFileId || null,
    thumbUrl: null
  }
}
function createSnapshot (chatId) {
  return {
    version: 4,
    chatId,
    items: [],
    found: 0,
    scanned: 0,
    typeCounts: emptyCounts(),
    expectedCount: 0,
    newestMessageId: 0,
    complete: false,
    mainComplete: false,
    stickerComplete: false,
    filters: {},
    stickerCursor: 0,
    savedAt: Date.now(),
    updatedAt: Date.now(),
    _byMessage: new Map(),
    _dirty: false
  }
}
function hydrateSnapshot (chatId, raw) {
  const snapshot = createSnapshot(chatId)
  if (!raw || !Array.isArray(raw.items)) return snapshot
  snapshot.expectedCount = Number(raw.expectedCount || 0)
  snapshot.scanned = Number(raw.scanned || 0)
  snapshot.newestMessageId = raw.newestMessageId || 0
  snapshot.complete = !!raw.complete
  snapshot.mainComplete = !!raw.mainComplete
  snapshot.stickerComplete = !!raw.stickerComplete
  snapshot.filters = raw.filters && typeof raw.filters === 'object' ? raw.filters : {}
  snapshot.stickerCursor = raw.stickerCursor || 0
  snapshot.savedAt = Number(raw.savedAt || Date.now())
  snapshot.updatedAt = Number(raw.updatedAt || snapshot.savedAt)
  for (const rawItem of raw.items) {
    const item = normalizeItem(chatId, rawItem)
    if (item) snapshot._byMessage.set(idOf(item.messageId), item)
  }
  rebuildSnapshot(snapshot)
  snapshot._dirty = false
  return snapshot
}
function rebuildSnapshot (snapshot) {
  snapshot.items = [...snapshot._byMessage.values()].sort((a, b) => compareMessageIds(b.messageId, a.messageId))
  const counts = emptyCounts()
  let newest = snapshot.newestMessageId || 0
  for (const item of snapshot.items) {
    counts[item.type] = (counts[item.type] || 0) + 1
    newest = maxMessageId(newest, item.messageId)
  }
  snapshot.typeCounts = counts
  snapshot.found = snapshot.items.length
  snapshot.newestMessageId = newest
  snapshot.savedAt = Date.now()
  snapshot.updatedAt = Date.now()
  snapshot._dirty = false
  return snapshot
}
function serializableSnapshot (snapshot, includeItems = true) {
  if (snapshot._dirty) rebuildSnapshot(snapshot)
  return {
    version: 4,
    chatId: snapshot.chatId,
    items: includeItems ? snapshot.items.map(item => ({ ...item, thumbUrl: null })) : undefined,
    found: snapshot.found,
    scanned: snapshot.scanned,
    typeCounts: { ...snapshot.typeCounts },
    expectedCount: Math.max(Number(snapshot.expectedCount || 0), snapshot._byMessage.size),
    newestMessageId: snapshot.newestMessageId || 0,
    complete: !!snapshot.complete,
    mainComplete: !!snapshot.mainComplete,
    stickerComplete: !!snapshot.stickerComplete,
    filters: snapshot.filters,
    stickerCursor: snapshot.stickerCursor || 0,
    savedAt: snapshot.savedAt || Date.now(),
    updatedAt: snapshot.updatedAt || Date.now()
  }
}
async function loadSnapshot (chatId) {
  const id = idOf(chatId)
  if (snapshots.has(id)) return snapshots.get(id)
  if (loadingSnapshots.has(id)) return loadingSnapshots.get(id)
  const task = (async () => {
    try {
      const compressed = await fs.promises.readFile(snapshotPath(chatId))
      const parsed = JSON.parse((await gunzip(compressed)).toString('utf8'))
      const snapshot = hydrateSnapshot(chatId, parsed)
      snapshots.set(id, snapshot)
      return snapshot
    } catch {
      const snapshot = createSnapshot(chatId)
      snapshots.set(id, snapshot)
      return snapshot
    }
  })().finally(() => loadingSnapshots.delete(id))
  loadingSnapshots.set(id, task)
  return task
}
async function persistSnapshotNow (snapshot) {
  const id = idOf(snapshot.chatId)
  if (persistTimers.has(id)) {
    clearTimeout(persistTimers.get(id))
    persistTimers.delete(id)
  }
  if (snapshot._dirty) rebuildSnapshot(snapshot)
  const compressed = await gzip(Buffer.from(JSON.stringify(serializableSnapshot(snapshot, true)), 'utf8'), { level: 6 })
  const target = snapshotPath(snapshot.chatId)
  const temp = target + '.' + process.pid + '.tmp'
  await fs.promises.writeFile(temp, compressed)
  await fs.promises.rename(temp, target).catch(async () => {
    await fs.promises.rm(target, { force: true }).catch(() => {})
    await fs.promises.rename(temp, target)
  })
}
function schedulePersist (snapshot, immediate = false) {
  const id = idOf(snapshot.chatId)
  if (persistTimers.has(id)) clearTimeout(persistTimers.get(id))
  if (immediate) {
    persistTimers.delete(id)
    persistSnapshotNow(snapshot).catch(() => {})
    return
  }
  persistTimers.set(id, setTimeout(() => {
    persistTimers.delete(id)
    persistSnapshotNow(snapshot).catch(() => {})
  }, PERSIST_INTERVAL_MS))
}
function sendSocket (socket, payload) {
  try { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload)) } catch {}
}
function broadcastEvent (name, payload) {
  const message = { type: 'event', event: { name, payload } }
  for (const socket of sockets) sendSocket(socket, message)
}
function respond (socket, id, ok, data, error) {
  sendSocket(socket, { type: 'response', id, ok, data: data == null ? null : data, error: error || null })
}
function mediaThumbFileId (thumb) {
  if (!thumb) return null
  if (thumb.file && thumb.file.id) return thumb.file.id
  if (thumb.photo && thumb.photo.id) return thumb.photo.id
  return null
}
function extractMediaItem (message) {
  if (!message || !message.content) return null
  const content = message.content
  const base = { messageId: message.id, chatId: message.chat_id, date: message.date || 0 }
  let media = null
  switch (content._) {
    case 'messageDocument':
      media = { type: 'document', file: content.document && content.document.document, name: content.document && content.document.file_name || `document_${message.id}`, mime: content.document && content.document.mime_type || 'application/octet-stream', thumb: content.document && content.document.thumbnail, caption: content.caption && content.caption.text }
      break
    case 'messagePhoto': {
      const sizes = ((content.photo && content.photo.sizes) || []).slice().sort((a, b) => Number(a.size || 0) - Number(b.size || 0))
      const biggest = sizes[sizes.length - 1]
      if (biggest) media = { type: 'photo', file: biggest.photo, name: `photo_${message.id}.jpg`, mime: 'image/jpeg', thumb: sizes[0], caption: content.caption && content.caption.text }
      break
    }
    case 'messageVideo':
      media = { type: 'video', file: content.video && content.video.video, name: content.video && content.video.file_name || `video_${message.id}.mp4`, mime: content.video && content.video.mime_type || 'video/mp4', thumb: content.video && content.video.thumbnail, caption: content.caption && content.caption.text }
      break
    case 'messageAnimation':
      media = { type: 'gif', file: content.animation && content.animation.animation, name: content.animation && content.animation.file_name || `animation_${message.id}.gif`, mime: content.animation && content.animation.mime_type || 'image/gif', thumb: content.animation && content.animation.thumbnail, caption: content.caption && content.caption.text }
      break
    case 'messageAudio':
      media = { type: 'audio', file: content.audio && content.audio.audio, name: content.audio && content.audio.file_name || `audio_${message.id}.mp3`, mime: content.audio && content.audio.mime_type || 'audio/mpeg', thumb: content.audio && content.audio.album_cover_thumbnail, caption: content.caption && content.caption.text }
      break
    case 'messageVoiceNote':
      media = { type: 'voice', file: content.voice_note && content.voice_note.voice, name: `voice_${message.id}.ogg`, mime: 'audio/ogg', thumb: null, caption: content.caption && content.caption.text }
      break
    case 'messageVideoNote':
      media = { type: 'video_note', file: content.video_note && content.video_note.video, name: `video_note_${message.id}.mp4`, mime: 'video/mp4', thumb: content.video_note && (content.video_note.thumbnail || content.video_note.thumb), caption: content.caption && content.caption.text }
      break
    case 'messageSticker':
      media = { type: 'sticker', file: content.sticker && content.sticker.sticker, name: content.sticker && content.sticker.set_name ? `${content.sticker.emoji || 'sticker'}.webp` : `sticker_${message.id}.webp`, mime: 'image/webp', thumb: content.sticker && content.sticker.thumbnail, caption: null }
      break
    default:
      return null
  }
  const file = media && media.file
  if (!file || !file.id) return null
  return normalizeItem(base.chatId, {
    ...base,
    fileId: file.id,
    name: media.name,
    fileSize: file.size || file.expected_size || 0,
    type: media.type,
    mime: media.mime,
    caption: media.caption || null,
    thumbFileId: mediaThumbFileId(media.thumb)
  })
}
function upsertItem (snapshot, item) {
  const normalized = normalizeItem(snapshot.chatId, item)
  if (!normalized) return false
  const key = idOf(normalized.messageId)
  const previous = snapshot._byMessage.get(key)
  const changed = !previous || previous.fileId !== normalized.fileId || previous.fileSize !== normalized.fileSize || previous.name !== normalized.name || previous.type !== normalized.type || previous.caption !== normalized.caption
  if (!changed) return false
  if (previous && previous.type !== normalized.type) snapshot.typeCounts[previous.type] = Math.max(0, Number(snapshot.typeCounts[previous.type] || 0) - 1)
  if (!previous || previous.type !== normalized.type) snapshot.typeCounts[normalized.type] = Number(snapshot.typeCounts[normalized.type] || 0) + 1
  snapshot._byMessage.set(key, normalized)
  snapshot.found = snapshot._byMessage.size
  snapshot.newestMessageId = maxMessageId(snapshot.newestMessageId, normalized.messageId)
  snapshot.updatedAt = Date.now()
  snapshot._dirty = true
  return true
}
function removeItems (snapshot, messageIds) {
  const removed = []
  for (const messageId of messageIds || []) {
    const key = idOf(messageId)
    const previous = snapshot._byMessage.get(key)
    if (!previous) continue
    snapshot._byMessage.delete(key)
    snapshot.typeCounts[previous.type] = Math.max(0, Number(snapshot.typeCounts[previous.type] || 0) - 1)
    removed.push(messageId)
  }
  if (removed.length) {
    snapshot.found = snapshot._byMessage.size
    snapshot.updatedAt = Date.now()
    snapshot._dirty = true
  }
  return removed
}
function progressPayload (snapshot, job, items = [], extra = {}) {
  return {
    chatId: snapshot.chatId,
    jobId: job && job.jobId,
    phase: job && job.phase || 'idle',
    indexed: snapshot._byMessage.size,
    found: snapshot._byMessage.size,
    expectedCount: Math.max(Number(snapshot.expectedCount || 0), snapshot._byMessage.size),
    scanned: snapshot.scanned,
    typeCounts: { ...snapshot.typeCounts },
    newestMessageId: snapshot.newestMessageId || 0,
    complete: !!snapshot.complete,
    mainComplete: !!snapshot.mainComplete,
    stickerComplete: !!snapshot.stickerComplete,
    background: !!(job && job.background),
    done: !!extra.done,
    cancelled: !!(job && job.cancelled),
    items,
    deletedIds: extra.deletedIds || [],
    error: extra.error || null
  }
}
async function searchChatPage (chatId, cursor, filter) {
  const query = {
    _: 'searchChatMessages', chat_id: chatId, query: '', sender_id: null,
    from_message_id: cursor || 0, offset: 0, limit: PAGE_SIZE, filter,
    message_thread_id: 0, saved_messages_topic_id: 0
  }
  try { return await client.invoke(query) } catch {
    const fallback = { ...query }
    delete fallback.saved_messages_topic_id
    delete fallback.message_thread_id
    return client.invoke(fallback)
  }
}
function historyPage (chatId, cursor) {
  return client.invoke({ _: 'getChatHistory', chat_id: chatId, from_message_id: cursor || 0, offset: 0, limit: PAGE_SIZE, only_local: false })
}
function nextCursorFromResult (result, messages) {
  return result && result.next_from_message_id || (messages.length ? messages[messages.length - 1].id : 0)
}
async function scanFilter (snapshot, job, name, filter, anchorMessageId) {
  const checkpoint = snapshot.filters[name] && typeof snapshot.filters[name] === 'object' ? snapshot.filters[name] : { cursor: 0, done: false, total: 0 }
  const isDelta = !!anchorMessageId && snapshot.mainComplete
  let cursor = isDelta ? 0 : (checkpoint.done ? 0 : checkpoint.cursor || 0)
  if (!isDelta && checkpoint.done) return
  let emitted = []
  let reachedAnchor = false
  job.phase = `media:${name}`
  for (let page = 0; page < 100000 && !job.cancelled; page++) {
    const result = await searchChatPage(snapshot.chatId, cursor, filter)
    const messages = (result && result.messages || []).filter(message => message && message.sending_state === undefined)
    const total = Number(result && result.total_count || checkpoint.total || 0)
    if (!isDelta) {
      checkpoint.total = Math.max(Number(checkpoint.total || 0), total)
      snapshot.filters[name] = checkpoint
      snapshot.expectedCount = FILTERS.reduce((sum, pair) => sum + Number(snapshot.filters[pair[0]] && snapshot.filters[pair[0]].total || 0), 0)
    }
    if (!messages.length) {
      if (!isDelta) checkpoint.done = true
      break
    }
    for (const message of messages) {
      if (anchorMessageId && compareMessageIds(message.id, anchorMessageId) <= 0) {
        reachedAnchor = true
        break
      }
      snapshot.scanned++
      const item = extractMediaItem(message)
      if (item && upsertItem(snapshot, item)) emitted.push(item)
    }
    if (emitted.length >= EMIT_BATCH) {
      broadcastEvent('media-index-v4-progress', progressPayload(snapshot, job, emitted))
      emitted = []
      schedulePersist(snapshot)
    }
    if (reachedAnchor) break
    const nextCursor = nextCursorFromResult(result, messages)
    if (messages.length < PAGE_SIZE || !nextCursor) {
      if (!isDelta) checkpoint.done = true
      break
    }
    if (compareMessageIds(nextCursor, cursor) === 0) break
    cursor = nextCursor
    if (!isDelta) {
      checkpoint.cursor = cursor
      snapshot.filters[name] = checkpoint
    }
    if (page % 5 === 4) {
      broadcastEvent('media-index-v4-progress', progressPayload(snapshot, job, []))
      schedulePersist(snapshot)
    }
    await new Promise(resolve => setImmediate(resolve))
  }
  if (!isDelta && !job.cancelled && (reachedAnchor || checkpoint.done || !cursor)) {
    checkpoint.done = true
    checkpoint.cursor = 0
    snapshot.filters[name] = checkpoint
  }
  if (emitted.length) broadcastEvent('media-index-v4-progress', progressPayload(snapshot, job, emitted))
}
async function scanStickers (snapshot, job, anchorMessageId) {
  const isDelta = !!anchorMessageId && snapshot.stickerComplete
  let cursor = isDelta ? 0 : (snapshot.stickerComplete ? 0 : snapshot.stickerCursor || 0)
  if (!isDelta && snapshot.stickerComplete) return
  let emitted = []
  let reachedAnchor = false
  let exhausted = false
  job.phase = 'stickers'
  for (let page = 0; page < 100000 && !job.cancelled; page++) {
    const result = await historyPage(snapshot.chatId, cursor)
    const messages = (result && result.messages || []).filter(message => message && message.sending_state === undefined)
    if (!messages.length) { exhausted = true; break }
    for (const message of messages) {
      if (anchorMessageId && compareMessageIds(message.id, anchorMessageId) <= 0) { reachedAnchor = true; break }
      const item = extractMediaItem(message)
      if (item && item.type === 'sticker' && upsertItem(snapshot, item)) emitted.push(item)
    }
    if (emitted.length >= EMIT_BATCH) {
      broadcastEvent('media-index-v4-progress', progressPayload(snapshot, job, emitted))
      emitted = []
      schedulePersist(snapshot)
    }
    if (reachedAnchor) break
    if (messages.length < PAGE_SIZE) { exhausted = true; break }
    const nextCursor = messages[messages.length - 1] && messages[messages.length - 1].id
    if (!nextCursor || compareMessageIds(nextCursor, cursor) === 0) break
    cursor = nextCursor
    if (!isDelta) snapshot.stickerCursor = cursor
    if (page % 4 === 0) {
      broadcastEvent('media-index-v4-progress', progressPayload(snapshot, job, emitted))
      emitted = []
      schedulePersist(snapshot)
    }
    await new Promise(resolve => setImmediate(resolve))
  }
  if (!isDelta && !job.cancelled && exhausted) {
    snapshot.stickerComplete = true
    snapshot.stickerCursor = 0
  }
  if (emitted.length) broadcastEvent('media-index-v4-progress', progressPayload(snapshot, job, emitted))
}
function runIndexJob (chatId, options = {}) {
  const id = idOf(chatId)
  if (jobs.has(id)) return jobs.get(id).promise
  const job = { jobId: crypto.randomUUID(), chatId, background: !!options.background, cancelled: false, phase: 'starting', promise: null }
  job.promise = (async () => {
    const snapshot = await loadSnapshot(chatId)
    const anchor = options.forceFull ? 0 : (snapshot.complete || snapshot.mainComplete ? snapshot.newestMessageId : 0)
    if (options.forceFull) {
      snapshot.complete = false
      snapshot.mainComplete = false
      snapshot.stickerComplete = false
      snapshot.filters = {}
      snapshot.stickerCursor = 0
      snapshot.expectedCount = 0
    }
    broadcastEvent('media-index-v4-progress', progressPayload(snapshot, job, [], { done: false }))
    try {
      for (const [name, filter] of FILTERS) {
        if (job.cancelled) break
        await scanFilter(snapshot, job, name, filter, anchor)
      }
      snapshot.mainComplete = FILTERS.every(pair => snapshot.filters[pair[0]] && snapshot.filters[pair[0]].done)
      broadcastEvent('media-index-v4-progress', progressPayload(snapshot, job))
      if (!job.cancelled && options.deep !== false) await scanStickers(snapshot, job, anchor)
      snapshot.complete = snapshot.mainComplete && (options.deep === false || snapshot.stickerComplete)
      rebuildSnapshot(snapshot)
      schedulePersist(snapshot, true)
      broadcastEvent('media-index-v4-progress', progressPayload(snapshot, job, [], { done: true }))
      return serializableSnapshot(snapshot, true)
    } catch (error) {
      snapshot.complete = false
      schedulePersist(snapshot, true)
      broadcastEvent('media-index-v4-progress', progressPayload(snapshot, job, [], { done: true, error: String(error && error.message ? error.message : error) }))
      throw error
    } finally { jobs.delete(id) }
  })()
  jobs.set(id, job)
  return job.promise
}
function cancelJob (chatId) {
  const job = jobs.get(idOf(chatId))
  if (!job) return false
  job.cancelled = true
  return true
}
function queueBackgroundChats (chats) {
  for (const chat of chats || []) {
    if (!chat || chat.id == null) continue
    const kind = String(chat.kind || '')
    if (!['channel', 'supergroup', 'group', 'private'].includes(kind)) continue
    const id = idOf(chat.id)
    if (backgroundQueued.has(id)) continue
    backgroundQueued.add(id)
    backgroundQueue.push({ chatId: chat.id, kind })
  }
  processBackgroundQueue().catch(() => {})
  return backgroundQueue.length
}
async function processBackgroundQueue () {
  if (backgroundRunning) return
  backgroundRunning = true
  try {
    while (backgroundQueue.length) {
      const next = backgroundQueue.shift()
      backgroundQueued.delete(idOf(next.chatId))
      const snapshot = await loadSnapshot(next.chatId)
      const stale = Date.now() - Number(snapshot.updatedAt || 0) > 24 * 60 * 60 * 1000
      if (!snapshot.complete || stale) await runIndexJob(next.chatId, { background: true, deep: true }).catch(() => {})
      await delay(BACKGROUND_DELAY_MS)
    }
  } finally { backgroundRunning = false }
}
async function patchRealtimeMessage (message) {
  if (!message || message.chat_id == null || message.id == null) return
  const id = idOf(message.chat_id)
  if (!snapshots.has(id)) return
  const snapshot = await loadSnapshot(message.chat_id)
  const item = extractMediaItem(message)
  const changed = item ? upsertItem(snapshot, item) : removeItems(snapshot, [message.id]).length > 0
  if (!changed) return
  rebuildSnapshot(snapshot)
  schedulePersist(snapshot)
  broadcastEvent('media-index-v4-progress', progressPayload(snapshot, null, item ? [item] : [], { deletedIds: item ? [] : [message.id] }))
}
function attachClient (nextClient) {
  if (!nextClient || client === nextClient) return
  client = nextClient
  client.on('update', update => {
    if (!update) return
    if (update._ === 'updateNewMessage' || update._ === 'updateMessageSendSucceeded') {
      patchRealtimeMessage(update.message).catch(() => {})
      return
    }
    if (update._ === 'updateMessageContent' || update._ === 'updateMessageEdited') {
      client.invoke({ _: 'getMessage', chat_id: update.chat_id, message_id: update.message_id }).then(patchRealtimeMessage).catch(() => {})
      return
    }
    if (update._ === 'updateDeleteMessages') {
      const id = idOf(update.chat_id)
      if (!snapshots.has(id)) return
      loadSnapshot(update.chat_id).then(snapshot => {
        const removed = removeItems(snapshot, update.message_ids || [])
        if (!removed.length) return
        rebuildSnapshot(snapshot)
        schedulePersist(snapshot)
        broadcastEvent('media-index-v4-progress', progressPayload(snapshot, null, [], { deletedIds: removed }))
      }).catch(() => {})
    }
  })
}
const originalCreateClient = tdl.createClient.bind(tdl)
tdl.createClient = function fileGramCreateIndexedClient (options) {
  const created = originalCreateClient(options)
  attachClient(created)
  return created
}
const INDEX_TYPES = new Set(['get-file-index-v4', 'start-file-index-v4', 'cancel-file-index-v4', 'queue-file-index-v4'])
async function handleIndexMessage (socket, message) {
  const id = message.id
  const payload = message.payload || {}
  try {
    if (!client) throw new Error('Telegram session is not ready')
    if (message.type === 'get-file-index-v4') {
      const snapshot = await loadSnapshot(payload.chatId)
      return respond(socket, id, true, { snapshot: snapshot.found || snapshot.complete || snapshot.mainComplete ? serializableSnapshot(snapshot, true) : null })
    }
    if (message.type === 'start-file-index-v4') {
      const chatId = payload.chatId
      if (chatId == null) throw new Error('chatId is required')
      const existing = jobs.get(idOf(chatId))
      if (!existing) runIndexJob(chatId, { background: false, deep: payload.deep !== false, forceFull: !!payload.forceFull }).catch(() => {})
      const snapshot = await loadSnapshot(chatId)
      return respond(socket, id, true, {
        started: !existing,
        jobId: existing && existing.jobId || (jobs.get(idOf(chatId)) && jobs.get(idOf(chatId)).jobId) || null,
        summary: serializableSnapshot(snapshot, false)
      })
    }
    if (message.type === 'cancel-file-index-v4') return respond(socket, id, true, { cancelled: cancelJob(payload.chatId) })
    if (message.type === 'queue-file-index-v4') return respond(socket, id, true, { queued: queueBackgroundChats(payload.chats || []) })
  } catch (error) {
    respond(socket, id, false, null, String(error && error.message ? error.message : error))
  }
}
const OriginalWebSocketServer = wsModule.WebSocketServer
class FileGramIndexWebSocketServer extends OriginalWebSocketServer {
  constructor (options, callback) {
    super(options, callback)
    this.on('connection', socket => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      const originalOn = socket.on.bind(socket)
      socket.on = function fileGramIndexSocketOn (eventName, listener) {
        if (eventName !== 'message') return originalOn(eventName, listener)
        return originalOn('message', raw => {
          let message = null
          try { message = JSON.parse(String(raw)) } catch {}
          if (message && INDEX_TYPES.has(message.type)) return
          return listener(raw)
        })
      }
      socket.prependListener('message', raw => {
        let message
        try { message = JSON.parse(String(raw)) } catch { return }
        if (!message || !INDEX_TYPES.has(message.type)) return
        handleIndexMessage(socket, message).catch(() => {})
      })
    })
  }
}
wsModule.WebSocketServer = FileGramIndexWebSocketServer

module.exports = {
  _test: { compareMessageIds, normalizeItem, extractMediaItem, hydrateSnapshot, serializableSnapshot }
}
