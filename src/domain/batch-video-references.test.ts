import { describe, expect, it } from 'vitest'
import {
  batchReferenceMediaType,
  buildBatchReferenceInstructions,
  cleanBatchReferenceLabel,
  inferBatchReferenceMimeType,
  needsLocalPoseProxy,
} from './batch-video-references'

describe('batch video references', () => {
  it('infers supported media types from MIME or extension', () => {
    expect(inferBatchReferenceMimeType(new File(['x'], 'hero.PNG', { type: 'image/png' }))).toBe(
      'image/png',
    )
    expect(inferBatchReferenceMimeType(new File(['x'], 'motion.mov'))).toBe('video/quicktime')
    expect(batchReferenceMediaType('audio/mpeg')).toBe('AUDIO')
  })

  it('builds explicit reference instructions in provider order', () => {
    const prompt = buildBatchReferenceInstructions([
      {
        mediaType: 'IMAGE',
        label: '许七安基础图',
        bindingLabel: '角色：许七安',
        usageNote: '保持脸、服装和体型一致',
      },
      {
        mediaType: 'VIDEO',
        label: '翻越栏杆动作',
        purpose: 'MOTION_REFERENCE',
        usageNote: '只参考动作轨迹和节奏',
      },
    ])

    expect(prompt).toContain('图片1：许七安基础图（角色：许七安）')
    expect(prompt).toContain('视频1：翻越栏杆动作（动作参考）')
    expect(prompt).toContain('不得混用')
  })

  it('turns filenames into readable labels', () => {
    expect(cleanBatchReferenceLabel('hero_sword-reference.png')).toBe('hero sword reference')
  })

  it('converts only raw motion videos to a local pose proxy', () => {
    expect(
      needsLocalPoseProxy({
        mediaType: 'VIDEO',
        label: '翻越栏杆动作',
        purpose: 'MOTION_REFERENCE',
      }),
    ).toBe(true)
    expect(
      needsLocalPoseProxy({
        mediaType: 'VIDEO',
        label: '人物轮廓姿态代理',
        purpose: 'MOTION_REFERENCE',
      }),
    ).toBe(false)
    expect(
      needsLocalPoseProxy({
        mediaType: 'IMAGE',
        label: '动作关键帧',
        purpose: 'MOTION_REFERENCE',
      }),
    ).toBe(false)
  })
})
