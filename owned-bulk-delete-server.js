'use strict'

const MAX_DELETE_IDS = 50000
const DELETE_BATCH_SIZE = 100
const OWNERSHIP_RECHECK_BATCHES = 25

function statusError (message, status) {
  const error = new Error(message)
  error.status = status
  return error
}

function floodWaitSeconds (error) {
  const text = String(error && error.message ? error.message : error || '')
  const match = /FLOOD_WAIT[_ ]?(\d+)/i.exec(text) || /retry after\s+(\d+)/i.exec(text)
  return match ? Math.max(1, Number(match[1]) || 1) : 0
}

function statusForError (error) {
  if (error && error.status) return Number(error.status)
  const text = String(error && error.message ? error.message : error || '')
  if (/not ready|authorization|not logged/i.test(text)) return 503
  if (/owner|creator|forbidden|not allowed|CHAT_ADMIN_REQUIRED|CHAT_WRITE_FORBIDDEN/i.test(text)) return 403
  if (floodWaitSeconds(error)) return 429
  if (/invalid|message id|chat id|too many/i.test(text)) return 400
  return 502
}

function normalizeMessageIds (values) {
  if (!Array.isArray(values)) throw statusError('messageIds must be an array', 400)
  if (values.length > MAX_DELETE_IDS) throw statusError(`A bulk delete is limited to ${MAX_DELETE_IDS.toLocaleString()} messages`, 413)
  const seen = new Set()
  const ids = []
  for (const raw of values) {
    const value = typeof raw === 'number' ? raw : Number(String(raw == null ? '' : raw).trim())
    if (!Number.isSafeInteger(value) || value === 0) throw statusError('Invalid message id in bulk delete request', 400)
    const key = String(value)
    if (seen.has(key)) continue
    seen.add(key)
    ids.push(value)
  }
  if (!ids.length) throw statusError('Choose at least one message to delete', 400)
  return ids
}

async function ensureReadyOwnedChat (client, chatId) {
  if (!client) throw statusError('Telegram session is not ready', 503)
  const auth = await client.invoke({ _: 'getAuthorizationState' }).catch(() => null)
  if (!auth || auth._ !== 'authorizationStateReady') throw statusError('Telegram session is not ready', 503)

  const chat = await client.invoke({ _: 'getChat', chat_id: chatId })
  const type = chat && chat.type
  if (!type) throw statusError('Invalid Telegram chat', 400)

  let owner = false
  let kind = ''
  if (type._ === 'chatTypeSupergroup') {
    const group = await client.invoke({ _: 'getSupergroup', supergroup_id: type.supergroup_id })
    owner = !!(group && group.status && group.status._ === 'chatMemberStatusCreator')
    const isChannel = type.is_channel === true || group && group.is_channel === true
    kind = isChannel ? 'channel' : 'supergroup'
  } else if (type._ === 'chatTypeBasicGroup') {
    const group = await client.invoke({ _: 'getBasicGroup', basic_group_id: type.basic_group_id })
    owner = !!(group && group.status && group.status._ === 'chatMemberStatusCreator')
    kind = 'group'
  } else {
    throw statusError('Bulk delete is available only for channels and groups you own', 403)
  }

  if (!owner) throw statusError('Bulk delete is limited to channels and groups owned by this Telegram account', 403)
  return { chat, kind }
}

async function deleteOwnedMessages (options) {
  const client = options && options.client
  const chatId = Number(options && options.chatId)
  if (!Number.isSafeInteger(chatId) || chatId === 0) throw statusError('Invalid chat id', 400)
  const messageIds = normalizeMessageIds(options && options.messageIds)
  const batchSize = Math.max(1, Math.min(DELETE_BATCH_SIZE, Number(options && options.batchSize || DELETE_BATCH_SIZE)))

  let ownership = await ensureReadyOwnedChat(client, chatId)
  let deleted = 0
  for (let offset = 0, batchIndex = 0; offset < messageIds.length; offset += batchSize, batchIndex++) {
    if (batchIndex && batchIndex % OWNERSHIP_RECHECK_BATCHES === 0) ownership = await ensureReadyOwnedChat(client, chatId)
    const batch = messageIds.slice(offset, offset + batchSize)
    await client.invoke({ _: 'deleteMessages', chat_id: chatId, message_ids: batch, revoke: true })
    deleted += batch.length
    if (typeof options.onBatch === 'function') await options.onBatch({ deleted, total: messageIds.length, batch, batchIndex, ownership })
  }

  return {
    ok: true,
    chatId,
    kind: ownership.kind,
    deleted,
    messageIds
  }
}

function createOwnedBulkDeleteHandler (options) {
  const getClient = options && options.getClient
  if (typeof getClient !== 'function') throw new Error('getClient is required')

  return async function ownedBulkDeleteHandler (req, res) {
    try {
      const chatId = Number(req.params && req.params.chatId)
      const result = await deleteOwnedMessages({
        client: getClient(),
        chatId,
        messageIds: req.body && req.body.messageIds
      })
      res.json(result)
    } catch (error) {
      if (res.writableEnded || res.destroyed) return
      const status = statusForError(error)
      const retry = floodWaitSeconds(error)
      if (retry) res.setHeader('Retry-After', String(retry))
      res.status(status).json({ ok: false, error: String(error && error.message ? error.message : error) })
    }
  }
}

module.exports = {
  MAX_DELETE_IDS,
  DELETE_BATCH_SIZE,
  normalizeMessageIds,
  ensureReadyOwnedChat,
  deleteOwnedMessages,
  createOwnedBulkDeleteHandler
}
