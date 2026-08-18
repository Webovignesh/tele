// @ts-check
'use strict'

/* Shared honest-fixture infrastructure for the FileGram Playwright suites.
 *
 * This module is NOT a test file (playwright's default testMatch only collects
 * *.spec.js / *.test.js), and it is NOT a runtime layer. It is the fixture
 * scaffolding task 2 built inside `tests/file-consistency.spec.js`, extracted so
 * `tests/preservation.spec.js` can reuse it verbatim instead of growing a second,
 * differently-honest fixture.
 *
 * `tests/file-consistency.spec.js` is deliberately left untouched, so the ten
 * bug-condition exploration tests stay a separate, re-runnable set whose recorded
 * failures in the task 2 evidence remain reproducible byte-for-byte.
 *
 * The honesty rules the fixtures enforce, carried over from task 2:
 *   - real layers are loaded BY URL out of a served real `public/` tree, with their
 *     real `?v=` tokens, so stack frames carry the real file and line;
 *   - the real `public/daily-driver-p0-v2.js` IndexedDB boundary runs against real
 *     IndexedDB, and `assertRealBoundary` fails the suite if anything stubs it;
 *   - layout fixtures load the real stylesheets from `public/index.html` over real
 *     markup sliced out of `public/index.html`, inside the real runtime parent
 *     chain that `public/management.js` produces.
 */

const fs = require('node:fs')
const path = require('node:path')
const { expect } = require('@playwright/test')

const ROOT = path.join(__dirname, '..')
const PUBLIC = path.join(ROOT, 'public')
const ORIGIN = 'http://filegram.test'
const SERVER = 'http://127.0.0.1:3000'

/* The concrete case from the bug report and the Phase 0 evidence: chat "TEST",
 * 22 stale rows locally, zero media messages in Telegram, configured download
 * folder F:\New\Tamil. */
const TEST_CHAT_ID = '-1004474514785'
const STALE_COUNT = 22
const CONFIGURED_DIR = 'F:\\New\\Tamil'
const HIGH_WATER_KEY = 'tele-file-index-high-water-v1'
const RECONCILE_MARK_KEY = 'filegram-files-delete-reconcile-v1'

/* `consistency: 'file-consistency-v2.js?v=3'` was here and is gone: task 9.1 deleted
 * that file. It was the last link in the dynamic chain, so it won `#set-dir` by accident
 * of load order while duplicating reconciliation, the picker handler and the Save-to
 * paint. Nothing in the preservation set loaded it. */
const LAYERS = {
  p0v2: 'daily-driver-p0-v2.js?v=1',
  guard: 'daily-driver-final-guard.js?v=3',
  owner: 'files-stability.js?v=2',
  pager: 'files-view.js?v=2',
  hardening: 'uploads-hardening.js?v=3'
}

const INDEX_HTML = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8')

/* Real stylesheet list, in the real order, read out of the real index.html. */
const REAL_STYLESHEETS = [...INDEX_HTML.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/g)].map(m => m[1])

function sliceBetween (startNeedle, endNeedle, requiredMarkers) {
  const start = INDEX_HTML.indexOf(startNeedle)
  if (start < 0) throw new Error(`index.html no longer contains ${startNeedle}`)
  const end = INDEX_HTML.indexOf(endNeedle, start)
  if (end < 0) throw new Error(`index.html no longer contains ${endNeedle} after ${startNeedle}`)
  const block = INDEX_HTML.slice(start, end).trimEnd()
  for (const marker of requiredMarkers || []) {
    if (!block.includes(marker)) throw new Error(`extracted block from ${startNeedle} is missing ${marker}`)
  }
  return block
}

/* Real Save-to markup, sliced out of the real index.html rather than retyped.
 *
 * The required markers changed with task 8.1: `#dl-dir` and `#dl-dir-current` are deleted
 * from the markup - not hidden - so the control is one `button#set-dir.fg-save-to` holding
 * one path display, `#dl-dir-path`. Asserting the new markers keeps the slice honest: if a
 * future edit removes the control or reintroduces a second one, this throws at load
 * instead of silently measuring nothing. */
