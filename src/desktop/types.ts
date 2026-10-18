import type { ImageSize } from '../domain/image-sizes'
import type { LocalProjectData } from '../api/local-project'
import type { Project, UpdateProjectSettingsInput } from '../api/client'
import type { GenerationJob } from '../api/generation'
import type { ExportJob, ExportSettingsInput } from '../api/export-jobs'
import type { ChatSession, ChatSessionDetail, ChatTurnResult } from '../api/chat'
import type {
  DeleteImageCandidateResult,
  ImageCandidate,
  ImageTargetType,
  LocalImageResultInput,
} from '../api/image-generation'
import type {
  LocalMediaResultInput,
  MediaCandidate,
  MediaCandidateDeleteResult,
  MediaType,
} from '../api/media-generation'

export interface DesktopBridge {
  readonly isDesktop: true
  getPersistedAuthState(): Promise<PersistedAuthState | null>
  savePersistedAuthState(input: PersistedAuthState): Promise<void>
  clearPersistedAuthState(): Promise<void>
  getRuntimeStatus(): Promise<DesktopRuntimeStatus>
  checkForUpdate(input?: {
    currentVersion?: string
    channel?: string
    platform?: string
  }): Promise<DesktopUpdateCheckResult>
  downloadAndInstallUpdate(input: DesktopUpdateInstallInput): Promise<DesktopUpdateInstallResult>
  cancelUpdateDownload(): Promise<boolean>
  onUpdateProgress(callback: (progress: DesktopUpdateProgress) => void): () => void
  getWorkspaceStatus(): Promise<DesktopWorkspaceStatus>
  listLocalProjects(): Promise<LocalProjectRecord[]>
  createLocalProject(input: LocalProjectInput): Promise<LocalProjectRecord>
  deleteLocalProject(projectId: string): Promise<{ projectId: string; deletedDirectory: string }>
  getLocalProjectData(projectId: string): Promise<LocalProjectData>
  saveLocalProjectData(projectId: string, data: LocalProjectData): Promise<LocalProjectData>
  updateLocalProject(projectId: string, input: UpdateProjectSettingsInput): Promise<Project>
  createLocalGenerationJob(projectId: string, job: GenerationJob): Promise<GenerationJob>
  getLocalGenerationJob(jobId: string): Promise<GenerationJob>
  listLocalGenerationJobs(
    projectId: string,
    page?: number,
    pageSize?: number,
  ): Promise<GenerationJobPage>
  listAllLocalGenerationJobs(page?: number, pageSize?: number): Promise<GenerationJobPage>
  updateLocalGenerationJob(
    jobId: string,
    action: 'START' | 'HEARTBEAT' | 'COMPLETE' | 'FAIL' | 'CANCEL' | 'RETRY',
    input?: Record<string, unknown>,
  ): Promise<GenerationJob>
  createLocalExportJob(
    projectId: string,
    episodeId: string,
    input: { outputName: string; settings: ExportSettingsInput; shots: EpisodeExportShotInput[] },
    idempotencyKey: string,
  ): Promise<ExportJob>
  listLocalExportJobs(projectId: string, episodeId: string): Promise<ExportJob[]>
  getLocalExportJob(jobId: string): Promise<ExportJob>
  updateLocalExportJob(
    jobId: string,
    action: 'START' | 'PROGRESS' | 'COMPLETE' | 'FAIL' | 'CANCEL' | 'RETRY',
    input?: Record<string, unknown>,
  ): Promise<ExportJob>
  listLocalChatSessions(): Promise<ChatSession[]>
  createLocalChatSession(input: { title?: string; localConnectionId: string }): Promise<ChatSession>
  getLocalChatSession(sessionId: string): Promise<ChatSessionDetail>
  deleteLocalChatSession(sessionId: string): Promise<void>
  appendLocalChatTurn(
    sessionId: string,
    input: {
      content: string
      imageDataUrl?: string
      assistantContent: string
      localConnectionId: string
      modelName: string
    },
  ): Promise<ChatTurnResult>
  attachLocalChatProject(sessionId: string, projectId: string): Promise<ChatSession>
  completeLocalImageGenerationJob(
    jobId: string,
    input: LocalImageResultInput,
  ): Promise<ImageCandidate>
  completeLocalMediaGenerationJob(
    jobId: string,
    input: LocalMediaResultInput,
  ): Promise<MediaCandidate>
  listLocalImageCandidates(
    projectId: string,
    targetType: ImageTargetType,
    targetId: string,
  ): Promise<ImageCandidate[]>
  listLocalMediaCandidates(
    projectId: string,
    storyboardId: string,
    mediaType: MediaType,
  ): Promise<MediaCandidate[]>
  getLocalImageCandidate(candidateId: string): Promise<ImageCandidate>
  getLocalMediaCandidate(candidateId: string): Promise<MediaCandidate>
  updateLocalImageCandidate(
    candidateId: string,
    action: 'SELECT' | 'SAVE' | 'DELETE',
    input: { version: number; assetId?: string },
  ): Promise<ImageCandidate | DeleteImageCandidateResult>
  updateLocalMediaCandidate(
    candidateId: string,
    action: 'SELECT' | 'SAVE' | 'DELETE',
    input: { version: number; assetId?: string },
  ): Promise<MediaCandidate | MediaCandidateDeleteResult>
  selectWorkspaceRoot(): Promise<DesktopWorkspaceStatus>
  ensureProject(project: { id: string; title: string }): Promise<LocalProject>
  getProject(projectId: string): Promise<LocalProject>
  importAssets(projectId: string, category: LocalAssetCategory): Promise<ImportedLocalAsset[]>
  removeAsset(projectId: string, assetId: string): Promise<LocalAsset>
  reconcileAssetIds(projectId: string, mappings: AssetIdMapping[]): Promise<LocalProject>
  assetPreviewUrl(projectId: string, assetId: string): string
  revealAsset(projectId: string, assetId: string): Promise<void>
  revealProject(projectId: string): Promise<void>
  exportVideoAssets(
    projectId: string,
    items: BatchVideoExportItem[],
  ): Promise<BatchVideoExportResult>
  listLocalAiConnections(): Promise<LocalAiConnection[]>
  saveLocalAiConnection(input: LocalAiConnectionInput): Promise<LocalAiConnection>
  discoverLocalAiModels(
    input: LocalAiConnectionDiscoveryInput,
  ): Promise<LocalAiModelDiscoveryResult>
  deleteLocalAiConnection(id: string, version: number): Promise<void>
  testLocalAiAddress(id: string): Promise<LocalAiConnectivityResult>
  generateLocalText(input: LocalTextGenerationInput): Promise<LocalTextGenerationResult>
  generateLocalImage(input: LocalImageGenerationInput): Promise<LocalImageGenerationResult>
  generateLocalMedia(input: LocalMediaGenerationInput): Promise<LocalMediaGenerationResult>
  generatedCandidatePreviewUrl(projectId: string, candidateId: string): string
  discardGeneratedImage(projectId: string, candidateId: string): Promise<void>
  discardGeneratedMedia(projectId: string, candidateId: string): Promise<void>
  cachePlatformImage(input: CachePlatformImageInput): Promise<CachedPlatformImageResult>
  saveGeneratedImage(input: SaveGeneratedImageInput): Promise<ImportedLocalAsset>
  saveGeneratedMedia(input: SaveGeneratedMediaInput): Promise<ImportedLocalAsset>
  extractVoiceSample(input: VoiceSampleExtractionInput): Promise<ImportedLocalAsset>
  extractLastVideoFrame(input: VideoFrameExtractionInput): Promise<ImportedLocalAsset>
  extractVideoFrame(input: VideoFrameExtractionInput): Promise<ImportedLocalAsset>
  renderPoseProxy(input: PoseProxyRenderInput): Promise<PoseProxyRenderResult>
  cancelPoseProxy(taskId: string): Promise<boolean>
  onPoseProxyProgress(callback: (progress: PoseProxyProgress) => void): () => void
  composeEpisode(input: EpisodeExportInput): Promise<EpisodeExportResult>
  cancelEpisodeExport(exportId: string): Promise<boolean>
  onExportProgress(callback: (progress: EpisodeExportProgress) => void): () => void
}

