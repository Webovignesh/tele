'use strict'

/* Final UI/runtime ownership pass.
 * Loaded last. Owns chat rows, the canonical per-chat file index, dedupe
 * confirmation normalization, and download rendering/actions.
 *
 * It does NOT render the Files list: files-view.js owns renderFiles and paints
 * exactly one 100-row page. The virtual renderer that used to live here is gone.
 */
;(function teleFinalUiFix () {
  const iconSvg = {
    channel: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11v2a2 2 0 0 0 2 2h2l4 3V6L8 9H6a2 2 0 0 0-2 2Z"/><path d="M16 9a4 4 0 0 1 0 6"/></svg>',
    group: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"/><path d="M2.5 21a6.5 6.5 0 0 1 13 0"/><path d="M17 11a3 3 0 1 0 0-6"/><path d="M18 14a5 5 0 0 1 3.5 4.8"/></svg>',
    supergroup: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"/><path d="M2.5 21a6.5 6.5 0 0 1 13 0"/><path d="M17 11a3 3 0 1 0 0-6"/><path d="M18 14a5 5 0 0 1 3.5 4.8"/></svg>',
    private: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4.5 21a7.5 7.5 0 0 1 15 0"/></svg>',
    other: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-5 4v-4.8A2.5 2.5 0 0 1 4 13.5v-8Z"/></svg>'
  }

  function key (value) { return String(value) }
  function chatOrder (chat) {
    try { return BigInt(String((chat && chat.order) || 0)) } catch { return 0n }
  }
  function previewText (chat) {
    if (chat.username) return '@' + chat.username
    if (chat.lastText) return chat.lastText
    const content = chat.lastMessage
    if (!content || !content._) return ''
    if (content._ === 'messageText') return content.text && content.text.text ? content.text.text : ''
    return ({ messagePhoto: 'Photo', messageVideo: 'Video', messageDocument: 'Document', messageAudio: 'Audio', messageVoiceNote: 'Voice message', messageAnimation: 'GIF', messageSticker: 'Sticker', messageVideoNote: 'Video message' })[content._] || ''
  }

  const avatarRetries = new Map()
  function buildAvatar (chat, current) {
    const photoFileId = Number(chat.photoFileId || 0)
    const signature = String(photoFileId || 0)
    if (current && current.dataset.teleUiPhoto === signature) return current
    const avatar = document.createElement('div')
    avatar.className = 'chat-avatar tele-final-avatar tele-ui-avatar'
    avatar.dataset.teleUiPhoto = signature
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
      const retry = avatarRetries.get(photoFileId) || 0
      image.src = `/api/media-preview/${encodeURIComponent(String(photoFileId))}?name=avatar.jpg&mime=image%2Fjpeg&retry=${retry}`
    }
    image.onload = () => fallback.classList.add('hidden')
    image.onerror = () => {
      const retries = avatarRetries.get(photoFileId) || 0
      if (retries < 2) {
        avatarRetries.set(photoFileId, retries + 1)
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

  function renderChatMeta (meta, chat) {
    const unread = Math.max(0, Number(chat.unread || 0))
    const kind = iconSvg[chat.kind] ? chat.kind : 'other'
    const signature = `${kind}:${unread}`
    if (meta.dataset.teleUiSignature === signature) return
    meta.dataset.teleUiSignature = signature
    meta.className = 'u tele-ui-chat-meta'
    const title = kind === 'channel' ? 'Channel' : kind === 'private' ? 'Private chat' : (kind === 'group' || kind === 'supergroup') ? 'Group' : 'Chat'
    meta.innerHTML = `<span class="tele-ui-kind-icon tele-ui-kind-${kind}" title="${title}">${iconSvg[kind]}</span>${unread ? `<span class="tele-ui-unread">${unread.toLocaleString()}</span>` : ''}`
  }

  function teleUiRenderChats () {
    const list = document.querySelector('#chat-list')
    const search = document.querySelector('#chat-search')
    const only = document.querySelector('#channels-only')
    if (!list || !search || !only) return
    const query = String(search.value || '').trim().toLowerCase()
    const channelsOnly = !!only.checked
    const chats = (state.chats || []).filter(Boolean).slice().sort((a, b) => {
      const aa = chatOrder(a)
      const bb = chatOrder(b)
      return aa === bb ? 0 : (aa < bb ? 1 : -1)
    })
    const existing = new Map([...list.querySelectorAll('.chat-item[data-chat-id]')].map(row => [key(row.dataset.chatId), row]))
    const live = new Set()
    let shown = 0
    for (const chat of chats) {
      const id = key(chat.id)
      live.add(id)
      let row = existing.get(id)
      if (!row) {
        row = document.createElement('li')
        row.className = 'chat-item'
        row.dataset.chatId = id
      }
      row.classList.toggle('active', id === key(state.activeChatId))
      const visible = (!channelsOnly || chat.kind === 'channel') && (!query || String(chat.title || '').toLowerCase().includes(query) || String(chat.username || '').toLowerCase().includes(query))
      row.hidden = !visible
      if (visible) shown++
      const oldAvatar = row.querySelector('.chat-avatar')
      const avatar = buildAvatar(chat, oldAvatar)
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
      const nextPreview = previewText(chat)
      let preview = col.querySelector('.preview')
      if (nextPreview) {
        if (!preview) { preview = document.createElement('div'); preview.className = 'preview'; col.appendChild(preview) }
        if (preview.textContent !== nextPreview) preview.textContent = nextPreview
        preview.title = nextPreview
      } else if (preview) preview.remove()
      let meta = row.querySelector('.u')
      if (!meta) { meta = document.createElement('div'); row.appendChild(meta) }
      renderChatMeta(meta, chat)
      row.onclick = () => openChat(chat.id)
      list.appendChild(row)
    }
    for (const [id, row] of existing) if (!live.has(id)) row.remove()
    const count = document.querySelector('#chat-count')
    if (count) count.textContent = channelsOnly ? `${shown} channels` : `${shown} chats`
  }
  renderChats = teleUiRenderChats

  function rebindChatFilters () {
    const oldSearch = document.querySelector('#chat-search')
    if (oldSearch && oldSearch.dataset.teleUiOwner !== '1') {
      const next = oldSearch.cloneNode(true)
      next.value = oldSearch.value
      next.dataset.teleUiOwner = '1'
      oldSearch.replaceWith(next)
      next.addEventListener('input', teleUiRenderChats)
      next.addEventListener('search', teleUiRenderChats)
    }
    const oldOnly = document.querySelector('#channels-only')
    if (oldOnly && oldOnly.dataset.teleUiOwner !== '1') {
      const next = oldOnly.cloneNode(true)
      next.checked = oldOnly.checked
      next.dataset.teleUiOwner = '1'
      oldOnly.replaceWith(next)
      next.addEventListener('change', () => {
        try { localStorage.setItem('tele-channels-only', next.checked ? '1' : '0') } catch {}
        teleUiRenderChats()
      })
    }
  }

  const canonicalIndexes = new Map()
  const indexLoads = new Map()
  const scanBatches = new Map()
  const lastFullSync = new Map()
  const FILE_SYNC_TTL = 5 * 60 * 1000

  function validIndex (chatId, snapshot) {
    if (!snapshot || !Array.isArray(snapshot.items)) return false
    const wanted = key(chatId)
    return snapshot.items.every(item => item && key(item.chatId) === wanted)
  }

  function sortIndexItems (items) {
    return items.sort((a, b) => {
      let aa = 0n; let bb = 0n
      try { aa = BigInt(String((a && a.messageId) || 0)) } catch {}
      try { bb = BigInt(String((b && b.messageId) || 0)) } catch {}
      return aa === bb ? 0 : (aa < bb ? 1 : -1)
    })
  }

  function normalizeIndex (chatId, snapshot) {
    const wanted = key(chatId)
    const byId = new Map()
    for (const item of (snapshot && snapshot.items) || []) {
      if (!item || key(item.chatId) !== wanted) continue
      byId.set(key(item.messageId), { ...item, chatId })
    }
    const items = sortIndexItems([...byId.values()])
    const typeCounts = {}
    for (const item of items) typeCounts[item.type] = (typeCounts[item.type] || 0) + 1
    return { chatId, items, found: items.length, scanned: Math.max(Number(snapshot && snapshot.scanned || 0), items.length), typeCounts, savedAt: Number(snapshot && snapshot.savedAt || Date.now()), done: true }
  }

  function mergeIndexes (chatId, ...sources) {
    const wanted = key(chatId)
    const byId = new Map()
    let scanned = 0
    let savedAt = 0
    for (const source of sources) {
      if (!validIndex(chatId, source)) continue
      scanned = Math.max(scanned, Number(source.scanned || 0))
      savedAt = Math.max(savedAt, Number(source.savedAt || 0))
      for (const item of source.items) {
        if (!item || key(item.chatId) !== wanted) continue
        byId.set(key(item.messageId), { ...item, chatId })
      }
    }
    return normalizeIndex(chatId, { items: [...byId.values()], scanned, savedAt: savedAt || Date.now() })
  }

  function currentCanonical (chatId) {
    const id = key(chatId)
    const owned = canonicalIndexes.get(id)
    const rescue = rescueFileCache && rescueFileCache.get ? rescueFileCache.get(id) : null
    if (owned && rescue && validIndex(chatId, rescue) && rescue.items.length > owned.items.length) {
      const merged = mergeIndexes(chatId, owned, rescue)
      canonicalIndexes.set(id, merged)
      return merged
    }
    return owned || (validIndex(chatId, rescue) ? normalizeIndex(chatId, rescue) : null)
  }

  function paintCanonical (chatId, snapshot, options = {}) {
    if (!validIndex(chatId, snapshot)) return null
    const id = key(chatId)
    const previous = currentCanonical(chatId)
    const next = previous ? mergeIndexes(chatId, previous, snapshot) : normalizeIndex(chatId, snapshot)
    canonicalIndexes.set(id, next)
    rescueFileCache.set(id, next)
    try { teleHotfixValidatedChats.add(id) } catch {}
    if (state.activeChatId != null && key(state.activeChatId) === id) {
      state.mediaCount = next.items.length
      state.typeCounts = next.typeCounts
      updateCanonicalCount()
      if (state.view === 'files' && options.render !== false) renderFiles()
    }
    if (options.persist !== false && typeof teleP0v2WriteIndex === 'function') Promise.resolve(teleP0v2WriteIndex(chatId, next)).catch(() => {})
    return next
  }

  async function restoreCanonical (chatId) {
    if (chatId == null) return null
    let best = currentCanonical(chatId)
    if (typeof teleP0v2ReadIndex === 'function') {
      const disk = await teleP0v2ReadIndex(chatId).catch(() => null)
      if (validIndex(chatId, disk)) best = best ? mergeIndexes(chatId, best, disk) : normalizeIndex(chatId, disk)
    }
    if (best) paintCanonical(chatId, best, { persist: false, render: false })
    return best
  }

  async function robustEnsureFiles (chatId, options = {}) {
    if (chatId == null) return null
    const id = key(chatId)
    if (indexLoads.has(id)) return indexLoads.get(id)
    const work = (async () => {
      let stable = await restoreCanonical(chatId)
      if (stable && state.activeChatId != null && key(state.activeChatId) === id && state.view === 'files') {
        updateCanonicalCount()
        renderFiles()
        setLoadState(`Cached ${stable.items.length.toLocaleString()} files · checking for updates`)
      }
      const shouldSync = options.force || !stable || Date.now() - (lastFullSync.get(id) || 0) > FILE_SYNC_TTL
      if (!shouldSync) return stable
      try {
        const fresh = await request('scan-media-v3', { chatId, force: !!stable || !!options.force })
        if (fresh && fresh.done !== false && validIndex(chatId, fresh)) {
          stable = paintCanonical(chatId, stable ? mergeIndexes(chatId, stable, fresh) : fresh, { persist: true })
          lastFullSync.set(id, Date.now())
        }
      } catch (error) {
        if (!stable && state.activeChatId != null && key(state.activeChatId) === id && state.view === 'files') setLoadState('Files could not sync. Reopen Files to retry.')
      }
      if (stable && state.activeChatId != null && key(state.activeChatId) === id && state.view === 'files') setLoadState(`Loaded ${stable.items.length.toLocaleString()} files`)
      return stable
    })().finally(() => indexLoads.delete(id))
    indexLoads.set(id, work)
    return work
  }
  rescueEnsureAllFiles = robustEnsureFiles

  function mergeProgressBatch (payload) {
    if (!payload || payload.chatId == null) return
    const chatId = payload.chatId
    const id = key(chatId)
    let batch = scanBatches.get(id)
    if (!batch) batch = { chatId, items: [], scanned: 0, done: false }
    if (Array.isArray(payload.items) && payload.items.length) batch = mergeIndexes(chatId, batch, { chatId, items: payload.items, scanned: payload.scanned, done: false })
    batch.scanned = Math.max(Number(batch.scanned || 0), Number(payload.scanned || 0))
    batch.done = !!payload.done
    scanBatches.set(id, batch)
    const stable = currentCanonical(chatId)
    if (stable) {
      if (payload.items && payload.items.length) paintCanonical(chatId, mergeIndexes(chatId, stable, batch), { persist: false })
      if (state.activeChatId != null && key(state.activeChatId) === id) {
        updateCanonicalCount()
        if (state.view === 'files') setLoadState(`Cached ${currentCanonical(chatId).items.length.toLocaleString()} files · syncing in background`)
      }
    } else if (batch.items.length) {
      paintCanonical(chatId, batch, { persist: false })
      if (state.activeChatId != null && key(state.activeChatId) === id && state.view === 'files') setLoadState(`Indexing files… ${batch.items.length.toLocaleString()} found`)
    }
    if (payload.done) {
      const final = currentCanonical(chatId)
      if (final && typeof teleP0v2WriteIndex === 'function') Promise.resolve(teleP0v2WriteIndex(chatId, final)).catch(() => {})
      scanBatches.delete(id)
      lastFullSync.set(id, Date.now())
    }
  }

  function updateCanonicalCount () {
    const chatId = state.activeChatId
    const snapshot = chatId == null ? null : currentCanonical(chatId)
    const total = snapshot ? snapshot.items.length : 0
    const label = document.querySelector('#chat-media-count')
    const downloadAll = document.querySelector('#download-all-media')
    if (label) label.textContent = snapshot ? `${total.toLocaleString()} file${total === 1 ? '' : 's'}` : ''
    if (downloadAll) {
      downloadAll.textContent = snapshot ? `Download all media (${total.toLocaleString()})` : 'Download all media'
      downloadAll.disabled = !snapshot || total === 0
    }
  }

  filesItems = function teleUiFilesItems () {
    let list
    if (state.files.mode === 'search') list = Array.isArray(state.files.results) ? state.files.results.slice() : []
    else {
      const snapshot = state.activeChatId == null ? null : currentCanonical(state.activeChatId)
      list = snapshot ? snapshot.items.slice() : []
    }
    const q = String(state.files.query || '').trim().toLowerCase()
    if (q) list = list.filter(item => String(item.name || '').toLowerCase().includes(q) || String(item.caption || '').toLowerCase().includes(q))
    if (state.files.filter !== 'all') list = list.filter(item => item.type === state.files.filter)
    const compareIds = (a, b) => {
      let aa = 0n; let bb = 0n
      try { aa = BigInt(String((a && a.messageId) || 0)) } catch {}
      try { bb = BigInt(String((b && b.messageId) || 0)) } catch {}
      return aa === bb ? 0 : (aa < bb ? -1 : 1)
    }
    if (state.files.sort === 'oldest') list.sort(compareIds)
    else if (state.files.sort === 'name') list.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
    else if (state.files.sort === 'size') list.sort((a, b) => Number(b.fileSize || 0) - Number(a.fileSize || 0))
    else list.sort((a, b) => compareIds(b, a))
    return list
  }

  /* The virtual files renderer that used to live here is gone.
   *
   * It windowed the rows and padded the scroll surface with two spacer divs, the
   * trailing one sized (items.length - end) * rowHeight. On a 22k index that is a
   * ~2 million pixel spacer behind ~20 real rows. Its companion scroll listener,
   * which was supposed to re-window as you scrolled, was bound to the #media-grid
   * node that files-view.js later replaced, so it never ran: scrolling produced
   * blank space that nothing refilled.
   *
   * Files are paged now (files-view.js, 100 per page). Pagination is the
   * scalability mechanism and must not be combined with virtualisation, so this
   * layer no longer renders files at all and no longer touches grid geometry. */

  const baseHandleEvent = handleEvent
  handleEvent = function teleUiHandleEvent (event) {
    if (event && event.name === 'media-index-progress') {
      mergeProgressBatch(event.payload || {})
      return
    }
    if (event && event.name === 'chat-upsert' && event.chat) {
      const chat = event.chat
      if (chat.lastMessage && chat.lastMessage._ === 'messageText') chat.lastText = chat.lastMessage.text && chat.lastMessage.text.text ? chat.lastMessage.text.text : ''
      const index = (state.chats || []).findIndex(current => key(current.id) === key(chat.id))
      if (index >= 0) state.chats[index] = { ...state.chats[index], ...chat }
      else state.chats.unshift(chat)
      if (state.activeChatId != null && key(state.activeChatId) === key(chat.id)) {
        const title = document.querySelector('#chat-title')
        if (title && chat.title) title.textContent = chat.title
      }
      teleUiRenderChats()
      return
    }
    const result = baseHandleEvent(event)
    if (event && event.name === 'chat-remove') teleUiRenderChats()
    if (event && (event.name === 'message-upsert' || event.name === 'message-delete')) {
      const payload = event.payload || event
      const chatId = payload.chatId
      if (chatId != null) {
        const rescue = rescueFileCache.get(key(chatId))
        if (validIndex(chatId, rescue)) paintCanonical(chatId, rescue, { persist: true, render: false })
      }
      // Repaint through the current renderFiles owner (files-view.js, which is
      // paged). Painting here directly used to bypass pagination and mount a
      // window of ~20 rows under a spacer sized for the whole index, which is
      // what let the Files list scroll far past its 100 rows into blank space.
      if (state.view === 'files') queueMicrotask(() => { try { renderFiles() } catch {} })
    }
    return result
  }

  const baseDedupeRender = typeof teleP1RenderDedupeReport === 'function' ? teleP1RenderDedupeReport : null
  if (baseDedupeRender) {
    teleP1RenderDedupeReport = function teleUiRenderDedupeReport (report) {
      const result = baseDedupeRender(report)
      const validation = document.querySelector('#tele-dedupe-body .tele-dedupe-validation')
      if (validation) {
        const check = document.createElement('span')
        check.className = 'tele-dedupe-check tele-ui-dedupe-check'
        check.setAttribute('aria-hidden', 'true')
        check.textContent = '✓'
        const copy = document.createElement('div')
        copy.className = 'tele-ui-dedupe-copy'
        const label = document.createElement('strong')
        label.textContent = 'Exact filename + exact byte size'
        const detail = document.createElement('span')
        detail.className = 'tele-ui-dedupe-detail'
        detail.textContent = `${Number(report.scannedFiles || 0).toLocaleString()} files scanned · ${fmtSize(Number(report.duplicateBytes || 0))} skipped`
        copy.append(label, detail)
        validation.replaceChildren(check, copy)
      }
      return result
    }
  }

  let downloadsTimer = 0
  let lastDownloadsPaint = 0
  const DOWNLOAD_PAINT_MS = 220
  const DOWNLOAD_LIST_LIMIT = 140

  function scheduleDownloads (immediate = false) {
    const now = Date.now()
    if (immediate && now - lastDownloadsPaint > 30) {
      clearTimeout(downloadsTimer)
      downloadsTimer = 0
      renderDownloadsNow()
      return
    }
    if (downloadsTimer) return
    const wait = Math.max(0, DOWNLOAD_PAINT_MS - (now - lastDownloadsPaint))
    downloadsTimer = setTimeout(() => {
      downloadsTimer = 0
      renderDownloadsNow()
    }, wait)
  }

  upsertDownload = function teleUiUpsertDownload (job) {
    state.downloads.set(job.jobId, { ...(state.downloads.get(job.jobId) || {}), ...job })
    scheduleDownloads(false)
  }

  function setJobOptimistic (job, status) {
    job.status = status
    if (status !== 'downloading') state.samples.delete(job.jobId)
  }

  function ensureDownloadSummary () {
    let summary = document.querySelector('#tele-ui-download-summary')
    if (summary) return summary
    const controls = document.querySelector('.dl-controls')
    if (!controls) return null
    summary = document.createElement('div')
    summary.id = 'tele-ui-download-summary'
    summary.className = 'tele-ui-download-summary'
    summary.innerHTML = '<div><span>Speed</span><strong data-stat="speed">0 B/s</strong></div><div><span>Current</span><strong data-stat="current">0</strong></div><div><span>Remaining</span><strong data-stat="remaining">0</strong></div><div><span>Total</span><strong data-stat="total">0</strong></div>'
    controls.prepend(summary)
    return summary
  }

  function updateSummary (values) {
    const summary = ensureDownloadSummary()
    if (!summary) return
    for (const [name, value] of Object.entries(values)) {
      const target = summary.querySelector(`[data-stat="${name}"]`)
      if (target) target.textContent = value
    }
  }

  function sampleSpeed (job, now, downloaded) {
    let sample = state.samples.get(job.jobId)
    if (!sample || Array.isArray(sample)) sample = { time: now, downloaded, speed: 0 }
    const elapsed = (now - sample.time) / 1000
    if (elapsed >= 0.18) {
      const instant = Math.max(0, (downloaded - sample.downloaded) / Math.max(elapsed, 0.001))
      sample.speed = sample.speed ? sample.speed * 0.65 + instant * 0.35 : instant
      sample.time = now
      sample.downloaded = downloaded
    }
    state.samples.set(job.jobId, sample)
    return Number(sample.speed || 0)
  }

  function renderDownloadJob (job, speed) {
    const downloaded = Math.max(0, Number(job.downloaded || 0))
    const fileSize = Math.max(0, Number(job.fileSize || 0))
    const el = h('div', 'djob ' + job.status)
    el.appendChild(h('div', 'name', job.fileName || '…'))
    const sub = h('div', 'sub')
    const statusText = { downloading: speed > 0 ? `● ${fmtSpeed(speed)}` : 'downloading', queued: 'queued', paused: 'paused', done: 'saved', cancelled: 'cancelled', cancelling: 'cancelling…', error: 'failed' }[job.status] || job.status
    sub.appendChild(h('span', '', fileSize ? `${fmtSize(downloaded)} / ${fmtSize(fileSize)}` : fmtSize(downloaded)))
    sub.appendChild(h('span', 'status-tag', statusText))
    el.appendChild(sub)
    const bar = h('div', 'bar')
    const fill = h('div', '')
    fill.style.width = `${fileSize ? Math.min(100, downloaded / fileSize * 100) : 0}%`
    bar.appendChild(fill)
    el.appendChild(bar)
    if (job.status === 'downloading' && speed > 0 && fileSize > downloaded) el.appendChild(h('div', 'sub', `ETA ${fmtEta((fileSize - downloaded) / speed)}`))
    else el.appendChild(h('div', 'sub', ''))
    el.appendChild(h('div', 'error-text', job.error || ''))
    const actions = h('div', 'actions')
    if (job.status === 'downloading' || job.status === 'queued') {
      const pause = h('button', 'ghost small', 'Pause')
      pause.onclick = () => { setJobOptimistic(job, 'paused'); scheduleDownloads(true); request('pause-job', { jobId: job.jobId }).catch(() => {}) }
      actions.appendChild(pause)
    }
    if (job.status === 'paused') {
      const resume = h('button', 'ghost small', 'Resume')
      resume.onclick = () => { setJobOptimistic(job, 'queued'); scheduleDownloads(true); request('resume-job', { jobId: job.jobId }).catch(() => {}) }
      actions.appendChild(resume)
    }
    if (['queued', 'downloading', 'paused'].includes(job.status)) {
      const cancel = h('button', 'ghost small', 'Cancel')
      cancel.onclick = () => { setJobOptimistic(job, 'cancelling'); scheduleDownloads(true); request('cancel-download', { jobId: job.jobId }).catch(() => {}) }
      actions.appendChild(cancel)
    }
    if (job.status === 'done' && job.destPath) {
      const link = h('a', '', 'Open')
      link.href = '/dl' + job.destPath
      link.target = '_blank'
      link.rel = 'noopener'
      actions.appendChild(link)
    }
    if (['done', 'error', 'cancelled'].includes(job.status)) {
      const remove = h('button', 'ghost small', 'Remove')
      remove.onclick = () => { state.downloads.delete(job.jobId); state.samples.delete(job.jobId); scheduleDownloads(true); request('remove-download', { jobId: job.jobId }).catch(() => {}) }
      actions.appendChild(remove)
    }
    el.appendChild(actions)
    return el
  }

  function renderDownloadsNow () {
    lastDownloadsPaint = Date.now()
    const list = document.querySelector('#download-list')
    const stats = document.querySelector('#download-stats')
    if (!list || !stats) return
    const now = Date.now()
    let totalSpeed = 0
    let active = 0
    let queued = 0
    let paused = 0
    let done = 0
    let failed = 0
    let cancelled = 0
    let downloadedBytes = 0
    let expectedBytes = 0
    const display = []
    for (const job of state.downloads.values()) {
      const downloaded = Math.max(0, Number(job.downloaded || 0))
      const fileSize = Math.max(0, Number(job.fileSize || 0))
      downloadedBytes += downloaded
      expectedBytes += fileSize
      let speed = 0
      if (job.status === 'downloading') {
        speed = sampleSpeed(job, now, downloaded)
        active++
        totalSpeed += speed
      } else {
        state.samples.delete(job.jobId)
        if (job.status === 'queued') queued++
        else if (job.status === 'paused') paused++
        else if (job.status === 'done') done++
        else if (job.status === 'error') failed++
        else if (job.status === 'cancelled' || job.status === 'cancelling') cancelled++
      }
      if (display.length < DOWNLOAD_LIST_LIMIT || ['downloading', 'paused', 'error', 'cancelling'].includes(job.status)) display.push({ job, speed })
    }
    display.sort((a, b) => {
      const rank = status => ({ downloading: 0, cancelling: 1, paused: 2, queued: 3, error: 4, done: 5, cancelled: 6 })[status] ?? 7
      return rank(a.job.status) - rank(b.job.status)
    })
    const fragment = document.createDocumentFragment()
    for (const row of display.slice(0, DOWNLOAD_LIST_LIMIT)) fragment.appendChild(renderDownloadJob(row.job, row.speed))
    /* Counters come from the server aggregate over the FULL queue. The loop
     * above only saw state.downloads, which holds the jobs this browser has
     * been told about — with concurrency 8 that is about 8 rows even when the
     * queue holds 20,000, which is why Total used to read 8. Byte totals and
     * live speed stay local because they are sampled per visible job. */
    const queue = state.queueStats
    const total = queue ? Number(queue.total || 0) : state.downloads.size
    const remaining = queue ? Number(queue.remaining || 0) : active + queued + paused
    if (queue) {
      done = Number(queue.done || 0)
      failed = Number(queue.error || 0)
      cancelled = Number(queue.cancelled || 0)
      paused = Number(queue.paused || 0)
      queued = Number(queue.queued || 0)
      active = Number(queue.downloading || 0)
    }
    if (total > display.length) fragment.appendChild(h('div', 'tele-ui-download-list-note', `Showing ${Math.min(display.length, DOWNLOAD_LIST_LIMIT).toLocaleString()} of ${total.toLocaleString()} jobs. Controls and stats apply to the whole queue.`))
    list.replaceChildren(fragment)
    const pct = expectedBytes > 0 ? Math.min(100, downloadedBytes / expectedBytes * 100) : 0
    const eta = totalSpeed > 0 && expectedBytes > downloadedBytes ? fmtEta((expectedBytes - downloadedBytes) / totalSpeed) : ''
    const parts = []
    if (total) parts.push(`${done}/${total} done`)
    if (remaining) parts.push(`${remaining} remaining`)
    if (active) parts.push(`${active} current`)
    if (paused) parts.push(`${paused} paused`)
    if (failed) parts.push(`${failed} failed`)
    if (cancelled) parts.push(`${cancelled} cancelled`)
    if (totalSpeed > 0) parts.push(fmtSpeed(totalSpeed))
    if (expectedBytes > 0) parts.push(`${pct.toFixed(pct >= 10 ? 0 : 1)}%`)
    if (eta) parts.push(`ETA ${eta}`)
    stats.textContent = parts.join(' · ')
    updateSummary({ speed: totalSpeed > 0 ? fmtSpeed(totalSpeed) : '0 B/s', current: active.toLocaleString(), remaining: remaining.toLocaleString(), total: total.toLocaleString() })
  }
  renderDownloads = renderDownloadsNow

  /* Bulk operations are ONE server-wide request each.
   *
   * They used to fan out per-job requests over state.downloads, which is only
   * the set of jobs the server has emitted — a job is first emitted when it
   * starts, so with concurrency 8 a 20,000-file queue looked like 8 jobs and
   * "Cancel all" cancelled 8. The server owns the queue and already exposes
   * whole-queue endpoints, so the correct client behaviour is to call one and
   * then re-sync from the authoritative snapshot. */
  async function applyQueueAction (type, payload = {}) {
    let response = null
    try {
      response = await request(type, payload)
    } catch {
      /* fall through to the resync below so the UI cannot be left optimistic */
    }
    if (response && response.stats) state.queueStats = response.stats
    try {
      const snapshot = await request('get-downloads', {})
      state.downloads.clear()
      state.samples.clear()
      for (const job of snapshot.jobs || []) state.downloads.set(job.jobId, job)
      if (snapshot.stats) state.queueStats = snapshot.stats
    } catch {}
    scheduleDownloads(true)
    return response
  }

  function queueCount (field) {
    if (state.queueStats) return Number(state.queueStats[field] || 0)
    let count = 0
    for (const job of state.downloads.values()) {
      if (field === 'remaining' && ['queued', 'downloading', 'paused'].includes(job.status)) count++
      else if (field === 'total') count++
      else if (job.status === field) count++
    }
    return count
  }

  function replaceButton (selector, handler) {
    const old = document.querySelector(selector)
    if (!old) return null
    const next = old.cloneNode(true)
    old.replaceWith(next)
    next.addEventListener('click', handler)
    return next
  }

  replaceButton('#pause-all', () => {
    for (const job of state.downloads.values()) {
      if (job.status === 'queued' || job.status === 'downloading') setJobOptimistic(job, 'paused')
    }
    scheduleDownloads(true)
    applyQueueAction('pause-all').catch(() => {})
  })
  replaceButton('#resume-all', () => {
    for (const job of state.downloads.values()) {
      if (job.status === 'paused') setJobOptimistic(job, 'queued')
    }
    scheduleDownloads(true)
    applyQueueAction('resume-all').catch(() => {})
  })
  replaceButton('#cancel-all', () => {
    const remaining = queueCount('remaining')
    if (!remaining) return
    if (!confirm(`Cancel all ${remaining.toLocaleString()} unfinished download(s)?`)) return
    for (const job of state.downloads.values()) {
      if (['queued', 'downloading', 'paused'].includes(job.status)) setJobOptimistic(job, 'cancelling')
    }
    scheduleDownloads(true)
    applyQueueAction('cancel-all').catch(() => {})
  })
  replaceButton('#clear-done', () => {
    for (const job of [...state.downloads.values()]) {
      if (['done', 'error', 'cancelled'].includes(job.status)) {
        state.downloads.delete(job.jobId)
        state.samples.delete(job.jobId)
      }
    }
    scheduleDownloads(true)
    applyQueueAction('clear-done').catch(() => {})
  })

  function installClearAll () {
    if (document.querySelector('#clear-all-downloads')) return
    const clearDone = document.querySelector('#clear-done')
    if (!clearDone || !clearDone.parentElement) return
    const clearAll = document.createElement('button')
    clearAll.id = 'clear-all-downloads'
    clearAll.className = 'ghost small danger'
    clearAll.textContent = 'Clear all'
    clearDone.insertAdjacentElement('afterend', clearAll)
    clearAll.addEventListener('click', () => {
      const total = queueCount('total')
      if (!total) return
      // Unfinished work is cancelled before the history is emptied, so confirm
      // whenever anything is still live.
      const remaining = queueCount('remaining')
      if (remaining && !confirm(`Cancel ${remaining.toLocaleString()} unfinished download(s) and clear all ${total.toLocaleString()} entries?`)) return
      state.downloads.clear()
      state.samples.clear()
      state.queueStats = null
      scheduleDownloads(true)
      applyQueueAction('clear-all').catch(() => {})
    })
  }

  function normalizeSearchIcon () {
    const icon = document.querySelector('#files-toolbar .search-icon')
    if (!icon) return
    icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>'
  }

  rebindChatFilters()
  normalizeSearchIcon()
  installClearAll()
  ensureDownloadSummary()
  teleUiRenderChats()
  restoreCanonical(state.activeChatId).then(() => {
    updateCanonicalCount()
    try { renderFiles() } catch {}
  }).catch(() => {})
  renderDownloadsNow()
})()
