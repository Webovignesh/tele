'use strict'

/* Tele daily-driver v3 ------------------------------------------------------
 * Final browser-side integration layer for the legacy rescue build.
 * - file indexing is chat-scoped and progressively rendered
 * - message/file media is thumbnail-first and only fetches full bytes on click
 * - preview playback is isolated in one resilient lightbox
 * - selection survives rerenders and the dock participates in layout
 * - uploads expose real browser-transfer progress and Telegram processing state
 */

const teleV3ThumbPromises = new Map()
const teleV3UploadStates = new WeakMap()
let teleV3PreviewItem = null
let teleV3ActiveScanKey = null
let teleV3OpenToken = 0
let teleV3FileRenderFrame = 0

function teleV3Key (item) {
  return `${item && item.chatId != null ? item.chatId : state.activeChatId}:${item && (item.messageId != null ? item.messageId : item.id)}`
}

function teleV3MediaUrl (item, retryToken) {
  const params = new URLSearchParams()
  params.set('name', String((item && item.name) || 'file'))
  if (item && item.mime) params.set('mime', String(item.mime))
  if (item && item.chatId != null) params.set('chatId', String(item.chatId))
  if (item && item.messageId != null) params.set('messageId', String(item.messageId))
  if (retryToken) params.set('retry', String(retryToken))
  return `/api/media-preview/${encodeURIComponent(item && item.fileId != null ? item.fileId : 0)}?${params.toString()}`
}

function teleV3Time12 (timestamp) {
  return new Date(Number(timestamp || 0) * 1000).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  })
}

function teleV3DayLabel (timestamp) {
  const date = new Date(Number(timestamp || 0) * 1000)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  if (same(date, today)) return 'Today'
  if (same(date, yesterday)) return 'Yesterday'
  return date.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric'
  })
}

function teleV3TypeLabel (type) {
  return ({
    photo: 'Photo',
    video: 'Video',
    video_note: 'Video',
    gif: 'GIF',
    audio: 'Audio',
    voice: 'Voice',
    document: 'Document',
    sticker: 'Sticker'
  })[type] || 'File'
}

function teleV3MediaGlyph (type) {
  if (typeof rescueMediaTypeSvg === 'function') return rescueMediaTypeSvg(type)
  return '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 6.5 7 14a3 3 0 0 0 4.2 4.2l8-8a5 5 0 0 0-7.1-7.1l-8.5 8.5a7 7 0 0 0 9.9 9.9l7.5-7.5"/></svg>'
}

async function teleV3ResolveThumb (item) {
  if (!item) return null
  if (item.thumbUrl) return '/dl' + item.thumbUrl
  if (!item.thumbFileId) return null
  const key = String(item.thumbFileId)
  if (teleV3ThumbPromises.has(key)) return teleV3ThumbPromises.get(key)
  const promise = request('get-thumb', { fileId: item.thumbFileId })
    .then(result => {
      if (!result || !result.path) return null
      item.thumbUrl = result.path
      return '/dl' + result.path
    })
    .catch(() => null)
    .finally(() => teleV3ThumbPromises.delete(key))
  teleV3ThumbPromises.set(key, promise)
  return promise
}

const teleV3ThumbObserver = 'IntersectionObserver' in window
  ? new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        teleV3ThumbObserver.unobserve(entry.target)
        const image = entry.target
        const item = image._teleV3Item
        teleV3ResolveThumb(item).then(url => {
          if (!url || !image.isConnected) return
          image.src = url
        })
      }
    }, { rootMargin: '360px 0px' })
  : null

function teleV3BindThumb (image, item) {
  if (!image || !item) return
  image._teleV3Item = item
  image.loading = 'lazy'
  image.decoding = 'async'
  image.addEventListener('load', () => {
    image.classList.add('is-loaded')
    image.closest('.tele-v3-media-thumb, .tele-v3-file-thumb')?.classList.add('has-image')
  })
  image.addEventListener('error', () => {
    image.removeAttribute('src')
    image.classList.remove('is-loaded')
    image.closest('.tele-v3-media-thumb, .tele-v3-file-thumb')?.classList.remove('has-image')
  })
  if (item.thumbUrl) image.src = '/dl' + item.thumbUrl
  else if (teleV3ThumbObserver) teleV3ThumbObserver.observe(image)
  else teleV3ResolveThumb(item).then(url => { if (url) image.src = url })
}

