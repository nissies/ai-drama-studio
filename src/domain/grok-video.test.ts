import { describe, expect, it } from 'vitest'
import {
  generationRouteModelCode,
  grokVideoMode,
  grokVideoReferenceError,
  isGrokCompatibleRoute,
} from './grok-video'

describe('Grok video capabilities', () => {
  it('recognizes the two configured Grok video modes exactly', () => {
    expect(grokVideoMode('grok-imagine-video')).toBe('TEXT_TO_VIDEO')
    expect(grokVideoMode(' GROK-IMAGINE-VIDEO-1.5 ')).toBe('IMAGE_TO_VIDEO')
    expect(grokVideoMode('other-video-model')).toBeNull()
  })

  it('ignores automatic references for text-to-video but rejects manual references', () => {
    expect(
      grokVideoReferenceError('TEXT_TO_VIDEO', [
        { mediaType: 'IMAGE', automatic: true },
      ]),
    ).toBeNull()
    expect(
      grokVideoReferenceError('TEXT_TO_VIDEO', [
        { mediaType: 'IMAGE', automatic: false },
      ]),
    ).toContain('取消手动选择')
  })

  it('accepts one to seven ordinary images without a first-frame purpose', () => {
    expect(
      grokVideoReferenceError('IMAGE_TO_VIDEO', [
        { mediaType: 'IMAGE' },
        { mediaType: 'IMAGE', purpose: 'CHARACTER_REFERENCE' },
        { mediaType: 'IMAGE', purpose: 'SCENE_REFERENCE' },
      ]),
    ).toBeNull()
  })

  it('rejects missing, non-image, and excessive references for the compatible 1.5 model', () => {
    expect(grokVideoReferenceError('IMAGE_TO_VIDEO', [])).toContain('至少选择一张')
    expect(
      grokVideoReferenceError('IMAGE_TO_VIDEO', [{ mediaType: 'VIDEO' }]),
    ).toContain('仅接受图片')
    expect(
      grokVideoReferenceError(
        'IMAGE_TO_VIDEO',
        Array.from({ length: 8 }, () => ({ mediaType: 'IMAGE' as const })),
      ),
    ).toContain('最多提交 7 张')
  })

  it('allows official xAI 1.5 without a reference while keeping compatible routes strict', () => {
    expect(grokVideoReferenceError('IMAGE_TO_VIDEO', [], false)).toBeNull()
    expect(
      isGrokCompatibleRoute({
        sourceType: 'LOCAL',
        localConnectionId: 'local-grok',
        localProviderCode: 'GROK',
        localModelName: 'grok-imagine-video-1.5',
      }),
    ).toBe(true)
    expect(
      isGrokCompatibleRoute({
        sourceType: 'PLATFORM',
        platformModelId: 'official-xai',
        platformModelCode: 'grok-imagine-video-1.5',
        platformProtocolProfile: 'XAI_OFFICIAL',
      }),
    ).toBe(false)
  })

  it('keeps the selected platform model code when the catalog is temporarily unavailable', () => {
    expect(
      generationRouteModelCode({
        sourceType: 'PLATFORM',
        platformModelId: 'grok-route-1-5',
        platformModelCode: 'grok-imagine-video-1.5',
        modelName: 'Grok Imagine Video 1.5',
      }),
    ).toBe('grok-imagine-video-1.5')
    expect(
      grokVideoMode(
        generationRouteModelCode({
          sourceType: 'PLATFORM',
          platformModelId: 'grok-route-1-5',
          platformModelCode: 'grok-imagine-video-1.5',
        }),
      ),
    ).toBe('IMAGE_TO_VIDEO')
    expect(
      generationRouteModelCode({
        sourceType: 'PLATFORM',
        platformModelId: 'grok-route-1-5',
        modelName: 'grok-imagine-video-1.5',
      }),
    ).toBe('grok-imagine-video-1.5')
  })
})
