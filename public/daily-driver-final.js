'use strict'

/* Final daily-driver reliability layer.
 * Owns the high-risk surfaces that accumulated competing legacy listeners:
 * chat/file cache presentation, Files rendering/preview, chat search/avatar
 * rendering, and the download dedupe confirmation report.
 */

;(function teleFinalRuntime () {
  const teleFinalAvatarRetries = new Map()
  const teleFinalThumbTargets = new WeakMap()

  /* `teleFinalSyncs`, `teleFinalSyncState`, `teleFinalPartial`, `teleFinalLastSync`,
   * `TELE_FINAL_SYNC_TTL`, `teleFinalNormalizeSnapshot`, `teleFinalSortItems` and
   * `teleFinalSyncInfo` went with the index code below: they were the bookkeeping for
   * this layer's own scan lifecycle, and it no longer runs scans. `teleFinalSnapshot`
   * stays as a READER of the shared cache for the renderer and the count label - the
   * owner writes that cache so legacy readers see the committed index. */
  function teleFinalKey (value) { return String(value) }

  function teleFinalValidSnapshot (chatId, snapshot) {
    if (!snapshot || !Array.isArray(snapshot.items)) return false
    const wanted = teleFinalKey(chatId)
    return snapshot.items.every(item => item && teleFinalKey(item.chatId) === wanted)
  }

  function teleFinalSnapshot (chatId) {
    const snapshot = rescueFileCache.get(teleFinalKey(chatId))
    return teleFinalValidSnapshot(chatId, snapshot) ? snapshot : null
  }

  /* THE OTHER END OF THE RE-INFLATION CHAIN WAS HERE.
   *
   * `teleFinalApplySnapshot` and `teleFinalRestorePersistent` are gone, and with them
   * `teleFinalMergePartial` (the partial paint path), `teleFinalEnsureFiles`,
   * `teleFinalPatchRealtimeMedia` and the `openChat` restore hook.
   *
   * Measured on the running application after the owner had already reconciled chat
   * TEST to zero and written a zero-item record:
   *
   *   teleFinalEnsureFiles (daily-driver-final.js:199)
   *     -> request('scan-media-v3')  ->  guardStableMediaScan substitutes the stale 22
   *     -> teleFinalApplySnapshot
   *          :64  rescueFileCache.set(key, stale 22)
   *          :66  state.mediaCount = 22
   *          :70  teleP0v2WriteIndex(chatId, stale 22)   <- record 0 -> 22, and the
   *               monotonic guard ALLOWED it because growth was never the case it
   *               refused
   *          :74  teleFinalUpdateMediaCountLabel()       <- header back to "22 files"
   *
   * So the owner pruned, this layer un-pruned, and the user saw 22 either way. Both
   * ends of that chain had to go, and both have. The guard's interception is deleted
   * in daily-driver-final-guard.js; this is the consumer that turned its answer into a
   * durable write.
   *
   * It also wrote the LEGACY record shape, which silently dropped `reconciledAt`,
   * `truthCount` and `removedIds` from the stored row, so the durable half of the
   * removal record survived only until the next legacy write.
   *
   * What replaces it: `public/files-stability.js` restores through `ensure` ->
   * `restore`, commits discoveries through `commitDiscovery` (additive) and removals
   * through `commitAuthoritative` (truth pass only), and persists through its own
   * unconditional boundary. Restore-without-rescan still short-circuits in `ensure`
   * (clause 3.4) and a partial scan still cannot replace a larger index (clause 3.2).
   *
   * Kept in this file: the Files renderer helpers, `buildGridCard`, the preview modal,
   * thumbnails, the chat list, the dedupe report - none of which own index state. */
  function teleFinalUpdateMediaCountLabel () {
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

    const snapshot = teleFinalSnapshot(chatId)
    if (snapshot) {
      const count = snapshot.items.length
      if (label) label.textContent = `${count.toLocaleString()} file${count === 1 ? '' : 's'}`
      if (downloadAll) { downloadAll.textContent = `Download all media (${count.toLocaleString()})`; downloadAll.disabled = count === 0 }
      if (selectAll) { selectAll.textContent = `Select all (${count.toLocaleString()})`; selectAll.disabled = count === 0 }
      return
    }

    if (label) label.textContent = state.view === 'files' ? 'Loading files…' : ''
    if (downloadAll) { downloadAll.textContent = 'Download all media'; downloadAll.disabled = true }
    if (selectAll) { selectAll.textContent = 'Select all'; selectAll.disabled = true }
  }

  rescueUpdateMediaLabel = teleFinalUpdateMediaCountLabel
  updateMediaCountLabel = teleFinalUpdateMediaCountLabel

  const teleFinalBaseHandleEvent = handleEvent
  handleEvent = function teleFinalHandleEvent (event) {
    /* `media-index-progress`, `message-upsert` and `message-delete` no longer touch the
     * index here.
     *
     * The progress branch ran `teleFinalMergePartial`, which wrote partial scan
     * snapshots into `rescueFileCache` and returned without calling the base chain, so
     * it both competed for the progress stream and swallowed the event for everyone
     * below it. `teleFinalPatchRealtimeMedia` mutated the shared snapshot in place on
     * every upsert and delete and persisted the result. Both are the owner's job now:
     * `files-stability.js` merges progress (batched), merges upserts through
     * `mergeRealtimeUpsert` (which will not re-add a removed id) and handles
     * `message-delete` in `handleRealtimeDelete`, gated on `isPermanent` so a TDLib
     * local-cache eviction is not mistaken for a deletion.
     *
     * The chat-list repaint stays: it owns no index state. */
    const result = teleFinalBaseHandleEvent(event)
    if (event && ['chat-upsert', 'chat-remove'].includes(event.name)) queueMicrotask(teleFinalRenderChats)
    return result
  }

  /* ------------------------------ Files renderer ------------------------------ */

  filesItems = function teleFinalFilesItems () {
    let list
    if (state.files.mode === 'search') {
      list = Array.isArray(state.files.results) ? state.files.results.slice() : []
    } else {
      const snapshot = state.activeChatId == null ? null : teleFinalSnapshot(state.activeChatId)
      list = snapshot ? snapshot.items.slice() : []
    }
    const q = String(state.files.query || '').trim().toLowerCase()
    if (q) list = list.filter(item => String(item.name || '').toLowerCase().includes(q) || String(item.caption || '').toLowerCase().includes(q))
    if (state.files.filter !== 'all') list = list.filter(item => item.type === state.files.filter)
    const compareIds = (a, b) => {
      const aa = BigInt(String((a && a.messageId) || 0))
      const bb = BigInt(String((b && b.messageId) || 0))
      return aa === bb ? 0 : (aa < bb ? -1 : 1)
    }
    switch (state.files.sort) {
      case 'oldest': list.sort(compareIds); break
      case 'name': list.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))); break
      case 'size': list.sort((a, b) => Number(b.fileSize || 0) - Number(a.fileSize || 0)); break
      default: list.sort((a, b) => compareIds(b, a))
    }
    return list
  }

  function teleFinalMediaUrl (item, fileId) {
    const id = fileId == null ? item.fileId : fileId
    const params = new URLSearchParams()
    params.set('name', fileId == null ? String(item.name || 'file') : 'thumb.jpg')
    params.set('mime', fileId == null ? String(item.mime || 'application/octet-stream') : 'image/jpeg')
    if (fileId == null && item.chatId != null) params.set('chatId', String(item.chatId))
    if (fileId == null && item.messageId != null) params.set('messageId', String(item.messageId))
    return `/api/media-preview/${encodeURIComponent(String(id || 0))}?${params.toString()}`
  }

  const teleFinalThumbObserver = 'IntersectionObserver' in window
    ? new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          teleFinalThumbObserver.unobserve(entry.target)
          const data = teleFinalThumbTargets.get(entry.target)
          if (!data) continue
          data.img.src = teleFinalMediaUrl(data.item, data.item.thumbFileId)
        }
      }, { root: document.querySelector('#media-grid'), rootMargin: '900px 0px', threshold: 0.01 })
    : null

  loadThumb = function teleFinalLoadThumb (img, item) {
    if (!img || !item || !item.thumbFileId) return
    img.loading = 'lazy'
    img.decoding = 'async'
    img.onload = () => {
      img.classList.remove('hidden')
      const icon = img.parentElement && img.parentElement.querySelector('.icon')
      if (icon) icon.classList.add('hidden')
    }
    img.onerror = () => { img.removeAttribute('src') }
    const host = img.closest('.gthumb') || img
    if (teleFinalThumbObserver) {
      teleFinalThumbTargets.set(host, { img, item })
      teleFinalThumbObserver.observe(host)
    } else {
      img.src = teleFinalMediaUrl(item, item.thumbFileId)
    }
  }

  function teleFinalBuildGridCard (item) {
    const key = `${item.chatId}:${item.messageId}`
    itemByKey.set(key, item)
    const card = document.createElement('div')
    card.className = 'gcard tele-final-file-card'
    card.dataset.key = key
    card._item = item
    if (isCompleted(key)) card.classList.add('completed')
    if (state.selection.has(key)) card.classList.add('selected')

    const thumb = document.createElement('button')
    thumb.type = 'button'
    thumb.className = 'gthumb tele-final-file-thumb'
    thumb.title = ['video', 'video_note'].includes(item.type) ? 'Open video' : 'Open preview'
    const icon = document.createElement('div')
    icon.className = 'icon'
    icon.textContent = mediaIcon[item.type] || '📎'
    const img = document.createElement('img')
    img.className = 'hidden'
    img.alt = ''
    thumb.append(icon, img)
    if (['video', 'video_note'].includes(item.type)) {
      const play = document.createElement('span')
      play.className = 'tele-final-play'
      play.textContent = '▶'
      thumb.appendChild(play)
    }
    thumb.onclick = event => {
      event.stopPropagation()
      teleFinalOpenPreview(item)
    }
    card.appendChild(thumb)

    const body = document.createElement('div')
    body.className = 'gbody'
    const name = document.createElement('div')
    name.className = 'gname'
    name.textContent = item.name || 'file'
    name.title = item.name || 'file'
    const meta = document.createElement('div')
    meta.className = 'gsize'
    meta.textContent = fmtSize(Number(item.fileSize || 0))
    if (item.date) meta.textContent += ` · ${fmtDate(item.date)}`
    body.append(name, meta)
    const statuses = document.createElement('div')
    statuses.className = 'file-statuses'
    if (rescueDownloadedMarks.has(key)) {
      const mark = document.createElement('span')
      mark.className = 'file-status downloaded'
      mark.textContent = 'Downloaded'
      statuses.appendChild(mark)
    }
    if (rescueForwardedMarks.has(key)) {
      const mark = document.createElement('span')
      mark.className = 'file-status forwarded'
      mark.textContent = 'Forwarded'
      statuses.appendChild(mark)
    }
    if (statuses.children.length) body.appendChild(statuses)
    card.appendChild(body)

    const type = document.createElement('div')
    type.className = 'gtype'
    type.textContent = String(item.type || 'file').replace('_', ' ')
    card.appendChild(type)

    const cb = makeCheckbox(item)
    cb.addEventListener('click', event => event.stopPropagation())
    card.appendChild(cb)
    loadThumb(img, item)

    card.onclick = event => {
      if (event.target.closest('button,input,a,select')) return
      const selected = state.selection.has(key)
      if (event.shiftKey && lastClickedKey) {
        const all = filesItems()
        const a = all.findIndex(row => `${row.chatId}:${row.messageId}` === lastClickedKey)
        const b = all.findIndex(row => `${row.chatId}:${row.messageId}` === key)
        if (a >= 0 && b >= 0) {
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
            const row = all[i]
            state.selection.set(`${row.chatId}:${row.messageId}`, row)
          }
          try { renderFiles() } catch {}
          updateSelectionBar()
          return
        }
      }
      if (selected) state.selection.delete(key)
      else state.selection.set(key, item)
      lastClickedKey = key
      card.classList.toggle('selected', !selected)
      cb.checked = !selected
      updateSelectionBar()
    }
    return card
  }

  buildGridCard = teleFinalBuildGridCard

  /* The 240-row grow-on-scroll files renderer that used to live here is gone,
   * along with its scroll listener. It mounted 240 rows and restored the previous
   * scrollTop, which made the grid taller than the page and fought the pager.
   * files-view.js owns renderFiles and mounts exactly one 100-row page.
   * teleFinalBuildGridCard is kept: it is still the buildGridCard owner and
   * files-view.js builds its cards through it. */

  /* ------------------------------ Unified popup preview ------------------------------ */

  function teleFinalPreviewModal () {
    let modal = document.querySelector('#tele-final-preview')
    if (modal) return modal
    modal = document.createElement('div')
    modal.id = 'tele-final-preview'
    modal.className = 'tele-final-preview hidden'
    modal.innerHTML = `<div class="tele-final-preview-shell" role="dialog" aria-modal="true">
      <header><div><strong id="tele-final-preview-title">Media</strong><span id="tele-final-preview-meta"></span></div><button type="button" id="tele-final-preview-close" class="ghost small" aria-label="Close">×</button></header>
      <main id="tele-final-preview-body"></main>
    </div>`
    document.body.appendChild(modal)
    const close = () => {
      modal.classList.add('hidden')
      const body = modal.querySelector('#tele-final-preview-body')
      body.querySelectorAll('video,audio').forEach(media => {
        try { media.pause() } catch {}
        media.removeAttribute('src')
        try { media.load() } catch {}
      })
      body.innerHTML = ''
    }
    modal.querySelector('#tele-final-preview-close').onclick = close
    modal.addEventListener('mousedown', event => { if (event.target === modal) close() })
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && !modal.classList.contains('hidden')) close() })
    return modal
  }

  async function teleFinalOpenPreview (item) {
    if (!item || !item.fileId) return toast('This Telegram file is not available yet', 'error')
    const modal = teleFinalPreviewModal()
    const body = modal.querySelector('#tele-final-preview-body')
    modal.querySelector('#tele-final-preview-title').textContent = item.name || 'Media'
    modal.querySelector('#tele-final-preview-meta').textContent = `${String(item.type || 'file').replace('_', ' ')} · ${fmtSize(Number(item.fileSize || 0))}`
    modal.classList.remove('hidden')
    body.innerHTML = '<div class="tele-final-preview-state">Preparing preview…</div>'

    const thumbUrl = item.thumbFileId ? teleFinalMediaUrl(item, item.thumbFileId) : null
    const mediaUrl = teleFinalMediaUrl(item)

    if (['photo', 'gif', 'sticker'].includes(item.type)) {
      if (thumbUrl) {
        const thumb = new Image()
        thumb.className = 'tele-final-preview-image is-thumb'
        thumb.alt = item.name || ''
        thumb.src = thumbUrl
        body.innerHTML = ''
        body.appendChild(thumb)
      }
      const image = new Image()
      image.className = 'tele-final-preview-image'
      image.alt = item.name || ''
      image.onload = () => {
        if (modal.classList.contains('hidden')) return
        body.innerHTML = ''
        body.appendChild(image)
      }
      image.onerror = () => {
        if (!thumbUrl) body.innerHTML = '<div class="tele-final-preview-state">Image preview failed. Download the original to open it.</div>'
      }
      image.src = mediaUrl
      return
    }

    if (item.type === 'video' || item.type === 'video_note') {
      const video = document.createElement('video')
      video.className = 'tele-final-preview-video'
      video.controls = true
      video.playsInline = true
      video.preload = 'metadata'
      if (thumbUrl) video.poster = thumbUrl
      const status = document.createElement('div')
      status.className = 'tele-final-preview-status'
      status.textContent = 'Preparing video…'
      const shell = document.createElement('div')
      shell.className = 'tele-final-video-shell'
      shell.append(video, status)
      body.innerHTML = ''
      body.appendChild(shell)
      video.addEventListener('canplay', () => {
        status.remove()
        video.play().catch(() => {})
      }, { once: true })
      video.addEventListener('error', () => {
        status.textContent = 'This video codec could not be played in Chrome. Download the original to open it.'
      })
      video.src = mediaUrl
      video.load()
      return
    }

    if (item.type === 'audio' || item.type === 'voice') {
      const audio = document.createElement('audio')
      audio.className = 'tele-final-preview-audio'
      audio.controls = true
      audio.autoplay = true
      audio.preload = 'metadata'
      body.innerHTML = ''
      body.appendChild(audio)
      audio.src = mediaUrl
      return
    }

    body.innerHTML = '<div class="tele-final-preview-state">This file type has no browser preview. Use Download selected.</div>'
  }

  rescuePreviewFile = teleFinalOpenPreview

  /* ------------------------------ Stable chat list + avatars ------------------------------ */

  function teleFinalChatOrder (chat) {
    try { return BigInt(String((chat && chat.order) || 0)) } catch { return 0n }
  }

  function teleFinalPreviewText (chat) {
    if (chat.username) return '@' + chat.username
    if (chat.lastText) return chat.lastText
    const content = chat.lastMessage
    if (!content || !content._) return ''
    if (content._ === 'messageText') return content.text && content.text.text ? content.text.text : ''
    return ({
      messagePhoto: 'Photo', messageVideo: 'Video', messageDocument: 'Document', messageAudio: 'Audio',
      messageVoiceNote: 'Voice message', messageAnimation: 'GIF', messageSticker: 'Sticker'
    })[content._] || ''
  }

  function teleFinalAvatar (chat) {
    const avatar = document.createElement('div')
    avatar.className = 'chat-avatar tele-final-avatar'
    avatar.style.background = avatarColor(chat.title || '')
    const fallback = document.createElement('span')
    fallback.className = 'tele-final-avatar-fallback'
    fallback.textContent = initials(chat.title || 'Chat')
    avatar.appendChild(fallback)

    const fileId = Number(chat.photoFileId || 0)
    if (!fileId) return avatar
    const image = new Image()
    image.className = 'tele-final-avatar-image'
    image.alt = ''
    image.loading = 'lazy'
    image.decoding = 'async'
    const load = () => {
      const retry = teleFinalAvatarRetries.get(fileId) || 0
      image.src = `/api/media-preview/${encodeURIComponent(String(fileId))}?name=avatar.jpg&mime=image%2Fjpeg&retry=${retry}`
    }
    image.onload = () => fallback.classList.add('hidden')
    image.onerror = () => {
      const count = teleFinalAvatarRetries.get(fileId) || 0
      if (count < 2) {
        teleFinalAvatarRetries.set(fileId, count + 1)
        setTimeout(load, 500 * (count + 1))
      } else {
        image.remove()
        fallback.classList.remove('hidden')
      }
    }
    avatar.appendChild(image)
    load()
    return avatar
  }

  function teleFinalRenderChats () {
    const list = document.querySelector('#chat-list')
    const search = document.querySelector('#chat-search')
    const only = document.querySelector('#channels-only')
    if (!list || !search || !only) return
    const query = String(search.value || '').trim().toLowerCase()
    const channelsOnly = !!only.checked
    const chats = (state.chats || []).filter(Boolean).slice().sort((a, b) => {
      const aa = teleFinalChatOrder(a)
      const bb = teleFinalChatOrder(b)
      return aa === bb ? 0 : (aa < bb ? 1 : -1)
    })
    const fragment = document.createDocumentFragment()
    let shown = 0
    for (const chat of chats) {
      if (channelsOnly && chat.kind !== 'channel') continue
      if (query && !String(chat.title || '').toLowerCase().includes(query) && !String(chat.username || '').toLowerCase().includes(query)) continue
      shown++
      const li = document.createElement('li')
      li.className = 'chat-item' + (teleFinalKey(chat.id) === teleFinalKey(state.activeChatId) ? ' active' : '')
      li.dataset.chatId = String(chat.id)
      li.appendChild(teleFinalAvatar(chat))
      const col = document.createElement('div')
      col.className = 'col'
      const title = document.createElement('div')
      title.className = 't'
      title.textContent = chat.title || 'Unknown'
      col.appendChild(title)
      const text = teleFinalPreviewText(chat)
      if (text) {
        const preview = document.createElement('div')
        preview.className = 'preview'
        preview.textContent = text
        preview.title = text
        col.appendChild(preview)
      }
      li.appendChild(col)
      const meta = document.createElement('div')
      meta.className = 'u'
      meta.textContent = typeIcon[chat.kind] || '💬'
      if (Number(chat.unread || 0) > 0) meta.textContent += ` · ${chat.unread}`
      li.appendChild(meta)
      li.onclick = () => openChat(chat.id)
      fragment.appendChild(li)
    }
    list.replaceChildren(fragment)
    const count = document.querySelector('#chat-count')
    if (count) count.textContent = channelsOnly ? `${shown} channels` : `${shown} chats`
  }

  renderChats = teleFinalRenderChats

  function teleFinalRebindChatFilters () {
    const oldSearch = document.querySelector('#chat-search')
    if (oldSearch && oldSearch.dataset.teleFinal !== '1') {
      const next = oldSearch.cloneNode(true)
      next.value = oldSearch.value
      next.dataset.teleFinal = '1'
      oldSearch.replaceWith(next)
      next.addEventListener('input', teleFinalRenderChats)
      next.addEventListener('search', teleFinalRenderChats)
    }
    const oldOnly = document.querySelector('#channels-only')
    if (oldOnly && oldOnly.dataset.teleFinal !== '1') {
      const next = oldOnly.cloneNode(true)
      next.checked = oldOnly.checked
      next.dataset.teleFinal = '1'
      oldOnly.replaceWith(next)
      next.addEventListener('change', () => {
        try { localStorage.setItem('tele-channels-only', next.checked ? '1' : '0') } catch {}
        teleFinalRenderChats()
      })
    }
  }

  teleFinalRebindChatFilters()
  teleFinalRenderChats()

  /* ------------------------------ Open/view ownership ------------------------------ */

  /* The `openChat` index restore hook is gone. It awaited `teleFinalRestorePersistent`
   * BEFORE the base chain, so this layer read the IndexedDB record and pushed it into
   * the shared cache ahead of the owner - one of the several independent restores that
   * let a single surviving stale copy repopulate everything (six shared-cache writes of
   * the stale 22 were recorded on a single chat open in Phase 0). Restoring is
   * `files-stability.js` `ensure` -> `restore`, and its own `openChat` wrapper schedules
   * the truth pass.
   *
   * Both wrappers keep only what they own: repainting through the CURRENT renderFiles
   * owner (files-view.js, which is paged) and the count label through its owner. */
  const teleFinalBaseOpenChat = openChat
  openChat = async function teleFinalOpenChat (chatId) {
    const result = await teleFinalBaseOpenChat(chatId)
    if (state.activeChatId != null && teleFinalKey(state.activeChatId) === teleFinalKey(chatId)) {
      if (typeof updateMediaCountLabel === 'function') updateMediaCountLabel()
      if (state.view === 'files') { try { renderFiles() } catch {} }
    }
    return result
  }

  const teleFinalBaseSetView = setView
  setView = function teleFinalSetView (view) {
    const result = teleFinalBaseSetView(view)
    if (view === 'files' && state.activeChatId != null) {
      if (typeof updateMediaCountLabel === 'function') updateMediaCountLabel()
      try { renderFiles() } catch {}
    }
    return result
  }

  /* ------------------------------ Dedupe confirmation ------------------------------ */

  function teleFinalFinishDedupe (modal, value) {
    modal.classList.add('hidden')
    const resolve = teleP1DedupeResolve
    teleP1DedupeResolve = null
    if (resolve) resolve(value)
  }

  teleP1ShowDedupeScanning = function teleFinalShowDedupeScanning (count) {
    const modal = teleP1EnsureDedupeModal()
    modal.classList.remove('hidden')
    modal.querySelector('#tele-dedupe-subtitle').textContent = `Checking ${count.toLocaleString()} selected file${count === 1 ? '' : 's'} before download`
    modal.querySelector('#tele-dedupe-body').innerHTML = `<div class="tele-dedupe-scanning"><span class="tele-dedupe-spinner"></span><div><strong>Scanning download folder</strong><span>Duplicates require an exact filename and exact byte-size match.</span></div></div>`
    const button = modal.querySelector('#tele-dedupe-continue')
    button.disabled = true
    button.textContent = 'Checking…'
    return modal
  }

  teleP1RenderDedupeReport = function teleFinalRenderDedupeReport (report) {
    const modal = teleP1EnsureDedupeModal()
    modal.classList.remove('hidden')
    const duplicates = Array.isArray(report.duplicates) ? report.duplicates : []
    const selectedCount = Number(report.selectedCount || 0)
    const duplicateCount = Number(report.duplicateCount || duplicates.length)
    const uniqueCount = Number(report.uniqueCount || 0)
    const existingCount = duplicates.filter(row => row.reason === 'existing').length
    const repeatedCount = Math.max(0, duplicateCount - existingCount)
    // Selected but already finished earlier in this browser, so not on disk under a
    // matching name yet still not worth fetching again.
    const completedCount = Number(report.completedCount || 0)

    modal.querySelector('#tele-dedupe-subtitle').textContent = duplicateCount
      ? `${duplicateCount.toLocaleString()} duplicate${duplicateCount === 1 ? '' : 's'} found · ${uniqueCount.toLocaleString()} ready to download`
      : `No duplicates found · ${uniqueCount.toLocaleString()} ready to download`

    const body = modal.querySelector('#tele-dedupe-body')
    body.innerHTML = ''
    const pathCard = document.createElement('div')
    pathCard.className = 'tele-dedupe-path'
    pathCard.innerHTML = '<span>Scanned path</span><strong></strong>'
    pathCard.querySelector('strong').textContent = report.rootPath || 'Downloads'
    body.appendChild(pathCard)

    const stats = document.createElement('div')
    stats.className = 'tele-dedupe-stats'
    /* Every selected file lands in exactly one bucket, so these add up to Selected.
     * That invariant is what makes the numbers checkable:
     * selected = on disk + marked done + repeated + will download.
     *
     * The labels name the EVIDENCE, not the outcome. "Already there" next to
     * "Already downloaded" read as two words for the same thing, because both only
     * said the file would be skipped and neither said how that was established. */
    const tiles = [
      ['Selected', selectedCount],
      // A matching file is physically in the destination folder.
      ['On disk', existingCount]
    ]
    // Exceptional, so only shown when it applies: this app's own completed list
    // says the file was fetched, but nothing matching it is in the folder now.
    if (completedCount) tiles.push(['Marked done', completedCount])
    // The same file chosen twice in one selection.
    if (repeatedCount) tiles.push(['Repeated in selection', repeatedCount])
    tiles.push(['Will download', uniqueCount])
    for (const [label, value] of tiles) {
      const card = document.createElement('div')
      card.className = 'tele-dedupe-stat'
      const name = document.createElement('span')
      name.textContent = label
      const number = document.createElement('strong')
      number.textContent = Number(value).toLocaleString()
      card.append(name, number)
      stats.appendChild(card)
    }
    body.appendChild(stats)

    /* "Marked done" is the one bucket whose meaning is not self-evident, so it is
     * spelled out rather than left to the label. Its own element, because the
     * validation line below is rewritten by a later layer. */
    if (completedCount) {
      const legend = document.createElement('div')
      legend.className = 'tele-dedupe-legend'
      legend.textContent = `Marked done: ${completedCount.toLocaleString()} of these were downloaded before, but no matching file is in this folder now. They are skipped; use Unmark to fetch them again.`
      body.appendChild(legend)
    }

    const validation = document.createElement('div')
    validation.className = 'tele-dedupe-validation'
    validation.innerHTML = '<span class="tele-dedupe-check">✓</span><div><strong>Exact filename + exact byte size</strong><span></span></div>'
    validation.querySelector('div span').textContent = `${Number(report.scannedFiles || 0).toLocaleString()} files scanned · ${fmtSize(Number(report.duplicateBytes || 0))} skipped`
    body.appendChild(validation)

    if (duplicates.length) {
      const title = document.createElement('div')
      title.className = 'tele-dedupe-list-title'
      title.textContent = `Duplicates (${duplicates.length.toLocaleString()})`
      body.appendChild(title)
      const list = document.createElement('div')
      list.className = 'tele-dedupe-list tele-final-dedupe-list'
      body.appendChild(list)
      let rendered = 0
      const append = () => {
        const end = Math.min(duplicates.length, rendered + 250)
        const fragment = document.createDocumentFragment()
        for (; rendered < end; rendered++) {
          const row = duplicates[rendered]
          const entry = document.createElement('div')
          entry.className = 'tele-dedupe-row'
          const left = document.createElement('div')
          left.className = 'tele-dedupe-row-main'
          const name = document.createElement('strong')
          name.textContent = row.fileName || 'file'
          const detail = document.createElement('span')
          detail.textContent = row.reason === 'existing'
            ? `${fmtSize(Number(row.fileSize || 0))} · ${row.relativePath || 'already in download folder'}`
            : `${fmtSize(Number(row.fileSize || 0))} · repeated in selection`
          left.append(name, detail)
          const badge = document.createElement('span')
          badge.className = `tele-dedupe-badge ${row.reason === 'existing' ? 'existing' : 'selection'}`
          badge.textContent = row.reason === 'existing' ? 'On disk' : 'Repeated'
          entry.append(left, badge)
          fragment.appendChild(entry)
        }
        list.appendChild(fragment)
      }
      append()
      list.addEventListener('scroll', () => {
        if (list.scrollTop + list.clientHeight >= list.scrollHeight - 600 && rendered < duplicates.length) append()
      }, { passive: true })
    }

    const cancel = modal.querySelector('#tele-dedupe-cancel')
    const proceed = modal.querySelector('#tele-dedupe-continue')
    cancel.textContent = 'Cancel'
    proceed.disabled = false
    proceed.textContent = uniqueCount ? `Continue with ${uniqueCount.toLocaleString()}` : 'Done'

    return new Promise(resolve => {
      teleP1DedupeResolve = resolve
      proceed.onclick = () => {
        modal.classList.add('hidden')
        teleP1DedupeResolve = null
        resolve(uniqueCount > 0)
      }
      cancel.onclick = () => teleFinalFinishDedupe(modal, false)
    })
  }

  // Final paint after every script has installed its wrappers. The index is not
  // hydrated from here any more; the owner's own queueMicrotask does that.
  queueMicrotask(() => {
    teleFinalRebindChatFilters()
    teleFinalRenderChats()
    if (typeof updateMediaCountLabel === 'function') updateMediaCountLabel()
  })
})()
