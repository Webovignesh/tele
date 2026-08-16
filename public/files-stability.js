'use strict'

/* FileGram persistent Files index owner.
 *
 * Rules:
 * - restore the committed per-chat index before doing network work;
 * - a refresh/revisit never starts another full-history scan when a committed
 *   index already exists;
 * - after restore, reconcile only messages newer than the last seen message;
 * - progressive scans only add to the committed index and are flushed in
 *   coarse batches so 20k+ indexes do not re-sort on every 100-item event;
 * - one owner handles media-index-progress so legacy layers cannot temporarily
 *   replace a complete count with a partial scan count;
 * - Files data never gets copied into state.messages. Messages and Files are
 *   separate data sets, which keeps chat switching and the Messages tab fast.
 */
;(function fileGramFilesStability () {
  const committed = new Map()
  const loading = new Map()
  const reconcileJobs = new Map()
  const candidates = new Map()
  const persistTimers = new Map()
  const paintTimers = new Map()
  const flushTimers = new Map()
  const fullScanJobs = new Set()
  const persistentReadJobs = new Map()

  const PROGRESS_FLUSH_MS = 350
  const PROGRESS_FLUSH_ITEMS = 800
  const RECONCILE_PAGE_LIMIT = 100
  const RECONCILE_MAX_PAGES = 2500

  /* Durable per-chat floor for the AUTHORITATIVE TOTAL.
   *
   * Same storage the scan guard already maintains, deliberately: one record, no
   * second source of truth. It exists because a short or partial scan can be
   * stamped done and land in the shared cache, and the header would then print a
   * number below one we have already proven (the 22,479 -> 17,484 -> 22,479
   * shrink). The floor is a total-only concept: FILTERED, CURRENT PAGE, SELECTED
   * and DOWNLOAD QUEUE counts are never compared against it.
   *
   * It expires like the guard's copy so a channel that genuinely loses files is
   * not pinned high forever, and a hard refresh clears it outright. */
  const HIGH_WATER_KEY = 'tele-file-index-high-water-v1'
  const HIGH_WATER_TTL = 14 * 24 * 60 * 60 * 1000

  function readHighWater () {
    try { return JSON.parse(localStorage.getItem(HIGH_WATER_KEY) || '{}') || {} } catch { return {} }
  }

  function writeHighWater (map) {
    try { localStorage.setItem(HIGH_WATER_KEY, JSON.stringify(map)) } catch {}
  }

  function totalFloor (chatId) {
    const entry = readHighWater()[idOf(chatId)]
    if (!entry) return 0
    if (Date.now() - Number(entry.at || 0) > HIGH_WATER_TTL) return 0
    return Math.max(0, Number(entry.count || 0))
  }

  /* Records a PROVEN-COMPLETE count. Callers must not pass partial scan counts:
   * the floor gates completeness checks and index repair, so a partial value would
   * both mask a real regression and trigger phantom rescans. */
  function rememberTotalFloor (chatId, count) {
    const value = Math.max(0, Number(count || 0))
    if (!value) return
    const map = readHighWater()
    const key = idOf(chatId)
    if (map[key] && Number(map[key].count || 0) >= value) return
    map[key] = { count: value, at: Date.now() }
    writeHighWater(map)
  }

  function clearTotalFloor (chatId) {
    const map = readHighWater()
    delete map[idOf(chatId)]
    writeHighWater(map)
  }

  function idOf (value) { return String(value) }

  function compareIds (a, b) {
    let aa = 0n; let bb = 0n
    try { aa = BigInt(String(a || 0)) } catch {}
    try { bb = BigInt(String(b || 0)) } catch {}
    return aa === bb ? 0 : (aa < bb ? -1 : 1)
  }

  function belongsToChat (chatId, snapshot) {
    if (!snapshot || !Array.isArray(snapshot.items)) return false
    const id = idOf(chatId)
    return snapshot.items.every(item => item && idOf(item.chatId) === id)
  }

  /* Completeness is a size question as well as a flag question. `done` is set by
   * whichever layer produced the snapshot, and a partial batch stamped done:true
   * used to satisfy this check - restore() then adopted it as the committed index
   * and the header shrank. A snapshot below the proven floor is treated as
   * incomplete, so restore() falls through to the persistent read and union, and
   * mergeProgress is allowed to rebuild it upward. */
  function isCompleteSnapshot (chatId, snapshot) {
    if (!belongsToChat(chatId, snapshot) || snapshot.done === false || !Array.isArray(snapshot.items)) return false
    return snapshot.items.length >= totalFloor(chatId)
  }

  function newestItemId (items) {
    let newest = 0
    for (const item of items || []) {
      if (item && item.messageId != null && (!newest || compareIds(item.messageId, newest) > 0)) newest = item.messageId
    }
    return newest
  }

  function normalize (chatId, snapshot) {
    const id = idOf(chatId)
    const byMessage = new Map()
    let scanned = 0
    let savedAt = Date.now()
    let latestSeenMessageId = snapshot && snapshot.latestSeenMessageId || 0
    for (const source of [snapshot]) {
      if (!source || !Array.isArray(source.items)) continue
      scanned = Math.max(scanned, Number(source.scanned || 0))
      savedAt = Math.max(savedAt, Number(source.savedAt || 0))
      if (source.latestSeenMessageId && compareIds(source.latestSeenMessageId, latestSeenMessageId) > 0) latestSeenMessageId = source.latestSeenMessageId
      for (const item of source.items) {
        if (!item || idOf(item.chatId) !== id || item.messageId == null) continue
        byMessage.set(idOf(item.messageId), { ...item, chatId })
      }
    }
    const items = [...byMessage.values()]
    items.sort((a, b) => compareIds(b.messageId, a.messageId))
    const typeCounts = {}
    for (const item of items) typeCounts[item.type] = (typeCounts[item.type] || 0) + 1
    return {
      chatId,
      items,
      found: items.length,
      scanned: Math.max(scanned, items.length),
      typeCounts,
      newestMessageId: newestItemId(items),
      latestSeenMessageId,
      savedAt,
      done: snapshot ? snapshot.done !== false : true
    }
  }

  /* Union of item sets. `done` means "this set is known to cover the chat's whole
   * history", so it is OR across the inputs, not AND.
   *
   * It used to be AND, which made incompleteness permanent and was the mechanism
   * behind every count fluctuation. flushProgress commits progress candidates that
   * carry done:false, so the first partial flush set the committed index to
   * done:false; from then on every union ANDed against that false, including the
   * union with the finished scan-media-v3 result (done:true). The index therefore
   * stayed flagged incomplete forever, which silently disabled the guard in
   * mergeProgress that ignores obsolete partial scans, stopped restore() from
   * fast-pathing, and pinned the status line to "Indexing files...".
   *
   * OR is the correct semantic: a complete set plus newer items is still complete,
   * while two partials remain partial. */
  function union (chatId, ...snapshots) {
    const id = idOf(chatId)
    const byMessage = new Map()
    let scanned = 0
    let savedAt = 0
    let latestSeenMessageId = 0
    let done = false
    for (const snapshot of snapshots) {
      if (!belongsToChat(chatId, snapshot)) continue
      scanned = Math.max(scanned, Number(snapshot.scanned || 0))
      savedAt = Math.max(savedAt, Number(snapshot.savedAt || 0))
      done = done || snapshot.done !== false
      if (snapshot.latestSeenMessageId && compareIds(snapshot.latestSeenMessageId, latestSeenMessageId) > 0) latestSeenMessageId = snapshot.latestSeenMessageId
      for (const item of snapshot.items) {
        if (!item || idOf(item.chatId) !== id || item.messageId == null) continue
        byMessage.set(idOf(item.messageId), { ...item, chatId })
      }
    }
    return normalize(chatId, { items: [...byMessage.values()], scanned, savedAt: savedAt || Date.now(), latestSeenMessageId, done })
  }

  function sharedSnapshot (chatId) {
    try {
      if (typeof rescueFileCache !== 'undefined' && rescueFileCache && rescueFileCache.get) {
        const value = rescueFileCache.get(idOf(chatId))
        if (belongsToChat(chatId, value)) return value
      }
    } catch {}
    return null
  }

  function setSharedSnapshot (chatId, snapshot) {
    try {
      if (typeof rescueFileCache !== 'undefined' && rescueFileCache && rescueFileCache.set) rescueFileCache.set(idOf(chatId), snapshot)
    } catch {}
  }

  /* THE authoritative total writer. Only the committed persistent index feeds it,
   * raised to the durable floor so a partial snapshot can never lower it.
   *
   * Never write a FILTERED, CURRENT PAGE, SEARCH RESULT or DOWNLOAD QUEUE count
   * here. Those belong to the pager (files-view.js), the Select all button and
   * the downloads panel respectively. */
  /* If the committed index is smaller than a count we have already PROVEN complete,
   * the index regressed. Rebuild it instead of printing a number the list cannot
   * back up: the header used to display max(measured, floor), which is how the
   * header could read 22,479 while Select all and the pager read 21,045. One
   * attempt per chat per session, so a channel that genuinely lost files does not
   * rescan in a loop. */
  const repairAttempts = new Set()

  function maybeRepairIndex (chatId, snapshot) {
    const id = idOf(chatId)
    if (repairAttempts.has(id)) return
    if (snapshot.done === false) return // a scan is still streaming; it is growing
    const floor = totalFloor(chatId)
    if (!floor || snapshot.items.length >= floor) return
    repairAttempts.add(id)
    try { setLoadState(`Repairing index (${snapshot.items.length.toLocaleString()} of ${floor.toLocaleString()} known files)`) } catch {}
    Promise.resolve(ensure(chatId, { hardRefresh: true })).catch(() => {})
  }

  function updateCountUi (chatId) {
    if (state.activeChatId == null || idOf(state.activeChatId) !== idOf(chatId)) return
    const snapshot = committed.get(idOf(chatId)) || sharedSnapshot(chatId)
    if (!snapshot) return
    // The REAL committed count. Never a remembered high-water and never a filtered,
    // page, search or download-queue figure.
    const total = snapshot.items.length
    // Only a snapshot covering the whole history may raise the durable floor, so a
    // partial scan cannot inflate it and then trigger a phantom repair.
    if (snapshot.done !== false) rememberTotalFloor(chatId, total)
    maybeRepairIndex(chatId, snapshot)
    state.mediaCount = total
    state.typeCounts = snapshot.typeCounts
    const count = document.querySelector('#chat-media-count')
    if (count) count.textContent = `${total.toLocaleString()} file${total === 1 ? '' : 's'}`
    const all = document.querySelector('#download-all-media')
    if (all) {
      all.textContent = `Download all media (${total.toLocaleString()})`
      all.disabled = total === 0
    }
  }

  /* This layer takes ownership of the legacy label symbols.
   *
   * They were last assigned by daily-driver-final-guard.js (guardUpdateMediaLabel),
   * which reads the shared, partial-writable rescueFileCache and applies no floor -
   * it records a high-water mark and then never consults it when painting. Every
   * legacy caller (openChat, the P0/P1 layers, the scan handlers) went through
   * that symbol, so the authoritative index owner was bypassed entirely. */
  function ownCountLabel () {
    const paint = function fileGramStableUpdateMediaLabel () {
      const chatId = state.activeChatId
      const label = document.querySelector('#chat-media-count')
      const all = document.querySelector('#download-all-media')
      if (chatId == null) {
        if (label) label.textContent = ''
        if (all) { all.textContent = 'Download all media'; all.disabled = true }
        return
      }
      const snapshot = committed.get(idOf(chatId)) || sharedSnapshot(chatId)
      if (!snapshot) {
        // No index yet. Say so rather than printing a number we cannot defend.
        if (label) label.textContent = state.view === 'files' ? 'Indexing files\u2026' : ''
        if (all) { all.textContent = 'Download all media'; all.disabled = true }
        return
      }
      updateCountUi(chatId)
    }
    try { updateMediaCountLabel = paint } catch {}
    try { rescueUpdateMediaLabel = paint } catch {}
  }

  function schedulePaint (chatId) {
    const id = idOf(chatId)
    if (paintTimers.has(id)) return
    paintTimers.set(id, setTimeout(() => {
      paintTimers.delete(id)
      updateCountUi(chatId)
      if (state.activeChatId != null && idOf(state.activeChatId) === id && state.view === 'files') {
        try { renderFiles() } catch {}
      }
    }, 80))
  }

  function schedulePersist (chatId, immediate = false) {
    const id = idOf(chatId)
    if (persistTimers.has(id)) clearTimeout(persistTimers.get(id))
    const write = () => {
      persistTimers.delete(id)
      const snapshot = committed.get(id)
      if (!snapshot) return
      if (typeof teleP0v2WriteIndex === 'function') Promise.resolve(teleP0v2WriteIndex(chatId, snapshot)).catch(() => {})
    }
    if (immediate) write()
    else persistTimers.set(id, setTimeout(write, 700))
  }

  function commitUnion (chatId, snapshot, options = {}) {
    if (!belongsToChat(chatId, snapshot)) return committed.get(idOf(chatId)) || null
    const id = idOf(chatId)
    const previous = committed.get(id)
    const next = previous ? union(chatId, previous, snapshot) : normalize(chatId, snapshot)
    committed.set(id, next)
    setSharedSnapshot(chatId, next)
    updateCountUi(chatId)
    if (options.persist) schedulePersist(chatId, !!options.immediate)
    if (options.paint !== false) schedulePaint(chatId)
    return next
  }

  function installPersistentReadDedupe () {
    if (typeof teleP0v2ReadIndex !== 'function' || teleP0v2ReadIndex.__fileGramDeduped) return
    const baseRead = teleP0v2ReadIndex
    const deduped = function fileGramDedupedPersistentRead (chatId) {
      const id = idOf(chatId)
      if (persistentReadJobs.has(id)) return persistentReadJobs.get(id)
      const job = Promise.resolve(baseRead(chatId)).finally(() => persistentReadJobs.delete(id))
      persistentReadJobs.set(id, job)
      return job
    }
    deduped.__fileGramDeduped = true
    teleP0v2ReadIndex = deduped
  }

  async function restore (chatId) {
    const id = idOf(chatId)
    const memory = committed.get(id)
    if (isCompleteSnapshot(chatId, memory)) {
      setSharedSnapshot(chatId, memory)
      updateCountUi(chatId)
      return memory
    }

    const shared = sharedSnapshot(chatId)
    if (isCompleteSnapshot(chatId, shared)) {
      committed.set(id, shared)
      updateCountUi(chatId)
      return shared
    }

    let best = memory && belongsToChat(chatId, memory) ? memory : null
    if (shared) best = best ? union(chatId, best, shared) : normalize(chatId, shared)
    if (typeof teleP0v2ReadIndex === 'function') {
      const disk = await Promise.resolve(teleP0v2ReadIndex(chatId)).catch(() => null)
      if (belongsToChat(chatId, disk)) best = best ? union(chatId, best, disk) : normalize(chatId, disk)
    }
    if (best) {
      committed.set(id, best)
      setSharedSnapshot(chatId, best)
      updateCountUi(chatId)
    }
    return best
  }

  function mediaItemFromMessage (chatId, message) {
    if (!message || !message.media) return null
    const media = message.media
    if (media.messageId == null) media.messageId = message.id
    if (media.chatId == null) media.chatId = chatId
    return media && media.messageId != null ? { ...media, chatId } : null
  }

  async function reconcileRecent (chatId, snapshot) {
    const id = idOf(chatId)
    if (!snapshot || reconcileJobs.has(id)) return reconcileJobs.get(id) || snapshot

    const job = (async () => {
      const anchor = snapshot.latestSeenMessageId || snapshot.newestMessageId || newestItemId(snapshot.items)
      let cursor = 0
      let reachedAnchor = false
      let latestSeen = snapshot.latestSeenMessageId || 0
      const additions = []

      for (let page = 0; page < RECONCILE_MAX_PAGES && !reachedAnchor; page++) {
        const data = await request('get-messages', { chatId, fromMessageId: cursor || 0, limit: RECONCILE_PAGE_LIMIT })
        const messages = Array.isArray(data && data.messages) ? data.messages : []
        if (!messages.length) break
        if (!latestSeen) latestSeen = messages[0] && messages[0].id || 0

        for (const message of messages) {
          if (anchor && compareIds(message.id, anchor) <= 0) {
            reachedAnchor = true
            break
          }
          const item = mediaItemFromMessage(chatId, message)
          if (item) additions.push(item)
        }

        if (reachedAnchor || !data.hasMore) break
        const oldest = messages[messages.length - 1]
        const nextCursor = oldest && oldest.id
        if (!nextCursor || idOf(nextCursor) === idOf(cursor)) break
        cursor = nextCursor
        if (page % 8 === 7) await new Promise(resolve => setTimeout(resolve, 0))
      }

      const metaSnapshot = {
        chatId,
        items: additions,
        scanned: snapshot.scanned,
        latestSeenMessageId: latestSeen || anchor,
        savedAt: Date.now(),
        done: true
      }
      const beforeCount = snapshot.items.length
      const next = commitUnion(chatId, metaSnapshot, { persist: true, immediate: true, paint: additions.length > 0 }) || snapshot
      if (state.activeChatId != null && idOf(state.activeChatId) === id && state.view === 'files') {
        if (next.items.length > beforeCount) {
          try { setLoadState(`${next.items.length.toLocaleString()} files · ${next.items.length - beforeCount} new`) } catch {}
        } else {
          try { setLoadState(`Loaded ${next.items.length.toLocaleString()} indexed files`) } catch {}
        }
      }
      return next
    })().catch(() => snapshot).finally(() => reconcileJobs.delete(id))

    reconcileJobs.set(id, job)
    return job
  }

  function cancelLegacyFullScan (chatId) {
    Promise.resolve(request('cancel-media-scan-v3', { chatId })).catch(() => {})
  }

  async function ensure (chatId, options = {}) {
    if (chatId == null) return null
    const id = idOf(chatId)
    if (loading.has(id)) return loading.get(id)

    const task = (async () => {
      let stable = await restore(chatId)
      if (stable && stable.items.length && !options.hardRefresh) {
        // A complete persistent index is authoritative. Kill any older full scan
        // that may have been started by a legacy startup layer before this owner
        // installed, then reconcile only the newest delta.
        cancelLegacyFullScan(chatId)
        if (state.activeChatId != null && idOf(state.activeChatId) === id && state.view === 'files') {
          try { setLoadState(`Loaded ${stable.items.length.toLocaleString()} indexed files`) } catch {}
          schedulePaint(chatId)
        }
        reconcileRecent(chatId, stable).catch(() => {})
        return stable
      }

      fullScanJobs.add(id)
      try {
        const result = await request('scan-media-v3', { chatId, force: !!options.hardRefresh })
        if (belongsToChat(chatId, result)) {
          stable = commitUnion(chatId, result, { persist: true, immediate: true })
          if (stable) reconcileRecent(chatId, stable).catch(() => {})
        }
      } catch (error) {
        if (!stable && state.activeChatId != null && idOf(state.activeChatId) === id) {
          try { setLoadState('File index sync failed. Reopen Files to retry.') } catch {}
        }
      } finally {
        fullScanJobs.delete(id)
      }
      return stable
    })().finally(() => loading.delete(id))

    loading.set(id, task)
    return task
  }

  function flushProgress (chatId, done) {
    const id = idOf(chatId)
    const candidate = candidates.get(id)
    if (!candidate || !candidate.items.length) {
      if (done) candidates.delete(id)
      return
    }
    commitUnion(chatId, candidate, { paint: true, persist: done, immediate: done })
    candidates.set(id, { chatId, items: [], scanned: candidate.scanned, latestSeenMessageId: candidate.latestSeenMessageId || 0, done: false })
    if (done) candidates.delete(id)
  }

  function scheduleProgressFlush (chatId) {
    const id = idOf(chatId)
    if (flushTimers.has(id)) return
    flushTimers.set(id, setTimeout(() => {
      flushTimers.delete(id)
      flushProgress(chatId, false)
    }, PROGRESS_FLUSH_MS))
  }

  function mergeProgress (payload) {
    if (!payload || payload.chatId == null) return
    const chatId = payload.chatId
    const id = idOf(chatId)
    const stable = committed.get(id) || sharedSnapshot(chatId)

    // Ignore progress from obsolete full-history scans whenever a complete
    // persistent index already exists. Those events caused the visible count to
    // jump 22k -> 6k -> 22k while also re-sorting large arrays in the browser.
    if (!fullScanJobs.has(id) && isCompleteSnapshot(chatId, stable) && stable.items.length) {
      if (flushTimers.has(id)) clearTimeout(flushTimers.get(id))
      flushTimers.delete(id)
      candidates.delete(id)
      updateCountUi(chatId)
      return
    }

    let candidate = candidates.get(id)
    if (!candidate) candidate = { chatId, items: [], scanned: 0, latestSeenMessageId: 0, done: false }

    if (Array.isArray(payload.items) && payload.items.length) candidate.items.push(...payload.items)
    candidate.scanned = Math.max(Number(candidate.scanned || 0), Number(payload.scanned || 0))
    candidate.done = !!payload.done
    candidates.set(id, candidate)

    if (candidate.items.length >= PROGRESS_FLUSH_ITEMS || payload.done) {
      if (flushTimers.has(id)) clearTimeout(flushTimers.get(id))
      flushTimers.delete(id)
      flushProgress(chatId, !!payload.done)
    } else {
      scheduleProgressFlush(chatId)
    }

    if (payload.done) {
      const final = committed.get(id)
      if (final && state.activeChatId != null && idOf(state.activeChatId) === id) {
        try { setLoadState(`Indexed ${final.items.length.toLocaleString()} files`) } catch {}
      }
    }
  }

  function syncFromSharedAfterRealtime (chatId) {
    queueMicrotask(() => {
      const shared = sharedSnapshot(chatId)
      if (shared) commitUnion(chatId, shared, { persist: true, paint: true })
    })
  }

  // Files must not be copied into state.messages. That old behavior is the main
  // reason switching back to a 20k/40k chat caused a long main-thread pause and
  // also contaminated the Messages tab.
  rescueApplyCompleteFiles = function fileGramApplyFilesMetadataOnly (chatId, snapshot) {
    if (!snapshot || !Array.isArray(snapshot.items)) return
    state.mediaCount = snapshot.items.length
    state.typeCounts = snapshot.typeCounts || null
    state.hasMore = state.hasMore !== false
  }

  installPersistentReadDedupe()
  ownCountLabel()
  rescueEnsureAllFiles = ensure

  // The committed index is already newest-first. Avoid cloning+sorting 40k rows
  // on every render/scroll. Only derive a new array when a filter/search/sort
  // actually requires it.
  filesItems = function fileGramStableFilesItems () {
    let list
    if (state.files.mode === 'search') {
      list = Array.isArray(state.files.results) ? state.files.results.slice() : []
    } else {
      const chatId = state.activeChatId
      const stable = chatId == null ? null : (committed.get(idOf(chatId)) || sharedSnapshot(chatId))
      list = stable && Array.isArray(stable.items) ? stable.items : []
    }

    const query = String(state.files.query || '').trim().toLowerCase()
    const filtered = query || state.files.filter !== 'all'
    if (query) list = list.filter(item => String(item.name || '').toLowerCase().includes(query) || String(item.caption || '').toLowerCase().includes(query))
    if (state.files.filter !== 'all') list = list.filter(item => item.type === state.files.filter)

    if (state.files.sort === 'oldest') return list.slice().reverse()
    if (state.files.sort === 'name') return list.slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
    if (state.files.sort === 'size') return list.slice().sort((a, b) => Number(b.fileSize || 0) - Number(a.fileSize || 0))
    if (state.files.mode === 'search' && !filtered) return list.slice().sort((a, b) => compareIds(b.messageId, a.messageId))
    return list
  }

  const baseHandleEvent = handleEvent
  handleEvent = function fileGramStableHandleEvent (event) {
    if (!event) return baseHandleEvent(event)

    // This layer is the sole owner of media-index-progress. Do not call the
    // legacy chain first: older P1/P0 handlers repaint partial scan snapshots
    // and are the direct cause of the count fluctuation visible in the UI.
    if (event.name === 'media-index-progress') {
      mergeProgress(event.payload || {})
      return
    }

    const result = baseHandleEvent(event)
    if (event.name === 'message-upsert' || event.name === 'message-delete') {
      const payload = event.payload || event
      if (payload.chatId != null) syncFromSharedAfterRealtime(payload.chatId)
    }
    return result
  }

  queueMicrotask(() => {
    if (state.activeChatId != null) ensure(state.activeChatId).catch(() => {})
  })

  window.teleFilesIndex = {
    ensure,
    count: chatId => {
      const snapshot = committed.get(idOf(chatId)) || sharedSnapshot(chatId)
      return snapshot && Array.isArray(snapshot.items) ? snapshot.items.length : 0
    },
    /* THE source of truth for the Files list.
     *
     * Everything that shows a total must read this, so the header, Download all,
     * Select all and the pager cannot disagree. Reading rescueFileCache directly
     * is what let them diverge: legacy layers still write that cache, so the list
     * could show 21,045 while the header showed 22,479. */
    snapshot: chatId => committed.get(idOf(chatId)) || sharedSnapshot(chatId) || null,
    // Alias kept for callers that only want the number.
    total: chatId => {
      const snapshot = committed.get(idOf(chatId)) || sharedSnapshot(chatId)
      return snapshot && Array.isArray(snapshot.items) ? snapshot.items.length : 0
    },
    // An explicit hard refresh is the one operation allowed to lower the total,
    // so it drops the floor first and rebuilds from the scan.
    hardRefresh: chatId => {
      clearTotalFloor(chatId)
      return ensure(chatId, { hardRefresh: true })
    }
  }
})()
