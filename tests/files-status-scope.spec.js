// @ts-check
'use strict'

const { test, expect } = require('@playwright/test')
const {
  HIGH_WATER_KEY,
  LAYERS,
  LOGIC_DOM,
  serveFixture,
  installGlobals,
  loadLayers
} = require('./fixture-support')

const ACTIVE_CHAT = '-1004474599001'
const BACKGROUND_CHAT = '-1004474599002'

async function seedRepairGap (page, chatId) {
  await page.evaluate(async ({ chatId, key }) => {
    const items = window.__itemsRange(chatId, 0, 5)
    const savedAt = Date.now() - 60000
    await window.__seedRecord(chatId, { ...window.__snapshotFrom(chatId, items, true), savedAt })
    const floors = JSON.parse(localStorage.getItem(key) || '{}')
    floors[String(chatId)] = { count: 6, at: Date.now() }
    localStorage.setItem(key, JSON.stringify(floors))
    window.__loadStates = []
    const node = document.querySelector('#load-state')
    if (node) node.textContent = ''
  }, { chatId, key: HIGH_WATER_KEY })
}

test('background Files repair cannot overwrite the footer of the active chat', async ({ page }) => {
  await serveFixture(page, LOGIC_DOM)
  await installGlobals(page, ACTIVE_CHAT)
  await seedRepairGap(page, BACKGROUND_CHAT)
  await loadLayers(page, [LAYERS.owner])

  await page.evaluate(chatId => window.teleFilesIndex.ensure(chatId), BACKGROUND_CHAT)
  await page.waitForTimeout(150)

  const state = await page.evaluate(() => ({
    activeChatId: String(window.state.activeChatId),
    loadStates: window.__loadStates.slice(),
    footer: (document.querySelector('#load-state') || {}).textContent || ''
  }))
  expect(state.activeChatId).toBe(ACTIVE_CHAT)
  expect(state.loadStates.some(text => /Repairing index/i.test(text))).toBe(false)
  expect(state.loadStates.some(text => /Could not verify against Telegram|truth was inconsistent|metadata is incomplete/i.test(text))).toBe(false)
  expect(state.footer).not.toMatch(/Repairing index|Could not verify against Telegram|truth was inconsistent|metadata is incomplete/i)
})

test('Files repair status is still visible when the repairing chat is active', async ({ page }) => {
  await serveFixture(page, LOGIC_DOM)
  await installGlobals(page, BACKGROUND_CHAT)
  await seedRepairGap(page, BACKGROUND_CHAT)
  await loadLayers(page, [LAYERS.owner])

  await page.evaluate(chatId => window.teleFilesIndex.ensure(chatId), BACKGROUND_CHAT)
  await expect.poll(() => page.evaluate(() => window.__loadStates.some(text => /Repairing index \(5 of 6 known files\)/i.test(text)))).toBe(true)
})