const REAL_DL_CONTROLS = sliceBetween('<div class="dl-controls">', '<div id="pack-banner"', ['id="set-dir"', 'class="fg-save-to"', 'id="dl-dir-path"'])

/* Everything the real `<aside class="downloads">` holds, so the layout fixture can
 * measure the stats card, the Parallel files slider and the queue action rows in
 * the same cascade as the Save-to control (clause 3.11). */
const REAL_DOWNLOADS_CHILDREN = sliceBetween('<div class="downloads-head">', '</aside>', [
  'id="download-stats"', 'id="scan-banner"', 'class="dl-controls"', 'id="concurrency"',
  'id="pause-all"', 'id="resume-all"', 'id="cancel-all"', 'id="clear-done"', 'id="download-list"'
])

/* The real Files surface: header counts, tabs, toolbar, grid and the load-state
 * footer, so the real pager in `public/files-view.js` mounts where it really does. */
const REAL_CHAT_SECTION = sliceBetween('<section class="chat">', '<aside class="downloads">', [
  'id="chat-media-count"', 'id="select-all-media"', 'id="files-toolbar"', 'id="media-grid"', 'id="load-state"'
])

/* ------------------------------------------------------------------ generators */

/* Deterministic generator so any counterexample is reproducible from the seed.
 * Same implementation as task 2's `rng`, deliberately unchanged. */
function rng (seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/* Smart generator: index sizes constrained to the input space the preservation
 * properties are about, with the page-boundary values that PAGE_SIZE = 100 makes
 * interesting pinned in rather than left to chance. */
function indexSizes (seed, cases, max = 420) {
  const next = rng(seed)
  const out = [0, 1, 99, 100, 101]
  for (let i = 0; i < cases; i++) out.push(1 + Math.floor(next() * max))
  return out
}

/* Smart generator: shrink pairs only (a partial or truthful result smaller than
 * what is already discovered). */
function shrinkPairs (seed, cases, max = 400) {
  const next = rng(seed)
  const out = [{ stored: STALE_COUNT, truth: 0 }]
  for (let i = 0; i < cases; i++) {
    const stored = 2 + Math.floor(next() * max)
    const truth = Math.floor(next() * stored)
    out.push({ stored, truth })
  }
  return out
}

/* Smart generator: streaming batch sizes, all strictly below the owner's
 * PROGRESS_FLUSH_ITEMS (800) so every batch really goes through the 350 ms timed
 * flush rather than the size-triggered one. */
function progressBatches (seed, batches, max = 180) {
  const next = rng(seed)
  const out = []
  for (let i = 0; i < batches; i++) out.push(1 + Math.floor(next() * max))
  return out
}

function generatedPaths (seed, cases) {
  const next = rng(seed)
  const out = [CONFIGURED_DIR]
  for (let i = 0; i < cases; i++) {
    const depth = 1 + Math.floor(next() * 5)
    const parts = []
    for (let d = 0; d < depth; d++) parts.push('seg' + Math.floor(next() * 1e6).toString(36))
    out.push('F:\\' + parts.join('\\'))
  }
  return out
}

/* Deterministic shuffle, so a generated event interleaving is reproducible. */
function shuffled (seed, values) {
  const next = rng(seed)
  const out = values.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/* ------------------------------------------------------------------- fixtures */

const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' }

/* Serves the fixture document plus the REAL public/ tree, so real stylesheets and
 * real scripts are fetched with their real bytes and their real ?v= tokens. */
async function serveFixture (page, body, api) {
  await page.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body })
    }
    if (url.pathname.startsWith('/api/')) {
      if (api) return api(route, url)
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{"ok":false}' })
    }
    const target = path.join(PUBLIC, url.pathname.replace(/^\/+/, ''))
    if (!target.startsWith(PUBLIC)) return route.fulfill({ status: 403, body: '' })
    try {
      return route.fulfill({ status: 200, contentType: MIME[path.extname(target)] || 'application/octet-stream', body: await fs.promises.readFile(target) })
    } catch {
      return route.fulfill({ status: 404, body: '' })
    }
  })
  await page.goto(`${ORIGIN}/`)
}

