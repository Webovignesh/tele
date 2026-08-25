'use strict'

/* Presentation companion for download-reliability-preload.js.
 * It owns no queue state. It explains the preflight when a large persistent Files
 * selection is being refreshed against Telegram, makes terminal failures explicit,
 * and prevents FileGram's historical local "completed" marker from vetoing a file
 * that the on-disk dedupe scan has just proved is missing from the download path.
 */
;(function fileGramDownloadReliabilityUi () {
  if (window.__fileGramDownloadReliabilityUiInstalled) return
  window.__fileGramDownloadReliabilityUiInstalled = true

  const completedBypass = new Map()
  const LONG_REQUEST_TYPES = new Set(['download-dedupe-preview', 'start-download'])
  const LONG_REQUEST_TIMEOUT_MS = 30 * 60 * 1000

  function addBypass (key) {
    const value = String(key || '')
    if (!value) return
    completedBypass.set(value, (completedBypass.get(value) || 0) + 1)
  }

  function removeBypass (key) {
    const value = String(key || '')
    const count = completedBypass.get(value) || 0
    if (count <= 1) completedBypass.delete(value)
    else completedBypass.set(value, count - 1)
  }

  /* app.js hard-codes a 120 second timeout inside request(). A large disk dedupe
   * plus a real 20k-40k Telegram history refresh can validly exceed that on a slow
   * connection. If the browser times out first, the server can still finish later
   * and enqueue downloads the UI believes failed - the worst possible split-brain.
   *
   * request() schedules its timeout synchronously before returning its Promise, so
   * for only these two long-running operations we temporarily map that exact 120s
   * timer to a bounded 30 minute timer, then restore setTimeout immediately. No
   * other FileGram request inherits the longer deadline. */
  function installLongRequestBoundary () {
    if (typeof request !== 'function' || request.__fileGramLongDownloadRequest) return false
    const baseRequest = request
    const wrappedRequest = function fileGramLongDownloadRequest (type, payload) {
      if (!LONG_REQUEST_TYPES.has(String(type || ''))) return baseRequest(type, payload)
      const originalSetTimeout = window.setTimeout
      window.setTimeout = function fileGramLongRequestTimer (callback, delay, ...args) {
        const nextDelay = Number(delay) === 120000 ? LONG_REQUEST_TIMEOUT_MS : delay
        return originalSetTimeout.call(window, callback, nextDelay, ...args)
      }
      try {
        return baseRequest(type, payload)
      } finally {
        window.setTimeout = originalSetTimeout
      }
    }
    wrappedRequest.__fileGramLongDownloadRequest = true
    wrappedRequest.__fileGramBase = baseRequest
    request = wrappedRequest
    return true
  }

  /* app.js and daily-driver-p1.js both used localStorage's `tele-completed` set as
   * an independent download authority. That is unsafe: users can move/delete a
   * downloaded file while the marker survives, so the exact disk scan says
   * "missing" but BOTH download wrappers silently remove it before start-download.
   *
   * Keep completed markers for presentation/Mark completed. Only while a user is
   * actively running startDownloads do the selected identities bypass that marker;
   * daily-driver-p1's filename+size disk scan remains the authority for whether the
   * file really needs to be queued. Reference counts keep overlapping calls safe. */
  function installCompletedMarkerBoundary () {
    if (typeof startDownloads !== 'function' || startDownloads.__fileGramDiskTruth) return false
    if (typeof isCompleted !== 'function') return false

    const baseStartDownloads = startDownloads
    const baseIsCompleted = isCompleted
    if (!baseIsCompleted.__fileGramDiskTruth) {
      const wrappedCompleted = function fileGramDiskTruthCompleted (key) {
        if (completedBypass.has(String(key || ''))) return false
        return baseIsCompleted(key)
      }
      wrappedCompleted.__fileGramDiskTruth = true
      wrappedCompleted.__fileGramBase = baseIsCompleted
      isCompleted = wrappedCompleted
    }

    const wrappedStart = async function fileGramDiskTruthStartDownloads (items) {
      const rows = (Array.isArray(items) ? items : []).filter(Boolean)
      const keys = []
      const activeChatId = typeof state !== 'undefined' && state ? state.activeChatId : null
      for (const item of rows) {
        const messageId = item && item.messageId
        if (messageId == null) continue
        const ownChatId = item.chatId != null ? item.chatId : activeChatId
        if (ownChatId != null) keys.push(`${ownChatId}:${messageId}`)
        /* app.js's original startDownloads still keys against state.activeChatId.
         * Include that legacy key too so the later base call cannot re-filter the
         * item after daily-driver-p1's disk scan has approved it. */
        if (activeChatId != null && String(activeChatId) !== String(ownChatId)) keys.push(`${activeChatId}:${messageId}`)
      }
      for (const key of keys) addBypass(key)
      try {
        return await baseStartDownloads.call(this, rows)
      } finally {
        for (const key of keys) removeBypass(key)
      }
    }
    wrappedStart.__fileGramDiskTruth = true
    wrappedStart.__fileGramBase = baseStartDownloads
    startDownloads = wrappedStart
    return true
  }

  function ensureBanner () {
    let banner = document.querySelector('#fg-download-health')
    if (banner) return banner
    const list = document.querySelector('#download-list')
    if (!list || !list.parentElement) return null
    banner = document.createElement('div')
    banner.id = 'fg-download-health'
    banner.hidden = true
    banner.setAttribute('role', 'status')
    list.insertAdjacentElement('beforebegin', banner)
    return banner
  }

  function paintQueueHealth () {
    const banner = ensureBanner()
    if (!banner || typeof state === 'undefined') return
    const stats = state.queueStats
    const failed = Math.max(0, Number(stats && stats.error || 0))
    if (!failed) {
      if (banner.dataset.mode !== 'preparing') banner.hidden = true
      return
    }
    const remaining = Math.max(0, Number(stats && stats.remaining || 0))
    banner.dataset.mode = 'failures'
    banner.className = 'is-error'
    banner.textContent = remaining
      ? `${failed.toLocaleString()} download${failed === 1 ? '' : 's'} failed · the remaining queue is still running`
      : `${failed.toLocaleString()} download${failed === 1 ? '' : 's'} failed · select those files again to retry with fresh Telegram references`
    banner.hidden = false
  }

  function paintReferenceProgress (payload) {
    const banner = ensureBanner()
    if (!banner) return
    banner.dataset.mode = 'preparing'
    banner.className = 'is-preparing'
    const selected = Math.max(0, Number(payload && payload.selected || 0))
    const resolved = Math.max(0, Number(payload && payload.resolved || 0))
    const scanned = Math.max(0, Number(payload && payload.scanned || 0))
    banner.textContent = `Refreshing Telegram file references… ${resolved.toLocaleString()} of ${selected.toLocaleString()} selected found · ${scanned.toLocaleString()} messages checked`
    banner.hidden = false
  }

  function finishReferenceRepair (payload) {
    const banner = ensureBanner()
    if (banner && banner.dataset.mode === 'preparing') {
      banner.hidden = true
      banner.dataset.mode = ''
    }
    const missing = Math.max(0, Number(payload && payload.missing || 0))
    if (missing && typeof toast === 'function') {
      toast(`${missing.toLocaleString()} selected file${missing === 1 ? '' : 's'} no longer exist in this Telegram chat and were skipped`, 'error')
    }
  }

  function installEventBoundary () {
    if (typeof handleEvent !== 'function' || handleEvent.__fileGramDownloadReliability) return false
    const base = handleEvent
    const wrapped = function fileGramDownloadReliabilityEvent (event) {
      if (event && event.name === 'download-reference-progress') {
        paintReferenceProgress(event.payload || {})
        return
      }
      if (event && event.name === 'download-reference-repair') {
        finishReferenceRepair(event.payload || {})
        return
      }
      const result = base(event)
      if (event && (event.name === 'download-stats' || event.name === 'download-update' || event.name === 'download-done')) {
        queueMicrotask(paintQueueHealth)
      }
      return result
    }
    wrapped.__fileGramDownloadReliability = true
    handleEvent = wrapped
    return true
  }

  function installStyle () {
    if (document.querySelector('#fg-download-health-style')) return
    const style = document.createElement('style')
    style.id = 'fg-download-health-style'
    style.textContent = `
      #fg-download-health {
        flex:0 0 auto;
        margin:8px 12px 0;
        padding:8px 10px;
        border-radius:7px;
        font-size:11px;
        line-height:1.35;
        overflow-wrap:anywhere;
      }
      #fg-download-health.is-preparing {
        color:var(--fg-text-secondary,#a4b6c8);
        background:rgba(77,163,255,.08);
        border:1px solid rgba(77,163,255,.18);
      }
      #fg-download-health.is-error {
        color:var(--fg-danger,#f04e5a);
        background:rgba(240,78,90,.07);
        border:1px solid rgba(240,78,90,.2);
      }
    `
    document.head.appendChild(style)
  }

  installStyle()
  paintQueueHealth()
  installLongRequestBoundary()
  installCompletedMarkerBoundary()
  if (!installEventBoundary() ||
      !(typeof startDownloads === 'function' && startDownloads.__fileGramDiskTruth) ||
      !(typeof request === 'function' && request.__fileGramLongDownloadRequest)) {
    let attempts = 0
    const timer = setInterval(() => {
      const eventReady = installEventBoundary() || (typeof handleEvent === 'function' && handleEvent.__fileGramDownloadReliability)
      const downloadReady = installCompletedMarkerBoundary() || (typeof startDownloads === 'function' && startDownloads.__fileGramDiskTruth)
      const requestReady = installLongRequestBoundary() || (typeof request === 'function' && request.__fileGramLongDownloadRequest)
      if ((eventReady && downloadReady && requestReady) || ++attempts > 200) clearInterval(timer)
    }, 25)
  }

  window.FileGramDownloadReliability = {
    paintQueueHealth,
    paintReferenceProgress,
    finishReferenceRepair,
    diskTruthInstalled: () => typeof startDownloads === 'function' && !!startDownloads.__fileGramDiskTruth,
    longRequestInstalled: () => typeof request === 'function' && !!request.__fileGramLongDownloadRequest,
    longRequestTimeoutMs: LONG_REQUEST_TIMEOUT_MS
  }
})()
