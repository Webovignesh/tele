'use strict'

const path = require('node:path')
const fs = require('node:fs')
const archiver = require('archiver')

const CHUNK_SIZE = 100

const MEDIA_EXT = new Set([
  '.mp4', '.mkv', '.mov', '.avi', '.webm', '.m4v', '.ts', '.flv', '.wmv', '.3gp',
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp',
  '.mp3', '.ogg', '.oga', '.wav', '.flac', '.m4a', '.aac', '.opus',
  '.pdf', '.epub'
])

const SKIP_DIRS = new Set(['.thumbs', '_zips', '.td_files', '.td_database'])

function normalizeName (name) {
  const ext = path.extname(name)
  const base = path.basename(name, ext)
  return base.replace(/\s*\(\d+\)\s*$/g, '') + ext
}

function suffixNum (name) {
  const ext = path.extname(name)
  const m = path.basename(name, ext).match(/\s*\((\d+)\)\s*$/)
  return m ? Number(m[1]) : 0
}

function walk (dir) {
  const out = []
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      out.push(...walk(abs))
    } else {
      if (!MEDIA_EXT.has(path.extname(e.name).toLowerCase())) continue
      let st
      try { st = fs.statSync(abs) } catch { continue }
      out.push({ abs, dir, name: e.name, size: st.size })
    }
  }
  return out
}

function dedupe (files) {
  const groups = new Map()
  for (const f of files) {
    const key = `${f.dir}\u0000${normalizeName(f.name)}\u0000${f.size}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(f)
  }
  const keep = []
  const remove = []
  for (const group of groups.values()) {
    group.sort((a, b) => suffixNum(a.name) - suffixNum(b.name))
    keep.push(group[0])
    for (const f of group.slice(1)) remove.push(f)
  }
  return { keep, remove }
}

function groupByFolder (files, downloadsDir) {
  const map = new Map()
  for (const f of files) {
    const rel = path.relative(downloadsDir, f.dir)
    if (!map.has(rel)) map.set(rel, [])
    map.get(rel).push(f)
  }
  return map
}

function scan (downloadsDir) {
  const files = walk(downloadsDir)
  const { keep, remove } = dedupe(files)
  const byFolder = groupByFolder(keep, downloadsDir)
  const removedByFolder = groupByFolder(remove, downloadsDir)

  const folders = []
  let zipCount = 0
  for (const [rel, list] of byFolder) {
    list.sort((a, b) => a.name.localeCompare(b.name))
    const chunks = Math.ceil(list.length / CHUNK_SIZE)
    zipCount += chunks
    folders.push({
      rel,
      label: rel || '(root)',
      files: list.length,
      duplicates: (removedByFolder.get(rel) || []).length,
      chunks
    })
  }

  return {
    totalFiles: files.length,
    duplicatesToRemove: remove.length,
    uniqueFiles: keep.length,
    zipCount,
    totalBytes: keep.reduce((s, f) => s + f.size, 0),
    folders
  }
}

function zipChunk (chunk, zipPath, baseRel) {
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
    for (const f of chunk) {
      const name = baseRel ? path.relative(baseRel, f.abs) : path.basename(f.abs)
      archive.file(f.abs, { name: name.replace(/\\/g, '/') })
    }
    archive.finalize()
  })
}

async function run (downloadsDir, onProgress, isCancelled) {
  const files = walk(downloadsDir)
  const { keep, remove } = dedupe(files)

  const zipsDir = path.join(downloadsDir, '_zips')
  fs.mkdirSync(zipsDir, { recursive: true })

  let removed = 0
  for (const f of remove) {
    if (isCancelled()) return { cancelled: true, zips: [], removed }
    try { fs.unlinkSync(f.abs); removed++ } catch {}
    onProgress && onProgress({ phase: 'dedup', removed, totalRemove: remove.length, kept: keep.length })
  }

  const byFolder = groupByFolder(keep, downloadsDir)
  const zips = []
  let processed = 0
  const total = keep.length

  for (const [rel, list] of byFolder) {
    if (isCancelled()) return { cancelled: true, zips, removed }
    list.sort((a, b) => a.name.localeCompare(b.name))
    const destDir = rel ? path.join(zipsDir, rel) : zipsDir
    fs.mkdirSync(destDir, { recursive: true })
    const label = sanitize(rel.split(path.sep).pop() || 'root')

    for (let i = 0; i < list.length; i += CHUNK_SIZE) {
      if (isCancelled()) return { cancelled: true, zips, removed }
      const chunk = list.slice(i, i + CHUNK_SIZE)
      const idx = i / CHUNK_SIZE + 1
      const zipPath = path.join(destDir, `${label}_${String(idx).padStart(3, '0')}.zip`)
      const ok = await zipChunk(chunk, zipPath, rel)
      if (!ok) continue
      for (const f of chunk) { try { fs.unlinkSync(f.abs) } catch {} }
      processed += chunk.length
      let st
      try { st = fs.statSync(zipPath) } catch { st = { size: 0 } }
      zips.push({
        name: path.basename(zipPath),
        url: path.relative(downloadsDir, zipPath).replace(/\\/g, '/'),
        size: st.size,
        files: chunk.length
      })
      onProgress && onProgress({ phase: 'zip', processed, total, current: zips.length })
    }
  }

  return { cancelled: false, zips, removed }
}

function sanitize (name) {
  return String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\.+$/g, '')
    .trim()
    .slice(0, 80) || 'files'
}

module.exports = { scan, run }
