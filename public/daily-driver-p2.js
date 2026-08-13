'use strict'

/* Daily-driver P2 reliability pass.
 * - restore per-chat file indexes before legacy openChat can discard them
 * - retry Files hydration when Telegram/browser cache races
 * - stream thumbnails/avatars from TDLib cache, never the download folder
 * - keep the full dedupe report visible instead of truncating after 100 rows
 */

const teleP2FileInflight = new Map()
const teleP2AvatarFailures = new Set()

function teleP2Key (value) { return String(value) }

function teleP2ValidSnapshot (chatId, snapshot) {
  if (!snapshot || !Array.isArray(snapshot.items)) return false
  const key = teleP2Key(chatId)
  return snapshot.items.every(item => item && teleP2Key(item.chatId) === key)
}

function teleP2ApplySnapshot (chatId, snapshot, label) {
  if (!teleP2ValidSnapshot(chatId, snapshot)) return false
  const key = teleP2Key(chatId)
  rescueFileCache.set(key, snapshot)
  try { teleHotfixValidatedChats.add(key) } catch {}
  if (state.activeChatId != null && teleP2Key(state.activeChatId) === key && state.view === 'files') {
    rescueApplyCompleteFiles(chatId, snapshot)
    renderFiles()
    updateMediaCountLabel()
    if (label) setLoadState(label)
  }
  return true
}

async function teleP2ReadPersistentFiles (chatId) {
  try {
    const snapshot = await teleP0v2ReadIndex(chatId)
    if (!teleP2ValidSnapshot(chatId, snapshot)) return null
    teleP2ApplySnapshot(chatId, snapshot, `Cached ${snapshot.items.length.toLocaleString()} files`)
    return snapshot
  } catch { return null }
}

async function teleP2EnsureFilesReady (chatId, allowRetry = true) {
  if (chatId == null) return null
  const key = teleP2Key(chatId)
  const memory = rescueFileCache.get(key)
  if (teleP2ValidSnapshot(chatId, memory) && memory.done !== false) {
    teleP2ApplySnapshot(chatId, memory, `Loaded ${memory.items.length.toLocaleString()} files`)
    return memory
  }
  if (teleP2FileInflight.has(key)) return teleP2FileInflight.get(key)

  const work = (async () => {
    const persisted = await teleP2ReadPersistentFiles(chatId)
    if (persisted && persisted.done !== false) return persisted
    try {
      const data = await request('scan-media-v3', { chatId, force: false })
      const snapshot = {
        chatId,
        items: ((data && data.items) || []).filter(item => item && teleP2Key(item.chatId) === key),
        found: 0,
        scanned: Number((data && data.scanned) || 0),
        typeCounts: (data && data.typeCounts) || {},
        savedAt: Date.now(),
        done: data ? data.done !== false : true
      }
      snapshot.found = snapshot.items.length
      try { teleP1SortMediaItems(snapshot.items) } catch {}
      teleP2ApplySnapshot(chatId, snapshot, `Loaded ${snapshot.items.length.toLocaleString()} files`)
      if (snapshot.done) {
        try { await teleP0v2WriteIndex(chatId, snapshot) } catch {}
      }
      return snapshot
    } catch (error) {
      if (allowRetry) {
        await new Promise(resolve => setTimeout(resolve, 650))
        return teleP2EnsureFilesReady(chatId, false)
      }
      if (state.activeChatId != null && teleP2Key(state.activeChatId) === key && state.view === 'files') {
        setLoadState('Files did not load. Reopen Files to retry.')
      }
      throw error
    }
  })().finally(() => teleP2FileInflight.delete(key))

  teleP2FileInflight.set(key, work)
  return work
}

// P1 starts the IndexedDB restore asynchronously, while the older hotfix below
// it may delete an unvalidated memory snapshot. Resolve that race before the
// existing openChat stack executes.
const teleP2BaseOpenChat = openChat
openChat = async function teleP2OpenChat (chatId) {
  const key = teleP2Key(chatId)
  const memory = rescueFileCache.get(key)
  if (teleP2ValidSnapshot(chatId, memory)) {
    try { teleHotfixValidatedChats.add(key) } catch {}
  } else {
    await teleP2ReadPersistentFiles(chatId)
  }
  const result = await teleP2BaseOpenChat(chatId)
  if (state.view === 'files') teleP2EnsureFilesReady(chatId).catch(() => {})
  return result
}

const teleP2BaseSetView = setView
setView = function teleP2SetView (view) {
  const result = teleP2BaseSetView(view)
  if (view === 'files' && state.activeChatId != null) {
    teleP2EnsureFilesReady(state.activeChatId).catch(() => {})
  }
  return result
}

/* ------------------------------ Direct thumbnail streaming ------------------------------ */

function teleP2FileUrl (fileId, name, mime) {
  const params = new URLSearchParams()
  params.set('name', name || 'thumb.jpg')
  if (mime) params.set('mime', mime)
  return `/api/media-preview/${encodeURIComponent(String(fileId || 0))}?${params.toString()}`
}

