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

/* Comments must not satisfy or break an assertion. Several deletions below leave a
 * comment explaining what was removed and why, and those comments necessarily name the
 * removed code. Everything asserted by ABSENCE is checked against comment-stripped
 * source; presence checks read the raw text. */
const stripComments = source => source
  .split('\n')
  .filter(line => {
    const trimmed = line.trim()
    return !(trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*/') || trimmed.startsWith('*'))
  })
  .join('\n')

const jsCode = stripComments(js)
const guardCode = stripComments(guard)
const uiFixCode = stripComments(uiFix)
const owner = fs.readFileSync(path.join(root, 'public', 'files-stability.js'), 'utf8')

assert.match(js, /handleEvent = function teleFinalHandleEvent/)
/* INVERTED. This layer used to handle `media-index-progress` (via
 * `teleFinalMergePartial`) and to own `rescueEnsureAllFiles`. Both are the other end of
 * the re-inflation chain that kept chat TEST at 22 files after the owner had already
 * reconciled it to zero:
 *
 *   teleFinalEnsureFiles -> request('scan-media-v3') -> the guard substitutes the stale 22
 *     -> teleFinalApplySnapshot -> shared cache, state.mediaCount, IndexedDB, header
 *
 * The record went 0 -> 22 through the monotonic boundary, because growth was never the
 * case that guard refused. Called out in the task 7/8/9 evidence. */
assert.doesNotMatch(jsCode, /media-index-progress/, 'only the Files index owner may handle the progress stream')
assert.doesNotMatch(jsCode, /teleFinalApplySnapshot|teleFinalRestorePersistent|teleFinalEnsureFiles|teleFinalMergePartial/, 'this layer must not own index commit, restore or discovery')
assert.doesNotMatch(jsCode, /rescueFileCache\.set/, 'the Files index owner must be the only writer of the shared cache')
assert.match(owner, /rescueEnsureAllFiles = ensure/, 'the owner must own rescueEnsureAllFiles')
// The 240-row grow-on-scroll renderer was removed: files-view.js owns renderFiles
// with real 100-per-page pagination and must not be shadowed by a second
// windowed renderer. buildGridCard ownership stays here.
assert.doesNotMatch(js, /renderFiles = teleFinalRenderFiles/)
assert.doesNotMatch(js, /teleFinalRenderFiles/)
assert.match(js, /buildGridCard = teleFinalBuildGridCard/)
assert.match(js, /rescuePreviewFile = teleFinalOpenPreview/)
assert.match(js, /teleP1RenderDedupeReport = function teleFinalRenderDedupeReport/)
assert.match(js, /renderChats = teleFinalRenderChats/)
/* INVERTED with the rest: the legacy persistence boundary is gone and this layer must not
 * reach for one. The owner's `writePersistent` is unconditional and has exactly two
 * callers, which scripts/files-reconcile.test.cjs asserts. */
assert.doesNotMatch(jsCode, /teleP0v2ReadIndex|teleP0v2WriteIndex/, 'this layer must not read or write the persistent index')
assert.match(js, /rescueDownloadedMarks/)
assert.match(js, /rescueForwardedMarks/)
assert.match(js, /Continue with/)
assert.doesNotMatch(js, /\+ .*more duplicate/)

/* THE THREE ASSERTIONS BELOW WERE THE MOST DAMAGING IN THE WHOLE SUITE, and they are
 * inverted.
 *
 *   assert.match(guard, /request = function teleGuardRequest/)
 *   assert.match(guard, /protectedByClientCache/)
 *   assert.match(guard, /force: round === 0 \? !!payload\.force : true/)
 *
 * Together they required the interception that substituted a stale client cache for
 * Telegram's answer to EXIST. `guardStableMediaScan` replaced the global `request`, ran
 * `scan-media-v3` up to five times, and when every truthful result came back below a
 * client-side floor returned `guardSnapshotAsResponse(known)` stamped
 * `done: true, fromCache: true, protectedByClientCache: true`. Measured on the running
 * app for chat TEST: the server answered `found=0 items=0` three times on the wire while
 * the caller received 22 rows. `hardRefresh` could not escape it either.
 *
 * So `npm run verify` was green precisely because Telegram truth was being discarded.
 * The protection that interception was standing in for now lives where the decision is
 * made: `commitDiscovery` unions and cannot lower a count, `commitAuthoritative` is
 * reachable only from a complete truth pass. Called out in the task 7/8/9 evidence. */
assert.doesNotMatch(guardCode, /request = function/, 'no layer may intercept the transport and substitute a cached scan result')
assert.doesNotMatch(guardCode, /protectedByClientCache/, 'no client cache may present itself as a completed scan')
assert.doesNotMatch(guardCode, /guardStableMediaScan|guardSnapshotAsResponse|guardBestKnownSnapshot|guardScanShape/, 'the client-cache substitution must be absent, not dormant')
assert.doesNotMatch(guardCode, /tele-file-index-high-water-v1/, 'the guard must not keep a second durable total floor')
assert.doesNotMatch(guardCode, /guardRememberHighWater|guardHighWaterCount\(/, 'the guard must not read or write a floor of its own')
assert.doesNotMatch(guardCode, /media-index-progress/, 'only the Files index owner may handle the progress stream')
/* The count-label takeover is gone too: `guardUpdateMediaLabel` painted the header,
 * Download all and Select all from the shared cache that every legacy layer writes. */
assert.doesNotMatch(guardCode, /guardUpdateMediaLabel/, 'the count label must be painted by its owner')
assert.match(owner, /function ownCountLabel/, 'the owner must own the count label symbols')
assert.match(guard, /renderChats = guardRenderChats/)
assert.match(guard, /handleEvent = function teleFinalGuardHandleEvent/)
assert.match(guard, /event\.name === 'chat-upsert'/)
/* KEPT: the load-state smoothing, which is presentational. It now asks the owner whether
 * a snapshot exists instead of reading the shared cache directly. */
assert.match(guard, /setLoadState = function teleGuardSetLoadState/)
assert.match(guard, /guardOwnedSnapshot\(state\.activeChatId\)/)

assert.match(uiFix, /renderChats = teleUiRenderChats/)
/* A third private copy of the index lived in this layer. `currentCanonical` merged its
 * own map with the shared cache whenever the shared cache was LARGER, and `paintCanonical`
 * wrote the merged result back to both the shared cache and IndexedDB - so a stale row
 * surviving in either place was copied into the other and made durable, and the merge only
 * ever grew. */
assert.doesNotMatch(uiFixCode, /canonicalIndexes|paintCanonical|restoreCanonical|mergeIndexes|robustEnsureFiles|mergeProgressBatch/, 'this layer must not keep its own copy of the Files index')
assert.doesNotMatch(uiFixCode, /media-index-progress/, 'only the Files index owner may handle the progress stream')
assert.doesNotMatch(uiFixCode, /rescueFileCache\.set|teleP0v2WriteIndex/, 'the Files index owner must be the only writer')
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
