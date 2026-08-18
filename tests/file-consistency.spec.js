// @ts-check
'use strict'

/* Bug condition exploration tests for .kiro/specs/files-consistency-and-folder-picker.
 *
 * Written in task 2 against unfixed code, where all ten FAILED - that failure was the
 * evidence the three defects existed. They encode the EXPECTED behaviour, so task 11.1
 * re-runs this same file, and their passing is what validates the fix. The ten tests and
 * their assertions are unchanged in MEANING. Only the fixture plumbing moved, and every
 * place a measurement had to be re-pointed is named below.
 *
 * ONE FIXTURE OWNER. This file used to carry its own copy of the fixture scaffolding -
 * `serveFixture`, `installGlobals`, `LAYERS`, `REAL_DL_CONTROLS`, `LOGIC_DOM`,
 * `LAYOUT_DOM`, the generators and the honesty guards - duplicated from
 * `tests/fixture-support.js`. That duplication is the same defect this whole fix is
 * about: two owners of one concern, and the one that wins is whichever file you happen
 * to read. It bit exactly as predicted. Task 8.1 deleted `#dl-dir` from
 * `public/index.html`; `tests/fixture-support.js` was updated for the new markup and
 * this file was not, so its private slice still demanded `id="dl-dir"` and threw at
 * module load:
 *
 *   Error: extracted .dl-controls block is not the real Save-to markup
 *   Error: No tests found.
 *
 * The whole suite stopped loading. There is now one fixture owner, `fixture-support.js`,
 * and this file holds tests only.
 *
 * WHAT WAS RE-POINTED, and why none of it weakens a test:
 *
 * 1. The persistence boundary (test 1). It used to call `window.teleP0v2WriteIndex` /
 *    `teleP0v2ReadIndex` directly. Task 9.2 DELETED that boundary; `public/files-stability.js`
 *    `writePersistent` is the boundary now, it lives inside the owner's closure, and the
 *    only way in is `commitAuthoritative` - which is the point of the fix. The test now
 *    drives a real truth pass and reads the record straight out of IndexedDB
 *    (`__seedRecord` / `__readRecord`). Same assertion, same numbers: the persisted
 *    record must equal the truth count, including zero.
 * 2. `live-media-ids` (tests 4, 5, 6). Task 4.3 DELETED
 *    `GET /api/filegram/live-media-ids/:chatId`; it is HTTP 404 now. Test 4's "the live
 *    truth source must answer, not fail" is re-pointed at `media-truth-v1`, the ws
 *    request in `server.js` that replaced it, and is asked of the REAL server for the
 *    real chat TEST. The assertion is the same one: the truth source must answer rather
 *    than fail with `Unknown class "messageFilterDocument"`.
 * 3. `reconcile-message-ids` (test 6). Also deleted by task 4.3. The count of
 *    reconciliation attempts is now the count of `media-truth-v1` calls the owner makes.
 * 4. `file-consistency-v2.js` (tests 4, 5, 7, 8). Deleted by task 9.1, so it cannot be
 *    loaded. Its reconciliation, its picker handler and its Save-to paint were the
 *    subjects; the owner, `public/app.js` and `public/index.html` + `filegram-ui.css`
 *    are the subjects now.
 * 5. Deleted DOM nodes (tests 7, 8). Task 8.1 removed `#dl-dir`, `#dl-dir-current`,
 *    `.fg-folder-path` and `.fg-folder-label` from the tree. They are re-pointed at the
 *    single control's own parts: `#dl-dir-path` / `.fg-save-to-path` for the path display
 *    and `.fg-save-to-label` for the label. The assertions still say "exactly one click
 *    target", "exactly one visible path display", "the control fills its parent" and
 *    "nothing is clipped" - the same four claims, about the node that now exists.
 * 6. Test 8 moved from the fixture to the RUNNING application. The single handler and
 *    the single painter both live in `public/app.js` now, which the fixture deliberately
 *    does not load (it would BE the app). Instrumenting the real page before any script
 *    runs is strictly stronger than the fixture version, which task 2 recorded as seeing
 *    only two of the three writers Phase 0 found live. Its picker call is routed to a
 *    cancel, so no native dialog opens and the user's configured folder is never changed.
 *
 * Tests 4, 8, 9 and 10 need the FileGram server running at http://127.0.0.1:3000
 * (`npm start`). They talk to it for real rather than mocking it.
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { test, expect } = require('@playwright/test')
const WebSocket = require('ws')

const {
  PUBLIC,
  SERVER,
  TEST_CHAT_ID,
  STALE_COUNT,
  CONFIGURED_DIR,
  HIGH_WATER_KEY,
  RECONCILE_MARK_KEY,
  LAYERS,
  INDEX_HTML,
  LOGIC_DOM,
  LAYOUT_DOM,
  rng,
  shrinkPairs,
  generatedPaths,
  serveFixture,
  installGlobals,
  loadLayers,
  assertRealBoundary,
  assertRealStylesheets,
  note,
  assertServerRunning
} = require('./fixture-support')

/* Derived chat ids for the generalised legs, so each generated case gets its own chat
 * and its own removal metadata instead of inheriting the previous case's. */
function caseChat (index) {
  return `-10044745147${String(60 + index)}`
}

/* One ws round trip against the REAL server, using the same framing the browser uses
 * (`{id,type,payload}` out, `{type:'response',id,ok,data,error}` back). */
function serverRequest (type, payload, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket('ws://127.0.0.1:3000')
    const timer = setTimeout(() => {
      try { socket.terminate() } catch {}
      reject(new Error(`ws ${type} timed out after ${timeout} ms`))
    }, timeout)
    socket.on('open', () => socket.send(JSON.stringify({ id: 1, type, payload })))
    socket.on('message', raw => {
      let message = null
      try { message = JSON.parse(String(raw)) } catch { return }
      if (!message || message.type !== 'response') return
      clearTimeout(timer)
      try { socket.close() } catch {}
      resolve(message)
    })
    socket.on('error', error => { clearTimeout(timer); reject(error) })
  })
}

/* ============================================================================
 * Test 1 - persistence boundary (hypothesis 2, clauses 1.6 / 2.6)
 *
 * RE-POINTED: the boundary under test is the owner's `writePersistent`, reached the
 * only way anything may reach it - a confirmed truth pass through
 * `commitAuthoritative`. The legacy `teleP0v2WriteIndex` this used to call directly no
 * longer exists (task 9.2). The record is read straight out of IndexedDB, so the
 * owner's own code never stands in for what is actually stored.
 * ==========================================================================*/

