'use strict'

/* ------------------------------ State ------------------------------ */
const state = {
  status: 'loading',
  chats: [],
  activeChatId: null,
  messages: [],
  selection: new Map(), // key `${chatId}:${messageId}` -> item
  selectedMessages: new Map(), // key `${chatId}:${messageId}` -> full message for Forward
  downloads: new Map(), // jobId -> job (a PROJECTION of the server queue, not the queue)
  // Authoritative queue aggregate from the server. state.downloads only holds
  // jobs the server has emitted (i.e. roughly the active workers plus finished
  // ones), so it must never be used to derive Total/Remaining.
  queueStats: null,
  prevSpeed: new Map(),
  samples: new Map(), // jobId -> [{time, downloaded}] for speed smoothing
  hasMore: true,
  loadingMore: false,
  view: 'files', // 'files' | 'messages'
  mediaCount: null,
  typeCounts: null,
  counting: false,
  concurrency: 16,
  scan: { active: false, mode: null },
  packActive: false,
  files: {
    query: '',
    filter: 'all',
    sort: 'newest',
    mode: 'browse', // 'browse' | 'search'
    results: [],
    totalCount: 0,
    hasMore: false,
    fromMessageId: 0,
    searching: false,
    loadingAll: false
  }
}

let ws = null
const pending = new Map()
let nextId = 1
const completed = new Set() // key `${chatId}:${messageId}` of files marked as completed
loadCompleted()
try { if (localStorage.getItem('tele-channels-only') === '1') $('#channels-only').checked = true } catch {}
const typeIcon = { private: '👤', group: '👥', supergroup: '👥', channel: '📢' }
const mediaIcon = { photo: '🖼️', video: '🎬', gif: '🎞️', document: '📄', audio: '🎵', voice: '🎙️', video_note: '🎥', sticker: '🎴' }
const typeLabel = { document: 'docs', photo: 'photos', video: 'videos', gif: 'gifs', audio: 'audio', voice: 'voice', video_note: 'notes', sticker: 'stickers' }

/* ------------------------------ WS plumbing ------------------------------ */

function connect () {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  ws = new WebSocket(`${proto}://${location.host}`)

  ws.onopen = () => request('get-status').then(applyStatus).catch(() => {})
  ws.onclose = () => setTimeout(connect, 1500)
  ws.onerror = () => ws.close()

  ws.onmessage = (e) => {
    let msg
    try { msg = JSON.parse(e.data) } catch { return }
    if (msg.type === 'response') {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      msg.ok ? p.resolve(msg.data) : p.reject(new Error(msg.error))
      return
    }
    if (msg.type === 'event') handleEvent(msg.event)
  }
}

function request (type, payload = {}) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error('Disconnected'))
    const id = nextId++
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, type, payload }))
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('Request timed out')) } }, 120000)
  })
}

/* ------------------------------ Helpers ------------------------------ */

function $(sel) { return document.querySelector(sel) }
function h(tag, cls, text) {
  const el = document.createElement(tag)
  if (cls) el.className = cls
  if (text !== undefined) el.textContent = text
  return el
}

function fmtSize (n) {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`
}

function fmtSpeed (n) { return `${fmtSize(n)}/s` }

/* Upper bound matters as much as the lower one. With only the isFinite/<=0 guards
 * a near-zero speed produced "ETA 13772h 50m", "ETA 560780h 25m" and, once the
 * value passed 1e21 and JS switched to exponential notation,
 * "ETA 4.997042705591493e+33h 21m". Anything beyond a day is not a useful
 * estimate, so it is reported as an unknown rather than a fabricated number. */
const ETA_MAX_SECONDS = 24 * 3600

function fmtEta (sec) {
  if (!isFinite(sec) || sec <= 0) return ''
  if (sec > ETA_MAX_SECONDS) return ''
  sec = Math.round(sec)
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`
}

function fmtDate (ts) { return new Date(ts * 1000).toLocaleDateString() }

function avatarColor (title) {
  let hash = 0
  for (const ch of title) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  const hues = [210, 160, 90, 280, 20, 50, 120, 340]
  return `hsl(${hues[hash % hues.length]}, 55%, 42%)`
}

function initials (title) {
  const parts = title.split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase()
}

let toastTimer = null
function toast (msg, type) {
  const t = $('#toast')
  t.textContent = msg
  t.className = type ? type : ''
  void t.offsetWidth
  t.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.classList.remove('show'), 3500)
}

function toastOk (msg) { toast(msg, 'ok') }

function escapeHtml (s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function debounce (fn, ms) {
  let t
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) }
}

/* ------------------------------ Event handling ------------------------------ */

function handleEvent (ev) {
  switch (ev.name) {
    case 'auth':
      state.status = ev.payload.status
      if (ev.payload.me) $('#user-name').textContent = ev.payload.me.name || ev.payload.me.username || 'you'
      showScreen('main')
      loadChats()
      break
    case 'login-prompt':
      showLoginPrompt(ev.kind, ev.info)
      break
    case 'download-update':
      upsertDownload(ev.job)
      break
    case 'download-stats':
      state.queueStats = ev.stats || null
      renderDownloads()
      break
    case 'download-done':
      upsertDownload(ev.job)
      markCompleted(`${ev.job.chatId}:${ev.job.messageId}`)
      setCardCompleted(`${ev.job.chatId}:${ev.job.messageId}`, true)
      break
    case 'download-all-progress':
      onScanProgress(ev.payload)
      break
    case 'download-all-error':
      hideScanBanner()
      toast(ev.error)
      break
    case 'error':
      toast(ev.error)
      break
    case 'settings-changed':
      setDirLabel(ev.downloadsDir)
      break
    case 'chat-upsert':
      upsertChat(ev.chat)
      break
    case 'chat-remove':
      removeChat(ev.chatId)
      break
    case 'forward-done':
      toastOk(`Forwarded ${(ev.payload.forwarded || []).length} message(s) to ${ev.payload.destination && ev.payload.destination.title ? ev.payload.destination.title : 'destination'}`)
      break
    case 'pack-progress':
      onPackProgress(ev.payload)
      break
    case 'pack-done':
      onPackDone(ev.payload)
      break
    case 'pack-error':
      hidePackBanner()
      toast(ev.error)
      break
  }
}

/* The ONE painter for the Save-to control.
 *
 * Six routines used to write this area: this one, `restoreDownloadDirHint` in
 * auth-state-fix.js, `teleP0v2RefreshPath` in daily-driver-p0-v2.js on a 1500 ms
 * interval, `installDownloadIcons` in filegram-shell.js (which set the text to
 * "Browse"), `paintFolderButton` in uploads-hardening.js behind a MutationObserver
 * plus a 25 ms interval, and file-consistency-v2.js, which clone-replaced the node
 * every 500 ms. Whichever ran last won, and the winner changed with load order, so
 * the rendered control did not correspond to any one layer's intent. The other five
 * are gone.
 *
 * The full path goes in `title` for the tooltip; the accessible name comes from the
 * label and path text. `auth-state-fix.js` wraps this to persist the value, so it
 * stays the single write point for both the DOM and localStorage. */
function setDirLabel (dir) {
  const value = String(dir == null ? '' : dir).trim()
  if (!value) return
  const button = $('#set-dir')
  const path = $('#dl-dir-path')
  if (path) path.textContent = value
  if (button) {
    button.title = value
    button.dataset.fgFolderPath = value
  }
}

