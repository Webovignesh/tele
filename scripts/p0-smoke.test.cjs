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
assert.match(compatSource, /inputPhoto/, 'upload compatibility must adapt photos to the current TDLib inputPhoto wrapper')
assert.match(compatSource, /inputVideo/, 'upload compatibility must adapt videos to the current TDLib inputVideo wrapper')
assert.match(compatSource, /inputAudio/, 'upload compatibility must adapt audio to the current TDLib inputAudio wrapper')
assert.match(compatSource, /inputDocument/, 'upload compatibility must adapt documents to the current TDLib inputDocument wrapper')
assert.match(compatSource, /realpathSync/, 'local InputFile paths must be canonicalized before TDLib upload')
assert.match(pkg.scripts.start, /tdl-upload-compat\.js/, 'runtime must preload the TDLib attachment compatibility layer')

const { normalizeAttachmentQuery } = require('../tdl-upload-compat.js')
const rawVideo = {
  _: 'sendMessage',
  chat_id: 1,
  input_message_content: {
    _: 'inputMessageVideo',
    video: { _: 'inputFileLocal', path: './.management_uploads/example/video.mp4' },
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
const videoMessage = normalizedVideo.input_message_content
assert.equal(videoMessage._, 'inputMessageVideo')
assert.equal(videoMessage.video._, 'inputVideo')
assert.equal(videoMessage.video.video._, 'inputFileLocal')
assert.match(videoMessage.video.video.path, /video\.mp4$/, 'primary video InputFile must survive inside inputVideo')
assert.equal(videoMessage.video.thumbnail, null)
assert.equal(videoMessage.video.cover, null)
assert.equal(videoMessage.show_caption_above_media, false)
assert.equal(videoMessage.self_destruct_type, null)
assert.equal(videoMessage.has_spoiler, false)

const normalizedPhoto = normalizeAttachmentQuery({
  _: 'sendMessage',
  input_message_content: {
    _: 'inputMessagePhoto',
    photo: { _: 'inputFileLocal', path: './sample.png' },
    thumbnail: null,
    added_sticker_file_ids: [],
    width: 0,
    height: 0,
    caption: { _: 'formattedText', text: '', entities: [] }
  }
}, false)
assert.equal(normalizedPhoto.input_message_content.photo._, 'inputPhoto')
assert.equal(normalizedPhoto.input_message_content.photo.photo._, 'inputFileLocal')

const normalizedDocument = normalizeAttachmentQuery({
  _: 'sendMessage',
  input_message_content: {
    _: 'inputMessageDocument',
    document: { _: 'inputFileLocal', path: './sample.pdf' },
    thumbnail: null,
    caption: { _: 'formattedText', text: '', entities: [] }
  }
}, false)
assert.equal(normalizedDocument.input_message_content.document._, 'inputDocument')
assert.equal(normalizedDocument.input_message_content.document.document._, 'inputFileLocal')
assert.equal(normalizedDocument.input_message_content.document.thumbnail, null)

const normalizedPrepared = normalizeAttachmentQuery({
  _: 'sendMessage',
  input_message_content: {
    _: 'inputMessagePhoto',
    photo: { '@type': 'inputFileId', id: 123 },
    caption: { _: 'formattedText', text: '', entities: [] }
  }
}, false)
assert.equal(normalizedPrepared.input_message_content.photo.photo._, 'inputFileId')
assert.equal(normalizedPrepared.input_message_content.photo.photo.id, 123)

console.log('P0 smoke checks passed')
