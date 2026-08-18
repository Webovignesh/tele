'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')

const html = fs.readFileSync('public/index.html', 'utf8')
const p1 = fs.readFileSync('public/daily-driver-p1.js', 'utf8')
const p1Css = fs.readFileSync('public/daily-driver-p1.css', 'utf8')
const server = fs.readFileSync('server.js', 'utf8')
const rescue = fs.readFileSync('public/rescue-runtime.js', 'utf8')
const management = fs.readFileSync('public/management.js', 'utf8')
const compatSource = fs.readFileSync('tdl-upload-compat.js', 'utf8')
const dedupeSource = fs.readFileSync('download-dedupe-preload.js', 'utf8')
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))

/* Comments must not satisfy or break an assertion: the deletions this fix makes leave
 * comments naming the removed code, so checks by ABSENCE read comment-stripped source. */
const stripComments = source => source
  .split('\n')
  .filter(line => {
    const trimmed = line.trim()
    return !(trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*/') || trimmed.startsWith('*'))
  })
  .join('\n')
const p1Code = stripComments(p1)

assert.match(html, /daily-driver-p1\.js/, 'P1 runtime must load last')
assert.match(html, /daily-driver-p1\.css/, 'P1 stylesheet must be active')
assert.match(p1, /teleP1BeginLatestPin/, 'chat opening must pin the message viewport to the latest message')
assert.match(p1, /panel\.scrollTop = panel\.scrollHeight/, 'latest-message pin must scroll to the bottom')
assert.match(p1, /wheel[^]*teleP1UserTouchedMessages = true/, 'manual user scrolling must cancel latest-message pinning')
/* INVERTED, and the requirements moved rather than dropped.
 *
 * These four required P1 to OWN progressive file-index reconciliation, to throttle its
 * own file paints, and to restore from and persist to the legacy IndexedDB boundary.
 * Four layers claimed that ownership simultaneously, each swallowing
 * `media-index-progress` without calling the base chain, which is what made the visible
 * count fluctuate and what let a partial batch reach storage.
 *
 * `public/files-stability.js` owns the stream, and it still batches (PROGRESS_FLUSH_MS
 * 350, PROGRESS_FLUSH_ITEMS 800) and still persists a completed index - the properties
 * are asserted against the owner. Called out in the task 7/8/9 evidence. */
const p1Owner = fs.readFileSync('public/files-stability.js', 'utf8')
assert.doesNotMatch(p1Code, /media-index-progress/, 'only the Files index owner may handle the progress stream')
assert.doesNotMatch(p1Code, /teleP0v2ReadIndex|teleP0v2WriteIndex/, 'this layer must not read or write the persistent index')
assert.doesNotMatch(p1Code, /rescueFileCache\.set/, 'the Files index owner must be the only writer of the shared cache')
assert.match(p1Owner, /event\.name === 'media-index-progress'/, 'the owner must handle the progress stream')
assert.match(p1Owner, /PROGRESS_FLUSH_MS = 350/, 'progress flushing must stay throttled')
assert.match(p1Owner, /PROGRESS_FLUSH_ITEMS = 800/, 'progress flushing must stay batched by item count')
assert.match(p1Owner, /async function writePersistent/, 'completed file indexes must still persist, from the owner')
assert.match(p1, /IntersectionObserver/, 'file thumbnails must load near the viewport instead of eagerly')
assert.match(p1, /teleP1ThumbInflight/, 'thumbnail requests must be deduplicated')
assert.match(p1, /video\.preload = 'none'/, 'message videos must not start metadata downloads eagerly')
assert.match(p1Css, /#mg-downloads-pane \.dl-controls/, 'downloads drawer must use the P1 flat layout')
/* INVERTED, and this pair is the one that mattered most.
 *
 * `grid-template-columns: minmax(0, 1fr) 54px` reserved a 54px track for the Save-to
 * button, and the companion rule `#mg-downloads-pane #set-dir { width: 54px !important }`
 * filled it. At two ID selectors that rule outranked all three injected
 * `width: 100% !important` overrides, so the control computed 54px inside a 361px row and
 * rendered as `[icon] SAV...` over `F:...`. This suite required both to exist, which is
 * why editing the JS layers could never fix the render. `.dir-current { display: none }`
 * hid the duplicate path line rather than removing it, which is the "hidden legacy
 * control" clause 2.20 objects to.
 *
 * Both are deleted. `public/filegram-ui.css` styles one full-width control, and
 * `#dl-dir-current` no longer exists to hide. Called out in the task 7/8/9 evidence. */
const p1CssCode = p1Css.replace(/\/\*[\s\S]*?\*\//g, ' ')
assert.doesNotMatch(p1CssCode, /54px/, 'the 54px Save-to rule and its grid track must be gone, not overridden')
assert.doesNotMatch(p1CssCode, /dir-current/, 'the duplicate download path card must be removed from the markup, not hidden')
assert.doesNotMatch(p1CssCode, /#set-dir|#dl-dir/, 'only filegram-ui.css may style the Save-to control')

assert.match(p1, /download-dedupe-preview/, 'download selected must run a dedupe preflight before queueing')
assert.match(p1, /Exact filename \+ exact size/, 'dedupe report must explain the two-factor duplicate validation')
assert.match(p1, /uniqueMessageIds/, 'dedupe report must queue only unique selected messages')
assert.match(p1Css, /tele-dedupe-dialog/, 'dedupe report must have a dedicated confirmation surface')
assert.match(dedupeSource, /signatureFor/, 'dedupe scanner must use a deterministic filename and size signature')
assert.match(dedupeSource, /stat\.size/, 'dedupe scanner must verify exact on-disk byte size')
assert.match(dedupeSource, /reason: 'selection'/, 'dedupe scanner must also collapse repeated files inside the current selection')
assert.match(dedupeSource, /configuredDownloadsDir/, 'dedupe scan must be constrained to Tele configured downloads path')
assert.match(pkg.scripts.start, /download-dedupe-preload\.js/, 'download dedupe scanner must preload with the local runtime')
assert.match(pkg.scripts.check, /download-dedupe-preload\.js/, 'download dedupe scanner must be syntax checked in CI')

assert.match(server, /return \{ '@type': 'inputFileLocal', path: absolutePath \}/, 'server must construct TDLib local InputFile objects')
assert.match(server, /return \{ '@type': 'inputFileId', id: uploaded\.id \}/, 'prepared uploads must construct TDLib InputFileId objects')
assert.match(compatSource, /inputPhoto/, 'compat layer must wrap photo InputFile in current TDLib inputPhoto')
assert.match(compatSource, /inputVideo/, 'compat layer must wrap video InputFile in current TDLib inputVideo')
assert.match(compatSource, /inputAudio/, 'compat layer must wrap audio InputFile in current TDLib inputAudio')
assert.match(compatSource, /inputDocument/, 'compat layer must wrap document InputFile in current TDLib inputDocument')
assert.match(compatSource, /validateAttachmentQuery/, 'compat layer must reject a lost primary InputFile before TDLib invoke')

const notificationRuntime = [p1, rescue, management, server].join('\n')
assert.doesNotMatch(notificationRuntime, /Notification\.requestPermission|new Notification|showNotification|rescueNotificationServiceRegistration|renderNotificationSection|Desktop notifications|set-managed-muted|managedNotificationSettings/, 'notification implementation must be removed from active runtime sources')
assert.equal(fs.existsSync('public/sw.js'), false, 'notification service worker must be deleted')

const { normalizeAttachmentQuery, validateAttachmentQuery } = require('../tdl-upload-compat.js')
const { signatureFor, sanitize } = require('../download-dedupe-preload.js')

assert.equal(sanitize('a:b?.mp4'), 'a_b_.mp4')
assert.equal(signatureFor('Video.MP4', 1024), signatureFor('video.mp4', 1024), 'filename comparison must be case-insensitive')
assert.notEqual(signatureFor('video.mp4', 1024), signatureFor('video.mp4', 1025), 'different file sizes must not dedupe')
assert.equal(signatureFor('video.mp4', 0), null, 'unknown file size must never be auto-skipped')

const rawVideo = {
  _: 'sendMessage',
  chat_id: 1,
  input_message_content: {
    _: 'inputMessageVideo',
    video: { '@type': 'inputFileLocal', path: './sample.mp4' },
    thumbnail: null,
    cover: null,
    self_destruct_type: null,
    start_timestamp: 0,
    added_sticker_file_ids: [],
    duration: 0,
    width: 0,
    height: 0,
    supports_streaming: true,
    caption: { _: 'formattedText', text: '', entities: [] }
  }
}
const normalizedVideo = normalizeAttachmentQuery(rawVideo, false)
assert.equal(normalizedVideo.input_message_content._, 'inputMessageVideo')
assert.equal(normalizedVideo.input_message_content.video._, 'inputVideo')
assert.equal(normalizedVideo.input_message_content.video.video._, 'inputFileLocal')
assert.equal(normalizedVideo.input_message_content.video.video['@type'], undefined)
assert.equal(normalizedVideo.input_message_content.video.thumbnail, null)
assert.equal(normalizedVideo.input_message_content.video.cover, null)
assert.equal(normalizedVideo.input_message_content.self_destruct_type, null)
assert.doesNotThrow(() => validateAttachmentQuery(normalizedVideo))

const normalizedPhoto = normalizeAttachmentQuery({
  _: 'sendMessage',
  chat_id: 1,
  input_message_content: {
    _: 'inputMessagePhoto',
    photo: { '@type': 'inputFileLocal', path: './sample.png' },
    thumbnail: null,
    added_sticker_file_ids: [],
    width: 0,
    height: 0,
    caption: { _: 'formattedText', text: '', entities: [] }
  }
}, false)
assert.equal(normalizedPhoto.input_message_content.photo._, 'inputPhoto')
assert.equal(normalizedPhoto.input_message_content.photo.photo._, 'inputFileLocal')
assert.doesNotThrow(() => validateAttachmentQuery(normalizedPhoto))

const normalizedDocument = normalizeAttachmentQuery({
  _: 'sendMessage',
  chat_id: 1,
  input_message_content: {
    _: 'inputMessageDocument',
    document: { '@type': 'inputFileLocal', path: './sample.pdf' },
    thumbnail: null,
    disable_content_type_detection: false,
    caption: { _: 'formattedText', text: '', entities: [] }
  }
}, false)
assert.equal(normalizedDocument.input_message_content.document._, 'inputDocument')
assert.equal(normalizedDocument.input_message_content.document.document._, 'inputFileLocal')
assert.doesNotThrow(() => validateAttachmentQuery(normalizedDocument))

console.log('P1 smoke checks passed')
