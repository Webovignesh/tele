'use strict'

const path = require('node:path')
const fs = require('node:fs')
const http = require('node:http')
const crypto = require('node:crypto')
// Owns the download folder picker (POST /api/filegram/pick-download-folder), which
// spawns the Windows common item dialog. computeBuildId() below requires this
// module lazily as well; the top-level require keeps one copy.
const childProcess = require('node:child_process')

const express = require('express')
const { WebSocketServer } = require('ws')
const dotenv = require('dotenv')
const tdl = require('tdl')
const { getTdjson } = require('prebuilt-tdlib')
const packMedia = require('./packMedia')
const packSelected = require('./packSelected')

dotenv.config()

const ROOT = __dirname
const CONFIG_PATH = path.join(ROOT, 'config.json')
const SETTINGS_PATH = path.join(ROOT, 'settings.json')
const DEFAULT_DOWNLOADS_DIR = path.join(ROOT, 'downloads')
let downloadsDir = DEFAULT_DOWNLOADS_DIR
let thumbsDir = null
const DB_DIR = path.join(ROOT, '.td_database')
const FILES_DIR = path.join(ROOT, '.td_files')
const MANAGEMENT_UPLOAD_DIR = path.join(ROOT, '.management_uploads')

function loadSettings () {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'))
    if (s && s.downloadsDir) downloadsDir = path.resolve(String(s.downloadsDir))
  } catch {}
  thumbsDir = path.join(downloadsDir, '.thumbs')
}

function saveSettings () {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify({ downloadsDir }, null, 2))
}

loadSettings()
fs.mkdirSync(downloadsDir, { recursive: true })
fs.mkdirSync(thumbsDir, { recursive: true })
fs.mkdirSync(MANAGEMENT_UPLOAD_DIR, { recursive: true })

const PORT = Number(process.env.PORT || 3000)
let CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 8))

/* Build identity.
 *
 * A running Node process keeps whatever module bytes it loaded at boot, so a
 * process started before a fix still serves the old code no matter what is on
 * disk. Three defects on this branch were declared fixed while user-visible
 * behaviour did not change, and a stale process was one of the candidate
 * explanations that no amount of source reading can rule out. The build id makes
 * the running process identify itself: it is the short HEAD sha when git is
 * available, and otherwise a sha256 prefix over server.js plus the preload files
 * that `npm start` wraps, so it still changes when those files change in a
 * checkout without git. It is printed at boot and returned on `get-status`, so
 * the browser can compare what answered it against the working tree. */
const BUILD_SOURCES = [
  'server.js',
  'tdlib-temp-preload.js',
  'tdl-upload-compat.js',
  'bulk-upload-preload.js',
  'download-dedupe-preload.js',
  'thumb-cache-preload.js',
  'session-preload.js'
]

function computeBuildId () {
  try {
    const head = childProcess
      .execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString('utf8')
      .trim()
    if (head) return { buildId: head, buildIdSource: 'git' }
  } catch {}
  const hash = crypto.createHash('sha256')
  for (const name of BUILD_SOURCES) {
    try { hash.update(fs.readFileSync(path.join(ROOT, name))) } catch { hash.update(`missing:${name}`) }
  }
  return { buildId: hash.digest('hex').slice(0, 12), buildIdSource: 'sha256' }
}

const { buildId: BUILD_ID, buildIdSource: BUILD_ID_SOURCE } = computeBuildId()
const PROCESS_STARTED_AT = new Date().toISOString()

let client = null
let ready = false
let authState = null
// Last known signed-in identity, so a browser reload can restore the account
// display without waiting for another authorizationStateReady transition.
let currentUser = null
let lastChatOffset = { order: '9223372036854775807', chat_id: 0 }

const senderCache = new Map()
const thumbCache = new Map()
const pendingThumbs = new Map()
const webSockets = new Set()

function loadConfig () {
  const env = {
    apiId: process.env.API_ID ? Number(process.env.API_ID) : null,
    apiHash: process.env.API_HASH || null
  }
  if (env.apiId && env.apiHash) return env
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    if (c.apiId && c.apiHash) return { apiId: Number(c.apiId), apiHash: String(c.apiHash) }
  } catch {}
  return null
}

function saveConfig (apiId, apiHash) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ apiId: Number(apiId), apiHash: String(apiHash) }, null, 2))
}

function sanitize (name) {
  return String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\.+$/g, '')
    .trim()
    .slice(0, 120) || 'file'
}

function uniquePath (dir, name) {
  let p = path.join(dir, name)
  let i = 1
  while (fs.existsSync(p)) {
    const ext = path.extname(name)
    const base = path.basename(name, ext)
    p = path.join(dir, `${base} (${i})${ext}`)
    i++
  }
  return p
}

/* ------------------------------ WebSocket helpers ------------------------------ */

function send (ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
}

function sendAll (msg) {
  for (const ws of webSockets) send(ws, msg)
}

function respond (ws, id, ok, data, error) {
  send(ws, { type: 'response', id, ok, data, error: error || null })
}

/* ------------------------------ Download manager ------------------------------ */

/* Queue state machine. The server owns the whole queue; the browser only ever
 * sees a projection of it, so every bulk operation and every statistic must be
 * derived here and never from what the client happens to have received.
 *
 *   queued  -> downloading -> done
 *              |  |  |
 *              |  |  +------> error
 *              |  +---------> paused -> queued (resume)
 *              +------------> cancelled
 *   queued  -> paused | cancelled          (never started)
 *
 * PENDING = 'queued', ACTIVE = 'downloading', and done/error/cancelled are
 * terminal. Cancellable work is exactly queued | downloading | paused.
 */
const CANCELLABLE = ['queued', 'downloading', 'paused']
const TERMINAL = ['done', 'error', 'cancelled']

/* How long an active job may go without a single new byte before its download
 * request is re-asserted.
 *
 * This is deliberately short, because re-asserting costs almost nothing: it is a
 * getFile plus an idempotent downloadFile against at most CONCURRENCY jobs, and it
 * never cancels anything. A file that is genuinely transferring refreshes its
 * timestamp on every progress update and is therefore never touched.
 *
 * It has to be shorter than TDLib's own retry backoff to be any use. TDLib gives up
 * on a file when its internal temp -> cache rename is refused - on Windows that
 * happens when real-time antivirus still holds the freshly written temp file:
 *   "Failed to Download file NNN of type Photo: [WindowsError : Access is denied.
 *    : 5 : Can't rename .td_files\temp\7557 to .td_files\photos\...jpg]"
 * It then retries on its own schedule, which measured at 36-38 seconds. With the
 * old 45s threshold we always waited for TDLib and the user saw the batch stop
 * dead; at 8s we nudge it back to work first. Observed against 150 photos: 146
 * finished in 14s and the last four froze for 38s, matching those log lines
 * exactly - including thumbnails under .td_database, which this app never touches,
 * so the refusal is not something we cause. */
const STALL_AFTER_MS = 8000
const SWEEP_INTERVAL_MS = 2000
// Bounded so a genuinely broken file cannot retry for ever.
const MAX_ATTEMPTS = 3
const SPEED_SMOOTHING = 0.6

class DownloadManager {
  constructor () {
    this.jobs = new Map()
    this.activeCount = 0
    this.lastEmit = new Map()
    /* fileId -> the path a completed job delivered it to. One TDLib file can back
     * several queued messages, and finalize() takes it out of TDLib's cache, so a
     * sibling needs to know where the content ended up. */
    this.deliveredByFile = new Map()
    // TDLib file ids currently being downloaded, so the same file is never
    // requested twice at once.
    this.inFlightFiles = new Set()
    // Set while a bulk operation walks the queue. tryRun() is a no-op during
    // that window so cancelling job 1 of 20,000 cannot start job 9 only for the
    // same pass to cancel it a moment later (an O(n^2) scan storm plus a burst
    // of pointless TDLib downloadFile round-trips).
    this.bulk = false
    this.statsTimer = null
    // Watchdog; unref'd so it never keeps the process alive on its own.
    this.sweepTimer = setInterval(() => { try { this.sweep() } catch {} }, SWEEP_INTERVAL_MS)
    if (this.sweepTimer && this.sweepTimer.unref) this.sweepTimer.unref()
  }

  /* Aggregate over the FULL queue. This is the only sanctioned source for the
   * Speed / Downloaded / Remaining / Total figures. */
  stats () {
    let queued = 0
    let downloading = 0
    let paused = 0
    let done = 0
    let error = 0
    let cancelled = 0
    let speed = 0
    let downloadedBytes = 0
    let expectedBytes = 0
    for (const job of this.jobs.values()) {
      switch (job.status) {
        case 'queued': queued++; break
        case 'downloading': downloading++; speed += Math.max(0, Number(job.speed || 0)); break
        case 'paused': paused++; break
        case 'done': done++; break
        case 'error': error++; break
        case 'cancelled': cancelled++; break
      }
      downloadedBytes += Math.max(0, Number(job.downloaded || 0))
      expectedBytes += Math.max(0, Number(job.fileSize || 0))
    }
    return {
      total: this.jobs.size,
      queued,
      downloading,
      paused,
      done,
      error,
      cancelled,
      // Work that still needs to finish, whether or not it has started.
      remaining: queued + downloading + paused,
      speed,
      downloadedBytes,
      expectedBytes,
      concurrency: CONCURRENCY
    }
  }

  /* Coalesced so a 20k enqueue produces a handful of broadcasts, not 20k. */
  scheduleStats () {
    if (this.statsTimer) return
    this.statsTimer = setTimeout(() => {
      this.statsTimer = null
      sendAll({ type: 'event', event: { name: 'download-stats', stats: this.stats() } })
    }, 200)
  }

  add (chatId, chatTitle, messageId, fileId, fileName, fileSize) {
    if (!fileId) throw new Error('No file id')
    const jobId = crypto.randomUUID()
    const job = {
      jobId,
      chatId,
      chatTitle,
      messageId,
      fileId,
      fileName,
      fileSize: fileSize || 0,
      status: 'queued',
      downloaded: 0,
      speed: 0,
      error: null,
      destPath: null,
      active: false,
      // Generation counter, incremented on every start, so a stale runner whose
      // await finally settles can detect that it no longer owns the job.
      run: 0,
      attempts: 0,
      lastProgressAt: 0,
      finalizing: false
    }
    this.jobs.set(jobId, job)
    // Enqueue is not broadcast per job: a "download all" on a 20k channel would
    // otherwise push 20k socket frames. The coalesced aggregate keeps the client
    // honest about queue size without that flood.
    this.scheduleStats()
    this.tryRun()
    return jobId
  }

  tryRun () {
    if (this.bulk) return
    while (this.activeCount < CONCURRENCY) {
      /* A file already in flight is skipped rather than requested again. Asking
       * TDLib for the same file twice made it fetch the bytes a second time into
       * another temp file, whose temp -> cache rename then collided with the copy we
       * were taking; TDLib calls that a failed download and retries after a long
       * backoff. The duplicate is left queued and settles as soon as the first copy
       * lands - see settleTwins. */
      let next = null
      for (const job of this.jobs.values()) {
        if (job.status !== 'queued') continue
        if (this.inFlightFiles.has(job.fileId)) continue
        next = job
        break
      }
      if (!next) break
      this.activeCount++
      // startJob handles its own failures, but it is not awaited here, so an
      // unexpected rejection must not become an unhandled rejection that leaves
      // activeCount incremented with nothing running.
      Promise.resolve(this.startJob(next)).catch(() => {})
    }
  }

  /* Runs fn with the scheduler suspended, then pumps once. */
  runBulk (fn) {
    const wasBulk = this.bulk
    this.bulk = true
    try {
      return fn()
    } finally {
      this.bulk = wasBulk
      if (!this.bulk) this.tryRun()
      this.scheduleStats()
    }
  }

  async startJob (job) {
    /* Every start takes a generation token.
     *
     * pause() frees the slot immediately while this runner's downloadFile promise
     * is still pending, so a resume can begin a SECOND runner for the same job.
     * Without the token the stale runner would later finalize the job, or flip it
     * to error, and release the slot the new runner owns - under-counting
     * activeCount and over-subscribing TDLib. */
    const run = (job.run || 0) + 1
    job.run = run
    const stale = () => job.run !== run

    // The whole body is guarded. The status/active/emitJob prologue used to sit
    // OUTSIDE the try, so a throw in emitJob escaped as an unhandled rejection
    // with activeCount already incremented: a permanent slot leak, unlogged.
    try {
      job.status = 'downloading'
      job.active = true
      this.inFlightFiles.add(job.fileId)
      job.attempts = (job.attempts || 0) + 1
      job.lastProgressAt = Date.now()
      job.speed = 0
      this.emitJob(job)

      /* Already fetched during this session through another message? Adopt that
       * copy instead of asking Telegram for the bytes again. */
      const delivered = this.deliveredByFile.get(job.fileId)
      if (delivered && fs.existsSync(delivered)) {
        job.downloaded = job.fileSize || job.downloaded || 0
        job.destPath = delivered
        job.status = 'done'
        job.speed = 0
        this.finishJob(job)
        this.emitJob(job)
        return
      }

      const fileInfo = await client.invoke({ _: 'getFile', file_id: job.fileId }).catch(() => null)
      if (stale()) return
      if (fileInfo && (fileInfo.size || fileInfo.expected_size)) {
        job.fileSize = fileInfo.size || fileInfo.expected_size
        this.emitJob(job)
      }
      /* A file that is already complete in TDLib's cache produces no further
       * updateFile, so it has to be finalized from this result or it would sit in
       * 'downloading' holding a slot until the watchdog noticed. */
      const cached = fileInfo && fileInfo.local
      if (cached && cached.is_downloading_completed && cached.path) {
        job.downloaded = job.fileSize || cached.downloaded_size || 0
        return await this.finalize(job, cached.path)
      }

      const res = await client.invoke({
        _: 'downloadFile',
        file_id: job.fileId,
        priority: 32, // Increase priority to max
        offset: 0,
        limit: 0,
        synchronous: false
      })
      if (stale()) return
      // downloadFile can resolve after the job was cancelled or paused. Both are
      // deliberate terminations, so neither may be overwritten by done/error.
      if (job.status === 'paused' || job.status === 'cancelled') return
      const local = res && res.local
      if (local && local.is_downloading_completed && local.path) {
        job.downloaded = job.fileSize || local.downloaded_size || 0
        await this.finalize(job, local.path)
      }
      // Otherwise the job stays 'downloading' and completion arrives through
      // onFileUpdate, with sweep() as the backstop if no update ever comes.
    } catch (e) {
      if (stale()) return
      if (job.status === 'paused' || job.status === 'cancelled') return
      job.status = 'error'
      job.error = String(e.message || e)
      job.speed = 0
      this.finishJob(job)
      this.emitJob(job)
    }
  }

  onFileUpdate (file) {
    if (!file || !file.id) return
    const now = Date.now()
    for (const job of this.jobs.values()) {
      if (job.fileId !== file.id) continue
      const local = file.local || {}
      if (job.status === 'paused' || job.status === 'cancelled') continue
      // A finished job must not be resurrected by a late update.
      if (TERMINAL.includes(job.status)) continue

      const bytes = Math.max(0, Number(local.downloaded_size || 0))

      /* Completion is handled FIRST and for any live status, not only
       * 'downloading'.
       *
       * The same TDLib file id can be driven by something other than this job's
       * runner (a duplicate entry in the same batch, downloadThumb,
       * ensureLocalFile), so a job can still be 'queued' at the moment its bytes
       * complete. Gating completion on 'downloading' dropped that signal on the
       * floor: the row kept a full progress bar labelled QUEUED for ever and
       * stats().done never incremented, which is exactly the reported symptom. */
      if (local.is_downloading_completed && local.path) {
        job.downloaded = job.fileSize || bytes || job.downloaded || 0
        job.speed = 0
        this.finalize(job, local.path)
        continue
      }

      if (local.is_downloading_active) {
        const elapsed = (now - (job.lastProgressAt || now)) / 1000
        const delta = bytes - Math.max(0, Number(job.downloaded || 0))
        // Server-side speed. job.speed was never assigned anywhere, so
        // stats().speed was structurally 0 despite being the documented source.
        if (elapsed > 0.05 && delta > 0) {
          const instant = delta / elapsed
          job.speed = job.speed ? job.speed * SPEED_SMOOTHING + instant * (1 - SPEED_SMOOTHING) : instant
        }
        if (delta > 0) job.lastProgressAt = now
        job.downloaded = bytes
        const last = this.lastEmit.get(job.jobId) || 0
        if (now - last > 250) {
          this.lastEmit.set(job.jobId, now)
          this.emitJob(job)
        }
        continue
      }

      /* Neither active nor complete.
       *
       * This is NOT a failure and must not be treated as one. TDLib accepts every
       * downloadFile request and then schedules the transfers itself, running far
       * fewer in parallel than we ask for, so "not active, no bytes yet" is the
       * normal resting state of most of a large batch.
       *
       * Requeueing here cancelled healthy downloads, discarded their partial data,
       * sent them to the back of TDLib's queue and eventually failed them outright.
       * That is what made large batches stop and later start again on their own.
       * sweep() re-asserts the request if a job really does go quiet for too long. */
      job.speed = 0
    }
  }

