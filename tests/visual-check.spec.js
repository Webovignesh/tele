// @ts-check
const { test, expect } = require('@playwright/test')

const APP = 'http://127.0.0.1:3000'

async function boot (page) {
  await page.goto(APP, { waitUntil: 'networkidle', timeout: 20000 })
  await page.waitForFunction(() => !document.getElementById('boot-status'), { timeout: 12000 }).catch(() => {})
  await page.waitForTimeout(2500)
  return page.evaluate(() => !!document.querySelector('#main-screen:not(.hidden)'))
}

test('app boots to a screen', async ({ page }) => {
  await boot(page)
  const visible = await page.evaluate(() => !!document.querySelector(
    '#main-screen:not(.hidden),#login-screen:not(.hidden),#config-screen:not(.hidden)'
  ))
  expect(visible).toBeTruthy()
  await page.screenshot({ path: 'tests/shot-1-boot.png' })
})

test('three-column shell resolves', async ({ page }) => {
  if (!await boot(page)) return
  const layout = await page.evaluate(() => {
    const app = document.querySelector('.app')
    if (!app) return null
    const s = getComputedStyle(app)
    return {
      display: s.display,
      columns: s.gridTemplateColumns.split(' ').length,
      sidebar: document.querySelector('.sidebar')?.getBoundingClientRect().width ?? 0,
      chat: document.querySelector('.chat')?.getBoundingClientRect().width ?? 0,
      downloads: document.querySelector('.downloads')?.getBoundingClientRect().width ?? 0
    }
  })
  expect(layout).not.toBeNull()
  expect(layout.display).toBe('grid')
  expect(layout.columns).toBe(3)
  expect(layout.sidebar).toBeGreaterThan(200)
  expect(layout.chat).toBeGreaterThan(200)
  expect(layout.downloads).toBeGreaterThan(200)
})

/* REGRESSION: the Files grid must be genuinely hideable. This is the bug that
 * leaked file rows into the Messages tab, caused by an ID-specificity rule
 * outranking .hidden. */
test('media grid is hideable so Messages cannot show file rows', async ({ page }) => {
  if (!await boot(page)) return
  const result = await page.evaluate(() => {
    const grid = document.querySelector('#media-grid')
    if (!grid) return { ok: false, reason: 'no grid' }
    const had = grid.classList.contains('hidden')
    grid.classList.add('hidden')
    const hiddenDisplay = getComputedStyle(grid).display
    if (!had) grid.classList.remove('hidden')
    return { ok: true, hiddenDisplay }
  })
  expect(result.ok).toBeTruthy()
  expect(result.hiddenDisplay).toBe('none')
})

test('tab switching keeps Messages and Files mutually exclusive', async ({ page }) => {
  if (!await boot(page)) return
  const tabFiles = page.locator('#tab-files')
  const tabMessages = page.locator('#tab-messages')
  if (!await tabFiles.count() || !await tabMessages.count()) return

  for (let i = 0; i < 20; i++) {
    await tabFiles.click()
    await page.waitForTimeout(35)
    let state = await page.evaluate(() => {
      const m = document.querySelector('#messages')
      const g = document.querySelector('#media-grid')
      return { messages: m ? getComputedStyle(m).display : 'none', grid: g ? getComputedStyle(g).display : 'none' }
    })
    expect(state.messages, `iteration ${i}: Messages must be hidden in Files view`).toBe('none')
    expect(state.grid, `iteration ${i}: Files grid must be visible in Files view`).not.toBe('none')

    await tabMessages.click()
    await page.waitForTimeout(35)
    state = await page.evaluate(() => {
      const m = document.querySelector('#messages')
      const g = document.querySelector('#media-grid')
      return { messages: m ? getComputedStyle(m).display : 'none', grid: g ? getComputedStyle(g).display : 'none' }
    })
    expect(state.grid, `iteration ${i}: Files grid must be hidden in Messages view`).toBe('none')
    expect(state.messages, `iteration ${i}: Messages must be visible in Messages view`).not.toBe('none')
  }
  await page.screenshot({ path: 'tests/shot-3-messages.png' })
})

/* Files-only chrome must not linger in the Messages view. */
test('Files chrome is hidden in the Messages view', async ({ page }) => {
  if (!await boot(page)) return
  const tabMessages = page.locator('#tab-messages')
  if (!await tabMessages.count()) return
  await tabMessages.click()
  await page.waitForTimeout(200)
  const chrome = await page.evaluate(() => {
    const show = sel => {
      const el = document.querySelector(sel)
      return el ? getComputedStyle(el).display : 'absent'
    }
    return {
      toolbar: show('#files-toolbar'),
      pager: show('#filegram-file-pager'),
      grid: show('#media-grid')
    }
  })
  expect(chrome.toolbar, 'Files toolbar must be hidden in Messages').toMatch(/none|absent/)
  expect(chrome.pager, 'Files pagination must be hidden in Messages').toMatch(/none|absent/)
  expect(chrome.grid, 'Files grid must be hidden in Messages').toMatch(/none|absent/)
})

/* REGRESSION: the thumbnail must not overflow its grid track and cover the
 * first characters of the filename. */
