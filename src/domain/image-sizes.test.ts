import { describe, expect, it } from 'vitest'
import { IMAGE_SIZE_OPTIONS, isImageSize } from './image-sizes'

describe('image sizes', () => {
  it('includes exact vertical and horizontal short-video ratios', () => {
    expect(IMAGE_SIZE_OPTIONS).toContainEqual({ value: '1152x2048', label: '竖屏 9:16' })
    expect(IMAGE_SIZE_OPTIONS).toContainEqual({ value: '2048x1152', label: '横屏 16:9' })
    expect(IMAGE_SIZE_OPTIONS).toContainEqual({ value: '1728x2304', label: '竖版 3:4' })
    expect(IMAGE_SIZE_OPTIONS).toContainEqual({ value: '2304x1728', label: '横版 4:3' })
    expect(isImageSize('1152x2048')).toBe(true)
    expect(isImageSize('1920x1080')).toBe(false)
  })
})
