import type { StoryboardMediaReferencePurpose } from './storyboard-media-references'
import { normalizeImageFile } from '../utils/image-files'

export type BatchReferenceMediaType = 'IMAGE' | 'VIDEO' | 'AUDIO'
export type BatchReferenceBindingType =
  | 'CHARACTER'
  | 'SCENE'
  | 'BACKGROUND'
  | 'PROP'
  | 'WEAPON'
  | 'MOTION'
  | 'VOICE'
  | 'SFX'
  | 'STYLE'

export interface BatchVideoReferenceDraft {
  id: string
  file: File
  previewUrl: string
  mediaType: BatchReferenceMediaType
  source: 'PROJECT' | 'UPLOAD'
  assetId?: string
  label: string
  selected: boolean
  bindingType?: BatchReferenceBindingType
  bindingTargetId?: string
  purpose?: StoryboardMediaReferencePurpose
  usageNote: string
}

export interface BatchVideoReferenceDescriptor {
  mediaType: BatchReferenceMediaType
  label: string
  bindingLabel?: string
  purpose?: StoryboardMediaReferencePurpose
  usageNote?: string
}

export const MAX_BATCH_REFERENCE_FILES = 20
export const MAX_BATCH_IMAGE_REFERENCE_BYTES = 10 * 1024 * 1024
export const MAX_BATCH_MEDIA_REFERENCE_BYTES = 50 * 1024 * 1024
export const MAX_BATCH_REFERENCE_TOTAL_BYTES = 100 * 1024 * 1024

const SUPPORTED_VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime'])
const SUPPORTED_AUDIO_TYPES = new Set([
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/aac',
  'audio/mp4',
  'audio/ogg',
  'audio/flac',
])
const MIME_BY_EXTENSION = new Map<string, string>([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.mov', 'video/quicktime'],
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.aac', 'audio/aac'],
  ['.m4a', 'audio/mp4'],
  ['.ogg', 'audio/ogg'],
  ['.flac', 'audio/flac'],
])

export async function normalizeBatchReferenceFile(file: File) {
  const mimeType = inferBatchReferenceMimeType(file)
  const mediaType = batchReferenceMediaType(mimeType)
  if (mediaType === 'IMAGE') {
    return {
      file: (await normalizeImageFile(file, MAX_BATCH_IMAGE_REFERENCE_BYTES)).file,
      mediaType,
    }
  }
  if (file.size <= 0 || file.size > MAX_BATCH_MEDIA_REFERENCE_BYTES) {
    throw new Error('单个视频或音频参考必须小于 50MB')
  }
  return {
    file:
      file.type === mimeType
        ? file
        : new File([file], file.name, { type: mimeType, lastModified: file.lastModified }),
    mediaType,
  }
}

export function inferBatchReferenceMimeType(file: File) {
  const declared = file.type.split(';', 1)[0].trim().toLowerCase()
  if (isSupportedBatchReferenceMimeType(declared)) return declared
  const extension = file.name.match(/\.[^.]+$/)?.[0]?.toLowerCase() ?? ''
  const inferred = MIME_BY_EXTENSION.get(extension)
  if (inferred && isSupportedBatchReferenceMimeType(inferred)) return inferred
  throw new Error('仅支持 PNG/JPEG/WebP 图片、MP4/WebM/MOV 视频和常见音频格式')
}

export function batchReferenceMediaType(mimeType: string): BatchReferenceMediaType {
  if (mimeType.startsWith('image/')) return 'IMAGE'
  if (SUPPORTED_VIDEO_TYPES.has(mimeType)) return 'VIDEO'
  if (SUPPORTED_AUDIO_TYPES.has(mimeType)) return 'AUDIO'
  throw new Error('参考素材类型无效')
}

export function isSupportedBatchReferenceMimeType(value: string) {
  return (
    value === 'image/png' ||
    value === 'image/jpeg' ||
    value === 'image/webp' ||
    SUPPORTED_VIDEO_TYPES.has(value) ||
    SUPPORTED_AUDIO_TYPES.has(value)
  )
}

export function cleanBatchReferenceLabel(filename: string) {
  return (
    filename
      .replace(/\.[^.]+$/, '')
      .replace(/[_-]+/g, ' ')
      .trim() || '补充参考素材'
  )
}

export function batchReferencePurposeLabel(purpose?: StoryboardMediaReferencePurpose) {
  if (purpose === 'FIRST_FRAME') return '首帧参考'
  if (purpose === 'END_FRAME') return '尾帧参考'
  if (purpose === 'CONTINUITY') return '连续性参考'
  if (purpose === 'VOICE_IDENTITY') return '角色声音参考'
  if (purpose === 'BACKGROUND_AUDIO') return '背景声音参考'
  if (purpose === 'MOTION_REFERENCE') return '动作参考'
  if (purpose === 'POSE_PROXY') return '姿态代理'
  return ''
}

export function batchReferenceTypeLabel(mediaType: BatchReferenceMediaType) {
  if (mediaType === 'IMAGE') return '图片'
  if (mediaType === 'VIDEO') return '视频'
  return '音频'
}

export function needsLocalPoseProxy(
  item: Pick<BatchVideoReferenceDescriptor, 'mediaType' | 'label' | 'purpose'>,
) {
  if (item.mediaType !== 'VIDEO' || item.purpose !== 'MOTION_REFERENCE') return false
  return !/pose[\s_-]*proxy|姿态代理|人物轮廓/i.test(item.label)
}

export function buildBatchReferenceInstructions(items: BatchVideoReferenceDescriptor[]) {
  if (!items.length) return ''
  const lines = ['参考素材对应关系：']
  for (const mediaType of ['IMAGE', 'VIDEO', 'AUDIO'] as const) {
    items
      .filter((item) => item.mediaType === mediaType)
      .forEach((item, index) => {
        const purpose = batchReferencePurposeLabel(item.purpose)
        const details = [purpose, item.bindingLabel].filter(Boolean).join(' · ')
        const usage = item.usageNote?.trim()
        lines.push(
          `${batchReferenceTypeLabel(mediaType)}${index + 1}：${item.label}${details ? `（${details}）` : ''}${usage ? `；用途说明：${usage}` : ''}`,
        )
      })
  }
  lines.push(
    '生成要求：严格按上述对应关系理解素材。角色图只约束对应角色身份与外观，场景图只约束空间、光线和陈设；动作视频只约束动作轨迹、节奏和运镜；声音素材只用于已说明的角色音色或环境声音，不得混用。',
  )
  return lines.join('\n')
}
