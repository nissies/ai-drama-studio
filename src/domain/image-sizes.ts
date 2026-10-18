export const IMAGE_SIZE_OPTIONS = [
  { value: '1152x2048', label: '竖屏 9:16' },
  { value: '1024x1024', label: '方形 1:1' },
  { value: '2048x1152', label: '横屏 16:9' },
  { value: '1728x2304', label: '竖版 3:4' },
  { value: '2304x1728', label: '横版 4:3' },
  { value: '1024x1536', label: '竖版 2:3' },
  { value: '1536x1024', label: '横版 3:2' },
] as const

export type ImageSize = (typeof IMAGE_SIZE_OPTIONS)[number]['value']

export function isImageSize(value: unknown): value is ImageSize {
  return IMAGE_SIZE_OPTIONS.some((option) => option.value === value)
}