/* Runtime script report.
 *
 * Prints one `[FileGram runtime]` line per loaded script comparing the bytes this
 * browser holds for it against the file on disk, plus the server's build id, pid
 * and start time. This exists because `?v=` tokens on this branch are reused
 * across content changes: the browser can keep executing an older copy of a
 * changed file, so a code fix can be entirely invisible in the UI. Nothing about
 * behaviour should be judged until this report says the executing bytes match the
 * working tree and the build id matches the checkout. It reads only; it changes no
 * behaviour. */
const runtimeReported = new Set()

async function reportRuntimeScripts (status) {
  if (runtimeReported.size === 0) {
    console.info(`[FileGram runtime] server pid=${status && status.serverPid} buildId=${status && status.buildId} buildIdSource=${status && status.buildIdSource} startedAt=${status && status.serverStartedAt}`)
  }
  try {
    const res = await fetch('/api/filegram/asset-hashes', { cache: 'no-store' })
    const disk = await res.json()
    if (!disk || !disk.ok) return
    if (status && status.buildId && disk.buildId && status.buildId !== disk.buildId) {
      console.warn(`[FileGram runtime] build id mismatch: get-status=${status.buildId} asset-hashes=${disk.buildId}`)
    }
    const timings = new Map()
    try {
      for (const entry of performance.getEntriesByType('resource')) {
        if (entry.initiatorType === 'script') timings.set(entry.name, entry)
      }
    } catch {}
    const sources = [...document.scripts].map(s => s.src).filter(Boolean)
    for (const src of sources) {
      if (runtimeReported.has(src)) continue
      runtimeReported.add(src)
      const url = new URL(src, location.href)
      const name = url.pathname.replace(/^\/+/, '')
      const token = url.search.replace(/^\?/, '') || 'none'
      const expected = disk.assets && disk.assets[name]
      if (!expected) {
        console.info(`[FileGram runtime] script=${name} token=${token} servedMatchesDisk=unknown (not a public/ script)`)
        continue
      }
      let match = 'unknown'
      let bytes = null
      try {
        /* cache: 'default' on purpose. A no-store fetch would always pull fresh
         * bytes from the server and could never observe the stale copy this check
         * exists to catch, so the request has to be allowed to hit the same HTTP
         * cache entry the <script> tag used. */
        const body = await fetch(url.href, { cache: 'default' }).then(r => r.arrayBuffer())
        bytes = body.byteLength
        const digest = await crypto.subtle.digest('SHA-256', body)
        const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
        match = hex === expected.sha256 ? 'yes' : 'no'
      } catch (e) {
        match = `error:${e && e.message ? e.message : e}`
      }
      const entry = timings.get(url.href)
      const cached = entry ? (entry.transferSize === 0 ? 'yes' : 'no') : 'unknown'
      console.info(`[FileGram runtime] script=${name} token=${token} servedMatchesDisk=${match} bytes=${bytes} diskBytes=${expected.bytes} fromBrowserCache=${cached}`)
    }
  } catch (e) {
    console.warn('[FileGram runtime] report failed', e)
  }
}

function applyStatus (data) {
  /* Deliberately not awaited: the report is diagnostic and must not delay boot.
   * Run twice because five scripts (files-stability, files-view, bulk-uploads,
   * uploads-hardening, file-consistency-v2) are appended dynamically and are not
   * in document.scripts yet on the first pass. Already-reported sources are
   * skipped, so the second pass only adds the late arrivals. */
  reportRuntimeScripts(data)
  setTimeout(() => reportRuntimeScripts(data), 6000)
  state.concurrency = data.concurrency || 8
  $('#concurrency').value = state.concurrency
  $('#concurrency-val').textContent = state.concurrency
  setDirLabel(data.downloadsDir)
  request('get-downloads', {}).then(d => {
    for (const job of d.jobs || []) state.downloads.set(job.jobId, job)
    if (d.stats) state.queueStats = d.stats
    state.concurrency = d.concurrency || state.concurrency
    $('#concurrency').value = state.concurrency
    $('#concurrency-val').textContent = state.concurrency
    renderDownloads()
  }).catch(() => {})
  if (data.status === 'need-config') showScreen('config')
  else if (data.status === 'ready') { state.status = 'ready'; showScreen('main'); loadChats() }
  else showScreen('login')
}

function showScreen (name) {
  for (const s of ['config', 'login', 'main']) {
    $(`#${s}-screen`).classList.toggle('hidden', s !== name)
  }
}

/* ------------------------------ Login UI ------------------------------ */

function showLoginPrompt (kind, info) {
  showScreen('login')
  const input = $('#login-input')
  const hint = $('#login-hint')
  const btn = $('#login-submit')
  const err = $('#login-error')
  err.textContent = ''
  hint.dataset.kind = kind
  input.classList.remove('hidden')
  btn.classList.remove('hidden')
  document.querySelectorAll('.other-device-link').forEach(l => l.remove())

  if (kind === 'phone') {
    hint.textContent = 'Enter your phone number in international format (e.g. +15551234567):'
    input.type = 'tel'
    input.placeholder = '+15551234567'
    input.value = ''
  } else if (kind === 'code') {
    const rawType = info && info.type
    const typeStr = rawType && typeof rawType === 'object' ? (rawType._ || rawType['@type'] || '') : String(rawType || '')
    const typeLabel = typeStr ? ` (${typeStr.replace(/^authenticationCodeType/i, '').replace(/([A-Z])/g, ' $1').trim()})` : ''
    hint.textContent = `Enter the login code sent to your Telegram${typeLabel}:`
    input.type = 'text'
    input.placeholder = '12345'
    input.value = ''
  } else if (kind === 'password') {
    hint.textContent = info && info.password_hint
      ? `Enter your 2-step verification password. Hint: ${info.password_hint}`
      : 'This account has 2-step verification enabled. Enter your password:'
    input.type = 'password'
    input.placeholder = 'Password'
    input.value = ''
  } else if (kind === 'other-device') {
    hint.textContent = 'Confirm login on another device:'
    input.classList.add('hidden')
    btn.classList.add('hidden')
    const link = h('a', 'other-device-link', info.link)
    link.href = info.link
    link.target = '_blank'
    link.rel = 'noopener'
    document.querySelector('#login-screen .card').querySelector('#login-hint').after(link)
    return
  } else if (kind === 'registration') {
    hint.textContent = 'This account is not registered yet. Enter a first name to register:'
    input.type = 'text'
    input.placeholder = 'First name'
    input.value = ''
  }
  input.focus()
}

function submitLoginInput () {
  const kind = $('#login-hint').dataset.kind
  const value = $('#login-input').value.trim()
  if (!value) return
  $('#login-submit').disabled = true
  $('#login-error').textContent = ''
  request('login-input', { kind, value })
    .then(() => {})
    .catch(e => {
      $('#login-error').textContent = e.message
      $('#login-input').value = ''
      $('#login-submit').disabled = false
    })
}

/* ------------------------------ Chats ------------------------------ */

