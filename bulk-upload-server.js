'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { ScalableUploadLedger } = require('./bulk-upload-ledger')

const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024
const SEND_TIMEOUT_MS = 30 * 60 * 1000

function decodeHeader (value) {
  const text = String(value || '')
  try { return decodeURIComponent(text) } catch { return text }
}

function sanitizeFileName (name) {
  return String(name || 'file')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\.+$/g, '')
    .trim()
    .slice(0, 180) || 'file'
}

function safeUploadId (value) {
  const id = String(value || '').trim()
  return /^[A-Za-z0-9._:-]{1,160}$/.test(id) ? id : ''
}

function fileSizeOf (file) {
  return Math.max(0, Number(file && (file.size || file.expected_size) || 0))
}

function attachmentMetaFromMessage (message) {
  if (!message || !message.content) return null
  const c = message.content
  if (c._ === 'messageDocument' && c.document) {
    return { name: c.document.file_name || '', size: fileSizeOf(c.document.document), kind: 'document' }
  }
  if (c._ === 'messageVideo' && c.video) {
    return { name: c.video.file_name || '', size: fileSizeOf(c.video.video), kind: 'video' }
  }
  if (c._ === 'messageAudio' && c.audio) {
    return { name: c.audio.file_name || '', size: fileSizeOf(c.audio.audio), kind: 'audio' }
  }
  if (c._ === 'messageAnimation' && c.animation) {
    return { name: c.animation.file_name || '', size: fileSizeOf(c.animation.animation), kind: 'animation' }
  }
  return null
}

function metadataMatches (record, input) {
  if (!record || !input) return false
  if (String(record.chatId) !== String(input.chatId)) return false
  if (String(record.fileName || '') !== String(input.fileName || '')) return false
  const a = Math.max(0, Number(record.size || 0))
  const b = Math.max(0, Number(input.size || 0))
  if (a && b && a !== b) return false
  if (record.mode && input.mode && record.mode !== input.mode) return false
  return true
}

function floodWaitSeconds (error) {
  const text = String(error && error.message ? error.message : error || '')
  const match = /FLOOD_WAIT[_ ]?(\d+)/i.exec(text) || /retry after\s+(\d+)/i.exec(text)
  return match ? Math.max(1, Number(match[1]) || 1) : 0
}

function statusForError (error) {
  const text = String(error && error.message ? error.message : error || '')
  if (error && error.status) return Number(error.status)
  if (/not ready|authorization|not logged/i.test(text)) return 503
  if (/owner|write forbidden|CHAT_WRITE_FORBIDDEN|not allowed/i.test(text)) return 403
  if (/too large|FILE_TOO_BIG/i.test(text)) return 413
  if (/invalid chat|invalid upload|empty|source file/i.test(text)) return 400
  if (floodWaitSeconds(error)) return 429
  return 502
}

