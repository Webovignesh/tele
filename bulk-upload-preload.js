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
     * that in-flight send, so a restored tab can query it before asking the user
     * to locate the source file again. No file bytes are exposed here. */
    app.get('/api/filegram/bulk-upload-status/:uploadId', async (req, res) => {
      res.setHeader('Cache-Control', 'no-store')
      const uploadId = String(req.params.uploadId || '').trim()
      if (!/^[A-Za-z0-9._:-]{1,160}$/.test(uploadId)) {
        return res.status(400).json({ ok: false, error: 'Invalid upload id' })
      }
      try {
        const record = await ledger.get(uploadId)
        if (!record) return res.json({ ok: true, exists: false, status: 'missing' })
        return res.json({
          ok: true,
          exists: true,
          active: active.has(uploadId),
          status: String(record.status || 'unknown'),
          messageId: record.messageId != null ? record.messageId : null,
          fileName: String(record.fileName || ''),
          size: Math.max(0, Number(record.size || 0)),
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
