'use strict'

/* Tele daily-driver runtime fixes.
 * Keeps the fast cache-first chat switcher, but separates file indexing from
 * message history, preserves selection, and renders media inline instead of
 * through a preview modal.
 *
 * Streaming file-scan results into the UI is no longer done here: the Files index
 * owner (public/files-stability.js) merges the scan stream.
 */

const teleDailyAttachmentUrls = new WeakMap()

function teleDailyTime12 (ts) {
  return new Date(Number(ts || 0) * 1000).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  })
}

function teleDailyDayLabel (ts) {
  const date = new Date(Number(ts || 0) * 1000)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  if (sameDay(date, today)) return 'Today'
  if (sameDay(date, yesterday)) return 'Yesterday'
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' })
}

function teleDailyMediaUrl (item) {
  return `/api/media-preview/${encodeURIComponent(item.fileId)}?name=${encodeURIComponent(item.name || 'file')}&mime=${encodeURIComponent(item.mime || '')}`
}

function teleDailyTypeLabel (type) {
  return ({ photo: 'Photo', video: 'Video', video_note: 'Video', gif: 'GIF', audio: 'Audio', voice: 'Voice', document: 'Document', sticker: 'Sticker' })[type] || 'File'
}

function teleDailyLoadThumbInto (img, item, fallbackToMedia) {
  if (!img || !item) return
  if (item.thumbUrl) {
    img.src = '/dl' + item.thumbUrl
    img.classList.remove('hidden')
    return
  }
  if (item.thumbFileId) {
    request('get-thumb', { fileId: item.thumbFileId }).then(data => {
      if (data && data.path) {
        item.thumbUrl = data.path
        img.src = '/dl' + data.path
        img.classList.remove('hidden')
      } else if (fallbackToMedia && item.fileId) {
        img.src = teleDailyMediaUrl(item)
        img.classList.remove('hidden')
      }
    }).catch(() => {
      if (fallbackToMedia && item.fileId) {
        img.src = teleDailyMediaUrl(item)
        img.classList.remove('hidden')
      }
    })
  } else if (fallbackToMedia && item.fileId) {
    img.src = teleDailyMediaUrl(item)
    img.classList.remove('hidden')
  }
}

function teleDailyMessageMedia (item) {
  if (!item || !item.fileId) return null
  const host = h('div', `tele-message-media tele-message-media--${item.type || 'file'}`)
  const url = teleDailyMediaUrl(item)

  if (item.type === 'photo' || item.type === 'gif' || item.type === 'sticker') {
    const img = h('img', 'tele-message-image')
    img.alt = item.name || ''
    img.loading = 'lazy'
    img.decoding = 'async'
    img.src = url
    host.appendChild(img)
    return host
  }

  if (item.type === 'video' || item.type === 'video_note') {
    const video = document.createElement('video')
    video.className = 'tele-message-video'
    video.controls = true
    video.playsInline = true
    video.preload = 'metadata'
    video.src = url
    if (item.thumbUrl) video.poster = '/dl' + item.thumbUrl
    else if (item.thumbFileId) {
      request('get-thumb', { fileId: item.thumbFileId }).then(data => {
        if (data && data.path) {
          item.thumbUrl = data.path
          video.poster = '/dl' + data.path
        }
      }).catch(() => {})
    }
    host.appendChild(video)
    return host
  }

  if (item.type === 'audio' || item.type === 'voice') {
    const audio = document.createElement('audio')
    audio.className = 'tele-message-audio'
    audio.controls = true
    audio.preload = 'none'
    audio.src = url
    host.appendChild(audio)
    return host
  }

  return null
}

/* Keep the complete media index out of state.messages. The previous rescue
 * layer merged tens of thousands of synthetic file rows into message history,
 * which could break history pagination and make Messages inherit Files state.
 */
