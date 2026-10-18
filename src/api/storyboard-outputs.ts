import { request } from './client'

export type StoryboardOutputType =
  | 'KEYFRAME'
  | 'END_FRAME'
  | 'CONTACT_SHEET'
  | 'VIDEO'
  | 'VOICE'
  | 'BGM'
  | 'SFX'
  | 'COMPOSITE'

export interface StoryboardOutput {
  id: string
  projectId: string
  episodeId: string
  storyboardId: string
  outputType: StoryboardOutputType
  mediaAssetId: string
  sourceType?: 'IMAGE_CANDIDATE' | 'MEDIA_CANDIDATE' | 'MANUAL' | 'GENERATION_JOB' | null
  sourceId?: string | null
  version: number
  updatedAt: string
}

function episodePath(projectId: string, episodeId: string) {
  return `/projects/${encodeURIComponent(projectId)}/episodes/${encodeURIComponent(episodeId)}`
}

export const storyboardOutputApi = {
  list: (projectId: string, episodeId: string) =>
    request<StoryboardOutput[]>(`${episodePath(projectId, episodeId)}/storyboard-outputs`),
  set: (
    projectId: string,
    episodeId: string,
    storyboardId: string,
    input: {
      outputType: StoryboardOutputType
      mediaAssetId: string
      sourceType?: 'IMAGE_CANDIDATE' | 'MEDIA_CANDIDATE' | 'MANUAL' | 'GENERATION_JOB'
      sourceId?: string
      version?: number
    },
  ) =>
    request<StoryboardOutput>(
      `${episodePath(projectId, episodeId)}/storyboards/${encodeURIComponent(storyboardId)}/outputs`,
      { method: 'POST', body: JSON.stringify(input) },
    ),
  delete: (
    projectId: string,
    episodeId: string,
    storyboardId: string,
    outputType: StoryboardOutputType,
    version: number,
  ) =>
    request<void>(
      `${episodePath(projectId, episodeId)}/storyboards/${encodeURIComponent(storyboardId)}/outputs/${encodeURIComponent(outputType)}?version=${version}`,
      { method: 'DELETE' },
    ),
}