function renderChats () {
  const list = $('#chat-list')
  list.innerHTML = ''
  const q = $('#chat-search').value.toLowerCase()
  const channelsOnly = $('#channels-only').checked
  let shown = 0
  for (const chat of state.chats) {
    if (q && !chat.title.toLowerCase().includes(q)) continue
    if (channelsOnly && chat.kind !== 'channel') continue
    shown++
    const li = h('li', 'chat-item' + (chat.id === state.activeChatId ? ' active' : ''))
    const av = h('div', 'chat-avatar')
    av.style.background = avatarColor(chat.title)
    av.textContent = initials(chat.title)
    li.appendChild(av)
    const col = h('div', 'col')
    col.appendChild(h('div', 't', chat.title))
    const identity = chat.username ? '@' + chat.username : (chat.lastText || '')
    if (identity) {
      const preview = h('div', 'preview', identity)
      preview.title = identity
      col.appendChild(preview)
    }
    li.appendChild(col)
    const u = h('div', 'u', typeIcon[chat.kind] || '💬')
    if (chat.unread > 0) u.textContent += ` · ${chat.unread}`
    li.appendChild(u)
    li.onclick = () => openChat(chat.id)
    list.appendChild(li)
  }
  $('#chat-count').textContent = channelsOnly ? `${shown} channels` : `${state.chats.length} chats`
}

function removeChat (chatId) {
  const wasActive = String(state.activeChatId) === String(chatId)
  state.chats = state.chats.filter(c => String(c.id) !== String(chatId))
  if (wasActive) {
    state.activeChatId = null
    state.messages = []
    state.selection.clear()
    state.selectedMessages.clear()
    $('#chat-title').textContent = 'Select a chat'
    $('#messages').innerHTML = ''
    $('#media-grid').innerHTML = ''
  }
  renderChats()
  updateSelectionBar()
}

function upsertChat (chat) {
  if (!chat || chat.id == null) return
  if (chat.lastMessage && chat.lastMessage._ === 'messageText') chat.lastText = chat.lastMessage.text?.text || ''
  const index = state.chats.findIndex(c => String(c.id) === String(chat.id))
  if (index >= 0) state.chats[index] = { ...state.chats[index], ...chat }
  else state.chats.unshift(chat)
  state.chats.sort((a, b) => String(a.order || '0') < String(b.order || '0') ? 1 : -1)
  renderChats()
}

async function loadChats () {
  try {
    const data = await request('get-chats')
    state.chats = data.chats
    state.chats.forEach(c => { if (c.lastMessage && c.lastMessage._ === 'messageText') c.lastText = c.lastMessage.text?.text || '' })
    renderChats()
  } catch (e) { toast(e.message, 'error') }
}

async function loadMoreChats () {
  const el = $('#chat-loading')
  if (el.dataset.loading) return
  el.dataset.loading = '1'
  el.textContent = 'Loading more chats…'
  try {
    const data = await request('get-chats-more')
    const seen = new Set(state.chats.map(c => c.id))
    for (const c of data.chats) {
      if (!seen.has(c.id)) { state.chats.push(c); if (c.lastMessage && c.lastMessage._ === 'messageText') c.lastText = c.lastMessage.text?.text || '' }
    }
    renderChats()
  } catch (e) { toast(e.message, 'error') } finally {
    delete el.dataset.loading
    el.textContent = ''
  }
}

/* ------------------------------ View switching ------------------------------ */

function setView (v) {
  state.view = v
  $('#tab-files').classList.toggle('active', v === 'files')
  $('#tab-messages').classList.toggle('active', v === 'messages')
  $('#files-toolbar').classList.toggle('hidden', v !== 'files')
  $('#messages').classList.toggle('hidden', v !== 'messages')
  $('#media-grid').classList.toggle('hidden', v !== 'files')
  $('#search-banner').classList.toggle('hidden', !(v === 'files' && state.files.mode === 'search'))
  if (v === 'files' && $('#media-grid').children.length === 0) renderFiles()
  if (v === 'messages' && $('#messages').children.length === 0) renderMessagesList()
}

/* ------------------------------ Messages / Files loading ------------------------------ */

async function openChat (chatId) {
  state.activeChatId = chatId
  state.messages = []
  state.selection.clear()
  state.selectedMessages.clear()
  state.hasMore = true
  // state.mediaCount = null // REMOVED: owner is files-stability.js
  state.typeCounts = null
  state.counting = false
  state.files = { query: '', filter: 'all', sort: 'newest', mode: 'browse', results: [], totalCount: 0, hasMore: false, fromMessageId: 0, searching: false, loadingAll: false }
  $('#file-search').value = ''
  $('#file-filter').value = 'all'
  $('#file-sort').value = 'newest'
  updateSelectionBar()
  renderChats()

  const chat = state.chats.find(c => c.id === chatId)
  $('#chat-title').textContent = chat ? chat.title : 'Chat'
  $('#messages').innerHTML = ''
  $('#media-grid').innerHTML = ''
  updateMediaCountLabel()
  setLoadState('')
  setView('files')

  await loadMessages(chatId)
  loadAllFiles(chatId)
}

async function loadMessages (chatId, fromMessageId) {
  if (state.loadingMore) return
  state.loadingMore = true
  const panel = state.view === 'files' ? $('#media-grid') : $('#messages')
  const firstLoad = state.messages.length === 0
  const prevPosFromBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight
  setLoadState('loading')
  try {
    const oldest = state.messages[state.messages.length - 1]
    const data = await request('get-messages', {
      chatId,
      fromMessageId: fromMessageId || (oldest ? oldest.id : 0),
      limit: 100
    })
    const seen = new Set(state.messages.map(m => m.key))
    let added = 0
    for (const m of data.messages) {
      const key = `${chatId}:${m.id}`
      if (seen.has(key)) continue
      seen.add(key)
      state.messages.push({ ...m, key })
      added++
    }
    state.messages.sort((a, b) => (String(a.id) < String(b.id) ? 1 : -1))
    state.hasMore = data.hasMore

    if (state.view === 'files') renderFiles()
    else renderMessagesList()

    if (firstLoad) panel.scrollTop = 0
    else {
      requestAnimationFrame(() => {
        panel.scrollTop = Math.max(0, panel.scrollHeight - prevPosFromBottom - panel.clientHeight)
      })
    }
    if (!added && !state.hasMore) setLoadState('End of history')
    else setLoadState('')
  } catch (e) {
    toast(e.message, 'error')
    setLoadState('Failed to load. Scroll to retry.')
  } finally {
    state.loadingMore = false
  }
}

function renderMessagesList () {
  const list = $('#messages')
  list.innerHTML = ''
  for (const m of [...state.messages].reverse()) {
    const msgEl = h('div', 'msg' + (m.outgoing ? ' outgoing' : ' incoming'))
    const head = h('div', 'msg-head')
    head.appendChild(h('span', 'msg-sender', m.sender || 'Unknown'))
    head.appendChild(h('span', 'msg-date', new Date(m.date * 1000).toLocaleString()))
    msgEl.appendChild(head)
    if (m.text) msgEl.appendChild(h('div', 'msg-text', m.text))
    if (m.media) msgEl.appendChild(buildMediaRow(m, false))
    const actions = h('div', 'msg-actions')
    const reply = h('button', 'ghost small', 'Reply')
    reply.type = 'button'
    reply.onclick = (e) => { e.stopPropagation(); if (window.teleReplyToMessage) window.teleReplyToMessage(m) }
    actions.appendChild(reply)
    if (m.outgoing && m.text) {
      const edit = h('button', 'ghost small', 'Edit')
      edit.type = 'button'
      edit.onclick = (e) => { e.stopPropagation(); if (window.teleEditMessage) window.teleEditMessage(m) }
      actions.appendChild(edit)
    }
    const del = h('button', 'ghost small danger-outline', 'Delete')
    del.type = 'button'
    del.onclick = (e) => { e.stopPropagation(); if (window.teleDeleteMessage) window.teleDeleteMessage(m) }
    actions.appendChild(del)
    msgEl.appendChild(actions)
    const select = h('label', 'msg-select')
    const cb = h('input', '')
    cb.type = 'checkbox'
    const key = `${state.activeChatId}:${m.id}`
    cb.checked = state.selectedMessages.has(key)
    cb.onchange = () => {
      if (cb.checked) {
        state.selectedMessages.set(key, m)
        if (m.media) state.selection.set(key, m.media)
      } else {
        state.selectedMessages.delete(key)
        if (m.media) state.selection.delete(key)
      }
      updateSelectionBar()
    }
    select.appendChild(cb)
    select.appendChild(document.createTextNode(' Select'))
    msgEl.appendChild(select)
    list.appendChild(msgEl)
  }
}

