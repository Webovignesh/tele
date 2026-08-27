// @ts-check
'use strict'

const path = require('node:path')
const { test, expect } = require('@playwright/test')

const FILEGRAM_UI = path.join(__dirname, '..', 'public', 'filegram-ui.css')
const FINAL_UI = path.join(__dirname, '..', 'public', 'daily-driver-final-ui-fix.css')
const RELIABILITY = path.join(__dirname, '..', 'public', 'download-reliability.css')
const RELIABILITY_JS = path.join(__dirname, '..', 'public', 'download-reliability.js')

test('large download window keeps every mounted card separate and full height', async ({ page }) => {
  await page.setContent(`<!doctype html><html><head></head><body>
    <div class="downloads" style="width:370px;height:600px;display:flex;flex-direction:column">
      <div id="download-list" style="height:420px;flex:0 0 420px"></div>
    </div>
  </body></html>`)
  await page.addStyleTag({ path: FILEGRAM_UI })
  await page.addStyleTag({ path: FINAL_UI })
  await page.addStyleTag({ path: RELIABILITY })

  await page.evaluate(() => {
    const list = document.querySelector('#download-list')
    for (let index = 0; index < 140; index++) {
      const row = document.createElement('div')
      row.className = `djob ${index % 7 === 0 ? 'error' : 'downloading'}`
      row.dataset.jobId = `job-${index}`
      row.innerHTML = `<div class="name">video_${index}.mp4</div>
        <div class="sub"><span class="status-tag">${index % 7 === 0 ? 'ERROR' : 'DOWNLOADING'}</span><span>12 MB / 50 MB</span></div>
        <div class="bar"><div style="width:${index % 100}%"></div></div>
        <div class="eta"></div>
        <div class="error-text">${index % 7 === 0 ? 'Telegram file reference expired' : ''}</div>
        <div class="actions"><button>Pause</button><button>Cancel</button></div>`
      list.appendChild(row)
    }
  })

  const geometry = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#download-list .djob')]
    const rects = rows.map(row => row.getBoundingClientRect())
    return {
      count: rows.length,
      minHeight: Math.min(...rects.map(rect => rect.height)),
      overlaps: rects.slice(1).filter((rect, index) => rect.top < rects[index].bottom - 0.5).length,
      contentVisibility: getComputedStyle(rows[0]).contentVisibility,
      contain: getComputedStyle(rows[0]).contain,
      scrollHeight: document.querySelector('#download-list').scrollHeight
    }
  })

  expect(geometry.count).toBe(140)
  expect(geometry.minHeight).toBeGreaterThanOrEqual(58)
  expect(geometry.overlaps).toBe(0)
  expect(geometry.contentVisibility).toBe('visible')
  expect(geometry.contain).toBe('none')
  expect(geometry.scrollHeight).toBeGreaterThan(8000)
})

test('download queue scroll position survives progress and error repaint geometry', async ({ page }) => {
  await page.setContent(`<!doctype html><html><head></head><body>
    <div class="downloads" style="width:370px;height:600px;display:flex;flex-direction:column">
      <div id="download-list" style="height:420px;flex:0 0 420px"></div>
    </div>
  </body></html>`)
  await page.addStyleTag({ path: FILEGRAM_UI })
  await page.addStyleTag({ path: FINAL_UI })
  await page.addStyleTag({ path: RELIABILITY })

  await page.evaluate(() => {
    const list = document.querySelector('#download-list')
    for (let index = 0; index < 140; index++) {
      const row = document.createElement('div')
      row.className = 'djob downloading'
      row.dataset.jobId = `job-${index}`
      row.innerHTML = `<div class="name">video_${index}.mp4</div><div class="sub"><span class="status-tag">DOWNLOADING</span><span>0 B / 50 MB</span></div><div class="bar"><div style="width:0%"></div></div><div class="eta"></div><div class="error-text"></div><div class="actions"><button>Pause</button></div>`
      list.appendChild(row)
    }
    list.scrollTop = 3100
  })

  const before = await page.locator('#download-list').evaluate(list => list.scrollTop)
  await page.evaluate(() => {
    for (let index = 0; index < 140; index++) {
      const row = document.querySelector(`[data-job-id="job-${index}"]`)
      row.querySelector('.bar > div').style.width = `${(index * 13) % 100}%`
      if (index % 9 === 0) {
        row.className = 'djob error'
        row.querySelector('.status-tag').textContent = 'ERROR'
        row.querySelector('.error-text').textContent = 'A long terminal error that must take normal layout space instead of painting over the next card.'
      }
    }
  })
  await page.waitForTimeout(100)
  const after = await page.locator('#download-list').evaluate(list => list.scrollTop)
  expect(Math.abs(after - before)).toBeLessThanOrEqual(2)
})

