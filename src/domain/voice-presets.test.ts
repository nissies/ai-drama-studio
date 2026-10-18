import { describe, expect, it } from 'vitest'
import { DEFAULT_VOICE_PRESET, isVoicePreset, voicePresetLabel } from './voice-presets'

describe('voice presets', () => {
  it('provides a provider-independent default', () => {
    expect(isVoicePreset(DEFAULT_VOICE_PRESET)).toBe(true)
    expect(voicePresetLabel(DEFAULT_VOICE_PRESET)).toBe('自然均衡声线')
  })

  it('keeps legacy custom voice ids recognizable without exposing them as a preset', () => {
    expect(isVoicePreset('voice-character-001')).toBe(false)
    expect(voicePresetLabel('voice-character-001')).toBe('已保存专属音色')
  })
})
