const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const {
  ASSETS,
  OptionalRuntimeAssetService,
  assertTrustedDownloadUrl,
  fetchTrusted,
} = require('./optional-runtime-assets.cjs')

const payload = Buffer.alloc(128, 7)
const testAsset = {
  ...ASSETS['dwpose-model'],
  sizeBytes: payload.length,
  sha256: crypto.createHash('sha256').update(payload).digest('hex'),
}
const testAssets = { 'dwpose-model': testAsset }

function response(body, url = ASSETS['dwpose-model'].downloadUrl) {
  const result = new Response(body, {
    status: 200,
    headers: { 'content-length': String(testAsset.sizeBytes) },
  })
  Object.defineProperty(result, 'url', { value: url })
  return result
}

async function withService(fetchImpl, run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-assets-'))
  try {
    await run(new OptionalRuntimeAssetService({ appDataPath: root, fetchImpl, assets: testAssets }), root)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

test('installs a pinned runtime asset only after size and sha256 verification', async () => {
  await withService(async () => response(payload), async (service) => {
    const result = await service.install('dwpose-model')
    assert.equal(result.state, 'READY')
    assert.equal((await service.status('dwpose-model')).state, 'READY')
    assert.equal(await service.resolve('dwpose-model'), path.join(service.root, 'dwpose-model', testAsset.fileName))
  })
})

test('rejects a corrupted payload and removes its partial file', async () => {
  const badPayload = Buffer.from(payload)
  badPayload[0] = 8
  await withService(async () => response(badPayload), async (service) => {
    await assert.rejects(service.install('dwpose-model'), /校验失败/)
    assert.equal((await service.status('dwpose-model')).state, 'NOT_INSTALLED')
  })
})

test('rejects untrusted download hosts and unknown asset ids', async () => {
  assert.throws(() => assertTrustedDownloadUrl('https://example.com/model.onnx'), /未受信任/)
  await withService(async () => response(payload), async (service) => {
    await assert.rejects(service.status('../secret'), /未知运行时资源/)
  })
})

test('validates every redirect before requesting its destination', async () => {
  const requested = []
  const fetchImpl = async (url) => {
    requested.push(url)
    return new Response(null, { status: 302, headers: { location: 'https://example.com/model' } })
  }
  await assert.rejects(fetchTrusted(fetchImpl, testAsset.downloadUrl), /未受信任/)
  assert.deepEqual(requested, [testAsset.downloadUrl])
})

test('removes only the managed optional asset', async () => {
  await withService(async () => response(payload), async (service) => {
    await service.install('dwpose-model')
    const status = await service.remove('dwpose-model')
    assert.equal(status.state, 'NOT_INSTALLED')
    assert.equal(await service.resolve('dwpose-model'), null)
  })
})
