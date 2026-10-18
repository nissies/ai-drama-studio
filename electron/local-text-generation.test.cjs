const assert = require('node:assert/strict')
const { test } = require('node:test')
const { LocalTextGenerationService, buildEndpoint } = require('./local-text-generation.cjs')

test('calls an enabled text connection without exposing its key in the result', async () => {
  const calls = []
  const service = new LocalTextGenerationService({
    connections: {
      async getRuntimeConfig(id, serviceType) {
        assert.equal(id, 'local-1')
        assert.equal(serviceType, 'TEXT')
        return {
          providerCode: 'OPENAI_COMPATIBLE',
          baseUrl: 'http://127.0.0.1:11434',
          endpointPath: '/v1/chat/completions',
          modelName: 'qwen3',
          apiKey: 'secret-key',
        }
      },
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return response(200, {
        choices: [{ message: { content: '改写后的剧本' } }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      })
    },
    now: () => new Date('2026-07-16T08:00:00.000Z'),
  })

  const result = await service.generate({
    connectionId: 'local-1',
    systemPrompt: '你是短剧编剧',
    userPrompt: '改写这段剧本',
    parameters: { temperature: 0.7, max_tokens: 2000 },
  })

  assert.equal(result.text, '改写后的剧本')
  assert.equal(result.completedAt, '2026-07-16T08:00:00.000Z')
  assert.equal('apiKey' in result, false)
  assert.equal(calls[0].url, 'http://127.0.0.1:11434/v1/chat/completions')
  assert.equal(calls[0].options.redirect, 'manual')
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret-key')
  assert.equal(JSON.parse(calls[0].options.body).model, 'qwen3')
})

test('rejects redirects and malformed successful responses', async () => {
  const connections = {
    async getRuntimeConfig() {
      return {
        providerCode: 'OPENAI_COMPATIBLE',
        baseUrl: 'http://127.0.0.1:11434',
        endpointPath: '/v1/chat/completions',
        modelName: 'qwen3',
        apiKey: null,
      }
    },
  }
  const redirected = new LocalTextGenerationService({
    connections,
    fetchImpl: async () => response(302, {}),
  })
  await assert.rejects(() => redirected.generate(input()), /重定向/)

  const malformed = new LocalTextGenerationService({
    connections,
    fetchImpl: async () => response(200, { choices: [] }),
  })
  await assert.rejects(() => malformed.generate(input()), /缺少 choices/)
})

test('only forwards allowlisted model parameters', async () => {
  let requestBody
  const service = new LocalTextGenerationService({
    connections: {
      async getRuntimeConfig() {
        return {
          providerCode: 'OPENAI_COMPATIBLE',
          baseUrl: 'http://localhost:8080',
          endpointPath: null,
          modelName: 'model',
          apiKey: null,
        }
      },
    },
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body)
      return response(200, { choices: [{ message: { content: 'ok' } }] })
    },
  })

  await service.generate({
    ...input(),
    parameters: { temperature: 1, max_tokens: 100, model: 123, stream: 1 },
  })
  assert.equal(requestBody.temperature, 1)
  assert.equal(requestBody.max_tokens, 100)
  assert.equal(requestBody.model, 'model')
  assert.equal(requestBody.stream, false)
})

test('sends a validated reference image as multimodal chat content', async () => {
  let requestBody
  const service = new LocalTextGenerationService({
    connections: {
      async getRuntimeConfig() {
        return {
          providerCode: 'OPENAI_COMPATIBLE',
          baseUrl: 'http://localhost:8080',
          endpointPath: '/v1/chat/completions',
          modelName: 'vision-model',
          apiKey: null,
        }
      },
    },
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body)
      return response(200, { choices: [{ message: { content: '看到了参考图' } }] })
    },
  })
  await service.generate({
    ...input(),
    imageDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
  })
  assert.equal(requestBody.messages[1].content[0].type, 'text')
  assert.equal(requestBody.messages[1].content[1].image_url.url, 'data:image/png;base64,iVBORw0KGgo=')
})

test('redacts a local API key if a provider echoes it in an error', async () => {
  const service = new LocalTextGenerationService({
    connections: {
      async getRuntimeConfig() {
        return {
          providerCode: 'OPENAI_COMPATIBLE',
          baseUrl: 'http://localhost:8080',
          endpointPath: '/v1/chat/completions',
          modelName: 'model',
          apiKey: 'secret-key',
        }
      },
    },
    fetchImpl: async () =>
      response(401, { error: { message: 'Authorization Bearer secret-key is invalid' } }),
  })

  await assert.rejects(
    () => service.generate(input()),
    (error) => error.message.includes('[REDACTED]') && !error.message.includes('secret-key'),
  )
})

test('appends endpoint paths to a versioned base URL', () => {
  assert.equal(
    buildEndpoint('https://api.example.test/v1', '/chat/completions'),
    'https://api.example.test/v1/chat/completions',
  )
  assert.equal(
    buildEndpoint('https://api.example.test/v1', null),
    'https://api.example.test/v1/chat/completions',
  )
})

function input() {
  return {
    connectionId: 'local-1',
    systemPrompt: 'system',
    userPrompt: 'user',
  }
}

function response(status, payload) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => 'application/json' },
    async json() {
      return payload
    },
  }
}
