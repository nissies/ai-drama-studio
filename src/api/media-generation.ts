import { getStoredToken, request, requestBinary, requestForm } from './client'
import type { GenerationJob, GenerationRoute } from './generation'
import { createLocalBinaryGenerationJob } from './local-generation'
import { isLocalProjectId } from './local-project'

export type MediaType = 'VIDEO' | 'TTS'
export type MediaCandidateStatus = 'AVAILABLE' | 'SELECTED' | 'LOCAL_SAVED'

export interface CreateMediaGenerationInput {
  mediaType: MediaType
  storyboardId: string
  prompt: string
  durationSec: number
  inputAssetId?: string | null
  voice?: string | null
  route: GenerationRoute
  parameters?: Record<string, unknown>
}

export interface BatchMediaGenerationItemInput {
  storyboardId: string
  prompt: string
  finalPrompt?: string | null
  durationSec: number
  inputAssetId?: string | null
  voice?: string | null
  parameters?: Record<string, unknown>
}

export interface BatchMediaGenerationInput {
  mediaType: MediaType
  route: GenerationRoute
  parameters?: Record<string, unknown>
  items: BatchMediaGenerationItemInput[]
}

export interface BatchMediaGenerationItemResult {
  storyboardId: string
  jobId?: string | null
  status?: string | null
  success: boolean
  errorMessage?: string | null
  reservedPoints: number
}

export interface BatchMediaGenerationResult {
  totalCount: number
  successCount: number
  failedCount: number
  estimatedPoints: number
  reservedPoints: number
  items: BatchMediaGenerationItemResult[]
}

export interface BatchMediaGenerationPreviewItem {
  storyboardId: string
  durationSec: number
  effectivePrompt: string
  parameters: Record<string, unknown>
}

export interface BatchMediaGenerationPreviewResult {
  totalCount: number
  items: BatchMediaGenerationPreviewItem[]
}

export interface MediaCandidate {
  id: string
  jobId: string
  storyboardId: string
  mediaType: MediaType
  providerCode: string
  modelName: string
  deliveryType: 'LOCAL_CACHE' | 'PLATFORM_REMOTE' | 'PLATFORM_CACHE'
  clientCandidateId?: string | null
  previewAvailable: boolean
  remoteExpiresAt?: string | null
  prompt: string
  inputAssetId?: string | null
  mimeType?: string | null
  sizeBytes?: number | null
  sha256?: string | null
  durationMs?: number | null
  width?: number | null
  height?: number | null
  status: MediaCandidateStatus
  localAssetId?: string | null
  version: number
  selectedAt?: string | null
  savedAt?: string | null
  createdAt: string
}

export interface LocalMediaResultInput {
  clientCandidateId: string
  providerCode: string
  modelName: string
  mimeType: string
  sizeBytes: number
  sha256: string
  durationMs: number
  width?: number | null
  height?: number | null
}

export interface UploadedMediaReference {
  id: string
  filename?: string | null
  mediaType: 'IMAGE' | 'VIDEO' | 'AUDIO'
  mimeType: string
  sizeBytes: number
}

export interface MediaCandidateDeleteResult {
  localAssetId?: string | null
  assetDeleted: boolean
}

function toRoutePayload(route?: GenerationRoute) {
  if (!route) throw new Error('请先选择一个生成模型')
  return {
    sourceType: route.sourceType,
    localConnectionId: route.sourceType === 'LOCAL' ? route.localConnectionId : undefined,
    localProviderCode: route.sourceType === 'LOCAL' ? route.localProviderCode : undefined,
    localModelName: route.sourceType === 'LOCAL' ? route.localModelName : undefined,
    platformModelId: route.sourceType === 'PLATFORM' ? route.platformModelId : undefined,
  }
}