loadThumb = function teleP2LoadThumb (img, item) {
  if (!img || !item || !item.thumbFileId) return
  const url = teleP2FileUrl(item.thumbFileId, 'thumb.jpg', 'image/jpeg')
  img.loading = 'lazy'
  img.decoding = 'async'
  img.onload = () => {
    img.classList.remove('hidden')
    const icon = img.previousElementSibling
    if (icon) icon.classList.add('hidden')
  }
  img.onerror = () => { img.removeAttribute('src') }
  img.src = url
}

try {
  teleHotfixThumbUrl = async function teleP2HotfixThumbUrl (item) {
    if (!item || !item.thumbFileId) return null
    return teleP2FileUrl(item.thumbFileId, 'thumb.jpg', 'image/jpeg')
  }
} catch {}

/* ------------------------------ Chat avatars ------------------------------ */

function teleP2Avatar (chat) {
  const av = h('div', 'chat-avatar')
  av.style.background = avatarColor(chat.title || '')
  const fallback = h('span', 'tele-p2-avatar-fallback', initials(chat.title || ''))
  av.appendChild(fallback)

  const fileId = Number(chat.photoFileId || 0)
  if (!fileId || teleP2AvatarFailures.has(fileId)) return av
  const img = document.createElement('img')
  img.className = 'tele-p2-avatar-img'
  img.alt = ''
  img.loading = 'lazy'
  img.decoding = 'async'
  img.onload = () => fallback.classList.add('hidden')
  img.onerror = () => {
    teleP2AvatarFailures.add(fileId)
    img.remove()
    fallback.classList.remove('hidden')
  }
  img.src = teleP2FileUrl(fileId, 'avatar.jpg', 'image/jpeg')
  av.appendChild(img)
  return av
}

function teleP2RenderChats () {
  const list = document.querySelector('#chat-list')
  const search = document.querySelector('#chat-search')
  const only = document.querySelector('#channels-only')
  if (!list || !search || !only) return
  list.innerHTML = ''
  const q = String(search.value || '').trim().toLowerCase()
  const channelsOnly = !!only.checked
  let shown = 0

  for (const chat of state.chats) {
    if (!chat) continue
    if (q && !String(chat.title || '').toLowerCase().includes(q) && !String(chat.username || '').toLowerCase().includes(q)) continue
    if (channelsOnly && chat.kind !== 'channel') continue
    shown++

    const li = h('li', 'chat-item' + (String(chat.id) === String(state.activeChatId) ? ' active' : ''))
    li.appendChild(teleP2Avatar(chat))
    const col = h('div', 'col')
    col.appendChild(h('div', 't', chat.title || 'Unknown'))
    const previewText = chat.username ? '@' + chat.username : (chat.lastText || '')
    if (previewText) {
      const preview = h('div', 'preview', previewText)
      preview.title = previewText
      col.appendChild(preview)
    }
    li.appendChild(col)
    const u = h('div', 'u', typeIcon[chat.kind] || '💬')
    if (chat.unread > 0) u.textContent += ` · ${chat.unread}`
    li.appendChild(u)
    li.onclick = () => openChat(chat.id)
    list.appendChild(li)
  }
  const count = document.querySelector('#chat-count')
  if (count) count.textContent = channelsOnly ? `${shown} channels` : `${state.chats.length} chats`
}

renderChats = teleP2RenderChats

// Replace the search node so no earlier captured legacy render callback can
// flash stale rows while the query is changing.
const teleP2Search = document.querySelector('#chat-search')
if (teleP2Search && !teleP2Search.dataset.p2Bound) {
  const replacement = teleP2Search.cloneNode(true)
  replacement.dataset.p2Bound = '1'
  teleP2Search.replaceWith(replacement)
  replacement.addEventListener('input', teleP2RenderChats)
}
teleP2RenderChats()

/* ------------------------------ Full dedupe report ------------------------------ */

const teleP2BaseDedupeReport = teleP1RenderDedupeReport
teleP1RenderDedupeReport = function teleP2RenderDedupeReport (report) {
  const promise = teleP2BaseDedupeReport(report)
  const list = document.querySelector('#tele-dedupe-body .tele-dedupe-list')
  if (!list) return promise

  const allRows = report && Array.isArray(report.duplicates) ? report.duplicates : []
  const existingRendered = list.querySelectorAll('.tele-dedupe-row').length
  const more = list.querySelector('.tele-dedupe-more')
  if (more) more.remove()

  for (const row of allRows.slice(existingRendered)) {
    const entry = document.createElement('div')
    entry.className = 'tele-dedupe-row'
    const left = document.createElement('div')
    left.className = 'tele-dedupe-row-main'
    const name = document.createElement('strong')
    name.textContent = row.fileName || 'file'
    const detail = document.createElement('span')
    detail.textContent = row.reason === 'existing'
      ? `${fmtSize(Number(row.fileSize || 0))} · ${row.relativePath || 'already in download folder'}`
      : `${fmtSize(Number(row.fileSize || 0))} · repeated in this selection`
    left.append(name, detail)
    const badge = document.createElement('span')
    badge.className = `tele-dedupe-badge ${row.reason === 'existing' ? 'existing' : 'selection'}`
    badge.textContent = row.reason === 'existing' ? 'On disk' : 'Repeated'
    entry.append(left, badge)
    list.appendChild(entry)
  }
  return promise
}
