'use strict'

/* Resolve a selected download against Telegram history immediately before it is
 * handed to the download queue.
 *
 * FileGram deliberately persists its Files index so a 20k+ channel does not need
 * to be rescanned every time it is opened. TDLib's numeric File ids, however, are
 * runtime/database references and an older committed index can outlive the exact
 * File object that was current when the row was indexed. A download must therefore
 * be identified by the durable Telegram identity (chatId + messageId), not by a
 * previously cached fileId.
 *
 * Small selections use getMessage directly. Large selections walk the chat once
 * in 100-message pages and resolve every requested message during that walk, so a
 * 5,000-file selection costs roughly one history walk rather than 5,000 RPCs.
 */

const DIRECT_LOOKUP_LIMIT = 96
const DIRECT_CONCURRENCY = 16
const HISTORY_PAGE_SIZE = 100
const HISTORY_ITERATION_LIMIT = 100000

function numericId (value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number !== 0 ? number : null
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

  const fileId = numericId(file && file.id)
  if (!fileId) return null
  return {
    fileId,
    fileSize: Math.max(0, Number(file.size || file.expected_size || 0))
  }
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

function applyFreshFile (item, message) {
  const fresh = mediaFileFromMessage(message)
  if (!fresh) return null
  return {
    ...item,
    fileId: fresh.fileId,
    fileSize: fresh.fileSize > 0 ? fresh.fileSize : Math.max(0, Number(item.fileSize || 0))
  }
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

async function resolveDirect (client, chatId, items) {
  const rows = await mapConcurrent(items, DIRECT_CONCURRENCY, async item => {
    const message = await client.invoke({ _: 'getMessage', chat_id: chatId, message_id: item.messageId }).catch(() => null)
    return { item, resolved: applyFreshFile(item, message) }
  })
  return {
    items: rows.filter(row => row.resolved).map(row => row.resolved),
    missing: rows.filter(row => !row.resolved).map(row => row.item.messageId),
    complete: true,
    scanned: rows.length,
    source: 'messages'
  }
}

async function resolveByHistory (client, chatId, items, onProgress) {
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
    for (const message of messages) {
      const key = String(message.id)
      if (seenMessages.has(key)) continue
      seenMessages.add(key)
      added++
      scanned++
      const item = wanted.get(key)
      if (!item) continue
      const fresh = applyFreshFile(item, message)
      if (fresh) {
        resolved.set(key, fresh)
        wanted.delete(key)
      }
      /* If the message still exists but no longer exposes a downloadable media
       * File, keep it in `wanted`. Reaching the end of history then reports it as
       * missing/unusable instead of silently dropping it from both queued+missing. */
    }

    if (typeof onProgress === 'function' && (iteration % 10 === 0 || !wanted.size)) {
      try { onProgress({ scanned, resolved: resolved.size, remaining: wanted.size }) } catch {}
    }

    if (!wanted.size) break
    const oldest = messages[messages.length - 1]
    const nextCursor = oldest && oldest.id
    if (!nextCursor || String(nextCursor) === String(cursor) || added === 0) break
    cursor = nextCursor
  }

  /* A history walk that stopped abnormally is not allowed to turn all remaining
   * items into "deleted". Resolve those few identities directly before deciding
   * they are unavailable. A walk that reached the real end is already proof. */
  if (!complete && wanted.size) {
    const fallback = await resolveDirect(client, chatId, [...wanted.values()])
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
  if (!normalized.length) return { items: [], missing: [], refreshed: 0, selected: 0, scanned: 0, source: 'none' }

  const result = normalized.length <= DIRECT_LOOKUP_LIMIT
    ? await resolveDirect(client, numericChatId, normalized)
    : await resolveByHistory(client, numericChatId, normalized, onProgress)

  /* Keep the post-pass O(n). A 20k selection used to call Array.find once for
   * every resolved row here, turning an otherwise linear history walk back into
   * hundreds of millions of comparisons right before queueing. */
  const originalById = new Map(normalized.map(row => [String(row.messageId), row]))
  let refreshed = 0
  for (const item of result.items) {
    const original = originalById.get(String(item.messageId))
    if (original && String(original.fileId) !== String(item.fileId)) refreshed++
  }

  return {
    ...result,
    refreshed,
    selected: normalized.length
  }
}

module.exports = {
  DIRECT_LOOKUP_LIMIT,
  HISTORY_PAGE_SIZE,
  mediaFileFromMessage,
  normalizeItems,
  resolveDownloadItems
}
