'use strict'

/* Runtime hardening for the bulk upload workspace.
 *
 * This layer deliberately does not own queue state or the Files index. It adds
 * transport/recovery guarantees around the existing owners, and normalizes the
 * temporary outgoing-message lifecycle so bulk sends cannot double the Files
 * count or make the Messages view briefly collapse while TDLib replaces ids.
 */
;(function hardenFileGramUploads () {
  if (window.__fileGramUploadsHardeningInstalled) return
  window.__fileGramUploadsHardeningInstalled = true

  const TRANSIENT_HTTP = new Set([408, 425, 429, 500, 502, 503, 504])
  const HIGH_WATER_KEY = 'tele-file-index-high-water-v1'
  const refreshTimers = new Map()
  let captionObserver = null

  function isTemporaryId (value) {
    return String(value == null ? '' : value).trim().startsWith('-')
  }

  function retryAfterMs (xhr) {
    const raw = String(xhr.getResponseHeader('Retry-After') || '').trim()
    if (!raw) return 0
    if (/^\d+$/.test(raw)) return Math.max(0, Number(raw) * 1000)
    const at = Date.parse(raw)
    return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0
  }

  function classify (xhr, payload) {
    const status = Number(xhr && xhr.status || 0)
    const error = new Error(String(payload && payload.error || `Upload failed with HTTP ${status || 0}`))
    error.status = status
    error.transient = !status || TRANSIENT_HTTP.has(status)
    error.uncertain = !status || status >= 500
    error.retryAfterMs = retryAfterMs(xhr)
    return error
  }

  function transport (job, file, context) {
    if (typeof window.__FILEGRAM_UPLOAD_TRANSPORT__ === 'function') {
      return window.__FILEGRAM_UPLOAD_TRANSPORT__(job, file, context)
    }
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      let settled = false
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        context.signal.removeEventListener('abort', abort)
        fn(value)
      }
      const abort = () => { try { xhr.abort() } catch {} }
      context.signal.addEventListener('abort', abort, { once: true })
      xhr.open('POST', `/api/chat-attachment/${encodeURIComponent(String(job.chatId))}`)
      xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name || job.name || 'file'))
      xhr.setRequestHeader('x-mime-type', encodeURIComponent(file.type || job.type || 'application/octet-stream'))
      xhr.setRequestHeader('x-filegram-upload-id', String(job.id))
      xhr.setRequestHeader('x-upload-mode', 'document')
      xhr.upload.onprogress = event => {
        context.onProgress(event.loaded, event.lengthComputable ? event.total : (file.size || job.size || 0))
      }
      xhr.onload = () => {
        let payload = null
        try { payload = JSON.parse(xhr.responseText || '{}') } catch { payload = {} }
        if (xhr.status >= 200 && xhr.status < 300) finish(resolve, payload)
        else finish(reject, classify(xhr, payload))
      }
      xhr.onerror = () => finish(reject, classify(xhr, null))
      xhr.ontimeout = () => finish(reject, classify(xhr, { error: 'Upload request timed out' }))
      xhr.onabort = () => {
        const error = new Error('Upload aborted')
        error.code = 'ABORTED'
        finish(reject, error)
      }
      xhr.timeout = 0
      xhr.send(file)
    })
  }

  function typeCounts (items) {
    const counts = {}
    for (const item of items || []) {
      if (!item || !item.type) continue
      counts[item.type] = (counts[item.type] || 0) + 1
    }
    return counts
  }

  function compareIds (a, b) {
    let aa = 0n; let bb = 0n
    try { aa = BigInt(String(a || 0)) } catch {}
    try { bb = BigInt(String(b || 0)) } catch {}
    return aa === bb ? 0 : (aa < bb ? -1 : 1)
  }

  function scrubTemporaryIndex (chatId) {
    if (chatId == null || !window.teleFilesIndex || typeof window.teleFilesIndex.snapshot !== 'function') return 0
    let snapshot = null
    try { snapshot = window.teleFilesIndex.snapshot(chatId) } catch {}
    if (!snapshot || !Array.isArray(snapshot.items)) return 0
    const removed = snapshot.items.filter(item => item && isTemporaryId(item.messageId))
    if (!removed.length) return 0

    const clean = snapshot.items.filter(item => !item || !isTemporaryId(item.messageId))
    clean.sort((a, b) => compareIds(b && b.messageId, a && a.messageId))
    snapshot.items = clean
    snapshot.found = clean.length
    snapshot.typeCounts = typeCounts(clean)
    snapshot.newestMessageId = clean.length ? clean[0].messageId : 0
    snapshot.scanned = Math.max(clean.length, Number(snapshot.scanned || 0) - removed.length)
    snapshot.savedAt = Date.now()

    try {
      const floors = JSON.parse(localStorage.getItem(HIGH_WATER_KEY) || '{}') || {}
      floors[String(chatId)] = { count: clean.length, at: Date.now() }
      localStorage.setItem(HIGH_WATER_KEY, JSON.stringify(floors))
    } catch {}
    try {
      if (typeof rescueFileCache !== 'undefined' && rescueFileCache && rescueFileCache.set) rescueFileCache.set(String(chatId), snapshot)
    } catch {}
    try {
      if (typeof teleP0v2WriteIndex === 'function') Promise.resolve(teleP0v2WriteIndex(chatId, snapshot)).catch(() => {})
    } catch {}

    try {
      if (typeof state !== 'undefined' && state && String(state.activeChatId) === String(chatId)) {
        state.mediaCount = clean.length
        state.typeCounts = snapshot.typeCounts
        if (Array.isArray(state.messages)) {
          state.messages = state.messages.filter(message => !(message && message.media && isTemporaryId(message.id)))
        }
        if (typeof rescueSaveActiveChat === 'function') rescueSaveActiveChat()
        if (state.view === 'messages' && typeof renderMessagesList === 'function') renderMessagesList()
        if (state.view === 'files' && typeof renderFiles === 'function') renderFiles()
        if (typeof updateMediaCountLabel === 'function') updateMediaCountLabel()
      }
    } catch {}
    return removed.length
  }

  function scheduleRecentRefresh (chatId) {
    const key = String(chatId == null ? '' : chatId)
    if (!key) return
    if (refreshTimers.has(key)) clearTimeout(refreshTimers.get(key))
    refreshTimers.set(key, setTimeout(async () => {
      refreshTimers.delete(key)
      try {
        if (typeof state === 'undefined' || !state || String(state.activeChatId) !== key) return
        if (typeof request !== 'function' || typeof rescueMergeMessages !== 'function') return
        const data = await request('get-messages', { chatId: Number(chatId), fromMessageId: 0, limit: 100 })
        if (String(state.activeChatId) !== key) return
        rescueMergeMessages(chatId, data && data.messages || [])
        if (typeof rescueSaveActiveChat === 'function') rescueSaveActiveChat()
        if (state.view === 'messages' && typeof renderMessagesList === 'function') renderMessagesList()
      } catch {}
    }, 350))
  }

  function installRealtimeHardening () {
    if (typeof handleEvent !== 'function' || handleEvent.__fileGramUploadRealtimeHardened) return false
    const baseHandleEvent = handleEvent
    const wrapped = function fileGramUploadStableHandleEvent (event) {
      if (event && event.name === 'message-upsert') {
        const message = event.message || event.payload && event.payload.message
        const chatId = event.chatId != null ? event.chatId : event.payload && event.payload.chatId
        if (message && message.media && message.outgoing && isTemporaryId(message.id)) return
        const result = baseHandleEvent(event)
        if (message && message.media && !isTemporaryId(message.id)) {
          scrubTemporaryIndex(chatId)
          scheduleRecentRefresh(chatId)
        }
        return result
      }
      const result = baseHandleEvent(event)
      if (event && event.name === 'message-delete') {
        const chatId = event.chatId != null ? event.chatId : event.payload && event.payload.chatId
        scrubTemporaryIndex(chatId)
      }
      return result
    }
    wrapped.__fileGramUploadRealtimeHardened = true
    handleEvent = wrapped
    try {
      if (typeof state !== 'undefined' && state && state.activeChatId != null) scrubTemporaryIndex(state.activeChatId)
    } catch {}
    return true
  }

  function removeCaptionUi () {
    document.querySelectorAll('.fg-up-caption').forEach(node => node.remove())
  }

  /* bulk-uploads exports its queue before its UI finishes mounting. A one-shot
   * removal therefore races createUi(). Observe only during bootstrap and remove
   * the caption the moment cached/new markup inserts it. */
  function installCaptionRemoval () {
    removeCaptionUi()
    if (captionObserver || !document.body) return
    captionObserver = new MutationObserver(() => removeCaptionUi())
    captionObserver.observe(document.body, { childList: true, subtree: true })
    setTimeout(() => {
      if (captionObserver) captionObserver.disconnect()
      captionObserver = null
      removeCaptionUi()
    }, 10000)
  }

  function installQueueHardening () {
    const api = window.FileGramUploads
    const queue = api && api.queue
    if (!queue) return false
    if (queue.__fileGramHardened) {
      removeCaptionUi()
      return true
    }
    queue.__fileGramHardened = true

    const baseResolve = queue.resolveSource.bind(queue)
    queue.resolveSource = async function verifiedSource (job, context) {
      const file = await baseResolve(job, context)
      if (!file) return file
      if (job.name && file.name && String(file.name) !== String(job.name)) {
        const error = new Error('Source file name changed since it was queued')
        error.code = 'SOURCE_CHANGED'
        throw error
      }
      if (Number(job.size || 0) && Number(file.size || 0) !== Number(job.size)) {
        const error = new Error('Source file size changed since it was queued')
        error.code = 'SOURCE_CHANGED'
        throw error
      }
      if (Number(job.lastModified || 0) && Number(file.lastModified || 0) && Number(file.lastModified) !== Number(job.lastModified)) {
        const error = new Error('Source file was modified since it was queued')
        error.code = 'SOURCE_CHANGED'
        throw error
      }
      return file
    }

    for (const job of queue.jobs.values()) job.caption = ''
    const baseAdd = queue.add.bind(queue)
    queue.add = function fileGramCaptionlessAdd (descriptors) {
      return baseAdd((descriptors || []).map(item => ({ ...item, caption: '' })))
    }

    queue.transport = transport

    queue.clearAll = function fileGramAtomicClearAll () {
      this.globalPaused = false
      this.cancelWake()
      for (const job of this.jobs.values()) {
        if (!this.active.has(job.id)) continue
        job._abortIntent = 'cancel'
        this.active.get(job.id)?.abort()
      }
      this.jobs.clear()
      this.order = []
      this.changed('clear-all')
    }

    removeCaptionUi()
    api.transportVersion = 4
    return true
  }

  installCaptionRemoval()
  installRealtimeHardening()
  let tries = 0
  const timer = setInterval(() => {
    installRealtimeHardening()
    installCaptionRemoval()
    if (installQueueHardening() || ++tries > 240) clearInterval(timer)
  }, 25)
})()