function teleV3EnsurePreviewModal () {
  let modal = document.querySelector('#tele-v3-preview')
  if (modal) return modal
  modal = document.createElement('div')
  modal.id = 'tele-v3-preview'
  modal.className = 'tele-v3-preview hidden'
  modal.innerHTML = `
    <div class="tele-v3-preview-shell" role="dialog" aria-modal="true" aria-labelledby="tele-v3-preview-title">
      <header class="tele-v3-preview-head">
        <div class="tele-v3-preview-titlebox">
          <strong id="tele-v3-preview-title">Media</strong>
          <span id="tele-v3-preview-meta"></span>
        </div>
        <div class="tele-v3-preview-actions">
          <button id="tele-v3-preview-download" class="ghost small" type="button">Download</button>
          <button id="tele-v3-preview-close" class="ghost small" type="button" aria-label="Close">×</button>
        </div>
      </header>
      <main id="tele-v3-preview-body" class="tele-v3-preview-body"></main>
    </div>`
  document.body.appendChild(modal)

  const close = () => {
    modal.classList.add('hidden')
    const body = modal.querySelector('#tele-v3-preview-body')
    body.querySelectorAll('video,audio').forEach(media => {
      try { media.pause() } catch {}
      media.removeAttribute('src')
      try { media.load() } catch {}
    })
    body.innerHTML = ''
    teleV3PreviewItem = null
  }
  modal.querySelector('#tele-v3-preview-close').onclick = close
  modal.addEventListener('mousedown', event => { if (event.target === modal) close() })
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !modal.classList.contains('hidden')) close()
  })
  modal.querySelector('#tele-v3-preview-download').onclick = () => {
    if (!teleV3PreviewItem) return
    startDownloads([teleV3PreviewItem])
    toastOk('Added to Downloads')
  }
  return modal
}

function teleV3PreviewFailure (body, item, message) {
  body.innerHTML = ''
  const stateBox = h('div', 'tele-v3-preview-state')
  stateBox.innerHTML = teleV3MediaGlyph(item && item.type)
  stateBox.append(
    h('strong', '', 'Could not open this media'),
    h('span', '', message || 'Telegram could not prepare a playable copy.'),
    h('small', '', 'Some videos use codecs the browser cannot decode. Downloading the original still works.')
  )
  const actions = h('div', 'tele-v3-preview-state-actions')
  const retry = h('button', '', 'Retry')
  retry.type = 'button'
  retry.onclick = () => teleV3OpenPreview(item, Date.now())
  const download = h('button', 'ghost', 'Download original')
  download.type = 'button'
  download.onclick = () => { startDownloads([item]); toastOk('Added to Downloads') }
  actions.append(retry, download)
  stateBox.appendChild(actions)
  body.appendChild(stateBox)
}

async function teleV3OpenPreview (item, retryToken) {
  if (!item || !item.fileId) return toast('This Telegram file is not available yet', 'error')
  teleV3PreviewItem = item
  const modal = teleV3EnsurePreviewModal()
  const body = modal.querySelector('#tele-v3-preview-body')
  const title = modal.querySelector('#tele-v3-preview-title')
  const meta = modal.querySelector('#tele-v3-preview-meta')
  title.textContent = item.name || teleV3TypeLabel(item.type)
  meta.textContent = `${teleV3TypeLabel(item.type)} · ${fmtSize(item.fileSize || 0)}`
  body.innerHTML = '<div class="tele-v3-preview-loading"><span></span>Preparing media from Telegram…</div>'
  modal.classList.remove('hidden')

  const url = teleV3MediaUrl(item, retryToken)
  let node
  if (item.type === 'photo' || item.type === 'gif' || item.type === 'sticker') {
    node = document.createElement('img')
    node.className = 'tele-v3-preview-image'
    node.alt = item.name || ''
    node.onload = () => { body.innerHTML = ''; body.appendChild(node) }
    node.onerror = () => teleV3PreviewFailure(body, item, 'The image bytes were unavailable or invalid.')
    node.src = url
    return
  }

  if (item.type === 'video' || item.type === 'video_note') {
    node = document.createElement('video')
    node.className = 'tele-v3-preview-video'
    node.controls = true
    node.playsInline = true
    node.preload = 'metadata'
    node.autoplay = true
    const poster = await teleV3ResolveThumb(item)
    if (poster) node.poster = poster
    node.onloadedmetadata = () => { body.innerHTML = ''; body.appendChild(node); node.play().catch(() => {}) }
    node.onerror = () => teleV3PreviewFailure(body, item, 'The browser could not play this Telegram video.')
    node.src = url
    node.load()
    return
  }

  if (item.type === 'audio' || item.type === 'voice') {
    node = document.createElement('audio')
    node.className = 'tele-v3-preview-audio'
    node.controls = true
    node.preload = 'metadata'
    node.autoplay = true
    node.onloadedmetadata = () => { body.innerHTML = ''; body.appendChild(node); node.play().catch(() => {}) }
    node.onerror = () => teleV3PreviewFailure(body, item, 'The browser could not play this audio file.')
    node.src = url
    node.load()
    return
  }

  if (String(item.mime || '').toLowerCase() === 'application/pdf' || /\.pdf$/i.test(item.name || '')) {
    const frame = document.createElement('iframe')
    frame.className = 'tele-v3-preview-pdf'
    frame.title = item.name || 'PDF preview'
    frame.onload = () => { body.innerHTML = ''; body.appendChild(frame) }
    frame.onerror = () => teleV3PreviewFailure(body, item, 'The PDF could not be displayed inline.')
    frame.src = url
    return
  }

  teleV3PreviewFailure(body, item, 'This file type has no browser preview.')
}

