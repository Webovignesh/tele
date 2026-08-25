'use strict'

/* Resolve a selected download against Telegram history immediately before it is
 * handed to the download queue.
 *
 * FileGram deliberately persists its Files index so a 20k+ channel does not need
 * to be rescanned every time it is opened. A Telegram message gives us two file
 * identities with very different lifetimes:
 *
 * - File.id is an int32 TDLib-local identifier. It is convenient while that File
 *   object is registered in the current TDLib instance/database, but it is not the
 *   durable identity FileGram should trust after cache retirement/restarts.
 * - File.remote.id is explicitly reusable by the same Telegram user across app
 *   restarts/devices. TDLib's getRemoteFile registers that durable identity and
 *   returns the File object that downloadFile should use now.
 *
 * Therefore (chatId + messageId) finds the current message, and remote.id (when
 * present) is registered before the numeric file id is allowed into the download
 * queue. This closes the failure where getChatHistory returned a message carrying
 * an old numeric id, but downloadFile immediately answered "File not found".
 *
 * Small selections use getMessage directly. Large selections walk the chat once
 * in 100-message pages. Remote registration is bounded and deduplicated by
 * remote.id, so a 20k selection stays linear and never fans out one history RPC
 * per selected row.
 */

const DIRECT_LOOKUP_LIMIT = 96
const DIRECT_CONCURRENCY = 16
const HISTORY_PAGE_SIZE = 100
const HISTORY_ITERATION_LIMIT = 100000

function numericId (value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number !== 0 ? number : null
}

function fileDescriptor (file) {
  const fileId = numericId(file && file.id)
  if (!fileId) return null
  const local = (file && file.local) || {}
  const remote = (file && file.remote) || {}
  return {
    fileId,
    fileSize: Math.max(0, Number(file.size || file.expected_size || 0)),
    remoteFileId: String(remote.id || '').trim(),
    canBeDownloaded: local.can_be_downloaded,
    isDownloadingCompleted: local.is_downloading_completed === true && !!local.path
  }
}

function mediaFileFromMessage (message) {
  const content = message && message.content
  if (!content) return null

  let file = null
  switch (content._) {
    case 'messageDocument': file = content.document && content.document.document; break
    case 'messageVideo': file = content.video && content.video.video; break
    case 'messageAudio': file = content.audio && content.audio.audio; break
    case 'messageAnimation': file = content.animation && content.animation.animation; break
    case 'messageVoiceNote': file = content.voice_note && content.voice_note.voice; break
    case 'messageVideoNote': file = content.video_note && content.video_note.video; break
    case 'messageSticker': file = content.sticker && content.sticker.sticker; break
    case 'messagePhoto': {
      const sizes = content.photo && Array.isArray(content.photo.sizes) ? content.photo.sizes : []
      for (const size of sizes) {
        const candidate = size && size.photo
        if (!candidate) continue
        if (!file || Number(candidate.size || candidate.expected_size || 0) > Number(file.size || file.expected_size || 0)) file = candidate
      }
      break
    }
  }

  return fileDescriptor(file)
}

function normalizeItems (items) {
  const unique = []
  const seen = new Set()
  for (const raw of Array.isArray(items) ? items : []) {
    if (!raw) continue
    const messageId = numericId(raw.messageId)
    if (!messageId) continue
    const key = String(messageId)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push({ ...raw, messageId })
  }
  return unique
}

function descriptorUsable (descriptor) {
  if (!descriptor) return false
  if (descriptor.isDownloadingCompleted) return true
  return descriptor.canBeDownloaded !== false
}

async function mapConcurrent (values, limit, worker) {
  const input = Array.isArray(values) ? values : []
  const output = new Array(input.length)
  let cursor = 0
  const count = Math.max(1, Math.min(Number(limit) || 1, input.length || 1))
  await Promise.all(Array.from({ length: count }, async () => {
    while (cursor < input.length) {
      const index = cursor++
      output[index] = await worker(input[index], index)
    }
  }))
  return output
}

