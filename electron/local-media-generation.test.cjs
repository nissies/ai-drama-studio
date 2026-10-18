const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const {
  LocalMediaGenerationService,
  buildMediaEndpoint,
  buildMediaStatusEndpoint,
  providerVoice,
  validateInput,
  xaiResolution,
} = require('./local-media-generation.cjs')

test('builds video and speech endpoints from the configured base URL', () => {
  assert.equal(
    buildMediaEndpoint('http://127.0.0.1:8188/v1', null, 'VIDEO'),
    'http://127.0.0.1:8188/v1/videos',
  )
  assert.equal(
    buildMediaEndpoint('https://example.test/api', '/speech/create', 'TTS'),
    'https://example.test/api/speech/create',
  )
  assert.equal(
    buildMediaStatusEndpoint(
      'https://api.x.ai/v1/videos/generations',
      'request-1',
      { providerCode: 'XAI' },
      'VIDEO',
    ),
    'https://api.x.ai/v1/videos/request-1',
  )
  assert.equal(xaiResolution(null, '720x1280'), '720p')
})

test('maps friendly voice presets to provider-specific voice ids', () => {
  assert.equal(providerVoice('MINIMAX', 'preset:female_young_bright'), 'female-tianmei')
  assert.equal(providerVoice('OPENAI_COMPATIBLE', 'preset:male_deep_powerful'), 'onyx')
  assert.equal(providerVoice('MINIMAX', 'custom-cloned-voice'), 'custom-cloned-voice')
})

test('generates speech locally and stages the binary response without exposing its key', async () => {
  let request
  let stagedResponse
  const service = new LocalMediaGenerationService({
    connections: {
      getRuntimeConfig: async (_id, serviceType) => {
        assert.equal(serviceType, 'TTS')
        return {
          providerCode: 'OPENAI_COMPATIBLE',
          baseUrl: 'https://example.test/v1',
          endpointPath: '/audio/speech',
          modelName: 'speech-model',
          apiKey: 'secret-key',
        }
      },
    },
    generatedMedia: {
      stage: async (projectId, response, input) => {
        stagedResponse = { projectId, response, input }
        return {
          id: 'audio-candidate',
          projectId,
          originalName: 'speech.mp3',
          mimeType: 'audio/mpeg',
          sizeBytes: 1024,
          sha256: 'a'.repeat(64),
          durationMs: 2400,
          width: null,
          height: null,
          createdAt: '2026-01-01T00:00:00.000Z',
        }
      },
    },
    workspace: {},
    fetchImpl: async (url, init) => {
      request = { url, init }
      return new Response(Buffer.from('ID3-audio'), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      })
    },
  })

  const result = await service.generate({
    projectId: 'project-1',
    connectionId: 'tts-1',
    mediaType: 'TTS',
    prompt: '你好，世界。',
    durationSec: 3,
    voice: 'alloy',
    speed: 1.1,
    parameters: { instructions: '年轻清冷女声，语气灵动' },
  })

  assert.equal(request.url, 'https://example.test/v1/audio/speech')
  assert.equal(request.init.headers.Authorization, 'Bearer secret-key')
  assert.deepEqual(JSON.parse(request.init.body), {
    model: 'speech-model',
    input: '你好，世界。',
    voice: 'alloy',
    response_format: 'mp3',
    speed: 1.1,
    instructions: '年轻清冷女声，语气灵动',
  })
  assert.equal(stagedResponse.projectId, 'project-1')
  assert.equal(stagedResponse.input.mimeType, 'audio/mpeg')
  assert.equal(result.id, 'audio-candidate')
  assert.equal(JSON.stringify(result).includes('secret-key'), false)
})