function teleV3MediaThumb (item, context) {
  const button = h('button', `tele-v3-media-thumb tele-v3-media-thumb--${item.type || 'file'} tele-v3-media-thumb--${context || 'message'}`)
  button.type = 'button'
  button.setAttribute('aria-label', `Open ${item.name || teleV3TypeLabel(item.type)}`)
  const fallback = h('span', 'tele-v3-media-fallback')
  fallback.innerHTML = teleV3MediaGlyph(item.type)
  button.appendChild(fallback)

  if (item.type === 'photo' || item.type === 'video' || item.type === 'video_note' || item.type === 'gif' || item.type === 'sticker') {
    const image = h('img', 'tele-v3-media-thumb-image')
    image.alt = ''
    button.appendChild(image)
    teleV3BindThumb(image, item)
  }

  if (item.type === 'video' || item.type === 'video_note' || item.type === 'gif') {
    const play = h('span', 'tele-v3-play')
    play.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>'
    button.appendChild(play)
  }

  button.onclick = event => {
    event.stopPropagation()
    teleV3OpenPreview(item)
  }
  return button
}

function teleV3BuildMediaRow (message, includeSelection) {
  const item = message && message.media
  const row = h('div', 'media tele-v3-media-row')
  if (!item) return row
  row.appendChild(teleV3MediaThumb(item, 'message'))

  const meta = h('div', 'tele-v3-media-meta')
  meta.append(
    h('strong', 'tele-v3-media-name', item.name || teleV3TypeLabel(item.type)),
    h('span', 'tele-v3-media-sub', `${fmtSize(item.fileSize || 0)} · ${teleV3TypeLabel(item.type)}`)
  )
  if (item.caption) meta.appendChild(h('div', 'tele-v3-media-caption', item.caption))
  row.appendChild(meta)

  if (includeSelection) {
    const key = teleV3Key(item)
    const checkbox = h('input', 'tele-v3-media-check')
    checkbox.type = 'checkbox'
    checkbox.checked = state.selection.has(key)
    checkbox.onclick = event => event.stopPropagation()
    checkbox.onchange = () => {
      if (checkbox.checked) state.selection.set(key, item)
      else state.selection.delete(key)
      updateSelectionBar()
    }
    row.appendChild(checkbox)
  }
  return row
}

buildMediaRow = teleV3BuildMediaRow

function teleV3StatusBadges (item) {
  const key = teleV3Key(item)
  const statuses = h('div', 'tele-v3-file-statuses')
  if (typeof rescueDownloadedMarks !== 'undefined' && rescueDownloadedMarks.has(key)) statuses.appendChild(h('span', 'downloaded', 'Downloaded'))
  if (typeof rescueForwardedMarks !== 'undefined' && rescueForwardedMarks.has(key)) statuses.appendChild(h('span', 'forwarded', 'Forwarded'))
  return statuses
}

buildGridCard = function teleV3BuildGridCard (item) {
  const key = teleV3Key(item)
  itemByKey.set(key, item)
  const card = h('div', 'gcard tele-v3-file-card')
  card.dataset.key = key
  card._item = item
  card.tabIndex = 0
  card.setAttribute('role', 'option')
  card.setAttribute('aria-selected', state.selection.has(key) ? 'true' : 'false')
  if (state.selection.has(key)) card.classList.add('selected')
  if (isCompleted(key)) card.classList.add('completed')

  const thumb = teleV3MediaThumb(item, 'file')
  thumb.classList.add('gthumb', 'tele-v3-file-thumb')
  card.appendChild(thumb)

  const body = h('div', 'gbody tele-v3-file-body')
  const name = h('div', 'gname', item.name || 'file')
  name.title = item.name || 'file'
  const details = h('div', 'gsize', fmtSize(item.fileSize || 0))
  if (item.date) details.textContent += ` · ${new Date(Number(item.date) * 1000).toLocaleDateString()}`
  body.append(name, details)
  const statuses = teleV3StatusBadges(item)
  if (statuses.children.length) body.appendChild(statuses)
  card.appendChild(body)
  card.appendChild(h('span', 'gtype', teleV3TypeLabel(item.type)))

  const checkbox = h('input', 'tele-v3-file-check')
  checkbox.type = 'checkbox'
  checkbox.checked = state.selection.has(key)
  checkbox.setAttribute('aria-label', `Select ${item.name || 'file'}`)
  checkbox.onclick = event => event.stopPropagation()
  checkbox.onchange = () => {
    if (checkbox.checked) state.selection.set(key, item)
    else state.selection.delete(key)
    card.classList.toggle('selected', checkbox.checked)
    card.setAttribute('aria-selected', checkbox.checked ? 'true' : 'false')
    lastClickedKey = key
    updateSelectionBar()
  }
  card.appendChild(checkbox)

  const selectFromPointer = event => {
    if (event.target.closest('button,input,a,video,audio')) return
    const grid = $('#media-grid')
    if (event.shiftKey && lastClickedKey) {
      const start = cardIndexForKey(grid, lastClickedKey)
      const end = cardIndexForKey(grid, key)
      if (start >= 0 && end >= 0) selectRange(Math.min(start, end), Math.max(start, end), grid)
      return
    }
    if (event.ctrlKey || event.metaKey) {
      const on = !state.selection.has(key)
      if (on) state.selection.set(key, item)
      else state.selection.delete(key)
      card.classList.toggle('selected', on)
      checkbox.checked = on
      card.setAttribute('aria-selected', on ? 'true' : 'false')
    } else if (!state.selection.has(key)) {
      state.selection.set(key, item)
      card.classList.add('selected')
      checkbox.checked = true
      card.setAttribute('aria-selected', 'true')
    }
    lastClickedKey = key
    updateSelectionBar()
  }
  card.onclick = selectFromPointer
  card.onkeydown = event => {
    if (event.key === 'Enter') {
      event.preventDefault()
      teleV3OpenPreview(item)
    } else if (event.key === ' ') {
      event.preventDefault()
      selectFromPointer({ target: card, ctrlKey: true, metaKey: false, shiftKey: false })
    }
  }
  return card
}

