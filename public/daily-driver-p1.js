'use strict'

/* Daily-driver P1 stabilization.
 * - latest-message pinning on chat open
 * - cache-first, throttled per-chat file reconciliation
 * - lazy/deduplicated thumbnails
 * - desktop notifications disabled and old service workers removed
 */

const teleP1ThumbCache = new Map()
const teleP1ThumbInflight = new Map()
const teleP1ThumbTargets = new WeakMap()
const teleP1FilePaintTimers = new Map()
let teleP1OpenToken = 0
let teleP1PinUntil = 0
let teleP1PinChatKey = null
let teleP1UserTouchedMessages = false

function teleP1Key (value) { return String(value) }

function teleP1SnapshotBelongs (chatId, snapshot) {
  if (!snapshot || !Array.isArray(snapshot.items)) return false
  const wanted = teleP1Key(chatId)
  return snapshot.items.every(item => item && teleP1Key(item.chatId) === wanted)
}

function teleP1ScrollLatest () {
  if (state.view !== 'messages' || state.activeChatId == null) return
  if (teleP1PinChatKey !== teleP1Key(state.activeChatId)) return
  if (teleP1UserTouchedMessages || Date.now() > teleP1PinUntil) return
  const panel = document.querySelector('#messages')
  if (!panel) return
  panel.scrollTop = panel.scrollHeight
}

function teleP1BeginLatestPin (chatId, duration = 2200) {
  teleP1PinChatKey = teleP1Key(chatId)
  teleP1PinUntil = Date.now() + duration
  teleP1UserTouchedMessages = false
  const token = ++teleP1OpenToken
  const paint = () => {
    if (token !== teleP1OpenToken) return
    teleP1ScrollLatest()
  }
  requestAnimationFrame(paint)
  setTimeout(paint, 40)
  setTimeout(paint, 140)
  setTimeout(paint, 360)
  setTimeout(paint, 900)
  setTimeout(paint, 1700)
}

const teleP1MessagesPanel = document.querySelector('#messages')
if (teleP1MessagesPanel) {
  for (const name of ['wheel', 'pointerdown', 'touchstart']) {
    teleP1MessagesPanel.addEventListener(name, () => { teleP1UserTouchedMessages = true }, { passive: true })
  }
  const observer = new MutationObserver(() => requestAnimationFrame(teleP1ScrollLatest))
  observer.observe(teleP1MessagesPanel, { childList: true })
}

const teleP1BaseSetView = setView
setView = function teleP1SetView (view) {
  const changed = state.view !== view
  const result = teleP1BaseSetView(view)
  if (view === 'messages' && state.activeChatId != null && changed) teleP1BeginLatestPin(state.activeChatId, 900)
  return result
}

const teleP1BaseOpenChat = openChat
openChat = async function teleP1OpenChat (chatId) {
  const key = teleP1Key(chatId)
  const memory = rescueFileCache.get(key)
  if (teleP1SnapshotBelongs(chatId, memory)) {
    try { teleHotfixValidatedChats.add(key) } catch {}
  } else {
    try {
      teleP0v2ReadIndex(chatId).then(snapshot => {
        if (!teleP1SnapshotBelongs(chatId, snapshot)) return
        rescueFileCache.set(key, snapshot)
        try { teleHotfixValidatedChats.add(key) } catch {}
        if (state.activeChatId != null && teleP1Key(state.activeChatId) === key && state.view === 'files') {
          rescueApplyCompleteFiles(chatId, snapshot)
          renderFiles()
          updateMediaCountLabel()
          setLoadState(`Cached ${snapshot.items.length.toLocaleString()} files`)
        }
      }).catch(() => {})
    } catch {}
  }

  teleP1BeginLatestPin(chatId)
  const result = await teleP1BaseOpenChat(chatId)
  teleP1ScrollLatest()
  return result
}

function teleP1SortMediaItems (items) {
  return items.sort((a, b) => {
    const aa = BigInt(String((a && a.messageId) || 0))
    const bb = BigInt(String((b && b.messageId) || 0))
    return aa === bb ? 0 : (aa < bb ? 1 : -1)
  })
}

function teleP1PaintFiles (chatId, snapshot, finalPaint) {
  const key = teleP1Key(chatId)
  if (state.activeChatId == null || teleP1Key(state.activeChatId) !== key || state.view !== 'files') return
  rescueApplyCompleteFiles(chatId, snapshot)
  renderFiles()
  updateMediaCountLabel()
  if (finalPaint) setLoadState(`Loaded ${snapshot.items.length.toLocaleString()} files`)
  else if (!snapshot.done) setLoadState(`Syncing files... ${snapshot.items.length.toLocaleString()} indexed`)
}

function teleP1ScheduleFilePaint (chatId, snapshot, finalPaint) {
  const key = teleP1Key(chatId)
  if (finalPaint) {
    clearTimeout(teleP1FilePaintTimers.get(key))
    teleP1FilePaintTimers.delete(key)
    teleP1PaintFiles(chatId, snapshot, true)
    return
  }
  if (teleP1FilePaintTimers.has(key)) return
  const timer = setTimeout(() => {
    teleP1FilePaintTimers.delete(key)
    const live = rescueFileCache.get(key)
    if (teleP1SnapshotBelongs(chatId, live)) teleP1PaintFiles(chatId, live, false)
  }, 220)
  teleP1FilePaintTimers.set(key, timer)
}

