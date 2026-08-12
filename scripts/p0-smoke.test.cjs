'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')

const html = fs.readFileSync('public/index.html', 'utf8')
const p0 = fs.readFileSync('public/daily-driver-p0-v2.js', 'utf8')
const p0Css = fs.readFileSync('public/daily-driver-p0.css', 'utf8')
const compat = fs.readFileSync('tdl-upload-compat.js', 'utf8')
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

assert.match(compat, /cover:\s*hasOwn\(content, 'cover'\)[^]*null/, 'video uploads must explicitly pass null when no TDLib cover exists')
assert.match(compat, /thumbnail:\s*hasOwn\(content, 'thumbnail'\)[^]*null/, 'nullable TDLib thumbnail fields must be explicit')
assert.match(compat, /album_cover_thumbnail/, 'audio uploads must explicitly skip album-cover upload when unused')
assert.match(compat, /realpathSync/, 'local InputFile paths must be canonicalized before TDLib upload')
assert.match(pkg.scripts.start, /tdl-upload-compat\.js/, 'runtime must preload the TDLib attachment compatibility layer')

console.log('P0 smoke checks passed')
