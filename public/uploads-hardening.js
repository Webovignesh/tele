'use strict'

/* Runtime hardening for the bulk upload workspace.
 *
 * This layer deliberately does not own queue scheduling. It adds transport and
 * recovery guarantees around the existing owner, makes Telegram deletions
 * authoritative over the append-friendly Files index, and removes duplicate UI
 * entry points that compete with the right-panel tabs.
 */
;(function hardenFileGramUploads () {
  if (window.__fileGramUploadsHardeningInstalled) return
  window.__fileGramUploadsHardeningInstalled = true

  const TRANSIENT_HTTP = new Set([408, 425, 429, 500, 502, 503, 504])
  /* THIS LAYER NO LONGER OWNS ANY PART OF THE FILES INDEX.
   *
   * Removed: `HIGH_WATER_KEY` and `exactHighWater` (a second implementation of the
   * durable total floor), `RECONCILE_MARK_KEY` / `readReconcileMarks` /
   * `markReconciled` (the permanent per-chat mark that disabled reconciliation for a
   * chat in every LATER session, so files deleted after the stamp stayed for ever),
   * `deletedByChat` / `rememberDeletedIds` / `pruneDeletedIndex` (session-lifetime
   * tombstones that made the counts look right for one page load and were lost on
   * reload), `indexSnapshot`, `paintFileCount`, `persistSnapshot`,
   * `scrubTemporaryIndex`, `reconcilePersistedIndex`, `reconcileFlights`,
   * `reconciledThisSession`, `installIndexApiHardening` (which wrapped
   * `teleFilesIndex.snapshot`/`ensure`/`hardRefresh` to filter the owner's answers
   * through those tombstones), `reconcileActiveChat` and the 900 ms chat-switch
   * interval that drove it.
   *
   * One of those was also an active hazard rather than merely redundant:
   * `pruneDeletedIndex` edited the array of the snapshot `teleFilesIndex.snapshot()`
   * handed it, IN PLACE. The old monotonic persistence guard absorbed that - a foreign
   * in-place shrink could never reach storage - so making the boundary unconditional
   * turned it into a durable corruption, which is what broke preservation test 3.12
   * while task 5 was being written. The owner now keeps a private ledger as the merge
   * base and publishes a copy, so a legacy layer editing the exposed snapshot can
   * still change what is on screen for that session but can never become the base of a
   * commit.
   *
   * `public/files-stability.js` owns discovery, restore, reconciliation, persistence
   * and the durable floor, and exposes `reconcile` and `retireTemporary` for the two
   * things this layer legitimately needs.
   *
   * KEPT, untouched: the upload transport, retry classification, `Retry-After`
   * handling and `installQueueHardening` (clause 3.12); the temporary-id suppression
   * in `installRealtimeHardening` (clause 3.5); the Messages-tab merge in
   * `scheduleRecentRefresh`; and `removeCaptionUi` / `removeDuplicateHeaderInfo`. */
  const refreshTimers = new Map()
  let uiObserver = null

  function isTemporaryId (value) {
    return String(value == null ? '' : value).trim().startsWith('-')
  }

  function chatKey (value) { return String(value == null ? '' : value) }

  /* The one index operation this layer still performs, and it goes through the owner.
   *
   * A temporary sending id is synthetic: Telegram can never report it as present, so it
   * has no business in the durable index. The owner drops the requested ids (or every
   * temporary id it holds when none are named), repaints and persists, and deliberately
   * does NOT record them as removals - a real re-upload arrives with a real id. */
  function retireTemporaryIds (chatId, ids) {
    if (chatId == null) return
    try {
      if (window.teleFilesIndex && typeof window.teleFilesIndex.retireTemporary === 'function') {
        window.teleFilesIndex.retireTemporary(chatId, ids)
      }
    } catch {}
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

  function scheduleRecentRefresh (chatId) {
    const key = chatKey(chatId)
    if (!key) return
    if (refreshTimers.has(key)) clearTimeout(refreshTimers.get(key))
    refreshTimers.set(key, setTimeout(async () => {
      refreshTimers.delete(key)
      try {
        if (typeof state === 'undefined' || !state || chatKey(state.activeChatId) !== key) return
        if (typeof request !== 'function' || typeof rescueMergeMessages !== 'function') return
        const data = await request('get-messages', { chatId: Number(chatId), fromMessageId: 0, limit: 100 })
        if (chatKey(state.activeChatId) !== key) return
        rescueMergeMessages(chatId, data && data.messages || [])
        if (typeof rescueSaveActiveChat === 'function') rescueSaveActiveChat()
        if (state.view === 'messages' && typeof renderMessagesList === 'function') renderMessagesList()
      } catch {}
    }, 350))
  }

  /* `installIndexApiHardening` is gone.
   *
   * It wrapped the owner's `snapshot`, `ensure`, `count`, `total` and `hardRefresh` so
   * every answer was filtered through this layer's in-memory `deletedByChat` set. That
   * is what made deletions look correct for the rest of a page session and wrong again
   * after a reload, and it also meant the owner's API returned something the owner had
   * not decided. The owner records removals durably in the persistent record
   * (`removedIds`, `reconciledAt`) instead, so no filter on the way out is needed and
   * correctness no longer depends on session lifetime (clause 2.13). */

  function installRealtimeHardening () {
    if (typeof handleEvent !== 'function' || handleEvent.__fileGramUploadRealtimeHardened) return false
    const baseHandleEvent = handleEvent
    /* All that survives here is TEMPORARY-ID correctness (clause 3.5).
     *
     * An outgoing media message still carrying its temporary sending id is dropped
     * before it reaches the chain, so an optimistic row never enters the index; when the
     * real message arrives, the temporary ids are retired through the owner and the
     * Messages tab is refreshed. The delete handling that used to be here is the owner's
     * `handleRealtimeDelete`, which prunes the index AND the record and is gated on
     * `isPermanent` - this layer's version pruned on every delete event, including the
     * `is_permanent: false, from_cache: true` evictions TDLib emits in bulk after a full
     * walk (22,489 ids about ten seconds after a complete scan, measured on this host),
     * which would delete a whole channel's index for files that still exist. */
    const wrapped = function fileGramUploadStableHandleEvent (event) {
      if (event && event.name === 'message-upsert') {
        const message = event.message || event.payload && event.payload.message
        const chatId = event.chatId != null ? event.chatId : event.payload && event.payload.chatId
        if (message && message.media && message.outgoing && isTemporaryId(message.id)) return
        const result = baseHandleEvent(event)
        if (message && message.media && !isTemporaryId(message.id)) {
          retireTemporaryIds(chatId)
          scheduleRecentRefresh(chatId)
        }
        return result
      }
      return baseHandleEvent(event)
    }
    wrapped.__fileGramUploadRealtimeHardened = true
    handleEvent = wrapped
    try {
      if (typeof state !== 'undefined' && state && state.activeChatId != null) retireTemporaryIds(state.activeChatId)
    } catch {}
    return true
  }

  function removeCaptionUi () {
    document.querySelectorAll('.fg-up-caption').forEach(node => node.remove())
  }

  function removeDuplicateHeaderInfo () {
    document.querySelectorAll('#mg-open-info').forEach(node => node.remove())
  }

  /* The Save-to control is not this layer's business any more.
   *
   * `installHardeningStyles` (the injected `#fg-hardening-style`), `paintFolderButton`,
   * `installDownloadFolderPicker` and the `setDirLabel` wrapper are all gone, together
   * with the MutationObserver, the 25 ms bootstrap interval and the 15 s sweep that
   * kept re-running them. Three consequences of that machinery were measured on the
   * running app: its `#fg-hardening-style` was one of three injected
   * `width: 100% !important` rules that all lost the cascade to
   * `#mg-downloads-pane #set-dir { width: 54px !important }`; `paintFolderButton`
   * rewrote the button's innerHTML with its own internal structure, competing with two
   * other layers doing the same; and its `onclick` was silently discarded when
   * file-consistency-v2.js clone-replaced the node, so the handler the user actually
   * triggered belonged to a different layer than the markup they saw.
   *
   * One control, one stylesheet block (filegram-ui.css), one painter and one handler
   * (both in app.js). `removeCaptionUi` and `removeDuplicateHeaderInfo` keep their own
   * cleanup loop below - they are unrelated to the download folder. */
  function installUiCleanup () {
    removeCaptionUi()
    removeDuplicateHeaderInfo()
    if (uiObserver || !document.body) return

    // Bootstrap-only observer, and both callbacks below are pure removals.
    uiObserver = new MutationObserver(() => {
      removeCaptionUi()
      removeDuplicateHeaderInfo()
    })
    uiObserver.observe(document.body, { childList: true, subtree: true })
    setTimeout(() => {
      if (uiObserver) uiObserver.disconnect()
      uiObserver = null
      removeCaptionUi()
      removeDuplicateHeaderInfo()
    }, 15000)
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
    api.transportVersion = 6
    return true
  }

  /* `reconcileActiveChat` and the 900 ms chat-switch interval that called it are gone.
   *
   * They drove `reconcilePersistedIndex`, this layer's own reconciliation, against
   * `POST /api/filegram/reconcile-message-ids/:chatId` - a second truth source, deleted
   * in task 4.3, which asked "do these specific ids still exist" one getMessage at a
   * time and could see nothing the client had never indexed. Reconciliation is
   * `files-stability.js` `reconcile()`, over `media-truth-v1`, scheduled from its own
   * `openChat` wrapper once per 60 s freshness window - no polling interval, and one
   * request per pass. */

  installUiCleanup()
  installRealtimeHardening()

  let tries = 0
  const timer = setInterval(() => {
    installRealtimeHardening()
    installUiCleanup()
    if (installQueueHardening() || ++tries > 240) clearInterval(timer)
  }, 25)
})()
