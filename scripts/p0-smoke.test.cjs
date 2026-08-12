'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')

const html = fs.readFileSync('public/index.html', 'utf8')
const p0 = fs.readFileSync('public/daily-driver-p0-v2.js', 'utf8')
const p0Css = fs.readFileSync('public/daily-driver-p0.css', 'utf8')
const compatSource = fs.readFileSync('tdl-upload-compat.js', 'utf8')
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))

assert.match(html, /daily-driver-p0-v2\.js/, 'safe P0 runtime must load after stable daily-driver layers')
assert.doesNotMatch(html, /src="daily-driver-p0\.js/, 'obsolete P0 runtime must not be active')
assert.match(html, /daily-driver-p0\.css/, 'P0 stylesheet must be active')
assert.match(p0, /indexedDB\.open/, 'completed file indexes must persist across browser refresh')
assert.match(p0, /scan-media-v3[^]*force:\s*false/, 'file reconciliation must reuse the chat-scoped server cache')
assert.doesNotMatch(p0, /scan-media-v3[^]*force:\s*true/, 'browser refresh must not force a full media rescan')
assert.match(p0, /cloneNode\(true\)/, 'chat search must discard the captured legacy renderer listener')
assert.match(p0, /XMLHttpRequest/, 'attachment UI must expose real browser upload progress')
assert.match(p0, /xhr\.upload\.onprogress/, 'attachment progress must be measured from user upload behavior')
assert.match(p0, /tele-p0-video-shell/, 'video preview must use the same popup viewer family as images')
assert.match(p0Css, /tele-p0-attachment/, 'attachment queue must use the polished progress surface')
assert.match(p0Css, /dir-current/, 'download path must have a full-width readable surface')

assert.match(compatSource, /cover:/, 'video upload compatibility must include the nullable cover field')
assert.match(compatSource, /album_cover_thumbnail:/, 'audio upload compatibility must include nullable album-cover thumbnail')
assert.match(compatSource, /realpathSync/, 'local InputFile paths must be canonicalized before TDLib upload')
assert.match(pkg.scripts.start, /tdl-upload-compat\.js/, 'runtime must preload the TDLib attachment compatibility layer')

const { normalizeAttachmentQuery } = require('../tdl-upload-compat.js')
const normalizedVideo = normalizeAttachmentQuery({
  _: 'sendMessage',
  chat_id: 1,
  input_message_content: {
    _: 'inputMessageVideo',
    video: { _: 'inputFileLocal', path: './.management_uploads/example/video.mp4' },
    start_timestamp: 0,
    added_sticker_file_ids: [],
    duration: 0,
    width: 0,
    height: 0,
    supports_streaming: true,
    caption: { _: 'formattedText', text: '', entities: [] }
  }
}, false)
const video = normalizedVideo.input_message_content
assert.equal(video.thumbnail, null, 'unused video thumbnail must be explicit null')
assert.equal(video.cover, null, 'unused video cover InputFile must be explicit null')
assert.equal(video.self_destruct_type, null, 'normal video self-destruct field must be explicit null')
assert.equal(video.show_caption_above_media, false)
assert.equal(video.has_spoiler, false)
assert.match(video.video.path, /video\.mp4$/, 'primary video InputFile path must survive normalization')

const normalizedDocument = normalizeAttachmentQuery({
  _: 'sendMessage',
  input_message_content: {
    _: 'inputMessageDocument',
    document: { _: 'inputFileLocal', path: './sample.pdf' },
    caption: { _: 'formattedText', text: '', entities: [] }
  }
}, false)
assert.equal(normalizedDocument.input_message_content.thumbnail, null, 'unused document thumbnail must be explicit null')

console.log('P0 smoke checks passed')
