'use strict'

/* Reconciliation and removal-durability invariants for the Files index owner.
 *
 * Two halves, both about `public/files-stability.js`:
 *
 *   1. SOURCE invariants. The two predicates from the design must be permanently
 *      false: `shrinkIsDiscarded` (the persistence boundary silently dropping a
 *      legitimate shrink) and `truthIsOverriddenByCache` (a client cache
 *      substituting itself for Telegram truth). Both were true at HEAD 90a56ce0 and
 *      both were confirmed at run time in the Phase 0 evidence, so they are pinned
 *      here at the source level as well as in the runtime suites.
 *
 *   2. BEHAVIOUR invariants, property-based. The REAL owner file is executed in a
 *      Node context with the browser globals it resolves at load time, exactly as
 *      the Playwright fixtures do in the browser. Nothing about the owner is
 *      stubbed: `writePersistent`, `commitDiscovery`, `commitAuthoritative`,
 *      `union`, `restore` and `reconcile` are the shipped implementations. The
 *      environment provides an in-memory IndexedDB with the same API surface the
 *      owner uses, a localStorage map and a scripted ws transport, so the
 *      properties are checked against real code and generated inputs rather than
 *      against a re-implementation.
 *
 * Generators are seeded, so any counterexample is reproducible from its seed.
 */

const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert/strict')

const root = path.resolve(__dirname, '..')
const readPublic = name => fs.readFileSync(path.join(root, 'public', name), 'utf8')
const readRoot = name => fs.readFileSync(path.join(root, name), 'utf8')

const OWNER_FILE = 'files-stability.js'
const owner = readPublic(OWNER_FILE)

const publicScripts = fs.readdirSync(path.join(root, 'public')).filter(name => name.endsWith('.js'))
const rootScripts = fs.readdirSync(root).filter(name => name.endsWith('.js') && fs.statSync(path.join(root, name)).isFile())

/* Files that task 9.1 deletes outright. They are still on disk while the owner is
 * being proven live (the plan deliberately lands the owner before stripping the
 * legacy layers, so the index is never unowned), so an invariant that must hold for
 * the surviving set tolerates them and tightens by itself when they are deleted. */
const DOOMED_FILES = ['file-consistency-v2.js', 'file-consistency-fix.js']

function functionBody (source, header) {
  const start = source.indexOf(header)
  assert.notEqual(start, -1, `expected to find ${header}`)
  /* Skip the parameter list before looking for the body, so a default value such as
   * `options = {}` is not mistaken for the function body. */
  let cursor = source.indexOf('(', start)
  let parens = 0
  for (; cursor < source.length; cursor++) {
    if (source[cursor] === '(') parens++
    else if (source[cursor] === ')') {
      parens--
      if (!parens) break
    }
  }
  const open = source.indexOf('{', cursor)
  let depth = 0
  for (let index = open; index < source.length; index++) {
    if (source[index] === '{') depth++
    else if (source[index] === '}') {
      depth--
      if (!depth) return source.slice(start, index + 1)
    }
  }
  throw new Error(`unbalanced braces after ${header}`)
}

/* Which function encloses a call site? The owner is one IIFE of named function
 * declarations, so the nearest preceding declaration is the caller. */
