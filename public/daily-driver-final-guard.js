'use strict'

/* Final stability guard.
 * This file loads after every legacy/rescue layer and deliberately owns the
 * surfaces that are unsafe to let older wrappers repaint repeatedly:
 * - scan-media-v3 result stability / never-shrink cache protection
 * - transport progress suppression (progress is not authoritative UI state)
 * - keyed chat-list reconciliation so search/realtime updates do not rebuild DPs
 * - stable Files footer/count text so background message refreshes cannot jitter it
 */

;(function teleFinalGuard () {
  const guardBaseHandleEvent = handleEvent
  const guardBaseSetLoadState = setLoadState
  const guardBaseOpenChat = openChat
  const guardAvatarRetries = new Map()

  /* THE CLIENT CACHE THAT OUTRANKED TELEGRAM WAS HERE, and it is the answer to
   * clause 2.24 item (2).
   *
   * This layer replaced the global `request` with `teleGuardRequest`, intercepted
   * `scan-media-v3`, and ran the server's answer through `guardStableMediaScan`. When
   * the truthful result came back smaller than a client-side floor - the persisted
   * IndexedDB record's item count, or this layer's own copy of the high-water mark -
   * it discarded the server's answer and returned `guardSnapshotAsResponse(known)`:
   * the stale snapshot, stamped `done: true, fromCache: true,
   * protectedByClientCache: true`, indistinguishable to the caller from a completed
   * scan.
   *
   * Measured on the running application for chat TEST: the server answered
   * `found=0 items=0` on ws request ids 31, 32 and 33; the caller received
   * `{"found":22,...,"protectedByClientCache":true}`. `teleFilesIndex.hardRefresh()`
   * did not escape it either, because `clearTotalFloor` dropped the localStorage
   * floor while `guardBestKnownSnapshot` read the IndexedDB record directly, and each
   * pass re-stamped the floor from the stale snapshot it had just served. That is why
   * every previous fix to this defect was invisible: no matter what the server said,
   * this function answered 22.
   *
   * Everything that made it work is gone: `guardStableMediaScan`, the `request`
   * interception, `guardBestKnownSnapshot`, `guardSnapshotAsResponse`,
   * `guardScanShape`, `guardMemorySnapshot`, `guardIsCompleteSnapshot`,
   * `GUARD_MAX_SCAN_ROUNDS` and the flight map. `scan-media-v3` now reaches its
   * caller unmodified.
   *
   * The protection it was standing in for has not been dropped, it has moved to where
   * the decision is made: `public/files-stability.js` commits discoveries through
   * `commitDiscovery`, which unions and therefore cannot lower a count, and only
   * `commitAuthoritative` - reached solely from a confirmed, complete truth pass - may
   * remove anything. A partial or cancelled scan still cannot replace a larger index
   * (clauses 3.2, 3.3), and it can no longer replace a smaller one either.
   *
   * The count-label takeover went with it. `guardUpdateMediaLabel` painted the header,
   * Download all and Select all from `rescueFileCache`, which every legacy layer
   * writes, so the number on screen came from whichever layer wrote that cache last
   * rather than from the committed index. `files-stability.js` `ownCountLabel()` owns
   * `updateMediaCountLabel` and `rescueUpdateMediaLabel` now and paints from the
   * committed index; `files-view.js` paints Select all from the same source. */
  function guardKey (value) { return String(value) }

  /* ------------------------------ Stable Files presentation ------------------------------ */

  /* Kept: the load-state smoothing. It suppresses the transient
   * "syncing / counting / Loaded N" chatter in the Files footer that made the status
   * line flicker while a scan streamed, and it is purely presentational.
   *
   * It now asks the index OWNER whether a snapshot exists instead of reading
   * `rescueFileCache` through the deleted `guardMemorySnapshot`. Same behaviour, one
   * source: the shared cache is written by several legacy layers, so a partial write
   * there could clear the footer while the committed index was still empty. Failures
   * still pass through unchanged, which is what lets the reconciliation's "Could not
   * verify against Telegram" notice reach the user (clause 2.10). */
  function guardOwnedSnapshot (chatId) {
    if (chatId == null) return null
    try {
      if (window.teleFilesIndex && typeof window.teleFilesIndex.snapshot === 'function') {
        const snapshot = window.teleFilesIndex.snapshot(chatId)
        if (snapshot && Array.isArray(snapshot.items) && snapshot.done !== false) return snapshot
      }
    } catch {}
    return null
  }

  setLoadState = function teleGuardSetLoadState (text) {
    if (state.view !== 'files') return guardBaseSetLoadState(text)
    const value = String(text || '')
    if (/failed|could not|error/i.test(value)) return guardBaseSetLoadState(value)
    if (guardOwnedSnapshot(state.activeChatId)) return guardBaseSetLoadState('')
    return guardBaseSetLoadState('Indexing files…')
  }

  /* ------------------------------ Keyed chat list ------------------------------ */

  function guardChatOrder (chat) {
    try { return BigInt(String((chat && chat.order) || 0)) } catch { return 0n }
  }

  function guardPreviewText (chat) {
    if (chat.username) return '@' + chat.username
    if (chat.lastText) return chat.lastText
    const content = chat.lastMessage
    if (!content || !content._) return ''
    if (content._ === 'messageText') return content.text && content.text.text ? content.text.text : ''
    return ({
      messagePhoto: 'Photo', messageVideo: 'Video', messageDocument: 'Document', messageAudio: 'Audio',
      messageVoiceNote: 'Voice message', messageAnimation: 'GIF', messageSticker: 'Sticker', messageVideoNote: 'Video message'
    })[content._] || ''
  }

  function guardAvatar (chat, current) {
    const photoFileId = Number(chat.photoFileId || 0)
    const wanted = String(photoFileId || 0)
    if (current && current.dataset.guardPhotoFileId === wanted) return current

    const avatar = document.createElement('div')
    avatar.className = 'chat-avatar tele-final-avatar tele-guard-avatar'
    avatar.dataset.guardPhotoFileId = wanted
    avatar.style.background = avatarColor(chat.title || '')
    const fallback = document.createElement('span')
    fallback.className = 'tele-final-avatar-fallback'
    fallback.textContent = initials(chat.title || 'Chat')
    avatar.appendChild(fallback)
    if (!photoFileId) return avatar

    const image = new Image()
    image.className = 'tele-final-avatar-image'
    image.alt = ''
    image.loading = 'lazy'
    image.decoding = 'async'
    const load = () => {
      const retry = guardAvatarRetries.get(photoFileId) || 0
      image.src = `/api/media-preview/${encodeURIComponent(String(photoFileId))}?name=avatar.jpg&mime=image%2Fjpeg&retry=${retry}`
    }
    image.onload = () => fallback.classList.add('hidden')
    image.onerror = () => {
      const retries = guardAvatarRetries.get(photoFileId) || 0
      if (retries < 2) {
        guardAvatarRetries.set(photoFileId, retries + 1)
        setTimeout(load, 450 * (retries + 1))
      } else {
        image.remove()
        fallback.classList.remove('hidden')
      }
    }
    avatar.appendChild(image)
    load()
    return avatar
  }

  function guardChatById (chatId) {
    if (chatId == null) return null
    return (state.chats || []).find(chat => chat && guardKey(chat.id) === guardKey(chatId)) || null
  }

  /* Repaint chats through the CURRENT renderChats owner, not through
   * guardRenderChats directly.
   *
   * guardRenderChats decides row.hidden from the search query and channels-only
   * alone. Later layers add their own predicates on top - filegram-shell.js adds
   * the Unread filter - and they run from the renderChats wrapper. Calling
   * guardRenderChats by name therefore re-showed every row and defeated the
   * Unread filter, which is exactly what made unrelated chats reappear the moment
   * a chat was clicked (openChat called it directly).
   *
   * No recursion: the wrapper invokes the base it captured at install time, not
   * this global. */
  function guardRepaintChats () {
    if (typeof renderChats === 'function' && renderChats !== guardRenderChats) return renderChats()
    return guardRenderChats()
  }

  /* Tells Telegram the chat has been read, so unread_count drops and the chat
   * leaves the Unread filter. Only fires when there is something unread, so
   * revisiting an already-read chat costs no round trip. */
  const guardReadInFlight = new Set()

  function guardMarkChatRead (chatId) {
    const chat = guardChatById(chatId)
    if (!chat || Number(chat.unread || 0) <= 0) return
    // openChat restores the preferred view through setView, so both hooks can fire
    // for a single user action. One request per chat at a time; the unread count
    // drops to 0 via chat-upsert, which stops any further call by itself.
    const key = guardKey(chatId)
    if (guardReadInFlight.has(key)) return
    guardReadInFlight.add(key)
    Promise.resolve(request('mark-read', { chatId }))
      .catch(() => {})
      .finally(() => guardReadInFlight.delete(key))
  }

  /* Active chat header avatar (#fg-chat-avatar).
   *
   * Nothing populated this node, so the header showed an empty dark circle: it was
   * never a failing image load. It reuses guardAvatar, the same loader, retry
   * policy and DOM-level cache the sidebar rows use, so no second downloader is
   * introduced and the browser serves the identical /api/media-preview URL from
   * cache. Photo when available, coloured initials otherwise; never empty.
   *
   * guardAvatar returns the node it was given when the photo id is unchanged, so
   * repeat opens neither rebuild nor reload. */
  function guardPaintHeaderAvatar () {
    const host = document.querySelector('#fg-chat-avatar')
    if (!host) return
    const chatId = state.activeChatId
    if (chatId == null) {
      host.replaceChildren()
      host.dataset.guardChat = ''
      return
    }
    const chat = guardChatById(chatId)
    if (!chat) return
    const key = guardKey(chatId)
    /* guardAvatar dedupes on the photo id alone. That is correct for the sidebar,
     * where every chat owns its own node, but wrong for this single shared host:
     * two consecutive chats that both lack a photo share photo id 0, so the node
     * would be reused and keep the PREVIOUS chat's initials and colour. Only offer
     * the existing node for reuse while the chat is unchanged, so a late-arriving
     * photo still dedupes but a chat switch always rebuilds. */
    const reuse = host.dataset.guardChat === key ? host.firstElementChild : null
    const next = guardAvatar(chat, reuse)
    if (next !== host.firstElementChild) host.replaceChildren(next)
    host.dataset.guardChat = key
  }

  function guardRenderChats () {
    const list = document.querySelector('#chat-list')
    const search = document.querySelector('#chat-search')
    const only = document.querySelector('#channels-only')
    if (!list || !search || !only) return
    const query = String(search.value || '').trim().toLowerCase()
    const channelsOnly = !!only.checked
    const chats = (state.chats || []).filter(Boolean).slice().sort((a, b) => {
      const aa = guardChatOrder(a)
      const bb = guardChatOrder(b)
      return aa === bb ? 0 : (aa < bb ? 1 : -1)
    })

    const existing = new Map([...list.querySelectorAll('.chat-item[data-chat-id]')].map(row => [guardKey(row.dataset.chatId), row]))
    const live = new Set()
    let shown = 0

    for (const chat of chats) {
      const key = guardKey(chat.id)
      live.add(key)
      let row = existing.get(key)
      if (!row) {
        row = document.createElement('li')
        row.className = 'chat-item'
        row.dataset.chatId = key
      }

      row.classList.toggle('active', key === guardKey(state.activeChatId))
      const visible = (!channelsOnly || chat.kind === 'channel') && (!query || String(chat.title || '').toLowerCase().includes(query) || String(chat.username || '').toLowerCase().includes(query))
      row.hidden = !visible
      if (visible) shown++

      const oldAvatar = row.querySelector('.chat-avatar')
      const avatar = guardAvatar(chat, oldAvatar)
      if (oldAvatar !== avatar) {
        if (oldAvatar) oldAvatar.replaceWith(avatar)
        else row.prepend(avatar)
      }

      let col = row.querySelector('.col')
      if (!col) { col = document.createElement('div'); col.className = 'col'; row.appendChild(col) }
      let title = col.querySelector('.t')
      if (!title) { title = document.createElement('div'); title.className = 't'; col.appendChild(title) }
      const nextTitle = chat.title || 'Unknown'
      if (title.textContent !== nextTitle) title.textContent = nextTitle

      const nextPreview = guardPreviewText(chat)
      let preview = col.querySelector('.preview')
      if (nextPreview) {
        if (!preview) { preview = document.createElement('div'); preview.className = 'preview'; col.appendChild(preview) }
        if (preview.textContent !== nextPreview) preview.textContent = nextPreview
        preview.title = nextPreview
      } else if (preview) preview.remove()

      let meta = row.querySelector('.u')
      if (!meta) { meta = document.createElement('div'); meta.className = 'u'; row.appendChild(meta) }
      const nextMeta = `${typeIcon[chat.kind] || '💬'}${Number(chat.unread || 0) > 0 ? ` · ${chat.unread}` : ''}`
      if (meta.textContent !== nextMeta) meta.textContent = nextMeta
      row.onclick = () => openChat(chat.id)
      list.appendChild(row)
    }

    for (const [key, row] of existing) if (!live.has(key)) row.remove()
    const count = document.querySelector('#chat-count')
    if (count) count.textContent = channelsOnly ? `${shown} channels` : `${shown} chats`
  }

  renderChats = guardRenderChats

  function guardRebindFilters () {
    const oldSearch = document.querySelector('#chat-search')
    if (oldSearch && oldSearch.dataset.teleGuard !== '1') {
      const next = oldSearch.cloneNode(true)
      next.value = oldSearch.value
      next.dataset.teleGuard = '1'
      oldSearch.replaceWith(next)
      next.addEventListener('input', guardRenderChats)
      next.addEventListener('search', guardRenderChats)
    }
    const oldOnly = document.querySelector('#channels-only')
    if (oldOnly && oldOnly.dataset.teleGuard !== '1') {
      const next = oldOnly.cloneNode(true)
      next.checked = oldOnly.checked
      next.dataset.teleGuard = '1'
      oldOnly.replaceWith(next)
      next.addEventListener('change', () => {
        try { localStorage.setItem('tele-channels-only', next.checked ? '1' : '0') } catch {}
        guardRepaintChats()
      })
    }
  }

  function guardUpsertChat (chat) {
    if (!chat || chat.id == null) return
    if (chat.lastMessage && chat.lastMessage._ === 'messageText') chat.lastText = chat.lastMessage.text && chat.lastMessage.text.text ? chat.lastMessage.text.text : ''
    const index = state.chats.findIndex(current => guardKey(current.id) === guardKey(chat.id))
    if (index >= 0) state.chats[index] = { ...state.chats[index], ...chat }
    else state.chats.unshift(chat)
    state.chats.sort((a, b) => {
      const aa = guardChatOrder(a)
      const bb = guardChatOrder(b)
      return aa === bb ? 0 : (aa < bb ? 1 : -1)
    })
    if (state.activeChatId != null && guardKey(state.activeChatId) === guardKey(chat.id)) {
      const title = document.querySelector('#chat-title')
      if (title && chat.title) title.textContent = chat.title
      // A chat's photo often arrives after it was opened, so refresh the header
      // here too rather than only on open.
      guardPaintHeaderAvatar()
    }
    guardRepaintChats()
  }

  handleEvent = function teleFinalGuardHandleEvent (event) {
    /* `media-index-progress` is not handled here any more, and the event is no longer
     * swallowed. This branch repainted the count from the shared cache and returned
     * WITHOUT calling the base chain, so it was one of the layers competing to own the
     * progress stream. `public/files-stability.js` is the sole owner of that event now:
     * it batches the batches (PROGRESS_FLUSH_MS 350, PROGRESS_FLUSH_ITEMS 800), commits
     * through `commitDiscovery`, and repaints from the committed index. Its wrapper is
     * installed later in the load order than this one, so the event never reaches this
     * function in the first place. */
    if (event && event.name === 'chat-upsert') {
      guardUpsertChat(event.chat)
      return
    }
    if (event && event.name === 'chat-remove') {
      removeChat(event.chatId)
      guardRepaintChats()
      return
    }
    return guardBaseHandleEvent(event)
  }

  openChat = async function teleGuardOpenChat (chatId) {
    const result = await guardBaseOpenChat(chatId)
    // Only counts as read if the messages are actually on screen.
    if (state.view === 'messages') guardMarkChatRead(chatId)
    guardRepaintChats()
    // The count label is repainted by its owner (files-stability.js), through the
    // symbol this layer used to overwrite.
    if (typeof updateMediaCountLabel === 'function') updateMediaCountLabel()
    guardPaintHeaderAvatar()
    return result
  }

  /* Reading is tied to SEEING the messages, not merely to opening the chat.
   * Opening straight into the Files tab shows no message, so the chat stays
   * unread; switching to Messages is what marks it read and drops it out of the
   * Unread filter. */
  const guardBaseSetView = setView
  setView = function teleGuardSetView (view) {
    const result = guardBaseSetView(view)
    if (view === 'messages' && state.activeChatId != null) guardMarkChatRead(state.activeChatId)
    return result
  }

  guardRebindFilters()
  guardRenderChats()
  guardPaintHeaderAvatar()
})()
