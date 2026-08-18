// @ts-check
'use strict'

/* Preservation baseline for .kiro/specs/files-consistency-and-folder-picker (task 3).
 *
 * These tests capture what HEAD `90a56ce0` ACTUALLY DOES for clauses 3.1 to 3.12, so
 * task 11.2 can prove the fix did not change it. They MUST PASS on unfixed code.
 * That is the whole point.
 *
 * Methodology, strictly observation-first. Every value in `CAPTURED` below was read
 * off a run of the UNFIXED build and then written down. Nothing here asserts what the
 * code ought to do. Where a first-pass expectation and the observation disagreed, the
 * observation won and got recorded; the four places where that happened are listed in
 * the `# Task 3 Evidence` section of
 * `.kiro/specs/files-consistency-and-folder-picker/bugfix.md`.
 *
 * Encoded as property-based tests over generated index sizes, scan interleavings,
 * event orders and page boundaries, because the preservation set is large and
 * mechanical. Generators are seeded (`rng(seed)`, the pattern task 2 established), so
 * any counterexample is reproducible from its seed.
 *
 * Fixture honesty is inherited from task 2 through `tests/fixture-support.js`: real
 * layers loaded by URL out of a served real `public/` tree with their real `?v=`
 * tokens, the real `daily-driver-p0-v2.js` IndexedDB boundary against real IndexedDB
 * (guarded by `assertRealBoundary`), and the real `index.html` stylesheets over real
 * markup inside the real `#mg-downloads-pane` chain.
 *
 * The last test observes the running application at http://127.0.0.1:3000
 * (`npm start`). The folder-dialog cancel leg uses a ROUTED cancel response, so no
 * native dialog is ever spawned and none can be left open.
 *
 * Clause 3.13 (`npm run verify`) is a command, not a browser observation; its verbatim
 * baseline output is recorded in the task 3 evidence instead of being re-run here.
 */

const { test, expect } = require('@playwright/test')
const {
  TEST_CHAT_ID,
  CONFIGURED_DIR,
  LAYERS,
  SERVER,
  LOGIC_DOM,
  LAYOUT_DOM,
  indexSizes,
  shrinkPairs,
  progressBatches,
  shuffled,
  serveFixture,
  installGlobals,
  loadLayers,
  assertRealBoundary,
  assertRealStylesheets,
  baseline,
  assertServerRunning
} = require('./fixture-support')

/* ============================================================================
 * CAPTURED - the observed behaviour of the UNFIXED build at HEAD 90a56ce0.
 * ==========================================================================*/
const CAPTURED = {
  headerFor: n => `${n.toLocaleString()} file${n === 1 ? '' : 's'}`,
  downloadAllFor: n => `Download all media (${n.toLocaleString()})`,

  // 3.1 / 3.4: a chat with rows in its record restores without a scan and only
  // cancels any legacy scan plus probes the newest delta. A chat whose record holds
  // ZERO rows has nothing to restore, so the owner does run one full scan for it.
  restore: {
    typesWhenRestored: ['cancel-media-scan-v3', 'get-messages'],
    typesWhenRecordEmpty: ['scan-media-v3', 'get-messages'],
    scansWhenRestored: 0,
    scansWhenRecordEmpty: 1
  },

  // The three names from the bug report are the OLDEST three rows of the generated
  // set, and the committed index is newest-first, so they appear at the tail.
  oldestThreeNames: ['photo_391118848.jpg', 'photo_393216000.jpg', 'photo_400556032.jpg'],

  streaming: {
    doneWhileStreaming: false,
    doneAfterFinalEvent: true,
    indexedLoadStatesBeforeFinal: 0,
    indexedLoadStatesAfterFinal: 1
  },

  temporary: { temporaryRows: 0, duplicateRows: 0 },

  pager: {
    pageSize: 100,
    pageSizeLabel: '100 / page',
    rangeLabel: (start, end, total) => `${start.toLocaleString()}\u2013${end.toLocaleString()} of ${total.toLocaleString()} files`,
    filteredRangeLabel: (start, end, total, source) => `${start.toLocaleString()}\u2013${end.toLocaleString()} of ${total.toLocaleString()} matching \u00b7 ${source.toLocaleString()} total`,
    pageOf: pages => `/ ${pages.toLocaleString()}`
  },

  /* 3.11, measured in the layout fixture at height 900. The four queue actions do
   * NOT share one row: they lay out as a 2x2 grid, which is what the real cascade
   * produces. `.downloads-head` (and with it `#download-stats`), `#toggle-drawer`
   * and the Zip-selected row are `display: none` in this composition - the drawer
   * tabs from `management.js` replaced the panel header, and `daily-driver-p1.css`
   * hides the pack row. The live stats card is `#tele-ui-download-summary`, created
   * by `daily-driver-final-ui-fix.js`, so it is measured in the live test instead.
   */
  /* RE-PINNED after task 8, and here is exactly what moved and why.
   *
   * Replacing the two-node Save-to block (a `label.conc` holding a heading, a text input
   * and a 54px button, plus a separate `#dl-dir-current` line) with one 46px button made
   * that block 47px SHORTER. `.dl-controls` is a grid and `#download-list` is the flex
   * child that absorbs the remaining height, so everything below the Save-to control moved
   * up by exactly 47px and the download list grew by 48 (47 plus one pixel of rounding):
   *
   *     slider top          176 -> 129        (-47)
   *     slider readout top  178 -> 131        (-47)
   *     queue row tops      [227,227,273,273] -> [180,180,226,226]   (-47 each)
   *     download list h     575 -> 623        (+48)
   *
   * Nothing else changed. Pane width and height, the Parallel row width, the slider width
   * and height, the readout size, the queue button size, the 2x2 arrangement and the
   * download list width are all identical to the task 3 baseline at all four viewports.
   *
   * A vertical shift is not what clause 3.11 protects: it requires the stats card, the
   * Parallel files slider and the queue action rows to keep their alignment and behaviour,
   * and they do - relative to each other and in size. Their absolute offset from the top of
   * the pane is a function of the height of the control being fixed, and it cannot be held
   * constant while replacing a two-row control with a one-row one. The shift-invariant
   * relationships are asserted separately below so these numbers are not merely "whatever
   * we measured this time". */
  sidebar: {
    paneHeight: 857,
    downloadListHeight: 623,
    concurrency: { w: null, h: 16, top: 129 },
    concurrencyVal: { w: 24, h: 12, top: 131 },
    queueButtonHeight: 38,
    queueRowTops: [180, 180, 226, 226],
    // Recorded so the re-pin above is checkable rather than asserted from nothing.
    saveToBlockShift: 47,
    hiddenDisplays: { downloadsHead: 'none', toggleDrawer: 'none', scanBanner: 'none', cancelPack: 'none' },
    zeroAreaNodes: ['downloadsHead', 'downloadsTitle', 'downloadStats', 'toggleDrawer', 'scanBanner', 'packMedia', 'cancelPack'],
    /* `setDirWidth: 54` was pinned here as a cross-reference to the task 2 / Phase 0
     * measurement, and it has been REMOVED rather than updated. It does not belong in the
     * preservation set at all: preservation quantifies over interactions where the bug
     * condition does NOT hold, and a Save-to render is `saveToLayoutCondition(X)` - it IS
     * the bug condition. Pinning 54px here made the preservation suite assert bug 3.
     *
     * The width is still measured and still printed in this test's BASELINE output as
     * context. Where it is now ASSERTED, and asserted as correct rather than as observed:
     * `tests/visual-check.spec.js` tests 27-29 (one control, full width, one width rule)
     * and `scripts/download-folder.test.cjs` at the source level. Nothing about the rest of
     * the sidebar changed, and every number below is unchanged from the task 3 baseline. */
    byViewport: {
      1280: { paneWidth: 339, parallelWidth: 311, concurrencyWidth: 275, queueButtonWidth: 152 },
      1366: { paneWidth: 369, parallelWidth: 341, concurrencyWidth: 305, queueButtonWidth: 167 },
      1600: { paneWidth: 389, parallelWidth: 361, concurrencyWidth: 325, queueButtonWidth: 177 },
      1920: { paneWidth: 399, parallelWidth: 371, concurrencyWidth: 335, queueButtonWidth: 182 }
    },
    slider: { min: '1', max: '64', step: '1', value: '16' }
  },

  folder: { configured: CONFIGURED_DIR, setDownloadDirRequestsOnCancel: 0 },

  /* Live app at 1600x900, observed against the running server (build id 90a56ce0).
   *
   * OBSERVED, and recorded rather than assumed:
   *  - the configured folder is read from `#dl-dir-path` inside the single Save-to
   *    control. The task 3 baseline read it from `#dl-dir.value` and `#dl-dir-current`,
   *    and recorded that `#dl-dir-current` showed the BARE path rather than app.js's
   *    `Saving to: <path>` because `teleP0v2RefreshPath` stripped the prefix on a 1500 ms
   *    interval. Both nodes and that interval are gone (tasks 8.1, 8.3); the same value is
   *    now displayed once, by the single painter, so the observation stands and its
   *    location moved.
   *  - each queue action issues its own request AND a `get-downloads` resync,
   *    because `daily-driver-final-ui-fix.js` `applyQueueAction` clone-replaces the
   *    four buttons and re-syncs from the authoritative snapshot after every action.
   *  - the stats card tile order is speed, fg-done, current, remaining, total:
   *    `filegram-shell.js` `installStatsCard` inserts its Downloaded tile directly
   *    after the Speed tile of `daily-driver-final-ui-fix.js`'s summary.
   */
  live: {
    savedPathText: CONFIGURED_DIR,
    queueResyncRequest: 'get-downloads',
    statsCardTiles: ['speed', 'fg-done', 'current', 'remaining', 'total'],
    statsCard: { w: 361, h: 111, display: 'grid' },
    concurrency: { w: 325, h: 16 },
    queueButton: { w: 177, h: 38 },
    queueButtonLabels: ['Pause all', 'Resume all', 'Cancel all', 'Clear done'],
    packMediaDisplay: 'none',
    paneWidth: 389
    /* `setDirWidth: 54` removed here for the same reason as in `sidebar` above: it pinned
     * bug 3 inside the preservation set. Measured and printed, asserted in
     * tests/visual-check.spec.js. */
  }
}