test('1 persistence boundary: a truth pass that shrinks the index is written durably', async ({ page }) => {
  test.setTimeout(120000)
  await serveFixture(page, LOGIC_DOM)
  await installGlobals(page, TEST_CHAT_ID)
  await loadLayers(page, [LAYERS.owner])
  await assertRealBoundary(page)

  const cases = shrinkPairs(0x5eed01, 5)
  const results = await page.evaluate(async ({ chatId, cases, chats }) => {
    const out = []
    for (let index = 0; index < cases.length; index++) {
      const item = cases[index]
      const chat = index === 0 ? chatId : chats[index]
      window.state.activeChatId = chat
      await window.teleFilesIndex.ensure(chat)
      const before = await window.__readRecord(chat)
      // Then commit the truth pass. This is the only subtractive path there is.
      window.__truthResponse = window.__truthAnswer(window.__itemsRange(chat, 0, item.truth).map(row => row.messageId))
      const pass = await window.teleFilesIndex.reconcile(chat, { force: true })
      const after = await window.__readRecord(chat)
      const snapshot = window.teleFilesIndex.snapshot(chat)
      out.push({
        chatId: chat,
        stored: item.stored,
        truth: item.truth,
        status: pass && pass.status,
        committed: snapshot ? snapshot.items.length : null,
        recordBefore: before ? before.items.length : null,
        recordAfter: after ? after.items.length : null,
        recordTruthCount: after ? after.truthCount : null,
        recordRemovedIds: after && Array.isArray(after.removedIds) ? after.removedIds.length : null
      })
    }
    return out
  }, { chatId: TEST_CHAT_ID, cases, chats: cases.map((_, index) => caseChat(index)) })

  note('test 1 persistence boundary', results)

  const concrete = results[0]
  expect.soft(concrete, `stored ${STALE_COUNT}, truth 0: the persisted record must become 0`).toMatchObject({ stored: STALE_COUNT, truth: 0, recordBefore: STALE_COUNT, recordAfter: 0 })
  for (const item of results) {
    expect.soft(item.recordAfter, `stored ${item.stored} -> truth ${item.truth}: persisted record must equal the truth count`).toBe(item.truth)
    expect.soft(item.committed, `stored ${item.stored} -> truth ${item.truth}: committed index must equal the truth count`).toBe(item.truth)
  }
})

/* ============================================================================
 * Test 2 - truth override (hypothesis 1, clauses 1.4 / 1.8 / 2.1 / 2.8)
 * ==========================================================================*/

test('2 truth override: a forced rescan returns the server truth, not the client cache', async ({ page }) => {
  test.setTimeout(120000)
  await serveFixture(page, LOGIC_DOM)
  await installGlobals(page, TEST_CHAT_ID)
  await loadLayers(page, [LAYERS.p0v2])

  // Seeded precondition. The 22 stale rows live in the user's own browser storage
  // and cannot be inherited, so they are seeded here exactly as Phase 0 seeded them
  // into a throwaway profile: real IndexedDB record, real localStorage floor, real
  // shared cache entry. Every mechanism after this line runs unmodified.
  const seeded = await page.evaluate(async ({ chatId, count, key }) => {
    const items = window.__itemsRange(chatId, 0, count)
    await window.__seedRecord(chatId, { items, savedAt: Date.now() - 60000 })
    window.rescueFileCache.set(String(chatId), window.__snapshotFrom(chatId, items, true))
    localStorage.setItem(key, JSON.stringify({ [String(chatId)]: { count, at: Date.now() } }))
    const record = await window.__readRecord(chatId)
    return { record: record ? record.items.length : null, floor: localStorage.getItem(key) }
  }, { chatId: TEST_CHAT_ID, count: STALE_COUNT, key: HIGH_WATER_KEY })
  expect(seeded.record, 'seeded precondition: persistent record holds the stale rows').toBe(STALE_COUNT)

  await loadLayers(page, [LAYERS.guard])

  // Caller-side instrument, outside the guard, so it records exactly what a caller
  // receives after any interception.
  await page.evaluate(() => {
    const guarded = window.request
    window.__requestIdentity = String(guarded).slice(0, 160)
    window.__callerReceived = []
    window.request = async function callerSideProbe (type, payload = {}) {
      const result = await guarded(type, payload)
      if (type === 'scan-media-v3') {
        window.__callerReceived.push({
          found: result.found,
          items: (result.items || []).length,
          done: result.done,
          fromCache: result.fromCache,
          protectedByClientCache: result.protectedByClientCache,
          firstNames: (result.items || []).slice(0, 3).map(item => item.name)
        })
      }
      return result
    }
  })

  await loadLayers(page, [LAYERS.owner])

  const observed = await page.evaluate(async ({ chatId, key }) => {
    // Telegram truth for chat TEST, as the real server answered it in task 4:
    // zero ids, complete, accessible.
    window.__truthResponse = window.__truthAnswer([])
    const requestIsWrapped = window.__requestIdentity
    const started = Date.now()
    await window.teleFilesIndex.hardRefresh(chatId)
    const ms = Date.now() - started
    const snapshot = window.teleFilesIndex.snapshot(chatId)
    const record = await window.__readRecord(chatId)
    return {
      requestIsWrapped,
      hardRefreshMs: ms,
      serverAnswers: window.__ws.filter(e => e.type === 'scan-media-v3').map(e => e.answered),
      callerReceived: window.__callerReceived,
      truthCalls: window.__truthCalls.length,
      ownerCount: snapshot ? snapshot.items.length : null,
      header: (document.querySelector('#chat-media-count') || {}).textContent,
      persisted: record ? record.items.length : null,
      highWater: localStorage.getItem(key)
    }
  }, { chatId: TEST_CHAT_ID, key: HIGH_WATER_KEY })

  note('test 2 truth override', observed)

  expect.soft(observed.serverAnswers.length, 'the server must actually be asked for truth').toBeGreaterThan(0)
  for (const answer of observed.serverAnswers) {
    expect.soft(answer, 'precondition: the server answers zero for chat TEST').toMatchObject({ found: 0, items: 0, done: true })
  }
  for (const received of observed.callerReceived) {
    expect.soft(received.items, 'the caller must receive the server truth of 0 items').toBe(0)
    expect.soft(received.protectedByClientCache, 'no client cache may substitute itself for Telegram truth').toBeFalsy()
  }
  expect.soft(observed.ownerCount, 'the owner index must converge to the server truth').toBe(0)
  expect.soft(observed.persisted, 'the persisted record must converge to the server truth').toBe(0)
  expect.soft(observed.header, 'the header must read the server truth').toBe('0 files')
  const floor = JSON.parse(observed.highWater || '{}')[TEST_CHAT_ID]
  expect.soft(floor && floor.count, 'a durable floor must not be re-stamped above Telegram truth').toBeFalsy()

  // Generalised over generated floors and truthful counts below them.
  const generalised = await page.evaluate(async ({ cases, key, chats }) => {
    const out = []
    for (let index = 0; index < cases.length; index++) {
      const item = cases[index]
      const chat = chats[index]
      const stale = window.__itemsRange(chat, 0, item.stored)
      await window.__seedRecord(chat, { items: stale, savedAt: Date.now() - 60000 })
      window.rescueFileCache.set(String(chat), window.__snapshotFrom(chat, stale, true))
      localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key) || '{}'), [String(chat)]: { count: item.stored, at: Date.now() } }))
      window.state.activeChatId = chat
      const truthful = window.__itemsRange(chat, 0, item.truth)
      window.__scanResponse = { found: truthful.length, scanned: truthful.length || 1, items: truthful, typeCounts: {}, cancelled: false, done: true, fromCache: false }
      window.__truthResponse = window.__truthAnswer(truthful.map(row => row.messageId))
      const received = await window.request('scan-media-v3', { chatId: chat, force: true })
      await window.teleFilesIndex.hardRefresh(chat)
      const snapshot = window.teleFilesIndex.snapshot(chat)
      const record = await window.__readRecord(chat)
      out.push({
        floor: item.stored,
        truth: item.truth,
        receivedItems: (received.items || []).length,
        protectedByClientCache: !!received.protectedByClientCache,
        ownerCount: snapshot ? snapshot.items.length : null,
        persisted: record ? record.items.length : null
      })
    }
    return out
  }, { key: HIGH_WATER_KEY, cases: shrinkPairs(0x5eed02, 2).slice(1), chats: [caseChat(20), caseChat(21)] })

  note('test 2 truth override, generalised', generalised)
  for (const item of generalised) {
    expect.soft(item.receivedItems, `floor ${item.floor}, truth ${item.truth}: the caller must receive the truthful count`).toBe(item.truth)
    expect.soft(item.protectedByClientCache, `floor ${item.floor}, truth ${item.truth}: no client cache substitution`).toBe(false)
    expect.soft(item.persisted, `floor ${item.floor}, truth ${item.truth}: the persisted record must follow the truth`).toBe(item.truth)
  }
})

