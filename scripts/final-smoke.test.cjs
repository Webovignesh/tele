'use strict'

const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')

const root = path.resolve(__dirname, '..')
const js = fs.readFileSync(path.join(root, 'public', 'daily-driver-final.js'), 'utf8')
const css = fs.readFileSync(path.join(root, 'public', 'daily-driver-final.css'), 'utf8')
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8')

assert.match(js, /handleEvent = function teleFinalHandleEvent/)
assert.match(js, /event\.name === 'media-index-progress'/)
assert.match(js, /rescueEnsureAllFiles = teleFinalEnsureFiles/)
assert.match(js, /renderFiles = teleFinalRenderFiles/)
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

assert.match(css, /#chat-list[\s\S]*overflow-x: hidden/)
assert.match(css, /#media-grid \.gthumb video/)
assert.match(css, /\.tele-final-preview/)
assert.match(css, /\.tele-final-dedupe-list/)
assert.match(css, /grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/)

assert.match(html, /daily-driver-final\.css\?v=1/)
assert.match(html, /daily-driver-final\.js\?v=1/)
assert.ok(html.indexOf('daily-driver-final.js?v=1') > html.indexOf('daily-driver-p2.js?v=1'), 'final runtime must load last')

console.log('final smoke checks passed')