/* ------------------------------ Files view ------------------------------ */

function filesItems () {
  let list
  if (state.files.mode === 'search') {
    list = state.files.results.slice()
  } else {
    list = state.messages.filter(m => m.media).map(m => m.media)
  }
  const q = state.files.query.trim().toLowerCase()
  if (q) {
    list = list.filter(it => (it.name || '').toLowerCase().includes(q) || (it.caption || '').toLowerCase().includes(q))
  }
  if (state.files.filter !== 'all') {
    list = list.filter(it => it.type === state.files.filter)
  }
  const cmp = (a, b) => (String(a.messageId) < String(b.messageId) ? -1 : 1)
  switch (state.files.sort) {
    case 'oldest': list.sort(cmp); break
    case 'name': list.sort((a, b) => (a.name || '').localeCompare(b.name || '')); break
    case 'size': list.sort((a, b) => (b.fileSize || 0) - (a.fileSize || 0)); break
    default: list.sort((a, b) => cmp(b, a))
  }
  return list
}

function renderFiles () {
  const grid = $('#media-grid')
  const items = filesItems()
  grid.innerHTML = ''
  for (const it of items) grid.appendChild(buildGridCard(it))
  $('#select-all-media').textContent = items.length ? `Select all (${items.length})` : 'Select all'
  $('#select-all-media').disabled = items.length === 0
}

function buildGridCard (item) {
  const key = `${item.chatId}:${item.messageId}`
  itemByKey.set(key, item)
  const card = h('div', 'gcard')
  card._item = item
  card.dataset.key = key
  if (isCompleted(key)) card.classList.add('completed')
  if (state.selection.has(key)) card.classList.add('selected')
  const wrap = h('div', 'gthumb')
  wrap.appendChild(h('div', 'icon', mediaIcon[item.type] || '📎'))
  const img = h('img', 'hidden')
  img.alt = ''
  wrap.appendChild(img)
  card.appendChild(wrap)
  if (isCompleted(key)) card.appendChild(h('div', 'done-badge', '✓'))
  const body = h('div', 'gbody')
  const name = h('div', 'gname', item.name || 'file')
  name.title = item.name || 'file'
  body.appendChild(name)
  const sizes = h('div', 'gsize', fmtSize(item.fileSize || 0))
  if (item.date) sizes.textContent += ` · ${fmtDate(item.date)}`
  body.appendChild(sizes)
  card.appendChild(body)
  card.appendChild(h('div', 'gtype', item.type))
  card.appendChild(makeCheckbox(item))
  loadThumb(img, item)
  card.onclick = (e) => {
    if (e.target.type === 'checkbox') return
    const key = card.dataset.key
    const item = itemByKey.get(key) || card._item
    if (e.shiftKey && lastClickedKey) {
      const grid = $('#media-grid')
      const a = cardIndexForKey(grid, lastClickedKey)
      const b = cardIndexForKey(grid, key)
      if (a >= 0 && b >= 0) selectRange(Math.min(a, b), Math.max(a, b), grid)
      return
    }
    const on = !state.selection.has(key)
    if (on && item) state.selection.set(key, item)
    else state.selection.delete(key)
    applyCardUI(key, on)
    lastClickedKey = key
    updateSelectionBar()
  }
  return card
}

function buildMediaRow (m, includeSelection = true) {
  const media = m.media
  const row = h('div', 'media')
  row.appendChild(h('div', 'icon', mediaIcon[media.type] || '📎'))

  const img = h('img', 'thumb hidden')
  img.alt = ''
  row.appendChild(img)

  const meta = h('div', 'meta')
  const name = h('div', 'name', media.name || 'file')
  name.title = media.name || 'file'
  meta.appendChild(name)
  const size = h('div', 'size')
  size.appendChild(h('span', '', fmtSize(media.fileSize || 0)))
  size.appendChild(h('span', 'type-badge', media.type))
  meta.appendChild(size)
  if (media.caption) meta.appendChild(h('div', 'msg-caption', escapeHtml(media.caption)))
  row.appendChild(meta)

  if (includeSelection) row.appendChild(makeCheckbox(media))
  loadThumb(img, media)
  return row
}

function makeCheckbox (item) {
  const cb = h('input', '')
  cb.type = 'checkbox'
  const key = `${item.chatId}:${item.messageId}`
  cb.dataset.key = key
  cb.checked = state.selection.has(key)
  cb.onchange = () => {
    if (cb.checked) state.selection.set(key, item)
    else state.selection.delete(key)
    applyCardUI(key, cb.checked)
    lastClickedKey = key
    updateSelectionBar()
  }
  return cb
}

function loadThumb (imgEl, item) {
  if (item.thumbUrl) {
    imgEl.src = '/dl' + item.thumbUrl
    imgEl.classList.remove('hidden')
    if (imgEl.previousSibling) imgEl.previousSibling.classList.add('hidden')
    return
  }
  if (!item.thumbFileId) return
  request('get-thumb', { fileId: item.thumbFileId })
    .then(data => {
      if (data.path) {
        item.thumbUrl = data.path
        imgEl.src = '/dl' + data.path
        imgEl.classList.remove('hidden')
        if (imgEl.previousSibling) imgEl.previousSibling.classList.add('hidden')
      }
    })
    .catch(() => {})
}

function setLoadState (text) {
  const el = $('#load-state')
  el.textContent = text
  el.classList.toggle('spinner', text === 'loading')
}

/* ------------------------------ File count ------------------------------ */

async function loadAllFiles (chatId) {
  if (chatId !== state.activeChatId) return
  state.counting = true
  state.files.loadingAll = true
  updateMediaCountLabel()
  setLoadState('loading')
  try {
    const data = await request('scan-media', { chatId, includeItems: true })
    if (chatId !== state.activeChatId) return
    if (data.busy) { setTimeout(() => loadAllFiles(chatId), 3000); return }
    // state.mediaCount = data.found // REMOVED: owner is files-stability.js
    state.typeCounts = data.typeCounts
    state.counting = false
    if (data.items && data.items.length) {
      const seen = new Set(state.messages.map(m => m.key))
      for (const it of data.items) {
        if (!seen.has(it.key)) {
          seen.add(it.key)
          state.messages.push({ ...it, id: it.messageId, media: it })
        }
      }
      state.messages.sort((a, b) => (String(a.id) < String(b.id) ? 1 : -1))
      state.hasMore = false
    }
    updateMediaCountLabel()
    renderFiles()
    if (state.files.mode !== 'search') {
      setLoadState(state.messages.length ? `Loaded all ${state.messages.length} files` : 'End of history')
    }
  } catch (e) {
    if (chatId === state.activeChatId) {
      state.counting = false
      setLoadState('Failed to load all files. Scroll to load more.')
      toast(e.message, 'error')
    }
  } finally {
    if (chatId === state.activeChatId) state.files.loadingAll = false
  }
}

