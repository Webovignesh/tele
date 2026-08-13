'use strict'

/* TDLib attachment compatibility shim.
 *
 * Current TDLib no longer puts InputFile directly on inputMessagePhoto,
 * inputMessageVideo, inputMessageAudio, or inputMessageDocument. Those message
 * types now contain inputPhoto/inputVideo/inputAudio/inputDocument wrappers.
 * The application still builds the older flat shape, which makes TDLib parse
 * the outer object but see a null InputFile and return "InputFile is not
 * specified". Normalize that legacy shape at the tdl boundary.
 */

const fs = require('node:fs')
const path = require('node:path')
const tdl = require('tdl')

const originalCreateClient = tdl.createClient.bind(tdl)

function tdType (value) {
  if (!value || typeof value !== 'object') return ''
  return String(value._ || value['@type'] || '')
}

function normalizeLocalPath (filePath, slashMode) {
  let next = String(filePath || '')
  if (!next) return next
  try {
    const realpath = fs.realpathSync.native || fs.realpathSync
    next = realpath(next)
  } catch {
    next = path.resolve(next)
  }
  if (slashMode && process.platform === 'win32') next = next.replace(/\\/g, '/')
  return next
}

function normalizeInputFileHolder (value, slashMode) {
  if (!value || typeof value !== 'object') return value
  const type = tdType(value)
  if (!/^inputFile(?:Local|Id|Remote|Generated)$/.test(type)) return value
  const next = { ...value, _: type }
  delete next['@type']
  if (type === 'inputFileLocal') next.path = normalizeLocalPath(next.path, slashMode)
  return next
}

function emptyCaption (caption) {
  return caption || { _: 'formattedText', text: '', entities: [] }
}

function normalizeAttachmentContent (content, slashMode) {
  if (!content || typeof content !== 'object') return content
  const type = tdType(content)

  if (type === 'inputMessagePhoto') {
    const existing = tdType(content.photo) === 'inputPhoto' ? content.photo : null
    const sourceFile = existing ? existing.photo : content.photo
    const photo = {
      _: 'inputPhoto',
      photo: normalizeInputFileHolder(sourceFile, slashMode),
      thumbnail: existing ? (existing.thumbnail == null ? null : existing.thumbnail) : (content.thumbnail == null ? null : content.thumbnail),
      video: existing ? (existing.video == null ? null : normalizeInputFileHolder(existing.video, slashMode)) : null,
      added_sticker_file_ids: existing ? (existing.added_sticker_file_ids || []) : (content.added_sticker_file_ids || []),
      width: existing ? Number(existing.width || 0) : Number(content.width || 0),
      height: existing ? Number(existing.height || 0) : Number(content.height || 0)
    }
    return {
      _: 'inputMessagePhoto',
      photo,
      caption: emptyCaption(content.caption),
      show_caption_above_media: !!content.show_caption_above_media,
      self_destruct_type: content.self_destruct_type == null ? null : content.self_destruct_type,
      has_spoiler: !!content.has_spoiler
    }
  }

  if (type === 'inputMessageVideo') {
    const existing = tdType(content.video) === 'inputVideo' ? content.video : null
    const sourceFile = existing ? existing.video : content.video
    const video = {
      _: 'inputVideo',
      video: normalizeInputFileHolder(sourceFile, slashMode),
      thumbnail: existing ? (existing.thumbnail == null ? null : existing.thumbnail) : (content.thumbnail == null ? null : content.thumbnail),
      cover: existing ? (existing.cover == null ? null : normalizeInputFileHolder(existing.cover, slashMode)) : (content.cover == null ? null : normalizeInputFileHolder(content.cover, slashMode)),
      start_timestamp: existing ? Number(existing.start_timestamp || 0) : Number(content.start_timestamp || 0),
      added_sticker_file_ids: existing ? (existing.added_sticker_file_ids || []) : (content.added_sticker_file_ids || []),
      duration: existing ? Number(existing.duration || 0) : Number(content.duration || 0),
      width: existing ? Number(existing.width || 0) : Number(content.width || 0),
      height: existing ? Number(existing.height || 0) : Number(content.height || 0),
      supports_streaming: existing ? !!existing.supports_streaming : !!content.supports_streaming
    }
    return {
      _: 'inputMessageVideo',
      video,
      caption: emptyCaption(content.caption),
      show_caption_above_media: !!content.show_caption_above_media,
      self_destruct_type: content.self_destruct_type == null ? null : content.self_destruct_type,
      has_spoiler: !!content.has_spoiler
    }
  }

  if (type === 'inputMessageAudio') {
    const existing = tdType(content.audio) === 'inputAudio' ? content.audio : null
    const sourceFile = existing ? existing.audio : content.audio
    return {
      _: 'inputMessageAudio',
      audio: {
        _: 'inputAudio',
        audio: normalizeInputFileHolder(sourceFile, slashMode),
        album_cover_thumbnail: existing ? (existing.album_cover_thumbnail == null ? null : existing.album_cover_thumbnail) : (content.album_cover_thumbnail == null ? null : content.album_cover_thumbnail),
        duration: existing ? Number(existing.duration || 0) : Number(content.duration || 0),
        title: existing ? String(existing.title || '') : String(content.title || ''),
        performer: existing ? String(existing.performer || '') : String(content.performer || '')
      },
      caption: emptyCaption(content.caption)
    }
  }

  if (type === 'inputMessageDocument') {
    const existing = tdType(content.document) === 'inputDocument' ? content.document : null
    const sourceFile = existing ? existing.document : content.document
    return {
      _: 'inputMessageDocument',
      document: {
        _: 'inputDocument',
        document: normalizeInputFileHolder(sourceFile, slashMode),
        thumbnail: existing ? (existing.thumbnail == null ? null : existing.thumbnail) : (content.thumbnail == null ? null : content.thumbnail),
        disable_content_type_detection: existing ? !!existing.disable_content_type_detection : !!content.disable_content_type_detection
      },
      caption: emptyCaption(content.caption)
    }
  }

  return content
}

