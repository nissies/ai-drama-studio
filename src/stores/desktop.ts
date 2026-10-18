import { defineStore } from 'pinia'
import type { Project } from '../api/client'
import type {
  DesktopRuntimeStatus,
  DesktopWorkspaceStatus,
  LocalAssetCategory,
  LocalProject,
  AssetIdMapping,
  LocalAiConnection,
  LocalAiConnectionInput,
  LocalAiConnectionDiscoveryInput,
  LocalAiModelDiscoveryResult,
  LocalAiConnectivityResult,
  LocalTextGenerationInput,
  LocalTextGenerationResult,
  LocalImageGenerationInput,
  LocalImageGenerationResult,
  LocalMediaGenerationInput,
  LocalMediaGenerationResult,
  SaveGeneratedImageInput,
  SaveGeneratedMediaInput,
  VoiceSampleExtractionInput,
  VideoFrameExtractionInput,
  ImportedLocalAsset,
  EpisodeExportInput,
  EpisodeExportProgress,
  EpisodeExportResult,
  BatchVideoExportItem,
  BatchVideoExportResult,
} from '../desktop/types'

function bridge() {
  return globalThis.window?.aiDramaDesktop
}

let localAiLoadRequest = 0
let localAiLoadPromise: Promise<void> | null = null

