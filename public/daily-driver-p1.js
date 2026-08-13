'use strict'

/* Daily-driver P1 stabilization.
 * - latest-message pinning on chat open
 * - cache-first, throttled per-chat file reconciliation
 * - lazy/deduplicated thumbnails
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

/* ------------------------------ Download dedupe preflight ------------------------------ */

const teleP1BaseStartDownloads = startDownloads
let teleP1DedupeResolve = null

function teleP1FormatDuration (ms) {
  if (!Number.isFinite(ms) || ms < 1) return '<1 ms'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

function teleP1EnsureDedupeModal () {
  let modal = document.querySelector('#tele-dedupe-modal')
  if (modal) return modal

  modal = document.createElement('div')
  modal.id = 'tele-dedupe-modal'
  modal.className = 'tele-dedupe-modal hidden'
  modal.innerHTML = `<div class="tele-dedupe-dialog" role="dialog" aria-modal="true" aria-labelledby="tele-dedupe-title">
    <div class="tele-dedupe-head">
      <div>
        <div id="tele-dedupe-title" class="tele-dedupe-title">Check for duplicates</div>
        <div id="tele-dedupe-subtitle" class="tele-dedupe-subtitle">Scanning your download folder…</div>
      </div>
      <button type="button" id="tele-dedupe-close" class="ghost small" aria-label="Close">✕</button>
    </div>
    <div id="tele-dedupe-body" class="tele-dedupe-body"></div>
    <div class="tele-dedupe-actions">
      <button type="button" id="tele-dedupe-cancel" class="ghost">Cancel</button>
      <button type="button" id="tele-dedupe-continue" class="primary" disabled>Continue</button>
    </div>
  </div>`
  document.body.appendChild(modal)

  const finish = value => {
    modal.classList.add('hidden')
    const resolve = teleP1DedupeResolve
    teleP1DedupeResolve = null
    if (resolve) resolve(value)
  }
  modal.querySelector('#tele-dedupe-close').onclick = () => finish(false)
  modal.querySelector('#tele-dedupe-cancel').onclick = () => finish(false)
  modal.addEventListener('mousedown', event => { if (event.target === modal) finish(false) })
  return modal
}

function teleP1ShowDedupeScanning (count) {
  const modal = teleP1EnsureDedupeModal()
  modal.classList.remove('hidden')
  modal.querySelector('#tele-dedupe-subtitle').textContent = `Scanning the selected download path for ${count.toLocaleString()} file${count === 1 ? '' : 's'}…`
  modal.querySelector('#tele-dedupe-body').innerHTML = `<div class="tele-dedupe-scanning"><span class="tele-dedupe-spinner"></span><div><strong>Cross-checking filename + file size</strong><span>Only an exact name and exact byte-size match is treated as a duplicate.</span></div></div>`
  const continueButton = modal.querySelector('#tele-dedupe-continue')
  continueButton.disabled = true
  continueButton.textContent = 'Scanning…'
  return modal
}

function teleP1RenderDedupeReport (report) {
  const modal = teleP1EnsureDedupeModal()
  const duplicateCount = Number(report.duplicateCount || 0)
  const uniqueCount = Number(report.uniqueCount || 0)
  const selectedCount = Number(report.selectedCount || 0)
  const existingCount = (report.duplicates || []).filter(row => row.reason === 'existing').length
  const selectionCount = duplicateCount - existingCount
  const unknownSizeCount = Number(report.unknownSizeCount || 0)

  modal.querySelector('#tele-dedupe-subtitle').textContent = duplicateCount
    ? `${duplicateCount.toLocaleString()} duplicate${duplicateCount === 1 ? '' : 's'} found · ${uniqueCount.toLocaleString()} ready to download`
    : `No duplicates found · ${uniqueCount.toLocaleString()} ready to download`

  const body = modal.querySelector('#tele-dedupe-body')
  body.innerHTML = ''

  const pathCard = document.createElement('div')
  pathCard.className = 'tele-dedupe-path'
  pathCard.innerHTML = `<span>Scanned path</span><strong></strong>`
  pathCard.querySelector('strong').textContent = report.rootPath || 'Downloads'
  body.appendChild(pathCard)

  const stats = document.createElement('div')
  stats.className = 'tele-dedupe-stats'
  const statData = [
    ['Selected', selectedCount.toLocaleString()],
    ['Already there', existingCount.toLocaleString()],
    ['Repeated selection', selectionCount.toLocaleString()],
    ['Will download', uniqueCount.toLocaleString()]
  ]
  for (const [label, value] of statData) {
    const card = document.createElement('div')
    card.className = 'tele-dedupe-stat'
    card.innerHTML = `<span></span><strong></strong>`
    card.querySelector('span').textContent = label
    card.querySelector('strong').textContent = value
    stats.appendChild(card)
  }
  body.appendChild(stats)

  const validation = document.createElement('div')
  validation.className = 'tele-dedupe-validation'
  validation.innerHTML = `<span class="tele-dedupe-check">✓</span><div><strong>Exact filename + exact size</strong><span></span></div>`
  validation.querySelector('div span').textContent = `${Number(report.scannedFiles || 0).toLocaleString()} files scanned in ${teleP1FormatDuration(Number(report.scanMs || 0))}${unknownSizeCount ? ` · ${unknownSizeCount} item${unknownSizeCount === 1 ? '' : 's'} had unknown size and will not be auto-skipped` : ''}`
  body.appendChild(validation)

  if (duplicateCount) {
    const listTitle = document.createElement('div')
    listTitle.className = 'tele-dedupe-list-title'
    listTitle.textContent = `Duplicates · ${fmtSize(Number(report.duplicateBytes || 0))} skipped`
    body.appendChild(listTitle)

    const list = document.createElement('div')
    list.className = 'tele-dedupe-list'
    const rows = (report.duplicates || []).slice(0, 100)
    for (const row of rows) {
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
    if (duplicateCount > rows.length) {
      const more = document.createElement('div')
      more.className = 'tele-dedupe-more'
      more.textContent = `+ ${(duplicateCount - rows.length).toLocaleString()} more duplicate${duplicateCount - rows.length === 1 ? '' : 's'}`
      list.appendChild(more)
    }
    body.appendChild(list)
  }

  const continueButton = modal.querySelector('#tele-dedupe-continue')
  continueButton.disabled = uniqueCount === 0
  continueButton.textContent = uniqueCount ? `Continue with ${uniqueCount.toLocaleString()}` : 'Nothing to download'

  return new Promise(resolve => {
    teleP1DedupeResolve = resolve
    continueButton.onclick = () => {
      modal.classList.add('hidden')
      teleP1DedupeResolve = null
      resolve(true)
    }
  })
}

startDownloads = async function teleP1StartDownloadsWithDedupe (items) {
  const candidates = (items || []).filter(item => !isCompleted(`${state.activeChatId}:${item.messageId}`))
  if (!candidates.length) {
    if (items && items.length) toast('All selected files are already completed')
    return
  }

  teleP1ShowDedupeScanning(candidates.length)
  let report
  try {
    report = await request('download-dedupe-preview', {
      items: candidates.map(item => ({
        messageId: item.messageId,
        fileName: item.name,
        fileSize: item.fileSize
      }))
    })
  } catch (error) {
    const modal = teleP1EnsureDedupeModal()
    modal.classList.add('hidden')
    toast(`Dedupe scan failed: ${error.message}`, 'error')
    return
  }

  const proceed = await teleP1RenderDedupeReport(report)
  if (!proceed) return

  const allowed = new Set((report.uniqueMessageIds || []).map(String))
  const todo = candidates.filter(item => allowed.has(String(item.messageId)))
  if (!todo.length) {
    toast('Everything selected is already present in the download folder')
    return
  }

  await teleP1BaseStartDownloads(todo)
}