function isAttachmentQuery (query) {
  if (!query || typeof query !== 'object') return false
  const type = tdType(query)
  if (type === 'preliminaryUploadFile') return true
  if (type !== 'sendMessage') return false
  return ['inputMessageVideo', 'inputMessagePhoto', 'inputMessageAudio', 'inputMessageDocument'].includes(tdType(query.input_message_content))
}

function normalizeAttachmentQuery (query, slashMode) {
  if (!isAttachmentQuery(query)) return query
  if (tdType(query) === 'preliminaryUploadFile') {
    return { ...query, file: normalizeInputFileHolder(query.file, slashMode) }
  }
  return { ...query, input_message_content: normalizeAttachmentContent(query.input_message_content, slashMode) }
}

function primaryInputFile (query) {
  if (tdType(query) === 'preliminaryUploadFile') return query.file
  const content = query && query.input_message_content
  switch (tdType(content)) {
    case 'inputMessagePhoto': return content.photo && (tdType(content.photo) === 'inputPhoto' ? content.photo.photo : content.photo)
    case 'inputMessageVideo': return content.video && (tdType(content.video) === 'inputVideo' ? content.video.video : content.video)
    case 'inputMessageAudio': return content.audio && (tdType(content.audio) === 'inputAudio' ? content.audio.audio : content.audio)
    case 'inputMessageDocument': return content.document && (tdType(content.document) === 'inputDocument' ? content.document.document : content.document)
    default: return null
  }
}

function validateAttachmentQuery (query) {
  const file = primaryInputFile(query)
  const type = tdType(file)
  if (!file || !/^inputFile(?:Local|Id|Remote|Generated)$/.test(type)) {
    throw new Error('Tele attachment pipeline lost the TDLib InputFile before invoke')
  }
  if (type === 'inputFileLocal' && !String(file.path || '').trim()) {
    throw new Error('Tele attachment pipeline received an empty local file path')
  }
  return query
}

function inputFileError (error) {
  return /input\s*file|inputfile|local file|file is not specified/i.test(String(error && error.message ? error.message : error))
}

tdl.createClient = function createCompatibleClient (options) {
  const client = originalCreateClient(options)
  const originalInvoke = client.invoke.bind(client)

  client.invoke = async function compatibleInvoke (query) {
    if (!isAttachmentQuery(query)) return originalInvoke(query)
    const normalized = validateAttachmentQuery(normalizeAttachmentQuery(query, false))
    try {
      return await originalInvoke(normalized)
    } catch (error) {
      if (!inputFileError(error) || process.platform !== 'win32') throw error
      return originalInvoke(validateAttachmentQuery(normalizeAttachmentQuery(query, true)))
    }
  }

  return client
}

module.exports = {
  normalizeAttachmentQuery,
  normalizeAttachmentContent,
  normalizeInputFileHolder,
  normalizeLocalPath,
  validateAttachmentQuery,
  isAttachmentQuery
}
