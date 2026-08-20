// @ts-check
'use strict'

const path = require('node:path')
const { test, expect } = require('@playwright/test')

const STYLE = path.join(__dirname, '..', 'public', 'style.css')
const UI_STABILITY = path.join(__dirname, '..', 'public', 'filegram-ui-stability.js')

test('consecutive toasts update without dropping the visible state', async ({ page }) => {
  await page.setContent('<!doctype html><html><head></head><body><div id="toast"></div></body></html>')
  await page.addStyleTag({ path: STYLE })
  await page.addScriptTag({ path: UI_STABILITY })

  await page.evaluate(() => window.toast('First notification', 'ok'))
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#toast')).opacity === '1')

  const result = await page.evaluate(() => {
    const toast = document.querySelector('#toast')
    window.toast('Second notification', 'error')
    return {
      text: toast.textContent,
      show: toast.classList.contains('show'),
      error: toast.classList.contains('error'),
      opacity: getComputedStyle(toast).opacity
    }
  })

  expect(result).toEqual({
    text: 'Second notification',
    show: true,
    error: true,
    opacity: '1'
  })
})

test('legacy upload redraws stay visually hidden behind stable Telegram progress', async ({ page }) => {
  await page.setContent(`<!doctype html><html><head></head><body>
    <div id="mg-uploads-pane">
      <div class="fg-up-stat"><span>Speed</span><strong id="fg-upload-speed">0 B/s</strong></div>
      <div id="fg-upload-list">
        <div class="fg-up-job is-uploading" data-job-id="job-1">
          <div class="fg-up-progress"><span style="width:100%"></span></div>
          <div class="fg-up-job-status">Sending to Telegram…</div>
        </div>
      </div>
    </div>
  </body></html>`)

  await page.evaluate(() => {
    const job = {
      id: 'job-1',
      status: 'uploading',
      size: 200,
      totalBytes: 200,
      progress: 0.42,
      _transferPhase: 'telegram',
      _telegramProgressAvailable: true,
      _telegramProgress: 0.42,
      _telegramUploadedBytes: 84,
      _telegramTotalBytes: 200
    }
    window.FileGramUploads = { queue: { jobs: new Map([[job.id, job]]) } }
  })

  await page.addScriptTag({ path: UI_STABILITY })
  await expect(page.locator('#fg-upload-live-status')).toHaveText('Uploading 42%')

  const initial = await page.evaluate(() => {
    const legacy = document.querySelector('#fg-upload-speed')
    const status = document.querySelector('.fg-up-job-status')
    const bar = document.querySelector('.fg-up-progress > span')
    return {
      legacyHidden: legacy.hidden,
      label: legacy.closest('.fg-up-stat').querySelector('span').textContent,
      live: document.querySelector('#fg-upload-live-status').textContent,
      rowData: status.dataset.fgLiveStatus,
      rowFontSize: getComputedStyle(status).fontSize,
      rowAfter: getComputedStyle(status, '::after').content,
      bar: bar.style.width
    }
  })

  expect(initial.legacyHidden).toBe(true)
  expect(initial.label).toBe('Status')
  expect(initial.live).toBe('Uploading 42%')
  expect(initial.rowData).toBe('Uploading 42%')
  expect(initial.rowFontSize).toBe('0px')
  expect(initial.rowAfter).toContain('Uploading 42%')
  expect(initial.bar).toBe('42%')

  // Model the legacy bulk renderer replacing the row with its old staging/send UI.
  await page.evaluate(() => {
    document.querySelector('#fg-upload-speed').textContent = '0 B/s'
    document.querySelector('#fg-upload-list').innerHTML = `
      <div class="fg-up-job is-uploading" data-job-id="job-1">
        <div class="fg-up-progress"><span style="width:100%"></span></div>
        <div class="fg-up-job-status">Sending to Telegram…</div>
      </div>`
  })

  await expect.poll(() => page.locator('.fg-up-progress > span').evaluate(el => el.style.width)).toBe('42%')
  const after = await page.evaluate(() => {
    const legacy = document.querySelector('#fg-upload-speed')
    const status = document.querySelector('.fg-up-job-status')
    return {
      legacyHidden: legacy.hidden,
      live: document.querySelector('#fg-upload-live-status').textContent,
      rowData: status.dataset.fgLiveStatus,
      rowFontSize: getComputedStyle(status).fontSize,
      rowAfter: getComputedStyle(status, '::after').content
    }
  })

  expect(after.legacyHidden).toBe(true)
  expect(after.live).toBe('Uploading 42%')
  expect(after.rowData).toBe('Uploading 42%')
  expect(after.rowFontSize).toBe('0px')
  expect(after.rowAfter).toContain('Uploading 42%')
})
