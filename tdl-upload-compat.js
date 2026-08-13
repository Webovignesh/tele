'use strict'

/* TDLib attachment compatibility shim.
 *
 * tdl recursively renames `_` discriminators to TDLib JSON `@type` before
 * sending a request. Keep attachment InputFile objects in that same `_` shape
 * and remove nullable optional upload fields when they are unused. Passing
 * fields like thumbnail/cover as explicit null can make TDLib try to register
 * a missing InputFile and return the misleading error "InputFile is not
 * specified" even though the primary local file is present.
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

function stripNullableInputFiles (content, keys) {
  const next = { ...content }
  for (const key of keys) {
    if (next[key] == null) delete next[key]
    else next[key] = normalizeInputFileHolder(next[key], false)
  }
  if (next.self_destruct_type == null) delete next.self_destruct_type
  if (next.album_cover_thumbnail == null) delete next.album_cover_thumbnail
  delete next['@type']
  return next
}

function normalizeAttachmentContent (content, slashMode) {
  if (!content || typeof content !== 'object') return content
  const type = tdType(content)
  switch (type) {
    case 'inputMessageVideo':
      return stripNullableInputFiles({
        ...content,
        _: type,
        video: normalizeInputFileHolder(content.video, slashMode),
        show_caption_above_media: !!content.show_caption_above_media,
        has_spoiler: !!content.has_spoiler
      }, ['thumbnail', 'cover'])
    case 'inputMessagePhoto':
      return stripNullableInputFiles({
        ...content,
        _: type,
        photo: normalizeInputFileHolder(content.photo, slashMode),
        show_caption_above_media: !!content.show_caption_above_media,
        has_spoiler: !!content.has_spoiler
      }, ['thumbnail'])
    case 'inputMessageAudio':
      return stripNullableInputFiles({
        ...content,
        _: type,
        audio: normalizeInputFileHolder(content.audio, slashMode)
      }, ['album_cover_thumbnail'])
    case 'inputMessageDocument':
      return stripNullableInputFiles({
        ...content,
        _: type,
        document: normalizeInputFileHolder(content.document, slashMode)
      }, ['thumbnail'])
    default:
      return content
  }
}

function isAttachmentQuery (query) {
  if (!query || typeof query !== 'object') return false
  const type = tdType(query)
  if (type === 'preliminaryUploadFile') return true
  if (type !== 'sendMessage') return false
  const contentType = tdType(query.input_message_content)
  return ['inputMessageVideo', 'inputMessagePhoto', 'inputMessageAudio', 'inputMessageDocument'].includes(contentType)
}

function normalizeAttachmentQuery (query, slashMode) {
  if (!isAttachmentQuery(query)) return query
  if (tdType(query) === 'preliminaryUploadFile') {
    return { ...query, file: normalizeInputFileHolder(query.file, slashMode) }
  }
  return {
    ...query,
    input_message_content: normalizeAttachmentContent(query.input_message_content, slashMode)
  }
}

function primaryInputFile (query) {
  if (tdType(query) === 'preliminaryUploadFile') return query.file
  const content = query && query.input_message_content
  switch (tdType(content)) {
    case 'inputMessageVideo': return content.video
    case 'inputMessagePhoto': return content.photo
    case 'inputMessageAudio': return content.audio
    case 'inputMessageDocument': return content.document
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

function documentFallbackQuery (query, slashMode) {
  if (!query || tdType(query) !== 'sendMessage') return null
  const content = normalizeAttachmentContent(query.input_message_content, slashMode)
  const contentType = tdType(content)
  if (contentType === 'inputMessageDocument') return null
  if (!['inputMessagePhoto', 'inputMessageVideo', 'inputMessageAudio'].includes(contentType)) return null
  if (content.self_destruct_type) return null

  const file = primaryInputFile({ ...query, input_message_content: content })
  if (!file) return null
  return validateAttachmentQuery({
    ...query,
    input_message_content: {
      _: 'inputMessageDocument',
      document: normalizeInputFileHolder(file, slashMode),
      disable_content_type_detection: false,
      caption: content.caption || { _: 'formattedText', text: '', entities: [] }
    }
  })
}

function inputFileError (error) {
  return /input\s*file|inputfile/i.test(String(error && error.message ? error.message : error))
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
      if (!inputFileError(error)) throw error

      if (process.platform === 'win32') {
        try {
          return await originalInvoke(validateAttachmentQuery(normalizeAttachmentQuery(query, true)))
        } catch (slashError) {
          if (!inputFileError(slashError)) throw slashError
        }
      }

      const fallback = documentFallbackQuery(query, process.platform === 'win32')
      if (!fallback) throw error
      return originalInvoke(fallback)
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
  documentFallbackQuery,
  isAttachmentQuery
}
