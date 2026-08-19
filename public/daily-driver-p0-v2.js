'use strict'

/* P0 v2: safe browser-refresh cache + search + preview + attachment progress.
 * Loaded after the stable rescue/hotfix layers. The experimental v3 runtime
 * remains isolated.
 */

const teleP0v2Upload = new WeakMap()

function teleP0v2Key (value) { return String(value) }

/* THE PERSISTENCE BOUNDARY THAT DISCARDED LEGITIMATE SHRINKS WAS HERE.
 *
 * `teleP0v2DbName`, `teleP0v2Store`, `teleP0v2Db`, `teleP0v2ReadIndex`,
 * `teleP0v2WriteIndex`, `teleP0v2PersistTimers`, `teleP0v2PersistSoon`,
 * `teleP0v2ValidSnapshot`, `teleP0v2PaintIndex`, `teleP0v2Sync`, the
 * `rescueEnsureAllFiles` override and the `media-index-progress` branch of this file's
 * `handleEvent` wrapper are all removed.
 *
 * `teleP0v2WriteIndex` opened with:
 *
 *     if (!options.allowShrink) {
 *       const existing = await teleP0v2ReadIndex(chatId)
 *       const storedCount = existing ? existing.items.length : 0
 *       if (storedCount > snapshot.items.length) return
 *     }
 *
 * and no production caller anywhere in the repository passed `allowShrink` - the flag
 * appeared only in this file and in `scripts/files-invariants.test.cjs`, which asserted
 * that the guard existed. Ten call sites across nine files routed every prune through
 * this function, so a prune that emptied the list on screen returned before writing and
 * the next `restore()` unioned the untouched record straight back in. Proven in the
 * page against the real record: a 0-item write left `{"items":22}` unchanged, and the
 * same write with `allowShrink: true` produced `{"items":0}`.
 *
 * The rule itself was not wrong, it was in the wrong place. Growth was never the case
 * it needed to refuse, so as a size check at the storage boundary it could not tell a
 * partial scan from a truthful shrink, and it therefore refused both. The protection
 * has moved to where the decision is actually made, in `public/files-stability.js`:
 * `commitDiscovery` unions, so it cannot lower a count no matter what a partial scan
 * reports, and `commitAuthoritative` - reachable only from a complete, accessible truth
 * pass - may lower it, to zero if that is what Telegram says. Its `writePersistent`
 * contains no count comparison at all, which `scripts/files-reconcile.test.cjs` asserts.
 *
 * Kept in this file: the search rebind, the unified media viewer
 * (`rescuePreviewFile`), the grid card hook and the attachment/composer code. */

/* app.js captured its original renderChats function when it registered the
 * search listener. Replace only the input DOM node to drop that obsolete
 * listener, then bind the live rescue renderer. */
function teleP0v2BindSearch () {
  const old = document.querySelector('#chat-search')
  if (!old || old.dataset.teleP0v2 === '1') return
  const next = old.cloneNode(true)
  next.value = old.value
  next.dataset.teleP0v2 = '1'
  old.replaceWith(next)
  next.addEventListener('input', () => renderChats())
  next.addEventListener('search', () => renderChats())
}
teleP0v2BindSearch()

/* The `handleEvent` wrapper is gone with its only branch. It scheduled a persist on
 * `media-index-progress`, reading the shared cache and writing it through the boundary
 * above, so it was a fifth writer of the persistent record on the progress stream.
 * `public/files-stability.js` persists from its own commit paths. */

/* ---------- Unified media viewer ---------- */
function teleP0v2PreviewFailure (body, item, message) {
  body.innerHTML = ''
  const box = h('div', 'tele-p0-preview-error')
  box.append(h('strong', '', 'Could not play this media'), h('span', 'muted', message || 'Telegram could not prepare the file.'))
  const actions = h('div', 'tele-p0-preview-actions')
  const retry = h('button', 'ghost', 'Retry')
  retry.type = 'button'
  retry.onclick = () => rescuePreviewFile(item)
  const download = h('button', 'ghost', 'Download original')
  download.type = 'button'
  download.onclick = () => startDownloads([item])
  actions.append(retry, download)
  box.appendChild(actions)
  body.appendChild(box)
}