  async finalize (job, srcPath) {
    /* Two completion signals can arrive inside the await window below - a TDLib
     * update and the watchdog's getFile, say. Without this guard both proceed:
     * the winner renames the file out of TDLib's cache and the loser then fails
     * with ENOENT and flips an already-'done' job to 'error'. */
    if (job.finalizing || TERMINAL.includes(job.status)) return
    job.finalizing = true
    try {
      /* One TDLib file can back more than one queued message - the same photo
       * reposted, or the same item indexed twice. Whichever job finalizes first
       * MOVES the file out of TDLib's cache, so a sibling arriving afterwards has
       * nothing left to move and used to fail with
       * "ENOENT ... copyfile .td_files\photos\... -> ... (1).jpg".
       *
       * That is not a failure: the bytes are already on disk. The sibling adopts
       * the delivered path instead of writing a second copy, which also stops the
       * duplicate checker from later seeing phantom "(1)" files. */
      const delivered = this.deliveredByFile.get(job.fileId)
      if (delivered && fs.existsSync(delivered) && !fs.existsSync(srcPath)) {
        job.destPath = delivered
        job.status = 'done'
        job.speed = 0
      } else {
        const chatFolder = path.join(downloadsDir, sanitize(job.chatTitle))
        fs.mkdirSync(chatFolder, { recursive: true })
        const dest = uniquePath(chatFolder, sanitize(job.fileName))
        let moved = false
        try {
          await fs.promises.rename(srcPath, dest)
          moved = true
        } catch {
          // Cross-volume moves always land here: the cache is under the app and the
          // destination is usually another drive.
          await fs.promises.copyFile(srcPath, dest)
        }
        /* Retire TDLib's copy through TDLib, not behind its back.
         *
         * Removing the cache file directly left TDLib believing it was still
         * cached. The next time it wanted that file it logged
         *   "Need to redownload file NNN: Can't get stat about the file"
         * re-fetched it, and its own temp -> cache rename then collided with ours:
         *   "Failed to Download file NNN of type Photo: [WindowsError :
         *    Access is denied. : 5 : Can't rename .td_files\temp\7326 to
         *    .td_files\photos\...jpg]"
         * TDLib treats that as a failed download and retries after a long backoff,
         * which is what made a batch sail through most files and then sit still for
         * half a minute. Measured: 146 of 150 photos finished in 14s, then four
         * jobs - exactly the four files in those log lines - froze for 36s.
         *
         * deleteFile keeps TDLib's database consistent whether or not the bytes are
         * still there, so it never tries to reuse a file we have taken. */
        if (client && ready) {
          await client.invoke({ _: 'deleteFile', file_id: job.fileId }).catch(() => {})
        } else if (!moved) {
          await fs.promises.unlink(srcPath).catch(() => {})
        }
        job.destPath = dest
        job.status = 'done'
        job.speed = 0
        this.deliveredByFile.set(job.fileId, dest)
        // Anything else queued for the same file is already satisfied by this copy.
        this.settleTwins(job)
      }
    } catch (e) {
      /* Last chance: a sibling may have delivered this same file while we were
       * awaiting, in which case the content is on disk and this is not an error. */
      const delivered = this.deliveredByFile.get(job.fileId)
      if (delivered && fs.existsSync(delivered)) {
        job.destPath = delivered
        job.status = 'done'
        job.error = null
        job.speed = 0
      } else {
        job.status = 'error'
        job.error = String(e.message || e)
        job.speed = 0
      }
    } finally {
      job.finalizing = false
    }
    this.finishJob(job)
    this.emitJob(job)
  }

  /* Settles every other job backed by the SAME TDLib file.
   *
   * One file can be queued through several messages. Letting each of them ask
   * TDLib for the same file made it download the bytes again into a second temp
   * file, and its temp -> cache rename then collided with the copy we were taking,
   * which TDLib reports as a failed download and retries slowly. The content is
   * already on disk, so the siblings adopt it. */
  settleTwins (job) {
    if (!job.destPath) return
    for (const other of [...this.jobs.values()]) {
      if (other === job || other.fileId !== job.fileId) continue
      if (TERMINAL.includes(other.status)) continue
      other.run = (other.run || 0) + 1 // invalidate any runner already in flight
      other.destPath = job.destPath
      other.status = 'done'
      other.error = null
      other.speed = 0
      other.downloaded = other.fileSize || job.downloaded || other.downloaded
      this.finishJob(other)
      this.emitJob(other)
    }
  }

  finishJob (job) {
    if (job.active) {
      job.active = false
      this.activeCount = Math.max(0, this.activeCount - 1)
      this.inFlightFiles.delete(job.fileId)
    }
    /* Pump unconditionally. This used to sit inside the `if (job.active)` branch,
     * so a terminal transition on a job that held no slot never re-pumped even
     * when capacity was free. */
    this.tryRun()
  }

  /* Recomputes activeCount from the jobs that actually hold a slot.
   *
   * tryRun's only gate is activeCount < CONCURRENCY, so one leaked increment
   * permanently lowers throughput and enough of them stop the queue with no error
   * logged anywhere. Deriving the counter instead of trusting incremental
   * bookkeeping means any leak self-heals on the next sweep. */
  reconcile () {
    let active = 0
    for (const job of this.jobs.values()) {
      if (TERMINAL.includes(job.status)) job.active = false
      if (job.active) active++
    }
    const drifted = active !== this.activeCount
    this.activeCount = active
    return drifted
  }

  /* Watchdog pass.
   *
   * A job that has not received a byte for a while is NOT assumed dead, because
   * with a large batch that is the normal condition of everything TDLib has not
   * scheduled yet. Recovery is to RE-ASSERT the request, never to cancel it:
   * downloadFile is idempotent, so for a file TDLib is already working on it only
   * refreshes the priority, and for one TDLib has genuinely forgotten it starts it
   * again. Nothing is discarded either way.
   *
   * Only jobs holding a slot are examined, so this is bounded by CONCURRENCY
   * however large the queue is. */
  sweep () {
    if (this.bulk || !client || !ready) return
    const now = Date.now()
    this.reconcile()
    for (const job of [...this.jobs.values()]) {
      if (job.status !== 'downloading' || !job.active) continue
      if (now - (job.lastProgressAt || now) < STALL_AFTER_MS) continue
      job.speed = 0
      Promise.resolve(this.reassert(job)).catch(() => {})
    }
    this.tryRun()
  }

  /* Re-states a download request for a job that has gone quiet. */
  async reassert (job) {
    const run = job.run
    const stale = () => job.run !== run || TERMINAL.includes(job.status) ||
      job.status === 'paused' || job.status === 'cancelled'
    try {
      const info = await client.invoke({ _: 'getFile', file_id: job.fileId })
      if (stale()) return
      const local = (info && info.local) || {}

      // The completion update may simply have been missed rather than never sent.
      if (local.is_downloading_completed && local.path) {
        job.downloaded = job.fileSize || local.downloaded_size || 0
        return await this.finalize(job, local.path)
      }

      // A file Telegram will not serve any more is genuinely terminal.
      if (info && info.can_be_downloaded === false) {
        job.status = 'error'
        job.error = 'Telegram will no longer serve this file'
        job.speed = 0
        this.finishJob(job)
        this.emitJob(job)
        return
      }

      /* Still pending or transferring. Re-assert without cancelling and give it a
       * fresh window. Deliberately does NOT count an attempt: waiting for TDLib is
       * not a failed try, and counting it here is what previously turned slow
       * files into errors. */
      job.idleChecks = (job.idleChecks || 0) + 1
      job.lastProgressAt = Date.now()
      if (local.downloaded_size) job.downloaded = Math.max(job.downloaded || 0, local.downloaded_size)
      await client.invoke({
        _: 'downloadFile',
        file_id: job.fileId,
        priority: 32,
        offset: 0,
        limit: 0,
        synchronous: false
      }).catch(() => {})
      this.emitJob(job)
    } catch (e) {
      if (stale()) return
      /* Only a repeatedly unreadable file state is treated as fatal. A single
       * failed getFile is usually transient. */
      job.stateFailures = (job.stateFailures || 0) + 1
      if (job.stateFailures >= MAX_ATTEMPTS) {
        job.status = 'error'
        job.error = `cannot read file state: ${String(e.message || e)}`
        job.speed = 0
        this.finishJob(job)
        this.emitJob(job)
      } else {
        job.lastProgressAt = Date.now()
      }
    }
  }

  /* Immediate recovery, used by Resume all so the button is never a no-op. */
  recover () {
    const now = Date.now()
    this.reconcile()
    let recovered = 0
    for (const job of [...this.jobs.values()]) {
      if (job.status !== 'downloading') continue
      if (!job.active) {
        // Marked downloading but holding no slot: its runner is gone.
        job.status = 'queued'
        job.speed = 0
        job.lastProgressAt = now
        recovered++
        this.emitJob(job)
      } else if (now - (job.lastProgressAt || now) >= STALL_AFTER_MS) {
        /* Re-assert rather than cancel. A quiet job is usually just waiting for
         * TDLib to schedule it, and cancelling would throw away whatever it has
         * already fetched. */
        Promise.resolve(this.reassert(job)).catch(() => {})
        recovered++
      }
    }
    this.tryRun()
    return recovered
  }

  pause (jobId) {
    const job = this.jobs.get(jobId)
    if (!job || (job.status !== 'queued' && job.status !== 'downloading')) return false
    job.status = 'paused'
    if (job.active) {
      client.invoke({ _: 'cancelDownloadFile', file_id: job.fileId, only_if_pending: false }).catch(() => {})
      this.finishJob(job)
    }
    this.emitJob(job)
    return true
  }

  resume (jobId) {
    const job = this.jobs.get(jobId)
    if (!job) return false
    // A job marked 'downloading' while holding no slot has lost its runner, so it
    // is resumable too. Otherwise Resume did nothing for exactly the jobs that
    // most needed it.
    if (job.status === 'downloading' && !job.active) job.status = 'paused'
    if (job.status !== 'paused') return false
    job.status = 'queued'
    // An explicit user resume restarts the retry budget.
    job.attempts = 0
    job.speed = 0
    job.lastProgressAt = Date.now()
    this.tryRun()
    this.emitJob(job)
    return true
  }

  pauseAll () {
    return this.runBulk(() => {
      const ids = [...this.jobs.values()].filter(j => j.status === 'queued' || j.status === 'downloading').map(j => j.jobId)
      for (const id of ids) this.pause(id)
      return ids.length
    })
  }

  resumeAll () {
    const ids = [...this.jobs.values()].filter(j => j.status === 'paused').map(j => j.jobId)
    // Not wrapped in runBulk: resuming is precisely the case where the pump has
    // to start work, and pause() already released every slot.
    for (const id of ids) this.resume(id)
    /* Resume all must also un-wedge work that is not merely paused. Jobs parked in
     * 'downloading' are invisible to the filter above, so with a leaked slot count
     * this button reported success and started precisely nothing. */
    const recovered = this.recover()
    this.scheduleStats()
    return ids.length + recovered
  }

  /* Cancels the ENTIRE queue: active, pending and paused alike. Nothing may
   * auto-start afterwards, which holds because tryRun only ever selects
   * 'queued' and every cancellable job leaves this loop as 'cancelled'. */
  cancelAll () {
    return this.runBulk(() => {
      const ids = [...this.jobs.values()]
        .filter(j => CANCELLABLE.includes(j.status))
        .map(j => j.jobId)
      for (const id of ids) this.cancel(id)
      return ids.length
    })
  }

  /* Removes finished entries only. Never touches live work. */
  clearDone () {
    return this.runBulk(() => {
      let removed = 0
      for (const job of [...this.jobs.values()]) {
        if (TERMINAL.includes(job.status)) {
          this.jobs.delete(job.jobId)
          this.lastEmit.delete(job.jobId)
          removed++
        }
      }
      return removed
    })
  }

  /* Cancels everything still running, then empties the queue and history. */
  clearAll () {
    return this.runBulk(() => {
      let cancelled = 0
      for (const job of [...this.jobs.values()]) {
        if (CANCELLABLE.includes(job.status) && this.cancel(job.jobId)) cancelled++
      }
      const removed = this.jobs.size
      this.jobs.clear()
      this.lastEmit.clear()
      this.deliveredByFile.clear()
      this.inFlightFiles.clear()
      this.activeCount = 0
      return { cancelled, removed }
    })
  }

  cancel (jobId) {
    const job = this.jobs.get(jobId)
    if (!job) return false
    if (job.status === 'queued' || job.status === 'downloading' || job.status === 'paused') {
      job.status = 'cancelled'
      if (job.active) {
        client.invoke({ _: 'cancelDownloadFile', file_id: job.fileId, only_if_pending: false }).catch(() => {})
        this.finishJob(job)
      }
      this.emitJob(job)
      return true
    }
    return false
  }

  /* Removing a live job must terminate it first. Deleting the record alone left
   * the TDLib download running and never released the concurrency slot, so the
   * queue permanently lost a worker and the pump immediately started more jobs
   * that reappeared in the list the user had just cleared. */
  remove (jobId) {
    const job = this.jobs.get(jobId)
    if (!job) return false
    if (CANCELLABLE.includes(job.status)) {
      if (job.active) {
        client.invoke({ _: 'cancelDownloadFile', file_id: job.fileId, only_if_pending: false }).catch(() => {})
      }
      job.status = 'cancelled'
      this.finishJob(job)
    }
    this.jobs.delete(jobId)
    this.lastEmit.delete(jobId)
    this.scheduleStats()
    return true
  }

  emitJob (job) {
    const { destPath, ...rest } = job
    this.scheduleStats()
    sendAll({ type: 'event', event: { name: 'download-update', job: rest } })
    // destPath is guarded: emitJob is reachable with status 'done' from more than
    // one path, and an unguarded .replace() here would throw inside a
    // fire-and-forget runner and silently leak its concurrency slot.
    if (job.status === 'done' && destPath) {
      sendAll({ type: 'event', event: { name: 'download-done', job: { ...rest, destPath: destPath.replace(downloadsDir, '').replace(/\\/g, '/') } } })
    }
  }

  snapshot () {
    const out = []
    for (const job of this.jobs.values()) {
      out.push({ ...job, destPath: job.destPath ? job.destPath.replace(downloadsDir, '').replace(/\\/g, '/') : null })
    }
    return out
  }
}

const dm = new DownloadManager()

/* ------------------------------ Native forward manager ------------------------------ */

const forwardHistory = new Set()