function teleV3RenderFilesNow () {
  if (typeof dragSel !== 'undefined' && dragSel) {
    setTimeout(() => renderFiles(), 90)
    return
  }
  const grid = $('#media-grid')
  if (!grid) return
  const items = filesItems()
  const limit = typeof rescueFileRenderLimit === 'number' ? rescueFileRenderLimit : 600
  const visible = items.length > 1200 ? items.slice(0, limit) : items
  const previousTop = grid.scrollTop
  const fragment = document.createDocumentFragment()
  for (const item of visible) fragment.appendChild(buildGridCard(item))
  if (visible.length < items.length) {
    const more = h('button', 'tele-v3-file-more', `Load more · ${visible.length.toLocaleString()} of ${items.length.toLocaleString()}`)
    more.type = 'button'
    more.onclick = () => {
      if (typeof rescueFileRenderLimit === 'number') rescueFileRenderLimit = Math.min(items.length, rescueFileRenderLimit + 800)
      renderFiles()
    }
    fragment.appendChild(more)
  }
  grid.replaceChildren(fragment)
  grid.scrollTop = previousTop

  const selectAll = $('#select-all-media')
  if (selectAll) {
    selectAll.textContent = items.length ? `Select all (${items.length.toLocaleString()})` : 'Select all'
    selectAll.disabled = items.length === 0
  }
  if (typeof rescueUpdateRangeControls === 'function') rescueUpdateRangeControls(items.length)
}

renderFiles = function teleV3RenderFiles () {
  if (teleV3FileRenderFrame) cancelAnimationFrame(teleV3FileRenderFrame)
  teleV3FileRenderFrame = requestAnimationFrame(() => {
    teleV3FileRenderFrame = 0
    teleV3RenderFilesNow()
  })
}

function teleV3UnionSelectionKeys () {
  return new Set([
    ...state.selection.keys(),
    ...state.selectedMessages.keys()
  ])
}

updateSelectionBar = function teleV3UpdateSelectionBar () {
  const selectedKeys = teleV3UnionSelectionKeys()
  const total = selectedKeys.size
  const forwardIds = selectedForwardIds()
  const dock = $('#selection-bar')
  if (!dock) return
  $('#selection-count').textContent = `${total} selected`
  dock.classList.toggle('hidden', total === 0)

  const forward = $('#forward-selected')
  if (forward) {
    forward.disabled = forwardIds.length === 0
    forward.textContent = forwardIds.length ? `Forward (${forwardIds.length})` : 'Forward'
  }
  const download = $('#download-selected')
  if (download) download.disabled = state.selection.size === 0
  const mark = $('#mark-completed')
  const unmark = $('#unmark-completed')
  if (mark) mark.disabled = state.selection.size === 0
  if (unmark) unmark.disabled = state.selection.size === 0
}

function teleV3MountSelectionDock () {
  const chat = $('.chat')
  const dock = $('#selection-bar')
  const composer = $('#tele-composer')
  if (!chat || !dock) return
  if (composer) {
    if (dock.nextElementSibling !== composer) chat.insertBefore(dock, composer)
  } else {
    const foot = $('.chat-foot')
    if (foot && dock.nextElementSibling !== foot) chat.insertBefore(dock, foot)
  }
  updateSelectionBar()
}
teleV3MountSelectionDock()

let teleV3BlankPointer = null
const teleV3SelectionGrid = $('#media-grid')
if (teleV3SelectionGrid) {
  teleV3SelectionGrid.addEventListener('mousedown', event => {
    if (event.button !== 0 || event.target.closest('.gcard,input,button,a,select')) return
    teleV3BlankPointer = {
      x: event.clientX,
      y: event.clientY,
      files: new Map(state.selection),
      messages: new Map(state.selectedMessages)
    }
  }, true)
  document.addEventListener('mouseup', event => {
    const snapshot = teleV3BlankPointer
    teleV3BlankPointer = null
    if (!snapshot) return
    if (Math.abs(event.clientX - snapshot.x) >= 6 || Math.abs(event.clientY - snapshot.y) >= 6) return
    setTimeout(() => {
      if (!snapshot.files.size && !snapshot.messages.size) return
      state.selection = new Map(snapshot.files)
      state.selectedMessages = new Map(snapshot.messages)
      renderFiles()
      updateSelectionBar()
    }, 0)
  })
}

