import { describe, expect, it } from 'vitest'
import {
  applyCharacterReferencePreset,
  applyCharacterNegativePreset,
  CHARACTER_COMPOSITION_OPTIONS,
  defaultCharacterDesignTier,
  defaultImageComposition,
  recommendedImageSize,
  referenceViewType,
} from './character-reference-presets'

describe('character reference presets', () => {
  it('exposes only turnaround portrait and full character sheet in the UI options', () => {
    expect(CHARACTER_COMPOSITION_OPTIONS.map((item) => item.value)).toEqual([
      'TURNAROUND_PORTRAIT',
      'CHARACTER_SHEET',
    ])
    expect(defaultImageComposition('characters')).toBe('TURNAROUND_PORTRAIT')
    expect(defaultImageComposition('scenes')).toBe('SINGLE')
  })

  it('keeps the original prompt and does not duplicate preset instructions', () => {
    const original = '黑色短发，蓝色眼睛，红色发卡'
    const portrait = applyCharacterReferencePreset(original, 'TURNAROUND_PORTRAIT')
    expect(portrait).toContain(original)
    expect(portrait).toContain('左侧区域')
    expect(portrait).toContain('右侧区域')
    expect(portrait).toContain('正面上半身近景')
    expect(portrait.match(/创建一张电影感、高级角色艺术书风格的角色身份板/g)).toHaveLength(1)
    expect(portrait.match(/角色设计深化要求/g)).toHaveLength(1)
    expect(applyCharacterReferencePreset(portrait, 'TURNAROUND_PORTRAIT')).toBe(portrait)

    const sheet = applyCharacterReferencePreset(portrait, 'CHARACTER_SHEET')
    expect(sheet).toContain(original)
    expect(sheet).toContain('完整设定板')
    expect(sheet).toContain('服装与饰品')
    expect(sheet).toContain('表情情绪')
    expect(sheet).not.toContain('左侧区域（约占画布 40%-45%）')
    expect(sheet.match(/角色设计深化要求/g)).toHaveLength(1)

    const single = applyCharacterReferencePreset(sheet, 'SINGLE')
    expect(single).toContain(original)
    expect(single).not.toContain('完整设定板')
    expect(single.match(/角色设计深化要求/g)).toHaveLength(1)
    expect(applyCharacterReferencePreset(single, 'SINGLE')).toBe(single)
  })

  it('places upper-body closeup on the left for turnaround portrait', () => {
    const prompt = applyCharacterReferencePreset('年轻女特工', 'TURNAROUND_PORTRAIT')
    const leftIndex = prompt.indexOf('左侧区域')
    const rightIndex = prompt.indexOf('右侧区域')
    const closeupIndex = prompt.indexOf('正面上半身近景')
    const frontIndex = prompt.indexOf('正面全身')
    expect(leftIndex).toBeGreaterThan(-1)
    expect(rightIndex).toBeGreaterThan(leftIndex)
    expect(closeupIndex).toBeGreaterThan(leftIndex)
    expect(closeupIndex).toBeLessThan(rightIndex)
    expect(frontIndex).toBeGreaterThan(rightIndex)
  })

  it('maps presets to a stable size and reference purpose', () => {
    expect(recommendedImageSize('SINGLE')).toBe('1152x2048')
    expect(recommendedImageSize('TURNAROUND')).toBe('2048x1152')
    expect(recommendedImageSize('TURNAROUND_PORTRAIT')).toBe('2048x1152')
    expect(recommendedImageSize('CHARACTER_SHEET')).toBe('2048x1152')
    expect(referenceViewType('SINGLE')).toBe('FRONT')
    expect(referenceViewType('TURNAROUND')).toBe('TURNAROUND')
    expect(referenceViewType('TURNAROUND_PORTRAIT')).toBe('TURNAROUND_PORTRAIT')
    expect(referenceViewType('CHARACTER_SHEET')).toBe('CHARACTER_SHEET')
  })

  it('always applies lead-character quality regardless of role type', () => {
    const result = applyCharacterReferencePreset(
      '年轻女天气预报员，神情警觉',
      'TURNAROUND_PORTRAIT',
    )
    const negative = applyCharacterNegativePreset('模糊, 低质量')

    expect(result).toContain('角色精修标准')
    expect(result).toContain('商业短剧主角级')
    expect(result).toContain('左侧区域')
    expect(result).toContain('不得复刻具体真人、明星、公众人物或网红')
    expect(negative).toContain('忽略参考图')
    expect(defaultCharacterDesignTier('主要角色')).toBe('LEAD')
    expect(defaultCharacterDesignTier('配角')).toBe('LEAD')
    expect(defaultCharacterDesignTier('路人')).toBe('LEAD')
  })

  it('adds a stronger reference lock when reference images are present', () => {
    const withoutRef = applyCharacterReferencePreset('红衣少女', 'CHARACTER_SHEET')
    const withRef = applyCharacterReferencePreset('红衣少女', 'CHARACTER_SHEET', undefined, {
      hasReferenceImages: true,
    })
    expect(withRef).toContain('请严格参考我提供的参考图')
    expect(withRef).toContain(withoutRef.split('\n\n')[0])
    expect(withRef.length).toBeGreaterThan(withoutRef.length)
  })
})
