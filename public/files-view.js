'use strict'

/* FileGram Files viewport owner.
 *
 * The index is owned by files-stability.js. This file owns only presentation:
 * - one fixed-height virtual canvas represents the full filtered result set;
 * - only visible rows are mounted, so 40k+ files remain cheap to scroll;
 * - chat revisits reuse the already-warm in-memory index instead of re-running
 *   the expensive restore path on every switch;
 * - range/shift/drag selection uses global result indexes, not DOM children.
 *
 * It deliberately replaces #media-grid once after the stability index is ready.
 * That removes the older competing scroll/drag listeners while leaving Messages
 * and the rest of the application DOM untouched.
 */
;(function fileGramFilesView () {
  const ROW_HEIGHT = 84
  const CARD_HEIGHT = 72
  const OVERSCAN = 12
  const EDGE_SCROLL = 68
  const BACKGROUND_RECONCILE_MS = 5 * 60 * 1000

  let grid = null
  let canvas = null
  let renderFrame = 0
  let cacheKey = ''
  let cacheItems = []
  let cacheCount = -1
  let cacheRevision = 0
  let renderedRevision = -1
  let renderedStart = -1
  let renderedEnd = -1
  let renderedKey = ''
  let drag = null
  let suppressClickUntil = 0

  const warmChats = new Set()
  const lastBackgroundReconcile = new Map()

  function idOf (value) { return String(value) }

  function itemKey (item) {
    return item ? `${item.chatId}:${item.messageId}` : ''
  }

  function currentViewKey () {
    return [
      state.activeChatId,
      state.files && state.files.mode,
      state.files && state.files.query,
      state.files && state.files.filter,
      state.files && state.files.sort
    ].join('|')
  }

  function sourceCount () {
    if (!state.files) return 0
    if (state.files.mode === 'search') return Array.isArray(state.files.results) ? state.files.results.length : 0
    if (state.activeChatId == null || !window.teleFilesIndex) return 0
    return Number(window.teleFilesIndex.count(state.activeChatId) || 0)
  }

  function installStyles () {
    if (document.querySelector('#filegram-files-view-style')) return
    const style = document.createElement('style')
    style.id = 'filegram-files-view-style'
    style.textContent = `
      #media-grid[data-filegram-view="1"]{display:block;position:relative;overflow-y:auto;overflow-x:hidden;padding:0!important;contain:strict;overflow-anchor:none}
      #media-grid[data-filegram-view="1"] .filegram-files-canvas{position:relative;width:100%;min-height:100%}
      #media-grid[data-filegram-view="1"] .filegram-files-slot{position:absolute;left:18px;right:18px;height:${CARD_HEIGHT}px}
      #media-grid[data-filegram-view="1"] .filegram-files-slot>.gcard{height:${CARD_HEIGHT}px;min-height:${CARD_HEIGHT}px;max-height:${CARD_HEIGHT}px;transform:none!important}
      #media-grid[data-filegram-view="1"] .filegram-files-slot>.gcard:hover{transform:none!important}
      #media-grid[data-filegram-view="1"] .filegram-drag-band{position:absolute;left:12px;right:12px;border:1px dashed var(--accent);background:rgba(56,132,255,.13);border-radius:7px;pointer-events:none;z-index:50}
    `
    document.head.appendChild(style)
  }

  function installGridOwner () {
    const existing = document.querySelector('#media-grid')
    if (!existing) return false
    if (existing.dataset.filegramView === '1') {
      grid = existing
      canvas = existing.querySelector('.filegram-files-canvas')
      return !!canvas
    }

    const next = existing.cloneNode(false)
    next.dataset.filegramView = '1'
    existing.replaceWith(next)
    grid = next

    canvas = document.createElement('div')
    canvas.className = 'filegram-files-canvas'
    grid.appendChild(canvas)

    grid.addEventListener('scroll', () => {
      scheduleRender(false)
      if (state.files && state.files.mode === 'search' && state.files.hasMore && !state.files.searching) {
        const nearEnd = grid.scrollTop + grid.clientHeight >= grid.scrollHeight - ROW_HEIGHT * 4
        if (nearEnd && typeof loadSearchMore === 'function') loadSearchMore()
      }
    }, { passive: true })

    grid.addEventListener('mousedown', startDrag, { capture: true })
    return true
  }

  function viewItems (force) {
    const nextKey = currentViewKey()
    const nextCount = sourceCount()
    if (!force && cacheKey === nextKey && cacheCount === nextCount) return cacheItems

    const sameView = cacheKey === nextKey
    let anchorKey = ''
    let anchorOffset = 0
    if (sameView && grid && cacheItems.length) {
      const oldIndex = Math.max(0, Math.min(cacheItems.length - 1, Math.floor(grid.scrollTop / ROW_HEIGHT)))
      anchorKey = itemKey(cacheItems[oldIndex])
      anchorOffset = grid.scrollTop - oldIndex * ROW_HEIGHT
    }

    const next = typeof filesItems === 'function' ? filesItems() : []
    cacheKey = nextKey
    cacheCount = nextCount
    cacheItems = Array.isArray(next) ? next : []
    cacheRevision++

    if (sameView && anchorKey && grid) {
      const newIndex = cacheItems.findIndex(item => itemKey(item) === anchorKey)
      if (newIndex >= 0) grid.scrollTop = Math.max(0, newIndex * ROW_HEIGHT + anchorOffset)
    } else if (!sameView && grid) {
      grid.scrollTop = 0
    }

    const selectAll = document.querySelector('#select-all-media')
    if (selectAll) {
      selectAll.textContent = cacheItems.length ? `Select all (${cacheItems.length.toLocaleString()})` : 'Select all'
      selectAll.disabled = cacheItems.length === 0
    }
    try {
      if (typeof rescueUpdateRangeControls === 'function') rescueUpdateRangeControls(cacheItems.length)
    } catch {}

    return cacheItems
  }

  function activeIndexByKey (key) {
    if (!key) return -1
    for (let index = 0; index < cacheItems.length; index++) {
      if (itemKey(cacheItems[index]) === key) return index
    }
    return -1
  }

  function updateVisibleSelection () {
    if (!grid) return
    for (const card of grid.querySelectorAll('.gcard[data-key]')) {
      const selected = state.selection.has(card.dataset.key)
      card.classList.toggle('selected', selected)
      const checkbox = card.querySelector('input[type="checkbox"]')
      if (checkbox) checkbox.checked = selected
    }
  }

  function selectGlobalRange (from, to) {
    const lo = Math.max(0, Math.min(from, to))
    const hi = Math.min(cacheItems.length - 1, Math.max(from, to))
    for (let index = lo; index <= hi; index++) {
      const item = cacheItems[index]
      if (item) state.selection.set(itemKey(item), item)
    }
    updateVisibleSelection()
    updateSelectionBar()
  }

  function buildSlot (item, index) {
    const slot = document.createElement('div')
    slot.className = 'filegram-files-slot'
    slot.dataset.index = String(index)
    slot.style.top = `${index * ROW_HEIGHT + 6}px`

    const card = buildGridCard(item)
    card.onclick = event => {
      if (Date.now() < suppressClickUntil) return
      if (event.target.closest('input,button,a,select')) return
      const key = itemKey(item)
      if (event.shiftKey && typeof lastClickedKey !== 'undefined' && lastClickedKey) {
        const previous = activeIndexByKey(lastClickedKey)
        if (previous >= 0) {
          selectGlobalRange(previous, index)
          return
        }
      }
      if (state.selection.has(key)) state.selection.delete(key)
      else state.selection.set(key, item)
      try { lastClickedKey = key } catch {}
      updateVisibleSelection()
      updateSelectionBar()
    }
    slot.appendChild(card)
    return slot
  }

  function renderNow (force) {
    if (!installGridOwner()) return
    const items = viewItems(force)
    const viewKey = currentViewKey()
    const viewport = Math.max(300, grid.clientHeight || 600)
    const firstVisible = Math.max(0, Math.floor(grid.scrollTop / ROW_HEIGHT))
    const start = Math.max(0, firstVisible - OVERSCAN)
    const end = Math.min(items.length, firstVisible + Math.ceil(viewport / ROW_HEIGHT) + OVERSCAN)

    canvas.style.height = `${Math.max(viewport, items.length * ROW_HEIGHT + 18)}px`

    if (!force && renderedKey === viewKey && renderedRevision === cacheRevision && renderedStart === start && renderedEnd === end) {
      updateVisibleSelection()
      return
    }

    renderedKey = viewKey
    renderedRevision = cacheRevision
    renderedStart = start
    renderedEnd = end

    const fragment = document.createDocumentFragment()
    for (let index = start; index < end; index++) fragment.appendChild(buildSlot(items[index], index))
    if (drag && drag.band) fragment.appendChild(drag.band)
    canvas.replaceChildren(fragment)
    updateVisibleSelection()
  }

  function scheduleRender (force) {
    if (!installGridOwner()) return
    if (force) {
      cacheCount = -1
      renderedRevision = -1
    }
    if (renderFrame) return
    renderFrame = requestAnimationFrame(() => {
      renderFrame = 0
      renderNow(force)
    })
  }

  function indexAtClientY (clientY) {
    if (!grid || !cacheItems.length) return -1
    const rect = grid.getBoundingClientRect()
    const y = grid.scrollTop + Math.max(0, Math.min(rect.height - 1, clientY - rect.top))
    return Math.max(0, Math.min(cacheItems.length - 1, Math.floor(y / ROW_HEIGHT)))
  }

  function addIndexToSelection (index) {
    const item = cacheItems[index]
    if (item) state.selection.set(itemKey(item), item)
  }

  function removeIndexFromSelection (index, baseSelected) {
    const item = cacheItems[index]
    if (!item) return
    const key = itemKey(item)
    if (!baseSelected.has(key)) state.selection.delete(key)
  }

  function applyDragRange (lo, hi) {
    if (!drag || lo < 0 || hi < 0) return
    if (drag.lastLo < 0) {
      for (let index = lo; index <= hi; index++) addIndexToSelection(index)
    } else {
      if (lo < drag.lastLo) for (let index = lo; index < drag.lastLo; index++) addIndexToSelection(index)
      if (hi > drag.lastHi) for (let index = drag.lastHi + 1; index <= hi; index++) addIndexToSelection(index)
      if (lo > drag.lastLo) for (let index = drag.lastLo; index < lo; index++) removeIndexFromSelection(index, drag.baseSelected)
      if (hi < drag.lastHi) for (let index = hi + 1; index <= drag.lastHi; index++) removeIndexFromSelection(index, drag.baseSelected)
    }
    drag.lastLo = lo
    drag.lastHi = hi
    updateVisibleSelection()
    updateSelectionBar()
  }

  function dragTick () {
    const current = drag
    if (!current || !current.active || !grid) return
    const rect = grid.getBoundingClientRect()
    let scrollDelta = 0
    if (current.clientY < rect.top + EDGE_SCROLL) {
      const ratio = Math.min(1, (rect.top + EDGE_SCROLL - current.clientY) / EDGE_SCROLL)
      scrollDelta = -Math.max(4, Math.round(40 * ratio * ratio))
    } else if (current.clientY > rect.bottom - EDGE_SCROLL) {
      const ratio = Math.min(1, (current.clientY - (rect.bottom - EDGE_SCROLL)) / EDGE_SCROLL)
      scrollDelta = Math.max(4, Math.round(40 * ratio * ratio))
    }

    if (scrollDelta) {
      grid.scrollTop = Math.max(0, Math.min(grid.scrollHeight - grid.clientHeight, grid.scrollTop + scrollDelta))
      scheduleRender(false)
    }

    current.currentIndex = indexAtClientY(current.clientY)
    const lo = Math.min(current.startIndex, current.currentIndex)
    const hi = Math.max(current.startIndex, current.currentIndex)
    applyDragRange(lo, hi)

    if (current.band) {
      current.band.style.top = `${lo * ROW_HEIGHT + 4}px`
      current.band.style.height = `${Math.max(2, (hi - lo + 1) * ROW_HEIGHT - 8)}px`
    }
    current.raf = requestAnimationFrame(dragTick)
  }

  function moveDrag (event) {
    if (!drag) return
    drag.clientX = event.clientX
    drag.clientY = event.clientY
    if (!drag.active) {
      if (Math.abs(event.clientX - drag.startX) < 5 && Math.abs(event.clientY - drag.startY) < 5) return
      drag.active = true
      drag.band = document.createElement('div')
      drag.band.className = 'filegram-drag-band'
      canvas.appendChild(drag.band)
      drag.raf = requestAnimationFrame(dragTick)
    }
    event.preventDefault()
  }

  function endDrag (event) {
    const current = drag
    if (!current) return
    drag = null
    cancelAnimationFrame(current.raf)
    document.removeEventListener('mousemove', moveDrag, true)
    document.removeEventListener('mouseup', endDrag, true)
    document.body.style.userSelect = ''
    if (current.band) current.band.remove()
    if (current.active) {
      suppressClickUntil = Date.now() + 120
      try {
        dragJustEnded = true
        setTimeout(() => { dragJustEnded = false }, 120)
      } catch {}
    }
    event.preventDefault()
  }

  function startDrag (event) {
    if (event.button !== 0 || event.target.closest('input,button,a,select')) return
    viewItems(false)
    const startIndex = indexAtClientY(event.clientY)
    if (startIndex < 0) return
    event.stopImmediatePropagation()
    drag = {
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
    document.addEventListener('mousemove', moveDrag, true)
    document.addEventListener('mouseup', endDrag, true)
  }

  function installWarmIndexGuard () {
    const baseEnsure = rescueEnsureAllFiles
    rescueEnsureAllFiles = function fileGramWarmEnsure (chatId, options = {}) {
      if (chatId == null) return Promise.resolve(null)
      const id = idOf(chatId)
      const count = window.teleFilesIndex ? Number(window.teleFilesIndex.count(chatId) || 0) : 0
      const now = Date.now()

      if (!options.hardRefresh && count > 0) {
        warmChats.add(id)
        scheduleRender(true)
        const last = lastBackgroundReconcile.get(id) || now
        if (now - last >= BACKGROUND_RECONCILE_MS) {
          lastBackgroundReconcile.set(id, now)
          const run = () => Promise.resolve(baseEnsure(chatId, options)).catch(() => {})
          if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 2500 })
          else setTimeout(run, 900)
        }
        return Promise.resolve(null)
      }

      const pending = Promise.resolve(baseEnsure(chatId, options))
      pending.finally(() => {
        if (window.teleFilesIndex && Number(window.teleFilesIndex.count(chatId) || 0) > 0) warmChats.add(id)
        lastBackgroundReconcile.set(id, Date.now())
        scheduleRender(true)
      })
      return pending
    }
  }

  function install () {
    if (window.__fileGramFilesViewInstalled) return
    if (!window.teleFilesIndex || typeof filesItems !== 'function' || typeof buildGridCard !== 'function' || typeof rescueEnsureAllFiles !== 'function') return false
    window.__fileGramFilesViewInstalled = true
    installStyles()
    installGridOwner()
    installWarmIndexGuard()
    renderFiles = function fileGramRenderFiles () { scheduleRender(true) }
    window.addEventListener('resize', () => scheduleRender(true), { passive: true })
    scheduleRender(true)
    return true
  }

  let tries = 0
  const waitForIndexOwner = () => {
    tries++
    if (install()) return
    if (tries < 1000) setTimeout(waitForIndexOwner, 10)
  }
  waitForIndexOwner()
})()