export interface BatchVideoExportItem {
  assetId: string
  fileName: string
}

export interface BatchVideoExportResult {
  canceled: boolean
  directory: string | null
  files: Array<{ assetId: string; fileName: string; filePath: string }>
}

export interface GenerationJobPage {
  items: GenerationJob[]
  page: number
  pageSize: number
  total: number
}

export interface PersistedAuthState {
  account: string
  password: string
  accessToken: string
  expiresAt: string
}

export type AiServiceType = 'TEXT' | 'IMAGE' | 'VIDEO' | 'TTS'

export interface LocalAiConnection {
  id: string
  serviceType: AiServiceType
  providerCode: string
  displayName: string
  baseUrl: string
  endpointPath?: string | null
  modelName: string
  apiKeyConfigured: boolean
  apiKeyHint?: string | null
  enabled: boolean
  defaultProvider: boolean
  version: number
  updatedAt: string
  storageMode: 'LOCAL'
}

export interface LocalAiConnectionInput {
  id?: string
  serviceType: AiServiceType
  providerCode: string
  displayName: string
  baseUrl: string
  endpointPath?: string | null
  modelName: string
  apiKey?: string
  clearApiKey: boolean
  enabled: boolean
  defaultProvider: boolean
  version?: number
}

export interface LocalAiConnectionDiscoveryInput {
  id?: string
  serviceType: AiServiceType
  providerCode?: string
  baseUrl: string
  endpointPath?: string | null
  apiKey?: string
}