filesItems = function teleDailyFilesItems () {
  let list
  if (state.files.mode === 'search') {
    list = state.files.results.slice()
  } else {
    const key = state.activeChatId == null ? null : rescueChatKey(state.activeChatId)
    const snapshot = key ? rescueFileCache.get(key) : null
    list = snapshot && Array.isArray(snapshot.items)
      ? snapshot.items.slice()
      : state.messages.filter(m => m && m.media).map(m => m.media)
  }

  const q = state.files.query.trim().toLowerCase()
  if (q) list = list.filter(it => (it.name || '').toLowerCase().includes(q) || (it.caption || '').toLowerCase().includes(q))
  if (state.files.filter !== 'all') list = list.filter(it => it.type === state.files.filter)

  const cmp = (a, b) => {
    const aa = BigInt(String(a.messageId || 0))
    const bb = BigInt(String(b.messageId || 0))
    return aa === bb ? 0 : (aa < bb ? -1 : 1)
  }
  list.sort((a, b) => cmp(b, a))
  return list
}

rescueApplyCompleteFiles = function teleDailyApplyCompleteFiles (chatId, snapshot) {
  if (!snapshot || !Array.isArray(snapshot.items)) return
  // state.mediaCount = snapshot.found == null ? snapshot.items.length : snapshot.found // REMOVED: owner is files-stability.js
  state.typeCounts = snapshot.typeCounts || null
}

/* `teleDailyMergeScanBatch` and its `handleEvent` wrapper are gone.
 *
 * It merged the item batches carried on `download-all-progress` - the legacy
 * "Download all media" scanner's event, emitted by `emitScan` in server.js - into
 * `rescueFileCache` and repainted from there, which made this file one of the writers
 * of the shared Files index. `public/files-stability.js` owns the index and merges the
 * `media-index-progress` stream instead; the download-all progress banner is still
 * handled by `app.js` `onScanProgress`, which is untouched. */

/* Clicking a selected card must not silently remove it. Normal click selects;
 * Ctrl/Cmd toggles; Shift extends from the last clicked item.
 */
const teleDailyBaseBuildGridCard = buildGridCard
buildGridCard = function teleDailyBuildGridCard (item) {
  const card = teleDailyBaseBuildGridCard(item)
  const key = `${item.chatId}:${item.messageId}`
  card.querySelectorAll('.file-preview-action').forEach(node => node.remove())

  const thumb = card.querySelector('.gthumb')
  if (thumb) {
    thumb.classList.add(`tele-file-thumb--${item.type || 'file'}`)
    if (item.type === 'video' || item.type === 'video_note') {
      const play = h('button', 'tele-inline-play', '▶')
      play.type = 'button'
      play.setAttribute('aria-label', `Play ${item.name || 'video'}`)
      play.onclick = e => {
        e.stopPropagation()
        const video = document.createElement('video')
        video.className = 'tele-file-inline-video'
        video.controls = true
        video.autoplay = true
        video.playsInline = true
        video.preload = 'metadata'
        video.src = teleDailyMediaUrl(item)
        thumb.innerHTML = ''
        thumb.appendChild(video)
      }
      thumb.appendChild(play)
    } else if (item.type === 'gif') {
      thumb.onclick = e => {
        e.stopPropagation()
        const img = thumb.querySelector('img')
        if (img && item.fileId && img.dataset.fullMedia !== '1') {
          img.dataset.fullMedia = '1'
          img.src = teleDailyMediaUrl(item)
        }
      }
    }
  }

  if (item.type === 'audio' || item.type === 'voice') {
    const body = card.querySelector('.gbody')
    if (body && item.fileId) {
      const audio = document.createElement('audio')
      audio.className = 'tele-file-audio'
      audio.controls = true
      audio.preload = 'none'
      audio.src = teleDailyMediaUrl(item)
      audio.onclick = e => e.stopPropagation()
      body.appendChild(audio)
    }
  }

  card.onclick = e => {
    if (e.target.closest('input,button,a,video,audio')) return
    const liveItem = itemByKey.get(key) || card._item || item
    const grid = $('#media-grid')

    if (e.shiftKey && lastClickedKey) {
      const a = cardIndexForKey(grid, lastClickedKey)
      const b = cardIndexForKey(grid, key)
      if (a >= 0 && b >= 0) selectRange(Math.min(a, b), Math.max(a, b), grid)
      return
    }

    if (e.ctrlKey || e.metaKey) {
      const on = !state.selection.has(key)
      if (on) state.selection.set(key, liveItem)
      else state.selection.delete(key)
      applyCardUI(key, on)
    } else if (!state.selection.has(key)) {
      state.selection.set(key, liveItem)
      applyCardUI(key, true)
    }

    lastClickedKey = key
    updateSelectionBar()
  }
  return card
}

