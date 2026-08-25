'use strict'

/* TDLib download invocation boundary.
 *
 * server.js already has a watchdog for an accepted download that later goes quiet,
 * but an immediate transient rejection from downloadFile currently becomes a
 * terminal job error. Also, TDLib exposes can_be_downloaded on File.local while an
 * older server check reads it from the File root. Normalize that shape here and
 * retry only genuinely transient invoke failures before the existing manager sees
 * them. This applies globally to every chat and does not own queue state.
 */

if (!global.__fileGramDownloadClientReliabilityInstalled) {
  global.__fileGramDownloadClientReliabilityInstalled = true

  const tdl = require('tdl')
  const priorCreateClient = tdl.createClient.bind(tdl)
  const RETRY_DELAYS_MS = [250, 750, 1500]

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

  function normalizeFileShape (file) {
    if (!file || typeof file !== 'object') return file
    const local = file.local
    if (local && file.can_be_downloaded === undefined && local.can_be_downloaded !== undefined) {
      file.can_be_downloaded = local.can_be_downloaded
    }
    return file
  }

  function errorCode (error) {
    const value = Number(error && (error.code != null ? error.code : error.status))
    return Number.isFinite(value) ? value : 0
  }

  function isTransientDownloadError (error) {
    const code = errorCode(error)
    if (code === 408 || code === 420 || code === 429 || (code >= 500 && code <= 599)) return true
    const message = String(error && (error.message || error) || '').toLowerCase()
    return /timeout|timed out|temporar|try again|retry|too many requests|network|connection|database is locked|request aborted|request failed/.test(message)
  }

  function retryDelay (error, attempt) {
    const message = String(error && (error.message || error) || '')
    const match = /retry\s*(?:after)?\s*(\d+)/i.exec(message)
    if (match) return Math.min(10000, Math.max(250, Number(match[1]) * 1000))
    return RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]
  }

  async function invokeDownloadWithRetry (invoke, query) {
    let lastError
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        return normalizeFileShape(await invoke(query))
      } catch (error) {
        lastError = error
        if (attempt >= RETRY_DELAYS_MS.length || !isTransientDownloadError(error)) throw error
        await sleep(retryDelay(error, attempt))
      }
    }
    throw lastError
  }

  tdl.createClient = function createDownloadReliableClient (options) {
    const client = priorCreateClient(options)
    if (!client || client.__fileGramDownloadClientReliability || typeof client.invoke !== 'function') return client
    client.__fileGramDownloadClientReliability = true
    const priorInvoke = client.invoke.bind(client)

    client.invoke = async function fileGramDownloadReliableInvoke (query) {
      if (query && query._ === 'downloadFile' && query.synchronous === false) {
        return invokeDownloadWithRetry(priorInvoke, query)
      }
      const result = await priorInvoke(query)
      if (query && query._ === 'getFile') return normalizeFileShape(result)
      return result
    }
    return client
  }

  module.exports = {
    RETRY_DELAYS_MS,
    normalizeFileShape,
    isTransientDownloadError,
    invokeDownloadWithRetry
  }
}
