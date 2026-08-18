// @ts-check
'use strict'

const { test, expect } = require('@playwright/test')
const WebSocket = require('ws')

const {
  SERVER,
  TEST_CHAT_ID,
  STALE_COUNT,
  CONFIGURED_DIR,
  HIGH_WATER_KEY,
  LAYERS,
  LOGIC_DOM,
  LAYOUT_DOM,
  serveFixture,
  installGlobals,
  loadLayers,
  assertRealBoundary,
  assertRealStylesheets,
  assertServerRunning
} = require('./fixture-support')

function chatFor (index) { return `-1004474520${String(index).padStart(3, '0')}` }
function sortedIds (values) { return [...values].map(String).sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0) }

async function seedSnapshot (page, chatId, count, options = {}) {
  return page.evaluate(async ({ chatId, count, key, ageMs }) => {
    const items = window.__itemsRange(chatId, 0, count)
    const savedAt = Date.now() - ageMs
    await window.__seedRecord(chatId, { items, savedAt })
    window.rescueFileCache.set(String(chatId), { ...window.__snapshotFrom(chatId, items, true), savedAt })
    const floors = JSON.parse(localStorage.getItem(key) || '{}')
    floors[String(chatId)] = { count, at: savedAt }
    localStorage.setItem(key, JSON.stringify(floors))
    return items.map(item => String(item.messageId))
  }, { chatId, count, key: HIGH_WATER_KEY, ageMs: options.ageMs || 60000 })
}

async function readOwnerState (page, chatId) {
  return page.evaluate(async chatId => {
    const snapshot = window.teleFilesIndex.snapshot(chatId)
    const record = await window.__readRecord(chatId)
    return {
      count: snapshot ? snapshot.items.length : null,
      ids: snapshot ? snapshot.items.map(item => String(item.messageId)) : [],
      persisted: record ? record.items.length : null,
      persistedIds: record ? record.items.map(item => String(item.messageId)) : [],
      truthCount: record ? Number(record.truthCount || 0) : null,
      removedIds: record && Array.isArray(record.removedIds) ? record.removedIds.map(item => String(item.id)) : [],
      header: (document.querySelector('#chat-media-count') || {}).textContent || '',
      selectAll: (document.querySelector('#select-all-media') || {}).textContent || ''
    }
  }, chatId)
}

async function bootOwner (page, activeChat = 'fixture-neutral') {
  await page.evaluate(chat => { window.state.activeChatId = chat }, activeChat)
  await loadLayers(page, [LAYERS.owner])
  await assertRealBoundary(page)
}

async function wsRequest (type, payload, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket('ws://127.0.0.1:3000')
    const timer = setTimeout(() => { try { socket.terminate() } catch {}; reject(new Error(`${type} timed out`)) }, timeout)
    socket.on('open', () => socket.send(JSON.stringify({ id: 1, type, payload })))
    socket.on('message', raw => {
      let message
      try { message = JSON.parse(String(raw)) } catch { return }
      if (!message || message.type !== 'response' || message.id !== 1) return
      clearTimeout(timer)
      try { socket.close() } catch {}
      resolve(message)
    })
    socket.on('error', error => { clearTimeout(timer); reject(error) })
  })
}

test('authoritative Telegram truth can shrink a persisted index, including to zero', async ({ page }) => {
  test.setTimeout(60000)
  await serveFixture(page, LOGIC_DOM)
  await installGlobals(page, 'fixture-neutral')

  const cases = [
    { chatId: TEST_CHAT_ID, stored: STALE_COUNT, live: 0 },
    { chatId: chatFor(1), stored: 166, live: 8 },
    { chatId: chatFor(2), stored: 193, live: 124 },
    { chatId: chatFor(3), stored: 347, live: 207 }
  ]
  const idsByChat = {}
  for (const item of cases) idsByChat[item.chatId] = await seedSnapshot(page, item.chatId, item.stored)

  await bootOwner(page)

  for (const item of cases) {
    const liveIds = idsByChat[item.chatId].slice(0, item.live)
    await page.evaluate(({ chatId, liveIds }) => {
      window.state.activeChatId = chatId
      window.__truthByChat = window.__truthByChat || {}
      window.__truthByChat[String(chatId)] = window.__truthAnswer(liveIds)
    }, { chatId: item.chatId, liveIds })

    await page.evaluate(chatId => window.teleFilesIndex.ensure(chatId), item.chatId)
    const before = await page.evaluate(chatId => window.__readRecord(chatId).then(record => record && record.items.length), item.chatId)
    expect(before, `precondition for ${item.chatId}`).toBe(item.stored)

    const result = await page.evaluate(chatId => window.teleFilesIndex.reconcile(chatId, { force: true }), item.chatId)
    expect(['pruned', 'unchanged']).toContain(result.status)
    const after = await readOwnerState(page, item.chatId)
    expect(after.count, `committed ${item.chatId}`).toBe(item.live)
    expect(after.persisted, `persisted ${item.chatId}`).toBe(item.live)
    expect(after.truthCount, `truth count ${item.chatId}`).toBe(item.live)
    expect(sortedIds(after.ids)).toEqual(sortedIds(liveIds))
    expect(sortedIds(after.persistedIds)).toEqual(sortedIds(liveIds))
  }
})