/* Every global the real layers resolve at load time, and nothing that replaces a
 * boundary under test.
 *
 * `options.filesView` adds the extra globals `public/files-view.js` resolves so the
 * REAL pager can be loaded (clauses 3.6, 3.7).
 * `options.upsertToSharedCache` makes the base `handleEvent` write an upserted
 * media message into `rescueFileCache`, which is what the legacy realtime layers
 * (`rescue-runtime.js` `rescueRealtimeMessageUpsert`, `daily-driver-final.js`
 * `teleFinalPatchRealtimeMedia`) do in the live app; the owner then unions it in
 * through its own `syncFromSharedAfterRealtime`. It stands in for the transport,
 * not for any boundary under test.
 */
async function installGlobals (page, chatId, options = {}) {
  await page.evaluate(({ chatId, options }) => {
    window.__ws = []
    window.__loadStates = []
    window.__toasts = []
    window.__warns = []
    window.__baseEvents = []
    window.__scanResponse = { found: 0, scanned: 1, items: [], typeCounts: {}, cancelled: false, done: true, fromCache: false }
    /* Opt-in transport answer for `media-truth-v1`, the ws request task 4.2 added to
     * `server.js` and the only truth source the owner consults.
     *
     * Left UNSET by default on purpose: an unset answer falls through to the generic
     * `{ ok: true }` below, which carries no `complete` flag, so the owner treats the
     * pass as unknown and changes nothing. Every fixture that does not opt in therefore
     * behaves exactly as it did before this hook existed. A fixture that DOES opt in is
     * standing in for the server, not for any boundary under test - the same role
     * `__scanResponse` plays for `scan-media-v3` - and the shapes it uses are the shapes
     * the real server was observed producing in the task 4 evidence. */
    window.__truthResponse = null
    window.__truthByChat = null
    window.__truthCalls = []

    const baseWarn = console.warn.bind(console)
    console.warn = (...args) => { window.__warns.push(args.map(a => String(a && a.message ? a.message : a)).join(' ')); baseWarn(...args) }

    window.state = {
      activeChatId: chatId,
      view: 'files',
      chats: [],
      messages: [],
      selection: new Map(),
      selectedMessages: new Map(),
      mediaCount: 0,
      typeCounts: {},
      hasMore: false,
      files: { mode: 'browse', query: '', filter: 'all', sort: 'newest', results: [], totalCount: 0, hasMore: false, fromMessageId: 0 }
    }
    window.rescueFileCache = new Map()
    window.rescueOpenGeneration = 0
    window.teleHotfixValidatedChats = new Set()
    window.teleHotfixSortFileItems = items => items
    window.typeIcon = {}

    window.request = async function fixtureRequest (type, payload = {}) {
      const entry = { type, payload, at: Date.now() }
      window.__ws.push(entry)
      if (type === 'scan-media-v3') {
        if (window.__scanThrows) throw new Error(String(window.__scanThrows))
        const answer = JSON.parse(JSON.stringify(window.__scanResponse))
        entry.answered = { found: answer.found, items: (answer.items || []).length, done: answer.done, scanned: answer.scanned }
        return answer
      }
      if (type === 'media-truth-v1') {
        const key = String(payload.chatId)
        const answer = (window.__truthByChat && window.__truthByChat[key]) || window.__truthResponse
        window.__truthCalls.push({ chatId: key, at: Date.now() })
        if (answer && answer.__throw) throw new Error(String(answer.__throw))
        if (answer) {
          entry.answered = { count: answer.count, ids: (answer.ids || []).length, complete: answer.complete, accessible: answer.accessible }
          return JSON.parse(JSON.stringify(answer))
        }
      }
      if (type === 'get-messages') return { messages: [], hasMore: false }
      if (type === 'set-download-dir') return { downloadsDir: payload.dir }
      if (type === 'get-status') return { status: 'ready', ready: true }
      return { ok: true }
    }

    window.handleEvent = function fixtureHandleEvent (event) {
      window.__baseEvents.push(event && event.name)
      if (!options.upsertToSharedCache) return
      if (!event || event.name !== 'message-upsert') return
      const payload = event.payload || event
      const chat = payload.chatId != null ? payload.chatId : event.chatId
      const message = payload.message || event.message
      if (chat == null || !message || !message.media) return
      const key = String(chat)
      const previous = window.rescueFileCache.get(key)
      const items = previous && Array.isArray(previous.items) ? previous.items.slice() : []
      const media = { ...message.media, chatId: chat, messageId: message.id, name: message.media.name }
      const at = items.findIndex(item => String(item.messageId) === String(message.id))
      if (at >= 0) items[at] = media
      else items.unshift(media)
      const typeCounts = {}
      for (const item of items) typeCounts[item.type] = (typeCounts[item.type] || 0) + 1
      window.rescueFileCache.set(key, { chatId: chat, items, found: items.length, scanned: items.length, typeCounts, newestMessageId: items.length ? items[0].messageId : 0, savedAt: Date.now(), done: true })
    }

    window.setLoadState = text => {
      window.__loadStates.push(String(text == null ? '' : text))
      const node = document.querySelector('#load-state')
      if (node) node.textContent = String(text == null ? '' : text)
    }
    window.openChat = async () => {}
    window.setView = view => { window.state.view = view }
    window.renderChats = () => {}
    window.renderFiles = () => {}
    window.renderMessagesList = () => {}
    window.removeChat = () => {}
    window.updateMediaCountLabel = () => {}
    window.rescueUpdateMediaLabel = () => {}
    window.rescueApplyCompleteFiles = () => {}
    window.rescueEnsureAllFiles = async () => null
    window.rescuePreviewFile = async () => {}
    window.rescueRenderAttachments = () => {}
    window.rescueSendComposer = async () => {}
    window.rescueSaveActiveChat = () => {}
    window.rescueMergeMessages = () => {}
    window.buildGridCard = () => document.createElement('div')
    window.filesItems = () => []
    window.avatarColor = () => '#123'
    window.initials = () => 'T'
    /* Stands in for `setDirLabel` in app.js, which the fixture does not load. It writes the
     * same node the real painter writes (`#dl-dir-path`); it used to write `#dl-dir.value`,
     * which no longer exists. */
    window.setDirLabel = dir => {
      const value = String(dir == null ? '' : dir).trim()
      if (!value) return
      const path = document.querySelector('#dl-dir-path')
      if (path) path.textContent = value
      const button = document.querySelector('#set-dir')
      if (button) { button.title = value; button.dataset.fgFolderPath = value }
    }
    window.toast = (message, kind) => { window.__toasts.push({ message: String(message && message.message ? message.message : message), kind: kind || '' }) }
    window.toastOk = message => { window.__toasts.push({ message: String(message), kind: 'ok' }) }

    if (options.filesView) {
      window.__selectionBarCalls = 0
      window.__rangeControls = null
      window.lastClickedKey = null
      window.updateSelectionBar = () => { window.__selectionBarCalls++ }
      window.rescueUpdateRangeControls = total => { window.__rangeControls = total }
      window.loadThumb = () => {}
      window.buildGridCard = item => {
        const card = document.createElement('div')
        card.className = 'gcard'
        card.dataset.key = `${item.chatId}:${item.messageId}`
        const box = document.createElement('input')
        box.type = 'checkbox'
        card.appendChild(box)
        const name = document.createElement('div')
        name.className = 'name'
        name.textContent = String(item.name || '')
        card.appendChild(name)
        return card
      }
    }

    window.__itemsRange = (chat, from, count, type) => {
      const names = ['photo_400556032.jpg', 'photo_393216000.jpg', 'photo_391118848.jpg']
      const items = []
      for (let i = from; i < from + count; i++) {
        items.push({
          chatId: chat,
          messageId: 1000000 + i,
          name: (from === 0 && names[i]) || `photo_stale_${i}.jpg`,
          type: type || (i % 4 === 0 ? 'document' : 'photo'),
          fileSize: 1024 + i
        })
      }
      return items
    }
    /* Direct access to the persistent record, for SEEDING a precondition and for READING
     * the result back.
     *
     * These replace `window.teleP0v2WriteIndex(..., { allowShrink: true })` and
     * `window.teleP0v2ReadIndex(...)`, which task 9.2 deleted along with the legacy
     * boundary. Going straight to IndexedDB is the more honest fixture in both directions:
     * a seeded record is meant to be a PREVIOUS session's artefact, so writing it through
     * a boundary that is itself under test was always a slight fiction, and reading it
     * back through the owner's own code would let the owner's answer stand in for what is
     * actually stored. Same database, same store, same record shape the owner reads. */
    const RECORD_DB = 'tele-daily-driver-cache-v1'
    const RECORD_STORE = 'file-indexes'
    const openRecordDb = () => new Promise((resolve, reject) => {
      const request = indexedDB.open(RECORD_DB, 1)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(RECORD_STORE)) request.result.createObjectStore(RECORD_STORE, { keyPath: 'chatId' })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error || new Error('IndexedDB unavailable'))
    })

    window.__seedRecord = async (chatId, snapshot, extra = {}) => {
      const db = await openRecordDb()
      const items = (snapshot && snapshot.items) || []
      const typeCounts = {}
      for (const item of items) typeCounts[item.type] = (typeCounts[item.type] || 0) + 1
      const record = {
        chatId: String(chatId),
        found: items.length,
        scanned: Number((snapshot && snapshot.scanned) || items.length),
        typeCounts,
        items,
        savedAt: Number((snapshot && snapshot.savedAt) || Date.now()),
        done: snapshot ? snapshot.done !== false : true,
        ...extra
      }
      await new Promise(resolve => {
        const tx = db.transaction(RECORD_STORE, 'readwrite')
        tx.objectStore(RECORD_STORE).put(record)
        tx.oncomplete = resolve
        tx.onerror = resolve
        tx.onabort = resolve
      })
      db.close()
      return record.items.length
    }

    window.__readRecord = async chatId => {
      const db = await openRecordDb()
      const result = await new Promise(resolve => {
        const tx = db.transaction(RECORD_STORE, 'readonly')
        const request = tx.objectStore(RECORD_STORE).get(String(chatId))
        request.onsuccess = () => resolve(request.result || null)
        request.onerror = () => resolve(null)
      })
      try { db.close() } catch {}
      return result
    }

    /* A `media-truth-v1` answer in the shape the real server produces, verified against
     * the real local Telegram session in the task 4 evidence: chat TEST answers
     * `{ok:true,ids:[],count:0,complete:true,accessible:true,scanned:1,source:'walk'}`. */
    window.__truthAnswer = (ids, extra = {}) => {
      const list = (ids || []).map(String)
      return { ok: true, ids: list, count: list.length, complete: true, accessible: true, scanned: list.length + 1, source: 'walk', ...extra }
    }

    window.__staleItems = (chat, count) => window.__itemsRange(chat, 0, count)
    window.__snapshotFrom = (chat, items, done) => {
      const typeCounts = {}
      for (const item of items) typeCounts[item.type] = (typeCounts[item.type] || 0) + 1
      return {
        chatId: chat,
        items,
        found: items.length,
        scanned: items.length,
        typeCounts,
        newestMessageId: items.length ? items[items.length - 1].messageId : 0,
        savedAt: Date.now(),
        done: done !== false
      }
    }
    window.__snapshotOf = (chat, count) => window.__snapshotFrom(chat, window.__itemsRange(chat, 0, count), true)
  }, { chatId, options })
}

