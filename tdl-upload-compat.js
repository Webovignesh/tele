'use strict'

/* TDLib upload compatibility shim.
 *
 * Recent TDLib schemas have nullable upload fields (for example video.cover,
 * video.thumbnail and document.thumbnail) which should be passed explicitly as
 * null when unused. The application historically omitted them. On Windows that
 * can surface as the misleading TDLib error "InputFile is not specified" even
 * though the primary video/document InputFile is present.
 *
 * This preloader wraps only attachment-related invoke calls. Everything else is
 * passed to tdl unchanged.
 */

const fs = require('node:fs')
const path = require('node:path')
const tdl = require('tdl')

const originalCreateClient = tdl.createClient.bind(tdl)

function hasOwn (object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function normalizeLocalInputFile (file, slashMode) {
  if (!file || typeof file !== 'object') return file
  if (file._ !== 'inputFileLocal') return file
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

function normalizeAttachmentContent (content, slashMode) {
  if (!content || typeof content !== 'object') return content
  switch (content._) {
    case 'inputMessageVideo': {
      const next = {
        ...content,
        video: normalizeInputFileHolder(content.video, slashMode),
        thumbnail: hasOwn(content, 'thumbnail') ? content.thumbnail : null,
        cover: hasOwn(content, 'cover') ? normalizeInputFileHolder(content.cover, slashMode) : null,
        self_destruct_type: hasOwn(content, 'self_destruct_type') ? content.self_destruct_type : null
      }
      return next
    }
    case 'inputMessagePhoto':
      return {
        ...content,
        photo: normalizeInputFileHolder(content.photo, slashMode),
        thumbnail: hasOwn(content, 'thumbnail') ? content.thumbnail : null,
        self_destruct_type: hasOwn(content, 'self_destruct_type') ? content.self_destruct_type : null
      }
    case 'inputMessageAudio':
      return {
        ...content,
        audio: normalizeInputFileHolder(content.audio, slashMode),
        album_cover_thumbnail: hasOwn(content, 'album_cover_thumbnail') ? content.album_cover_thumbnail : null
      }
    case 'inputMessageDocument':
      return {
        ...content,
        document: normalizeInputFileHolder(content.document, slashMode),
        thumbnail: hasOwn(content, 'thumbnail') ? content.thumbnail : null
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
      /* A second attempt uses a canonical real path with forward slashes. This
       * is harmless on Windows and avoids path parsing edge cases in tdjson. */
      return originalInvoke(normalizeAttachmentQuery(query, true))
    }
  }

  return client
}
