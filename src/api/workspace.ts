import { request } from './client'

export interface Episode {
  id: string
  projectId: string
  episodeNo: number
  title: string
  synopsis?: string
  scriptText?: string
  targetDurationSec: number
  status: string
  version: number
  updatedAt: string
}

export interface EpisodeInput {
  title: string
  synopsis?: string
  scriptText?: string
  targetDurationSec: number
  version?: number
}

export interface EpisodeBatchDeleteResult {
  deletedCount: number
}

export type CharacterFormCategory = 'APPEARANCE' | 'COSTUME' | 'WEAPON'

export interface CharacterForm {
  id: string
  formCode: string
  formCategory: CharacterFormCategory
  displayName: string
  appearancePrompt?: string
  negativePrompt?: string
  defaultForm: boolean
}

export interface CharacterAsset {
  id: string
  projectId: string
  name: string
  roleType?: string
  description?: string
  identityPrompt?: string
  negativePrompt?: string
  voiceDescription?: string
  ttsVoiceId?: string
  status: string
  version: number
  forms: CharacterForm[]
  updatedAt: string
}

export interface CharacterInput {
  name: string
  roleType?: string
  description?: string
  identityPrompt?: string
  negativePrompt?: string
  voiceDescription?: string
  ttsVoiceId?: string
  version?: number
}

export interface CharacterFormInput {
  formCategory: CharacterFormCategory
  displayName: string
  appearancePrompt?: string
  negativePrompt?: string
  defaultForm: boolean
}

export interface Scene {
  id: string
  projectId: string
  episodeId: string
  sceneNo: number
  title: string
  location?: string
  timeOfDay?: string
  description?: string
  environmentPrompt?: string
  status: string
  version: number
  updatedAt: string
}

export interface SceneInput {
  title: string
  location?: string
  timeOfDay?: string
  description?: string
  environmentPrompt?: string
  version?: number
}

export type StoryboardReviewStatus = 'PENDING' | 'APPROVED' | 'CHANGES_REQUESTED'
export type StoryboardAudioMode = 'AI_DUB' | 'VIDEO_NATIVE'

export interface Storyboard {
  id: string
  projectId: string
  episodeId: string
  sceneId?: string
  characterIds: string[]
  shotNo: number
  title: string
  shotType?: string
  angle?: string
  movement?: string
  location?: string
  timeOfDay?: string
  actionText?: string
  dialogue?: string
  innerMonologue?: string
  audioMode: StoryboardAudioMode
  speakerCharacterId?: string
  description?: string
  resultText?: string
  atmosphere?: string
  imagePrompt?: string
  videoPrompt?: string
  finalVideoPrompt?: string
  bgmPrompt?: string
  soundEffect?: string
  durationSec: number
  reviewStatus: StoryboardReviewStatus
  reviewNote?: string
  status: string
  version: number
  updatedAt: string
}

export interface StoryboardInput {
  title: string
  sceneId?: string
  characterIds: string[]
  shotType?: string
  angle?: string
  movement?: string
  location?: string
  timeOfDay?: string
  actionText?: string
  dialogue?: string
  innerMonologue?: string
  audioMode: StoryboardAudioMode
  speakerCharacterId?: string
  description?: string
  resultText?: string
  atmosphere?: string
  imagePrompt?: string
  videoPrompt?: string
  bgmPrompt?: string
  soundEffect?: string
  durationSec: number
  version?: number
}

export interface StoryboardBatchDeleteResult {
  deletedCount: number
}

export interface StoryboardBatchAudioModeResult {
  updatedCount: number
  audioMode: StoryboardAudioMode
}

function projectPath(projectId: string) {
  return `/projects/${encodeURIComponent(projectId)}`
}

function episodePath(projectId: string, episodeId: string) {
  return `${projectPath(projectId)}/episodes/${encodeURIComponent(episodeId)}`
}

