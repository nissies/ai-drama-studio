const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const sharp = require('sharp')
const { afterEach, beforeEach, test } = require('node:test')
const { GeneratedImageStore } = require('./generated-image-store.cjs')
const { LocalWorkspaceService } = require('./local-workspace.cjs')

let temporaryRoot
let workspace
let store

beforeEach(async () => {
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-drama-generated-'))
  workspace = new LocalWorkspaceService({
    appDataPath: path.join(temporaryRoot, 'app-data'),
    documentsPath: path.join(temporaryRoot, 'documents'),
  })
  await workspace.ensureProject({ id: 'project-1', title: 'Generated images' })
  store = new GeneratedImageStore({ workspace, apiOrigin: 'http://127.0.0.1:8080' })
})

afterEach(async () => {
  await fs.rm(temporaryRoot, { recursive: true, force: true })
})

test('stages a decoded image in cache and only promotes it after an explicit action', async () => {
  const bytes = await sharp({
    create: { width: 64, height: 96, channels: 3, background: '#2f7d68' },
  })
    .png()
    .toBuffer()

  const candidate = await store.stage('project-1', bytes, { originalName: 'hero' })
  assert.equal((await workspace.getProject('project-1')).assets.length, 0)
  assert.equal(candidate.width, 64)
  assert.equal(candidate.height, 96)
  assert.equal(candidate.mimeType, 'image/png')
  assert.equal((await store.resolve('project-1', candidate.id)).candidate.sha256, candidate.sha256)

  const asset = await store.promote('project-1', candidate.id, 'characters')
  assert.equal(asset.category, 'characters')
  assert.equal((await workspace.getProject('project-1')).assets.length, 1)
})

test('promotes storyboard images into storyboard assets', async () => {
  const bytes = await sharp({
    create: { width: 96, height: 64, channels: 3, background: '#8844aa' },
  })
    .png()
    .toBuffer()

  const candidate = await store.stage('project-1', bytes, { originalName: 'storyboard' })
  const asset = await store.promote('project-1', candidate.id, 'storyboards')

  assert.equal(asset.category, 'storyboards')
  assert.equal((await workspace.getProject('project-1')).assets.length, 1)
})

test('rejects MIME spoofing and path-like candidate ids', async () => {
  const bytes = await sharp({
    create: { width: 64, height: 64, channels: 3, background: '#ffffff' },
  })
    .png()
    .toBuffer()

  await assert.rejects(store.stage('project-1', bytes, { mimeType: 'image/jpeg' }), /不匹配/)
  await assert.rejects(store.resolve('project-1', '../outside'), /标识无效/)
})

test('discards an unpromoted generated image and its metadata', async () => {
  const bytes = await sharp({
    create: { width: 64, height: 64, channels: 3, background: '#ffffff' },
  })
    .png()
    .toBuffer()
  const candidate = await store.stage('project-1', bytes, { originalName: 'temporary' })

  await store.discard('project-1', candidate.id)

  await assert.rejects(store.resolve('project-1', candidate.id))
})

test('surfaces backend image download errors and accepts JSON error responses', async () => {
  let requestOptions
  const imageStore = new GeneratedImageStore({
    workspace,
    apiOrigin: 'http://127.0.0.1:8080',
    fetchImpl: async (_url, options) => {
      requestOptions = options
      return new Response(
        JSON.stringify({ error: { code: 'RESOURCE_CONFLICT', message: '平台图片临时缓存已过期，请重新生成' } }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      )
    },
  })

  await assert.rejects(
    imageStore.downloadToCache({ projectId: 'project-1', candidateId: 'candidate-1', accessToken: 'token' }),
    /平台图片临时缓存已过期/,
  )
  assert.match(requestOptions.headers.Accept, /application\/json/)
})
