'use strict'

/* Bulk upload bootstrap.
 *
 * Tagged bulk-upload requests reuse the ordinary attachment endpoint, and this
 * preload also normalizes TDLib update semantics before server.js subscribes.
 */

if (!global.__fileGramBulkUploadPreloadInstalled) {
  global.__fileGramBulkUploadPreloadInstalled = true

  const path = require('node:path')
  const tdl = require('tdl')
  const { createBulkUploadHandler } = require('./bulk-upload-server')
  const { createOwnedBulkDeleteHandler } = require('./owned-bulk-delete-server')
  const { ScalableUploadLedger } = require('./bulk-upload-ledger')

  let activeClient = null
  const uploadFileIds = new Map()
  const priorCreateClient = tdl.createClient.bind(tdl)

  function installUpdateBoundary (client) {
    if (!client || client.__fileGramUpdateBoundary) return
    if (typeof client.on !== 'function') return
    client.__fileGramUpdateBoundary = true

    const priorOn = client.on.bind(client)
    client.on = function fileGramBoundaryOn (eventName, listener) {
      if (eventName !== 'update' || typeof listener !== 'function') return priorOn(eventName, listener)
      return priorOn('update', update => {
        /* TDLib emits updateDeleteMessages(is_permanent=false) when it evicts
         * messages from its local cache. That is NOT a Telegram deletion and must
         * never reach server.js's media-index delete path or the browser's
         * message-delete event. On large channels these eviction batches can contain
         * tens of thousands of ids immediately after a complete history walk. */
        if (update && update._ === 'updateDeleteMessages' && update.is_permanent === false) return

        /* A successful outgoing message replaces its temporary negative id with the
         * final Telegram id. Retire only that synthetic id before the success update
         * is delivered so one upload cannot become two Files rows. */
        if (update && !update.__fileGramSyntheticDelete && update._ === 'updateMessageSendSucceeded' &&
            update.message && update.message.chat_id != null && update.old_message_id != null &&
            String(update.old_message_id) !== String(update.message.id)) {
          listener({
            _: 'updateDeleteMessages',
            chat_id: update.message.chat_id,
            message_ids: [update.old_message_id],
            is_permanent: true,
            from_cache: false,
            __fileGramSyntheticDelete: true
          })
        }
        return listener(update)
      })
    }
  }

  function fileFromMessage (message) {
    const c = message && message.content
    if (!c) return null
    if (c._ === 'messageDocument' && c.document) return c.document.document || null
    if (c._ === 'messageVideo' && c.video) return c.video.video || null
    if (c._ === 'messageAudio' && c.audio) return c.audio.audio || null
    if (c._ === 'messageAnimation' && c.animation) return c.animation.animation || null
    if (c._ === 'messageVoiceNote' && c.voice_note) return c.voice_note.voice || null
    if (c._ === 'messageVideoNote' && c.video_note) return c.video_note.video || null
    if (c._ === 'messageSticker' && c.sticker) return c.sticker.sticker || null
    if (c._ === 'messagePhoto' && c.photo && Array.isArray(c.photo.sizes)) {
      let best = null
      for (const size of c.photo.sizes) {
        const file = size && size.photo
        if (!file) continue
        if (!best || Number(file.size || file.expected_size || 0) > Number(best.size || best.expected_size || 0)) best = file
      }
      return best
    }
    return null
  }

  async function telegramUploadProgress (client, uploadId, record) {
    if (!client || !record || String(record.status || '') !== 'sending') return null
    let fileId = uploadFileIds.get(uploadId)

    if (!fileId && record.messageId != null && record.chatId != null) {
      let message = await client.invoke({
        _: 'getMessageLocally',
        chat_id: record.chatId,
        message_id: record.messageId
      }).catch(() => null)
      if (!message) {
        message = await client.invoke({
          _: 'getMessage',
          chat_id: record.chatId,
          message_id: record.messageId
        }).catch(() => null)
      }
      const file = fileFromMessage(message)
      if (file && Number.isSafeInteger(Number(file.id)) && Number(file.id) > 0) {
        fileId = Number(file.id)
        uploadFileIds.set(uploadId, fileId)
      }
    }

    if (!fileId) return null
    const file = await client.invoke({ _: 'getFile', file_id: fileId }).catch(() => null)
    if (!file) return null

    const remote = file.remote || {}
    const uploadedBytes = Math.max(0, Number(remote.uploaded_size || 0))
    const totalBytes = Math.max(0, Number(file.size || 0), Number(file.expected_size || 0), Number(record.size || 0))
    const complete = remote.is_uploading_completed === true
    const available = complete || uploadedBytes > 0 || remote.is_uploading_active === true
    const progress = complete
      ? 1
      : (totalBytes > 0 ? Math.max(0, Math.min(1, uploadedBytes / totalBytes)) : 0)

    return { available, fileId, uploadedBytes, totalBytes, progress, complete }
  }

  tdl.createClient = function createBulkUploadAwareClient (options) {
    const client = priorCreateClient(options)
    activeClient = client
    installUpdateBoundary(client)
    return client
  }

  const expressPath = require.resolve('express')
  const originalExpress = require(expressPath)

  function wrappedExpress (...args) {
    const app = originalExpress(...args)
    const root = __dirname
    const ledger = new ScalableUploadLedger(root)
    const active = new Set()
    const handler = createBulkUploadHandler({ root, getClient: () => activeClient, ledger, active })
    const deleteHandler = createOwnedBulkDeleteHandler({ getClient: () => activeClient })

    /* Route-specific JSON parsing is required because this preload registers the
     * endpoint before server.js installs its normal Express middleware. Ownership
     * is checked again inside deleteHandler immediately before TDLib deleteMessages. */
    app.post('/api/filegram/owned-bulk-delete/:chatId', originalExpress.json({ limit: '2mb' }), deleteHandler)

    app.post('/api/chat-attachment/:chatId', (req, res, next) => {
      const tagged = req.headers['x-filegram-upload-id']
      if (!tagged) return next()
      req.headers['x-upload-id'] = tagged
      return handler(req, res)
    })

    /* Browser refresh can sever the original POST after FileGram has already
     * staged the whole source. The append-only ledger is the durable truth for
     * that in-flight send, so a restored tab can query it before asking for file
     * access again. While a send is active, TDLib's File.remote.uploaded_size is
     * also exposed so the browser can display real Telegram transfer progress
     * rather than browser-to-localhost staging progress. */
    app.get('/api/filegram/bulk-upload-status/:uploadId', async (req, res) => {
      res.setHeader('Cache-Control', 'no-store')
      const uploadId = String(req.params.uploadId || '').trim()
      if (!/^[A-Za-z0-9._:-]{1,160}$/.test(uploadId)) {
        return res.status(400).json({ ok: false, error: 'Invalid upload id' })
      }
      try {
        const record = await ledger.get(uploadId)
        if (!record) return res.json({ ok: true, exists: false, status: 'missing' })
        const transfer = await telegramUploadProgress(activeClient, uploadId, record)
        if (String(record.status || '') === 'completed') uploadFileIds.delete(uploadId)
        return res.json({
          ok: true,
          exists: true,
          active: active.has(uploadId),
          status: String(record.status || 'unknown'),
          messageId: record.messageId != null ? record.messageId : null,
          fileName: String(record.fileName || ''),
          size: Math.max(0, Number(record.size || 0)),
          telegramProgressAvailable: !!(transfer && transfer.available),
          telegramProgress: transfer ? transfer.progress : null,
          telegramUploadedBytes: transfer ? transfer.uploadedBytes : null,
          telegramTotalBytes: transfer ? transfer.totalBytes : null,
          error: record.error ? String(record.error) : null,
          startedAt: Math.max(0, Number(record.startedAt || 0)),
          completedAt: Math.max(0, Number(record.completedAt || 0)),
          updatedAt: Math.max(0, Number(record.updatedAt || 0))
        })
      } catch (error) {
        return res.status(500).json({ ok: false, error: String(error && error.message ? error.message : error) })
      }
    })

    app.get('/api/bulk-upload-health', async (req, res) => {
      try {
        const auth = activeClient ? await activeClient.invoke({ _: 'getAuthorizationState' }).catch(() => null) : null
        res.json({ ok: true, telegramReady: !!(auth && auth._ === 'authorizationStateReady'), active: active.size })
      } catch (error) {
        res.status(500).json({ ok: false, error: String(error && error.message ? error.message : error) })
      }
    })

    global.__fileGramBulkUpload = {
      getClient: () => activeClient,
      getLedger: () => ledger,
      getActiveUploads: () => active,
      root: path.resolve(root)
    }
    return app
  }

  Object.setPrototypeOf(wrappedExpress, originalExpress)
  for (const key of Object.keys(originalExpress)) wrappedExpress[key] = originalExpress[key]
  require.cache[expressPath].exports = wrappedExpress

  global.__fileGramBulkUpload = {
    getClient: () => activeClient,
    getLedger: () => null,
    getActiveUploads: () => null,
    root: path.resolve(__dirname)
  }
}