export const useDesktopStore = defineStore('desktop', {
  state: () => ({
    available: Boolean(bridge()),
    runtime: null as DesktopRuntimeStatus | null,
    workspace: null as DesktopWorkspaceStatus | null,
    project: null as LocalProject | null,
    localAiConnections: [] as LocalAiConnection[],
    loading: false,
    importing: false,
    localAiLoading: false,
    localAiSaving: false,
    exportProgress: null as EpisodeExportProgress | null,
    error: '',
  }),
  actions: {
    async initialize() {
      const desktop = bridge()
      if (!desktop || this.loading) return
      this.loading = true
      this.error = ''
      try {
        const [runtime, workspace] = await Promise.all([
          desktop.getRuntimeStatus(),
          desktop.getWorkspaceStatus(),
        ])
        this.runtime = runtime
        this.workspace = workspace
      } catch (error) {
        this.error = messageFor(error, '桌面运行环境读取失败')
      } finally {
        this.loading = false
      }
    },
    async selectWorkspaceRoot() {
      const desktop = bridge()
      if (!desktop) return
      this.error = ''
      try {
        this.workspace = await desktop.selectWorkspaceRoot()
      } catch (error) {
        this.error = messageFor(error, '工作目录设置失败')
      }
    },
    async ensureProject(project: Pick<Project, 'id' | 'title'>) {
      const desktop = bridge()
      if (!desktop) return
      this.error = ''
      try {
        this.project = await desktop.ensureProject(project)
        this.workspace = await desktop.getWorkspaceStatus()
      } catch (error) {
        this.error = messageFor(error, '本地项目初始化失败')
      }
    },
    async loadProject(projectId: string) {
      const desktop = bridge()
      if (!desktop) return null
      this.error = ''
      try {
        this.project = await desktop.getProject(projectId)
        return this.project
      } catch (error) {
        this.error = messageFor(error, '本地项目清单读取失败')
        throw error
      }
    },
    async importAssets(category: LocalAssetCategory) {
      const desktop = bridge()
      if (!desktop || !this.project || this.importing) return []
      this.importing = true
      this.error = ''
      try {
        const imported = await desktop.importAssets(this.project.projectId, category)
        this.project = await desktop.getProject(this.project.projectId)
        this.workspace = await desktop.getWorkspaceStatus()
        return imported
      } catch (error) {
        this.error = messageFor(error, '本地素材导入失败')
        return []
      } finally {
        this.importing = false
      }
    },
    async removeAsset(assetId: string) {
      const desktop = bridge()
      if (!desktop || !this.project) return
      this.error = ''
      try {
        await desktop.removeAsset(this.project.projectId, assetId)
        this.project.assets = this.project.assets.filter((asset) => asset.id !== assetId)
      } catch (error) {
        this.error = messageFor(error, '本地素材删除失败')
      }
    },
    async reconcileAssetIds(mappings: AssetIdMapping[]) {
      const desktop = bridge()
      if (!desktop || !this.project || mappings.length === 0) return
      const serializableMappings = mappings.map(({ clientAssetId, assetId }) => ({
        clientAssetId,
        assetId,
      }))
      this.project = await desktop.reconcileAssetIds(this.project.projectId, serializableMappings)
    },
    assetPreviewUrl(assetId: string) {
      const desktop = bridge()
      if (!desktop || !this.project) return ''
      return desktop.assetPreviewUrl(this.project.projectId, assetId)
    },
    async revealAsset(assetId: string) {
      const desktop = bridge()
      if (desktop && this.project) await desktop.revealAsset(this.project.projectId, assetId)
    },
    async revealProject() {
      const desktop = bridge()
      if (desktop && this.project) await desktop.revealProject(this.project.projectId)
    },
    async exportVideoAssets(items: BatchVideoExportItem[]): Promise<BatchVideoExportResult> {
      const desktop = bridge()
      if (!desktop || !this.project) throw new Error('请在 Windows 客户端中批量导出视频')
      return desktop.exportVideoAssets(this.project.projectId, items)
    },
    async loadLocalAiConnections() {
      const desktop = bridge()
      if (!desktop) return
      if (localAiLoadPromise) return localAiLoadPromise
      const requestId = ++localAiLoadRequest
      this.localAiLoading = true
      this.error = ''
      const loadPromise = Promise.resolve().then(async () => {
        try {
          const connections = await desktop.listLocalAiConnections()
          if (requestId === localAiLoadRequest) {
            this.localAiConnections = Array.isArray(connections) ? connections : []
          }
        } catch (error) {
          if (requestId === localAiLoadRequest) {
            this.error = messageFor(error, '本地 AI 配置读取失败')
          }
        } finally {
          if (localAiLoadPromise === loadPromise) {
            localAiLoadPromise = null
            this.localAiLoading = false
          }
        }
      })
      localAiLoadPromise = loadPromise
      return loadPromise
    },
    async saveLocalAiConnection(input: LocalAiConnectionInput) {
      const desktop = bridge()
      if (!desktop || this.localAiSaving) return null
      this.localAiSaving = true
      this.error = ''
      try {
        const saved = await desktop.saveLocalAiConnection(input)
        const pendingLoad = localAiLoadPromise
        localAiLoadRequest += 1
        const existingIndex = this.localAiConnections.findIndex((item) => item.id === saved.id)
        if (existingIndex >= 0) this.localAiConnections.splice(existingIndex, 1, saved)
        else this.localAiConnections.unshift(saved)
        await this.loadLocalAiConnections()
        if (pendingLoad) await this.loadLocalAiConnections()
        return saved
      } catch (error) {
        this.error = messageFor(error, '本地 AI 配置保存失败')
        throw error
      } finally {
        this.localAiSaving = false
      }
    },
    async discoverLocalAiModels(
      input: LocalAiConnectionDiscoveryInput,
    ): Promise<LocalAiModelDiscoveryResult> {
      const desktop = bridge()
      if (!desktop) throw new Error('请在 Windows 客户端中获取模型列表')
      return desktop.discoverLocalAiModels(input)
    },
    async deleteLocalAiConnection(id: string, version: number) {
      const desktop = bridge()
      if (!desktop) return
      this.error = ''
      try {
        await desktop.deleteLocalAiConnection(id, version)
        this.localAiConnections = this.localAiConnections.filter((item) => item.id !== id)
      } catch (error) {
        this.error = messageFor(error, '本地 AI 配置删除失败')
        throw error
      }
    },
    async testLocalAiAddress(id: string): Promise<LocalAiConnectivityResult | null> {
      const desktop = bridge()
      if (!desktop) return null
      this.error = ''
      try {
        return await desktop.testLocalAiAddress(id)
      } catch (error) {
        this.error = messageFor(error, '本地 AI 地址测试失败')
        throw error
      }
    },
    async generateLocalText(input: LocalTextGenerationInput): Promise<LocalTextGenerationResult> {
      const desktop = bridge()
      if (!desktop) throw new Error('当前不是 Windows 桌面客户端，无法调用我的 API')
      this.error = ''
      try {
        return await desktop.generateLocalText(input)
      } catch (error) {
        this.error = messageFor(error, '本地 AI 文本生成失败')
        throw error
      }
    },
    async generateLocalImage(
      input: LocalImageGenerationInput,
    ): Promise<LocalImageGenerationResult> {
      const desktop = bridge()
      if (!desktop) throw new Error('当前不是 Windows 桌面客户端，无法调用我的 API')
      this.error = ''
      try {
        return await desktop.generateLocalImage(input)
      } catch (error) {
        this.error = messageFor(error, '本地 AI 图片生成失败')
        throw error
      }
    },
    async generateLocalMedia(
      input: LocalMediaGenerationInput,
    ): Promise<LocalMediaGenerationResult> {
      const desktop = bridge()
      if (!desktop) throw new Error('当前不是 Windows 桌面客户端，无法调用我的 API')
      this.error = ''
      try {
        return await desktop.generateLocalMedia(input)
      } catch (error) {
        this.error = messageFor(
          error,
          input.mediaType === 'VIDEO' ? '本地 AI 视频生成失败' : '本地 AI 配音生成失败',
        )
        throw error
      }
    },
    generatedCandidatePreviewUrl(candidateId: string) {
      const desktop = bridge()
      if (!desktop || !this.project) return ''
      return desktop.generatedCandidatePreviewUrl(this.project.projectId, candidateId)
    },
    async discardGeneratedImage(candidateId: string) {
      const desktop = bridge()
      if (!desktop || !this.project) return
      await desktop.discardGeneratedImage(this.project.projectId, candidateId)
    },
    async saveGeneratedImage(input: SaveGeneratedImageInput): Promise<ImportedLocalAsset> {
      const desktop = bridge()
      if (!desktop) throw new Error('请在 Windows 客户端中保存图片')
      this.error = ''
      try {
        const asset = await desktop.saveGeneratedImage(input)
        if (this.project?.projectId === input.projectId) {
          this.project.assets = mergeLocalAsset(this.project.assets, asset)
        } else {
          this.project = await desktop.getProject(input.projectId)
        }
        return asset
      } catch (error) {
        this.error = messageFor(error, '生成图片保存失败')
        throw error
      }
    },
    async saveGeneratedMedia(input: SaveGeneratedMediaInput): Promise<ImportedLocalAsset> {
      const desktop = bridge()
      if (!desktop) throw new Error('请在 Windows 客户端中保存媒体')
      this.error = ''
      try {
        const asset = await desktop.saveGeneratedMedia(input)
        if (this.project?.projectId === input.projectId) {
          this.project.assets = mergeLocalAsset(this.project.assets, asset)
        } else {
          this.project = await desktop.getProject(input.projectId)
        }
        return asset
      } catch (error) {
        this.error = messageFor(error, '生成媒体保存失败')
        throw error
      }
    },
    async extractVoiceSample(input: VoiceSampleExtractionInput): Promise<ImportedLocalAsset> {
      const desktop = bridge()
      if (!desktop) throw new Error('请在 Windows 客户端中提取声音样本')
      this.error = ''
      try {
        const asset = await desktop.extractVoiceSample(input)
        if (this.project) this.project = await desktop.getProject(this.project.projectId)
        return asset
      } catch (error) {
        this.error = messageFor(error, '声音样本提取失败')
        throw error
      }
    },
    async extractLastVideoFrame(input: VideoFrameExtractionInput): Promise<ImportedLocalAsset> {
      const desktop = bridge()
      if (!desktop) throw new Error('请在 Windows 客户端中提取视频尾帧')
      this.error = ''
      try {
        const asset = await desktop.extractLastVideoFrame(input)
        if (this.project) this.project = await desktop.getProject(this.project.projectId)
        return asset
      } catch (error) {
        this.error = messageFor(error, '视频尾帧提取失败')
        throw error
      }
    },
    async extractVideoFrame(input: VideoFrameExtractionInput): Promise<ImportedLocalAsset> {
      const desktop = bridge()
      if (!desktop) throw new Error('请在 Windows 客户端中提取视频帧')
      this.error = ''
      try {
        const asset = await desktop.extractVideoFrame(input)
        if (this.project) this.project = await desktop.getProject(this.project.projectId)
        return asset
      } catch (error) {
        this.error = messageFor(error, '视频帧提取失败')
        throw error
      }
    },
    async composeEpisode(input: EpisodeExportInput): Promise<EpisodeExportResult> {
      const desktop = bridge()
      if (!desktop) throw new Error('请在 Windows 客户端中合成成片')
      this.error = ''
      this.exportProgress = {
        exportId: input.exportId,
        stage: 'RENDERING',
        progress: 0,
        shotNo: null,
      }
      const unsubscribe = desktop.onExportProgress((progress) => {
        if (progress.exportId === input.exportId) this.exportProgress = progress
      })
      try {
        const result = await desktop.composeEpisode(input)
        if (this.project) this.project = await desktop.getProject(this.project.projectId)
        return result
      } catch (error) {
        this.error = messageFor(error, '整集导出失败')
        throw error
      } finally {
        unsubscribe()
      }
    },
    async cancelEpisodeExport(exportId: string) {
      const desktop = bridge()
      if (desktop) await desktop.cancelEpisodeExport(exportId)
    },
  },
})

function messageFor(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

function mergeLocalAsset(assets: LocalProject['assets'], asset: ImportedLocalAsset) {
  const normalized = { ...asset, fileAvailable: true }
  return assets.some((item) => item.id === asset.id)
    ? assets.map((item) => (item.id === asset.id ? normalized : item))
    : [normalized, ...assets]
}