function teleV3CloseMessageMenus (except) {
  document.querySelectorAll('.tele-v3-message-menu').forEach(menu => {
    if (menu !== except) menu.classList.add('hidden')
  })
}

document.addEventListener('click', event => {
  if (!event.target.closest('.tele-v3-message-menu') && !event.target.closest('.tele-v3-message-more')) teleV3CloseMessageMenus()
})

function teleV3MessageGroupBoundary (left, right) {
  if (!left || !right) return true
  if (!!left.outgoing !== !!right.outgoing) return true
  if (String(left.sender || '') !== String(right.sender || '')) return true
  return Math.abs(Number(left.date || 0) - Number(right.date || 0)) > 300
}

renderMessagesList = function teleV3RenderMessagesList () {
  const list = $('#messages')
  if (!list) return
  const wasNearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 90
  const limit = typeof rescueMessageRenderLimit === 'number' ? rescueMessageRenderLimit : 120
  const source = Array.isArray(state.messages) ? state.messages.slice(0, limit).reverse() : []
  const fragment = document.createDocumentFragment()
  let previousDay = null

  for (let index = 0; index < source.length; index++) {
    const message = source[index]
    const day = teleV3DayLabel(message.date)
    if (day !== previousDay) {
      fragment.appendChild(h('div', 'tele-v3-date', day))
      previousDay = day
    }

    const previous = source[index - 1]
    const next = source[index + 1]
    const groupStart = teleV3MessageGroupBoundary(previous, message) || (previous && teleV3DayLabel(previous.date) !== day)
    const groupEnd = teleV3MessageGroupBoundary(message, next) || (next && teleV3DayLabel(next.date) !== day)
    const key = `${state.activeChatId}:${message.id}`
    const selected = state.selectedMessages.has(key)

    const row = h('div', `tele-v3-message-row ${message.outgoing ? 'outgoing' : 'incoming'}${selected ? ' selected' : ''}${groupStart ? ' group-start' : ''}${groupEnd ? ' group-end' : ''}`)
    const select = h('label', 'tele-v3-message-select')
    const checkbox = h('input', '')
    checkbox.type = 'checkbox'
    checkbox.checked = selected
    checkbox.setAttribute('aria-label', 'Select message')
    checkbox.onchange = () => {
      if (checkbox.checked) {
        state.selectedMessages.set(key, message)
        if (message.media) state.selection.set(key, message.media)
      } else {
        state.selectedMessages.delete(key)
        if (message.media) state.selection.delete(key)
      }
      row.classList.toggle('selected', checkbox.checked)
      updateSelectionBar()
    }
    select.appendChild(checkbox)

    const bubble = h('article', 'msg tele-v3-message-bubble')
    bubble.dataset.messageId = String(message.id)
    if (!message.outgoing && groupStart && message.sender) bubble.appendChild(h('div', 'msg-sender', message.sender))
    if (message.text) bubble.appendChild(h('div', 'msg-text', message.text))
    if (message.media) bubble.appendChild(buildMediaRow(message, false))

    const footer = h('footer', 'tele-v3-message-footer')
    footer.appendChild(h('time', '', teleV3Time12(message.date)))
    if (message.outgoing) footer.appendChild(h('span', 'tele-v3-delivery', '✓'))
    bubble.appendChild(footer)

    const more = h('button', 'tele-v3-message-more', '⋮')
    more.type = 'button'
    more.setAttribute('aria-label', 'Message actions')
    const menu = h('div', 'tele-v3-message-menu hidden')
    const action = (label, callback, danger) => {
      const button = h('button', danger ? 'danger' : '', label)
      button.type = 'button'
      button.onclick = event => {
        event.stopPropagation()
        menu.classList.add('hidden')
        callback()
      }
      menu.appendChild(button)
    }
    action('Reply', () => window.teleReplyToMessage && window.teleReplyToMessage(message))
    if (message.outgoing && message.text) action('Edit', () => window.teleEditMessage && window.teleEditMessage(message))
    action('Delete', () => window.teleDeleteMessage && window.teleDeleteMessage(message), true)
    more.onclick = event => {
      event.stopPropagation()
      const opening = menu.classList.contains('hidden')
      teleV3CloseMessageMenus(menu)
      menu.classList.toggle('hidden', !opening)
    }
    bubble.append(more, menu)
    bubble.addEventListener('contextmenu', event => {
      event.preventDefault()
      teleV3CloseMessageMenus(menu)
      menu.classList.remove('hidden')
    })

    row.append(select, bubble)
    fragment.appendChild(row)
  }

  list.replaceChildren(fragment)
  if (wasNearBottom) requestAnimationFrame(() => { list.scrollTop = list.scrollHeight })
}

