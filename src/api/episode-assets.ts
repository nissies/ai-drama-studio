import { request } from './client'
import { isLocalProjectId } from './local-project'
import {
  applyLocalEpisodeAssetCandidate,
  latestLocalEpisodeAssetCandidate,
  localEpisodeAssetCandidateByJob,
} from './local-candidates'

export interface EpisodeCharacterCandidate {
  candidateKey: string
  name: string
  roleType?: string | null
  description?: string | null
  identityPrompt?: string | null
  negativePrompt?: string | null
}

export interface EpisodeSceneCandidate {
  candidateKey: string
  title: string
  location?: string | null
  timeOfDay?: string | null
  description?: string | null
  environmentPrompt?: string | null
}

export interface EpisodeAssetPayload {
  schemaVersion: '1.0'
  characters: EpisodeCharacterCandidate[]
  scenes: EpisodeSceneCandidate[]
}

export interface EpisodeAssetApplySummary {
  candidateId: string
  createdCharacters: Record<string, string>
  reusedCharacters: Record<string, string>
  createdSceneIds: string[]
  appliedAt: string
}

export interface EpisodeAssetCandidate {
  id: string
  projectId: string
  episodeId: string
  generationJobId: string
  schemaVersion: string
  status: 'READY' | 'INVALID' | 'APPLIED'
  payload?: EpisodeAssetPayload | null
  validationError?: string | null
  version: number
  application?: EpisodeAssetApplySummary | null
  createdAt: string
  updatedAt: string
}

export interface EpisodeCharacterDecision {
  candidateKey: string
  action: 'CREATE' | 'REUSE' | 'IGNORE'
  targetCharacterId?: string
}

function candidatePath(projectId: string, suffix: string) {
  return `/projects/${encodeURIComponent(projectId)}/episode-asset-candidates${suffix}`
}

export const episodeAssetCandidateApi = {
  latest: (projectId: string, episodeId: string) =>
    isLocalProjectId(projectId)
      ? latestLocalEpisodeAssetCandidate(projectId, episodeId)
      : request<EpisodeAssetCandidate>(
          candidatePath(projectId, `/latest?episodeId=${encodeURIComponent(episodeId)}`),
        ),
  getByJob: (projectId: string, jobId: string) =>
    jobId.startsWith('local-job-')
      ? localEpisodeAssetCandidateByJob(projectId, jobId)
      : request<EpisodeAssetCandidate>(
          candidatePath(projectId, `/by-job/${encodeURIComponent(jobId)}`),
        ),
  apply: (
    projectId: string,
    candidateId: string,
    input: {
      candidateVersion: number
      payloadJson: string
      selectedSceneKeys: string[]
      characterDecisions: EpisodeCharacterDecision[]
    },
    idempotencyKey: string,
  ) =>
    candidateId.startsWith('local-episode-assets-')
      ? applyLocalEpisodeAssetCandidate(projectId, candidateId, input)
      : request<EpisodeAssetApplySummary>(
          candidatePath(projectId, `/${encodeURIComponent(candidateId)}/apply`),
          {
            method: 'POST',
            headers: { 'Idempotency-Key': idempotencyKey },
            body: JSON.stringify(input),
          },
        ),
}