/* ------------------------------------------------------------------ helpers */

function chatFor (index) { return `-100447451${String(4700 + index)}` }

async function logicFixture (page, chatId, layers, options = {}) {
  await serveFixture(page, LOGIC_DOM, options.api)
  await installGlobals(page, chatId, options)
  await loadLayers(page, layers)
  if (layers.includes(LAYERS.p0v2)) await assertRealBoundary(page)
}

/* Seeds a chat's persistent record and lets the REAL restore path adopt it.
 *
 * The seed used to go through `teleP0v2WriteIndex(..., { allowShrink: true })`, the legacy
 * boundary that task 9.2 deleted. It writes the record directly now (`__seedRecord` in
 * tests/fixture-support.js): same database, same store, same shape. Nothing under test
 * changed - `ensure()` -> `restore()` is still the real path that adopts it - and the seed
 * is arguably more honest for representing a previous session's artefact than a call
 * through a boundary that was itself one of the things being tested. */
async function seedAndRestore (page, chatId, count) {
  return page.evaluate(async ({ chatId, count }) => {
    window.state.activeChatId = chatId
    await window.__seedRecord(chatId, window.__snapshotOf(chatId, count))
    const restored = await window.teleFilesIndex.ensure(chatId)
    return restored ? restored.items.length : 0
  }, { chatId, count })
}

async function observeChat (page, chatId) {
  return page.evaluate(async chatId => {
    const key = String(chatId)
    const forChat = type => window.__ws.filter(entry => entry.type === type && String(entry.payload && entry.payload.chatId) === key)
    const snapshot = window.teleFilesIndex.snapshot(chatId)
    const record = await window.__readRecord(chatId)
    const header = document.querySelector('#chat-media-count')
    const all = document.querySelector('#download-all-media')
    const shared = window.rescueFileCache.get(key)
    const items = snapshot && Array.isArray(snapshot.items) ? snapshot.items : []
    let descending = true
    for (let i = 1; i < items.length; i++) {
      if (Number(items[i].messageId) >= Number(items[i - 1].messageId)) { descending = false; break }
    }
    return {
      committed: snapshot ? items.length : null,
      committedDone: snapshot ? snapshot.done : null,
      persisted: record ? record.items.length : null,
      shared: shared && Array.isArray(shared.items) ? shared.items.length : null,
      header: header ? header.textContent : null,
      downloadAll: all ? all.textContent : null,
      downloadAllDisabled: all ? !!all.disabled : null,
      stateMediaCount: window.state.mediaCount,
      typeCountsTotal: Object.values(window.state.typeCounts || {}).reduce((a, b) => a + Number(b || 0), 0),
      ownerTotal: window.teleFilesIndex.total(chatId),
      ownerCount: window.teleFilesIndex.count(chatId),
      newestFirst: descending,
      firstNames: items.slice(0, 3).map(item => item.name),
      lastNames: items.slice(-3).map(item => item.name),
      scansForChat: forChat('scan-media-v3').length,
      typesForChat: [...new Set(window.__ws.filter(entry => String(entry.payload && entry.payload.chatId) === key).map(entry => entry.type))]
    }
  }, chatId)
}

/* ============================================================================
 * 3.1 - an intact chat keeps every file and every count
 * ==========================================================================*/

test('3.1 intact chat: counts and list contents are unchanged for a chat with no deletions', async ({ page }) => {
  test.setTimeout(120000)
  await logicFixture(page, TEST_CHAT_ID, [LAYERS.p0v2, LAYERS.owner])

  const sizes = indexSizes(0x3a1001, 4)
  const observed = []
  for (let index = 0; index < sizes.length; index++) {
    const chatId = chatFor(index)
    const count = sizes[index]
    const restored = await seedAndRestore(page, chatId, count)
    await page.waitForTimeout(200)
    observed.push({ chatId, count, restored, ...(await observeChat(page, chatId)) })
  }

  baseline('3.1 intact chat', observed)

  for (const item of observed) {
    const n = item.count
    const where = `chat ${item.chatId} (${n} intact files)`
    expect.soft(item.restored, `${where}: restore returns every row`).toBe(n)
    expect.soft(item.committed, `${where}: committed index holds every row`).toBe(n)
    expect.soft(item.persisted, `${where}: persisted record holds every row`).toBe(n)
    expect.soft(item.shared, `${where}: shared cache mirrors the committed index`).toBe(n)
    expect.soft(item.header, `${where}: header count`).toBe(CAPTURED.headerFor(n))
    expect.soft(item.downloadAll, `${where}: Download all media label`).toBe(CAPTURED.downloadAllFor(n))
    expect.soft(item.downloadAllDisabled, `${where}: Download all media enabled state`).toBe(n === 0)
    expect.soft(item.stateMediaCount, `${where}: state.mediaCount`).toBe(n)
    expect.soft(item.typeCountsTotal, `${where}: type counts sum to the total`).toBe(n)
    expect.soft(item.ownerTotal, `${where}: teleFilesIndex.total`).toBe(n)
    expect.soft(item.ownerCount, `${where}: teleFilesIndex.count`).toBe(n)
    expect.soft(item.newestFirst, `${where}: the list stays newest-first`).toBe(true)
    // A record with rows restores without a scan; an empty record has nothing to
    // restore, so the owner falls through to one full scan. Both are observed.
    expect.soft(item.scansForChat, `${where}: scans issued for this chat`).toBe(n === 0 ? CAPTURED.restore.scansWhenRecordEmpty : CAPTURED.restore.scansWhenRestored)
    expect.soft(item.typesForChat, `${where}: requests issued for this chat`).toEqual(n === 0 ? CAPTURED.restore.typesWhenRecordEmpty : CAPTURED.restore.typesWhenRestored)
    // List contents by value, not only by count.
    if (n >= 3) expect.soft(item.lastNames, `${where}: the three reported files are the oldest rows and are still listed`).toEqual(CAPTURED.oldestThreeNames)
    if (n >= 1 && n < 3) expect.soft(item.firstNames, `${where}: the newest row is listed by name`).toEqual(CAPTURED.oldestThreeNames.slice(-n).reverse().slice(0, n))
  }
})

/* ============================================================================
 * 3.2 - partial-scan protection
 *
 * Phase 0 confirmed the persistence boundary discards shrinks, so the OBSERVED
 * behaviour is that the larger index survives. That is captured as the baseline on
 * purpose: after the fix the enforcement point moves from the persistence boundary
 * to commitDiscovery / commitAuthoritative, and the observable result must stay the
 * same.
 * ==========================================================================*/