export interface LocalAiModelDiscoveryResult {
  providerCode: string
  endpointPath: string
  models: string[]
}

export interface LocalAiConnectivityResult {
  status: 'REACHABLE' | 'DEGRADED' | 'UNREACHABLE'
  httpStatus: number | null
  message: string
  checkedAt: string
}

export interface LocalTextGenerationInput {
  connectionId: string
  systemPrompt: string
  userPrompt: string
  imageDataUrl?: string
  parameters?: Record<string, number>
  timeoutMillis?: number
}

export interface LocalTextGenerationResult {
  text: string
  providerCode: string
  modelName: string
  usage: {
    promptTokens: number | null
    completionTokens: number | null
    totalTokens: number | null
  } | null
  completedAt: string
}

export interface LocalImageGenerationInput {
  projectId: string
  connectionId: string
  prompt: string
  negativePrompt?: string | null
  size: ImageSize
  referenceImages?: Array<{
    name: string
    mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
    bytes: ArrayBuffer
  }>
  parameters?: Record<string, string>
  timeoutMillis?: number
}

export interface LocalImageGenerationResult {
  id: string
  projectId: string
  originalName: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  sizeBytes: number
  sha256: string
  width: number
  height: number
  createdAt: string
  providerCode: string
  modelName: string
  revisedPrompt?: string | null
}

export interface CachePlatformImageInput {
  projectId: string
  candidateId: string
  accessToken: string
}

export interface CachedPlatformImageResult {
  id: string
  projectId: string
  originalName: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  sizeBytes: number
  sha256: string
  width: number
  height: number
  createdAt: string
}

export interface LocalMediaGenerationInput {
  projectId: string
  connectionId: string
  mediaType: 'VIDEO' | 'TTS'
  prompt: string
  durationSec: number
  inputAssetId?: string | null
  referenceAssetIds?: string[]
  referenceImages?: Array<{ mimeType: string; bytes: ArrayBuffer }>
  voice?: string | null
  responseFormat?: 'mp3' | 'wav' | 'aac' | 'opus' | 'flac'
  speed?: number
  size?: string
  aspectRatio?: '9:16' | '16:9'
  parameters?: Record<string, string | number | boolean>
  timeoutMillis?: number
}

export interface LocalMediaGenerationResult {
  id: string
  projectId: string
  originalName: string
  mimeType: string
  sizeBytes: number
  sha256: string
  durationMs: number
  width?: number | null
  height?: number | null
  createdAt: string
  providerCode: string
  modelName: string
}

export type SaveGeneratedImageInput =
  | {
      projectId: string
      projectTitle: string
      candidateId: string
      deliveryType: 'LOCAL_CACHE'
      clientCandidateId: string
      category: 'images' | 'characters' | 'scenes' | 'storyboards'
    }
  | {
      projectId: string
      projectTitle: string
      candidateId: string
      deliveryType: 'PLATFORM_REMOTE'
      category: 'images' | 'characters' | 'scenes' | 'storyboards'
      accessToken: string
    }

export type SaveGeneratedMediaInput =
  | {
      projectId: string
      projectTitle: string
      candidateId: string
      deliveryType: 'LOCAL_CACHE'
      clientCandidateId: string
      category: 'audio' | 'videos'
    }
  | {
      projectId: string
      projectTitle: string
      candidateId: string
      deliveryType: 'PLATFORM_REMOTE' | 'PLATFORM_CACHE'
      category: 'audio' | 'videos'
      accessToken: string
    }

export interface VoiceSampleExtractionInput {
  projectId: string
  videoAssetId: string
  outputName: string
  startSec: number
  endSec: number
}

