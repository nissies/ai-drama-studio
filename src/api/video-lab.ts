import { request } from './client'

export interface VideoLabBootstrap {
  projectId: string
  projectTitle: string
  episodeId: string
  episodeTitle: string
  storyboardId: string
  storyboardTitle: string
}

export const videoLabApi = {
  bootstrap: () => request<VideoLabBootstrap>('/video-lab/bootstrap'),
}