test('3.2 partial-scan protection: a partial done:true result of M does not replace a discovered index of N', async ({ page }) => {
  test.setTimeout(180000)
  await logicFixture(page, TEST_CHAT_ID, [LAYERS.p0v2, LAYERS.owner])

  const pairs = shrinkPairs(0x3a2002, 3, 260)
  const viaProgress = []
  const viaScan = []

  for (let index = 0; index < pairs.length; index++) {
    const { stored, truth } = pairs[index]

    // Route A: discovery by streaming progress, then a partial batch stamped done.
    const progressChat = chatFor(100 + index)
    await page.evaluate(({ chatId, stored }) => {
      window.state.activeChatId = chatId
      window.handleEvent({ name: 'media-index-progress', payload: { chatId, items: window.__itemsRange(chatId, 0, stored), scanned: stored, done: false } })
    }, { chatId: progressChat, stored })
    await page.waitForTimeout(600)
    const afterDiscovery = await observeChat(page, progressChat)
    await page.evaluate(({ chatId, truth }) => {
      window.handleEvent({ name: 'media-index-progress', payload: { chatId, items: window.__itemsRange(chatId, 0, truth), scanned: truth, done: true } })
    }, { chatId: progressChat, truth })
    await page.waitForTimeout(600)
    viaProgress.push({ chatId: progressChat, stored, truth, discovered: afterDiscovery.committed, ...(await observeChat(page, progressChat)) })

    // Route B: a full scan-media-v3 result smaller than the discovered record.
    const scanChat = chatFor(200 + index)
    await seedAndRestore(page, scanChat, stored)
    await page.waitForTimeout(200)
    const afterSeed = await observeChat(page, scanChat)
    await page.evaluate(async ({ chatId, truth }) => {
      window.state.activeChatId = chatId
      window.__scanResponse = { found: truth, scanned: Math.max(1, truth), items: window.__itemsRange(chatId, 0, truth), typeCounts: {}, cancelled: false, done: true, fromCache: false }
      await window.teleFilesIndex.ensure(chatId, { hardRefresh: true })
    }, { chatId: scanChat, truth })
    await page.waitForTimeout(400)
    viaScan.push({ chatId: scanChat, stored, truth, discovered: afterSeed.committed, ...(await observeChat(page, scanChat)) })
  }

  baseline('3.2 partial-scan protection, route A (media-index-progress done:true)', viaProgress)
  baseline('3.2 partial-scan protection, route B (scan-media-v3 result below the record)', viaScan)

  for (const item of viaProgress) {
    const where = `progress route, N=${item.stored} M=${item.truth}`
    expect.soft(item.discovered, `${where}: discovery reached N`).toBe(item.stored)
    expect.soft(item.committed, `${where}: the committed index stays at N`).toBe(item.stored)
    expect.soft(item.header, `${where}: the header stays at N`).toBe(CAPTURED.headerFor(item.stored))
    /* OBSERVED, and recorded rather than tidied: an M = 0 final batch reaches
     * flushProgress with an already-drained candidate, so flushProgress returns
     * before committing. The index therefore stays at N but keeps `done: false`,
     * and because the intermediate flush ran with `persist: false` the record is
     * never written at all. For M > 0 the final batch commits and persists N. */
    if (item.truth === 0) {
      expect.soft(item.committedDone, `${where}: an empty final batch leaves the index flagged incomplete`).toBe(false)
      expect.soft(item.persisted, `${where}: an empty final batch writes no record`).toBe(null)
    } else {
      expect.soft(item.committedDone, `${where}: a non-empty final batch marks the index complete`).toBe(true)
      expect.soft(item.persisted, `${where}: the persisted record stays at N`).toBe(item.stored)
    }
  }
  for (const item of viaScan) {
    const where = `scan route, N=${item.stored} M=${item.truth}`
    expect.soft(item.discovered, `${where}: the record restored to N`).toBe(item.stored)
    expect.soft(item.committed, `${where}: the committed index stays at N`).toBe(item.stored)
    expect.soft(item.persisted, `${where}: the persisted record stays at N`).toBe(item.stored)
    expect.soft(item.committedDone, `${where}: the index stays complete`).toBe(true)
    expect.soft(item.header, `${where}: the header stays at N`).toBe(CAPTURED.headerFor(item.stored))
  }
})

/* ============================================================================
 * 3.3 - a streaming scan grows the index and is not complete until the end
 * ==========================================================================*/

test('3.3 streaming scan: done:false batches grow the index monotonically and the total is not complete until the final event', async ({ page }) => {
  test.setTimeout(180000)
  await logicFixture(page, TEST_CHAT_ID, [LAYERS.p0v2, LAYERS.owner])

  const batches = progressBatches(0x3a3003, 6)
  const chatId = chatFor(300)
  await page.evaluate(chatId => { window.state.activeChatId = chatId }, chatId)

  const steps = []
  let cursor = 0
  for (let index = 0; index < batches.length; index++) {
    const size = batches[index]
    await page.evaluate(({ chatId, from, size }) => {
      window.handleEvent({ name: 'media-index-progress', payload: { chatId, items: window.__itemsRange(chatId, from, size), scanned: from + size, done: false } })
    }, { chatId, from: cursor, size })
    cursor += size
    await page.waitForTimeout(550)
    const seen = await page.evaluate(chatId => {
      const snapshot = window.teleFilesIndex.snapshot(chatId)
      return {
        count: snapshot ? snapshot.items.length : 0,
        done: snapshot ? snapshot.done : null,
        indexedLoadStates: window.__loadStates.filter(text => /^Indexed /.test(text)).length
      }
    }, chatId)
    steps.push({ batch: index + 1, size, cumulative: cursor, ...seen })
  }

  const beforeFinal = steps[steps.length - 1]
  await page.evaluate(({ chatId, from }) => {
    window.handleEvent({ name: 'media-index-progress', payload: { chatId, items: window.__itemsRange(chatId, from, 3), scanned: from + 3, done: true } })
  }, { chatId, from: cursor })
  cursor += 3
  await page.waitForTimeout(500)
  const final = await page.evaluate(chatId => {
    const snapshot = window.teleFilesIndex.snapshot(chatId)
    return {
      count: snapshot ? snapshot.items.length : 0,
      done: snapshot ? snapshot.done : null,
      indexedLoadStates: window.__loadStates.filter(text => /^Indexed /.test(text)),
      loadStates: window.__loadStates.slice(-6)
    }
  }, chatId)

  baseline('3.3 streaming scan', { batches, steps, final, expectedTotal: cursor })

  for (let index = 1; index < steps.length; index++) {
    expect.soft(steps[index].count, `batch ${index + 1}: the index never shrinks while streaming`).toBeGreaterThanOrEqual(steps[index - 1].count)
  }
  for (const step of steps) {
    expect.soft(step.count, `batch ${step.batch}: the index holds every item flushed so far`).toBe(step.cumulative)
    expect.soft(step.done, `batch ${step.batch}: an in-progress total is not reported complete`).toBe(CAPTURED.streaming.doneWhileStreaming)
    expect.soft(step.indexedLoadStates, `batch ${step.batch}: no "Indexed N files" line before the final event`).toBe(CAPTURED.streaming.indexedLoadStatesBeforeFinal)
  }
  expect.soft(beforeFinal.done, 'the last done:false batch is still not complete').toBe(CAPTURED.streaming.doneWhileStreaming)
  expect.soft(final.done, 'the final event marks the total complete').toBe(CAPTURED.streaming.doneAfterFinalEvent)
  expect.soft(final.count, 'the final index holds every streamed item').toBe(cursor)
  expect.soft(final.indexedLoadStates.length, 'exactly one "Indexed N files" line, on the final event').toBe(CAPTURED.streaming.indexedLoadStatesAfterFinal)
  expect.soft(final.indexedLoadStates[0], 'the completed total is the streamed total').toBe(`Indexed ${cursor.toLocaleString()} files`)
})

/* ============================================================================
 * 3.4 - reopening a chat with a complete record issues no full scan
 * ==========================================================================*/

test('3.4 restore without rescan: reopening a chat with a complete record issues no full scan', async ({ page }) => {
  test.setTimeout(120000)
  await logicFixture(page, TEST_CHAT_ID, [LAYERS.p0v2, LAYERS.owner])

  const sizes = indexSizes(0x3a4004, 2).filter(size => size > 0)
  const observed = []
  for (let index = 0; index < sizes.length; index++) {
    const chatId = chatFor(400 + index)
    const count = sizes[index]
    await page.evaluate(async ({ chatId, count }) => {
      window.state.activeChatId = chatId
      await window.__seedRecord(chatId, window.__snapshotOf(chatId, count))
    }, { chatId, count })

    const open = async () => page.evaluate(async chatId => {
      const before = window.__ws.length
      const restored = await window.teleFilesIndex.ensure(chatId)
      await new Promise(resolve => setTimeout(resolve, 250))
      return { restored: restored ? restored.items.length : 0, types: [...new Set(window.__ws.slice(before).map(entry => entry.type))] }
    }, chatId)

    const first = await open()
    // "Reopen": the owner's ensure() is what every openChat path funnels into.
    const second = await open()
    observed.push({ chatId, count, first, second, ...(await observeChat(page, chatId)) })
  }

  baseline('3.4 restore without rescan', observed)

  for (const item of observed) {
    const where = `chat ${item.chatId} (${item.count} rows)`
    expect.soft(item.first.restored, `${where}: the first open restores every row`).toBe(item.count)
    expect.soft(item.second.restored, `${where}: the reopen restores every row`).toBe(item.count)
    expect.soft(item.first.types, `${where}: the first open issues no scan-media-v3`).not.toContain('scan-media-v3')
    expect.soft(item.second.types, `${where}: the reopen issues no scan-media-v3`).not.toContain('scan-media-v3')
    expect.soft(item.first.types, `${where}: the first open cancels any legacy full scan and probes the delta`).toEqual(CAPTURED.restore.typesWhenRestored)
    expect.soft(item.second.types, `${where}: the reopen does the same and nothing more`).toEqual(CAPTURED.restore.typesWhenRestored)
    expect.soft(item.scansForChat, `${where}: no full scan for this chat across either open`).toBe(CAPTURED.restore.scansWhenRestored)
  }
})

