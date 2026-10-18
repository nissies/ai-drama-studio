const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { afterEach, beforeEach, test } = require('node:test')
const { LocalAiConnectionService } = require('./local-ai-connections.cjs')

let temporaryRoot
let encryption
let service

beforeEach(async () => {
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-drama-local-ai-'))
  encryption = {
    available: true,
    isAvailable() {
      return this.available
    },
    encrypt(value) {
      return Buffer.from(`encrypted:${value}`, 'utf8')
    },
    decrypt(value) {
      return value.toString('utf8').replace(/^encrypted:/, '')
    },
  }
  service = new LocalAiConnectionService({ appDataPath: temporaryRoot, encryption })
})

afterEach(async () => {
  await fs.rm(temporaryRoot, { recursive: true, force: true })
})

test('encrypts API keys and never returns plaintext or ciphertext to the renderer', async () => {
  const saved = await service.save(input({ apiKey: 'secret-1234' }))
  const [listed] = await service.list()
  const file = await fs.readFile(path.join(temporaryRoot, 'local-ai-connections.json'), 'utf8')

  assert.equal(saved.apiKeyConfigured, true)
  assert.equal(saved.apiKeyHint, '1234')
  assert.equal(listed.apiKeyConfigured, true)
  assert.equal('apiKey' in listed, false)
  assert.equal('encryptedApiKeyBase64' in listed, false)
  assert.equal(file.includes('secret-1234'), false)
  assert.equal((await service.getRuntimeConfig(saved.id)).apiKey, 'secret-1234')
})

test('refuses to save a key when safe storage is unavailable', async () => {
  encryption.available = false
  await assert.rejects(service.save(input({ apiKey: 'secret' })), /安全存储不可用/)
  assert.deepEqual(await service.list(), [])
})

test('keeps only one default connection per service type', async () => {
  const first = await service.save(input({ displayName: 'First', defaultProvider: true }))
  await service.save(input({ displayName: 'Second', defaultProvider: true }))
  const listed = await service.list()

  assert.equal(listed.find((item) => item.id === first.id).defaultProvider, false)
  assert.equal(listed.filter((item) => item.defaultProvider).length, 1)
})

test('requires key re-entry when the destination host changes', async () => {
  const saved = await service.save(input({ apiKey: 'secret' }))

  await assert.rejects(
    service.save({
      ...input(),
      id: saved.id,
      version: saved.version,
      baseUrl: 'http://other:11434',
    }),
    /重新输入或清除 API Key/,
  )
})

test('runtime config rejects disabled and mismatched connections', async () => {
  const disabled = await service.save(input({ enabled: false }))
  await assert.rejects(service.getRuntimeConfig(disabled.id, 'TEXT'), /已停用/)

  const image = await service.save(
    input({ serviceType: 'IMAGE', providerCode: 'IMAGE_API', modelName: 'image-model' }),
  )
  await assert.rejects(service.getRuntimeConfig(image.id, 'TEXT'), /类型与当前任务不匹配/)
})

test('address test sends HEAD without authorization and does not follow redirects', async () => {
  const calls = []
  service = new LocalAiConnectionService({
    appDataPath: temporaryRoot,
    encryption,
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return { status: 405 }
    },
  })
  const saved = await service.save(input({ apiKey: 'secret' }))
  const result = await service.testAddress(saved.id)

  assert.equal(result.status, 'REACHABLE')
  assert.equal(calls[0].options.method, 'HEAD')
  assert.equal(calls[0].options.redirect, 'manual')
  assert.equal('Authorization' in calls[0].options.headers, false)
})

test('infers provider code and default endpoint when optional fields are blank', async () => {
  const saved = await service.save(
    input({
      providerCode: '',
      endpointPath: '',
      baseUrl: 'http://127.0.0.1:11434',
    }),
  )

  assert.equal(saved.providerCode, 'OLLAMA')
  assert.equal(saved.endpointPath, '/api/chat')
})

test('separates a generic compatible endpoint from the official xAI video protocol', async () => {
  const image = await service.save(
    input({
      serviceType: 'IMAGE',
      providerCode: 'OPENAI_COMPATIBLE',
      baseUrl: 'https://api.example.test',
      endpointPath: '',
      modelName: 'grok-imagine-image-2.0',
    }),
  )
  const video = await service.save(
    input({
      serviceType: 'VIDEO',
      providerCode: '',
      baseUrl: 'https://api.x.ai',
      endpointPath: '',
      modelName: 'grok-imagine-video-1.5',
    }),
  )

  assert.equal(image.providerCode, 'OPENAI_COMPATIBLE')
  assert.equal(image.endpointPath, '/v1/images/generations')
  assert.equal(video.providerCode, 'XAI')
  assert.equal(video.endpointPath, '/v1/videos/generations')
})