function updateMediaCountLabel () {
  const el = $('#chat-media-count')
  if (state.counting) { el.textContent = 'counting files…'; return }
  if (state.mediaCount == null) { el.textContent = ''; return }
  const parts = []
  if (state.typeCounts) {
    for (const [k, v] of Object.entries(state.typeCounts)) {
      if (v && typeLabel[k]) parts.push(`${v} ${typeLabel[k]}`)
    }
  }
  el.textContent = parts.length
    ? `${state.mediaCount} files · ${parts.join(' · ')}`
    : `${state.mediaCount} files`
  $('#download-all-media').textContent = `Download all media (${state.mediaCount})`
  $('#download-all-media').disabled = false
}

/* ------------------------------ Search ------------------------------ */

function updateSearchBanner () {
  const banner = $('#search-banner')
  if (state.files.mode === 'search') {
    banner.classList.remove('hidden')
    $('#search-banner-text').textContent = `Searching whole chat: ${state.files.totalCount} match${state.files.totalCount === 1 ? '' : 'es'} for "${state.files.query}"`
  } else {
    banner.classList.add('hidden')
  }
}

async function searchWholeChat () {
  const q = state.files.query.trim()
  if (!q || !state.activeChatId) return
  state.files.mode = 'search'
  state.files.results = []
  state.files.totalCount = 0
  state.files.hasMore = true
  state.files.fromMessageId = 0
  updateSearchBanner()
  renderFiles()
  await loadSearchMore()
}

async function loadSearchMore () {
  if (state.files.searching) return
  state.files.searching = true
  try {
    const data = await request('search-media', {
      chatId: state.activeChatId,
      query: state.files.query,
      fromMessageId: state.files.fromMessageId,
      limit: 100,
      filter: state.files.filter
    })
    const seen = new Set(state.files.results.map(r => r.key))
    for (const it of data.items) {
      if (!seen.has(it.key)) { state.files.results.push(it); seen.add(it.key) }
    }
    state.files.totalCount = data.totalCount
    state.files.hasMore = data.hasMore
    if (data.items.length) state.files.fromMessageId = data.items[data.items.length - 1].messageId
    renderFiles()
    updateSearchBanner()
  } catch (e) {
    toast(e.message, 'error')
  } finally {
    state.files.searching = false
  }
}

/* ------------------------------ Selection / bulk actions ------------------------------ */

function updateSelectionBar () {
  const messageForwardCount = selectedForwardIds().length
  const count = state.selection.size
  $('#selection-count').textContent = `${count} selected`
  $('#selection-bar').classList.toggle('hidden', count === 0 && messageForwardCount === 0)
  const forwardBtn = $('#forward-selected')
  if (forwardBtn) {
    forwardBtn.disabled = messageForwardCount === 0
    forwardBtn.textContent = messageForwardCount ? `Forward (${messageForwardCount})` : 'Forward'
  }
}

function selectAllMedia () {
  const items = state.view === 'files' ? filesItems() : state.messages.filter(m => m.media).map(m => m.media)
  const keys = items.map(it => `${it.chatId}:${it.messageId}`)
  const allSelected = keys.length && keys.every(k => state.selection.has(k))
  state.selection.clear()
  if (!allSelected) for (const it of items) state.selection.set(`${it.chatId}:${it.messageId}`, it)
  const checkboxes = document.querySelectorAll('#media-grid input[type=checkbox], #messages input[type=checkbox]')
  for (const cb of checkboxes) cb.checked = state.selection.has(cb.dataset.key)
  updateSelectionBar()
}

/* ------------------------------ Selection helpers ------------------------------
 * Drag-to-select was removed. Selection is checkbox, click, shift-click range,
 * Select all and the numeric range tools. itemByKey keeps selection independent
 * of DOM state, which matters because only the current page is mounted.
 */

let lastClickedKey = null
const itemByKey = new Map() // key -> item, kept in sync so selection never depends on DOM state

function cardIndexForKey (grid, key) {
  const cards = grid.children
  for (let i = 0; i < cards.length; i++) {
    if (cards[i].dataset && cards[i].dataset.key === key) return i
  }
  return -1
}

function applyCardUI (key, on) {
  if (!key) return
  const card = document.querySelector(`#media-grid .gcard[data-key="${key}"]`)
  if (!card) return
  card.classList.toggle('selected', on)
  const cb = card.querySelector('input[type=checkbox]')
  if (cb) cb.checked = on
}

function selectRange (lo, hi, grid) {
  const cards = grid.children
  for (let i = lo; i <= hi && i < cards.length; i++) {
    const card = cards[i]
    if (!card.dataset || !card.dataset.key) continue
    const item = itemByKey.get(card.dataset.key) || card._item
    if (item) state.selection.set(card.dataset.key, item)
    applyCardUI(card.dataset.key, true)
  }
  updateSelectionBar()
}

/* ------------------------------ Completed files ------------------------------ */

function loadCompleted () {
  completed.clear()
  try {
    const raw = localStorage.getItem('tele-completed')
    if (raw) for (const k of JSON.parse(raw)) completed.add(String(k))
  } catch {}
}

function saveCompleted () {
  try { localStorage.setItem('tele-completed', JSON.stringify([...completed])) } catch {}
}

function isCompleted (key) { return completed.has(key) }

function markCompleted (key) {
  if (!key) return
  completed.add(key)
  saveCompleted()
}

function setCardCompleted (key, done) {
  const card = document.querySelector(`#media-grid .gcard[data-key="${key}"]`)
  if (!card) return
  card.classList.toggle('completed', done)
  let badge = card.querySelector('.done-badge')
  if (done && !badge) {
    badge = h('div', 'done-badge', '✓')
    const thumb = card.querySelector('.gthumb')
    if (thumb) thumb.insertAdjacentElement('afterend', badge)
    else card.appendChild(badge)
  } else if (!done && badge) {
    badge.remove()
  }
}

function markSelectedCompleted () {
  const keys = [...state.selection.keys()]
  for (const key of keys) markCompleted(key)
  state.selection.clear()
  for (const cb of document.querySelectorAll('#media-grid input[type=checkbox], #messages input[type=checkbox]')) cb.checked = false
  updateSelectionBar()
  for (const key of keys) setCardCompleted(key, true)
  toast(`Marked ${completed.size} total files as completed`)
}

function unmarkSelectedCompleted () {
  let n = 0
  const keys = [...state.selection.keys()]
  for (const key of keys) {
    if (completed.has(key)) { completed.delete(key); n++ }
  }
  saveCompleted()
  state.selection.clear()
  for (const cb of document.querySelectorAll('#media-grid input[type=checkbox], #messages input[type=checkbox]')) cb.checked = false
  updateSelectionBar()
  for (const key of keys) setCardCompleted(key, false)
  toast(n ? `Unmarked ${n} files` : 'No completed files in selection')
}

function selectedForwardIds () {
  const ids = []
  const seen = new Set()
  for (const item of state.selectedMessages.values()) {
    const id = String(item.id || item.messageId || '')
    if (id && !seen.has(id)) { seen.add(id); ids.push(id) }
  }
  for (const item of state.selection.values()) {
    const id = String(item.messageId || item.id || '')
    if (id && !seen.has(id)) { seen.add(id); ids.push(id) }
  }
  return ids
}

