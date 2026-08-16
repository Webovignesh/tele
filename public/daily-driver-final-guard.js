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
  const guardBaseRequest = request
  const guardBaseHandleEvent = handleEvent
  const guardBaseSetLoadState = setLoadState
  const guardBaseOpenChat = openChat
  const guardScanFlights = new Map()
  const guardAvatarRetries = new Map()
  const GUARD_HIGH_WATER_KEY = 'tele-file-index-high-water-v1'
  const GUARD_MAX_SCAN_ROUNDS = 5

  let guardHighWater = {}
  try { guardHighWater = JSON.parse(localStorage.getItem(GUARD_HIGH_WATER_KEY) || '{}') || {} } catch { guardHighWater = {} }

  function guardKey (value) { return String(value) }

  function guardIsCompleteSnapshot (chatId, snapshot) {
    if (!snapshot || snapshot.done === false || !Array.isArray(snapshot.items)) return false
    const key = guardKey(chatId)
    return snapshot.items.every(item => item && guardKey(item.chatId) === key)
  }

  function guardMemorySnapshot (chatId) {
    const snapshot = rescueFileCache.get(guardKey(chatId))
    return guardIsCompleteSnapshot(chatId, snapshot) ? snapshot : null
  }

  function guardRememberHighWater (chatId, count) {
    const key = guardKey(chatId)
    const value = Math.max(0, Number(count || 0))
    const current = guardHighWater[key] && Number(guardHighWater[key].count || 0)
    if (value <= current) return
    guardHighWater[key] = { count: value, at: Date.now() }
    try { localStorage.setItem(GUARD_HIGH_WATER_KEY, JSON.stringify(guardHighWater)) } catch {}
  }

  function guardHighWaterCount (chatId) {
    const entry = guardHighWater[guardKey(chatId)]
    if (!entry) return 0
    const age = Date.now() - Number(entry.at || 0)
    // High-water protection is for transient scan collapse, not permanent
    // historical truth. Let very old values expire naturally.
    if (age > 14 * 24 * 60 * 60 * 1000) return 0
    return Math.max(0, Number(entry.count || 0))
  }

  async function guardBestKnownSnapshot (chatId) {
    let best = guardMemorySnapshot(chatId)
    try {
      const disk = await teleP0v2ReadIndex(chatId)
      if (guardIsCompleteSnapshot(chatId, disk) && (!best || disk.items.length > best.items.length)) best = disk
    } catch {}
    if (best) guardRememberHighWater(chatId, best.items.length)
    return best
  }

  function guardScanShape (result) {
    return {
      count: Array.isArray(result && result.items) ? result.items.length : Number(result && result.found || 0),
      scanned: Number(result && result.scanned || 0),
      done: !result || result.done !== false,
      fromCache: !!(result && result.fromCache)
    }
  }

  function guardSnapshotAsResponse (snapshot) {
    return {
      found: snapshot.items.length,
      scanned: Number(snapshot.scanned || 0),
      typeCounts: snapshot.typeCounts || {},
      items: snapshot.items.map(item => ({ ...item })),
      cancelled: false,
      done: true,
      fromCache: true,
      protectedByClientCache: true
    }
  }

  async function guardStableMediaScan (payload) {
    const chatId = payload && payload.chatId
    if (chatId == null) return guardBaseRequest('scan-media-v3', payload)
    const key = guardKey(chatId)
    if (guardScanFlights.has(key)) return guardScanFlights.get(key)

    const flight = (async () => {
      const known = await guardBestKnownSnapshot(chatId)
      const floor = Math.max(known ? known.items.length : 0, guardHighWaterCount(chatId))
      let best = null
      let bestShape = { count: 0, scanned: 0 }
      let previousShape = null

      for (let round = 0; round < GUARD_MAX_SCAN_ROUNDS; round++) {
        const result = await guardBaseRequest('scan-media-v3', {
          ...payload,
          // A second pass must bypass a possibly-short in-memory server index.
          force: round === 0 ? !!payload.force : true
        })
        const shape = guardScanShape(result)
        if (!shape.done) continue

        if (!best || shape.count > bestShape.count || (shape.count === bestShape.count && shape.scanned > bestShape.scanned)) {
          best = result
          bestShape = shape
        }
        if (shape.count) guardRememberHighWater(chatId, shape.count)

        const belowKnownFloor = floor > 0 && shape.count < floor
        const firstPassNeedsVerification = round === 0 && (
          belowKnownFloor ||
          shape.fromCache ||
          (shape.count < 5000 && shape.scanned < 5000)
        )

        if (!firstPassNeedsVerification && round === 0) return result

        if (round > 0 && !belowKnownFloor) {
          const improved = previousShape && (shape.count > previousShape.count || shape.scanned > previousShape.scanned)
          // Once a forced pass stops growing, it is stable. Large completed
          // passes are also accepted immediately so 20k+ channels are not rescanned.
          if (!improved || shape.count >= 5000 || shape.scanned >= 5000) return best || result
        }

        previousShape = shape
        if (round < GUARD_MAX_SCAN_ROUNDS - 1) {
          await new Promise(resolve => setTimeout(resolve, 650 + round * 350))
        }
      }

      // Never let a transient 9/51/1000-item scan destroy a previously complete
      // per-chat index. The next background reconciliation can try again.
      if (known && (!best || bestShape.count < floor)) return guardSnapshotAsResponse(known)
      return best || guardSnapshotAsResponse(known || { items: [], scanned: 0, typeCounts: {} })
    })().finally(() => guardScanFlights.delete(key))

    guardScanFlights.set(key, flight)
    return flight
  }

  request = function teleGuardRequest (type, payload = {}) {
    if (type === 'scan-media-v3') return guardStableMediaScan(payload)
    return guardBaseRequest(type, payload)
  }

  /* ------------------------------ Stable Files presentation ------------------------------ */

  function guardUpdateMediaLabel () {
    const chatId = state.activeChatId
    const label = document.querySelector('#chat-media-count')
    const downloadAll = document.querySelector('#download-all-media')
    const selectAll = document.querySelector('#select-all-media')
    if (chatId == null) {
      if (label) label.textContent = ''
      if (downloadAll) { downloadAll.textContent = 'Download all media'; downloadAll.disabled = true }
      if (selectAll) { selectAll.textContent = 'Select all'; selectAll.disabled = true }
      return
    }

    const snapshot = guardMemorySnapshot(chatId)
    if (!snapshot) {
      if (label) label.textContent = state.view === 'files' ? 'Indexing files…' : ''
      if (downloadAll) { downloadAll.textContent = 'Download all media'; downloadAll.disabled = true }
      if (selectAll) { selectAll.textContent = 'Select all'; selectAll.disabled = true }
      return
    }

    const count = snapshot.items.length
    guardRememberHighWater(chatId, count)
    if (label) label.textContent = `${count.toLocaleString()} file${count === 1 ? '' : 's'}`
    if (downloadAll) { downloadAll.textContent = `Download all media (${count.toLocaleString()})`; downloadAll.disabled = count === 0 }
    if (selectAll) { selectAll.textContent = `Select all (${count.toLocaleString()})`; selectAll.disabled = count === 0 }
  }

  updateMediaCountLabel = guardUpdateMediaLabel
  rescueUpdateMediaLabel = guardUpdateMediaLabel

  setLoadState = function teleGuardSetLoadState (text) {
    if (state.view !== 'files') return guardBaseSetLoadState(text)
    const value = String(text || '')
    if (/failed|could not|error/i.test(value)) return guardBaseSetLoadState(value)
    if (guardMemorySnapshot(state.activeChatId)) return guardBaseSetLoadState('')
    return guardBaseSetLoadState('Indexing files…')
  }

  const mediaLabel = document.querySelector('#chat-media-count')
  if (mediaLabel) {
    new MutationObserver(() => {
      if (/syncing|refreshing|counting/i.test(mediaLabel.textContent || '')) guardUpdateMediaLabel()
    }).observe(mediaLabel, { childList: true, characterData: true, subtree: true })
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
  function guardMarkChatRead (chatId) {
    const chat = guardChatById(chatId)
    if (!chat || Number(chat.unread || 0) <= 0) return
    Promise.resolve(request('mark-read', { chatId })).catch(() => {})
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
    if (event && event.name === 'media-index-progress') {
      const payload = event.payload || {}
      if (state.activeChatId != null && guardKey(payload.chatId) === guardKey(state.activeChatId) && state.view === 'files') {
        guardUpdateMediaLabel()
        setLoadState(guardMemorySnapshot(state.activeChatId) ? '' : 'Indexing files…')
      }
      return
    }
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
    guardMarkChatRead(chatId)
    guardRepaintChats()
    guardUpdateMediaLabel()
    guardPaintHeaderAvatar()
    return result
  }

  guardRebindFilters()
  guardRenderChats()
  guardUpdateMediaLabel()
  guardPaintHeaderAvatar()
})()
