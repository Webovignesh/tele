'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')

const html = fs.readFileSync('public/index.html', 'utf8')
const p2 = fs.readFileSync('public/daily-driver-p2.js', 'utf8')
const p2Css = fs.readFileSync('public/daily-driver-p2.css', 'utf8')
const thumbPreload = fs.readFileSync('thumb-cache-preload.js', 'utf8')

assert.match(html, /daily-driver-p2\.js/, 'P2 runtime must load after P1')
assert.match(html, /daily-driver-p2\.css/, 'P2 stylesheet must be active')
assert.match(p2, /teleP2ReadPersistentFiles/, 'chat opening must restore persistent file indexes')
assert.match(p2, /teleP2EnsureFilesReady/, 'Files view must have a retryable hydration path')
assert.match(p2, /scan-media-v3/, 'Files recovery must use the chat-scoped scanner')
assert.match(p2, /photoFileId/, 'chat rows must render Telegram chat photos when available')
assert.match(p2, /api\/media-preview/, 'thumbnails and avatars must stream from Telegram cache')
assert.match(p2, /allRows\.slice\(existingRendered\)/, 'dedupe report must append every duplicate row')
assert.match(p2Css, /tele-p2-avatar-img/, 'avatar image styling must be present')
assert.match(thumbPreload, /\.thumbs/, 'legacy .thumbs directories must be intercepted')
assert.match(thumbPreload, /rmSync/, 'legacy .thumbs caches must be removed')

console.log('P2 smoke checks passed')