function teleV3ScrollLatest (chatId, token) {
  const run = () => {
    if (token !== teleV3OpenToken || String(state.activeChatId) !== String(chatId) || state.view !== 'messages') return
    const list = $('#messages')
    if (list) list.scrollTop = list.scrollHeight
  }
  requestAnimationFrame(() => requestAnimationFrame(run))
  setTimeout(run, 120)
  setTimeout(run, 420)
}

const teleV3BaseOpenChat = openChat
openChat = async function teleV3OpenChat (chatId) {
  const token = ++teleV3OpenToken
  const result = teleV3BaseOpenChat(chatId)
  teleV3ScrollLatest(chatId, token)
  try { await result } finally { teleV3ScrollLatest(chatId, token) }
  return result
}

const teleV3BaseSetView = setView
setView = function teleV3SetView (view) {
  teleV3BaseSetView(view)
  if (view === 'messages' && state.activeChatId != null) teleV3ScrollLatest(state.activeChatId, teleV3OpenToken)
}

function teleV3ChatPreview (chat) {
  const content = chat && chat.lastMessage
  if (content && content._ === 'messageText') return String(content.text && content.text.text || '')
  if (content && /^message/.test(content._ || '')) {
    return ({
      messagePhoto: 'Photo',
      messageVideo: 'Video',
      messageDocument: 'Document',
      messageAudio: 'Audio',
      messageVoiceNote: 'Voice message',
      messageAnimation: 'GIF',
      messageSticker: 'Sticker'
    })[content._] || 'New message'
  }
  return String(chat && (chat.lastText || (chat.username ? '@' + chat.username : '')) || '')
}

renderChats = function teleV3RenderChats () {
  if (typeof rescueSortChatsRecentFirst === 'function') rescueSortChatsRecentFirst()
  const list = $('#chat-list')
  if (!list) return
  const query = String($('#chat-search') && $('#chat-search').value || '').trim().toLowerCase()
  const channelsOnly = !!($('#channels-only') && $('#channels-only').checked)
  const fragment = document.createDocumentFragment()
  let shown = 0

  for (const chat of state.chats) {
    const previewText = teleV3ChatPreview(chat)
    const searchable = `${chat.title || ''} ${chat.username || ''} ${previewText}`.toLowerCase()
    if (query && !searchable.includes(query)) continue
    if (channelsOnly && chat.kind !== 'channel') continue
    shown++

    const item = h('li', `chat-item${String(chat.id) === String(state.activeChatId) ? ' active' : ''}`)
    item.dataset.chatId = String(chat.id)
    const avatar = h('div', 'chat-avatar', initials(chat.title || '?'))
    avatar.style.background = avatarColor(chat.title || '?')
    item.appendChild(avatar)
    if (typeof rescueLoadAvatar === 'function') rescueLoadAvatar(chat, avatar)

    const column = h('div', 'col')
    column.appendChild(h('div', 't', chat.title || 'Unknown'))
    if (previewText) {
      const preview = h('div', 'preview', previewText)
      preview.title = previewText
      column.appendChild(preview)
    }
    item.appendChild(column)

    const kind = h('div', 'u chat-kind')
    if (typeof rescueChatTypeSvg === 'function') kind.innerHTML = rescueChatTypeSvg(chat.kind)
    else kind.textContent = chat.kind === 'channel' ? 'C' : '•'
    if (chat.unread > 0) kind.appendChild(h('span', 'chat-unread', String(chat.unread)))
    item.appendChild(kind)
    item.onclick = () => openChat(chat.id)
    fragment.appendChild(item)
  }

  list.replaceChildren(fragment)
  const count = $('#chat-count')
  if (count) count.textContent = channelsOnly ? `${shown} channels` : `${state.chats.length} chats`
}

function teleV3RebindChatSearch () {
  const current = $('#chat-search')
  if (!current || current.dataset.teleV3Bound === '1') return
  const replacement = current.cloneNode(true)
  replacement.dataset.teleV3Bound = '1'
  current.replaceWith(replacement)
  replacement.addEventListener('input', () => renderChats())
}
teleV3RebindChatSearch()
renderChats()

function teleV3ScheduleFileRender () {
  if (teleV3FileRenderFrame) return
  teleV3FileRenderFrame = requestAnimationFrame(() => {
    teleV3FileRenderFrame = 0
    if (state.view === 'files') teleV3RenderFilesNow()
  })
}

