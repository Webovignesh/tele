'use strict'

/* FileGram UI shell.
 *
 * Presentation-only enhancements layered on top of the stable runtime. This
 * file owns NO data. It never writes a file count, never touches the index,
 * never renders the file page, and never sends a download request. It only:
 *   - adds chrome the base markup lacks (filter segments, icons, sparkline)
 *   - mirrors values other owners already computed
 *   - relabels controls without re-templating nodes other layers hold
 *     references to
 *
 * Every install is idempotent and guarded so a double-load is harmless.
 */
;(function fileGramShell () {
  const ICON = {
    search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>',
    info: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h10M7 13h6"/></svg>',
    download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v10m0 0 4-4m-4 4-4-4"/><path d="M4 18h16"/></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="5" width="3.5" height="14" rx="1"/><rect x="13.5" y="5" width="3.5" height="14" rx="1"/></svg>',
    resume: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v4h-4"/></svg>',
    trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg>',
    gear: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.6 1.6 0 0 0 .33 1.76l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.6 1.6 0 0 0-1.76-.33 1.6 1.6 0 0 0-1 1.47V21a2 2 0 1 1-4 0v-.11a1.6 1.6 0 0 0-1-1.47 1.6 1.6 0 0 0-1.76.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.6 1.6 0 0 0 4.6 15a1.6 1.6 0 0 0-1.47-1H3a2 2 0 1 1 0-4h.11a1.6 1.6 0 0 0 1.47-1 1.6 1.6 0 0 0-.33-1.76l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.6 1.6 0 0 0 9 4.6a1.6 1.6 0 0 0 1-1.47V3a2 2 0 1 1 4 0v.11a1.6 1.6 0 0 0 1 1.47 1.6 1.6 0 0 0 1.76-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.6 1.6 0 0 0 19.4 9a1.6 1.6 0 0 0 1.47 1H21a2 2 0 1 1 0 4h-.11a1.6 1.6 0 0 0-1.47 1z"/></svg>',
    dots: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>'
  }

  const $ = sel => document.querySelector(sel)
  function svgButton (button, markup, label) {
    if (!button || button.dataset.fgIcon === '1') return
    button.dataset.fgIcon = '1'
    const text = label != null ? label : (button.textContent || '').trim()
    button.innerHTML = `<span class="fg-icon">${markup}</span><span class="fg-btn-label">${text}</span>`
  }

  /* ---------------------------------------------------------------- header */

  function installHeaderAvatar () {
    const container = $('#fg-chat-avatar')
    if (!container) return
    const chatId = state && state.activeChatId
    if (chatId == null) {
      container.replaceChildren()
      container.style.background = 'var(--fg-surface-3)'
      return
    }
    const chat = (state.chats || []).find(c => String(c.id) === String(chatId))
    if (!chat) return
    container.style.background = avatarColor(chat.title || '')
    const photoFileId = Number(chat.photoFileId || 0)
    const existing = container.querySelector('img')
    if (existing && existing.dataset.photoId === String(photoFileId)) return
    const fallback = document.createElement('span')
    fallback.textContent = initials(chat.title || 'C')
    container.replaceChildren(fallback)
    if (!photoFileId) return
    const img = new Image()
    img.dataset.photoId = String(photoFileId)
    img.alt = ''
    img.loading = 'lazy'
    img.decoding = 'async'
    img.onload = () => { fallback.style.visibility = 'hidden' }
    img.onerror = () => img.remove()
    img.src = `/api/media-preview/${encodeURIComponent(String(photoFileId))}?name=avatar.jpg&mime=image%2Fjpeg`
    container.appendChild(img)
  }

  function installHeaderIcons () {
    svgButton($('#mg-open-info'), ICON.info, 'Chat info')
    const all = $('#download-all-media')
    // #download-all-media's label carries the authoritative count and is
    // rewritten by files-stability.js / final-guard.js. Wrap the live text in a
    // span those writers keep hitting instead of replacing their target.
    if (all && all.dataset.fgIcon !== '1') {
      all.dataset.fgIcon = '1'
      const icon = document.createElement('span')
      icon.className = 'fg-icon'
      icon.innerHTML = ICON.download
      all.prepend(icon)
    }
  }

  function installHeaderOverflow () {
    const actions = $('.chat-actions')
    if (!actions || $('#fg-chat-overflow')) return
    const button = document.createElement('button')
    button.id = 'fg-chat-overflow'
    button.type = 'button'
    button.className = 'fg-icon-button'
    button.title = 'More actions'
    button.setAttribute('aria-label', 'More actions')
    button.innerHTML = `<span class="fg-icon">${ICON.dots}</span>`
    button.addEventListener('click', () => {
      const info = $('#mg-open-info')
      if (info) info.click()
    })
    actions.appendChild(button)
  }

  /* --------------------------------------------------------------- sidebar */

  function installSearchHint () {
    const search = $('#chat-search')
    if (!search || search.parentElement.classList.contains('fg-search-wrap')) return
    const wrap = document.createElement('div')
    wrap.className = 'fg-search-wrap'
    const icon = document.createElement('span')
    icon.className = 'fg-icon fg-search-icon'
    icon.innerHTML = ICON.search
    const hint = document.createElement('kbd')
    hint.className = 'fg-kbd'
    hint.textContent = navigator.platform.toLowerCase().includes('mac') ? '\u2318K' : 'Ctrl K'
    search.replaceWith(wrap)
    wrap.append(icon, search, hint)
    document.addEventListener('keydown', event => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k') return
      event.preventDefault()
      search.focus()
      search.select()
    })
  }

  /* Filter segments. `All` / `Unread` are a client-side view filter owned here.
   * `Channels only` delegates to the existing #channels-only checkbox so the
   * legacy renderers and its localStorage persistence keep working. */
  let unreadOnly = false

  function unreadChatCount () {
    return (state.chats || []).filter(c => c && Number(c.unread || 0) > 0).length
  }

  function applyUnreadFilter () {
    const list = $('#chat-list')
    if (!list) return
    let shown = 0
    for (const row of list.querySelectorAll('.chat-item[data-chat-id]')) {
      const chat = (state.chats || []).find(c => String(c.id) === row.dataset.chatId)
      const hasUnread = chat ? Number(chat.unread || 0) > 0 : false
      // Respect the owning renderer's own visibility decision; only add ours.
      if (unreadOnly && !hasUnread) row.hidden = true
      if (!row.hidden) shown++
    }
    const badge = $('#fg-filter-unread .fg-seg-badge')
    if (badge) {
      const count = unreadChatCount()
      badge.textContent = count ? String(count) : ''
      badge.hidden = count === 0
    }
    return shown
  }

  function installFilterSegments () {
    const legacy = $('.channels-filter')
    if (!legacy || $('#fg-filter-row')) return
    const checkbox = $('#channels-only')
    const row = document.createElement('div')
    row.id = 'fg-filter-row'
    row.className = 'fg-filter-row'

    const segAll = document.createElement('button')
    segAll.id = 'fg-filter-all'
    segAll.type = 'button'
    segAll.className = 'fg-seg is-active'
    segAll.textContent = 'All'

    const segUnread = document.createElement('button')
    segUnread.id = 'fg-filter-unread'
    segUnread.type = 'button'
    segUnread.className = 'fg-seg'
    segUnread.innerHTML = 'Unread <span class="fg-seg-badge" hidden></span>'

    const toggle = document.createElement('label')
    toggle.className = 'fg-channels-toggle'
    toggle.innerHTML = '<span>Channels only</span>'
    toggle.title = 'Show channels only'

    const setMode = next => {
      unreadOnly = next
      segAll.classList.toggle('is-active', !next)
      segUnread.classList.toggle('is-active', next)
      renderChats()
      applyUnreadFilter()
    }
    segAll.addEventListener('click', () => setMode(false))
    segUnread.addEventListener('click', () => setMode(true))

    legacy.replaceWith(row)
    row.append(segAll, segUnread, toggle)
    // Move the real checkbox and count into the new chrome. Same nodes, so the
    // clone-rebinding sentinels and change listeners in the legacy layers stay
    // attached and localStorage persistence is untouched.
    if (checkbox) toggle.appendChild(checkbox)
    const count = $('#chat-count')
    if (count) row.appendChild(count)
  }

  /* ------------------------------------------------------- sidebar account */

  function installAccountRow () {
    const account = $('#fg-sidebar-account')
    if (!account || account.dataset.fgReady === '1') return
    account.dataset.fgReady = '1'
    const gear = account.querySelector('.fg-settings-btn')
    if (gear) gear.innerHTML = `<span class="fg-icon">${ICON.gear}</span>`
    const menu = account.querySelector('.fg-account-menu')
    if (menu) {
      menu.innerHTML = `<span class="fg-icon">${ICON.dots}</span>`
      menu.addEventListener('click', () => {
        const logout = $('#tele-logout')
        if (logout) logout.click()
      })
    }
    if (gear) {
      gear.addEventListener('click', () => {
        const infoTab = $('#mg-tab-info')
        if (infoTab) infoTab.click()
      })
    }
  }

  function syncAccountIdentity () {
    const source = $('#user-name')
    const name = $('#fg-account-name')
    if (!source || !name) return
    const value = (source.textContent || '').trim()
    if (!value || value === 'you') return
    if (name.textContent !== value) name.textContent = value
    const avatar = $('#fg-account-avatar')
    if (avatar && avatar.dataset.fgSeeded !== value) {
      avatar.dataset.fgSeeded = value
      avatar.style.background = avatarColor(value)
      avatar.textContent = initials(value)
    }
  }

  /* ------------------------------------------------------- files workspace */

  function installToolbarIcons () {
    const icon = $('#files-toolbar .search-icon')
    if (icon && icon.dataset.fgIcon !== '1') {
      icon.dataset.fgIcon = '1'
      icon.classList.add('fg-icon')
      icon.innerHTML = ICON.search
    }
    const rangeSelect = $('#file-range-select')
    if (rangeSelect && rangeSelect.dataset.fgLabel !== '1') {
      rangeSelect.dataset.fgLabel = '1'
      // rescue-runtime.js only reads this node's click handler, never its text.
      rangeSelect.textContent = 'Apply'
      rangeSelect.classList.add('fg-apply')
    }
  }

  /* Relabel the pager without re-templating it. files-view.js caches
   * .filegram-page-summary / input / .filegram-page-of by reference and only
   * ever sets .disabled on the nav buttons, so text is safe to change. */
  function installPagerLabels () {
    const pager = $('#filegram-file-pager')
    if (!pager || pager.dataset.fgLabels === '1') return
    const prev = pager.querySelector('[data-page-action="prev"]')
    const next = pager.querySelector('[data-page-action="next"]')
    const first = pager.querySelector('[data-page-action="first"]')
    const last = pager.querySelector('[data-page-action="last"]')
    if (!prev || !next) return
    pager.dataset.fgLabels = '1'
    prev.innerHTML = '<span class="fg-chevron">\u2039</span><span>Previous</span>'
    prev.classList.add('fg-page-prev')
    next.innerHTML = '<span>Next</span><span class="fg-chevron">\u203a</span>'
    next.classList.add('fg-page-next')
    if (first) first.title = 'First page'
    if (last) last.title = 'Last page'

    const total = pager.querySelector('.filegram-page-of')
    const input = pager.querySelector('input')
    if (input && !pager.querySelector('.fg-page-word')) {
      const word = document.createElement('span')
      word.className = 'fg-page-word'
      word.textContent = 'Page'
      input.before(word)
    }
    if (total) {
      // "/ 87" -> "of 87". Rewriting makes the pattern stop matching, so this
      // observer cannot feed itself.
      const normalise = () => {
        const match = /^\s*\/\s*(.+)$/.exec(total.textContent || '')
        if (match) total.textContent = `of ${match[1]}`
      }
      new MutationObserver(normalise).observe(total, { childList: true, characterData: true, subtree: true })
      normalise()
    }
  }

  /* ----------------------------------------------------- downloads sidebar */

  function installDownloadIcons () {
    svgButton($('#pause-all'), ICON.pause, 'Pause all')
    svgButton($('#resume-all'), ICON.resume, 'Resume all')
    svgButton($('#cancel-all'), ICON.trash, 'Cancel all')
    svgButton($('#clear-done'), ICON.check, 'Clear done')
    svgButton($('#clear-all-downloads'), ICON.trash, 'Clear all')
    const setDir = $('#set-dir')
    if (setDir && setDir.dataset.fgLabel !== '1') {
      setDir.dataset.fgLabel = '1'
      setDir.textContent = 'Browse'
      setDir.title = 'Set the download destination folder'
    }
    const tabDownloads = $('#mg-tab-downloads')
    const tabInfo = $('#mg-tab-info')
    svgButton(tabDownloads, ICON.download, 'Downloads')
    svgButton(tabInfo, ICON.info, 'Chat Info')
  }

  /* Aggregate speed history for the sparklines. This is the ONLY new sampling
   * in the shell and it derives from state.downloads, which the download
   * engine owns. Nothing is invented: when no bytes move, the series is flat
   * zero and the sparkline renders empty. */
  const SPARK_POINTS = 40
  const SPARK_MS = 1000
  const speedSeries = []
  let lastBytes = null
  let lastSampleAt = 0
  let sparkTimer = 0

  function totalDownloadedBytes () {
    let bytes = 0
    for (const job of state.downloads.values()) bytes += Math.max(0, Number(job.downloaded || 0))
    return bytes
  }

  function activeJobCount () {
    let active = 0
    for (const job of state.downloads.values()) if (job.status === 'downloading') active++
    return active
  }

  function sampleSpeed () {
    const now = Date.now()
    const bytes = totalDownloadedBytes()
    if (lastBytes == null) { lastBytes = bytes; lastSampleAt = now; return }
    const elapsed = (now - lastSampleAt) / 1000
    if (elapsed <= 0) return
    const rate = Math.max(0, (bytes - lastBytes) / elapsed)
    lastBytes = bytes
    lastSampleAt = now
    speedSeries.push(rate)
    while (speedSeries.length > SPARK_POINTS) speedSeries.shift()
    paintSparkline()
  }

  function paintSparkline () {
    const host = $('#fg-spark-speed')
    if (!host) return
    const peak = Math.max(...speedSeries, 0)
    if (!peak) { host.replaceChildren(); return }
    const step = 100 / Math.max(1, SPARK_POINTS - 1)
    const points = speedSeries
      .map((value, index) => `${(index * step).toFixed(2)},${(20 - (value / peak) * 18).toFixed(2)}`)
      .join(' ')
    host.innerHTML = `<svg viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true"><polyline points="${points}"/></svg>`
  }

  function startSparkline () {
    if (sparkTimer) return
    // Only runs while something is actually downloading, then stops itself.
    sparkTimer = setInterval(() => {
      if (!activeJobCount() && !speedSeries.some(Boolean)) {
        clearInterval(sparkTimer)
        sparkTimer = 0
        lastBytes = null
        return
      }
      sampleSpeed()
    }, SPARK_MS)
  }

  function installSparkline () {
    const summary = $('#tele-ui-download-summary')
    if (!summary || summary.dataset.fgSpark === '1') return
    summary.dataset.fgSpark = '1'
    const host = document.createElement('div')
    host.id = 'fg-spark-speed'
    host.className = 'fg-spark'
    summary.appendChild(host)
  }

  /* A real "Downloaded" tile. The legacy summary exposes Speed / Current /
   * Remaining / Total; the completed-job count only ever reached the
   * #download-stats text line. This adds it as a first-class tile fed from
   * state.downloads, and is owned entirely by this file — no existing tile is
   * relabelled, so no metric is misrepresented. */
  function installDoneTile () {
    const summary = $('#tele-ui-download-summary')
    if (!summary || summary.querySelector('[data-stat="fg-done"]')) return
    const speedTile = summary.querySelector('[data-stat="speed"]')
    const anchor = speedTile && speedTile.parentElement
    if (!anchor) return
    const tile = document.createElement('div')
    tile.innerHTML = '<span>Downloaded</span><strong data-stat="fg-done">0</strong>'
    anchor.insertAdjacentElement('afterend', tile)
  }

  function syncDoneTile () {
    const target = document.querySelector('[data-stat="fg-done"]')
    if (!target) return
    let done = 0
    for (const job of state.downloads.values()) if (job.status === 'done') done++
    const text = done.toLocaleString()
    if (target.textContent !== text) target.textContent = text
  }

  /* Mirror the download totals into a readable footer line. Values are read
   * from state.downloads only — the same source renderDownloadsNow uses. */
  function installTotalsLine () {
    const summary = $('#tele-ui-download-summary')
    if (!summary || $('#fg-download-total')) return
    const line = document.createElement('div')
    line.id = 'fg-download-total'
    line.className = 'fg-download-total'
    line.innerHTML = '<span>Total</span><strong>0 files</strong>'
    summary.insertAdjacentElement('afterend', line)
  }

  function syncTotalsLine () {
    const strong = document.querySelector('#fg-download-total strong')
    if (strong) {
      const total = state.downloads.size
      const text = `${total.toLocaleString()} file${total === 1 ? '' : 's'}`
      if (strong.textContent !== text) strong.textContent = text
    }
    syncDoneTile()
    if (activeJobCount()) startSparkline()
  }

  /* -------------------------------------------------------------- lifecycle */

  function decorate () {
    installSearchHint()
    installFilterSegments()
    installAccountRow()
    installHeaderIcons()
    installHeaderOverflow()
    installToolbarIcons()
    installPagerLabels()
    installDownloadIcons()
    installDoneTile()
    installSparkline()
    installTotalsLine()
    syncAccountIdentity()
  }

  // Chrome injected by other layers appears asynchronously (management.js
  // drawer tabs, final-ui-fix summary tiles, files-view pager, rescue-runtime
  // range tools). Poll briefly until they exist, then stop.
  let attempts = 0
  const settle = () => {
    attempts++
    decorate()
    const ready = $('#filegram-file-pager') && $('#tele-ui-download-summary') && $('#mg-tab-info') && $('#file-range-select')
    if (!ready && attempts < 120) setTimeout(settle, 120)
  }
  settle()

  const title = $('#chat-title')
  if (title) new MutationObserver(installHeaderAvatar).observe(title, { childList: true, characterData: true, subtree: true })
  const user = $('#user-name')
  if (user) new MutationObserver(syncAccountIdentity).observe(user, { childList: true, characterData: true, subtree: true })

  // Keep the mirrored totals and the unread badge fresh without adding a
  // repaint loop: piggyback on the events the runtime already dispatches.
  if (typeof handleEvent === 'function') {
    const base = handleEvent
    handleEvent = function fileGramShellHandleEvent (event) {
      const result = base(event)
      if (!event) return result
      if (event.name === 'download-update' || event.name === 'download-done') queueMicrotask(syncTotalsLine)
      if (event.name === 'chat-upsert' || event.name === 'chat-remove') queueMicrotask(applyUnreadFilter)
      return result
    }
  }

  if (typeof renderChats === 'function') {
    const baseRenderChats = renderChats
    renderChats = function fileGramShellRenderChats () {
      const result = baseRenderChats()
      applyUnreadFilter()
      return result
    }
  }

  setTimeout(() => { syncTotalsLine(); applyUnreadFilter() }, 400)
})()
