import { describe, expect, it } from 'vitest'
import { toImageGenerationPayload } from './image-generation-payload'

describe('image generation payload', () => {
  it('keeps LOCAL routing explicit without platform fields', () => {
    expect(
      toImageGenerationPayload({
        targetType: 'CHARACTER',
        targetId: 'character-1',
        prompt: 'front portrait',
        negativePrompt: 'extra fingers',
        size: '1024x1536',
        compositionType: 'SINGLE',
        route: {
          sourceType: 'LOCAL',
          localConnectionId: 'local-image-1',
          localProviderCode: 'LOCAL',
          localModelName: 'image-model',
        },
      }),
    ).toEqual({
      targetType: 'CHARACTER',
      targetId: 'character-1',
      prompt: 'front portrait',
      negativePrompt: 'extra fingers',
      size: '1024x1536',
      compositionType: 'SINGLE',
      parameters: {},
      sourceType: 'LOCAL',
      localConnectionId: 'local-image-1',
      localProviderCode: 'LOCAL',
      localModelName: 'image-model',
    })
  })

  it('keeps PLATFORM routing explicit without local fields', () => {
    const payload = toImageGenerationPayload({
      targetType: 'SCENE',
      targetId: 'scene-1',
      prompt: 'night restaurant',
      size: '1536x1024',
      compositionType: 'SINGLE',
      route: { sourceType: 'PLATFORM', platformModelId: 'platform-image-1' },
    })

    expect(payload.sourceType).toBe('PLATFORM')
    expect(payload).toHaveProperty('platformModelId', 'platform-image-1')
    expect(payload).not.toHaveProperty('localConnectionId')
  })
})
