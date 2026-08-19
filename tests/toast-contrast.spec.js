// @ts-check
'use strict'

const path = require('node:path')
const { test, expect } = require('@playwright/test')

const STYLE = path.join(__dirname, '..', 'public', 'style.css')
const FILEGRAM_UI = path.join(__dirname, '..', 'public', 'filegram-ui.css')
const UPLOADS = path.join(__dirname, '..', 'public', 'uploads.css')

function contrastRatio (foreground, background) {
  const parse = value => {
    const parts = String(value || '').match(/[\d.]+/g) || []
    return parts.slice(0, 3).map(Number)
  }
  const luminance = value => {
    const rgb = parse(value).map(channel => {
      const c = channel / 255
      return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
    })
    return 0.2126 * (rgb[0] || 0) + 0.7152 * (rgb[1] || 0) + 0.0722 * (rgb[2] || 0)
  }
  const a = luminance(foreground)
  const b = luminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

async function toastStyle (page, kind, message) {
  return page.evaluate(({ kind, message }) => {
    const toast = document.querySelector('#toast')
    toast.textContent = message
    toast.className = `${kind} show`
    const style = getComputedStyle(toast)
    return {
      color: style.color,
      background: style.backgroundColor,
      borderColor: style.borderColor,
      opacity: style.opacity,
      text: toast.textContent
    }
  }, { kind, message })
}

test('success and error toasts remain readable through the full CSS cascade', async ({ page }) => {
  await page.setContent('<div id="toast"></div>')
  // Match production order: legacy base -> FileGram design system -> uploads layer.
  await page.addStyleTag({ path: STYLE })
  await page.addStyleTag({ path: FILEGRAM_UI })
  await page.addStyleTag({ path: UPLOADS })

  const ok = await toastStyle(page, 'ok', 'Deleted 4 files from TEST')
  expect(ok.text).toBe('Deleted 4 files from TEST')
  expect(ok.opacity).toBe('1')
  expect(contrastRatio(ok.color, ok.background)).toBeGreaterThanOrEqual(4.5)

  const error = await toastStyle(page, 'error', 'Delete failed')
  expect(error.text).toBe('Delete failed')
  expect(error.opacity).toBe('1')
  expect(contrastRatio(error.color, error.background)).toBeGreaterThanOrEqual(4.5)
})