/* Register a message's durable remote id with TDLib.
 *
 * getRemoteFile is intentionally preferred even when the numeric id returned by
 * the message happens to equal the eventual id. Registration itself is the
 * important operation: a message can be restored from the message database while
 * its old File.id is no longer present in TDLib's file registry (for example after
 * FileGram correctly called deleteFile when a prior download was copied out).
 *
 * If remote registration is unavailable for an otherwise valid message, fall back
 * to getFile on the current numeric id. A transient getRemoteFile failure must not
 * turn a good current File into a false deletion. */
async function registerMessageFile (client, descriptor, remoteRegistrations) {
  if (!descriptor) return { descriptor: null, registered: false }

  if (descriptor.remoteFileId) {
    const remoteId = descriptor.remoteFileId
    if (!remoteRegistrations.has(remoteId)) {
      const registration = Promise.resolve()
        .then(() => client.invoke({
          _: 'getRemoteFile',
          remote_file_id: remoteId,
          // TDLib explicitly permits null when the type is unknown. The message
          // carrying this remote id has just been loaded, so the source is known.
          file_type: null
        }))
        .then(fileDescriptor)
        .catch(() => null)
      remoteRegistrations.set(remoteId, registration)
    }

    const registered = await remoteRegistrations.get(remoteId)
    if (descriptorUsable(registered)) {
      return {
        descriptor: {
          ...registered,
          remoteFileId: registered.remoteFileId || remoteId
        },
        registered: true
      }
    }
  }

  const currentFile = await client.invoke({ _: 'getFile', file_id: descriptor.fileId })
    .then(fileDescriptor)
    .catch(() => null)
  if (!descriptorUsable(currentFile)) return { descriptor: null, registered: false }
  return {
    descriptor: {
      ...currentFile,
      remoteFileId: currentFile.remoteFileId || descriptor.remoteFileId
    },
    registered: false
  }
}

async function resolveMessageFile (client, item, message, remoteRegistrations) {
  const fromMessage = mediaFileFromMessage(message)
  if (!fromMessage) return null
  const registration = await registerMessageFile(client, fromMessage, remoteRegistrations)
  const fresh = registration.descriptor
  if (!fresh) return null
  return {
    ...item,
    fileId: fresh.fileId,
    fileSize: fresh.fileSize > 0 ? fresh.fileSize : Math.max(0, Number(item.fileSize || 0)),
    remoteFileId: fresh.remoteFileId || fromMessage.remoteFileId || '',
    _fileGramRemoteRegistered: registration.registered === true
  }
}

async function resolveDirect (client, chatId, items, remoteRegistrations) {
  const rows = await mapConcurrent(items, DIRECT_CONCURRENCY, async item => {
    const message = await client.invoke({ _: 'getMessage', chat_id: chatId, message_id: item.messageId }).catch(() => null)
    return { item, resolved: await resolveMessageFile(client, item, message, remoteRegistrations) }
  })
  return {
    items: rows.filter(row => row.resolved).map(row => row.resolved),
    missing: rows.filter(row => !row.resolved).map(row => row.item.messageId),
    complete: true,
    scanned: rows.length,
    source: 'messages'
  }
}