function normalizeMessageIds (ids) {
  const out = []
  const seen = new Set()
  for (const raw of ids || []) {
    const id = String(raw || '').trim()
    if (!/^\d+$/.test(id) || id === '0' || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

async function resolveDestinationChat (destination) {
  if (!client || !ready) throw new Error('Telegram session is not ready')

  if (destination && destination.chatId != null) {
    const chatId = destination.chatId
    const chat = await client.invoke({ _: 'getChat', chat_id: chatId })
    return { id: chat.id, title: chat.title || 'Destination' }
  }

  const query = String(destination && (destination.username || destination.query) || '').trim()
  if (!query) throw new Error('Choose a destination chat')

  const username = query.replace(/^@/, '')
  if (username) {
    const publicChat = await client.invoke({ _: 'searchPublicChat', username }).catch(() => null)
    if (publicChat && publicChat.id) return { id: publicChat.id, title: publicChat.title || '@' + username }
  }

  const local = await client.invoke({ _: 'searchChats', query, limit: 50 }).catch(() => null)
  for (const chatId of (local && local.chat_ids) || []) {
    const chat = await client.invoke({ _: 'getChat', chat_id: chatId }).catch(() => null)
    if (!chat) continue
    const title = String(chat.title || '')
    const usernames = chat.usernames && chat.usernames.active_usernames ? chat.usernames.active_usernames : []
    if (title.toLowerCase() === query.toLowerCase() || usernames.some(u => String(u).toLowerCase() === username.toLowerCase())) {
      return { id: chat.id, title: title || query }
    }
  }

  throw new Error('Destination chat not found')
}

async function forwardMessagesNative (sourceChatId, messageIds, destination) {
  if (!client || !ready) throw new Error('Telegram session is not ready')
  if (sourceChatId == null) throw new Error('Source chat is required')

  const ids = normalizeMessageIds(messageIds)
  if (!ids.length) throw new Error('Select at least one message to forward')
  const dest = await resolveDestinationChat(destination)
  if (String(dest.id) === String(sourceChatId)) throw new Error('Choose a different destination chat')

  const fresh = []
  const skipped = []
  for (const messageId of ids) {
    const dedupeKey = String(sourceChatId) + ':' + messageId + ':' + String(dest.id)
    if (forwardHistory.has(dedupeKey)) skipped.push(messageId)
    else fresh.push(messageId)
  }

  if (!fresh.length) {
    return { destination: dest, forwarded: [], skipped, messages: [] }
  }

  // TDLib's native forwardMessages preserves Telegram-native forwarding semantics
  // for both text and media. No download/re-upload path is involved.
  const result = await client.invoke({
    _: 'forwardMessages',
    chat_id: dest.id,
    from_chat_id: sourceChatId,
    message_ids: fresh,
    options: { _: 'messageSendOptions', disable_notification: false, from_background: false, protect_content: false },
    send_copy: false,
    remove_caption: false
  })

  const forwardedMessages = (result && result.messages) || []
  for (const messageId of fresh) {
    forwardHistory.add(String(sourceChatId) + ':' + messageId + ':' + String(dest.id))
  }

  sendAll({
    type: 'event',
    event: {
      name: 'forward-done',
      payload: {
        sourceChatId,
        destination: dest,
        forwarded: fresh,
        skipped,
        destinationMessageIds: forwardedMessages.map(m => m && m.id).filter(Boolean)
      }
    }
  })

  return { destination: dest, forwarded: fresh, skipped, messages: forwardedMessages }
}

/* ------------------------------ Media packer ------------------------------ */

let packState = null // { active, cancelled }

function startPack () {
  if (packState && packState.active) return false
  packState = { active: true, cancelled: false }
  packMedia.run(
    downloadsDir,
    (payload) => sendAll({ type: 'event', event: { name: 'pack-progress', payload } }),
    () => packState.cancelled
  )
    .then(result => {
      packState.active = false
      if (result.cancelled) {
        sendAll({ type: 'event', event: { name: 'pack-error', error: 'Packing cancelled' } })
      } else {
        sendAll({ type: 'event', event: { name: 'pack-done', payload: { zips: result.zips, removed: result.removed } } })
      }
    })
    .catch(e => {
      packState.active = false
      sendAll({ type: 'event', event: { name: 'pack-error', error: String(e.message || e) } })
    })
  return true
}

function startPackSelected (items, chatTitle) {
  if (packState && packState.active) return false
  packState = { active: true, cancelled: false }
  packSelected.runPack({
    client: client,
    items,
    chatTitle: chatTitle || 'files',
    downloadsDir,
    onProgress: (payload) => sendAll({ type: 'event', event: { name: 'pack-progress', payload } }),
    isCancelled: () => packState.cancelled
  })
    .then(result => {
      packState.active = false
      if (result.cancelled) {
        sendAll({ type: 'event', event: { name: 'pack-error', error: 'Packing cancelled' } })
      } else {
        sendAll({ type: 'event', event: { name: 'pack-done', payload: { zips: result.zips, removed: result.removed, failed: result.failed } } })
      }
    })
    .catch(e => {
      packState.active = false
      sendAll({ type: 'event', event: { name: 'pack-error', error: String(e.message || e) } })
    })
  return true
}


/* ------------------------------ Channel scanner ------------------------------ */

let scanState = null
const scanCache = new Map() // chatId -> { found, scanned, typeCounts }
const mediaIndexCache = new Map() // chatId -> full media snapshot for instant revisits

function emitScan (extra = {}) {
  if (!scanState) return
  sendAll({
    type: 'event',
    event: {
      name: 'download-all-progress',
      payload: {
        mode: scanState.mode,
        chatId: scanState.chatId,
        scanned: scanState.scanned,
        found: scanState.found,
        queued: scanState.queued,
        cancelled: scanState.cancelled,
        typeCounts: scanState.typeCounts,
        ...extra
      }
    }
  })
}

async function scanChat (chatId, { queue = false, mode, returnItems = false } = {}) {
  const mediaKey = String(chatId)
  if (!queue && returnItems) {
    const cachedIndex = mediaIndexCache.get(mediaKey)
    if (cachedIndex && Array.isArray(cachedIndex.items)) {
      return {
        found: cachedIndex.found,
        scanned: cachedIndex.scanned,
        typeCounts: { ...cachedIndex.typeCounts },
        items: cachedIndex.items.map(item => ({ ...item }))
      }
    }
  }
  if (scanState && scanState.active) throw new Error('A scan is already running')
  const chat = await client.invoke({ _: 'getChat', chat_id: chatId }).catch(() => ({ title: 'Chat' }))
  const chatTitle = chat.title || 'Chat'
  scanState = {
    chatId,
    active: true,
    cancelled: false,
    scanned: 0,
    found: 0,
    queued: 0,
    mode: mode || (queue ? 'download' : 'count'),
    typeCounts: { document: 0, photo: 0, video: 0, gif: 0, audio: 0, voice: 0, video_note: 0, sticker: 0 }
  }
  const items = []
  emitScan()
  try {
    let from = 0
    for (let iter = 0; iter < 100000; iter++) {
      if (scanState.cancelled) break
      const history = await client.invoke({
        _: 'getChatHistory',
        chat_id: chatId,
        from_message_id: from,
        offset: 0,
        limit: 100,
        only_local: false
      })
      const msgs = (history.messages || []).filter(m => m.sending_state === undefined)
      if (!msgs.length) break
      const batchItems = []
      for (const m of msgs) {
        const media = extractMedia(m)
        if (media && media.file) {
          scanState.found++
          scanState.typeCounts[media.type] = (scanState.typeCounts[media.type] || 0) + 1
          const f = media.file
          const item = {
            key: `${chatId}:${m.id}`,
            messageId: m.id,
            chatId,
            date: m.date,
            fileId: f.id,
            name: media.name,
            fileSize: f.size || f.expected_size || 0,
            type: media.type,
            mime: media.mime || 'application/octet-stream',
            caption: media.caption || null,
            thumbFileId: mediaThumbFileId(media.thumb),
            thumbUrl: null
          }
          if (returnItems) {
            items.push(item)
            batchItems.push(item)
          }
          if (queue) {
            dm.add(chatId, chatTitle, m.id, f.id, media.name, f.size || f.expected_size || 0)
            scanState.queued++
          }
        }
      }
      scanState.scanned += msgs.length
      from = msgs[msgs.length - 1].id
      emitScan(returnItems ? { items: batchItems } : {})
    }
  } finally {
    scanState.active = false
    const result = { found: scanState.found, scanned: scanState.scanned, typeCounts: scanState.typeCounts, items }
    scanCache.set(chatId, { found: result.found, scanned: result.scanned, typeCounts: result.typeCounts })
    if (!queue && returnItems && !scanState.cancelled) {
      mediaIndexCache.set(String(chatId), {
        found: result.found,
        scanned: result.scanned,
        typeCounts: { ...result.typeCounts },
        items: result.items.map(item => ({ ...item })),
        savedAt: Date.now()
      })
    }
    emitScan({ done: true })
    return result
  }
}



/* ------------------------------ Chat-scoped media index v3 ------------------------------ */

const mediaIndexScanJobs = new Map()
let mediaIndexScanSerial = 0

function cloneMediaIndexSnapshot (snapshot, extra = {}) {
  return {
    found: Number(snapshot && snapshot.found || 0),
    scanned: Number(snapshot && snapshot.scanned || 0),
    typeCounts: { ...((snapshot && snapshot.typeCounts) || {}) },
    items: Array.isArray(snapshot && snapshot.items) ? snapshot.items.map(item => ({ ...item })) : [],
    cancelled: !!(snapshot && snapshot.cancelled),
    done: !!(snapshot && snapshot.done),
    /* Completeness of the WALK, distinct from `done`.
     *
     * `done` only means "this scan stopped and was not cancelled", which a
     * truncated walk also satisfies, so it cannot tell a failed scan from an
     * empty chat. `historyComplete` is true only when the walk reached the real
     * end of history (an empty page). A repeated cursor, a page that added no
     * new messages, the iteration guard, a cancel or a throw all leave it false. */
    historyComplete: !!(snapshot && snapshot.historyComplete),
    ...extra
  }
}

function emitMediaIndexProgress (job, items, done) {
  sendAll({
    type: 'event',
    event: {
      name: 'media-index-progress',
      payload: {
        scanId: job.scanId,
        chatId: job.chatId,
        scanned: job.scanned,
        found: job.found,
        typeCounts: { ...job.typeCounts },
        items: Array.isArray(items) ? items : [],
        cancelled: !!job.cancelled,
        done: !!done,
        // False for every streaming event; true on the final event only when the
        // walk reached the empty-page end of history.
        historyComplete: !!job.historyComplete && !job.cancelled
      }
    }
  })
}

function cancelMediaIndexScanV3 (chatId) {
  const job = mediaIndexScanJobs.get(String(chatId))
  if (!job) return false
  job.cancelled = true
  return true
}

async function scanMediaIndexV3 (chatId, force = false) {
  const key = String(chatId)
  if (!force) {
    const cached = mediaIndexCache.get(key)
    if (cached && Array.isArray(cached.items)) {
      return cloneMediaIndexSnapshot(cached, { done: true, fromCache: true })
    }
  }

  const existing = mediaIndexScanJobs.get(key)
  if (existing) return existing.promise

  const job = {
    scanId: ++mediaIndexScanSerial,
    chatId,
    cancelled: false,
    scanned: 0,
    found: 0,
    typeCounts: { document: 0, photo: 0, video: 0, gif: 0, audio: 0, voice: 0, video_note: 0, sticker: 0 },
    items: [],
    /* Set true at exactly one place: the empty-page exit below. Every other way
     * out of the loop (repeated cursor, newMessages === 0, the 100000-iteration
     * guard, a cancel, a throw) leaves it false. */
    historyComplete: false,
    promise: null
  }

  job.promise = (async () => {
    const seenMessages = new Set()
    let cursor = 0
    emitMediaIndexProgress(job, [], false)

    try {
      for (let iteration = 0; iteration < 100000 && !job.cancelled; iteration++) {
        const history = await client.invoke({
          _: 'getChatHistory',
          chat_id: chatId,
          from_message_id: cursor,
          offset: 0,
          limit: 100,
          only_local: false
        })
        const messages = (history.messages || []).filter(message => message.sending_state === undefined)
        if (!messages.length) {
          // The real end of history, and the ONLY exit that proves completeness.
          job.historyComplete = true
          break
        }

        const batchItems = []
        let newMessages = 0
        for (const message of messages) {
          const messageKey = String(message.id)
          if (seenMessages.has(messageKey)) continue
          seenMessages.add(messageKey)
          newMessages++
          const media = extractMedia(message)
          if (!media || !media.file) continue
          const file = media.file
          const item = {
            key: `${chatId}:${message.id}`,
            messageId: message.id,
            chatId,
            date: message.date,
            fileId: file.id,
            name: media.name,
            fileSize: file.size || file.expected_size || 0,
            type: media.type,
            mime: media.mime || 'application/octet-stream',
            caption: media.caption || null,
            thumbFileId: mediaThumbFileId(media.thumb),
            thumbUrl: null
          }
          job.items.push(item)
          batchItems.push(item)
          job.found++
          job.typeCounts[media.type] = (job.typeCounts[media.type] || 0) + 1
        }

        job.scanned += newMessages
        const oldest = messages[messages.length - 1]
        const nextCursor = oldest && oldest.id
        emitMediaIndexProgress(job, batchItems, false)
        if (!nextCursor || String(nextCursor) === String(cursor) || newMessages === 0) break
        cursor = nextCursor
        await new Promise(resolve => setImmediate(resolve))
      }

      const snapshot = {
        found: job.found,
        scanned: job.scanned,
        typeCounts: { ...job.typeCounts },
        items: job.items.map(item => ({ ...item })),
        cancelled: !!job.cancelled,
        done: !job.cancelled,
        /* Carried into the cached snapshot, so a later reader (`media-truth-v1`,
         * or the `fromCache` early return above) can still tell a walk that
         * reached the end of history from one that stopped early. A cancel clears
         * it even if the empty page was reached, because a cancelled walk is not a
         * truth pass. A throw never gets here at all. */
        historyComplete: !!job.historyComplete && !job.cancelled,
        savedAt: Date.now()
      }
      if (!job.cancelled) mediaIndexCache.set(key, snapshot)
      emitMediaIndexProgress(job, [], true)
      return cloneMediaIndexSnapshot(snapshot)
    } finally {
      if (mediaIndexScanJobs.get(key) === job) mediaIndexScanJobs.delete(key)
    }
  })()

  mediaIndexScanJobs.set(key, job)
  return job.promise
}

/* ------------------------------ Telegram media truth ------------------------------ */

/* The single source of truth for "which media message ids does Telegram hold for
 * this chat right now", and the only thing the client is allowed to prune against.
 *
 * Two properties matter more than the id list itself:
 *
 * `accessible` - probed with getChat. A chat that was left, deleted or is
 * otherwise unreachable answers `accessible: false`, never an empty chat, so an
 * inaccessible chat can never be mistaken for a deletion event.
 *
 * `complete` - true only when the walk reached the real end of history (an empty
 * page) on an accessible chat with no thrown error. It is deliberately NOT derived
 * from how many rows were found: the previous truth source reported
 * `exact: ids.length < 5000`, which is true for a scan that failed and returned
 * nothing, so a failure was indistinguishable from an empty channel. Completeness
 * is a property of how the walk ended, so there is no item cap here either.
 *
 * The walk is the same getChatHistory walk `scanMediaIndexV3` performs, with the
 * same message filter (`extractMedia` yields a file, and `sending_state` is
 * undefined so a message still being sent is not counted as live history). Only
 * ids are collected, so nothing here can write the media index. */
async function mediaTruthV1 (chatId) {
  if (!client || !ready) throw new Error('Not logged in')
  const key = String(chatId)

  let accessible = false
  try {
    const chat = await client.invoke({ _: 'getChat', chat_id: chatId })
    accessible = !!(chat && chat.id != null)
  } catch (error) {
    return {
      ok: true,
      ids: [],
      count: 0,
      complete: false,
      accessible: false,
      scanned: 0,
      source: 'probe',
      error: String(error && error.message ? error.message : error)
    }
  }
  if (!accessible) {
    return { ok: true, ids: [], count: 0, complete: false, accessible: false, scanned: 0, source: 'probe' }
  }

  /* A cached snapshot is reusable only when its own walk reached the end of
   * history and was not cancelled. `scan-media-v3` keeps that snapshot fresh
   * through the live delete and upsert paths, so reusing it avoids re-walking a
   * large channel on every reconciliation pass. */
  const cached = mediaIndexCache.get(key)
  if (cached && Array.isArray(cached.items) && cached.historyComplete && !cached.cancelled) {
    const ids = cached.items.map(item => String(item.messageId))
    return {
      ok: true,
      ids,
      count: ids.length,
      complete: true,
      accessible: true,
      scanned: Number(cached.scanned || 0),
      source: 'cache'
    }
  }

  const ids = []
  const seenMessages = new Set()
  let scanned = 0
  let historyComplete = false
  let cursor = 0

  try {
    for (let iteration = 0; iteration < 100000; iteration++) {
      const history = await client.invoke({
        _: 'getChatHistory',
        chat_id: chatId,
        from_message_id: cursor,
        offset: 0,
        limit: 100,
        only_local: false
      })
      const messages = (history.messages || []).filter(message => message.sending_state === undefined)
      if (!messages.length) {
        // The real end of history, and the ONLY exit that proves completeness.
        historyComplete = true
        break
      }
      let newMessages = 0
      for (const message of messages) {
        const messageKey = String(message.id)
        if (seenMessages.has(messageKey)) continue
        seenMessages.add(messageKey)
        newMessages++
        const media = extractMedia(message)
        if (!media || !media.file) continue
        ids.push(messageKey)
      }
      scanned += newMessages
      const oldest = messages[messages.length - 1]
      const nextCursor = oldest && oldest.id
      // A repeated cursor or a page that added nothing new means the walk stopped
      // early: it leaves historyComplete false, exactly as in scanMediaIndexV3.
      if (!nextCursor || String(nextCursor) === String(cursor) || newMessages === 0) break
      cursor = nextCursor
      await new Promise(resolve => setImmediate(resolve))
    }
  } catch (error) {
    /* A thrown walk reports no ids at all. Returning the partial set would invite
     * a caller to prune against it; `complete: false` plus an empty list makes
     * misuse impossible rather than merely discouraged. */
    return {
      ok: false,
      ids: [],
      count: 0,
      complete: false,
      accessible: true,
      scanned,
      source: 'walk',
      error: String(error && error.message ? error.message : error)
    }
  }

  return {
    ok: true,
    ids,
    count: ids.length,
    complete: historyComplete,
    accessible: true,
    scanned,
    source: 'walk'
  }
}


/* ------------------------------ Thumbnails ------------------------------ */

async function copyToThumbs (fileId, src) {
  const ext = path.extname(src) || '.jpg'
  const dest = uniquePath(thumbsDir, `${fileId}-${crypto.randomBytes(4).toString('hex')}${ext}`)
  try {
    await fs.promises.copyFile(src, dest)
    thumbCache.set(fileId, dest)
    return dest
  } catch {
    return null
  }
}

function downloadThumb (fileId, thumbDir = thumbsDir) {
  if (thumbCache.has(fileId)) return thumbCache.get(fileId)
  if (pendingThumbs.has(fileId)) return pendingThumbs.get(fileId)

  const p = (async () => {
    if (!client || !ready) return null

    const cached = await client.invoke({ _: 'getFile', file_id: fileId }).catch(() => null)
    if (cached && cached.local && cached.local.is_downloading_completed && cached.local.path) {
      return copyToThumbs(fileId, cached.local.path)
    }

    const src = await new Promise((resolve) => {
      /* The timeout path used to resolve without removing the listener, so every
       * thumbnail that timed out left one behind on the shared client for the life
       * of the process - the source of
       * "MaxListenersExceededWarning: 11 update listeners added to
       * [StableTdClient]" - and each survivor then ran on every single updateFile. */
      const timer = setTimeout(() => {
        client.off('update', onUpdate)
        resolve(null)
      }, 60000)
      const onUpdate = (u) => {
        if (u._ !== 'updateFile' || u.file.id !== fileId) return
        const local = u.file.local || {}
        if (local.is_downloading_completed && local.path) {
          clearTimeout(timer)
          client.off('update', onUpdate)
          resolve(local.path)
        }
      }
      client.on('update', onUpdate)
      client.invoke({ _: 'downloadFile', file_id: fileId, priority: 32, offset: 0, limit: 0, synchronous: false })
        .then(res => {
          const local = res && res.local
          if (local && local.is_downloading_completed && local.path) {
            clearTimeout(timer)
            client.off('update', onUpdate)
            resolve(local.path)
          }
        })
        .catch(() => { clearTimeout(timer); client.off('update', onUpdate); resolve(null) })
    })

    if (!src) return null
    return copyToThumbs(fileId, src)
  })()

  pendingThumbs.set(fileId, p)
  p.finally(() => pendingThumbs.delete(fileId)).catch(() => {})
  return p
}

/* ------------------------------ Auth handling ------------------------------ */

/* Best available file id for the signed-in user's avatar.
 *
 * A `user` record only exposes profile_photo.small, which is absent if TDLib has
 * not populated it yet. userFullInfo carries the richer chatPhoto variants, and
 * getUserProfilePhotos is the last resort. */
async function resolveOwnPhotoFileId (userId) {
  const smallest = photo => {
    const sizes = (photo && photo.sizes) || []
    const size = sizes.find(s => s && s.photo && s.photo.id) || null
    return size ? size.photo.id : null
  }

  const user = await client.invoke({ _: 'getUser', user_id: userId }).catch(() => null)
  if (user && user.profile_photo && user.profile_photo.small) return user.profile_photo.small.id

  const full = await client.invoke({ _: 'getUserFullInfo', user_id: userId }).catch(() => null)
  for (const candidate of [full && full.personal_photo, full && full.photo, full && full.public_photo]) {
    if (!candidate) continue
    if (candidate.small && candidate.small.id) return candidate.small.id
    const id = smallest(candidate)
    if (id) return id
  }

  const photos = await client.invoke({ _: 'getUserProfilePhotos', user_id: userId, offset: 0, limit: 1 })
    .catch(() => null)
  const first = photos && photos.photos && photos.photos[0]
  return smallest(first)
}

function handleAuthState (state) {
  authState = state
  if (!state) return

  if (state._ === 'authorizationStateReady') {
    ready = true
    client.invoke({ _: 'getMe' }).then(async me => {
      currentUser = {
        id: me.id,
        name: [me.first_name, me.last_name].filter(Boolean).join(' '),
        username: me.username,
        // Reuses the existing /api/media-preview file resolver on the client;
        // no separate profile photo pipeline is introduced.
        photoFileId: me.profile_photo && me.profile_photo.small ? me.profile_photo.small.id : null
      }
      sendAll({ type: 'event', event: { name: 'auth', payload: { status: 'ready', me: currentUser } } })

      /* getMe can answer before TDLib has attached the profile photo, and a
       * user record only carries the small thumbnail. Fall back through the
       * fuller sources so the sidebar can show a real avatar rather than
       * initials. updateUser covers any later change. */
      if (!currentUser.photoFileId) {
        const photoFileId = await resolveOwnPhotoFileId(me.id)
        console.log(`[identity] ${currentUser.name || currentUser.username || me.id} profile photo: ${photoFileId || 'none found'}`)
        if (photoFileId) {
          currentUser = { ...currentUser, photoFileId }
          sendAll({ type: 'event', event: { name: 'auth', payload: { status: 'ready', me: currentUser } } })
        }
      }
    }).catch(() => {})
  } else if (state._ === 'authorizationStateWaitPhoneNumber') {
    ready = false
    // A fresh phone prompt means the previous session is gone; do not let the
    // old identity leak into the next login.
    currentUser = null
    sendAll({ type: 'event', event: { name: 'login-prompt', kind: 'phone', info: null } })
  } else if (state._ === 'authorizationStateWaitCode') {
    ready = false
    sendAll({ type: 'event', event: { name: 'login-prompt', kind: 'code', info: state.code_info || null } })
  } else if (state._ === 'authorizationStateWaitPassword') {
    ready = false
    sendAll({ type: 'event', event: { name: 'login-prompt', kind: 'password', info: { password_hint: state.password_hint, has_recovery_email_address: state.has_recovery_email_address } } })
  } else if (state._ === 'authorizationStateWaitOtherDeviceConfirmation') {
    sendAll({ type: 'event', event: { name: 'login-prompt', kind: 'other-device', info: { link: state.link } } })
  } else if (state._ === 'authorizationStateWaitRegistration') {
    sendAll({ type: 'event', event: { name: 'login-prompt', kind: 'registration', info: null } })
  }
}

async function submitLogin (kind, value) {
  if (!client) throw new Error('Client not ready')
  if (kind === 'phone') {
    await client.invoke({
      _: 'setAuthenticationPhoneNumber',
      phone_number: String(value).trim(),
      settings: {
        _: 'phoneNumberAuthenticationSettings',
        allow_flash_call: false,
        is_current_phone_number: false,
        allow_sms_retriever_api: false
      }
    })
  } else if (kind === 'code') {
    await client.invoke({ _: 'checkAuthenticationCode', code: String(value).trim() })
  } else if (kind === 'password') {
    await client.invoke({ _: 'checkAuthenticationPassword', password: String(value) })
  } else if (kind === 'registration') {
    await client.invoke({
      _: 'registerUser',
      first_name: String(value),
      last_name: ''
    })
  } else {
    throw new Error('Unknown login input kind')
  }
}

/* Realtime entity/full-info caches. TDLib full-info getters may return cached
 * data for a short period, so update*FullInfo events are treated as authoritative. */
const managedSupergroupFullInfoCache = new Map()
const managedBasicGroupFullInfoCache = new Map()
const supergroupChatIds = new Map()
const basicGroupChatIds = new Map()
const privateUserChatIds = new Map()

/* ------------------------------ Client init ------------------------------ */

function initClient (config) {
  if (client) return
  tdl.configure({ tdjson: getTdjson(), verbosityLevel: 2 })

  client = tdl.createClient({
    apiId: config.apiId,
    apiHash: config.apiHash,
    databaseDirectory: DB_DIR,
    filesDirectory: FILES_DIR,
    tdlibParameters: {
      use_message_database: true,
      use_secret_chats: false,
      system_language_code: 'en',
      application_version: '4.14.8',
      device_model: 'Desktop',
      system_version: 'Windows 10.0.22631'
    }
  })

  client.on('error', (err) => {
    console.error('TDLib error:', err)
    sendAll({ type: 'event', event: { name: 'error', error: String(err.message || err) } })
  })

  client.on('update', (u) => {
    if (u._ === 'updateAuthorizationState') {
      handleAuthState(u.authorization_state)
      return
    }
    if (u._ === 'updateFile') {
      dm.onFileUpdate(u.file)
      return
    }

    /* Keep the signed-in identity fresh.
     *
     * getMe() runs the moment authorizationStateReady arrives, which is often
     * before TDLib has populated the user's profile photo, so photoFileId came
     * back null and the sidebar could only ever draw initials. TDLib fills the
     * record in later and reports it here, so the identity is refreshed and
     * rebroadcast whenever anything the UI shows has actually changed. */
    if (u._ === 'updateUser' && u.user && currentUser && String(u.user.id) === String(currentUser.id)) {
      const next = {
        id: u.user.id,
        name: [u.user.first_name, u.user.last_name].filter(Boolean).join(' ') || currentUser.name,
        username: u.user.username || currentUser.username,
        photoFileId: u.user.profile_photo && u.user.profile_photo.small
          ? u.user.profile_photo.small.id
          : currentUser.photoFileId
      }
      const changed = next.name !== currentUser.name ||
        next.username !== currentUser.username ||
        String(next.photoFileId) !== String(currentUser.photoFileId)
      currentUser = next
      if (changed) sendAll({ type: 'event', event: { name: 'auth', payload: { status: 'ready', me: currentUser } } })
      return
    }

    if (u._ === 'updateNewMessage') {
      emitRealtimeMessage(u.message).catch(() => {})
      emitChatUpsert(u.message && u.message.chat_id).catch(() => {})
      return
    }
    if (u._ === 'updateMessageContent' || u._ === 'updateMessageEdited') {
      client.invoke({ _: 'getMessage', chat_id: u.chat_id, message_id: u.message_id })
        .then(emitRealtimeMessage)
        .catch(() => {})
      return
    }
    if (u._ === 'updateMessageSendSucceeded') {
      if (u.old_message_id && u.message && String(u.old_message_id) !== String(u.message.id)) {
        sendAll({ type: 'event', event: { name: 'message-delete', chatId: u.message.chat_id, messageIds: [u.old_message_id] } })
      }
      emitRealtimeMessage(u.message).catch(() => {})
      emitChatUpsert(u.message && u.message.chat_id).catch(() => {})
      return
    }
    if (u._ === 'updateDeleteMessages') {
      deleteMediaIndexMessages(u.chat_id, u.message_ids || [], { permanent: !!u.is_permanent, fromCache: !!u.from_cache })
      sendAll({
        type: 'event',
        event: {
          name: 'message-delete',
          chatId: u.chat_id,
          messageIds: u.message_ids || [],
          isPermanent: !!u.is_permanent,
          fromCache: !!u.from_cache
        }
      })
      emitChatUpsert(u.chat_id).catch(() => {})
      return
    }

    if (u._ === 'updateNewChat') {
      serializeChatDetailed(u.chat).then(chat => {
        sendAll({ type: 'event', event: { name: 'chat-upsert', chat } })
      }).catch(() => {})
      return
    }

    if ([
      'updateChatTitle',
      'updateChatPhoto',
      'updateChatLastMessage',
      'updateChatReadInbox',
      'updateChatReadOutbox',
      'updateChatUnreadMentionCount',
      'updateChatUnreadReactionCount',
      'updateChatNotificationSettings',
      'updateChatDraftMessage',
      'updateChatMessageAutoDeleteTime',
      'updateChatAvailableReactions'
    ].includes(u._)) {
      emitChatUpsert(u.chat_id).catch(() => {})
      if (u._ === 'updateChatNotificationSettings' || u._ === 'updateChatMessageAutoDeleteTime') emitManagementRefresh(u.chat_id)
      return
    }

    if (u._ === 'updateChatPosition') {
      const pos = u.position || {}
      const list = pos.list || pos.chat_list
      const isMain = !list || list._ === 'chatListMain'
      if (isMain && String(pos.order || '0') === '0') {
        sendAll({ type: 'event', event: { name: 'chat-remove', chatId: u.chat_id } })
      } else {
        emitChatUpsert(u.chat_id).catch(() => {})
      }
      return
    }

    if (u._ === 'updateChatMember') {
      emitChatUpsert(u.chat_id).catch(() => {})
      emitManagementRefresh(u.chat_id)
      return
    }

    if (u._ === 'updateSupergroupFullInfo') {
      managedSupergroupFullInfoCache.set(String(u.supergroup_id), u.supergroup_full_info)
      const chatId = supergroupChatIds.get(String(u.supergroup_id))
      if (chatId != null) emitChatUpsert(chatId).catch(() => {})
      sendAll({ type: 'event', event: { name: 'management-refresh', chatId: chatId == null ? null : chatId, supergroupId: u.supergroup_id } })
      return
    }
    if (u._ === 'updateBasicGroupFullInfo') {
      managedBasicGroupFullInfoCache.set(String(u.basic_group_id), u.basic_group_full_info)
      const chatId = basicGroupChatIds.get(String(u.basic_group_id))
      if (chatId != null) emitChatUpsert(chatId).catch(() => {})
      sendAll({ type: 'event', event: { name: 'management-refresh', chatId: chatId == null ? null : chatId, basicGroupId: u.basic_group_id } })
      return
    }
    if (u._ === 'updateSupergroup') {
      const chatId = supergroupChatIds.get(String(u.supergroup && u.supergroup.id))
      if (chatId != null) emitChatUpsert(chatId).catch(() => {})
      sendAll({ type: 'event', event: { name: 'management-refresh', chatId: chatId == null ? null : chatId, supergroupId: u.supergroup && u.supergroup.id } })
      return
    }
    if (u._ === 'updateBasicGroup') {
      const chatId = basicGroupChatIds.get(String(u.basic_group && u.basic_group.id))
      if (chatId != null) emitChatUpsert(chatId).catch(() => {})
      sendAll({ type: 'event', event: { name: 'management-refresh', chatId: chatId == null ? null : chatId, basicGroupId: u.basic_group && u.basic_group.id } })
      return
    }
    if (u._ === 'updateUser' || u._ === 'updateUserFullInfo') {
      const userId = u.user ? u.user.id : u.user_id
      const chatId = privateUserChatIds.get(String(userId))
      if (chatId != null) emitChatUpsert(chatId).catch(() => {})
      emitManagementRefresh(chatId == null ? null : chatId)
    }
  })
}

/* ------------------------------ Data helpers ------------------------------ */

function resolveSenderName (msg) {
  const s = msg.sender_id
  if (!s) return null
  const key = `${s._}:${s.user_id ?? s.chat_id}`
  if (senderCache.has(key)) return senderCache.get(key)

  const fetch = async () => {
    try {
      if (s._ === 'messageSenderUser') {
        const u = await client.invoke({ _: 'getUser', user_id: s.user_id })
        return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || 'User'
      }
      if (s._ === 'messageSenderChat') {
        const c = await client.invoke({ _: 'getChat', chat_id: s.chat_id })
        return c.title || 'Chat'
      }
    } catch {}
    return 'Unknown'
  }
  const name = fetch()
  senderCache.set(key, name)
  return name
}

function extractMedia (msg) {
  const c = msg.content
  if (!c) return null
  const base = { messageId: msg.id, date: msg.date, chatId: msg.chat_id }
  switch (c._) {
    case 'messageDocument':
      return { ...base, type: 'document', file: c.document.document, name: c.document.file_name || `document_${msg.id}`, mime: c.document.mime_type || 'application/octet-stream', thumb: c.document.thumbnail, caption: c.caption?.text }
    case 'messagePhoto': {
      const sizes = (c.photo.sizes || []).sort((a, b) => a.size - b.size)
      const big = sizes[sizes.length - 1]
      if (!big) return null
      return { ...base, type: 'photo', file: big.photo, name: `photo_${msg.id}.jpg`, mime: 'image/jpeg', thumb: sizes[0], caption: c.caption?.text }
    }
    case 'messageVideo':
      return { ...base, type: 'video', file: c.video.video, name: c.video.file_name || `video_${msg.id}.mp4`, mime: c.video.mime_type || 'video/mp4', thumb: c.video.thumbnail, caption: c.caption?.text }
    case 'messageAnimation':
      return { ...base, type: 'gif', file: c.animation.animation, name: c.animation.file_name || `animation_${msg.id}.gif`, mime: c.animation.mime_type || 'image/gif', thumb: c.animation.thumbnail }
    case 'messageAudio':
      return { ...base, type: 'audio', file: c.audio.audio, name: c.audio.file_name || `audio_${msg.id}.mp3`, mime: c.audio.mime_type || 'audio/mpeg', thumb: c.audio.album_cover_thumbnail }
    case 'messageVoiceNote':
      return { ...base, type: 'voice', file: c.voice_note.voice, name: `voice_${msg.id}.ogg`, mime: 'audio/ogg', thumb: null }
    case 'messageVideoNote':
      return { ...base, type: 'video_note', file: c.video_note.video, name: `video_note_${msg.id}.mp4`, mime: 'video/mp4', thumb: c.video_note.thumbnail || c.video_note.thumb || null }
    case 'messageSticker':
      return { ...base, type: 'sticker', file: c.sticker.sticker, name: c.sticker.set_name ? `${c.sticker.emoji || 'sticker'}.webp` : `sticker_${msg.id}.webp`, mime: 'image/webp', thumb: null }
    default:
      return null
  }
}

function mediaThumbFileId (thumb) {
  if (!thumb) return null
  if (thumb.file && thumb.file.id) return thumb.file.id
  if (thumb.photo && thumb.photo.id) return thumb.photo.id
  return null
}

function mediaIndexItemFromSerialized (chatId, message) {
  if (!message || !message.media) return null
  const media = message.media
  const file = media.file || null
  const fileId = media.fileId || (file && file.id)
  if (!fileId) return null
  return {
    key: `${chatId}:${message.id}`,
    messageId: message.id,
    chatId,
    date: message.date || media.date || 0,
    fileId,
    name: media.name,
    fileSize: media.fileSize || (file && (file.size || file.expected_size)) || 0,
    type: media.type,
    mime: media.mime || 'application/octet-stream',
    caption: media.caption || null,
    thumbFileId: media.thumbFileId || mediaThumbFileId(media.thumb),
    thumbUrl: media.thumbUrl || null
  }
}

function patchMediaIndexMessage (chatId, message) {
  const key = String(chatId)
  const cached = mediaIndexCache.get(key)
  if (!cached || !Array.isArray(cached.items) || !message) return
  const id = String(message.id)
  const index = cached.items.findIndex(item => String(item.messageId) === id)
  const next = mediaIndexItemFromSerialized(chatId, message)
  if (next) {
    if (index >= 0) cached.items[index] = next
    else cached.items.unshift(next)
  } else if (index >= 0) {
    cached.items.splice(index, 1)
  }
  cached.items.sort((a, b) => {
    const aa = BigInt(String(a.messageId || 0))
    const bb = BigInt(String(b.messageId || 0))
    return aa === bb ? 0 : (aa < bb ? 1 : -1)
  })
  cached.found = cached.items.length
  cached.typeCounts = cached.items.reduce((counts, item) => {
    counts[item.type] = (counts[item.type] || 0) + 1
    return counts
  }, { document: 0, photo: 0, video: 0, gif: 0, audio: 0, voice: 0, video_note: 0, sticker: 0 })
  cached.savedAt = Date.now()
}

/* `options.permanent` says whether Telegram actually deleted the messages.
 *
 * TDLib also sends updateDeleteMessages with `is_permanent: false` and
 * `from_cache: true` when it merely evicts messages from its own local cache,
 * which it does routinely right after a full history walk. Measured on this host:
 * a complete scan of one 22492-message channel indexed 22485 files, and about ten
 * seconds later TDLib evicted 22489 message ids in five batches, all
 * `is_permanent: false, from_cache: true`. Those files still exist on Telegram.
 *
 * The pruning below is left exactly as it was, so nothing that reads this cache
 * changes behaviour. What must not survive an eviction is the snapshot's CLAIM to
 * be a complete view of history: `media-truth-v1` would otherwise reuse a snapshot
 * holding 2 of 22485 files and report it as complete truth, which is the one thing
 * a truth source may never do. Clearing `historyComplete` makes the next truth
 * request re-walk instead of trusting a shredded snapshot.
 *
 * Callers that pass nothing are treated as permanent, which is what the explicit
 * delete path and the temporary-id retirement both are. */
function deleteMediaIndexMessages (chatId, messageIds, options = {}) {
  const key = String(chatId)
  const cached = mediaIndexCache.get(key)
  if (!cached || !Array.isArray(cached.items)) return
  const ids = new Set((messageIds || []).map(String))
  const before = cached.items.length
  cached.items = cached.items.filter(item => !ids.has(String(item.messageId)))
  if (cached.items.length !== before && options.permanent === false) cached.historyComplete = false
  cached.found = cached.items.length
  cached.typeCounts = cached.items.reduce((counts, item) => {
    counts[item.type] = (counts[item.type] || 0) + 1
    return counts
  }, { document: 0, photo: 0, video: 0, gif: 0, audio: 0, voice: 0, video_note: 0, sticker: 0 })
  cached.savedAt = Date.now()
}

function mainChatOrder (chat) {
  const positions = Array.isArray(chat && chat.positions) ? chat.positions : []
  const main = positions.find(p => {
    const list = p && (p.list || p.chat_list)
    return !list || list._ === 'chatListMain'
  })
  return String((main && main.order) || chat.order || '0')
}

function compareChatOrderDesc (a, b) {
  const aa = BigInt(String((a && a.order) || '0'))
  const bb = BigInt(String((b && b.order) || '0'))
  return aa === bb ? 0 : (aa < bb ? 1 : -1)
}

function serializeChat (chat) {
  const title = chat.title || 'Unknown'
  const info = {
    id: chat.id,
    title,
    order: mainChatOrder(chat),
    unread: chat.unread_count || 0,
    lastMessage: chat.last_message ? chat.last_message.content : null,
    username: null,
    photoFileId: chat.photo && chat.photo.small ? chat.photo.small.id : null
  }
  const t = chat.type
  if (t) {
    if (t._ === 'chatTypePrivate') {
      info.kind = 'private'
      privateUserChatIds.set(String(t.user_id), chat.id)
    } else if (t._ === 'chatTypeBasicGroup') {
      info.kind = 'group'
      basicGroupChatIds.set(String(t.basic_group_id), chat.id)
    } else if (t._ === 'chatTypeSupergroup') {
      info.kind = t.is_channel ? 'channel' : 'supergroup'
      supergroupChatIds.set(String(t.supergroup_id), chat.id)
    } else info.kind = 'other'
  }
  return info
}

async function serializeChatDetailed (chat) {
  const info = serializeChat(chat)
  try {
    if (chat.type && chat.type._ === 'chatTypePrivate') {
      const user = await client.invoke({ _: 'getUser', user_id: chat.type.user_id })
      info.username = user && user.username ? user.username : null
    }
  } catch {}
  return info
}

async function loadChats () {
  if (!client || !ready) throw new Error('Not logged in')
  const chats = await client.invoke({
    _: 'getChats',
    chat_list: { _: 'chatListMain' },
    offset_order: lastChatOffset.order,
    offset_chat_id: lastChatOffset.chat_id,
    limit: 100
  })
  const ids = (chats.chat_ids || [])
  const out = (await Promise.all(ids.map(async (id) => {
    try {
      const chat = await client.invoke({ _: 'getChat', chat_id: id })
      const t = chat.type
      if (t && t._ === 'chatTypeSecret') return null
      return await serializeChatDetailed(chat)
    } catch (e) {
      return null
    }
  }))).filter(Boolean)
  out.sort(compareChatOrderDesc)
  if (out.length) {
    lastChatOffset = { order: out[out.length - 1].order, chat_id: out[out.length - 1].id }
  } else {
    lastChatOffset = { order: '0', chat_id: 0 }
  }
  return out
}

async function serializeRealtimeMessage (m) {
  if (!m) return null
  const item = {
    id: m.id,
    date: m.date,
    text: m.content && m.content._ === 'messageText' ? (m.content.text?.text || '') : null,
    sender: await resolveSenderName(m),
    outgoing: !!m.is_outgoing,
    media: extractMedia(m)
  }
  if (item.media && item.media.file) {
    const f = item.media.file
    item.media.fileSize = f.size || f.expected_size || 0
    item.media.fileId = f.id
    const thumbFileId = mediaThumbFileId(item.media.thumb)
    if (thumbFileId) {
      item.media.thumbUrl = null
      item.media.thumbFileId = thumbFileId
    }
  } else {
    item.media = null
  }
  return item
}

async function emitRealtimeMessage (message) {
  if (!message || message.chat_id == null) return
  const serialized = await serializeRealtimeMessage(message)
  if (!serialized) return
  patchMediaIndexMessage(message.chat_id, serialized)
  sendAll({ type: 'event', event: { name: 'message-upsert', chatId: message.chat_id, message: serialized } })
}

async function emitChatUpsert (chatId) {
  if (chatId == null || !client) return
  const chat = await client.invoke({ _: 'getChat', chat_id: chatId }).catch(() => null)
  if (!chat) return
  sendAll({ type: 'event', event: { name: 'chat-upsert', chat: await serializeChatDetailed(chat) } })
}

function emitManagementRefresh (chatId = null) {
  sendAll({ type: 'event', event: { name: 'management-refresh', chatId } })
}

async function loadMessages (chatId, fromMessageId, limit) {
  if (!client || !ready) throw new Error('Not logged in')
  const target = Math.max(1, Math.min(100, Number(limit) || 100))
  const raw = []
  const seen = new Set()
  let cursor = fromMessageId || 0
  let exhausted = false

  // TDLib can return a very short batch for private/contact histories while it
  // hydrates older messages. Keep paging inside this request so the UI receives
  // one useful snapshot rather than appearing to contain only one message.
  for (let attempt = 0; attempt < 8 && raw.length < target; attempt++) {
    const history = await client.invoke({
      _: 'getChatHistory',
      chat_id: chatId,
      from_message_id: cursor,
      offset: 0,
      limit: Math.min(100, target - raw.length),
      only_local: false
    })
    const batch = (history.messages || []).filter(m => m.sending_state === undefined)
    if (!batch.length) { exhausted = true; break }

    let added = 0
    for (const message of batch) {
      const key = String(message.id)
      if (seen.has(key)) continue
      seen.add(key)
      raw.push(message)
      added++
      if (raw.length >= target) break
    }

    const oldest = batch[batch.length - 1]
    const nextCursor = oldest && oldest.id
    if (!nextCursor || String(nextCursor) === String(cursor) || added === 0) {
      exhausted = true
      break
    }
    cursor = nextCursor
  }

  const out = await Promise.all(raw.map(async (m) => {
    const item = {
      id: m.id,
      date: m.date,
      text: m.content && m.content._ === 'messageText' ? (m.content.text?.text || '') : null,
      sender: await resolveSenderName(m),
      outgoing: !!m.is_outgoing,
      media: extractMedia(m)
    }
    if (item.media && item.media.file) {
      const f = item.media.file
      item.media.fileSize = f.size || f.expected_size || 0
      item.media.fileId = f.id
      const thumbFileId = mediaThumbFileId(item.media.thumb)
      if (thumbFileId) {
        item.media.thumbUrl = null
        item.media.thumbFileId = thumbFileId
      }
    } else {
      item.media = null
    }
    return item
  }))

  out.sort((a, b) => (String(a.id) < String(b.id) ? 1 : -1))
  return { messages: out, hasMore: !exhausted && raw.length >= target }
}



/* ------------------------------ Telegram management ------------------------------ */

function ensureManagementReady () {
  if (!client || !ready) throw new Error('Telegram session is not ready')
}

function normalizeManagedUsername (value) {
  return String(value || '').trim().replace(/^@/, '')
}

function managedStatusLabel (status) {
  if (!status || !status._) return 'Member'
  return ({
    chatMemberStatusCreator: 'Owner',
    chatMemberStatusAdministrator: 'Administrator',
    chatMemberStatusMember: 'Member',
    chatMemberStatusRestricted: 'Restricted',
    chatMemberStatusLeft: 'Left',
    chatMemberStatusBanned: 'Banned'
  })[status._] || 'Member'
}

function managedPermissions (status, chat, kind, isSavedMessages, canGetMembers) {
  const owner = status && status._ === 'chatMemberStatusCreator'
  const administrator = status && status._ === 'chatMemberStatusAdministrator'
  const rights = (status && status.rights) || {}
  const adminFallback = administrator && Object.keys(rights).length === 0
  return {
    isOwner: !!owner,
    isAdministrator: !!(owner || administrator),
    canChangeInfo: !!(owner || rights.can_change_info || adminFallback),
    canInviteUsers: !!(owner || rights.can_invite_users || adminFallback),
    canRestrictMembers: !!(owner || rights.can_restrict_members || adminFallback),
    canDeleteForAll: !!chat.can_be_deleted_for_all_users,
    canClearHistoryForSelf: !!chat.can_be_deleted_only_for_self,
    canClearHistoryForAll: !!chat.can_be_deleted_for_all_users,
    canClearHistory: !!(chat.can_be_deleted_only_for_self || chat.can_be_deleted_for_all_users),
    canLeave: kind !== 'private' && kind !== 'secret',
    canEditUsername: !!(owner && (kind === 'channel' || kind === 'supergroup')),
    canGetMembers: !!canGetMembers,
    canSetPhoto: !!((owner || rights.can_change_info || adminFallback) && kind !== 'private'),
  }
}

async function getManagedChatInfo (chatId) {
  ensureManagementReady()
  const chat = await client.invoke({ _: 'getChat', chat_id: chatId })
  const serialized = await serializeChatDetailed(chat)
  const type = chat.type || {}
  let status = null
  let fullInfo = null
  let groupInfo = null
  let canGetMembers = false

  if (type._ === 'chatTypeSupergroup') {
    groupInfo = await client.invoke({ _: 'getSupergroup', supergroup_id: type.supergroup_id }).catch(() => null)
    status = groupInfo && groupInfo.status
    const freshFullInfo = await client.invoke({ _: 'getSupergroupFullInfo', supergroup_id: type.supergroup_id }).catch(() => null)
    fullInfo = freshFullInfo || managedSupergroupFullInfoCache.get(String(type.supergroup_id)) || null
    if (freshFullInfo) managedSupergroupFullInfoCache.set(String(type.supergroup_id), freshFullInfo)
    canGetMembers = !!(fullInfo && fullInfo.can_get_members)
    if (!serialized.username && groupInfo && groupInfo.usernames && groupInfo.usernames.active_usernames && groupInfo.usernames.active_usernames.length) {
      serialized.username = groupInfo.usernames.active_usernames[0]
    }
  } else if (type._ === 'chatTypeBasicGroup') {
    groupInfo = await client.invoke({ _: 'getBasicGroup', basic_group_id: type.basic_group_id }).catch(() => null)
    status = groupInfo && groupInfo.status
    const freshFullInfo = await client.invoke({ _: 'getBasicGroupFullInfo', basic_group_id: type.basic_group_id }).catch(() => null)
    fullInfo = freshFullInfo || managedBasicGroupFullInfoCache.get(String(type.basic_group_id)) || null
    if (freshFullInfo) managedBasicGroupFullInfoCache.set(String(type.basic_group_id), freshFullInfo)
    canGetMembers = !!fullInfo
  }

  const me = await client.invoke({ _: 'getMe' }).catch(() => null)
  const isSavedMessages = !!(me && type._ === 'chatTypePrivate' && String(type.user_id) === String(me.id))
  const memberCount = type._ === 'chatTypeBasicGroup'
    ? (fullInfo && Array.isArray(fullInfo.members) ? fullInfo.members.length : (groupInfo && groupInfo.member_count) || null)
    : (fullInfo && fullInfo.member_count) || (groupInfo && groupInfo.member_count) || (type._ === 'chatTypePrivate' ? 2 : null)
  const inviteLink = fullInfo && fullInfo.invite_link && fullInfo.invite_link.invite_link
  const permissions = managedPermissions(status, chat, serialized.kind, isSavedMessages, canGetMembers)
  const activePublicUsernames = groupInfo && groupInfo.usernames && Array.isArray(groupInfo.usernames.active_usernames)
    ? groupInfo.usernames.active_usernames
    : []
  const accessType = type._ === 'chatTypePrivate'
    ? 'Private chat'
    : (type._ === 'chatTypeSupergroup' && activePublicUsernames.length ? 'Public' : 'Private')

  return {
    chat: {
      ...serialized,
      messageAutoDeleteTime: Number(chat.message_auto_delete_time || 0)
    },
    details: {
      description: (fullInfo && fullInfo.description) || '',
      accessType,
      memberCount,
      administratorCount: (fullInfo && fullInfo.administrator_count) || null,
      inviteLink: inviteLink || null,
      statusLabel: managedStatusLabel(status),
      autoDeleteTime: Number(chat.message_auto_delete_time || 0)
    },
    permissions,
    internal: {
      supergroupId: type._ === 'chatTypeSupergroup' ? type.supergroup_id : null,
      basicGroupId: type._ === 'chatTypeBasicGroup' ? type.basic_group_id : null
    }
  }
}

async function resolveManagedUserByUsername (value) {
  ensureManagementReady()
  const username = normalizeManagedUsername(value)
  if (!username) throw new Error('Username is required')
  const chat = await client.invoke({ _: 'searchPublicChat', username }).catch(() => null)
  if (!chat || !chat.type || chat.type._ !== 'chatTypePrivate' || !chat.type.user_id) {
    throw new Error(`@${username} is not a public user account`)
  }
  return { username, userId: chat.type.user_id }
}

async function createManagedChat (payload) {
  ensureManagementReady()
  const type = payload.type === 'group' ? 'group' : 'channel'
  const title = String(payload.title || '').trim()
  const description = String(payload.description || '').trim()
  const autoDeleteTime = Number(payload.autoDeleteTime || 0)
  if (!title || title.length > 128) throw new Error('Title must be 1-128 characters')
  if (description.length > 255) throw new Error('Description must be at most 255 characters')
  if (autoDeleteTime < 0 || autoDeleteTime > 365 * 86400 || autoDeleteTime % 86400 !== 0) throw new Error('Invalid auto-delete value')

  const chat = await client.invoke({
    _: 'createNewSupergroupChat',
    title,
    is_forum: type === 'group' && !!payload.forum,
    is_channel: type === 'channel',
    description,
    location: null,
    message_auto_delete_time: autoDeleteTime,
    for_import: false
  })

  const warnings = []

  const memberUsernames = [...new Set((payload.memberUsernames || []).map(normalizeManagedUsername).filter(Boolean))].slice(0, 20)
  if (memberUsernames.length) {
    const userIds = []
    for (const memberUsername of memberUsernames) {
      try {
        const member = await resolveManagedUserByUsername(memberUsername)
        userIds.push(member.userId)
      } catch (e) {
        warnings.push(String(e.message || e))
      }
    }
    if (userIds.length) {
      try {
        const added = await client.invoke({ _: 'addChatMembers', chat_id: chat.id, user_ids: userIds })
        const failed = added && added.failed_to_add_members
        if (Array.isArray(failed) && failed.length) warnings.push(`${failed.length} member(s) could not be added`)
      } catch (e) {
        warnings.push(`Some members could not be added: ${String(e.message || e)}`)
      }
    }
  }

  const fresh = await client.invoke({ _: 'getChat', chat_id: chat.id }).catch(() => chat)
  const serialized = await serializeChatDetailed(fresh)
  sendAll({ type: 'event', event: { name: 'chat-upsert', chat: serialized } })
  return { chat: serialized, warnings }
}

async function updateManagedChat (payload) {
  const info = await getManagedChatInfo(payload.chatId)
  const chatId = payload.chatId
  const title = payload.title == null ? null : String(payload.title).trim()
  const description = payload.description == null ? null : String(payload.description).trim()

  if ((title != null || description != null || payload.autoDeleteTime != null) && !info.permissions.canChangeInfo) {
    throw new Error('Telegram does not allow you to change this chat information')
  }
  if (title != null) {
    if (!title || title.length > 128) throw new Error('Title must be 1-128 characters')
    if (title !== info.chat.title) await client.invoke({ _: 'setChatTitle', chat_id: chatId, title })
  }
  if (description != null) {
    if (description.length > 255) throw new Error('Description must be at most 255 characters')
    if (description !== info.details.description) await client.invoke({ _: 'setChatDescription', chat_id: chatId, description })
  }
  if (payload.autoDeleteTime != null) {
    const autoDeleteTime = Number(payload.autoDeleteTime || 0)
    if (autoDeleteTime < 0 || autoDeleteTime > 365 * 86400 || autoDeleteTime % 86400 !== 0) throw new Error('Invalid auto-delete value')
    if (autoDeleteTime !== info.details.autoDeleteTime) {
      await client.invoke({ _: 'setChatMessageAutoDeleteTime', chat_id: chatId, message_auto_delete_time: autoDeleteTime })
    }
  }

  const fresh = await client.invoke({ _: 'getChat', chat_id: chatId })
  const serialized = await serializeChatDetailed(fresh)
  sendAll({ type: 'event', event: { name: 'chat-upsert', chat: serialized } })
  return getManagedChatInfo(chatId)
}

async function managedMembers (chatId, limit) {
  const info = await getManagedChatInfo(chatId)
  if (!info.permissions.canGetMembers) throw new Error('Telegram does not allow the member list to be viewed')
  const max = Math.max(1, Math.min(100, Number(limit) || 100))
  let members = []
  let totalCount = 0

  if (info.internal.supergroupId) {
    const result = await client.invoke({
      _: 'getSupergroupMembers',
      supergroup_id: info.internal.supergroupId,
      filter: null,
      offset: 0,
      limit: max
    })
    members = result.members || []
    totalCount = result.total_count || members.length
  } else if (info.internal.basicGroupId) {
    const full = await client.invoke({ _: 'getBasicGroupFullInfo', basic_group_id: info.internal.basicGroupId })
    members = (full.members || []).slice(0, max)
    totalCount = (full.members || []).length
  }

  const me = await client.invoke({ _: 'getMe' }).catch(() => null)
  const out = []
  for (const member of members) {
    const sender = member.member_id || {}
    if (sender._ === 'messageSenderUser' && sender.user_id) {
      const user = await client.invoke({ _: 'getUser', user_id: sender.user_id }).catch(() => null)
      const usernames = user && user.usernames && user.usernames.active_usernames
      out.push({
        userId: sender.user_id,
        name: user ? ([user.first_name, user.last_name].filter(Boolean).join(' ') || 'User') : 'User',
        username: user ? ((usernames && usernames[0]) || user.username || null) : null,
        statusLabel: managedStatusLabel(member.status),
        isSelf: !!(me && String(me.id) === String(sender.user_id))
      })
    } else if (sender._ === 'messageSenderChat' && sender.chat_id) {
      const senderChat = await client.invoke({ _: 'getChat', chat_id: sender.chat_id }).catch(() => null)
      out.push({
        userId: null,
        name: senderChat ? senderChat.title : 'Chat',
        username: null,
        statusLabel: managedStatusLabel(member.status),
        isSelf: false
      })
    }
  }
  return { members: out, totalCount }
}

async function addManagedMember (chatId, username) {
  const info = await getManagedChatInfo(chatId)
  if (!info.permissions.canInviteUsers) throw new Error('You do not have permission to add members')
  const user = await resolveManagedUserByUsername(username)
  const result = await client.invoke({ _: 'addChatMember', chat_id: chatId, user_id: user.userId, forward_limit: 0 })
  return { userId: user.userId, username: user.username, result }
}

async function removeManagedMember (chatId, userId) {
  const info = await getManagedChatInfo(chatId)
  if (!info.permissions.canRestrictMembers) throw new Error('You do not have permission to remove members')
  const me = await client.invoke({ _: 'getMe' })
  if (String(me.id) === String(userId)) throw new Error('Use Leave chat to remove yourself')
  await client.invoke({
    _: 'setChatMemberStatus',
    chat_id: chatId,
    member_id: { _: 'messageSenderUser', user_id: userId },
    status: { _: 'chatMemberStatusLeft' }
  })
  return { ok: true }
}


/* ------------------------------ Interactive chat service ------------------------------ */

function managedTextContent (text) {
  return {
    _: 'inputMessageText',
    text: { _: 'formattedText', text, entities: [] },
    link_preview_options: null,
    clear_draft: true
  }
}

async function getManagedMessageActions (chatId, messageId) {
  ensureManagementReady()
  const properties = await client.invoke({ _: 'getMessageProperties', chat_id: chatId, message_id: messageId })
  return {
    canReply: !!properties.can_be_replied,
    canEdit: !!properties.can_be_edited,
    canDeleteSelf: !!properties.can_be_deleted_only_for_self,
    canDeleteAll: !!properties.can_be_deleted_for_all_users
  }
}

async function sendManagedTextMessage (chatId, text, replyToMessageId) {
  ensureManagementReady()
  const body = String(text || '').trim()
  if (!body) throw new Error('Message is empty')
  if (body.length > 4096) throw new Error('Message is too long')
  let replyTo = null
  if (replyToMessageId) {
    const actions = await getManagedMessageActions(chatId, replyToMessageId)
    if (!actions.canReply) throw new Error('Telegram does not allow replying to this message')
    replyTo = { _: 'inputMessageReplyToMessage', message_id: replyToMessageId, quote: null, checklist_task_id: 0 }
  }
  const message = await client.invoke({
    _: 'sendMessage',
    chat_id: chatId,
    topic_id: null,
    reply_to: replyTo,
    options: null,
    reply_markup: null,
    input_message_content: managedTextContent(body)
  })
  emitRealtimeMessage(message).catch(() => {})
  emitChatUpsert(chatId).catch(() => {})
  return serializeRealtimeMessage(message)
}

async function editManagedTextMessage (chatId, messageId, text) {
  ensureManagementReady()
  const body = String(text || '').trim()
  if (!body) throw new Error('Message is empty')
  const actions = await getManagedMessageActions(chatId, messageId)
  if (!actions.canEdit) throw new Error('Telegram does not allow editing this message')
  const message = await client.invoke({
    _: 'editMessageText',
    chat_id: chatId,
    message_id: messageId,
    reply_markup: null,
    input_message_content: managedTextContent(body)
  })
  emitRealtimeMessage(message).catch(() => {})
  return serializeRealtimeMessage(message)
}

async function deleteManagedMessage (chatId, messageId, revoke) {
  ensureManagementReady()
  const actions = await getManagedMessageActions(chatId, messageId)
  let useRevoke = revoke === true
  if (useRevoke && !actions.canDeleteAll && actions.canDeleteSelf) useRevoke = false
  if (!useRevoke && !actions.canDeleteSelf && actions.canDeleteAll) useRevoke = true
  if (useRevoke && !actions.canDeleteAll) throw new Error('Telegram does not allow deleting this message for everyone')
  if (!useRevoke && !actions.canDeleteSelf) throw new Error('Telegram does not allow deleting this message only for you')
  await client.invoke({ _: 'deleteMessages', chat_id: chatId, message_ids: [messageId], revoke: useRevoke })
  sendAll({ type: 'event', event: { name: 'message-delete', chatId, messageIds: [messageId], isPermanent: useRevoke } })
  emitChatUpsert(chatId).catch(() => {})
  return { ok: true, revoke: useRevoke }
}


function managedAttachmentKind (fileName, mimeType) {
  const name = String(fileName || '').toLowerCase()
  const mime = String(mimeType || '').toLowerCase()
  if (/^image\/(jpeg|png)$/.test(mime) || /\.(jpe?g|png)$/.test(name)) return 'photo'
  if (/^video\//.test(mime) || /\.(mp4|mov|m4v|webm|mkv)$/.test(name)) return 'video'
  if (/^audio\//.test(mime) || /\.(mp3|m4a|aac|ogg|wav|flac)$/.test(name)) return 'audio'
  return 'document'
}

function managedAttachmentContent (kind, inputFile, caption, oneTime) {
  const formattedCaption = { _: 'formattedText', text: String(caption || '').slice(0, 1024), entities: [] }
  const selfDestruct = oneTime ? { _: 'messageSelfDestructTypeImmediately' } : null

  if (kind === 'photo') {
    return {
      _: 'inputMessagePhoto',
      photo: inputFile,
      thumbnail: null,
      added_sticker_file_ids: [],
      width: 0,
      height: 0,
      caption: formattedCaption,
      show_caption_above_media: false,
      self_destruct_type: selfDestruct,
      has_spoiler: false
    }
  }

  if (kind === 'video') {
    return {
      _: 'inputMessageVideo',
      video: inputFile,
      thumbnail: null,
      cover: null,
      start_timestamp: 0,
      added_sticker_file_ids: [],
      duration: 0,
      width: 0,
      height: 0,
      supports_streaming: true,
      caption: formattedCaption,
      show_caption_above_media: false,
      self_destruct_type: selfDestruct,
      has_spoiler: false
    }
  }

  if (kind === 'audio') {
    return {
      _: 'inputMessageAudio',
      audio: inputFile,
      album_cover_thumbnail: null,
      duration: 0,
      title: '',
      performer: '',
      caption: formattedCaption
    }
  }

  return {
    _: 'inputMessageDocument',
    document: inputFile,
    thumbnail: null,
    disable_content_type_detection: false,
    caption: formattedCaption
  }
}

function managedLocalInputFile (absolutePath) {
  return { '@type': 'inputFileLocal', path: absolutePath }
}

function managedUploadFileType (kind) {
  if (kind === 'photo') return { _: 'fileTypePhoto' }
  if (kind === 'video') return { _: 'fileTypeVideo' }
  if (kind === 'audio') return { _: 'fileTypeAudio' }
  return { _: 'fileTypeDocument' }
}

async function managedWaitForPreliminaryUpload (file, timeoutMs = 180000) {
  if (!file || !file.id) throw new Error('Telegram did not return a file id for the upload')
  if (file.remote && file.remote.is_uploading_completed) return file

  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      client.off('update', onUpdate)
      if (error) reject(error)
      else resolve(value)
    }
    const onUpdate = update => {
      if (!update || update._ !== 'updateFile' || !update.file || String(update.file.id) !== String(file.id)) return
      if (update.file.remote && update.file.remote.is_uploading_completed) finish(null, update.file)
    }
    const timer = setTimeout(() => finish(new Error('Telegram upload preparation timed out')), timeoutMs)
    client.on('update', onUpdate)
    client.invoke({ _: 'getFile', file_id: file.id }).then(current => {
      if (current && current.remote && current.remote.is_uploading_completed) finish(null, current)
    }).catch(() => {})
  })
}

async function managedPrepareInputFile (absolutePath, kind) {
  const uploaded = await client.invoke({
    _: 'preliminaryUploadFile',
    file: managedLocalInputFile(absolutePath),
    file_type: managedUploadFileType(kind),
    priority: 32
  })
  if (!uploaded || !uploaded.id) throw new Error('Telegram did not return a prepared file id')
  // preliminaryUploadFile intentionally remains incomplete until the file is
  // attached to a message. Use the returned id immediately; waiting for
  // remote.is_uploading_completed here deadlocks the send pipeline.
  return { '@type': 'inputFileId', id: uploaded.id }
}

function managedSendAttachmentQuery (chatId, replyTo, content) {
  const query = {
    _: 'sendMessage',
    chat_id: chatId,
    input_message_content: content
  }
  if (replyTo) query.reply_to = replyTo
  return query
}

async function sendManagedAttachmentMessage (chatId, filePath, caption, replyToMessageId, mimeType, fileName, oneTime) {
  ensureManagementReady()
  const absolutePath = path.resolve(String(filePath || ''))
  const stat = await fs.promises.stat(absolutePath).catch(() => null)
  if (!stat || !stat.isFile() || stat.size <= 0) throw new Error('The attachment could not be staged for Telegram')

  let replyTo = null
  if (replyToMessageId) {
    const actions = await getManagedMessageActions(chatId, replyToMessageId)
    if (!actions.canReply) throw new Error('Telegram does not allow replying to this message')
    replyTo = { _: 'inputMessageReplyToMessage', message_id: replyToMessageId, quote: null, checklist_task_id: 0 }
  }

  const kind = managedAttachmentKind(fileName || absolutePath, mimeType)
  if (oneTime) {
    const chat = await client.invoke({ _: 'getChat', chat_id: chatId })
    if (!chat || !chat.type || chat.type._ !== 'chatTypePrivate') {
      throw new Error('Telegram supports View once only in private chats')
    }
    if (kind !== 'photo' && kind !== 'video') {
      throw new Error('View once is available only for photos and videos')
    }
  }

  let message
  let directError = null
  try {
    const content = managedAttachmentContent(kind, managedLocalInputFile(absolutePath), caption, !!oneTime)
    message = await client.invoke(managedSendAttachmentQuery(chatId, replyTo, content))
  } catch (error) {
    directError = error
    const text = String(error && error.message ? error.message : error)
    if (!/inputfile|input file|local file|file is not specified/i.test(text)) throw error
  }

  if (!message) {
    try {
      const prepared = await managedPrepareInputFile(absolutePath, kind)
      const content = managedAttachmentContent(kind, prepared, caption, !!oneTime)
      message = await client.invoke(managedSendAttachmentQuery(chatId, replyTo, content))
    } catch (fallbackError) {
      const first = directError ? String(directError.message || directError) : 'direct local-file send failed'
      const second = String(fallbackError && fallbackError.message ? fallbackError.message : fallbackError)
      throw new Error('Telegram attachment send failed. Direct: ' + first + '. Prepared upload: ' + second)
    }
  }

  emitRealtimeMessage(message).catch(() => {})
  emitChatUpsert(chatId).catch(() => {})
  return serializeRealtimeMessage(message)
}

/* ------------------------------ File search ------------------------------ */

/* TDLib class names, not invented ones.
 *
 * This map used to read `messageFilterDocument`, `messageFilterPhoto` and five more
 * siblings. TDLib has no such classes - the family is `searchMessagesFilter*` - so
 * `searchChatMessages` rejected the request at PARSE time with
 * `Unknown class "messageFilterDocument"`. That failure was chat-independent and
 * total: all seven non-`all` filters were dead for every chat, always, and
 * `loadSearchMore` in public/app.js toasted the raw TDLib string at the user.
 *
 * Only whole-chat search reached this code. The ordinary Files-tab type dropdown
 * filters the already-loaded index in the browser, which is why the defect stayed
 * invisible until someone filtered a search. */
const MESSAGE_FILTERS = {
  all: null,
  document: 'searchMessagesFilterDocument',
  photo: 'searchMessagesFilterPhoto',
  video: 'searchMessagesFilterVideo',
  audio: 'searchMessagesFilterAudio',
  voice: 'searchMessagesFilterVoiceNote',
  gif: 'searchMessagesFilterAnimation',
  video_note: 'searchMessagesFilterVideoNote'
}

async function searchMedia (chatId, query, fromMessageId, limit, filter) {
  if (!client || !ready) throw new Error('Not logged in')
  const res = await client.invoke({
    _: 'searchChatMessages',
    chat_id: chatId,
    query: String(query || ''),
    from_message_id: fromMessageId || 0,
    offset: 0,
    limit: limit || 100,
    filter: MESSAGE_FILTERS[filter] ? { _: MESSAGE_FILTERS[filter] } : undefined
  })
  const raw = (res.messages || []).filter(m => m.sending_state === undefined)
  const items = []
  for (const m of raw) {
    const media = extractMedia(m)
    if (!media || !media.file) continue
    const f = media.file
    items.push({
      key: `${chatId}:${m.id}`,
      messageId: m.id,
      chatId,
      date: m.date,
      fileId: f.id,
      name: media.name,
      fileSize: f.size || f.expected_size || 0,
      type: media.type,
      mime: media.mime || 'application/octet-stream',
      caption: media.caption || null,
      thumbFileId: mediaThumbFileId(media.thumb),
      thumbUrl: null
    })
  }
  return { items, totalCount: res.total_count || items.length, hasMore: raw.length === limit }
}

/* ------------------------------ HTTP + WS server ------------------------------ */

const app = express()
app.use(express.json())


app.post('/api/chat-photo/:chatId', express.raw({ type: 'application/octet-stream', limit: '10mb' }), async (req, res) => {
  let tempPath = null
  try {
    ensureManagementReady()
    const chatId = Number(req.params.chatId)
    if (!Number.isSafeInteger(chatId)) return res.status(400).json({ error: 'Invalid chat id' })
    const info = await getManagedChatInfo(chatId)
    if (!info.permissions.canSetPhoto) return res.status(403).json({ error: 'You do not have permission to change this chat photo' })
    const name = String(req.headers['x-file-name'] || 'photo.jpg')
    const lower = name.toLowerCase()
    const extension = lower.endsWith('.png') ? '.png' : (/\.jpe?g$/.test(lower) ? '.jpg' : null)
    if (!extension) return res.status(400).json({ error: 'Chat photos must be PNG or JPEG' })
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'No image uploaded' })
    const isPng = req.body.length >= 8 && req.body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    const isJpeg = req.body.length >= 3 && req.body[0] === 0xff && req.body[1] === 0xd8 && req.body[2] === 0xff
    if ((extension === '.png' && !isPng) || (extension === '.jpg' && !isJpeg)) {
      return res.status(400).json({ error: 'The uploaded file does not match its PNG/JPEG format' })
    }
    tempPath = path.join(MANAGEMENT_UPLOAD_DIR, `${crypto.randomUUID()}${extension}`)
    await fs.promises.writeFile(tempPath, req.body)
    await client.invoke({
      _: 'setChatPhoto',
      chat_id: chatId,
      photo: { _: 'inputChatPhotoStatic', photo: { _: 'inputFileLocal', path: tempPath } }
    })
    const fresh = await client.invoke({ _: 'getChat', chat_id: chatId })
    sendAll({ type: 'event', event: { name: 'chat-upsert', chat: await serializeChatDetailed(fresh) } })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  } finally {
    if (tempPath) fs.promises.unlink(tempPath).catch(() => {})
  }
})


