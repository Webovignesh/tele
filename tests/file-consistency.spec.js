// @ts-check
'use strict'

const path = require('node:path')
const { test, expect } = require('@playwright/test')

const HARDENING = path.join(__dirname, '..', 'public', 'uploads-hardening.js')

async function fixture (page, options = {}) {
  const initialItems = options.items || [
    { chatId: 777, messageId: 11, name: 'deleted-a.jpg', type: 'document', fileSize: 10 },
    { chatId: 777, messageId: 12, name: 'deleted-b.jpg', type: 'document', fileSize: 20 }
  ]
  await page.route('http://filegram.test/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: `<!doctype html><html><head></head><body>
      <header class="chat-head">
        <div class="chat-actions"><button id="mg-open-info">Chat info</button></div>
        <span id="chat-media-count"></span>
        <button id="select-all-media">Select all</button>
      </header>
      <section id="messages"></section>
      <section id="media-grid"></section>
      <aside class="downloads">
        <label class="conc">
          <span>Save to</span>
          <span class="row">
            <input id="dl-dir" value="F:\\Old" />
            <button id="set-dir" type="button">Browse</button>
          </span>
        </label>
        <div id="dl-dir-current"></div>
      </aside>
    </body></html>`
  }))
  await page.goto('http://filegram.test/')
  await page.evaluate(({ initialItems, missingOnReconcile }) => {
    const snapshot = {
      chatId: 777,
      items: initialItems.map(item => ({ ...item })),
      found: initialItems.length,
      typeCounts: { document: initialItems.length },
      scanned: initialItems.length,
      done: true,
      savedAt: Date.now()
    }
    window.state = {
      status: 'ready',
      activeChatId: 777,
      view: 'files',
      messages: initialItems.map(item => ({ id: item.messageId, media: { ...item } })),
      mediaCount: initialItems.length,
      typeCounts: { document: initialItems.length }
    }
    window.rescueFileCache = new Map([['777', snapshot]])
    window.__persistedSnapshot = null
    window.__handledEvents = []
    window.__renderFiles = 0
    window.handleEvent = event => window.__handledEvents.push(event)
    window.renderFiles = () => { window.__renderFiles++ }
    window.renderMessagesList = () => {}
    window.rescueSaveActiveChat = () => {}
    window.teleP0v2WriteIndex = async (chatId, next) => {
      window.__persistedSnapshot = JSON.parse(JSON.stringify(next))
    }
    window.teleFilesIndex = {
      snapshot: () => snapshot,
      ensure: async () => snapshot,
      hardRefresh: async () => snapshot,
      count: () => snapshot.items.length,
      total: () => snapshot.items.length
    }
    window.setDirLabel = dir => {
      document.querySelector('#dl-dir').value = dir
      document.querySelector('#dl-dir-current').textContent = dir
    }
    window.request = async (type, payload) => {
      if (type === 'set-download-dir') return { downloadsDir: payload.dir }
      if (type === 'get-messages') return { messages: [], hasMore: false }
      throw new Error(`Unexpected request ${type}`)
    }
    window.toast = () => {}
    window.toastOk = () => {}
    window.FileGramUploads = {
      queue: {
        resolveSource: async () => null,
        jobs: new Map(),
        active: new Map(),
        add: descriptors => descriptors,
        cancelWake: () => {},
        changed: () => {}
      }
    }
    window.fetch = async (url) => {
      const target = String(url)
      if (target.includes('/api/filegram/reconcile-message-ids/')) {
        const missing = missingOnReconcile ? snapshot.items.map(item => String(item.messageId)) : []
        const existing = missingOnReconcile ? [] : snapshot.items.map(item => String(item.messageId))
        return { ok: true, status: 200, json: async () => ({ ok: true, missing, existing, unknown: [] }) }
      }
      if (target.includes('/api/filegram/pick-download-folder')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, cancelled: false, path: 'F:\\Picked\\Folder' }) }
      }
      throw new Error(`Unexpected fetch ${target}`)
    }
  }, { initialItems, missingOnReconcile: options.missingOnReconcile !== false })
  await page.addScriptTag({ path: HARDENING })
}

test('stale deleted files are removed from the committed index and duplicate Chat info is removed', async ({ page }) => {
  await fixture(page)

  await expect(page.locator('#mg-open-info')).toHaveCount(0)
  await expect.poll(async () => page.evaluate(() => window.teleFilesIndex.snapshot(777).items.length), { timeout: 5000 }).toBe(0)
  await expect(page.locator('#chat-media-count')).toHaveText('0 files')
  await expect(page.locator('#select-all-media')).toBeDisabled()
  await expect.poll(async () => page.evaluate(() => window.__persistedSnapshot && window.__persistedSnapshot.items.length)).toBe(0)
})

test('realtime message deletion lowers the persistent Files count instead of unioning the row back', async ({ page }) => {
  await fixture(page, { missingOnReconcile: false })
  await expect.poll(async () => page.evaluate(() => window.teleFilesIndex.snapshot(777).items.length)).toBe(2)

  await page.evaluate(() => {
    window.handleEvent({ name: 'message-delete', chatId: 777, messageIds: [11] })
  })

  await expect.poll(async () => page.evaluate(() => window.teleFilesIndex.snapshot(777).items.map(item => String(item.messageId)))).toEqual(['12'])
  await expect(page.locator('#chat-media-count')).toHaveText('1 file')
  await expect.poll(async () => page.evaluate(() => window.__persistedSnapshot && window.__persistedSnapshot.items.length)).toBe(1)
})

test('download destination is one button and selecting it commits the chosen native folder', async ({ page }) => {
  await fixture(page, { items: [], missingOnReconcile: false })

  const picker = page.locator('#set-dir')
  await expect(picker).toHaveClass(/fg-download-folder-picker/)
  await expect(page.locator('#dl-dir')).toBeHidden()
  await expect(picker).toContainText('F:\\Old')

  await picker.click()

  await expect.poll(async () => page.locator('#dl-dir').inputValue()).toBe('F:\\Picked\\Folder')
  await expect(picker).toContainText('F:\\Picked\\Folder')
  await expect(picker).toHaveAttribute('title', 'F:\\Picked\\Folder')
})
