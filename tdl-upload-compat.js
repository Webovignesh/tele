'use strict'

/* TDLib upload compatibility shim.
 *
 * The installed TDLib schema contains nullable upload/file fields on media
 * content (notably inputMessageVideo.cover). They need to be represented as
 * explicit null values when unused. Omitting one can surface as the misleading
 * "InputFile is not specified" error even when the primary video/document file
 * is present.
 *
 * This preloader wraps attachment-related invokes only. All other TDLib calls
 * pass through unchanged.
 */

const fs = require('node:fs')
const path = require('node:path')
const tdl = require('tdl')

const originalCreateClient = tdl.createClient.bind(tdl)

function hasOwn (object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function normalizeLocalInputFile (file, slashMode) {
  if (!file || typeof file !== 'object' || file._ !== 'inputFileLocal') return file
  let filePath = String(file.path || '')
  if (filePath) {
    try {
      const realpath = fs.realpathSync.native || fs.realpathSync
      filePath = realpath(filePath)
    } catch {
      filePath = path.resolve(filePath)
    }
    if (slashMode && process.platform === 'win32') filePath = filePath.replace(/\\/g, '/')
  }
  return { ...file, path: filePath }
}

function normalizeInputFileHolder (value, slashMode) {
  if (!value || typeof value !== 'object') return value
  if (value._ === 'inputFileLocal') return normalizeLocalInputFile(value, slashMode)
  return value
}

function nullable (content, key, value) {
  return hasOwn(content, key) ? value : null
}

function normalizeAttachmentContent (content, slashMode) {
  if (!content || typeof content !== 'object') return content
  switch (content._) {
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
  if (query._ === 'preliminaryUploadFile') return true
  if (query._ !== 'sendMessage') return false
  const type = query.input_message_content && query.input_message_content._
  return ['inputMessageVideo', 'inputMessagePhoto', 'inputMessageAudio', 'inputMessageDocument'].includes(type)
}

function normalizeAttachmentQuery (query, slashMode) {
  if (!isAttachmentQuery(query)) return query
  if (query._ === 'preliminaryUploadFile') {
    return { ...query, file: normalizeInputFileHolder(query.file, slashMode) }
  }
  return {
    ...query,
    input_message_content: normalizeAttachmentContent(query.input_message_content, slashMode)
  }
}

function inputFileError (error) {
  return /input\s*file|inputfile/i.test(String(error && error.message ? error.message : error))
}

tdl.createClient = function createCompatibleClient (options) {
  const client = originalCreateClient(options)
  const originalInvoke = client.invoke.bind(client)

  client.invoke = async function compatibleInvoke (query) {
    if (!isAttachmentQuery(query)) return originalInvoke(query)

    const normalized = normalizeAttachmentQuery(query, false)
    try {
      return await originalInvoke(normalized)
    } catch (error) {
      if (!inputFileError(error) || process.platform !== 'win32') throw error
      /* Retry a local Windows InputFile with a canonical forward-slash path.
       * inputFileId fallbacks are unchanged by this retry. */
      return originalInvoke(normalizeAttachmentQuery(query, true))
    }
  }

  return client
}

module.exports = {
  normalizeAttachmentQuery,
  normalizeAttachmentContent,
  normalizeLocalInputFile,
  isAttachmentQuery
}
