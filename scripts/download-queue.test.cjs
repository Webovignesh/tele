'use strict'

/* Behavioural regression tests for the download queue state machine.
 *
 * server.js cannot be required directly: importing it dials TDLib and binds
 * port 3000. So the real DownloadManager source is extracted from server.js and
 * evaluated against stubs. The class under test is therefore the shipping code,
 * not a copy that can drift.
 *
 * These cover the bug where "Cancel all" and "Clear all" only affected the
 * active workers (about CONCURRENCY jobs) instead of the whole queue.
 */

const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')

const root = path.resolve(__dirname, '..')
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8')

/* ---- extract `const CANCELLABLE ... class DownloadManager { ... }` ---- */

function extractQueueSource (text) {
  const constStart = text.indexOf('const CANCELLABLE')
  assert.ok(constStart > 0, 'CANCELLABLE queue-state list must exist in server.js')
  const classStart = text.indexOf('class DownloadManager {', constStart)
  assert.ok(classStart > 0, 'DownloadManager class must exist in server.js')
  let depth = 0
  let index = text.indexOf('{', classStart)
  const bodyStart = index
  for (; index < text.length; index++) {
    const ch = text[index]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) break
    }
  }
  assert.ok(index > bodyStart, 'DownloadManager class body must be brace-balanced')
  return text.slice(constStart, index + 1)
}

function makeHarness (concurrency = 8) {
  const invocations = []
  const broadcasts = []

  const client = {
    invoke (payload) {
      invocations.push(payload)
      if (payload._ === 'getFile') return Promise.resolve({ size: 1000 })
      if (payload._ === 'downloadFile') {
        // Resolves without completing, so nothing auto-finalizes and the test
        // controls every terminal transition explicitly.
        return Promise.resolve({ local: { is_downloading_completed: false } })
      }
      return Promise.resolve({})
    }
  }

  const fakeFs = {
    existsSync: () => false,
    mkdirSync: () => {},
    promises: {
      rename: () => Promise.resolve(),
      copyFile: () => Promise.resolve(),
      unlink: () => Promise.resolve()
    }
  }

  const factory = new Function(
    'crypto', 'client', 'ready', 'sendAll', 'fs', 'path', 'downloadsDir', 'sanitize', 'uniquePath', 'initialConcurrency',
    `let CONCURRENCY = initialConcurrency
     ${extractQueueSource(source)}
     return {
       DownloadManager,
       CANCELLABLE,
       TERMINAL,
       STALL_AFTER_MS,
       MAX_ATTEMPTS,
       setConcurrency: value => { CONCURRENCY = value },
       getConcurrency: () => CONCURRENCY
     }`
  )

  let seq = 0
  const api = factory(
    { randomUUID: () => `job-${++seq}` },
    client,
    true, // `ready`, so the watchdog does not bail on a half-initialised client
    message => broadcasts.push(message),
    fakeFs,
    path,
    '/downloads',
    name => String(name),
    (dir, name) => path.join(dir, name),
    concurrency
  )

  return { ...api, invocations, broadcasts, dm: new api.DownloadManager() }
}

function enqueue (dm, count, offset = 0) {
  const ids = []
  for (let i = 0; i < count; i++) {
    ids.push(dm.add(-100, 'Channel', 1000 + offset + i, 5000 + offset + i, `file-${offset + i}.bin`, 1000))
  }
  return ids
}

function countByStatus (dm) {
  const out = {}
  for (const job of dm.jobs.values()) out[job.status] = (out[job.status] || 0) + 1
  return out
}

// finalize() is async and callers do not await it, so drain the microtask queue.
const settle = () => new Promise(resolve => setImmediate(resolve))

function trulyActive (dm) {
  let active = 0
  for (const job of dm.jobs.values()) if (job.active) active++
  return active
}

const stoppedUpdate = job => ({
  id: job.fileId,
  local: { is_downloading_active: false, is_downloading_completed: false }
})

/* ------------------------------------------------------------------ */
/* Queue-state vocabulary                                             */
/* ------------------------------------------------------------------ */
{
  const { CANCELLABLE, TERMINAL } = makeHarness()
  assert.deepEqual(CANCELLABLE, ['queued', 'downloading', 'paused'], 'cancellable states must be queued/downloading/paused')
  assert.deepEqual(TERMINAL, ['done', 'error', 'cancelled'], 'terminal states must be done/error/cancelled')
}

