'use strict'

/* Presentation companion for download-reliability-preload.js.
 * It owns no queue state. It only explains the preflight when a large persistent
 * Files selection is being refreshed against Telegram and makes terminal failures
 * explicit instead of leaving a misleading "Remaining 0" card above silent rows.
 */
;(function fileGramDownloadReliabilityUi () {
  if (window.__fileGramDownloadReliabilityUiInstalled) return
  window.__fileGramDownloadReliabilityUiInstalled = true

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
  if (!installEventBoundary()) {
    let attempts = 0
    const timer = setInterval(() => {
      if (installEventBoundary() || ++attempts > 200) clearInterval(timer)
    }, 25)
  }

  window.FileGramDownloadReliability = {
    paintQueueHealth,
    paintReferenceProgress,
    finishReferenceRepair
  }
})()