/* ============================================================================
 * 3.5 - a new upload appears and its temporary id is retired
 *
 * The base `handleEvent` in the fixture writes an upserted media message into
 * `rescueFileCache`, which is what the legacy realtime layers do in the live app
 * (Phase 0 recorded six such writes on one chat open). It stands in for the
 * transport; the code under test is the REAL `uploads-hardening.js` temporary-id
 * logic and the REAL owner union.
 * ==========================================================================*/

test('3.5 upload and temporary-id retirement: the row appears once and the temporary id is replaced', async ({ page }) => {
  test.setTimeout(180000)
  await logicFixture(page, TEST_CHAT_ID, [LAYERS.p0v2, LAYERS.owner, LAYERS.hardening], { upsertToSharedCache: true })

  const sizes = indexSizes(0x3a5005, 2).filter(size => size > 0)
  const observed = []

  for (let index = 0; index < sizes.length; index++) {
    const chatId = chatFor(500 + index)
    const count = sizes[index]
    const temporaryId = '-9001'
    const realId = 2000000 + index

    await seedAndRestore(page, chatId, count)
    await page.waitForTimeout(200)

    // The optimistic row the upload workspace produces while the message is still
    // sending: an outgoing media message that still carries a temporary id.
    const suppressed = await page.evaluate(async ({ chatId, temporaryId }) => {
      const before = window.__baseEvents.length
      window.handleEvent({
        name: 'message-upsert',
        chatId,
        payload: { chatId, message: { id: temporaryId, outgoing: true, date: Math.floor(Date.now() / 1000), media: { chatId, messageId: temporaryId, name: 'pending-upload.txt', type: 'document', fileSize: 11 } } }
      })
      await new Promise(resolve => setTimeout(resolve, 250))
      const snapshot = window.teleFilesIndex.snapshot(chatId)
      return {
        baseEventsAdded: window.__baseEvents.slice(before),
        committed: snapshot ? snapshot.items.length : null,
        temporaryRows: snapshot ? snapshot.items.filter(item => String(item.messageId).startsWith('-')).length : null
      }
    }, { chatId, temporaryId })

    // Telegram confirms the send: the same file arrives with its real message id.
    const retired = await page.evaluate(async ({ chatId, realId }) => {
      const before = window.__baseEvents.length
      window.handleEvent({
        name: 'message-upsert',
        chatId,
        payload: { chatId, message: { id: realId, outgoing: true, date: Math.floor(Date.now() / 1000), media: { chatId, messageId: realId, name: 'pending-upload.txt', type: 'document', fileSize: 11 } } }
      })
      await new Promise(resolve => setTimeout(resolve, 450))
      const snapshot = window.teleFilesIndex.snapshot(chatId)
      const items = snapshot ? snapshot.items : []
      const ids = items.map(item => String(item.messageId))
      return {
        baseEventsAdded: window.__baseEvents.slice(before),
        committed: items.length,
        temporaryRows: ids.filter(id => id.startsWith('-')).length,
        duplicates: ids.length - new Set(ids).size,
        holdsRealId: ids.includes(String(realId)),
        namedRows: items.filter(item => item.name === 'pending-upload.txt').length
      }
    }, { chatId, realId })

    observed.push({ chatId, count, temporaryId, realId, suppressed, retired })
  }

  baseline('3.5 upload and temporary-id retirement', observed)

  for (const item of observed) {
    const where = `chat ${item.chatId} (${item.count} existing rows)`
    expect.soft(item.suppressed.baseEventsAdded, `${where}: a temporary outgoing media upsert does not reach the base chain`).toEqual([])
    expect.soft(item.suppressed.temporaryRows, `${where}: no temporary row enters the index`).toBe(CAPTURED.temporary.temporaryRows)
    expect.soft(item.suppressed.committed, `${where}: the suppressed upsert changes no count`).toBe(item.count)
    expect.soft(item.retired.baseEventsAdded, `${where}: the real-id upsert reaches the base chain`).toEqual(['message-upsert'])
    expect.soft(item.retired.holdsRealId, `${where}: the row appears under its real message id`).toBe(true)
    expect.soft(item.retired.committed, `${where}: exactly one row was added`).toBe(item.count + 1)
    expect.soft(item.retired.temporaryRows, `${where}: no temporary id survives`).toBe(CAPTURED.temporary.temporaryRows)
    expect.soft(item.retired.duplicates, `${where}: no row is duplicated`).toBe(CAPTURED.temporary.duplicateRows)
    expect.soft(item.retired.namedRows, `${where}: the uploaded file is listed exactly once`).toBe(1)
  }
})

/* ============================================================================
 * 3.6 - pagination: 100 rows per page, the existing range labels, Next/Previous
 * ==========================================================================*/

test('3.6 pagination: 100 rows per page with the existing range labels and Next/Previous behaviour', async ({ page }) => {
  test.setTimeout(180000)
  await logicFixture(page, TEST_CHAT_ID, [LAYERS.p0v2, LAYERS.owner, LAYERS.pager], { filesView: true })
  await page.waitForFunction(() => !!window.fileGramFilesPages, null, { timeout: 15000 })

  const pageSize = await page.evaluate(() => window.fileGramFilesPages.pageSize)
  const totals = indexSizes(0x3a6006, 2, 340)
  const observed = []

  const readPager = () => page.evaluate(() => {
    const pager = document.querySelector('#filegram-file-pager')
    const grid = document.querySelector('#media-grid')
    const selectAll = document.querySelector('#select-all-media')
    return {
      rows: grid ? grid.querySelectorAll(':scope > .gcard[data-global-index]').length : null,
      firstIndex: grid && grid.firstElementChild ? Number(grid.firstElementChild.dataset.globalIndex) : null,
      lastIndex: grid && grid.lastElementChild ? Number(grid.lastElementChild.dataset.globalIndex) : null,
      summary: pager ? pager.querySelector('.filegram-page-summary').textContent : null,
      pageSizeLabel: pager ? pager.querySelector('.filegram-page-size').textContent : null,
      pageInput: pager ? pager.querySelector('input').value : null,
      pageOf: pager ? pager.querySelector('.filegram-page-of').textContent : null,
      firstDisabled: pager ? pager.querySelector('[data-page-action="first"]').disabled : null,
      prevDisabled: pager ? pager.querySelector('[data-page-action="prev"]').disabled : null,
      nextDisabled: pager ? pager.querySelector('[data-page-action="next"]').disabled : null,
      lastDisabled: pager ? pager.querySelector('[data-page-action="last"]').disabled : null,
      selectAll: selectAll ? selectAll.textContent : null,
      selectAllDisabled: selectAll ? selectAll.disabled : null,
      hidden: pager ? pager.classList.contains('hidden') : null
    }
  })

  for (let index = 0; index < totals.length; index++) {
    const chatId = chatFor(600 + index)
    const total = totals[index]
    await seedAndRestore(page, chatId, total)
    await page.evaluate(() => window.fileGramFilesPages.refresh())
    await page.waitForTimeout(250)

    const pages = Math.max(1, Math.ceil(total / pageSize))
    const first = await readPager()
    let second = null
    let backToFirst = null
    if (pages > 1) {
      await page.locator('#filegram-file-pager [data-page-action="next"]').click()
      await page.waitForTimeout(250)
      second = await readPager()
      await page.locator('#filegram-file-pager [data-page-action="prev"]').click()
      await page.waitForTimeout(250)
      backToFirst = await readPager()
    }
    observed.push({ chatId, total, pages, first, second, backToFirst })
  }

  baseline('3.6 pagination', { pageSize, observed })

  expect.soft(pageSize, 'the pager renders 100 entries per page').toBe(CAPTURED.pager.pageSize)
  for (const item of observed) {
    const { total, pages } = item
    const firstEnd = Math.min(total, pageSize)
    const where = `total ${total}`
    expect.soft(item.first.rows, `${where}: page 1 mounts min(total, 100) rows`).toBe(firstEnd)
    expect.soft(item.first.pageSizeLabel, `${where}: the page-size label`).toBe(CAPTURED.pager.pageSizeLabel)
    expect.soft(item.first.summary, `${where}: page 1 range label`).toBe(CAPTURED.pager.rangeLabel(total ? 1 : 0, firstEnd, total))
    expect.soft(item.first.pageOf, `${where}: page count label`).toBe(CAPTURED.pager.pageOf(pages))
    expect.soft(item.first.pageInput, `${where}: page 1 is selected`).toBe('1')
    expect.soft(item.first.prevDisabled, `${where}: Previous is disabled on page 1`).toBe(true)
    expect.soft(item.first.firstDisabled, `${where}: First is disabled on page 1`).toBe(true)
    expect.soft(item.first.nextDisabled, `${where}: Next is enabled only when more pages exist`).toBe(pages <= 1)
    expect.soft(item.first.lastDisabled, `${where}: Last is enabled only when more pages exist`).toBe(pages <= 1)
    expect.soft(item.first.selectAll, `${where}: Select all carries the derived total`).toBe(total ? `Select all (${total.toLocaleString()})` : 'Select all')
    expect.soft(item.first.selectAllDisabled, `${where}: Select all is disabled only when empty`).toBe(total === 0)
    expect.soft(item.first.hidden, `${where}: the pager is visible on the Files tab`).toBe(false)

    if (pages > 1) {
      const secondStart = pageSize + 1
      const secondEnd = Math.min(total, pageSize * 2)
      expect.soft(item.second.rows, `${where}: page 2 mounts its own slice`).toBe(secondEnd - pageSize)
      expect.soft(item.second.summary, `${where}: page 2 range label`).toBe(CAPTURED.pager.rangeLabel(secondStart, secondEnd, total))
      expect.soft(item.second.pageInput, `${where}: Next advances one page`).toBe('2')
      expect.soft(item.second.firstIndex, `${where}: page 2 starts at global index 100`).toBe(pageSize)
      expect.soft(item.second.prevDisabled, `${where}: Previous is enabled on page 2`).toBe(false)
      expect.soft(item.backToFirst.pageInput, `${where}: Previous returns to page 1`).toBe('1')
      expect.soft(item.backToFirst.summary, `${where}: Previous restores the page 1 range label`).toBe(CAPTURED.pager.rangeLabel(1, firstEnd, total))
    }
  }
})

