// @ts-check
const { test, expect } = require('@playwright/test')
const { decodePng, isNear, ACCENT } = require('./png-pixels')

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

/* ==========================================================================
 * Files: real paged rows, no virtual/infinite scroll surface
 * ========================================================================== */

async function openFirstChatFiles (page) {
  if (!await boot(page)) return false
  const row = page.locator('#chat-list .chat-item').first()
  if (!await row.count()) return false
  await row.click().catch(() => {})
  await page.waitForTimeout(1500)
  const tabFiles = page.locator('#tab-files')
  if (!await tabFiles.count()) return false
  await tabFiles.click()
  await page.waitForTimeout(2500)
  return true
}

/* REGRESSION: the grid must never be taller than the rows it actually holds.
 * A virtual renderer used to append a trailing spacer sized
 * (items.length - end) * rowHeight, so a 22k index produced a multi-million
 * pixel scroll surface behind ~20 real rows and scrolling ran into blankness. */
test('Files grid has no synthetic scroll geometry beyond its rows', async ({ page }) => {
  if (!await openFirstChatFiles(page)) return
  const geometry = await page.evaluate(() => {
    const grid = document.querySelector('#media-grid')
    if (!grid) return null
    const cards = [...grid.querySelectorAll(':scope > .gcard')]
    let rowHeight = 0
    for (const card of cards) rowHeight += card.getBoundingClientRect().height
    return {
      children: grid.childElementCount,
      cards: cards.length,
      spacers: grid.querySelectorAll('[class*="spacer"]').length,
      scrollHeight: grid.scrollHeight,
      clientHeight: grid.clientHeight,
      rowsHeight: Math.round(rowHeight)
    }
  })
  if (!geometry || !geometry.cards) {
    test.info().annotations.push({ type: 'note', description: 'no indexed files available; geometry assertion skipped' })
    return
  }
  expect(geometry.spacers, 'no spacer elements may pad the scroll surface').toBe(0)
  expect(geometry.cards, 'a page must never mount more than 100 file rows').toBeLessThanOrEqual(100)
  expect(geometry.children, 'the grid must contain only the page rows').toBe(geometry.cards)
  // Allow generous padding slack, but nothing like a whole-index surface.
  expect(geometry.scrollHeight, `scrollHeight ${geometry.scrollHeight} must track the ${geometry.rowsHeight}px of rows`)
    .toBeLessThan(geometry.rowsHeight + 400)
})

test('Files pager reports one page per 100 rows and resets scroll on change', async ({ page }) => {
  if (!await openFirstChatFiles(page)) return
  const state = await page.evaluate(() => {
    const pager = document.querySelector('#filegram-file-pager')
    const grid = document.querySelector('#media-grid')
    if (!pager || !grid) return null
    const pages = window.fileGramFilesPages
    return {
      pageSize: pages ? pages.pageSize : -1,
      pageCount: pages ? pages.pageCount() : -1,
      page: pages ? pages.page() : -1,
      cards: grid.querySelectorAll(':scope > .gcard').length,
      scrollTop: grid.scrollTop
    }
  })
  if (!state) return
  expect(state.pageSize, 'the page size must be 100').toBe(100)
  expect(state.page).toBe(1)
  expect(state.cards).toBeLessThanOrEqual(state.pageSize)
  // With N files the pager must claim ceil(N / 100) pages, never a scroll window.
  expect(state.pageCount).toBeGreaterThanOrEqual(1)

  if (state.pageCount > 1) {
    await page.evaluate(() => window.fileGramFilesPages.goToPage(2))
    await page.waitForTimeout(600)
    const second = await page.evaluate(() => {
      const grid = document.querySelector('#media-grid')
      return {
        page: window.fileGramFilesPages.page(),
        scrollTop: grid.scrollTop,
        cards: grid.querySelectorAll(':scope > .gcard').length,
        firstIndex: Number((grid.querySelector(':scope > .gcard') || {}).dataset?.globalIndex ?? -1)
      }
    })
    expect(second.page).toBe(2)
    expect(second.scrollTop, 'a page change must reset scroll to the top').toBe(0)
    expect(second.firstIndex, 'page 2 must start at global index 100').toBe(100)
    expect(second.cards).toBeLessThanOrEqual(100)
  }
})

/* REGRESSION: drag-to-select is removed. Pressing and moving over a row must not
 * create a marquee, must not select a range, and must leave text selection alone. */
test('drag selection is gone and cannot select a range', async ({ page }) => {
  if (!await openFirstChatFiles(page)) return
  const cards = page.locator('#media-grid .gcard')
  if (await cards.count() < 3) {
    test.info().annotations.push({ type: 'note', description: 'not enough rows to attempt a drag' })
    return
  }
  await page.evaluate(() => { state.selection.clear() })
  const first = await cards.nth(0).boundingBox()
  const third = await cards.nth(2).boundingBox()
  if (!first || !third) return

  await page.mouse.move(first.x + 40, first.y + first.height / 2)
  await page.mouse.down()
  await page.mouse.move(third.x + 40, third.y + third.height / 2, { steps: 8 })
  const during = await page.evaluate(() => ({
    marquee: document.querySelectorAll('.marquee').length,
    userSelect: document.body.style.userSelect,
    selected: state.selection.size
  }))
  await page.mouse.up()
  await page.waitForTimeout(150)

  expect(during.marquee, 'no marquee overlay may be created').toBe(0)
  expect(during.userSelect, 'drag must not suppress text selection any more').toBe('')
  expect(during.selected, 'dragging must not paint a selection range').toBeLessThanOrEqual(1)
  expect(await page.locator('.drag-hint').count(), 'the "Drag to select" hint must be gone').toBe(0)
})

test('checkbox and Select all still drive selection after drag removal', async ({ page }) => {
  if (!await openFirstChatFiles(page)) return
  const boxes = page.locator('#media-grid .gcard input[type=checkbox]')
  if (!await boxes.count()) return
  await page.evaluate(() => { state.selection.clear(); updateSelectionBar() })
  await boxes.first().check()
  expect(await page.evaluate(() => state.selection.size), 'a checkbox must select one row').toBe(1)

  const selectAll = page.locator('#select-all-media')
  if (await selectAll.count() && await selectAll.isEnabled()) {
    await selectAll.click()
    await page.waitForTimeout(200)
    expect(await page.evaluate(() => state.selection.size), 'Select all must select the whole filtered set').toBeGreaterThan(1)
  }
})

/* ==========================================================================
 * Authoritative count
 * ========================================================================== */

/* REGRESSION: 22,479 -> 17,484 -> 22,479. A short snapshot stamped done:true
 * used to reach the header through the shared cache. The committed index plus a
 * durable floor must make that impossible. */
test('a smaller snapshot cannot lower the authoritative file count', async ({ page }) => {
  if (!await openFirstChatFiles(page)) return
  const before = await page.evaluate(() => (document.querySelector('#chat-media-count') || {}).textContent || '')
  const parsed = Number(String(before).replace(/[^\d]/g, ''))
  if (!parsed) {
    test.info().annotations.push({ type: 'note', description: 'chat has no indexed files; count-floor assertion skipped' })
    return
  }

  const after = await page.evaluate(() => {
    const chatId = String(state.activeChatId)
    const snapshot = rescueFileCache.get(chatId)
    if (!snapshot || !Array.isArray(snapshot.items) || snapshot.items.length < 2) return null
    // A partial batch that claims to be complete, exactly as the legacy scan
    // layers used to publish.
    const partial = {
      chatId: state.activeChatId,
      items: snapshot.items.slice(0, Math.max(1, Math.floor(snapshot.items.length / 2))),
      found: Math.max(1, Math.floor(snapshot.items.length / 2)),
      scanned: 100,
      typeCounts: {},
      done: true,
      savedAt: Date.now()
    }
    rescueFileCache.set(chatId, partial)
    updateMediaCountLabel()
    return (document.querySelector('#chat-media-count') || {}).textContent || ''
  })
  if (after === null) {
    test.info().annotations.push({ type: 'note', description: 'too few files to halve; assertion skipped' })
    return
  }
  const parsedAfter = Number(String(after).replace(/[^\d]/g, ''))
  expect(parsedAfter, `header showed ${after} after a half-size snapshot was published; it must not drop below ${before}`)
    .toBeGreaterThanOrEqual(parsed)
})

/* ==========================================================================
 * Remaining UI details
 * ========================================================================== */

test('app icon is declared and self contained', async ({ page }) => {
  await boot(page)
  const icon = await page.evaluate(() => {
    const link = document.querySelector('link[rel~="icon"]')
    if (!link) return null
    return { href: link.getAttribute('href') || '', rel: link.getAttribute('rel') }
  })
  expect(icon, 'an app icon must be declared').not.toBeNull()
  // Inline data URI: no network fetch, no file to ship. The xmlns literal inside
  // the SVG is an XML namespace identifier, not a request, so only the href
  // scheme is checked here.
  expect(icon.href.startsWith('data:image/svg+xml'), 'the icon must be inline SVG, not a network asset').toBeTruthy()
  expect(/^https?:/.test(icon.href), 'the icon must not be fetched over the network').toBeFalsy()
  expect(decodeURIComponent(icon.href), 'the data URI must carry real SVG markup').toContain('<svg')
})