const teleDailyBaseBuildMediaRow = buildMediaRow
buildMediaRow = function teleDailyBuildMediaRow (message, includeSelection = true) {
  const row = teleDailyBaseBuildMediaRow(message, includeSelection)
  row.querySelectorAll('.media-preview-action').forEach(node => node.remove())
  const item = message && message.media
  if (!item) return row

  const inline = teleDailyMessageMedia(item)
  if (inline) {
    row.classList.add('tele-media-row-inline')
    const oldThumb = row.querySelector('.thumb')
    const oldIcon = row.querySelector('.icon')
    if (oldThumb) oldThumb.remove()
    if (oldIcon) oldIcon.remove()
    row.insertBefore(inline, row.firstChild)
  }
  return row
}

function teleDailyCloseMessageMenus (except) {
  document.querySelectorAll('.tele-msg-menu').forEach(menu => {
    if (menu !== except) menu.classList.add('hidden')
  })
}

document.addEventListener('click', event => {
  if (!event.target.closest('.tele-msg-menu') && !event.target.closest('.tele-msg-more')) teleDailyCloseMessageMenus()
})

renderMessagesList = function teleDailyRenderMessagesList () {
  const list = $('#messages')
  if (!list) return
  list.innerHTML = ''
  const source = Array.isArray(state.messages) ? state.messages.slice(0, rescueMessageRenderLimit).reverse() : []
  let previousDay = null

  for (const m of source) {
    const day = teleDailyDayLabel(m.date)
    if (day !== previousDay) {
      list.appendChild(h('div', 'tele-date-separator', day))
      previousDay = day
    }

    const key = `${state.activeChatId}:${m.id}`
    const selected = state.selectedMessages.has(key)
    const msgEl = h('div', `msg ${m.outgoing ? 'outgoing' : 'incoming'}${selected ? ' tele-selected' : ''}`)
    msgEl.dataset.messageId = String(m.id)

    if (!m.outgoing && m.sender) msgEl.appendChild(h('div', 'msg-sender', m.sender))
    if (m.text) msgEl.appendChild(h('div', 'msg-text', m.text))
    if (m.media) msgEl.appendChild(buildMediaRow(m, false))

    const meta = h('div', 'tele-msg-meta')
    meta.appendChild(h('span', 'tele-msg-time', teleDailyTime12(m.date)))
    msgEl.appendChild(meta)

    const more = h('button', 'tele-msg-more', '⋮')
    more.type = 'button'
    more.setAttribute('aria-label', 'Message actions')
    const menu = h('div', 'tele-msg-menu hidden')
    const addAction = (label, fn, danger) => {
      const button = h('button', danger ? 'danger' : '', label)
      button.type = 'button'
      button.onclick = event => { event.stopPropagation(); menu.classList.add('hidden'); fn() }
      menu.appendChild(button)
    }
    addAction('Reply', () => { if (window.teleReplyToMessage) window.teleReplyToMessage(m) })
    if (m.outgoing && m.text) addAction('Edit', () => { if (window.teleEditMessage) window.teleEditMessage(m) })
    addAction('Delete', () => { if (window.teleDeleteMessage) window.teleDeleteMessage(m) }, true)
    more.onclick = event => {
      event.stopPropagation()
      const opening = menu.classList.contains('hidden')
      teleDailyCloseMessageMenus(menu)
      menu.classList.toggle('hidden', !opening)
    }
    msgEl.append(more, menu)

    const select = h('label', 'tele-msg-select')
    const checkbox = h('input', '')
    checkbox.type = 'checkbox'
    checkbox.checked = selected
    checkbox.setAttribute('aria-label', 'Select message')
    checkbox.onchange = () => {
      if (checkbox.checked) {
        state.selectedMessages.set(key, m)
        if (m.media) state.selection.set(key, m.media)
      } else {
        state.selectedMessages.delete(key)
        if (m.media) state.selection.delete(key)
      }
      msgEl.classList.toggle('tele-selected', checkbox.checked)
      updateSelectionBar()
    }
    select.appendChild(checkbox)
    msgEl.appendChild(select)

    msgEl.addEventListener('contextmenu', event => {
      event.preventDefault()
      teleDailyCloseMessageMenus(menu)
      menu.classList.remove('hidden')
    })
    list.appendChild(msgEl)
  }
}

