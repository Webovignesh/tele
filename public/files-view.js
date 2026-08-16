'use strict'

/* FileGram Files page owner.
 *
 * The persistent index is owned by files-stability.js. This file owns only the
 * visible Files workspace:
 * - exactly 100 derived entries per page;
 * - filters/search/sort are applied to the complete committed index before the
 *   page slice is taken;
 * - only the current page is mounted, so a 40k-file chat never creates a 40k
 *   DOM or a giant synthetic scroll surface;
 * - thumbnails are requested lazily only when their rows approach the viewport;
 * - warm indexes are reused immediately when switching chats;
 * - hidden Messages content is not repainted while the Files tab is active;
 * - selection remains global across pages and shift/range selection still uses
 *   indexes in the complete filtered result set.
 */
;(function fileGramFilesPages () {
  const PAGE_SIZE = 100
  const BACKGROUND_RECONCILE_MS = 5 * 60 * 1000

  let grid = null
  let pager = null
  let pagerSummary = null
  let pageInput = null
  let pageTotal = null
  let prevButton = null
  let nextButton = null
  let firstButton = null
  let lastButton = null
  let renderFrame = 0
  let cacheKey = ''
  let cacheStamp = ''
  let cacheItems = []
  let cacheSourceTotal = 0
  let cacheRevision = 0
  let renderedRevision = -1
  let renderedPage = -1

  const pageByView = new Map()
  const lastBackgroundReconcile = new Map()
  const observedThumbs = new Set()
  const thumbTargets = new WeakMap()

  const baseLoadThumb = typeof loadThumb === 'function' ? loadThumb : null
  const baseRenderMessagesList = typeof renderMessagesList === 'function' ? renderMessagesList : null

  function idOf (value) { return String(value) }
  function itemKey (item) { return item ? `${item.chatId}:${item.messageId}` : '' }

  function compareIds (a, b) {
    let aa = 0n; let bb = 0n
    try { aa = BigInt(String(a || 0)) } catch {}
    try { bb = BigInt(String(b || 0)) } catch {}
    return aa === bb ? 0 : (aa < bb ? -1 : 1)
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

  /* Reads the authoritative index owner, NOT the shared legacy cache.
   *
   * Legacy layers still write rescueFileCache, so reading it here made the list a
   * second, independent source of truth: Select all and the pager could report
   * 21,045 while the header reported 22,479 from the committed index. Everything
   * that displays a total now derives from one snapshot. rescueFileCache remains
   * as a fallback for the window before the index owner installs. */
  function activeSnapshot () {
    if (state.activeChatId == null) return null
    try {
      const index = window.teleFilesIndex
      if (index && typeof index.snapshot === 'function') {
        const owned = index.snapshot(state.activeChatId)
        if (owned && Array.isArray(owned.items)) return owned
      }
    } catch {}
    try {
      if (typeof rescueFileCache !== 'undefined' && rescueFileCache && rescueFileCache.get) {
        const snapshot = rescueFileCache.get(idOf(state.activeChatId))
        if (snapshot && Array.isArray(snapshot.items)) return snapshot
      }
    } catch {}
    return null
  }

  function sourceStamp () {
    if (!state.files) return 'none'
    if (state.files.mode === 'search') {
      const results = Array.isArray(state.files.results) ? state.files.results : []
      return `search:${results.length}:${state.files.totalCount || 0}:${state.files.fromMessageId || 0}`
    }
    const snapshot = activeSnapshot()
    if (!snapshot) return 'browse:0:0'
    return `browse:${snapshot.items.length}:${Number(snapshot.savedAt || 0)}`
  }

  function trimPageMemory () {
    while (pageByView.size > 48) pageByView.delete(pageByView.keys().next().value)
  }

  function getPage (viewKey = currentViewKey ()) {
    return Math.max(1, Number(pageByView.get(viewKey) || 1))
  }

  function setPage (page, viewKey = currentViewKey ()) {
    pageByView.set(viewKey, Math.max(1, Math.floor(Number(page) || 1)))
    trimPageMemory()
  }

  function installStyles () {
    if (document.querySelector('#filegram-files-pages-style')) return
    const style = document.createElement('style')
    style.id = 'filegram-files-pages-style'
    style.textContent = `
      #media-grid[data-filegram-pages="1"]{display:flex;flex-direction:column;gap:8px;overflow-y:auto;overflow-x:hidden;overflow-anchor:none;contain:layout paint style;padding:12px 18px 18px!important}
      #media-grid[data-filegram-pages="1"]>.gcard{flex:0 0 auto;transform:none!important}
      #media-grid[data-filegram-pages="1"]>.gcard:hover{transform:none!important}
      .filegram-file-pager{display:flex;align-items:center;gap:8px;min-height:44px;padding:6px 16px;border-bottom:1px solid var(--border,#26384a);background:var(--panel,#101923);color:var(--muted,#8294a8);font-size:12px}
      .filegram-file-pager.hidden{display:none!important}
      .filegram-file-pager .filegram-page-summary{min-width:0;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
      .filegram-file-pager .filegram-page-nav{display:flex;align-items:center;gap:6px;flex:0 0 auto}
      .filegram-file-pager button{min-width:34px;height:30px;padding:0 9px}
      .filegram-file-pager input{width:58px;height:30px;padding:0 7px;text-align:center;font-variant-numeric:tabular-nums}
      .filegram-file-pager .filegram-page-of{min-width:42px;text-align:left;white-space:nowrap;font-variant-numeric:tabular-nums}
      .filegram-file-pager .filegram-page-size{white-space:nowrap;color:var(--muted,#8294a8)}
      @media(max-width:900px){.filegram-file-pager .filegram-page-size{display:none}.filegram-file-pager{padding-inline:10px}}
    `
    document.head.appendChild(style)
  }

  function installPager () {
    const toolbar = document.querySelector('#files-toolbar')
    if (!toolbar) return false
    pager = document.querySelector('#filegram-file-pager')
    if (!pager) {
      pager = document.createElement('div')
      pager.id = 'filegram-file-pager'
      pager.className = 'filegram-file-pager'
      pager.innerHTML = `
        <span class="filegram-page-summary">0 files</span>
        <span class="filegram-page-size">100 / page</span>
        <span class="filegram-page-nav">
          <button type="button" class="ghost small" data-page-action="first" title="First page">«</button>
          <button type="button" class="ghost small" data-page-action="prev" title="Previous page">‹</button>
          <input type="number" min="1" step="1" value="1" aria-label="Files page">
          <span class="filegram-page-of">/ 1</span>
          <button type="button" class="ghost small" data-page-action="next" title="Next page">›</button>
          <button type="button" class="ghost small" data-page-action="last" title="Last page">»</button>
        </span>`
      toolbar.insertAdjacentElement('afterend', pager)
    }
    pagerSummary = pager.querySelector('.filegram-page-summary')
    pageInput = pager.querySelector('input')
    pageTotal = pager.querySelector('.filegram-page-of')
    firstButton = pager.querySelector('[data-page-action="first"]')
    prevButton = pager.querySelector('[data-page-action="prev"]')
    nextButton = pager.querySelector('[data-page-action="next"]')
    lastButton = pager.querySelector('[data-page-action="last"]')

    if (pager.dataset.filegramBound !== '1') {
      pager.dataset.filegramBound = '1'
      firstButton.onclick = () => goToPage(1)
      prevButton.onclick = () => goToPage(getPage() - 1)
      nextButton.onclick = () => goToPage(getPage() + 1)
      lastButton.onclick = () => goToPage(pageCount(cacheItems.length))
      pageInput.addEventListener('change', () => goToPage(pageInput.value))
      pageInput.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return
        event.preventDefault()
        goToPage(pageInput.value)
      })
    }
    pager.classList.toggle('hidden', state.view !== 'files')
    return true
  }

  function cleanupObservedThumbs () {
    if (!window.__fileGramThumbObserver) return
    for (const target of observedThumbs) window.__fileGramThumbObserver.unobserve(target)
    observedThumbs.clear()
  }

  function installLazyThumbOwner () {
    if (!baseLoadThumb || window.__fileGramLazyThumbInstalled) return
    window.__fileGramLazyThumbInstalled = true
    if (!('IntersectionObserver' in window)) return

    window.__fileGramThumbObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const payload = thumbTargets.get(entry.target)
        window.__fileGramThumbObserver.unobserve(entry.target)
        observedThumbs.delete(entry.target)
        if (!payload) continue
        baseLoadThumb(payload.img, payload.item)
      }
    }, { root: null, rootMargin: '320px 0px', threshold: 0.01 })

    loadThumb = function fileGramLazyLoadThumb (img, item) {
      if (!img || !item || item.thumbUrl || !item.thumbFileId) return baseLoadThumb(img, item)
      const target = img.parentElement || img
      target.dataset.filegramThumbTarget = '1'
      thumbTargets.set(target, { img, item })
      observedThumbs.add(target)
      window.__fileGramThumbObserver.observe(target)
    }
  }

  function installGridOwner () {
    const existing = document.querySelector('#media-grid')
    if (!existing) return false
    if (existing.dataset.filegramPages === '1') {
      grid = existing
      return true
    }

    // cloneNode(false) intentionally drops every listener bound to the previous
    // node by earlier layers, which is how this layer becomes the sole owner of
    // the grid. Selection is driven by the per-card handlers in decorateCard and
    // by the checkbox/Select all/range controls; the grid itself needs none.
    const next = existing.cloneNode(false)
    next.dataset.filegramPages = '1'
    existing.replaceWith(next)
    grid = next
    return true
  }

  function deriveItems (force = false) {
    const nextKey = currentViewKey()
    const nextStamp = sourceStamp()
    if (!force && cacheKey === nextKey && cacheStamp === nextStamp) return cacheItems

    let source
    if (state.files && state.files.mode === 'search') {
      source = Array.isArray(state.files.results) ? state.files.results : []
    } else {
      const snapshot = activeSnapshot()
      source = snapshot && Array.isArray(snapshot.items) ? snapshot.items : []
    }
    cacheSourceTotal = source.length

    const query = String(state.files && state.files.query || '').trim().toLowerCase()
    const filter = String(state.files && state.files.filter || 'all')
    const sort = String(state.files && state.files.sort || 'newest')
    let next = source

    if (query) {
      next = next.filter(item => String(item && item.name || '').toLowerCase().includes(query) || String(item && item.caption || '').toLowerCase().includes(query))
    }
    if (filter !== 'all') {
      next = next.filter(item => String(item && item.type || '') === filter)
    }

    if (sort === 'oldest') next = next.slice().reverse()
    else if (sort === 'name') next = next.slice().sort((a, b) => String(a && a.name || '').localeCompare(String(b && b.name || '')))
    else if (sort === 'size') next = next.slice().sort((a, b) => Number(b && b.fileSize || 0) - Number(a && a.fileSize || 0))
    else if (state.files && state.files.mode === 'search') next = next.slice().sort((a, b) => compareIds(b && b.messageId, a && a.messageId))

    const changedView = cacheKey !== nextKey
    cacheKey = nextKey
    cacheStamp = nextStamp
    cacheItems = next
    cacheRevision++

    if (changedView && !pageByView.has(nextKey)) setPage(1, nextKey)
    const pages = pageCount(cacheItems.length)
    if (getPage(nextKey) > pages) setPage(pages, nextKey)

    return cacheItems
  }

  function pageCount (total) {
    return Math.max(1, Math.ceil(Math.max(0, Number(total) || 0) / PAGE_SIZE))
  }

  function updatePager (items) {
    if (!installPager()) return
    const total = items.length
    const pages = pageCount(total)
    const page = Math.min(pages, getPage())
    if (page !== getPage()) setPage(page)
    const start = total ? (page - 1) * PAGE_SIZE + 1 : 0
    const end = Math.min(total, page * PAGE_SIZE)
    const filtered = total !== cacheSourceTotal
    pagerSummary.textContent = filtered
      ? `${start.toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()} matching · ${cacheSourceTotal.toLocaleString()} total`
      : `${start.toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()} files`
    pageInput.value = String(page)
    pageInput.max = String(pages)
    pageTotal.textContent = `/ ${pages.toLocaleString()}`
    firstButton.disabled = page <= 1
    prevButton.disabled = page <= 1
    nextButton.disabled = page >= pages
    lastButton.disabled = page >= pages
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

  function activeIndexByKey (key) {
    if (!key) return -1
    for (let index = 0; index < cacheItems.length; index++) {
      if (itemKey(cacheItems[index]) === key) return index
    }
    return -1
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

  function decorateCard (card, item, globalIndex) {
    card.dataset.globalIndex = String(globalIndex)
    card.onclick = event => {
      if (event.target.closest('input,button,a,select')) return
      const key = itemKey(item)
      if (event.shiftKey && typeof lastClickedKey !== 'undefined' && lastClickedKey) {
        const previous = activeIndexByKey(lastClickedKey)
        if (previous >= 0) {
          selectGlobalRange(previous, globalIndex)
          return
        }
      }
      if (state.selection.has(key)) state.selection.delete(key)
      else state.selection.set(key, item)
      try { lastClickedKey = key } catch {}
      updateVisibleSelection()
      updateSelectionBar()
    }
    return card
  }

  /* Is the grid exactly the page this layer last painted?
   *
   * The early return below assumed that matching revision + page meant the DOM
   * was still ours. Other layers paint into #media-grid directly, so the grid
   * could hold a virtual window plus spacers, or 240 rows, while this layer
   * happily skipped the repaint and only refreshed the pager text. Verifying the
   * mounted rows makes the paged view self-healing. */
  function gridMatchesPage (items, page) {
    if (!grid) return false
    const start = (page - 1) * PAGE_SIZE
    const expected = Math.max(0, Math.min(items.length, start + PAGE_SIZE) - start)
    if (grid.childElementCount !== expected) return false
    return grid.querySelectorAll(':scope > .gcard[data-global-index]').length === expected
  }

  function renderNow (force = false) {
    if (!installGridOwner() || !installPager()) return
    const items = deriveItems(force)
    const pages = pageCount(items.length)
    const page = Math.min(pages, getPage())
    if (page !== getPage()) setPage(page)

    if (!force && renderedRevision === cacheRevision && renderedPage === page && gridMatchesPage(items, page)) {
      updatePager(items)
      updateVisibleSelection()
      return
    }
    renderedRevision = cacheRevision
    renderedPage = page

    cleanupObservedThumbs()
    const start = (page - 1) * PAGE_SIZE
    const end = Math.min(items.length, start + PAGE_SIZE)
    const fragment = document.createDocumentFragment()
    for (let index = start; index < end; index++) {
      const item = items[index]
      fragment.appendChild(decorateCard(buildGridCard(item), item, index))
    }
    grid.replaceChildren(fragment)
    grid.scrollTop = 0

    const selectAll = document.querySelector('#select-all-media')
    if (selectAll) {
      selectAll.textContent = items.length ? `Select all (${items.length.toLocaleString()})` : 'Select all'
      selectAll.disabled = items.length === 0
    }
    try {
      if (typeof rescueUpdateRangeControls === 'function') rescueUpdateRangeControls(items.length)
    } catch {}
    updatePager(items)
    updateVisibleSelection()
  }

  function scheduleRender (force = false) {
    if (!installGridOwner()) return
    if (force) renderedRevision = -1
    if (renderFrame) return
    renderFrame = requestAnimationFrame(() => {
      renderFrame = 0
      renderNow(force)
    })
  }

  function goToPage (requested) {
    const items = deriveItems(false)
    const pages = pageCount(items.length)
    const page = Math.max(1, Math.min(pages, Math.floor(Number(requested) || 1)))
    if (page === getPage() && renderedRevision === cacheRevision) {
      updatePager(items)
      return
    }
    setPage(page)
    renderedPage = -1
    scheduleRender(false)
  }

  function installWarmIndexGuard () {
    const baseEnsure = rescueEnsureAllFiles
    rescueEnsureAllFiles = function fileGramWarmEnsure (chatId, options = {}) {
      if (chatId == null) return Promise.resolve(null)
      const id = idOf(chatId)
      const count = window.teleFilesIndex ? Number(window.teleFilesIndex.count(chatId) || 0) : 0
      const now = Date.now()

      if (!options.hardRefresh && count > 0) {
        scheduleRender(false)
        const last = lastBackgroundReconcile.get(id) || now
        if (now - last >= BACKGROUND_RECONCILE_MS) {
          lastBackgroundReconcile.set(id, now)
          const run = () => Promise.resolve(baseEnsure(chatId, options)).catch(() => {})
          if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 3000 })
          else setTimeout(run, 1200)
        }
        return Promise.resolve(null)
      }

      const pending = Promise.resolve(baseEnsure(chatId, options))
      pending.finally(() => {
        lastBackgroundReconcile.set(id, Date.now())
        scheduleRender(false)
      })
      return pending
    }
  }

  function installMessagePaintGuard () {
    if (!baseRenderMessagesList || window.__fileGramMessagePaintGuard) return
    window.__fileGramMessagePaintGuard = true
    renderMessagesList = function fileGramVisibleMessageRender () {
      if (state.view === 'files') return
      return baseRenderMessagesList()
    }
  }

  function installViewGuard () {
    if (window.__fileGramPageSetViewGuard) return
    window.__fileGramPageSetViewGuard = true
    const baseSetView = setView
    setView = function fileGramPagedSetView (view) {
      const result = baseSetView(view)
      if (installPager()) pager.classList.toggle('hidden', view !== 'files')
      if (view === 'files') scheduleRender(false)
      return result
    }
  }

  function install () {
    if (window.__fileGramFilesPagesInstalled) return true
    if (!window.teleFilesIndex || typeof buildGridCard !== 'function' || typeof rescueEnsureAllFiles !== 'function') return false
    window.__fileGramFilesPagesInstalled = true
    installStyles()
    installLazyThumbOwner()
    installGridOwner()
    installPager()
    installWarmIndexGuard()
    installMessagePaintGuard()
    installViewGuard()
    renderFiles = function fileGramRenderFilesPage () { scheduleRender(false) }
    window.fileGramFilesPages = {
      pageSize: PAGE_SIZE,
      page: () => getPage(),
      pageCount: () => pageCount(deriveItems(false).length),
      goToPage,
      refresh: () => scheduleRender(true)
    }
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
