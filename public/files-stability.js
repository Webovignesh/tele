'use strict'

/* Large-chat Files stability owner.
 *
 * Invariants:
 * - a committed per-chat index is restored from IndexedDB before any network scan;
 * - partial/progressive scans may only add to the committed index, never shrink it;
 * - revisiting a chat with a committed index never triggers a historical full scan;
 * - filters/sorts are pure derived views and never become the authoritative count;
 * - realtime message events merge into the committed snapshot without rebuilding
 *   a 20k+ item DOM; the existing final virtualizer renders only the visible window.
 */
;(function teleFilesStability () {
  const committed = new Map()
  const loading = new Map()
  const candidates = new Map()
  const persistTimers = new Map()
  const paintTimers = new Map()

  function idOf (value) { return String(value) }

  function belongsToChat (chatId, snapshot) {
    if (!snapshot || !Array.isArray(snapshot.items)) return false
    const id = idOf(chatId)
    return snapshot.items.every(item => item && idOf(item.chatId) === id)
  }

  function normalize (chatId, snapshot) {
    const id = idOf(chatId)
    const byMessage = new Map()
    let scanned = 0
    let savedAt = Date.now()
    for (const source of [snapshot]) {
      if (!source || !Array.isArray(source.items)) continue
      scanned = Math.max(scanned, Number(source.scanned || 0))
      savedAt = Math.max(savedAt, Number(source.savedAt || 0))
      for (const item of source.items) {
        if (!item || idOf(item.chatId) !== id || item.messageId == null) continue
        byMessage.set(idOf(item.messageId), { ...item, chatId })
      }
    }
    const items = [...byMessage.values()]
    items.sort((a, b) => {
      let aa = 0n; let bb = 0n
      try { aa = BigInt(String(a.messageId || 0)) } catch {}
      try { bb = BigInt(String(b.messageId || 0)) } catch {}
      return aa === bb ? 0 : (aa < bb ? 1 : -1)
    })
    const typeCounts = {}
    for (const item of items) typeCounts[item.type] = (typeCounts[item.type] || 0) + 1
    return {
      chatId,
      items,
      found: items.length,
      scanned: Math.max(scanned, items.length),
      typeCounts,
      savedAt,
      done: true
    }
  }

  function union (chatId, ...snapshots) {
    const id = idOf(chatId)
    const byMessage = new Map()
    let scanned = 0
    let savedAt = 0
    for (const snapshot of snapshots) {
      if (!belongsToChat(chatId, snapshot)) continue
      scanned = Math.max(scanned, Number(snapshot.scanned || 0))
      savedAt = Math.max(savedAt, Number(snapshot.savedAt || 0))
      for (const item of snapshot.items) {
        if (!item || idOf(item.chatId) !== id || item.messageId == null) continue
        byMessage.set(idOf(item.messageId), { ...item, chatId })
      }
    }
    return normalize(chatId, { items: [...byMessage.values()], scanned, savedAt: savedAt || Date.now() })
  }

  function sharedSnapshot (chatId) {
    try {
      if (typeof rescueFileCache !== 'undefined' && rescueFileCache && rescueFileCache.get) {
        const value = rescueFileCache.get(idOf(chatId))
        if (belongsToChat(chatId, value)) return value
      }
    } catch {}
    return null
  }

  function setSharedSnapshot (chatId, snapshot) {
    try {
      if (typeof rescueFileCache !== 'undefined' && rescueFileCache && rescueFileCache.set) {
        rescueFileCache.set(idOf(chatId), snapshot)
      }
    } catch {}
  }

  function updateCountUi (chatId) {
    if (state.activeChatId == null || idOf(state.activeChatId) !== idOf(chatId)) return
    const snapshot = committed.get(idOf(chatId))
    if (!snapshot) return
    state.mediaCount = snapshot.items.length
    state.typeCounts = snapshot.typeCounts
    const count = document.querySelector('#chat-media-count')
    if (count) count.textContent = `${snapshot.items.length.toLocaleString()} file${snapshot.items.length === 1 ? '' : 's'}`
    const all = document.querySelector('#download-all-media')
    if (all) {
      all.textContent = `Download all media (${snapshot.items.length.toLocaleString()})`
      all.disabled = snapshot.items.length === 0
    }
  }

  function schedulePaint (chatId) {
    const id = idOf(chatId)
    if (paintTimers.has(id)) return
    paintTimers.set(id, setTimeout(() => {
      paintTimers.delete(id)
      updateCountUi(chatId)
      if (state.activeChatId != null && idOf(state.activeChatId) === id && state.view === 'files') {
        try { renderFiles() } catch {}
      }
    }, 120))
  }

  function schedulePersist (chatId, immediate = false) {
    const id = idOf(chatId)
    if (persistTimers.has(id)) clearTimeout(persistTimers.get(id))
    const write = () => {
      persistTimers.delete(id)
      const snapshot = committed.get(id)
      if (!snapshot) return
      if (typeof teleP0v2WriteIndex === 'function') {
        Promise.resolve(teleP0v2WriteIndex(chatId, snapshot)).catch(() => {})
      }
    }
    if (immediate) write()
    else persistTimers.set(id, setTimeout(write, 900))
  }

  function commitUnion (chatId, snapshot, options = {}) {
    if (!belongsToChat(chatId, snapshot)) return committed.get(idOf(chatId)) || null
    const id = idOf(chatId)
    const previous = committed.get(id)
    const next = previous ? union(chatId, previous, snapshot) : normalize(chatId, snapshot)
    committed.set(id, next)
    setSharedSnapshot(chatId, next)
    updateCountUi(chatId)
    if (options.persist) schedulePersist(chatId, !!options.immediate)
    if (options.paint !== false) schedulePaint(chatId)
    return next
  }

  async function restore (chatId) {
    const id = idOf(chatId)
    let best = committed.get(id) || null
    const shared = sharedSnapshot(chatId)
    if (shared) best = best ? union(chatId, best, shared) : normalize(chatId, shared)
    if (typeof teleP0v2ReadIndex === 'function') {
      const disk = await Promise.resolve(teleP0v2ReadIndex(chatId)).catch(() => null)
      if (belongsToChat(chatId, disk)) best = best ? union(chatId, best, disk) : normalize(chatId, disk)
    }
    if (best) {
      committed.set(id, best)
      setSharedSnapshot(chatId, best)
      updateCountUi(chatId)
    }
    return best
  }

  async function ensure (chatId, options = {}) {
    if (chatId == null) return null
    const id = idOf(chatId)
    if (loading.has(id)) return loading.get(id)
    const task = (async () => {
      let stable = await restore(chatId)
      if (stable && stable.items.length) {
        if (state.activeChatId != null && idOf(state.activeChatId) === id && state.view === 'files') {
          try { setLoadState(`Loaded ${stable.items.length.toLocaleString()} indexed files`) } catch {}
          schedulePaint(chatId)
        }
        // A committed snapshot is authoritative on revisit. Realtime Telegram
        // events keep it fresh; do not rescan 20k+ historical messages here.
        if (!options.hardRefresh) return stable
      }

      try {
        const result = await request('scan-media-v3', { chatId, force: !!options.hardRefresh })
        if (belongsToChat(chatId, result)) {
          stable = commitUnion(chatId, result, { persist: true, immediate: true })
        }
      } catch (error) {
        if (!stable && state.activeChatId != null && idOf(state.activeChatId) === id) {
          try { setLoadState('File index sync failed. Reopen Files to retry.') } catch {}
        }
      }
      return stable
    })().finally(() => loading.delete(id))
    loading.set(id, task)
    return task
  }

  function mergeProgress (payload) {
    if (!payload || payload.chatId == null) return
    const chatId = payload.chatId
    const id = idOf(chatId)
    let candidate = candidates.get(id)
    if (!candidate) candidate = { chatId, items: [], scanned: 0, done: false }
    if (Array.isArray(payload.items) && payload.items.length) {
      candidate = union(chatId, candidate, { chatId, items: payload.items, scanned: payload.scanned || 0, savedAt: Date.now() })
    }
    candidate.scanned = Math.max(Number(candidate.scanned || 0), Number(payload.scanned || 0))
    candidate.done = !!payload.done
    candidates.set(id, candidate)

    // Progressive batches can only increase the visible committed snapshot.
    if (candidate.items.length) commitUnion(chatId, candidate, { paint: true, persist: false })
    if (payload.done) {
      candidates.delete(id)
      schedulePersist(chatId, true)
      const final = committed.get(id)
      if (final && state.activeChatId != null && idOf(state.activeChatId) === id) {
        try { setLoadState(`Indexed ${final.items.length.toLocaleString()} files`) } catch {}
      }
    }
  }

  function syncFromSharedAfterRealtime (chatId) {
    queueMicrotask(() => {
      const shared = sharedSnapshot(chatId)
      if (shared) commitUnion(chatId, shared, { persist: true, paint: true })
    })
  }

  // Replace the expensive revisit behavior with committed-index restore.
  rescueEnsureAllFiles = ensure

  // Pure derived view: filtering and sorting never alter committed state/counts.
  filesItems = function teleStableFilesItems () {
    let list
    if (state.files.mode === 'search') list = Array.isArray(state.files.results) ? state.files.results.slice() : []
    else {
      const chatId = state.activeChatId
      const stable = chatId == null ? null : (committed.get(idOf(chatId)) || sharedSnapshot(chatId))
      list = stable && Array.isArray(stable.items) ? stable.items.slice() : []
    }
    const query = String(state.files.query || '').trim().toLowerCase()
    if (query) list = list.filter(item => String(item.name || '').toLowerCase().includes(query) || String(item.caption || '').toLowerCase().includes(query))
    if (state.files.filter !== 'all') list = list.filter(item => item.type === state.files.filter)
    const idCompare = (a, b) => {
      let aa = 0n; let bb = 0n
      try { aa = BigInt(String(a && a.messageId || 0)) } catch {}
      try { bb = BigInt(String(b && b.messageId || 0)) } catch {}
      return aa === bb ? 0 : (aa < bb ? -1 : 1)
    }
    if (state.files.sort === 'oldest') list.sort(idCompare)
    else if (state.files.sort === 'name') list.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
    else if (state.files.sort === 'size') list.sort((a, b) => Number(b.fileSize || 0) - Number(a.fileSize || 0))
    else list.sort((a, b) => idCompare(b, a))
    return list
  }

  const baseHandleEvent = handleEvent
  handleEvent = function teleStableHandleEvent (event) {
    const result = baseHandleEvent(event)
    if (!event) return result
    if (event.name === 'media-index-progress') mergeProgress(event.payload || {})
    if (event.name === 'message-upsert' || event.name === 'message-delete') {
      const payload = event.payload || event
      if (payload.chatId != null) syncFromSharedAfterRealtime(payload.chatId)
    }
    return result
  }

  // Restore the active chat immediately on load without waiting for a scan.
  queueMicrotask(() => {
    if (state.activeChatId != null) ensure(state.activeChatId).catch(() => {})
  })

  window.teleFilesIndex = {
    ensure,
    count: chatId => {
      const snapshot = committed.get(idOf(chatId)) || sharedSnapshot(chatId)
      return snapshot && Array.isArray(snapshot.items) ? snapshot.items.length : 0
    },
    hardRefresh: chatId => ensure(chatId, { hardRefresh: true })
  }
})()
