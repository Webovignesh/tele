'use strict'

/* Behavioural tests for the duplicate check.
 *
 * The reported symptom was that the modal disagreed with reality: a selection of
 * 11,101 files reported "Selected 9,521", and a destination folder holding about
 * 6,000 files reported "Already there 4,738". Two independent causes:
 *
 *   1. The client filtered locally-completed items out of the selection BEFORE
 *      asking for the scan, so the scanner reported the size of the trimmed list
 *      and never saw the files most likely to be on disk. Covered by the client
 *      contract assertions at the bottom.
 *   2. server.js finalize() saves name collisions through uniquePath(), which
 *      appends " (N)". Those copies could never match a filename+size signature,
 *      so files that were plainly on disk were reported as still to download.
 *
 * The real scanner is exercised against a temporary folder; nothing here touches
 * settings.json or the configured downloads directory.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')

const { buildDedupeReport, signatureFor, sanitize } = require('../download-dedupe-preload.js')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-dedupe-test-'))
const write = (dir, name, bytes) => {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), Buffer.alloc(bytes, 1))
}

// A per-chat subfolder, mirroring what server.js finalize() creates.
const chatDir = path.join(root, 'Tamil')
write(chatDir, 'photo_1.jpg', 1000) // plain match
write(chatDir, 'photo_2 (1).jpg', 2000) // uniquePath() collision rename
write(chatDir, 'photo_3.jpg', 999) // same name, different size
write(root, 'photo_4.jpg', 4000) // top-level match
write(path.join(root, '.thumbs'), 'photo_5.jpg', 5000) // must be ignored
write(path.join(chatDir, 'nested', 'deeper'), 'photo_8.jpg', 8000) // deep recursion

const selection = [
  { uid: '-100:1', messageId: 1, fileName: 'photo_1.jpg', fileSize: 1000 },
  { uid: '-100:2', messageId: 2, fileName: 'photo_2.jpg', fileSize: 2000 },
  { uid: '-100:3', messageId: 3, fileName: 'photo_3.jpg', fileSize: 1000 },
  { uid: '-100:4', messageId: 4, fileName: 'photo_4.jpg', fileSize: 4000 },
  { uid: '-100:5', messageId: 5, fileName: 'photo_5.jpg', fileSize: 5000 },
  { uid: '-100:6', messageId: 6, fileName: 'photo_6.jpg', fileSize: 6000 },
  { uid: '-100:8', messageId: 8, fileName: 'photo_8.jpg', fileSize: 8000 },
  // One signature twice in a single selection, using a messageId that also exists
  // in another chat.
  { uid: '-100:7', messageId: 7, fileName: 'dup.jpg', fileSize: 7000 },
  { uid: '-200:7', messageId: 7, fileName: 'dup.jpg', fileSize: 7000 }
]

;(async () => {
  try {
    const report = await buildDedupeReport(selection, root)
    const onDisk = report.duplicates.filter(row => row.reason === 'existing').map(row => row.uid).sort()
    const repeated = report.duplicates.filter(row => row.reason === 'selection').map(row => row.uid)
    const unique = report.uniqueUids

    assert.equal(report.selectedCount, selection.length, 'selectedCount must be the size of the list it was given')

    assert.ok(onDisk.includes('-100:1'), 'an exact filename+size match must be found')
    /* The regression: a file saved as "photo_2 (1).jpg" is the same content as
     * "photo_2.jpg". Before this was handled, every collision-renamed copy was
     * invisible and got downloaded again. */
    assert.ok(onDisk.includes('-100:2'), 'a uniquePath "(N)" rename must be recognised as already on disk')
    assert.ok(onDisk.includes('-100:4'), 'a file at the top level must be matched')
    assert.ok(onDisk.includes('-100:8'), 'nested subfolders must be scanned')

    assert.ok(!onDisk.includes('-100:3'), 'the same name with a different size must NOT be a duplicate')
    assert.ok(unique.includes('-100:3'), 'a size mismatch must remain downloadable')
    assert.ok(!onDisk.includes('-100:5'), '.thumbs must be excluded from matching')
    assert.ok(unique.includes('-100:5'), 'a thumbnail cache hit must not suppress the real file')
    assert.ok(unique.includes('-100:6'), 'a file that is absent must be downloadable')

    assert.equal(repeated.length, 1, 'a signature repeated inside the selection must be flagged exactly once')
    assert.equal(new Set([...onDisk, ...repeated, ...unique]).size, selection.length,
      'every selected item must be classified exactly once')
    assert.equal(report.duplicateCount + report.uniqueCount, report.selectedCount,
      'duplicates + unique must account for the whole selection')

    // Identity must survive a messageId shared by two chats.
    const sevens = [...onDisk, ...repeated, ...unique].filter(uid => uid.endsWith(':7'))
    assert.deepEqual(sevens.sort(), ['-100:7', '-200:7'], 'cross-chat items must stay distinct')

    assert.equal(report.scannedFiles, 5, 'scannedFiles must count real files outside .thumbs')
    assert.ok(report.rootPath === root || report.rootPath === path.resolve(root), 'the scanned root must be reported')

    /* ---- signature rules ---- */
    /* A nameless item still gets a signature, because sanitize() falls back to
     * "file" exactly as the server does when saving it - so the name the scanner
     * looks for is the name the file would actually have on disk. */
    assert.equal(signatureFor('', 100), signatureFor('file', 100), 'a nameless item matches the name the server would give it')
    assert.equal(signatureFor('a.jpg', 0), null, 'a zero-byte item has no signature')
    assert.equal(signatureFor('A.JPG', 10), signatureFor('a.jpg', 10), 'matching must be case-insensitive')
    assert.notEqual(signatureFor('a.jpg', 10), signatureFor('a.jpg', 11), 'size must be part of the signature')
    assert.equal(sanitize('a/b:c.jpg'), 'a_b_c.jpg', 'sanitize must mirror the server')

    /* ---- an unknown size must never be silently skipped ---- */
    const unknown = await buildDedupeReport([{ uid: 'x:1', messageId: 1, fileName: 'photo_1.jpg', fileSize: 0 }], root)
    assert.equal(unknown.uniqueCount, 1, 'an item with no size must stay downloadable')
    assert.equal(unknown.unknownSizeCount, 1, 'and must be reported as unknown-size')

    /* ---- a missing destination folder is simply empty ---- */
    const missing = await buildDedupeReport(selection, path.join(root, 'does-not-exist'))
    assert.equal(missing.duplicateCount, 1, 'only the in-selection repeat can be a duplicate with no folder')
    assert.equal(missing.scannedFiles, 0)

    /* ---- client contract: the full selection must be scanned ---- */
    const p1 = fs.readFileSync(path.join(__dirname, '..', 'public', 'daily-driver-p1.js'), 'utf8')
    const wrapper = /startDownloads = async function teleP1StartDownloadsWithDedupe[\s\S]*?\n\}/.exec(p1)
    assert.ok(wrapper, 'the dedupe wrapper must exist')
    const body = wrapper[0]
    const requestIndex = body.indexOf("request('download-dedupe-preview'")
    assert.ok(requestIndex > 0, 'the wrapper must request the preview')
    /* isCompleted may only be consulted to CLASSIFY, never to trim the list before
     * the scan - that is what made Selected and Already there disagree with
     * reality. */
    assert.doesNotMatch(body, /const candidates = \(items \|\| \[\]\)\.filter\(item => !isCompleted/,
      'completed items must not be filtered out before the scan')
    assert.match(body, /selectedCount: selected\.length/, 'the modal must be told the true selection size')
    assert.match(body, /completedCount:/, 'already-downloaded items must be reported, not hidden')
    assert.match(body, /uid: teleP1ItemUid\(item\)/, 'items must carry a per-item identity')
    assert.doesNotMatch(body, /isCompleted\(`\$\{state\.activeChatId\}/,
      'the completed key must use the item\'s own chat, not the active one')

    const final = fs.readFileSync(path.join(__dirname, '..', 'public', 'daily-driver-final.js'), 'utf8')
    assert.match(final, /\['Already downloaded', completedCount\]/, 'the modal must show the already-downloaded bucket')

    console.log('dedupe checks passed')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})().catch(error => {
  console.error(error)
  process.exit(1)
})