async function loadLayers (page, layers) {
  for (const layer of layers) await page.addScriptTag({ url: `${ORIGIN}/${layer}` })
}

/* Guard assertion for clause 1.23 / task 6.3: the real persistence boundary must be
 * the one under test. If a future edit stubs it, this fails instead of greening.
 *
 * It covers BOTH boundaries that exist while the owner is being proven live:
 *
 *   - the legacy `teleP0v2WriteIndex` in `public/daily-driver-p0-v2.js`, which the
 *     task 2 exploration tests probe directly and which task 9.2 removes. Checked
 *     only when it is present, so this guard does not break when it goes;
 *   - the owner's own `writePersistent` in `public/files-stability.js`, which is the
 *     boundary the fix moved persistence to. It lives inside the owner's closure and
 *     is not reachable as a global, so it is verified two ways that a stub cannot
 *     fake: the API the owner installs must be the real one (its `reconcile` really
 *     is the shipped truth-pass implementation), and the bytes the page was served
 *     for `files-stability.js` must still contain an UNCONDITIONAL boundary - no
 *     `allowShrink`, no stored-count comparison. A fixture that swaps the owner for
 *     an always-writing stub fails here rather than greening, which is exactly the
 *     failure mode the old `tests/file-consistency.spec.js` had.
 */
