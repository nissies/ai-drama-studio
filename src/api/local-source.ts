import type {
  ApplySummary,
  CharacterDecision,
  SourceChunk,
  SourceDocument,
  SourceDocumentDetail,
  SourceDocumentInput,
  SourceGenerationPlan,
  StructureCandidate,
  StructurePayload,
} from './source'
import { splitSourceIntoStructure } from '../domain/source-episode-splitter'

const CHUNK_SIZE = 40_000
const SEGMENT_SIZE = 120_000

export async function listLocalSourceDocuments(projectId: string): Promise<SourceDocument[]> {
  const data = await bridge().getLocalProjectData(projectId)
  return data.sourceDocuments
    .map((item) => item.document)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

export async function getLocalSourceDocument(projectId: string, documentId: string) {
  const data = await bridge().getLocalProjectData(projectId)
  const detail = data.sourceDocuments.find((item) => item.document.id === documentId)
  if (!detail) throw new Error('本地原文资料不存在')
  return structuredClone(detail)
}

export async function createLocalSourceDocument(projectId: string, input: SourceDocumentInput) {
  const data = await bridge().getLocalProjectData(projectId)
  const now = new Date().toISOString()
  const id = globalThis.crypto.randomUUID()
  const detail = await buildDetail(projectId, id, input, 0, 1, now)
  data.sourceDocuments.push(detail)
  await bridge().saveLocalProjectData(projectId, data)
  return detail
}

export async function updateLocalSourceDocument(
  projectId: string,
  documentId: string,
  input: SourceDocumentInput,
) {
  const data = await bridge().getLocalProjectData(projectId)
  const index = data.sourceDocuments.findIndex((item) => item.document.id === documentId)
  if (index < 0) throw new Error('本地原文资料不存在')
  const current = data.sourceDocuments[index]
  if (input.version !== current.document.version) throw new Error('原文资料已更新，请刷新后重试')
  const detail = await buildDetail(
    projectId,
    documentId,
    input,
    current.document.version + 1,
    current.document.revisionNo + 1,
    new Date().toISOString(),
  )
  data.sourceDocuments[index] = detail
  data.structureCandidates = data.structureCandidates.filter((item) => item.documentId !== documentId)
  await bridge().saveLocalProjectData(projectId, data)
  return detail
}

export async function deleteLocalSourceDocument(projectId: string, documentId: string) {
  const data = await bridge().getLocalProjectData(projectId)
  const next = data.sourceDocuments.filter((item) => item.document.id !== documentId)
  if (next.length === data.sourceDocuments.length) throw new Error('本地原文资料不存在')
  data.sourceDocuments = next
  data.structureCandidates = data.structureCandidates.filter((item) => item.documentId !== documentId)
  await bridge().saveLocalProjectData(projectId, data)
}

export async function localSourceGenerationPlan(projectId: string, documentId: string) {
  const detail = await getLocalSourceDocument(projectId, documentId)
  const segments: SourceGenerationPlan['segments'] = []
  let startChunk = 0
  while (startChunk < detail.chunks.length) {
    let endChunk = startChunk
    let characters = 0
    while (
      endChunk < detail.chunks.length &&
      (characters === 0 || characters + detail.chunks[endChunk].characterCount <= SEGMENT_SIZE)
    ) {
      characters += detail.chunks[endChunk].characterCount
      endChunk += 1
    }
    const first = detail.chunks[startChunk]
    const last = detail.chunks[endChunk - 1]
    segments.push({
      segmentNo: segments.length + 1,
      segmentCount: 0,
      startChunkNo: first.chunkNo,
      endChunkNo: last.chunkNo,
      startOffset: first.startOffset,
      endOffset: last.endOffset,
      characterCount: last.endOffset - first.startOffset,
      heading: first.heading,
    })
    startChunk = endChunk
  }
  for (const segment of segments) segment.segmentCount = segments.length
  return {
    revisionId: detail.document.revisionId,
    revisionNo: detail.document.revisionNo,
    characterCount: detail.document.characterCount,
    segments,
  }
}

export async function listLocalStructureCandidates(projectId: string) {
  return (await bridge().getLocalProjectData(projectId)).structureCandidates
    .slice()
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

export async function createLocalSystemStructureCandidate(
  projectId: string,
  input: {
    documentId: string
    episodeCountMode: 'AUTO' | 'FIXED'
    targetEpisodeCount: number
    targetCharactersPerEpisode?: number
    targetDurationSec: number
  },
  idempotencyKey: string,
) {
  const desktop = bridge()
  const data = await desktop.getLocalProjectData(projectId)
  const detail = data.sourceDocuments.find((item) => item.document.id === input.documentId)
  if (!detail) throw new Error('本地原文资料不存在')
  const candidateId = `local-system-structure-${idempotencyKey}`
  const existing = data.structureCandidates.find((item) => item.id === candidateId)
  if (existing) return structuredClone(existing)
  const payload = splitSourceIntoStructure(detail.content, input)
  const now = new Date().toISOString()
  const candidate: StructureCandidate = {
    id: candidateId,
    projectId,
    documentId: detail.document.id,
    sourceRevisionId: detail.document.revisionId,
    generationJobId: null,
    schemaVersion: '1.0',
    status: 'READY',
    payload,
    validationError: null,
    version: 0,
    application: null,
    createdAt: now,
    updatedAt: now,
  }
  data.structureCandidates.push(candidate)
  await desktop.saveLocalProjectData(projectId, data)
  return structuredClone(candidate)
}

export async function materializeLocalStructureCandidate(projectId: string, jobId: string) {
  const desktop = bridge()
  const [data, job] = await Promise.all([
    desktop.getLocalProjectData(projectId),
    desktop.getLocalGenerationJob(jobId),
  ])
  if (job.projectId !== projectId || !['SOURCE_STRUCTURE', 'SOURCE_STRUCTURE_MERGE'].includes(job.jobType)) {
    throw new Error('本地结构化任务无效')
  }
  if (job.status !== 'SUCCEEDED' || !job.resultText?.trim()) throw new Error('本地结构化任务尚未完成')
  const existing = data.structureCandidates.find((item) => item.generationJobId === jobId)
  if (existing) return existing
  const detail = data.sourceDocuments.find((item) => item.document.revisionId === job.targetId)
  if (!detail) throw new Error('结构化任务对应的原文版本不存在')
  const now = new Date().toISOString()
  let payload: StructurePayload | null = null
  let validationError: string | null = null
  try {
    payload = clearGeneratedScripts(parseStructurePayload(job.resultText))
  } catch (error) {
    validationError = error instanceof Error ? error.message : '结构化结果无法解析'
  }
  const candidate: StructureCandidate = {
    id: `local-structure-${job.id}`,
    projectId,
    documentId: detail.document.id,
    sourceRevisionId: detail.document.revisionId,
    generationJobId: job.id,
    schemaVersion: '1.0',
    status: payload ? 'READY' : 'INVALID',
    payload,
    validationError,
    version: 0,
    application: null,
    createdAt: now,
    updatedAt: now,
  }
  data.structureCandidates.push(candidate)
  await desktop.saveLocalProjectData(projectId, data)
  return candidate
}

export async function applyLocalStructureCandidate(
  projectId: string,
  candidateId: string,
  input: {
    candidateVersion: number
    payloadJson: string
    selectedEpisodeKeys: string[]
    characterDecisions: CharacterDecision[]
  },
): Promise<ApplySummary> {
  const desktop = bridge()
  const data = await desktop.getLocalProjectData(projectId)
  const index = data.structureCandidates.findIndex((item) => item.id === candidateId)
  if (index < 0) throw new Error('本地结构化候选不存在')
  const candidate = data.structureCandidates[index]
  if (candidate.application) return candidate.application
  if (candidate.status !== 'READY' || candidate.version !== input.candidateVersion) {
    throw new Error('结构化候选已变化，请重新打开')
  }
  const currentSource = data.sourceDocuments.find((item) => item.document.id === candidate.documentId)
  if (!currentSource || currentSource.document.revisionId !== candidate.sourceRevisionId) {
    throw new Error('原文已产生新版本，旧候选不能应用')
  }
  const payload = restrictScriptsToLegacyCandidate(
    parseStructurePayload(input.payloadJson),
    candidate.payload,
  )
  const episodeKeys = new Set(input.selectedEpisodeKeys)
  if (!episodeKeys.size) throw new Error('请至少选择一集')
  const availableEpisodeKeys = new Set(payload.episodes.map((item) => item.candidateKey))
  if ([...episodeKeys].some((key) => !availableEpisodeKeys.has(key))) {
    throw new Error('所选分集不在当前候选中')
  }
  const decisions = new Map(input.characterDecisions.map((item) => [item.candidateKey, item]))
  const now = new Date().toISOString()
  const createdCharacters: Record<string, string> = {}
  const reusedCharacters: Record<string, string> = {}
  for (const item of payload.characters) {
    const decision = decisions.get(item.candidateKey)
    if (!decision || decision.action === 'IGNORE') continue
    if (decision.action === 'REUSE') {
      const existing = data.characters.find((character) => character.id === decision.targetCharacterId)
      if (!existing) throw new Error(`复用角色不存在：${item.name}`)
      reusedCharacters[item.candidateKey] = existing.id
      continue
    }
    const id = globalThis.crypto.randomUUID()
    data.characters.push({
      id,
      projectId,
      name: item.name,
      roleType: item.roleType || undefined,
      description: item.description || undefined,
      identityPrompt: item.identityPrompt || undefined,
      negativePrompt: item.negativePrompt || undefined,
      status: 'DRAFT',
      version: 0,
      forms: [],
      updatedAt: now,
    })
    createdCharacters[item.candidateKey] = id
  }
  const createdEpisodes: Record<string, string> = {}
  const createdSceneIds: string[] = []
  let episodeNo = Math.max(0, ...data.episodes.map((episode) => episode.episodeNo)) + 1
  for (const item of payload.episodes) {
    if (!episodeKeys.has(item.candidateKey)) continue
    const episodeId = globalThis.crypto.randomUUID()
    data.episodes.push({
      id: episodeId,
      projectId,
      episodeNo,
      title: item.title,
      synopsis: item.synopsis || undefined,
      scriptText: item.scriptText,
      targetDurationSec: item.targetDurationSec,
      status: 'DRAFT',
      version: 0,
      updatedAt: now,
    })
    createdEpisodes[item.candidateKey] = episodeId
    episodeNo += 1
    let sceneNo = 1
    for (const scene of item.scenes) {
      const id = globalThis.crypto.randomUUID()
      data.scenes.push({
        id,
        projectId,
        episodeId,
        sceneNo,
        title: scene.title,
        location: scene.location || undefined,
        timeOfDay: scene.timeOfDay || undefined,
        description: scene.description || undefined,
        environmentPrompt: scene.environmentPrompt || undefined,
        status: 'DRAFT',
        version: 0,
        updatedAt: now,
      })
      createdSceneIds.push(id)
      sceneNo += 1
    }
  }
  const summary: ApplySummary = {
    candidateId,
    createdEpisodes,
    createdCharacters,
    reusedCharacters,
    createdSceneIds,
    appliedAt: now,
  }
  data.structureCandidates[index] = {
    ...candidate,
    status: 'APPLIED',
    payload,
    version: candidate.version + 1,
    application: summary,
    updatedAt: now,
  }
  await desktop.saveLocalProjectData(projectId, data)
  return summary
}

export function sourceDetailByRevision(
  data: { sourceDocuments: SourceDocumentDetail[] },
  revisionId: string,
) {
  return data.sourceDocuments.find((item) => item.document.revisionId === revisionId) || null
}

export function sourceSegmentContent(detail: SourceDocumentDetail, segmentNo: number) {
  const segments = buildSegments(detail)
  const segment = segments[segmentNo - 1]
  if (!segment) throw new Error('原文分段不存在')
  return {
    ...segment,
    content: detail.content.slice(segment.startOffset, segment.endOffset),
  }
}

function buildSegments(detail: SourceDocumentDetail) {
  const segments: Array<{
    segmentNo: number
    segmentCount: number
    startOffset: number
    endOffset: number
  }> = []
  let startChunk = 0
  while (startChunk < detail.chunks.length) {
    let endChunk = startChunk
    let characters = 0
    while (
      endChunk < detail.chunks.length &&
      (characters === 0 || characters + detail.chunks[endChunk].characterCount <= SEGMENT_SIZE)
    ) {
      characters += detail.chunks[endChunk].characterCount
      endChunk += 1
    }
    segments.push({
      segmentNo: segments.length + 1,
      segmentCount: 0,
      startOffset: detail.chunks[startChunk].startOffset,
      endOffset: detail.chunks[endChunk - 1].endOffset,
    })
    startChunk = endChunk
  }
  for (const segment of segments) segment.segmentCount = segments.length
  return segments
}

async function buildDetail(
  projectId: string,
  id: string,
  input: SourceDocumentInput,
  version: number,
  revisionNo: number,
  now: string,
): Promise<SourceDocumentDetail> {
  const title = input.title.trim()
  const content = input.content
  if (!title || title.length > 160) throw new Error('原文标题无效')
  if (!content.trim() || content.length > 10_000_000) throw new Error('原文内容必须在 1 到 1000 万字符之间')
  const chunks = splitChunks(content)
  return {
    document: {
      id,
      projectId,
      title,
      sourceType: input.sourceType,
      status: 'READY',
      version,
      revisionId: globalThis.crypto.randomUUID(),
      revisionNo,
      characterCount: content.length,
      chunkCount: chunks.length,
      contentSha256: await sha256(content),
      updatedAt: now,
    },
    content,
    chunks,
  }
}

function splitChunks(content: string): SourceChunk[] {
  const chunks: SourceChunk[] = []
  let start = 0
  while (start < content.length) {
    let end = Math.min(content.length, start + CHUNK_SIZE)
    if (end < content.length) {
      const newline = content.lastIndexOf('\n', end)
      if (newline > start + CHUNK_SIZE / 2) end = newline + 1
    }
    const text = content.slice(start, end)
    const heading = text.match(/^\s*(?:第.{1,20}[章节集回]|#{1,6}\s+[^\n]+)/)?.[0]?.trim() || null
    chunks.push({
      id: globalThis.crypto.randomUUID(),
      chunkNo: chunks.length + 1,
      heading,
      startOffset: start,
      endOffset: end,
      characterCount: end - start,
    })
    start = end
  }
  return chunks
}

function parseStructurePayload(value: string): StructurePayload {
  const normalized = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = normalized.indexOf('{')
  const end = normalized.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型没有返回完整 JSON 对象')
  const raw = JSON.parse(normalized.slice(start, end + 1)) as Record<string, unknown>
  if (raw.schemaVersion !== '1.0') throw new Error('结构化结果 schemaVersion 必须为 1.0')
  const episodes = requiredArray(raw.episodes, 'episodes', 2_000).map((entry, index) => {
    const item = record(entry, `episodes[${index}]`)
    const duration = Number(item.targetDurationSec)
    if (!Number.isFinite(duration) || duration < 5 || duration > 3_600) throw new Error('分集时长无效')
    const synopsis = optionalText(item.synopsis, 200_000)
    const scriptText = emptyText(item.scriptText, 500_000)
    if (!synopsis && !scriptText) throw new Error('分集剧情资料和剧本不能同时为空')
    return {
      candidateKey: key(item.candidateKey),
      title: text(item.title, 120),
      synopsis,
      scriptText,
      targetDurationSec: Math.round(duration),
      scenes: requiredArray(item.scenes, 'scenes', 300).map((sceneEntry) => {
        const scene = record(sceneEntry, 'scene')
        return {
          candidateKey: key(scene.candidateKey),
          title: text(scene.title, 120),
          location: optionalText(scene.location, 300),
          timeOfDay: optionalText(scene.timeOfDay, 80),
          description: optionalText(scene.description, 3_000),
          environmentPrompt: optionalText(scene.environmentPrompt, 5_000),
        }
      }),
    }
  })
  const characters = requiredArray(raw.characters, 'characters', 200).map((entry) => {
    const item = record(entry, 'character')
    return {
      candidateKey: key(item.candidateKey),
      name: text(item.name, 120),
      roleType: optionalText(item.roleType, 120),
      description: optionalText(item.description, 3_000),
      identityPrompt: optionalText(item.identityPrompt, 6_000),
      negativePrompt: optionalText(item.negativePrompt, 3_000),
    }
  })
  const keys = new Set<string>()
  for (const item of [...episodes, ...characters, ...episodes.flatMap((episode) => episode.scenes)]) {
    if (keys.has(item.candidateKey)) throw new Error(`候选标识重复：${item.candidateKey}`)
    keys.add(item.candidateKey)
  }
  if (!episodes.length) throw new Error('结构化结果没有分集')
  return { schemaVersion: '1.0', episodes, characters }
}

function clearGeneratedScripts(payload: StructurePayload): StructurePayload {
  const episodes = payload.episodes.map((episode) => {
    if (!episode.synopsis?.trim()) {
      throw new Error('长文分集结果缺少分集剧情资料')
    }
    return { ...episode, scriptText: '' }
  })
  return { ...payload, episodes }
}

function restrictScriptsToLegacyCandidate(
  submitted: StructurePayload,
  original?: StructurePayload | null,
): StructurePayload {
  const legacyScriptKeys = new Set(
    (original?.episodes || [])
      .filter((episode) => episode.scriptText?.trim())
      .map((episode) => episode.candidateKey),
  )
  return {
    ...submitted,
    episodes: submitted.episodes.map((episode) => {
      const scriptText = legacyScriptKeys.has(episode.candidateKey) ? episode.scriptText : ''
      if (!episode.synopsis?.trim() && !scriptText.trim()) {
        throw new Error('分集剧情资料和剧本不能同时为空')
      }
      return { ...episode, scriptText }
    }),
  }
}

function requiredArray(value: unknown, label: string, maximum: number) {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} 数组无效`)
  return value
}

function record(value: unknown, label: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 对象无效`)
  return value as Record<string, unknown>
}

function key(value: unknown) {
  const result = text(value, 120)
  if (!/^[A-Za-z0-9_-]+$/.test(result)) throw new Error('candidateKey 格式无效')
  return result
}

function text(value: unknown, maximum: number) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('候选必填文本为空')
  if (value.trim().length > maximum) throw new Error('候选文本超过允许长度')
  return value.trim()
}

function optionalText(value: unknown, maximum: number) {
  if (value == null || value === '') return null
  return text(String(value), maximum)
}

function emptyText(value: unknown, maximum: number) {
  if (value == null) return ''
  if (typeof value !== 'string') throw new Error('候选文本格式无效')
  if (value.trim().length > maximum) throw new Error('候选文本超过允许长度')
  return value.trim()
}

async function sha256(value: string) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function bridge() {
  const desktop = globalThis.window?.aiDramaDesktop
  if (!desktop) throw new Error('请在 Windows 客户端中使用本地原文资料')
  return desktop
}
