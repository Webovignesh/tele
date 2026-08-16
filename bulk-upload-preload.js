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
  const { createBulkUploadHandler, UploadLedger } = require('./bulk-upload-server')

  let activeClient = null
  const priorCreateClient = tdl.createClient.bind(tdl)
  tdl.createClient = function createBulkUploadAwareClient (options) {
    const client = priorCreateClient(options)
    activeClient = client
    return client
  }

  const expressPath = require.resolve('express')
  const originalExpress = require(expressPath)

  function wrappedExpress (...args) {
    const app = originalExpress(...args)
    const root = __dirname
    const ledger = new UploadLedger(root)
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
