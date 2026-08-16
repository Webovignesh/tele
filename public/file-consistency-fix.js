'use strict'

/* Final authority for two surfaces that must reflect external truth rather than
 * append-only cache state:
 *   1. Telegram message deletion -> Files index shrink.
 *   2. Download destination -> one native-folder button.
 *
 * The legacy index intentionally unions snapshots so partial scans can never
 * destroy a 20k channel. That rule is correct for discovery but wrong for
 * deletion. This layer performs a positive existence check against TDLib for the
 * active chat, tombstones missing message ids for the browser session, mutates the
 * committed snapshot in place, and persists the exact reduced snapshot.
 */
;(function fileGramConsistencyFix () {
  if (window.__fileGramConsistencyFixInstalled) return
  window.__fileGramConsistencyFixInstalled = true

  const HIGH_WATER_KEY = 'tele-file-index-high-water-v1'
  const tombstones = new Map()
  const flights = new Map()
  const verified = new Set()
  const retryCount = new Map()
  let lastActive = null
  let folderInstalled = false
  let eventInstalled = false
  let apiInstalled = false

  function key (value) { return String(value == null ? '' : value) }
  function tempId (value) { return String(value == null ? '' : value).startsWith('-') }

  function counts (items) {
    const out = {}
    for (const item of items || []) if (item && item.type) out[item.type] = (out[item.type] || 0) + 1
    return out
  }

  function snapshotFor (chatId) {
    try {
      if (window.teleFilesIndex && typeof window.teleFilesIndex.snapshot === 'function') {
        const value = window.teleFilesIndex.snapshot(chatId)
        if (value && Array.isArray(value.items)) return value
      }
    } catch {}
    try {
      if (typeof rescueFileCache !== 'undefined' && rescueFileCache && rescueFileCache.get) {
        const value = rescueFileCache.get(key(chatId))
        if (value && Array.isArray(value.items)) return value
      }
    } catch {}
    return null
  }

  function exactFloor (chatId, total) {
    try {
      const map = JSON.parse(localStorage.getItem(HIGH_WATER_KEY) || '{}') || {}
      if (total > 0) map[key(chatId)] = { count: total, at: Date.now() }
      else delete map[key(chatId)]
      localStorage.setItem(HIGH_WATER_KEY, JSON.stringify(map))
    } catch {}
  }

  function paint (chatId, snapshot) {
    try {
      if (typeof state === 'undefined' || !state || key(state.activeChatId) !== key(chatId)) return
      const total = snapshot && Array.isArray(snapshot.items) ? snapshot.items.length : 0
      state.mediaCount = total
      state.typeCounts = snapshot && snapshot.typeCounts || {}
      const label = document.querySelector('#chat-media-count')
      if (label) label.textContent = `${total.toLocaleString()} file${total === 1 ? '' : 's'}`
      const selectAll = document.querySelector('#select-all-media')
      if (selectAll) {
        selectAll.textContent = total ? `Select all (${total.toLocaleString()})` : 'Select all'
        selectAll.disabled = total === 0
      }
      if (state.view === 'files' && typeof renderFiles === 'function') renderFiles()
    } catch {}
  }

  function persist (chatId, snapshot) {
    try { if (typeof rescueFileCache !== 'undefined' && rescueFileCache && rescueFileCache.set) rescueFileCache.set(key(chatId), snapshot) } catch {}
    try { if (typeof teleP0v2WriteIndex === 'function') Promise.resolve(teleP0v2WriteIndex(chatId, snapshot)).catch(() => {}) } catch {}
  }

  function prune (chatId, ids) {
    const chat = key(chatId)
    if (!chat) return 0
    let dead = tombstones.get(chat)
    if (!dead) { dead = new Set(); tombstones.set(chat, dead) }
    for (const id of ids || []) if (id != null) dead.add(String(id))

    const snapshot = snapshotFor(chatId)
    if (!snapshot || !Array.isArray(snapshot.items)) return 0
    const before = snapshot.items.length
    snapshot.items = snapshot.items.filter(item => item && !tempId(item.messageId) && !dead.has(String(item.messageId)))
    snapshot.found = snapshot.items.length
    snapshot.typeCounts = counts(snapshot.items)
    snapshot.newestMessageId = snapshot.items.length ? snapshot.items[0].messageId : 0
    snapshot.savedAt = Date.now()
    snapshot.done = true

    exactFloor(chatId, snapshot.items.length)
    persist(chatId, snapshot)
    paint(chatId, snapshot)
    return before - snapshot.items.length
  }

  async function reconcile (chatId, force = false) {
    const chat = key(chatId)
    if (!chat) return null
    if (!force && verified.has(chat)) return null
    if (flights.has(chat)) return flights.get(chat)

    const job = (async () => {
      const snapshot = snapshotFor(chatId)
      if (!snapshot || !Array.isArray(snapshot.items)) return null
      // Temporary outgoing ids are never valid persistent Files rows.
      const temporary = snapshot.items.filter(item => item && tempId(item.messageId)).map(item => item.messageId)
      if (temporary.length) prune(chatId, temporary)

      const current = snapshotFor(chatId)
      const ids = [...new Set((current && current.items || [])
        .map(item => String(item && item.messageId))
        .filter(id => /^\d+$/.test(id)))]
      if (!ids.length) {
        verified.add(chat)
        prune(chatId, [])
        return { existing: 0, missing: 0, unknown: 0 }
      }

      let existing = 0
      let missing = 0
      let unknown = 0
      for (let offset = 0; offset < ids.length; offset += 500) {
        const messageIds = ids.slice(offset, offset + 500)
        const response = await fetch(`/api/filegram/reconcile-message-ids/${encodeURIComponent(chat)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messageIds })
        })
        let payload = {}
        try { payload = await response.json() } catch {}
        if (!response.ok || !payload.ok) throw new Error(payload.error || `File reconciliation failed (${response.status})`)
        const gone = Array.isArray(payload.missing) ? payload.missing : []
        const unsure = Array.isArray(payload.unknown) ? payload.unknown : []
        existing += Array.isArray(payload.existing) ? payload.existing.length : 0
        missing += gone.length
        unknown += unsure.length
        if (gone.length) prune(chatId, gone)
        await new Promise(resolve => setTimeout(resolve, 0))
      }

      prune(chatId, [])
      if (!unknown) {
        verified.add(chat)
        retryCount.delete(chat)
      } else {
        const attempts = (retryCount.get(chat) || 0) + 1
        retryCount.set(chat, attempts)
        if (attempts < 4) setTimeout(() => reconcile(chatId, true).catch(() => {}), attempts * 1500)
      }
      return { existing, missing, unknown }
    })().catch(() => null).finally(() => flights.delete(chat))

    flights.set(chat, job)
    return job
  }

  function installIndexApi () {
    if (apiInstalled || !window.teleFilesIndex) return false
    const api = window.teleFilesIndex
    const baseSnapshot = typeof api.snapshot === 'function' ? api.snapshot.bind(api) : null
    if (!baseSnapshot) return false
    api.snapshot = chatId => {
      const snapshot = baseSnapshot(chatId)
      const dead = tombstones.get(key(chatId))
      if (snapshot && Array.isArray(snapshot.items) && dead && dead.size) {
        const clean = snapshot.items.filter(item => item && !tempId(item.messageId) && !dead.has(String(item.messageId)))
        if (clean.length !== snapshot.items.length) {
          snapshot.items = clean
          snapshot.found = clean.length
          snapshot.typeCounts = counts(clean)
          snapshot.newestMessageId = clean.length ? clean[0].messageId : 0
        }
      }
      return snapshot
    }
    api.count = chatId => {
      const snapshot = api.snapshot(chatId)
      return snapshot && Array.isArray(snapshot.items) ? snapshot.items.length : 0
    }
    api.total = api.count
    apiInstalled = true
    return true
  }

  function installEvents () {
    if (eventInstalled || typeof handleEvent !== 'function') return false
    const base = handleEvent
    handleEvent = function fileGramConsistencyEvent (event) {
      const result = base(event)
      if (event && event.name === 'message-delete') {
        const payload = event.payload || event
        const chatId = payload.chatId != null ? payload.chatId : event.chatId
        const ids = payload.messageIds || payload.message_ids || event.messageIds || []
        prune(chatId, ids)
      }
      if (event && event.name === 'message-upsert') {
        const payload = event.payload || event
        const chatId = payload.chatId != null ? payload.chatId : event.chatId
        setTimeout(() => reconcile(chatId, true).catch(() => {}), 300)
      }
      return result
    }
    eventInstalled = true
    return true
  }

  function removeDuplicateChatInfo () {
    const button = document.querySelector('#mg-open-info')
    if (button) button.remove()
  }

  function folderMarkup(path) {
    return `<span class="fg-native-folder-icon" aria-hidden="true">\uD83D\uDCC1</span><span class="fg-native-folder-copy"><small>Save to</small><strong>${String(path || 'Choose download folder').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))}</strong></span><span class="fg-native-folder-chevron" aria-hidden="true">\u203A</span>`
  }

  function injectFolderStyle () {
    if (document.querySelector('#fg-native-folder-style')) return
    const style = document.createElement('style')
    style.id = 'fg-native-folder-style'
    style.textContent = `
      .fg-download-folder-picker{width:100%!important;min-width:0!important;height:52px!important;padding:0 14px!important;display:flex!important;align-items:center!important;gap:10px!important;border:1px solid var(--fg-border,#24364a)!important;border-radius:10px!important;background:var(--fg-surface-2,#111c2a)!important;color:inherit!important;text-align:left!important;overflow:hidden!important}
      .fg-download-folder-picker:hover{border-color:#3c6f9d!important;background:var(--fg-surface-3,#162437)!important}
      .fg-native-folder-icon{font-size:20px;flex:0 0 auto}.fg-native-folder-copy{display:flex;flex-direction:column;min-width:0;line-height:1.15;flex:1}.fg-native-folder-copy small{font-size:10px;letter-spacing:.08em;text-transform:uppercase;opacity:.62;margin-bottom:4px}.fg-native-folder-copy strong{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.fg-native-folder-chevron{font-size:22px;opacity:.7;flex:0 0 auto}
      #dl-dir.fg-download-path-hidden,#dl-dir-current.fg-download-path-hidden{display:none!important}
      #mg-downloads-pane .dl-controls>label.conc:first-of-type{display:block!important;margin:0 0 16px!important}
      #mg-downloads-pane .dl-controls>label.conc:first-of-type>span:first-child{display:none!important}
      #mg-downloads-pane .dl-controls>label.conc:first-of-type .row{display:block!important;width:100%!important}
    `
    document.head.appendChild(style)
  }

  function installFolderButton () {
    const old = document.querySelector('#set-dir')
    const input = document.querySelector('#dl-dir')
    if (!old || !input) return false
    if (folderInstalled && old.classList.contains('fg-download-folder-picker')) return true

    injectFolderStyle()
    const button = old.cloneNode(false)
    button.id = 'set-dir'
    button.type = 'button'
    button.className = 'fg-download-folder-picker'
    button.dataset.fgNativeFolderOwner = '1'
    const current = String(input.value || '').trim()
    button.innerHTML = folderMarkup(current)
    button.title = current || 'Choose download folder'
    old.replaceWith(button)
    input.classList.add('fg-download-path-hidden')
    const currentLabel = document.querySelector('#dl-dir-current')
    if (currentLabel) currentLabel.classList.add('fg-download-path-hidden')

    const repaint = path => {
      const value = String(path || '').trim()
      input.value = value
      button.innerHTML = folderMarkup(value)
      button.title = value || 'Choose download folder'
      if (currentLabel) currentLabel.textContent = value
    }

    button.addEventListener('click', async () => {
      if (button.disabled) return
      button.disabled = true
      try {
        const response = await fetch('/api/filegram/pick-download-folder-modern', { method: 'POST' })
        let payload = {}
        try { payload = await response.json() } catch {}
        if (!response.ok || !payload.ok) throw new Error(payload.error || `Folder picker failed (${response.status})`)
        if (payload.cancelled || !payload.path) return
        if (typeof request !== 'function') throw new Error('FileGram is not connected')
        const result = await request('set-download-dir', { dir: payload.path })
        repaint(result && result.downloadsDir ? result.downloadsDir : payload.path)
        if (typeof toastOk === 'function') toastOk('Download folder changed')
      } catch (error) {
        if (typeof toast === 'function') toast(String(error && error.message ? error.message : error), 'error')
      } finally {
        button.disabled = false
      }
    })
    folderInstalled = true
    return true
  }

  function install () {
    installIndexApi()
    installEvents()
    removeDuplicateChatInfo()
    installFolderButton()
  }

  install()
  const observer = new MutationObserver(() => {
    removeDuplicateChatInfo()
    if (!folderInstalled || !document.querySelector('#set-dir.fg-download-folder-picker')) {
      folderInstalled = false
      installFolderButton()
    }
  })
  if (document.body) observer.observe(document.body, { childList: true, subtree: true })

  // Active-chat watcher is intentional: several legacy layers replace openChat,
  // so wrapping one function is not reliable. Reconciliation runs only once per
  // chat per browser session unless Telegram returns an uncertain result.
  setInterval(() => {
    install()
    try {
      const active = typeof state !== 'undefined' && state ? state.activeChatId : null
      const activeKey = key(active)
      if (!activeKey) return
      if (activeKey !== lastActive) lastActive = activeKey
      if (!verified.has(activeKey)) reconcile(active).catch(() => {})
    } catch {}
  }, 700)
})()
