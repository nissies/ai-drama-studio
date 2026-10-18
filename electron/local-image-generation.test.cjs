const assert = require('node:assert/strict')
const { test } = require('node:test')
const {
  LocalImageGenerationService,
  buildImageEditEndpoint,
  buildImageEndpoint,
  effectiveImageSize,
  safeRemoteUrl,
} = require('./local-image-generation.cjs')

test('upgrades all Seedream 5.0 image sizes to the provider minimum', () => {
  assert.equal(effectiveImageSize('doubao-seedream-5-0-260128', '2048x1152'), '2560x1440')
  assert.equal(effectiveImageSize('doubao-seedream-5-0-pro-260628', '1024x1024'), '1920x1920')
  assert.equal(effectiveImageSize('other-model', '2048x1152'), '2048x1152')
})

test('builds the OpenAI-compatible image endpoint without hardcoded hosts', () => {
  assert.equal(
    buildImageEndpoint('http://127.0.0.1:8188/v1', null),
    'http://127.0.0.1:8188/v1/images/generations',
  )
  assert.equal(
    buildImageEndpoint('https://example.test/api', '/images/create'),
    'https://example.test/api/images/create',
  )
  assert.equal(
    buildImageEditEndpoint('https://example.test/v1', '/images/generations'),
    'https://example.test/v1/images/edits',
  )
  assert.equal(
    buildImageEditEndpoint('https://example.test/v1', '/images/edits'),
    'https://example.test/v1/images/edits',
  )
})

test('generates an image through the Grok OpenAI-compatible endpoint', async () => {
  let request
  const service = new LocalImageGenerationService({
    connections: {
      getRuntimeConfig: async (_id, serviceType) => {
        assert.equal(serviceType, 'IMAGE')
        return {
          providerCode: 'GROK',
          baseUrl: 'https://api.example.test',
          endpointPath: '/v1/images/generations',
          modelName: 'grok-imagine-image-2.0',
          apiKey: 'secret-key',
        }
      },
    },
    generatedImages: {
      stage: async (projectId, bytes, input) => ({
        id: 'grok-image-candidate',
        projectId,
        originalName: input.originalName,
        mimeType: 'image/png',
        sizeBytes: bytes.length,
        sha256: 'c'.repeat(64),
        width: 1024,
        height: 1024,
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    },
    fetchImpl: async (url, init) => {
      request = { url, init }
      return new Response(
        JSON.stringify({ data: [{ b64_json: Buffer.from('png-bytes').toString('base64') }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    },
  })

  const result = await service.generate({
    projectId: 'project-1',
    connectionId: 'grok-image',
    prompt: '雨夜古城中的年轻捕快',
    size: '1024x1024',
  })

  assert.equal(request.url, 'https://api.example.test/v1/images/generations')
  assert.equal(request.init.headers.Authorization, 'Bearer secret-key')
  assert.deepEqual(JSON.parse(request.init.body), {
    model: 'grok-imagine-image-2.0',
    prompt: '雨夜古城中的年轻捕快',
    n: 1,
    size: '1024x1024',
  })
  assert.equal(result.providerCode, 'GROK')
  assert.equal(JSON.stringify(result).includes('secret-key'), false)
})

test('generates one local image with reference image through edit endpoint', async () => {
  let request
  const connections = {
    getRuntimeConfig: async () => ({
      providerCode: 'OPENAI_COMPATIBLE',
      baseUrl: 'https://example.test/v1',
      endpointPath: '/images/generations',
      modelName: 'image-model',
      apiKey: 'secret-key',
    }),
  }
  const generatedImages = {
    stage: async (projectId, bytes, input) => ({
      id: 'candidate-1',
      projectId,
      originalName: input.originalName,
      mimeType: 'image/png',
      sizeBytes: bytes.length,
      sha256: 'a'.repeat(64),
      width: 1024,
      height: 1536,
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
  }
  const fetchImpl = async (url, init) => {
    request = { url, init }
    return new Response(
      JSON.stringify({ data: [{ b64_json: Buffer.from('png-bytes').toString('base64') }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  const service = new LocalImageGenerationService({ connections, generatedImages, fetchImpl })

  const result = await service.generate({
    projectId: 'project-1',
    connectionId: 'connection-1',
    prompt: 'cute character',
    negativePrompt: 'extra fingers',
    size: '1024x1536',
    referenceImages: [
      {
        name: 'reference.png',
        mimeType: 'image/png',
        bytes: Uint8Array.from([137, 80, 78, 71]).buffer,
      },
    ],
  })

  assert.equal(request.url, 'https://example.test/v1/images/edits')
  assert.equal(request.init.headers.Authorization, 'Bearer secret-key')
  assert.equal(request.init.headers['Content-Type'], undefined)
  assert.equal(request.init.body instanceof FormData, true)
  const fields = Array.from(request.init.body.entries())
  assert.equal(fields.find(([name]) => name === 'model')?.[1], 'image-model')
  assert.match(fields.find(([name]) => name === 'prompt')?.[1], /Avoid: extra fingers/)
  assert.equal(fields.find(([name]) => name === 'n')?.[1], '1')
  assert.equal(fields.find(([name]) => name === 'image')?.[1]?.type, 'image/png')
  assert.equal(result.id, 'candidate-1')
  assert.equal(result.providerCode, 'OPENAI_COMPATIBLE')
  assert.equal(JSON.stringify(result).includes('secret-key'), false)
})

test('rejects redirect responses instead of following another source', async () => {
  const service = new LocalImageGenerationService({
    connections: {
      getRuntimeConfig: async () => ({
        providerCode: 'LOCAL',
        baseUrl: 'http://127.0.0.1:8188',
        endpointPath: '/images',
        modelName: 'local-image',
        apiKey: null,
      }),
    },
    generatedImages: { stage: async () => assert.fail('must not stage') },
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: '/other' } }),
  })

  await assert.rejects(
    service.generate({
      projectId: 'project-1',
      connectionId: 'connection-1',
      prompt: 'scene',
      size: '1024x1536',
    }),
    /重定向/,
  )
})

test('allows same-origin local results and rejects cross-origin private addresses', async () => {
  assert.equal(
    await safeRemoteUrl('http://127.0.0.1:8188/output/image.png', 'http://127.0.0.1:8188/v1'),
    'http://127.0.0.1:8188/output/image.png',
  )
  await assert.rejects(
    safeRemoteUrl('https://127.0.0.1/private.png', 'https://provider.example/v1'),
    /本机、内网或保留网络/,
  )
  await assert.rejects(
    safeRemoteUrl('http://169.254.169.254/latest', 'http://127.0.0.1:8188/v1'),
    /公网 HTTPS/,
  )
})