/* ------------------------------------------------------------------ */
/* Test 1: concurrency 8, enqueue 100, cancel all                      */
/* ------------------------------------------------------------------ */
{
  const { dm, invocations } = makeHarness(8)
  enqueue(dm, 100)

  assert.equal(dm.jobs.size, 100, 'the server must hold all 100 jobs')
  assert.equal(dm.activeCount, 8, 'exactly CONCURRENCY jobs may be active')
  const before = countByStatus(dm)
  assert.equal(before.downloading, 8)
  assert.equal(before.queued, 92)

  const cancelled = dm.cancelAll()
  assert.equal(cancelled, 100, 'cancel all must cancel the whole queue, not just the active workers')

  const after = countByStatus(dm)
  assert.equal(after.cancelled, 100, 'every job must end cancelled')
  assert.equal(after.queued, undefined, 'no job may remain pending')
  assert.equal(after.downloading, undefined, 'no job may remain active')
  assert.equal(dm.activeCount, 0, 'every concurrency slot must be released')

  const stats = dm.stats()
  assert.equal(stats.total, 100)
  assert.equal(stats.remaining, 0, 'Remaining must fall to 0 for cancellable work')
  assert.equal(stats.queued, 0)
  assert.equal(stats.downloading, 0)

  // Active jobs must actually be aborted at the TDLib layer.
  assert.equal(invocations.filter(i => i._ === 'cancelDownloadFile').length, 8, 'each active job must receive a cancel')

  // Nothing may start later.
  dm.tryRun()
  assert.equal(dm.activeCount, 0, 'the scheduler must not dequeue cancelled work')
  assert.equal(countByStatus(dm).downloading, undefined, 'no job may restart after cancel all')
}

/* ------------------------------------------------------------------ */
/* Test 2: concurrency 8, enqueue 100, clear all                       */
/* ------------------------------------------------------------------ */
{
  const { dm, invocations } = makeHarness(8)
  enqueue(dm, 100)

  const result = dm.clearAll()
  assert.equal(result.cancelled, 100, 'clear all must cancel every unfinished job first')
  assert.equal(dm.jobs.size, 0, 'the entire queue and history must be empty')
  assert.equal(dm.activeCount, 0, 'no concurrency slot may stay leased')
  assert.equal(dm.stats().total, 0, 'Total must be 0')
  assert.equal(dm.stats().remaining, 0, 'Remaining must be 0')
  assert.equal(invocations.filter(i => i._ === 'cancelDownloadFile').length, 8, 'active jobs must be aborted, not merely forgotten')

  dm.tryRun()
  assert.equal(dm.activeCount, 0, 'nothing may start after clear all')
}

/* ------------------------------------------------------------------ */
/* Test 3: enqueue 100, complete 10 -> 10 done / 90 remaining / 100    */
/* ------------------------------------------------------------------ */
async function runCompletionTest () {
  const { dm } = makeHarness(8)
  enqueue(dm, 100)

  // Completing a job frees its slot and the pump starts the next queued one, so
  // there is always an active job to finish.
  for (let completed = 0; completed < 10; completed++) {
    const job = [...dm.jobs.values()].find(j => j.status === 'downloading')
    assert.ok(job, 'an active job must be available to complete')
    await dm.finalize(job, '/tmp/src.bin')
  }

  const stats = dm.stats()
  assert.equal(stats.done, 10, 'Downloaded must count completed jobs')
  assert.equal(stats.total, 100, 'Total must be the whole queue')
  assert.equal(stats.remaining, 90, 'Remaining must be pending + active + paused')
  assert.equal(stats.done + stats.remaining, 100, 'done + remaining must account for the queue')
  assert.equal(stats.downloading, 8, 'the pump must keep CONCURRENCY jobs running')
}