rescuePreviewFile = async function teleP0v2PreviewFile (item) {
  if (!item || !item.fileId) return toast('This Telegram file is not available yet', 'error')
  const modal = teleHotfixPreviewModal()
  const body = modal.querySelector('#tele-hotfix-preview-body')
  modal.querySelector('#tele-hotfix-preview-title').textContent = item.name || 'Media'
  modal.querySelector('#tele-hotfix-preview-meta').textContent = `${String(item.type || 'file').replace('_', ' ')} · ${fmtSize(item.fileSize || 0)}`
  body.innerHTML = '<div class="tele-hotfix-preview-state">Opening…</div>'
  modal.classList.remove('hidden')

  const thumb = await teleHotfixThumbUrl(item)
  const mediaUrl = teleHotfixMediaUrl(item, Date.now())

  if (['photo', 'gif', 'sticker'].includes(item.type)) {
    if (thumb) {
      const low = new Image()
      low.className = 'tele-p0-preview-image is-thumb'
      low.alt = item.name || ''
      low.src = thumb
      body.innerHTML = ''
      body.appendChild(low)
    }
    const image = new Image()
    image.className = 'tele-p0-preview-image'
    image.alt = item.name || ''
    image.onload = () => { if (!modal.classList.contains('hidden')) { body.innerHTML = ''; body.appendChild(image) } }
    image.onerror = () => { if (!thumb) teleP0v2PreviewFailure(body, item, 'Image preview failed.') }
    image.src = mediaUrl
    return
  }

  if (item.type === 'video' || item.type === 'video_note') {
    const shell = h('div', 'tele-p0-video-shell')
    const video = document.createElement('video')
    video.className = 'tele-p0-preview-video'
    video.controls = true
    video.playsInline = true
    video.preload = 'auto'
    if (thumb) video.poster = thumb
    const status = h('div', 'tele-p0-video-status', 'Preparing video…')
    shell.append(video, status)
    body.innerHTML = ''
    body.appendChild(shell)
    video.addEventListener('loadedmetadata', () => { status.textContent = 'Ready' }, { once: true })
    video.addEventListener('canplay', () => { status.remove(); video.play().catch(() => {}) }, { once: true })
    video.addEventListener('error', () => teleP0v2PreviewFailure(body, item, 'The file could not be streamed or Chrome does not support its codec.'))
    video.src = mediaUrl
    video.load()
    return
  }

  if (item.type === 'audio' || item.type === 'voice') {
    const audio = document.createElement('audio')
    audio.className = 'tele-p0-preview-audio'
    audio.controls = true
    audio.autoplay = true
    audio.preload = 'auto'
    audio.onerror = () => teleP0v2PreviewFailure(body, item, 'Audio preview failed.')
    body.innerHTML = ''
    body.appendChild(audio)
    audio.src = mediaUrl
    return
  }

  teleP0v2PreviewFailure(body, item, 'This file type has no browser preview.')
}

const teleP0v2BaseBuildGridCard = buildGridCard
buildGridCard = function teleP0v2BuildGridCard (item) {
  const card = teleP0v2BaseBuildGridCard(item)
  const thumb = card.querySelector('.gthumb')
  if (thumb) {
    thumb.setAttribute('role', 'button')
    thumb.tabIndex = 0
    thumb.onclick = event => { event.stopPropagation(); rescuePreviewFile(item) }
    thumb.onkeydown = event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        event.stopPropagation()
        rescuePreviewFile(item)
      }
    }
  }
  return card
}

/* ---------- Attachment queue ---------- */
function teleP0v2UploadState (file) {
  let value = teleP0v2Upload.get(file)
  if (!value) { value = { phase: 'ready', percent: 0, error: '' }; teleP0v2Upload.set(file, value) }
  return value
}
function teleP0v2FileKind (file) {
  const type = String(file && file.type || '')
  if (type.startsWith('image/')) return 'Image'
  if (type.startsWith('video/')) return 'Video'
  if (type.startsWith('audio/')) return 'Audio'
  return 'File'
}

rescueRenderAttachments = function teleP0v2RenderAttachments () {
  const preview = document.querySelector('#tele-attachment-preview')
  const list = document.querySelector('#tele-attachment-list')
  const oneTimeWrap = document.querySelector('#tele-one-time-wrap')
  if (!preview || !list) return
  list.innerHTML = ''
  rescueCompose.attachments.forEach((file, index) => {
    const upload = teleP0v2UploadState(file)
    const row = h('div', `tele-p0-attachment ${upload.phase === 'error' ? 'is-error' : ''}`)
    row.appendChild(h('div', 'tele-p0-attachment-icon', teleP0v2FileKind(file)))
    const body = h('div', 'tele-p0-attachment-body')
    const top = h('div', 'tele-p0-attachment-top')
    top.append(h('strong', 'tele-p0-attachment-name', file.name), h('span', 'tele-p0-attachment-size', fmtSize(file.size)))
    const status = h('div', `tele-p0-attachment-status ${upload.phase}`)
    status.textContent = upload.phase === 'uploading' ? `Uploading ${Math.round(upload.percent)}%`
      : upload.phase === 'telegram' ? 'Sending to Telegram…'
        : upload.phase === 'sent' ? 'Sent'
          : upload.phase === 'error' ? (upload.error || 'Failed') : 'Ready to send'
    const track = h('div', 'tele-p0-upload-track')
    const fill = h('div', 'tele-p0-upload-fill')
    fill.style.width = `${Math.max(0, Math.min(100, upload.percent || 0))}%`
    track.appendChild(fill)
    body.append(top, status, track)
    const remove = h('button', 'ghost small tele-p0-attachment-remove', '×')
    remove.type = 'button'
    remove.disabled = upload.phase === 'uploading' || upload.phase === 'telegram'
    remove.onclick = () => { rescueCompose.attachments.splice(index, 1); rescueCompose.oneTime = false; rescueRenderAttachments() }
    row.append(body, remove)
    list.appendChild(row)
  })
  preview.classList.toggle('hidden', rescueCompose.attachments.length === 0)
  const activeChat = state.chats.find(chat => String(chat.id) === String(state.activeChatId))
  const canViewOnce = rescueCompose.attachments.length === 1 && activeChat && activeChat.kind === 'private' && rescueAttachmentCanViewOnce(rescueCompose.attachments[0])
  if (oneTimeWrap) oneTimeWrap.classList.toggle('hidden', !canViewOnce)
  if (!canViewOnce) {
    rescueCompose.oneTime = false
    const checkbox = document.querySelector('#tele-one-time')
    if (checkbox) checkbox.checked = false
  }
}

