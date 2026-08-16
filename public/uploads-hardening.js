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
  const HIGH_WATER_KEY = 'tele-file-index-high-water-v1'
  const RECONCILE_MARK_KEY = 'filegram-files-delete-reconcile-v1'
  const refreshTimers = new Map()
  const deletedByChat = new Map()
  const reconcileFlights = new Map()
  const reconciledThisSession = new Set()
  let uiObserver = null
  let folderPickerInstalled = false
  let indexApiPatched = false

  function isTemporaryId (value) {
    return String(value == null ? '' : value).trim().startsWith('-')
  }

  function chatKey (value) { return String(value == null ? '' : value) }

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

  function indexSnapshot (chatId) {
    try {
      if (window.teleFilesIndex && typeof window.teleFilesIndex.snapshot === 'function') {
        const snapshot = window.teleFilesIndex.snapshot(chatId)
        if (snapshot && Array.isArray(snapshot.items)) return snapshot
      }
    } catch {}
    try {
      if (typeof rescueFileCache !== 'undefined' && rescueFileCache && rescueFileCache.get) {
        const snapshot = rescueFileCache.get(chatKey(chatId))
        if (snapshot && Array.isArray(snapshot.items)) return snapshot
      }
    } catch {}
    return null
  }

  function exactHighWater (chatId, count) {
    try {
      const floors = JSON.parse(localStorage.getItem(HIGH_WATER_KEY) || '{}') || {}
      const key = chatKey(chatId)
      if (count > 0) floors[key] = { count, at: Date.now() }
      else delete floors[key]
      localStorage.setItem(HIGH_WATER_KEY, JSON.stringify(floors))
    } catch {}
  }

  function paintFileCount (chatId, snapshot) {
    try {
      if (typeof state === 'undefined' || !state || chatKey(state.activeChatId) !== chatKey(chatId)) return
      const total = Array.isArray(snapshot && snapshot.items) ? snapshot.items.length : 0
      state.mediaCount = total
      state.typeCounts = snapshot && snapshot.typeCounts || {}
      const label = document.querySelector('#chat-media-count')
      if (label) label.textContent = `${total.toLocaleString()} file${total === 1 ? '' : 's'}`
      const selectAll = document.querySelector('#select-all-media')
      if (selectAll) {
        selectAll.textContent = `Select all (${total.toLocaleString()})`
        selectAll.disabled = total === 0
      }
    } catch {}
  }

  function persistSnapshot (chatId, snapshot) {
    try {
      if (typeof rescueFileCache !== 'undefined' && rescueFileCache && rescueFileCache.set) rescueFileCache.set(chatKey(chatId), snapshot)
    } catch {}
    try {
      if (typeof teleP0v2WriteIndex === 'function') Promise.resolve(teleP0v2WriteIndex(chatId, snapshot)).catch(() => {})
    } catch {}
  }

  function rememberDeletedIds (chatId, ids) {
    const key = chatKey(chatId)
    if (!key) return new Set()
    let set = deletedByChat.get(key)
    if (!set) {
      set = new Set()
      deletedByChat.set(key, set)
    }
    for (const id of ids || []) if (id != null) set.add(String(id))
    return set
  }

  function pruneDeletedIndex (chatId, extraIds, options = {}) {
    const key = chatKey(chatId)
    if (!key) return 0
    const deleted = rememberDeletedIds(chatId, extraIds)
    const snapshot = indexSnapshot(chatId)
    if (!snapshot || !Array.isArray(snapshot.items)) return 0

    const before = snapshot.items.length
    const clean = snapshot.items.filter(item => item && !deleted.has(String(item.messageId)) && !isTemporaryId(item.messageId))
    if (clean.length === before && !(extraIds && extraIds.length)) {
      paintFileCount(chatId, snapshot)
      return 0
    }

    clean.sort((a, b) => compareIds(b && b.messageId, a && a.messageId))
    snapshot.items = clean
    snapshot.found = clean.length
    snapshot.typeCounts = typeCounts(clean)
    snapshot.newestMessageId = clean.length ? clean[0].messageId : 0
    snapshot.savedAt = Date.now()
    if (snapshot.done == null) snapshot.done = true

    exactHighWater(chatId, clean.length)
    persistSnapshot(chatId, snapshot)

    try {
      if (typeof state !== 'undefined' && state && chatKey(state.activeChatId) === key) {
        if (Array.isArray(state.messages)) {
          state.messages = state.messages.filter(message => message && !deleted.has(String(message.id)) && !isTemporaryId(message.id))
        }
        if (typeof rescueSaveActiveChat === 'function') rescueSaveActiveChat()
        paintFileCount(chatId, snapshot)
        if (options.render !== false) {
          if (state.view === 'messages' && typeof renderMessagesList === 'function') renderMessagesList()
          if (state.view === 'files' && typeof renderFiles === 'function') renderFiles()
        }
      }
    } catch {}
    return before - clean.length
  }

  function scrubTemporaryIndex (chatId) {
    const snapshot = indexSnapshot(chatId)
    if (!snapshot || !Array.isArray(snapshot.items)) return 0
    const temporary = snapshot.items.filter(item => item && isTemporaryId(item.messageId)).map(item => item.messageId)
    return temporary.length ? pruneDeletedIndex(chatId, temporary) : 0
  }

  function readReconcileMarks () {
    try { return JSON.parse(localStorage.getItem(RECONCILE_MARK_KEY) || '{}') || {} } catch { return {} }
  }

  function markReconciled (chatId) {
    try {
      const marks = readReconcileMarks()
      marks[chatKey(chatId)] = Date.now()
      localStorage.setItem(RECONCILE_MARK_KEY, JSON.stringify(marks))
    } catch {}
  }

  async function reconcilePersistedIndex (chatId, force = false) {
    const key = chatKey(chatId)
    if (!key || reconcileFlights.has(key)) return reconcileFlights.get(key) || null
    if (!force && reconciledThisSession.has(key)) return null
    const marks = readReconcileMarks()
    if (!force && Number(marks[key] || 0) > 0) {
      reconciledThisSession.add(key)
      return null
    }

    const snapshot = indexSnapshot(chatId)
    // Do not stamp a chat reconciled merely because its persistent index has not
    // finished restoring yet. That race permanently preserved stale counts on a
    // fast chat switch because the later real snapshot was never verified.
    if (!snapshot || !Array.isArray(snapshot.items)) return null
    if (!snapshot.items.length) {
      if (snapshot.done === false) return null
      reconciledThisSession.add(key)
      markReconciled(chatId)
      exactHighWater(chatId, 0)
      paintFileCount(chatId, snapshot)
      return null
    }

    const flight = (async () => {
      let unknown = 0
      const ids = snapshot.items.map(item => String(item.messageId)).filter(id => /^-?\d+$/.test(id))
      for (let offset = 0; offset < ids.length; offset += 750) {
        const messageIds = ids.slice(offset, offset + 750)
        const response = await fetch(`/api/filegram/reconcile-message-ids/${encodeURIComponent(String(chatId))}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messageIds })
        })
        let payload = {}
        try { payload = await response.json() } catch {}
        if (!response.ok || !payload.ok) throw new Error(payload.error || `Index reconciliation failed (${response.status})`)
        unknown += Array.isArray(payload.unknown) ? payload.unknown.length : 0
        const missing = Array.isArray(payload.missing) ? payload.missing : []
        if (missing.length) pruneDeletedIndex(chatId, missing)
        await new Promise(resolve => setTimeout(resolve, 0))
      }
      scrubTemporaryIndex(chatId)
      if (!unknown) {
        reconciledThisSession.add(key)
        markReconciled(chatId)
      }
      return { unknown }
    })().catch(() => null).finally(() => reconcileFlights.delete(key))
    reconcileFlights.set(key, flight)
    return flight
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
        pruneDeletedIndex(chatId, [], { render: false })
        if (typeof rescueSaveActiveChat === 'function') rescueSaveActiveChat()
        if (state.view === 'messages' && typeof renderMessagesList === 'function') renderMessagesList()
      } catch {}
    }, 350))
  }

  function installIndexApiHardening () {
    if (indexApiPatched || !window.teleFilesIndex) return false
    const api = window.teleFilesIndex
    const baseSnapshot = typeof api.snapshot === 'function' ? api.snapshot.bind(api) : null
    const baseEnsure = typeof api.ensure === 'function' ? api.ensure.bind(api) : null
    const baseHardRefresh = typeof api.hardRefresh === 'function' ? api.hardRefresh.bind(api) : null

    if (baseSnapshot) {
      api.snapshot = chatId => {
        const snapshot = baseSnapshot(chatId)
        if (!snapshot || !Array.isArray(snapshot.items)) return snapshot
        const deleted = deletedByChat.get(chatKey(chatId))
        if (deleted && deleted.size) {
          const clean = snapshot.items.filter(item => item && !deleted.has(String(item.messageId)) && !isTemporaryId(item.messageId))
          if (clean.length !== snapshot.items.length) {
            snapshot.items = clean
            snapshot.found = clean.length
            snapshot.typeCounts = typeCounts(clean)
            snapshot.newestMessageId = clean.length ? clean[0].messageId : 0
          }
        }
        return snapshot
      }
    }
    if (baseEnsure) {
      api.ensure = async (...args) => {
        const result = await baseEnsure(...args)
        const chatId = args[0]
        pruneDeletedIndex(chatId, [], { render: false })
        return api.snapshot ? api.snapshot(chatId) : result
      }
    }
    api.count = chatId => {
      const snapshot = api.snapshot ? api.snapshot(chatId) : null
      return snapshot && Array.isArray(snapshot.items) ? snapshot.items.length : 0
    }
    api.total = api.count
    if (baseHardRefresh) {
      api.hardRefresh = async (...args) => {
        const result = await baseHardRefresh(...args)
        pruneDeletedIndex(args[0], [], { render: false })
        return api.snapshot ? api.snapshot(args[0]) : result
      }
    }
    indexApiPatched = true
    return true
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
        pruneDeletedIndex(chatId, [], { render: false })
        if (message && message.media && !isTemporaryId(message.id)) {
          scrubTemporaryIndex(chatId)
          scheduleRecentRefresh(chatId)
        }
        return result
      }

      const result = baseHandleEvent(event)
      if (event && event.name === 'message-delete') {
        const payload = event.payload || event
        const chatId = event.chatId != null ? event.chatId : payload.chatId
        const ids = event.messageIds || payload.messageIds || []
        pruneDeletedIndex(chatId, ids)
        setTimeout(() => pruneDeletedIndex(chatId, ids), 0)
        setTimeout(() => pruneDeletedIndex(chatId, ids), 120)
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

  function removeDuplicateHeaderInfo () {
    document.querySelectorAll('#mg-open-info').forEach(node => node.remove())
  }

  function installHardeningStyles () {
    if (document.querySelector('#fg-hardening-style')) return
    const style = document.createElement('style')
    style.id = 'fg-hardening-style'
    style.textContent = `
      #dl-dir, #dl-dir-current { display: none !important; }
      #set-dir.fg-download-folder-picker {
        width: 100% !important; min-width: 0 !important; min-height: 42px !important;
        display: flex !important; align-items: center !important; justify-content: flex-start !important;
        gap: 10px !important; padding: 8px 12px !important; overflow: hidden !important;
        text-align: left !important;
      }
      #set-dir.fg-download-folder-picker .fg-folder-icon { flex: 0 0 auto; font-size: 16px; }
      #set-dir.fg-download-folder-picker .fg-folder-copy { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
      #set-dir.fg-download-folder-picker .fg-folder-label { color: var(--fg-text-muted); font-size: 10px; text-transform: uppercase; letter-spacing: .5px; }
      #set-dir.fg-download-folder-picker .fg-folder-path { color: var(--fg-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    `
    document.head.appendChild(style)
  }

  function paintFolderButton () {
    const button = document.querySelector('#set-dir')
    const input = document.querySelector('#dl-dir')
    if (!button || !input) return
    const current = String(input.value || '').trim() || 'Choose a download folder'
    const ready = button.dataset.fgFolderPath === current && !!button.querySelector('.fg-folder-path')
    if (ready) return

    button.dataset.fgFolderPath = current
    button.title = current
    if (!button.querySelector('.fg-folder-copy')) {
      button.innerHTML = '<span class="fg-folder-icon" aria-hidden="true">📁</span><span class="fg-folder-copy"><span class="fg-folder-label">Save to</span><span class="fg-folder-path"></span></span>'
    }
    const path = button.querySelector('.fg-folder-path')
    if (path && path.textContent !== current) path.textContent = current
  }

  function installDownloadFolderPicker () {
    const button = document.querySelector('#set-dir')
    const input = document.querySelector('#dl-dir')
    if (!button || !input) return false
    installHardeningStyles()
    button.classList.add('fg-download-folder-picker')
    paintFolderButton()

    if (!folderPickerInstalled) {
      folderPickerInstalled = true
      button.onclick = async () => {
        if (button.disabled) return
        button.disabled = true
        try {
          const response = await fetch('/api/filegram/pick-download-folder', { method: 'POST' })
          let payload = {}
          try { payload = await response.json() } catch {}
          if (!response.ok || !payload.ok) throw new Error(payload.error || `Folder picker failed (${response.status})`)
          if (payload.cancelled || !payload.path) return
          if (typeof request !== 'function') throw new Error('FileGram is not connected')
          const result = await request('set-download-dir', { dir: payload.path })
          if (typeof setDirLabel === 'function') setDirLabel(result.downloadsDir || payload.path)
          else input.value = result.downloadsDir || payload.path
          paintFolderButton()
          if (typeof toastOk === 'function') toastOk('Download folder changed')
          else if (typeof toast === 'function') toast('Download folder changed', 'ok')
        } catch (error) {
          if (typeof toast === 'function') toast(error.message || String(error), 'error')
        } finally {
          button.disabled = false
        }
      }

      try {
        if (typeof setDirLabel === 'function' && !setDirLabel.__fileGramFolderAware) {
          const baseSetDirLabel = setDirLabel
          const wrapped = function fileGramFolderAwareSetDirLabel (dir) {
            const result = baseSetDirLabel(dir)
            paintFolderButton()
            return result
          }
          wrapped.__fileGramFolderAware = true
          setDirLabel = wrapped
        }
      } catch {}
    }
    return true
  }

  function installUiCleanup () {
    removeCaptionUi()
    removeDuplicateHeaderInfo()
    installDownloadFolderPicker()
    if (uiObserver || !document.body) return

    // Bootstrap-only observer. Every repaint below is idempotent; in particular
    // paintFolderButton does not mutate the DOM if its path is unchanged, so the
    // observer cannot feed itself forever.
    uiObserver = new MutationObserver(() => {
      removeCaptionUi()
      removeDuplicateHeaderInfo()
      installDownloadFolderPicker()
    })
    uiObserver.observe(document.body, { childList: true, subtree: true })
    setTimeout(() => {
      if (uiObserver) uiObserver.disconnect()
      uiObserver = null
      removeCaptionUi()
      removeDuplicateHeaderInfo()
      installDownloadFolderPicker()
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

  function reconcileActiveChat () {
    try {
      if (typeof state === 'undefined' || !state || state.activeChatId == null) return
      const chatId = state.activeChatId
      pruneDeletedIndex(chatId, [], { render: false })
      reconcilePersistedIndex(chatId).then(() => {
        pruneDeletedIndex(chatId, [])
      }).catch(() => {})
    } catch {}
  }

  installUiCleanup()
  installIndexApiHardening()
  installRealtimeHardening()
  reconcileActiveChat()

  let tries = 0
  const timer = setInterval(() => {
    installRealtimeHardening()
    installIndexApiHardening()
    installUiCleanup()
    reconcileActiveChat()
    if (installQueueHardening() || ++tries > 240) clearInterval(timer)
  }, 25)

  let lastActiveChat = ''
  setInterval(() => {
    try {
      const current = typeof state !== 'undefined' && state ? chatKey(state.activeChatId) : ''
      if (!current || current === lastActiveChat) return
      lastActiveChat = current
      pruneDeletedIndex(current, [], { render: false })
      reconcilePersistedIndex(current).then(() => pruneDeletedIndex(current, [])).catch(() => {})
    } catch {}
  }, 900)
})()