test('terminal queue failures are made explicit instead of looking silently stopped', async ({ page }) => {
  await page.setContent('<div id="tele-ui-download-summary"></div><div id="download-list"></div>')
  await page.evaluate(() => {
    window.state = {
      queueStats: { total: 2329, remaining: 0, done: 0, error: 2329, cancelled: 0 },
      downloads: new Map()
    }
    window.handleEvent = event => {
      if (event && event.name === 'download-stats') window.state.queueStats = event.stats
    }
  })
  await page.addScriptTag({ path: RELIABILITY_JS })
  await expect(page.locator('#fg-download-health')).toBeVisible()
  await expect(page.locator('#fg-download-health')).toContainText('2,329 downloads failed')

  await page.evaluate(() => window.handleEvent({ name: 'download-stats', stats: { total: 2329, remaining: 1200, done: 1129, error: 0 } }))
  await expect(page.locator('#fg-download-health')).toBeHidden()
})

test('a stale local completed marker cannot veto a file the disk preflight approved', async ({ page }) => {
  await page.setContent('<div id="download-list"></div>')
  await page.evaluate(() => {
    window.state = { activeChatId: 777, queueStats: null, downloads: new Map() }
    window.handleEvent = () => {}
    // Simulate a historical localStorage completion marker that survived after the
    // actual file was deleted/moved from the configured download path.
    window.isCompleted = () => true
    window.__queued = []

    // Model the two existing filters: daily-driver-p1 checks item.chatId, then after
    // an async disk scan app.js checks state.activeChatId again. The reliability
    // boundary must suppress BOTH checks for this active invocation only.
    window.startDownloads = async items => {
      const p1Todo = items.filter(item => !window.isCompleted(`${item.chatId}:${item.messageId}`))
      await Promise.resolve()
      const baseTodo = p1Todo.filter(item => !window.isCompleted(`${window.state.activeChatId}:${item.messageId}`))
      window.__queued.push(...baseTodo.map(item => item.messageId))
    }
  })
  await page.addScriptTag({ path: RELIABILITY_JS })
  await expect.poll(() => page.evaluate(() => window.FileGramDownloadReliability.diskTruthInstalled())).toBe(true)

  await page.evaluate(() => window.startDownloads([{ chatId: 777, messageId: 42, fileId: 1, name: 'video.mp4' }]))
  expect(await page.evaluate(() => window.__queued)).toEqual([42])
  // Outside the download invocation the completion marker keeps its UI semantics.
  expect(await page.evaluate(() => window.isCompleted('777:42'))).toBe(true)
})

test('only long download preparation requests extend the generic 120 second timeout', async ({ page }) => {
  await page.setContent('<div id="download-list"></div>')
  await page.evaluate(() => {
    window.state = { activeChatId: 777, queueStats: null, downloads: new Map() }
    window.handleEvent = () => {}
    window.isCompleted = () => false
    window.startDownloads = async () => {}
    window.__scheduledDelays = []
    const nativeSetTimeout = window.setTimeout.bind(window)
    window.setTimeout = (callback, delay, ...args) => {
      window.__scheduledDelays.push(Number(delay))
      return nativeSetTimeout(callback, 0, ...args)
    }
    window.request = () => new Promise(resolve => setTimeout(resolve, 120000))
  })

  await page.addScriptTag({ path: RELIABILITY_JS })
  await expect.poll(() => page.evaluate(() => window.FileGramDownloadReliability.longRequestInstalled())).toBe(true)
  expect(await page.evaluate(() => window.FileGramDownloadReliability.longRequestTimeoutMs)).toBe(30 * 60 * 1000)

  await page.evaluate(async () => {
    window.__scheduledDelays.length = 0
    await window.request('start-download', {})
  })
  expect(await page.evaluate(() => window.__scheduledDelays.includes(30 * 60 * 1000))).toBe(true)

  await page.evaluate(async () => {
    window.__scheduledDelays.length = 0
    await window.request('get-status', {})
  })
  expect(await page.evaluate(() => window.__scheduledDelays.includes(120000))).toBe(true)
  expect(await page.evaluate(() => window.__scheduledDelays.includes(30 * 60 * 1000))).toBe(false)
})
