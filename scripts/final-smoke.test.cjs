'use strict'

const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')

const root = path.resolve(__dirname, '..')
const js = fs.readFileSync(path.join(root, 'public', 'daily-driver-final.js'), 'utf8')
const guard = fs.readFileSync(path.join(root, 'public', 'daily-driver-final-guard.js'), 'utf8')
const uiFix = fs.readFileSync(path.join(root, 'public', 'daily-driver-final-ui-fix.js'), 'utf8')
const css = fs.readFileSync(path.join(root, 'public', 'daily-driver-final.css'), 'utf8')
const guardCss = fs.readFileSync(path.join(root, 'public', 'daily-driver-final-guard.css'), 'utf8')
const uiFixCss = fs.readFileSync(path.join(root, 'public', 'daily-driver-final-ui-fix.css'), 'utf8')
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8')

assert.match(js, /handleEvent = function teleFinalHandleEvent/)
assert.match(js, /event\.name === 'media-index-progress'/)
assert.match(js, /rescueEnsureAllFiles = teleFinalEnsureFiles/)
// The 240-row grow-on-scroll renderer was removed: files-view.js owns renderFiles
// with real 100-per-page pagination and must not be shadowed by a second
// windowed renderer. buildGridCard ownership stays here.
assert.doesNotMatch(js, /renderFiles = teleFinalRenderFiles/)
assert.doesNotMatch(js, /teleFinalRenderFiles/)
assert.match(js, /buildGridCard = teleFinalBuildGridCard/)
assert.match(js, /rescuePreviewFile = teleFinalOpenPreview/)
assert.match(js, /teleP1RenderDedupeReport = function teleFinalRenderDedupeReport/)
assert.match(js, /renderChats = teleFinalRenderChats/)
assert.match(js, /teleP0v2ReadIndex/)
assert.match(js, /teleP0v2WriteIndex/)
assert.match(js, /rescueDownloadedMarks/)
assert.match(js, /rescueForwardedMarks/)
assert.match(js, /Continue with/)
assert.doesNotMatch(js, /\+ .*more duplicate/)

assert.match(guard, /request = function teleGuardRequest/)
assert.match(guard, /tele-file-index-high-water-v1/)
assert.match(guard, /protectedByClientCache/)
assert.match(guard, /force: round === 0 \? !!payload\.force : true/)
assert.match(guard, /renderChats = guardRenderChats/)
assert.match(guard, /handleEvent = function teleFinalGuardHandleEvent/)
assert.match(guard, /event\.name === 'media-index-progress'/)
assert.match(guard, /event\.name === 'chat-upsert'/)
assert.match(guard, /guardMemorySnapshot\(state\.activeChatId\)/)

assert.match(uiFix, /renderChats = teleUiRenderChats/)
// The virtual files renderer was removed. It padded the scroll surface with
// spacers sized for the whole index while its re-windowing scroll listener was
// dead, so the Files list scrolled far past its rows into blank space. This layer
// must not render files or bind grid scroll handlers any more.
assert.doesNotMatch(uiFix, /renderFilesVirtual/)
assert.doesNotMatch(uiFix, /tele-ui-virtual-spacer/)
assert.doesNotMatch(uiFix, /addEventListener\('scroll'/)
assert.match(uiFix, /teleP1RenderDedupeReport = function teleUiRenderDedupeReport/)
assert.match(uiFix, /upsertDownload = function teleUiUpsertDownload/)
/* The global entry point must be the THROTTLED wrapper, not renderDownloadsNow.
 * app.js answers the 200ms download-stats broadcast by calling renderDownloads()
 * directly, so binding it to the immediate painter bypassed the coalescer and
 * drove ~10 full repaints a second. */
assert.match(uiFix, /renderDownloads = function teleUiRenderDownloads/)
assert.match(uiFix, /teleUiRenderDownloads \(\) \{ scheduleDownloads\(false\) \}/)
// The rAF that used to be asserted here drove the virtual files scroll handler,
// which is gone. Download painting is still throttled, which is the property
// worth pinning.
assert.match(uiFix, /DOWNLOAD_PAINT_MS/)
assert.match(uiFix, /function scheduleDownloads/)

/* The download list must be reconciled in place, never cleared. #download-list is
 * the scroll container, so replaceChildren collapsed scrollHeight and the browser
 * clamped scrollTop to 0 on every paint, making the list unscrollable while
 * anything was downloading. */
assert.doesNotMatch(uiFix, /list\.replaceChildren/)
assert.match(uiFix, /node\.dataset\.jobId/)
assert.match(uiFix, /list\.insertBefore\(node/)
assert.match(uiFix, /function actionsSignature/)

/* Speed must snap to a hard zero when a transfer stops. The EMA decays
 * geometrically and never reaches zero, so a stalled job kept a denormal speed
 * alive, every `speed > 0` guard stayed true and remaining/speed exploded into
 * "ETA 4.99e+33h". */
assert.match(uiFix, /SPEED_FLOOR/)
assert.match(uiFix, /STALL_AFTER_MS/)
assert.match(uiFix, /sample\.speed = 0/)
assert.match(uiFix, /tele-ui-kind-icon/)
assert.doesNotMatch(uiFix, /MutationObserver/)

assert.match(css, /#chat-list[\s\S]*overflow-x: hidden/)
assert.match(css, /#media-grid \.gthumb video/)
assert.match(css, /\.tele-final-preview/)
assert.match(css, /\.tele-final-dedupe-list/)
assert.match(css, /grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/)

assert.match(guardCss, /height: min\(70vh, 640px\)/)
assert.match(guardCss, /grid-template-columns: 28px minmax\(0, 1fr\)/)
assert.match(guardCss, /tele-dedupe-row-main strong/)
assert.match(guardCss, /#media-grid \.gthumb video/)

assert.match(uiFixCss, /#tele-dedupe-body \.tele-dedupe-validation/)
assert.match(uiFixCss, /all: unset/)
assert.match(uiFixCss, /grid-template-columns: 32px minmax\(0, 1fr\)/)
assert.match(uiFixCss, /tele-ui-dedupe-copy/)
assert.match(uiFixCss, /tele-ui-kind-icon/)
assert.match(uiFixCss, /min-width: 0 !important/)
assert.match(uiFixCss, /#download-stats/)

assert.match(html, /daily-driver-final\.css\?v=2/)
assert.match(html, /daily-driver-final-guard\.css\?v=2/)
assert.match(html, /daily-driver-final-ui-fix\.css\?v=2/)
assert.match(html, /daily-driver-final\.js\?v=2/)
assert.match(html, /daily-driver-final-guard\.js\?v=3/)
assert.match(html, /daily-driver-final-ui-fix\.js\?v=2/)
assert.ok(html.indexOf('daily-driver-final.js?v=2') > html.indexOf('daily-driver-p2.js?v=1'), 'final runtime must load after P2')
assert.ok(html.indexOf('daily-driver-final-guard.css?v=2') > html.indexOf('daily-driver-final.css?v=2'), 'guard CSS must load after final CSS')
assert.ok(html.indexOf('daily-driver-final-ui-fix.css?v=2') > html.indexOf('daily-driver-final-guard.css?v=2'), 'UI fix CSS must load last')
assert.ok(html.indexOf('daily-driver-final-guard.js?v=3') > html.indexOf('daily-driver-final.js?v=2'), 'final guard must load after final runtime')
assert.ok(html.indexOf('daily-driver-final-ui-fix.js?v=2') > html.indexOf('daily-driver-final-guard.js?v=3'), 'UI fix JS must load last')

console.log('final smoke checks passed')
