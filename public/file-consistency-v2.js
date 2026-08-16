'use strict'

;(function fileGramConsistencyV2 () {
  if (window.__fileGramConsistencyV2Installed) return
  window.__fileGramConsistencyV2Installed = true

  const tombstones = new Map()
  const checked = new Set()
  const flights = new Map()
  let lastChat = null

  const key = value => String(value == null ? '' : value)
  const isTemp = value => key(value).startsWith('-')

  function counts (items) {
    const out = {}
    for (const item of items || []) if (item && item.type) out[item.type] = (out[item.type] || 0) + 1
    return out
  }

  function snapshot (chatId) {
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

  function persist (chatId, next) {
    try { if (typeof rescueFileCache !== 'undefined' && rescueFileCache && rescueFileCache.set) rescueFileCache.set(key(chatId), next) } catch {}
    try { if (typeof teleP0v2WriteIndex === 'function') Promise.resolve(teleP0v2WriteIndex(chatId, next)).catch(() => {}) } catch {}
  }

  function clearHighWater (chatId, total) {
    try {
      const storageKey = 'tele-file-index-high-water-v1'
      const map = JSON.parse(localStorage.getItem(storageKey) || '{}') || {}
      if (total > 0) map[key(chatId)] = { count: total, at: Date.now() }
      else delete map[key(chatId)]
      localStorage.setItem(storageKey, JSON.stringify(map))
    } catch {}
  }

  function repaint (chatId, next) {
    try {
      if (typeof state === 'undefined' || !state || key(state.activeChatId) !== key(chatId)) return
      const total = next && Array.isArray(next.items) ? next.items.length : 0
      state.mediaCount = total
      state.typeCounts = next && next.typeCounts || {}
      const count = document.querySelector('#chat-media-count')
      if (count) count.textContent = `${total.toLocaleString()} file${total === 1 ? '' : 's'}`
      const selectAll = document.querySelector('#select-all-media')
      if (selectAll) {
        selectAll.textContent = total ? `Select all (${total.toLocaleString()})` : 'Select all'
        selectAll.disabled = total === 0
      }
      if (state.view === 'files' && typeof renderFiles === 'function') renderFiles()
    } catch {}
  }

  function prune (chatId, ids) {
    const chat = key(chatId)
    if (!chat) return 0
    let dead = tombstones.get(chat)
    if (!dead) {
      dead = new Set()
      tombstones.set(chat, dead)
    }
    for (const id of ids || []) dead.add(key(id))

    const current = snapshot(chatId)
    if (!current || !Array.isArray(current.items)) return 0
    const before = current.items.length
    const clean = current.items.filter(item => item && !isTemp(item.messageId) && !dead.has(key(item.messageId)))
    current.items = clean
    current.found = clean.length
    current.typeCounts = counts(clean)
    current.newestMessageId = clean.length ? clean[0].messageId : 0
    current.savedAt = Date.now()
    current.done = true
    clearHighWater(chatId, clean.length)
    persist(chatId, current)
    repaint(chatId, current)
    return before - clean.length
  }

  async function reconcileSmallChat (chatId, force = false) {
    const chat = key(chatId)
    if (!chat) return null
    if (!force && checked.has(chat)) return null
    if (flights.has(chat)) return flights.get(chat)

    const current = snapshot(chatId)
    if (!current || !Array.isArray(current.items)) return null
    if (current.items.length > 1000) {
      checked.add(chat)
      return null
    }

    const job = (async () => {
      const response = await fetch(`/api/filegram/live-media-ids/${encodeURIComponent(chat)}`, { cache: 'no-store' })
      let payload = {}
      try { payload = await response.json() } catch {}
      if (!response.ok || !payload.ok || !payload.exact) throw new Error(payload.error || 'Live Telegram media scan was not exact')

      const live = new Set((payload.ids || []).map(key))
      const latest = snapshot(chatId)
      if (!latest || !Array.isArray(latest.items)) return null
      const missing = latest.items
        .filter(item => item && (isTemp(item.messageId) || !live.has(key(item.messageId))))
        .map(item => item.messageId)
      if (missing.length) prune(chatId, missing)
      else repaint(chatId, latest)
      checked.add(chat)
      return { live: live.size, removed: missing.length }
    })().catch(error => {
      console.warn('[files] live reconciliation failed', error && error.message ? error.message : error)
      return null
    }).finally(() => flights.delete(chat))

    flights.set(chat, job)
    return job
  }

  function installIndexGuard () {
    const api = window.teleFilesIndex
    if (!api || api.__fileGramConsistencyV2) return
    const baseSnapshot = typeof api.snapshot === 'function' ? api.snapshot.bind(api) : null
    if (!baseSnapshot) return
    api.snapshot = chatId => {
      const value = baseSnapshot(chatId)
      const dead = tombstones.get(key(chatId))
      if (value && Array.isArray(value.items) && dead && dead.size) {
        const clean = value.items.filter(item => item && !isTemp(item.messageId) && !dead.has(key(item.messageId)))
        if (clean.length !== value.items.length) {
          value.items = clean
          value.found = clean.length
          value.typeCounts = counts(clean)
          value.newestMessageId = clean.length ? clean[0].messageId : 0
        }
      }
      return value
    }
    api.count = chatId => {
      const value = api.snapshot(chatId)
      return value && Array.isArray(value.items) ? value.items.length : 0
    }
    api.total = api.count
    api.__fileGramConsistencyV2 = true
  }

  function installDeleteHook () {
    if (typeof handleEvent !== 'function' || handleEvent.__fileGramConsistencyV2) return
    const base = handleEvent
    const wrapped = function (event) {
      const result = base(event)
      if (event && event.name === 'message-delete') {
        const payload = event.payload || event
        const chatId = payload.chatId != null ? payload.chatId : event.chatId
        const ids = payload.messageIds || payload.message_ids || event.messageIds || []
        prune(chatId, ids)
      }
      return result
    }
    wrapped.__fileGramConsistencyV2 = true
    handleEvent = wrapped
  }

  function installDownloadFolderButton () {
    const old = document.querySelector('#set-dir')
    const input = document.querySelector('#dl-dir')
    if (!old || !input || old.dataset.fgFolderV2 === '1') return

    const styleId = 'fg-download-folder-v2-style'
    if (!document.getElementById(styleId)) {
      const style = document.createElement('style')
      style.id = styleId
      style.textContent = `
        #mg-downloads-pane .dl-controls>label.conc:first-of-type{display:block!important;width:100%!important;margin:0 0 18px!important}
        #mg-downloads-pane .dl-controls>label.conc:first-of-type>span:first-child{display:none!important}
        #mg-downloads-pane .dl-controls>label.conc:first-of-type .row{display:block!important;width:100%!important}
        #dl-dir,#dl-dir-current{display:none!important}
        #set-dir.fg-folder-v2{display:flex!important;width:100%!important;min-width:0!important;height:54px!important;align-items:center!important;gap:10px!important;padding:0 14px!important;border:1px solid #24364a!important;border-radius:10px!important;background:#111c2a!important;color:#dbe9f7!important;text-align:left!important;overflow:hidden!important}
        #set-dir.fg-folder-v2:hover{border-color:#4b91d1!important;background:#152337!important}
        #set-dir.fg-folder-v2 .fg-folder-v2-copy{display:flex;flex:1;min-width:0;flex-direction:column;line-height:1.1}
        #set-dir.fg-folder-v2 small{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#7f98b2;margin-bottom:5px}
        #set-dir.fg-folder-v2 strong{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      `
      document.head.appendChild(style)
    }

    const button = old.cloneNode(false)
    button.id = 'set-dir'
    button.type = 'button'
    button.className = 'fg-folder-v2'
    button.dataset.fgFolderV2 = '1'
    const paint = value => {
      const path = String(value || '').trim()
      input.value = path
      button.title = path || 'Choose download folder'
      button.innerHTML = `<span aria-hidden="true">📁</span><span class="fg-folder-v2-copy"><small>Save to</small><strong>${path.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])) || 'Choose download folder'}</strong></span>`
    }
    paint(input.value)
    old.replaceWith(button)

    button.addEventListener('click', async () => {
      button.disabled = true
      try {
        const response = await fetch('/api/filegram/pick-download-folder', { method: 'POST', cache: 'no-store' })
        const payload = await response.json()
        if (!response.ok || !payload.ok) throw new Error(payload.error || 'Folder picker failed')
        if (!payload.path) return
        const result = await request('set-download-dir', { dir: payload.path })
        paint(result && result.downloadsDir ? result.downloadsDir : payload.path)
        if (typeof toastOk === 'function') toastOk('Download folder changed')
      } catch (error) {
        if (typeof toast === 'function') toast(String(error && error.message ? error.message : error), 'error')
      } finally {
        button.disabled = false
      }
    })
  }

  function install () {
    installIndexGuard()
    installDeleteHook()
    installDownloadFolderButton()
    const duplicate = document.querySelector('#mg-open-info')
    if (duplicate) duplicate.remove()
  }

  install()
  const observer = new MutationObserver(install)
  if (document.body) observer.observe(document.body, { childList: true, subtree: true })

  setInterval(() => {
    install()
    try {
      const chatId = typeof state !== 'undefined' && state ? state.activeChatId : null
      const chat = key(chatId)
      if (!chat) return
      if (chat !== lastChat) {
        lastChat = chat
        checked.delete(chat)
      }
      if (!checked.has(chat)) reconcileSmallChat(chatId).catch(() => {})
    } catch {}
  }, 500)
})()