function inputContent (mode, filePath, fileName, mimeType, caption) {
  const inputFile = { _: 'inputFileLocal', path: filePath }
  const formattedCaption = { _: 'formattedText', text: String(caption || '').slice(0, 1024), entities: [] }
  const lower = String(fileName || '').toLowerCase()
  const mime = String(mimeType || '').toLowerCase()
  const autoKind = /^image\/(jpeg|png)$/.test(mime) || /\.(jpe?g|png)$/.test(lower)
    ? 'photo'
    : (/^video\//.test(mime) || /\.(mp4|mov|m4v|webm|mkv)$/.test(lower)
        ? 'video'
        : (/^audio\//.test(mime) || /\.(mp3|m4a|aac|ogg|wav|flac)$/.test(lower) ? 'audio' : 'document'))
  const kind = mode === 'auto' ? autoKind : 'document'

  if (kind === 'photo') {
    return {
      _: 'inputMessagePhoto',
      photo: inputFile,
      thumbnail: null,
      added_sticker_file_ids: [],
      width: 0,
      height: 0,
      caption: formattedCaption,
      show_caption_above_media: false,
      self_destruct_type: null,
      has_spoiler: false
    }
  }
  if (kind === 'video') {
    return {
      _: 'inputMessageVideo',
      video: inputFile,
      thumbnail: null,
      cover: null,
      start_timestamp: 0,
      added_sticker_file_ids: [],
      duration: 0,
      width: 0,
      height: 0,
      supports_streaming: true,
      caption: formattedCaption,
      show_caption_above_media: false,
      self_destruct_type: null,
      has_spoiler: false
    }
  }
  if (kind === 'audio') {
    return {
      _: 'inputMessageAudio',
      audio: inputFile,
      album_cover_thumbnail: null,
      duration: 0,
      title: '',
      performer: '',
      caption: formattedCaption
    }
  }
  return {
    _: 'inputMessageDocument',
    document: inputFile,
    thumbnail: null,
    disable_content_type_detection: false,
    caption: formattedCaption
  }
}

async function ensureReadyOwnedChannel (client, chatId) {
  if (!client) {
    const error = new Error('Telegram session is not ready')
    error.status = 503
    throw error
  }
  const auth = await client.invoke({ _: 'getAuthorizationState' }).catch(() => null)
  if (!auth || auth._ !== 'authorizationStateReady') {
    const error = new Error('Telegram session is not ready')
    error.status = 503
    throw error
  }
  const chat = await client.invoke({ _: 'getChat', chat_id: chatId })
  const type = chat && chat.type
  if (!type || type._ !== 'chatTypeSupergroup') {
    const error = new Error('Bulk upload destination must be a channel')
    error.status = 403
    throw error
  }
  const group = await client.invoke({ _: 'getSupergroup', supergroup_id: type.supergroup_id })
  const isChannel = type.is_channel === true || group && group.is_channel === true
  const owner = group && group.status && group.status._ === 'chatMemberStatusCreator'
  if (!isChannel || !owner) {
    const error = new Error('Bulk uploads are limited to channels owned by this Telegram account')
    error.status = 403
    throw error
  }
  return chat
}

function waitForMessageSend (client, chatId, pendingMessage, signal, timeoutMs = SEND_TIMEOUT_MS) {
  if (!pendingMessage || pendingMessage.id == null) return Promise.reject(new Error('Telegram did not return a pending message'))
  if (!pendingMessage.sending_state) return Promise.resolve(pendingMessage)
  const oldId = String(pendingMessage.id)
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error, message) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      client.off('update', onUpdate)
      if (signal) signal.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(message)
    }
    const onAbort = () => {
      const error = new Error('Upload cancelled')
      error.code = 'ABORTED'
      finish(error)
    }
    const onUpdate = update => {
      if (!update) return
      if (update._ === 'updateMessageSendSucceeded' && String(update.old_message_id) === oldId && update.message && String(update.message.chat_id) === String(chatId)) {
        finish(null, update.message)
      } else if (update._ === 'updateMessageSendFailed' && String(update.old_message_id) === oldId) {
        const message = update.error_message || update.error && update.error.message || 'Telegram failed to send the file'
        const error = new Error(String(message))
        if (update.error_code) error.code = update.error_code
        finish(error)
      }
    }
    const timer = setTimeout(() => finish(new Error('Telegram upload timed out')), timeoutMs)
    client.on('update', onUpdate)
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function verifyUncertainRecord (client, record) {
  if (!record || !record.chatId || !record.fileName) return null
  if (record.messageId != null) {
    const message = await client.invoke({ _: 'getMessage', chat_id: record.chatId, message_id: record.messageId }).catch(() => null)
    if (message) {
      const meta = attachmentMetaFromMessage(message)
      if (!meta || (meta.name === record.fileName && (!record.size || !meta.size || Number(meta.size) === Number(record.size)))) return message
    }
  }
  if (record.mode !== 'document') return null
  const result = await client.invoke({
    _: 'searchChatMessages',
    chat_id: record.chatId,
    query: record.fileName,
    from_message_id: 0,
    offset: 0,
    limit: 50,
    filter: { _: 'searchMessagesFilterDocument' }
  }).catch(() => null)
  const floor = Math.floor(Number(record.startedAt || record.createdAt || Date.now()) / 1000) - 30
  for (const message of result && result.messages || []) {
    if (!message || Number(message.date || 0) < floor) continue
    const meta = attachmentMetaFromMessage(message)
    if (!meta || meta.name !== record.fileName) continue
    if (record.size && meta.size && Number(meta.size) !== Number(record.size)) continue
    return message
  }
  return null
}

function createBulkUploadHandler (options) {
  const root = options.root
  const getClient = options.getClient
  const ledger = options.ledger || new ScalableUploadLedger(root)
  const active = options.active || new Set()

  return async function bulkUploadHandler (req, res) {
    let stageDir = null
    let pendingMessage = null
    let completedResponse = false
    const abort = new AbortController()
    const onAbort = () => abort.abort()
    req.once('aborted', onAbort)
    res.once('close', () => {
      if (!completedResponse && !res.writableEnded) abort.abort()
    })

    const fail = (error) => {
      if (res.writableEnded || res.destroyed) return
      const status = statusForError(error)
      const retry = floodWaitSeconds(error)
      if (retry) res.setHeader('Retry-After', String(retry))
      res.status(status).json({ error: String(error && error.message ? error.message : error) })
    }

    let uploadId = ''
    try {
      uploadId = safeUploadId(req.headers['x-upload-id'])
      if (!uploadId) {
        const error = new Error('Invalid upload id')
        error.status = 400
        throw error
      }
      const chatId = Number(req.params.chatId)
      if (!Number.isSafeInteger(chatId)) {
        const error = new Error('Invalid chat id')
        error.status = 400
        throw error
      }
      const fileName = sanitizeFileName(decodeHeader(req.headers['x-file-name'] || 'file'))
      const mimeType = decodeHeader(req.headers['x-mime-type'] || 'application/octet-stream').slice(0, 200)
      const caption = decodeHeader(req.headers['x-caption'] || '').slice(0, 1024)
      const mode = String(req.headers['x-upload-mode'] || 'document') === 'auto' ? 'auto' : 'document'
      const expectedSize = Math.max(0, Number(req.headers['content-length'] || 0))
      if (expectedSize > MAX_UPLOAD_BYTES) {
        const error = new Error('Source file is larger than 4 GB')
        error.status = 413
        throw error
      }

      const client = getClient()
      await ensureReadyOwnedChannel(client, chatId)
      const meta = { chatId, fileName, size: expectedSize, mimeType, mode }
      const previous = await ledger.get(uploadId)
      if (previous && !metadataMatches(previous, meta)) {
        const error = new Error('This upload id is already bound to a different file or destination')
        error.status = 409
        throw error
      }
      if (previous && previous.status === 'completed') {
        req.resume()
        completedResponse = true
        return res.json({ ok: true, recovered: true, messageId: previous.messageId, message: previous.messageId != null ? { id: previous.messageId } : null })
      }
      if (active.has(uploadId)) {
        req.resume()
        const error = new Error('This upload is already active')
        error.status = 425
        throw error
      }

      if (previous && ['receiving', 'staged', 'sending', 'uncertain'].includes(previous.status)) {
        const delivered = await verifyUncertainRecord(client, previous)
        if (delivered) {
          await ledger.set(uploadId, { ...previous, status: 'completed', messageId: delivered.id, completedAt: Date.now() })
          req.resume()
          completedResponse = true
          return res.json({ ok: true, recovered: true, messageId: delivered.id, message: { id: delivered.id } })
        }
      }

      active.add(uploadId)
      const createdAt = previous && previous.createdAt || Date.now()
      await ledger.set(uploadId, { ...meta, status: 'receiving', createdAt, startedAt: previous && previous.startedAt || 0 })

      stageDir = path.join(root, '.management_uploads', 'bulk', uploadId)
      await fs.promises.rm(stageDir, { recursive: true, force: true }).catch(() => {})
      await fs.promises.mkdir(stageDir, { recursive: true })
      const tempPath = path.join(stageDir, fileName)
      const handle = await fs.promises.open(tempPath, 'wx')
      let total = 0
      try {
        for await (const chunk of req) {
          if (abort.signal.aborted) throw Object.assign(new Error('Upload cancelled'), { code: 'ABORTED' })
          total += chunk.length
          if (total > MAX_UPLOAD_BYTES) {
            const error = new Error('Source file is larger than 4 GB')
            error.status = 413
            throw error
          }
          await handle.write(chunk)
        }
      } finally {
        await handle.close().catch(() => {})
      }
      if (!total) {
        const error = new Error('Source file is empty')
        error.status = 400
        throw error
      }
      if (expectedSize && total !== expectedSize) {
        const error = new Error(`Source file transfer was incomplete (${total} of ${expectedSize} bytes)`)
        error.status = 400
        throw error
      }

      await ledger.set(uploadId, { ...meta, size: total, status: 'staged', createdAt, startedAt: previous && previous.startedAt || 0 })
      await ensureReadyOwnedChannel(client, chatId)

      const startedAt = Date.now()
      await ledger.set(uploadId, { ...meta, size: total, status: 'sending', createdAt, startedAt })
      pendingMessage = await client.invoke({
        _: 'sendMessage',
        chat_id: chatId,
        input_message_content: inputContent(mode, tempPath, fileName, mimeType, caption)
      })
      await ledger.set(uploadId, {
        ...meta,
        size: total,
        status: 'sending',
        createdAt,
        startedAt,
        messageId: pendingMessage && pendingMessage.id != null ? pendingMessage.id : null
      })
      const finalMessage = await waitForMessageSend(client, chatId, pendingMessage, abort.signal)
      await ledger.set(uploadId, {
        ...meta,
        size: total,
        status: 'completed',
        createdAt,
        startedAt,
        completedAt: Date.now(),
        messageId: finalMessage && finalMessage.id != null ? finalMessage.id : pendingMessage.id
      })
      completedResponse = true
      return res.json({ ok: true, messageId: finalMessage.id, message: { id: finalMessage.id } })
    } catch (error) {
      if (uploadId) {
        const previous = await ledger.get(uploadId).catch(() => null)
        if (previous && previous.status !== 'completed') {
          const uncertain = pendingMessage != null || statusForError(error) >= 500
          await ledger.set(uploadId, {
            ...previous,
            status: uncertain ? 'uncertain' : 'failed',
            messageId: pendingMessage && pendingMessage.id != null ? pendingMessage.id : previous.messageId,
            error: String(error && error.message ? error.message : error)
          }).catch(() => {})
        }
      }
      if (abort.signal.aborted && pendingMessage && pendingMessage.id != null) {
        const client = getClient()
        if (client) {
          await client.invoke({ _: 'deleteMessages', chat_id: Number(req.params.chatId), message_ids: [pendingMessage.id], revoke: true }).catch(() => {})
        }
      }
      fail(error)
    } finally {
      req.removeListener('aborted', onAbort)
      if (uploadId) active.delete(uploadId)
      if (stageDir) fs.promises.rm(stageDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

function installBulkUploadRoutes (app, getClient, options = {}) {
  if (!app || app.__fileGramBulkUploadRoutes) return
  app.__fileGramBulkUploadRoutes = true
  const root = options.root || __dirname
  const ledger = new ScalableUploadLedger(root)
  const active = new Set()
  app.post('/api/bulk-upload/:chatId', createBulkUploadHandler({ root, getClient, ledger, active }))
  app.get('/api/bulk-upload-health', async (req, res) => {
    try {
      const client = getClient()
      const auth = client ? await client.invoke({ _: 'getAuthorizationState' }).catch(() => null) : null
      res.json({ ok: true, telegramReady: !!(auth && auth._ === 'authorizationStateReady'), active: active.size })
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error && error.message ? error.message : error) })
    }
  })
}

module.exports = {
  installBulkUploadRoutes,
  createBulkUploadHandler,
  sanitizeFileName,
  safeUploadId,
  metadataMatches,
  attachmentMetaFromMessage,
  floodWaitSeconds,
  statusForError,
  inputContent,
  ensureReadyOwnedChannel,
  waitForMessageSend,
  verifyUncertainRecord
}