app.post('/api/chat-attachment/:chatId', async (req, res) => {
  let uploadDir = null
  try {
    ensureManagementReady()
    const chatId = Number(req.params.chatId)
    if (!Number.isSafeInteger(chatId)) return res.status(400).json({ error: 'Invalid chat id' })
    const rawName = String(req.headers['x-file-name'] || 'attachment.bin')
    let decodedName = rawName
    try { decodedName = decodeURIComponent(rawName) } catch {}
    const fileName = sanitize(decodedName) || 'attachment.bin'
    const contentLength = Number(req.headers['content-length'] || 0)
    const maxBytes = 4 * 1024 * 1024 * 1024
    if (contentLength > maxBytes) return res.status(413).json({ error: 'Attachment is larger than 4 GB' })

    uploadDir = path.join(MANAGEMENT_UPLOAD_DIR, crypto.randomUUID())
    await fs.promises.mkdir(uploadDir, { recursive: true })
    const tempPath = path.join(uploadDir, fileName)
    const handle = await fs.promises.open(tempPath, 'wx')
    let total = 0
    try {
      for await (const chunk of req) {
        total += chunk.length
        if (total > maxBytes) throw new Error('Attachment is larger than 4 GB')
        await handle.write(chunk)
      }
    } finally {
      await handle.close()
    }
    if (!total) return res.status(400).json({ error: 'Attachment is empty' })

    let caption = String(req.headers['x-caption'] || '')
    try { caption = decodeURIComponent(caption) } catch {}
    const replyHeader = req.headers['x-reply-to']
    const replyToMessageId = replyHeader ? Number(replyHeader) : null
    let mimeType = String(req.headers['x-mime-type'] || 'application/octet-stream')
    try { mimeType = decodeURIComponent(mimeType) } catch {}
    const oneTime = String(req.headers['x-one-time'] || '') === '1'
    const message = await sendManagedAttachmentMessage(
      chatId,
      tempPath,
      caption,
      Number.isSafeInteger(replyToMessageId) ? replyToMessageId : null,
      mimeType,
      fileName,
      oneTime
    )
    res.json({ ok: true, message })
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  } finally {
    if (uploadDir) {
      const timer = setTimeout(() => fs.promises.rm(uploadDir, { recursive: true, force: true }).catch(() => {}), 6 * 60 * 60 * 1000)
      if (timer.unref) timer.unref()
    }
  }
})