test('normalizes a legacy Grok text-to-video endpoint and accepts a nested result URL', async () => {
  let generationRequest
  let downloaded = false
  const service = new LocalMediaGenerationService({
    connections: {
      getRuntimeConfig: async (_id, serviceType) => {
        assert.equal(serviceType, 'VIDEO')
        return {
          providerCode: 'GROK',
          baseUrl: 'https://api.example.test',
          endpointPath: '/v1/videos',
          modelName: 'grok-imagine-video',
          apiKey: 'secret-key',
        }
      },
    },
    generatedMedia: {
      stage: async (projectId, response, input) => ({
        id: 'grok-video-candidate',
        projectId,
        originalName: input.originalName,
        mimeType: response.headers.get('content-type'),
        sizeBytes: 2048,
        sha256: 'b'.repeat(64),
        durationMs: 5000,
        width: 720,
        height: 1280,
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    },
    workspace: {},
    fetchImpl: async (url, init) => {
      if (url === 'https://api.example.test/v1/videos/generations') {
        generationRequest = init
        return new Response(
          JSON.stringify({
            status: 'completed',
            data: { video: { url: 'https://api.example.test/generated/result.mp4' } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      assert.equal(url, 'https://api.example.test/generated/result.mp4')
      downloaded = true
      return new Response(Buffer.from('video-bytes'), {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      })
    },
  })

  const result = await service.generate({
    projectId: 'project-1',
    connectionId: 'grok-video',
    mediaType: 'VIDEO',
    prompt: '角色沿着雨夜街道向前奔跑',
    durationSec: 5,
    size: '720x1280',
    aspectRatio: '9:16',
  })

  const fields = JSON.parse(generationRequest.body)
  assert.equal(generationRequest.headers.Authorization, 'Bearer secret-key')
  assert.equal(generationRequest.headers['Content-Type'], 'application/json')
  assert.equal(fields.model, 'grok-imagine-video')
  assert.equal(fields.prompt, '角色沿着雨夜街道向前奔跑')
  assert.equal(fields.duration, 5)
  assert.equal(downloaded, true)
  assert.equal(result.providerCode, 'GROK')
  assert.equal(JSON.stringify(result).includes('secret-key'), false)
})

test('sends one to seven Grok 1.5 reference images without requiring a first-frame label', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aidrama-grok-video-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const files = new Map()
  for (const [index, assetId] of ['character-image', 'scene-image'].entries()) {
    const filePath = path.join(directory, `${index}.png`)
    await fs.writeFile(filePath, Buffer.from(`png-${index}`))
    files.set(assetId, filePath)
  }
  let generationRequest
  const service = new LocalMediaGenerationService({
    connections: {
      getRuntimeConfig: async () => ({
        providerCode: 'GROK',
        baseUrl: 'https://api.example.test',
        endpointPath: '/v1/videos/generations',
        modelName: 'grok-imagine-video-1.5',
        apiKey: 'secret-key',
      }),
    },
    generatedMedia: {
      stage: async (projectId, _response, input) => ({
        id: 'grok-reference-video',
        projectId,
        originalName: input.originalName,
        mimeType: 'video/mp4',
        sizeBytes: 2048,
        sha256: 'd'.repeat(64),
        durationMs: 5000,
        width: 720,
        height: 1280,
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    },
    workspace: {
      resolveAsset: async (_projectId, assetId) => ({
        asset: { mimeType: 'image/png' },
        path: files.get(assetId),
      }),
    },
    fetchImpl: async (url, init) => {
      if (url === 'https://api.example.test/v1/videos/generations') {
        generationRequest = init
        return new Response(
          JSON.stringify({ video: { url: 'https://api.example.test/generated/references.mp4' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(Buffer.from('video-bytes'), {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      })
    },
  })

  await service.generate({
    projectId: 'project-1',
    connectionId: 'grok-video',
    mediaType: 'VIDEO',
    prompt: '保持角色、服装与场景一致，完成追逐镜头',
    durationSec: 5,
    referenceAssetIds: ['character-image'],
    referenceImages: [
      { mimeType: 'image/png', bytes: Uint8Array.from(Buffer.from('inline-scene')).buffer },
    ],
    parameters: { reference_mode: 'REFERENCE_TO_VIDEO' },
  })

  const payload = JSON.parse(generationRequest.body)
  assert.equal(payload.image, undefined)
  assert.equal(payload.reference_images.length, 2)
  assert.match(payload.reference_images[0].url, /^data:image\/png;base64,/)
})

test('rejects Grok 1.5 without an image before calling the compatible provider', async () => {
  let requestCount = 0
  const service = new LocalMediaGenerationService({
    connections: {
      getRuntimeConfig: async () => ({
        providerCode: 'GROK',
        baseUrl: 'https://api.example.test',
        endpointPath: '/v1/videos/generations',
        modelName: 'grok-imagine-video-1.5',
        apiKey: 'secret-key',
      }),
    },
    generatedMedia: {},
    workspace: {},
    fetchImpl: async () => {
      requestCount += 1
      throw new Error('provider must not be called')
    },
  })

  await assert.rejects(
    service.generate({
      projectId: 'project-1',
      connectionId: 'grok-video',
      mediaType: 'VIDEO',
      prompt: '生成短视频',
      durationSec: 5,
    }),
    /至少提供一张参考图片/,
  )
  assert.equal(requestCount, 0)
})

test('generates official xAI video with JSON and polls request_id until done', async () => {
  const requests = []
  let pollCount = 0
  const service = new LocalMediaGenerationService({
    connections: {
      getRuntimeConfig: async () => ({
        providerCode: 'XAI',
        baseUrl: 'https://api.x.ai',
        endpointPath: '/v1/videos/generations',
        modelName: 'grok-imagine-video-1.5',
        apiKey: 'xai-secret',
      }),
    },
    generatedMedia: {
      stage: async (projectId, response, input) => ({
        id: 'xai-video-candidate',
        projectId,
        originalName: input.originalName,
        mimeType: response.headers.get('content-type'),
        sizeBytes: 4096,
        sha256: 'c'.repeat(64),
        durationMs: 6000,
        width: 1280,
        height: 720,
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    },
    workspace: {},
    pollIntervalMillis: 0,
    fetchImpl: async (url, init) => {
      requests.push({ url, init })
      if (url === 'https://api.x.ai/v1/videos/generations') {
        return new Response(JSON.stringify({ request_id: 'request-123' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url === 'https://api.x.ai/v1/videos/request-123') {
        pollCount += 1
        return new Response(
          JSON.stringify(
            pollCount === 1
              ? { status: 'pending' }
              : { status: 'done', video: { url: 'https://api.x.ai/generated/result.mp4' } },
          ),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      assert.equal(url, 'https://api.x.ai/generated/result.mp4')
      return new Response(Buffer.from('xai-video-bytes'), {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      })
    },
  })

  const result = await service.generate({
    projectId: 'project-1',
    connectionId: 'xai-video',
    mediaType: 'VIDEO',
    prompt: '电影感雨夜追逐镜头',
    durationSec: 6,
    size: '1280x720',
    aspectRatio: '16:9',
  })

  assert.deepEqual(JSON.parse(requests[0].init.body), {
    model: 'grok-imagine-video-1.5',
    prompt: '电影感雨夜追逐镜头',
    duration: 6,
    aspect_ratio: '16:9',
    resolution: '720p',
  })
  assert.equal(requests[0].init.headers['Content-Type'], 'application/json')
  assert.equal(requests[0].init.headers.Authorization, 'Bearer xai-secret')
  assert.equal(pollCount, 2)
  assert.equal(result.id, 'xai-video-candidate')
  assert.equal(JSON.stringify(result).includes('xai-secret'), false)
})

test('reports an expired official xAI video task without requesting content', async () => {
  let requestCount = 0
  const service = new LocalMediaGenerationService({
    connections: {
      getRuntimeConfig: async () => ({
        providerCode: 'XAI',
        baseUrl: 'https://api.x.ai',
        endpointPath: '/v1/videos/generations',
        modelName: 'grok-imagine-video-1.5',
        apiKey: 'xai-secret',
      }),
    },
    generatedMedia: { stage: async () => assert.fail('expired tasks must not stage media') },
    workspace: {},
    pollIntervalMillis: 0,
    fetchImpl: async () => {
      requestCount += 1
      return new Response(
        JSON.stringify(
          requestCount === 1 ? { request_id: 'expired-request' } : { status: 'expired' },
        ),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    },
  })

  await assert.rejects(
    service.generate({
      projectId: 'project-1',
      connectionId: 'xai-video',
      mediaType: 'VIDEO',
      prompt: '生成一个短镜头',
      durationSec: 5,
    }),
    /已过期/,
  )
  assert.equal(requestCount, 2)
})

test('rejects invalid media duration and unsupported media types before calling a provider', () => {
  assert.throws(
    () =>
      validateInput({
        projectId: 'project-1',
        connectionId: 'connection-1',
        mediaType: 'VIDEO',
        prompt: 'test',
        durationSec: 0,
      }),
    /时长/,
  )
  assert.throws(
    () =>
      validateInput({
        projectId: 'project-1',
        connectionId: 'connection-1',
        mediaType: 'MUSIC',
        prompt: 'test',
        durationSec: 5,
      }),
    /VIDEO 或 TTS/,
  )
  assert.equal(
    validateInput({
      projectId: 'project-1',
      connectionId: 'connection-1',
      mediaType: 'VIDEO',
      prompt: 'test',
      durationSec: 5,
      aspectRatio: '16:9',
    }).aspectRatio,
    '16:9',
  )
  assert.throws(
    () =>
      validateInput({
        projectId: 'project-1',
        connectionId: 'connection-1',
        mediaType: 'VIDEO',
        prompt: 'test',
        durationSec: 5,
        aspectRatio: '1:1',
      }),
    /视频比例/,
  )
})
