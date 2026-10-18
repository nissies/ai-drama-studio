import { request } from './client'
import type { EpisodeExportShotInput } from '../desktop/types'
import { isLocalProjectId } from './local-project'

export type ExportJobStatus = 'WAITING_LOCAL' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED'

export interface ExportSettingsInput {
  width: number
  height: number
  fps: number
  crf: number
  preset: 'veryfast' | 'faster' | 'fast' | 'medium' | 'slow'
  subtitles: boolean
  bgmVolume: number
  sfxVolume: number
}

export interface ExportJob {
  id: string
  projectId: string
  episodeId: string
  status: ExportJobStatus
  stage?: 'RENDERING' | 'CONCATENATING' | 'SUCCEEDED' | null
  progress: number
  currentShotNo?: number | null
  clientExportId?: string | null
  outputAssetId?: string | null
  outputFilename?: string | null
  errorCode?: string | null
  errorMessage?: string | null
  version: number
  createdAt: string
  updatedAt: string
  finishedAt?: string | null
}

function episodePath(projectId: string, episodeId: string) {
  return `/projects/${encodeURIComponent(projectId)}/episodes/${encodeURIComponent(episodeId)}/export-jobs`
}

function jobPath(jobId: string) {
  return `/export-jobs/${encodeURIComponent(jobId)}`
}

export const exportJobApi = {
  create: (
    projectId: string,
    episodeId: string,
    input: { outputName: string; settings: ExportSettingsInput; shots: EpisodeExportShotInput[] },
    idempotencyKey: string,
  ) => isLocalProjectId(projectId)
    ? requiredDesktop().createLocalExportJob(projectId, episodeId, input, idempotencyKey)
    : request<ExportJob>(episodePath(projectId, episodeId), {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(input),
      }),
  list: (projectId: string, episodeId: string) =>
    isLocalProjectId(projectId)
      ? requiredDesktop().listLocalExportJobs(projectId, episodeId)
      : request<ExportJob[]>(episodePath(projectId, episodeId)),
  get: (jobId: string) => isLocalExportJobId(jobId)
    ? requiredDesktop().getLocalExportJob(jobId)
    : request<ExportJob>(jobPath(jobId)),
  start: (jobId: string, clientExportId: string) =>
    isLocalExportJobId(jobId)
      ? requiredDesktop().updateLocalExportJob(jobId, 'START', { clientExportId })
      : request<ExportJob>(`${jobPath(jobId)}/start`, {
      method: 'POST',
      body: JSON.stringify({ clientExportId }),
    }),
  progress: (
    jobId: string,
    input: { clientExportId: string; progress: number; stage: string; shotNo?: number | null },
  ) => isLocalExportJobId(jobId)
    ? requiredDesktop().updateLocalExportJob(jobId, 'PROGRESS', input)
    : request<ExportJob>(`${jobPath(jobId)}/progress`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
  complete: (
    jobId: string,
    input: { clientExportId: string; outputAssetId: string; outputFilename: string },
  ) => isLocalExportJobId(jobId)
    ? requiredDesktop().updateLocalExportJob(jobId, 'COMPLETE', input)
    : request<ExportJob>(`${jobPath(jobId)}/complete`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
  fail: (jobId: string, clientExportId: string, message: string) =>
    isLocalExportJobId(jobId)
      ? requiredDesktop().updateLocalExportJob(jobId, 'FAIL', { clientExportId, message })
      : request<ExportJob>(`${jobPath(jobId)}/failure`, {
          method: 'POST',
          body: JSON.stringify({ clientExportId, message }),
        }),
  cancel: (jobId: string) => isLocalExportJobId(jobId)
    ? requiredDesktop().updateLocalExportJob(jobId, 'CANCEL')
    : request<ExportJob>(`${jobPath(jobId)}/cancel`, { method: 'POST' }),
  retry: (jobId: string) => isLocalExportJobId(jobId)
    ? requiredDesktop().updateLocalExportJob(jobId, 'RETRY')
    : request<ExportJob>(`${jobPath(jobId)}/retry`, { method: 'POST' }),
}

function isLocalExportJobId(jobId: string) {
  return jobId.startsWith('local-export-')
}

function requiredDesktop() {
  const desktop = globalThis.window?.aiDramaDesktop
  if (!desktop) throw new Error('请在 Windows 客户端中操作本地导出任务')
  return desktop
}
