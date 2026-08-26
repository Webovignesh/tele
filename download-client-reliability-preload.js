'use strict'

/* TDLib download invocation boundary.
 *
 * server.js remains the queue owner. This layer hardens accepted TDLib transfers
 * and keeps a small, low-priority backlog registered with TDLib so the network
 * does not repeatedly fall idle between FileGram's active-worker batches.
 *
 * The warm backlog is deliberately bounded. It never changes FileGram's visible
 * concurrency, never marks extra jobs active, and is cancelled wholesale whenever
 * a download pause/cancel/clear command is issued. Active workers are always
 * promoted to max priority by the normal server request.
 */

if (!global.__fileGramDownloadClientReliabilityInstalled) {
  global.__fileGramDownloadClientReliabilityInstalled = true

  const tdl = require('tdl')
  const wsModule = require('ws')
  const priorCreateClient = tdl.createClient.bind(tdl)
  const RETRY_DELAYS_MS = [250, 750, 1500]
  const ACTIVE_STALL_MS = 1800
  const ACTIVE_SWEEP_MS = 600
  const REASSERT_MIN_MS = 1500
  const ACTIVE_PRIORITY = 32
  const WARM_PRIORITY = 8
  const WARM_AHEAD = 32

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
          priority: Math.max(1, Number(query.priority || ACTIVE_PRIORITY)),
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
      const result = await invokeDownloadWithRetry(invoke, { ...state.query, priority: ACTIVE_PRIORITY }).catch(() => null)
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

  /* Keep the next few selected Telegram files warm at low priority.
   *
   * A unique max-priority request means FileGram has promoted that file into one
   * of its real active slots. We immediately use the freed warm slot for the next
   * queued file. A warm file that completes before promotion also frees a slot.
   * This maintains a rolling backlog instead of pre-starting an unbounded batch.
   */
  function createWarmDownloadBacklog ({ invoke, warmAhead = WARM_AHEAD, warmPriority = WARM_PRIORITY } = {}) {
    const pending = []
    const known = new Set()
    const warmed = new Set()
    const promoted = new Set()
    const completed = new Set()
    let cursor = 0
    let pumping = false
    let dropped = false

    function fileIdOf (value) {
      const id = Number(value)
      return Number.isFinite(id) && id !== 0 ? id : null
    }

    async function pump () {
      if (pumping || dropped) return
      pumping = true
      try {
        while (!dropped && warmed.size < warmAhead && cursor < pending.length) {
          const fileId = pending[cursor++]
          if (!fileId || completed.has(fileId) || promoted.has(fileId) || warmed.has(fileId)) continue
          warmed.add(fileId)
          await invokeDownloadWithRetry(invoke, {
            _: 'downloadFile',
            file_id: fileId,
            priority: warmPriority,
            offset: 0,
            limit: 0,
            synchronous: false
          }).catch(() => {
            warmed.delete(fileId)
          })
        }
      } finally {
        pumping = false
      }
    }

    function prime (items) {
      dropped = false
      for (const item of Array.isArray(items) ? items : []) {
        const fileId = fileIdOf(item && (item.fileId != null ? item.fileId : item.file_id))
        if (!fileId || known.has(fileId) || completed.has(fileId)) continue
        known.add(fileId)
        pending.push(fileId)
      }
      Promise.resolve(pump()).catch(() => {})
    }

    function promote (fileId) {
      const id = fileIdOf(fileId)
      if (!id || promoted.has(id)) return
      promoted.add(id)
      warmed.delete(id)
      Promise.resolve(pump()).catch(() => {})
    }

    function observe (file) {
      const id = fileIdOf(file && file.id)
      if (!id) return
      const local = (file && file.local) || {}
      if (!local.is_downloading_completed) return
      completed.add(id)
      warmed.delete(id)
      Promise.resolve(pump()).catch(() => {})
    }

    async function drop () {
      dropped = true
      const ids = [...warmed]
      warmed.clear()
      pending.length = 0
      cursor = 0
      known.clear()
      promoted.clear()
      for (const fileId of ids) {
        await invoke({ _: 'cancelDownloadFile', file_id: fileId, only_if_pending: false }).catch(() => {})
      }
    }

    return {
      prime,
      promote,
      observe,
      drop,
      stats: () => ({ pending: Math.max(0, pending.length - cursor), warmed: warmed.size, promoted: promoted.size, completed: completed.size })
    }
  }

  let warmBridge = null

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
    const warm = createWarmDownloadBacklog({ invoke: priorInvoke })
    warmBridge = warm
    global.__fileGramDownloadWarmBacklog = warm

    if (typeof client.on === 'function') {
      client.on('update', update => {
        if (update && update._ === 'updateFile') {
          keeper.observe(update.file)
          warm.observe(update.file)
        }
      })
    }

    client.invoke = async function fileGramDownloadReliableInvoke (query) {
      if (query && query._ === 'downloadFile' && query.synchronous === false) {
        const priority = Math.max(1, Number(query.priority || ACTIVE_PRIORITY))
        if (priority >= ACTIVE_PRIORITY) {
          warm.promote(query.file_id)
          keeper.track(query)
        }
        try {
          const result = await invokeDownloadWithRetry(priorInvoke, query)
          if (priority >= ACTIVE_PRIORITY) keeper.observe(result)
          warm.observe(result)
          return result
        } catch (error) {
          if (priority >= ACTIVE_PRIORITY) keeper.forget(query.file_id)
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

  /* Safety boundary for user cancellation/pause. A warm request is deliberately
   * not a FileGram active worker, so server.js cannot know it exists. Whenever the
   * user issues any download pause/cancel/clear command, cancel the warm backlog
   * before the normal server handler runs. Correctness wins over keeping the
   * optimization alive after a manual queue intervention. */
  const previousEmit = wsModule.WebSocket.prototype.emit
  wsModule.WebSocket.prototype.emit = function fileGramWarmBacklogSocketEmit (eventName, ...args) {
    if (eventName === 'message' && args.length && warmBridge) {
      let request = null
      try {
        const raw = Buffer.isBuffer(args[0]) ? args[0].toString('utf8') : String(args[0])
        request = JSON.parse(raw)
      } catch {}
      const type = String(request && request.type || '').toLowerCase()
      if (type && /download/.test(type) && /(pause|cancel|clear|remove)/.test(type)) {
        Promise.resolve(warmBridge.drop()).catch(() => {})
      }
    }
    return previousEmit.call(this, eventName, ...args)
  }

  module.exports = {
    RETRY_DELAYS_MS,
    ACTIVE_STALL_MS,
    ACTIVE_SWEEP_MS,
    REASSERT_MIN_MS,
    ACTIVE_PRIORITY,
    WARM_PRIORITY,
    WARM_AHEAD,
    normalizeFileShape,
    isTransientDownloadError,
    invokeDownloadWithRetry,
    createActiveDownloadKeeper,
    createWarmDownloadBacklog
  }
}