async function assertRealBoundary (page) {
  const shape = await page.evaluate(async () => {
    const out = {
      legacyPresent: typeof window.teleP0v2WriteIndex === 'function',
      legacySource: typeof window.teleP0v2WriteIndex === 'function' ? String(window.teleP0v2WriteIndex) : '',
      ownerPresent: !!(window.teleFilesIndex && typeof window.teleFilesIndex.reconcile === 'function'),
      reconcileSource: window.teleFilesIndex && typeof window.teleFilesIndex.reconcile === 'function' ? String(window.teleFilesIndex.reconcile) : '',
      ownerApi: window.teleFilesIndex ? Object.keys(window.teleFilesIndex).filter(key => typeof window.teleFilesIndex[key] === 'function') : [],
      ownerBytes: ''
    }
    if (out.ownerPresent) {
      try {
        out.ownerBytes = await fetch('/files-stability.js?v=2', { cache: 'no-store' }).then(response => response.text())
      } catch {}
    }
    return out
  })

  if (shape.legacyPresent) {
    expect(shape.legacySource, 'teleP0v2WriteIndex must be the real IndexedDB boundary, not a test stub').toContain('teleP0v2ValidSnapshot')
  }

  if (!shape.ownerPresent) return
  for (const method of ['ensure', 'snapshot', 'count', 'total', 'reconcile', 'retireTemporary', 'hardRefresh']) {
    expect(shape.ownerApi, `the real owner API must expose ${method}`).toContain(method)
  }
  expect(shape.reconcileSource, "the owner's reconcile must be the real truth pass, not a stub").toContain('media-truth-v1')
  expect(shape.reconcileSource, "the owner's reconcile must commit through commitAuthoritative").toContain('commitAuthoritative')

  const owner = shape.ownerBytes
  expect(owner.length, 'the page must have been served the real files-stability.js').toBeGreaterThan(1000)
  const start = owner.indexOf('async function writePersistent')
  expect(start, "the owner's persistence boundary must be present in the served bytes").toBeGreaterThan(-1)
  const boundary = owner.slice(start, owner.indexOf('/* Legacy readers', start))
  expect(boundary.length, "the owner's persistence boundary must be readable in the served bytes").toBeGreaterThan(200)
  expect(boundary, 'the persistence boundary must have no shrink escape hatch').not.toContain('allowShrink')
  expect(boundary, 'the persistence boundary must not read the stored count').not.toContain('storedCount')
  expect(boundary, 'the persistence boundary must not read before writing').not.toContain('readPersistent')
}