export interface VideoFrameExtractionInput {
  projectId: string
  videoAssetId: string
  outputName: string
  position?: 'FIRST' | 'LAST'
}

export interface PoseProxyLandmark {
  x: number
  y: number
  z?: number
  visibility: number
}

export interface PoseProxyFrame {
  poses: PoseProxyLandmark[][]
  poseMasks?: PoseProxyMask[]
}

export interface PoseProxyMask {
  width: number
  height: number
  alpha: Uint8Array
}

export interface PoseProxyRenderInput {
  taskId: string
  sourceWidth: number
  sourceHeight: number
  fps: number
  frames: PoseProxyFrame[]
}

export interface PoseProxyRenderResult {
  taskId: string
  fileName: string
  mimeType: 'video/mp4'
  bytes: Uint8Array
  width: number
  height: number
  fps: number
  durationSec: number
  detectedFrameRatio: number
}

export interface PoseProxyProgress {
  taskId: string
  stage: 'LOADING_MODEL' | 'ANALYZING' | 'RENDERING' | 'ENCODING' | 'SUCCEEDED'
  progress: number
  message: string
}

export interface EpisodeExportShotInput {
  storyboardId: string
  shotNo: number
  durationSec: number
  visualType: 'IMAGE' | 'VIDEO'
  visualAssetId: string
  audioMode: 'AI_DUB' | 'VIDEO_NATIVE'
  voiceAssetId?: string | null
  bgmAssetId?: string | null
  sfxAssetId?: string | null
  subtitle?: string | null
}

export interface EpisodeExportInput {
  exportId: string
  projectId: string
  episodeId: string
  outputName: string
  width: number
  height: number
  fps: number
  crf: number
  preset: 'veryfast' | 'faster' | 'fast' | 'medium' | 'slow'
  subtitles: boolean
  bgmVolume: number
  sfxVolume: number
  shots: EpisodeExportShotInput[]
}

export interface EpisodeExportProgress {
  exportId: string
  stage: 'RENDERING' | 'CONCATENATING' | 'SUCCEEDED'
  progress: number
  shotNo?: number | null
}

export interface EpisodeExportResult {
  exportId: string
  asset: ImportedLocalAsset
}

export interface DesktopRuntimeStatus {
  platform: string
  appVersion: string
  ffmpeg: {
    available: boolean
    bundled: boolean
    executable: string
    version: string | null
  }
}

export interface DesktopWorkspaceStatus {
  workspaceRoot: string
  projectCount: number
  disk: {
    freeBytes: number
    totalBytes: number
  }
}

export type LocalAssetCategory =
  'images' | 'characters' | 'scenes' | 'storyboards' | 'audio' | 'videos' | 'exports'

export interface LocalAsset {
  id: string
  category: LocalAssetCategory
  originalName: string
  relativePath: string
  sizeBytes: number
  sha256: string
  mimeType: string
  importedAt: string
  fileAvailable: boolean
}

export interface ImportedLocalAsset extends LocalAsset {
  duplicate: boolean
  repaired: boolean
}

export interface AssetIdMapping {
  clientAssetId: string
  assetId: string
}

export interface LocalProject {
  directory: string
  manifestPath: string
  projectId: string
  title: string
  updatedAt: string
  assets: LocalAsset[]
}

export interface LocalProjectInput {
  title: string
  description?: string
  visualStyle?: string
  visualBible?: string
  aspectRatio?: string
}

export interface LocalProjectRecord {
  id: string
  title: string
  description?: string
  visualStyle?: string
  visualBible?: string
  aspectRatio: string
  status: string
  version: number
  updatedAt: string
}

export interface DesktopReleaseInfo {
  id: string
  versionName: string
  versionCode: number
  channel: string
  platform: string
  title: string
  releaseNotes: string
  mandatory: boolean
  sizeBytes: number
  sha256: string
  fileName: string
  publishedAt?: string | null
}

export interface DesktopUpdateCheckResult {
  updateAvailable: boolean
  mandatory: boolean
  currentVersion: string
  latest: DesktopReleaseInfo | null
}

export interface DesktopUpdateInstallInput {
  releaseId: string
  sha256: string
  sizeBytes: number
  fileName?: string
}

export interface DesktopUpdateInstallResult {
  installerPath: string
  sha256: string
  sizeBytes: number
}

export interface DesktopUpdateProgress {
  stage: 'DOWNLOADING' | 'INSTALLING'
  progress: number
  receivedBytes: number
  totalBytes: number
}
