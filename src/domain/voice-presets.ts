export const DEFAULT_VOICE_PRESET = 'preset:neutral_balanced'

export const VOICE_PRESETS = [
  { value: DEFAULT_VOICE_PRESET, label: '自然均衡声线', description: '通用对白，语气自然稳定' },
  {
    value: 'preset:female_young_bright',
    label: '清甜年轻女声',
    description: '明亮灵动，适合少女和年轻角色',
  },
  {
    value: 'preset:female_calm_gentle',
    label: '温柔沉静女声',
    description: '柔和克制，适合内心独白和情感戏',
  },
  {
    value: 'preset:female_mature_confident',
    label: '成熟自信女声',
    description: '稳重有力量，适合成熟女性角色',
  },
  {
    value: 'preset:male_young_clear',
    label: '清亮青年男声',
    description: '清晰自然，适合年轻男性角色',
  },
  {
    value: 'preset:male_calm_professional',
    label: '沉稳青年男声',
    description: '理性克制，适合可靠或冷静角色',
  },
  {
    value: 'preset:male_deep_powerful',
    label: '低沉有力男声',
    description: '厚重坚定，适合强势或成熟角色',
  },
  {
    value: 'preset:narration_warm',
    label: '温暖旁白声',
    description: '叙述感清楚，适合旁白和剧情解说',
  },
] as const

export function isVoicePreset(value?: string | null) {
  return Boolean(value && VOICE_PRESETS.some((preset) => preset.value === value))
}

export function voicePresetLabel(value?: string | null) {
  if (!value) return '跟随配音模型默认音色'
  return VOICE_PRESETS.find((preset) => preset.value === value)?.label ?? '已保存专属音色'
}