test('partial scans and partial progress can never lower the committed total', async ({ page }) => {
  await serveFixture(page, LOGIC_DOM)
  await installGlobals(page, 'fixture-neutral')
  const chatId = chatFor(10)
  const allIds = await seedSnapshot(page, chatId, 300)
  await bootOwner(page)

  await page.evaluate(({ chatId, ids }) => {
    window.state.activeChatId = chatId
    window.__truthByChat = { [String(chatId)]: window.__truthAnswer(ids) }
  }, { chatId, ids: allIds })
  await page.evaluate(chatId => window.teleFilesIndex.ensure(chatId), chatId)

  await page.evaluate(chatId => {
    const items = window.__itemsRange(chatId, 0, 40)
    window.handleEvent({ name: 'media-index-progress', payload: { chatId, items, found: 40, scanned: 40, done: false, historyComplete: false } })
  }, chatId)
  await page.waitForTimeout(500)
  let state = await readOwnerState(page, chatId)
  expect(state.count).toBe(300)
  expect(state.persisted).toBe(300)

  await page.evaluate(chatId => {
    window.__scanResponse = { chatId, items: window.__itemsRange(chatId, 0, 50), found: 50, scanned: 50, done: true, historyComplete: false, fromCache: false }
  }, chatId)
  await page.evaluate(chatId => window.teleFilesIndex.hardRefresh(chatId), chatId)
  state = await readOwnerState(page, chatId)
  expect(state.count).toBe(300)
  expect(state.persisted).toBe(300)
})

test('confirmed empty Telegram truth survives browser reload and stale high-water state', async ({ page }) => {
  await serveFixture(page, LOGIC_DOM)
  await installGlobals(page, 'fixture-neutral')
  await seedSnapshot(page, TEST_CHAT_ID, STALE_COUNT)
  await bootOwner(page)

  await page.evaluate(chatId => {
    window.state.activeChatId = chatId
    window.__truthByChat = { [String(chatId)]: window.__truthAnswer([]) }
  }, TEST_CHAT_ID)
  await page.evaluate(chatId => window.teleFilesIndex.ensure(chatId), TEST_CHAT_ID)
  await page.evaluate(chatId => window.teleFilesIndex.reconcile(chatId, { force: true }), TEST_CHAT_ID)

  let state = await readOwnerState(page, TEST_CHAT_ID)
  expect(state.count).toBe(0)
  expect(state.persisted).toBe(0)
  expect(state.header).toBe('0 files')

  // Same browser origin, new JS world: IndexedDB/localStorage survive, in-memory owner does not.
  await page.reload()
  await installGlobals(page, 'fixture-neutral')
  await bootOwner(page)
  await page.evaluate(chatId => { window.state.activeChatId = chatId }, TEST_CHAT_ID)
  await page.evaluate(chatId => window.teleFilesIndex.ensure(chatId), TEST_CHAT_ID)
  state = await readOwnerState(page, TEST_CHAT_ID)
  expect(state.count).toBe(0)
  expect(state.persisted).toBe(0)
})

test('failed or incomplete truth is unknown: it never shrinks and retries with backoff', async ({ page }) => {
  test.setTimeout(30000)
  await serveFixture(page, LOGIC_DOM)
  await installGlobals(page, 'fixture-neutral')
  const chatId = chatFor(20)
  await seedSnapshot(page, chatId, 64)
  await page.evaluate(chatId => {
    window.__truthByChat = { [String(chatId)]: { __throw: 'truth unavailable' } }
  }, chatId)
  await bootOwner(page)
  await page.evaluate(chatId => { window.state.activeChatId = chatId }, chatId)
  await page.evaluate(chatId => window.teleFilesIndex.ensure(chatId), chatId)

  const first = await page.evaluate(chatId => window.teleFilesIndex.reconcile(chatId, { force: true }), chatId)
  expect(first.status).toBe('unknown')
  await page.waitForTimeout(2400)
  const state = await readOwnerState(page, chatId)
  expect(state.count).toBe(64)
  expect(state.persisted).toBe(64)
  const diagnostics = await page.evaluate(() => ({ calls: window.__truthCalls.length, states: window.__loadStates.slice() }))
  expect(diagnostics.calls).toBeGreaterThanOrEqual(2)
  expect(diagnostics.states.some(text => /Could not verify against Telegram/i.test(text))).toBe(true)
})

