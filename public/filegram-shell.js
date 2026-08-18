'use strict'

/* FileGram UI shell.
 *
 * Presentation-only. This file owns NO data: it never writes a file count,
 * never touches the index, never renders the file page, never sends a download
 * request, and never implements logout. It only:
 *   - adds chrome the base markup lacks (brand mark, filter segments, account
 *     popover, custom dropdown, statistics card)
 *   - mirrors values other owners already computed
 *   - relabels/relocates controls without re-templating nodes that other
 *     layers hold live references to
 *
 * Every install is idempotent so a double-load is harmless.
 */
;(function fileGramShell () {
  // A second <script> load must not re-run the installs, re-wrap the runtime
  // globals or start a second set of timers.
  if (window.__fileGramShellInstalled) return
  window.__fileGramShellInstalled = true

  const $ = sel => document.querySelector(sel)
  const $$ = sel => [...document.querySelectorAll(sel)]

  const ICON = {
    /* Telegram mark: brand-blue disc with the white paper plane. Self-contained
     * inline SVG, no network asset and no emoji. The plane is scaled and offset
     * so its bounding box sits centred in the 28x28 disc. The Telegram logo is a
     * trademark of Telegram Messenger; it is used here to identify the service
     * this client connects to. */
    brand: '<svg viewBox="0 0 28 28" aria-hidden="true"><defs><linearGradient id="fgTelegramMark" x1="14" y1="0" x2="14" y2="28" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#2AABEE"/><stop offset="1" stop-color="#229ED9"/></linearGradient></defs><circle cx="14" cy="14" r="14" fill="url(#fgTelegramMark)"/><path transform="translate(2.1 2.7) scale(0.96)" fill="#fff" d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z"/></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6v12M6 12h12"/></svg>',
    search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>',
    info: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h10M7 13h6"/></svg>',
    download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v10m0 0 4-4m-4 4-4-4"/><path d="M4 18h16"/></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="5" width="3.5" height="14" rx="1"/><rect x="13.5" y="5" width="3.5" height="14" rx="1"/></svg>',
    resume: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v4h-4"/></svg>',
    trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg>',
    gear: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.1"/><path d="M19.1 14.4a1.5 1.5 0 0 0 .3 1.65l.05.06a1.9 1.9 0 1 1-2.68 2.68l-.06-.06a1.5 1.5 0 0 0-2.56 1.07v.16a1.9 1.9 0 1 1-3.8 0v-.1a1.5 1.5 0 0 0-2.56-1.02l-.06.05a1.9 1.9 0 1 1-2.68-2.68l.05-.06a1.5 1.5 0 0 0-1.02-2.56h-.16a1.9 1.9 0 1 1 0-3.8h.1A1.5 1.5 0 0 0 5.5 7.33l-.05-.06a1.9 1.9 0 1 1 2.68-2.68l.06.05A1.5 1.5 0 0 0 10.75 3.6v-.16a1.9 1.9 0 1 1 3.8 0v.1a1.5 1.5 0 0 0 2.56 1.02l.06-.05a1.9 1.9 0 1 1 2.68 2.68l-.05.06a1.5 1.5 0 0 0 1.07 2.56h.16a1.9 1.9 0 1 1 0 3.8h-.16a1.5 1.5 0 0 0-1.37.92z"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>'
  }

  function iconify (button, markup, label) {
    if (!button || button.dataset.fgIcon === '1') return
    button.dataset.fgIcon = '1'
    const text = label != null ? label : (button.textContent || '').trim()
    button.replaceChildren()
    const icon = document.createElement('span')
    icon.className = 'fg-icon'
    icon.innerHTML = markup
    const span = document.createElement('span')
    span.className = 'fg-btn-label'
    span.textContent = text
    button.append(icon, span)
  }

  /* ============================== brand + create ========================= */

  function installBrand () {
    const mark = $('#fg-brand-mark')
    if (mark && mark.dataset.fgReady !== '1') {
      mark.dataset.fgReady = '1'
      mark.innerHTML = ICON.brand
    }
    const create = $('#fg-create-chat')
    if (create && create.dataset.fgReady !== '1') {
      create.dataset.fgReady = '1'
      create.innerHTML = `<span class="fg-icon">${ICON.plus}</span><span class="fg-btn-label">Create</span>`
      create.addEventListener('click', () => {
        const wizard = $('#mg-create-chat')
        if (wizard) wizard.click()
      })
    }
  }

  /* ============================== chat search ============================= */

  function installSearchHint () {
    const search = $('#chat-search')
    if (!search || search.closest('.fg-search-wrap')) return
    const wrap = document.createElement('div')
    wrap.className = 'fg-search-wrap'
    const icon = document.createElement('span')
    icon.className = 'fg-icon fg-field-icon'
    icon.innerHTML = ICON.search
    const hint = document.createElement('kbd')
    hint.className = 'fg-kbd'
    hint.textContent = /mac|iphone|ipad/i.test(navigator.platform || '') ? '\u2318K' : 'Ctrl K'
    search.replaceWith(wrap)
    wrap.append(icon, search, hint)

    document.addEventListener('keydown', event => {
      if (!(event.ctrlKey || event.metaKey) || (event.key || '').toLowerCase() !== 'k') return
      event.preventDefault()
      search.focus()
      search.select()
    })
  }

  /* ============================== chat filters ===========================
   * Semantics, stated explicitly because the two are easy to conflate:
   *   - the Unread badge counts CHATS THAT CONTAIN unread messages, not the
   *     total number of unread messages;
   *   - it counts LOADED chats only, because the server exposes no global
   *     unread-chat total (serializeChat sends a per-chat `unread` only).
   * Unread and Channels-only compose: both predicates must pass.
   */
  let unreadOnly = false

  function isChannel (chat) { return chat && chat.kind === 'channel' }
  function hasUnread (chat) { return chat && Number(chat.unread || 0) > 0 }

  function channelsOnlyActive () {
    const box = $('#channels-only')
    return !!(box && box.checked)
  }

  function matchingChatCount () {
    return (state.chats || []).filter(chat => {
      if (!chat) return false
      if (!hasUnread(chat)) return false
      if (channelsOnlyActive() && !isChannel(chat)) return false
      return true
    }).length
  }

  /* Applies the Unread predicate on top of whatever the owning chat renderer
   * already decided. It only ever HIDES rows, so the renderer's own query and
   * channels-only filtering stay authoritative. */
  function applyChatFilters () {
    const list = $('#chat-list')
    if (!list) return
    const byId = new Map((state.chats || []).filter(Boolean).map(c => [String(c.id), c]))
    let shown = 0
    for (const row of list.querySelectorAll('.chat-item[data-chat-id]')) {
      if (unreadOnly) {
        const chat = byId.get(row.dataset.chatId)
        if (!hasUnread(chat)) row.hidden = true
      }
      if (!row.hidden) shown++
    }

    const badge = $('#fg-filter-unread .fg-seg-badge')
    if (badge) {
      const count = matchingChatCount()
      const text = count ? String(count) : ''
      if (badge.textContent !== text) badge.textContent = text
      badge.hidden = count === 0
    }
    const summary = $('#fg-filter-summary')
    if (summary) {
      const text = `${shown.toLocaleString()} shown`
      if (summary.textContent !== text) summary.textContent = text
    }
    const empty = $('#fg-chat-empty')
    if (empty) empty.hidden = shown !== 0
  }

  function installFilterSegments () {
    const legacy = $('.channels-filter')
    if (!legacy || $('#fg-filter-row')) return
    const checkbox = $('#channels-only')

    const row = document.createElement('div')
    row.id = 'fg-filter-row'
    row.className = 'fg-filter-row'
    row.setAttribute('role', 'group')
    row.setAttribute('aria-label', 'Chat filters')

    const segAll = document.createElement('button')
    segAll.id = 'fg-filter-all'
    segAll.type = 'button'
    segAll.className = 'fg-seg is-active'
    segAll.textContent = 'All'
    segAll.setAttribute('aria-pressed', 'true')

    const segUnread = document.createElement('button')
    segUnread.id = 'fg-filter-unread'
    segUnread.type = 'button'
    segUnread.className = 'fg-seg'
    segUnread.setAttribute('aria-pressed', 'false')
    segUnread.append(document.createTextNode('Unread'))
    const badge = document.createElement('span')
    badge.className = 'fg-seg-badge'
    badge.hidden = true
    segUnread.appendChild(badge)

    const toggle = document.createElement('label')
    toggle.className = 'fg-channels-toggle'
    toggle.title = 'Show channels only'
    const toggleText = document.createElement('span')
    toggleText.textContent = 'Channels only'
    toggle.appendChild(toggleText)

    const setMode = next => {
      unreadOnly = next
      segAll.classList.toggle('is-active', !next)
      segUnread.classList.toggle('is-active', next)
      segAll.setAttribute('aria-pressed', String(!next))
      segUnread.setAttribute('aria-pressed', String(next))
      renderChats()
    }
    segAll.addEventListener('click', () => setMode(false))
    segUnread.addEventListener('click', () => setMode(true))

    legacy.replaceWith(row)
    row.append(segAll, segUnread, toggle)
    // The real checkbox node is MOVED, not recreated, so the legacy
    // clone-rebinding sentinels, its change listener and its localStorage
    // persistence all survive.
    if (checkbox) {
      toggle.appendChild(checkbox)
      checkbox.addEventListener('change', () => queueMicrotask(applyChatFilters))
    }
    const count = $('#chat-count')
    if (count) row.appendChild(count)
  }

  function installChatEmptyState () {
    const list = $('#chat-list')
    if (!list || $('#fg-chat-empty')) return
    const empty = document.createElement('div')
    empty.id = 'fg-chat-empty'
    empty.className = 'fg-chat-empty'
    empty.hidden = true
    empty.textContent = 'No chats match these filters.'
    list.insertAdjacentElement('afterend', empty)
  }

  /* ============================== account shell ==========================
   * Identity comes from the `auth` event's `me` payload, which server.js
   * builds from getMe(). The avatar reuses the existing /api/media-preview
   * file resolver; no second profile-photo pipeline is introduced.
   */
  /* Identity is held on window rather than in this closure so that a re-execution
   * of this file, or any repaint that happens to run before get-status resolves,
   * cannot reset it to empty and repaint the placeholder over the real name. */
  const account = window.__fileGramAccount ||
    (window.__fileGramAccount = { name: '', username: '', photoFileId: 0 })

  function paintAccount () {
    const nameEl = $('#fg-account-name')
    const statusEl = $('#fg-account-status')
    const avatar = $('#fg-account-avatar')
    const label = account.name || account.username || ''
    // Once a real identity is known, never regress to the neutral placeholder.
    if (!label && nameEl && nameEl.dataset.fgRealName === '1') return
    // A session can be authenticated before the identity payload arrives (or on
    // a server build that predates `me` in get-status). Claiming "Not signed in"
    // in that window would be wrong, so fall back to a neutral signed-in label.
    const signedIn = typeof state !== 'undefined' && state && state.status === 'ready'

    if (nameEl) {
      const text = label || (signedIn ? 'Telegram account' : 'Not signed in')
      if (nameEl.textContent !== text) nameEl.textContent = text
      nameEl.title = text
      if (label) nameEl.dataset.fgRealName = '1'
    }
    if (statusEl) {
      const text = account.username
        ? `@${account.username}`
        : (label || signedIn ? 'Online' : 'Connecting\u2026')
      if (statusEl.textContent !== text) statusEl.textContent = text
      statusEl.classList.toggle('is-online', !!(label || signedIn))
    }
    if (!avatar) return

    const signature = `${label}|${account.photoFileId}|${signedIn}`
    if (avatar.dataset.fgSignature === signature) return
    avatar.dataset.fgSignature = signature
    avatar.style.background = label ? avatarColor(label) : 'var(--fg-surface-3)'
    const fallback = document.createElement('span')
    fallback.className = 'fg-account-initials'
    fallback.textContent = label ? initials(label) : ''
    avatar.replaceChildren(fallback)
    if (!account.photoFileId) return

    const img = new Image()
    img.alt = ''
    img.loading = 'lazy'
    img.decoding = 'async'
    img.onload = () => { fallback.style.visibility = 'hidden' }
    img.onerror = () => img.remove()
    img.src = `/api/media-preview/${encodeURIComponent(String(account.photoFileId))}?name=avatar.jpg&mime=image%2Fjpeg`
    avatar.appendChild(img)
  }

  function captureAccount (me) {
    if (!me) return
    account.name = String(me.name || '').trim()
    account.username = String(me.username || '').trim()
    account.photoFileId = Number(me.photoFileId || 0)
    paintAccount()
  }

  /* ---- gear popover ---- */
  function closePopover () {
    const popover = $('#fg-account-popover')
    const gear = $('#fg-settings-btn')
    if (popover) popover.classList.add('hidden')
    if (gear) gear.setAttribute('aria-expanded', 'false')
  }

  function installAccountPopover () {
    const gear = $('#fg-settings-btn')
    const popover = $('#fg-account-popover')
    if (!gear || !popover || gear.dataset.fgReady === '1') return
    gear.dataset.fgReady = '1'
    gear.innerHTML = `<span class="fg-icon">${ICON.gear}</span>`

    gear.addEventListener('click', event => {
      event.stopPropagation()
      const open = popover.classList.toggle('hidden')
      gear.setAttribute('aria-expanded', String(!open))
      if (!open) popover.querySelector('.fg-popover-item')?.focus()
    })
    document.addEventListener('click', event => {
      if (popover.classList.contains('hidden')) return
      if (event.target === gear || gear.contains(event.target) || popover.contains(event.target)) return
      closePopover()
    })
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !popover.classList.contains('hidden')) {
        closePopover()
        gear.focus()
      }
    })

    const logout = $('#fg-popover-logout')
    if (logout) {
      logout.addEventListener('click', () => {
        closePopover()
        openLogoutModal()
      })
    }
  }

  /* ---- in-app logout confirmation ----
   * The confirmation is ours; the logout itself is NOT reimplemented. On
   * confirm we set a preconfirm flag and invoke the existing #tele-logout
   * button so auth-state-fix.js runs its unchanged TDLib logout pipeline.
   */
  let logoutReturnFocus = null

  function openLogoutModal () {
    const modal = $('#fg-logout-modal')
    if (!modal) return
    logoutReturnFocus = document.activeElement
    modal.classList.remove('hidden')
    $('#fg-logout-cancel')?.focus()
  }

  function closeLogoutModal () {
    const modal = $('#fg-logout-modal')
    if (!modal) return
    modal.classList.add('hidden')
    if (logoutReturnFocus && document.contains(logoutReturnFocus)) logoutReturnFocus.focus()
    logoutReturnFocus = null
  }

  function installLogoutModal () {
    const modal = $('#fg-logout-modal')
    if (!modal || modal.dataset.fgReady === '1') return
    modal.dataset.fgReady = '1'

    $('#fg-logout-cancel')?.addEventListener('click', closeLogoutModal)
    modal.addEventListener('mousedown', event => { if (event.target === modal) closeLogoutModal() })
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !modal.classList.contains('hidden')) closeLogoutModal()
    })

    $('#fg-logout-confirm')?.addEventListener('click', () => {
      const confirmBtn = $('#fg-logout-confirm')
      const real = $('#tele-logout')
      if (!real) {
        closeLogoutModal()
        toast('Logout is not available yet', 'error')
        return
      }
      if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Logging out\u2026' }
      real.dataset.fgPreconfirmed = '1'
      real.click()
      setTimeout(() => {
        closeLogoutModal()
        if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'Log out' }
      }, 400)
    })
  }

  /* ============================== center header ==========================
   * Select all is removed from the primary header and relocated into the Files
   * toolbar. The node itself is MOVED, so its click handler and the count text
   * written by files-stability/final-guard keep working.
   */
  function installHeaderIcons () {
    iconify($('#mg-open-info'), ICON.info, 'Chat info')
    const all = $('#download-all-media')
    if (all && all.dataset.fgIcon !== '1') {
      all.dataset.fgIcon = '1'
      const icon = document.createElement('span')
      icon.className = 'fg-icon'
      icon.innerHTML = ICON.download
      all.prepend(icon)
    }
  }

  /* The chat-header overflow ("three dot") button is deliberately absent.
   * Both of its entries are reachable elsewhere: Chat info from the drawer tab,
   * and Zip selected from the downloads panel. */

  function relocateSelectAll () {
    const selectAll = $('#select-all-media')
    const toolbar = $('#files-toolbar')
    if (!selectAll || !toolbar) return
    if (selectAll.dataset.fgMoved === '1') return
    selectAll.dataset.fgMoved = '1'
    selectAll.classList.add('fg-toolbar-select-all')
    toolbar.appendChild(selectAll)
  }

  /* ============================== files toolbar ========================== */

  function installFileSearch () {
    const box = $('#files-toolbar .search-box')
    const icon = box && box.querySelector('.search-icon')
    if (!box || !icon) return
    if (box.dataset.fgReady !== '1') {
      box.dataset.fgReady = '1'
      box.classList.add('fg-field')
    }
    if (icon.dataset.fgIcon !== '1') {
      icon.dataset.fgIcon = '1'
      icon.classList.add('fg-icon', 'fg-field-icon')
      icon.innerHTML = ICON.search
    }
  }

  /* Custom file-type dropdown. The native <select id="file-filter"> is kept in
   * the DOM (visually hidden) and remains the single source of truth: choosing
   * an item sets select.value and dispatches a real `change` event, so the
   * existing Files filter logic and every listener on it are untouched. */
  function installTypeDropdown () {
    const select = $('#file-filter')
    if (!select || select.dataset.fgCustom === '1') return
    const options = [...select.options]
    if (!options.length) return
    select.dataset.fgCustom = '1'

    const root = document.createElement('div')
    root.className = 'fg-select'
    root.id = 'fg-file-filter'

    const trigger = document.createElement('button')
    trigger.type = 'button'
    trigger.className = 'fg-select-trigger'
    trigger.setAttribute('aria-haspopup', 'listbox')
    trigger.setAttribute('aria-expanded', 'false')
    const triggerLabel = document.createElement('span')
    triggerLabel.className = 'fg-select-value'
    const chevron = document.createElement('span')
    chevron.className = 'fg-icon fg-select-chevron'
    chevron.innerHTML = ICON.chevron
    trigger.append(triggerLabel, chevron)

    const menu = document.createElement('div')
    menu.className = 'fg-select-menu hidden'
    menu.setAttribute('role', 'listbox')
    menu.setAttribute('aria-label', 'File type')

    const items = options.map(option => {
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'fg-select-item'
      item.setAttribute('role', 'option')
      item.dataset.value = option.value
      item.textContent = option.textContent
      item.addEventListener('click', () => {
        commit(option.value)
        close()
        trigger.focus()
      })
      menu.appendChild(item)
      return item
    })

    function syncLabel () {
      const current = options.find(o => o.value === select.value) || options[0]
      triggerLabel.textContent = current ? current.textContent : ''
      for (const item of items) {
        const active = item.dataset.value === select.value
        item.classList.toggle('is-selected', active)
        item.setAttribute('aria-selected', String(active))
      }
    }

    function commit (value) {
      if (select.value === value) return
      select.value = value
      // Real event so existing Files filter listeners run unchanged.
      select.dispatchEvent(new Event('change', { bubbles: true }))
      syncLabel()
    }

    function open () {
      menu.classList.remove('hidden')
      trigger.setAttribute('aria-expanded', 'true')
      const active = items.find(i => i.classList.contains('is-selected')) || items[0]
      active?.focus()
    }
    function close () {
      menu.classList.add('hidden')
      trigger.setAttribute('aria-expanded', 'false')
    }
    function isOpen () { return !menu.classList.contains('hidden') }

    trigger.addEventListener('click', event => {
      event.stopPropagation()
      isOpen() ? close() : open()
    })
    menu.addEventListener('keydown', event => {
      const index = items.indexOf(document.activeElement)
      if (event.key === 'ArrowDown') { event.preventDefault(); items[Math.min(items.length - 1, index + 1)]?.focus() }
      else if (event.key === 'ArrowUp') { event.preventDefault(); items[Math.max(0, index - 1)]?.focus() }
      else if (event.key === 'Escape') { event.preventDefault(); close(); trigger.focus() }
      else if (event.key === 'Home') { event.preventDefault(); items[0]?.focus() }
      else if (event.key === 'End') { event.preventDefault(); items[items.length - 1]?.focus() }
    })
    trigger.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open() }
    })
    document.addEventListener('click', event => {
      if (!isOpen() || root.contains(event.target)) return
      close()
    })
    // Keep the custom label correct if any other layer changes the filter.
    select.addEventListener('change', syncLabel)

    select.replaceWith(root)
    root.append(trigger, menu, select)
    select.classList.add('fg-visually-hidden')
    syncLabel()
  }

  /* Range defaults. rescue-runtime.js:686 only resets `to` when it EXCEEDS the
   * total, so a render while the index was still cold pinned it to 1 and it
   * never recovered. This wrapper restores min(100, total) — matching the
   * 100-per-page size — but stops as soon as the user edits either field, so a
   * manual range is never clobbered before Apply. */
  function installRangeDefaults () {
    if (typeof rescueUpdateRangeControls !== 'function' || rescueUpdateRangeControls.__fgRangeDefault) return
    const base = rescueUpdateRangeControls
    const wrapped = function fileGramRangeDefaults (total) {
      const result = base(total)
      const from = $('#file-range-from')
      const to = $('#file-range-to')
      const count = Math.max(0, Number(total) || 0)
      if (to && !to.dataset.fgUserEdited) {
        // Default mirrors the 100-per-page size. With an empty/cold result set
        // it still reads 100 rather than collapsing to 1.
        const want = String(count > 0 ? Math.min(100, count) : 100)
        if (to.value !== want) to.value = want
      }
      if (from && !from.dataset.fgUserEdited && (!from.value || Number(from.value) < 1)) from.value = '1'
      return result
    }
    wrapped.__fgRangeDefault = true
    rescueUpdateRangeControls = wrapped

    for (const id of ['#file-range-from', '#file-range-to']) {
      const node = $(id)
      if (!node || node.dataset.fgRangeBound === '1') continue
      node.dataset.fgRangeBound = '1'
      node.addEventListener('input', () => { node.dataset.fgUserEdited = '1' })
    }
  }

  function installToolbarLabels () {
    const rangeSelect = $('#file-range-select')
    if (rangeSelect && rangeSelect.dataset.fgLabel !== '1') {
      rangeSelect.dataset.fgLabel = '1'
      rangeSelect.textContent = 'Apply'
      rangeSelect.classList.add('fg-apply')
      rangeSelect.title = 'Select the files in this range across the whole filtered result set'
    }
    // The header and the pager already state the total; a third copy inside the
    // range block only steals width from the controls.
    const summary = $('#file-range-summary')
    if (summary) summary.classList.add('fg-visually-hidden')
  }

  /* Pager relabel without re-templating: files-view.js caches
   * .filegram-page-summary, the input and .filegram-page-of by reference and
   * only ever sets .disabled on the nav buttons, so their text is safe.
   * It is also relocated to the foot of the workspace — installPager() looks
   * the node up by id and reuses it, so moving it is safe. */
  function installPagerLabels () {
    const pager = $('#filegram-file-pager')
    if (!pager || pager.dataset.fgLabels === '1') return
    const prev = pager.querySelector('[data-page-action="prev"]')
    const next = pager.querySelector('[data-page-action="next"]')
    if (!prev || !next) return
    pager.dataset.fgLabels = '1'

    // The pager's children must stay inside #filegram-file-pager: files-view.js
    // installPager() re-queries .filegram-page-summary / input /
    // .filegram-page-of from within the pager on every updatePager() call, so
    // relocating any of them out would make those lookups null and throw.
    // Only the whole pager element is moved, and only as one unit.
    const foot = document.querySelector('.chat-foot')
    if (foot) foot.insertAdjacentElement('beforebegin', pager)
    pager.classList.add('fg-pager-foot')

    prev.innerHTML = '<span class="fg-chevron">\u2039</span><span>Previous</span>'
    prev.classList.add('fg-page-prev')
    next.innerHTML = '<span>Next</span><span class="fg-chevron">\u203a</span>'
    next.classList.add('fg-page-next')

    const input = pager.querySelector('input')
    if (input && !pager.querySelector('.fg-page-word')) {
      const word = document.createElement('span')
      word.className = 'fg-page-word'
      word.textContent = 'Page'
      input.before(word)
    }
    const total = pager.querySelector('.filegram-page-of')
    if (total) {
      // "/ 225" -> "of 225". The rewrite stops matching its own output, so the
      // observer cannot feed itself.
      const normalise = () => {
        const match = /^\s*\/\s*(.+)$/.exec(total.textContent || '')
        if (match) total.textContent = `of ${match[1]}`
      }
      new MutationObserver(normalise).observe(total, { childList: true, characterData: true, subtree: true })
      normalise()
    }
  }

  /* Keeps the page controls clear of the selection dock.
   *
   * rescue-runtime.js moves #selection-bar inside .chat and app.js toggles its
   * .hidden class from the selection count. The dock is absolutely positioned, so
   * it painted over the relocated pager: the nav was not merely obscured but
   * unclickable - a hit test at the centre of Next returned #mark-completed, so
   * paging was impossible whenever anything was selected.
   *
   * Publishing the dock's measured height lets the stylesheet reserve exactly that
   * much space at the bottom of the chat column. Measured rather than hard-coded
   * because the dock's buttons wrap when the workspace is narrow, and the dock owns
   * its own visibility - this only observes it. */
  function installDockClearance () {
    const dock = $('#selection-bar')
    const chat = document.querySelector('.chat')
    if (!dock || !chat || dock.dataset.fgClearance === '1') return
    dock.dataset.fgClearance = '1'

    const sync = () => {
      const open = !dock.classList.contains('hidden')
      const height = open ? Math.ceil(dock.getBoundingClientRect().height) : 0
      const next = `${height}px`
      // Guarded so the ResizeObserver below cannot feed itself.
      if (chat.style.getPropertyValue('--fg-dock-h') !== next) {
        chat.style.setProperty('--fg-dock-h', next)
      }
      chat.classList.toggle('fg-dock-open', open)
    }

    new MutationObserver(sync).observe(dock, { attributes: true, attributeFilter: ['class'] })
    // Catches the buttons wrapping to a second line as the workspace narrows.
    if (typeof ResizeObserver === 'function') new ResizeObserver(sync).observe(dock)
    sync()
  }

  /* ============================== downloads panel ========================= */

  function installDownloadIcons () {
    iconify($('#pause-all'), ICON.pause, 'Pause all')
    iconify($('#resume-all'), ICON.resume, 'Resume all')
    iconify($('#cancel-all'), ICON.trash, 'Cancel all')
    iconify($('#clear-done'), ICON.check, 'Clear done')
    iconify($('#clear-all-downloads'), ICON.trash, 'Clear all')
    iconify($('#mg-tab-downloads'), ICON.download, 'Downloads')
    iconify($('#mg-tab-info'), ICON.info, 'Chat Info')

    /* This used to set `#set-dir.textContent = 'Browse'`, which destroyed the
     * control's icon/label/path markup on every pass and made it one of the three
     * layers fighting over the node. The Save-to control carries its own markup in
     * index.html and `setDirLabel` in app.js is its only painter. */
  }

  /* Paints the elapsed portion of the concurrency track.
   *
   * Chromium cannot style ::-webkit-slider-runnable-track relative to the value,
   * so the filled part is a gradient stop driven by this custom property. Purely
   * presentational: it reads the input's own value and writes no state. The
   * concurrency value itself stays owned by app.js, which debounces
   * set-concurrency to the server. */
  function paintRangeFill () {
    const slider = $('#concurrency')
    if (!slider) return
    const min = Number(slider.min || 1)
    const max = Number(slider.max || 64)
    const value = Number(slider.value || min)
    const span = max - min
    const ratio = span > 0 ? Math.min(1, Math.max(0, (value - min) / span)) : 0
    /* Only the ratio is published. The stylesheet turns it into the stop position,
     * because a pseudo-element DOES inherit custom properties from its originating
     * element. The stop has to be the thumb CENTRE, not a plain percentage of the
     * track: the centre only travels between half a thumb from each end, so a
     * percentage runs ahead of the head and paints blue past it. */
    slider.style.setProperty('--fg-range-ratio', ratio.toFixed(5))
  }

  function installRangeFill () {
    const slider = $('#concurrency')
    if (!slider || slider.dataset.fgRangeFill === '1') return
    slider.dataset.fgRangeFill = '1'
    slider.addEventListener('input', paintRangeFill)
    slider.addEventListener('change', paintRangeFill)

    /* A programmatic assignment fires NO input or change event.
     *
     * applyStatus writes the server's concurrency straight to .value inside a
     * promise, so the fill kept the markup default's geometry (value="16") while
     * the thumb and the readout showed the real number - blue painted well past
     * the head. Hooking the property means any layer that assigns .value
     * repaints, whatever order things resolve in. */
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
    if (descriptor && descriptor.get && descriptor.set) {
      Object.defineProperty(slider, 'value', {
        configurable: true,
        enumerable: descriptor.enumerable,
        get () { return descriptor.get.call(this) },
        set (next) { descriptor.set.call(this, next); paintRangeFill() }
      })
    }
    // min/max/value can also be rewritten as attributes by another layer.
    new MutationObserver(paintRangeFill)
      .observe(slider, { attributes: true, attributeFilter: ['min', 'max', 'step', 'value'] })

    paintRangeFill()
  }

  /* The statistics card. Structure is ours; every number is read from
   * state.downloads, which the download engine owns. These are DOWNLOAD QUEUE
   * figures: with an empty queue they are legitimately 0 / 0 / 0 files. The
   * channel's file count is never substituted here. */
  function installStatsCard () {
    const summary = $('#tele-ui-download-summary')
    if (!summary || summary.dataset.fgCard === '1') return
    summary.dataset.fgCard = '1'
    summary.classList.add('fg-stats')

    if (!summary.querySelector('[data-stat="fg-done"]')) {
      const speedTile = summary.querySelector('[data-stat="speed"]')
      const anchor = speedTile && speedTile.parentElement
      if (anchor) {
        const tile = document.createElement('div')
        const label = document.createElement('span')
        label.textContent = 'Downloaded'
        const value = document.createElement('strong')
        value.dataset.stat = 'fg-done'
        value.textContent = '0'
        tile.append(label, value)
        anchor.insertAdjacentElement('afterend', tile)
      }
    }
    if (!summary.querySelector('#fg-spark-speed')) {
      const spark = document.createElement('div')
      spark.id = 'fg-spark-speed'
      spark.className = 'fg-spark'
      summary.appendChild(spark)
    }
    // Total lives in the lower section of the SAME card.
    if (!summary.querySelector('#fg-stats-total')) {
      const footer = document.createElement('div')
      footer.id = 'fg-stats-total'
      footer.className = 'fg-stats-total'
      const label = document.createElement('span')
      label.textContent = 'Total'
      const value = document.createElement('strong')
      value.textContent = '0 files'
      footer.append(label, value)
      summary.appendChild(footer)
    }
  }

  /* Queue figures come from state.queueStats, the server's aggregate over the
   * whole queue. state.downloads is only the projection the server has pushed
   * (roughly one concurrency window plus finished jobs), so counting it made
   * Total report 8 for a 20,000-file queue. Falls back to the projection only
   * when no aggregate has arrived yet. */
  function syncStats () {
    const queue = state.queueStats
    let done = 0
    if (queue) done = Number(queue.done || 0)
    else for (const job of state.downloads.values()) if (job.status === 'done') done++
    const doneEl = document.querySelector('[data-stat="fg-done"]')
    if (doneEl) {
      const text = done.toLocaleString()
      if (doneEl.textContent !== text) doneEl.textContent = text
    }
    const totalEl = document.querySelector('#fg-stats-total strong')
    if (totalEl) {
      const total = queue ? Number(queue.total || 0) : state.downloads.size
      const text = `${total.toLocaleString()} file${total === 1 ? '' : 's'}`
      if (totalEl.textContent !== text) totalEl.textContent = text
    }
    if (activeJobCount()) startSparkline()
  }

  /* Aggregate speed history for the sparkline. Derived purely from byte deltas
   * on state.downloads. Flat/empty when nothing moves; nothing is invented. */
  const SPARK_POINTS = 40
  const speedSeries = []
  let lastBytes = null
  let lastSampleAt = 0
  let sparkTimer = 0

  function activeJobCount () {
    let active = 0
    for (const job of state.downloads.values()) if (job.status === 'downloading') active++
    return active
  }

  function sampleSpeed () {
    const now = Date.now()
    let bytes = 0
    for (const job of state.downloads.values()) bytes += Math.max(0, Number(job.downloaded || 0))
    if (lastBytes == null) { lastBytes = bytes; lastSampleAt = now; return }
    const elapsed = (now - lastSampleAt) / 1000
    if (elapsed <= 0) return
    speedSeries.push(Math.max(0, (bytes - lastBytes) / elapsed))
    while (speedSeries.length > SPARK_POINTS) speedSeries.shift()
    lastBytes = bytes
    lastSampleAt = now
    paintSparkline()
  }

  function paintSparkline () {
    const host = $('#fg-spark-speed')
    if (!host) return
    const peak = Math.max(...speedSeries, 0)
    if (!peak) { host.replaceChildren(); return }
    const step = 100 / Math.max(1, SPARK_POINTS - 1)
    const points = speedSeries
      .map((value, index) => `${(index * step).toFixed(2)},${(18 - (value / peak) * 16).toFixed(2)}`)
      .join(' ')
    host.innerHTML = `<svg viewBox="0 0 100 18" preserveAspectRatio="none" aria-hidden="true"><polyline points="${points}"/></svg>`
  }

  function startSparkline () {
    if (sparkTimer) return
    sparkTimer = setInterval(() => {
      if (!activeJobCount() && !speedSeries.some(Boolean)) {
        clearInterval(sparkTimer)
        sparkTimer = 0
        lastBytes = null
        return
      }
      sampleSpeed()
    }, 1000)
  }

  /* ============================== lifecycle ============================== */

  function decorate () {
    installBrand()
    installSearchHint()
    installFilterSegments()
    installChatEmptyState()
    installAccountPopover()
    installLogoutModal()
    installHeaderIcons()
    relocateSelectAll()
    installFileSearch()
    installTypeDropdown()
    installToolbarLabels()
    installRangeDefaults()
    installPagerLabels()
    installDockClearance()
    installDownloadIcons()
    installStatsCard()
    installRangeFill()
    // applyStatus writes the slider value from the server, which fires no input
    // event, so the fill is repainted on every decorate pass.
    paintRangeFill()
    paintAccount()
  }

  // Chrome from other layers arrives asynchronously (management.js drawer tabs,
  // final-ui-fix summary tiles, files-view pager, rescue-runtime range tools).
  // Poll briefly until they all exist, then stop. No steady-state loop.
  let attempts = 0
  const settle = () => {
    attempts++
    decorate()
    const ready = $('#filegram-file-pager') && $('#tele-ui-download-summary') &&
      $('#mg-tab-info') && $('#file-range-select') && $('#fg-file-filter')
    if (!ready && attempts < 150) setTimeout(settle, 120)
  }
  settle()

  const user = $('#user-name')
  if (user) {
    new MutationObserver(() => {
      const value = (user.textContent || '').trim()
      if (value && value !== 'you' && !account.name) { account.name = value; paintAccount() }
    }).observe(user, { childList: true, characterData: true, subtree: true })
  }

  // Piggyback on events the runtime already dispatches instead of polling.
  if (typeof handleEvent === 'function') {
    const base = handleEvent
    handleEvent = function fileGramShellHandleEvent (event) {
      const result = base(event)
      if (!event) return result
      if (event.name === 'auth' && event.payload && event.payload.me) captureAccount(event.payload.me)
      if (event.name === 'download-update' || event.name === 'download-done' || event.name === 'download-stats') queueMicrotask(syncStats)
      if (event.name === 'chat-upsert' || event.name === 'chat-remove') queueMicrotask(applyChatFilters)
      return result
    }
  }

  /* A browser reload of an already-authenticated session never replays the
   * `auth` event, so identity also has to come from get-status, which now
   * carries the cached `me`. */
  if (typeof applyStatus === 'function') {
    const baseApplyStatus = applyStatus
    applyStatus = function fileGramShellApplyStatus (data) {
      const result = baseApplyStatus(data)
      if (data && data.me) captureAccount(data.me)
      return result
    }
  }

  /* ...but that wrapper only helps if it is installed before the runtime's one
   * boot-time get-status resolves, and it usually is not. app.js does
   * `request('get-status').then(applyStatus)` inside ws.onopen, which evaluates
   * `applyStatus` at that moment; a localhost socket normally opens before this
   * file has executed, so the payload is handed to a pre-shell wrapper and the
   * `me` field is dropped. auth-state-fix's microtask re-request has the same
   * problem and additionally skips while the socket is still CONNECTING. Nothing
   * requests status again, and `auth` is only replayed on a fresh
   * authorizationStateReady transition, so a reload of an already-signed-in
   * session would keep the placeholder name indefinitely.
   *
   * So the shell asks for its own identity instead of depending on that race.
   * Read-only request; it owns no data and mutates no server state. The timer
   * self-clears on success and is hard-capped, so it cannot become the kind of
   * orphaned interval that previously blanked the downloads list.
   */
  function pullIdentity () {
    if (account.name || account.username) return true
    if (typeof request !== 'function') return false
    if (typeof ws === 'undefined' || !ws || ws.readyState !== WebSocket.OPEN) return false
    request('get-status')
      .then(data => { if (data && data.me) captureAccount(data.me) })
      .catch(() => {})
    return false
  }

  if (!pullIdentity()) {
    let tries = 0
    const identityTimer = setInterval(() => {
      if (pullIdentity() || ++tries >= 20) clearInterval(identityTimer)
    }, 500)
  }

  if (typeof renderChats === 'function') {
    const baseRenderChats = renderChats
    renderChats = function fileGramShellRenderChats () {
      const result = baseRenderChats()
      applyChatFilters()
      return result
    }
  }

  /* Final gate: one tick later, so the other owners and their event listeners have
   * finished installing.
   *
   * This must call decorate(), NEVER fileGramShell(). This IIFE *is*
   * fileGramShell, so calling it here re-entered the whole file once per
   * macrotask, forever. Each re-entry rebuilt the `account` closure as empty,
   * which made paintAccount repaint the placeholder "Telegram account" over the
   * real name; started another identity setInterval and another 120ms settle()
   * chain; grew the handleEvent / applyStatus / renderChats wrapper chains by one
   * link per tick; and added another MutationObserver. It was the single cause of
   * both the blank/flashing profile and the right-panel flicker. */
  setTimeout(() => { decorate(); syncStats(); applyChatFilters() }, 0)
})()

