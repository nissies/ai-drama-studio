import { defineStore } from 'pinia'
import { projectApi, type Project, type UpdateProjectSettingsInput } from '../api/client'
import {
  characterReferenceApi,
  characterVoiceReferenceApi,
  mediaAssetApi,
  sceneReferenceApi,
  type CharacterReference,
  type CharacterReferenceInput,
  type CharacterVoiceReference,
  type CharacterVoiceReferenceInput,
  type MediaAsset,
  type SceneReference,
  type SceneReferenceInput,
} from '../api/assets'
import {
  characterApi,
  episodeApi,
  sceneApi,
  storyboardApi,
  type CharacterAsset,
  type CharacterFormInput,
  type CharacterInput,
  type Episode,
  type EpisodeInput,
  type Scene,
  type SceneInput,
  type Storyboard,
  type StoryboardInput,
  type StoryboardReviewStatus,
} from '../api/workspace'
import type { AssetIdMapping, LocalAsset } from '../desktop/types'
import {
  storyboardOutputApi,
  type StoryboardOutput,
  type StoryboardOutputType,
} from '../api/storyboard-outputs'
import { isLocalProjectId, type LocalProjectData } from '../api/local-project'
import { resequenceEpisodes } from '../domain/episode-metrics'

function localBridge() {
  const desktop = globalThis.window?.aiDramaDesktop
  if (!desktop) throw new Error('请在 Windows 客户端中打开本地项目')
  return desktop
}

function localMediaAsset(projectId: string, asset: LocalAsset): MediaAsset {
  const now = asset.importedAt || new Date(0).toISOString()
  return {
    id: asset.id,
    projectId,
    assetType: asset.mimeType.startsWith('video/')
      ? 'VIDEO'
      : asset.mimeType.startsWith('audio/')
        ? 'AUDIO'
        : 'IMAGE',
    localCategory: asset.category,
    originalFilename: asset.originalName,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    sha256: asset.sha256,
    storageScope: 'LOCAL_DESKTOP',
    contentAvailable: asset.fileAvailable,
    status: asset.fileAvailable ? 'READY' : 'MISSING',
    version: 0,
    createdAt: now,
    updatedAt: now,
  }
}

function nextVersion(version?: number) {
  return Number(version || 0) + 1
}

function nowIso() {
  return new Date().toISOString()
}