export const episodeApi = {
  list: (projectId: string) => request<Episode[]>(`${projectPath(projectId)}/episodes`),
  create: (projectId: string, input: EpisodeInput) =>
    request<Episode>(`${projectPath(projectId)}/episodes`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  update: (projectId: string, episodeId: string, input: EpisodeInput) =>
    request<Episode>(episodePath(projectId, episodeId), {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  delete: (projectId: string, episodeId: string) =>
    request<void>(episodePath(projectId, episodeId), { method: 'DELETE' }),
  batchDelete: (projectId: string, episodeIds: string[]) =>
    request<EpisodeBatchDeleteResult>(`${projectPath(projectId)}/episodes/batch-delete`, {
      method: 'POST',
      body: JSON.stringify({ episodeIds }),
    }),
}

export const characterApi = {
  list: (projectId: string) => request<CharacterAsset[]>(`${projectPath(projectId)}/characters`),
  create: (projectId: string, input: CharacterInput) =>
    request<CharacterAsset>(`${projectPath(projectId)}/characters`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  update: (projectId: string, characterId: string, input: CharacterInput) =>
    request<CharacterAsset>(
      `${projectPath(projectId)}/characters/${encodeURIComponent(characterId)}`,
      { method: 'PUT', body: JSON.stringify(input) },
    ),
  delete: (projectId: string, characterId: string) =>
    request<void>(`${projectPath(projectId)}/characters/${encodeURIComponent(characterId)}`, {
      method: 'DELETE',
    }),
  createForm: (projectId: string, characterId: string, input: CharacterFormInput) =>
    request<CharacterForm>(
      `${projectPath(projectId)}/characters/${encodeURIComponent(characterId)}/forms`,
      { method: 'POST', body: JSON.stringify(input) },
    ),
  updateForm: (projectId: string, characterId: string, formId: string, input: CharacterFormInput) =>
    request<CharacterForm>(
      `${projectPath(projectId)}/characters/${encodeURIComponent(characterId)}/forms/${encodeURIComponent(formId)}`,
      { method: 'PUT', body: JSON.stringify(input) },
    ),
  deleteForm: (projectId: string, characterId: string, formId: string) =>
    request<void>(
      `${projectPath(projectId)}/characters/${encodeURIComponent(characterId)}/forms/${encodeURIComponent(formId)}`,
      { method: 'DELETE' },
    ),
}

export const sceneApi = {
  list: (projectId: string, episodeId: string) =>
    request<Scene[]>(`${episodePath(projectId, episodeId)}/scenes`),
  create: (projectId: string, episodeId: string, input: SceneInput) =>
    request<Scene>(`${episodePath(projectId, episodeId)}/scenes`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  update: (projectId: string, episodeId: string, sceneId: string, input: SceneInput) =>
    request<Scene>(`${episodePath(projectId, episodeId)}/scenes/${encodeURIComponent(sceneId)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  delete: (projectId: string, episodeId: string, sceneId: string) =>
    request<void>(`${episodePath(projectId, episodeId)}/scenes/${encodeURIComponent(sceneId)}`, {
      method: 'DELETE',
    }),
}

export const storyboardApi = {
  list: (projectId: string, episodeId: string) =>
    request<Storyboard[]>(`${episodePath(projectId, episodeId)}/storyboards`),
  create: (projectId: string, episodeId: string, input: StoryboardInput) =>
    request<Storyboard>(`${episodePath(projectId, episodeId)}/storyboards`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  update: (projectId: string, episodeId: string, storyboardId: string, input: StoryboardInput) =>
    request<Storyboard>(
      `${episodePath(projectId, episodeId)}/storyboards/${encodeURIComponent(storyboardId)}`,
      { method: 'PUT', body: JSON.stringify(input) },
    ),
  updateFinalVideoPrompt: (
    projectId: string,
    episodeId: string,
    storyboardId: string,
    input: { finalVideoPrompt?: string | null; version: number },
  ) =>
    request<Storyboard>(
      `${episodePath(projectId, episodeId)}/storyboards/${encodeURIComponent(storyboardId)}/final-video-prompt`,
      { method: 'PUT', body: JSON.stringify(input) },
    ),
  reorder: (projectId: string, episodeId: string, storyboards: Storyboard[]) =>
    request<Storyboard[]>(`${episodePath(projectId, episodeId)}/storyboards/reorder`, {
      method: 'PUT',
      body: JSON.stringify({
        items: storyboards.map(({ id, version }) => ({ id, version })),
      }),
    }),
  updateAudioModeBatch: (
    projectId: string,
    episodeId: string,
    storyboards: Storyboard[],
    audioMode: StoryboardAudioMode,
  ) =>
    request<StoryboardBatchAudioModeResult>(
      `${episodePath(projectId, episodeId)}/storyboards/batch-audio-mode`,
      {
        method: 'PUT',
        body: JSON.stringify({
          audioMode,
          items: storyboards.map(({ id, version }) => ({ id, version })),
        }),
      },
    ),
  review: (
    projectId: string,
    episodeId: string,
    storyboardId: string,
    input: {
      reviewStatus: Exclude<StoryboardReviewStatus, 'PENDING'>
      reviewNote?: string
      version: number
    },
  ) =>
    request<Storyboard>(
      `${episodePath(projectId, episodeId)}/storyboards/${encodeURIComponent(storyboardId)}/review`,
      { method: 'PUT', body: JSON.stringify(input) },
    ),
  delete: (projectId: string, episodeId: string, storyboardId: string) =>
    request<void>(
      `${episodePath(projectId, episodeId)}/storyboards/${encodeURIComponent(storyboardId)}`,
      { method: 'DELETE' },
    ),
  batchDelete: (projectId: string, episodeId: string, storyboardIds: string[]) =>
    request<StoryboardBatchDeleteResult>(
      `${episodePath(projectId, episodeId)}/storyboards/batch-delete`,
      {
        method: 'POST',
        body: JSON.stringify({ storyboardIds }),
      },
    ),
}
