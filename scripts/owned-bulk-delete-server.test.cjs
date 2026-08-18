'use strict'

const assert = require('node:assert/strict')
const {
  DELETE_BATCH_SIZE,
  normalizeMessageIds,
  ensureReadyOwnedChat,
  deleteOwnedMessages
} = require('../owned-bulk-delete-server')

function fakeClient ({ kind = 'channel', owner = true, ready = true } = {}) {
  const calls = []
  const status = { _: owner ? 'chatMemberStatusCreator' : 'chatMemberStatusAdministrator', rights: { can_delete_messages: true } }
  const chat = kind === 'private'
    ? { id: 777, type: { _: 'chatTypePrivate', user_id: 9 } }
    : kind === 'group'
      ? { id: 777, type: { _: 'chatTypeBasicGroup', basic_group_id: 22 } }
      : { id: 777, type: { _: 'chatTypeSupergroup', supergroup_id: 11, is_channel: kind === 'channel' } }

  return {
    calls,
    async invoke (request) {
      calls.push(request)
      if (request._ === 'getAuthorizationState') return { _: ready ? 'authorizationStateReady' : 'authorizationStateWaitPhoneNumber' }
      if (request._ === 'getChat') return chat
      if (request._ === 'getSupergroup') return { id: 11, is_channel: kind === 'channel', status }
      if (request._ === 'getBasicGroup') return { id: 22, status }
      if (request._ === 'deleteMessages') return { _: 'ok' }
      throw new Error(`Unexpected TDLib call ${request._}`)
    }
  }
}

async function run () {
  assert.deepEqual(normalizeMessageIds([1, '2', 1, 3]), [1, 2, 3], 'message ids should be normalized and deduplicated')
  assert.throws(() => normalizeMessageIds([]), /at least one message/i)
  assert.throws(() => normalizeMessageIds([0]), /invalid message id/i)

  const channel = fakeClient({ kind: 'channel', owner: true })
  const ids = Array.from({ length: DELETE_BATCH_SIZE * 2 + 5 }, (_, index) => index + 1)
  const deleted = await deleteOwnedMessages({ client: channel, chatId: 777, messageIds: [...ids, ids[0]] })
  assert.equal(deleted.deleted, ids.length)
  assert.equal(deleted.kind, 'channel')
  assert.deepEqual(deleted.messageIds, ids)
  const channelDeletes = channel.calls.filter(call => call._ === 'deleteMessages')
  assert.equal(channelDeletes.length, 3, 'large selections should be deleted in bounded TDLib batches')
  assert.deepEqual(channelDeletes.map(call => call.message_ids.length), [100, 100, 5])
  assert.ok(channelDeletes.every(call => call.revoke === true), 'owned bulk delete must always delete for everyone')

  const supergroup = fakeClient({ kind: 'supergroup', owner: true })
  const supergroupInfo = await ensureReadyOwnedChat(supergroup, 777)
  assert.equal(supergroupInfo.kind, 'supergroup', 'owned supergroups should be eligible')

  const basicGroup = fakeClient({ kind: 'group', owner: true })
  const basicGroupInfo = await ensureReadyOwnedChat(basicGroup, 777)
  assert.equal(basicGroupInfo.kind, 'group', 'owned basic groups should be eligible')

  const adminOnly = fakeClient({ kind: 'channel', owner: false })
  await assert.rejects(
    () => deleteOwnedMessages({ client: adminOnly, chatId: 777, messageIds: [1, 2] }),
    error => error && error.status === 403 && /owned/i.test(error.message)
  )
  assert.equal(adminOnly.calls.filter(call => call._ === 'deleteMessages').length, 0, 'admin rights must not bypass owner-only policy')

  const privateChat = fakeClient({ kind: 'private', owner: true })
  await assert.rejects(
    () => deleteOwnedMessages({ client: privateChat, chatId: 777, messageIds: [1] }),
    error => error && error.status === 403 && /channels and groups/i.test(error.message)
  )
  assert.equal(privateChat.calls.filter(call => call._ === 'deleteMessages').length, 0)

  const notReady = fakeClient({ kind: 'channel', owner: true, ready: false })
  await assert.rejects(
    () => deleteOwnedMessages({ client: notReady, chatId: 777, messageIds: [1] }),
    error => error && error.status === 503
  )

  console.log('owned bulk delete server checks passed')
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