/* ============================================================================
 * 3.7 - filtered, search, selection and queue counts stay separate from the total
 * ==========================================================================*/

test('3.7 separated counts: filtered, search, selection and queue counts never overwrite the authoritative total', async ({ page }) => {
  test.setTimeout(180000)
  await logicFixture(page, TEST_CHAT_ID, [LAYERS.p0v2, LAYERS.owner, LAYERS.pager], { filesView: true })
  await page.waitForFunction(() => !!window.fileGramFilesPages, null, { timeout: 15000 })

  const chatId = chatFor(700)
  const total = 250
  await seedAndRestore(page, chatId, total)
  await page.evaluate(() => window.fileGramFilesPages.refresh())
  await page.waitForTimeout(250)

  const read = () => page.evaluate(() => {
    const pager = document.querySelector('#filegram-file-pager')
    const queue = document.querySelector('#download-stats')
    return {
      header: document.querySelector('#chat-media-count').textContent,
      stateMediaCount: window.state.mediaCount,
      ownerTotal: window.teleFilesIndex.total(window.state.activeChatId),
      summary: pager ? pager.querySelector('.filegram-page-summary').textContent : null,
      selectAll: document.querySelector('#select-all-media').textContent,
      selectionSize: window.state.selection.size,
      queueStats: queue ? queue.textContent : null
    }
  })

  // The generated set alternates document/photo every fourth item, so a type
  // filter always selects a strict subset.
  const typeCounts = await page.evaluate(chatId => window.teleFilesIndex.snapshot(chatId).typeCounts, chatId)
  const unfiltered = await read()

  await page.evaluate(() => { window.state.files.filter = 'document'; window.fileGramFilesPages.refresh() })
  await page.waitForTimeout(250)
  const filtered = await read()

  await page.evaluate(() => { window.state.files.filter = 'all'; window.state.files.query = 'photo_stale_1'; window.fileGramFilesPages.refresh() })
  await page.waitForTimeout(250)
  const searched = await read()

  await page.evaluate(() => { window.state.files.query = ''; window.fileGramFilesPages.refresh() })
  await page.waitForTimeout(250)
  const selectionCount = await page.evaluate(async () => {
    const cards = [...document.querySelectorAll('#media-grid > .gcard')].slice(0, 7)
    for (const card of cards) card.click()
    await new Promise(resolve => setTimeout(resolve, 150))
    return cards.length
  })
  const selected = await read()

  /* The download queue paints its own node (#download-stats, written by app.js
   * renderDownloads). Proving the queue figure lands there and not on the
   * authoritative total is the separation this clause is about. */
  await page.evaluate(() => {
    document.querySelector('#download-stats').textContent = '3 active \u00b7 12 queued \u00b7 41 done'
  })
  const withQueue = await read()

  baseline('3.7 separated counts', { total, typeCounts, unfiltered, filtered, searched, selected, selectionCount, withQueue })

  const authoritative = CAPTURED.headerFor(total)
  for (const [label, snapshot] of [['unfiltered', unfiltered], ['type filter', filtered], ['search query', searched], ['selection', selected], ['download queue', withQueue]]) {
    expect.soft(snapshot.header, `${label}: the authoritative total is never overwritten`).toBe(authoritative)
    expect.soft(snapshot.stateMediaCount, `${label}: state.mediaCount stays authoritative`).toBe(total)
    expect.soft(snapshot.ownerTotal, `${label}: the owner total stays authoritative`).toBe(total)
  }
  expect.soft(filtered.summary, 'a type filter reports its own count and the total separately')
    .toBe(CAPTURED.pager.filteredRangeLabel(1, Math.min(100, typeCounts.document), typeCounts.document, total))
  expect.soft(filtered.selectAll, 'Select all reports the filtered count, not the total').toBe(`Select all (${typeCounts.document.toLocaleString()})`)
  expect.soft(searched.summary, 'a search reports its own count and the total separately').toMatch(/ matching \u00b7 250 total$/)
  expect.soft(selected.selectionSize, 'the selection has its own count').toBe(selectionCount)
  expect.soft(withQueue.queueStats, 'the queue count lives on its own node').toBe('3 active \u00b7 12 queued \u00b7 41 done')
})

/* ============================================================================
 * 3.8 - an inaccessible chat's empty result prunes nothing
 * ==========================================================================*/

test('3.8 inaccessible chat: an empty result prunes nothing', async ({ page }) => {
  test.setTimeout(180000)
  await logicFixture(page, TEST_CHAT_ID, [LAYERS.p0v2, LAYERS.owner])

  const sizes = indexSizes(0x3a8008, 2).filter(size => size > 0)
  const emptyLeg = []
  const throwLeg = []

  for (let index = 0; index < sizes.length; index++) {
    const count = sizes[index]

    const emptyChat = chatFor(800 + index)
    await seedAndRestore(page, emptyChat, count)
    await page.waitForTimeout(200)
    await page.evaluate(async chatId => {
      window.state.activeChatId = chatId
      window.__scanResponse = { found: 0, scanned: 1, items: [], typeCounts: {}, cancelled: false, done: true, fromCache: false }
      await window.teleFilesIndex.ensure(chatId, { hardRefresh: true })
    }, emptyChat)
    await page.waitForTimeout(400)
    emptyLeg.push({ chatId: emptyChat, count, ...(await observeChat(page, emptyChat)) })

    const throwChat = chatFor(850 + index)
    await seedAndRestore(page, throwChat, count)
    await page.waitForTimeout(200)
    const thrown = await page.evaluate(async chatId => {
      window.state.activeChatId = chatId
      window.__scanThrows = 'chat is not accessible'
      try { await window.teleFilesIndex.ensure(chatId, { hardRefresh: true }) } finally { window.__scanThrows = null }
      await new Promise(resolve => setTimeout(resolve, 250))
      return { loadStates: window.__loadStates.slice(-3) }
    }, throwChat)
    throwLeg.push({ chatId: throwChat, count, ...thrown, ...(await observeChat(page, throwChat)) })
  }

  baseline('3.8 inaccessible chat, empty done:true result', emptyLeg)
  baseline('3.8 inaccessible chat, scan throws', throwLeg)

  for (const item of emptyLeg) {
    const where = `chat ${item.chatId} (${item.count} rows)`
    expect.soft(item.committed, `${where}: an empty result prunes nothing from the index`).toBe(item.count)
    expect.soft(item.persisted, `${where}: an empty result prunes nothing from the record`).toBe(item.count)
    expect.soft(item.header, `${where}: an empty result leaves the header alone`).toBe(CAPTURED.headerFor(item.count))
  }
  for (const item of throwLeg) {
    const where = `chat ${item.chatId} (${item.count} rows)`
    expect.soft(item.committed, `${where}: a failed scan prunes nothing from the index`).toBe(item.count)
    expect.soft(item.persisted, `${where}: a failed scan prunes nothing from the record`).toBe(item.count)
    expect.soft(item.header, `${where}: a failed scan leaves the header alone`).toBe(CAPTURED.headerFor(item.count))
  }
})

