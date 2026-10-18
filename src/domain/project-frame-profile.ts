import type { ImageSize } from './image-sizes'
import type { ProjectAspectRatio } from './project-aspect-ratios'

export type EffectiveProjectAspectRatio = Exclude<ProjectAspectRatio, 'UNSET'>

export interface ProjectFrameProfile {
  aspectRatio: EffectiveProjectAspectRatio
  label: string
  imageSize: ImageSize
  videoSize: string
  exportWidth: number
  exportHeight: number
  cssAspectRatio: string
  previewMaxWidth: string
}

const FRAME_PROFILES: Record<EffectiveProjectAspectRatio, ProjectFrameProfile> = {
  '9:16': {
    aspectRatio: '9:16',
    label: '竖屏 9:16',
    imageSize: '1152x2048',
    videoSize: '720x1280',
    exportWidth: 1080,
    exportHeight: 1920,
    cssAspectRatio: '9 / 16',
    previewMaxWidth: '206px',
  },
  '16:9': {
    aspectRatio: '16:9',
    label: '横屏 16:9',
    imageSize: '2048x1152',
    videoSize: '1280x720',
    exportWidth: 1920,
    exportHeight: 1080,
    cssAspectRatio: '16 / 9',
    previewMaxWidth: '320px',
  },
  '1:1': {
    aspectRatio: '1:1',
    label: '方形 1:1',
    imageSize: '1024x1024',
    videoSize: '1024x1024',
    exportWidth: 1440,
    exportHeight: 1440,
    cssAspectRatio: '1 / 1',
    previewMaxWidth: '280px',
  },
  '4:3': {
    aspectRatio: '4:3',
    label: '横版 4:3',
    imageSize: '2304x1728',
    videoSize: '1280x960',
    exportWidth: 1920,
    exportHeight: 1440,
    cssAspectRatio: '4 / 3',
    previewMaxWidth: '320px',
  },
  '3:4': {
    aspectRatio: '3:4',
    label: '竖版 3:4',
    imageSize: '1728x2304',
    videoSize: '960x1280',
    exportWidth: 1440,
    exportHeight: 1920,
    cssAspectRatio: '3 / 4',
    previewMaxWidth: '240px',
  },
}

export function projectFrameProfile(aspectRatio?: ProjectAspectRatio): ProjectFrameProfile {
  return FRAME_PROFILES[aspectRatio && aspectRatio !== 'UNSET' ? aspectRatio : '9:16']
}