/* The layout fixtures must cascade the REAL stylesheets. A bare page has no CSS, so
 * every geometry assertion on it passes for the wrong reason - that is exactly how
 * the old suite's full-width assertion greened while the real control was 54px. */
async function assertRealStylesheets (page) {
  const count = await page.evaluate(() => document.styleSheets.length)
  expect(count, 'the layout fixture must load the real index.html stylesheets, not a bare page').toBeGreaterThanOrEqual(REAL_STYLESHEETS.length)
  expect(REAL_STYLESHEETS.length, 'index.html must still declare the full stylesheet set').toBeGreaterThanOrEqual(15)
}

/* Logic fixture: the REAL Files surface markup, no stylesheets. Geometry is never
 * asserted here; the layout fixture below is the only place that measures. */
const LOGIC_DOM = `<!doctype html><html><head><meta charset="utf-8"><title>fixture</title></head><body>
  <div id="main-screen" class="screen">
    <div class="app">
      <aside class="sidebar"></aside>
      ${REAL_CHAT_SECTION}
      <aside class="downloads">
        <div id="mg-downloads-pane" class="mg-drawer-pane">
          ${REAL_DOWNLOADS_CHILDREN}
        </div>
      </aside>
    </div>
  </div>
</body></html>`

/* Layout fixture: the REAL stylesheets from index.html over the REAL downloads
 * markup, inside the REAL parent chain `public/management.js` builds at run time
 * (`aside.downloads > .mg-drawer-tabs + #mg-downloads-pane.mg-drawer-pane`), which
 * is the chain Phase 0 measured in the live app. */