/* ============================================================================
 * 3.11 - the rest of the Downloads sidebar keeps its geometry and behaviour
 *
 * Real stylesheets over the real downloads markup inside the real parent chain, so
 * this measures the cascade the Phase 4 stylesheet deletions will disturb. The
 * numbers below are what the UNFIXED cascade produces, including the parts of the
 * markup it hides.
 * ==========================================================================*/

test('3.11 rest of the sidebar: stats card, Parallel files slider and queue action rows keep their geometry', async ({ page }) => {
  test.setTimeout(120000)
  await serveFixture(page, LAYOUT_DOM)
  await installGlobals(page, null)

  // Task 6.3's shared guard: a bare page with no CSS fails here rather than greening
  // every geometry assertion below it.
  await assertRealStylesheets(page)

  const measure = () => page.evaluate(() => {
    const box = selector => {
      const node = document.querySelector(selector)
      if (!node) return null
      const rect = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      return { w: Math.round(rect.width), h: Math.round(rect.height), top: Math.round(rect.top), left: Math.round(rect.left), display: style.display, visible: rect.width > 0 && rect.height > 0 }
    }
    const topsOf = selectors => selectors.map(selector => {
      const node = document.querySelector(selector)
      return node ? Math.round(node.getBoundingClientRect().top) : null
    })
    const pane = document.querySelector('#mg-downloads-pane')
    const parallel = [...document.querySelectorAll('#mg-downloads-pane .dl-controls > label.conc')].pop()
    const setDir = document.querySelector('#set-dir')
    return {
      pane: box('#mg-downloads-pane'),
      paneWidth: pane ? Math.round(pane.getBoundingClientRect().width) : null,
      downloadsHead: box('.downloads-head'),
      downloadsTitle: box('.downloads-head .dl-title h3'),
      downloadStats: box('#download-stats'),
      toggleDrawer: box('#toggle-drawer'),
      scanBanner: box('#scan-banner'),
      parallelLabelText: parallel ? (parallel.querySelector('span') || {}).textContent : null,
      parallelWidth: parallel ? Math.round(parallel.getBoundingClientRect().width) : null,
      concurrency: box('#concurrency'),
      concurrencyVal: box('#concurrency-val'),
      pauseAll: box('#pause-all'),
      resumeAll: box('#resume-all'),
      cancelAll: box('#cancel-all'),
      clearDone: box('#clear-done'),
      packMedia: box('#pack-media'),
      cancelPack: box('#cancel-pack'),
      downloadList: box('#download-list'),
      queueRowTops: topsOf(['#pause-all', '#resume-all', '#cancel-all', '#clear-done']),
      // cross-reference to the task 2 / Phase 0 finding, recorded as context
      setDirWidth: setDir ? Math.round(setDir.getBoundingClientRect().width) : null
    }
  })

  const byViewport = []
  for (const width of [1280, 1366, 1600, 1920]) {
    await page.setViewportSize({ width, height: 900 })
    await page.waitForTimeout(200)
    byViewport.push({ viewport: width, ...(await measure()) })
  }

  // Behaviour, not only geometry: the slider still drives its own readout.
  const sliderBehaviour = await page.evaluate(async () => {
    const slider = document.querySelector('#concurrency')
    const readout = document.querySelector('#concurrency-val')
    const before = { value: slider.value, readout: readout.textContent, min: slider.min, max: slider.max, step: slider.step }
    slider.value = '33'
    readout.textContent = slider.value
    slider.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 60))
    return { before, after: { value: slider.value, readout: readout.textContent } }
  })

  baseline('3.11 rest of the sidebar', { byViewport, sliderBehaviour })

  for (const item of byViewport) {
    const pinned = CAPTURED.sidebar.byViewport[item.viewport]
    const where = `viewport ${item.viewport}px`
    expect.soft(item.paneWidth, `${where}: the downloads pane width`).toBe(pinned.paneWidth)
    expect.soft(item.pane.h, `${where}: the downloads pane height`).toBe(CAPTURED.sidebar.paneHeight)

    /* The panel header, its stats line and the Hide button are display:none in this
     * composition: `management.js`'s drawer tabs replaced them, and three
     * stylesheets say so. The live stats card is `#tele-ui-download-summary`,
     * created by `daily-driver-final-ui-fix.js`, and is measured in the live test. */
    expect.soft(item.downloadsHead.display, `${where}: the panel header stays replaced by the drawer tabs`).toBe(CAPTURED.sidebar.hiddenDisplays.downloadsHead)
    expect.soft(item.toggleDrawer.display, `${where}: the Hide button stays replaced by the drawer tabs`).toBe(CAPTURED.sidebar.hiddenDisplays.toggleDrawer)
    expect.soft(item.scanBanner.display, `${where}: the scan banner stays hidden until a scan runs`).toBe(CAPTURED.sidebar.hiddenDisplays.scanBanner)
    expect.soft(item.cancelPack.display, `${where}: Cancel packing stays hidden until packing runs`).toBe(CAPTURED.sidebar.hiddenDisplays.cancelPack)
    for (const name of CAPTURED.sidebar.zeroAreaNodes) {
      expect.soft(item[name].visible, `${where}: ${name} occupies no layout`).toBe(false)
    }

    expect.soft(item.parallelLabelText, `${where}: the Parallel files label`).toBe('Parallel files')
    expect.soft(item.parallelWidth, `${where}: the Parallel files row width`).toBe(pinned.parallelWidth)
    expect.soft(item.concurrency.w, `${where}: the slider width`).toBe(pinned.concurrencyWidth)
    expect.soft(item.concurrency.h, `${where}: the slider height`).toBe(CAPTURED.sidebar.concurrency.h)
    expect.soft(item.concurrency.top, `${where}: the slider vertical position`).toBe(CAPTURED.sidebar.concurrency.top)
    expect.soft(item.concurrencyVal.w, `${where}: the slider readout width`).toBe(CAPTURED.sidebar.concurrencyVal.w)
    expect.soft(item.concurrencyVal.h, `${where}: the slider readout height`).toBe(CAPTURED.sidebar.concurrencyVal.h)
    expect.soft(item.concurrencyVal.top, `${where}: the slider readout vertical position`).toBe(CAPTURED.sidebar.concurrencyVal.top)

    for (const [name, node] of [['Pause all', item.pauseAll], ['Resume all', item.resumeAll], ['Cancel all', item.cancelAll], ['Clear done', item.clearDone]]) {
      expect.soft(node.visible, `${where}: ${name} is laid out`).toBe(true)
      expect.soft(node.w, `${where}: ${name} width`).toBe(pinned.queueButtonWidth)
      expect.soft(node.h, `${where}: ${name} height`).toBe(CAPTURED.sidebar.queueButtonHeight)
    }
    // OBSERVED: the four queue actions lay out as a 2x2 grid, not one row.
    expect.soft(item.queueRowTops, `${where}: the queue actions keep their 2x2 layout`).toEqual(CAPTURED.sidebar.queueRowTops)

    expect.soft(item.downloadList.w, `${where}: the download list fills the pane`).toBe(pinned.paneWidth)
    expect.soft(item.downloadList.h, `${where}: the download list height`).toBe(CAPTURED.sidebar.downloadListHeight)

    /* Shift-invariant relationships. These hold whatever the Save-to control's height is,
     * so they keep meaning after the re-pin above and would catch a real regression in the
     * sidebar's internal arrangement that a pure vertical offset cannot explain. */
    expect.soft(item.concurrencyVal.top - item.concurrency.top, `${where}: the readout stays centred on the slider`).toBe(2)
    expect.soft(item.cancelAll.top - item.pauseAll.top, `${where}: the two queue rows keep their spacing`).toBe(46)
    expect.soft(item.resumeAll.left - item.pauseAll.left, `${where}: the queue columns keep their spacing`).toBe(pinned.queueButtonWidth + 8)
    expect.soft(item.downloadList.top, `${where}: the download list starts below the queue actions`).toBeGreaterThan(item.clearDone.top + item.clearDone.h)
    expect.soft(item.concurrency.top, `${where}: the Parallel row stays above the queue actions`).toBeLessThan(item.pauseAll.top)
    // The Save-to width is recorded in the BASELINE output above and asserted in
    // tests/visual-check.spec.js, not here. See the note on CAPTURED.sidebar.
  }

  expect.soft(sliderBehaviour.before.min, 'the slider keeps its range').toBe(CAPTURED.sidebar.slider.min)
  expect.soft(sliderBehaviour.before.max, 'the slider keeps its range').toBe(CAPTURED.sidebar.slider.max)
  expect.soft(sliderBehaviour.before.step, 'the slider keeps its step').toBe(CAPTURED.sidebar.slider.step)
  expect.soft(sliderBehaviour.before.value, 'the slider keeps its default').toBe(CAPTURED.sidebar.slider.value)
  expect.soft(sliderBehaviour.after.readout, 'the slider readout follows the slider').toBe('33')
})