function teleP1MergeMediaProgress (payload) {
  if (!payload || payload.chatId == null) return
  const key = teleP1Key(payload.chatId)
  const current = rescueFileCache.get(key)
  const snapshot = teleP1SnapshotBelongs(payload.chatId, current)
    ? current
    : { chatId: payload.chatId, items: [], found: 0, scanned: 0, typeCounts: {}, savedAt: Date.now(), done: false }

  const byKey = new Map((snapshot.items || []).map(item => [String(item.key || `${item.chatId}:${item.messageId}`), item]))
  for (const item of payload.items || []) {
    if (!item || teleP1Key(item.chatId) !== key) continue
    byKey.set(String(item.key || `${item.chatId}:${item.messageId}`), item)
  }
  snapshot.chatId = payload.chatId
  snapshot.items = teleP1SortMediaItems([...byKey.values()])
  snapshot.found = snapshot.items.length
  snapshot.scanned = Number(payload.scanned || snapshot.scanned || 0)
  snapshot.typeCounts = payload.typeCounts || snapshot.typeCounts || {}
  snapshot.savedAt = Date.now()
  snapshot.done = !!payload.done
  rescueFileCache.set(key, snapshot)
  try { teleHotfixValidatedChats.add(key) } catch {}

  if (snapshot.done) {
    try { teleP0v2WriteIndex(payload.chatId, snapshot).catch(() => {}) } catch {}
  }
  teleP1ScheduleFilePaint(payload.chatId, snapshot, snapshot.done)
}

const teleP1BaseHandleEvent = handleEvent
handleEvent = function teleP1HandleEvent (event) {
  if (event && event.name === 'media-index-progress') {
    teleP1MergeMediaProgress(event.payload || {})
    return
  }
  return teleP1BaseHandleEvent(event)
}

function teleP1RevealThumb (img, item, pathValue) {
  if (!img || !img.isConnected || !pathValue) return
  item.thumbUrl = pathValue
  img.onload = () => {
    img.classList.remove('hidden')
    const icon = img.previousElementSibling
    if (icon) icon.classList.add('hidden')
  }
  img.src = '/dl' + pathValue
}

function teleP1GetThumbPath (item) {
  if (!item) return Promise.resolve(null)
  if (item.thumbUrl) return Promise.resolve(item.thumbUrl)
  const fileId = Number(item.thumbFileId || 0)
  if (!fileId) return Promise.resolve(null)
  if (teleP1ThumbCache.has(fileId)) return Promise.resolve(teleP1ThumbCache.get(fileId))
  if (teleP1ThumbInflight.has(fileId)) return teleP1ThumbInflight.get(fileId)

  const work = request('get-thumb', { fileId }).then(data => {
    const pathValue = data && data.path ? data.path : null
    if (pathValue) teleP1ThumbCache.set(fileId, pathValue)
    return pathValue
  }).catch(() => null).finally(() => teleP1ThumbInflight.delete(fileId))
  teleP1ThumbInflight.set(fileId, work)
  return work
}

const teleP1ThumbObserver = 'IntersectionObserver' in window
  ? new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        teleP1ThumbObserver.unobserve(entry.target)
        const data = teleP1ThumbTargets.get(entry.target)
        if (!data) continue
        teleP1GetThumbPath(data.item).then(pathValue => teleP1RevealThumb(data.img, data.item, pathValue))
      }
    }, { root: null, rootMargin: '700px 0px', threshold: 0.01 })
  : null

loadThumb = function teleP1LoadThumb (img, item) {
  if (!img || !item) return
  const target = img.closest('.gthumb') || img.parentElement || img
  if (!teleP1ThumbObserver) {
    teleP1GetThumbPath(item).then(pathValue => teleP1RevealThumb(img, item, pathValue))
    return
  }
  teleP1ThumbTargets.set(target, { img, item })
  teleP1ThumbObserver.observe(target)
}

/* Prevent the message list from starting metadata downloads for every video.
 * The poster/controls remain visible and the file is fetched only when played. */
const teleP1BaseMessageMedia = teleDailyMessageMedia
teleDailyMessageMedia = function teleP1MessageMedia (item) {
  const node = teleP1BaseMessageMedia(item)
  if (!node) return node
  const video = node.querySelector('video')
  if (video) video.preload = 'none'
  const audio = node.querySelector('audio')
  if (audio) audio.preload = 'none'
  return node
}

function teleP1StripNotificationUi () {
  const panel = document.querySelector('#mg-info-pane')
  if (!panel) return
  for (const section of panel.querySelectorAll('.mg-section')) {
    const title = section.querySelector('h4')
    if (title && title.textContent.trim().toLowerCase() === 'notifications') section.remove()
  }
  for (const row of panel.querySelectorAll('.mg-info-row')) {
    const label = row.firstElementChild
    if (label && label.textContent.trim().toLowerCase() === 'notifications') row.remove()
  }
}

function teleP1DisableNotifications () {
  try { localStorage.removeItem('tele-desktop-notifications') } catch {}
  try { rescueMaybeNotifyMessage = function () {} } catch {}
  try { rescueNotificationServiceRegistration = async function () { return null } } catch {}
  window.teleDesktopNotificationsEnabled = undefined
  window.teleEnableDesktopNotifications = undefined
  window.teleDisableDesktopNotifications = undefined
  window.teleTestDesktopNotification = undefined
  teleP1StripNotificationUi()

  if ('serviceWorker' in navigator && navigator.serviceWorker.getRegistrations) {
    const unregister = () => navigator.serviceWorker.getRegistrations()
      .then(registrations => Promise.all(registrations.map(registration => registration.unregister())))
      .catch(() => {})
    unregister()
    setTimeout(unregister, 500)
    setTimeout(unregister, 1800)
  }
}

const teleP1InfoPane = document.querySelector('#mg-info-pane')
if (teleP1InfoPane) {
  new MutationObserver(teleP1StripNotificationUi).observe(teleP1InfoPane, { childList: true, subtree: true })
}
teleP1DisableNotifications()
