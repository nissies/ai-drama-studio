// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('binary API errors', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('keeps JSON error envelopes negotiable for media endpoints', async () => {
    let requestOptions: RequestInit | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestOptions = init
        return new Response(
          JSON.stringify({
            requestId: 'request-1',
            data: null,
            error: { code: 'RESOURCE_CONFLICT', message: '临时缓存已过期' },
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        )
      }),
    )

    const { requestBinary } = await import('./client')
    await expect(requestBinary('/media-candidates/candidate-1/content', ['video/mp4'])).rejects.toMatchObject({
      code: 'RESOURCE_CONFLICT',
      status: 409,
      message: '临时缓存已过期',
    })
    expect((requestOptions?.headers as Record<string, string>).Accept).toContain('application/json')
  })
})