const LAYOUT_DOM = `<!doctype html><html><head><meta charset="utf-8"><title>fixture</title>
  ${REAL_STYLESHEETS.map(href => `<link rel="stylesheet" href="${href}">`).join('')}
</head><body>
  <div id="main-screen" class="screen">
    <div class="app">
      <aside class="sidebar"></aside>
      <main class="chat"></main>
      <aside class="downloads" data-management-mounted="1">
        <div class="mg-drawer-tabs">
          <button id="mg-tab-downloads" class="mg-drawer-tab active" type="button">Downloads</button>
          <button id="mg-tab-info" class="mg-drawer-tab" type="button">Chat Info</button>
        </div>
        <div id="mg-downloads-pane" class="mg-drawer-pane">
          ${REAL_DOWNLOADS_CHILDREN}
        </div>
        <div id="mg-info-pane" class="mg-drawer-pane mg-info-pane hidden"></div>
      </aside>
    </div>
  </div>
</body></html>`

function note (label, value) {
  console.log(`\nCOUNTEREXAMPLE [${label}]\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`)
}

/* Preservation tests record captured baselines, not counterexamples. */
function baseline (label, value) {
  console.log(`\nBASELINE [${label}]\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`)
}

/* Tests that observe the real server say so clearly rather than failing on a
 * connection error that reads like a defect. */
async function assertServerRunning (request) {
  let reachable = false
  let detail = ''
  try {
    const response = await request.get(`${SERVER}/index.html`, { timeout: 5000 })
    reachable = response.ok()
    detail = `HTTP ${response.status()}`
  } catch (error) {
    detail = String(error && error.message ? error.message : error)
  }
  expect(reachable, `this test observes the running application; start it with "npm start" and wait for the [FileGram server] banner (${detail})`).toBe(true)
}

module.exports = {
  ROOT,
  PUBLIC,
  ORIGIN,
  SERVER,
  TEST_CHAT_ID,
  STALE_COUNT,
  CONFIGURED_DIR,
  HIGH_WATER_KEY,
  RECONCILE_MARK_KEY,
  LAYERS,
  MIME,
  INDEX_HTML,
  REAL_STYLESHEETS,
  REAL_DL_CONTROLS,
  REAL_DOWNLOADS_CHILDREN,
  REAL_CHAT_SECTION,
  LOGIC_DOM,
  LAYOUT_DOM,
  rng,
  indexSizes,
  shrinkPairs,
  progressBatches,
  generatedPaths,
  shuffled,
  serveFixture,
  installGlobals,
  loadLayers,
  assertRealBoundary,
  assertRealStylesheets,
  note,
  baseline,
  assertServerRunning
}