test('brand mark renders as a sized inline SVG', async ({ page }) => {
  if (!await boot(page)) return
  const brand = await page.evaluate(() => {
    const mark = document.querySelector('#fg-brand-mark')
    if (!mark) return null
    const svg = mark.querySelector('svg')
    const box = mark.getBoundingClientRect()
    const cs = getComputedStyle(mark)
    return {
      hasSvg: !!svg,
      width: Math.round(box.width),
      height: Math.round(box.height),
      display: cs.display,
      visibility: cs.visibility,
      opacity: cs.opacity
    }
  })
  expect(brand).not.toBeNull()
  expect(brand.hasSvg, 'the brand mark must contain an inline SVG').toBeTruthy()
  expect(brand.width).toBeGreaterThanOrEqual(24)
  expect(brand.width).toBeLessThanOrEqual(28)
  expect(brand.height).toBeGreaterThanOrEqual(24)
  expect(brand.visibility).toBe('visible')
  expect(Number(brand.opacity)).toBeGreaterThan(0.9)
})

test('active chat header avatar is never an empty circle', async ({ page }) => {
  if (!await boot(page)) return
  const row = page.locator('#chat-list .chat-item').first()
  if (!await row.count()) return
  await row.click().catch(() => {})
  await page.waitForTimeout(3000)

  const avatar = await page.evaluate(() => {
    const host = document.querySelector('#fg-chat-avatar')
    if (!host) return null
    const node = host.firstElementChild
    const img = host.querySelector('img')
    const fallback = host.querySelector('.tele-final-avatar-fallback')
    const box = node ? node.getBoundingClientRect() : null
    return {
      mounted: host.childElementCount,
      width: box ? Math.round(box.width) : 0,
      height: box ? Math.round(box.height) : 0,
      hasPhoto: !!(img && img.complete && img.naturalWidth > 0),
      initials: fallback ? (fallback.textContent || '').trim() : '',
      initialsHidden: fallback ? fallback.classList.contains('hidden') : null
    }
  })
  expect(avatar, 'the header avatar host must exist').not.toBeNull()
  expect(avatar.mounted, 'the header avatar must be populated').toBeGreaterThan(0)
  expect(avatar.width, 'the mounted avatar must not collapse to zero').toBeGreaterThanOrEqual(28)
  expect(avatar.height).toBeGreaterThanOrEqual(28)
  // Either a real photo, or visible initials. Never an empty circle.
  const showsSomething = avatar.hasPhoto || (avatar.initials.length > 0 && !avatar.initialsHidden)
  expect(showsSomething, `photo=${avatar.hasPhoto} initials="${avatar.initials}" hidden=${avatar.initialsHidden}`).toBeTruthy()
})

/* The hairline must be drawn on the BOTTOM of the metric tiles, so it meets the
 * ends of the vertical column dividers. Declared on Total instead it sat below the
 * sparkline row and the vertical dividers stopped short of it. */
test('download stats hairline meets the column dividers', async ({ page }) => {
  if (!await boot(page)) return
  const card = await page.evaluate(() => {
    const summary = document.querySelector('#tele-ui-download-summary')
    const total = document.querySelector('#fg-stats-total')
    if (!summary || !total) return null
    const tiles = [...summary.children].filter(el => el.querySelector(':scope > strong[data-stat]'))
    const visible = tiles.filter(el => getComputedStyle(el).display !== 'none')
    const first = visible[0]
    const spark = summary.querySelector('.fg-spark')
    return {
      insideSameCard: summary.contains(total),
      tileBorderBottom: first ? getComputedStyle(first).borderBottomWidth : 'n/a',
      tileBorderRight: first ? getComputedStyle(first).borderRightWidth : 'n/a',
      tileBottom: first ? Math.round(first.getBoundingClientRect().bottom) : -1,
      totalTop: Math.round(total.getBoundingClientRect().top),
      totalBorderTop: getComputedStyle(total).borderTopWidth,
      sparkDisplay: spark ? getComputedStyle(spark).display : 'absent',
      sparkEmpty: spark ? spark.childElementCount === 0 : null,
      label: (total.querySelector('span') || {}).textContent
    }
  })
  expect(card, 'the Total row must exist').not.toBeNull()
  expect(card.insideSameCard, 'Total must stay inside the same stats card').toBeTruthy()
  expect(card.tileBorderBottom, 'the metric tiles must draw the 1px hairline').toBe('1px')
  expect(card.tileBorderRight, 'the column dividers must remain').toBe('1px')
  // The line and the divider ends share a y coordinate, so the corners join.
  expect(card.tileBottom, 'the hairline must sit exactly where Total begins').toBe(card.totalTop)
  expect(card.totalBorderTop, 'Total must not draw a second line').toBe('0px')
  if (card.sparkEmpty) {
    expect(card.sparkDisplay, 'an empty sparkline must collapse, not leave a gap').toBe('none')
  }
  expect(card.label).toMatch(/total/i)
})

test('stats card aligns with the download controls and is spaced from them', async ({ page }) => {
  if (!await boot(page)) return
  const layout = await page.evaluate(() => {
    const card = document.querySelector('#tele-ui-download-summary')
    const label = [...document.querySelectorAll('.dl-controls .conc')]
      .map(c => c.querySelector('span'))
      .find(Boolean)
    // The download destination is one control now, so its own left edge is what the
    // card has to line up with; `#dl-dir` no longer exists (task 8).
    const field = document.querySelector('#set-dir')
    if (!card || !label || !field) return null
    const cb = card.getBoundingClientRect()
    return {
      cardLeft: Math.round(cb.left),
      cardRight: Math.round(cb.right),
      labelLeft: Math.round(label.getBoundingClientRect().left),
      fieldLeft: Math.round(field.getBoundingClientRect().left),
      gap: Math.round(field.getBoundingClientRect().top - cb.bottom)
    }
  })
  expect(layout, 'the stats card and the Save-to control must exist').not.toBeNull()
  // The card used to carry its own 14px side margin on top of .dl-controls'
  // padding, so it sat indented relative to the controls beneath it.
  expect(layout.cardLeft, 'the card must share the controls left edge').toBe(layout.labelLeft)
  expect(layout.cardLeft, 'the card must line up with the Save-to control').toBe(layout.fieldLeft)
  expect(layout.gap, `only ${layout.gap}px between the stats card and the Save-to control`).toBeGreaterThanOrEqual(10)
})

/* The thumb was pinned inside a 6px-tall input, so it rendered high and clipped,
 * and the track had no filled portion at all. */
test('concurrency slider thumb is centred and the track shows the value', async ({ page }) => {
  if (!await boot(page)) return
  const slider = await page.evaluate(() => {
    const input = document.querySelector('#concurrency')
    if (!input) return null
    const cs = getComputedStyle(input)
    const min = Number(input.min || 1)
    const max = Number(input.max || 64)
    const value = Number(input.value)
    return {
      height: parseFloat(cs.height),
      background: cs.backgroundColor,
      fill: cs.getPropertyValue('--fg-range-ratio').trim(),
      expected: ((value - min) / (max - min)).toFixed(5),
      value
    }
  })
  expect(slider, 'the slider must exist').not.toBeNull()
  // The box must be at least as tall as the 14px thumb or the head sits off-track.
  expect(slider.height, 'the input must be tall enough for the thumb').toBeGreaterThanOrEqual(14)
  expect(slider.fill, 'the filled portion must track the value').toBe(slider.expected)

  // Moving the slider must repaint the fill.
  await page.locator('#concurrency').focus()
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(150)
  const after = await page.evaluate(() => {
    const input = document.querySelector('#concurrency')
    const min = Number(input.min || 1)
    const max = Number(input.max || 64)
    return {
      fill: getComputedStyle(input).getPropertyValue('--fg-range-ratio').trim(),
      expected: ((Number(input.value) - min) / (max - min)).toFixed(5)
    }
  })
  expect(after.fill, 'the fill must follow the slider').toBe(after.expected)
  await page.keyboard.press('ArrowLeft')
  await page.waitForTimeout(400)
})

