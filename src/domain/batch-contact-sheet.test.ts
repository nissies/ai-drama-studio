import { describe, expect, it } from 'vitest'
import type { Storyboard } from '../api/workspace'
import {
  buildContactSheetImagePrompt,
  contactSheetRecommended,
  contactSheetTimeline,
  contactSheetTimelineInstruction,
  hasNineContactSheetBeats,
  normalizeContactSheetPlan,
} from './batch-contact-sheet'

const storyboard = { durationSec: 15 } as Storyboard

describe('batch contact sheet', () => {
  it('builds a strict continuous 3x3 image prompt', () => {
    const prompt = buildContactSheetImagePrompt(storyboard, '1. 0-2秒｜远景｜角色入场｜庭院｜推镜')
    expect(prompt).toContain('3 列 x 3 行')
    expect(prompt).toContain('同一个连续视频镜头')
    expect(prompt).toContain('目标视频时长：15 秒')
    expect(prompt).toContain('禁止标题、数字、水印')
  })

  it('recommends contact sheets for long shots', () => {
    expect(contactSheetRecommended(storyboard)).toBe(true)
    expect(contactSheetRecommended({ durationSec: 8 } as Storyboard)).toBe(false)
  })

  it('requires all nine numbered beats', () => {
    const complete = Array.from({ length: 9 }, (_, index) => `${index + 1}. 节点`).join('\n')
    expect(hasNineContactSheetBeats(complete)).toBe(true)
    expect(hasNineContactSheetBeats(complete.replace('9. 节点', ''))).toBe(false)
  })

  it('maps nine cells across the complete video duration', () => {
    const timeline = contactSheetTimeline(15)
    expect(timeline).toHaveLength(9)
    expect(timeline[0]).toMatchObject({ cell: 1, start: 0 })
    expect(timeline[8]).toMatchObject({ cell: 9, end: 15 })
    expect(contactSheetTimelineInstruction(15)).toContain('第 1 格=0-1.7 秒')
    expect(contactSheetTimelineInstruction(15)).toContain('第 9 格=13.3-15 秒')
  })

  it('normalizes model time ranges to the deterministic complete video timeline', () => {
    const modelPlan = [
      '1. 0-1.7 秒｜远景',
      '2. 1.8-3.2 秒｜中景',
      '3. 3.6-5 秒｜近景',
      '4. 5-6.7 秒｜侧面',
      '5. 6.7-8.3 秒｜特写',
      '6. 8.3-10 秒｜反打',
      '7. 10-11.7 秒｜跟拍',
      '8. 11.7-13.3 秒｜俯拍',
      '9. 13.3-14 秒｜收束',
    ].join('\n')
    const normalized = normalizeContactSheetPlan(modelPlan, 15)
    expect(normalized).toContain('1. 0-1.7 秒｜远景')
    expect(normalized).toContain('2. 1.7-3.3 秒｜中景')
    expect(normalized).toContain('9. 13.3-15 秒｜收束')
    expect(hasNineContactSheetBeats(modelPlan, 15)).toBe(true)
  })

  it('accepts common cell labels but rejects missing or duplicate cells', () => {
    const flexible = Array.from(
      { length: 9 },
      (_, index) => `第 ${index + 1} 格：画面动作 ${index + 1}`,
    ).join('；')
    expect(normalizeContactSheetPlan(flexible, 12)).toContain('9. 10.7-12 秒｜画面动作 9')
    expect(normalizeContactSheetPlan(flexible.replace('第 9 格', '第 8 格'), 12)).toBeNull()
    expect(normalizeContactSheetPlan(flexible.replace('；第 9 格：画面动作 9', ''), 12)).toBeNull()
  })
})