function enclosingFunction (source, index) {
  const before = source.slice(0, index)
  const matches = [...before.matchAll(/function\s+([A-Za-z0-9_$]+)\s*\(/g)]
  return matches.length ? matches[matches.length - 1][1] : null
}

function callSites (source, needle) {
  const out = []
  let from = 0
  for (;;) {
    const at = source.indexOf(needle, from)
    if (at < 0) break
    out.push(at)
    from = at + needle.length
  }
  return out
}

/* ==================================================================== */
/* 1. Source invariants                                                  */
/* ==================================================================== */

/* The owner owns persistence. */
assert.match(owner, /const DB_NAME = 'tele-daily-driver-cache-v1'/, 'the owner must own the persistent database')
assert.match(owner, /const DB_STORE = 'file-indexes'/, 'the owner must own the persistent store')
assert.match(owner, /function openDb/, 'the owner must open the database itself')
assert.match(owner, /async function readPersistent/, 'the owner must read the persistent record itself')
assert.match(owner, /async function writePersistent \(chatId, snapshot, options = \{\}\)/, 'the owner must own the persistence boundary')

/* The boundary is UNCONDITIONAL: no count comparison, no shrink escape hatch, no
 * read-before-write. This is `shrinkIsDiscarded` made permanently false. */
const boundary = functionBody(owner, 'async function writePersistent')
assert.doesNotMatch(boundary, /allowShrink/, 'writePersistent must not carry a shrink escape hatch')
assert.doesNotMatch(boundary, /storedCount/, 'writePersistent must not read a stored count')
assert.doesNotMatch(boundary, /readPersistent/, 'writePersistent must not read before writing')
assert.doesNotMatch(boundary, /items\.length\s*[<>]/, 'writePersistent must contain no count comparison')
assert.doesNotMatch(boundary, /\.length\s*[<>]=?\s*[A-Za-z0-9_$.]*[Cc]ount/, 'writePersistent must contain no count comparison')

/* Exactly two functions may reach it, and they are the two the protection moved to.
 * commitDiscovery unions, so it cannot lower a count; commitAuthoritative is the
 * only subtractive path. A partial scan therefore has no route to replace a larger
 * index, which is how clause 3.2 survives without a size check at the boundary. */
const ALLOWED_PERSIST_CALLERS = new Set(['commitDiscovery', 'commitAuthoritative'])
const persistCalls = callSites(owner, 'writePersistent(chatId').filter(at => !owner.slice(0, at).endsWith('async function '))
assert.ok(persistCalls.length >= 2, 'both commit paths must persist')
for (const at of persistCalls) {
  if (owner.slice(at - 20, at).includes('function ')) continue
  const caller = enclosingFunction(owner, at)
  assert.ok(ALLOWED_PERSIST_CALLERS.has(caller), `only commitDiscovery and commitAuthoritative may call writePersistent, saw ${caller}`)
}
for (const name of publicScripts.concat(rootScripts)) {
  if (name === OWNER_FILE) continue
  const source = name.endsWith('.js') && publicScripts.includes(name) ? readPublic(name) : readRoot(name)
  assert.doesNotMatch(source, /writePersistent\s*\(/, `${name} must not call the owner's persistence boundary`)
}

/* commitAuthoritative is the ONLY appender to removedIds, so a removal is always
 * authoritative and always attributable (clause 2.13). */
assert.match(owner, /function appendRemovedIds/, 'durable removals must have one appender')
const appendCalls = callSites(owner, 'appendRemovedIds(').filter(at => !/function\s+$/.test(owner.slice(Math.max(0, at - 12), at)))
assert.equal(appendCalls.length, 1, 'removedIds must be appended from exactly one call site')
assert.equal(enclosingFunction(owner, appendCalls[0]), 'commitAuthoritative', 'only commitAuthoritative may append to removedIds')
assert.match(owner, /const REMOVED_IDS_LIMIT = 5000/, 'removedIds must be capped per chat')
assert.match(owner, /const REMOVED_IDS_TTL = 30 \* 24 \* 60 \* 60 \* 1000/, 'removedIds must be pruned by age')

/* union filters removedIds against the removal watermark, with reconciledAt as the
 * fallback for records that predate per-id stamps. */
const unionBody = functionBody(owner, 'function union (chatId, ...snapshots)')
assert.match(unionBody, /removalBlocks\(chatId, item\.messageId, at\)/, 'union must filter removed ids')
const blocksBody = functionBody(owner, 'function removalBlocks')
assert.match(blocksBody, /removedIds/, 'the removal filter must consult removedIds')
assert.match(blocksBody, /reconciledAt/, 'the removal filter must consult reconciledAt')
const normalizeBody = functionBody(owner, 'function normalize (chatId, snapshot)')
assert.match(normalizeBody, /removalBlocks\(chatId, item\.messageId, at\)/, 'commit-time normalisation must filter removed ids')

/* The permanent per-chat reconcile mark is gone, and its stored value is migrated
 * away so an existing installation is not stuck (clause 2.9). */
const MARK_KEY = 'filegram-files-delete-reconcile-v1'
const markInOwner = callSites(owner, MARK_KEY)
assert.equal(markInOwner.length, 1, 'the owner may reference the legacy mark exactly once, in its migration')
assert.match(owner, /function migrateLegacyReconcileMark/, 'a one-time migration must remove the stored mark')
assert.match(functionBody(owner, 'function migrateLegacyReconcileMark'), /localStorage\.removeItem\(LEGACY_RECONCILE_MARK_KEY\)/, 'the migration must remove the stored value')
assert.match(owner, /migrateLegacyReconcileMark\(\)/, 'the migration must actually run')
for (const name of publicScripts) {
  if (name === OWNER_FILE || DOOMED_FILES.includes(name)) continue
  assert.doesNotMatch(readPublic(name), new RegExp(MARK_KEY), `${name} must not read or write the permanent reconcile mark`)
}
for (const name of DOOMED_FILES) {
  const file = path.join(root, 'public', name)
  if (!fs.existsSync(file)) continue
  // Still on disk until task 9.1 deletes the file outright.
  assert.ok(true, `${name} is scheduled for deletion in task 9.1`)
}

/* Exactly one implementation reads and writes the durable total floor, and it is
 * the owner's - subordinate to Telegram truth. */
const FLOOR_KEY = 'tele-file-index-high-water-v1'
const floorOwners = publicScripts.filter(name => !DOOMED_FILES.includes(name) && readPublic(name).includes(FLOOR_KEY))
assert.deepEqual(floorOwners, [OWNER_FILE], `exactly one implementation may own the durable total floor, saw ${JSON.stringify(floorOwners)}`)
assert.match(owner, /function setTotalFloor/, 'a truth pass must be able to write the floor down')
const authoritativeBody = functionBody(owner, 'async function commitAuthoritative')
assert.match(authoritativeBody, /setTotalFloor\(chatId, floorCount, at\)/, 'the authoritative commit must write the floor from the truth pass')
assert.match(authoritativeBody, /Math\.max\(snapshot\.items\.length, Number\(options\.truth\.count \|\| 0\)\)/, 'the floor must follow Telegram truth, not a partially discovered count')
assert.match(functionBody(owner, 'function maybeRepairIndex'), /floor\.at <= reconciledAt/, 'a floor older than the last truth pass must never trigger a rescan')

/* No layer may substitute a client cache for a scan result. The interception that
 * did (`truthIsOverriddenByCache`) is removed in task 9.2; until then it must exist
 * in at most one file, and never in the owner. */
const interceptors = publicScripts.filter(name => /(^|\n)\s*request = function/.test(readPublic(name)))
assert.ok(interceptors.length <= 1, `at most one layer may replace the global request, saw ${JSON.stringify(interceptors)}`)
if (interceptors.length) {
  assert.deepEqual(interceptors, ['daily-driver-final-guard.js'], 'only the guard may still intercept scan-media-v3, and task 9.2 removes it')
}
assert.doesNotMatch(owner, /request = function/, 'the owner must never intercept the transport')
assert.doesNotMatch(owner, /protectedByClientCache/, 'the owner must never substitute a cached snapshot for a scan result')

/* The shared legacy cache must not gain a NEW writer. The owner is the intended
 * sole writer after task 9.3; this list is the observed set at the point the owner
 * landed, taken from the task 1.6 instrumentation, and it may only shrink. */
const SHARED_CACHE_WRITERS = new Set([
  'files-stability.js', 'daily-driver-final.js', 'daily-driver-final-ui-fix.js', 'daily-driver-hotfix.js',
  'daily-driver-p0-v2.js', 'daily-driver-p1.js', 'daily-driver-p2.js', 'rescue-runtime.js',
  'telegram-daily-driver.js', 'uploads-hardening.js', 'file-consistency-v2.js', 'file-consistency-fix.js'
])
const sharedWriters = publicScripts.filter(name => readPublic(name).includes('rescueFileCache.set'))
for (const name of sharedWriters) {
  assert.ok(SHARED_CACHE_WRITERS.has(name), `${name} is a NEW writer of the shared cache; the owner must be the only one`)
}
assert.ok(sharedWriters.includes(OWNER_FILE), 'the owner must write the shared cache so legacy readers see the committed index')

/* The required diagnostic (clause 2.12): one line, six fields, greppable shape. */
const logBody = functionBody(owner, 'function logReconcile')
for (const field of ['chatId=', 'cached=', 'live=', 'missing=', 'remaining=', 'persisted=', 'truth=', 'complete=', 'accessible=']) {
  assert.ok(logBody.includes(field), `the [Files reconcile] line must carry ${field}`)
}
assert.match(logBody, /console\.info\(`\[Files reconcile\] \$\{parts\.join\(' '\)\}`, missing\)/, 'the full missing list must be attached as a second console argument')
assert.match(functionBody(owner, 'function formatMissing'), /TRUTH_MISSING_LOG_LIMIT/, 'the missing list must be summarised beyond a fixed limit')
assert.match(owner, /const TRUTH_MISSING_LOG_LIMIT = 20/, 'the missing list must print in full up to 20 ids')

/* Truth handling: one call per pass, gated on completeness, exponential backoff. */
const reconcileBody = functionBody(owner, 'async function reconcile (chatId, options = {})')
assert.match(reconcileBody, /request\('media-truth-v1', \{ chatId \}\)/, 'reconciliation must use the single truth request')
assert.equal(callSites(reconcileBody, "request(").length, 1, 'a pass must make exactly one truth call, with no polling')
assert.match(reconcileBody, /truth\.complete && truth\.accessible !== false/, 'pruning must be gated on a complete, accessible truth pass')
assert.match(reconcileBody, /scheduleBackoff\(chatId\)/, 'an unknown result must schedule a backoff retry')
assert.match(owner, /const TRUTH_BACKOFF_START_MS = 2000/, 'backoff must start at 2s, not a 500 ms loop')
assert.match(owner, /const TRUTH_BACKOFF_MAX_MS = 5 \* 60 \* 1000/, 'backoff must cap at 5 minutes')
assert.match(functionBody(owner, 'function scheduleBackoff'), /current\.delay \* 2/, 'backoff must be exponential')
assert.match(owner, /const TRUTH_THROTTLE_MS = 60000/, 'the throttle must be a per-session freshness window')

/* The owner API the other layers need (clause 2.21). */
assert.match(owner, /window\.teleFilesIndex = \{/, 'the owner must expose its API')
for (const method of ['ensure', 'count', 'snapshot', 'total', 'reconcile', 'retireTemporary', 'hardRefresh']) {
  assert.ok(new RegExp(`(^|\\s)${method}[,:]`, 'm').test(owner), `the owner API must expose ${method}`)
}

/* Live deletions are handled by the owner, and the resurrection path that read the
 * shared cache back after a delete is gone (clause 2.7). */
assert.match(owner, /function handleRealtimeDelete/, 'the owner must handle message-delete')
assert.doesNotMatch(owner, /syncFromSharedAfterRealtime\s*\(/, 'the union-from-shared-on-delete path must be gone')
assert.match(functionBody(owner, 'function mergeRealtimeUpsert'), /removedIds\.has\(idOf\(item\.messageId\)\)/, 'the upsert merge must not re-add a removed id')
assert.match(functionBody(owner, 'function handleRealtimeDelete'), /if \(!permanent \|\| fromCache\) return/, 'a TDLib cache eviction must never be treated as a deletion')

/* ==================================================================== */
/* 2. Behaviour invariants, property-based, against the real owner       */
/* ==================================================================== */

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

/* Smart generator: shrink pairs only - a truth pass that reports fewer files than
 * are stored - with the concrete case from the bug report (22 stored, 0 live)
 * pinned in rather than left to chance. */
function shrinkPairs (seed, cases, max = 260) {
  const next = rng(seed)
  const out = [{ stored: 22, live: 0 }, { stored: 1, live: 0 }]
  for (let index = 0; index < cases; index++) {
    const stored = 2 + Math.floor(next() * max)
    out.push({ stored, live: Math.floor(next() * stored) })
  }
  return out
}

function delay (ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

/* In-memory IndexedDB with exactly the surface the owner uses. */
function createIndexedDb () {
  const stores = new Map()
  const created = new Set()
  const clone = value => (value === undefined ? undefined : structuredClone(value))
  return {
    stores,
    created,
    api: {
      open () {
        const request = { onsuccess: null, onerror: null, onupgradeneeded: null, result: null }
        request.result = {
          objectStoreNames: { contains: name => created.has(name) },
          createObjectStore (name) {
            created.add(name)
            if (!stores.has(name)) stores.set(name, new Map())
            return {}
          },
          transaction (name) {
            if (!stores.has(name)) stores.set(name, new Map())
            const store = stores.get(name)
            const pending = []
            const tx = { oncomplete: null, onerror: null, onabort: null }
            tx.objectStore = () => ({
              get (key) {
                const req = { onsuccess: null, onerror: null, result: undefined }
                pending.push(() => { req.result = clone(store.get(String(key))); if (req.onsuccess) req.onsuccess() })
                return req
              },
              put (record) {
                const req = { onsuccess: null, onerror: null }
                pending.push(() => { store.set(String(record.chatId), clone(record)); if (req.onsuccess) req.onsuccess() })
                return req
              }
            })
            setTimeout(() => {
              for (const run of pending) run()
              if (tx.oncomplete) tx.oncomplete()
            }, 0)
            return tx
          },
          close () {}
        }
        setTimeout(() => {
          if (!created.has('file-indexes') && request.onupgradeneeded) request.onupgradeneeded()
          if (request.onsuccess) request.onsuccess()
        }, 0)
        return request
      }
    }
  }
}

function node () { return { textContent: '', disabled: false } }

/* Loads the REAL owner file into a Node context carrying the globals it resolves at
 * load time. Only the environment is provided; every function under test is the
 * shipped implementation. */
function createOwner (options = {}) {
  const db = createIndexedDb()
  const storage = new Map()
  const truthResponses = []
  const requests = []
  const infoLines = []
  const nodes = { '#chat-media-count': node(), '#download-all-media': node(), '#select-all-media': node() }

  const sandbox = {
    console: {
      info: (...args) => infoLines.push(args),
      warn: () => {},
      error: () => {},
      log: () => {}
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    structuredClone,
    indexedDB: db.api,
    localStorage: {
      getItem: key => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key)
    },
    document: { querySelector: selector => nodes[selector] || null },
    state: {
      activeChatId: null,
      view: 'files',
      mediaCount: 0,
      typeCounts: {},
      hasMore: false,
      files: { mode: 'browse', query: '', filter: 'all', sort: 'newest', results: [] }
    },
    rescueFileCache: new Map(),
    request: async (type, payload = {}) => {
      requests.push({ type, payload })
      if (type === 'media-truth-v1') {
        const answer = truthResponses.length > 1 ? truthResponses.shift() : truthResponses[0]
        if (answer && answer.__throw) throw new Error(String(answer.__throw))
        return answer === undefined ? { ok: true } : answer
      }
      if (type === 'scan-media-v3') {
        if (options.scanThrows) throw new Error(String(options.scanThrows))
        return sandbox.__scanResponse
      }
      if (type === 'get-messages') return { messages: [], hasMore: false }
      return { ok: true }
    },
    handleEvent: event => { sandbox.__baseEvents.push(event && event.name) },
    setLoadState: text => { sandbox.__loadStates.push(String(text == null ? '' : text)) },
    renderFiles: () => {},
    renderMessagesList: () => {},
    openChat: async () => {},
    updateMediaCountLabel: () => {},
    rescueUpdateMediaLabel: () => {},
    rescueApplyCompleteFiles: () => {},
    rescueEnsureAllFiles: async () => null,
    filesItems: () => [],
    __baseEvents: [],
    __loadStates: [],
    __scanResponse: { found: 0, scanned: 1, items: [], typeCounts: {}, cancelled: false, done: true, fromCache: false }
  }
  sandbox.window = sandbox
  vm.createContext(sandbox)
  vm.runInContext(owner, sandbox, { filename: 'public/files-stability.js' })

  const itemsRange = (chatId, from, count) => {
    const items = []
    for (let index = from; index < from + count; index++) {
      items.push({ chatId, messageId: 1000000 + index, name: `photo_stale_${index}.jpg`, type: index % 4 === 0 ? 'document' : 'photo', fileSize: 1024 + index })
    }
    return items
  }

  return {
    sandbox,
    api: sandbox.teleFilesIndex,
    requests,
    infoLines,
    loadStates: sandbox.__loadStates,
    nodes,
    storage,
    itemsRange,
    truth (...answers) { truthResponses.length = 0; truthResponses.push(...answers) },
    scan (response) { sandbox.__scanResponse = response },
    activate (chatId) { sandbox.state.activeChatId = chatId },
    record (chatId) { return db.stores.get('file-indexes') ? db.stores.get('file-indexes').get(String(chatId)) || null : null },
    /* Seeds a persistent record the way a previous session would have left one,
     * with its own savedAt so age-based filtering is exercised honestly. */
    seedRecord (chatId, items, savedAt) {
      db.created.add('file-indexes')
      if (!db.stores.has('file-indexes')) db.stores.set('file-indexes', new Map())
      const typeCounts = {}
      for (const item of items) typeCounts[item.type] = (typeCounts[item.type] || 0) + 1
      db.stores.get('file-indexes').set(String(chatId), structuredClone({
        chatId: String(chatId),
        found: items.length,
        scanned: items.length,
        typeCounts,
        items,
        savedAt: Number(savedAt || Date.now()),
        done: true
      }))
    },
    reconcileLines () {
      return this.infoLines.filter(entry => String(entry[0] || '').startsWith('[Files reconcile]')).map(entry => String(entry[0]))
    },
    header () { return nodes['#chat-media-count'].textContent },
    floor (chatId) {
      try { return JSON.parse(storage.get('tele-file-index-high-water-v1') || '{}')[String(chatId)] || null } catch { return null }
    }
  }
}

async function propertyShrinkDurability () {
  for (const pair of shrinkPairs(0x5eed11, 4)) {
    const env = createOwner()
    const chatId = '-1004474514785'
    env.activate(chatId)
    const items = env.itemsRange(chatId, 0, pair.stored)
    env.seedRecord(chatId, items, Date.now() - 60000)
    const restored = await env.api.ensure(chatId)
    assert.equal(restored.items.length, pair.stored, `precondition: the record restores ${pair.stored} rows`)

    const liveIds = items.slice(0, pair.live).map(item => String(item.messageId))
    env.truth({ ok: true, ids: liveIds, count: liveIds.length, complete: true, accessible: true, scanned: pair.stored, source: 'walk' })
    const result = await env.api.reconcile(chatId, { force: true })

    const where = `stored ${pair.stored} -> live ${pair.live}`
    assert.equal(result.status, pair.live === pair.stored ? 'unchanged' : 'pruned', `${where}: the pass must report what it did`)
    assert.equal(env.api.count(chatId), pair.live, `${where}: the committed index must equal Telegram truth`)
    const record = env.record(chatId)
    assert.equal(record.items.length, pair.live, `${where}: the persisted record must equal Telegram truth, including zero`)
    assert.equal(record.truthCount, pair.live, `${where}: the record must carry the truth count`)
    assert.ok(record.reconciledAt > 0, `${where}: the record must carry the truth watermark`)
    assert.equal(env.header(), `${pair.live.toLocaleString()} file${pair.live === 1 ? '' : 's'}`, `${where}: the header must read Telegram truth`)
    if (!pair.live) assert.equal(env.floor(chatId), null, `${where}: the durable floor must be deleted at zero`)
    else assert.equal(env.floor(chatId).count, pair.live, `${where}: the durable floor must be written down to the reconciled count`)

    // Idempotent: a second pass over the same truth changes nothing.
    const again = await env.api.reconcile(chatId, { force: true })
    assert.equal(again.status, 'unchanged', `${where}: a second pass must be a no-op`)
    assert.equal(env.api.count(chatId), pair.live, `${where}: a second pass must not change the index`)
    assert.equal(env.record(chatId).items.length, pair.live, `${where}: a second pass must not change the record`)
  }
}

async function propertyIncompleteTruthIsInert () {
  const failures = [
    { label: 'request threw', answer: { __throw: 'Disconnected' } },
    { label: 'walk threw', answer: { ok: false, ids: [], count: 0, complete: false, accessible: true, scanned: 3, source: 'walk', error: 'boom' } },
    { label: 'incomplete walk', answer: { ok: true, ids: [], count: 0, complete: false, accessible: true, scanned: 3, source: 'walk' } },
    { label: 'inaccessible chat', answer: { ok: true, ids: [], count: 0, complete: false, accessible: false, scanned: 0, source: 'probe' } },
    { label: 'accessible but not complete with ids', answer: { ok: true, ids: ['1000000'], count: 1, complete: false, accessible: true, scanned: 9, source: 'walk' } },
    { label: 'no payload', answer: null }
  ]
  for (const failure of failures) {
    const env = createOwner()
    const chatId = '-1004474514785'
    env.activate(chatId)
    const items = env.itemsRange(chatId, 0, 22)
    env.seedRecord(chatId, items, Date.now() - 60000)
    await env.api.ensure(chatId)
    const before = structuredClone(env.record(chatId))

    env.truth(failure.answer)
    const result = await env.api.reconcile(chatId, { force: true })

    const where = `incomplete truth (${failure.label})`
    assert.equal(result.status, 'unknown', `${where}: the pass must report unknown`)
    assert.equal(env.api.count(chatId), 22, `${where}: the index must be unchanged`)
    assert.equal(env.record(chatId).items.length, before.items.length, `${where}: the record must be unchanged`)
    assert.equal((env.record(chatId).removedIds || []).length, 0, `${where}: no prune may be recorded`)
    assert.equal(env.record(chatId).savedAt, before.savedAt, `${where}: the record must not even be rewritten`)
    const lines = env.reconcileLines()
    assert.equal(lines.length, 1, `${where}: exactly one diagnostic line per pass`)
    assert.match(lines[0], /live=unknown/, `${where}: an unknown result must be reported as unknown, not as zero`)
    assert.match(lines[0], /persisted=skipped\(reason=/, `${where}: the diagnostic must say why nothing was written`)
    assert.match(lines[0], /remaining=22/, `${where}: the diagnostic must report the surviving count`)
    assert.ok(
      env.loadStates.some(text => /could not verify against telegram/i.test(text)),
      `${where}: the failure must be surfaced in the load state, not only in console.warn`
    )
  }
}

async function propertyUnionNeverResurrects () {
  const env = createOwner()
  const chatId = '-1004474514785'
  env.activate(chatId)
  const items = env.itemsRange(chatId, 0, 22)
  const stale = Date.now() - 60000
  env.seedRecord(chatId, items, stale)
  await env.api.ensure(chatId)

  env.truth({ ok: true, ids: [], count: 0, complete: true, accessible: true, scanned: 1, source: 'walk' })
  await env.api.reconcile(chatId, { force: true })
  assert.equal(env.api.count(chatId), 0, 'precondition: the truth pass emptied the index')

  /* Every stale source clause 2.7 enumerates, replayed against the fixed owner:
   * a legacy layer writes the pre-prune record back, and the shared cache still
   * holds the pre-prune snapshot. Both carry their own older savedAt. */
  env.seedRecord(chatId, items, stale)
  env.sandbox.rescueFileCache.set(String(chatId), {
    chatId,
    items,
    found: items.length,
    scanned: items.length,
    typeCounts: {},
    savedAt: stale,
    done: true
  })

  const restored = await env.api.ensure(chatId)
  assert.equal(restored ? restored.items.length : 0, 0, 'restore must not union a stale record back in')
  assert.equal(env.api.count(chatId), 0, 'the committed index must stay pruned')
  assert.equal(env.sandbox.rescueFileCache.get(String(chatId)).items.length, 0, 'the shared cache must not repopulate the index')

  /* ... and the same through the scan-result merge path. */
  env.scan({ found: 22, scanned: 22, items: structuredClone(items), typeCounts: {}, cancelled: false, done: true, fromCache: false, savedAt: stale })
  await env.api.ensure(chatId, { hardRefresh: true })
  assert.equal(env.api.count(chatId), 0, 'a scan result older than the truth pass must not resurrect removed ids')
}

async function propertyRemovalIsNotABlacklist () {
  const env = createOwner()
  const chatId = '-1004474514785'
  env.activate(chatId)
  const items = env.itemsRange(chatId, 0, 12)
  env.seedRecord(chatId, items, Date.now() - 60000)
  await env.api.ensure(chatId)

  env.truth({ ok: true, ids: items.slice(0, 9).map(item => String(item.messageId)), count: 9, complete: true, accessible: true, scanned: 12, source: 'walk' })
  await env.api.reconcile(chatId, { force: true })
  assert.equal(env.api.count(chatId), 9, 'precondition: three ids were removed')
  assert.equal(env.record(chatId).removedIds.length, 3, 'precondition: the removals are durable')

  // A later truth pass reports every id present again (a genuine re-upload).
  env.scan({ found: 12, scanned: 12, items: structuredClone(items), typeCounts: {}, cancelled: false, done: true, fromCache: false })
  env.truth({ ok: true, ids: items.map(item => String(item.messageId)), count: 12, complete: true, accessible: true, scanned: 12, source: 'walk' })
  await env.api.hardRefresh(chatId)

  assert.equal(env.api.count(chatId), 12, 'a truth pass reporting removed ids present again must bring them back')
  assert.equal(env.record(chatId).items.length, 12, 'the durable record must hold them again')
  assert.equal(env.record(chatId).removedIds.length, 0, 'removedIds must not be a permanent blacklist')
}

/* Order independence over the operations that genuinely commute: restores and truth
 * passes, in any interleaving, converge on Telegram truth and a later restore never
 * re-grows the index.
 *
 * A permanent delete followed by a FRESH discovery of the same id is deliberately
 * NOT in this set: the removal watermark is compared against the contributing
 * snapshot's age, so newer evidence wins by design (that is what stops `removedIds`
 * from becoming a blacklist). That case is pinned separately below, so the
 * behaviour is asserted rather than assumed. */
async function propertyOrderIndependence () {
  const chatId = '-1004474514785'
  const orders = [
    ['ensure', 'reconcile', 'ensure', 'reconcile'],
    ['reconcile', 'ensure', 'reconcile', 'ensure'],
    ['ensure', 'ensure', 'reconcile', 'ensure'],
    ['reconcile', 'reconcile', 'ensure', 'ensure']
  ]
  const outcomes = []
  for (const order of orders) {
    const env = createOwner()
    env.activate(chatId)
    const items = env.itemsRange(chatId, 0, 12)
    env.seedRecord(chatId, items, Date.now() - 60000)
    await env.api.ensure(chatId)
    // Telegram truth: ids 1000000..1000009 exist, 1000010 and 1000011 do not.
    env.truth({ ok: true, ids: items.slice(0, 10).map(item => String(item.messageId)), count: 10, complete: true, accessible: true, scanned: 12, source: 'walk' })

    for (const step of order) {
      if (step === 'ensure') await env.api.ensure(chatId)
      else await env.api.reconcile(chatId, { force: true })
      await delay(10)
    }
    outcomes.push({ order: order.join('>'), committed: env.api.count(chatId), record: env.record(chatId).items.length })
  }
  for (const outcome of outcomes) {
    assert.equal(outcome.committed, 10, `order ${outcome.order}: the committed index must converge on truth, saw ${JSON.stringify(outcomes)}`)
    assert.equal(outcome.record, 10, `order ${outcome.order}: the record must converge on truth, saw ${JSON.stringify(outcomes)}`)
  }
}

/* Newest evidence wins, and only for a source that is newer than the removal.
 * This is the discriminator that keeps a stale record from resurrecting a pruned row
 * (propertyUnionNeverResurrects) while a genuine re-upload still lands. */
async function propertyNewestEvidenceWins () {
  const env = createOwner()
  const chatId = '-1004474514785'
  env.activate(chatId)
  const items = env.itemsRange(chatId, 0, 12)
  env.seedRecord(chatId, items, Date.now() - 60000)
  await env.api.ensure(chatId)
  const handleEvent = env.sandbox.handleEvent

  handleEvent({ name: 'message-delete', chatId, messageIds: [String(items[0].messageId)], isPermanent: true, fromCache: false })
  await delay(40)
  assert.equal(env.api.count(chatId), 11, 'precondition: the permanent delete pruned one row')

  /* The same source through the same path, with only its age changing. A scan result
   * stamped before the removal is a stale copy and must not bring the row back. */
  env.scan({ found: 12, scanned: 12, items: structuredClone(items), typeCounts: {}, cancelled: false, done: true, fromCache: false, savedAt: Date.now() - 60000 })
  await env.api.ensure(chatId, { hardRefresh: true })
  assert.equal(env.api.count(chatId), 11, 'a source older than the removal must not resurrect the row')
  assert.equal(env.record(chatId).items.length, 11, 'and it must not resurrect it in the record either')

  // An unstamped, freshly fetched result is newer evidence, so it does.
  env.scan({ found: 12, scanned: 12, items: structuredClone(items), typeCounts: {}, cancelled: false, done: true, fromCache: false })
  await env.api.ensure(chatId, { hardRefresh: true })
  assert.equal(env.api.count(chatId), 12, 'a source newer than the removal is newer evidence and wins')
}

async function propertyPermanentDeleteOnly () {
  const env = createOwner()
  const chatId = '-1004474514785'
  env.activate(chatId)
  const items = env.itemsRange(chatId, 0, 12)
  env.seedRecord(chatId, items, Date.now() - 60000)
  await env.api.ensure(chatId)
  const handleEvent = env.sandbox.handleEvent

  // A TDLib local-cache eviction: never a deletion event.
  handleEvent({ name: 'message-delete', chatId, messageIds: items.slice(0, 5).map(item => String(item.messageId)), isPermanent: false, fromCache: true })
  await delay(30)
  assert.equal(env.api.count(chatId), 12, 'a cache eviction must not prune the index')
  assert.equal(env.record(chatId).items.length, 12, 'a cache eviction must not prune the record')

  // A real Telegram deletion: durable, immediate, no refresh.
  handleEvent({ name: 'message-delete', chatId, messageIds: items.slice(0, 3).map(item => String(item.messageId)), isPermanent: true, fromCache: false })
  await delay(60)
  assert.equal(env.api.count(chatId), 9, 'a permanent deletion must prune the index without a refresh')
  assert.equal(env.record(chatId).items.length, 9, 'a permanent deletion must prune the persisted record')
  assert.equal(env.record(chatId).removedIds.length, 3, 'a permanent deletion must be recorded durably')
}

/* An in-progress total is still not a completed one (clause 3.3), and a pass must
 * not subtract from a set that is still arriving. */
async function propertyPartialIndexIsNotStampedComplete () {
  const chatId = '-1004474514785'

  // Leg 1: truth reports MORE than the index holds. Nothing is missing, so nothing is
  // pruned, but the index must not be stamped complete and the floor must follow
  // Telegram's count rather than what has been discovered so far.
  const env = createOwner()
  env.activate(chatId)
  const items = env.itemsRange(chatId, 0, 300)
  env.seedRecord(chatId, items, Date.now() - 60000)
  await env.api.ensure(chatId)
  const liveIds = items.map(item => String(item.messageId)).concat(
    env.itemsRange(chatId, 300, 700).map(item => String(item.messageId))
  )
  env.truth({ ok: true, ids: liveIds, count: liveIds.length, complete: true, accessible: true, scanned: 1000, source: 'walk' })
  const result = await env.api.reconcile(chatId, { force: true })
  assert.equal(result.status, 'unchanged', 'an under-full index has nothing missing')
  assert.equal(env.api.count(chatId), 300, 'an under-full index is not pruned')
  assert.equal(env.api.snapshot(chatId).done, false, 'an index below the truth count must not be stamped complete')
  assert.equal(env.record(chatId).done, false, 'and the record must say so too')
  assert.equal(env.floor(chatId).count, 1000, 'the durable floor must follow Telegram truth, not the partial count')

  /* Leg 2: a chat whose index is arriving right now - no record yet, one unflushed
   * progress batch in hand - blocks the pass outright. (A chat that already holds a
   * COMPLETE index treats such an event as an obsolete scan and drops it, which is
   * the pre-existing `mergeProgress` guard, so this leg deliberately uses a chat
   * with nothing committed.) */
  const streaming = createOwner()
  streaming.activate(chatId)
  streaming.truth({ ok: true, ids: [], count: 0, complete: true, accessible: true, scanned: 1, source: 'walk' })
  streaming.sandbox.handleEvent({
    name: 'media-index-progress',
    payload: { chatId, items: streaming.itemsRange(chatId, 0, 40), scanned: 40, done: false }
  })
  const skipped = await streaming.api.reconcile(chatId, { force: true })
  assert.equal(skipped.status, 'skipped', 'a pass must not run against a streaming index')
  assert.equal(skipped.reason, 'scan-in-flight', 'and it must say why')
  assert.equal(streaming.reconcileLines().length, 0, 'a pass that never asked the server must not log a line')
  assert.equal(streaming.requests.filter(entry => entry.type === 'media-truth-v1').length, 0, 'and it must not call the server')
}

async function propertyThrottleAndBackoff () {
  const env = createOwner()
  const chatId = '-1004474514785'
  env.activate(chatId)
  env.seedRecord(chatId, env.itemsRange(chatId, 0, 22), Date.now() - 60000)
  await env.api.ensure(chatId)

  env.truth({ ok: true, ids: [], count: 0, complete: false, accessible: true, scanned: 1, source: 'walk' })
  await env.api.reconcile(chatId, { force: true })
  const afterFirst = env.requests.filter(entry => entry.type === 'media-truth-v1').length
  assert.equal(afterFirst, 1, 'one pass makes exactly one truth call')

  const throttled = await env.api.reconcile(chatId)
  assert.equal(throttled.status, 'skipped', 'a second pass inside the freshness window must be skipped')
  assert.equal(throttled.reason, 'throttled', 'and it must say why')
  assert.equal(env.requests.filter(entry => entry.type === 'media-truth-v1').length, 1, 'a throttled pass must not call the server')
  assert.equal(env.reconcileLines().length, 1, 'a throttled pass is not a pass and must not log')

  // The backoff retry must not fire inside the first two seconds.
  await delay(1500)
  assert.equal(env.requests.filter(entry => entry.type === 'media-truth-v1').length, 1, 'the first backoff retry must be at least 2s away')
}

async function main () {
  await propertyShrinkDurability()
  await propertyIncompleteTruthIsInert()
  await propertyUnionNeverResurrects()
  await propertyRemovalIsNotABlacklist()
  await propertyOrderIndependence()
  await propertyNewestEvidenceWins()
  await propertyPermanentDeleteOnly()
  await propertyPartialIndexIsNotStampedComplete()
  await propertyThrottleAndBackoff()
  console.log('files reconcile checks passed')
}

main().then(() => process.exit(0)).catch(error => {
  console.error(error)
  process.exit(1)
})
