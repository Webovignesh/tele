'use strict'

/* TDLib attachment compatibility shim.
 *
 * tdl normally converts `_` discriminator keys to TDLib JSON `@type` keys.
 * Attachment InputFile objects are normalized to explicit `@type` objects
 * before they enter tdl so nested local/prepared files cannot be lost while
 * older and newer TDLib schemas are mixed. Nullable media fields are also
 * represented explicitly.
 */

const fs = require('node:fs')
const path = require('node:path')
const tdl = require('tdl')

const originalCreateClient = tdl.createClient.bind(tdl)

function hasOwn (object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function tdType (value) {
  if (!value || typeof value !== 'object') return ''
  return String(value['@type'] || value._ || '')
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

  const next = { ...value, '@type': type }
  delete next._
  if (type === 'inputFileLocal') next.path = normalizeLocalPath(next.path, slashMode)
  return next
}

function nullable (content, key, value) {
  return hasOwn(content, key) ? value : null
}

function normalizeAttachmentContent (content, slashMode) {
  if (!content || typeof content !== 'object') return content
  const type = tdType(content)
  switch (type) {
    case 'inputMessageVideo':
      return {
        ...content,
        video: normalizeInputFileHolder(content.video, slashMode),
        thumbnail: nullable(content, 'thumbnail', content.thumbnail),
        cover: nullable(content, 'cover', normalizeInputFileHolder(content.cover, slashMode)),
        show_caption_above_media: !!content.show_caption_above_media,
        self_destruct_type: nullable(content, 'self_destruct_type', content.self_destruct_type),
        has_spoiler: !!content.has_spoiler
      }
    case 'inputMessagePhoto':
      return {
        ...content,
        photo: normalizeInputFileHolder(content.photo, slashMode),
        thumbnail: nullable(content, 'thumbnail', content.thumbnail),
        show_caption_above_media: !!content.show_caption_above_media,
        self_destruct_type: nullable(content, 'self_destruct_type', content.self_destruct_type),
        has_spoiler: !!content.has_spoiler
      }
    case 'inputMessageAudio':
      return {
        ...content,
        audio: normalizeInputFileHolder(content.audio, slashMode),
        album_cover_thumbnail: nullable(content, 'album_cover_thumbnail', content.album_cover_thumbnail)
      }
    case 'inputMessageDocument':
      return {
        ...content,
        document: normalizeInputFileHolder(content.document, slashMode),
        thumbnail: nullable(content, 'thumbnail', content.thumbnail)
      }
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
      if (!inputFileError(error) || process.platform !== 'win32') throw error
      /* Retry only the primary file path in forward-slash form on Windows.
       * Nested InputFile objects stay explicit TDLib JSON `@type` objects. */
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
