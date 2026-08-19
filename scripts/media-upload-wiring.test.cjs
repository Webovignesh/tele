'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8')
const pkg = JSON.parse(read('package.json'))
const uploads = read('public/uploads.js')
const preload = read('bulk-upload-preload.js')

const start = String(pkg.scripts && pkg.scripts.start || '')
const reliabilityAt = start.indexOf('-r ./bulk-upload-reliability-preload.js')
const bulkAt = start.indexOf('-r ./bulk-upload-preload.js')
assert.ok(reliabilityAt >= 0, 'server reliability preload must be part of npm start')
assert.ok(bulkAt > reliabilityAt, 'server reliability boundary must load before bulk-upload-preload')

assert.match(uploads, /filegram-media-preview\.js\?v=1/)
assert.match(uploads, /upload-reliability\.js\?v=1/)
assert.match(uploads, /uploads-hardening\.js\?v=3/)
assert.ok(
  uploads.indexOf('uploads-hardening.js?v=3') < uploads.indexOf('loadPostHardening'),
  'post-hardening owners must not replace the upload transport before hardening installs'
)

assert.match(preload, /\/api\/filegram\/bulk-upload-status\/:uploadId/)
assert.match(preload, /Cache-Control.*no-store/)
assert.match(preload, /active\.has\(uploadId\)/)

console.log('media/upload wiring checks passed')