export const mediaGenerationApi = {
  uploadReferences: (files: File[]) => {
    const body = new FormData()
    files.forEach((file) => body.append('files', file, file.name))
    return requestForm<UploadedMediaReference[]>('/media-references', body)
  },
  create: (projectId: string, input: CreateMediaGenerationInput, idempotencyKey: string) => {
    if (isLocalProjectId(projectId) && input.route.sourceType === 'LOCAL') {
      return createLocalBinaryGenerationJob({
        projectId,
        jobType: input.mediaType === 'VIDEO' ? 'VIDEO_GENERATION' : 'TTS_GENERATION',
        targetType: 'STORYBOARD',
        targetId: input.storyboardId,
        prompt: input.prompt,
        parameters: {
          ...input.parameters,
          duration_sec: input.durationSec,
          input_asset_id: input.inputAssetId ?? undefined,
          voice: input.voice ?? undefined,
          speed: input.parameters?.speed,
          instructions: input.parameters?.instructions,
        },
        route: input.route,
      })
    }
    const routePayload = toRoutePayload(input.route)
    return request<GenerationJob>(`/projects/${encodeURIComponent(projectId)}/media-generation-jobs`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({
        mediaType: input.mediaType,
        storyboardId: input.storyboardId,
        prompt: input.prompt,
        durationSec: input.durationSec,
        inputAssetId: input.inputAssetId ?? undefined,
        voice: input.voice ?? undefined,
        ...routePayload,
        parameters: input.parameters ?? {},
      }),
    })
  },
  createBatch: (projectId: string, input: BatchMediaGenerationInput, idempotencyKey: string) => {
    if (isLocalProjectId(projectId) && input.route.sourceType === 'LOCAL') {
      return createLocalMediaBatch(projectId, input)
    }
    const routePayload = toRoutePayload(input.route)
    return request<BatchMediaGenerationResult>(
      `/projects/${encodeURIComponent(projectId)}/media-generation-jobs/batch`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({
          mediaType: input.mediaType,
          ...routePayload,
          parameters: input.parameters ?? {},
          items: input.items.map((item) => ({
            storyboardId: item.storyboardId,
            prompt: item.prompt,
            finalPrompt: item.finalPrompt ?? undefined,
            durationSec: item.durationSec,
            inputAssetId: item.inputAssetId ?? undefined,
            voice: item.voice ?? undefined,
            parameters: item.parameters ?? {},
          })),
        }),
      },
    )
  },
  previewBatch: (
    projectId: string,
    input: Pick<BatchMediaGenerationInput, 'mediaType' | 'parameters' | 'items'>,
  ) =>
    isLocalProjectId(projectId)
      ? Promise.resolve({
          totalCount: input.items.length,
          items: input.items.map((item) => ({
            storyboardId: item.storyboardId,
            durationSec: item.durationSec,
            effectivePrompt: item.finalPrompt?.trim() || item.prompt,
            parameters: { ...input.parameters, ...item.parameters },
          })),
        })
      : request<BatchMediaGenerationPreviewResult>(
      `/projects/${encodeURIComponent(projectId)}/media-generation-jobs/batch/preview`,
      {
        method: 'POST',
        body: JSON.stringify({
          mediaType: input.mediaType,
          parameters: input.parameters ?? {},
          items: input.items.map((item) => ({
            storyboardId: item.storyboardId,
            prompt: item.prompt,
            finalPrompt: item.finalPrompt ?? undefined,
            durationSec: item.durationSec,
            inputAssetId: item.inputAssetId ?? undefined,
            voice: item.voice ?? undefined,
            parameters: item.parameters ?? {},
          })),
        }),
      },
        ),
  completeLocal: (jobId: string, input: LocalMediaResultInput) =>
    jobId.startsWith('local-job-')
      ? requiredDesktop().completeLocalMediaGenerationJob(jobId, input)
      : request<MediaCandidate>(`/generation-jobs/${encodeURIComponent(jobId)}/local-media-result`, {
          method: 'POST',
          body: JSON.stringify(input),
        }),
  list: (projectId: string, storyboardId: string, mediaType: MediaType) =>
    isLocalProjectId(projectId)
      ? requiredDesktop().listLocalMediaCandidates(projectId, storyboardId, mediaType)
      : request<MediaCandidate[]>(
          `/projects/${encodeURIComponent(projectId)}/media-candidates?storyboardId=${encodeURIComponent(storyboardId)}&mediaType=${mediaType}`,
        ),
  select: (candidateId: string, version: number) =>
    candidateId.startsWith('local-media-')
      ? updateLocalMediaCandidate(candidateId, 'SELECT', { version })
      : request<MediaCandidate>(`/media-candidates/${encodeURIComponent(candidateId)}/select`, {
          method: 'POST',
          body: JSON.stringify({ version }),
        }),
  confirmSaved: (candidateId: string, assetId: string, version: number) =>
    candidateId.startsWith('local-media-')
      ? updateLocalMediaCandidate(candidateId, 'SAVE', { version, assetId })
      : request<MediaCandidate>(`/media-candidates/${encodeURIComponent(candidateId)}/local-asset`, {
          method: 'POST',
          body: JSON.stringify({ assetId, version }),
        }),
  delete: (candidateId: string, version: number) =>
    candidateId.startsWith('local-media-')
      ? deleteLocalMediaCandidate(candidateId, version)
      : request<MediaCandidateDeleteResult>(
          `/media-candidates/${encodeURIComponent(candidateId)}?version=${version}`,
          { method: 'DELETE' },
        ),
  preview: (candidateId: string) =>
    candidateId.startsWith('local-media-')
      ? previewLocalMediaCandidate(candidateId)
      : requestBinary(
          `/media-candidates/${encodeURIComponent(candidateId)}/content`,
          [
            'video/mp4',
            'video/webm',
            'video/quicktime',
            'audio/mpeg',
            'audio/wav',
            'audio/x-wav',
            'audio/aac',
            'audio/mp4',
            'audio/ogg',
            'audio/flac',
          ],
        ),
  accessToken: () => getStoredToken(),
}