function teleP0v2UploadFile (file, headers, progress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `/api/chat-attachment/${encodeURIComponent(state.activeChatId)}`)
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value)
    xhr.upload.onprogress = event => { if (event.lengthComputable) progress(Math.min(100, event.loaded / event.total * 100), false) }
    xhr.upload.onload = () => progress(100, true)
    xhr.onerror = () => reject(new Error(`${file.name}: browser upload failed`))
    xhr.onabort = () => reject(new Error(`${file.name}: upload cancelled`))
    xhr.onload = () => {
      let data = {}
      try { data = JSON.parse(xhr.responseText || '{}') } catch {}
      if (xhr.status < 200 || xhr.status >= 300) return reject(new Error(`${file.name}: ${data.error || `upload failed (${xhr.status})`}`))
      resolve(data)
    }
    xhr.send(file)
  })
}

rescueSendComposer = async function teleP0v2SendComposer () {
  const input = document.querySelector('#tele-compose-input')
  const send = document.querySelector('#tele-compose-send')
  if (!input || !send || state.activeChatId == null) return
  const text = input.value.trim()
  const attachments = rescueCompose.attachments.slice()
  if (!text && !attachments.length) return
  if (attachments.length && rescueCompose.editMessageId) return toast('Finish editing before attaching files', 'error')
  if (rescueCompose.oneTime && attachments.length !== 1) return toast('View once supports one photo or video at a time', 'error')

  send.disabled = true
  try {
    if (rescueCompose.editMessageId) {
      send.textContent = 'Saving…'
      await request('edit-chat-message', { chatId: state.activeChatId, messageId: rescueCompose.editMessageId, text })
    } else if (attachments.length) {
      for (let index = 0; index < attachments.length; index++) {
        const file = attachments[index]
        const upload = teleP0v2UploadState(file)
        upload.phase = 'uploading'; upload.percent = 0; upload.error = ''
        rescueRenderAttachments()
        const headers = {
          'Content-Type': 'application/octet-stream',
          'X-File-Name': encodeURIComponent(file.name),
          'X-Mime-Type': encodeURIComponent(file.type || 'application/octet-stream'),
          'X-Caption': encodeURIComponent(index === 0 ? text.slice(0, 1024) : ''),
          'X-One-Time': rescueCompose.oneTime && index === 0 ? '1' : '0'
        }
        if (rescueCompose.replyTo && rescueCompose.replyTo.id != null && index === 0) headers['X-Reply-To'] = String(rescueCompose.replyTo.id)
        try {
          await teleP0v2UploadFile(file, headers, (percent, bodyDone) => {
            upload.percent = percent
            upload.phase = bodyDone ? 'telegram' : 'uploading'
            send.textContent = bodyDone ? `Telegram ${index + 1}/${attachments.length}` : `Uploading ${Math.round(percent)}%`
            rescueRenderAttachments()
          })
          upload.percent = 100; upload.phase = 'sent'; rescueRenderAttachments()
        } catch (error) {
          upload.phase = 'error'; upload.error = String(error && error.message ? error.message : error); rescueRenderAttachments(); throw error
        }
      }
    } else {
      send.textContent = 'Sending…'
      await request('send-chat-message', { chatId: state.activeChatId, text, replyToMessageId: rescueCompose.replyTo ? rescueCompose.replyTo.id : null })
    }
    input.value = ''
    input.style.height = 'auto'
    if (attachments.length) await new Promise(resolve => setTimeout(resolve, 300))
    rescueClearAttachment()
    rescueClearComposeContext()
  } catch (error) {
    toast(String(error && error.message ? error.message : error), 'error')
  } finally {
    send.disabled = false
    send.textContent = 'Send'
    input.focus()
  }
}
const teleP0v2SendButton = document.querySelector('#tele-compose-send')
if (teleP0v2SendButton) teleP0v2SendButton.onclick = () => rescueSendComposer()

/* `teleP0v2RefreshPath` was here, with an `#dl-dir` input listener, a `#set-dir`
 * click listener, a 1500 ms interval and an initial call. It copied `#dl-dir.value`
 * into `#dl-dir-current` and stripped app.js's `Saving to: ` prefix, which is why the
 * baseline observed the bare path on that line rather than what `setDirLabel`
 * actually wrote: this interval overwrote it four times a second... and both nodes it
 * addressed have been deleted. `setDirLabel` in app.js is the only painter now. */
