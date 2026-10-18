import { describe, expect, it } from 'vitest'
import { buildProjectPayload } from './project-payload'

describe('buildProjectPayload', () => {
  it('trims values and removes blank optional fields', () => {
    expect(
      buildProjectPayload({ title: '  第一部短剧  ', description: '   ', visualStyle: ' 3D动画 ' }),
    ).toEqual({
      title: '第一部短剧',
      description: undefined,
      visualStyle: '3D动画',
      aspectRatio: 'UNSET',
    })
  })
})