/* ============================================================================
 * 3.12 - removal is not a blacklist
 *
 * Baselined now so the fix cannot turn a removal into a permanent suppression.
 *
 * OBSERVED on unfixed code, and recorded rather than asserted: a removal is
 * in-memory only. `uploads-hardening.js` keeps the removed ids in `deletedByChat`
 * and filters them out of `teleFilesIndex.snapshot` for the rest of the session, so
 * a later truth pass reporting them present does NOT bring them back in-session -
 * that is a session-lifetime blacklist and it is bug 1's other half. The durable
 * record is never pruned at all, which is why the ids survive there.
 *
 * The assertions below therefore cover the DURABLE level, which is the level the
 * design moves the mechanism to (`removedIds` / `reconciledAt` inside the persistent
 * record) and the level where the property has to hold both before and after the
 * fix: a truth pass that reports a previously removed id present again leaves that
 * id in the durable record, so the next session restores it. The in-session half is
 * a fix-side property and belongs to the task 2 / task 11.1 set, not here.
 * ==========================================================================*/

test('3.12 removal is not a blacklist: a truth pass that reports a removed id present again keeps it durable', async ({ page }) => {
  test.setTimeout(180000)
  await logicFixture(page, TEST_CHAT_ID, [LAYERS.p0v2, LAYERS.owner, LAYERS.hardening])

  const chatId = chatFor(900)
  const total = 12
  await seedAndRestore(page, chatId, total)
  await page.waitForTimeout(200)

  // Generated removal orders, so the property is not tied to one sequence.
  const removalOrders = [shuffled(0x3a9009, [0, 3, 7]), shuffled(0x3a900a, [1, 5, 9])]
  const observed = []

  for (const order of removalOrders) {
    const removedIds = order.map(offset => String(1000000 + offset))
    const step = await page.evaluate(async ({ chatId, removedIds, total }) => {
      // Removal through the only subtractive path that exists on unfixed code.
      window.handleEvent({ name: 'message-delete', chatId, payload: { chatId, messageIds: removedIds } })
      await new Promise(resolve => setTimeout(resolve, 350))
      const afterRemoval = window.teleFilesIndex.snapshot(chatId)
      const recordAfterRemoval = await window.__readRecord(chatId)

      // A later truth pass reports every id present again (a genuine re-upload).
      window.__scanResponse = { found: total, scanned: total, items: window.__itemsRange(chatId, 0, total), typeCounts: {}, cancelled: false, done: true, fromCache: false }
      await window.teleFilesIndex.ensure(chatId, { hardRefresh: true })
      await new Promise(resolve => setTimeout(resolve, 450))
      const afterTruth = window.teleFilesIndex.snapshot(chatId)
      const recordAfterTruth = await window.__readRecord(chatId)
      const committedIds = afterTruth ? afterTruth.items.map(item => String(item.messageId)) : []
      const durableIds = recordAfterTruth ? recordAfterTruth.items.map(item => String(item.messageId)) : []
      return {
        removedIds,
        countAfterRemoval: afterRemoval ? afterRemoval.items.length : null,
        recordAfterRemoval: recordAfterRemoval ? recordAfterRemoval.items.length : null,
        countAfterTruth: afterTruth ? afterTruth.items.length : null,
        recordAfterTruth: recordAfterTruth ? recordAfterTruth.items.length : null,
        readdedInSession: removedIds.filter(id => committedIds.includes(id)),
        readdedInDurable: removedIds.filter(id => durableIds.includes(id))
      }
    }, { chatId, removedIds, total })
    observed.push(step)
  }

  // Reload leg: a fresh session restores from the durable record, which is where the
  // "not a blacklist" property has to survive.
  const allRemoved = [...new Set(removalOrders.flat().map(offset => String(1000000 + offset)))]
  const afterReload = await page.evaluate(async ({ chatId, allRemoved }) => {
    const record = await window.__readRecord(chatId)
    const ids = record ? record.items.map(item => String(item.messageId)) : []
    return { durable: record ? record.items.length : null, restorable: allRemoved.filter(id => ids.includes(id)) }
  }, { chatId, allRemoved })

  baseline('3.12 removal is not a blacklist', { total, observed, afterReload })
  console.log(`OBSERVATION [3.12]: on unfixed code a removal is in-memory only. teleFilesIndex.snapshot suppressed every re-reported id for the rest of the session (readdedInSession=${JSON.stringify(observed.map(step => step.readdedInSession))}), while the durable record was never pruned (recordAfterRemoval=${JSON.stringify(observed.map(step => step.recordAfterRemoval))}). The in-session half is a fix-side property (task 11.1), not a preservation assertion.`)

  for (const step of observed) {
    const where = `removed ${JSON.stringify(step.removedIds)}`
    expect.soft(step.readdedInDurable, `${where}: a truth pass reporting them present keeps every id in the durable record`).toEqual(step.removedIds)
    expect.soft(step.recordAfterTruth, `${where}: the durable record holds the full set after the truth pass`).toBe(total)
  }
  expect.soft(afterReload.restorable, 'every removed id a truth pass re-reported is restorable from the durable record').toEqual(allRemoved)
  expect.soft(afterReload.durable, 'the durable record holds the full set after the truth passes').toBe(total)
})

/* ============================================================================
 * 3.9 / 3.10 - the download queue actions, the configured folder, and the live
 * sidebar cross-check, against the RUNNING application.
 *
 * The folder dialog is never opened: the cancel leg routes
 * `/api/filegram/pick-download-folder` to a cancel response, so no native dialog is
 * spawned and none can be left open.
 * ==========================================================================*/

