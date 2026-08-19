// @ts-check
'use strict'

const path = require('node:path')
const { test, expect } = require('@playwright/test')

const UPLOAD_RELIABILITY = path.join(__dirname, '..', 'public', 'upload-reliability.js')
const MEDIA_PREVIEW = path.join(__dirname, '..', 'public', 'filegram-media-preview.js')

async function uploadQueueFixture (page, statuses = []) {
  await page.setContent('<!doctype html><html><head></head><body></body></html>')
  await page.evaluate(initialStatuses => {
    window.__statusReplies = initialStatuses.slice()
    window.fetch = async () => {
      const next = window.__statusReplies.length
        ? window.__statusReplies.shift()
        : { ok: true, exists: false, status: 'missing' }
      return {
        ok: true,
        status: 200,
        json: async () => next
      }
    }

    const job = {
      id: 'upload-refresh-1',
      name: 'video.mp4',
      size: 200,
      totalBytes: 200,
      uploadedBytes: 200,
      progress: 1,
      speed: 999999999,
      attempts: 1,
      status: 'needs_access',
      error: 'Source file access is required'
    }

    const queue = {
      jobs: new Map([[job.id, job]]),
      progress (target, loaded, total) {
        target.status = 'uploading'
        target.uploadedBytes = loaded
        target.totalBytes = total
        target.progress = total ? loaded / total : 0
        target.speed = 999999999
      },
      cancel (id) {
        const target = this.jobs.get(String(id))
        if (target) target.status = 'cancelled'
      },
      clearAll () { this.jobs.clear() },
      changed (type, payload) {
        window.__queueChanges = window.__queueChanges || []
        window.__queueChanges.push({ type, id: payload && payload.id, status: payload && payload.status })
      },
      pump () { window.__pumpCount = (window.__pumpCount || 0) + 1 },
      verifyDelivery: async () => false
    }
    window.FileGramUploads = { queue }
  }, statuses)
  await page.addScriptTag({ path: UPLOAD_RELIABILITY })
  await expect.poll(() => page.evaluate(() => !!window.__fileGramUploadReliabilityInstalled)).toBe(true)
  await expect.poll(() => page.evaluate(() => !!window.FileGramUploads.queue.__fileGramUploadReliability)).toBe(true)
}

test('loopback staging completion never leaves a fake Telegram speed displayed', async ({ page }) => {
  await uploadQueueFixture(page, [{ ok: true, exists: false, status: 'missing' }])
  const result = await page.evaluate(() => {
    const queue = window.FileGramUploads.queue
    const job = queue.jobs.get('upload-refresh-1')
    job.status = 'uploading'
    job.error = null
    queue.progress(job, 200, 200)
    return { speed: job.speed, progress: job.progress, uploadedBytes: job.uploadedBytes }
  })
  expect(result).toEqual({ speed: 0, progress: 1, uploadedBytes: 200 })
})

test('refresh reconnects an in-flight staged upload to server truth before asking for file access', async ({ page }) => {
  await uploadQueueFixture(page, [
    { ok: true, exists: true, active: true, status: 'sending', messageId: -10, size: 200 },
    { ok: true, exists: true, active: false, status: 'completed', messageId: 555, size: 200, completedAt: Date.now() }
  ])

  await expect.poll(() => page.evaluate(() => window.FileGramUploads.queue.jobs.get('upload-refresh-1').status)).toBe('verifying')
  await expect.poll(() => page.evaluate(() => window.FileGramUploads.queue.jobs.get('upload-refresh-1').status), { timeout: 4000 }).toBe('completed')

  const recovered = await page.evaluate(() => {
    const job = window.FileGramUploads.queue.jobs.get('upload-refresh-1')
    return {
      recovered: job.recovered,
      messageId: job.telegramMessageId,
      speed: job.speed,
      error: job.error
    }
  })
  expect(recovered).toEqual({ recovered: true, messageId: 555, speed: 0, error: null })
})

test('file icon opens an on-demand image preview without selecting the card', async ({ page }) => {
  await page.route('http://filegram.test/**', async route => {
    if (route.request().url().includes('/api/media-preview/')) {
      return route.fulfill({
        status: 200,
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="black"/></svg>'
      })
    }
    return route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><head></head><body><div id="media-grid"><div class="gcard" data-key="777:42"><div class="gthumb"><span class="icon">image</span></div><div class="gname">photo.jpg</div><input type="checkbox" data-key="777:42"></div></div></body></html>'
    })
  })
  await page.goto('http://filegram.test/')
  await page.evaluate(() => {
    window.__selectionClicks = 0
    const item = { chatId: 777, messageId: 42, fileId: 91, name: 'photo.jpg', fileSize: 2048, type: 'photo', mime: 'image/jpeg' }
    const card = document.querySelector('.gcard')
    card._item = item
    card.onclick = () => { window.__selectionClicks++ }
    window.teleFilesIndex = { snapshot: () => ({ items: [item] }) }
    window.state = { activeChatId: 777, messages: [] }
  })
  await page.addScriptTag({ path: MEDIA_PREVIEW })

  await page.locator('.gthumb').click()
  await expect(page.locator('#fg-media-preview-modal')).toBeVisible()
  await expect(page.locator('.fg-preview-stage img')).toBeVisible()
  expect(await page.evaluate(() => window.__selectionClicks)).toBe(0)

  const href = await page.locator('.fg-preview-open').getAttribute('href')
  expect(href).toContain('/api/media-preview/91?')
  expect(href).toContain('chatId=777')
  expect(href).toContain('messageId=42')
  expect(href).toContain('name=photo.jpg')

  await page.keyboard.press('Escape')
  await expect(page.locator('#fg-media-preview-modal')).toBeHidden()
})
