'use strict'

/* FileGram large-chat index and virtual Files view.
 * Network scans only merge additions; explicit Telegram delete events remove
 * entries. The DOM is a fixed-height virtual window, so 40k+ files remain
 * scrollable without sorting or rebuilding the full list on every frame.
 */
;(function fileGramFilesEngine () {
  const ROW_HEIGHT = 84
  const CARD_HEIGHT = 72
  const HORIZONTAL_INSET = 16
  const OVERSCAN = 14
  const PERSIST_DELAY = 2200
  const entries = new Map()
  const loading = new Map()
  const persistTimers = new Map()
  const rebuildTimers = new Map()
  const queuedChats = new Set()
  let viewCache = null
  let activeView = []
  let activeViewIndex = new Map()
  let viewSerial = 0
  let selectionSerial = 0
  let grid = null
  let canvas = null
  let renderFrame = 0
  let renderedKey = ''
  let renderedStart = -1
  let renderedEnd = -1
  let renderedViewSerial = -1
  let dragState = null

  function idOf (value) { return String(value) }
  function compareIds (a, b) {
    let aa = 0n
    let bb = 0n
    try { aa = BigInt(String(a || 0)) } catch {}
    try { bb = BigInt(String(b || 0)) } catch {}
    return aa === bb ? 0 : (aa < bb ? -1 : 1)
  }
  function emptyCounts () {
    return { document: 0, photo: 0, video: 0, gif: 0, audio: 0, voice: 0, video_note: 0, sticker: 0 }
  }
  function createEntry (chatId) {
    return {
      chatId,
      byMessage: new Map(),
      items: [],
      typeCounts: emptyCounts(),
      expectedCount: 0,
      scanned: 0,
      newestMessageId: 0,
      complete: false,
      mainComplete: false,
      stickerComplete: false,
      revision: 0,
      restored: false,
      rebuilding: false,
      status: 'idle',
      error: null,
      pendingTopAdds: 0
    }
  }
  function entryFor (chatId) {
    const id = idOf(chatId)
    let entry = entries.get(id)
    if (!entry) {
      entry = createEntry(chatId)
      entries.set(id, entry)
    }
    return entry
  }
  function normalizeItem (chatId, item) {
    if (!item || item.messageId == null || !item.fileId) return null
    return { ...item, key: `${chatId}:${item.messageId}`, chatId, thumbUrl: item.thumbUrl || null }
  }
  function updateEntryMetadata (entry, snapshot) {
    if (!snapshot) return
    entry.expectedCount = Math.max(entry.expectedCount, Number(snapshot.expectedCount || snapshot.found || 0))
    entry.scanned = Math.max(entry.scanned, Number(snapshot.scanned || 0))
    if (snapshot.newestMessageId && compareIds(snapshot.newestMessageId, entry.newestMessageId) > 0) entry.newestMessageId = snapshot.newestMessageId
    entry.complete = entry.complete || !!snapshot.complete
    entry.mainComplete = entry.mainComplete || !!snapshot.mainComplete || !!snapshot.done
    entry.stickerComplete = entry.stickerComplete || !!snapshot.stickerComplete
  }
  function mergeItems (entry, items) {
    let changed = 0
    let newestAdded = 0
    const oldNewest = entry.newestMessageId
    for (const raw of items || []) {
      const item = normalizeItem(entry.chatId, raw)
      if (!item) continue
      const key = idOf(item.messageId)
      const previous = entry.byMessage.get(key)
      if (!previous || previous.fileId !== item.fileId || previous.fileSize !== item.fileSize || previous.name !== item.name || previous.type !== item.type || previous.caption !== item.caption) {
        entry.byMessage.set(key, item)
        changed++
        if (oldNewest && compareIds(item.messageId, oldNewest) > 0) newestAdded++
      }
      if (!entry.newestMessageId || compareIds(item.messageId, entry.newestMessageId) > 0) entry.newestMessageId = item.messageId
    }
    if (changed) scheduleRebuild(entry)
    return { changed, newestAdded }
  }
  function removeItems (entry, messageIds) {
    let changed = 0
    for (const messageId of messageIds || []) {
      if (entry.byMessage.delete(idOf(messageId))) changed++
    }
    if (changed) scheduleRebuild(entry)
    return changed
  }
  function rebuildEntry (entry, immediate = false) {
    const run = () => {
      rebuildTimers.delete(idOf(entry.chatId))
      entry.items = [...entry.byMessage.values()].sort((a, b) => compareIds(b.messageId, a.messageId))
      const counts = emptyCounts()
      for (const item of entry.items) counts[item.type] = (counts[item.type] || 0) + 1
      entry.typeCounts = counts
      entry.expectedCount = Math.max(entry.expectedCount, entry.items.length)
      entry.revision++
      entry.rebuilding = false
      viewCache = null
      viewSerial++
      syncSharedSnapshot(entry)
      updateCountUi(entry)
      scheduleRender(true)
      if (entry.pendingTopAdds > 0 && grid && state.activeChatId != null && idOf(state.activeChatId) === idOf(entry.chatId)) {
        const rows = entry.pendingTopAdds
        entry.pendingTopAdds = 0
        requestAnimationFrame(() => { grid.scrollTop += rows * ROW_HEIGHT })
      }
    }
    const id = idOf(entry.chatId)
    if (rebuildTimers.has(id)) clearTimeout(rebuildTimers.get(id))
    entry.rebuilding = true
    if (immediate) run()
    else rebuildTimers.set(id, setTimeout(run, 90))
  }
  function scheduleRebuild (entry) { rebuildEntry(entry, false) }
  function serializableEntry (entry) {
    return {
      chatId: entry.chatId,
      items: entry.items.map(item => ({ ...item, thumbUrl: null })),
      found: entry.items.length,
      scanned: entry.scanned,
      typeCounts: { ...entry.typeCounts },
      expectedCount: entry.expectedCount,
      newestMessageId: entry.newestMessageId,
      complete: entry.complete,
      mainComplete: entry.mainComplete,
      stickerComplete: entry.stickerComplete,
      savedAt: Date.now(),
      done: entry.complete
    }
  }
  function syncSharedSnapshot (entry) {
    try {
      if (typeof rescueFileCache !== 'undefined' && rescueFileCache && rescueFileCache.set) rescueFileCache.set(idOf(entry.chatId), serializableEntry(entry))
    } catch {}
  }
  function schedulePersist (entry, immediate = false) {
    if (typeof teleP0v2WriteIndex !== 'function') return
    const id = idOf(entry.chatId)
    if (persistTimers.has(id)) clearTimeout(persistTimers.get(id))
    const write = () => {
      persistTimers.delete(id)
      if (entry.rebuilding) rebuildEntry(entry, true)
      Promise.resolve(teleP0v2WriteIndex(entry.chatId, serializableEntry(entry))).catch(() => {})
    }
    if (immediate) write()
    else persistTimers.set(id, setTimeout(write, PERSIST_DELAY))
  }
  async function restoreLocal (chatId) {
    const entry = entryFor(chatId)
    if (entry.restored) return entry
    entry.restored = true
    let snapshot = null
    try {
      if (typeof rescueFileCache !== 'undefined' && rescueFileCache && rescueFileCache.get) snapshot = rescueFileCache.get(idOf(chatId)) || null
    } catch {}
    if (snapshot && Array.isArray(snapshot.items)) {
      updateEntryMetadata(entry, snapshot)
      mergeItems(entry, snapshot.items)
    }
    if (typeof teleP0v2ReadIndex === 'function') {
      const disk = await Promise.resolve(teleP0v2ReadIndex(chatId)).catch(() => null)
      if (disk && Array.isArray(disk.items)) {
        updateEntryMetadata(entry, disk)
        mergeItems(entry, disk.items)
      }
    }
    if (entry.rebuilding) rebuildEntry(entry, true)
    else updateCountUi(entry)
    return entry
  }
  async function restoreServer (entry) {
    try {
      const data = await request('get-file-index-v4', { chatId: entry.chatId })
      const snapshot = data && data.snapshot
      if (snapshot && Array.isArray(snapshot.items)) {
        updateEntryMetadata(entry, snapshot)
        mergeItems(entry, snapshot.items)
        if (entry.rebuilding) rebuildEntry(entry, true)
        schedulePersist(entry)
      }
      return true
    } catch { return false }
  }
  async function startSync (entry, options = {}) {
    try {
      entry.status = 'indexing'
      entry.error = null
      updateCountUi(entry)
      await request('start-file-index-v4', { chatId: entry.chatId, deep: true, forceFull: !!options.forceFull })
      return true
    } catch { return false }
  }
  async function fallbackV3 (entry, options = {}) {
    try {
      const snapshot = await request('scan-media-v3', { chatId: entry.chatId, force: !!options.forceFull })
      if (snapshot && Array.isArray(snapshot.items)) {
        updateEntryMetadata(entry, snapshot)
        mergeItems(entry, snapshot.items)
        entry.complete = entry.complete || snapshot.done !== false
        if (entry.rebuilding) rebuildEntry(entry, true)
        schedulePersist(entry, true)
      }
    } catch (error) {
      entry.error = String(error && error.message ? error.message : error)
      entry.status = 'error'
      updateCountUi(entry)
    }
  }
  async function ensure (chatId, options = {}) {
    if (chatId == null) return null
    const id = idOf(chatId)
    if (loading.has(id)) return loading.get(id)
    const task = (async () => {
      const entry = await restoreLocal(chatId)
      updateCountUi(entry)
      scheduleRender(true)
      const serverAvailable = await restoreServer(entry)
      if (serverAvailable) await startSync(entry, options)
      else if (!entry.items.length || options.forceFull) fallbackV3(entry, options).catch(() => {})
      return entry
    })().finally(() => loading.delete(id))
    loading.set(id, task)
    return task
  }
  function mergeProgress (payload) {
    if (!payload || payload.chatId == null) return
    const entry = entryFor(payload.chatId)
    const beforeScroll = grid && state.activeChatId != null && idOf(state.activeChatId) === idOf(entry.chatId) ? grid.scrollTop : 0
    const beforeNewest = entry.newestMessageId
    const result = mergeItems(entry, payload.items || [])
    updateEntryMetadata(entry, payload)
    const removed = removeItems(entry, payload.deletedIds || [])
    entry.status = payload.error ? 'error' : (payload.done ? (payload.complete ? 'complete' : 'partial') : 'indexing')
    entry.error = payload.error || null
    if (payload.complete) entry.complete = true
    if (entry.rebuilding && (payload.done || result.changed + removed > 1000)) rebuildEntry(entry, true)
    if (grid && beforeScroll > ROW_HEIGHT * 2 && beforeNewest && result.newestAdded > 0 && idOf(state.activeChatId) === idOf(entry.chatId)) entry.pendingTopAdds += result.newestAdded
    updateCountUi(entry)
    if (result.changed || removed) schedulePersist(entry, !!payload.done)
    scheduleRender(true)
  }
  function updateCountUi (entry) {
    if (!entry || state.activeChatId == null || idOf(state.activeChatId) !== idOf(entry.chatId)) return
    const indexed = entry.byMessage.size
    const total = Math.max(indexed, Number(entry.expectedCount || 0))
    state.mediaCount = total
    state.typeCounts = entry.typeCounts
    const label = document.querySelector('#chat-media-count')
    if (label) {
      if (!entry.complete && total > indexed) label.textContent = `${total.toLocaleString()} files - ${indexed.toLocaleString()} indexed`
      else if (entry.status === 'indexing' && !entry.complete) label.textContent = `${indexed.toLocaleString()} files - indexing`
      else label.textContent = `${indexed.toLocaleString()} file${indexed === 1 ? '' : 's'}`
    }
    const all = document.querySelector('#download-all-media')
    if (all) {
      all.textContent = entry.complete ? `Download all media (${indexed.toLocaleString()})` : `Download indexed media (${indexed.toLocaleString()})`
      all.disabled = indexed === 0
    }
    try {
      if (entry.error) setLoadState(`Index paused: ${entry.error}`)
      else if (entry.status === 'indexing') setLoadState(total > indexed ? `Indexing ${indexed.toLocaleString()} of about ${total.toLocaleString()} files` : `Indexing files - ${indexed.toLocaleString()} found`)
      else if (entry.complete) setLoadState(`Indexed ${indexed.toLocaleString()} files`)
      else if (indexed) setLoadState(`Loaded ${indexed.toLocaleString()} indexed files`)
    } catch {}
  }
  function searchResultsRevision () {
    const results = Array.isArray(state.files.results) ? state.files.results : []
    const first = results[0]
    const last = results[results.length - 1]
    return `${results.length}:${first && first.messageId || 0}:${last && last.messageId || 0}`
  }
  function getView () {
    const chatId = state.activeChatId
    const entry = chatId == null ? null : entryFor(chatId)
    const mode = state.files.mode
    const revision = mode === 'search' ? searchResultsRevision() : (entry ? entry.revision : 0)
    const key = [chatId, mode, revision, state.files.query, state.files.filter, state.files.sort].join('|')
    if (viewCache && viewCache.key === key) return viewCache.items
    let list = mode === 'search' ? (Array.isArray(state.files.results) ? state.files.results.slice() : []) : (entry ? entry.items : [])
    const query = String(state.files.query || '').trim().toLowerCase()
    if (query) list = list.filter(item => String(item.name || '').toLowerCase().includes(query) || String(item.caption || '').toLowerCase().includes(query))
    if (state.files.filter !== 'all') list = list.filter(item => item.type === state.files.filter)
    if (state.files.sort === 'oldest') list = list.slice().sort((a, b) => compareIds(a.messageId, b.messageId))
    else if (state.files.sort === 'name') list = list.slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
    else if (state.files.sort === 'size') list = list.slice().sort((a, b) => Number(b.fileSize || 0) - Number(a.fileSize || 0))
    else if (mode === 'search') list = list.slice().sort((a, b) => compareIds(b.messageId, a.messageId))
    activeView = list
    activeViewIndex = new Map()
    for (let i = 0; i < list.length; i++) activeViewIndex.set(`${list[i].chatId}:${list[i].messageId}`, i)
    viewCache = { key, items: list }
    viewSerial++
    return list
  }
  function installGridOwner () {
    const old = document.querySelector('#media-grid')
    if (!old) return false
    if (old.dataset.fileGramOwner === '1') {
      grid = old
      canvas = old.querySelector('.filegram-virtual-canvas')
      return true
    }
    const next = old.cloneNode(false)
    next.id = old.id
    next.className = old.className
    next.dataset.fileGramOwner = '1'
    old.replaceWith(next)
    grid = next
    canvas = document.createElement('div')
    canvas.className = 'filegram-virtual-canvas'
    grid.appendChild(canvas)
    grid.addEventListener('scroll', () => scheduleRender(false), { passive: true })
    grid.addEventListener('mousedown', startDrag, { capture: true })
    return true
  }
  function viewKey () { return [state.activeChatId, state.files.mode, state.files.query, state.files.filter, state.files.sort].join('|') }
  function scheduleRender (force) {
    if (!installGridOwner()) return
    if (force) {
      renderedViewSerial = -1
      renderedStart = -1
      renderedEnd = -1
    }
    if (renderFrame) return
    renderFrame = requestAnimationFrame(() => {
      renderFrame = 0
      renderVirtual()
    })
  }
  function buildVirtualCard (item, index) {
    const slot = document.createElement('div')
    slot.className = 'filegram-virtual-slot'
    slot.dataset.index = String(index)
    slot.style.top = `${index * ROW_HEIGHT + 6}px`
    slot.style.left = `${HORIZONTAL_INSET}px`
    slot.style.right = `${HORIZONTAL_INSET}px`
    slot.style.height = `${CARD_HEIGHT}px`
    const card = buildGridCard(item)
    card.classList.add('filegram-virtual-card')
    card.style.height = `${CARD_HEIGHT}px`
    card.style.minHeight = `${CARD_HEIGHT}px`
    card.onclick = event => {
      if (event.target.closest('input,button,a,select')) return
      if (typeof dragJustEnded !== 'undefined' && dragJustEnded) {
        dragJustEnded = false
        return
      }
      const key = `${item.chatId}:${item.messageId}`
      if (event.shiftKey && typeof lastClickedKey !== 'undefined' && lastClickedKey && activeViewIndex.has(lastClickedKey)) {
        selectGlobalRange(activeViewIndex.get(lastClickedKey), index)
        return
      }
      if (state.selection.has(key)) state.selection.delete(key)
      else state.selection.set(key, item)
      if (typeof lastClickedKey !== 'undefined') lastClickedKey = key
      selectionSerial++
      updateVisibleSelection()
      updateSelectionBar()
    }
    slot.appendChild(card)
    return slot
  }
  function renderVirtual () {
    if (!installGridOwner()) return
    const items = getView()
    const key = viewKey()
    if (renderedKey !== key) {
      renderedKey = key
      grid.scrollTop = 0
      renderedStart = -1
      renderedEnd = -1
    }
    const viewport = Math.max(300, grid.clientHeight || 600)
    const first = Math.max(0, Math.floor(grid.scrollTop / ROW_HEIGHT))
    const start = Math.max(0, first - OVERSCAN)
    const end = Math.min(items.length, first + Math.ceil(viewport / ROW_HEIGHT) + OVERSCAN)
    canvas.style.height = `${Math.max(viewport, items.length * ROW_HEIGHT + 12)}px`
    if (start === renderedStart && end === renderedEnd && renderedViewSerial === viewSerial) return
    renderedStart = start
    renderedEnd = end
    renderedViewSerial = viewSerial
    const fragment = document.createDocumentFragment()
    for (let index = start; index < end; index++) fragment.appendChild(buildVirtualCard(items[index], index))
    if (dragState && dragState.band) fragment.appendChild(dragState.band)
    canvas.replaceChildren(fragment)
    const selectAll = document.querySelector('#select-all-media')
    if (selectAll) {
      selectAll.textContent = items.length ? `Select all (${items.length.toLocaleString()})` : 'Select all'
      selectAll.disabled = items.length === 0
    }
  }
  function updateVisibleSelection () {
    if (!grid) return
    for (const card of grid.querySelectorAll('.gcard[data-key]')) {
      const selected = state.selection.has(card.dataset.key)
      card.classList.toggle('selected', selected)
      const checkbox = card.querySelector('input[type=checkbox]')
      if (checkbox) checkbox.checked = selected
    }
  }
  function selectGlobalRange (a, b) {
    const items = getView()
    const lo = Math.max(0, Math.min(a, b))
    const hi = Math.min(items.length - 1, Math.max(a, b))
    for (let index = lo; index <= hi; index++) {
      const item = items[index]
      state.selection.set(`${item.chatId}:${item.messageId}`, item)
    }
    selectionSerial++
    updateVisibleSelection()
    updateSelectionBar()
  }
  function indexAtClientY (clientY) {
    if (!grid) return -1
    const rect = grid.getBoundingClientRect()
    const y = grid.scrollTop + clientY - rect.top
    return Math.max(0, Math.min(getView().length - 1, Math.floor(y / ROW_HEIGHT)))
  }
  function startDrag (event) {
    if (event.button !== 0 || event.target.closest('input,button,a,select')) return
    const startIndex = indexAtClientY(event.clientY)
    if (startIndex < 0) return
    event.stopImmediatePropagation()
    event.preventDefault()
    dragState = {
      startX: event.clientX,
      startY: event.clientY,
      clientX: event.clientX,
      clientY: event.clientY,
      startIndex,
      currentIndex: startIndex,
      lastLo: -1,
      lastHi: -1,
      baseSelected: new Set(state.selection.keys()),
      active: false,
      band: null,
      raf: 0
    }
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', moveDrag, { capture: true })
    document.addEventListener('mouseup', endDrag, { capture: true })
  }
  function moveDrag (event) {
    if (!dragState) return
    dragState.clientX = event.clientX
    dragState.clientY = event.clientY
    if (!dragState.active) {
      if (Math.abs(event.clientX - dragState.startX) < 5 && Math.abs(event.clientY - dragState.startY) < 5) return
      dragState.active = true
      dragState.band = document.createElement('div')
      dragState.band.className = 'filegram-selection-band'
      canvas.appendChild(dragState.band)
      dragState.raf = requestAnimationFrame(dragTick)
    }
    event.preventDefault()
  }
  function applyDragRange (lo, hi) {
    const ds = dragState
    const items = getView()
    if (!ds || !items.length || (lo === ds.lastLo && hi === ds.lastHi)) return
    if (ds.lastLo >= 0) {
      for (let index = ds.lastLo; index <= ds.lastHi; index++) {
        if (index >= lo && index <= hi) continue
        const item = items[index]
        if (!item) continue
        const key = `${item.chatId}:${item.messageId}`
        if (!ds.baseSelected.has(key)) state.selection.delete(key)
      }
    }
    for (let index = lo; index <= hi; index++) {
      if (index >= ds.lastLo && index <= ds.lastHi) continue
      const item = items[index]
      if (item) state.selection.set(`${item.chatId}:${item.messageId}`, item)
    }
    ds.lastLo = lo
    ds.lastHi = hi
    selectionSerial++
    updateVisibleSelection()
    updateSelectionBar()
  }
  function dragTick () {
    const ds = dragState
    if (!ds || !ds.active) return
    const rect = grid.getBoundingClientRect()
    const edge = 64
    let delta = 0
    if (ds.clientY < rect.top + edge) {
      const ratio = Math.min(1, (rect.top + edge - ds.clientY) / edge)
      delta = -Math.max(4, Math.round(32 * ratio * ratio))
    } else if (ds.clientY > rect.bottom - edge) {
      const ratio = Math.min(1, (ds.clientY - (rect.bottom - edge)) / edge)
      delta = Math.max(4, Math.round(32 * ratio * ratio))
    }
    if (delta) {
      grid.scrollTop = Math.max(0, Math.min(grid.scrollHeight - grid.clientHeight, grid.scrollTop + delta))
      scheduleRender(false)
    }
    ds.currentIndex = indexAtClientY(Math.max(rect.top + 1, Math.min(rect.bottom - 1, ds.clientY)))
    const lo = Math.min(ds.startIndex, ds.currentIndex)
    const hi = Math.max(ds.startIndex, ds.currentIndex)
    applyDragRange(lo, hi)
    if (ds.band) {
      ds.band.style.top = `${lo * ROW_HEIGHT + 4}px`
      ds.band.style.height = `${Math.max(2, (hi - lo + 1) * ROW_HEIGHT - 8)}px`
      ds.band.style.left = `${HORIZONTAL_INSET - 4}px`
      ds.band.style.right = `${HORIZONTAL_INSET - 4}px`
    }
    ds.raf = requestAnimationFrame(dragTick)
  }
  function endDrag (event) {
    const ds = dragState
    if (!ds) return
    dragState = null
    cancelAnimationFrame(ds.raf)
    document.removeEventListener('mousemove', moveDrag, { capture: true })
    document.removeEventListener('mouseup', endDrag, { capture: true })
    document.body.style.userSelect = ''
    if (ds.band) ds.band.remove()
    if (!ds.active) {
      const item = getView()[ds.startIndex]
      if (item) {
        const key = `${item.chatId}:${item.messageId}`
        if (state.selection.has(key)) state.selection.delete(key)
        else state.selection.set(key, item)
        if (typeof lastClickedKey !== 'undefined') lastClickedKey = key
      }
    } else if (typeof dragJustEnded !== 'undefined') {
      dragJustEnded = true
      setTimeout(() => { dragJustEnded = false }, 80)
    }
    selectionSerial++
    updateVisibleSelection()
    updateSelectionBar()
    event.preventDefault()
  }
  function selectAllStable () {
    const items = getView()
    const allSelected = items.length > 0 && items.every(item => state.selection.has(`${item.chatId}:${item.messageId}`))
    if (allSelected) {
      for (const item of items) state.selection.delete(`${item.chatId}:${item.messageId}`)
    } else {
      for (const item of items) state.selection.set(`${item.chatId}:${item.messageId}`, item)
    }
    selectionSerial++
    updateVisibleSelection()
    updateSelectionBar()
  }
  function queueKnownChats () {
    if (!ws || ws.readyState !== WebSocket.OPEN || !Array.isArray(state.chats) || !state.chats.length) return
    const chats = []
    for (const chat of state.chats) {
      if (!chat || chat.id == null) continue
      const id = idOf(chat.id)
      if (queuedChats.has(id)) continue
      queuedChats.add(id)
      chats.push({ id: chat.id, kind: chat.kind })
    }
    if (chats.length) request('queue-file-index-v4', { chats }).catch(() => {})
  }

  filesItems = getView
  renderFiles = () => scheduleRender(true)
  rescueEnsureAllFiles = ensure
  try {
    cardIndexForKey = function fileGramCardIndexForKey (_grid, key) {
      getView()
      return activeViewIndex.has(key) ? activeViewIndex.get(key) : -1
    }
    selectRange = function fileGramSelectRange (lo, hi) { selectGlobalRange(lo, hi) }
  } catch {}

  const selectAllButton = document.querySelector('#select-all-media')
  if (selectAllButton) {
    const next = selectAllButton.cloneNode(true)
    selectAllButton.replaceWith(next)
    next.addEventListener('click', selectAllStable)
  }

  const baseHandleEvent = handleEvent
  handleEvent = function fileGramFilesHandleEvent (event) {
    const result = baseHandleEvent(event)
    if (!event) return result
    if (event.name === 'media-index-v4-progress') mergeProgress(event.payload || {})
    if (event.name === 'auth') setTimeout(queueKnownChats, 1200)
    if (event.name === 'chat-upsert' && event.chat) setTimeout(queueKnownChats, 0)
    if (event.name === 'message-upsert' || event.name === 'message-delete') setTimeout(() => scheduleRender(true), 0)
    return result
  }

  setInterval(queueKnownChats, 10000)
  queueMicrotask(() => {
    installGridOwner()
    if (state.activeChatId != null) ensure(state.activeChatId).catch(() => {})
    queueKnownChats()
    scheduleRender(true)
  })

  window.fileGramIndex = {
    ensure,
    hardRefresh: chatId => ensure(chatId, { forceFull: true }),
    count: chatId => entryFor(chatId).byMessage.size,
    status: chatId => {
      const entry = entryFor(chatId)
      return { indexed: entry.byMessage.size, expectedCount: entry.expectedCount, complete: entry.complete, status: entry.status, error: entry.error }
    }
  }
})()
