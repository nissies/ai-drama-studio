import { describe, expect, it } from 'vitest'
import { MOTION_SHOT_TEMPLATES, motionShotTemplateById } from './motion-shot-templates'

describe('motion-shot-templates', () => {
  it('includes core fight templates', () => {
    expect(MOTION_SHOT_TEMPLATES.length).toBeGreaterThanOrEqual(5)
    expect(motionShotTemplateById('GROUP_RUSH')?.title).toContain('群体')
    expect(motionShotTemplateById('DUAL_FIGHT')?.recommendedMode).toBe('pose_proxy')
  })
})