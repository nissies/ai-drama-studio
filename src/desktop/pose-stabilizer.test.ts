import { describe, expect, it } from 'vitest'
import { stabilizePoseFrames } from './pose-stabilizer'
import type { PoseProxyLandmark } from './types'

function pose(centerX: number, centerY = 0.5, visibility = 1): PoseProxyLandmark[] {
  return Array.from({ length: 33 }, (_, index) => ({
    x: centerX + (index === 11 || index === 23 ? -0.04 : index === 12 || index === 24 ? 0.04 : 0),
    y: centerY,
    z: 0,
    visibility,
  }))
}

describe('stabilizePoseFrames', () => {
  it('keeps the primary person in a stable position when detector ordering changes', () => {
    const frames = stabilizePoseFrames([
      { poses: [pose(0.3), pose(0.72)] },
      { poses: [pose(0.74), pose(0.32)] },
    ])

    expect(frames[1].poses).toHaveLength(2)
    expect(frames[1].poses[0][11].x).toBeLessThan(0.5)
    expect(frames[1].poses[1][11].x).toBeGreaterThan(0.5)
  })

  it('holds a briefly missing landmark instead of instantly collapsing the body', () => {
    const visible = pose(0.5)
    const missing = pose(0.5)
    missing[15] = { ...missing[15], visibility: 0 }

    const frames = stabilizePoseFrames([{ poses: [visible] }, { poses: [missing] }])

    expect(frames[1].poses[0][15].visibility).toBeGreaterThan(0.5)
    expect(frames[1].poses[0][15].x).toBeCloseTo(visible[15].x)
  })

  it('smooths compact segmentation masks without changing their dimensions', () => {
    const first = new Uint8Array(16)
    first.fill(40)
    const second = new Uint8Array(16)
    second.fill(220)

    const frames = stabilizePoseFrames([
      { poses: [pose(0.5)], poseMasks: [{ width: 4, height: 4, alpha: first }] },
      { poses: [pose(0.5)], poseMasks: [{ width: 4, height: 4, alpha: second }] },
    ])

    expect(frames[1].poseMasks).toHaveLength(1)
    expect(frames[1].poseMasks?.[0].width).toBe(4)
    expect(frames[1].poseMasks?.[0].alpha[0]).toBeGreaterThan(40)
    expect(frames[1].poseMasks?.[0].alpha[0]).toBeLessThan(220)
  })
})