test('brand mark is the Telegram logo, self contained', async ({ page }) => {
  if (!await boot(page)) return
  const brand = await page.evaluate(() => {
    const mark = document.querySelector('#fg-brand-mark')
    if (!mark) return null
    const svg = mark.querySelector('svg')
    return {
      hasSvg: !!svg,
      hasDisc: !!mark.querySelector('circle'),
      planePaths: mark.querySelectorAll('path').length,
      markup: mark.innerHTML,
      width: Math.round(mark.getBoundingClientRect().width)
    }
  })
  expect(brand).not.toBeNull()
  expect(brand.hasSvg, 'the mark must be an inline SVG').toBeTruthy()
  expect(brand.hasDisc, 'the Telegram mark is a disc').toBeTruthy()
  expect(brand.planePaths, 'the paper plane must be drawn').toBeGreaterThanOrEqual(1)
  expect(brand.width).toBeGreaterThanOrEqual(24)
  expect(brand.width).toBeLessThanOrEqual(28)
  // No network asset and no emoji. url() is permitted only as an internal
  // fragment reference, which is how the gradient is applied.
  expect(brand.markup).not.toContain('<img')
  expect(brand.markup, 'url() may only reference an in-document fragment').not.toMatch(/url\(\s*['"]?[^#'")]/)
  expect(brand.markup, 'the mark must not fetch anything').not.toMatch(/https?:\/\//)
})

test('chat header has no overflow menu button', async ({ page }) => {
  if (!await boot(page)) return
  expect(await page.locator('#fg-chat-overflow').count(), 'the three-dot button must be gone').toBe(0)
  expect(await page.locator('#fg-chat-overflow-menu').count(), 'its menu must be gone too').toBe(0)
  const dots = await page.evaluate(() => {
    const actions = document.querySelector('.chat-actions')
    return actions ? actions.querySelectorAll('button').length : -1
  })
  // Download all media + Select all may live here; nothing else.
  expect(dots).toBeLessThanOrEqual(2)
})

/* REGRESSION: selecting Unread then clicking a chat used to re-show every chat,
 * because the chat renderers were called by name and bypassed the wrapper that
 * reapplies the Unread predicate. */
test('Unread filter survives opening a chat and typing in search', async ({ page }) => {
  if (!await boot(page)) return
  const seg = page.locator('#fg-filter-unread')
  if (!await seg.count()) return
  await seg.click()
  await page.waitForTimeout(700)

  const count = async () => page.evaluate(() => {
    const rows = [...document.querySelectorAll('#chat-list .chat-item[data-chat-id]')]
    return { visible: rows.filter(r => !r.hidden).length, total: rows.length }
  })

  const before = await count()
  if (!before.visible) {
    test.info().annotations.push({ type: 'note', description: 'no unread chats; filter assertion skipped' })
    return
  }
  expect(before.visible, 'the filter must hide read chats').toBeLessThan(before.total)

  await page.locator('#chat-list .chat-item:not([hidden])').first().click().catch(() => {})
  await page.waitForTimeout(2500)
  const afterOpen = await count()
  // At most the opened chat may leave the list once it is marked read.
  expect(afterOpen.visible, `opening a chat revealed ${afterOpen.visible} of ${afterOpen.total} rows`)
    .toBeLessThanOrEqual(before.visible)
  // The row set may GROW as more chats stream in from the server; what must not
  // happen is previously hidden rows becoming visible.
  expect(afterOpen.total, 'rows must not disappear').toBeGreaterThanOrEqual(before.total)

  await page.locator('#chat-search').fill('a')
  await page.waitForTimeout(600)
  const afterSearch = await count()
  expect(afterSearch.visible, 'typing in search must not defeat the Unread filter')
    .toBeLessThanOrEqual(before.visible)
  await page.locator('#chat-search').fill('')
  await page.waitForTimeout(400)
  await page.locator('#fg-filter-all').click().catch(() => {})
})

/* REGRESSION: guardAvatar dedupes on photo id, so two consecutive chats without a
 * photo both mapped to id 0 and the header kept the previous chat's initials. */
test('header avatar initials follow the active chat', async ({ page }) => {
  if (!await boot(page)) return
  const seen = []
  for (let index = 0; index < 5; index++) {
    const row = page.locator('#chat-list .chat-item:not([hidden])').nth(index)
    if (!await row.count()) break
    await row.click().catch(() => {})
    await page.waitForTimeout(1600)
    const info = await page.evaluate(() => {
      const host = document.querySelector('#fg-chat-avatar')
      const fallback = host && host.querySelector('.tele-final-avatar-fallback')
      const img = host && host.querySelector('img')
      return {
        title: ((document.querySelector('#chat-title') || {}).textContent || '').trim(),
        initials: fallback ? (fallback.textContent || '').trim() : '',
        photoShown: !!(img && img.complete && img.naturalWidth > 0)
      }
    })
    seen.push(info)
  }
  expect(seen.length, 'at least one chat must be openable').toBeGreaterThan(0)
  for (const entry of seen) {
    if (entry.photoShown || !entry.title) continue
    const expected = entry.title.trim()[0].toUpperCase()
    expect(entry.initials.startsWith(expected),
      `chat "${entry.title}" shows initials "${entry.initials}", expected to start with "${expected}"`).toBeTruthy()
  }
})


/* ==========================================================================
 * Save to: ONE control
 *
 * This live suite is the authority on the Save-to layout, which is how the clause
 * 1.23 contradiction is resolved. `tests/file-consistency.spec.js` used to require
 * `#dl-dir` HIDDEN with `#set-dir.fg-folder-v2`, while the tests here used to
 * require `#dl-dir` VISIBLE beside a matching Browse button. Both cannot be right,
 * and neither described the intended UI. The tests below describe the single control
 * from the design: one `button#set-dir.fg-save-to` filling its parent, one path
 * display, and `#dl-dir` / `#dl-dir-current` absent from the DOM entirely rather
 * than hidden.
 *
 * ORDERING, stated plainly: that markup and its one stylesheet block land in TASK 8.
 * These assertions are written first so task 8 has an executable target and so no
 * green test in this tree describes a UI that is being deleted. Until task 8 lands
 * they FAIL, and they are meant to - a failure here before task 8 is the target, not
 * a regression.
 * ========================================================================== */

test('Save to and Parallel files share a left edge', async ({ page }) => {
  if (!await boot(page)) return
  const edges = await page.evaluate(() => {
    const saveTo = document.querySelector('#set-dir')
    const parallel = [...document.querySelectorAll('.dl-controls .conc')]
      .map(conc => conc.querySelector('span'))
      .find(span => span && /parallel/i.test(span.textContent || ''))
    if (!saveTo || !parallel) return null
    const saveToBox = saveTo.getBoundingClientRect()
    const parallelBox = parallel.getBoundingClientRect()
    return {
      saveToLeft: Math.round(saveToBox.left),
      parallelLeft: Math.round(parallelBox.left),
      parallelAlignSelf: getComputedStyle(parallel).alignSelf,
      saveToIsOnlyControl: document.querySelectorAll('.dl-controls #set-dir').length
    }
  })
  expect(edges, 'the Save-to control and the Parallel files row must both exist').not.toBeNull()
  expect(edges.parallelAlignSelf, 'the Parallel files label must stay left aligned, not centred').toBe('flex-start')
  expect(edges.saveToLeft, 'the Save-to control must share the Parallel files left edge').toBe(edges.parallelLeft)
  expect(edges.saveToIsOnlyControl, 'exactly one Save-to control may sit in the download controls').toBe(1)
})

test('Save to is exactly one control, with no legacy path nodes in the DOM', async ({ page }) => {
  if (!await boot(page)) return
  const shape = await page.evaluate(() => {
    const button = document.querySelector('#set-dir')
    const pane = document.querySelector('#mg-downloads-pane') || document.querySelector('.downloads')
    const visible = node => {
      if (!node) return false
      const box = node.getBoundingClientRect()
      return box.width > 0 && box.height > 0 && getComputedStyle(node).display !== 'none'
    }
    return {
      hasControl: !!button,
      controlClasses: button ? button.className : null,
      isSaveTo: !!(button && button.classList.contains('fg-save-to')),
      tagName: button ? button.tagName : null,
      legacyInput: !!document.querySelector('#dl-dir'),
      legacyLine: !!document.querySelector('#dl-dir-current'),
      clickTargets: pane ? pane.querySelectorAll('#set-dir, .fg-save-to').length : -1,
      pathDisplays: pane
        ? [...pane.querySelectorAll('#dl-dir-path, .fg-save-to-path, #dl-dir, #dl-dir-current, .dir-current')].filter(visible).length
        : -1,
      nestedButtons: button ? button.querySelectorAll('button').length : -1,
      parts: button
        ? {
            icon: !!button.querySelector('.fg-save-to-icon'),
            label: !!button.querySelector('.fg-save-to-label'),
            path: !!button.querySelector('#dl-dir-path, .fg-save-to-path'),
            chevron: !!button.querySelector('.fg-save-to-chevron')
          }
        : null
    }
  })

  expect(shape.hasControl, 'the Save-to control must exist').toBe(true)
  expect(shape.tagName, 'the Save-to control is a button').toBe('BUTTON')
  expect(shape.isSaveTo, `the control must carry the single Save-to class, saw "${shape.controlClasses}"`).toBe(true)
  expect(shape.legacyInput, '#dl-dir must be removed from the markup, not hidden').toBe(false)
  expect(shape.legacyLine, '#dl-dir-current must be removed from the markup, not hidden').toBe(false)
  expect(shape.clickTargets, 'exactly one click target may exist for the download destination').toBe(1)
  expect(shape.pathDisplays, 'exactly one visible path display may exist').toBe(1)
  expect(shape.nestedButtons, 'the control must not nest a second button').toBe(0)
  expect(shape.parts, 'the control must be one row of icon, copy and chevron').toEqual({ icon: true, label: true, path: true, chevron: true })
})

test('Save to fills the sidebar width and ellipsises only on genuine overflow', async ({ page }) => {
  if (!await boot(page)) return
  const measured = []
  for (const width of [1280, 1366, 1600, 1920]) {
    await page.setViewportSize({ width, height: 900 })
    await page.waitForTimeout(250)
    measured.push({
      viewport: width,
      ...(await page.evaluate(() => {
        const button = document.querySelector('#set-dir')
        if (!button) return { present: false }
        const parent = button.parentElement
        const path = button.querySelector('#dl-dir-path, .fg-save-to-path')
        const box = button.getBoundingClientRect()
        const style = getComputedStyle(button)
        /* "Available width" is the parent's CONTENT box, not its border box.
         * `.dl-controls` carries 14px of horizontal padding, so an assertion against
         * `parent.getBoundingClientRect().width` demands the control overflow its own
         * parent's padding - which nothing can do and which is not what clause 2.19
         * asks for. The Parallel files row is measured alongside it as the reference:
         * that sibling has always filled the pane, so "the control is exactly as wide
         * as the row beside it" is the same claim, checkable against a known-good
         * value (the task 3 baseline pins that row at 311/341/361/371 px). */
        const parentStyle = getComputedStyle(parent)
        const parentContentWidth = Math.round(parent.clientWidth - parseFloat(parentStyle.paddingLeft || '0') - parseFloat(parentStyle.paddingRight || '0'))
        const siblingRow = document.querySelector('#mg-downloads-pane .dl-controls .conc > .row, .downloads .dl-controls .conc > .row')
        return {
          present: true,
          width: Math.round(box.width),
          parentWidth: parentContentWidth,
          parentBorderBoxWidth: Math.round(parent.getBoundingClientRect().width),
          siblingRowWidth: siblingRow ? Math.round(siblingRow.getBoundingClientRect().width) : -1,
          height: Math.round(box.height),
          display: style.display,
          textAlign: style.textAlign,
          title: button.title,
          pathText: path ? (path.textContent || '').trim() : null,
          pathClientWidth: path ? path.clientWidth : -1,
          pathScrollWidth: path ? path.scrollWidth : -1,
          pathOverflow: path ? getComputedStyle(path).textOverflow : null
        }
      }))
    })
  }
  await page.setViewportSize({ width: 1600, height: 900 })

  for (const item of measured) {
    const where = `viewport ${item.viewport}px`
    expect(item.present, `${where}: the Save-to control must exist`).toBe(true)
    expect(item.display, `${where}: the control is one flex row`).toBe('flex')
    expect(item.textAlign, `${where}: the control reads left to right`).toBe('left')
    expect(item.width, `${where}: the control must fill the available width (${item.parentWidth}px content box, parent border box ${item.parentBorderBoxWidth}px)`).toBeGreaterThanOrEqual(item.parentWidth - 2)
    if (item.siblingRowWidth > 0) {
      expect(Math.abs(item.width - item.siblingRowWidth), `${where}: the control must be as wide as the Parallel files row beside it (${item.siblingRowWidth}px)`).toBeLessThanOrEqual(2)
    }
    expect(item.height, `${where}: the control must be comfortably tall`).toBeGreaterThanOrEqual(40)
    /* Ellipsis is allowed only when the path genuinely exceeds the width it was
     * given. `SAV...` on a 54px control is the defect, so both the mechanism
     * (text-overflow) and the condition (real overflow) are asserted. */
    if (item.pathText) {
      expect(item.pathOverflow, `${where}: the path must ellipsise rather than clip`).toBe('ellipsis')
      expect(item.title, `${where}: the full path must be available as a tooltip`).toBeTruthy()
      if (item.pathScrollWidth <= item.pathClientWidth + 1) {
        expect(item.pathText, `${where}: a path that fits must be shown in full`).toBe(item.title)
      }
    }
  }
})

test('exactly one stylesheet rule decides the Save-to width', async ({ page }) => {
  if (!await boot(page)) return
  const rules = await page.evaluate(() => {
    const out = []
    const specificity = selector => {
      const ids = (selector.match(/#[\w-]+/g) || []).length
      const classes = (selector.match(/\.[\w-]+|\[[^\]]*\]|:[\w-]+/g) || []).length
      const types = (selector.match(/(^|[\s>+~])[a-z][\w-]*/gi) || []).length
      return `${ids},${classes},${types}`
    }
    for (const sheet of document.styleSheets) {
      let cssRules = []
      try { cssRules = [...sheet.cssRules] } catch { continue }
      for (const rule of cssRules) {
        if (!rule.selectorText || !/set-dir|dl-dir|dir-current/.test(rule.selectorText)) continue
        const width = rule.style && rule.style.getPropertyValue('width')
        out.push({
          sheet: String(sheet.href || `<injected ${(sheet.ownerNode && sheet.ownerNode.id) || 'style'}>`).replace(/^.*\//, ''),
          selector: rule.selectorText,
          specificity: specificity(rule.selectorText),
          width: width ? width + (rule.style.getPropertyPriority('width') ? ' !important' : '') : ''
        })
      }
    }
    return out
  })

  const widthRules = rules.filter(rule => rule.width)
  expect(
    widthRules.length,
    `exactly one rule may declare a width for the Save-to control, saw ${JSON.stringify(widthRules, null, 2)}`
  ).toBe(1)
  expect(widthRules[0].selector, 'the surviving rule must address the single control by class').toMatch(/#set-dir\.fg-save-to/)
  const removedNodeRules = rules.filter(rule => /dl-dir(?!-path)|dir-current/.test(rule.selector))
  expect(
    removedNodeRules.length,
    `no rule may target a removed node, saw ${JSON.stringify(removedNodeRules, null, 2)}`
  ).toBe(0)
  expect(
    await page.evaluate(() => !!document.querySelector('#fg-hardening-style, #fg-download-folder-v2-style')),
    'no second stylesheet may be injected for the same node'
  ).toBe(false)
})

test('Parallel files slider fills its row and drives concurrency', async ({ page }) => {
  if (!await boot(page)) return
  const layout = await page.evaluate(() => {
    const slider = document.querySelector('#concurrency')
    const value = document.querySelector('#concurrency-val')
    const label = [...document.querySelectorAll('.dl-controls .conc')]
      .map(c => c.querySelector('span'))
      .find(s => s && /parallel/i.test(s.textContent || ''))
    if (!slider || !value || !label) return null
    const sb = slider.getBoundingClientRect()
    const vb = value.getBoundingClientRect()
    return {
      sliderWidth: Math.round(sb.width),
      collides: vb.left < sb.right - 1,
      labelAboveSlider: Math.round(label.getBoundingClientRect().bottom) <= Math.round(sb.top) + 2,
      valueText: (value.textContent || '').trim(),
      sliderValue: slider.value
    }
  })
  expect(layout, 'the Parallel files row must exist').not.toBeNull()
  expect(layout.sliderWidth, 'the slider must fill the remaining width').toBeGreaterThan(150)
  expect(layout.collides, 'the value must not overlap the slider').toBeFalsy()
  expect(layout.labelAboveSlider, 'the label sits on its own line above the slider').toBeTruthy()
  expect(layout.valueText).toBe(layout.sliderValue)

  // Keyboard must work and must push the new value through.
  await page.locator('#concurrency').focus()
  const start = Number(layout.sliderValue)
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(150)
  const bumped = await page.evaluate(() => ({
    slider: Number(document.querySelector('#concurrency').value),
    readout: (document.querySelector('#concurrency-val').textContent || '').trim()
  }))
  expect(bumped.slider, 'the arrow key must move the slider').toBe(start + 1)
  expect(bumped.readout, 'the readout must follow the slider').toBe(String(start + 1))
  // Put it back so the run leaves no state behind.
  await page.keyboard.press('ArrowLeft')
  await page.waitForTimeout(400)
})

/* ==========================================================================
 * P0: one authoritative total, and a completeness flag that can recover
 * ========================================================================== */

/* REGRESSION: header 22,479 while Select all and the pager read 21,045.
 *
 * Two causes, both fixed: the header displayed max(measured, floor), which
 * fabricated a number the list could not back up; and files-view derived its list
 * from rescueFileCache while the header derived from the committed index, so any
 * legacy write to the shared cache desynchronised them. */
test('every total agrees with the committed index', async ({ page }) => {
  if (!await openFirstChatFiles(page)) return

  // Give a large channel time to settle; a cold index streams in batches.
  let reading = null
  for (let attempt = 0; attempt < 24; attempt++) {
    reading = await page.evaluate(() => {
      const num = s => Number(String(s || '').replace(/[^\d]/g, '')) || 0
      const index = window.teleFilesIndex
      const owned = index && typeof index.snapshot === 'function' ? index.snapshot(state.activeChatId) : null
      return {
        header: num((document.querySelector('#chat-media-count') || {}).textContent),
        downloadAll: num((document.querySelector('#download-all-media') || {}).textContent),
        selectAll: num((document.querySelector('#select-all-media') || {}).textContent),
        pager: (document.querySelector('.filegram-page-summary') || {}).textContent || '',
        items: owned && Array.isArray(owned.items) ? owned.items.length : -1,
        done: owned ? owned.done : null
      }
    })
    if (reading.done === true) break
    await page.waitForTimeout(2500)
  }
  if (!reading || reading.items <= 0) {
    test.info().annotations.push({ type: 'note', description: 'chat has no indexed files; total agreement skipped' })
    return
  }

  /* The completeness flag must be able to reach true. It used to be ANDed in
   * union(), so the first progress flush (done:false) pinned it false forever. */
  expect(reading.done, 'a settled index must report itself complete').toBe(true)

  expect(reading.header, 'the header must equal the committed index').toBe(reading.items)
  expect(reading.downloadAll, 'Download all must equal the committed index').toBe(reading.items)
  expect(reading.selectAll, 'Select all must equal the committed index').toBe(reading.items)
  // With no filter applied the pager reports plain "of N files"; the "matching"
  // form would mean the list is deriving from a different source than the header.
  expect(reading.pager, `pager disagreed: ${reading.pager}`).toContain(reading.items.toLocaleString())
  expect(reading.pager, 'an unfiltered view must not report a matching subset').not.toContain('matching')
})

test('a settled index stops reporting that it is still indexing', async ({ page }) => {
  if (!await openFirstChatFiles(page)) return
  let settled = null
  for (let attempt = 0; attempt < 24; attempt++) {
    settled = await page.evaluate(() => {
      const index = window.teleFilesIndex
      const owned = index && typeof index.snapshot === 'function' ? index.snapshot(state.activeChatId) : null
      return {
        done: owned ? owned.done : null,
        items: owned && owned.items ? owned.items.length : 0,
        loadState: ((document.querySelector('#load-state') || {}).textContent || '').trim()
      }
    })
    if (settled.done === true) break
    await page.waitForTimeout(2500)
  }
  if (!settled || !settled.items) return
  // The status line was stuck on "Indexing files..." forever because the snapshot
  // never reported completeness.
  expect(settled.loadState, `status still reads "${settled.loadState}"`).not.toMatch(/indexing/i)
})

/* ==========================================================================
 * Remaining UI details
 * ========================================================================== */

test('auth screens carry the Telegram mark', async ({ page }) => {
  await boot(page)
  const marks = await page.evaluate(() => {
    const out = []
    for (const selector of ['#login-screen h1', '#config-screen h1']) {
      const h1 = document.querySelector(selector)
      if (!h1) continue
      const mark = h1.querySelector('.fg-auth-mark')
      out.push({
        selector,
        hasMark: !!mark,
        hasDisc: !!(mark && mark.querySelector('circle')),
        planePaths: mark ? mark.querySelectorAll('path').length : 0,
        name: (h1.querySelector('.fg-auth-name') || {}).textContent || '',
        // The old placeholder was a CSS ::before gradient square.
        legacyBefore: getComputedStyle(h1, '::before').content
      })
    }
    return out
  })
  expect(marks.length, 'both auth screens must exist').toBe(2)
  for (const mark of marks) {
    expect(mark.hasMark, `${mark.selector} must carry the mark`).toBeTruthy()
    expect(mark.hasDisc, `${mark.selector} mark must be the Telegram disc`).toBeTruthy()
    expect(mark.planePaths, `${mark.selector} must draw the paper plane`).toBeGreaterThanOrEqual(1)
    expect(mark.name).toBe('FileGram')
    expect(mark.legacyBefore, `${mark.selector} must not keep the placeholder square`).toBe('none')
  }
})

/* REGRESSION: the fill ran past the thumb. A plain percentage stop is wrong
 * because the thumb centre only travels between half a thumb from each end. */
test('slider fill boundary is computed at the thumb centre', async ({ page }) => {
  if (!await boot(page)) return
  const geometry = await page.evaluate(() => {
    const input = document.querySelector('#concurrency')
    if (!input) return null
    const min = Number(input.min || 1)
    const max = Number(input.max || 64)
    const ratio = (Number(input.value) - min) / (max - min)
    const style = getComputedStyle(input)
    return {
      ratioVar: style.getPropertyValue('--fg-range-ratio').trim(),
      expected: ratio.toFixed(5),
      stop: style.getPropertyValue('--fg-range-stop').trim(),
      thumb: style.getPropertyValue('--fg-range-thumb').trim()
    }
  })
  expect(geometry, 'the slider must exist').not.toBeNull()
  expect(geometry.ratioVar, 'the ratio must track the value').toBe(geometry.expected)
  expect(geometry.thumb, 'the thumb width must be declared for the inset maths').toBe('14px')
  /* The stop must subtract a whole thumb width and re-centre by half of one.
   * A plain percentage of the track runs ahead of the head. */
  expect(geometry.stop).toContain('100%')
  expect(geometry.stop, `stop expression was "${geometry.stop}"`).toMatch(/100%\s*-\s*(var\(--fg-range-thumb\)|14px)/)
  expect(geometry.stop).toMatch(/\/\s*2/)

  await page.locator('#concurrency').focus()
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(150)
  const moved = await page.evaluate(() => {
    const input = document.querySelector('#concurrency')
    const min = Number(input.min || 1)
    const max = Number(input.max || 64)
    return {
      ratioVar: getComputedStyle(input).getPropertyValue('--fg-range-ratio').trim(),
      expected: ((Number(input.value) - min) / (max - min)).toFixed(5)
    }
  })
  expect(moved.ratioVar).toBe(moved.expected)
})

/* REGRESSION: a programmatic assignment fires no input or change event.
 *
 * applyStatus writes the server's concurrency straight to .value inside a promise,
 * so the fill kept the markup default's geometry (value="16") while the thumb and
 * the readout showed the real number - blue painted far past the head. The
 * unbounded shell re-entry used to repaint constantly and hide this; once that was
 * fixed, the stale fill became visible. */
test('the slider fill survives a programmatic value change', async ({ page }) => {
  if (!await boot(page)) return
  const readRatio = () => page.evaluate(() => {
    const input = document.querySelector('#concurrency')
    const min = Number(input.min || 1)
    const max = Number(input.max || 64)
    return {
      published: getComputedStyle(input).getPropertyValue('--fg-range-ratio').trim(),
      expected: ((Number(input.value) - min) / (max - min)).toFixed(5),
      value: Number(input.value)
    }
  })

  const original = (await readRatio()).value
  for (const value of [32, 64, 1, 8]) {
    // Assign exactly the way applyStatus does: no event dispatched.
    await page.evaluate(next => { document.querySelector('#concurrency').value = next }, value)
    await page.waitForTimeout(120)
    const state = await readRatio()
    expect(state.value, 'the assignment must land').toBe(value)
    expect(state.published, `fill went stale at value ${value}`).toBe(state.expected)
  }

  // An attribute rewrite by another layer must also repaint.
  await page.evaluate(() => document.querySelector('#concurrency').setAttribute('max', '32'))
  await page.waitForTimeout(120)
  const afterMax = await readRatio()
  expect(afterMax.published, 'a max change must repaint the fill').toBe(afterMax.expected)

  await page.evaluate(value => {
    const input = document.querySelector('#concurrency')
    input.setAttribute('max', '64')
    input.value = value
  }, original)
  await page.keyboard.press('ArrowLeft')
  await page.waitForTimeout(400)
})

/* REGRESSION: forcing display:block on the fallback put the initial in the corner
 * of the 36px box, where border-radius + overflow:hidden clipped it away, leaving
 * an apparently empty coloured circle. */
test('header avatar initials are centred, not clipped into a corner', async ({ page }) => {
  if (!await boot(page)) return
  let checked = 0
  for (let index = 0; index < 6; index++) {
    const row = page.locator('#chat-list .chat-item:not([hidden])').nth(index)
    if (!await row.count()) break
    await row.click().catch(() => {})
    await page.waitForTimeout(1600)
    const avatar = await page.evaluate(() => {
      const host = document.querySelector('#fg-chat-avatar')
      const fallback = host && host.querySelector('.tele-final-avatar-fallback')
      const img = host && host.querySelector('img')
      if (!host || !fallback) return null
      const photoShown = !!(img && img.complete && img.naturalWidth > 0)
      if (photoShown) return { photoShown }
      const hostBox = host.getBoundingClientRect()
      const glyphBox = fallback.getBoundingClientRect()
      return {
        photoShown,
        title: ((document.querySelector('#chat-title') || {}).textContent || '').trim(),
        initials: (fallback.textContent || '').trim(),
        display: getComputedStyle(fallback).display,
        offsetX: Math.round((glyphBox.left + glyphBox.width / 2) - (hostBox.left + hostBox.width / 2)),
        offsetY: Math.round((glyphBox.top + glyphBox.height / 2) - (hostBox.top + hostBox.height / 2))
      }
    })
    if (!avatar || avatar.photoShown) continue
    checked++
    expect(avatar.initials.length, `"${avatar.title}" must show initials`).toBeGreaterThan(0)
    expect(avatar.display, 'the fallback must stay a centring grid').toBe('grid')
    // Centred on the circle, so the glyph cannot be clipped by the border radius.
    expect(Math.abs(avatar.offsetX), `"${avatar.title}" glyph is off-centre by ${avatar.offsetX}px`).toBeLessThanOrEqual(1)
    expect(Math.abs(avatar.offsetY), `"${avatar.title}" glyph is off-centre by ${avatar.offsetY}px`).toBeLessThanOrEqual(1)
  }
  if (!checked) {
    test.info().annotations.push({ type: 'note', description: 'every visible chat had a photo; initials centring not exercised' })
  }
})

/* Reading is tied to SEEING messages: opening into Files must not mark a chat read,
 * switching to Messages must, and a single user action must issue one request. */
test('mark-read is issued by the Messages tab, once', async ({ page }) => {
  if (!await boot(page)) return
  const result = await page.evaluate(async () => {
    const chat = (state.chats || [])[0]
    if (!chat) return null
    const calls = []
    const base = request
    request = function fileGramSpyRequest (type, payload) {
      if (type === 'mark-read') calls.push(String(payload && payload.chatId))
      return base(type, payload)
    }
    const wanted = String(chat.id)
    /* Re-resolve from state every time. guardUpsertChat replaces
     * state.chats[index] with a NEW object, so a captured reference goes stale and
     * writing unread onto it would silently do nothing. */
    const markUnread = () => {
      const live = (state.chats || []).find(entry => entry && String(entry.id) === wanted)
      if (live) live.unread = 3
      return !!live
    }
    try {
      // The chat must be ACTIVE: the guard resolves it from state.activeChatId, so
      // marking an unopened chat unread proves nothing.
      await openChat(chat.id)
      setView('files')
      await new Promise(resolve => setTimeout(resolve, 600))
      if (!markUnread()) return { skipped: 'chat vanished from state' }
      calls.length = 0

      setView('files')
      await new Promise(resolve => setTimeout(resolve, 800))
      const onFiles = calls.length

      markUnread()
      setView('messages')
      await new Promise(resolve => setTimeout(resolve, 1500))
      const onMessages = calls.length
      return { onFiles, onMessages, chatId: wanted, active: String(state.activeChatId) }
    } finally {
      request = base
    }
  })
  if (!result || result.skipped) return
  expect(result.active, 'the chat under test must be the active one').toBe(result.chatId)
  expect(result.onFiles, 'the Files tab must not mark a chat read').toBe(0)
  // Exactly one: openChat restores the view through setView, so both hooks can fire
  // for one action and the in-flight guard must collapse them.
  expect(result.onMessages, `Messages tab issued ${result.onMessages} mark-read requests`).toBe(1)
})

/* ==========================================================================
 * Shell lifecycle, profile identity, download list behaviour
 * ========================================================================== */

/* REGRESSION: the shell's final line was
 *   setTimeout(() => { fileGramShell(); ... }, 0)
 * inside the IIFE named fileGramShell, so the whole file re-entered itself once
 * per macrotask for ever. Each pass rebuilt `account` as empty (repainting the
 * placeholder over the real name), started another identity interval and settle()
 * chain, and grew the handleEvent/applyStatus/renderChats wrapper chains. */
test('the shell installs once and keeps identity outside its closure', async ({ page }) => {
  if (!await boot(page)) return
  const shell = await page.evaluate(() => ({
    installed: window.__fileGramShellInstalled === true,
    identityOnWindow: !!window.__fileGramAccount
  }))
  expect(shell.installed, 'the shell must record that it installed').toBeTruthy()
  expect(shell.identityOnWindow, 'identity must survive a re-execution of the file').toBeTruthy()

  // Wrapper chains must be stable. Unbounded re-entry re-wrapped these globals on
  // every tick, so their source text kept growing in nesting depth.
  const first = await page.evaluate(() => String(renderChats))
  await page.waitForTimeout(2500)
  const second = await page.evaluate(() => String(renderChats))
  expect(second, 'renderChats must not be re-wrapped over time').toBe(first)
})

test('the profile never falls back to the placeholder once identity is known', async ({ page }) => {
  if (!await boot(page)) return
  await page.waitForTimeout(4000)
  const known = await page.evaluate(() => {
    const account = window.__fileGramAccount
    return !!(account && (account.name || account.username))
  })
  if (!known) {
    test.info().annotations.push({ type: 'note', description: 'no identity payload available; placeholder check skipped' })
    return
  }
  const seen = new Set()
  for (let sample = 0; sample < 6; sample++) {
    seen.add(await page.evaluate(() => ((document.querySelector('#fg-account-name') || {}).textContent || '').trim()))
    await page.waitForTimeout(700)
  }
  expect([...seen], 'the neutral placeholder must never be painted over a real name')
    .not.toContain('Telegram account')
  expect([...seen], 'the name must not flicker between values').toHaveLength(1)

  const avatar = await page.evaluate(() => {
    const host = document.querySelector('#fg-account-avatar')
    const img = host && host.querySelector('img')
    const initials = host && host.querySelector('.fg-account-initials')
    return {
      photoShown: !!(img && img.complete && img.naturalWidth > 0),
      initials: (initials && initials.textContent || '').trim(),
      background: host ? getComputedStyle(host).backgroundColor : ''
    }
  })
  // Either a real photo, or a coloured disc with a glyph. The old bug produced
  // neither: an empty circle on the neutral surface colour.
  if (!avatar.photoShown) {
    expect(avatar.initials.length, 'a photo-less account must still show a glyph').toBeGreaterThan(0)
  }
})

/* REGRESSION: renderDownloadsNow rebuilt every row and swapped the list with
 * replaceChildren on each paint. #download-list is the scroll container, so
 * scrollHeight collapsed and the browser clamped scrollTop to 0 about ten times a
 * second, making the list impossible to scroll while anything was downloading. */
test('download list keeps scroll position and reuses rows across repaints', async ({ page }) => {
  if (!await boot(page)) return

  // Synthetic jobs: enough rows to scroll, and no real downloads triggered.
  await page.evaluate(() => {
    for (let index = 0; index < 40; index++) {
      state.downloads.set(`fg-test-${index}`, {
        jobId: `fg-test-${index}`,
        chatId: -1,
        chatTitle: 'Test',
        messageId: index,
        fileId: 90000 + index,
        fileName: `probe_${index}.mp4`,
        fileSize: 1000000,
        downloaded: 500000,
        status: 'downloading',
        error: null,
        destPath: null
      })
    }
    state.queueStats = {
      total: 40, queued: 0, downloading: 40, paused: 0, done: 0, error: 0, cancelled: 0,
      remaining: 40, speed: 0, downloadedBytes: 20000000, expectedBytes: 40000000, concurrency: 8
    }
    renderDownloads()
  })
  await page.waitForTimeout(700)

  const geometry = await page.evaluate(() => {
    const list = document.querySelector('#download-list')
    if (!list) return null
    return { rows: list.querySelectorAll('.djob').length, scrollHeight: list.scrollHeight, clientHeight: list.clientHeight }
  })
  expect(geometry, 'the download list must exist').not.toBeNull()
  expect(geometry.rows, 'the synthetic rows must render').toBeGreaterThan(10)

  if (geometry.scrollHeight <= geometry.clientHeight) {
    test.info().annotations.push({ type: 'note', description: 'list not scrollable at this viewport; scroll retention skipped' })
  } else {
    const result = await page.evaluate(async () => {
      const list = document.querySelector('#download-list')
      const first = list.querySelector('.djob')
      first.dataset.probeMark = 'kept'
      list.scrollTop = 120
      const readings = []
      // Force repaints while watching the scroll offset.
      for (let index = 0; index < 8; index++) {
        renderDownloads()
        await new Promise(resolve => setTimeout(resolve, 260))
        readings.push(list.scrollTop)
      }
      return {
        readings,
        rowSurvived: !!list.querySelector('[data-probe-mark="kept"]')
      }
    })
    expect(result.readings.every(value => value > 0),
      `scroll position was reset: ${result.readings.join(', ')}`).toBeTruthy()
    expect(result.rowSurvived, 'rows must be patched in place, not rebuilt').toBeTruthy()
  }

  await page.evaluate(() => {
    for (const key of [...state.downloads.keys()]) if (String(key).startsWith('fg-test-')) state.downloads.delete(key)
    state.queueStats = null
    renderDownloads()
  })
})

/* REGRESSION: "ETA 13772h 50m", "ETA 560780h 25m", "ETA 4.997042705591493e+33h 21m".
 * The speed EMA decayed geometrically without ever reaching zero, so `speed > 0`
 * stayed true and remaining/speed exploded; fmtEta had no upper clamp. */
test('ETA is clamped and never printed for a stalled transfer', async ({ page }) => {
  if (!await boot(page)) return

  const clamp = await page.evaluate(() => ({
    normal: fmtEta(90),
    hour: fmtEta(3700),
    absurd: fmtEta(4.9e37),
    huge: fmtEta(49570000),
    negative: fmtEta(-5),
    infinite: fmtEta(Infinity)
  }))
  expect(clamp.normal, 'a real estimate must still format').toBe('1m 30s')
  expect(clamp.hour).toMatch(/^1h/)
  expect(clamp.absurd, 'exponential notation must never reach the UI').toBe('')
  expect(clamp.huge, 'an implausible estimate must be withheld').toBe('')
  expect(clamp.negative).toBe('')
  expect(clamp.infinite).toBe('')

  // A job whose byte count never advances must settle to no speed and no ETA.
  await page.evaluate(() => {
    state.downloads.set('fg-stall-test', {
      jobId: 'fg-stall-test',
      chatId: -1,
      chatTitle: 'Test',
      messageId: 1,
      fileId: 99999,
      fileName: 'stalled.mp4',
      fileSize: 100000000,
      downloaded: 1000,
      status: 'downloading',
      error: null,
      destPath: null
    })
    renderDownloads()
  })
  // Repaint repeatedly without ever advancing `downloaded`.
  for (let index = 0; index < 10; index++) {
    await page.evaluate(() => renderDownloads())
    await page.waitForTimeout(260)
  }
  const stalled = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#download-list .djob')]
    const row = rows.find(node => (node.textContent || '').includes('stalled.mp4'))
    if (!row) return null
    return {
      text: (row.textContent || '').trim(),
      eta: [...row.querySelectorAll('.sub')].map(s => (s.textContent || '').trim()).find(t => t.startsWith('ETA')) || ''
    }
  })
  if (stalled) {
    expect(stalled.eta, `a stalled job published "${stalled.eta}"`).toBe('')
    expect(stalled.text).not.toMatch(/e\+/i)
    expect(stalled.text, 'no absurd hour count may appear').not.toMatch(/\d{3,}h/)
  }
  await page.evaluate(() => {
    state.downloads.delete('fg-stall-test')
    state.samples.delete('fg-stall-test')
    renderDownloads()
  })
})

/* Pixel-level truth for the slider fill.
 *
 * Computed style cannot answer this: Chromium serialises the
 * ::-webkit-slider-runnable-track background with its calc() unresolved, and the
 * INPUT's own background-image is legitimately `none` because the stylesheet makes
 * the input transparent. Reading the input's computed background is what made an
 * earlier diagnosis of this bug wrong. So the rendered pixels are sampled instead.
 */
test('the painted fill reaches the thumb and stops there', async ({ page }) => {
  if (!await boot(page)) return
  const slider = page.locator('#concurrency')
  if (!await slider.count()) {
    test.info().annotations.push({ type: 'note', description: 'slider not present; skipped' })
    return
  }

  const original = await page.evaluate(() => Number(document.querySelector('#concurrency').value))
  const failures = []

  for (const value of [1, 8, 16, 32, 48, 64]) {
    await page.evaluate(next => { document.querySelector('#concurrency').value = next }, value)
    await page.waitForTimeout(150)

    const geometry = await page.evaluate(() => {
      const input = document.querySelector('#concurrency')
      const min = Number(input.min || 1)
      const max = Number(input.max || 64)
      const width = input.getBoundingClientRect().width
      const ratio = (Number(input.value) - min) / (max - min)
      // The thumb centre only travels between half a thumb from each end.
      return { width, thumbCentre: ratio * (width - 14) + 7 }
    })

    const png = decodePng(await slider.screenshot())
    const row = Math.round(png.height / 2)
    const sample = x => (x >= 0 && x < png.width ? png.pixel(x, row) : null)

    /* BOTH sides are checked, 12px clear of the 7px-radius thumb.
     *
     * Checking only for overshoot is not enough: the thumb is painted in the same
     * accent colour, so a fill that collapsed to 7px still left "rightmost accent"
     * sitting at the thumb and looked fine. That is how an undershoot shipped. */
    const left = Math.round(geometry.thumbCentre - 12)
    const right = Math.round(geometry.thumbCentre + 12)

    const leftPixel = sample(left)
    if (leftPixel && !isNear(leftPixel, ACCENT)) {
      failures.push(`value ${value}: track left of the thumb (x=${left}) is not filled, got rgb(${leftPixel.join(',')})`)
    }
    const rightPixel = sample(right)
    if (rightPixel && isNear(rightPixel, ACCENT)) {
      failures.push(`value ${value}: fill overshoots past the thumb at x=${right}`)
    }

    // And the fill must run flush to the thumb rather than stopping short.
    let accentEnd = -1
    for (let x = 0; x < png.width; x++) {
      if (Math.abs(x - geometry.thumbCentre) <= 8) continue
      if (isNear(sample(x), ACCENT)) accentEnd = x
      else if (x > geometry.thumbCentre) break
    }
    const thumbBandStart = geometry.thumbCentre - 8
    if (accentEnd >= 0 && thumbBandStart > 2 && accentEnd < thumbBandStart - 3) {
      failures.push(`value ${value}: fill stops at x=${accentEnd}, ${(thumbBandStart - accentEnd).toFixed(1)}px short of the thumb`)
    }
  }

  await page.evaluate(value => { document.querySelector('#concurrency').value = value }, original)
  expect(failures, failures.join('; ')).toEqual([])
})

/* REGRESSION: the selection dock is absolutely positioned inside .chat, so it
 * painted on top of the relocated pager. The page nav was not merely obscured but
 * unreachable - a hit test at the centre of Next returned #mark-completed - so
 * paging was impossible whenever anything was selected.
 *
 * The pager was also rendering as two rows, putting the nav directly under the
 * dock: its DOM order is summary, page-size, nav but the assigned columns are
 * 1, 3, 2, and grid's sparse placement cursor never moves backwards. */
test('the selection dock never covers the page controls', async ({ page }) => {
  if (!await boot(page)) return

  const opened = await page.evaluate(async () => {
    const chats = (state.chats || []).filter(Boolean)
    if (!chats.length) return false
    // Multi-page paging is what this exercises, so take the fullest chat available.
    const chat = [...chats].sort((a, b) => Number(b.fileCount || 0) - Number(a.fileCount || 0))[0]
    await openChat(chat.id)
    setView('files')
    return true
  })
  if (!opened) {
    test.info().annotations.push({ type: 'note', description: 'no chat available; skipped' })
    return
  }
  await page.waitForTimeout(9000)

  const pagerPresent = await page.evaluate(() => {
    const pager = document.querySelector('#filegram-file-pager')
    return !!(pager && !pager.classList.contains('hidden'))
  })
  if (!pagerPresent) {
    test.info().annotations.push({ type: 'note', description: 'pager not shown for this chat; skipped' })
    return
  }

  // The pager must be a single row: summary, nav and page size all in row 1.
  const rows = await page.evaluate(() => {
    const pager = document.querySelector('#filegram-file-pager')
    const cell = selector => {
      const node = pager.querySelector(selector)
      return node ? getComputedStyle(node).gridRowStart : null
    }
    return {
      height: Math.round(pager.getBoundingClientRect().height),
      summary: cell('.filegram-page-summary'),
      nav: cell('.filegram-page-nav'),
      size: cell('.filegram-page-size')
    }
  })
  expect(rows.summary, 'the summary must sit in row 1').toBe('1')
  expect(rows.nav, 'the nav must share row 1, not wrap below').toBe('1')
  expect(rows.size, 'the page size must share row 1').toBe('1')

  const select = await page.evaluate(() => {
    const button = document.querySelector('#select-all-media')
    if (!button) return false
    button.click()
    return true
  })
  if (!select) {
    test.info().annotations.push({ type: 'note', description: 'no select-all control; skipped' })
    return
  }
  await page.waitForTimeout(2500)

  const geometry = await page.evaluate(() => {
    const dock = document.querySelector('#selection-bar')
    const nav = document.querySelector('#filegram-file-pager .filegram-page-nav')
    if (!dock || !nav || dock.classList.contains('hidden')) return null
    const dockRect = dock.getBoundingClientRect()
    const navRect = nav.getBoundingClientRect()
    return {
      overlapY: Math.min(navRect.bottom, dockRect.bottom) - Math.max(navRect.top, dockRect.top),
      overlapX: Math.min(navRect.right, dockRect.right) - Math.max(navRect.left, dockRect.left),
      chatReserved: getComputedStyle(document.querySelector('.chat')).paddingBottom,
      dockOpenClass: document.querySelector('.chat').classList.contains('fg-dock-open')
    }
  })
  if (!geometry) {
    test.info().annotations.push({ type: 'note', description: 'dock did not open; skipped' })
    return
  }

  expect(geometry.dockOpenClass, 'the chat column must reserve space for the dock').toBeTruthy()
  expect(parseFloat(geometry.chatReserved), 'the reserve must be a real amount').toBeGreaterThan(20)
  expect(geometry.overlapY <= 0 || geometry.overlapX <= 0,
    `dock overlaps the nav by ${geometry.overlapY}x${geometry.overlapX}px`).toBeTruthy()

  /* The decisive check: the nav buttons must be the topmost element at their own
   * centre. Geometry alone would not catch a transparent overlay. */
  const hits = await page.evaluate(() => {
    const out = {}
    for (const action of ['prev', 'next']) {
      const button = document.querySelector(`#filegram-file-pager [data-page-action="${action}"]`)
      if (!button) { out[action] = 'missing'; continue }
      const rect = button.getBoundingClientRect()
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      out[action] = !top ? 'nothing' : (button === top || button.contains(top) ? 'clickable' : `covered by #${top.id || top.className}`)
    }
    return out
  })
  expect(hits.next, `Next: ${hits.next}`).toBe('clickable')
  expect(hits.prev, `Previous: ${hits.prev}`).toBe('clickable')

  /* Paging must actually work with a selection active - but only assert it when
   * there is somewhere to page to. A single-page chat legitimately leaves Next
   * disabled, and the checks above are the point of this test. */
  const pages = await page.evaluate(() => {
    const total = document.querySelector('#filegram-file-pager .filegram-page-of')
    const match = /(\d[\d,]*)/.exec((total && total.textContent) || '')
    return match ? Number(match[1].replace(/,/g, '')) : 1
  })
  if (pages <= 1) {
    test.info().annotations.push({ type: 'note', description: `only ${pages} page; paging assertion skipped` })
    await page.evaluate(() => document.querySelector('#clear-selection')?.click())
    return
  }

  const paged = await page.evaluate(async () => {
    const input = document.querySelector('#filegram-file-pager input')
    const before = input ? input.value : null
    const next = document.querySelector('#filegram-file-pager [data-page-action="next"]')
    const disabled = next.disabled
    next.click()
    await new Promise(resolve => setTimeout(resolve, 3500))
    return { before, disabled, after: input ? input.value : null }
  })
  expect(paged.disabled, `Next is disabled despite ${pages} pages`).toBeFalsy()
  expect(paged.after, `paging did not advance from ${paged.before} (of ${pages} pages)`).not.toBe(paged.before)

  await page.evaluate(() => document.querySelector('#clear-selection')?.click())
})

/* REGRESSION: the download list re-sorted its visible window by status on every
 * paint. During a real batch, one file finishing and the next starting happens
 * several times a second, and each of those advances moved 101 of the 140 visible
 * rows, changed the top row, and let the browser's scroll anchoring drag scrollTop
 * from 600 to 1636 over twelve advances. Frames stayed at 60fps throughout, which
 * is why it read as "sluggish scrolling" rather than measuring slow. */
test('the download list holds its position while the queue advances', async ({ page }) => {
  if (!await boot(page)) return

  const seed = await page.evaluate(async () => {
    const total = 4000
    state.downloads.clear()
    state.samples.clear()
    const jobs = []
    for (let index = 0; index < total; index++) {
      let status
      if (index < 15) status = 'downloading'
      else if (index < 40) status = 'paused'
      else if (index % 7 === 0) status = 'done'
      else status = 'queued'
      const job = {
        jobId: `stable-${index}`,
        chatId: -1,
        chatTitle: 'Bench',
        messageId: index,
        fileId: 800000 + index,
        fileName: `photo_${index}.jpg`,
        fileSize: 250000,
        downloaded: status === 'done' ? 250000 : 60000,
        status,
        error: null,
        destPath: status === 'done' ? '/Bench/p.jpg' : null
      }
      state.downloads.set(job.jobId, job)
      jobs.push(job)
    }
    window.__benchJobs = jobs
    state.queueStats = {
      total, queued: total - 55, downloading: 15, paused: 25, done: 15, error: 0, cancelled: 0,
      remaining: total - 15, speed: 1500000, downloadedBytes: 1e8, expectedBytes: 1.5e9, concurrency: 15
    }
    renderDownloads()
    await new Promise(resolve => setTimeout(resolve, 500))
    const list = document.querySelector('#download-list')
    return { rows: list ? list.querySelectorAll('.djob').length : 0, scrollable: list ? list.scrollHeight > list.clientHeight : false }
  })
  expect(seed.rows, 'the synthetic queue must render rows').toBeGreaterThan(20)

  const result = await page.evaluate(async () => {
    const list = document.querySelector('#download-list')
    const order = () => [...list.querySelectorAll('.djob')].map(node => node.dataset.jobId)
    const jobs = window.__benchJobs

    list.scrollTop = Math.min(600, Math.max(0, list.scrollHeight - list.clientHeight - 10))
    const scrollBefore = list.scrollTop
    let previous = order()
    const firstBefore = previous[0]
    let moved = 0
    let topChanges = 0

    for (let pass = 0; pass < 10; pass++) {
      // The normal rhythm of a batch: one active job completes, one queued starts.
      const active = jobs.filter(job => job.status === 'downloading')
      if (active.length) {
        active[0].status = 'done'
        active[0].downloaded = active[0].fileSize
        handleEvent({ name: 'download-update', job: { ...active[0] } })
      }
      const next = jobs.find(job => job.status === 'queued')
      if (next) {
        next.status = 'downloading'
        handleEvent({ name: 'download-update', job: { ...next } })
      }
      await new Promise(resolve => setTimeout(resolve, 300))

      const current = order()
      for (let index = 0; index < Math.min(current.length, previous.length); index++) {
        if (current[index] !== previous[index]) moved++
      }
      if (current[0] !== previous[0]) topChanges++
      previous = current
    }

    return {
      moved,
      topChanges,
      firstBefore,
      firstAfter: previous[0],
      scrollBefore,
      scrollAfter: list.scrollTop,
      rows: previous.length
    }
  })

  // Rows may be substituted in place, but the window must not reshuffle.
  expect(result.moved, `${result.moved} row positions changed across 10 queue advances`).toBeLessThanOrEqual(12)
  expect(result.topChanges, 'the top row must not keep changing identity').toBeLessThanOrEqual(1)
  expect(Math.abs(result.scrollAfter - result.scrollBefore),
    `scroll drifted from ${result.scrollBefore} to ${result.scrollAfter} without user input`).toBeLessThanOrEqual(4)

  await page.evaluate(() => {
    delete window.__benchJobs
    state.downloads.clear()
    state.samples.clear()
    state.queueStats = null
    renderDownloads()
  })
})

/* The panel's totals must come from the server aggregate, not from the projection
 * this browser happens to hold: with a 22,000-job queue the browser only ever sees
 * about one concurrency window plus finished jobs. */
test('download totals come from the server aggregate', async ({ page }) => {
  if (!await boot(page)) return
  const out = await page.evaluate(async () => {
    state.downloads.clear()
    state.samples.clear()
    for (let index = 0; index < 200; index++) {
      state.downloads.set(`agg-${index}`, {
        jobId: `agg-${index}`, chatId: -1, chatTitle: 'S', messageId: index, fileId: index,
        fileName: `f_${index}.jpg`, fileSize: 1000, downloaded: 0, status: 'queued', error: null, destPath: null
      })
    }
    handleEvent({
      name: 'download-stats',
      stats: {
        total: 22479, queued: 22000, downloading: 10, paused: 5, done: 452, error: 7, cancelled: 5,
        remaining: 22015, speed: 0, downloadedBytes: 5e8, expectedBytes: 1e9, concurrency: 15
      }
    })
    await new Promise(resolve => setTimeout(resolve, 600))
    const tile = name => {
      const node = document.querySelector(`[data-stat="${name}"]`)
      return node ? node.textContent.trim() : null
    }
    return {
      line: (document.querySelector('#download-stats') || {}).textContent || '',
      total: tile('total'),
      remaining: tile('remaining'),
      current: tile('current')
    }
  })
  expect(out.total, 'Total must be the whole queue').toBe('22,479')
  expect(out.remaining).toBe('22,015')
  expect(out.current).toBe('10')
  expect(out.line, 'the summary must quote the aggregate').toContain('452/22479')
  expect(out.line, 'percentage must use the aggregate byte totals').toContain('50%')

  await page.evaluate(() => {
    state.downloads.clear()
    state.samples.clear()
    state.queueStats = null
    renderDownloads()
  })
})