/* ============================================================================
 * Test 3 - restore union (hypothesis 3, clauses 1.7 / 2.7)
 *
 * RE-POINTED PRECONDITION, and this is the one to read carefully, because it looks
 * like a change of subject and is not.
 *
 * The task 2 version hand-made its precondition: a pruned in-memory snapshot beside an
 * untouched record, with no removal ever recorded anywhere. On the FIXED owner that
 * state cannot arise - a prune writes the remaining items and the removal in the same
 * `commitAuthoritative` call - so a fixture that fabricates it is asserting that the
 * owner must guess which of two disagreeing sources is newer, with no evidence either
 * way. Task 5's evidence said this explicitly and left the test failing rather than
 * quietly relaxing it.
 *
 * So the prune is now REAL: a truth pass removes the rows, and then every stale source
 * the live app was observed re-inflating is put back exactly as the legacy layers put
 * it back (task 5 evidence: `teleFinalApplySnapshot` rewriting the record and the shared
 * cache, and the floor re-stamped from the stale snapshot). Restore then has to hold the
 * line against all three at once - memory, `rescueFileCache` and the IndexedDB record.
 * The three assertions are the original three, unchanged: restore yields the pruned set,
 * the owner stays pruned, the shared cache is not repopulated.
 * ==========================================================================*/

test('3 restore union: restore keeps the pruned set and does not union a stale record back in', async ({ page }) => {
  test.setTimeout(120000)
  await serveFixture(page, LOGIC_DOM)
  await installGlobals(page, TEST_CHAT_ID)
  await loadLayers(page, [LAYERS.p0v2, LAYERS.owner])

  const prune = await page.evaluate(async ({ chatId, count, key }) => {
    const stale = window.__itemsRange(chatId, 0, count)
    await window.__seedRecord(chatId, { items: stale, savedAt: Date.now() - 60000 })
    window.rescueFileCache.set(String(chatId), window.__snapshotFrom(chatId, stale, true))
    localStorage.setItem(key, JSON.stringify({ [String(chatId)]: { count, at: Date.now() - 60000 } }))
    await window.teleFilesIndex.ensure(chatId)
    const cached = window.teleFilesIndex.snapshot(chatId)
    window.__truthResponse = window.__truthAnswer([])
    const pass = await window.teleFilesIndex.reconcile(chatId, { force: true })
    const record = await window.__readRecord(chatId)
    return {
      cachedBeforePrune: cached ? cached.items.length : null,
      status: pass && pass.status,
      recordAfterPrune: record ? record.items.length : null,
      removedIdsRecorded: record && Array.isArray(record.removedIds) ? record.removedIds.length : null
    }
  }, { chatId: TEST_CHAT_ID, count: STALE_COUNT, key: HIGH_WATER_KEY })
  expect(prune.cachedBeforePrune, 'precondition: the owner really held the stale rows').toBe(STALE_COUNT)
  expect(prune.recordAfterPrune, 'precondition: the truth pass really pruned the record').toBe(0)

  const observed = await page.evaluate(async ({ chatId, count, key }) => {
    /* Every stale source the live app was observed re-inflating, put back at once,
     * each carrying the older `savedAt` a previous session's copy really carries. */
    const stale = window.__itemsRange(chatId, 0, count)
    await window.__seedRecord(chatId, { items: stale, savedAt: Date.now() - 60000 })
    window.rescueFileCache.set(String(chatId), { ...window.__snapshotFrom(chatId, stale, false), savedAt: Date.now() - 60000 })
    localStorage.setItem(key, JSON.stringify({ [String(chatId)]: { count, at: Date.now() } }))

    const restored = await window.rescueEnsureAllFiles(chatId)
    const snapshot = window.teleFilesIndex.snapshot(chatId)
    const record = await window.__readRecord(chatId)
    return {
      restoredCount: restored ? restored.items.length : null,
      ownerCount: snapshot ? snapshot.items.length : null,
      sharedCount: (window.rescueFileCache.get(String(chatId)) || { items: [] }).items.length,
      persisted: record ? record.items.length : null,
      names: snapshot ? snapshot.items.slice(0, 3).map(item => item.name) : []
    }
  }, { chatId: TEST_CHAT_ID, count: STALE_COUNT, key: HIGH_WATER_KEY })

  note('test 3 restore union', { prune, ...observed })

  expect.soft(observed.restoredCount, 'restore must yield the pruned set, not the union with the stale record').toBe(0)
  expect.soft(observed.ownerCount, 'the owner index must stay pruned after restore').toBe(0)
  expect.soft(observed.sharedCount, 'the shared cache must not be repopulated from the stale record').toBe(0)
})

