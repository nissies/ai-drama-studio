import { request } from './client'
import { isLocalProjectId } from './local-project'
import {
  applyLocalStructureCandidate,
  createLocalSourceDocument,
  createLocalSystemStructureCandidate,
  deleteLocalSourceDocument,
  getLocalSourceDocument,
  listLocalSourceDocuments,
  listLocalStructureCandidates,
  localSourceGenerationPlan,
  materializeLocalStructureCandidate,
  updateLocalSourceDocument,
} from './local-source'

export type SourceType = 'NOVEL' | 'SCRIPT'

export interface SourceDocument {
  id: string
  projectId: string
  title: string
  sourceType: SourceType
  status: string
  version: number
  revisionId: string
  revisionNo: number
  characterCount: number
  chunkCount: number
  contentSha256: string
  updatedAt: string
}

export interface SourceChunk {
  id: string
  chunkNo: number
  heading?: string | null
  startOffset: number
  endOffset: number
  characterCount: number
}

export interface SourceDocumentDetail {
  document: SourceDocument
  content: string
  chunks: SourceChunk[]
}

export interface SourceGenerationSegment {
  segmentNo: number
  segmentCount: number
  startChunkNo: number
  endChunkNo: number
  startOffset: number
  endOffset: number
  characterCount: number
  heading?: string | null
}

export interface SourceGenerationPlan {
  revisionId: string
  revisionNo: number
  characterCount: number
  segments: SourceGenerationSegment[]
}

export interface SourceDocumentInput {
  title: string
  sourceType: SourceType
  content: string
  version?: number
}

export interface SceneCandidate {
  candidateKey: string
  title: string
  location?: string | null
  timeOfDay?: string | null
  description?: string | null
  environmentPrompt?: string | null
}

export interface EpisodeCandidate {
  candidateKey: string
  title: string
  synopsis?: string | null
  scriptText: string
  targetDurationSec: number
  scenes: SceneCandidate[]
}

export interface CharacterCandidate {
  candidateKey: string
  name: string
  roleType?: string | null
  description?: string | null
  identityPrompt?: string | null
  negativePrompt?: string | null
}

export interface StructurePayload {
  schemaVersion: '1.0'
  episodes: EpisodeCandidate[]
  characters: CharacterCandidate[]
}

export interface ApplySummary {
  candidateId: string
  createdEpisodes: Record<string, string>
  createdCharacters: Record<string, string>
  reusedCharacters: Record<string, string>
  createdSceneIds: string[]
  appliedAt: string
}

export interface StructureCandidate {
  id: string
  projectId: string
  documentId: string
  sourceRevisionId: string
  generationJobId: string | null
  schemaVersion: string
  status: 'READY' | 'INVALID' | 'APPLIED'
  payload?: StructurePayload | null
  validationError?: string | null
  version: number
  application?: ApplySummary | null
  createdAt: string
  updatedAt: string
}

export interface CharacterDecision {
  candidateKey: string
  action: 'CREATE' | 'REUSE' | 'IGNORE'
  targetCharacterId?: string
}

function sourcePath(projectId: string, documentId?: string) {
  const base = `/projects/${encodeURIComponent(projectId)}/source-documents`
  return documentId ? `${base}/${encodeURIComponent(documentId)}` : base
}

function candidatePath(projectId: string, suffix = '') {
  return `/projects/${encodeURIComponent(projectId)}/structure-candidates${suffix}`
}

export const sourceDocumentApi = {
  list: (projectId: string) => isLocalProjectId(projectId)
    ? listLocalSourceDocuments(projectId)
    : request<SourceDocument[]>(sourcePath(projectId)),
  get: (projectId: string, documentId: string) =>
    isLocalProjectId(projectId)
      ? getLocalSourceDocument(projectId, documentId)
      : request<SourceDocumentDetail>(sourcePath(projectId, documentId)),
  generationPlan: (projectId: string, documentId: string) =>
    isLocalProjectId(projectId)
      ? localSourceGenerationPlan(projectId, documentId)
      : request<SourceGenerationPlan>(`${sourcePath(projectId, documentId)}/generation-plan`),
  create: (projectId: string, input: SourceDocumentInput) =>
    isLocalProjectId(projectId)
      ? createLocalSourceDocument(projectId, input)
      : request<SourceDocumentDetail>(sourcePath(projectId), {
          method: 'POST',
          body: JSON.stringify(input),
        }),
  update: (projectId: string, documentId: string, input: SourceDocumentInput) =>
    isLocalProjectId(projectId)
      ? updateLocalSourceDocument(projectId, documentId, input)
      : request<SourceDocumentDetail>(sourcePath(projectId, documentId), {
          method: 'PUT',
          body: JSON.stringify(input),
        }),
  delete: (projectId: string, documentId: string) =>
    isLocalProjectId(projectId)
      ? deleteLocalSourceDocument(projectId, documentId)
      : request<void>(sourcePath(projectId, documentId), { method: 'DELETE' }),
}

export const structureCandidateApi = {
  list: (projectId: string) => isLocalProjectId(projectId)
    ? listLocalStructureCandidates(projectId)
    : request<StructureCandidate[]>(candidatePath(projectId)),
  getByJob: (projectId: string, jobId: string) =>
    isLocalProjectId(projectId)
      ? materializeLocalStructureCandidate(projectId, jobId)
      : request<StructureCandidate>(
          candidatePath(projectId, `/by-job/${encodeURIComponent(jobId)}`),
        ),
  apply: (
    projectId: string,
    candidateId: string,
    input: {
      candidateVersion: number
      payloadJson: string
      selectedEpisodeKeys: string[]
      characterDecisions: CharacterDecision[]
    },
    idempotencyKey: string,
  ) => isLocalProjectId(projectId)
    ? applyLocalStructureCandidate(projectId, candidateId, input)
    : request<ApplySummary>(
        candidatePath(projectId, `/${encodeURIComponent(candidateId)}/apply`),
        {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotencyKey },
          body: JSON.stringify(input),
        },
      ),
  systemSplit: (
    projectId: string,
    input: {
      documentId: string
      episodeCountMode: 'AUTO' | 'FIXED'
      targetEpisodeCount: number
      targetCharactersPerEpisode?: number
      targetDurationSec: number
    },
    idempotencyKey: string,
  ) => isLocalProjectId(projectId)
    ? createLocalSystemStructureCandidate(projectId, input, idempotencyKey)
    : request<StructureCandidate>(candidatePath(projectId, '/system-split'), {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(input),
      }),
}
