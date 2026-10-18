import { getStoredToken, request } from './client'
import { toCreatePayload } from './generation-payload'
import { createLocalGenerationJob } from './local-generation'
import { isLocalProjectId } from './local-project'

export type GenerationSourceType = 'LOCAL' | 'PLATFORM'
export type GenerationJobStatus =
  'WAITING_LOCAL' | 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED'

export type GenerationRoute =
  | {
      sourceType: 'LOCAL'
      localConnectionId: string
      localProviderCode: string
      localModelName: string
    }
  | {
      sourceType: 'PLATFORM'
      platformModelId: string
      platformModelCode?: string
      platformProtocolProfile?: string
      modelName?: string
    }

export interface CreateGenerationJobInput {
  jobType:
    | 'SCRIPT_GENERATE'
    | 'SCRIPT_REWRITE'
    | 'EPISODE_ASSET_EXTRACT'
    | 'STORYBOARD_GENERATE'
    | 'PROJECT_VISUAL_BIBLE_GENERATE'
    | 'VOICE_INSTRUCTION_GENERATE'
    | 'STORYBOARD_CONTACT_SHEET_PLAN'
    | 'SOURCE_STRUCTURE'
    | 'SOURCE_STRUCTURE_SEGMENT'
    | 'SOURCE_STRUCTURE_MERGE'
    | 'IMAGE_GENERATION'
    | 'VIDEO_GENERATION'
    | 'TTS_GENERATION'
  targetType:
    | 'EPISODE'
    | 'PROJECT'
    | 'SOURCE_REVISION'
    | 'CHARACTER'
    | 'CHARACTER_FORM'
    | 'SCENE'
    | 'STORYBOARD'
    | 'VIDEO_LAB'
    | 'IMAGE_LAB'
  targetId: string
  parameters?: Record<string, unknown>
  route: GenerationRoute
}

export interface GenerationExecutionRequest {
  systemPrompt: string
  userPrompt: string
  parameters: Record<string, unknown>
}

export interface GenerationJob {
  id: string
  projectId: string
  jobType:
    | 'SCRIPT_GENERATE'
    | 'SCRIPT_REWRITE'
    | 'EPISODE_ASSET_EXTRACT'
    | 'STORYBOARD_GENERATE'
    | 'PROJECT_VISUAL_BIBLE_GENERATE'
    | 'VOICE_INSTRUCTION_GENERATE'
    | 'STORYBOARD_CONTACT_SHEET_PLAN'
    | 'SOURCE_STRUCTURE'
    | 'SOURCE_STRUCTURE_SEGMENT'
    | 'SOURCE_STRUCTURE_MERGE'
    | 'IMAGE_GENERATION'
    | 'VIDEO_GENERATION'
    | 'TTS_GENERATION'
  serviceType: 'TEXT' | 'IMAGE' | 'VIDEO' | 'TTS'
  targetType:
    | 'EPISODE'
    | 'PROJECT'
    | 'SOURCE_REVISION'
    | 'CHARACTER'
    | 'CHARACTER_FORM'
    | 'SCENE'
    | 'STORYBOARD'
    | 'VIDEO_LAB'
    | 'IMAGE_LAB'
  targetId: string
  targetVersion: number
  sourceType: GenerationSourceType
  localConnectionId?: string | null
  platformModelId?: string | null
  sourceDisplayName?: string | null
  modelName?: string | null
  status: GenerationJobStatus
  progress: number
  executionRequest?: GenerationExecutionRequest | null
  resultText?: string | null
  errorCode?: string | null
  errorMessage?: string | null
  attemptCount: number
  createdAt: string
  updatedAt: string
}

function projectJobsPath(projectId: string) {
  return `/projects/${encodeURIComponent(projectId)}/generation-jobs`
}

function jobPath(jobId: string) {
  return `/generation-jobs/${encodeURIComponent(jobId)}`
}

