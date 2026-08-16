// @ts-check
'use strict'

const path = require('node:path')
const { test, expect } = require('@playwright/test')

const CORE = path.join(__dirname, '..', 'public', 'upload-queue-core.js')
const UPLOADS = path.join(__dirname, '..', 'public', 'uploads.js')
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
    </body></html>`
  }))
  await page.goto('http://filegram.test/')
  await page.addStyleTag({ path: CSS })
  await page.evaluate(({ failFirst = false, slow = false } = {}) => {
    window.state = {
      status: 'ready',
      activeChatId: 777,
      chats: [{ id: 777, title: 'TEST', kind: 'channel', unread: 0 }]
    }
    window.toast = (message, kind) => { window.__lastToast = { message, kind } }
    window.confirm = () => true
    window.teleFilesIndex = {
      ensure: async () => ({ items: [], done: true }),
      snapshot: () => ({ items: [], done: true })
    }
    window.request = async (type, payload) => {
      if (type === 'get-chat-management') {
        return { chat: { id: payload.chatId, title: 'TEST', kind: 'channel' }, permissions: { isOwner: true } }
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
        setTimeout(tick, slow ? 250 : 5)
      }
      setTimeout(tick, slow ? 250 : 5)
    })
  }, options)
  await page.addScriptTag({ path: CORE })
  await page.addScriptTag({ path: UPLOADS })
  await expect(page.locator('#mg-tab-uploads')).toBeVisible()
  await page.locator('#mg-tab-uploads').click()
  await expect(page.locator('#mg-uploads-pane')).toBeVisible()
  await expect(page.locator('#fg-upload-channel option', { hasText: 'TEST' })).toHaveCount(1)
  await page.locator('#fg-upload-channel').selectOption({ label: 'TEST' })
}

async function setConcurrency (page, value) {
  await page.locator('#fg-upload-concurrency').evaluate((el, next) => {
    el.value = String(next)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, value)
}

async function addFilesThroughPicker (page, files) {
  const chooserPromise = page.waitForEvent('filechooser')
  await page.locator('#fg-upload-add-files').click()
  const chooser = await chooserPromise
  await chooser.setFiles(files)
  await expect(page.locator('#fg-upload-review-modal')).toBeVisible()
}

test('Uploads tab reviews duplicates then uploads unique files', async ({ page }) => {
  await fixture(page)
  await addFilesThroughPicker(page, [
    { name: 'alpha.txt', mimeType: 'text/plain', buffer: Buffer.from('alpha') },
    { name: 'alpha.txt', mimeType: 'text/plain', buffer: Buffer.from('alpha') },
    { name: 'beta.txt', mimeType: 'text/plain', buffer: Buffer.from('beta') }
  ])

  await expect(page.locator('#fg-upload-review-destination')).toHaveText('TEST')
  await expect(page.locator('#fg-upload-review-unique')).toContainText('Queue unique (2)')
  await expect(page.locator('#fg-upload-review-duplicates')).toContainText('same file already selected')
  await page.locator('#fg-upload-review-unique').click()

  await expect.poll(async () => page.evaluate(() => window.FileGramUploads.snapshot().stats.completed)).toBe(2)
  const snapshot = await page.evaluate(() => window.FileGramUploads.snapshot())
  expect(snapshot.stats.total).toBe(2)
  expect(snapshot.stats.remaining).toBe(0)
  expect(snapshot.jobs.every(job => job.chatTitle === 'TEST')).toBeTruthy()
})

test('Pause all and Resume all apply to the whole queue', async ({ page }) => {
  await fixture(page, { slow: true })
  await setConcurrency(page, 2)
  const files = Array.from({ length: 8 }, (_, index) => ({
    name: `pause-${index}.txt`,
    mimeType: 'text/plain',
    buffer: Buffer.from(`payload-${index}`)
  }))
  await addFilesThroughPicker(page, files)
  await page.locator('#fg-upload-review-unique').click()
  await expect.poll(async () => page.evaluate(() => window.FileGramUploads.snapshot().stats.uploading)).toBe(2)
  await page.locator('#fg-upload-pause-all').click()
  await expect.poll(async () => page.evaluate(() => window.FileGramUploads.snapshot().stats.paused)).toBe(8)
  expect(await page.evaluate(() => window.FileGramUploads.snapshot().stats.uploading)).toBe(0)
  await page.locator('#fg-upload-resume-all').click()
  await expect.poll(async () => page.evaluate(() => window.FileGramUploads.snapshot().stats.completed), { timeout: 10000 }).toBe(8)
})

test('Cancel all covers the entire queue, not only parallel workers', async ({ page }) => {
  await fixture(page, { slow: true })
  await setConcurrency(page, 2)
  const files = Array.from({ length: 20 }, (_, index) => ({
    name: `bulk-${index}.txt`,
    mimeType: 'text/plain',
    buffer: Buffer.from(`payload-${index}`)
  }))
  await addFilesThroughPicker(page, files)
  await page.locator('#fg-upload-review-unique').click()
  await expect.poll(async () => page.evaluate(() => window.FileGramUploads.snapshot().stats.uploading)).toBe(2)
  await page.locator('#fg-upload-cancel-all').click()
  await expect.poll(async () => page.evaluate(() => window.FileGramUploads.snapshot().stats.remaining)).toBe(0)
  const stats = await page.evaluate(() => window.FileGramUploads.snapshot().stats)
  expect(stats.cancelled).toBe(20)
  expect(stats.total).toBe(20)
})

test('Clear done and Clear all have full-queue semantics', async ({ page }) => {
  await fixture(page)
  await addFilesThroughPicker(page, [
    { name: 'done-1.txt', mimeType: 'text/plain', buffer: Buffer.from('1') },
    { name: 'done-2.txt', mimeType: 'text/plain', buffer: Buffer.from('2') }
  ])
  await page.locator('#fg-upload-review-unique').click()
  await expect.poll(async () => page.evaluate(() => window.FileGramUploads.snapshot().stats.completed)).toBe(2)
  await page.locator('#fg-upload-clear-done').click()
  await expect.poll(async () => page.evaluate(() => window.FileGramUploads.snapshot().stats.total)).toBe(0)

  await addFilesThroughPicker(page, Array.from({ length: 6 }, (_, index) => ({
    name: `clear-${index}.txt`, mimeType: 'text/plain', buffer: Buffer.from(String(index))
  })))
  await page.locator('#fg-upload-review-unique').click()
  await expect.poll(async () => page.evaluate(() => window.FileGramUploads.snapshot().stats.total)).toBe(6)
  await page.locator('#fg-upload-clear-all').click()
  await expect.poll(async () => page.evaluate(() => window.FileGramUploads.snapshot().stats.total)).toBe(0)
  expect(await page.locator('#fg-upload-list .fg-up-job').count()).toBe(0)
})

test('server interruption automatically retries without losing the queue', async ({ page }) => {
  await fixture(page, { failFirst: true })
  await addFilesThroughPicker(page, [
    { name: 'restart-safe.txt', mimeType: 'text/plain', buffer: Buffer.from('restart-safe') }
  ])
  await page.locator('#fg-upload-review-unique').click()
  await expect.poll(async () => page.evaluate(() => window.FileGramUploads.snapshot().stats.completed), { timeout: 10000 }).toBe(1)
  const result = await page.evaluate(() => {
    const snapshot = window.FileGramUploads.snapshot()
    const job = snapshot.jobs.find(item => item.name === 'restart-safe.txt')
    return { attempts: window.__uploadAttempts[job.id], status: job.status }
  })
  expect(result.status).toBe('completed')
  expect(result.attempts).toBe(2)
})

test('large queue remains paged at 100 rows', async ({ page }) => {
  await fixture(page, { slow: true })
  const files = Array.from({ length: 240 }, (_, index) => ({
    name: `paged-${String(index).padStart(3, '0')}.txt`,
    mimeType: 'text/plain',
    buffer: Buffer.from(String(index))
  }))
  await addFilesThroughPicker(page, files)
  await page.locator('#fg-upload-review-unique').click()
  await expect.poll(async () => page.evaluate(() => window.FileGramUploads.snapshot().stats.total)).toBe(240)
  await expect(page.locator('#fg-upload-list .fg-up-job')).toHaveCount(100)
  await expect(page.locator('#fg-upload-page-label')).toHaveText('Page 1 of 3')
  await page.locator('#fg-upload-next').click()
  await expect(page.locator('#fg-upload-list .fg-up-job')).toHaveCount(100)
  await expect(page.locator('#fg-upload-page-label')).toHaveText('Page 2 of 3')
})

test('live TEST channel smoke uploads and cleans up', async ({ page }) => {
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
  await addFilesThroughPicker(page, names.map((name, index) => ({
    name,
    mimeType: 'text/plain',
    buffer: Buffer.from(`FileGram live upload ${index}`)
  })))
  await page.locator('#fg-upload-review-unique').click()

  await expect.poll(async () => page.evaluate(expected => {
    const jobs = window.FileGramUploads.snapshot().jobs.filter(job => expected.includes(job.name))
    return jobs.length === expected.length && jobs.every(job => job.status === 'completed')
  }, names), { timeout: 120000 }).toBe(true)

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
