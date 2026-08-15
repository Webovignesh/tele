'use strict'

/* Ownership invariants for the Files subsystem.
 *
 * These guard the two failure modes that kept coming back:
 *   1. a partial or short scan snapshot lowering the AUTHORITATIVE TOTAL;
 *   2. a superseded renderer painting into #media-grid, which reintroduced
 *      virtual/infinite scroll geometry underneath a paged view.
 *
 * Observable DOM behaviour is covered in tests/visual-check.spec.js; this file
 * pins the source-level contracts that make that behaviour possible.
 */

const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')

const root = path.resolve(__dirname, '..')
const read = name => fs.readFileSync(path.join(root, 'public', name), 'utf8')

const stability = read('files-stability.js')
const filesView = read('files-view.js')
const p0 = read('daily-driver-p0-v2.js')
const final = read('daily-driver-final.js')
const uiFix = read('daily-driver-final-ui-fix.js')
const guard = read('daily-driver-final-guard.js')
const app = read('app.js')
const rescue = read('rescue-runtime.js')
const daily = read('telegram-daily-driver.js')
const shell = read('filegram-shell.js')
const html = read('index.html')
const uiCss = read('filegram-ui.css')
const baseCss = read('style.css')
const stabilityCss = read('stability.css')

/* ------------------------------------------------------------------ */
/* 1. The authoritative total has exactly one owner and cannot shrink  */
/* ------------------------------------------------------------------ */

assert.match(stability, /function ownCountLabel/, 'the index owner must claim the count label symbols')
assert.match(stability, /updateMediaCountLabel = paint/, 'updateMediaCountLabel must be owned by the index layer')
assert.match(stability, /rescueUpdateMediaLabel = paint/, 'rescueUpdateMediaLabel must be owned by the index layer')
assert.match(stability, /ownCountLabel\(\)/, 'ownCountLabel must actually be installed')
assert.match(stability, /function totalFloor/, 'a durable total floor must exist')
assert.match(stability, /function rememberTotalFloor/, 'the floor must be recorded as the total grows')
assert.match(stability, /Math\.max\(measured, totalFloor\(chatId\)\)/, 'the header total must be raised to the floor')
assert.match(stability, /snapshot\.items\.length >= totalFloor\(chatId\)/, 'completeness must be size aware, not flag-only')
assert.match(stability, /function clearTotalFloor/, 'a hard refresh must be able to drop the floor')

// The count label must not be reassigned after this layer takes it. Any later
// assignment would silently restore the old partial-reading writer.
const lateOwners = [
  ['daily-driver-final-guard.js', guard],
  ['daily-driver-final-ui-fix.js', uiFix],
  ['filegram-shell.js', shell]
]
for (const [name, source] of lateOwners) {
  if (name === 'daily-driver-final-guard.js') continue // loads BEFORE files-stability.js
  assert.doesNotMatch(source, /^\s*updateMediaCountLabel\s*=/m, `${name} must not take over the count label`)
  assert.doesNotMatch(source, /^\s*rescueUpdateMediaLabel\s*=/m, `${name} must not take over the count label`)
}

// The persistent index must be monotonic unless a shrink is explicitly allowed.
assert.match(p0, /async function teleP0v2WriteIndex \(chatId, snapshot, options = \{\}\)/, 'the persistent write must accept options')
assert.match(p0, /options\.allowShrink/, 'shrinking the persistent index must be opt-in')
assert.match(p0, /if \(storedCount > snapshot\.items\.length\) return/, 'a smaller snapshot must not overwrite a larger stored index')