const previewFileInflight = new Map()

async function resolvePreviewFileId (fileId, chatId, messageId) {
  let id = Number(fileId)
  if (!Number.isSafeInteger(id) || id <= 0) id = 0
  let file = id ? await client.invoke({ _: 'getFile', file_id: id }).catch(() => null) : null
  const usable = file && file.local && (file.local.is_downloading_completed || file.local.can_be_downloaded !== false)
  if (usable) return id

  const numericChatId = Number(chatId)
  const numericMessageId = Number(messageId)
  if (Number.isSafeInteger(numericChatId) && Number.isSafeInteger(numericMessageId)) {
    const message = await client.invoke({ _: 'getMessage', chat_id: numericChatId, message_id: numericMessageId }).catch(() => null)
    const media = extractMedia(message)
    if (media && media.file && media.file.id) return media.file.id
  }
  if (id) return id
  throw new Error('Telegram file reference is unavailable')
}

async function ensurePreviewFile (fileId, chatId, messageId) {
  const resolvedId = await resolvePreviewFileId(fileId, chatId, messageId)
  const key = String(resolvedId)
  if (previewFileInflight.has(key)) return previewFileInflight.get(key)

  const work = (async () => {
    const existing = await client.invoke({ _: 'getFile', file_id: resolvedId }).catch(() => null)
    if (existing && existing.local && existing.local.is_downloading_completed && existing.local.path) return existing.local.path
    if (existing && existing.local && existing.local.can_be_downloaded === false) throw new Error('Telegram reports that this file cannot be downloaded')

    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        client.off('update', onUpdate)
        if (error) reject(error)
        else resolve(value)
      }
      const inspect = file => {
        if (!file || String(file.id) !== key) return
        const local = file.local || {}
        if (local.is_downloading_completed && local.path) finish(null, local.path)
        else if (local.can_be_downloaded === false && !local.is_downloading_active) finish(new Error('Telegram file is not downloadable'))
      }
      const onUpdate = update => {
        if (!update || update._ !== 'updateFile') return
        inspect(update.file)
      }
      const timer = setTimeout(() => finish(new Error('Telegram could not prepare this media in time')), 120000)
      client.on('update', onUpdate)
      client.invoke({
        _: 'downloadFile',
        file_id: resolvedId,
        priority: 32,
        offset: 0,
        limit: 0,
        synchronous: false
      }).then(inspect).catch(error => finish(error))
    })
  })().finally(() => previewFileInflight.delete(key))

  previewFileInflight.set(key, work)
  return work
}

