'use strict'

/* Final UI/runtime ownership pass.
 * This file loads last and intentionally replaces the remaining repair-style
 * observers with direct owners for chat rows, Files incremental rendering,
 * dedupe confirmation normalization, and download rendering/actions.
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

  /* ------------------------------ Chat list: one final owner ------------------------------ */

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

  const baseHandleEvent = handleEvent
  handleEvent = function teleUiHandleEvent (event) {
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
    if (event && (event.name === 'message-upsert' || event.name === 'message-delete') && state.view === 'files') {
      const anchor = captureFileAnchor()
      queueMicrotask(() => { renderFiles(); restoreFileAnchor(anchor) })
    }
    return result
  }

  /* ------------------------------ Files: stable incremental window ------------------------------ */

  const fileWindow = { key: '', limit: 240, pageSize: 240 }
  function fileViewKey () {
    return [state.activeChatId, state.files.mode, state.files.query, state.files.filter, state.files.sort].join('|')
  }
  function captureFileAnchor () {
    const grid = document.querySelector('#media-grid')
    if (!grid || !grid.children.length) return null
    const top = grid.getBoundingClientRect().top
    for (const card of grid.querySelectorAll('.gcard[data-key]')) {
      const rect = card.getBoundingClientRect()
      if (rect.bottom >= top) return { key: card.dataset.key, offset: rect.top - top }
    }
    return null
  }
  function restoreFileAnchor (anchor) {
    if (!anchor) return
    const grid = document.querySelector('#media-grid')
    const card = grid && [...grid.querySelectorAll('.gcard[data-key]')].find(row => row.dataset.key === anchor.key)
    if (!grid || !card) return
    const top = grid.getBoundingClientRect().top
    grid.scrollTop += card.getBoundingClientRect().top - top - anchor.offset
  }

  function renderFilesIncremental () {
    const grid = document.querySelector('#media-grid')
    if (!grid) return
    const items = filesItems()
    const nextKey = fileViewKey()
    const changedView = fileWindow.key !== nextKey
    if (changedView) {
      fileWindow.key = nextKey
      fileWindow.limit = fileWindow.pageSize
    }
    const limit = Math.min(items.length, fileWindow.limit)
    const expected = items.slice(0, limit)
    const cards = [...grid.querySelectorAll('.gcard[data-key]')]
    let prefixMatches = !changedView && cards.length <= expected.length
    if (prefixMatches) {
      for (let i = 0; i < cards.length; i++) {
        const expectedKey = `${expected[i].chatId}:${expected[i].messageId}`
        if (cards[i].dataset.key !== expectedKey) { prefixMatches = false; break }
      }
    }

    if (!prefixMatches) {
      const anchor = changedView ? null : captureFileAnchor()
      grid.replaceChildren()
      const fragment = document.createDocumentFragment()
      for (const item of expected) fragment.appendChild(buildGridCard(item))
      grid.appendChild(fragment)
      restoreFileAnchor(anchor)
    } else if (cards.length < expected.length) {
      const fragment = document.createDocumentFragment()
      for (let i = cards.length; i < expected.length; i++) fragment.appendChild(buildGridCard(expected[i]))
      grid.appendChild(fragment)
    }

    const oldStatus = grid.querySelector('.tele-final-list-status')
    if (oldStatus) oldStatus.remove()
    if (items.length > limit) {
      const status = document.createElement('div')
      status.className = 'tele-final-list-status'
      status.textContent = `Showing ${limit.toLocaleString()} of ${items.length.toLocaleString()} · scroll for more`
      grid.appendChild(status)
    }
    const selectAll = document.querySelector('#select-all-media')
    if (selectAll) {
      selectAll.textContent = items.length ? `Select all (${items.length.toLocaleString()})` : 'Select all'
      selectAll.disabled = items.length === 0
    }
  }

  renderFiles = renderFilesIncremental

  const grid = document.querySelector('#media-grid')
  if (grid) {
    grid.addEventListener('scroll', event => {
      if (event.target !== grid) return
      event.stopImmediatePropagation()
      if (grid.scrollTop + grid.clientHeight < grid.scrollHeight - 900) return
      const items = filesItems()
      if (fileWindow.limit >= items.length) return
      fileWindow.limit = Math.min(items.length, fileWindow.limit + fileWindow.pageSize)
      renderFilesIncremental()
    }, { capture: true, passive: true })
  }

  /* ------------------------------ Dedupe: deterministic confirmation markup ------------------------------ */

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

  /* ------------------------------ Downloads: batched rendering + live stats ------------------------------ */

  let downloadsRaf = 0
  function scheduleDownloads () {
    if (downloadsRaf) return
    downloadsRaf = requestAnimationFrame(() => {
      downloadsRaf = 0
      renderDownloadsNow()
    })
  }

  upsertDownload = function teleUiUpsertDownload (job) {
    state.downloads.set(job.jobId, { ...(state.downloads.get(job.jobId) || {}), ...job })
    scheduleDownloads()
  }

  function setJobOptimistic (job, status) {
    job.status = status
    if (status !== 'downloading') state.samples.delete(job.jobId)
  }

  function renderDownloadsNow () {
    const list = document.querySelector('#download-list')
    const stats = document.querySelector('#download-stats')
    if (!list || !stats) return
    const fragment = document.createDocumentFragment()
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

    for (const job of state.downloads.values()) {
      const downloaded = Math.max(0, Number(job.downloaded || 0))
      const fileSize = Math.max(0, Number(job.fileSize || 0))
      downloadedBytes += downloaded
      expectedBytes += fileSize
      let speed = 0
      let samples = state.samples.get(job.jobId)
      if (job.status === 'downloading') {
        if (!samples) { samples = []; state.samples.set(job.jobId, samples) }
        samples.push({ time: now, downloaded })
        while (samples.length > 1 && now - samples[0].time > 3000) samples.shift()
        if (samples.length >= 2) {
          const first = samples[0]
          const last = samples[samples.length - 1]
          const seconds = (last.time - first.time) / 1000
          if (seconds > 0) speed = Math.max(0, (last.downloaded - first.downloaded) / seconds)
        }
      } else {
        state.samples.delete(job.jobId)
      }
      if (job.status === 'downloading') { active++; totalSpeed += speed }
      else if (job.status === 'queued') queued++
      else if (job.status === 'paused') paused++
      else if (job.status === 'done') done++
      else if (job.status === 'error') failed++
      else if (job.status === 'cancelled' || job.status === 'cancelling') cancelled++

      const el = h('div', 'djob ' + job.status)
      el.appendChild(h('div', 'name', job.fileName || '…'))
      const sub = h('div', 'sub')
      const statusText = {
        downloading: speed > 0 ? `● ${fmtSpeed(speed)}` : 'downloading', queued: 'queued', paused: 'paused', done: 'saved', cancelled: 'cancelled', cancelling: 'cancelling…', error: 'failed'
      }[job.status] || job.status
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
        pause.onclick = () => { setJobOptimistic(job, 'paused'); scheduleDownloads(); request('pause-job', { jobId: job.jobId }).catch(() => {}) }
        actions.appendChild(pause)
      }
      if (job.status === 'paused') {
        const resume = h('button', 'ghost small', 'Resume')
        resume.onclick = () => { setJobOptimistic(job, 'queued'); scheduleDownloads(); request('resume-job', { jobId: job.jobId }).catch(() => {}) }
        actions.appendChild(resume)
      }
      if (['queued', 'downloading', 'paused'].includes(job.status)) {
        const cancel = h('button', 'ghost small', 'Cancel')
        cancel.onclick = () => { setJobOptimistic(job, 'cancelling'); scheduleDownloads(); request('cancel-download', { jobId: job.jobId }).catch(() => {}) }
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
        remove.onclick = () => { state.downloads.delete(job.jobId); state.samples.delete(job.jobId); scheduleDownloads(); request('remove-download', { jobId: job.jobId }).catch(() => {}) }
        actions.appendChild(remove)
      }
      el.appendChild(actions)
      fragment.appendChild(el)
    }
    list.replaceChildren(fragment)

    const total = state.downloads.size
    const remaining = active + queued + paused
    const pct = expectedBytes > 0 ? Math.min(100, downloadedBytes / expectedBytes * 100) : 0
    const eta = totalSpeed > 0 && expectedBytes > downloadedBytes ? fmtEta((expectedBytes - downloadedBytes) / totalSpeed) : ''
    const parts = []
    if (total) parts.push(`${done}/${total} done`)
    if (remaining) parts.push(`${remaining} remaining`)
    if (active) parts.push(`${active} active`)
    if (paused) parts.push(`${paused} paused`)
    if (failed) parts.push(`${failed} failed`)
    if (cancelled) parts.push(`${cancelled} cancelled`)
    if (totalSpeed > 0) parts.push(fmtSpeed(totalSpeed))
    if (expectedBytes > 0) parts.push(`${pct.toFixed(pct >= 10 ? 0 : 1)}%`)
    if (eta) parts.push(`ETA ${eta}`)
    stats.textContent = parts.join(' · ')
  }

  renderDownloads = renderDownloadsNow

  function replaceButton (selector, handler) {
    const old = document.querySelector(selector)
    if (!old) return null
    const next = old.cloneNode(true)
    old.replaceWith(next)
    next.addEventListener('click', handler)
    return next
  }

  replaceButton('#pause-all', () => {
    for (const job of state.downloads.values()) if (job.status === 'queued' || job.status === 'downloading') setJobOptimistic(job, 'paused')
    scheduleDownloads()
    request('pause-all', {}).catch(() => {})
  })
  replaceButton('#resume-all', () => {
    for (const job of state.downloads.values()) if (job.status === 'paused') setJobOptimistic(job, 'queued')
    scheduleDownloads()
    request('resume-all', {}).catch(() => {})
  })
  replaceButton('#cancel-all', () => {
    const activeJobs = [...state.downloads.values()].filter(job => ['queued', 'downloading', 'paused'].includes(job.status))
    if (!activeJobs.length) return
    if (!confirm(`Cancel ${activeJobs.length} active download(s)?`)) return
    for (const job of activeJobs) setJobOptimistic(job, 'cancelling')
    scheduleDownloads()
    request('cancel-all', {}).catch(() => {})
  })
  replaceButton('#clear-done', () => {
    const ids = []
    for (const [id, job] of state.downloads) {
      if (['done', 'error', 'cancelled'].includes(job.status)) {
        ids.push(id)
        state.downloads.delete(id)
        state.samples.delete(id)
      }
    }
    scheduleDownloads()
    for (const jobId of ids) request('remove-download', { jobId }).catch(() => {})
  })

  function normalizeSearchIcon () {
    const icon = document.querySelector('#files-toolbar .search-icon')
    if (!icon) return
    icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>'
  }

  rebindChatFilters()
  normalizeSearchIcon()
  teleUiRenderChats()
  renderFilesIncremental()
  renderDownloadsNow()
})()
