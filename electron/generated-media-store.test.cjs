const assert = require('node:assert/strict')
const { test } = require('node:test')
const { GeneratedMediaStore, fetchPlatformMediaResponse } = require('./generated-media-store.cjs')

test('retries transient platform media download failures', async () => {
  const responses = [
    new Response(JSON.stringify({ error: { message: '供应商临时不可用' } }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    }),
    new Response('bad gateway', { status: 502 }),
    new Response('video', { status: 200, headers: { 'content-type': 'video/mp4' } }),
  ]
  let calls = 0
  const response = await fetchPlatformMediaResponse({
    url: 'https://api.example.com/api/v1/media-candidates/candidate-1/content',
    accessToken: 'token',
    fetchImpl: async () => responses[calls++],
    retryDelays: [0, 0],
    sleepImpl: async () => undefined,
  })

  assert.equal(response.status, 200)
  assert.equal(calls, 3)
})

test('surfaces the backend media download error message', async () => {
  await assert.rejects(
    fetchPlatformMediaResponse({
      url: 'https://api.example.com/api/v1/media-candidates/candidate-2/content',
      accessToken: 'token',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ error: { message: '供应商临时视频地址已失效，请重新生成' } }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        ),
      retryDelays: [],
    }),
    /供应商临时视频地址已失效/,
  )
})

test('accepts a JSON error envelope from the media content endpoint', async () => {
  let requestOptions
  await assert.rejects(
    fetchPlatformMediaResponse({
      url: 'https://api.example.com/api/v1/media-candidates/candidate-4/content',
      accessToken: 'token',
      fetchImpl: async (_url, options) => {
        requestOptions = options
        return new Response(
          JSON.stringify({ error: { code: 'RESOURCE_CONFLICT', message: '临时缓存已过期' } }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        )
      },
      retryDelays: [],
    }),
    /临时缓存已过期/,
  )
  assert.match(requestOptions.headers.Accept, /application\/json/)
})

test('never follows media redirects', async () => {
  await assert.rejects(
    fetchPlatformMediaResponse({
      url: 'https://api.example.com/api/v1/media-candidates/candidate-3/content',
      accessToken: 'token',
      fetchImpl: async () => new Response(null, { status: 302 }),
      retryDelays: [0],
    }),
    /重定向/,
  )
})

test('rejects an oversized audio response before writing it to disk', async () => {
  const store = new GeneratedMediaStore({ workspace: {} })
  await assert.rejects(
    store.downloadAndPromote({
      projectId: 'project-1',
      candidateId: 'candidate-audio',
      category: 'audio',
      accessToken: 'token',
      apiOrigin: 'https://api.example.com',
      fetchImpl: async () =>
        new Response(null, {
          status: 200,
          headers: { 'content-type': 'audio/mpeg', 'content-length': String(100 * 1024 * 1024 + 1) },
        }),
    }),
    /超过 100MB 上限/,
  )
})