/* Richer attachment tray. View-once remains visible when it applies to the
 * chosen media, but Telegram itself only accepts self-destruct media in private
 * chats; groups/channels show the control disabled with that reason.
 */
function teleDailyAttachmentUrl (file) {
  if (teleDailyAttachmentUrls.has(file)) return teleDailyAttachmentUrls.get(file)
  const url = URL.createObjectURL(file)
  teleDailyAttachmentUrls.set(file, url)
  return url
}

rescueRenderAttachments = function teleDailyRenderAttachments () {
  const preview = document.querySelector('#tele-attachment-preview')
  const list = document.querySelector('#tele-attachment-list')
  const oneTimeWrap = document.querySelector('#tele-one-time-wrap')
  const oneTime = document.querySelector('#tele-one-time')
  const clear = document.querySelector('#tele-attachment-clear')
  if (!preview || !list) return
  list.innerHTML = ''

  for (const [index, file] of rescueCompose.attachments.entries()) {
    const card = h('div', 'tele-upload-card')
    card.dataset.uploadIndex = String(index)
    const visual = h('div', 'tele-upload-visual')
    const mime = String(file.type || '').toLowerCase()
    const name = String(file.name || '').toLowerCase()
    if (mime.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/.test(name)) {
      const image = h('img', '')
      image.alt = ''
      image.src = teleDailyAttachmentUrl(file)
      visual.appendChild(image)
    } else if (mime.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv)$/.test(name)) {
      const video = document.createElement('video')
      video.muted = true
      video.playsInline = true
      video.preload = 'metadata'
      video.src = teleDailyAttachmentUrl(file)
      visual.appendChild(video)
      visual.appendChild(h('span', 'tele-upload-kind', 'Video'))
    } else {
      visual.innerHTML = rescueMediaTypeSvg(mime.startsWith('audio/') ? 'audio' : 'document')
    }

    const info = h('div', 'tele-upload-info')
    info.append(h('strong', '', file.name), h('span', 'tele-upload-meta', `${fmtSize(file.size)} · ${file.type || 'file'}`), h('span', 'tele-upload-state', 'Ready'))
    const remove = h('button', 'tele-upload-remove', '×')
    remove.type = 'button'
    remove.setAttribute('aria-label', `Remove ${file.name}`)
    remove.onclick = () => {
      const removed = rescueCompose.attachments[index]
      if (removed && teleDailyAttachmentUrls.has(removed)) {
        URL.revokeObjectURL(teleDailyAttachmentUrls.get(removed))
        teleDailyAttachmentUrls.delete(removed)
      }
      rescueCompose.attachments.splice(index, 1)
      rescueCompose.oneTime = false
      rescueRenderAttachments()
    }
    card.append(visual, info, remove)
    list.appendChild(card)
  }

  preview.classList.toggle('hidden', rescueCompose.attachments.length === 0)
  if (clear) clear.textContent = 'Clear all'

  const canUseType = rescueCompose.attachments.length === 1 && rescueAttachmentCanViewOnce(rescueCompose.attachments[0])
  const activeChat = state.chats.find(chat => String(chat.id) === String(state.activeChatId))
  const telegramAllows = !!(activeChat && activeChat.kind === 'private')
  if (oneTimeWrap) {
    oneTimeWrap.classList.toggle('hidden', !canUseType)
    oneTimeWrap.classList.toggle('disabled', canUseType && !telegramAllows)
    oneTimeWrap.title = canUseType && !telegramAllows ? 'Telegram supports View once only in private chats' : ''
    let hint = oneTimeWrap.querySelector('.tele-one-time-hint')
    if (canUseType && !telegramAllows) {
      if (!hint) {
        hint = h('small', 'tele-one-time-hint', 'Private chats only')
        oneTimeWrap.appendChild(hint)
      }
    } else if (hint) hint.remove()
  }
  if (oneTime) {
    oneTime.disabled = !telegramAllows || !canUseType
    if (oneTime.disabled) oneTime.checked = false
  }
  if (!telegramAllows || !canUseType) rescueCompose.oneTime = false
}

