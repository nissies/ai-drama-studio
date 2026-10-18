const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { afterEach, beforeEach, test } = require('node:test')
const { LocalChatStore } = require('./local-chat-store.cjs')

let temporaryRoot
let store

beforeEach(async () => {
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-drama-chat-'))
  store = new LocalChatStore({ appDataPath: temporaryRoot })
})

afterEach(async () => {
  await fs.rm(temporaryRoot, { recursive: true, force: true })
})

test('persists local chat turns and project links', async () => {
  const session = await store.create({ title: 'Offline idea', localConnectionId: 'text-1' })
  const turn = await store.appendTurn(session.id, {
    content: '写一个悬疑短剧',
    assistantContent: '可以从密室失踪案开始。',
    localConnectionId: 'text-1',
    modelName: 'qwen3',
  })
  assert.equal(turn.chargedPoints, 0)
  assert.equal(turn.session.messageCount, 2)

  const linked = await store.attachProject(session.id, 'local-project-1')
  assert.equal(linked.projectId, 'local-project-1')
  const reopened = new LocalChatStore({ appDataPath: temporaryRoot })
  const detail = await reopened.get(session.id)
  assert.equal(detail.messages[1].modelName, 'qwen3')
  assert.equal(detail.session.projectId, 'local-project-1')
})

test('deletes local sessions without affecting other sessions', async () => {
  const first = await store.create({ localConnectionId: 'text-1' })
  const second = await store.create({ localConnectionId: 'text-2' })
  await store.delete(first.id)
  const sessions = await store.list()
  assert.deepEqual(sessions.map((item) => item.id), [second.id])
})
