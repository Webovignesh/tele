'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'filegram-index-test-'))
process.env.FILEGRAM_INDEX_DIR = temp
const engine = require('../file-index-preload.js')._test

assert.equal(engine.compareMessageIds('1000000000000000001', '999999999999999999'), 1)
assert.equal(engine.compareMessageIds('7', '7'), 0)

const photoMessage = {
  id: '100',
  chat_id: '-42',
  date: 123,
  content: {
    _: 'messagePhoto',
    photo: { sizes: [{ size: 10, photo: { id: 1 } }, { size: 20, photo: { id: 2, size: 20 } }] },
    caption: { text: 'caption' }
  }
}
const photo = engine.extractMediaItem(photoMessage)
assert.equal(photo.type, 'photo')
assert.equal(photo.fileId, 2)
assert.equal(photo.chatId, '-42')

const hydrated = engine.hydrateSnapshot('-42', {
  expectedCount: 3,
  items: [photo, { ...photo, name: 'newer-name.jpg' }]
})
assert.equal(hydrated.items.length, 1, 'message-id dedupe must be stable')
assert.equal(hydrated.expectedCount, 3)
assert.equal(engine.serializableSnapshot(hydrated, false).items, undefined)

const serverSource = fs.readFileSync('file-index-preload.js', 'utf8')
const browserSource = fs.readFileSync('public/files-stability.js', 'utf8')
const cssSource = fs.readFileSync('public/stability.css', 'utf8')

assert.match(serverSource, /searchMessagesFilterPhotoAndVideo/)
assert.match(serverSource, /searchMessagesFilterDocument/)
assert.match(serverSource, /queueBackgroundChats/)
assert.match(serverSource, /media-index-v4-progress/)
assert.match(serverSource, /\.json\.gz/)
assert.match(browserSource, /filegram-virtual-canvas/)
assert.match(browserSource, /activeViewIndex/)
assert.match(browserSource, /indexAtClientY/)
assert.match(browserSource, /queue-file-index-v4/)
assert.doesNotMatch(browserSource, /tele-ui-virtual-spacer/)
assert.match(cssSource, /#media-grid\[data-file-gram-owner="1"\]/)
assert.match(cssSource, /position:\s*absolute/)

fs.rmSync(temp, { recursive: true, force: true })
console.log('file index smoke checks passed')