/* ============================================================================
 * Test 4 - unknown truth (hypothesis 4, clauses 1.10 / 2.10)
 *
 * RE-POINTED: the truth source is `media-truth-v1`, not
 * `GET /api/filegram/live-media-ids/:chatId`, which task 4.3 deleted. That endpoint is
 * what answered HTTP 500 `Unknown class "messageFilterDocument"` for every chat on this
 * host, so an assertion that it answers 200 can now only ever fail, and would fail for
 * the wrong reason: the endpoint is gone on purpose. Leg (a) asks the REAL server for
 * the REAL chat over the replacement request; leg (b) is the original client-side
 * assertion set, driven by a truth source that fails.
 * ==========================================================================*/

test('4 unknown truth: a failing live truth source is surfaced and retried with backoff', async ({ page, request }) => {
  test.setTimeout(180000)
  await assertServerRunning(request)

  // Leg (a): the replacement truth source, asked of the real server for chat TEST.
  const direct = await serverRequest('media-truth-v1', { chatId: Number(TEST_CHAT_ID) })
  const directBody = JSON.stringify(direct)
  note('test 4 live truth source, direct call', `ws media-truth-v1 payload={"chatId":${TEST_CHAT_ID}}\n${directBody}`)

  expect.soft(direct.ok, 'the live truth source must answer, not fail').toBe(true)
  expect.soft(directBody, 'the live truth source must not fail on an unknown TDLib class').not.toContain('Unknown class')
  expect.soft(direct.data && direct.data.accessible, 'the live truth source must report accessibility explicitly').toBe(true)
  expect.soft(direct.data && direct.data.complete, 'the live truth source must report completeness explicitly').toBe(true)

  // Leg (b): a truth source that fails. The index must not move, the failure must be
  // surfaced beyond console.warn, and the retry must be a backoff rather than a loop.
  const started = Date.now()
  await serveFixture(page, LOGIC_DOM)
  await installGlobals(page, TEST_CHAT_ID)
  await loadLayers(page, [LAYERS.p0v2])
  await page.evaluate(async ({ chatId, count, key }) => {
    const stale = window.__itemsRange(chatId, 0, count)
    await window.__seedRecord(chatId, { items: stale, savedAt: Date.now() - 60000 })
    window.rescueFileCache.set(String(chatId), window.__snapshotFrom(chatId, stale, true))
    localStorage.setItem(key, JSON.stringify({ [String(chatId)]: { count, at: Date.now() } }))
    window.__truthResponse = { __throw: 'media-truth-v1 failed: the truth source is unavailable' }
  }, { chatId: TEST_CHAT_ID, count: STALE_COUNT, key: HIGH_WATER_KEY })
  await loadLayers(page, [LAYERS.owner])

  await page.waitForTimeout(3000)

  const observed = await page.evaluate(async chatId => {
    const snapshot = window.teleFilesIndex.snapshot(chatId)
    const record = await window.__readRecord(chatId)
    return {
      ownerCount: snapshot ? snapshot.items.length : null,
      persisted: record ? record.items.length : null,
      truthCalls: window.__truthCalls.slice(),
      loadStates: window.__loadStates.slice(-8),
      toasts: window.__toasts.slice(-8),
      warns: window.__warns.slice(0, 4),
      warnCount: window.__warns.length
    }
  }, TEST_CHAT_ID)

  const seen = observed.truthCalls.map(call => ({ at: call.at - started }))
  const gaps = seen.slice(1).map((item, index) => item.at - seen[index].at)
  const withinTwoSeconds = observed.truthCalls.filter((call, index) => call.at - observed.truthCalls[0].at <= 2000).length
  note('test 4 unknown truth', { requests: seen.length, withinTwoSeconds, gaps, observed })

  expect.soft(observed.ownerCount, 'an unknown truth result must leave the index unchanged').toBe(STALE_COUNT)
  expect.soft(observed.persisted, 'an unknown truth result must leave the persisted record unchanged').toBe(STALE_COUNT)
  expect.soft(withinTwoSeconds, 'a failing truth source must be retried with backoff, at most one retry in two seconds').toBeLessThanOrEqual(2)
  const surfaced = [...observed.loadStates, ...observed.toasts.map(t => t.message)].some(text => /could not verify|unverified|telegram|last known/i.test(String(text)))
  expect.soft(surfaced, 'the failure must be surfaced in the UI or the load state, not only in console.warn').toBe(true)
})

/* ============================================================================
 * Test 5 - empty-scan ambiguity (clauses 1.11 / 2.11)
 *
 * RE-POINTED to `media-truth-v1`, same reason as test 4. The input is still the
 * defective shape: zero ids and NO completeness evidence, which is what the old
 * `exact: ids.length < 5000` heuristic produced for a scan that found nothing because
 * it had failed. Nothing may be pruned from that.
 * ==========================================================================*/

test('5 empty-scan ambiguity: an empty truth answer with no completeness evidence never prunes', async ({ page }) => {
  test.setTimeout(120000)
  await serveFixture(page, LOGIC_DOM)
  await installGlobals(page, TEST_CHAT_ID)
  await loadLayers(page, [LAYERS.p0v2, LAYERS.owner])

  /* The concrete failing case first, then generated cached index sizes. Each case
   * uses its own chat so each gets its own fresh reconciliation pass rather than
   * inheriting the previous chat's removal metadata. */
  const cases = [{ chatId: TEST_CHAT_ID, count: STALE_COUNT }]
  const sizes = rng(0x5eed05)
  for (let i = 0; i < 3; i++) cases.push({ chatId: `-10044745147${80 + i}`, count: 1 + Math.floor(sizes() * 200) })

  const observed = []
  for (const item of cases) {
    const state = await page.evaluate(async ({ chatId, count, key }) => {
      const stale = window.__itemsRange(chatId, 0, count)
      window.state.activeChatId = chatId
      window.rescueFileCache.set(String(chatId), window.__snapshotFrom(chatId, stale, true))
      await window.__seedRecord(chatId, { items: stale, savedAt: Date.now() - 60000 })
      localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key) || '{}'), [String(chatId)]: { count, at: Date.now() } }))
      await window.teleFilesIndex.ensure(chatId)
      /* An empty answer with no completeness evidence anywhere in the payload: no
       * `complete`, no `accessible`. Indistinguishable from a failed walk, which is
       * the whole point. */
      window.__truthResponse = { ok: true, ids: [], count: 0, scanned: 0, source: 'walk' }
      const pass = await window.teleFilesIndex.reconcile(chatId, { force: true })
      const snapshot = window.teleFilesIndex.snapshot(chatId)
      const record = await window.__readRecord(chatId)
      return {
        status: pass && pass.status,
        reason: pass && pass.reason,
        ownerCount: snapshot ? snapshot.items.length : null,
        persisted: record ? record.items.length : null
      }
    }, { chatId: item.chatId, count: item.count, key: HIGH_WATER_KEY })
    observed.push({ chatId: item.chatId, cached: item.count, ...state })
  }

  const truthCalls = await page.evaluate(() => window.__truthCalls.length)
  note('test 5 empty-scan ambiguity', { truthCalls, observed })

  for (const item of observed) {
    expect.soft(item.ownerCount, `chat ${item.chatId} cached ${item.cached}: an unevidenced empty answer must not prune the index`).toBe(item.cached)
    expect.soft(item.persisted, `chat ${item.chatId} cached ${item.cached}: an unevidenced empty answer must not prune the record`).toBe(item.cached)
  }
})

