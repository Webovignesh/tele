'use strict'

const path = require('node:path')
const fs = require('node:fs')
const archiver = require('archiver')

const CHUNK_SIZE = 100

function sanitize (name) {
  return String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\.+$/g, '')
    .trim()
    .slice(0, 80) || 'files'
}

function dedupeItems (items) {
  const seen = new Map()
  const unique = []
  const remove = []
  for (const it of items) {
    const key = it.fileName
      ? `${it.fileSize || 0}\u0000${String(it.fileName)}`
      : `f:${it.fileId || ''}`
    if (seen.has(key)) { remove.push(it); continue }
    seen.set(key, true)
    unique.push(it)
  }
  return { unique, remove }
}

function preview (items) {
  const { unique, remove } = dedupeItems(items)
  return {
    totalFiles: items.length,
    duplicatesToRemove: remove.length,
    uniqueFiles: unique.length,
    zipCount: Math.max(0, Math.ceil(unique.length / CHUNK_SIZE)),
    totalBytes: unique.reduce((s, i) => s + (i.fileSize || 0), 0)
  }
}

function downloadFile (client, fileId, onProgress, isCancelled) {
  return new Promise((resolve, reject) => {
    if (isCancelled()) return reject(new Error('Cancelled'))
    let settled = false
    const timer = setTimeout(() => { if (!settled) { settled = true; client.off('update', onUpdate); reject(new Error(`Download timed out: ${fileId}`)) } }, 60 * 60 * 1000)
    const onUpdate = (u) => {
      if (u._ !== 'updateFile' || u.file.id !== fileId) return
      const local = u.file.local || {}
      if (local.is_downloading_completed && local.path) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        client.off('update', onUpdate)
        resolve(local.path)
      } else if (local.is_downloading_active && onProgress) {
        onProgress(local.downloaded_size || 0, u.file.size || 0)
      }
    }
    client.on('update', onUpdate)
    client.invoke({ _: 'downloadFile', file_id: fileId, priority: 32, offset: 0, limit: 0, synchronous: false })
      .then(res => {
        const local = res && res.local
        if (local && local.is_downloading_completed && local.path) {
          if (settled) return
          settled = true
          clearTimeout(timer)
          client.off('update', onUpdate)
          resolve(local.path)
        }
      })
      .catch(err => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        client.off('update', onUpdate)
        reject(err)
      })
  })
}

function zipChunk (files, zipPath) {
  return new Promise((resolve) => {
    const output = fs.createWriteStream(zipPath)
    const archive = new archiver.ZipArchive({ zlib: { level: 6 } })
    const fail = () => {
      try { fs.unlinkSync(zipPath) } catch {}
      resolve(false)
    }
    output.on('close', () => resolve(true))
    output.on('error', fail)
    archive.on('error', fail)
    archive.pipe(output)
    for (const f of files) {
      archive.file(f.abs, { name: f.name.replace(/\\/g, '/') })
    }
    archive.finalize()
  })
}

async function runPack ({ client, items, chatTitle, downloadsDir, onProgress, isCancelled }) {
  const { unique, remove } = dedupeItems(items)
  const zipsDir = path.join(downloadsDir, '_zips')
  fs.mkdirSync(zipsDir, { recursive: true })
  const chatLabel = sanitize(chatTitle)
  const destDir = path.join(zipsDir, chatLabel)
  fs.mkdirSync(destDir, { recursive: true })

  const failed = []
  const files = [] // { abs: td_files local path, name }
  let doneCount = 0
  let next = 0
  const concurrency = 5

  const worker = async () => {
    while (!isCancelled()) {
      const i = next++
      if (i >= unique.length) break
      const it = unique[i]
      try {
        const src = await downloadFile(client, it.fileId, () => {}, isCancelled)
        if (!src) throw new Error('No local path')
        const safeName = sanitize(it.fileName || `file_${it.messageId || i}`)
        files.push({ abs: src, name: safeName, size: it.fileSize || 0 })
      } catch (e) {
        if (isCancelled()) break
        failed.push({ name: it.fileName || `file_${it.messageId || i}`, error: String(e.message || e) })
      }
      doneCount++
      onProgress && onProgress({ phase: 'download', downloaded: doneCount, total: unique.length, failed: failed.length })
    }
  }

  onProgress && onProgress({ phase: 'download', downloaded: 0, total: unique.length, failed: 0 })
  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length || 1) }, () => worker()))

  if (isCancelled()) return { cancelled: true, zips: [], removed: remove.length, failed }

  const zips = []
  for (let i = 0; i < files.length; i += CHUNK_SIZE) {
    if (isCancelled()) return { cancelled: true, zips, removed: remove.length, failed }
    const chunk = files.slice(i, i + CHUNK_SIZE)
    const idx = i / CHUNK_SIZE + 1
    const zipPath = path.join(destDir, `${chatLabel}_${String(idx).padStart(3, '0')}.zip`)
    const ok = await zipChunk(chunk, zipPath)
    if (ok) {
      let st
      try { st = fs.statSync(zipPath) } catch { st = { size: 0 } }
      zips.push({
        name: path.basename(zipPath),
        url: path.relative(downloadsDir, zipPath).replace(/\\/g, '/'),
        size: st.size,
        files: chunk.length
      })
      onProgress && onProgress({ phase: 'zip', processed: Math.min(i + CHUNK_SIZE, files.length), total: files.length, current: zips.length })
    }
  }

  return { cancelled: false, zips, removed: remove.length, failed }
}

module.exports = { preview, runPack, dedupe: dedupeItems }
