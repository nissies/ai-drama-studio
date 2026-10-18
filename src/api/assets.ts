import type { LocalAsset } from '../desktop/types'
import { request, requestBlob, requestForm } from './client'

export type MediaAssetType = 'IMAGE' | 'AUDIO' | 'VIDEO'
export type CharacterViewType =
  | 'FRONT'
  | 'THREE_QUARTER'
  | 'SIDE'
  | 'BACK'
  | 'CLOSE_UP'
  | 'TURNAROUND'
  | 'TURNAROUND_PORTRAIT'
  | 'CHARACTER_SHEET'
  | 'OTHER'
export type SceneReferenceType = 'OVERVIEW' | 'DETAIL' | 'LIGHTING' | 'STYLE' | 'OTHER'

export interface MediaAsset {
  id: string
  projectId: string
  assetType: MediaAssetType
  localCategory: LocalAsset['category']
  originalFilename: string
  mimeType: string
  sizeBytes: number
  sha256: string
  storageScope: 'LOCAL_DESKTOP' | 'SERVER'
  contentAvailable?: boolean
  status: string
  version: number
  createdAt: string
  updatedAt: string
}

export interface AssetSyncResult {
  clientAssetId: string
  asset: MediaAsset
}

export interface CharacterReference {
  id: string
  characterId: string
  characterFormId?: string
  assetId: string
  viewType: CharacterViewType
  primaryReference: boolean
  sortOrder: number
  version: number
  updatedAt: string
}

export interface SceneReference {
  id: string
  episodeId: string
  sceneId: string
  assetId: string
  referenceType: SceneReferenceType
  primaryReference: boolean
  sortOrder: number
  version: number
  updatedAt: string
}

export interface CharacterVoiceReference {
  id: string
  characterId: string
  assetId: string
  sourceStoryboardId?: string
  primaryReference: boolean
  version: number
  updatedAt: string
}

export interface CharacterReferenceInput {
  characterId: string
  characterFormId?: string
  assetId: string
  viewType: CharacterViewType
  primaryReference: boolean
}

export interface SceneReferenceInput {
  episodeId: string
  sceneId: string
  assetId: string
  referenceType: SceneReferenceType
  primaryReference: boolean
}

export interface CharacterVoiceReferenceInput {
  characterId: string
  assetId: string
  sourceStoryboardId?: string
  primaryReference: boolean
}

function projectPath(projectId: string) {
  return `/projects/${encodeURIComponent(projectId)}`
}

export const mediaAssetApi = {
  list: (projectId: string) => request<MediaAsset[]>(`${projectPath(projectId)}/assets`),
  synchronize: (projectId: string, assets: LocalAsset[]) =>
    request<AssetSyncResult[]>(`${projectPath(projectId)}/assets/sync`, {
      method: 'PUT',
      body: JSON.stringify({
        assets: assets.map((asset) => ({
          id: asset.id,
          localCategory: asset.category,
          originalFilename: asset.originalName,
          mimeType: asset.mimeType,
          sizeBytes: asset.sizeBytes,
          sha256: asset.sha256,
        })),
      }),
    }),
  upload: (
    projectId: string,
    input: {
      localCategory: LocalAsset['category']
      file: File
    },
  ) => {
    const body = new FormData()
    body.set('localCategory', input.localCategory)
    body.set('file', input.file)
    return requestForm<MediaAsset>(`${projectPath(projectId)}/assets/upload`, body)
  },
  content: (projectId: string, assetId: string) =>
    requestBlob(`${projectPath(projectId)}/assets/${encodeURIComponent(assetId)}/content`),
  delete: (projectId: string, assetId: string) =>
    request<void>(`${projectPath(projectId)}/assets/${encodeURIComponent(assetId)}`, {
      method: 'DELETE',
    }),
}

export const characterReferenceApi = {
  list: (projectId: string) =>
    request<CharacterReference[]>(`${projectPath(projectId)}/character-references`),
  create: (projectId: string, input: CharacterReferenceInput) =>
    request<CharacterReference>(`${projectPath(projectId)}/character-references`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  delete: (projectId: string, referenceId: string) =>
    request<void>(
      `${projectPath(projectId)}/character-references/${encodeURIComponent(referenceId)}`,
      { method: 'DELETE' },
    ),
}

export const characterVoiceReferenceApi = {
  list: (projectId: string) =>
    request<CharacterVoiceReference[]>(`${projectPath(projectId)}/character-voice-references`),
  create: (projectId: string, input: CharacterVoiceReferenceInput) =>
    request<CharacterVoiceReference>(`${projectPath(projectId)}/character-voice-references`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  delete: (projectId: string, referenceId: string) =>
    request<void>(
      `${projectPath(projectId)}/character-voice-references/${encodeURIComponent(referenceId)}`,
      { method: 'DELETE' },
    ),
}

export const sceneReferenceApi = {
  list: (projectId: string) =>
    request<SceneReference[]>(`${projectPath(projectId)}/scene-references`),
  create: (projectId: string, input: SceneReferenceInput) =>
    request<SceneReference>(`${projectPath(projectId)}/scene-references`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  delete: (projectId: string, referenceId: string) =>
    request<void>(`${projectPath(projectId)}/scene-references/${encodeURIComponent(referenceId)}`, {
      method: 'DELETE',
    }),
}
