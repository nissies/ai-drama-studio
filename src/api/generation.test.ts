import { describe, expect, it } from 'vitest'
import type { CreateGenerationJobInput } from './generation'
import { toCreatePayload } from './generation-payload'

const base = {
  jobType: 'SCRIPT_REWRITE',
  targetType: 'EPISODE',
  targetId: 'episode-1',
} as const

describe('generation payload', () => {
  it('keeps local and platform route fields mutually exclusive', () => {
    const local = toCreatePayload({
      ...base,
      route: {
        sourceType: 'LOCAL',
        localConnectionId: 'local-1',
        localProviderCode: 'OLLAMA',
        localModelName: 'qwen3',
      },
    })
    const platform = toCreatePayload({
      ...base,
      route: { sourceType: 'PLATFORM', platformModelId: 'model-1' },
    })

    expect(local).toMatchObject({ sourceType: 'LOCAL', localConnectionId: 'local-1' })
    expect(local).not.toHaveProperty('platformModelId')
    expect(platform).toMatchObject({ sourceType: 'PLATFORM', platformModelId: 'model-1' })
    expect(platform).not.toHaveProperty('localConnectionId')
  })

  it('normalizes missing parameters to an empty object', () => {
    const input: CreateGenerationJobInput = {
      ...base,
      route: { sourceType: 'PLATFORM', platformModelId: 'model-1' },
    }
    expect(toCreatePayload(input).parameters).toEqual({})
  })

  it('keeps source revision generation targets explicit', () => {
    const payload = toCreatePayload({
      jobType: 'SOURCE_STRUCTURE',
      targetType: 'SOURCE_REVISION',
      targetId: 'revision-1',
      parameters: { targetEpisodeCount: 8, targetDurationSec: 60 },
      route: { sourceType: 'PLATFORM', platformModelId: 'model-1' },
    })

    expect(payload).toMatchObject({
      jobType: 'SOURCE_STRUCTURE',
      targetType: 'SOURCE_REVISION',
      targetId: 'revision-1',
      sourceType: 'PLATFORM',
    })
  })

  it('keeps script generation and asset extraction as distinct episode jobs', () => {
    const route = { sourceType: 'PLATFORM' as const, platformModelId: 'model-1' }
    const generate = toCreatePayload({
      jobType: 'SCRIPT_GENERATE',
      targetType: 'EPISODE',
      targetId: 'episode-1',
      route,
    })
    const extract = toCreatePayload({
      jobType: 'EPISODE_ASSET_EXTRACT',
      targetType: 'EPISODE',
      targetId: 'episode-1',
      parameters: { temperature: 0.2 },
      route,
    })

    expect(generate).toMatchObject({ jobType: 'SCRIPT_GENERATE', targetType: 'EPISODE' })
    expect(extract).toMatchObject({
      jobType: 'EPISODE_ASSET_EXTRACT',
      parameters: { temperature: 0.2 },
    })
  })
})
