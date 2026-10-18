export const PROJECT_ASPECT_RATIO_OPTIONS = [
  { value: 'UNSET', label: '未设置比例' },
  { value: '9:16', label: '竖屏 9:16' },
  { value: '16:9', label: '横屏 16:9' },
  { value: '1:1', label: '方形 1:1' },
  { value: '4:3', label: '横版 4:3' },
  { value: '3:4', label: '竖版 3:4' },
] as const

export type ProjectAspectRatio = (typeof PROJECT_ASPECT_RATIO_OPTIONS)[number]['value']

export function projectAspectRatioLabel(value?: string) {
  return (
    PROJECT_ASPECT_RATIO_OPTIONS.find((option) => option.value === value)?.label ?? '未设置比例'
  )
}
