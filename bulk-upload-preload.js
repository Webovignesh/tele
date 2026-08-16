'use strict'

/*
 * Bulk upload bootstrap.
 *
 * This preload intentionally keeps the large upload subsystem out of server.js.
 * It captures the same TDLib client instance FileGram creates and installs the
 * idempotent /api/bulk-upload route on the same Express application. It is loaded
 * after tdl-upload-compat.js, so attachment queries still pass through the proven
 * InputFile compatibility layer.
 */

if (!global.__fileGramBulkUploadPreloadInstalled) {
  global.__fileGramBulkUploadPreloadInstalled = true

  const path = require('node:path')
  const tdl = require('tdl')
  const { installBulkUploadRoutes } = require('./bulk-upload-server')

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
    installBulkUploadRoutes(app, () => activeClient, { root: __dirname })
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