test('TDLib cache eviction is ignored while permanent Telegram deletion is persisted', async ({ page }) => {
  await serveFixture(page, LOGIC_DOM)
  await installGlobals(page, 'fixture-neutral')
  const chatId = chatFor(30)
  const ids = await seedSnapshot(page, chatId, 3)
  await page.evaluate(({ chatId, ids }) => { window.__truthByChat = { [String(chatId)]: window.__truthAnswer(ids) } }, { chatId, ids })
  await bootOwner(page)
  await page.evaluate(chatId => { window.state.activeChatId = chatId }, chatId)
  await page.evaluate(chatId => window.teleFilesIndex.ensure(chatId), chatId)

  await page.evaluate(({ chatId, id }) => {
    window.handleEvent({ name: 'message-delete', chatId, messageIds: [id], isPermanent: false, fromCache: true })
  }, { chatId, id: ids[0] })
  await page.waitForTimeout(100)
  expect((await readOwnerState(page, chatId)).count).toBe(3)

  await page.evaluate(({ chatId, id }) => {
    window.handleEvent({ name: 'message-delete', chatId, messageIds: [id], isPermanent: true, fromCache: false })
  }, { chatId, id: ids[1] })
  await expect.poll(async () => (await readOwnerState(page, chatId)).count).toBe(2)
  const state = await readOwnerState(page, chatId)
  expect(state.persisted).toBe(2)
  expect(state.ids).not.toContain(ids[1])
})

test('stale compatibility cache cannot resurrect rows after authoritative reconciliation', async ({ page }) => {
  await serveFixture(page, LOGIC_DOM)
  await installGlobals(page, 'fixture-neutral')
  const chatId = chatFor(40)
  const staleIds = await seedSnapshot(page, chatId, 22)
  const liveIds = staleIds.slice(0, 5)
  await page.evaluate(({ chatId, liveIds }) => { window.__truthByChat = { [String(chatId)]: window.__truthAnswer(liveIds) } }, { chatId, liveIds })
  await bootOwner(page)
  await page.evaluate(chatId => { window.state.activeChatId = chatId }, chatId)
  await page.evaluate(chatId => window.teleFilesIndex.ensure(chatId), chatId)
  await page.evaluate(chatId => window.teleFilesIndex.reconcile(chatId, { force: true }), chatId)
  expect((await readOwnerState(page, chatId)).count).toBe(5)

  await page.evaluate(chatId => {
    const stale = window.__itemsRange(chatId, 0, 22)
    window.rescueFileCache.set(String(chatId), { ...window.__snapshotFrom(chatId, stale, true), savedAt: Date.now() - 120000 })
  }, chatId)
  await page.evaluate(chatId => window.rescueEnsureAllFiles(chatId), chatId)
  const state = await readOwnerState(page, chatId)
  expect(state.count).toBe(5)
  expect(state.persisted).toBe(5)
  expect(sortedIds(state.ids)).toEqual(sortedIds(liveIds))
})

test('Save-to renders as one full-width control with one visible path', async ({ page }) => {
  await serveFixture(page, LAYOUT_DOM)
  await installGlobals(page, TEST_CHAT_ID)
  await assertRealStylesheets(page)
  await page.evaluate(dir => window.setDirLabel(dir), CONFIGURED_DIR)

  const observed = await page.evaluate(() => {
    const button = document.querySelector('#set-dir')
    const parent = button.parentElement
    const path = document.querySelector('#dl-dir-path')
    const box = button.getBoundingClientRect()
    const style = getComputedStyle(parent)
    const contentWidth = parent.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0)
    return {
      width: box.width,
      parentContentWidth: contentWidth,
      path: path && path.textContent,
      pathClient: path && path.clientWidth,
      pathScroll: path && path.scrollWidth,
      clickTargets: document.querySelectorAll('#set-dir').length,
      visiblePaths: [...document.querySelectorAll('#dl-dir-path')].filter(node => getComputedStyle(node).display !== 'none').length,
      legacy: ['#dl-dir', '#dl-dir-current'].filter(selector => document.querySelector(selector))
    }
  })
  expect(observed.width).toBeGreaterThanOrEqual(observed.parentContentWidth - 2)
  expect(observed.path).toBe(CONFIGURED_DIR)
  expect(observed.clickTargets).toBe(1)
  expect(observed.visiblePaths).toBe(1)
  expect(observed.legacy).toEqual([])
})

test('live TEST channel truth agrees with the real authenticated Telegram session', async ({ request }) => {
  test.skip(process.env.FILEGRAM_LIVE !== '1', 'Set FILEGRAM_LIVE=1 with npm start running to exercise the authenticated TEST channel')
  await assertServerRunning(request)
  const response = await wsRequest('media-truth-v1', { chatId: Number(TEST_CHAT_ID) })
  expect(response.ok).toBe(true)
  expect(response.data && response.data.accessible).toBe(true)
  expect(response.data && response.data.complete).toBe(true)
  expect(Array.isArray(response.data && response.data.ids)).toBe(true)
  expect(Number(response.data && response.data.count)).toBe((response.data && response.data.ids || []).length)
})

test('native folder picker identity is verified on Windows only', async ({ request }) => {
  test.skip(process.env.FILEGRAM_PICKER_LIVE !== '1' || process.platform !== 'win32', 'Set FILEGRAM_PICKER_LIVE=1 on Windows with npm start running for the native dialog gate')
  await assertServerRunning(request)
  const response = await request.post(`${SERVER}/api/filegram/pick-download-folder`, { timeout: 120000 })
  const payload = await response.json()
  expect(payload.ok).toBe(true)
  expect(String(payload.implementation || '')).toMatch(/IFileOpenDialog|OpenFileDialog/)
})