async function createLocalMediaBatch(
  projectId: string,
  input: BatchMediaGenerationInput,
): Promise<BatchMediaGenerationResult> {
  if (input.route.sourceType !== 'LOCAL') throw new Error('本地批量任务只能使用本地模型')
  const results = await Promise.allSettled(
    input.items.map((item) =>
      createLocalBinaryGenerationJob({
        projectId,
        jobType: input.mediaType === 'VIDEO' ? 'VIDEO_GENERATION' : 'TTS_GENERATION',
        targetType: 'STORYBOARD',
        targetId: item.storyboardId,
        prompt: item.finalPrompt?.trim() || item.prompt,
        parameters: {
          ...input.parameters,
          ...item.parameters,
          duration_sec: item.durationSec,
          input_asset_id: item.inputAssetId ?? undefined,
          voice: item.voice ?? undefined,
        },
        route: input.route,
      }),
    ),
  )
  const items = results.map((result, index) => {
    const storyboardId = input.items[index].storyboardId
    return result.status === 'fulfilled'
      ? {
          storyboardId,
          jobId: result.value.id,
          status: result.value.status,
          success: true,
          reservedPoints: 0,
        }
      : {
          storyboardId,
          status: 'FAILED',
          success: false,
          errorMessage:
            result.reason instanceof Error ? result.reason.message : '本地任务创建失败',
          reservedPoints: 0,
        }
  })
  return {
    totalCount: items.length,
    successCount: items.filter((item) => item.success).length,
    failedCount: items.filter((item) => !item.success).length,
    estimatedPoints: 0,
    reservedPoints: 0,
    items,
  }
}

function requiredDesktop() {
  const desktop = globalThis.window?.aiDramaDesktop
  if (!desktop) throw new Error('请在 Windows 客户端中使用本地媒体候选')
  return desktop
}

async function updateLocalMediaCandidate(
  candidateId: string,
  action: 'SELECT' | 'SAVE',
  input: { version: number; assetId?: string },
) {
  return (await requiredDesktop().updateLocalMediaCandidate(
    candidateId,
    action,
    input,
  )) as MediaCandidate
}

async function previewLocalMediaCandidate(candidateId: string) {
  const desktop = requiredDesktop()
  const candidate = await desktop.getLocalMediaCandidate(candidateId)
  if (!candidate.clientCandidateId) throw new Error('本地媒体候选文件不存在')
  const response = await globalThis.fetch(
    desktop.generatedCandidatePreviewUrl(candidate.projectId, candidate.clientCandidateId),
  )
  if (!response.ok) throw new Error('本地媒体候选预览读取失败')
  return response.blob()
}

async function deleteLocalMediaCandidate(candidateId: string, version: number) {
  const desktop = requiredDesktop()
  const candidate = await desktop.getLocalMediaCandidate(candidateId)
  const deleted = (await desktop.updateLocalMediaCandidate(candidateId, 'DELETE', {
    version,
  })) as MediaCandidateDeleteResult
  if (!candidate.localAssetId && candidate.clientCandidateId) {
    await desktop.discardGeneratedMedia(candidate.projectId, candidate.clientCandidateId)
  }
  return deleted
}