async function resolveByHistory (client, chatId, items, onProgress, remoteRegistrations) {
  const wanted = new Map(items.map(item => [String(item.messageId), item]))
  const resolved = new Map()
  const seenMessages = new Set()
  let cursor = 0
  let scanned = 0
  let complete = false

  for (let iteration = 0; iteration < HISTORY_ITERATION_LIMIT && wanted.size; iteration++) {
    const history = await client.invoke({
      _: 'getChatHistory',
      chat_id: chatId,
      from_message_id: cursor,
      offset: 0,
      limit: HISTORY_PAGE_SIZE,
      only_local: false
    })
    const messages = (history && history.messages || []).filter(message => message && message.sending_state === undefined)
    if (!messages.length) {
      complete = true
      break
    }

    let added = 0
    const matches = []
    for (const message of messages) {
      const key = String(message.id)
      if (seenMessages.has(key)) continue
      seenMessages.add(key)
      added++
      scanned++
      const item = wanted.get(key)
      if (item) matches.push({ key, item, message })
    }

    /* Register only selected media found on this page, with bounded concurrency.
     * History pagination remains sequential (required by the cursor), but up to 16
     * offline getRemoteFile registrations within one page may proceed together. */
    const hydrated = await mapConcurrent(matches, DIRECT_CONCURRENCY, async match => ({
      key: match.key,
      resolved: await resolveMessageFile(client, match.item, match.message, remoteRegistrations)
    }))
    for (const row of hydrated) {
      if (!row.resolved) continue
      resolved.set(row.key, row.resolved)
      wanted.delete(row.key)
    }

    if (typeof onProgress === 'function' && (iteration % 10 === 0 || !wanted.size)) {
      try {
        onProgress({
          scanned,
          resolved: resolved.size,
          remaining: wanted.size,
          registered: [...resolved.values()].filter(item => item._fileGramRemoteRegistered).length
        })
      } catch {}
    }

    if (!wanted.size) break
    const oldest = messages[messages.length - 1]
    const nextCursor = oldest && oldest.id
    if (!nextCursor || String(nextCursor) === String(cursor) || added === 0) break
    cursor = nextCursor
  }

  /* A history walk that stopped abnormally is not allowed to turn all remaining
   * items into "deleted". Resolve those identities directly before deciding they
   * are unavailable. Reuse the same remote-registration cache so a fallback never
   * re-registers a remote id already attempted during the history walk. */
  if (!complete && wanted.size) {
    const fallback = await resolveDirect(client, chatId, [...wanted.values()], remoteRegistrations)
    for (const item of fallback.items) resolved.set(String(item.messageId), item)
    for (const item of fallback.items) wanted.delete(String(item.messageId))
  }

  return {
    items: items.map(item => resolved.get(String(item.messageId))).filter(Boolean),
    missing: [...wanted.values()].map(item => item.messageId),
    complete,
    scanned,
    source: 'history'
  }
}

async function resolveDownloadItems ({ client, chatId, items, onProgress } = {}) {
  if (!client || typeof client.invoke !== 'function') throw new Error('Telegram session is not ready')
  const numericChatId = numericId(chatId)
  if (!numericChatId) throw new Error('Invalid chat id')
  const normalized = normalizeItems(items)
  if (!normalized.length) return { items: [], missing: [], refreshed: 0, registered: 0, selected: 0, scanned: 0, source: 'none' }

  const remoteRegistrations = new Map()
  const result = normalized.length <= DIRECT_LOOKUP_LIMIT
    ? await resolveDirect(client, numericChatId, normalized, remoteRegistrations)
    : await resolveByHistory(client, numericChatId, normalized, onProgress, remoteRegistrations)

  /* Keep the post-pass O(n). A 20k selection used to call Array.find once for
   * every resolved row here, turning an otherwise linear history walk back into
   * hundreds of millions of comparisons right before queueing. */
  const originalById = new Map(normalized.map(row => [String(row.messageId), row]))
  let refreshed = 0
  let registered = 0
  const cleanItems = []
  for (const item of result.items) {
    const original = originalById.get(String(item.messageId))
    if (original && String(original.fileId) !== String(item.fileId)) refreshed++
    if (item._fileGramRemoteRegistered) registered++
    const clean = { ...item }
    delete clean._fileGramRemoteRegistered
    cleanItems.push(clean)
  }

  return {
    ...result,
    items: cleanItems,
    refreshed,
    registered,
    selected: normalized.length
  }
}

module.exports = {
  DIRECT_LOOKUP_LIMIT,
  HISTORY_PAGE_SIZE,
  fileDescriptor,
  mediaFileFromMessage,
  normalizeItems,
  registerMessageFile,
  resolveDownloadItems
}
