'use strict'

/* Upload connection-lifetime boundary.
 *
 * The browser POST has two distinct phases:
 *   1. receive the source bytes into FileGram's local staging directory;
 *   2. TDLib sends the staged file to Telegram and FileGram waits for the final
 *      message id.
 *
 * Closing/reloading the browser must abort phase 1, because FileGram no longer
 * has a complete source file. It must NOT abort phase 2: once the request body
 * reached EOF the server owns a complete staged copy and can safely finish the
 * Telegram send without the tab that initiated it.
 *
 * bulk-upload-server.js intentionally stays the state-machine owner. This preload
 * wraps only its request-disconnect boundary before bulk-upload-preload requires
 * the factory.
 */
if (!global.__fileGramBulkUploadReliabilityInstalled) {
  global.__fileGramBulkUploadReliabilityInstalled = true

  const modulePath = require.resolve('./bulk-upload-server')
  const api = require(modulePath)
  const baseCreateBulkUploadHandler = api.createBulkUploadHandler

  function wrapRequestLifetime (handler) {
    return async function reliableBulkUploadHandler (req, res) {
      let receivingBody = true
      const originalIterator = req[Symbol.asyncIterator]
      const originalReqOnce = req.once
      const originalResOnce = res.once

      /* Mark the ownership hand-off at the exact point the HTTP request body
       * reaches EOF. A mid-body network cut never reaches done=true and therefore
       * still triggers the original abort path. */
      if (typeof originalIterator === 'function') {
        req[Symbol.asyncIterator] = function fileGramUploadIterator () {
          const iterator = originalIterator.call(this)
          const wrapped = {
            async next (...args) {
              const result = await iterator.next(...args)
              if (result && result.done) receivingBody = false
              return result
            },
            async return (...args) {
              return typeof iterator.return === 'function'
                ? iterator.return(...args)
                : { done: true, value: undefined }
            },
            async throw (...args) {
              if (typeof iterator.throw === 'function') return iterator.throw(...args)
              throw args[0]
            },
            [Symbol.asyncIterator] () { return this }
          }
          return wrapped
        }
      }

      req.once = function fileGramRequestOnce (eventName, listener) {
        if (eventName !== 'aborted' || typeof listener !== 'function') {
          return originalReqOnce.apply(this, arguments)
        }
        return originalReqOnce.call(this, eventName, function fileGramRequestAborted (...args) {
          if (receivingBody) return listener.apply(this, args)
        })
      }

      res.once = function fileGramResponseOnce (eventName, listener) {
        if (eventName !== 'close' || typeof listener !== 'function') {
          return originalResOnce.apply(this, arguments)
        }
        return originalResOnce.call(this, eventName, function fileGramResponseClosed (...args) {
          if (receivingBody) return listener.apply(this, args)
        })
      }

      try {
        return await handler(req, res)
      } finally {
        req[Symbol.asyncIterator] = originalIterator
        req.once = originalReqOnce
        res.once = originalResOnce
      }
    }
  }

  api.createBulkUploadHandler = function createReliableBulkUploadHandler (options) {
    return wrapRequestLifetime(baseCreateBulkUploadHandler(options))
  }

  /* Export a narrow test hook without exposing it to the browser or production
   * API. Unit tests exercise the phase boundary directly with fake streams. */
  global.__fileGramBulkUploadReliability = { wrapRequestLifetime }
}
