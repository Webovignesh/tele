'use strict'

/* FileGram bulk-upload reliability boundary.
 *
 * The upload POST first copies bytes from the browser to the local FileGram
 * process, then TDLib sends the staged file to Telegram. XHR upload progress only
 * measures the first (loopback) phase, so this layer switches to server-reported
 * TDLib progress once staging reaches EOF. It also reconnects restored queue rows
 * to the durable server-side upload ledger before asking for file access again.
 */
;(function fileGramUploadReliability () {
  if (window.__fileGramUploadReliabilityInstalled) return
  window.__fileGramUploadReliabilityInstalled = true

  const POLL_MS = 500
  const MAX_RECOVERY_MS = 35 * 60 * 1000
  const recoveries = new Map()
  let progressPollBusy = false
  let paintObserver = null
  let paintQueued = false

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const activeServerStates = new Set(['receiving', 'staged', 'sending', 'uncertain'])

  async function readServerStatus (job) {
    const response = await fetch(`/api/filegram/bulk-upload-status/${encodeURIComponent(String(job.id))}`, {
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    })
    let payload = null
    try { payload = await response.json() } catch { payload = null }
    if (!response.ok || !payload || payload.ok === false) {
      const error = new Error(String(payload && payload.error || `Upload status failed with HTTP ${response.status}`))
      error.status = response.status
      throw error
    }
    return payload
  }

  function changed (queue, type, job) {
    try { queue.changed(type, job) } catch {}
  }

  function setText (node, text) {
    if (node && node.textContent !== text) node.textContent = text
  }

  function percentOf (value) {
    return Math.max(0, Math.min(100, Math.round(Number(value || 0) * 100)))
  }

  function displayProgress (job) {
    if (!job) return 0
    if (job._transferPhase === 'telegram') return Math.max(0, Math.min(1, Number(job._telegramProgress || 0)))
    return Math.max(0, Math.min(1, Number(job.progress || 0)))
  }

  function paintJobRows (queue) {
    if (!queue) return
    for (const job of queue.jobs.values()) {
      if (!job || job.status !== 'uploading' || job._transferPhase !== 'telegram') continue
      const row = document.querySelector(`.fg-up-job[data-job-id="${CSS.escape(String(job.id))}"]`)
      if (!row) continue
      const percent = percentOf(job._telegramProgress)
      const status = row.querySelector('.fg-up-job-status')
      setText(status, job._telegramProgressAvailable ? `Uploading ${percent}%` : 'Uploading to Telegram…')
      const bar = row.querySelector('.fg-up-progress > span')
      const width = `${job._telegramProgressAvailable ? percent : 0}%`
      if (bar && bar.style.width !== width) bar.style.width = width
    }
  }

  function paintTransferPhase (queue) {
    const value = document.querySelector('#fg-upload-speed')
    if (!value || !queue) return
    const label = value.closest('.fg-up-stat')?.querySelector('span')
    setText(label, 'Status')

    const jobs = [...queue.jobs.values()]
    const staging = jobs.filter(job => job.status === 'uploading' && job._transferPhase !== 'telegram')
    const telegram = jobs.filter(job => job.status === 'uploading' && job._transferPhase === 'telegram')
    const verifying = jobs.filter(job => job.status === 'verifying')
    const retrying = jobs.filter(job => job.status === 'retrying')

    if (staging.length) {
      const totalBytes = staging.reduce((sum, job) => sum + Math.max(1, Number(job.totalBytes || job.size || 1)), 0)
      const doneBytes = staging.reduce((sum, job) => sum + displayProgress(job) * Math.max(1, Number(job.totalBytes || job.size || 1)), 0)
      setText(value, `Staging ${Math.round(doneBytes / totalBytes * 100)}%`)
      paintJobRows(queue)
      return
    }
    if (telegram.length) {
      const known = telegram.filter(job => job._telegramProgressAvailable)
      if (known.length) {
        const totalBytes = known.reduce((sum, job) => sum + Math.max(1, Number(job._telegramTotalBytes || job.size || 1)), 0)
        const doneBytes = known.reduce((sum, job) => sum + Math.max(0, Number(job._telegramUploadedBytes || 0)), 0)
        setText(value, `Uploading ${Math.max(0, Math.min(100, Math.round(doneBytes / totalBytes * 100)))}%`)
      } else {
        setText(value, 'Uploading…')
      }
      paintJobRows(queue)
      return
    }
    if (verifying.length) { setText(value, 'Verifying…'); return }
    if (retrying.length) { setText(value, 'Retrying…'); return }
    setText(value, 'Idle')
  }

  function schedulePaint (queue) {
    if (paintQueued) return
    paintQueued = true
    queueMicrotask(() => {
      paintQueued = false
      paintTransferPhase(queue)
    })
  }

  function installPaintObserver (queue) {
    if (paintObserver || typeof MutationObserver !== 'function') return
    const host = document.querySelector('#mg-uploads-pane')
    if (!host) return
    paintObserver = new MutationObserver(() => schedulePaint(queue))
    paintObserver.observe(host, { childList: true, subtree: true })
  }

  function applyServerProgress (queue, job, status) {
    if (!job || !status) return
    if (String(status.status || '') === 'sending') {
      job._transferPhase = 'telegram'
      job._telegramProgressAvailable = status.telegramProgressAvailable === true
      job._telegramProgress = status.telegramProgress != null
        ? Math.max(0, Math.min(1, Number(status.telegramProgress || 0)))
        : 0
      job._telegramUploadedBytes = status.telegramUploadedBytes != null
        ? Math.max(0, Number(status.telegramUploadedBytes || 0))
        : 0
      job._telegramTotalBytes = status.telegramTotalBytes != null
        ? Math.max(0, Number(status.telegramTotalBytes || 0))
        : Math.max(0, Number(job.size || job.totalBytes || 0))

      /* Keep the queue's normal renderer truthful too. bulk-uploads.js redraws
       * rows after queue.changed(); without synchronizing these fields it would
       * repeatedly repaint the completed localhost staging bar at 100% between
       * TDLib samples. */
      job.progress = job._telegramProgressAvailable ? job._telegramProgress : 0
      job.uploadedBytes = job._telegramProgressAvailable ? job._telegramUploadedBytes : 0
      job.totalBytes = Math.max(0, Number(job._telegramTotalBytes || job.size || 0))
      job.speed = 0
      changed(queue, 'telegram-progress', job)
    }
  }

  async function pollTelegramProgress (queue) {
    if (!queue || progressPollBusy) return
    const jobs = [...queue.jobs.values()].filter(job => job && job.status === 'uploading' && job._transferPhase === 'telegram')
    if (!jobs.length) return
    progressPollBusy = true
    try {
      await Promise.all(jobs.slice(0, 8).map(async job => {
        try {
          const status = await readServerStatus(job)
          applyServerProgress(queue, job, status)
        } catch {}
      }))
    } finally {
      progressPollBusy = false
      paintTransferPhase(queue)
    }
  }

  function completeRecovered (queue, job, status) {
    if (!job || !queue.jobs.has(String(job.id))) return
    job.status = 'completed'
    job.progress = 1
    job.uploadedBytes = Math.max(Number(job.totalBytes || 0), Number(job.size || 0), Number(job.uploadedBytes || 0))
    job.totalBytes = Math.max(Number(job.totalBytes || 0), Number(job.size || 0))
    job.speed = 0
    job.retryAt = 0
    job.error = null
    job.recovered = true
    job.completedAt = Math.max(Number(status && status.completedAt || 0), Date.now())
    job.updatedAt = Date.now()
    if (status && status.messageId != null) job.telegramMessageId = status.messageId
    job.result = { ok: true, messageId: job.telegramMessageId || null }
    delete job._transferPhase
    delete job._telegramProgress
    delete job._telegramProgressAvailable
    delete job._telegramUploadedBytes
    delete job._telegramTotalBytes
    changed(queue, 'recovered', job)
    try { queue.pump() } catch {}
  }

  function setVerifying (queue, job) {
    if (!job || ['completed', 'cancelled', 'failed'].includes(job.status)) return
    job.status = 'verifying'
    job.speed = 0
    job.error = null
    job.updatedAt = Date.now()
    changed(queue, 'verifying', job)
  }

  function stopRecovery (jobId) {
    recoveries.delete(String(jobId))
  }

  async function verifyExistingDelivery (queue, current, status) {
    if (typeof queue.verifyDelivery !== 'function') return false
    let delivered = false
    try { delivered = !!(await queue.verifyDelivery(current)) } catch {}
    if (delivered) completeRecovered(queue, current, status)
    return delivered
  }

  async function recoverJob (queue, job, fallbackStatus) {
    const id = String(job.id)
    if (recoveries.has(id)) return recoveries.get(id)

    const work = (async () => {
      const started = Date.now()
      let consecutiveStatusErrors = 0
      setVerifying(queue, job)

      while (Date.now() - started < MAX_RECOVERY_MS) {
        const current = queue.jobs.get(id)
        if (!current || ['completed', 'cancelled'].includes(current.status)) return
        if (current.status === 'paused') return

        let status
        try {
          status = await readServerStatus(current)
          consecutiveStatusErrors = 0
        } catch {
          consecutiveStatusErrors++
          if (consecutiveStatusErrors < 8) {
            await sleep(POLL_MS)
            continue
          }
          status = null
        }

        if (status && status.exists && status.status === 'completed') {
          completeRecovered(queue, current, status)
          return
        }

        if (status && status.exists && activeServerStates.has(String(status.status || ''))) {
          if (String(status.status || '') === 'sending' && status.active !== false) {
            current.status = 'uploading'
            current.error = null
            applyServerProgress(queue, current, status)
            await sleep(POLL_MS)
            continue
          }

          /* If the process that owned the send disappeared, a stale 'sending'
           * ledger record must not strand the browser indefinitely. First look for
           * the exact filename+size on Telegram; if it is not there, fall back to
           * the browser source so the normal retry path can continue. */
          if (status.status === 'uncertain' || status.active === false) {
            if (await verifyExistingDelivery(queue, current, status)) return
            if (status.active === false && status.status !== 'uncertain') break
          }
          setVerifying(queue, current)
          await sleep(POLL_MS)
          continue
        }

        break
      }

      const current = queue.jobs.get(id)
      if (!current || ['completed', 'cancelled', 'paused'].includes(current.status)) return
      current.status = fallbackStatus === 'queued' ? 'queued' : 'needs_access'
      current.speed = 0
      current.error = current.status === 'needs_access'
        ? 'Source access is required because the browser refreshed before FileGram finished staging this file'
        : null
      current.updatedAt = Date.now()
      changed(queue, current.status === 'queued' ? 'resume' : 'needs-access', current)
      if (current.status === 'queued') queue.pump()
    })().finally(() => stopRecovery(id))

    recoveries.set(id, work)
    return work
  }

  function shouldRecover (job) {
    if (!job || !job.id) return false
    if (['completed', 'cancelled', 'failed', 'paused'].includes(job.status)) return false
    if (Number(job.attempts || 0) <= 0 && Number(job.progress || 0) <= 0 && Number(job.uploadedBytes || 0) <= 0) return false
    return ['needs_access', 'queued', 'retrying', 'verifying', 'uploading'].includes(job.status)
  }

  function install (queue) {
    if (!queue || queue.__fileGramUploadReliability) return false
    queue.__fileGramUploadReliability = true

    const baseProgress = queue.progress.bind(queue)
    queue.progress = function fileGramStableUploadProgress (job, loaded, total) {
      baseProgress(job, loaded, total)
      if (!job) return

      job.speed = 0
      const bytes = Math.max(0, Number(loaded || 0))
      const max = Math.max(bytes, Number(total || 0), Number(job.size || 0))
      if (max > 0 && bytes >= max) {
        /* The localhost staging copy is complete, but the Telegram transfer is
         * starting at 0%. Reset the visible queue progress instead of leaving the
         * old staging bar at 100%. */
        job.progress = 0
        job.uploadedBytes = 0
        job.totalBytes = max
        job._transferPhase = 'telegram'
        job._telegramProgress = 0
        job._telegramProgressAvailable = false
        job._telegramUploadedBytes = 0
        job._telegramTotalBytes = max
        changed(this, 'staged', job)
        pollTelegramProgress(this).catch(() => {})
      }
      schedulePaint(this)
    }

    const baseCancel = queue.cancel.bind(queue)
    queue.cancel = function fileGramReliableCancel (id) {
      stopRecovery(id)
      return baseCancel(id)
    }

    const baseClearAll = queue.clearAll.bind(queue)
    queue.clearAll = function fileGramReliableClearAll () {
      recoveries.clear()
      return baseClearAll()
    }

    for (const job of queue.jobs.values()) {
      if (shouldRecover(job)) recoverJob(queue, job, job.handle ? 'queued' : 'needs_access').catch(() => {})
    }

    const baseChanged = queue.changed.bind(queue)
    queue.changed = function fileGramReliableChanged (type, payload) {
      const result = baseChanged(type, payload)
      const jobs = Array.isArray(payload) ? payload : (payload && payload.id ? [payload] : [])
      for (const job of jobs) {
        if (type === 'restored' || type === 'needs-access') {
          const live = this.jobs.get(String(job.id))
          if (shouldRecover(live)) recoverJob(this, live, live.handle ? 'queued' : 'needs_access').catch(() => {})
        }
        if (['completed', 'cancel', 'failed'].includes(type) && job) {
          delete job._transferPhase
          delete job._telegramProgress
          delete job._telegramProgressAvailable
          delete job._telegramUploadedBytes
          delete job._telegramTotalBytes
        }
      }
      schedulePaint(this)
      return result
    }

    installPaintObserver(queue)

    const phaseTimer = setInterval(() => {
      if (!document.documentElement.isConnected) {
        if (paintObserver) paintObserver.disconnect()
        paintObserver = null
        return clearInterval(phaseTimer)
      }
      pollTelegramProgress(queue).catch(() => {})
      paintTransferPhase(queue)
    }, POLL_MS)

    window.__fileGramUploadRecovery = {
      recover: id => {
        const job = queue.jobs.get(String(id))
        return job ? recoverJob(queue, job, job.handle ? 'queued' : 'needs_access') : Promise.resolve()
      },
      status: readServerStatus,
      poll: () => pollTelegramProgress(queue)
    }
    schedulePaint(queue)
    return true
  }

  let tries = 0
  const timer = setInterval(() => {
    const queue = window.FileGramUploads && window.FileGramUploads.queue
    if (install(queue) || ++tries > 400) clearInterval(timer)
  }, 25)
})()
