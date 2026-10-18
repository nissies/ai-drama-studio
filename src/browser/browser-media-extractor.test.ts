import { describe, expect, it } from 'vitest'
import { encodePcmWav } from './browser-media-extractor'

describe('browser media extractor', () => {
  it('encodes mono PCM samples as a valid wav blob', async () => {
    const audioBuffer = {
      sampleRate: 24_000,
      getChannelData: () => new Float32Array([-1, -0.5, 0, 0.5, 1]),
    } as AudioBuffer

    const blob = encodePcmWav(audioBuffer)
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const text = (offset: number, length: number) =>
      String.fromCharCode(...bytes.slice(offset, offset + length))

    expect(blob.type).toBe('audio/wav')
    expect(blob.size).toBe(54)
    expect(text(0, 4)).toBe('RIFF')
    expect(text(8, 4)).toBe('WAVE')
    expect(text(36, 4)).toBe('data')
  })
})
