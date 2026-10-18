import { getStoredToken, request, requestBlob, requestForm } from './client'
import type { GenerationJob, GenerationRoute } from './generation'
import { toImageGenerationPayload } from './image-generation-payload'
import { createLocalBinaryGenerationJob } from './local-generation'
import { isLocalProjectId } from './local-project'

export type { ImageSize } from '../domain/image-sizes'
import type { ImageSize } from '../domain/image-sizes'

export type ImageTargetType = 'CHARACTER' | 'CHARACTER_FORM' | 'SCENE' | 'STORYBOARD' | 'IMAGE_LAB'
export type ImageCompositionType =
  | 'SINGLE'
  | 'TURNAROUND'
  | 'TURNAROUND_PORTRAIT'
  | 'CHARACTER_SHEET'
  | 'CONTACT_SHEET'
export type ImageCandidateStatus = 'AVAILABLE' | 'SELECTED' | 'LOCAL_SAVED'

export interface CreateImageGenerationInput {
  targetType: ImageTargetType
  targetId: string
  prompt: string
  negativePrompt?: string
  size: ImageSize
  compositionType: ImageCompositionType
  parameters?: Record<string, unknown>
  route: GenerationRoute
}

export interface ImageCandidate {
  id: string
  jobId: string
  /** 服务端候选所属项目；独立生图也使用服务端系统工作区保存素材。 */
  projectId?: string | null
  targetType: ImageTargetType
  targetId: string
  compositionType: ImageCompositionType
  providerCode: string
  modelName: string
  deliveryType: 'LOCAL_CACHE' | 'PLATFORM_REMOTE'
  clientCandidateId?: string | null
  previewAvailable: boolean
  remoteExpiresAt?: string | null
  prompt: string
  negativePrompt?: string | null
  revisedPrompt?: string | null
  mimeType?: string | null
  sizeBytes?: number | null
  sha256?: string | null
  width?: number | null
  height?: number | null
  status: ImageCandidateStatus
  localAssetId?: string | null
  version: number
  selectedAt?: string | null
  savedAt?: string | null
  createdAt: string
}

export interface LocalImageResultInput {
  clientCandidateId: string
  providerCode: string
  modelName: string
  mimeType: string
  sizeBytes: number
  sha256: string
  width: number
  height: number
  revisedPrompt?: string | null
}

export interface UploadedImageReference {
  id: string
  filename?: string | null
  mimeType: string
  sizeBytes: number
}

export interface DeleteImageCandidateResult {
  localAssetId?: string | null
  assetDeleted: boolean
}

export const imageGenerationApi = {
  create: (projectId: string, input: CreateImageGenerationInput, idempotencyKey: string) =>
    isLocalProjectId(projectId) && input.route.sourceType === 'LOCAL'
      ? createLocalBinaryGenerationJob({
          projectId,
          jobType: 'IMAGE_GENERATION',
          targetType: input.targetType,
          targetId: input.targetId,
          prompt: input.prompt,
          parameters: {
            ...input.parameters,
            negative_prompt: input.negativePrompt,
            size: input.size,
            composition_type: input.compositionType,
          },
          route: input.route,
        })
      : request<GenerationJob>(
          `/projects/${encodeURIComponent(projectId)}/image-generation-jobs`,
          {
            method: 'POST',
            headers: { 'Idempotency-Key': idempotencyKey },
            body: JSON.stringify(toImageGenerationPayload(input)),
          },
        ),
  completeLocal: (jobId: string, input: LocalImageResultInput) =>
    jobId.startsWith('local-job-')
      ? requiredDesktop().completeLocalImageGenerationJob(jobId, input)
      : request<ImageCandidate>(`/generation-jobs/${encodeURIComponent(jobId)}/local-image-result`, {
          method: 'POST',
          body: JSON.stringify(input),
        }),
  list: (projectId: string, targetType: ImageTargetType, targetId: string) =>
    isLocalProjectId(projectId)
      ? requiredDesktop().listLocalImageCandidates(projectId, targetType, targetId)
      : request<ImageCandidate[]>(
          `/projects/${encodeURIComponent(projectId)}/image-candidates?targetType=${encodeURIComponent(targetType)}&targetId=${encodeURIComponent(targetId)}`,
        ),
  select: (candidateId: string, version: number) =>
    candidateId.startsWith('local-image-')
      ? updateLocalImageCandidate(candidateId, 'SELECT', { version })
      : request<ImageCandidate>(`/image-candidates/${encodeURIComponent(candidateId)}/select`, {
          method: 'POST',
          body: JSON.stringify({ version }),
        }),
  confirmSaved: (candidateId: string, assetId: string, version: number) =>
    candidateId.startsWith('local-image-')
      ? updateLocalImageCandidate(candidateId, 'SAVE', { version, assetId })
      : request<ImageCandidate>(`/image-candidates/${encodeURIComponent(candidateId)}/local-asset`, {
          method: 'POST',
          body: JSON.stringify({ assetId, version }),
        }),
  preview: (candidateId: string) =>
    candidateId.startsWith('local-image-')
      ? previewLocalImageCandidate(candidateId)
      : requestBlob(`/image-candidates/${encodeURIComponent(candidateId)}/content`),
  delete: (candidateId: string, version: number) =>
    candidateId.startsWith('local-image-')
      ? deleteLocalImageCandidate(candidateId, version)
      : request<DeleteImageCandidateResult>(
          `/image-candidates/${encodeURIComponent(candidateId)}?version=${encodeURIComponent(version)}`,
          { method: 'DELETE' },
        ),
  uploadReferences: (files: File[]) => {
    const body = new FormData()
    files.forEach((file) => body.append('files', file, file.name))
    return requestForm<UploadedImageReference[]>('/image-references', body)
  },
  accessToken: () => getStoredToken(),
}

function requiredDesktop() {
  const desktop = globalThis.window?.aiDramaDesktop
  if (!desktop) throw new Error('请在 Windows 客户端中使用本地图片候选')
  return desktop
}

async function updateLocalImageCandidate(
  candidateId: string,
  action: 'SELECT' | 'SAVE',
  input: { version: number; assetId?: string },
) {
  return (await requiredDesktop().updateLocalImageCandidate(
    candidateId,
    action,
    input,
  )) as ImageCandidate
}

async function previewLocalImageCandidate(candidateId: string) {
  const desktop = requiredDesktop()
  const candidate = await desktop.getLocalImageCandidate(candidateId)
  if (!candidate.clientCandidateId) throw new Error('本地图片候选文件不存在')
  const response = await globalThis.fetch(
    desktop.generatedCandidatePreviewUrl(candidate.projectId, candidate.clientCandidateId),
  )
  if (!response.ok) throw new Error('本地图片候选预览读取失败')
  return response.blob()
}

async function deleteLocalImageCandidate(candidateId: string, version: number) {
  const desktop = requiredDesktop()
  const candidate = await desktop.getLocalImageCandidate(candidateId)
  const deleted = (await desktop.updateLocalImageCandidate(candidateId, 'DELETE', {
    version,
  })) as DeleteImageCandidateResult
  if (!candidate.localAssetId && candidate.clientCandidateId) {
    await desktop.discardGeneratedImage(candidate.projectId, candidate.clientCandidateId)
  }
  return deleted
}