export const generationApi = {
  create: (projectId: string, input: CreateGenerationJobInput, idempotencyKey: string) =>
    isLocalProjectId(projectId)
      ? createLocalGenerationJob(projectId, input)
      : request<GenerationJob>(projectJobsPath(projectId), {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotencyKey },
          body: JSON.stringify(toCreatePayload(input)),
        }),
  get: (jobId: string) =>
    isLocalJobId(jobId)
      ? requiredDesktop().getLocalGenerationJob(jobId)
      : request<GenerationJob>(jobPath(jobId)),
  listMine: async (page = 1, pageSize = 100) => {
    const desktop = globalThis.window?.aiDramaDesktop
    const localPage = desktop
      ? await desktop.listAllLocalGenerationJobs(page, pageSize)
      : emptyPage(page, pageSize)
    if (!getStoredToken()) return localPage
    const cloudPage = await request<GenerationJobPage>(
      `/generation-jobs?page=${page}&pageSize=${pageSize}`,
    ).catch((error) => {
      if (!desktop) throw error
      return emptyPage(page, pageSize)
    })
    return mergePages(localPage, cloudPage, page, pageSize)
  },
  list: (projectId: string, page = 1, pageSize = 100) =>
    isLocalProjectId(projectId)
      ? requiredDesktop().listLocalGenerationJobs(projectId, page, pageSize)
      : request<GenerationJobPage>(
          `${projectJobsPath(projectId)}?page=${page}&pageSize=${pageSize}`,
        ),
  startLocal: (jobId: string) =>
    isLocalJobId(jobId)
      ? requiredDesktop().updateLocalGenerationJob(jobId, 'START')
      : request<GenerationJob>(`${jobPath(jobId)}/local-start`, { method: 'POST' }),
  heartbeatLocal: (jobId: string, progress = 20) =>
    isLocalJobId(jobId)
      ? requiredDesktop().updateLocalGenerationJob(jobId, 'HEARTBEAT', { progress })
      : request<GenerationJob>(
          `${jobPath(jobId)}/local-heartbeat?progress=${Math.max(0, Math.min(100, Math.round(progress)))}`,
          { method: 'POST' },
        ),
  completeLocal: (
    jobId: string,
    input: {
      text: string
      providerCode: string
      modelName: string
      usage?: {
        promptTokens: number | null
        completionTokens: number | null
        totalTokens: number | null
      } | null
    },
  ) =>
    isLocalJobId(jobId)
      ? requiredDesktop().updateLocalGenerationJob(jobId, 'COMPLETE', input)
      : request<GenerationJob>(`${jobPath(jobId)}/local-result`, {
          method: 'POST',
          body: JSON.stringify(input),
        }),
  failLocal: (jobId: string, message: string) =>
    isLocalJobId(jobId)
      ? requiredDesktop().updateLocalGenerationJob(jobId, 'FAIL', { message })
      : request<GenerationJob>(`${jobPath(jobId)}/local-failure`, {
          method: 'POST',
          body: JSON.stringify({ message }),
        }),
  cancel: (jobId: string) =>
    isLocalJobId(jobId)
      ? requiredDesktop().updateLocalGenerationJob(jobId, 'CANCEL')
      : request<GenerationJob>(`${jobPath(jobId)}/cancel`, { method: 'POST' }),
  retry: (jobId: string) =>
    isLocalJobId(jobId)
      ? retryLocalJob(jobId)
      : request<GenerationJob>(`${jobPath(jobId)}/retry`, { method: 'POST' }),
}

type GenerationJobPage = { items: GenerationJob[]; page: number; pageSize: number; total: number }

function isLocalJobId(jobId: string) {
  return jobId.startsWith('local-job-')
}

function requiredDesktop() {
  const desktop = globalThis.window?.aiDramaDesktop
  if (!desktop) throw new Error('请在 Windows 客户端中操作本地生成任务')
  return desktop
}

function emptyPage(page: number, pageSize: number): GenerationJobPage {
  return { items: [], page, pageSize, total: 0 }
}

function mergePages(
  localPage: GenerationJobPage,
  cloudPage: GenerationJobPage,
  page: number,
  pageSize: number,
): GenerationJobPage {
  const items = [...localPage.items, ...cloudPage.items]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, pageSize)
  return { items, page, pageSize, total: localPage.total + cloudPage.total }
}

async function retryLocalJob(jobId: string) {
  const desktop = requiredDesktop()
  let job = await desktop.updateLocalGenerationJob(jobId, 'RETRY')
  if (!job.executionRequest || job.serviceType !== 'TEXT') return job
  job = await desktop.updateLocalGenerationJob(jobId, 'START')
  try {
    const result = await desktop.generateLocalText({
      connectionId: job.localConnectionId!,
      systemPrompt: job.executionRequest.systemPrompt,
      userPrompt: job.executionRequest.userPrompt,
      parameters: job.executionRequest.parameters as Record<string, number>,
    })
    return desktop.updateLocalGenerationJob(jobId, 'COMPLETE', result as unknown as Record<string, unknown>)
  } catch (error) {
    const message = error instanceof Error ? error.message : '本地 AI 执行失败'
    await desktop.updateLocalGenerationJob(jobId, 'FAIL', { message })
    throw error
  }
}

export function startLocalJobHeartbeat(jobId: string, progress = 20) {
  const interval = globalThis.setInterval(() => {
    void generationApi.heartbeatLocal(jobId, progress).catch(() => {
    })
  }, 60_000)
  return () => globalThis.clearInterval(interval)
}