function previewMimeType (requested, name) {
  const explicit = String(requested || '').trim().toLowerCase()
  if (/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(explicit)) return explicit
  const extension = path.extname(String(name || '')).toLowerCase()
  return ({
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.m4v': 'video/x-m4v',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.ogg': 'audio/ogg',
    '.wav': 'audio/wav',
    '.flac': 'audio/flac',
    '.pdf': 'application/pdf'
  })[extension] || 'application/octet-stream'
}

function parsePreviewRange (header, size) {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(header).trim())
  if (!match) return false
  let start = match[1] ? Number(match[1]) : null
  let end = match[2] ? Number(match[2]) : null
  if (start == null && end == null) return false
  if (start == null) {
    const suffix = Math.max(0, end || 0)
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    if (end == null || end >= size) end = size - 1
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return false
  return { start, end }
}

app.get('/api/media-preview/:fileId', async (req, res) => {
  try {
    ensureManagementReady()
    const localPath = await ensurePreviewFile(req.params.fileId, req.query.chatId, req.query.messageId)
    const stat = await fs.promises.stat(localPath)
    if (!stat.isFile() || stat.size <= 0) throw new Error('Prepared media file is empty')

    const name = sanitize(String(req.query.name || path.basename(localPath)))
    const mime = previewMimeType(req.query.mime, name)
    const range = parsePreviewRange(req.headers.range, stat.size)
    res.setHeader('Content-Type', mime)
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Cache-Control', 'private, max-age=300')
    res.setHeader('Content-Disposition', "inline; filename*=UTF-8''" + encodeURIComponent(name))

    if (range === false) {
      res.status(416)
      res.setHeader('Content-Range', `bytes */${stat.size}`)
      return res.end()
    }

    let stream
    if (range) {
      const length = range.end - range.start + 1
      res.status(206)
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`)
      res.setHeader('Content-Length', String(length))
      if (req.method === 'HEAD') return res.end()
      stream = fs.createReadStream(localPath, { start: range.start, end: range.end })
    } else {
      res.status(200)
      res.setHeader('Content-Length', String(stat.size))
      if (req.method === 'HEAD') return res.end()
      stream = fs.createReadStream(localPath)
    }

    stream.on('error', error => {
      if (!res.headersSent) res.status(500).json({ error: String(error.message || error) })
      else res.destroy(error)
    })
    res.on('close', () => stream.destroy())
    stream.pipe(res)
  } catch (error) {
    res.status(404).json({ error: String(error.message || error) })
  }
})

app.use('/dl', (req, res, next) => {
  express.static(downloadsDir, { fallthrough: true, maxAge: 0, dotfiles: 'allow' })(req, res, next)
})
app.use(express.static(path.join(ROOT, 'public')))

app.get('/api/downloads', (req, res) => {
  res.json(dm.snapshot().filter(j => j.status === 'done'))
})

/* On-disk hashes for every script in public/.
 *
 * `?v=` tokens on this branch are reused across content changes, so a browser can
 * keep executing an older copy of a changed file and a real code fix can be
 * invisible. The browser cannot know what is on disk, so the server reports it
 * here and app.js compares the bytes it actually received against these hashes,
 * printing one `[FileGram runtime]` line per script. That is what allows a claim
 * about behaviour to be tied to the code that produced it, instead of being
 * judged against source that may never have reached the browser. */
app.get('/api/filegram/asset-hashes', (req, res) => {
  const dir = path.join(ROOT, 'public')
  const assets = {}
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.js')) continue
      try {
        const bytes = fs.readFileSync(path.join(dir, name))
        assets[name] = { sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }
      } catch {}
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) })
  }
  res.json({ ok: true, buildId: BUILD_ID, buildIdSource: BUILD_ID_SOURCE, serverPid: process.pid, assets })
})

/* ---------------------------- Download folder picker ----------------------------
 *
 * One endpoint, in the process `npm start` actually launches.
 *
 * It used to live in `bulk-upload-preload.js`, which meant reachability depended on
 * which preloads happened to wrap express, and a second copy lived in
 * `native-folder-picker-preload.js`, which nothing required, so its
 * `-modern` route answered 404 for its whole life. Both are gone; this is the only
 * implementation.
 *
 * The dialog is the Windows Vista+ common item dialog (`IFileOpenDialog`) in
 * folder-pick mode: the large, resizable Explorer surface with an address bar, a
 * contents pane and a sidebar. The previous implementation used
 * `OpenFileDialog` with a synthetic file name (`$d.FileName = "Select this folder"`)
 * and derived the directory from `Split-Path -Parent` of whatever the dialog left
 * in the file-name box, so the answer could be a parent directory or an empty
 * string that was then indistinguishable from a cancel. `GetResult()` +
 * `GetDisplayName(SIGDN_FILESYSPATH)` returns the chosen directory itself, so there
 * is nothing to derive (clause 2.17).
 *
 * `implementation` on the response body names the dialog that actually ran. That
 * field is how a stale process is caught next time: at HEAD the response carried no
 * such field, so the running dialog could not be identified from what the browser
 * received. */
const PICKER_TIMEOUT_MS = 5 * 60 * 1000
const PICKER_PRIMARY = 'IFileOpenDialog'
const PICKER_FALLBACK = 'OpenFileDialog'
const PICKER_TITLE = 'Select FileGram download folder'

/* `IFileOpenDialog` / `IShellItem` interop.
 *
 * The unused vtable slots are declared as no-argument placeholders because a COM
 * interface declared `InterfaceIsIUnknown` is dispatched by slot ORDER; the
 * signatures of methods that are never called do not matter, their positions do.
 * Only Show, GetOptions, SetOptions, SetTitle, SetOkButtonLabel, SetFolder,
 * GetResult and GetDisplayName are ever invoked. */
const PICKER_INTEROP_SCRIPT = `$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Runtime.InteropServices;

namespace FileGramPicker
{
    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IShellItem
    {
        void BindToHandler();
        void GetParent();
        void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
        void GetAttributes();
        void Compare();
    }

    [ComImport, Guid("d57c7288-d4ad-4768-be02-9d969532d960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IFileOpenDialog
    {
        [PreserveSig] int Show(IntPtr hwndParent);
        void SetFileTypes();
        void SetFileTypeIndex();
        void GetFileTypeIndex();
        void Advise();
        void Unadvise();
        void SetOptions(uint fos);
        void GetOptions(out uint pfos);
        void SetDefaultFolder(IShellItem psi);
        void SetFolder(IShellItem psi);
        void GetFolder();
        void GetCurrentSelection();
        void SetFileName();
        void GetFileName();
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
        void SetFileNameLabel();
        void GetResult(out IShellItem ppsi);
        void AddPlace();
        void SetDefaultExtension();
        void Close();
        void SetClientGuid();
        void ClearClientData();
        void SetFilter();
        void GetResults();
        void GetSelectedItems();
    }

    [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7"), ClassInterface(ClassInterfaceType.None)]
    public class FileOpenDialogShell { }

    public static class Picker
    {
        const uint FOS_PICKFOLDERS = 0x00000020;
        const uint FOS_FORCEFILESYSTEM = 0x00000040;
        const uint FOS_PATHMUSTEXIST = 0x00000800;
        const uint SIGDN_FILESYSPATH = 0x80058000;
        const int CANCELLED = unchecked((int)0x800704C7);

        [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
        static extern void SHCreateItemFromParsingName(
            [MarshalAs(UnmanagedType.LPWStr)] string pszPath,
            IntPtr pbc,
            [MarshalAs(UnmanagedType.LPStruct)] Guid riid,
            [MarshalAs(UnmanagedType.Interface)] out object ppv);

        public static string Pick(string title, string startIn)
        {
            IFileOpenDialog dialog = (IFileOpenDialog)(new FileOpenDialogShell());
            uint options;
            dialog.GetOptions(out options);
            dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
            if (!string.IsNullOrEmpty(title)) dialog.SetTitle(title);
            dialog.SetOkButtonLabel("Select folder");
            if (!string.IsNullOrEmpty(startIn))
            {
                try
                {
                    object item;
                    SHCreateItemFromParsingName(startIn, IntPtr.Zero, typeof(IShellItem).GUID, out item);
                    if (item != null) dialog.SetFolder((IShellItem)item);
                }
                catch { }
            }
            int hr = dialog.Show(IntPtr.Zero);
            if (hr == CANCELLED) return null;
            if (hr != 0) Marshal.ThrowExceptionForHR(hr);
            IShellItem chosen;
            dialog.GetResult(out chosen);
            string chosenPath;
            chosen.GetDisplayName(SIGDN_FILESYSPATH, out chosenPath);
            return chosenPath;
        }
    }
}
'@
Add-Type -TypeDefinition $source -Language CSharp | Out-Null
[Console]::Out.Write('FILEGRAM_READY')
[Console]::Out.Flush()
$picked = [FileGramPicker.Picker]::Pick($env:FILEGRAM_PICKER_TITLE, $env:FILEGRAM_PICKER_START)
if ($null -eq $picked) { [Console]::Out.Write('FILEGRAM_CANCELLED') }
else { [Console]::Out.Write('FILEGRAM_PATH:' + $picked) }
`

/* Declared degradation, never a silent one.
 *
 * If the interop shim cannot be built on this host (no C# compiler reachable from
 * Add-Type, a locked-down .NET) the fallback is `OpenFileDialog` with
 * `ValidateNames = $false`, which is still the Explorer shell surface but is a FILE
 * chooser used as a folder chooser. It reports `implementation: 'OpenFileDialog'`
 * and `degraded: true` so the response says which dialog the user saw. The
 * directory comes from the dialog's own folder via `GetDirectoryName`, and only
 * when that yields a real existing directory - never from `Split-Path -Parent` of a
 * fabricated file name. */
const PICKER_FALLBACK_SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = $env:FILEGRAM_PICKER_TITLE
$dialog.ValidateNames = $false
$dialog.CheckFileExists = $false
$dialog.CheckPathExists = $true
$dialog.Multiselect = $false
$dialog.RestoreDirectory = $true
if ($env:FILEGRAM_PICKER_START -and (Test-Path -LiteralPath $env:FILEGRAM_PICKER_START)) { $dialog.InitialDirectory = $env:FILEGRAM_PICKER_START }
[Console]::Out.Write('FILEGRAM_READY')
[Console]::Out.Flush()
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  $candidate = [System.IO.Path]::GetDirectoryName($dialog.FileName)
  if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Container)) { [Console]::Out.Write('FILEGRAM_PATH:' + $candidate) }
  else { [Console]::Out.Write('FILEGRAM_CANCELLED') }
} else { [Console]::Out.Write('FILEGRAM_CANCELLED') }
`

function runPickerScript (script) {
  return new Promise(resolve => {
    const child = childProcess.spawn('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FILEGRAM_PICKER_TITLE: PICKER_TITLE, FILEGRAM_PICKER_START: downloadsDir || '' }
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      finish({ code: null, stdout, stderr, timedOut: true })
    }, PICKER_TIMEOUT_MS)
    if (timer.unref) timer.unref()
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8') })
    child.on('error', error => finish({ code: null, stdout, stderr: String(error && error.message || error), spawnFailed: true }))
    child.on('close', code => finish({ code, stdout, stderr }))
  })
}

/* Reads the child's answer. Three outcomes and no fourth:
 *   FILEGRAM_PATH:<dir>   a directory the user chose
 *   FILEGRAM_CANCELLED    the user cancelled, or the dialog closed with no result
 *   neither               nothing was chosen, and `ranDialog` says whether the shim
 *                         got as far as showing a dialog at all
 *
 * `FILEGRAM_READY` is written and flushed by the script after `Add-Type` succeeds and
 * before `Show()`, which is what makes the third case decidable. It matters: without
 * it, a dialog the user (or a test) closed abnormally looked identical to an interop
 * shim that could not be built, so the endpoint fell back and opened a SECOND dialog
 * on top of the one that had just been dismissed. Observed while verifying this
 * endpoint, and fixed here rather than left as a surprise.
 *
 * The old implementation had no third case at all: a dialog that ended abnormally
 * exited 4294967295 and the route answered HTTP 500 with the string "Folder picker
 * exited with code 4294967295", which was toasted verbatim at the user. A dialog that
 * produced no selection is a cancel as far as the configured folder is concerned, and
 * nothing about it changes, so that is what is reported. */
function readPickerAnswer (result) {
  const text = String(result && result.stdout || '')
  const ranDialog = text.includes('FILEGRAM_READY')
  const marker = text.indexOf('FILEGRAM_PATH:')
  if (marker >= 0) {
    const picked = text.slice(marker + 'FILEGRAM_PATH:'.length).trim()
    if (picked) return { kind: 'path', path: picked }
  }
  if (text.includes('FILEGRAM_CANCELLED')) return { kind: 'cancelled', reason: 'cancelled' }
  // The dialog was on screen and went away without a result: an abnormal close, not an
  // unavailable shim. Reported as a cancel, and never retried through the fallback.
  if (ranDialog) return { kind: 'cancelled', reason: 'dialog-closed' }
  return { kind: 'unavailable', stderr: String(result && result.stderr || '').trim() }
}

app.post('/api/filegram/pick-download-folder', async (req, res) => {
  if (process.platform !== 'win32') {
    return res.status(501).json({ ok: false, cancelled: false, path: null, implementation: null, error: 'The native folder picker is available on Windows only' })
  }
  try {
    const primary = await runPickerScript(PICKER_INTEROP_SCRIPT)
    const answer = readPickerAnswer(primary)
    if (answer.kind === 'path') return res.json({ ok: true, cancelled: false, path: answer.path, implementation: PICKER_PRIMARY, degraded: false })
    if (answer.kind === 'cancelled') {
      return res.json({ ok: true, cancelled: true, path: null, implementation: PICKER_PRIMARY, degraded: false, reason: answer.reason })
    }

    console.warn('[FileGram picker] IFileOpenDialog unavailable on this host, falling back to OpenFileDialog:', answer.stderr || `exit ${primary.code}`)
    const fallback = await runPickerScript(PICKER_FALLBACK_SCRIPT)
    const fallbackAnswer = readPickerAnswer(fallback)
    if (fallbackAnswer.kind === 'path') return res.json({ ok: true, cancelled: false, path: fallbackAnswer.path, implementation: PICKER_FALLBACK, degraded: true })
    if (fallbackAnswer.kind === 'cancelled') {
      return res.json({ ok: true, cancelled: true, path: null, implementation: PICKER_FALLBACK, degraded: true, reason: fallbackAnswer.reason })
    }
    return res.status(500).json({
      ok: false,
      cancelled: false,
      path: null,
      implementation: null,
      degraded: true,
      // A sentence, not an exit code. The frontend toasts this text.
      error: 'The folder picker could not open on this computer. Nothing was changed.'
    })
  } catch (error) {
    console.warn('[FileGram picker] failed:', error && error.stack || error)
    res.status(500).json({ ok: false, cancelled: false, path: null, implementation: null, error: 'The folder picker could not open on this computer. Nothing was changed.' })
  }
})

app.post('/api/config', (req, res) => {
  const { apiId, apiHash } = req.body || {}
  if (!apiId || !apiHash) {
    return res.status(400).json({ error: 'apiId and apiHash are required' })
  }
  try {
    saveConfig(apiId, apiHash)
    initClient({ apiId: Number(apiId), apiHash: String(apiHash) })
    res.json({ ok: true, status: 'initialized' })
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
})

const server = http.createServer(app)
const wss = new WebSocketServer({ server })

wss.on('connection', (ws) => {
  webSockets.add(ws)
  ws.on('close', () => webSockets.delete(ws))

  ws.on('message', async (raw) => {
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      return respond(ws, null, false, null, 'Invalid JSON')
    }
    const { id, type, payload } = msg
    try {
      switch (type) {
        case 'get-status': {
          const config = loadConfig()
          if (!config) return respond(ws, id, true, { status: 'need-config', buildId: BUILD_ID, buildIdSource: BUILD_ID_SOURCE, serverPid: process.pid, serverStartedAt: PROCESS_STARTED_AT })
          return respond(ws, id, true, {
            status: ready ? 'ready' : (authState ? 'waiting-input' : 'initializing'),
            ready,
            concurrency: CONCURRENCY,
            downloadsDir,
            authState: authState ? authState._ : null,
            me: ready ? currentUser : null,
            // Same identity as the boot banner, so the browser can tell which
            // process answered it and whether that process is this working tree.
            buildId: BUILD_ID,
            buildIdSource: BUILD_ID_SOURCE,
            serverPid: process.pid,
            serverStartedAt: PROCESS_STARTED_AT
          })
        }
        case 'login-input':
          await submitLogin(payload.kind, payload.value)
          return respond(ws, id, true, { ok: true })
        case 'get-chats':
          lastChatOffset = { order: '9223372036854775807', chat_id: 0 }
          return respond(ws, id, true, { chats: await loadChats() })
        case 'get-chats-more':
          return respond(ws, id, true, { chats: await loadChats() })
        case 'get-messages': {
          const r = await loadMessages(payload.chatId, payload.fromMessageId, payload.limit || 100)
          return respond(ws, id, true, r)
        }
        /* Marks a chat read on Telegram.
         *
         * Deliberately an explicit command rather than a side effect of
         * get-messages: the file index reconciler calls get-messages repeatedly in
         * the background, so marking read there would silently clear the unread
         * state of chats the user never opened.
         *
         * Viewing the chat's last message marks everything up to it as read.
         * TDLib then pushes updateChatReadInbox, which already emits chat-upsert,
         * so the client's unread count and filters update through the normal path
         * with no extra plumbing. */
        case 'mark-read': {
          if (!client || !ready) return respond(ws, id, false, null, 'Not logged in')
          if (payload.chatId == null) return respond(ws, id, false, null, 'chatId is required')
          const chat = await client.invoke({ _: 'getChat', chat_id: payload.chatId }).catch(() => null)
          const lastMessageId = chat && chat.last_message ? chat.last_message.id : null
          if (!lastMessageId) return respond(ws, id, true, { ok: false, reason: 'no messages' })
          const view = extra => client.invoke({
            _: 'viewMessages',
            chat_id: payload.chatId,
            message_ids: [lastMessageId],
            force_read: true,
            ...extra
          })
          // The source parameter is required by newer TDLib builds and rejected by
          // older ones, so fall back rather than assume a version.
          const ok = await view({ source: { _: 'messageSourceChatHistory' } })
            .then(() => true)
            .catch(() => view({ message_thread_id: 0 }).then(() => true).catch(() => false))
          return respond(ws, id, true, { ok })
        }
        case 'search-media': {
          const r = await searchMedia(payload.chatId, payload.query, payload.fromMessageId, payload.limit, payload.filter)
          return respond(ws, id, true, r)
        }
        case 'search-destinations': {
          const query = String(payload.query || '').trim()
          const ids = query
            ? ((await client.invoke({ _: 'searchChats', query, limit: 50 }).catch(() => ({ chat_ids: [] }))).chat_ids || [])
            : ((await client.invoke({ _: 'getChats', chat_list: { _: 'chatListMain' }, offset_order: '9223372036854775807', offset_chat_id: 0, limit: 50 })).chat_ids || [])
          const chats = []
          for (const chatId of ids) {
            if (payload.excludeChatId != null && String(chatId) === String(payload.excludeChatId)) continue
            const chat = await client.invoke({ _: 'getChat', chat_id: chatId }).catch(() => null)
            if (!chat || (chat.type && chat.type._ === 'chatTypeSecret')) continue
            chats.push(await serializeChatDetailed(chat))
          }
          return respond(ws, id, true, { chats })
        }
        case 'forward-messages': {
          const result = await forwardMessagesNative(payload.sourceChatId, payload.messageIds, payload.destination || {})
          return respond(ws, id, true, {
            destination: result.destination,
            forwarded: result.forwarded,
            skipped: result.skipped,
            destinationMessageIds: result.messages.map(m => m && m.id).filter(Boolean)
          })
        }

        case 'get-message-actions':
          return respond(ws, id, true, await getManagedMessageActions(payload.chatId, payload.messageId))
        case 'send-chat-message':
          return respond(ws, id, true, await sendManagedTextMessage(payload.chatId, payload.text, payload.replyToMessageId))
        case 'edit-chat-message':
          return respond(ws, id, true, await editManagedTextMessage(payload.chatId, payload.messageId, payload.text))
        case 'delete-chat-message':
          return respond(ws, id, true, await deleteManagedMessage(payload.chatId, payload.messageId, payload.revoke))
        case 'get-chat-management':
          return respond(ws, id, true, await getManagedChatInfo(payload.chatId))
        case 'create-managed-chat':
          return respond(ws, id, true, await createManagedChat(payload || {}))
        case 'update-managed-chat':
          return respond(ws, id, true, await updateManagedChat(payload || {}))
        case 'get-managed-members':
          return respond(ws, id, true, await managedMembers(payload.chatId, payload.limit))
        case 'add-managed-member':
          return respond(ws, id, true, await addManagedMember(payload.chatId, payload.username))
        case 'remove-managed-member':
          return respond(ws, id, true, await removeManagedMember(payload.chatId, payload.userId))
        case 'replace-managed-invite': {
          const info = await getManagedChatInfo(payload.chatId)
          if (!info.permissions.canInviteUsers) throw new Error('You do not have permission to manage invite links')
          const link = await client.invoke({ _: 'replacePrimaryChatInviteLink', chat_id: payload.chatId })
          if (info.internal.supergroupId) managedSupergroupFullInfoCache.delete(String(info.internal.supergroupId))
          if (info.internal.basicGroupId) managedBasicGroupFullInfoCache.delete(String(info.internal.basicGroupId))
          emitManagementRefresh(payload.chatId)
          return respond(ws, id, true, { inviteLink: link && link.invite_link })
        }
        case 'remove-managed-photo': {
          const info = await getManagedChatInfo(payload.chatId)
          if (!info.permissions.canSetPhoto) throw new Error('You do not have permission to change this chat photo')
          await client.invoke({ _: 'setChatPhoto', chat_id: payload.chatId, photo: null })
          const fresh = await client.invoke({ _: 'getChat', chat_id: payload.chatId })
          sendAll({ type: 'event', event: { name: 'chat-upsert', chat: await serializeChatDetailed(fresh) } })
          return respond(ws, id, true, { ok: true })
        }
        case 'clear-managed-history': {
          const info = await getManagedChatInfo(payload.chatId)
          let revoke = !!payload.revoke
          if (revoke && !info.permissions.canClearHistoryForAll && info.permissions.canClearHistoryForSelf) revoke = false
          if (!revoke && !info.permissions.canClearHistoryForSelf && info.permissions.canClearHistoryForAll) revoke = true
          if (revoke && !info.permissions.canClearHistoryForAll) throw new Error('Telegram does not allow deleting this history for everyone')
          if (!revoke && !info.permissions.canClearHistoryForSelf) throw new Error('Telegram does not allow deleting this history only for you')
          await client.invoke({ _: 'deleteChatHistory', chat_id: payload.chatId, remove_from_chat_list: false, revoke })
          mediaIndexCache.delete(String(payload.chatId))
          sendAll({ type: 'event', event: { name: 'history-cleared', chatId: payload.chatId, revoke } })
          return respond(ws, id, true, { ok: true, revoke })
        }
        case 'leave-managed-chat': {
          const info = await getManagedChatInfo(payload.chatId)
          if (!info.permissions.canLeave) throw new Error('This chat cannot be left')
          await client.invoke({ _: 'leaveChat', chat_id: payload.chatId })
          sendAll({ type: 'event', event: { name: 'chat-remove', chatId: payload.chatId } })
          return respond(ws, id, true, { ok: true })
        }
        case 'delete-managed-chat': {
          const info = await getManagedChatInfo(payload.chatId)
          if (!info.permissions.canDeleteForAll) throw new Error('Telegram does not allow you to delete this chat for everyone')
          await client.invoke({ _: 'deleteChat', chat_id: payload.chatId })
          sendAll({ type: 'event', event: { name: 'chat-remove', chatId: payload.chatId } })
          return respond(ws, id, true, { ok: true })
        }
        case 'start-download': {
          const chat = await client.invoke({ _: 'getChat', chat_id: payload.chatId }).catch(() => ({ title: 'Chat' }))
          const chatTitle = chat.title || 'Chat'
          const jobIds = []
          for (const item of payload.items || []) {
            const jid = dm.add(payload.chatId, chatTitle, item.messageId, item.fileId, item.fileName, item.fileSize)
            jobIds.push(jid)
          }
          return respond(ws, id, true, { jobIds })
        }
        case 'download-all':
          scanChat(payload.chatId, { queue: true, mode: 'download' }).catch(e => {
            sendAll({ type: 'event', event: { name: 'download-all-error', error: String(e.message || e) } })
          })
          return respond(ws, id, true, { started: true })
        case 'scan-media-v3': {
          const result = await scanMediaIndexV3(payload.chatId, !!payload.force)
          return respond(ws, id, true, result)
        }
        case 'cancel-media-scan-v3':
          return respond(ws, id, true, { cancelled: cancelMediaIndexScanV3(payload.chatId) })
        /* The one truth request. Answers with the media message ids Telegram holds
         * for the chat, plus whether the chat was reachable and whether the walk
         * reached the end of history. The transport response stays `ok: true` even
         * for an inaccessible chat, because "this chat is not reachable" is an
         * answer, not a transport failure; the payload's own `accessible` and
         * `complete` flags are what a caller must gate pruning on. */
        case 'media-truth-v1': {
          if (payload.chatId == null) return respond(ws, id, false, null, 'chatId is required')
          return respond(ws, id, true, await mediaTruthV1(payload.chatId))
        }
        case 'scan-media': {
          if (scanState && scanState.active) {
            if (scanState.mode === 'count' && String(scanState.chatId) !== String(payload.chatId)) scanState.cancelled = true
            return respond(ws, id, true, { busy: true })
          }
          const r = await scanChat(payload.chatId, { queue: false, mode: 'count', returnItems: payload.includeItems })
          return respond(ws, id, true, { found: r.found, scanned: r.scanned, typeCounts: r.typeCounts, items: r.items })
        }
        case 'cancel-scan':
          if (scanState) scanState.cancelled = true
          return respond(ws, id, true, { ok: true })
        case 'set-concurrency':
          CONCURRENCY = Math.max(1, Math.min(64, Number(payload.value) || CONCURRENCY))
          dm.tryRun()
          return respond(ws, id, true, { concurrency: CONCURRENCY })
        case 'set-download-dir': {
          const dir = String(payload.dir || '').trim().replace(/^"|"$/g, '')
          if (!dir) return respond(ws, id, false, null, 'Path is required')
          const resolved = path.resolve(dir)
          fs.mkdirSync(resolved, { recursive: true })
          downloadsDir = resolved
          thumbsDir = path.join(downloadsDir, '.thumbs')
          fs.mkdirSync(thumbsDir, { recursive: true })
          saveSettings()
          sendAll({ type: 'event', event: { name: 'settings-changed', downloadsDir } })
          return respond(ws, id, true, { downloadsDir })
        }
        case 'pause-job':
          return respond(ws, id, true, { ok: dm.pause(payload.jobId) })
        case 'resume-job':
          return respond(ws, id, true, { ok: dm.resume(payload.jobId) })
        case 'pause-all':
          return respond(ws, id, true, { paused: dm.pauseAll(), stats: dm.stats() })
        case 'resume-all':
          return respond(ws, id, true, { resumed: dm.resumeAll(), stats: dm.stats() })
        case 'cancel-all':
          return respond(ws, id, true, { cancelled: dm.cancelAll(), stats: dm.stats() })
        case 'clear-done':
          return respond(ws, id, true, { removed: dm.clearDone(), stats: dm.stats() })
        case 'clear-all':
          return respond(ws, id, true, { ...dm.clearAll(), stats: dm.stats() })
        case 'cancel-download':
          return respond(ws, id, true, { ok: dm.cancel(payload.jobId) })
        case 'remove-download':
          return respond(ws, id, true, { ok: dm.remove(payload.jobId) })
        case 'get-downloads':
          return respond(ws, id, true, { jobs: dm.snapshot(), concurrency: CONCURRENCY, stats: dm.stats() })
        case 'get-thumb': {
          const p = await downloadThumb(payload.fileId)
          return respond(ws, id, true, { path: p && p.startsWith(downloadsDir) ? p.replace(downloadsDir, '').replace(/\\/g, '/') : null })
        }
        case 'pack-scan':
          return respond(ws, id, true, packMedia.scan(downloadsDir))
        case 'pack-run':
          if (!startPack()) return respond(ws, id, true, { busy: true })
          return respond(ws, id, true, { started: true })
        case 'pack-selected':
          return respond(ws, id, true, packSelected.preview(payload.items || []))
        case 'pack-selected':
          return respond(ws, id, true, packSelected.preview(payload.items || []))
        case 'pack-selected-run': {
          if (!startPackSelected(payload.items || [], String(payload.chatTitle || 'files'))) {
            return respond(ws, id, true, { busy: true })
          }
          return respond(ws, id, true, { started: true })
        }
        case 'cancel-pack':
          if (packState) packState.cancelled = true
          return respond(ws, id, true, { ok: true })
        default:
          return respond(ws, id, false, null, `Unknown type: ${type}`)
      }
    } catch (e) {
      respond(ws, id, false, null, String(e.message || e))
    }
  })
})

const config = loadConfig()
if (config) {
  initClient(config)
} else {
  console.log('No API credentials found. Open the web UI to enter api_id and api_hash.')
}

/* Fail with an explanation instead of an unhandled 'error' event.
 *
 * The common case is starting FileGram when it is already running, which used to
 * print a raw EADDRINUSE stack trace. The handler is attached to BOTH the http
 * server and the WebSocket server on purpose: ws forwards the underlying server's
 * 'listening', 'error' and 'upgrade' events onto itself, so handling it only on
 * `server` still leaves an unhandled 'error' on `wss` and node throws anyway. */
let listenFailureReported = false

function reportListenFailure (error) {
  if (listenFailureReported) return
  listenFailureReported = true
  if (error && error.code === 'EADDRINUSE') {
    console.error(`\nFileGram cannot start: port ${PORT} is already in use.`)
    console.error('It is most likely already running, in which case just open:')
    console.error(`  http://127.0.0.1:${PORT}`)
    console.error('\nTo find and stop whatever is holding the port:')
    console.error(`  Get-NetTCPConnection -LocalPort ${PORT} -State Listen | Select-Object OwningProcess`)
    console.error('  Stop-Process -Id <OwningProcess>')
    console.error(`\nOr start on a different port:  $env:PORT=3010; npm start\n`)
  } else {
    console.error('\nFileGram server error:', (error && error.message) || error, '\n')
  }
  process.exit(1)
}

server.on('error', reportListenFailure)
wss.on('error', reportListenFailure)

server.listen(PORT, '127.0.0.1', () => {
  console.log(`FileGram running at http://127.0.0.1:${PORT}`)
  console.log(`[FileGram server] pid=${process.pid} started=${PROCESS_STARTED_AT} buildId=${BUILD_ID} buildIdSource=${BUILD_ID_SOURCE} root=${ROOT} cwd=${process.cwd()}`)
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (client) await client.close().catch(() => {})
    process.exit(0)
  })
}
