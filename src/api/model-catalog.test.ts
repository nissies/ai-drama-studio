import { describe, expect, it, vi } from 'vitest'
import { normalizePlatformModelCatalog, platformModelPriceLabel } from './model-catalog'

vi.mock('./client', () => ({ request: vi.fn() }))

describe('normalizePlatformModelCatalog', () => {
  it('keeps the settings page renderable when optional catalog fields are missing', () => {
    expect(
      normalizePlatformModelCatalog([
        { id: 'model-1', serviceType: 'VIDEO', modelCode: 'seedance', displayName: 'Seedance' },
      ]),
    ).toEqual([
      expect.objectContaining({
        id: 'model-1',
        capabilities: [],
        defaultParameters: {},
        routeCount: 0,
        updatedAt: '',
      }),
    ])
  })

  it('drops invalid catalog entries instead of throwing during rendering', () => {
    expect(normalizePlatformModelCatalog([null, {}, { id: 'x', serviceType: 'UNKNOWN' }])).toEqual([])
  })

  it('uses the backend description so billing multipliers stay visible', () => {
    expect(
      platformModelPriceLabel({
        id: 'model-1',
        serviceType: 'VIDEO',
        modelCode: 'wan3.0-video-prime',
        displayName: 'Wan 3.0',
        capabilities: ['VIDEO'],
        defaultParameters: {},
        creditPrice: {
          pricingMode: 'VIDEO_SECOND',
          basePoints: 0,
          unitPoints: 60,
          input1kTokenPoints: 0,
          output1kTokenPoints: 0,
          minimumPoints: 60,
          billingMultiplier: 2,
          version: 1,
          description: '60 点/秒 · 最低 60 点/次 · 失败不扣点 · 2x 倍率',
        },
        routeCount: 1,
        updatedAt: '2026-09-04T00:00:00',
      }),
    ).toBe('60 点/秒 · 最低 60 点/次 · 失败不扣点 · 2x 倍率')
  })
})
