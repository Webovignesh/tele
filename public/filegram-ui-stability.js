'use strict'

/* Final UI stability boundary.
 *
 * Two older render paths intentionally remain for compatibility:
 * - app.js owns the legacy toast element;
 * - bulk-uploads.js owns the upload queue DOM and redraws it periodically.
 *
 * Neither is allowed to create a visible flash. Toast updates stay continuously
 * visible when a second notification arrives, and upload progress is presented
 * through a stable overlay that the legacy speed renderer cannot overwrite.
 */
;(function fileGramUiStability () {
  if (window.__fileGramUiStabilityInstalled) return
  window.__fileGramUiStabilityInstalled = true

  const SYNC_MS = 250
  let toastTimer = null
  let uploadObserver = null
  let observedUploadList = null

  function installStableToast () {
    const node = document.querySelector('#toast')
    if (!node || window.__fileGramStableToastInstalled) return false
    window.__fileGramStableToastInstalled = true

    const stableToast = (message, type) => {
      const toastNode = document.querySelector('#toast')
      if (!toastNode) return
      const text = String(message == null ? '' : message).trim()

      clearTimeout(toastTimer)
      toastNode.classList.remove('ok', 'error')

      if (!text) {
        toastNode.textContent = ''
        toastNode.classList.remove('show')
        return
      }

      toastNode.textContent = text
      if (type === 'ok' || type === 'error') toastNode.classList.add(type)

      /* Do not remove .show and force a reflow before re-adding it. That old
       * retrigger pattern made consecutive notifications visibly disappear for a
       * frame and was the source of the intermittent empty/flash banner. */
      toastNode.classList.add('show')
      toastTimer = setTimeout(() => toastNode.classList.remove('show'), 3500)
    }

    window.toast = stableToast
    window.toastOk = message => stableToast(message, 'ok')
    return true
  }

  function installUploadStyle () {
    if (document.querySelector('#fg-upload-stable-ui-style')) return
    const style = document.createElement('style')
    style.id = 'fg-upload-stable-ui-style'
    style.textContent = `
      #fg-upload-speed[hidden] { display:none!important; }
      #fg-upload-live-status { display:block; }
      .fg-up-job.is-uploading .fg-up-job-status[data-fg-live-status] {
        font-size:0!important;
        line-height:1.2!important;
      }
      .fg-up-job.is-uploading .fg-up-job-status[data-fg-live-status]::after {
        content:attr(data-fg-live-status);
        font-size:11px!important;
        line-height:1.2!important;
        color:var(--fg-text-secondary,#a4b6c8)!important;
        white-space:nowrap;
      }
    `
    document.head.appendChild(style)
  }

  function percent (value) {
    return Math.max(0, Math.min(100, Math.round(Number(value || 0) * 100)))
  }

  function jobProgress (job) {
    if (!job) return 0
    if (job._transferPhase === 'telegram') {
      return job._telegramProgressAvailable
        ? Math.max(0, Math.min(1, Number(job._telegramProgress || 0)))
        : 0
    }
    return Math.max(0, Math.min(1, Number(job.progress || 0)))
  }

  function jobStatus (job) {
    if (!job) return ''
    if (job.status === 'uploading') {
      if (job._transferPhase === 'telegram') {
        return job._telegramProgressAvailable
          ? `Uploading ${percent(job._telegramProgress)}%`
          : 'Uploading…'
      }
      return `Staging ${percent(job.progress)}%`
    }
    if (job.status === 'verifying') return 'Verifying delivery'
    if (job.status === 'retrying') return 'Retrying…'
    if (job.status === 'paused') return 'Paused'
    if (job.status === 'needs_access') return 'Needs file access'
    if (job.status === 'queued') return 'Queued'
    if (job.status === 'completed') return job.recovered ? 'Completed · recovered' : 'Completed'
    if (job.status === 'failed') return 'Failed'
    if (job.status === 'cancelled') return 'Cancelled'
    return String(job.status || '')
  }

  function aggregateStatus (queue) {
    if (!queue || !queue.jobs) return 'Idle'
    const staging = []
    const telegram = []
    let verifying = false
    let retrying = false

    for (const job of queue.jobs.values()) {
      if (!job) continue
      if (job.status === 'uploading') {
        if (job._transferPhase === 'telegram') telegram.push(job)
        else staging.push(job)
      } else if (job.status === 'verifying') verifying = true
      else if (job.status === 'retrying') retrying = true
    }

    if (staging.length) {
      let total = 0
      let done = 0
      for (const job of staging) {
        const bytes = Math.max(1, Number(job.totalBytes || job.size || 1))
        total += bytes
        done += jobProgress(job) * bytes
      }
      return `Staging ${Math.max(0, Math.min(100, Math.round(done / Math.max(1, total) * 100)))}%`
    }

    if (telegram.length) {
      const known = telegram.filter(job => job._telegramProgressAvailable)
      if (!known.length) return 'Uploading…'
      let total = 0
      let done = 0
      for (const job of known) {
        const bytes = Math.max(1, Number(job._telegramTotalBytes || job.size || 1))
        total += bytes
        done += Math.max(0, Number(job._telegramUploadedBytes || 0))
      }
      return `Uploading ${Math.max(0, Math.min(100, Math.round(done / Math.max(1, total) * 100)))}%`
    }

    if (verifying) return 'Verifying…'
    if (retrying) return 'Retrying…'
    return 'Idle'
  }

  function ensureLiveUploadStatus () {
    const legacy = document.querySelector('#fg-upload-speed')
    if (!legacy) return null

    const label = legacy.closest('.fg-up-stat')?.querySelector('span')
    if (label && label.textContent !== 'Status') label.textContent = 'Status'

    let live = document.querySelector('#fg-upload-live-status')
    if (!live) {
      live = document.createElement('strong')
      live.id = 'fg-upload-live-status'
      live.textContent = 'Idle'
      legacy.hidden = true
      legacy.setAttribute('aria-hidden', 'true')
      legacy.insertAdjacentElement('afterend', live)
    }
    return live
  }

  function syncUploadRows (queue) {
    const list = document.querySelector('#fg-upload-list')
    if (!list || !queue || !queue.jobs) return

    for (const row of list.querySelectorAll('.fg-up-job[data-job-id]')) {
      const job = queue.jobs.get(String(row.dataset.jobId || ''))
      if (!job) continue

      const status = row.querySelector('.fg-up-job-status')
      if (status) {
        if (job.status === 'uploading') status.dataset.fgLiveStatus = jobStatus(job)
        else delete status.dataset.fgLiveStatus
      }

      if (job.status === 'uploading') {
        const bar = row.querySelector('.fg-up-progress > span')
        if (bar) {
          const width = `${percent(jobProgress(job))}%`
          if (bar.style.width !== width) bar.style.width = width
        }
      }
    }
  }

  function observeUploadRows (queue) {
    const list = document.querySelector('#fg-upload-list')
    if (!list || observedUploadList === list) return
    if (uploadObserver) uploadObserver.disconnect()
    observedUploadList = list
    uploadObserver = new MutationObserver(() => syncUploadRows(queue))
    uploadObserver.observe(list, { childList: true, subtree: true })
  }

  function syncUploadUi () {
    const queue = window.FileGramUploads && window.FileGramUploads.queue
    if (!queue) return false
    installUploadStyle()
    const live = ensureLiveUploadStatus()
    if (live) live.textContent = aggregateStatus(queue)
    syncUploadRows(queue)
    observeUploadRows(queue)
    return true
  }

  installStableToast()
  syncUploadUi()

  const timer = setInterval(() => {
    installStableToast()
    syncUploadUi()
    if (!document.documentElement.isConnected) {
      clearInterval(timer)
      if (uploadObserver) uploadObserver.disconnect()
    }
  }, SYNC_MS)

  window.FileGramUiStability = {
    sync: syncUploadUi,
    toast: (...args) => window.toast && window.toast(...args)
  }
})()