test('3.9 and 3.10 download queue wiring, the configured folder, and the live sidebar on the running app', async ({ page, request }) => {
  test.setTimeout(240000)
  await assertServerRunning(request)

  let pickerCalls = 0
  await page.route(`${SERVER}/api/filegram/pick-download-folder*`, route => {
    pickerCalls++
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, cancelled: true }) })
  })

  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto(`${SERVER}/`, { waitUntil: 'load' })
  // Waits on the single control's path display. The task 3 baseline waited on
  // `#dl-dir.value`; that input is deleted, and this is where the same value is shown.
  await page.waitForFunction(() => typeof window.request === 'function' && !!document.querySelector('#dl-dir-path'), null, { timeout: 30000 })
  await page.waitForFunction(() => {
    const node = document.querySelector('#dl-dir-path')
    return !!node && /[\\/]/.test(String(node.textContent || ''))
  }, null, { timeout: 30000 })
  await page.waitForTimeout(6000)

  // Record every ws request the page makes, passing them through untouched.
  await page.evaluate(() => {
    window.__requests = []
    const base = window.request
    window.request = function preservationRequestProbe (type, payload = {}) {
      window.__requests.push({ type, payload })
      return base(type, payload)
    }
  })

  const startup = await page.evaluate(() => {
    const text = selector => { const node = document.querySelector(selector); return node ? node.textContent.trim() : null }
    const box = selector => {
      const node = document.querySelector(selector)
      if (!node) return null
      const rect = node.getBoundingClientRect()
      return { w: Math.round(rect.width), h: Math.round(rect.height), top: Math.round(rect.top), display: getComputedStyle(node).display, visible: rect.width > 0 && rect.height > 0 }
    }
    return {
      buildId: null,
      savedPathText: text('#dl-dir-path'),
      setDirTitle: document.querySelector('#set-dir') ? document.querySelector('#set-dir').title : null,
      setDirPath: document.querySelector('#set-dir') ? (document.querySelector('#set-dir').dataset.fgFolderPath || null) : null,
      queueButtons: ['#pause-all', '#resume-all', '#cancel-all', '#clear-done', '#pack-media'].map(selector => {
        const node = document.querySelector(selector)
        return { selector, present: !!node, text: node ? node.textContent.trim() : null, box: box(selector) }
      }),
      statsCard: box('#tele-ui-download-summary'),
      statsCardTiles: [...document.querySelectorAll('#tele-ui-download-summary [data-stat]')].map(node => ({ stat: node.dataset.stat, text: node.textContent.trim() })),
      statsTotal: text('#fg-stats-total'),
      concurrency: box('#concurrency'),
      concurrencyValue: document.querySelector('#concurrency') ? document.querySelector('#concurrency').value : null,
      concurrencyReadout: text('#concurrency-val'),
      downloadStats: text('#download-stats'),
      paneWidth: document.querySelector('#mg-downloads-pane') ? Math.round(document.querySelector('#mg-downloads-pane').getBoundingClientRect().width) : null,
      setDirWidth: document.querySelector('#set-dir') ? Math.round(document.querySelector('#set-dir').getBoundingClientRect().width) : null
    }
  })

  /* Queue actions. Pause all / Resume all / Clear done are safe on an idle queue.
   * Cancel all is left to its own guard: app.js returns before requesting anything
   * when queueStats reports nothing remaining, and nothing here is going to confirm
   * a destructive prompt. */
  const queueWiring = []
  for (const [selector, expected] of [['#pause-all', 'pause-all'], ['#resume-all', 'resume-all'], ['#clear-done', 'clear-done']]) {
    const seen = await page.evaluate(async ({ selector }) => {
      const before = window.__requests.length
      document.querySelector(selector).click()
      await new Promise(resolve => setTimeout(resolve, 900))
      return window.__requests.slice(before).map(entry => entry.type)
    }, { selector })
    queueWiring.push({ selector, expected, observed: seen })
  }
  const cancelAll = await page.evaluate(async () => {
    const before = window.__requests.length
    const remaining = window.state && window.state.queueStats ? Number(window.state.queueStats.remaining || 0) : 0
    document.querySelector('#cancel-all').click()
    await new Promise(resolve => setTimeout(resolve, 900))
    return { remaining, observed: window.__requests.slice(before).map(entry => entry.type) }
  })

  // Cancelled folder dialog: routed cancel, no native dialog.
  const beforeCancel = await page.evaluate(() => ({
    savedPathText: document.querySelector('#dl-dir-path').textContent.trim(),
    setDirTitle: document.querySelector('#set-dir').title,
    setDirText: document.querySelector('#set-dir').textContent.trim()
  }))
  await page.locator('#set-dir').click()
  await page.waitForTimeout(2000)
  const afterCancel = await page.evaluate(() => ({
    savedPathText: document.querySelector('#dl-dir-path').textContent.trim(),
    setDirTitle: document.querySelector('#set-dir').title,
    setDirText: document.querySelector('#set-dir').textContent.trim(),
    setDownloadDirRequests: window.__requests.filter(entry => entry.type === 'set-download-dir').length
  }))

  const status = await page.evaluate(() => window.request('get-status', {})
    .then(data => ({ downloadsDir: data.downloadsDir, buildId: data.buildId, buildIdSource: data.buildIdSource, serverPid: data.serverPid, ready: data.ready, concurrency: data.concurrency }))
    .catch(error => ({ error: String(error && error.message) })))

  baseline('3.9 and 3.10 live download queue, configured folder and sidebar', { startup, queueWiring, cancelAll, beforeCancel, afterCancel, status, pickerCalls })

  // 3.10 - a configured folder shows on startup. Same value, same source of truth, read
  // from the single control's path display instead of from the deleted input and line.
  expect.soft(startup.savedPathText, 'the configured folder shows on startup').toBe(CAPTURED.live.savedPathText)
  expect.soft(startup.setDirTitle, 'the Save-to control carries the configured folder in its tooltip').toBe(CAPTURED.folder.configured)
  expect.soft(startup.setDirPath, 'the Save-to control records the configured folder in its dataset').toBe(CAPTURED.folder.configured)
  expect.soft(status.downloadsDir, 'the server reports the same configured folder').toBe(CAPTURED.folder.configured)

  // 3.9 - the queue action rows are present and each issues its own request plus the
  // authoritative resync that daily-driver-final-ui-fix.js performs after any action
  const queueButtons = startup.queueButtons.filter(button => button.selector !== '#pack-media')
  expect.soft(queueButtons.map(button => button.text), 'the four queue actions keep their labels').toEqual(CAPTURED.live.queueButtonLabels)
  for (const button of startup.queueButtons) {
    expect.soft(button.present, `${button.selector} is present in the sidebar`).toBe(true)
  }
  for (const button of queueButtons) {
    expect.soft(button.box.visible, `${button.selector} is laid out`).toBe(true)
    expect.soft(button.box.w, `${button.selector} width`).toBe(CAPTURED.live.queueButton.w)
    expect.soft(button.box.h, `${button.selector} height`).toBe(CAPTURED.live.queueButton.h)
  }
  expect.soft(queueButtons[0].box.top, 'Pause all and Resume all share a row').toBe(queueButtons[1].box.top)
  expect.soft(queueButtons[2].box.top, 'Cancel all and Clear done share a row').toBe(queueButtons[3].box.top)
  expect.soft(queueButtons[2].box.top, 'the queue actions keep their 2x2 layout').toBeGreaterThan(queueButtons[0].box.top)
  const pack = startup.queueButtons.find(button => button.selector === '#pack-media')
  expect.soft(pack.box.display, 'the Zip selected row stays hidden by daily-driver-p1.css').toBe(CAPTURED.live.packMediaDisplay)
  for (const item of queueWiring) {
    expect.soft(item.observed, `${item.selector} issues its own queue request and the authoritative resync`).toEqual([item.expected, CAPTURED.live.queueResyncRequest])
  }
  expect.soft(cancelAll.observed, 'Cancel all issues nothing while the queue reports nothing remaining').toEqual([])

  // 3.10 - a cancelled dialog leaves the configured folder alone
  expect.soft(pickerCalls, 'the Save-to click reaches the picker endpoint exactly once').toBe(1)
  expect.soft(afterCancel.savedPathText, 'a cancelled dialog leaves the configured folder unchanged').toBe(beforeCancel.savedPathText)
  expect.soft(afterCancel.setDirTitle, 'a cancelled dialog leaves the displayed path unchanged').toBe(beforeCancel.setDirTitle)
  expect.soft(afterCancel.setDirText, 'a cancelled dialog leaves the control text unchanged').toBe(beforeCancel.setDirText)
  expect.soft(afterCancel.setDownloadDirRequests, 'a cancelled dialog issues no set-download-dir').toBe(CAPTURED.folder.setDownloadDirRequestsOnCancel)

  // 3.11 live cross-check - the stats card the layout fixture cannot see, because
  // daily-driver-final-ui-fix.js creates it at run time.
  expect.soft(startup.statsCard && startup.statsCard.visible, 'the live stats card is laid out').toBe(true)
  expect.soft(startup.statsCard.w, 'the live stats card width').toBe(CAPTURED.live.statsCard.w)
  expect.soft(startup.statsCard.h, 'the live stats card height').toBe(CAPTURED.live.statsCard.h)
  expect.soft(startup.statsCard.display, 'the live stats card keeps its grid').toBe(CAPTURED.live.statsCard.display)
  expect.soft(startup.statsCardTiles.map(tile => tile.stat), 'the live stats card keeps its tiles, in order').toEqual(CAPTURED.live.statsCardTiles)
  expect.soft(startup.concurrency && startup.concurrency.visible, 'the live Parallel files slider is laid out').toBe(true)
  expect.soft(startup.concurrency.w, 'the live slider width').toBe(CAPTURED.live.concurrency.w)
  expect.soft(startup.concurrency.h, 'the live slider height').toBe(CAPTURED.live.concurrency.h)
  expect.soft(startup.concurrencyReadout, 'the live slider readout matches the slider value').toBe(startup.concurrencyValue)
  expect.soft(startup.paneWidth, 'the live downloads pane width at 1600px').toBe(CAPTURED.live.paneWidth)
  // The live Save-to width is measured and printed in the BASELINE output above but not
  // asserted here: a Save-to render is inside the bug condition, so it belongs to
  // tests/visual-check.spec.js. See the note on CAPTURED.sidebar.
})
