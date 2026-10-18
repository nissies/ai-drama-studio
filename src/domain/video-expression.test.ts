import { describe, expect, it } from 'vitest'
import { buildExpressionPrompt, normalizeAiExpression } from './video-expression'

describe('video expression prompt', () => {
  it('turns an emotion into executable facial parameters', () => {
    const prompt = buildExpressionPrompt({
      emotion: 'RESTRAINED_ANGER',
      intensity: 4,
      gaze: 'LOCK_TARGET',
      performanceNote: '说话前停顿半秒，鼻翼随呼吸轻微起伏',
    })

    expect(prompt).toContain('眉头内收')
    expect(prompt).toContain('强度 4/5')
    expect(prompt).toContain('目光持续锁定对方')
    expect(prompt).toContain('鼻翼随呼吸轻微起伏')
    expect(prompt).toContain('保持角色身份')
  })

  it('clamps intensity and removes model formatting', () => {
    expect(
      buildExpressionPrompt({
        emotion: 'CUSTOM',
        intensity: 99,
        gaze: 'CAMERA',
      }),
    ).toContain('强度 5/5')
    expect(normalizeAiExpression('```text\n表情提示词：眉头轻压   嘴唇闭合\n```')).toBe(
      '眉头轻压 嘴唇闭合',
    )
  })
})