function teleV3MergeIndexProgress (payload) {
  if (!payload || payload.chatId == null) return
  const key = rescueChatKey(payload.chatId)
  let snapshot = rescueFileCache.get(key)
  if (!snapshot || payload.reset) snapshot = { items: [], found: 0, scanned: 0, typeCounts: {}, savedAt: Date.now(), complete: false }
  const byKey = new Map((snapshot.items || []).map(item => [String(item.key || teleV3Key(item)), item]))
  for (const item of payload.items || []) byKey.set(String(item.key || teleV3Key(item)), item)
  snapshot.items = [...byKey.values()].sort((a, b) => {
    const left = BigInt(String(a.messageId || 0))
    const right = BigInt(String(b.messageId || 0))
    return left === right ? 0 : (left < right ? 1 : -1)
  })
  snapshot.found = Number(payload.found == null ? snapshot.items.length : payload.found)
  snapshot.scanned = Number(payload.scanned || snapshot.scanned || 0)
  snapshot.typeCounts = payload.typeCounts || snapshot.typeCounts || {}
  snapshot.complete = !!payload.done && !payload.cancelled
  snapshot.cancelled = !!payload.cancelled
  snapshot.savedAt = Date.now()
  rescueFileCache.set(key, snapshot)

  if (String(state.activeChatId) !== key || state.view !== 'files') return
  rescueApplyCompleteFiles(payload.chatId, snapshot)
  rescueUpdateMediaLabel()
  if (payload.done) setLoadState(snapshot.cancelled ? `Paused at ${snapshot.items.length.toLocaleString()} files` : `Loaded ${snapshot.items.length.toLocaleString()} files`)
  else setLoadState(`Loading files · ${snapshot.items.length.toLocaleString()} found · ${snapshot.scanned.toLocaleString()} messages scanned`)
  teleV3ScheduleFileRender()
}

const teleV3BaseHandleEvent = handleEvent
handleEvent = function teleV3HandleEvent (event) {
  if (event && event.name === 'media-index-progress') {
    teleV3MergeIndexProgress(event.payload)
    return
  }
  const result = teleV3BaseHandleEvent(event)
  if (event && (event.name === 'download-done' || event.name === 'forward-done') && state.view === 'files') teleV3ScheduleFileRender()
  return result
}

rescueEnsureAllFiles = async function teleV3EnsureAllFiles (chatId) {
  if (chatId == null) return
  const key = rescueChatKey(chatId)
  const cached = rescueFileCache.get(key)
  if (cached && cached.complete) {
    if (String(state.activeChatId) === key && state.view === 'files') {
      rescueApplyCompleteFiles(chatId, cached)
      rescueUpdateMediaLabel()
      renderFiles()
      setLoadState(`Loaded ${cached.items.length.toLocaleString()} files`)
    }
    return cached
  }
  if (rescueFileInflight.has(key)) return rescueFileInflight.get(key)

  if (teleV3ActiveScanKey && teleV3ActiveScanKey !== key) {
    request('cancel-media-scan-v3', { chatId: teleV3ActiveScanKey }).catch(() => {})
  }
  teleV3ActiveScanKey = key

  const partial = cached || { items: [], found: 0, scanned: 0, typeCounts: {}, complete: false, savedAt: Date.now() }
  rescueFileCache.set(key, partial)
  if (String(state.activeChatId) === key && state.view === 'files') {
    rescueApplyCompleteFiles(chatId, partial)
    renderFiles()
    setLoadState(partial.items.length ? `Resuming file index · ${partial.items.length.toLocaleString()} found` : 'Loading files…')
  }

  const work = request('scan-media-v3', { chatId })
    .then(result => {
      teleV3MergeIndexProgress({ ...result, chatId, done: !result.cancelled })
      return rescueFileCache.get(key)
    })
    .catch(error => {
      if (String(state.activeChatId) === key && state.view === 'files') {
        setLoadState('File index paused. Open Files to retry.')
        toast(String(error && error.message ? error.message : error), 'error')
      }
      return null
    })
    .finally(() => {
      rescueFileInflight.delete(key)
      if (teleV3ActiveScanKey === key) teleV3ActiveScanKey = null
    })
  rescueFileInflight.set(key, work)
  return work
}

function teleV3UploadState (file) {
  return teleV3UploadStates.get(file) || { text: 'Ready', mode: 'ready', percent: 0 }
}

function teleV3DecorateUploadTray () {
  const cards = document.querySelectorAll('.tele-upload-card')
  cards.forEach((card, index) => {
    const file = rescueCompose.attachments[index]
    if (!file) return
    const uploadState = teleV3UploadState(file)
    card.dataset.state = uploadState.mode
    const stateNode = card.querySelector('.tele-upload-state')
    if (stateNode) stateNode.textContent = uploadState.text
    let progress = card.querySelector('.tele-v3-upload-progress')
    if (!progress) {
      progress = h('div', 'tele-v3-upload-progress')
      progress.innerHTML = '<span></span>'
      card.querySelector('.tele-upload-info')?.appendChild(progress)
    }
    progress.querySelector('span').style.width = `${Math.max(0, Math.min(100, uploadState.percent || 0))}%`
  })
}

const teleV3BaseRenderAttachments = rescueRenderAttachments
rescueRenderAttachments = function teleV3RenderAttachments () {
  teleV3BaseRenderAttachments()
  teleV3DecorateUploadTray()
}

