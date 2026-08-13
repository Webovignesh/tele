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

assert.match(html, /daily-driver-p1\.js/, 'P1 runtime must load last')
assert.match(html, /daily-driver-p1\.css/, 'P1 stylesheet must be active')
assert.match(p1, /teleP1BeginLatestPin/, 'chat opening must pin the message viewport to the latest message')
assert.match(p1, /panel\.scrollTop = panel\.scrollHeight/, 'latest-message pin must scroll to the bottom')
assert.match(p1, /wheel[^]*teleP1UserTouchedMessages = true/, 'manual user scrolling must cancel latest-message pinning')
assert.match(p1, /media-index-progress/, 'P1 must own progressive file-index reconciliation')
assert.match(p1, /teleP1FilePaintTimers/, 'file-index rendering must be throttled')
assert.match(p1, /teleP0v2ReadIndex/, 'completed file indexes must restore from persistent cache')
assert.match(p1, /teleP0v2WriteIndex/, 'completed file indexes must persist after reconciliation')
assert.match(p1, /IntersectionObserver/, 'file thumbnails must load near the viewport instead of eagerly')
assert.match(p1, /teleP1ThumbInflight/, 'thumbnail requests must be deduplicated')
assert.match(p1, /video\.preload = 'none'/, 'message videos must not start metadata downloads eagerly')
assert.match(p1Css, /#mg-downloads-pane \.dl-controls/, 'downloads drawer must use the P1 flat layout')
assert.match(p1Css, /\.dir-current[^]*display: none/, 'duplicate download path card must be removed')
assert.match(p1Css, /grid-template-columns: minmax\(0, 1fr\) 54px/, 'download folder row must reserve readable path width')

assert.match(server, /return \{ '@type': 'inputFileLocal', path: absolutePath \}/, 'server must construct TDLib local InputFile objects')
assert.match(server, /return \{ '@type': 'inputFileId', id: uploaded\.id \}/, 'prepared uploads must construct TDLib InputFileId objects')
assert.match(compatSource, /stripNullableInputFiles/, 'compat layer must strip unused nullable upload fields before TDLib invoke')
assert.match(compatSource, /documentFallbackQuery/, 'compat layer must provide a document fallback for stubborn media InputFile failures')
assert.match(compatSource, /validateAttachmentQuery/, 'compat layer must reject a lost primary InputFile before TDLib invoke')

const notificationRuntime = [p1, rescue, management, server].join('\n')
assert.doesNotMatch(notificationRuntime, /Notification\.requestPermission|new Notification|showNotification|rescueNotificationServiceRegistration|renderNotificationSection|Desktop notifications|set-managed-muted|managedNotificationSettings/, 'notification implementation must be removed from active runtime sources')
assert.equal(fs.existsSync('public/sw.js'), false, 'notification service worker must be deleted')

const { normalizeAttachmentQuery, validateAttachmentQuery, documentFallbackQuery } = require('../tdl-upload-compat.js')
const rawVideo = {
  _: 'sendMessage',
  chat_id: 1,
  input_message_content: {
    _: 'inputMessageVideo',
    video: { '@type': 'inputFileLocal', path: './sample.mp4' },
    thumbnail: null,
    cover: null,
    self_destruct_type: null,
    caption: { _: 'formattedText', text: '', entities: [] }
  }
}
const normalized = normalizeAttachmentQuery(rawVideo, false)
assert.equal(normalized.input_message_content.video._, 'inputFileLocal')
assert.equal(normalized.input_message_content.video['@type'], undefined)
assert.equal(Object.prototype.hasOwnProperty.call(normalized.input_message_content, 'thumbnail'), false)
assert.equal(Object.prototype.hasOwnProperty.call(normalized.input_message_content, 'cover'), false)
assert.equal(Object.prototype.hasOwnProperty.call(normalized.input_message_content, 'self_destruct_type'), false)
assert.doesNotThrow(() => validateAttachmentQuery(normalized))

const fallback = documentFallbackQuery(rawVideo, false)
assert.equal(fallback.input_message_content._, 'inputMessageDocument')
assert.equal(fallback.input_message_content.document._, 'inputFileLocal')
assert.equal(Object.prototype.hasOwnProperty.call(fallback.input_message_content, 'thumbnail'), false)
assert.doesNotThrow(() => validateAttachmentQuery(fallback))

console.log('P1 smoke checks passed')