function teleDailySetUploadState (index, text, mode) {
  const card = document.querySelector(`.tele-upload-card[data-upload-index="${index}"]`)
  if (!card) return
  card.dataset.state = mode || ''
  const stateNode = card.querySelector('.tele-upload-state')
  if (stateNode) stateNode.textContent = text
}

rescueSendComposer = async function teleDailySendComposer () {
  const input = document.querySelector('#tele-compose-input')
  const send = document.querySelector('#tele-compose-send')
  if (!input || !send || state.activeChatId == null) return
  const text = input.value.trim()
  const attachments = rescueCompose.attachments.slice()
  if (!text && !attachments.length) return
  if (attachments.length && rescueCompose.editMessageId) return toast('Finish editing before attaching files', 'error')
  if (rescueCompose.oneTime && attachments.length !== 1) return toast('View once supports one photo or video at a time', 'error')

  send.disabled = true
  const oldLabel = send.textContent
  send.textContent = attachments.length ? `Send ${attachments.length}` : 'Sending…'
  try {
    if (rescueCompose.editMessageId) {
      await request('edit-chat-message', { chatId: state.activeChatId, messageId: rescueCompose.editMessageId, text })
      toastOk('Message edited')
    } else if (attachments.length) {
      for (let i = 0; i < attachments.length; i++) {
        const attachment = attachments[i]
        teleDailySetUploadState(i, `Sending ${i + 1} of ${attachments.length}…`, 'sending')
        send.textContent = attachments.length > 1 ? `Sending ${i + 1}/${attachments.length}` : 'Sending…'
        const headers = {
          'Content-Type': 'application/octet-stream',
          'X-File-Name': encodeURIComponent(attachment.name),
          'X-Mime-Type': encodeURIComponent(attachment.type || 'application/octet-stream'),
          'X-Caption': encodeURIComponent(i === 0 ? text.slice(0, 1024) : ''),
          'X-One-Time': rescueCompose.oneTime && i === 0 ? '1' : '0'
        }
        if (rescueCompose.replyTo && rescueCompose.replyTo.id != null && i === 0) headers['X-Reply-To'] = String(rescueCompose.replyTo.id)
        const response = await fetch(`/api/chat-attachment/${encodeURIComponent(state.activeChatId)}`, { method: 'POST', headers, body: attachment })
        const result = await response.json().catch(() => ({}))
        if (!response.ok) {
          teleDailySetUploadState(i, result.error || `Upload failed (${response.status})`, 'error')
          throw new Error(`${attachment.name}: ${result.error || `upload failed (${response.status})`}`)
        }
        teleDailySetUploadState(i, 'Sent', 'done')
      }
    } else {
      await request('send-chat-message', { chatId: state.activeChatId, text, replyToMessageId: rescueCompose.replyTo ? rescueCompose.replyTo.id : null })
    }
    input.value = ''
    input.style.height = 'auto'
    rescueClearAttachment()
    rescueClearComposeContext()
  } catch (e) {
    toast(e.message, 'error')
  } finally {
    send.disabled = false
    send.textContent = oldLabel
    input.focus()
  }
}

/* The old lightbox is deliberately retired. */
document.querySelector('#tele-preview-modal')?.remove()

const teleDailySendButton = document.querySelector('#tele-compose-send')
if (teleDailySendButton) teleDailySendButton.onclick = rescueSendComposer
