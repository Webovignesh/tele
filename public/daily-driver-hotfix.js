'use strict'

/* Daily-driver acceptance hotfix v2.
 * Stable v2 UI, chat-scoped file indexes, non-destructive message state,
 * fast thumbnail-first preview, and consistent persisted file markings.
 */

function teleHotfixChatKey (chatId) { return String(chatId) }
const teleHotfixValidatedChats = new Set()

function teleHotfixSnapshotBelongsToChat (chatId, snapshot) {
  if (!snapshot || !Array.isArray(snapshot.items)) return false
  const wanted = teleHotfixChatKey(chatId)
  return snapshot.items.every(item => item && teleHotfixChatKey(item.chatId) === wanted)
}

/* `teleHotfixDropContaminatedSnapshot` is gone with its two callers. It dropped a
 * shared-cache entry whose items belonged to a different chat - a symptom of the old
 * `rescueApplyCompleteFiles`, which copied a whole file index into `state.messages`
 * and could leak one chat's index into the next. That copy stopped happening long ago
 * (see below), and the owner scopes every commit to its chat with `belongsToChat`. */

function teleHotfixSortFileItems (items) {
  return items.sort((a, b) => {
    const aa = BigInt(String((a && a.messageId) || 0))
    const bb = BigInt(String((b && b.messageId) || 0))
    return aa === bb ? 0 : (aa < bb ? 1 : -1)
  })
}

/* Critical isolation: the old rescueApplyCompleteFiles copied an entire file
 * index into state.messages. That made a previous 20k-file channel appear as
 * the next chat's file count and also polluted message history. File indexes
 * now stay in rescueFileCache only. */
rescueApplyCompleteFiles = function teleHotfixApplyFileSnapshot (chatId, snapshot) {
  if (!snapshot || !Array.isArray(snapshot.items)) return
  if (!teleHotfixSnapshotBelongsToChat(chatId, snapshot)) return
  // state.mediaCount = snapshot.items.length // REMOVED: owner is files-stability.js
  state.typeCounts = snapshot.typeCounts || null
}

/* Files view now reads only the active chat's scoped index. Message history is
 * never used as the canonical whole-chat file source. */
filesItems = function teleHotfixFilesItems () {
  let list
  if (state.files.mode === 'search') {
    list = state.files.results.slice()
  } else {
    const key = state.activeChatId == null ? null : teleHotfixChatKey(state.activeChatId)
    const snapshot = key ? rescueFileCache.get(key) : null
    list = snapshot && teleHotfixSnapshotBelongsToChat(state.activeChatId, snapshot)
      ? snapshot.items.slice()
      : []
  }

  const q = String(state.files.query || '').trim().toLowerCase()
  if (q) list = list.filter(it => (it.name || '').toLowerCase().includes(q) || (it.caption || '').toLowerCase().includes(q))
  if (state.files.filter !== 'all') list = list.filter(it => it.type === state.files.filter)

  const compareIds = (a, b) => {
    const aa = BigInt(String((a && a.messageId) || 0))
    const bb = BigInt(String((b && b.messageId) || 0))
    return aa === bb ? 0 : (aa < bb ? -1 : 1)
  }
  switch (state.files.sort) {
    case 'oldest': list.sort(compareIds); break
    case 'name': list.sort((a, b) => (a.name || '').localeCompare(b.name || '')); break
    case 'size': list.sort((a, b) => (b.fileSize || 0) - (a.fileSize || 0)); break
    default: list.sort((a, b) => compareIds(b, a))
  }
  return list
}

