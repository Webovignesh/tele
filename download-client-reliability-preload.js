'use strict'

/* TDLib download invocation boundary.
 *
 * server.js already owns queue state. This layer only hardens accepted TDLib
 * transfers: transient invoke failures are retried, File.local availability is
 * normalized for the older manager, and a tiny process-side keeper re-asserts an
 * accepted download when its BYTE COUNT has not advanced for a short window.
 *
 * Why the keeper exists: on Windows TDLib can accept downloadFile, transfer in a
 * burst, then sit quiet while an internal temp/cache transition or retry is
 * pending. The server watchdog is intentionally conservative and only checks every
 * several seconds. The user-visible result is repeated full-speed -> 0 B/s ->
 * full-speed gaps. Re-asserting downloadFile is idempotent and does not discard
 * partial bytes, so we can safely nudge only the already-active file much sooner.
 *
 * This remains global for every chat and never owns queue state, starts extra
 * queued files, changes concurrency, or cancels a healthy transfer.
 */

if (!global.__fileGramDownloadClientReliabilityInstalled) {
  global.__fileGramDownloadClientReliabilityInstalled = true

  const tdl = require('tdl')
  const priorCreateClient = tdl.createClient.bind(tdl)
  const RETRY_DELAYS_MS = [250, 750, 1500]
  const ACTIVE_STALL_MS = 1800
  const ACTIVE_SWEEP_MS = 600
  const REASSERT_MIN_MS = 1500

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

  function createActiveDownloadKeeper ({ invoke, emitUpdate, now = Date.now, setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
    const tracked = new Map()
    let sweeping = false

    function fileIdOf (value) {
      const id = Number(value)
      return Number.isFinite(id) && id !== 0 ? id : null
    }

    function track (query) {
      const fileId = fileIdOf(query && query.file_id)
      if (!fileId) return
      const stamp = now()
      const previous = tracked.get(fileId)
      tracked.set(fileId, {
        query: {
          _: 'downloadFile',
          file_id: fileId,
          priority: Math.max(1, Number(query.priority || 32)),
          offset: Number(query.offset || 0),
          limit: Number(query.limit || 0),
          synchronous: false
        },
        lastBytes: previous ? previous.lastBytes : 0,
        lastProgressAt: previous ? previous.lastProgressAt : stamp,
        lastAssertAt: stamp
      })
    }

    function forget (fileId) {
      const id = fileIdOf(fileId)
      if (id) tracked.delete(id)
    }

    function observe (file) {
      const id = fileIdOf(file && file.id)
      if (!id) return
      const state = tracked.get(id)
      if (!state) return
      const local = (file && file.local) || {}
      if (local.is_downloading_completed) {
        tracked.delete(id)
        return
      }
      const bytes = Math.max(0, Number(local.downloaded_size || 0))
      if (bytes > state.lastBytes) {
        state.lastBytes = bytes
        state.lastProgressAt = now()
      }
    }

    async function checkOne (fileId, state) {
      const stamp = now()
      if (stamp - state.lastProgressAt < ACTIVE_STALL_MS) return
      if (stamp - state.lastAssertAt < REASSERT_MIN_MS) return
      state.lastAssertAt = stamp

      const info = normalizeFileShape(await invoke({ _: 'getFile', file_id: fileId }).catch(() => null))
      if (!tracked.has(fileId)) return
      if (info && info.local && info.local.is_downloading_completed && info.local.path) {
        tracked.delete(fileId)
        try { emitUpdate(info) } catch {}
        return
      }
      if (info && info.can_be_downloaded === false) {
        tracked.delete(fileId)
        try { emitUpdate(info) } catch {}
        return
      }

      const before = state.lastBytes
      const result = await invokeDownloadWithRetry(invoke, { ...state.query, priority: 32 }).catch(() => null)
      if (!tracked.has(fileId) || !result) return
      const local = result.local || {}
      if (local.is_downloading_completed && local.path) {
        tracked.delete(fileId)
        try { emitUpdate(result) } catch {}
        return
      }
      const bytes = Math.max(0, Number(local.downloaded_size || 0))
      if (bytes > before) {
        state.lastBytes = bytes
        state.lastProgressAt = now()
      }
    }

    async function sweep () {
      if (sweeping || !tracked.size) return
      sweeping = true
      try {
        // The queue exposes at most its configured active workers here. Keep this
        // bounded and serial so recovery itself can never become an RPC storm.
        for (const [fileId, state] of [...tracked.entries()]) await checkOne(fileId, state)
      } finally {
        sweeping = false
      }
    }

    const timer = setIntervalFn(() => { Promise.resolve(sweep()).catch(() => {}) }, ACTIVE_SWEEP_MS)
    if (timer && typeof timer.unref === 'function') timer.unref()

    return {
      track,
      forget,
      observe,
      sweep,
      size: () => tracked.size,
      stop: () => clearIntervalFn(timer)
    }
  }

  tdl.createClient = function createDownloadReliableClient (options) {
    const client = priorCreateClient(options)
    if (!client || client.__fileGramDownloadClientReliability || typeof client.invoke !== 'function') return client
    client.__fileGramDownloadClientReliability = true
    const priorInvoke = client.invoke.bind(client)

    const keeper = createActiveDownloadKeeper({
      invoke: priorInvoke,
      emitUpdate: file => {
        if (file && typeof client.emit === 'function') client.emit('update', { _: 'updateFile', file })
      }
    })

    if (typeof client.on === 'function') {
      client.on('update', update => {
        if (update && update._ === 'updateFile') keeper.observe(update.file)
      })
    }

    client.invoke = async function fileGramDownloadReliableInvoke (query) {
      if (query && query._ === 'downloadFile' && query.synchronous === false) {
        keeper.track(query)
        try {
          const result = await invokeDownloadWithRetry(priorInvoke, query)
          keeper.observe(result)
          return result
        } catch (error) {
          // A rejected initial request belongs to the existing queue error path;
          // do not leave a keeper entry for work TDLib never accepted.
          keeper.forget(query.file_id)
          throw error
        }
      }
      if (query && (query._ === 'cancelDownloadFile' || query._ === 'deleteFile')) keeper.forget(query.file_id)
      const result = await priorInvoke(query)
      if (query && query._ === 'getFile') return normalizeFileShape(result)
      return result
    }
    return client
  }

  module.exports = {
    RETRY_DELAYS_MS,
    ACTIVE_STALL_MS,
    ACTIVE_SWEEP_MS,
    REASSERT_MIN_MS,
    normalizeFileShape,
    isTransientDownloadError,
    invokeDownloadWithRetry,
    createActiveDownloadKeeper
  }
}
