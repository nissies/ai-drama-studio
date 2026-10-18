import { describe, expect, it } from 'vitest'
import {
  applyProjectVisualNegativeStyle,
  applyProjectVisualStyle,
  projectVideoStylePrompt,
  resolveVisualStyle,
  VISUAL_STYLE_PRESETS,
} from './production-visual-style'

describe('production visual style', () => {
  it('provides six stable project-level visual style choices', () => {
    expect(VISUAL_STYLE_PRESETS).toHaveLength(6)
    expect(new Set(VISUAL_STYLE_PRESETS.map((preset) => preset.id)).size).toBe(6)
    expect(VISUAL_STYLE_PRESETS.map((preset) => preset.label)).toEqual([
      '电影感半写实数字人',
      '精品 2.5D 动漫',
      '精致二维动画',
      '高级风格化 3D',
      '新国风动画',
      '萌系 Q 版动画',
    ])
  })

  it('maps legacy free-text styles to the closest maintained preset', () => {
    expect(resolveVisualStyle('电影感').id).toBe('CINEMATIC_DIGITAL_HUMAN')
    expect(resolveVisualStyle('3D 动画').id).toBe('STYLIZED_3D_ANIMATION')
    expect(resolveVisualStyle('二次元').id).toBe('CINEMATIC_2D_ANIMATION')
    expect(resolveVisualStyle('古风水墨').id).toBe('CHINESE_AESTHETIC_ANIMATION')
    expect(resolveVisualStyle(undefined).id).toBe('PREMIUM_2_5D_ANIMATION')
  })

  it('builds a fictional semi-real CG actor instead of copying a real person', () => {
    const result = applyProjectVisualStyle(
      '霜白长发，冰蓝眼睛，羽毛服装',
      'characters',
      'CINEMATIC_DIGITAL_HUMAN',
    )

    expect(result).toContain('高精度半写实 CG 角色与影视级建模质感')
    expect(result).toContain('轻微可见的自然微纹理')
    expect(result).toContain('不存在于现实中的虚构 CG 数字演员')
    expect(result).toContain('不得复刻任何具体真人、明星或公众人物')
    expect(result).not.toContain('精品 2.5D 动漫短剧')
  })

  it('keeps scene and storyboard requirements specific to their production purpose', () => {
    const scene = applyProjectVisualStyle('雨夜古城', 'scenes', 'CHINESE_AESTHETIC_ANIMATION')
    const storyboard = applyProjectVisualStyle(
      '角色推门进入',
      'storyboards',
      'STYLIZED_3D_ANIMATION',
    )

    expect(scene).toContain('画面是纯环境设定')
    expect(scene).toContain('不出现人物')
    expect(scene).toContain('水墨气韵')
    expect(storyboard).toContain('正式成片关键帧')
    expect(storyboard).toContain('高级风格化 3D 动画短剧')
  })

  it('does not duplicate policies when prompts are normalized or switched', () => {
    const once = applyProjectVisualStyle(
      '角色基础设定',
      'characters',
      'PREMIUM_2_5D_ANIMATION',
    )
    const twice = applyProjectVisualStyle(once, 'characters', 'PREMIUM_2_5D_ANIMATION')
    const switched = applyProjectVisualStyle(
      twice,
      'storyboards',
      'CINEMATIC_DIGITAL_HUMAN',
    )

    expect(twice).toBe(once)
    expect(switched.match(/项目视觉风格锁定/g)).toHaveLength(1)
    expect(switched).not.toContain('精品 2.5D 动漫短剧')
    expect(switched).not.toContain('角色资产制作要求')
    expect(switched).toContain('关键帧制作要求')
  })

  it('applies style-specific negative prompts without duplication', () => {
    const once = applyProjectVisualNegativeStyle(
      '多余手指',
      'characters',
      'CINEMATIC_DIGITAL_HUMAN',
    )
    const twice = applyProjectVisualNegativeStyle(
      once,
      'characters',
      'CINEMATIC_DIGITAL_HUMAN',
    )

    expect(twice).toBe(once)
    expect(once).toContain('真实照片复刻')
    expect(once).toContain('粗大毛孔')
    expect(once).toContain('服装结构不一致')
  })

  it('changes video rendering instructions with the project style', () => {
    const digitalHuman = projectVideoStylePrompt('CINEMATIC_DIGITAL_HUMAN')
    const chibi = projectVideoStylePrompt('CHIBI_ANIMATION')

    expect(digitalHuman).toContain('微纹理稳定的 CG 肤质')
    expect(chibi).toContain('头身比例')
    expect(chibi).not.toContain('电影感半写实数字人制式')
    expect(chibi).toContain('不得复刻任何具体真人、明星或公众人物')
  })
})