function teleV3SetUploadState (file, text, mode, percent) {
  teleV3UploadStates.set(file, { text, mode, percent })
  const index = rescueCompose.attachments.indexOf(file)
  if (index < 0) return
  const card = document.querySelector(`.tele-upload-card[data-upload-index="${index}"]`)
  if (!card) return
  card.dataset.state = mode
  const stateNode = card.querySelector('.tele-upload-state')
  if (stateNode) stateNode.textContent = text
  const bar = card.querySelector('.tele-v3-upload-progress span')
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, percent || 0))}%`
}

function teleV3UploadAttachment (file, index, total, caption) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `/api/chat-attachment/${encodeURIComponent(state.activeChatId)}`)
    xhr.timeout = 10 * 60 * 1000
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name))
    xhr.setRequestHeader('X-Mime-Type', encodeURIComponent(file.type || 'application/octet-stream'))
    xhr.setRequestHeader('X-Caption', encodeURIComponent(index === 0 ? caption.slice(0, 1024) : ''))
    xhr.setRequestHeader('X-One-Time', rescueCompose.oneTime && index === 0 ? '1' : '0')
    if (rescueCompose.replyTo && rescueCompose.replyTo.id != null && index === 0) xhr.setRequestHeader('X-Reply-To', String(rescueCompose.replyTo.id))

    xhr.upload.onprogress = event => {
      if (!event.lengthComputable) return
      const percent = Math.max(1, Math.min(100, Math.round(event.loaded / event.total * 100)))
      teleV3SetUploadState(file, `Uploading ${percent}%`, 'sending', percent)
    }
    xhr.upload.onload = () => teleV3SetUploadState(file, 'Sending to Telegram…', 'processing', 100)
    xhr.onerror = () => reject(new Error('Network upload failed'))
    xhr.ontimeout = () => reject(new Error('Telegram upload timed out'))
    xhr.onabort = () => reject(new Error('Upload cancelled'))
    xhr.onload = () => {
      let result = {}
      try { result = JSON.parse(xhr.responseText || '{}') } catch {}
      if (xhr.status < 200 || xhr.status >= 300) return reject(new Error(result.error || `upload failed (${xhr.status})`))
      resolve(result)
    }
    xhr.send(file)
  })
}

rescueSendComposer = async function teleV3SendComposer () {
  const input = $('#tele-compose-input')
  const send = $('#tele-compose-send')
  if (!input || !send || state.activeChatId == null) return
  const text = input.value.trim()
  const attachments = rescueCompose.attachments.slice()
  if (!text && !attachments.length) return
  if (attachments.length && rescueCompose.editMessageId) return toast('Finish editing before attaching files', 'error')
  if (rescueCompose.oneTime && attachments.length !== 1) return toast('View once supports one photo or video at a time', 'error')

  send.disabled = true
  const originalLabel = send.textContent
  let completed = 0
  try {
    if (rescueCompose.editMessageId) {
      send.textContent = 'Saving…'
      await request('edit-chat-message', { chatId: state.activeChatId, messageId: rescueCompose.editMessageId, text })
      toastOk('Message edited')
    } else if (attachments.length) {
      for (let index = 0; index < attachments.length; index++) {
        const file = attachments[index]
        send.textContent = attachments.length > 1 ? `${index + 1}/${attachments.length}` : 'Sending…'
        teleV3SetUploadState(file, 'Starting…', 'sending', 1)
        try {
          await teleV3UploadAttachment(file, index, attachments.length, text)
          completed++
          teleV3SetUploadState(file, 'Sent', 'done', 100)
        } catch (error) {
          teleV3SetUploadState(file, error.message, 'error', 100)
          throw new Error(`${file.name}: ${error.message}`)
        }
      }
    } else {
      send.textContent = 'Sending…'
      await request('send-chat-message', {
        chatId: state.activeChatId,
        text,
        replyToMessageId: rescueCompose.replyTo ? rescueCompose.replyTo.id : null
      })
    }

    input.value = ''
    input.style.height = 'auto'
    if (attachments.length) toastOk(`Sent ${completed} file${completed === 1 ? '' : 's'}`)
    setTimeout(() => {
      rescueClearAttachment()
      rescueClearComposeContext()
    }, attachments.length ? 350 : 0)
  } catch (error) {
    toast(error.message, 'error')
  } finally {
    send.disabled = false
    send.textContent = originalLabel
    input.focus()
  }
}

const teleV3SendButton = $('#tele-compose-send')
if (teleV3SendButton) teleV3SendButton.onclick = rescueSendComposer

function teleV3PolishDownloads () {
  const pane = $('#mg-downloads-pane')
  if (!pane) return
  pane.classList.add('tele-v3-download-pane')
  const header = pane.querySelector('.downloads-head')
  if (header) header.classList.add('tele-v3-inner-download-header')
  const controls = pane.querySelector('.dl-controls')
  if (controls) controls.classList.add('tele-v3-download-controls')
}
teleV3PolishDownloads()

new MutationObserver(() => {
  teleV3MountSelectionDock()
  teleV3PolishDownloads()
}).observe(document.body, { childList: true, subtree: true })