export const useWorkspaceStore = defineStore('workspace', {
  state: () => ({
    project: null as Project | null,
    episodes: [] as Episode[],
    characters: [] as CharacterAsset[],
    scenes: [] as Scene[],
    storyboards: [] as Storyboard[],
    storyboardOutputs: [] as StoryboardOutput[],
    mediaAssets: [] as MediaAsset[],
    characterReferences: [] as CharacterReference[],
    characterVoiceReferences: [] as CharacterVoiceReference[],
    sceneReferences: [] as SceneReference[],
    localData: null as LocalProjectData | null,
    activeEpisodeId: '',
    loading: false,
    scenesLoading: false,
    storyboardsLoading: false,
    assetsLoading: false,
    error: '',
  }),
  getters: {
    activeEpisode(state): Episode | null {
      return state.episodes.find((episode) => episode.id === state.activeEpisodeId) ?? null
    },
    mediaAssetById: (state) => (assetId: string) =>
      state.mediaAssets.find((asset) => asset.id === assetId),
    outputForStoryboard: (state) => (storyboardId: string, outputType: StoryboardOutputType) =>
      state.storyboardOutputs.find(
        (output) => output.storyboardId === storyboardId && output.outputType === outputType,
      ),
    referencesForCharacter: (state) => (characterId: string, formId?: string) =>
      state.characterReferences.filter(
        (reference) =>
          reference.characterId === characterId &&
          (formId ? reference.characterFormId === formId : !reference.characterFormId),
      ),
    referencesForScene: (state) => (sceneId: string) =>
      state.sceneReferences.filter((reference) => reference.sceneId === sceneId),
    voiceReferencesForCharacter: (state) => (characterId: string) =>
      state.characterVoiceReferences.filter((reference) => reference.characterId === characterId),
  },
  actions: {
    async load(projectId: string) {
      this.loading = true
      this.error = ''
      try {
        if (isLocalProjectId(projectId)) {
          await this.loadLocalProject(projectId)
          return
        }
        this.localData = null
        const [
          project,
          episodes,
          characters,
          mediaAssets,
          characterReferences,
          characterVoiceReferences,
          sceneReferences,
        ] = await Promise.all([
          projectApi.get(projectId),
          episodeApi.list(projectId),
          characterApi.list(projectId),
          mediaAssetApi.list(projectId),
          characterReferenceApi.list(projectId),
          characterVoiceReferenceApi.list(projectId),
          sceneReferenceApi.list(projectId),
        ])
        this.project = project
        this.episodes = resequenceEpisodes(episodes)
        this.characters = characters
        this.mediaAssets = mediaAssets
        this.characterReferences = characterReferences
        this.characterVoiceReferences = characterVoiceReferences
        this.sceneReferences = sceneReferences
        if (!episodes.some((episode) => episode.id === this.activeEpisodeId)) {
          this.activeEpisodeId = episodes[0]?.id ?? ''
        }
        await this.loadEpisodeResources(projectId)
      } catch (error) {
        this.error = error instanceof Error ? error.message : '工作台加载失败'
      } finally {
        this.loading = false
      }
    },
    async loadLocalProject(projectId: string) {
      const desktop = localBridge()
      const [records, localProject, data] = await Promise.all([
        desktop.listLocalProjects(),
        desktop.getProject(projectId),
        desktop.getLocalProjectData(projectId),
      ])
      const project = records.find((item) => item.id === projectId)
      if (!project) throw new Error('本地项目不存在或已被移除')
      this.project = project as Project
      this.localData = data
      this.episodes = resequenceEpisodes(data.episodes)
      this.characters = data.characters
      this.mediaAssets = localProject.assets.map((asset) => localMediaAsset(projectId, asset))
      this.characterReferences = data.characterReferences
      this.characterVoiceReferences = data.characterVoiceReferences
      this.sceneReferences = data.sceneReferences
      if (!data.episodes.some((episode) => episode.id === this.activeEpisodeId)) {
        this.activeEpisodeId = data.episodes[0]?.id ?? ''
      }
      await this.loadEpisodeResources(projectId)
    },
    async persistLocalData(projectId: string) {
      if (!this.localData || this.localData.projectId !== projectId) {
        throw new Error('本地项目数据尚未加载完成')
      }
      this.localData.episodes = this.episodes
      this.localData.characters = this.characters
      this.localData.characterReferences = this.characterReferences
      this.localData.characterVoiceReferences = this.characterVoiceReferences
      this.localData.sceneReferences = this.sceneReferences
      this.localData = await localBridge().saveLocalProjectData(projectId, this.localData)
      this.episodes = this.localData.episodes
      this.characters = this.localData.characters
      this.characterReferences = this.localData.characterReferences
      this.characterVoiceReferences = this.localData.characterVoiceReferences
      this.sceneReferences = this.localData.sceneReferences
      return this.localData
    },
    async updateProjectSettings(projectId: string, input: UpdateProjectSettingsInput) {
      const updated = isLocalProjectId(projectId)
        ? await localBridge().updateLocalProject(projectId, input)
        : await projectApi.updateSettings(projectId, input)
      this.project = updated
      return updated
    },
    async selectEpisode(projectId: string, episodeId: string) {
      this.activeEpisodeId = episodeId
      await this.loadEpisodeResources(projectId)
    },
    async loadEpisodeResources(projectId: string) {
      await Promise.all([this.loadScenes(projectId), this.loadStoryboards(projectId)])
    },
    async loadAssetResources(projectId: string) {
      this.assetsLoading = true
      try {
        if (isLocalProjectId(projectId)) {
          const [project, data] = await Promise.all([
            localBridge().getProject(projectId),
            localBridge().getLocalProjectData(projectId),
          ])
          this.localData = data
          this.mediaAssets = project.assets.map((asset) => localMediaAsset(projectId, asset))
          this.characterReferences = data.characterReferences
          this.characterVoiceReferences = data.characterVoiceReferences
          this.sceneReferences = data.sceneReferences
          return
        }
        const [mediaAssets, characterReferences, characterVoiceReferences, sceneReferences] =
          await Promise.all([
            mediaAssetApi.list(projectId),
            characterReferenceApi.list(projectId),
            characterVoiceReferenceApi.list(projectId),
            sceneReferenceApi.list(projectId),
          ])
        this.mediaAssets = mediaAssets
        this.characterReferences = characterReferences
        this.characterVoiceReferences = characterVoiceReferences
        this.sceneReferences = sceneReferences
      } finally {
        this.assetsLoading = false
      }
    },
    async synchronizeLocalAssets(projectId: string, localAssets: LocalAsset[]) {
      if (isLocalProjectId(projectId)) {
        localAssets.forEach((asset) => {
          this.replaceByIdOrAppend(this.mediaAssets, localMediaAsset(projectId, asset))
        })
        return localAssets.map((asset) => ({ clientAssetId: asset.id, assetId: asset.id }))
      }
      const mappings: AssetIdMapping[] = []
      for (let offset = 0; offset < localAssets.length; offset += 500) {
        const results = await mediaAssetApi.synchronize(
          projectId,
          localAssets.slice(offset, offset + 500),
        )
        mappings.push(
          ...results.map((result) => ({
            clientAssetId: result.clientAssetId,
            assetId: result.asset.id,
          })),
        )
      }
      await this.loadAssetResources(projectId)
      return mappings
    },
    async deleteMediaAsset(projectId: string, assetId: string) {
      if (!isLocalProjectId(projectId)) await mediaAssetApi.delete(projectId, assetId)
      this.mediaAssets = this.mediaAssets.filter((asset) => asset.id !== assetId)
    },
    forgetMediaAsset(assetId: string) {
      this.mediaAssets = this.mediaAssets.filter((asset) => asset.id !== assetId)
    },
    async createCharacterReference(projectId: string, input: CharacterReferenceInput) {
      const reference = isLocalProjectId(projectId)
        ? {
            id: globalThis.crypto.randomUUID(),
            ...input,
            sortOrder: this.characterReferences.filter(
              (item) =>
                item.characterId === input.characterId &&
                item.characterFormId === input.characterFormId,
            ).length,
            version: 0,
            updatedAt: nowIso(),
          }
        : await characterReferenceApi.create(projectId, input)
      if (reference.primaryReference) {
        this.characterReferences.forEach((item) => {
          const sameTarget =
            item.characterId === reference.characterId &&
            item.characterFormId === reference.characterFormId
          if (sameTarget) item.primaryReference = false
        })
      }
      this.replaceByIdOrAppend(this.characterReferences, reference)
      if (isLocalProjectId(projectId)) await this.persistLocalData(projectId)
      return reference
    },
    async deleteCharacterReference(projectId: string, referenceId: string) {
      if (!isLocalProjectId(projectId)) {
        await characterReferenceApi.delete(projectId, referenceId)
      }
      this.characterReferences = this.characterReferences.filter((item) => item.id !== referenceId)
      if (isLocalProjectId(projectId)) await this.persistLocalData(projectId)
    },
    async createCharacterVoiceReference(projectId: string, input: CharacterVoiceReferenceInput) {
      const reference = isLocalProjectId(projectId)
        ? {
            id: globalThis.crypto.randomUUID(),
            ...input,
            version: 0,
            updatedAt: nowIso(),
          }
        : await characterVoiceReferenceApi.create(projectId, input)
      if (reference.primaryReference) {
        this.characterVoiceReferences.forEach((item) => {
          if (item.characterId === reference.characterId) item.primaryReference = false
        })
      }
      this.replaceByIdOrAppend(this.characterVoiceReferences, reference)
      if (isLocalProjectId(projectId)) await this.persistLocalData(projectId)
      return reference
    },
    async deleteCharacterVoiceReference(projectId: string, referenceId: string) {
      if (!isLocalProjectId(projectId)) {
        await characterVoiceReferenceApi.delete(projectId, referenceId)
      }
      this.characterVoiceReferences = this.characterVoiceReferences.filter(
        (item) => item.id !== referenceId,
      )
      if (isLocalProjectId(projectId)) await this.persistLocalData(projectId)
    },
    async createSceneReference(projectId: string, input: SceneReferenceInput) {
      const reference = isLocalProjectId(projectId)
        ? {
            id: globalThis.crypto.randomUUID(),
            ...input,
            sortOrder: this.sceneReferences.filter((item) => item.sceneId === input.sceneId).length,
            version: 0,
            updatedAt: nowIso(),
          }
        : await sceneReferenceApi.create(projectId, input)
      if (reference.primaryReference) {
        this.sceneReferences.forEach((item) => {
          if (item.sceneId === reference.sceneId) item.primaryReference = false
        })
      }
      this.replaceByIdOrAppend(this.sceneReferences, reference)
      if (isLocalProjectId(projectId)) await this.persistLocalData(projectId)
      return reference
    },
    async deleteSceneReference(projectId: string, referenceId: string) {
      if (!isLocalProjectId(projectId)) await sceneReferenceApi.delete(projectId, referenceId)
      this.sceneReferences = this.sceneReferences.filter((item) => item.id !== referenceId)
      if (isLocalProjectId(projectId)) await this.persistLocalData(projectId)
    },
    async loadScenes(projectId: string) {
      if (!this.activeEpisodeId) {
        this.scenes = []
        return
      }
      this.scenesLoading = true
      try {
        if (isLocalProjectId(projectId)) {
          this.localData = await localBridge().getLocalProjectData(projectId)
          this.scenes = this.localData.scenes.filter(
            (scene) => scene.episodeId === this.activeEpisodeId,
          )
        } else {
          this.scenes = await sceneApi.list(projectId, this.activeEpisodeId)
        }
      } finally {
        this.scenesLoading = false
      }
    },
    async loadStoryboards(projectId: string) {
      if (!this.activeEpisodeId) {
        this.storyboards = []
        this.storyboardOutputs = []
        return
      }
      this.storyboardsLoading = true
      try {
        if (isLocalProjectId(projectId)) {
          this.localData = await localBridge().getLocalProjectData(projectId)
          this.storyboards =
            this.localData?.storyboards.filter(
              (storyboard) => storyboard.episodeId === this.activeEpisodeId,
            ) ?? []
          this.storyboardOutputs =
            this.localData?.storyboardOutputs.filter(
              (output) => output.episodeId === this.activeEpisodeId,
            ) ?? []
          return
        }
        const [storyboards, storyboardOutputs] = await Promise.all([
          storyboardApi.list(projectId, this.activeEpisodeId),
          storyboardOutputApi.list(projectId, this.activeEpisodeId),
        ])
        this.storyboards = storyboards
        this.storyboardOutputs = storyboardOutputs
      } finally {
        this.storyboardsLoading = false
      }
    },
    async createEpisode(projectId: string, input: EpisodeInput) {
      const created = isLocalProjectId(projectId)
        ? {
            id: globalThis.crypto.randomUUID(),
            projectId,
            episodeNo: Math.max(0, ...this.episodes.map((episode) => episode.episodeNo)) + 1,
            title: input.title,
            synopsis: input.synopsis,
            scriptText: input.scriptText,
            targetDurationSec: input.targetDurationSec,
            status: 'DRAFT',
            version: 0,
            updatedAt: nowIso(),
          }
        : await episodeApi.create(projectId, input)
      this.episodes.push(created)
      if (isLocalProjectId(projectId)) await this.persistLocalData(projectId)
      await this.selectEpisode(projectId, created.id)
      return created
    },
    async updateEpisode(projectId: string, episodeId: string, input: EpisodeInput) {
      const current = this.episodes.find((episode) => episode.id === episodeId)
      if (!current) throw new Error('分集不存在')
      const updated = isLocalProjectId(projectId)
        ? {
            ...current,
            ...input,
            version: nextVersion(current.version),
            updatedAt: nowIso(),
          }
        : await episodeApi.update(projectId, episodeId, input)
      this.replaceById(this.episodes, updated)
      if (isLocalProjectId(projectId)) await this.persistLocalData(projectId)
      return updated
    },
    async deleteEpisode(projectId: string, episodeId: string) {
      return this.deleteEpisodes(projectId, [episodeId])
    },
    async deleteEpisodes(projectId: string, episodeIds: string[]) {
      const deleteIds = new Set(
        episodeIds.filter((episodeId) => this.episodes.some((episode) => episode.id === episodeId)),
      )
      if (deleteIds.size === 0) return 0
      const activeIndex = this.episodes.findIndex((episode) => episode.id === this.activeEpisodeId)
      if (!isLocalProjectId(projectId)) {
        await episodeApi.batchDelete(projectId, [...deleteIds])
      }
      this.episodes = resequenceEpisodes(
        this.episodes.filter((episode) => !deleteIds.has(episode.id)),
      )
      if (isLocalProjectId(projectId) && this.localData) {
        const sceneIds = new Set(
          this.localData.scenes
            .filter((scene) => deleteIds.has(scene.episodeId))
            .map((scene) => scene.id),
        )
        const storyboardIds = new Set(
          this.localData.storyboards
            .filter((storyboard) => deleteIds.has(storyboard.episodeId))
            .map((storyboard) => storyboard.id),
        )
        this.localData.scenes = this.localData.scenes.filter(
          (scene) => !deleteIds.has(scene.episodeId),
        )
        this.localData.storyboards = this.localData.storyboards.filter(
          (storyboard) => !deleteIds.has(storyboard.episodeId),
        )
        this.localData.storyboardOutputs = this.localData.storyboardOutputs.filter(
          (output) => !deleteIds.has(output.episodeId),
        )
        this.sceneReferences = this.sceneReferences.filter(
          (reference) => !deleteIds.has(reference.episodeId) && !sceneIds.has(reference.sceneId),
        )
        this.characterVoiceReferences = this.characterVoiceReferences.filter(
          (reference) =>
            !reference.sourceStoryboardId || !storyboardIds.has(reference.sourceStoryboardId),
        )
        await this.persistLocalData(projectId)
      }
      if (deleteIds.has(this.activeEpisodeId)) {
        const nextIndex = Math.min(Math.max(activeIndex, 0), this.episodes.length - 1)
        this.activeEpisodeId = this.episodes[nextIndex]?.id ?? ''
        await this.loadEpisodeResources(projectId)
      }
      return deleteIds.size
    },
    async saveCharacter(projectId: string, input: CharacterInput, characterId?: string) {
      const current = characterId
        ? this.characters.find((character) => character.id === characterId)
        : undefined
      if (characterId && !current) throw new Error('角色不存在')
      const saved = isLocalProjectId(projectId)
        ? current
          ? { ...current, ...input, version: nextVersion(current.version), updatedAt: nowIso() }
          : {
              id: globalThis.crypto.randomUUID(),
              projectId,
              ...input,
              status: 'DRAFT',
              version: 0,
              forms: [],
              updatedAt: nowIso(),
            }
        : characterId
          ? await characterApi.update(projectId, characterId, input)
          : await characterApi.create(projectId, input)
      if (characterId) this.replaceById(this.characters, saved)
      else this.characters.push(saved)
      if (isLocalProjectId(projectId)) await this.persistLocalData(projectId)
      return saved
    },
    async deleteCharacter(projectId: string, characterId: string) {
      if (!isLocalProjectId(projectId)) await characterApi.delete(projectId, characterId)
      this.characters = this.characters.filter((character) => character.id !== characterId)
      this.characterReferences = this.characterReferences.filter(
        (reference) => reference.characterId !== characterId,
      )
      this.characterVoiceReferences = this.characterVoiceReferences.filter(
        (reference) => reference.characterId !== characterId,
      )
      if (isLocalProjectId(projectId) && this.localData) {
        this.localData.storyboards = this.localData.storyboards.map((storyboard) => ({
          ...storyboard,
          characterIds: storyboard.characterIds.filter((id) => id !== characterId),
          speakerCharacterId:
            storyboard.speakerCharacterId === characterId
              ? undefined
              : storyboard.speakerCharacterId,
        }))
        await this.persistLocalData(projectId)
      }
    },
    async saveCharacterForm(
      projectId: string,
      characterId: string,
      input: CharacterFormInput,
      formId?: string,
    ) {
      const character = this.characters.find((item) => item.id === characterId)
      if (!character) throw new Error('角色不存在')
      const current = formId ? character.forms.find((form) => form.id === formId) : undefined
      if (formId && !current) throw new Error('角色形态不存在')
      const saved = isLocalProjectId(projectId)
        ? current
          ? { ...current, ...input }
          : {
              id: globalThis.crypto.randomUUID(),
              formCode: `form-${globalThis.crypto.randomUUID().slice(0, 8)}`,
              ...input,
            }
        : formId
          ? await characterApi.updateForm(projectId, characterId, formId, input)
          : await characterApi.createForm(projectId, characterId, input)
      if (saved.defaultForm) {
        character.forms.forEach((form) => (form.defaultForm = false))
      }
      const index = character.forms.findIndex((form) => form.id === saved.id)
      if (index >= 0) character.forms[index] = saved
      else character.forms.push(saved)
      if (isLocalProjectId(projectId)) {
        character.version = nextVersion(character.version)
        character.updatedAt = nowIso()
        await this.persistLocalData(projectId)
      }
      return saved
    },
    async deleteCharacterForm(projectId: string, characterId: string, formId: string) {
      if (!isLocalProjectId(projectId)) {
        await characterApi.deleteForm(projectId, characterId, formId)
      }
      const character = this.characters.find((item) => item.id === characterId)
      if (character) character.forms = character.forms.filter((form) => form.id !== formId)
      this.characterReferences = this.characterReferences.filter(
        (reference) => reference.characterFormId !== formId,
      )
      if (isLocalProjectId(projectId)) {
        if (character) {
          character.version = nextVersion(character.version)
          character.updatedAt = nowIso()
        }
        await this.persistLocalData(projectId)
      }
    },
    async saveScene(projectId: string, input: SceneInput, sceneId?: string) {
      if (!this.activeEpisodeId) throw new Error('请先创建分集')
      const current = sceneId ? this.scenes.find((scene) => scene.id === sceneId) : undefined
      if (sceneId && !current) throw new Error('场景不存在')
      const saved = isLocalProjectId(projectId)
        ? current
          ? { ...current, ...input, version: nextVersion(current.version), updatedAt: nowIso() }
          : {
              id: globalThis.crypto.randomUUID(),
              projectId,
              episodeId: this.activeEpisodeId,
              sceneNo:
                Math.max(
                  0,
                  ...(this.localData?.scenes
                    .filter((scene) => scene.episodeId === this.activeEpisodeId)
                    .map((scene) => scene.sceneNo) ?? []),
                ) + 1,
              ...input,
              status: 'DRAFT',
              version: 0,
              updatedAt: nowIso(),
            }
        : sceneId
          ? await sceneApi.update(projectId, this.activeEpisodeId, sceneId, input)
          : await sceneApi.create(projectId, this.activeEpisodeId, input)
      if (sceneId) this.replaceById(this.scenes, saved)
      else this.scenes.push(saved)
      if (isLocalProjectId(projectId) && this.localData) {
        const index = this.localData.scenes.findIndex((scene) => scene.id === saved.id)
        if (index >= 0) this.localData.scenes[index] = saved
        else this.localData.scenes.push(saved)
        await this.persistLocalData(projectId)
      }
      return saved
    },
    async deleteScene(projectId: string, sceneId: string) {
      if (!this.activeEpisodeId) return
      if (!isLocalProjectId(projectId)) {
        await sceneApi.delete(projectId, this.activeEpisodeId, sceneId)
      }
      this.scenes = this.scenes.filter((scene) => scene.id !== sceneId)
      this.sceneReferences = this.sceneReferences.filter(
        (reference) => reference.sceneId !== sceneId,
      )
      if (isLocalProjectId(projectId) && this.localData) {
        this.localData.scenes = this.localData.scenes.filter((scene) => scene.id !== sceneId)
        this.localData.storyboards = this.localData.storyboards.map((storyboard) =>
          storyboard.sceneId === sceneId ? { ...storyboard, sceneId: undefined } : storyboard,
        )
        await this.persistLocalData(projectId)
      }
    },
    async saveStoryboard(projectId: string, input: StoryboardInput, storyboardId?: string) {
      if (!this.activeEpisodeId) throw new Error('请先创建分集')
      const current = storyboardId
        ? this.storyboards.find((storyboard) => storyboard.id === storyboardId)
        : undefined
      if (storyboardId && !current) throw new Error('分镜不存在')
      const saved = isLocalProjectId(projectId)
        ? current
          ? { ...current, ...input, version: nextVersion(current.version), updatedAt: nowIso() }
          : {
              id: globalThis.crypto.randomUUID(),
              projectId,
              episodeId: this.activeEpisodeId,
              shotNo:
                Math.max(
                  0,
                  ...(this.localData?.storyboards
                    .filter((storyboard) => storyboard.episodeId === this.activeEpisodeId)
                    .map((storyboard) => storyboard.shotNo) ?? []),
                ) + 1,
              ...input,
              reviewStatus: 'PENDING' as const,
              status: 'DRAFT',
              version: 0,
              updatedAt: nowIso(),
            }
        : storyboardId
          ? await storyboardApi.update(projectId, this.activeEpisodeId, storyboardId, input)
          : await storyboardApi.create(projectId, this.activeEpisodeId, input)
      if (storyboardId) this.replaceById(this.storyboards, saved)
      else this.storyboards.push(saved)
      if (isLocalProjectId(projectId) && this.localData) {
        const index = this.localData.storyboards.findIndex(
          (storyboard) => storyboard.id === saved.id,
        )
        if (index >= 0) this.localData.storyboards[index] = saved
        else this.localData.storyboards.push(saved)
        await this.persistLocalData(projectId)
      }
      return saved
    },
    async updateFinalVideoPrompt(
      projectId: string,
      storyboardId: string,
      finalVideoPrompt?: string | null,
    ) {
      if (!this.activeEpisodeId) throw new Error('请先创建分集')
      const storyboard = this.storyboards.find((item) => item.id === storyboardId)
      if (!storyboard) throw new Error('分镜不存在')
      const saved = isLocalProjectId(projectId)
        ? {
            ...storyboard,
            finalVideoPrompt: finalVideoPrompt || undefined,
            version: nextVersion(storyboard.version),
            updatedAt: nowIso(),
          }
        : await storyboardApi.updateFinalVideoPrompt(
            projectId,
            this.activeEpisodeId,
            storyboardId,
            { finalVideoPrompt, version: storyboard.version },
          )
      this.replaceById(this.storyboards, saved)
      if (isLocalProjectId(projectId) && this.localData) {
        this.replaceById(this.localData.storyboards, saved)
        await this.persistLocalData(projectId)
      }
      return saved
    },
    async deleteStoryboard(projectId: string, storyboardId: string) {
      if (!this.activeEpisodeId) return
      if (!isLocalProjectId(projectId)) {
        await storyboardApi.delete(projectId, this.activeEpisodeId, storyboardId)
      } else if (this.localData) {
        this.localData.storyboards = this.localData.storyboards.filter(
          (storyboard) => storyboard.id !== storyboardId,
        )
        this.localData.storyboardOutputs = this.localData.storyboardOutputs.filter(
          (output) => output.storyboardId !== storyboardId,
        )
        this.characterVoiceReferences = this.characterVoiceReferences.filter(
          (reference) => reference.sourceStoryboardId !== storyboardId,
        )
        await this.persistLocalData(projectId)
      }
      await this.loadStoryboards(projectId)
    },
    async deleteStoryboards(projectId: string, storyboardIds: string[]) {
      if (!this.activeEpisodeId) throw new Error('请先创建分集')
      const result = isLocalProjectId(projectId)
        ? { deletedCount: storyboardIds.length }
        : await storyboardApi.batchDelete(projectId, this.activeEpisodeId, storyboardIds)
      if (isLocalProjectId(projectId) && this.localData) {
        const ids = new Set(storyboardIds)
        this.localData.storyboards = this.localData.storyboards.filter(
          (storyboard) => !ids.has(storyboard.id),
        )
        this.localData.storyboardOutputs = this.localData.storyboardOutputs.filter(
          (output) => !ids.has(output.storyboardId),
        )
        this.characterVoiceReferences = this.characterVoiceReferences.filter(
          (reference) => !reference.sourceStoryboardId || !ids.has(reference.sourceStoryboardId),
        )
        await this.persistLocalData(projectId)
      }
      await this.loadStoryboards(projectId)
      return result
    },
    async reorderStoryboards(projectId: string, ordered: Storyboard[]) {
      if (!this.activeEpisodeId) return
      if (isLocalProjectId(projectId) && this.localData) {
        const now = nowIso()
        const reordered = ordered.map((storyboard, index) => ({
          ...storyboard,
          shotNo: index + 1,
          version: nextVersion(storyboard.version),
          updatedAt: now,
        }))
        const byId = new Map(reordered.map((storyboard) => [storyboard.id, storyboard]))
        this.localData.storyboards = this.localData.storyboards.map(
          (storyboard) => byId.get(storyboard.id) ?? storyboard,
        )
        this.storyboards = reordered
        await this.persistLocalData(projectId)
      } else {
        this.storyboards = await storyboardApi.reorder(projectId, this.activeEpisodeId, ordered)
      }
    },
    async updateStoryboardAudioModeBatch(
      projectId: string,
      storyboards: Storyboard[],
      audioMode: Storyboard['audioMode'],
    ) {
      if (!this.activeEpisodeId) throw new Error('请先创建分集')
      const result = isLocalProjectId(projectId)
        ? { updatedCount: storyboards.length, audioMode }
        : await storyboardApi.updateAudioModeBatch(
            projectId,
            this.activeEpisodeId,
            storyboards,
            audioMode,
          )
      if (isLocalProjectId(projectId) && this.localData) {
        const ids = new Set(storyboards.map((storyboard) => storyboard.id))
        const now = nowIso()
        this.localData.storyboards = this.localData.storyboards.map((storyboard) =>
          ids.has(storyboard.id)
            ? {
                ...storyboard,
                audioMode,
                version: nextVersion(storyboard.version),
                updatedAt: now,
              }
            : storyboard,
        )
        await this.persistLocalData(projectId)
      }
      await this.loadStoryboards(projectId)
      return result
    },
    async setStoryboardOutput(
      projectId: string,
      storyboardId: string,
      input: {
        outputType: StoryboardOutputType
        mediaAssetId: string
        sourceType?: 'IMAGE_CANDIDATE' | 'MEDIA_CANDIDATE' | 'MANUAL' | 'GENERATION_JOB'
        sourceId?: string
      },
    ) {
      if (!this.activeEpisodeId) throw new Error('请先创建分集')
      const existing = this.outputForStoryboard(storyboardId, input.outputType)
      const saved = isLocalProjectId(projectId)
        ? {
            id: existing?.id ?? globalThis.crypto.randomUUID(),
            projectId,
            episodeId: this.activeEpisodeId,
            storyboardId,
            ...input,
            version: existing ? nextVersion(existing.version) : 0,
            updatedAt: nowIso(),
          }
        : await storyboardOutputApi.set(projectId, this.activeEpisodeId, storyboardId, {
            ...input,
            ...(existing ? { version: existing.version } : {}),
          })
      this.replaceByIdOrAppend(this.storyboardOutputs, saved)
      if (isLocalProjectId(projectId) && this.localData) {
        this.replaceByIdOrAppend(this.localData.storyboardOutputs, saved)
        await this.persistLocalData(projectId)
      }
      return saved
    },
    async deleteStoryboardOutput(
      projectId: string,
      storyboardId: string,
      outputType: StoryboardOutputType,
    ) {
      if (!this.activeEpisodeId) return
      const existing = this.outputForStoryboard(storyboardId, outputType)
      if (!existing) return
      if (!isLocalProjectId(projectId)) {
        await storyboardOutputApi.delete(
          projectId,
          this.activeEpisodeId,
          storyboardId,
          outputType,
          existing.version,
        )
      }
      this.storyboardOutputs = this.storyboardOutputs.filter((item) => item.id !== existing.id)
      if (isLocalProjectId(projectId) && this.localData) {
        this.localData.storyboardOutputs = this.localData.storyboardOutputs.filter(
          (item) => item.id !== existing.id,
        )
        await this.persistLocalData(projectId)
      }
    },
    async reviewStoryboard(
      projectId: string,
      storyboardId: string,
      reviewStatus: Exclude<StoryboardReviewStatus, 'PENDING'>,
      reviewNote?: string,
    ) {
      if (!this.activeEpisodeId) throw new Error('请先创建分集')
      const storyboard = this.storyboards.find((item) => item.id === storyboardId)
      if (!storyboard) throw new Error('分镜不存在')
      const saved = isLocalProjectId(projectId)
        ? {
            ...storyboard,
            reviewStatus,
            reviewNote,
            version: nextVersion(storyboard.version),
            updatedAt: nowIso(),
          }
        : await storyboardApi.review(projectId, this.activeEpisodeId, storyboardId, {
            reviewStatus,
            reviewNote,
            version: storyboard.version,
          })
      this.replaceById(this.storyboards, saved)
      if (isLocalProjectId(projectId) && this.localData) {
        this.replaceById(this.localData.storyboards, saved)
        await this.persistLocalData(projectId)
      }
      return saved
    },
    replaceById<T extends { id: string }>(items: T[], replacement: T) {
      const index = items.findIndex((item) => item.id === replacement.id)
      if (index >= 0) items[index] = replacement
    },
    replaceByIdOrAppend<T extends { id: string }>(items: T[], replacement: T) {
      const index = items.findIndex((item) => item.id === replacement.id)
      if (index >= 0) items[index] = replacement
      else items.push(replacement)
    },
  },
})