async function searchForwardDestinations (query = '') {
  return request('search-destinations', { query, excludeChatId: state.activeChatId })
}

function ensureForwardModal () {
  let modal = $('#forward-modal')
  if (modal) return modal
  modal = h('div', 'forward-modal hidden')
  modal.id = 'forward-modal'
  modal.innerHTML = `<div class="forward-dialog">
    <div class="forward-head"><div><strong>Forward messages</strong><div id="forward-summary" class="small muted"></div></div><button id="forward-close" class="ghost small">✕</button></div>
    <input id="forward-search" type="search" placeholder="Search chats or @username…" autocomplete="off">
    <div id="forward-results" class="forward-results"></div>
  </div>`
  document.body.appendChild(modal)
  $('#forward-close').onclick = closeForwardModal
  modal.addEventListener('mousedown', e => { if (e.target === modal) closeForwardModal() })
  $('#forward-search').addEventListener('input', debounce(() => loadForwardDestinations($('#forward-search').value), 180))
  return modal
}

function closeForwardModal () {
  const modal = $('#forward-modal')
  if (modal) modal.classList.add('hidden')
}

async function sendForwardTo (chat) {
  const messageIds = selectedForwardIds()
  try {
    const result = await request('forward-messages', {
      sourceChatId: state.activeChatId,
      messageIds,
      destination: { chatId: chat.id }
    })
    const forwarded = (result.forwarded || []).length
    const skipped = (result.skipped || []).length
    state.selectedMessages.clear()
    state.selection.clear()
    closeForwardModal()
    updateSelectionBar()
    renderMessagesList()
    renderFiles()
    toastOk(`Forwarded ${forwarded} message(s) to ${chat.title}${skipped ? ` · ${skipped} skipped` : ''}`)
  } catch (e) { toast(e.message, 'error') }
}

async function loadForwardDestinations (query = '') {
  const results = $('#forward-results')
  if (!results) return
  results.innerHTML = '<div class="forward-loading">Loading chats…</div>'
  try {
    const data = await searchForwardDestinations(query)
    results.innerHTML = ''
    for (const chat of data.chats || []) {
      const row = h('button', 'forward-chat')
      row.type = 'button'
      const av = h('span', 'forward-avatar', initials(chat.title))
      av.style.background = avatarColor(chat.title)
      const body = h('span', 'forward-chat-body')
      body.appendChild(h('span', 'forward-chat-title', chat.title))
      const meta = chat.username ? '@' + chat.username : (chat.kind || 'chat')
      body.appendChild(h('span', 'forward-chat-meta', meta))
      row.append(av, body)
      row.onclick = () => sendForwardTo(chat)
      results.appendChild(row)
    }
    if (!results.children.length) results.appendChild(h('div', 'forward-loading', 'No matching chats'))
  } catch (e) {
    results.innerHTML = ''
    results.appendChild(h('div', 'forward-loading', e.message))
  }
}

async function forwardSelectedMessages () {
  if (!state.activeChatId) return
  const messageIds = selectedForwardIds()
  if (!messageIds.length) return toast('Select one or more messages first', 'error')
  const modal = ensureForwardModal()
  $('#forward-summary').textContent = `${messageIds.length} selected message${messageIds.length === 1 ? '' : 's'}`
  $('#forward-search').value = ''
  modal.classList.remove('hidden')
  $('#forward-search').focus()
  await loadForwardDestinations('')
}

async function startDownloads (items) {
  const todo = items.filter(i => !isCompleted(`${state.activeChatId}:${i.messageId}`))
  if (!todo.length) {
    if (items.length) toast('All selected files are already completed')
    return
  }
  try {
    const data = await request('start-download', {
      chatId: state.activeChatId,
      items: todo.map(i => ({
        messageId: i.messageId,
        fileId: i.fileId,
        fileName: i.name,
        fileSize: i.fileSize
      }))
    })
    for (const jid of data.jobIds) {
      state.downloads.set(jid, { jobId: jid, status: 'queued', fileName: '', downloaded: 0, fileSize: 0 })
    }
    renderDownloads()
    state.selection.clear()
    updateSelectionBar()
    for (const cb of document.querySelectorAll('#media-grid input[type=checkbox], #messages input[type=checkbox]')) cb.checked = false
  } catch (e) { toast(e.message, 'error') }
}

async function downloadAllMedia () {
  if (!state.activeChatId) return
  if (state.scan.active) return toast('Already scanning / downloading this chat')
  try {
    await request('download-all', { chatId: state.activeChatId })
  } catch (e) { toast(e.message, 'error') }
}


/* ------------------------------ Scan banner ------------------------------ */

function onScanProgress (payload) {
  state.scan = { active: !payload.done, mode: payload.mode }
  if (payload.mode === 'count') {
    if (payload.chatId === state.activeChatId) {
      // state.mediaCount = payload.found // REMOVED: owner is files-stability.js
      state.typeCounts = payload.typeCounts
      state.counting = !payload.done
      updateMediaCountLabel()
    }
    if (payload.done) {
      const banner = $('#scan-banner')
      banner.classList.add('done')
      $('#scan-text').textContent = `Scanned ${payload.scanned} messages · ${payload.found} files`
      setTimeout(() => { banner.classList.add('hidden'); banner.classList.remove('done') }, 4000)
    }
    return
  }

  const banner = $('#scan-banner')
  banner.classList.remove('hidden', 'done')
  if (payload.done) {
    $('#scan-text').textContent = payload.cancelled
      ? `Scan cancelled after ${payload.found} files found`
      : `Done — queued ${payload.queued} of ${payload.found} files for download`
    banner.classList.add('done')
    setTimeout(() => { banner.classList.add('hidden'); banner.classList.remove('done') }, 5000)
  } else {
    $('#scan-text').textContent = `Scanning… ${payload.found} files found${payload.queued ? ` · ${payload.queued} queued` : ''}`
  }
}

function hideScanBanner () {
  state.scan = { active: false, mode: null }
  $('#scan-banner').classList.add('hidden')
}

/* ------------------------------ Media packer ------------------------------ */

function copyLink (text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text)
      .then(() => toast('Link copied to clipboard'))
      .catch(() => toast('Copy failed'))
    return
  }
  const ta = h('textarea', '')
  ta.value = text
  document.body.appendChild(ta)
  ta.select()
  try { document.execCommand('copy'); toast('Link copied to clipboard') } catch { toast('Copy failed') }
  ta.remove()
}

function renderZipResults (zips) {
  const box = $('#zip-results')
  if (!zips || !zips.length) { box.classList.add('hidden'); box.innerHTML = ''; return }
  box.innerHTML = ''
  box.classList.remove('hidden')
  box.appendChild(h('h4', '', `${zips.length} zip${zips.length === 1 ? '' : 's'} ready`))
  for (const z of zips) {
    const row = h('div', 'zip-row')
    const name = h('span', 'zname', z.name)
    name.title = z.name
    row.appendChild(name)
    row.appendChild(h('span', 'zsize', fmtSize(z.size || 0)))
    const a = h('a', '', 'Open')
    a.href = '/dl/' + z.url
    a.target = '_blank'
    a.rel = 'noopener'
    a.style.cssText = 'background:var(--ok);color:#07110a;padding:3px 8px;border-radius:6px;text-decoration:none;font-weight:600'
    row.appendChild(a)
    const copy = h('button', 'ghost small', 'Copy')
    copy.onclick = () => packLink(z)
    row.appendChild(copy)
    box.appendChild(row)
  }
}

