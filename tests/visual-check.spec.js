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
    const field = document.querySelector('#dl-dir')
    if (!card || !label || !field) return null
    const cb = card.getBoundingClientRect()
    return {
      cardLeft: Math.round(cb.left),
      cardRight: Math.round(cb.right),
      labelLeft: Math.round(label.getBoundingClientRect().left),
      fieldLeft: Math.round(field.getBoundingClientRect().left),
      gap: Math.round(label.getBoundingClientRect().top - cb.bottom)
    }
  })
  expect(layout, 'the stats card and Save to row must exist').not.toBeNull()
  // The card used to carry its own 14px side margin on top of .dl-controls'
  // padding, so it sat indented relative to the controls beneath it.
  expect(layout.cardLeft, 'the card must share the controls left edge').toBe(layout.labelLeft)
  expect(layout.cardLeft, 'the card must line up with the path field').toBe(layout.fieldLeft)
  expect(layout.gap, `only ${layout.gap}px between the stats card and "Save to"`).toBeGreaterThanOrEqual(10)
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


test('Save to and Parallel files labels share a left edge', async ({ page }) => {
  if (!await boot(page)) return
  const labels = await page.evaluate(() => {
    const out = []
    for (const conc of document.querySelectorAll('.dl-controls .conc')) {
      const span = conc.querySelector('span')
      if (!span) continue
      const cs = getComputedStyle(span)
      out.push({
        text: (span.textContent || '').trim(),
        left: Math.round(span.getBoundingClientRect().left),
        alignSelf: cs.alignSelf,
        textAlign: cs.textAlign
      })
    }
    return out
  })
  expect(labels.length, 'both control sections must be present').toBeGreaterThanOrEqual(2)
  // Neither label may be centred over the panel.
  for (const label of labels) {
    expect(label.alignSelf, `"${label.text}" must be left aligned, not centred`).toBe('flex-start')
  }
  const lefts = [...new Set(labels.map(l => l.left))]
  expect(lefts.length, `labels must share one left edge, got ${JSON.stringify(labels.map(l => [l.text, l.left]))}`).toBe(1)
})

test('Save to path is one line with a full-path tooltip and a matching Browse button', async ({ page }) => {
  if (!await boot(page)) return
  const row = await page.evaluate(() => {
    const input = document.querySelector('#dl-dir')
    const button = document.querySelector('#set-dir')
    const duplicate = document.querySelector('#dl-dir-current')
    if (!input || !button) return null
    const ib = input.getBoundingClientRect()
    const bb = button.getBoundingClientRect()
    return {
      value: input.value,
      title: input.title,
      inputHeight: Math.round(ib.height),
      buttonHeight: Math.round(bb.height),
      sameRow: Math.abs(ib.top - bb.top) <= 1,
      noOverlap: bb.left >= ib.right - 1,
      duplicateVisible: duplicate ? getComputedStyle(duplicate).display !== 'none' : false,
      buttonText: (button.textContent || '').trim()
    }
  })
  expect(row, 'the Save to row must exist').not.toBeNull()
  expect(row.inputHeight, 'Browse must match the path field height').toBe(row.buttonHeight)
  expect(row.sameRow, 'the path field and Browse must sit on one line').toBeTruthy()
  expect(row.noOverlap, 'Browse must not overlap the path field').toBeTruthy()
  expect(row.duplicateVisible, 'the duplicated path line must stay hidden').toBeFalsy()
  if (row.value) expect(row.title, 'the full path must be available as a tooltip').toBe(row.value)
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
    const cs = getComputedStyle(input)
    const min = Number(input.min || 1)
    const max = Number(input.max || 64)
    const ratio = (Number(input.value) - min) / (max - min)
    return {
      ratioVar: cs.getPropertyValue('--fg-range-ratio').trim(),
      expected: ratio.toFixed(5),
      stop: cs.getPropertyValue('--fg-range-stop').trim(),
      thumb: cs.getPropertyValue('--fg-range-thumb').trim()
    }
  })
  expect(geometry, 'the slider must exist').not.toBeNull()
  expect(geometry.ratioVar, 'the ratio must track the value').toBe(geometry.expected)
  expect(geometry.thumb, 'the thumb width must be declared for the inset maths').toBe('14px')
  // The stop must subtract a thumb width and re-centre by half of one, otherwise
  // the painted fill overshoots the head.
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