function teleHotfixUpdateScopedMediaLabel () {
  const key = state.activeChatId == null ? null : teleHotfixChatKey(state.activeChatId)
  const snapshot = key ? rescueFileCache.get(key) : null
  const valid = snapshot && teleHotfixSnapshotBelongsToChat(state.activeChatId, snapshot)
  const count = valid ? snapshot.items.length : 0
  const label = document.querySelector('#chat-media-count')
  if (label) {
    if (state.activeChatId == null) label.textContent = ''
    else if (!valid && state.view === 'files') label.textContent = 'Loading files…'
    else if (valid) label.textContent = `${count.toLocaleString()} file${count === 1 ? '' : 's'}`
    else label.textContent = ''
  }
  const downloadAll = document.querySelector('#download-all-media')
  if (downloadAll) {
    downloadAll.textContent = valid ? `Download all media (${count.toLocaleString()})` : 'Download all media'
    downloadAll.disabled = !valid || count === 0
  }
  const selectAll = document.querySelector('#select-all-media')
  if (selectAll) {
    selectAll.textContent = valid ? `Select all (${count.toLocaleString()})` : 'Select all'
    selectAll.disabled = !valid || count === 0
  }
}
rescueUpdateMediaLabel = teleHotfixUpdateScopedMediaLabel
updateMediaCountLabel = teleHotfixUpdateScopedMediaLabel

/* The `openChat` index handling is gone, and with it `teleHotfixApplyProgress`, the
 * `media-index-progress` wrapper and this layer's `rescueEnsureAllFiles` override.
 *
 * The removal worth explaining is the `rescueFileCache.delete(key)` this wrapper did
 * for any chat not yet validated in the current page session. It was there to stop an
 * unvalidated whole-chat count showing on first entry, but it discarded the restored
 * index of a chat whose record had just been read by another layer, forcing a rescan -
 * which is precisely the race `daily-driver-p2.js` then added more code to work
 * around. With one owner there is no unvalidated count to hide: `files-stability.js`
 * paints only what it has committed, and its `isCompleteSnapshot` decides
 * completeness.
 *
 * Kept: `teleHotfixSortFileItems` and `teleHotfixValidatedChats` (other layers call
 * and read them), `teleHotfixSnapshotBelongsToChat`, the count label, the preview
 * modal and the thumbnail helpers. */
const teleHotfixBaseOpenChat = openChat
openChat = async function teleHotfixOpenChat (chatId) {
  const result = await teleHotfixBaseOpenChat(chatId)
  teleHotfixUpdateScopedMediaLabel()
  return result
}

function teleHotfixMediaUrl (item, retryToken) {
  const params = new URLSearchParams()
  params.set('name', String((item && item.name) || 'file'))
  if (item && item.mime) params.set('mime', String(item.mime))
  if (item && item.chatId != null) params.set('chatId', String(item.chatId))
  if (item && item.messageId != null) params.set('messageId', String(item.messageId))
  if (retryToken) params.set('retry', String(retryToken))
  return `/api/media-preview/${encodeURIComponent(item && item.fileId != null ? item.fileId : 0)}?${params.toString()}`
}

async function teleHotfixThumbUrl (item) {
  if (!item) return null
  if (item.thumbUrl) return '/dl' + item.thumbUrl
  if (!item.thumbFileId) return null
  try {
    const data = await request('get-thumb', { fileId: item.thumbFileId })
    if (!data || !data.path) return null
    item.thumbUrl = data.path
    return '/dl' + data.path
  } catch { return null }
}

function teleHotfixPreviewModal () {
  let modal = document.querySelector('#tele-hotfix-preview')
  if (modal) return modal
  modal = document.createElement('div')
  modal.id = 'tele-hotfix-preview'
  modal.className = 'tele-hotfix-preview hidden'
  modal.innerHTML = `
    <div class="tele-hotfix-preview-shell" role="dialog" aria-modal="true">
      <header><div><strong id="tele-hotfix-preview-title">Media</strong><span id="tele-hotfix-preview-meta"></span></div><button id="tele-hotfix-preview-close" class="ghost small" type="button" aria-label="Close">×</button></header>
      <main id="tele-hotfix-preview-body"></main>
    </div>`
  document.body.appendChild(modal)
  const close = () => {
    modal.classList.add('hidden')
    const body = modal.querySelector('#tele-hotfix-preview-body')
    body.querySelectorAll('video,audio').forEach(media => { try { media.pause() } catch {}; media.removeAttribute('src'); try { media.load() } catch {} })
    body.innerHTML = ''
  }
  modal.querySelector('#tele-hotfix-preview-close').onclick = close
  modal.addEventListener('mousedown', event => { if (event.target === modal) close() })
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !modal.classList.contains('hidden')) close() })
  return modal
}