/* Filtered and page counts must stay out of the header. The pager owns them. */
assert.match(filesView, /filegram-page-summary/, 'the pager owns the filtered/page summary')
assert.doesNotMatch(filesView, /#chat-media-count/, 'the Files view must never write the header total')

/* ------------------------------------------------------------------ */
/* 2. Pagination: one page of at most PAGE_SIZE rows, no virtual geometry */
/* ------------------------------------------------------------------ */

assert.match(filesView, /const PAGE_SIZE = 100/, 'the page size must remain 100')
assert.match(filesView, /start \+ PAGE_SIZE/, 'the render must slice exactly one page')
assert.match(filesView, /grid\.scrollTop = 0/, 'a page change must reset scroll to the top')
assert.match(filesView, /function gridMatchesPage/, 'the paged view must detect foreign DOM and repaint')
assert.match(filesView, /gridMatchesPage\(items, page\)/, 'the early return must verify the mounted page')

/* No layer may keep a synthetic scroll surface for the whole index. */
for (const [name, source] of [['daily-driver-final-ui-fix.js', uiFix], ['daily-driver-final.js', final], ['rescue-runtime.js', rescue], ['files-view.js', filesView], ['app.js', app]]) {
  assert.doesNotMatch(source, /tele-ui-virtual-spacer/, `${name} must not create virtual scroll spacers`)
  assert.doesNotMatch(source, /renderFilesVirtual/, `${name} must not reference the virtual files renderer`)
}
assert.doesNotMatch(uiFix, /function spacer/, 'the spacer factory must be gone')
// No layer may compute a scroll height. The grid's height must come only from the
// rows actually mounted, which is what makes the page bottom the real bottom.
// rescue-runtime.js is excluded: its only style.height is the message composer
// textarea auto-grow, which has nothing to do with the files grid.
for (const [name, source] of [['daily-driver-final-ui-fix.js', uiFix], ['daily-driver-final.js', final], ['files-view.js', filesView]]) {
  assert.doesNotMatch(source, /style\.height = /, `${name} must not set synthetic element heights in the files grid`)
}
assert.doesNotMatch(final, /teleFinalRenderFiles/, 'the 240-row growing renderer must be gone')
assert.doesNotMatch(final, /TELE_FINAL_PAGE_SIZE/, 'the 240-row window constant must be gone')
assert.doesNotMatch(rescue, /rescueFastFileRender/, 'the 600-row growing renderer must be gone')
assert.doesNotMatch(rescue, /rescueFileRenderLimit/, 'the grow-on-scroll limit must be gone')
assert.doesNotMatch(stabilityCss, /tele-ui-virtual-spacer/, 'spacer CSS must be gone')
assert.doesNotMatch(uiCss, /tele-ui-virtual-spacer/, 'spacer CSS must be gone')

/* No layer may append more files to the grid as the user scrolls. */
assert.doesNotMatch(app, /#media-grid'\)\.addEventListener\('scroll'/, 'app.js must not keep an infinite-scroll listener on the files grid')
assert.doesNotMatch(final, /teleFinalGrid\.addEventListener\('scroll'/, 'the 240-row scroll listener must be gone')
assert.doesNotMatch(rescue, /rescueFileGridForWindow/, 'the rescue scroll-growth listener must be gone')

/* files-view remains the sole renderFiles owner and the last word on the grid. */
assert.match(filesView, /renderFiles = function fileGramRenderFilesPage/, 'files-view.js must own renderFiles')

/* ------------------------------------------------------------------ */
/* 3. Drag selection is completely gone                                */
/* ------------------------------------------------------------------ */

const dragSymbols = [
  'startDragSelect', 'onDragSelectMove', 'onDragSelectEnd', 'dragTick', 'updateBand',
  'dragSel', 'dragJustEnded', 'suppressClickUntil', 'applyDragRange', 'moveDrag',
  'endDrag', 'startDrag', 'cardIndexFromPoint', 'rowIndexAtY'
]
for (const [name, source] of [['app.js', app], ['files-view.js', filesView], ['rescue-runtime.js', rescue], ['telegram-daily-driver.js', daily], ['daily-driver-final.js', final], ['daily-driver-final-ui-fix.js', uiFix]]) {
  for (const symbol of dragSymbols) {
    assert.doesNotMatch(source, new RegExp(`\\b${symbol}\\b`), `${name} must not reference drag symbol ${symbol}`)
  }
}
assert.doesNotMatch(app, /marquee/, 'the marquee overlay must be gone')
assert.doesNotMatch(baseCss, /\.marquee/, 'marquee CSS must be gone')
assert.doesNotMatch(uiCss, /\.marquee/, 'marquee CSS must be gone')
assert.doesNotMatch(baseCss, /\.drag-hint/, 'drag hint CSS must be gone')
assert.doesNotMatch(uiCss, /\.drag-hint/, 'drag hint CSS must be gone')
assert.doesNotMatch(html, /drag-hint/, 'the "Drag to select" hint must be gone from the markup')
assert.doesNotMatch(html, /Drag to select/, 'the "Drag to select" copy must be gone')
assert.doesNotMatch(shell, /dragHint/, 'the shell must not hide a hint that no longer exists')

/* Checkbox, Select all and range selection must survive. */
assert.match(app, /function makeCheckbox/, 'checkbox selection must remain')
assert.match(app, /function selectAllMedia/, 'Select all must remain')
assert.match(app, /function applyCardUI/, 'card selection painting must remain')
assert.match(rescue, /function rescueSelectFileRange/, 'numeric range selection must remain')
assert.match(filesView, /function selectGlobalRange/, 'shift-click range selection must remain')
assert.match(filesView, /event\.shiftKey/, 'shift-click must remain wired')

console.log('files invariants checks passed')