function packLink (z) {
  copyLink(`${location.origin}/dl/${z.url}`)
}

function setPackActive (active) {
  $('#cancel-pack').classList.toggle('hidden', !active)
  $('#pack-media').disabled = active
}

function onPackProgress (p) {
  setPackActive(true)
  const banner = $('#pack-banner')
  banner.classList.remove('hidden', 'done')
  if (p.phase === 'download') {
    $('#pack-text').textContent = p.failed
      ? `Downloading… ${p.downloaded}/${p.total} (${p.failed} failed)`
      : `Downloading… ${p.downloaded}/${p.total}`
  } else if (p.phase === 'zip') {
    $('#pack-text').textContent = `Zipping… ${p.processed}/${p.total}`
  } else if (p.phase === 'dedup') {
    $('#pack-text').textContent = `Removing duplicates… ${p.removed}/${p.totalRemove}`
  } else {
    $('#pack-text').textContent = 'Packing…'
  }
}

function showPackBanner (text) {
  const banner = $('#pack-banner')
  banner.classList.remove('hidden')
  $('#pack-text').textContent = text
}

function onPackDone (payload) {
  setPackActive(false)
  const banner = $('#pack-banner')
  banner.classList.remove('hidden')
  banner.classList.add('done')
  const failed = (payload.failed || []).length
  $('#pack-text').textContent = `Done — ${payload.zips.length} zip(s)${failed ? `, ${failed} failed` : ''}`
  setTimeout(() => banner.classList.add('hidden'))
  renderZipResults(payload.zips)
  state.selection.clear()
  for (const cb of document.querySelectorAll('#media-grid input[type=checkbox], #messages input[type=checkbox]')) cb.checked = false
  updateSelectionBar()
}

function hidePackBanner () {
  setPackActive(false)
  $('#pack-banner').classList.add('hidden')
}

async function startPack () {
  if (state.packActive) return
  if (!state.activeChatId) return toast('Open a chat first')
  const items = [...state.selection.values()]
  if (!items.length) return toast('Select files to zip first')
  const chatTitle = $('#chat-title').textContent || 'files'
  const payload = {
    chatId: state.activeChatId,
    chatTitle,
    items: items.map(i => ({ fileId: i.fileId, messageId: i.messageId, fileName: i.name, fileSize: i.fileSize }))
  }
  try {
    const s = await request('pack-selected', payload)
    if (!s.uniqueFiles) return toast('All selected files are duplicates')
    const ok = confirm(
      `Zip ${s.uniqueFiles} selected files:\n\n` +
      `• ${s.totalFiles} total selected (includes duplicates)\n` +
      `• ${s.duplicatesToRemove} duplicates to skip\n` +
      `• ${s.zipCount} zip archive(s) (100 files each, compressed)\n` +
      `• download only the unique files from Telegram\n\n` +
      `Proceed?`
    )
    if (!ok) return
    state.packActive = true
    setPackActive(true)
    showPackBanner(`Downloading ${s.uniqueFiles} unique files…`)
    await request('pack-selected-run', payload)
  } catch (e) {
    hidePackBanner()
    toast(e.message, 'error')
  }
}

/* ------------------------------ Downloads panel ------------------------------ */

function upsertDownload (job) {
  state.downloads.set(job.jobId, { ...(state.downloads.get(job.jobId) || {}), ...job })
  renderDownloads()
}

function renderDownloads () {
  const list = $('#download-list')
  list.innerHTML = ''
  let totalSpeed = 0
  let active = 0
  let queued = 0
  let done = 0
  const now = Date.now()

  for (const job of state.downloads.values()) {
    let speed = 0
    let samples = state.samples.get(job.jobId)
    if (job.status === 'downloading') {
      if (!samples) { samples = []; state.samples.set(job.jobId, samples) }
      samples.push({ time: now, downloaded: job.downloaded })
      while (samples.length > 1 && now - samples[0].time > 3000) samples.shift()
      if (samples.length >= 2) {
        const a = samples[0]
        const b = samples[samples.length - 1]
        const dt = (b.time - a.time) / 1000
        if (dt > 0) speed = Math.max(0, (b.downloaded - a.downloaded) / dt)
      }
    } else {
      state.samples.delete(job.jobId)
      state.prevSpeed.delete(job.jobId)
    }
    if (job.status === 'downloading') { totalSpeed += speed; active++ }
    else if (job.status === 'queued') queued++
    else if (job.status === 'done') done++

    const el = h('div', 'djob ' + job.status)
    el.appendChild(h('div', 'name', job.fileName || '…'))
    const sub = h('div', 'sub')
    const statusText = { downloading: `● ${fmtSpeed(speed)}`, queued: 'queued', paused: 'paused', done: 'saved', cancelled: 'cancelled', error: 'failed' }[job.status] || job.status
    const sizeText = job.fileSize ? `${fmtSize(job.downloaded)} / ${fmtSize(job.fileSize)}` : (job.status === 'done' ? 'done' : fmtSize(job.downloaded))
    sub.appendChild(h('span', '', sizeText))
    sub.appendChild(h('span', 'status-tag', statusText))
    el.appendChild(sub)

    const bar = h('div', 'bar')
    const fill = h('div', '')
    const pct = job.fileSize ? Math.min(100, job.downloaded / job.fileSize * 100) : 0
    fill.style.width = `${pct}%`
    bar.appendChild(fill)
    el.appendChild(bar)

    if (job.status === 'downloading' && speed > 0 && job.fileSize) {
      const eta = (job.fileSize - job.downloaded) / speed
      el.appendChild(h('div', 'sub', `ETA ${fmtEta(eta)}`))
    } else {
      el.appendChild(h('div', 'sub', ''))
    }
    el.appendChild(h('div', 'error-text', job.error || ''))

    const actions = h('div', 'actions')
    if (job.status === 'downloading' || job.status === 'queued') {
      const pause = h('button', 'ghost small', 'Pause')
      pause.onclick = () => request('pause-job', { jobId: job.jobId }).catch(() => {})
      actions.appendChild(pause)
    }
    if (job.status === 'paused') {
      const res = h('button', 'ghost small', 'Resume')
      res.onclick = () => request('resume-job', { jobId: job.jobId }).catch(() => {})
      actions.appendChild(res)
    }
    if (job.status === 'queued' || job.status === 'downloading' || job.status === 'paused') {
      const cancel = h('button', 'ghost small', 'Cancel')
      cancel.onclick = () => request('cancel-download', { jobId: job.jobId }).catch(() => {})
      actions.appendChild(cancel)
    }
    if (job.status === 'done' && job.destPath) {
      const a = h('a', '', 'Open')
      a.href = '/dl' + job.destPath
      a.target = '_blank'
      a.rel = 'noopener'
      a.style.cssText = 'font-size:11px;padding:4px 8px;background:var(--ok);border-radius:7px;text-decoration:none;color:#07110a;font-weight:600;'
      actions.appendChild(a)
    }
    if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') {
      const rm = h('button', 'ghost small', 'Remove')
      rm.onclick = () => {
        state.downloads.delete(job.jobId)
        state.prevSpeed.delete(job.jobId)
        request('remove-download', { jobId: job.jobId }).catch(() => {})
        renderDownloads()
      }
      actions.appendChild(rm)
    }
    el.appendChild(actions)
    list.appendChild(el)
  }

  const parts = []
  if (active) parts.push(`${active} active · ${fmtSpeed(totalSpeed)}`)
  if (queued) parts.push(`${queued} queued`)
  if (done) parts.push(`${done} done`)
  $('#download-stats').textContent = parts.join(' · ') || (state.downloads.size ? 'idle' : '')
}