rescuePreviewFile = async function teleHotfixPreviewFile (item) {
  if (!item || !item.fileId) return toast('This Telegram file is not available yet', 'error')
  const modal = teleHotfixPreviewModal()
  const body = modal.querySelector('#tele-hotfix-preview-body')
  modal.querySelector('#tele-hotfix-preview-title').textContent = item.name || 'Media'
  modal.querySelector('#tele-hotfix-preview-meta').textContent = `${String(item.type || 'file').replace('_', ' ')} · ${fmtSize(item.fileSize || 0)}`
  body.innerHTML = '<div class="tele-hotfix-preview-state">Opening media…</div>'
  modal.classList.remove('hidden')

  const url = teleHotfixMediaUrl(item)
  const thumb = await teleHotfixThumbUrl(item)
  let node
  if (item.type === 'photo' || item.type === 'gif' || item.type === 'sticker') {
    node = document.createElement('img')
    node.alt = item.name || ''
    if (thumb) {
      node.src = thumb
      body.innerHTML = ''
      body.appendChild(node)
    }
    const full = new Image()
    full.alt = node.alt
    full.onload = () => { if (!modal.classList.contains('hidden')) { body.innerHTML = ''; body.appendChild(full) } }
    full.onerror = () => {
      if (thumb) return
      body.innerHTML = '<div class="tele-hotfix-preview-state">Could not open this image. Try again or download the original.</div>'
    }
    full.src = url
    return
  }

  if (item.type === 'video' || item.type === 'video_note') {
    node = document.createElement('video')
    node.controls = true
    node.autoplay = false
    node.playsInline = true
    node.preload = 'metadata'
    if (thumb) node.poster = thumb
    body.innerHTML = ''
    body.appendChild(node)
    node.src = url
    node.load()
    node.onerror = () => {
      body.innerHTML = '<div class="tele-hotfix-preview-state">This video could not be streamed in the browser. Download the original if its codec is unsupported.</div>'
    }
    return
  }

  if (item.type === 'audio' || item.type === 'voice') {
    node = document.createElement('audio')
    node.controls = true
    node.preload = 'metadata'
    body.innerHTML = ''
    body.appendChild(node)
    node.src = url
    return
  }

  body.innerHTML = '<div class="tele-hotfix-preview-state">This file type has no browser preview. Use Download selected.</div>'
}

const teleHotfixBaseBuildGridCard = buildGridCard
buildGridCard = function teleHotfixBuildGridCard (item) {
  const card = teleHotfixBaseBuildGridCard(item)
  const thumb = card.querySelector('.gthumb')
  if (thumb) {
    thumb.style.cursor = 'pointer'
    thumb.title = item.type === 'video' || item.type === 'video_note' ? 'Play video' : 'Open preview'
    thumb.onclick = event => { event.stopPropagation(); rescuePreviewFile(item) }
  }
  return card
}

const teleHotfixBaseBuildMediaRow = buildMediaRow
buildMediaRow = function teleHotfixBuildMediaRow (message, includeSelection = true) {
  const row = teleHotfixBaseBuildMediaRow(message, includeSelection)
  if (message && message.media) {
    const mediaHost = row.querySelector('.thumb, img, video, .icon')
    if (mediaHost) {
      mediaHost.style.cursor = 'pointer'
      mediaHost.onclick = event => { event.stopPropagation(); rescuePreviewFile(message.media) }
    }
  }
  return row
}

/* Capture selected keys before the legacy Unmark handler clears selection. */
let teleHotfixUnmarkKeys = []
const teleHotfixUnmark = document.querySelector('#unmark-completed')
if (teleHotfixUnmark) {
  teleHotfixUnmark.addEventListener('click', () => {
    teleHotfixUnmarkKeys = [...new Set([...state.selection.keys(), ...state.selectedMessages.keys()].map(String))]
  }, true)
  teleHotfixUnmark.addEventListener('click', () => {
    queueMicrotask(() => {
      for (const key of teleHotfixUnmarkKeys) rescueDownloadedMarks.delete(key)
      rescueSaveMarkSet('tele-downloaded-files-v1', rescueDownloadedMarks)
      teleHotfixUnmarkKeys = []
      if (state.view === 'files') renderFiles()
    })
  })
}
