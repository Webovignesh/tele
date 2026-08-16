// @ts-check
'use strict'

const path = require('node:path')
const { test, expect } = require('@playwright/test')

const CONSISTENCY = path.join(__dirname, '..', 'public', 'file-consistency-v2.js')

async function fixture (page, options = {}) {
  const items = options.items || [
    { chatId: 777, messageId: 11, name: 'deleted-a.jpg', type: 'document', fileSize: 10 },
    { chatId: 777, messageId: 12, name: 'deleted-b.jpg', type: 'document', fileSize: 20 }
  ]
  const liveIds = options.liveIds || []

  await page.route('http://filegram.test/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: `<!doctype html><html><head></head><body>
      <header><span id="chat-media-count"></span><button id="select-all-media">Select all</button></header>
      <section id="media-grid"></section>
      <div id="mg-downloads-pane"><div class="dl-controls">
        <label class="conc"><span>Save to</span><span class="row"><input id="dl-dir" value="F:\\Old"><button id="set-dir">Browse</button></span></label>
        <div id="dl-dir-current"></div>
      </div></div>
    </body></html>`
  }))
  await page.goto('http://filegram.test/')

  await page.evaluate(({ items, liveIds }) => {
    const snap = {
      chatId: 777,
      items: items.map(item => ({ ...item })),
      found: items.length,
      typeCounts: { document: items.length },
      done: true,
      savedAt: Date.now()
    }
    window.state = { activeChatId: 777, view: 'files', mediaCount: items.length, typeCounts: { document: items.length } }
    window.rescueFileCache = new Map([['777', snap]])
    window.__persistedSnapshot = null
    window.teleP0v2WriteIndex = async (_chatId, value) => { window.__persistedSnapshot = JSON.parse(JSON.stringify(value)) }
    window.renderFiles = () => {}
    window.request = async (type, payload) => {
      if (type === 'set-download-dir') return { downloadsDir: payload.dir }
      throw new Error(`Unexpected request ${type}`)
    }
    window.toast = () => {}
    window.toastOk = () => {}
    window.teleFilesIndex = {
      snapshot: () => snap,
      count: () => snap.items.length,
      total: () => snap.items.length
    }
    window.fetch = async url => {
      const target = String(url)
      if (target.includes('/api/filegram/live-media-ids/')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, exact: true, ids: liveIds.map(String) }) }
      }
      if (target.includes('/api/filegram/pick-download-folder')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, path: 'F:\\Picked\\Folder' }) }
      }
      throw new Error(`Unexpected fetch ${target}`)
    }
  }, { items, liveIds })

  await page.addScriptTag({ path: CONSISTENCY })
}

test('small stale Files index is replaced from live Telegram media truth', async ({ page }) => {
  await fixture(page, { liveIds: [] })
  await expect.poll(async () => page.evaluate(() => window.teleFilesIndex.snapshot(777).items.length)).toBe(0)
  await expect(page.locator('#chat-media-count')).toHaveText('0 files')
  await expect(page.locator('#select-all-media')).toBeDisabled()
  await expect.poll(async () => page.evaluate(() => window.__persistedSnapshot && window.__persistedSnapshot.items.length)).toBe(0)
})

test('live Telegram rows are retained and deleted rows are pruned', async ({ page }) => {
  await fixture(page, { liveIds: [12] })
  await expect.poll(async () => page.evaluate(() => window.teleFilesIndex.snapshot(777).items.map(item => item.messageId))).toEqual([12])
  await expect(page.locator('#chat-media-count')).toHaveText('1 file')
})

test('download destination is one full width control and commits selected folder', async ({ page }) => {
  await fixture(page, { items: [], liveIds: [] })
  const button = page.locator('#set-dir')
  await expect(button).toHaveClass(/fg-folder-v2/)
  await expect(page.locator('#dl-dir')).toBeHidden()
  await expect(button).toContainText('F:\\Old')
  const geometry = await button.evaluate(el => ({ width: el.getBoundingClientRect().width, parent: el.parentElement.getBoundingClientRect().width }))
  expect(geometry.width).toBeGreaterThanOrEqual(geometry.parent - 2)
  await button.click()
  await expect.poll(async () => page.locator('#dl-dir').inputValue()).toBe('F:\\Picked\\Folder')
  await expect(button).toContainText('F:\\Picked\\Folder')
})