test('file row thumbnail cannot overlap the filename', async ({ page }) => {
  if (!await boot(page)) return
  await page.locator('#chat-list .chat-item').first().click().catch(() => {})
  await page.waitForTimeout(1200)
  const tabFiles = page.locator('#tab-files')
  if (await tabFiles.count()) { await tabFiles.click(); await page.waitForTimeout(2500) }

  const rows = await page.evaluate(() => {
    return [...document.querySelectorAll('#media-grid .gcard')].slice(0, 12).map(card => {
      const thumb = card.querySelector('.gthumb')
      const name = card.querySelector('.gname')
      if (!thumb || !name) return null
      const t = thumb.getBoundingClientRect()
      const n = name.getBoundingClientRect()
      return { thumbRight: t.right, nameLeft: n.left, thumbWidth: t.width, text: name.textContent || '' }
    }).filter(Boolean)
  })

  if (!rows.length) {
    test.info().annotations.push({ type: 'note', description: 'no indexed files available; overlap assertion skipped' })
    return
  }
  for (const row of rows) {
    expect(row.thumbWidth, `thumb should be 48px, got ${row.thumbWidth}`).toBeLessThanOrEqual(50)
    expect(row.nameLeft, `filename "${row.text}" starts at ${row.nameLeft} but thumb ends at ${row.thumbRight}`)
      .toBeGreaterThanOrEqual(row.thumbRight - 0.5)
  }
  await page.screenshot({ path: 'tests/shot-2-files.png' })
})

test('custom file-type dropdown opens and drives the native select', async ({ page }) => {
  if (!await boot(page)) return
  // The Files toolbar is correctly hidden while Messages is active.
  const tabFiles = page.locator('#tab-files')
  if (await tabFiles.count()) { await tabFiles.click(); await page.waitForTimeout(250) }
  const trigger = page.locator('#fg-file-filter .fg-select-trigger')
  if (!await trigger.count() || !await trigger.isVisible()) return
  await trigger.click()
  await expect(page.locator('#fg-file-filter .fg-select-menu')).toBeVisible()
  await page.screenshot({ path: 'tests/shot-4-dropdown.png' })

  await page.locator('#fg-file-filter .fg-select-item[data-value="video"]').click()
  const value = await page.evaluate(() => document.querySelector('#file-filter')?.value)
  expect(value).toBe('video')

  // Escape must close it.
  await trigger.click()
  await page.keyboard.press('Escape')
  await expect(page.locator('#fg-file-filter .fg-select-menu')).toBeHidden()
})

test('Ctrl+K focuses chat search without a second focus decoration', async ({ page }) => {
  if (!await boot(page)) return
  await page.keyboard.press('Control+k')
  await page.waitForTimeout(180)
  const focus = await page.evaluate(() => {
    const input = document.querySelector('#chat-search')
    if (!input) return null
    const s = getComputedStyle(input)
    return {
      focused: document.activeElement === input,
      outline: s.outlineStyle,
      boxShadow: s.boxShadow,
      border: s.borderTopWidth
    }
  })
  expect(focus).not.toBeNull()
  expect(focus.focused).toBeTruthy()
  // The wrapper owns the ring; the input itself must draw nothing.
  expect(focus.outline === 'none' || focus.outline === '').toBeTruthy()
  expect(focus.boxShadow === 'none' || focus.boxShadow === '').toBeTruthy()
  await page.screenshot({ path: 'tests/shot-6-ctrlk.png' })
})

test('account footer shows real identity and gear opens logout menu', async ({ page }) => {
  if (!await boot(page)) return
  const footer = await page.evaluate(() => {
    const el = document.querySelector('#fg-sidebar-account')
    if (!el) return null
    return {
      height: el.getBoundingClientRect().height,
      name: document.querySelector('#fg-account-name')?.textContent || '',
      avatar: document.querySelector('#fg-account-avatar')?.getBoundingClientRect().width ?? 0,
      hasThreeDot: !!document.querySelector('.fg-account-menu'),
      gearRightOfName: (() => {
        const gear = document.querySelector('#fg-settings-btn')
        const info = document.querySelector('#fg-account-info, .fg-account-info')
        if (!gear || !info) return false
        return gear.getBoundingClientRect().left > info.getBoundingClientRect().left
      })()
    }
  })
  expect(footer).not.toBeNull()
  expect(footer.height).toBeGreaterThanOrEqual(58)
  expect(footer.avatar).toBeGreaterThanOrEqual(34)
  expect(footer.hasThreeDot, 'three-dot logout button must be gone').toBeFalsy()
  expect(footer.gearRightOfName, 'gear must sit to the right').toBeTruthy()

  await page.locator('#fg-settings-btn').click()
  await expect(page.locator('#fg-account-popover')).toBeVisible()
  await expect(page.locator('#fg-popover-logout')).toBeVisible()
  await page.screenshot({ path: 'tests/shot-5-account.png' })

  // In-app confirmation, not a browser dialog.
  let nativeDialog = false
  page.on('dialog', async d => { nativeDialog = true; await d.dismiss() })
  await page.locator('#fg-popover-logout').click()
  await expect(page.locator('#fg-logout-modal')).toBeVisible()
  expect(nativeDialog, 'logout must not use window.confirm').toBeFalsy()
  await page.locator('#fg-logout-cancel').click()
  await expect(page.locator('#fg-logout-modal')).toBeHidden()
})

test('download statistics use queue semantics', async ({ page }) => {
  if (!await boot(page)) return
  const stats = await page.evaluate(() => {
    const read = sel => document.querySelector(sel)?.textContent?.trim() || null
    return {
      speed: read('[data-stat="speed"]'),
      done: read('[data-stat="fg-done"]'),
      remaining: read('[data-stat="remaining"]'),
      total: read('#fg-stats-total strong'),
      queue: window.state ? window.state.downloads.size : -1,
      cardIsOne: !!document.querySelector('#tele-ui-download-summary #fg-stats-total')
    }
  })
  expect(stats.cardIsOne, 'Total must live inside the same stats card').toBeTruthy()
  if (stats.queue === 0) {
    expect(stats.done).toBe('0')
    expect(stats.total).toBe('0 files')
  }
  await page.screenshot({ path: 'tests/shot-7-downloads.png' })
})
