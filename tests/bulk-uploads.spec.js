// @ts-check
'use strict'

const path = require('node:path')
const { test, expect } = require('@playwright/test')

const CORE = path.join(__dirname, '..', 'public', 'upload-queue-core.js')
const BULK_UPLOADS = path.join(__dirname, '..', 'public', 'bulk-uploads.js')
const HARDENING = path.join(__dirname, '..', 'public', 'uploads-hardening.js')
const CSS = path.join(__dirname, '..', 'public', 'uploads.css')

async function fixture (page, options = {}) {
  await page.route('http://filegram.test/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: `<!doctype html><html><head></head><body>
      <aside class="downloads">
        <div class="mg-drawer-tabs">
          <button id="mg-tab-downloads" class="mg-drawer-tab active">Downloads</button>
          <button id="mg-tab-info" class="mg-drawer-tab">Chat Info</button>
        </div>
        <div id="mg-downloads-pane" class="mg-drawer-pane">downloads</div>
        <div id="mg-info-pane" class="mg-drawer-pane hidden">info</div>
      </aside>
      <ul id="chat-list"></ul>
    </body></html>`
  }))
  await page.goto('http://filegram.test/')
  await page.addStyleTag({ path: CSS })
  await page.evaluate(({ failFirst = false, slow = false, remoteItems = [] } = {}) => {
    window.state = {
      status: 'ready',
      activeChatId: 777,
      chats: [
        { id: 777, title: 'TEST', kind: 'channel', unread: 0 },
        { id: 888, title: 'NOT OWNED', kind: 'channel', unread: 0 }
      ]
    }
    window.toast = (message, kind) => { window.__lastToast = { message, kind } }
    window.confirm = () => true
    window.teleFilesIndex = {
      ensure: async () => ({ items: remoteItems, done: true }),
      snapshot: () => ({ items: remoteItems, done: true })
    }
    window.request = async (type, payload) => {
      if (type === 'get-chat-management') {
        const owner = Number(payload.chatId) === 777
        return {
          chat: { id: payload.chatId, title: owner ? 'TEST' : 'NOT OWNED', kind: 'channel' },
          permissions: { isOwner: owner }
        }
      }
      if (type === 'search-media') return { items: [], totalCount: 0, hasMore: false }
      if (type === 'delete-chat-message') return { ok: true }
      throw new Error(`Unexpected request ${type}`)
    }
    try { delete window.showOpenFilePicker } catch { window.showOpenFilePicker = undefined }
    try { delete window.showDirectoryPicker } catch { window.showDirectoryPicker = undefined }
    window.__uploadAttempts = {}
    window.__FILEGRAM_UPLOAD_VERIFY__ = async () => false
    window.__FILEGRAM_UPLOAD_TRANSPORT__ = (job, file, context) => new Promise((resolve, reject) => {
      const attempts = (window.__uploadAttempts[job.id] || 0) + 1
      window.__uploadAttempts[job.id] = attempts
      if (failFirst && attempts === 1) {
        const error = new Error('server restart')
        error.transient = true
        error.uncertain = true
        reject(error)
        return
      }
      let sent = 0
      const chunk = Math.max(1, Math.ceil(file.size / 4))
      const tick = () => {
        if (context.signal.aborted) {
          reject(Object.assign(new Error('aborted'), { code: 'ABORTED' }))
          return
        }
        sent = Math.min(file.size, sent + chunk)
        context.onProgress(sent, file.size)
        if (sent >= file.size) {
          resolve({ ok: true, message: { id: `${job.id}-message` } })
          return
        }
        setTimeout(tick, slow ? 200 : 5)
      }
      setTimeout(tick, slow ? 200 : 5)
    })
  }, options)
  await page.addScriptTag({ path: CORE })
  await page.addScriptTag({ path: BULK_UPLOADS })
  await page.addScriptTag({ path: HARDENING })
  await expect(page.locator('#mg-tab-uploads')).toBeVisible()
  await page.locator('#mg-tab-uploads').click()
  await expect(page.locator('#mg-uploads-pane')).toBeVisible()
  await expect(page.locator('#fg-upload-channel option', { hasText: /^TEST$/ })).toHaveCount(1)
  await expect(page.locator('#fg-upload-channel option', { hasText: /^NOT OWNED$/ })).toHaveCount(0)
  await page.locator('#fg-upload-channel').selectOption({ label: 'TEST' })
}

async function setConcurrency (page, value) {
  await page.locator('#fg-upload-concurrency').evaluate((el, next) => {
    el.value = String(next)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, value)
}

async function addFiles (page, files) {
  const chooserPromise = page.waitForEvent('filechooser')
  await page.locator('#fg-upload-add-files').click()
  const chooser = await chooserPromise
  await chooser.setFiles(files)
  await expect(page.locator('#fg-upload-review-modal')).toBeVisible()
}

async function persistedUploadCount (page) {
  return page.evaluate(async () => new Promise((resolve, reject) => {
    const request = indexedDB.open('filegram-uploads-v1', 1)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const count = db.transaction('jobs', 'readonly').objectStore('jobs').count()
      count.onerror = () => reject(count.error)
      count.onsuccess = () => { resolve(count.result); db.close() }
    }
  }))
}

test('owned TEST channel is selectable and duplicate review explains evidence', async ({ page }) => {
  await fixture(page, {
    remoteItems: [{ name: 'remote.txt', fileSize: 6, chatId: 777, messageId: 1, type: 'document' }]
  })
  await addFiles(page, [
    { name: 'alpha.txt', mimeType: 'text/plain', buffer: Buffer.from('alpha') },
    { name: 'alpha.txt', mimeType: 'text/plain', buffer: Buffer.from('alpha') },
    { name: 'remote.txt', mimeType: 'text/plain', buffer: Buffer.from('remote') },
    { name: 'beta.txt', mimeType: 'text/plain', buffer: Buffer.from('beta') }
  ])
  await expect(page.locator('#fg-upload-review-destination')).toHaveText('TEST')
  await expect(page.locator('#fg-upload-review-duplicates')).toContainText('same file already selected')
  await expect(page.locator('#fg-upload-review-duplicates')).toContainText('channel index')
  await expect(page.locator('#fg-upload-review-unique')).toContainText('Queue unique (2)')
  await page.locator('#fg-upload-review-unique').click()
  await expect.poll(async () => page.evaluate(() => window.FileGramUploads.snapshot().stats.completed)).toBe(2)
})

test('Pause all and Resume all apply to every queued file', async ({ page }) => {
  await fixture(page, { slow: true })
  await setConcurrency(page, 2)
  await addFiles(page, Array.from({ length: 12 }, (_, index) => ({
    name: `pause-${index}.txt`, mimeType: 'text/plain', buffer: Buffer.from(`payload-${index}`)
  })))
  await page.locator('#fg-upload-review-unique').click()
  await expect.poll(async () => page.evaluate(() => window.FileGramUploads.snapshot().stats.uploading)).toBe(2)
  await page.locator('#fg-upload-pause-all').click()
  await expect.poll(async () => page.evaluate(() => window.FileGramUploads.snapshot().stats.paused)).toBe(12)
  expect(await page.evaluate(() => window.FileGramUploads.snapshot().stats.uploading)).toBe(0)
  await page.locator('#fg-upload-resume-all').click()
  await expect.poll(async () => page.evaluate(() => window.FileGramUploads.snapshot().stats.completed), { timeout: 15000 }).toBe(12)
})

test('Cancel all cancels the whole queue, not just parallel workers', async ({ page }) => {
  await fixture(page, { slow: true })
  await setConcurrency(page, 3)
  await addFiles(page, Array.from({ length: 30 }, (_, index) => ({
    name: `cancel-${index}.txt`, mimeType: 'text/plain', buffer: Buffer.from(String(index))
  })))
  await page.locator('#fg-upload-review-unique').click()
  await expect.poll(async () => page.evaluate(() => window.FileGramUploads.snapshot().stats.uploading)).toBe(3)
  await page.locator('#fg-upload-cancel-all').click()
  await expect.poll(async () => page.evaluate(() => window.FileGramUploads.snapshot().stats.remaining)).toBe(0)
  const stats = await page.evaluate(() => window.FileGramUploads.snapshot().stats)
  expect(stats.cancelled).toBe(30)
  expect(stats.total).toBe(30)
})

test('Clear done and Clear all keep full-queue and persistent semantics', async ({ page }) => {
  await fixture(page)
  await addFiles(page, [
    { name: 'done-1.txt', mimeType: 'text/plain', buffer: Buffer.from('1') },
    { name: 'done-2.txt', mimeType: 'text/plain', buffer: Buffer.from('2') }
  ])
  await page.locator('#fg-upload-review-unique').click()
  await expect.poll(async () => page.evaluate(() => window.FileGramUploads.snapshot().stats.completed)).toBe(2)
  await page.locator('#fg-upload-clear-done').click()
  await expect.poll(async () => page.evaluate(() => window.FileGramUploads.snapshot().stats.total)).toBe(0)

  await addFiles(page, Array.from({ length: 40 }, (_, index) => ({
    name: `clear-${index}.txt`, mimeType: 'text/plain', buffer: Buffer.from(String(index))
  })))
  await page.locator('#fg-upload-review-unique').click()
  await expect.poll(async () => page.evaluate(() => window.FileGramUploads.snapshot().stats.total)).toBe(40)
  await page.locator('#fg-upload-clear-all').click()
  await expect.poll(async () => page.evaluate(() => window.FileGramUploads.snapshot().stats.total)).toBe(0)
  await expect(page.locator('#fg-upload-list .fg-up-job')).toHaveCount(0)
  await page.waitForTimeout(500)
  expect(await persistedUploadCount(page)).toBe(0)
})

test('server interruption auto-retries without losing the file', async ({ page }) => {
  await fixture(page, { failFirst: true })
  await addFiles(page, [{ name: 'restart-safe.txt', mimeType: 'text/plain', buffer: Buffer.from('restart-safe') }])
  await page.locator('#fg-upload-review-unique').click()
  await expect.poll(async () => page.evaluate(() => {
    const snapshot = window.FileGramUploads.snapshot()
    const job = snapshot.jobs.find(item => item.name === 'restart-safe.txt')
    return { status: job && job.status, attempts: job ? (window.__uploadAttempts[job.id] || 0) : 0 }
  }), { timeout: 12000 }).toMatchObject({ status: 'completed', attempts: 2 })
})

test('large queues render exactly 100 jobs per page', async ({ page }) => {
  await fixture(page, { slow: true })
  await setConcurrency(page, 1)
  await addFiles(page, Array.from({ length: 240 }, (_, index) => ({
    name: `paged-${String(index).padStart(3, '0')}.txt`, mimeType: 'text/plain', buffer: Buffer.from(String(index))
  })))
  await page.locator('#fg-upload-review-unique').click()
  await expect.poll(async () => page.evaluate(() => window.FileGramUploads.snapshot().stats.total)).toBe(240)
  await expect(page.locator('#fg-upload-list .fg-up-job')).toHaveCount(100)
  await expect(page.locator('#fg-upload-page-label')).toHaveText('Page 1 of 3')
  await page.locator('#fg-upload-next').click()
  await expect(page.locator('#fg-upload-list .fg-up-job')).toHaveCount(100)
  await expect(page.locator('#fg-upload-page-label')).toHaveText('Page 2 of 3')
})

test('live TEST channel uploads three files and removes the evidence messages', async ({ page }) => {
  test.skip(process.env.FILEGRAM_UPLOAD_LIVE !== '1', 'Set FILEGRAM_UPLOAD_LIVE=1 to exercise the real logged-in TEST channel')
  const app = process.env.FILEGRAM_APP || 'http://127.0.0.1:3000'
  await page.goto(app, { waitUntil: 'networkidle', timeout: 30000 })
  await page.waitForFunction(() => !!document.querySelector('#main-screen:not(.hidden)'), { timeout: 15000 })
  await expect(page.locator('#mg-tab-uploads')).toBeVisible()
  await page.locator('#mg-tab-uploads').click()
  await expect(page.locator('#fg-upload-channel option', { hasText: /^TEST$/ })).toHaveCount(1)
  await page.locator('#fg-upload-channel').selectOption({ label: 'TEST' })

  const stamp = Date.now()
  const names = [1, 2, 3].map(index => `filegram-e2e-${stamp}-${index}.txt`)
  await addFiles(page, names.map((name, index) => ({
    name,
    mimeType: 'text/plain',
    buffer: Buffer.from(`FileGram live upload ${index}`)
  })))
  await page.locator('#fg-upload-review-unique').click()

  await expect.poll(async () => page.evaluate(expected => {
    const jobs = window.FileGramUploads.snapshot().jobs.filter(job => expected.includes(job.name))
    return jobs.length === expected.length && jobs.every(job => job.status === 'completed')
  }, names), { timeout: 180000 }).toBe(true)

  const uploaded = await page.evaluate(expected => window.FileGramUploads.snapshot().jobs
    .filter(job => expected.includes(job.name))
    .map(job => ({ chatId: job.chatId, messageId: job.telegramMessageId, name: job.name })), names)
  expect(uploaded.every(item => item.messageId)).toBeTruthy()

  await page.evaluate(async items => {
    for (const item of items) {
      await window.request('delete-chat-message', { chatId: item.chatId, messageId: item.messageId, revoke: true }).catch(() => {})
    }
  }, uploaded)
})