test('discovers Ollama models and returns normalized configuration defaults', async () => {
  const calls = []
  service = new LocalAiConnectionService({
    appDataPath: temporaryRoot,
    encryption,
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ models: [{ name: 'qwen3:8b' }, { model: 'gemma3:latest' }] }),
      }
    },
  })

  const result = await service.discoverModels({
    serviceType: 'TEXT',
    providerCode: '',
    baseUrl: 'http://127.0.0.1:11434',
    endpointPath: '/v1/chat/completions',
  })

  assert.equal(calls[0].url, 'http://127.0.0.1:11434/api/tags')
  assert.equal(result.providerCode, 'OLLAMA')
  assert.equal(result.endpointPath, '/api/chat')
  assert.deepEqual(result.models, ['gemma3:latest', 'qwen3:8b'])
})

test('discovers OpenAI-compatible models with bearer authorization', async () => {
  const calls = []
  service = new LocalAiConnectionService({
    appDataPath: temporaryRoot,
    encryption,
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ data: [{ id: 'gpt-image-1' }, { id: 'gpt-image-1' }] }),
      }
    },
  })

  const result = await service.discoverModels({
    serviceType: 'IMAGE',
    baseUrl: 'https://example.com',
    endpointPath: '/v1/images/generations',
    apiKey: 'secret-key',
  })

  assert.equal(calls[0].url, 'https://example.com/v1/models')
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret-key')
  assert.deepEqual(result.models, ['gpt-image-1'])
})

test('discovers models from supported Chinese provider endpoints', async () => {
  const providers = [
    [
      'https://ark.cn-beijing.volces.com/api/v3',
      'VOLCENGINE',
      'https://ark.cn-beijing.volces.com/api/v3/models',
    ],
    [
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
      'DASHSCOPE',
      'https://dashscope.aliyuncs.com/compatible-mode/v1/models',
    ],
    ['https://api.deepseek.com', 'DEEPSEEK', 'https://api.deepseek.com/models'],
    [
      'https://open.bigmodel.cn/api/paas/v4',
      'ZHIPU',
      'https://open.bigmodel.cn/api/paas/v4/models',
    ],
    ['https://api.moonshot.cn/v1', 'MOONSHOT', 'https://api.moonshot.cn/v1/models'],
    ['https://api.siliconflow.cn/v1', 'SILICONFLOW', 'https://api.siliconflow.cn/v1/models'],
    ['https://qianfan.baidubce.com/v2', 'QIANFAN', 'https://qianfan.baidubce.com/v2/models'],
    [
      'https://api.hunyuan.cloud.tencent.com/v1',
      'HUNYUAN',
      'https://api.hunyuan.cloud.tencent.com/v1/models',
    ],
  ]

  for (const [baseUrl, providerCode, expectedUrl] of providers) {
    const calls = []
    service = new LocalAiConnectionService({
      appDataPath: temporaryRoot,
      encryption,
      fetchImpl: async (url) => {
        calls.push(url)
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          json: async () => ({ data: [{ model_id: `${providerCode.toLowerCase()}-model` }] }),
        }
      },
    })

    const result = await service.discoverModels({
      serviceType: 'TEXT',
      baseUrl,
      endpointPath: '/v1/chat/completions',
      apiKey: 'secret-key',
    })

    assert.equal(result.providerCode, providerCode)
    assert.equal(calls[0], expectedUrl)
    assert.deepEqual(result.models, [`${providerCode.toLowerCase()}-model`])
  }
})

test('normalizes nested and root model list payloads', async () => {
  const payloads = [
    [{ modelId: 'root-model' }],
    { data: { models: [{ model_code: 'nested-model' }, { modelName: 'named-model' }] } },
  ]

  for (const payload of payloads) {
    service = new LocalAiConnectionService({
      appDataPath: temporaryRoot,
      encryption,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => payload,
      }),
    })
    const result = await service.discoverModels({
      serviceType: 'TEXT',
      baseUrl: 'https://example.com',
    })
    assert.ok(result.models.length > 0)
  }
})

function input(overrides = {}) {
  return {
    serviceType: 'TEXT',
    providerCode: 'OLLAMA',
    displayName: 'Local Ollama',
    baseUrl: 'http://127.0.0.1:11434',
    endpointPath: '/api/chat',
    modelName: 'qwen3',
    apiKey: '',
    clearApiKey: false,
    enabled: true,
    defaultProvider: false,
    ...overrides,
  }
}
