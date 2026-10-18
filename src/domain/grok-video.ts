import type { GenerationRoute } from '../api/generation'

export type GrokVideoMode = 'TEXT_TO_VIDEO' | 'IMAGE_TO_VIDEO' | null

export interface GrokVideoReference {
  mediaType: 'IMAGE' | 'VIDEO' | 'AUDIO'
  purpose?: string | null
  automatic?: boolean
}

export function grokVideoMode(modelCode?: string | null): GrokVideoMode {
  const normalized = modelCode?.trim().toLowerCase()
  if (normalized === 'grok-imagine-video') return 'TEXT_TO_VIDEO'
  if (normalized === 'grok-imagine-video-1.5') return 'IMAGE_TO_VIDEO'
  return null
}

export function generationRouteModelCode(route: GenerationRoute): string {
  return route.sourceType === 'LOCAL'
    ? route.localModelName
    : (route.platformModelCode?.trim() || route.modelName?.trim() || '')
}

export function isGrokCompatibleRoute(route: GenerationRoute): boolean {
  if (route.sourceType === 'LOCAL') {
    return route.localProviderCode.trim().toUpperCase() === 'GROK'
  }
  return route.platformProtocolProfile?.trim().toUpperCase() === 'GROK_COMPATIBLE'
}

export function grokVideoReferenceError(
  mode: GrokVideoMode,
  references: GrokVideoReference[],
  requireImage = true,
): string | null {
  if (mode === 'TEXT_TO_VIDEO') {
    return references.some((reference) => !reference.automatic)
      ? 'grok-imagine-video 仅支持文生视频，请取消手动选择的参考素材'
      : null
  }
  if (mode !== 'IMAGE_TO_VIDEO') return null
  if (requireImage && !references.length) {
    return 'grok-imagine-video-1.5 仅支持图生视频，请至少选择一张参考图片'
  }
  if (references.some((reference) => reference.mediaType !== 'IMAGE')) {
    return 'grok-imagine-video-1.5 仅接受图片参考，不能发送视频或音频素材'
  }
  if (references.length > 7) {
    return 'grok-imagine-video-1.5 每次最多提交 7 张参考图片'
  }
  return null
}
