import { describe, expect, it } from 'vitest'
import { detectImageMimeType, normalizeImageFile } from './image-files'

describe('image file normalization', () => {
  it('corrects a JPEG file mislabeled with a PNG name and MIME type', async () => {
    const file = new File(
      [new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])],
      'reference.png',
      { type: 'image/png' },
    )

    const result = await normalizeImageFile(file, 1024)

    expect(result.corrected).toBe(true)
    expect(result.file.name).toBe('reference.jpg')
    expect(result.file.type).toBe('image/jpeg')
    expect(await detectImageMimeType(result.file)).toBe('image/jpeg')
  })

  it('rejects content that is not a supported image', async () => {
    const file = new File([new TextEncoder().encode('{"error":true}')], 'error.png', {
      type: 'image/png',
    })

    await expect(normalizeImageFile(file, 1024)).rejects.toThrow('不是有效的')
  })
})