/* ============================================================================
 * Test 6 - reconcile mark (clauses 1.9 / 2.9)
 *
 * RE-POINTED: reconciliation attempts are counted as `media-truth-v1` calls, because
 * `POST /api/filegram/reconcile-message-ids/:chatId` - the endpoint this used to count -
 * was deleted by task 4.3. The precondition is unchanged and is still SEEDED.
 * ==========================================================================*/

test('6 reconcile mark: a chat marked reconciled in an earlier session still detects later deletions', async ({ page }) => {
  test.setTimeout(120000)
  await serveFixture(page, LOGIC_DOM)
  await installGlobals(page, TEST_CHAT_ID)
  await loadLayers(page, [LAYERS.p0v2])

  /* Seeded precondition, stated plainly: the mark could only ever be written by the
   * app after a reconcile succeeded, and on this host the old live truth endpoint
   * answered HTTP 500 for every chat, so the app could never write it here. The mark
   * is therefore written directly, which is what an installation carrying a mark from
   * an earlier session looks like. */
  await page.evaluate(async ({ chatId, count, markKey, floorKey }) => {
    const stale = window.__itemsRange(chatId, 0, count)
    await window.__seedRecord(chatId, { items: stale, savedAt: Date.now() - 60000 })
    window.rescueFileCache.set(String(chatId), window.__snapshotFrom(chatId, stale, true))
    localStorage.setItem(floorKey, JSON.stringify({ [String(chatId)]: { count, at: Date.now() } }))
    localStorage.setItem(markKey, JSON.stringify({ [String(chatId)]: Date.now() - 86400000 }))
    window.__truthResponse = window.__truthAnswer([])
  }, { chatId: TEST_CHAT_ID, count: STALE_COUNT, markKey: RECONCILE_MARK_KEY, floorKey: HIGH_WATER_KEY })

  // No manual pass: the owner's own startup path has to reconcile the marked chat.
  await loadLayers(page, [LAYERS.owner, LAYERS.hardening])
  await page.waitForTimeout(4000)

  const observed = await page.evaluate(async ({ chatId, markKey }) => {
    const snapshot = window.teleFilesIndex.snapshot(chatId)
    const record = await window.__readRecord(chatId)
    return {
      mark: localStorage.getItem(markKey),
      truthCalls: window.__truthCalls.filter(call => call.chatId === String(chatId)).length,
      ownerCount: snapshot ? snapshot.items.length : null,
      persisted: record ? record.items.length : null,
      header: (document.querySelector('#chat-media-count') || {}).textContent
    }
  }, { chatId: TEST_CHAT_ID, markKey: RECONCILE_MARK_KEY })

  const markedRequests = observed.truthCalls

  /* Control leg, recorded not asserted. On unfixed code the mark was the
   * discriminator: with it, zero reconcile requests; without it, one. It cannot
   * discriminate any more, because the owner's startup migration deletes the stored
   * value outright, which is what `mark` reads back as below. */
  const controlChat = '-1004474514799'
  const controlRequests = await page.evaluate(async ({ chatId, count }) => {
    const stale = window.__itemsRange(chatId, 0, count)
    window.rescueFileCache.set(String(chatId), window.__snapshotFrom(chatId, stale, true))
    await window.__seedRecord(chatId, { items: stale, savedAt: Date.now() - 60000 })
    window.state.activeChatId = chatId
    await window.teleFilesIndex.ensure(chatId)
    await new Promise(resolve => setTimeout(resolve, 2500))
    return window.__truthCalls.filter(call => call.chatId === String(chatId)).length
  }, { chatId: controlChat, count: STALE_COUNT })

  note('test 6 reconcile mark', { reconcileRequestsWithMark: markedRequests, reconcileRequestsWithoutMark: controlRequests, observed })
  console.log(`OBSERVATION [test 6]: marked chat made ${markedRequests} truth requests, the unmarked control chat made ${controlRequests}. The mark was SEEDED, and the owner's startup migration removed it (localStorage now reads ${observed.mark}).`)

  expect.soft(markedRequests, 'a chat marked in an earlier session must still be reconciled against Telegram').toBeGreaterThan(0)
  expect.soft(observed.ownerCount, 'deletions after the mark must still be removed from the index').toBe(0)
  expect.soft(observed.persisted, 'deletions after the mark must still be removed from the persisted record').toBe(0)
})

/* ============================================================================
 * Test 7 - Save-to render (hypothesis 7, clauses 1.18 / 1.19 / 2.19 / 2.20)
 * Real stylesheets over real markup inside the real #mg-downloads-pane chain.
 *
 * RE-POINTED: the parts measured are the single control's own -
 * `.fg-save-to-icon` / `.fg-save-to-label` / `.fg-save-to-path` (`#dl-dir-path`) /
 * `.fg-save-to-chevron`. The old `.fg-folder-label` and `.fg-folder-path` spans were
 * markup injected by `uploads-hardening.js` and `file-consistency-v2.js`; task 8.3
 * removed the first and task 9.1 deleted the second, so neither exists to measure.
 * `#dl-dir` and `#dl-dir-current` are gone from the tree entirely (task 8.1), so the
 * path is written where the single painter writes it, through the same
 * `setDirLabel(dir)` contract `public/app.js` implements.
 *
 * No JS layer is loaded, and that is the finding rather than a gap: after task 8.3 and
 * task 9.1 there is no layer left that paints or resizes this node. The width is decided
 * by the cascade alone, which is what hypothesis 7 was about. The fully-painted live
 * control is asserted by `tests/visual-check.spec.js` (the layout authority after task
 * 6.2), and test 8 below proves on the running app that nothing else writes the node.
 * ==========================================================================*/