/* ------------------------------ Wire up UI ------------------------------ */

$('#save-config').onclick = async () => {
  const apiId = $('#api-id').value.trim()
  const apiHash = $('#api-hash').value.trim()
  if (!apiId || !apiHash) return
  $('#config-error').textContent = ''
  $('#save-config').disabled = true
  try {
    const r = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiId, apiHash })
    })
    const data = await r.json()
    if (!r.ok) throw new Error(data.error || 'Failed to save')
    $('#login-hint').textContent = 'Connecting…'
    showScreen('login')
  } catch (e) {
    $('#config-error').textContent = e.message
  } finally {
    $('#save-config').disabled = false
  }
}

$('#login-submit').onclick = submitLoginInput
$('#login-input').addEventListener('keydown', e => { if (e.key === 'Enter') submitLoginInput() })

$('#chat-search').addEventListener('input', renderChats)
$('#channels-only').addEventListener('change', () => {
  try { localStorage.setItem('tele-channels-only', $('#channels-only').checked ? '1' : '0') } catch {}
  renderChats()
})
$('#chat-list').addEventListener('scroll', e => {
  if (e.target.scrollTop + e.target.clientHeight >= e.target.scrollHeight - 60) loadMoreChats()
})

$('#tab-files').onclick = () => setView('files')
$('#tab-messages').onclick = () => setView('messages')

/* No scroll listener on #media-grid. Files are paged (100 per page, files-view.js
 * owns the pager), so reaching the last row is the end of the page and the next
 * files come from Next, not from appending on scroll. An infinite-scroll loader
 * here is what made the grid behave like a much longer list. Messages keep their
 * own scroll-back loader below. */
$('#messages').addEventListener('scroll', e => {
  if (e.target.scrollTop <= 250) {
    if (state.activeChatId && state.hasMore && !state.loadingMore) loadMessages(state.activeChatId)
  }
})

const searchDebounced = debounce(() => {
  if (state.files.mode === 'search') {
    state.files.mode = 'browse'
    state.files.results = []
    updateSearchBanner()
  }
  renderFiles()
}, 250)
$('#file-search').addEventListener('input', e => {
  state.files.query = e.target.value
  searchDebounced()
})
$('#clear-search').onclick = () => {
  state.files.mode = 'browse'
  state.files.results = []
  state.files.totalCount = 0
  updateSearchBanner()
  renderFiles()
}
$('#file-filter').addEventListener('change', e => {
  state.files.filter = e.target.value
  if (state.files.mode === 'search') searchWholeChat()
  else renderFiles()
})
$('#file-sort').addEventListener('change', e => {
  state.files.sort = e.target.value
  renderFiles()
})

$('#select-all-media').onclick = selectAllMedia
$('#download-all-media').onclick = downloadAllMedia
$('#cancel-scan').onclick = () => request('cancel-scan', {}).catch(() => {})
$('#download-selected').onclick = () => startDownloads([...state.selection.values()])
$('#forward-selected').onclick = forwardSelectedMessages
$('#mark-completed').onclick = markSelectedCompleted
$('#unmark-completed').onclick = unmarkSelectedCompleted
$('#clear-selection').onclick = () => {
  state.selection.clear()
  state.selectedMessages.clear()
  for (const cb of document.querySelectorAll('#media-grid input[type=checkbox], #messages input[type=checkbox]')) cb.checked = false
  updateSelectionBar()
}

/* The ONE click handler for the Save-to control.
 *
 * Three implementations used to target this node: `installDownloadFolderPicker` in
 * uploads-hardening.js assigned `button.onclick`, `file-consistency-v2.js` later
 * clone-replaced the node and added its own listener (silently discarding
 * hardening's), and the unloaded `file-consistency-fix.js` carried a third. Which
 * one ran was decided by script load order, not by design. Both are deleted, so
 * this is the only binding.
 *
 * It no longer reads a text field: `#dl-dir` is gone from the markup, and the folder
 * comes from the native dialog. On `cancelled` nothing happens at all - no request,
 * no repaint - so the configured folder survives a cancel (clause 3.10). */
$('#set-dir').onclick = async () => {
  const button = $('#set-dir')
  if (button.disabled) return
  button.disabled = true
  try {
    const response = await fetch('/api/filegram/pick-download-folder', { method: 'POST', cache: 'no-store' })
    let payload = {}
    try { payload = await response.json() } catch {}
    if (!response.ok || !payload.ok) throw new Error(payload.error || 'The folder picker could not open. Nothing was changed.')
    if (payload.cancelled || !payload.path) return
    const result = await request('set-download-dir', { dir: payload.path })
    setDirLabel(result.downloadsDir || payload.path)
    toast('Download folder changed')
  } catch (e) {
    toast(e.message, 'error')
  } finally {
    button.disabled = false
  }
}

$('#pack-media').onclick = startPack
$('#cancel-pack').onclick = () => request('cancel-pack', {}).catch(() => {})

$('#pause-all').onclick = () => request('pause-all', {}).catch(() => {})
$('#resume-all').onclick = () => request('resume-all', {}).catch(() => {})
// Bulk actions are single server-wide calls. Looping state.downloads here would
// only ever reach the jobs this browser happens to know about (about one
// concurrency window), never the real queue.
$('#cancel-all').onclick = async () => {
  const remaining = state.queueStats ? Number(state.queueStats.remaining || 0) : 0
  if (!remaining) return
  if (!confirm(`Cancel all ${remaining.toLocaleString()} unfinished download(s)?`)) return
  const res = await request('cancel-all', {}).catch(() => null)
  if (!res) return
  if (res.stats) state.queueStats = res.stats
  for (const j of state.downloads.values()) {
    if (j.status === 'queued' || j.status === 'downloading' || j.status === 'paused') j.status = 'cancelled'
  }
  renderDownloads()
}
$('#clear-done').onclick = async () => {
  const res = await request('clear-done', {}).catch(() => null)
  if (res && res.stats) state.queueStats = res.stats
  for (const [id, j] of [...state.downloads]) {
    if (j.status === 'done' || j.status === 'error' || j.status === 'cancelled') {
      state.downloads.delete(id)
      state.prevSpeed.delete(id)
    }
  }
  renderDownloads()
}

$('#toggle-drawer').onclick = () => {
  const dl = $('.downloads')
  const hidden = dl.style.display === 'none'
  dl.style.display = hidden ? '' : 'none'
  $('#toggle-drawer').textContent = hidden ? 'Hide' : 'Show'
}

const setConcurrency = debounce((v) => {
  request('set-concurrency', { value: v }).then(d => {
    state.concurrency = d.concurrency
    $('#concurrency-val').textContent = d.concurrency
  }).catch(() => {})
}, 300)

$('#concurrency').addEventListener('input', e => {
  $('#concurrency-val').textContent = e.target.value
  setConcurrency(e.target.value)
})

connect()
if (history.scrollRestoration) history.scrollRestoration = 'manual'
// Legacy 1s repaint removed — final-ui-fix.js owns the download render cycle
// with a 220ms throttle and proper speed sampling.
