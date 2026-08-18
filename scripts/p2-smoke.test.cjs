'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')

const html = fs.readFileSync('public/index.html', 'utf8')
const p2 = fs.readFileSync('public/daily-driver-p2.js', 'utf8')
const p2Css = fs.readFileSync('public/daily-driver-p2.css', 'utf8')
const thumbPreload = fs.readFileSync('thumb-cache-preload.js', 'utf8')

/* Comments must not satisfy or break an assertion: the deletions this fix makes leave
 * comments naming the removed code, so checks by ABSENCE read comment-stripped source. */
const stripComments = source => source
  .split('\n')
  .filter(line => {
    const trimmed = line.trim()
    return !(trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*/') || trimmed.startsWith('*'))
  })
  .join('\n')
const p2Code = stripComments(p2)

assert.match(html, /daily-driver-p2\.js/, 'P2 runtime must load after P1')
assert.match(html, /daily-driver-p2\.css/, 'P2 stylesheet must be active')
/* INVERTED, and the requirements moved rather than dropped.
 *
 * These three required P2 to restore persistent file indexes on chat open and to own a
 * retryable hydration path over its own `scan-media-v3`. It existed to resolve a race
 * between P1's asynchronous restore and the hotfix's deletion of unvalidated snapshots -
 * a race that only existed because three layers restored the same index independently.
 * With one owner there is nothing to race: `public/files-stability.js` `ensure` dedupes
 * per chat, `restore` is the only reader of the record, and `reconcile` retries with
 * exponential backoff. Called out in the task 7/8/9 evidence. */
const p2Owner = fs.readFileSync('public/files-stability.js', 'utf8')
assert.doesNotMatch(p2Code, /teleP2ReadPersistentFiles|teleP2EnsureFilesReady/, 'this layer must not own index restore or hydration')
assert.doesNotMatch(p2Code, /scan-media-v3/, 'only the Files index owner may run the chat-scoped scanner')
assert.doesNotMatch(p2Code, /rescueFileCache\.set/, 'the Files index owner must be the only writer of the shared cache')
assert.match(p2Owner, /async function restore \(chatId\)/, 'chat opening must still restore the persistent index, from the owner')
assert.match(p2Owner, /async function ensure \(chatId, options = \{\}\)/, 'the Files view must still have one hydration path')
assert.match(p2Owner, /function scheduleBackoff/, 'hydration failures must be retried with backoff')
assert.match(p2, /photoFileId/, 'chat rows must render Telegram chat photos when available')
assert.match(p2, /api\/media-preview/, 'thumbnails and avatars must stream from Telegram cache')
assert.match(p2, /allRows\.slice\(existingRendered\)/, 'dedupe report must append every duplicate row')
assert.match(p2Css, /tele-p2-avatar-img/, 'avatar image styling must be present')
assert.match(thumbPreload, /\.thumbs/, 'legacy .thumbs directories must be intercepted')
assert.match(thumbPreload, /rmSync/, 'legacy .thumbs caches must be removed')

console.log('P2 smoke checks passed')