test('7 Save-to render: the control fills its parent and neither label nor path is clipped', async ({ page }) => {
  test.setTimeout(120000)
  await serveFixture(page, LAYOUT_DOM)
  await installGlobals(page, null)
  await assertRealStylesheets(page)
  await page.evaluate(dir => window.setDirLabel(dir), CONFIGURED_DIR)
  await page.waitForTimeout(200)

  const measure = async () => page.evaluate(() => {
    const button = document.querySelector('#set-dir')
    const parent = button.parentElement
    const style = getComputedStyle(button)
    const spans = [...button.querySelectorAll('span')].map(node => ({
      className: node.className,
      text: (node.textContent || '').trim(),
      clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth,
      clipped: node.scrollWidth > node.clientWidth + 1
    }))
    return {
      parentChain: (() => { const chain = []; let node = button.parentElement; while (node && chain.length < 8) { chain.push(node.tagName.toLowerCase() + (node.id ? '#' + node.id : '') + (node.className ? '.' + String(node.className).trim().split(/\s+/).join('.') : '')); node = node.parentElement } return chain })(),
      computedWidth: style.width,
      computedMinWidth: style.minWidth,
      computedPadding: style.padding,
      computedDisplay: style.display,
      computedTextAlign: style.textAlign,
      buttonWidth: Math.round(button.getBoundingClientRect().width),
      buttonHeight: Math.round(button.getBoundingClientRect().height),
      /* "Fills its parent" means the parent's CONTENT box. `.dl-controls` carries 14px
       * of horizontal padding, so comparing against its border box would demand the
       * control overflow its own parent's padding. The Parallel files row is measured
       * alongside as the reference value, because that row has always filled the pane
       * (task 3 pinned it at 311/341/361/371 px), so "as wide as the row beside it" is
       * the same claim against a known-good number. */
      parentWidth: (() => {
        const parentStyle = getComputedStyle(parent)
        return Math.round(parent.clientWidth - parseFloat(parentStyle.paddingLeft || '0') - parseFloat(parentStyle.paddingRight || '0'))
      })(),
      parentBorderBoxWidth: Math.round(parent.getBoundingClientRect().width),
      siblingRowWidth: (() => {
        const row = document.querySelector('#mg-downloads-pane .dl-controls .conc > .row')
        return row ? Math.round(row.getBoundingClientRect().width) : -1
      })(),
      clickTargets: [...document.querySelectorAll('#mg-downloads-pane button#set-dir, #mg-downloads-pane .fg-save-to')].length,
      /* Every node that has ever displayed the destination path, including the two
       * this fix deleted, so a reintroduced legacy node would push this above 1. */
      visiblePathDisplays: [...document.querySelectorAll('#mg-downloads-pane #dl-dir, #mg-downloads-pane #dl-dir-current, #mg-downloads-pane #dl-dir-path, #mg-downloads-pane #set-dir .fg-save-to-path, #mg-downloads-pane #set-dir .fg-folder-path, #mg-downloads-pane #set-dir strong')]
        .filter(node => node.getBoundingClientRect().width > 0).length,
      legacyNodesPresent: ['#dl-dir', '#dl-dir-current'].filter(selector => !!document.querySelector(selector)),
      spans
    }
  })

  // Which rule actually decides the width, in cascade order with its specificity.
  const widthRules = await page.evaluate(() => {
    const out = []
    const specificity = selector => {
      const ids = (selector.match(/#[\w-]+/g) || []).length
      const classes = (selector.match(/\.[\w-]+|\[[^\]]*\]|:[\w-]+/g) || []).length
      const types = (selector.match(/(^|[\s>+~])[a-z][\w-]*/gi) || []).length
      return `${ids},${classes},${types}`
    }
    for (const sheet of document.styleSheets) {
      let rules = []
      try { rules = [...sheet.cssRules] } catch { continue }
      for (const rule of rules) {
        if (!rule.selectorText || !/set-dir/.test(rule.selectorText)) continue
        const width = rule.style && rule.style.getPropertyValue('width')
        if (!width) continue
        out.push({
          sheet: String(sheet.href || '<injected ' + ((sheet.ownerNode && sheet.ownerNode.id) || 'style') + '>').replace(/^.*\//, ''),
          selector: rule.selectorText,
          specificity: specificity(rule.selectorText),
          width: width + (rule.style.getPropertyPriority('width') ? ' !important' : ''),
          minWidth: rule.style.getPropertyValue('min-width') || '-'
        })
      }
    }
    return out
  })
  note('test 7 matched width rules for #set-dir, in cascade order', widthRules)

  const widths = [1280, 1366, 1600, 1920]
  const byViewport = []
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 })
    await page.waitForTimeout(150)
    byViewport.push({ viewport: width, ...(await measure()) })
  }

  const byPath = []
  for (const dir of generatedPaths(0x5eed07, 4)) {
    await page.evaluate(value => window.setDirLabel(value), dir)
    await page.waitForTimeout(150)
    const snapshot = await measure()
    byPath.push({ dir, buttonWidth: snapshot.buttonWidth, parentWidth: snapshot.parentWidth, clipped: snapshot.spans.filter(s => s.clipped).map(s => `${s.className}:"${s.text}" w${s.clientWidth}/scrollW${s.scrollWidth}`) })
  }

  note('test 7 Save-to render', { byViewport, byPath })

  for (const item of byViewport) {
    expect.soft(item.buttonWidth, `viewport ${item.viewport}px: the control must fill its parent (${item.parentWidth}px content box, parent border box ${item.parentBorderBoxWidth}px)`).toBeGreaterThanOrEqual(item.parentWidth - 2)
    if (item.siblingRowWidth > 0) {
      expect.soft(Math.abs(item.buttonWidth - item.siblingRowWidth), `viewport ${item.viewport}px: the control must be as wide as the Parallel files row beside it (${item.siblingRowWidth}px)`).toBeLessThanOrEqual(2)
    }
    for (const span of item.spans) {
      expect.soft(span.clipped, `viewport ${item.viewport}px: "${span.text}" must not be clipped inside the control`).toBe(false)
    }
    expect.soft(item.clickTargets, `viewport ${item.viewport}px: exactly one Save-to click target`).toBe(1)
    expect.soft(item.visiblePathDisplays, `viewport ${item.viewport}px: exactly one visible path display`).toBe(1)
    expect.soft(item.legacyNodesPresent, `viewport ${item.viewport}px: no legacy path node may exist in the tree`).toEqual([])
  }
  for (const item of byPath) {
    expect.soft(item.buttonWidth, `path ${item.dir}: the control must fill its parent (${item.parentWidth}px)`).toBeGreaterThanOrEqual(item.parentWidth - 2)
  }
})