/* ------------------------------------------------------------------ */
/* Test 4: pause all / resume all over a queue larger than concurrency */
/* ------------------------------------------------------------------ */
function runPauseTests () {
  {
    const { dm } = makeHarness(8)
    enqueue(dm, 100)

    const paused = dm.pauseAll()
    assert.equal(paused, 100, 'pause all must cover pending jobs as well as active ones')
    const after = countByStatus(dm)
    assert.equal(after.paused, 100)
    assert.equal(after.downloading, undefined, 'no job may stay active while paused')
    assert.equal(dm.activeCount, 0, 'pausing must release every slot')
    assert.equal(dm.stats().remaining, 100, 'paused work still needs to complete, so it stays in Remaining')

    dm.tryRun()
    assert.equal(dm.activeCount, 0, 'the scheduler must not resume paused work on its own')

    const resumed = dm.resumeAll()
    assert.equal(resumed, 100, 'resume all must requeue the whole paused set')
    assert.equal(dm.activeCount, 8, 'resuming must refill exactly CONCURRENCY slots')
    assert.equal(countByStatus(dm).queued, 92)
  }

  /* ---- clear done removes only terminal entries ---- */
  {
    const { dm } = makeHarness(8)
    enqueue(dm, 20)
    const victim = [...dm.jobs.values()].find(j => j.status === 'downloading')
    dm.cancel(victim.jobId)
    const removed = dm.clearDone()
    assert.equal(removed, 1, 'clear done must remove exactly the terminal entries')
    assert.equal(dm.jobs.size, 19, 'live work must survive clear done')
    assert.equal(dm.stats().remaining, 19)
  }

  /* ---- removing an ACTIVE job must abort it and free its slot ---- */
  {
    const { dm, invocations } = makeHarness(4)
    enqueue(dm, 10)
    assert.equal(dm.activeCount, 4)
    const job = [...dm.jobs.values()].find(j => j.status === 'downloading')
    invocations.length = 0
    dm.remove(job.jobId)
    assert.equal(dm.jobs.has(job.jobId), false, 'the job record must be gone')
    assert.equal(invocations.filter(i => i._ === 'cancelDownloadFile').length, 1, 'removing a live job must cancel the TDLib download')
    assert.equal(dm.activeCount, 4, 'the freed slot must be refilled, not leaked')
    assert.equal(dm.stats().total, 9)
  }

  /* ---- a cancelled job may not be resurrected as done/error ---- */
  {
    const { dm } = makeHarness(2)
    enqueue(dm, 4)
    const job = [...dm.jobs.values()].find(j => j.status === 'downloading')
    dm.cancel(job.jobId)
    assert.equal(job.status, 'cancelled')
    // A TDLib completion arriving after the cancel must be ignored.
    dm.onFileUpdate({ id: job.fileId, local: { is_downloading_completed: true, path: '/tmp/late.bin' } })
    assert.equal(job.status, 'cancelled', 'a late completion must not overwrite a cancellation')
  }
}

