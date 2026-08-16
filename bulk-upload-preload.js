'use strict'

/*
 * Bulk upload bootstrap.
 *
 * The ordinary composer already owns /api/chat-attachment/:chatId. Bulk uploads
 * deliberately reuse that URL so cached clients stay compatible, but tag every
 * request with x-filegram-upload-id. This preload registers first and intercepts
 * only tagged requests; all ordinary attachment requests fall through to the
 * original server.js route untouched.
 *
 * It is loaded after tdl-upload-compat.js, so bulk sendMessage calls use the same
 * proven TDLib InputFile compatibility layer as the rest of FileGram.
 */

if (!global.__fileGramBulkUploadPreloadInstalled) {
  global.__fileGramBulkUploadPreloadInstalled = true

  const path = require('node:path')
  const tdl = require('tdl')
  const { createBulkUploadHandler } = require('./bulk-upload-server')
  const { ScalableUploadLedger } = require('./bulk-upload-ledger')

  let activeClient = null
  const priorCreateClient = tdl.createClient.bind(tdl)

  /* TDLib gives an outgoing message a temporary (normally negative) id and then
   * replaces it with the final Telegram id through updateMessageSendSucceeded.
   * server.js already knows how to remove media-index rows when it receives an
   * updateDeleteMessages event, but TDLib does not emit that event for this id
   * replacement. The result was one stale temporary media row plus one final row
   * for every successful upload: 11 real files became 22 in FileGram.
   *
   * Emit the equivalent delete update BEFORE server.js processes the succeeded
   * update. This uses the existing authoritative deletion path rather than adding
   * a second media-index owner. Extra fields are ignored by TDLib consumers and
   * the synthetic marker prevents recursion.
   */
  function installTemporaryMessageRetirement (client) {
    if (!client || client.__fileGramTemporaryMessageRetirement) return
    client.__fileGramTemporaryMessageRetirement = true
    client.prependListener('update', update => {
      if (!update || update.__fileGramSyntheticDelete) return
      if (update._ !== 'updateMessageSendSucceeded') return
      if (!update.message || update.message.chat_id == null || update.old_message_id == null) return
      if (String(update.old_message_id) === String(update.message.id)) return
      client.emit('update', {
        _: 'updateDeleteMessages',
        chat_id: update.message.chat_id,
        message_ids: [update.old_message_id],
        is_permanent: true,
        from_cache: false,
        __fileGramSyntheticDelete: true
      })
    })
  }

  tdl.createClient = function createBulkUploadAwareClient (options) {
    const client = priorCreateClient(options)
    activeClient = client
    installTemporaryMessageRetirement(client)
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

    app.post('/api/chat-attachment/:chatId', (req, res, next) => {
      const tagged = req.headers['x-filegram-upload-id']
      if (!tagged) return next()
      req.headers['x-upload-id'] = tagged
      return handler(req, res)
    })

    app.get('/api/bulk-upload-health', async (req, res) => {
      try {
        const auth = activeClient ? await activeClient.invoke({ _: 'getAuthorizationState' }).catch(() => null) : null
        res.json({ ok: true, telegramReady: !!(auth && auth._ === 'authorizationStateReady'), active: active.size })
      } catch (error) {
        res.status(500).json({ ok: false, error: String(error && error.message ? error.message : error) })
      }
    })
    return app
  }

  Object.setPrototypeOf(wrappedExpress, originalExpress)
  for (const key of Object.keys(originalExpress)) wrappedExpress[key] = originalExpress[key]
  require.cache[expressPath].exports = wrappedExpress

  global.__fileGramBulkUpload = {
    getClient: () => activeClient,
    root: path.resolve(__dirname)
  }
}