/* ============================================================================
 * Test 8 - Save-to binding (hypothesis 8, clauses 1.16 / 2.16)
 *
 * RE-POINTED to the RUNNING application, and re-pointed at the control rather than at
 * one node. The single handler and the single painter are both in `public/app.js` now,
 * which the fixture does not load, and the painter writes the path SPAN (`#dl-dir-path`)
 * plus the button's `title` rather than the button's innerHTML. Instrumenting the real
 * page before any script runs is what task 2 could not do: its fixture saw two of the
 * three writers Phase 0 observed live, and recorded that count as a floor rather than a
 * total. This sees all of them.
 *
 * The picker call is routed to a cancel, so no native dialog opens and no
 * `set-download-dir` is issued - the user's configured folder is not touched.
 * ==========================================================================*/

test('8 Save-to binding: exactly one layer owns the control and exactly one picker URL is requested', async ({ page, request }) => {
  test.setTimeout(120000)
  await assertServerRunning(request)

  const pickerRequests = []
  await page.route('**/api/filegram/pick-download-folder', async route => {
    pickerRequests.push({ pathname: new URL(route.request().url()).pathname, method: route.request().method() })
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, cancelled: true, path: null, implementation: 'IFileOpenDialog', reason: 'cancelled' }) })
  })

  // The Phase 0 instrument, installed before any page script runs: record every write
  // to the Save-to control with the stack that made it, plus every click binding.
  await page.addInitScript(() => {
    window.__setDirWrites = []
    window.__clickBindings = []
    const owner = stack => {
      for (const line of String(stack || '').split('\n').slice(1)) {
        const match = line.match(/([\w.-]+\.js)(?:\?[^\s:)]*)?:(\d+):(\d+)/)
        if (match) return `${match[1]}:${match[2]}`
      }
      return 'unknown'
    }
    /* The control is the button and its path display. `#dl-dir` and `#dl-dir-current`
     * are included so a reintroduced legacy node would be caught as another painter. */
    const isTarget = node => !!node && (node.id === 'set-dir' || node.id === 'dl-dir-path' || node.id === 'dl-dir' || node.id === 'dl-dir-current')
    const isButton = node => !!node && node.id === 'set-dir'

    for (const property of ['innerHTML', 'textContent']) {
      const proto = property === 'innerHTML' ? Element.prototype : Node.prototype
      const descriptor = Object.getOwnPropertyDescriptor(proto, property)
      Object.defineProperty(proto, property, {
        configurable: true,
        get: descriptor.get,
        set (value) {
          if (isTarget(this)) window.__setDirWrites.push({ kind: property, node: this.id, owner: owner(new Error().stack) })
          return descriptor.set.call(this, value)
        }
      })
    }

    // The single painter writes the tooltip as well as the text, so a second painter
    // that only set the tooltip would still be caught.
    const title = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'title')
    Object.defineProperty(HTMLElement.prototype, 'title', {
      configurable: true,
      get: title.get,
      set (value) {
        if (isButton(this)) window.__setDirWrites.push({ kind: 'title', node: this.id, owner: owner(new Error().stack) })
        return title.set.call(this, value)
      }
    })

    const baseReplaceWith = Element.prototype.replaceWith
    Element.prototype.replaceWith = function instrumentedReplaceWith (...nodes) {
      if (isTarget(this)) window.__setDirWrites.push({ kind: 'replaceWith', node: this.id, owner: owner(new Error().stack) })
      return baseReplaceWith.apply(this, nodes)
    }

    const baseAdd = EventTarget.prototype.addEventListener
    EventTarget.prototype.addEventListener = function instrumentedAdd (type, listener, options) {
      if (type === 'click' && isButton(this)) window.__clickBindings.push({ kind: 'addEventListener', owner: owner(new Error().stack) })
      return baseAdd.call(this, type, listener, options)
    }

    const onclick = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'onclick')
    Object.defineProperty(HTMLElement.prototype, 'onclick', {
      configurable: true,
      get: onclick.get,
      set (value) {
        if (isButton(this) && typeof value === 'function') window.__clickBindings.push({ kind: 'onclick', owner: owner(new Error().stack) })
        return onclick.set.call(this, value)
      }
    })
  })

  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto(`${SERVER}/`, { waitUntil: 'load' })
  await page.waitForSelector('#set-dir', { timeout: 30000 })
  // Long enough for every layer, including the ones that used to run on intervals of
  // 25 ms, 500 ms, 1500 ms and 15 s, to have had a chance to touch the node.
  await page.waitForTimeout(18000)

  const beforeClick = await page.evaluate(() => ({ writes: window.__setDirWrites.length, bindings: window.__clickBindings.length }))
  await page.locator('#set-dir').click()
  await page.waitForTimeout(1500)

  const observed = await page.evaluate(() => {
    const writes = window.__setDirWrites
    const bindings = window.__clickBindings
    const files = new Set(writes.map(w => String(w.owner).split(':')[0]).filter(name => name && name !== 'unknown'))
    const button = document.querySelector('#set-dir')
    return {
      writes,
      bindings,
      writerFiles: [...files],
      bindingFiles: [...new Set(bindings.map(b => String(b.owner).split(':')[0]))],
      replacedAfterBinding: writes.some(w => w.kind === 'replaceWith'),
      nodeClasses: button.className,
      nodeDataset: { ...button.dataset },
      pathText: (document.querySelector('#dl-dir-path') || {}).textContent,
      buttonTitle: button.title,
      legacyNodesPresent: ['#dl-dir', '#dl-dir-current'].filter(selector => !!document.querySelector(selector))
    }
  })

  note('test 8 Save-to binding', { pickerRequests, beforeClick, ...observed })

  expect.soft(observed.writerFiles.length, `exactly one layer may paint #set-dir, saw ${JSON.stringify(observed.writerFiles)}`).toBe(1)
  expect.soft(observed.bindings.length, `exactly one click binding may exist on #set-dir, saw ${JSON.stringify(observed.bindings)}`).toBe(1)
  expect.soft(observed.replacedAfterBinding, '#set-dir must not be clone-replaced, which silently discards another layer\'s handler').toBe(false)
  expect.soft(pickerRequests.length, 'one click must request exactly one picker URL').toBe(1)
})

/* ============================================================================
 * Test 9 - picker identity (hypotheses 5 and 9, clauses 1.14 / 1.17 / 2.14)
 * Calls the real endpoint on the running server.
 * ==========================================================================*/