/* ------------------------------------------------------------------ */
/* Guard: no client layer may fan bulk actions out per job             */
/* ------------------------------------------------------------------ */
function runClientContractTests () {
  const uiFix = fs.readFileSync(path.join(root, 'public', 'daily-driver-final-ui-fix.js'), 'utf8')
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8')

  assert.match(uiFix, /function applyQueueAction/, 'bulk actions must go through the single server-wide helper')
  assert.match(uiFix, /applyQueueAction\('cancel-all'\)/, 'Cancel all must call the whole-queue endpoint')
  assert.match(uiFix, /applyQueueAction\('clear-all'\)/, 'Clear all must call the whole-queue endpoint')
  assert.match(uiFix, /applyQueueAction\('clear-done'\)/, 'Clear done must call the whole-queue endpoint')
  assert.match(uiFix, /applyQueueAction\('pause-all'\)/, 'Pause all must call the whole-queue endpoint')
  assert.match(uiFix, /applyQueueAction\('resume-all'\)/, 'Resume all must call the whole-queue endpoint')
  assert.doesNotMatch(uiFix, /runRequestQueue/, 'the per-job bulk fan-out must be gone')
  assert.match(uiFix, /state\.queueStats/, 'stats must read the server aggregate')

  assert.match(app, /case 'download-stats'/, 'the client must consume the queue aggregate event')
  assert.match(app, /queueStats/, 'state must carry the server queue aggregate')
  assert.match(app, /request\('clear-done'/, 'legacy clear-done must use the server endpoint')

  const server = source
  assert.match(server, /clearAll \(\)/, 'the server must expose a whole-queue clear')
  assert.match(server, /clearDone \(\)/, 'the server must expose a terminal-only clear')
  assert.match(server, /case 'clear-all'/, 'clear-all must be reachable over the socket')
  assert.match(server, /case 'clear-done'/, 'clear-done must be reachable over the socket')
  assert.match(server, /stats \(\)/, 'the server must aggregate queue statistics')
}

/* ------------------------------------------------------------------ */
/* Stall regressions                                                   */
/*                                                                     */
/* Reported symptom: a 267-file batch stops after a while. The UI shows */
/* 0 B/s, done 0, remaining 267, and rows labelled QUEUED with a full   */
/* progress bar. Pause all then Resume all changes nothing.            */
/* ------------------------------------------------------------------ */
async function runStallTests () {
  /* ---- a completion must finalize a job that is NOT 'downloading' ----
   * The same TDLib file id can be driven by a duplicate job, downloadThumb or
   * ensureLocalFile, so a job can still be 'queued' when its bytes finish.
   * Gating completion on 'downloading' dropped the signal: the row kept a full
   * bar labelled QUEUED for ever and stats().done never moved. */
  {
    const { dm } = makeHarness(2)
    enqueue(dm, 10)
    const queued = [...dm.jobs.values()].find(j => j.status === 'queued')
    assert.ok(queued, 'a queued job must exist')

    dm.onFileUpdate({
      id: queued.fileId,
      local: { is_downloading_completed: true, path: '/tmp/done.bin', downloaded_size: 1000 }
    })
    await settle()

    assert.equal(queued.status, 'done', 'a completion must finalize a queued job, not be discarded')
    assert.equal(dm.stats().done, 1, 'stats().done must reflect it')
  }

  /* ---- a stopped download must not hold its slot for ever ----
   * updateFile with neither is_downloading_active nor is_downloading_completed
   * used to be a total no-op, leaving the job parked in 'downloading'. Eight of
   * those starved the queue permanently. */
  {
    const { dm } = makeHarness(2)
    enqueue(dm, 5)
    const job = [...dm.jobs.values()].find(j => j.status === 'downloading')
    const attemptsBefore = job.attempts

    dm.onFileUpdate(stoppedUpdate(job))

    assert.ok(job.attempts > attemptsBefore || job.status === 'queued', 'a stopped download must be retried')
    assert.equal(dm.activeCount, 2, 'the slot must be reused, not leaked')
    assert.equal(dm.activeCount, trulyActive(dm), 'the slot count must match reality')
  }

  /* ---- retries are bounded ---- */
  {
    const { dm, MAX_ATTEMPTS } = makeHarness(1)
    enqueue(dm, 1)
    const job = [...dm.jobs.values()][0]
    for (let attempt = 0; attempt <= MAX_ATTEMPTS + 1; attempt++) dm.onFileUpdate(stoppedUpdate(job))
    assert.equal(job.status, 'error', 'a permanently stopped download must end as error, not retry for ever')
    assert.match(job.error, /gave up/, 'the reason must say it gave up')
    assert.equal(dm.activeCount, 0, 'its slot must be released')
  }

  /* ---- a leaked slot count starves the pump, and reconcile heals it ---- */
  {
    const { dm } = makeHarness(2)
    enqueue(dm, 6)
    assert.equal(dm.activeCount, 2)

    // Simulate the historical leak: the counter says the workers are busy while
    // no job actually holds a slot.
    dm.activeCount = 5
    dm.tryRun()
    assert.equal(countByStatus(dm).downloading, 2, 'a leaked count starves the scheduler')

    assert.equal(dm.reconcile(), true, 'reconcile must report the drift')
    assert.equal(dm.activeCount, trulyActive(dm), 'the count must be derived from reality')
    assert.equal(dm.activeCount, 2)
  }

  /* ---- finishJob must pump even when the job held no slot ---- */
  {
    const { dm } = makeHarness(2)
    enqueue(dm, 5)
    const queued = [...dm.jobs.values()].find(j => j.status === 'queued')
    dm.activeCount = 1 // a slot is free but nothing is driving the pump
    dm.finishJob(queued)
    assert.equal(dm.activeCount, 2, 'a terminal transition must re-pump regardless of slot ownership')
  }

  /* ---- Resume all must un-wedge jobs that are not merely paused ----
   * resumeAll only matched status === 'paused', so a job stuck in 'downloading'
   * was invisible to it: the button reported success and started nothing. */
  {
    const { dm } = makeHarness(2)
    enqueue(dm, 4)
    const job = [...dm.jobs.values()].find(j => j.status === 'downloading')
    // Its runner vanished: marked downloading, holds no slot.
    job.active = false
    dm.activeCount = 1

    const resumed = dm.resumeAll()
    assert.ok(resumed >= 1, 'Resume all must recover a wedged job')
    assert.ok(job.active || job.status === 'queued', 'the wedged job must be running or requeued')
    assert.equal(dm.activeCount, trulyActive(dm), 'slots must stay consistent')
  }

  /* ---- pause -> resume must not let a stale runner corrupt the new one ----
   * Exactly one job at concurrency 1, so pausing frees the only slot and resuming
   * is guaranteed to start a fresh runner. With a second job in the queue the
   * pause would hand the slot to that job instead, and resume would correctly
   * start nothing. */
  {
    const { dm } = makeHarness(1)
    enqueue(dm, 1)
    const job = [...dm.jobs.values()][0]
    const runBefore = job.run
    assert.ok(runBefore > 0, 'a started job must carry a generation token')

    dm.pause(job.jobId)
    assert.equal(job.status, 'paused')
    assert.equal(dm.activeCount, 0, 'pausing the only active job must free the slot')

    dm.resume(job.jobId)
    await settle()

    assert.ok(job.run > runBefore, 'resuming must invalidate the previous runner')
    assert.equal(job.status, 'downloading', 'resuming must actually restart the job')
    assert.equal(dm.activeCount, trulyActive(dm), 'the double runner must not double-release a slot')
  }

  /* ---- the server must actually measure speed ----
   * job.speed was never assigned, so stats().speed was structurally 0 despite
   * being documented as the sanctioned source for the Speed readout. */
  {
    const { dm } = makeHarness(1)
    enqueue(dm, 1)
    const job = [...dm.jobs.values()][0]
    job.lastProgressAt = Date.now() - 1000
    dm.onFileUpdate({ id: job.fileId, local: { is_downloading_active: true, downloaded_size: 500 } })
    assert.ok(job.speed > 0, 'a progressing download must report a speed')
    assert.ok(dm.stats().speed > 0, 'the aggregate must expose it')
  }

  /* ---- finalize must not run twice and flip done -> error ---- */
  {
    const { dm } = makeHarness(1)
    enqueue(dm, 1)
    const job = [...dm.jobs.values()][0]
    await Promise.all([dm.finalize(job, '/tmp/a.bin'), dm.finalize(job, '/tmp/a.bin')])
    assert.equal(job.status, 'done', 'a second finalize must not overwrite the first')
    assert.equal(dm.activeCount, trulyActive(dm))
  }

  /* ---- a late completion must not resurrect a finished job ---- */
  {
    const { dm } = makeHarness(1)
    enqueue(dm, 1)
    const job = [...dm.jobs.values()][0]
    await dm.finalize(job, '/tmp/a.bin')
    assert.equal(job.status, 'done')
    dm.onFileUpdate({ id: job.fileId, local: { is_downloading_active: true, downloaded_size: 10 } })
    assert.equal(job.status, 'done', 'a terminal job must ignore later updates')
  }
}

/* ------------------------------------------------------------------ */
/* Static guards for the recovery machinery                            */
/* ------------------------------------------------------------------ */
function runRecoveryContractTests () {
  assert.match(source, /STALL_AFTER_MS/, 'a stall threshold must exist')
  assert.match(source, /sweep \(\)/, 'a watchdog pass must exist')
  assert.match(source, /reconcile \(\)/, 'the slot count must be reconcilable')
  assert.match(source, /requeue \(job, reason\)/, 'stuck jobs must be requeueable')
  assert.match(source, /recover \(\)/, 'explicit recovery must exist for Resume all')
  assert.match(source, /this\.sweepTimer = setInterval/, 'the watchdog must be scheduled')
  assert.match(source, /sweepTimer\.unref/, 'the watchdog must not hold the process open')
  assert.match(source, /const stale = \(\) => job\.run !== run/, 'runners must detect that they are stale')
  assert.match(source, /job\.status === 'done' && destPath/, 'the done broadcast must guard destPath')

  // finishJob must pump outside the slot-ownership branch.
  const finishJob = /finishJob \(job\) \{([\s\S]*?)\n  \}/.exec(source)
  assert.ok(finishJob, 'finishJob must exist')
  const body = finishJob[1]
  const pumpIndex = body.indexOf('this.tryRun()')
  const closeIndex = body.indexOf('}')
  assert.ok(pumpIndex > closeIndex, 'tryRun must be called outside the `if (job.active)` block')
}

;(async () => {
  await runCompletionTest()
  runPauseTests()
  await runStallTests()
  runRecoveryContractTests()
  runClientContractTests()
  console.log('download queue checks passed')
})().catch(error => {
  console.error(error)
  process.exit(1)
})
