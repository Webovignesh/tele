'use strict'

/* Final daily-driver reliability layer.
 * Owns the high-risk surfaces that accumulated competing legacy listeners:
 * chat/file cache presentation, Files rendering/preview, chat search/avatar
 * rendering, and the download dedupe confirmation report.
 */

;(function teleFinalRuntime () {
  const teleFinalSyncs = new Map()
  const teleFinalSyncState = new Map()
  const teleFinalPartial = new Map()
  const teleFinalLastSync = new Map()
  const teleFinalAvatarRetries = new Map()
  const teleFinalThumbTargets = new WeakMap()
  const teleFinalPage = { key: '', limit: 240 }
  const TELE_FINAL_PAGE_SIZE = 240
  const TELE_FINAL_SYNC_TTL = 120000

  function teleFinalKey (value) { return String(value) }

  function teleFinalValidSnapshot (chatId, snapshot) {
    if (!snapshot || !Array.isArray(snapshot.items)) return false
    const wanted = teleFinalKey(chatId)
    return snapshot.items.every(item => item && teleFinalKey(item.chatId) === wanted)
  }

  function teleFinalSortItems (items) {
    return items.sort((a, b) => {
      const aa = BigInt(String((a && a.messageId) || 0))
      const bb = BigInt(String((b && b.messageId) || 0))
      return aa === bb ? 0 : (aa < bb ? 1 : -1)
    })
  }

  function teleFinalNormalizeSnapshot (chatId, source) {
    const key = teleFinalKey(chatId)
    const items = teleFinalSortItems(((source && source.items) || [])
      .filter(item => item && teleFinalKey(item.chatId) === key)
      .map(item => ({ ...item, chatId })))
    return {
      chatId,
      items,
      found: items.length,
      scanned: Number((source && source.scanned) || 0),
      typeCounts: (source && source.typeCounts) || {},
      savedAt: Number((source && source.savedAt) || Date.now()),
      done: source ? source.done !== false : true
    }
  }

  function teleFinalSnapshot (chatId) {
    const snapshot = rescueFileCache.get(teleFinalKey(chatId))
    return teleFinalValidSnapshot(chatId, snapshot) ? snapshot : null
  }

  function teleFinalSyncInfo (chatId) {
    return teleFinalSyncState.get(teleFinalKey(chatId)) || { active: false, partialFound: 0, scanned: 0 }
  }

  function teleFinalApplySnapshot (chatId, source, options = {}) {
    const snapshot = teleFinalNormalizeSnapshot(chatId, source)
    if (!teleFinalValidSnapshot(chatId, snapshot)) return null
    const key = teleFinalKey(chatId)
    rescueFileCache.set(key, snapshot)
    try { teleHotfixValidatedChats.add(key) } catch {}
    state.mediaCount = snapshot.items.length
    state.typeCounts = snapshot.typeCounts || null

    if (options.persist !== false && snapshot.done) {
      try { teleP0v2WriteIndex(chatId, snapshot).catch(() => {}) } catch {}
    }

    if (state.activeChatId != null && teleFinalKey(state.activeChatId) === key) {
      teleFinalUpdateMediaCountLabel()
      if (state.view === 'files' && options.render !== false) {
        try { renderFiles() } catch {}
      }
      if (options.status) setLoadState(options.status)
    }
    return snapshot
  }

  async function teleFinalRestorePersistent (chatId) {
    const memory = teleFinalSnapshot(chatId)
    if (memory && memory.done !== false) return memory
    try {
      const disk = await teleP0v2ReadIndex(chatId)
      if (!teleFinalValidSnapshot(chatId, disk) || disk.done === false) return null
      return teleFinalApplySnapshot(chatId, disk, { persist: false, render: false })
    } catch {
      return null
    }
  }

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
    const sync = teleFinalSyncInfo(chatId)
    if (snapshot) {
      const count = snapshot.items.length
      if (label) label.textContent = `${count.toLocaleString()} file${count === 1 ? '' : 's'}${sync.active ? ' · syncing' : ''}`
      if (downloadAll) { downloadAll.textContent = `Download all media (${count.toLocaleString()})`; downloadAll.disabled = count === 0 }
      if (selectAll) { selectAll.textContent = `Select all (${count.toLocaleString()})`; selectAll.disabled = count === 0 }
      return
    }

    if (label) label.textContent = sync.active ? 'Indexing files…' : (state.view === 'files' ? 'Loading files…' : '')
    if (downloadAll) { downloadAll.textContent = 'Download all media'; downloadAll.disabled = true }
    if (selectAll) { selectAll.textContent = 'Select all'; selectAll.disabled = true }
  }

  rescueUpdateMediaLabel = teleFinalUpdateMediaCountLabel
  updateMediaCountLabel = teleFinalUpdateMediaCountLabel

  function teleFinalMergePartial (payload) {
    if (!payload || payload.chatId == null) return
    const chatId = payload.chatId
    const key = teleFinalKey(chatId)
    const stable = teleFinalSnapshot(chatId)
    const sync = teleFinalSyncInfo(chatId)
    sync.active = !payload.done
    sync.partialFound = Number(payload.found || sync.partialFound || 0)
    sync.scanned = Number(payload.scanned || sync.scanned || 0)
    teleFinalSyncState.set(key, sync)

    // A completed cache is authoritative while reconciliation runs. Never let
    // 100-message scan batches replace its count or rows.
    if (stable) {
      if (state.activeChatId != null && teleFinalKey(state.activeChatId) === key) {
        teleFinalUpdateMediaCountLabel()
        if (state.view === 'files' && sync.active) setLoadState(`Cached ${stable.items.length.toLocaleString()} files · syncing in background`)
      }
      return
    }

    let partial = teleFinalPartial.get(key)
    if (!partial) partial = { chatId, items: [], scanned: 0, typeCounts: {}, done: false }
    const byMessage = new Map(partial.items.map(item => [teleFinalKey(item.messageId), item]))
    for (const item of payload.items || []) {
      if (!item || teleFinalKey(item.chatId) !== key) continue
      byMessage.set(teleFinalKey(item.messageId), item)
    }
    partial.items = teleFinalSortItems([...byMessage.values()])
    partial.scanned = Number(payload.scanned || partial.scanned || 0)
    partial.typeCounts = payload.typeCounts || partial.typeCounts || {}
    partial.done = false
    teleFinalPartial.set(key, partial)

    if (state.activeChatId != null && teleFinalKey(state.activeChatId) === key && state.view === 'files') {
      rescueFileCache.set(key, partial)
      state.mediaCount = null
      teleFinalUpdateMediaCountLabel()
      if (!teleFinalMergePartial.paintTimer) {
        teleFinalMergePartial.paintTimer = setTimeout(() => {
          teleFinalMergePartial.paintTimer = null
          if (state.activeChatId != null && teleFinalKey(state.activeChatId) === key && state.view === 'files') {
            try { renderFiles() } catch {}
            setLoadState(`Indexing files… ${partial.items.length.toLocaleString()} found`)
          }
        }, 260)
      }
    }
  }

  async function teleFinalEnsureFiles (chatId, options = {}) {
    if (chatId == null) return null
    const key = teleFinalKey(chatId)
    let stable = teleFinalSnapshot(chatId) || await teleFinalRestorePersistent(chatId)
    if (stable && state.activeChatId != null && teleFinalKey(state.activeChatId) === key && state.view === 'files') {
      teleFinalApplySnapshot(chatId, stable, { persist: false, status: `Cached ${stable.items.length.toLocaleString()} files` })
    }

    const lastSync = teleFinalLastSync.get(key) || 0
    const shouldSync = options.force || !stable || Date.now() - lastSync > TELE_FINAL_SYNC_TTL
    if (!shouldSync) return stable
    if (teleFinalSyncs.has(key)) return stable || teleFinalSyncs.get(key)

    const sync = teleFinalSyncInfo(chatId)
    sync.active = true
    sync.partialFound = 0
    sync.scanned = 0
    teleFinalSyncState.set(key, sync)
    teleFinalUpdateMediaCountLabel()

    const run = (async () => {
      let lastError = null
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const data = await request('scan-media-v3', { chatId, force: !!options.force && attempt === 0 })
          const next = teleFinalNormalizeSnapshot(chatId, data || {})
          // A zero-message response immediately after reconnect is not allowed
          // to erase a known complete cache. Keep the cache and retry later.
          if (stable && stable.items.length && next.items.length === 0 && next.scanned === 0) {
            throw new Error('Telegram returned an empty transient media index')
          }
          next.done = true
          stable = teleFinalApplySnapshot(chatId, next, {
            persist: true,
            status: `Loaded ${next.items.length.toLocaleString()} files`
          })
          teleFinalPartial.delete(key)
          teleFinalLastSync.set(key, Date.now())
          return stable
        } catch (error) {
          lastError = error
          if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 850))
        }
      }
      if (!stable && state.activeChatId != null && teleFinalKey(state.activeChatId) === key && state.view === 'files') {
        setLoadState('Files could not sync. Reopen Files to retry.')
      }
      return stable || Promise.reject(lastError || new Error('Files could not sync'))
    })().finally(() => {
      teleFinalSyncs.delete(key)
      const current = teleFinalSyncInfo(chatId)
      current.active = false
      teleFinalSyncState.set(key, current)
      teleFinalUpdateMediaCountLabel()
      if (state.activeChatId != null && teleFinalKey(state.activeChatId) === key && state.view === 'files') {
        const finalSnapshot = teleFinalSnapshot(chatId)
        if (finalSnapshot) setLoadState(`Loaded ${finalSnapshot.items.length.toLocaleString()} files`)
      }
    })

    teleFinalSyncs.set(key, run)
    return stable || run
  }

  rescueEnsureAllFiles = teleFinalEnsureFiles

  function teleFinalPatchRealtimeMedia (event) {
    if (!event) return
    if (event.name === 'message-upsert') {
      const payload = event.payload || event
      const chatId = payload.chatId
      const message = payload.message
      if (chatId == null || !message) return
      const snapshot = teleFinalSnapshot(chatId)
      if (!snapshot) return
      const id = teleFinalKey(message.id)
      const byMessage = new Map(snapshot.items.map(item => [teleFinalKey(item.messageId), item]))
      if (message.media && message.media.fileId) {
        const media = message.media
        byMessage.set(id, {
          ...media,
          key: `${chatId}:${message.id}`,
          chatId,
          messageId: message.id,
          date: message.date || media.date || 0,
          fileId: media.fileId || (media.file && media.file.id),
          fileSize: media.fileSize || (media.file && (media.file.size || media.file.expected_size)) || 0
        })
      } else {
        byMessage.delete(id)
      }
      snapshot.items = teleFinalSortItems([...byMessage.values()])
      snapshot.found = snapshot.items.length
      snapshot.savedAt = Date.now()
      snapshot.done = true
      teleFinalApplySnapshot(chatId, snapshot, { persist: true, render: state.view === 'files' })
    }

    if (event.name === 'message-delete') {
      const payload = event.payload || event
      const chatId = payload.chatId
      const ids = new Set((payload.messageIds || []).map(teleFinalKey))
      const snapshot = teleFinalSnapshot(chatId)
      if (!snapshot || !ids.size) return
      snapshot.items = snapshot.items.filter(item => !ids.has(teleFinalKey(item.messageId)))
      snapshot.found = snapshot.items.length
      snapshot.savedAt = Date.now()
      teleFinalApplySnapshot(chatId, snapshot, { persist: true, render: state.view === 'files' })
    }
  }

  const teleFinalBaseHandleEvent = handleEvent
  handleEvent = function teleFinalHandleEvent (event) {
    if (event && event.name === 'media-index-progress') {
      teleFinalMergePartial(event.payload || {})
      return
    }
    const result = teleFinalBaseHandleEvent(event)
    if (event && (event.name === 'message-upsert' || event.name === 'message-delete')) teleFinalPatchRealtimeMedia(event)
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

  function teleFinalViewKey (items) {
    return [state.activeChatId, state.files.mode, state.files.query, state.files.filter, state.files.sort, items.length].join('|')
  }

  function teleFinalResetFileWindow () {
    teleFinalPage.key = ''
    teleFinalPage.limit = TELE_FINAL_PAGE_SIZE
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

  function teleFinalRenderFiles () {
    const grid = document.querySelector('#media-grid')
    if (!grid) return
    const items = filesItems()
    const key = teleFinalViewKey(items)
    if (teleFinalPage.key !== key) {
      teleFinalPage.key = key
      teleFinalPage.limit = TELE_FINAL_PAGE_SIZE
    }
    const limit = Math.min(items.length, teleFinalPage.limit)
    const scrollTop = grid.scrollTop
    grid.innerHTML = ''
    for (let i = 0; i < limit; i++) grid.appendChild(teleFinalBuildGridCard(items[i]))
    if (items.length > limit) {
      const status = document.createElement('div')
      status.className = 'tele-final-list-status'
      status.textContent = `Showing ${limit.toLocaleString()} of ${items.length.toLocaleString()} · scroll for more`
      grid.appendChild(status)
    }
    grid.scrollTop = scrollTop

    const selectAll = document.querySelector('#select-all-media')
    if (selectAll) {
      selectAll.textContent = items.length ? `Select all (${items.length.toLocaleString()})` : 'Select all'
      selectAll.disabled = items.length === 0
    }
  }

  renderFiles = teleFinalRenderFiles

  const teleFinalGrid = document.querySelector('#media-grid')
  if (teleFinalGrid && !teleFinalGrid.dataset.teleFinalScroll) {
    teleFinalGrid.dataset.teleFinalScroll = '1'
    teleFinalGrid.addEventListener('scroll', () => {
      if (teleFinalGrid.scrollTop + teleFinalGrid.clientHeight < teleFinalGrid.scrollHeight - 900) return
      const items = filesItems()
      if (teleFinalPage.limit >= items.length) return
      teleFinalPage.limit = Math.min(items.length, teleFinalPage.limit + TELE_FINAL_PAGE_SIZE)
      teleFinalRenderFiles()
    }, { passive: true })
  }

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

  const teleFinalBaseOpenChat = openChat
  openChat = async function teleFinalOpenChat (chatId) {
    await teleFinalRestorePersistent(chatId)
    const result = await teleFinalBaseOpenChat(chatId)
    if (state.activeChatId != null && teleFinalKey(state.activeChatId) === teleFinalKey(chatId)) {
      const snapshot = teleFinalSnapshot(chatId)
      if (snapshot) teleFinalApplySnapshot(chatId, snapshot, { persist: false, render: state.view === 'files' })
      teleFinalUpdateMediaCountLabel()
      // Paint through the current renderFiles owner. teleFinalRenderFiles mounts
      // a growing 240-row window and restores the previous scrollTop, which
      // fought pagination and left the grid scrollable well past its 100 rows.
      if (state.view === 'files') { try { renderFiles() } catch {} }
      teleFinalEnsureFiles(chatId).catch(() => {})
    }
    return result
  }

  const teleFinalBaseSetView = setView
  setView = function teleFinalSetView (view) {
    const result = teleFinalBaseSetView(view)
    if (view === 'files' && state.activeChatId != null) {
      if (teleFinalSnapshot(state.activeChatId)) { try { renderFiles() } catch {} }
      teleFinalUpdateMediaCountLabel()
      teleFinalEnsureFiles(state.activeChatId).catch(() => {})
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
    for (const [label, value] of [
      ['Selected', selectedCount], ['Already there', existingCount], ['Repeated selection', repeatedCount], ['Will download', uniqueCount]
    ]) {
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

  // Final paint after every script has installed its wrappers.
  queueMicrotask(() => {
    teleFinalRebindChatFilters()
    teleFinalRenderChats()
    teleFinalUpdateMediaCountLabel()
    if (state.activeChatId != null && state.view === 'files') teleFinalEnsureFiles(state.activeChatId).catch(() => {})
  })
})()