function stopPickerChildren () {
  /* Targeted on the picker's own dialog title so nothing else on the machine is
   * touched, and excluding this querying process, whose own command line contains
   * the same string. */
  const script = [
    "$p = @(Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*Select FileGram download folder*' })",
    'foreach ($proc in $p) { try { Stop-Process -Id $proc.ProcessId -Force } catch {} }',
    '$p.Count'
  ].join('; ')
  try {
    return String(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' })).trim()
  } catch (error) {
    return `stop failed: ${error && error.message}`
  }
}

test('9 picker identity: the picker response identifies an Explorer-style implementation', async ({ request }) => {
  test.setTimeout(90000)
  await assertServerRunning(request)
  const pending = request.post(`${SERVER}/api/filegram/pick-download-folder`, { timeout: 60000 }).catch(error => ({ __error: String(error && error.message) }))

  // The endpoint opens a real native dialog. Never leave it open: terminate the
  // PowerShell child so the machine is not blocked. An abnormally terminated dialog
  // must not be reported as a raw exit code, which is one of the assertions.
  let killed = 'not attempted'
  for (let attempt = 0; attempt < 12; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    killed = stopPickerChildren()
    if (killed !== '0') break
  }
  await new Promise(resolve => setTimeout(resolve, 500))
  stopPickerChildren()

  const response = await pending
  const status = response && typeof response.status === 'function' ? response.status() : 0
  const body = response && typeof response.text === 'function' ? await response.text() : JSON.stringify(response)
  let payload = {}
  try { payload = JSON.parse(body) } catch {}

  note('test 9 picker identity', `POST ${SERVER}/api/filegram/pick-download-folder\nHTTP ${status}\n${body}\npicker children terminated: ${killed}`)

  expect.soft(payload.implementation, 'the picker response must identify which dialog implementation ran').toBeTruthy()
  expect.soft(String(payload.implementation || ''), 'the picker must be an Explorer-style common item dialog').toMatch(/IFileOpenDialog|OpenFileDialog/)
  expect.soft(body, 'an abnormally terminated dialog must not be reported as a raw exit code').not.toContain('exited with code')
})

/* ============================================================================
 * Test 10 - cache token (hypothesis 6, clauses 1.22 / 2.22)
 * ==========================================================================*/

test('10 cache token: a script content change changes the cache token that references it', async ({ page, request }) => {
  test.setTimeout(90000)
  await assertServerRunning(request)
  const target = path.join(PUBLIC, 'uploads-hardening.js')
  const loader = path.join(PUBLIC, 'uploads.js')
  const original = fs.readFileSync(target)
  const tokenOf = () => {
    const match = fs.readFileSync(loader, 'utf8').match(/uploads-hardening\.js\?v=([^'"]+)/)
    return match ? match[1] : null
  }
  const sha = buffer => crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 12)

  const before = { token: tokenOf(), hash: sha(original) }
  /** @type {{token:string|null,hash:string}} */
  let after = { token: null, hash: '' }
  let executedNewBytes = null

  try {
    await page.goto(`${SERVER}/`, { waitUntil: 'load' })
    await page.waitForFunction(() => [...document.scripts].some(s => /uploads-hardening\.js/.test(s.src)), null, { timeout: 20000 })
    const loadedToken = await page.evaluate(() => {
      const script = [...document.scripts].find(s => /uploads-hardening\.js/.test(s.src))
      return script ? new URL(script.src).search : null
    })
    expect(loadedToken, 'the app must load uploads-hardening.js with a cache token').toContain('v=')

    const mutated = Buffer.concat([original, Buffer.from('\n;window.__fgCacheTokenProbe = "task2";\n', 'utf8')])
    fs.writeFileSync(target, mutated)
    after = { token: tokenOf(), hash: sha(mutated) }

    // Same browser context, so the HTTP cache is the one that would serve a stale
    // copy if the token were the only freshness signal.
    await page.reload({ waitUntil: 'load' })
    await page.waitForTimeout(3000)
    executedNewBytes = await page.evaluate(() => window.__fgCacheTokenProbe === 'task2')
  } finally {
    fs.writeFileSync(target, original)
    const restored = fs.readFileSync(target)
    expect(restored.equals(original), 'the probed script must be restored byte-for-byte').toBe(true)
  }

  /* Static survey of every ?v= token the app references, recorded as evidence for
   * clause 2.22: none of them is derived from the content it names. */
  const referenced = []
  for (const [file, source] of [['index.html', INDEX_HTML], ['auth-state-fix.js', fs.readFileSync(path.join(PUBLIC, 'auth-state-fix.js'), 'utf8')], ['uploads.js', fs.readFileSync(loader, 'utf8')]]) {
    for (const match of source.matchAll(/([\w.-]+\.(?:js|css))\?v=([\w.-]+)/g)) {
      const asset = path.join(PUBLIC, match[1])
      if (!fs.existsSync(asset)) continue
      referenced.push({ referencedBy: file, asset: match[1], token: match[2], contentHash: sha(fs.readFileSync(asset)) })
    }
  }
  /* A token counts as content-derived only if it is long enough to be a hash prefix
   * and actually is one, so a bare "4" cannot pass by accidentally matching the
   * first character of a hash. */
  const notContentDerived = referenced.filter(item => !(String(item.token).length >= 8 && item.contentHash.startsWith(String(item.token))))

  note('test 10 cache token', {
    probedAsset: 'public/uploads-hardening.js',
    tokenBeforeChange: before.token,
    tokenAfterChange: after.token,
    contentHashBeforeChange: before.hash,
    contentHashAfterChange: after.hash,
    browserExecutedNewBytesAfterReload: executedNewBytes,
    referencedTokensNotDerivedFromContent: notContentDerived.length,
    referencedTokensTotal: referenced.length,
    sample: notContentDerived.slice(0, 6)
  })

  expect.soft(after.hash, 'precondition: the probe really changed the file content').not.toBe(before.hash)
  expect.soft(after.token, 'a content change must change the cache token that references the file').not.toBe(before.token)
  expect.soft(notContentDerived.length, `every referenced ?v= token must be derived from its file's content, ${notContentDerived.length} of ${referenced.length} are not`).toBe(0)
  /* Recorded, not asserted as the defect: Phase 0 refuted hypothesis 6 server-side.
   * express.static forces revalidation, so a fresh reload does execute new bytes on
   * this host. The durable hazard is the token, which is what the assertions above
   * cover. */
  console.log(`OBSERVATION [test 10]: browser executed the new bytes after reload = ${executedNewBytes} (Phase 0 refuted hypothesis 6 server-side; the token is the durable hazard)`)
})
