import { request } from './client'
import { isLocalProjectId } from './local-project'
import {
  applyLocalStoryboardCandidate,
  latestLocalStoryboardCandidate,
  localStoryboardCandidateByJob,
} from './local-candidates'

export interface StoryboardShotCandidate {
  candidateKey: string
  title: string
  sceneId?: string | null
  characterIds: string[]
  shotType?: string | null
  angle?: string | null
  movement?: string | null
  location?: string | null
  timeOfDay?: string | null
  actionText?: string | null
  dialogue?: string | null
  innerMonologue?: string | null
  description?: string | null
  resultText?: string | null
  atmosphere?: string | null
  imagePrompt?: string | null
  videoPrompt?: string | null
  bgmPrompt?: string | null
  soundEffect?: string | null
  durationSec: number
}

export interface StoryboardCandidatePayload {
  schemaVersion: '1.0'
  shots: StoryboardShotCandidate[]
}

export interface StoryboardCandidateApplySummary {
  candidateId: string
  createdStoryboards: Record<string, string>
  createdCount: number
  appliedAt: string
}

export interface StoryboardCandidate {
  id: string
  projectId: string
  episodeId: string
  generationJobId: string
  schemaVersion: string
  status: 'READY' | 'INVALID' | 'APPLIED'
  payload?: StoryboardCandidatePayload | null
  validationError?: string | null
  version: number
  application?: StoryboardCandidateApplySummary | null
  createdAt: string
  updatedAt: string
}

function candidatePath(projectId: string, suffix: string) {
  return `/projects/${encodeURIComponent(projectId)}/storyboard-candidates${suffix}`
}

export const storyboardCandidateApi = {
  latest: (projectId: string, episodeId: string) =>
    isLocalProjectId(projectId)
      ? latestLocalStoryboardCandidate(projectId, episodeId)
      : request<StoryboardCandidate>(
          candidatePath(projectId, `/latest?episodeId=${encodeURIComponent(episodeId)}`),
        ),
  getByJob: (projectId: string, jobId: string) =>
    jobId.startsWith('local-job-')
      ? localStoryboardCandidateByJob(projectId, jobId)
      : request<StoryboardCandidate>(
          candidatePath(projectId, `/by-job/${encodeURIComponent(jobId)}`),
        ),
  apply: (
    projectId: string,
    candidateId: string,
    input: {
      candidateVersion: number
      payloadJson: string
      selectedShotKeys: string[]
    },
    idempotencyKey: string,
  ) =>
    candidateId.startsWith('local-storyboards-')
      ? applyLocalStoryboardCandidate(projectId, candidateId, input)
      : request<StoryboardCandidateApplySummary>(
          candidatePath(projectId, `/${encodeURIComponent(candidateId)}/apply`),
          {
            method: 'POST',
            headers: { 'Idempotency-Key': idempotencyKey },
            body: JSON.stringify(input),
          },
        ),
}
