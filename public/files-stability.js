'use strict'

/* FileGram Files owner: discovery only grows; confirmed Telegram truth may shrink. */
;(function fileGramFilesStability () {
  const DB_NAME = 'tele-daily-driver-cache-v1'
  const DB_STORE = 'file-indexes'
  const HIGH_WATER_KEY = 'tele-file-index-high-water-v1'
  const LEGACY_RECONCILE_MARK_KEY = 'filegram-files-delete-reconcile-v1'
  const REMOVED_IDS_LIMIT = 5000
  const REMOVED_IDS_TTL = 30 * 24 * 60 * 60 * 1000
  const TRUTH_MISSING_LOG_LIMIT = 20
  const TRUTH_BACKOFF_START_MS = 2000
  const TRUTH_BACKOFF_MAX_MS = 5 * 60 * 1000
  const TRUTH_THROTTLE_MS = 60000
  const PROGRESS_FLUSH_MS = 350
  const PROGRESS_FLUSH_ITEMS = 800
  const RECONCILE_PAGE_LIMIT = 100
  const RECONCILE_MAX_PAGES = 2500

  const committed = new Map()
  const loading = new Map()
  const reconcileJobs = new Map()
  const recentJobs = new Map()
  const candidates = new Map()
  const flushTimers = new Map()
  const fullScanJobs = new Set()
  const progressInFlight = new Set()
  const repairAttempts = new Set()
  const backoff = new Map()
  const lastTruthPass = new Map()
  const autoReconcileTimers = new Map()
  const removalState = new Map()
  const handledEvents = new WeakSet()
  let ownerHandleEvent = null

  function idOf (value) { return String(value == null ? '' : value) }
  function compareIds (a, b) {
    let aa = 0n; let bb = 0n
    try { aa = BigInt(String(a || 0)) } catch {}
    try { bb = BigInt(String(b || 0)) } catch {}
    return aa === bb ? 0 : (aa < bb ? -1 : 1)
  }
  function newestItemId (items) {
    let newest = 0
    for (const item of items || []) if (item && item.messageId != null && (!newest || compareIds(item.messageId, newest) > 0)) newest = item.messageId
    return newest
  }
  function belongsToChat (chatId, snapshot) {
    if (!snapshot || !Array.isArray(snapshot.items)) return false
    const wanted = idOf(chatId)
    return snapshot.items.every(item => item && idOf(item.chatId) === wanted)
  }
  function countTypes (items) {
    const out = {}
    for (const item of items || []) if (item && item.type) out[item.type] = (out[item.type] || 0) + 1
    return out
  }
  function cloneSnapshot (snapshot) {
    if (!snapshot) return null
    return { ...snapshot, items: (snapshot.items || []).map(item => ({ ...item })), typeCounts: { ...(snapshot.typeCounts || {}) }, removedIds: (snapshot.removedIds || []).map(item => ({ ...item })) }
  }

  function openDb () {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined' || !indexedDB) return resolve(null)
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE, { keyPath: 'chatId' }) }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error || new Error('IndexedDB unavailable'))
    })
  }
  async function readPersistent (chatId) {
    const db = await openDb().catch(() => null)
    if (!db) return null
    return new Promise(resolve => {
      let done = false
      const finish = value => { if (done) return; done = true; try { db.close() } catch {}; resolve(value || null) }
      try {
        const tx = db.transaction(DB_STORE, 'readonly')
        const req = tx.objectStore(DB_STORE).get(idOf(chatId))
        req.onsuccess = () => finish(req.result)
        req.onerror = tx.onerror = tx.onabort = () => finish(null)
      } catch { finish(null) }
    })
  }
  async function writePersistent (chatId, snapshot, options = {}) {
    const db = await openDb().catch(() => null)
    if (!db) return { written: false, reason: 'indexeddb-unavailable' }
    const record = {
      chatId: idOf(chatId), found: snapshot.items.length, scanned: Number(snapshot.scanned || 0),
      typeCounts: snapshot.typeCounts || {}, items: snapshot.items.map(item => ({ ...item })),
      newestMessageId: snapshot.newestMessageId || 0, latestSeenMessageId: snapshot.latestSeenMessageId || 0,
      savedAt: Number(snapshot.savedAt || Date.now()), done: snapshot.done !== false,
      reconciledAt: Number(snapshot.reconciledAt || 0), truthCount: Number(snapshot.truthCount || 0),
      removedIds: (snapshot.removedIds || []).map(item => ({ ...item }))
    }
    return new Promise(resolve => {
      let done = false
      const finish = value => { if (done) return; done = true; try { db.close() } catch {}; resolve(value) }
      try {
        const tx = db.transaction(DB_STORE, 'readwrite')
        tx.objectStore(DB_STORE).put(record)
        tx.oncomplete = () => finish({ written: true })
        tx.onerror = () => finish({ written: false, reason: 'transaction-error' })
        tx.onabort = () => finish({ written: false, reason: 'transaction-abort' })
      } catch { finish({ written: false, reason: 'transaction-open-failed' }) }
    })
  }

  /* Legacy readers receive a copy; they are never an owned merge base after restore. */
  function sharedSnapshot (chatId) {
    try { const value = rescueFileCache.get(idOf(chatId)); return belongsToChat(chatId, value) ? value : null } catch { return null }
  }
  function publishShared (chatId, snapshot) { try { rescueFileCache.set(idOf(chatId), cloneSnapshot(snapshot)) } catch {} }

  function readHighWater () { try { return JSON.parse(localStorage.getItem(HIGH_WATER_KEY) || '{}') || {} } catch { return {} } }
  function writeHighWater (map) { try { localStorage.setItem(HIGH_WATER_KEY, JSON.stringify(map)) } catch {} }
  function readTotalFloor (chatId) { const e = readHighWater()[idOf(chatId)]; return e ? { count: Math.max(0, Number(e.count || 0)), at: Math.max(0, Number(e.at || 0)) } : null }
  function totalFloor (chatId) { const e = readTotalFloor(chatId); return e ? e.count : 0 }
  function rememberTotalFloor (chatId, count) {
    const value = Math.max(0, Number(count || 0)); if (!value) return
    const map = readHighWater(); const key = idOf(chatId); const current = map[key]
    if (current && Number(current.count || 0) >= value) return
    map[key] = { count: value, at: Date.now() }; writeHighWater(map)
  }
  function clearTotalFloor (chatId) {
    const map = readHighWater(); delete map[idOf(chatId)]; writeHighWater(map)
  }
  function setTotalFloor (chatId, count, at) {
    const value = Math.max(0, Number(count || 0)); const map = readHighWater(); const key = idOf(chatId)
    if (!value) delete map[key]; else map[key] = { count: value, at: Number(at || Date.now()) }
    writeHighWater(map)
  }
  function migrateLegacyReconcileMark () { try { localStorage.removeItem(LEGACY_RECONCILE_MARK_KEY) } catch {} }

  function cleanRemovedEntries (entries, now = Date.now()) {
    const cutoff = now - REMOVED_IDS_TTL; const map = new Map()
    for (const raw of entries || []) {
      const id = idOf(raw && typeof raw === 'object' ? raw.id : raw); if (!id) continue
      const at = Number(raw && typeof raw === 'object' ? raw.at : 0) || 0; if (at && at < cutoff) continue
      if (!map.has(id) || at >= map.get(id).at) map.set(id, { id, at })
    }
    return [...map.values()].sort((a, b) => b.at - a.at).slice(0, REMOVED_IDS_LIMIT)
  }
  function hydrateRemovalState (chatId, snapshot) {
    if (!snapshot) return
    const key = idOf(chatId); const incomingAt = Number(snapshot.reconciledAt || 0); const current = removalState.get(key)
    if (current && current.reconciledAt > incomingAt) return
    const entries = cleanRemovedEntries(snapshot.removedIds || [])
    removalState.set(key, { reconciledAt: Math.max(incomingAt, current ? current.reconciledAt : 0), removedIds: new Map(entries.map(e => [idOf(e.id), Number(e.at || incomingAt || 0)])) })
  }
  function currentRemovalMeta (chatId) {
    const key = idOf(chatId); const current = removalState.get(key) || { reconciledAt: 0, removedIds: new Map() }
    const entries = cleanRemovedEntries([...current.removedIds.entries()].map(([id, at]) => ({ id, at })))
    const next = { reconciledAt: Number(current.reconciledAt || 0), removedIds: new Map(entries.map(e => [idOf(e.id), Number(e.at || 0)])) }
    removalState.set(key, next); return next
  }
  function removalBlocks (chatId, messageId, sourceAt) {
    const meta = currentRemovalMeta(chatId); const removedIds = meta.removedIds; const id = idOf(messageId)
    if (!removedIds.has(id)) return false
    const removedAt = Number(removedIds.get(id) || 0); const reconciledAt = Number(meta.reconciledAt || 0)
    return Number(sourceAt || 0) <= (removedAt || reconciledAt)
  }
  function appendRemovedIds (chatId, previous, ids, at, presentIds) {
    hydrateRemovalState(chatId, previous)
    const meta = currentRemovalMeta(chatId); const present = presentIds instanceof Set ? presentIds : new Set((presentIds || []).map(idOf))
    for (const id of present) meta.removedIds.delete(idOf(id))
    for (const raw of ids || []) { const id = idOf(raw); if (id && !id.startsWith('-')) meta.removedIds.set(id, Number(at || Date.now())) }
    meta.reconciledAt = Math.max(meta.reconciledAt, Number(at || Date.now()))
    const entries = cleanRemovedEntries([...meta.removedIds.entries()].map(([id, stamp]) => ({ id, at: stamp })), at)
    removalState.set(idOf(chatId), { reconciledAt: meta.reconciledAt, removedIds: new Map(entries.map(e => [idOf(e.id), Number(e.at || 0)])) })
    return entries
  }

  function normalize (chatId, snapshot) {
    const wanted = idOf(chatId); const at = Number(snapshot && snapshot.savedAt || Date.now()); if (snapshot) hydrateRemovalState(chatId, snapshot)
    const byMessage = new Map()
    for (const item of snapshot && Array.isArray(snapshot.items) ? snapshot.items : []) {
      if (!item || idOf(item.chatId) !== wanted || item.messageId == null) continue
      if (removalBlocks(chatId, item.messageId, at)) continue
      byMessage.set(idOf(item.messageId), { ...item, chatId })
    }
    const items = [...byMessage.values()].sort((a, b) => compareIds(b.messageId, a.messageId)); const meta = currentRemovalMeta(chatId)
    const done = snapshot && snapshot.historyComplete === false ? false : (!snapshot || snapshot.done !== false)
    return { chatId, items, found: items.length, scanned: Math.max(Number(snapshot && snapshot.scanned || 0), items.length), typeCounts: countTypes(items), newestMessageId: newestItemId(items), latestSeenMessageId: snapshot && snapshot.latestSeenMessageId || 0, savedAt: at, done, reconciledAt: Math.max(Number(snapshot && snapshot.reconciledAt || 0), meta.reconciledAt), truthCount: Math.max(0, Number(snapshot && snapshot.truthCount || 0)), removedIds: cleanRemovedEntries([...meta.removedIds.entries()].map(([id, stamp]) => ({ id, at: stamp })), at) }
  }
  function union (chatId, ...snapshots) {
    const wanted = idOf(chatId); const byMessage = new Map(); let scanned = 0; let savedAt = 0; let latestSeenMessageId = 0; let done = false; let reconciledAt = 0; let truthCount = 0
    for (const snapshot of snapshots) {
      if (!belongsToChat(chatId, snapshot)) continue
      hydrateRemovalState(chatId, snapshot); const at = Number(snapshot.savedAt || Date.now()); savedAt = Math.max(savedAt, at); scanned = Math.max(scanned, Number(snapshot.scanned || 0))
      if (snapshot.historyComplete !== false) done = done || snapshot.done !== false
      if (Number(snapshot.reconciledAt || 0) >= reconciledAt) { reconciledAt = Number(snapshot.reconciledAt || 0); truthCount = Math.max(0, Number(snapshot.truthCount || 0)) }
      if (snapshot.latestSeenMessageId && compareIds(snapshot.latestSeenMessageId, latestSeenMessageId) > 0) latestSeenMessageId = snapshot.latestSeenMessageId
      for (const item of snapshot.items) {
        if (!item || idOf(item.chatId) !== wanted || item.messageId == null) continue
        if (removalBlocks(chatId, item.messageId, at)) continue
        byMessage.set(idOf(item.messageId), { ...item, chatId })
      }
    }
    return normalize(chatId, { items: [...byMessage.values()], scanned, savedAt: savedAt || Date.now(), latestSeenMessageId, done, reconciledAt, truthCount })
  }

  function floorAwareComplete (chatId, snapshot) { const floor = readTotalFloor(chatId); return !floor || floor.at <= Number(snapshot.reconciledAt || 0) || snapshot.items.length >= floor.count }
  function isCompleteSnapshot (chatId, snapshot) {
    if (!belongsToChat(chatId, snapshot) || snapshot.done === false || !Array.isArray(snapshot.items)) return false
    return snapshot.items.length >= totalFloor(chatId) || floorAwareComplete(chatId, snapshot)
  }
  function paint (chatId, snapshot) {
    if (!state || state.activeChatId == null || idOf(state.activeChatId) !== idOf(chatId)) return
    const total = snapshot.items.length; state.mediaCount = total; state.typeCounts = snapshot.typeCounts || {}
    const label = document.querySelector('#chat-media-count'); if (label) label.textContent = `${total.toLocaleString()} file${total === 1 ? '' : 's'}`
    const all = document.querySelector('#download-all-media'); if (all) { all.textContent = `Download all media (${total.toLocaleString()})`; all.disabled = total === 0 }
    const selectAll = document.querySelector('#select-all-media'); if (selectAll) { selectAll.textContent = total ? `Select all (${total.toLocaleString()})` : 'Select all'; selectAll.disabled = total === 0 }
    if (state.view === 'files' && typeof renderFiles === 'function') try { renderFiles() } catch {}
  }
  function ownCountLabel () {
    const paintOwned = function fileGramStableUpdateMediaLabel () { const chatId = state && state.activeChatId; const snapshot = committed.get(idOf(chatId)); if (snapshot) paint(chatId, snapshot) }
    try { updateMediaCountLabel = paintOwned } catch {}; try { rescueUpdateMediaLabel = paintOwned } catch {}
  }
  function maybeRepairIndex (chatId, snapshot) {
    if (!snapshot || snapshot.done === false) return
    const key = idOf(chatId); if (repairAttempts.has(key)) return
    const floor = readTotalFloor(chatId); if (!floor || snapshot.items.length >= floor.count) return
    const reconciledAt = Number(snapshot.reconciledAt || 0); if (floor.at <= reconciledAt) return
    repairAttempts.add(key); try { setLoadState(`Repairing index (${snapshot.items.length.toLocaleString()} of ${floor.count.toLocaleString()} known files)`) } catch {}; hardRefresh(chatId).catch(() => {})
  }
  function updateCountUi (chatId) {
    const snapshot = committed.get(idOf(chatId)); if (!snapshot) return
    const total = snapshot.items.length
    if (snapshot.done !== false) rememberTotalFloor(chatId, total)
    maybeRepairIndex(chatId, snapshot); paint(chatId, snapshot)
  }

  async function commitDiscovery (chatId, snapshot, options = {}) {
    if (!belongsToChat(chatId, snapshot)) return committed.get(idOf(chatId)) || null
    const key = idOf(chatId); const previous = committed.get(key)
    const next = previous ? union(chatId, previous, snapshot) : normalize(chatId, snapshot)
    committed.set(key, next); publishShared(chatId, next); updateCountUi(chatId); await writePersistent(chatId, next, options); return next
  }
  async function commitAuthoritative (chatId, snapshot, options = {}) {
    if (!belongsToChat(chatId, snapshot)) return { snapshot: committed.get(idOf(chatId)) || null, persisted: { written: false, reason: 'invalid-snapshot' } }
    const key = idOf(chatId); const previous = committed.get(key) || normalize(chatId, { chatId, items: [], done: true, savedAt: snapshot.savedAt || Date.now() }); const at = Number(options.at || Date.now())
    const presentIds = options.presentIds instanceof Set ? options.presentIds : new Set((options.presentIds || snapshot.items.map(item => idOf(item.messageId))).map(idOf))
    const removed = Array.isArray(options.removedIds) ? options.removedIds.map(idOf) : previous.items.filter(item => !presentIds.has(idOf(item.messageId))).map(item => idOf(item.messageId))
    const removedIds = appendRemovedIds(chatId, previous, removed, at, presentIds)
    const floorCount = Math.max(snapshot.items.length, Number(options.truth.count || 0))
    const next = normalize(chatId, { ...snapshot, savedAt: Math.max(Number(snapshot.savedAt || 0), at), done: snapshot.done !== false && snapshot.items.length >= floorCount, reconciledAt: at, truthCount: floorCount, removedIds })
    next.removedIds = removedIds; next.reconciledAt = at; next.truthCount = floorCount; next.done = snapshot.done !== false && next.items.length >= floorCount
    committed.set(key, next); hydrateRemovalState(chatId, next); publishShared(chatId, next); setTotalFloor(chatId, floorCount, at); updateCountUi(chatId)
    const persisted = await writePersistent(chatId, next, options); return { snapshot: next, persisted }
  }

  async function restore (chatId) {
    const key = idOf(chatId); const owned = committed.get(key)
    if (owned) { publishShared(chatId, owned); updateCountUi(chatId); return owned }
    const disk = await readPersistent(chatId).catch(() => null)
    if (belongsToChat(chatId, disk)) { hydrateRemovalState(chatId, disk); const next = normalize(chatId, disk); committed.set(key, next); publishShared(chatId, next); updateCountUi(chatId); return next }
    const shared = sharedSnapshot(chatId); return belongsToChat(chatId, shared) ? commitDiscovery(chatId, shared, { source: 'legacy-shared' }) : null
  }
  function mediaItemFromMessage (chatId, message) { if (!message || !message.media) return null; const id = message.media.messageId != null ? message.media.messageId : message.id; return id == null ? null : { ...message.media, messageId: id, chatId } }
  async function reconcileRecent (chatId, snapshot) {
    const key = idOf(chatId); if (!snapshot || recentJobs.has(key)) return recentJobs.get(key) || snapshot
    const job = (async () => {
      const anchor = snapshot.latestSeenMessageId || snapshot.newestMessageId || newestItemId(snapshot.items); let cursor = 0; let reachedAnchor = false; let latestSeen = snapshot.latestSeenMessageId || 0; const additions = []
      for (let page = 0; page < RECONCILE_MAX_PAGES && !reachedAnchor; page++) {
        const data = await request('get-messages', { chatId, fromMessageId: cursor || 0, limit: RECONCILE_PAGE_LIMIT }); const messages = Array.isArray(data && data.messages) ? data.messages : []; if (!messages.length) break
        if (!latestSeen) latestSeen = messages[0] && messages[0].id || 0
        for (const message of messages) { if (anchor && compareIds(message.id, anchor) <= 0) { reachedAnchor = true; break }; const item = mediaItemFromMessage(chatId, message); if (item && !idOf(item.messageId).startsWith('-')) additions.push(item) }
        if (reachedAnchor || !data.hasMore) break; const oldest = messages[messages.length - 1]; const nextCursor = oldest && oldest.id; if (!nextCursor || idOf(nextCursor) === idOf(cursor)) break; cursor = nextCursor
        if (page % 8 === 7) await new Promise(resolve => setTimeout(resolve, 0))
      }
      if (!additions.length && latestSeen === snapshot.latestSeenMessageId) return snapshot
      return commitDiscovery(chatId, { chatId, items: additions, scanned: snapshot.scanned, latestSeenMessageId: latestSeen || anchor, savedAt: Date.now(), done: snapshot.done !== false }, { source: 'recent' })
    })().catch(() => snapshot).finally(() => recentJobs.delete(key)); recentJobs.set(key, job); return job
  }
  function cancelLegacyFullScan (chatId) { try { Promise.resolve(request('cancel-media-scan-v3', { chatId })).catch(() => {}) } catch {} }
  function scheduleAutoReconcile (chatId) {
    if (typeof location === 'undefined') return
    const key = idOf(chatId); if (!key || autoReconcileTimers.has(key)) return
    const timer = setTimeout(() => { autoReconcileTimers.delete(key); reconcile(chatId).catch(() => {}) }, 250); if (timer && timer.unref) timer.unref(); autoReconcileTimers.set(key, timer)
  }
  async function ensure (chatId, options = {}) {
    if (chatId == null) return null; const key = idOf(chatId); if (loading.has(key)) return loading.get(key)
    const task = (async () => {
      let stable = await restore(chatId)
      if (stable && isCompleteSnapshot(chatId, stable) && !options.hardRefresh) { cancelLegacyFullScan(chatId); reconcileRecent(chatId, stable).catch(() => {}); scheduleAutoReconcile(chatId); return stable }
      fullScanJobs.add(key)
      try {
        const result = await request('scan-media-v3', { chatId, force: !!options.hardRefresh })
        if (belongsToChat(chatId, result)) { stable = await commitDiscovery(chatId, { ...result, chatId, savedAt: Number(result.savedAt || Date.now()) }, { source: options.hardRefresh ? 'hard-refresh' : 'scan' }); if (stable) reconcileRecent(chatId, stable).catch(() => {}) }
      } catch { if (!stable && state && idOf(state.activeChatId) === key) try { setLoadState('File index sync failed. Reopen Files to retry.') } catch {} } finally { fullScanJobs.delete(key) }
      scheduleAutoReconcile(chatId); return stable
    })().finally(() => loading.delete(key)); loading.set(key, task); return task
  }

  function formatMissing (missing) { const list = (missing || []).map(idOf); return list.length <= TRUTH_MISSING_LOG_LIMIT ? (list.join(',') || '-') : `${list.slice(0, TRUTH_MISSING_LOG_LIMIT).join(',')}…(+${list.length - TRUTH_MISSING_LOG_LIMIT})` }
  function logReconcile (details) {
    const missing = Array.isArray(details.missing) ? details.missing.map(idOf) : []
    const parts = [`chatId=${idOf(details.chatId)}`, `cached=${Number(details.cached || 0)}`, `live=${details.live == null ? 'unknown' : Number(details.live)}`, `missing=${details.live == null ? 'unknown' : `${missing.length}[${formatMissing(missing)}]`}`, `remaining=${Number(details.remaining || 0)}`, `persisted=${details.persisted || 'skipped(reason=unknown)'}`, `truth=${details.truth || 'unknown'}`, `complete=${details.complete === true ? 'true' : 'false'}`, `accessible=${details.accessible === false ? 'false' : details.accessible === true ? 'true' : 'unknown'}`]
    console.info(`[Files reconcile] ${parts.join(' ')}`, missing)
  }
  function clearBackoff (chatId) { const key = idOf(chatId); const current = backoff.get(key); if (current && current.timer) clearTimeout(current.timer); backoff.delete(key) }
  function scheduleBackoff (chatId) {
    const key = idOf(chatId); const current = backoff.get(key) || { delay: TRUTH_BACKOFF_START_MS, timer: null }; if (current.timer) return
    const delay = Math.max(TRUTH_BACKOFF_START_MS, Number(current.delay || TRUTH_BACKOFF_START_MS)); const timer = setTimeout(() => { const next = backoff.get(key); if (next) next.timer = null; reconcile(chatId, { force: true }).catch(() => {}) }, delay)
    if (timer && timer.unref) timer.unref(); backoff.set(key, { delay: Math.min(TRUTH_BACKOFF_MAX_MS, current.delay * 2), timer })
  }
  async function reconcile (chatId, options = {}) {
    if (chatId == null) return { status: 'skipped', reason: 'no-chat' }; const key = idOf(chatId)
    if (fullScanJobs.has(key) || progressInFlight.has(key) || candidates.has(key)) return { status: 'skipped', reason: 'scan-in-flight' }
    if (reconcileJobs.has(key)) return reconcileJobs.get(key)
    const last = Number(lastTruthPass.get(key) || 0); if (!options.force && last && Date.now() - last < TRUTH_THROTTLE_MS) return { status: 'skipped', reason: 'throttled' }
    const job = (async () => {
      let current = await restore(chatId); if (!current) return { status: 'skipped', reason: 'no-index' }; lastTruthPass.set(key, Date.now())
      let truth = null
      try { truth = await request('media-truth-v1', { chatId }) } catch (error) { truth = { ok: false, complete: false, accessible: true, error: String(error && error.message ? error.message : error), source: 'request' } }
      if (!(truth && truth.complete && truth.accessible !== false)) {
        scheduleBackoff(chatId); try { setLoadState('Could not verify against Telegram. Retrying automatically.') } catch {}
        logReconcile({ chatId, cached: current.items.length, live: null, missing: [], remaining: current.items.length, persisted: `skipped(reason=${truth && truth.error ? 'truth-error' : truth && truth.accessible === false ? 'chat-inaccessible' : 'truth-incomplete'})`, truth: truth && truth.source || 'unknown', complete: !!(truth && truth.complete), accessible: truth && truth.accessible })
        return { status: 'unknown', reason: truth && truth.error ? 'truth-error' : 'truth-incomplete' }
      }

      const rawIds = Array.isArray(truth.ids) ? truth.ids.map(idOf).filter(id => /^\d+$/.test(id)) : []
      const liveIds = new Set(rawIds)
      const reportedCount = Number(truth.count)
      if (!Number.isSafeInteger(reportedCount) || reportedCount < 0 || reportedCount !== liveIds.size || rawIds.length !== liveIds.size) {
        scheduleBackoff(chatId); try { setLoadState('Telegram file truth was inconsistent. Retrying automatically.') } catch {}
        logReconcile({ chatId, cached: current.items.length, live: Number.isFinite(reportedCount) ? reportedCount : null, missing: [], remaining: current.items.length, persisted: 'skipped(reason=truth-inconsistent)', truth: truth.source || 'unknown', complete: true, accessible: true })
        return { status: 'unknown', reason: 'truth-inconsistent' }
      }

      /* A complete truth ID set is allowed to remove stale rows only after the
       * owner also has metadata for every live ID. If the browser index is partial,
       * pruning immediately would turn "100 cached / 120 live" into an even smaller
       * intersection. Recover metadata through the normal full scanner first; its
       * result is discovery-only and therefore cannot lower the current index. */
      let knownIds = new Set(current.items.map(item => idOf(item.messageId)))
      let missingMetadata = [...liveIds].filter(id => !knownIds.has(id))
      if (missingMetadata.length) {
        fullScanJobs.add(key)
        try {
          const scan = await request('scan-media-v3', { chatId, force: true })
          if (belongsToChat(chatId, scan)) await commitDiscovery(chatId, { ...scan, chatId, savedAt: Number(scan.savedAt || Date.now()) }, { source: 'truth-metadata-recovery' })
        } catch {}
        finally { fullScanJobs.delete(key) }
        current = committed.get(key) || current
        knownIds = new Set(current.items.map(item => idOf(item.messageId)))
        missingMetadata = [...liveIds].filter(id => !knownIds.has(id))
        if (missingMetadata.length) {
          scheduleBackoff(chatId); try { setLoadState('File metadata is incomplete. Retrying automatically.') } catch {}
          logReconcile({ chatId, cached: current.items.length, live: liveIds.size, missing: [], remaining: current.items.length, persisted: `skipped(reason=metadata-incomplete:${missingMetadata.length})`, truth: truth.source || 'unknown', complete: true, accessible: true })
          return { status: 'unknown', reason: 'metadata-incomplete', missingMetadata: missingMetadata.length }
        }
      }

      clearBackoff(chatId)
      const missing = current.items.filter(item => !liveIds.has(idOf(item.messageId))).map(item => idOf(item.messageId))
      const remainingItems = current.items.filter(item => liveIds.has(idOf(item.messageId)))
      const at = Date.now()
      const result = await commitAuthoritative(chatId, { ...current, items: remainingItems, savedAt: at, done: remainingItems.length === reportedCount }, { at, truth: { ...truth, count: reportedCount }, presentIds: liveIds, removedIds: missing })
      const next = result.snapshot; const persisted = result.persisted && result.persisted.written ? 'written' : `skipped(reason=${result.persisted && result.persisted.reason || 'unknown'})`
      logReconcile({ chatId, cached: current.items.length, live: reportedCount, missing, remaining: next.items.length, persisted, truth: truth.source || 'unknown', complete: true, accessible: true })
      if (state && idOf(state.activeChatId) === key && state.view === 'files') try { setLoadState(`Loaded ${next.items.length.toLocaleString()} indexed files`) } catch {}
      return { status: missing.length ? 'pruned' : 'unchanged', missing: missing.length, remaining: next.items.length }
    })().finally(() => reconcileJobs.delete(key)); reconcileJobs.set(key, job); return job
  }

  async function mergeRealtimeUpsert (chatId, message) {
    const item = mediaItemFromMessage(chatId, message); if (!item || idOf(item.messageId).startsWith('-')) return
    const removedIds = currentRemovalMeta(chatId).removedIds
    if (removedIds.has(idOf(item.messageId))) return
    await restore(chatId); await commitDiscovery(chatId, { chatId, items: [item], scanned: 1, latestSeenMessageId: item.messageId, savedAt: Date.now(), done: true }, { source: 'realtime-upsert' })
  }
  function handleRealtimeDelete (event) {
    const payload = event && (event.payload || event) || {}; const chatId = payload.chatId != null ? payload.chatId : event && event.chatId; const permanent = payload.isPermanent === true || payload.is_permanent === true; const fromCache = payload.fromCache === true || payload.from_cache === true
    if (!permanent || fromCache) return
    const ids = (payload.messageIds || payload.message_ids || event && event.messageIds || []).map(idOf); if (chatId == null || !ids.length) return
    Promise.resolve(restore(chatId)).then(async previous => {
      if (!previous) return; const gone = new Set(ids); const nextItems = previous.items.filter(item => !gone.has(idOf(item.messageId))); if (nextItems.length === previous.items.length) return
      const truthCount = Math.max(nextItems.length, Number(previous.truthCount || previous.items.length) - (previous.items.length - nextItems.length))
      await commitAuthoritative(chatId, { ...previous, items: nextItems, savedAt: Date.now(), done: previous.done !== false }, { at: Date.now(), truth: { count: truthCount }, presentIds: new Set(nextItems.map(item => idOf(item.messageId))), removedIds: ids })
    }).catch(() => {})
  }
  function retireTemporary (chatId, ids) {
    if (chatId == null) return Promise.resolve(null); const explicit = Array.isArray(ids) && ids.length ? new Set(ids.map(idOf)) : null
    return Promise.resolve(restore(chatId)).then(async previous => {
      if (!previous) return null; const nextItems = previous.items.filter(item => explicit ? !explicit.has(idOf(item.messageId)) : !idOf(item.messageId).startsWith('-')); if (nextItems.length === previous.items.length) return previous
      const result = await commitAuthoritative(chatId, { ...previous, items: nextItems, savedAt: Date.now(), done: previous.done !== false }, { at: Date.now(), truth: { count: Math.max(0, Number(previous.truthCount || previous.items.length) - (previous.items.length - nextItems.length)) }, presentIds: new Set(nextItems.map(item => idOf(item.messageId))), removedIds: [] }); return result.snapshot
    })
  }
  async function hardRefresh (chatId) { clearTotalFloor(chatId); const snapshot = await ensure(chatId, { hardRefresh: true }); await reconcile(chatId, { force: true }); return committed.get(idOf(chatId)) || snapshot || null }

  function flushProgress (chatId, done) { const key = idOf(chatId); const c = candidates.get(key); if (!c) { if (done) progressInFlight.delete(key); return }; if (done) c.done = c.done && c.historyComplete !== false; if (c.items.length) commitDiscovery(chatId, c, { source: 'progress' }).catch(() => {}); candidates.delete(key); if (done) progressInFlight.delete(key) }
  function scheduleProgressFlush (chatId) { const key = idOf(chatId); if (flushTimers.has(key)) return; flushTimers.set(key, setTimeout(() => { flushTimers.delete(key); flushProgress(chatId, false) }, PROGRESS_FLUSH_MS)) }
  function mergeProgress (payload) {
    if (!payload || payload.chatId == null) return; const chatId = payload.chatId; const key = idOf(chatId); const stable = committed.get(key); if (payload.done) progressInFlight.delete(key); else progressInFlight.add(key)
    if (!fullScanJobs.has(key) && isCompleteSnapshot(chatId, stable) && stable.items.length) { if (flushTimers.has(key)) clearTimeout(flushTimers.get(key)); flushTimers.delete(key); candidates.delete(key); return }
    let c = candidates.get(key); if (!c) c = { chatId, items: [], scanned: 0, savedAt: Date.now(), done: false, historyComplete: false }
    if (Array.isArray(payload.items) && payload.items.length) c.items.push(...payload.items); c.scanned = Math.max(Number(c.scanned || 0), Number(payload.scanned || 0)); c.savedAt = Date.now(); c.done = !!payload.done; c.historyComplete = !!payload.historyComplete; candidates.set(key, c)
    if (c.items.length >= PROGRESS_FLUSH_ITEMS || payload.done) { if (flushTimers.has(key)) clearTimeout(flushTimers.get(key)); flushTimers.delete(key); flushProgress(chatId, !!payload.done) } else scheduleProgressFlush(chatId)
  }

  function installCompatibilityOwners () {
    ownCountLabel(); try { rescueEnsureAllFiles = ensure } catch {}
    try { rescueApplyCompleteFiles = function fileGramApplyFilesMetadataOnly (chatId) { const owned = committed.get(idOf(chatId)); if (owned) paint(chatId, owned); if (state) state.hasMore = state.hasMore !== false } } catch {}
    try { filesItems = function fileGramStableFilesItems () { let list = state.files.mode === 'search' ? (state.files.results || []).slice() : ((committed.get(idOf(state.activeChatId)) || {}).items || []); const q = String(state.files.query || '').trim().toLowerCase(); const filtered = q || state.files.filter !== 'all'; if (q) list = list.filter(item => String(item.name || '').toLowerCase().includes(q) || String(item.caption || '').toLowerCase().includes(q)); if (state.files.filter !== 'all') list = list.filter(item => item.type === state.files.filter); if (state.files.sort === 'oldest') return list.slice().reverse(); if (state.files.sort === 'name') return list.slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))); if (state.files.sort === 'size') return list.slice().sort((a, b) => Number(b.fileSize || 0) - Number(a.fileSize || 0)); if (state.files.mode === 'search' && !filtered) return list.slice().sort((a, b) => compareIds(b.messageId, a.messageId)); return list } } catch {}
  }
  function installEventOwner () {
    try {
      if (typeof handleEvent !== 'function' || handleEvent === ownerHandleEvent) return; const baseHandleEvent = handleEvent
      const wrapped = function fileGramStableHandleEvent (event) {
        if (!event) return baseHandleEvent(event); const seen = typeof event === 'object' && handledEvents.has(event)
        if (event.name === 'media-index-progress') { if (seen) return baseHandleEvent(event); handledEvents.add(event); mergeProgress(event.payload || {}); return }
        if (!seen && typeof event === 'object') handledEvents.add(event); const result = baseHandleEvent(event)
        if (!seen && event.name === 'message-delete') handleRealtimeDelete(event)
        if (!seen && event.name === 'message-upsert') { const payload = event.payload || event; const chatId = payload.chatId != null ? payload.chatId : event.chatId; const message = payload.message || event.message; if (chatId != null && message) mergeRealtimeUpsert(chatId, message).catch(() => {}) }
        return result
      }
      wrapped.__fileGramFilesOwner = true; ownerHandleEvent = wrapped; handleEvent = wrapped
    } catch {}
  }
  function installOpenChatOwner () {
    try { if (typeof openChat !== 'function' || openChat.__fileGramFilesOwner) return; const base = openChat; const wrapped = async function fileGramStableOpenChat (chatId) { const result = await base(chatId); ensure(chatId).then(() => scheduleAutoReconcile(chatId)).catch(() => {}); return result }; wrapped.__fileGramFilesOwner = true; openChat = wrapped } catch {}
  }
  function installRuntimeOwnership () { installCompatibilityOwners(); installEventOwner(); installOpenChatOwner() }

  migrateLegacyReconcileMark(); installRuntimeOwnership()
  window.teleFilesIndex = {
    ensure,
    count: chatId => { const snapshot = committed.get(idOf(chatId)); return snapshot && Array.isArray(snapshot.items) ? snapshot.items.length : 0 },
    snapshot: chatId => cloneSnapshot(committed.get(idOf(chatId)) || null),
    total: chatId => { const snapshot = committed.get(idOf(chatId)); return snapshot && Array.isArray(snapshot.items) ? snapshot.items.length : 0 },
    reconcile,
    retireTemporary,
    hardRefresh
  }
  setTimeout(() => { installRuntimeOwnership(); try { if (state && state.activeChatId != null) ensure(state.activeChatId).catch(() => {}) } catch {} }, 0)
})()
