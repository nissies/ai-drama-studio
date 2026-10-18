import type {
  EpisodeAssetApplySummary,
  EpisodeAssetCandidate,
  EpisodeAssetPayload,
  EpisodeCharacterDecision,
} from './episode-assets'
import type { GenerationJob } from './generation'
import type {
  StoryboardCandidate,
  StoryboardCandidateApplySummary,
  StoryboardCandidatePayload,
  StoryboardShotCandidate,
} from './storyboard-candidates'
import type { LocalProjectData } from './local-project'
import { ApiClientError } from './client'

const EPISODE_CANDIDATE_PREFIX = 'local-episode-assets-'
const STORYBOARD_CANDIDATE_PREFIX = 'local-storyboards-'

export async function latestLocalEpisodeAssetCandidate(projectId: string, episodeId: string) {
  const job = await latestSuccessfulJob(projectId, 'EPISODE_ASSET_EXTRACT', episodeId)
  if (!job) throw notFoundError('尚无本地角色场景候选')
  return materializeEpisodeAssetCandidate(job)
}

export async function localEpisodeAssetCandidateByJob(projectId: string, jobId: string) {
  const job = await requiredLocalJob(jobId, projectId)
  return materializeEpisodeAssetCandidate(job)
}

export async function applyLocalEpisodeAssetCandidate(
  projectId: string,
  candidateId: string,
  input: {
    candidateVersion: number
    payloadJson: string
    selectedSceneKeys: string[]
    characterDecisions: EpisodeCharacterDecision[]
  },
): Promise<EpisodeAssetApplySummary> {
  if (input.candidateVersion !== 0) throw new Error('本地候选版本已变化，请重新打开')
  const job = await requiredLocalJob(candidateJobId(candidateId, EPISODE_CANDIDATE_PREFIX), projectId)
  const payload = parseEpisodeAssetPayload(input.payloadJson)
  const desktop = requiredDesktop()
  const data = await desktop.getLocalProjectData(projectId)
  const createdCharacters: Record<string, string> = {}
  const reusedCharacters: Record<string, string> = {}
  const decisions = new Map(input.characterDecisions.map((item) => [item.candidateKey, item]))
  const now = new Date().toISOString()
  for (const candidate of payload.characters) {
    const decision = decisions.get(candidate.candidateKey)
    if (!decision || decision.action === 'IGNORE') continue
    if (decision.action === 'REUSE') {
      const target = data.characters.find((item) => item.id === decision.targetCharacterId)
      if (!target) throw new Error(`复用角色不存在：${candidate.name}`)
      reusedCharacters[candidate.candidateKey] = target.id
      continue
    }
    const id = globalThis.crypto.randomUUID()
    data.characters.push({
      id,
      projectId,
      name: candidate.name,
      roleType: candidate.roleType || undefined,
      description: candidate.description || undefined,
      identityPrompt: candidate.identityPrompt || undefined,
      negativePrompt: candidate.negativePrompt || undefined,
      status: 'DRAFT',
      version: 0,
      forms: [],
      updatedAt: now,
    })
    createdCharacters[candidate.candidateKey] = id
  }
  const selectedScenes = new Set(input.selectedSceneKeys)
  const createdSceneIds: string[] = []
  let nextSceneNo =
    Math.max(
      0,
      ...data.scenes.filter((scene) => scene.episodeId === job.targetId).map((scene) => scene.sceneNo),
    ) + 1
  for (const candidate of payload.scenes) {
    if (!selectedScenes.has(candidate.candidateKey)) continue
    const id = globalThis.crypto.randomUUID()
    data.scenes.push({
      id,
      projectId,
      episodeId: job.targetId,
      sceneNo: nextSceneNo,
      title: candidate.title,
      location: candidate.location || undefined,
      timeOfDay: candidate.timeOfDay || undefined,
      description: candidate.description || undefined,
      environmentPrompt: candidate.environmentPrompt || undefined,
      status: 'DRAFT',
      version: 0,
      updatedAt: now,
    })
    nextSceneNo += 1
    createdSceneIds.push(id)
  }
  await desktop.saveLocalProjectData(projectId, data)
  return {
    candidateId,
    createdCharacters,
    reusedCharacters,
    createdSceneIds,
    appliedAt: now,
  }
}

export async function latestLocalStoryboardCandidate(projectId: string, episodeId: string) {
  const job = await latestSuccessfulJob(projectId, 'STORYBOARD_GENERATE', episodeId)
  if (!job) throw notFoundError('尚无本地分镜候选')
  return materializeStoryboardCandidate(job)
}

export async function localStoryboardCandidateByJob(projectId: string, jobId: string) {
  const job = await requiredLocalJob(jobId, projectId)
  return materializeStoryboardCandidate(job)
}

export async function applyLocalStoryboardCandidate(
  projectId: string,
  candidateId: string,
  input: {
    candidateVersion: number
    payloadJson: string
    selectedShotKeys: string[]
  },
): Promise<StoryboardCandidateApplySummary> {
  if (input.candidateVersion !== 0) throw new Error('本地候选版本已变化，请重新打开')
  const job = await requiredLocalJob(candidateJobId(candidateId, STORYBOARD_CANDIDATE_PREFIX), projectId)
  const desktop = requiredDesktop()
  const data = await desktop.getLocalProjectData(projectId)
  const payload = parseStoryboardCandidatePayload(input.payloadJson, data, job.targetId)
  const selectedKeys = new Set(input.selectedShotKeys)
  const selected = payload.shots.filter((shot) => selectedKeys.has(shot.candidateKey))
  const now = new Date().toISOString()
  const createdStoryboards: Record<string, string> = {}
  let shotNo =
    Math.max(
      0,
      ...data.storyboards
        .filter((storyboard) => storyboard.episodeId === job.targetId)
        .map((storyboard) => storyboard.shotNo),
    ) + 1
  for (const candidate of selected) {
    const id = globalThis.crypto.randomUUID()
    const prompts = storyboardPrompts(candidate, data)
    data.storyboards.push({
      id,
      projectId,
      episodeId: job.targetId,
      sceneId: candidate.sceneId || undefined,
      characterIds: candidate.characterIds,
      shotNo,
      title: candidate.title,
      shotType: candidate.shotType || undefined,
      angle: candidate.angle || undefined,
      movement: candidate.movement || undefined,
      location: candidate.location || undefined,
      timeOfDay: candidate.timeOfDay || undefined,
      actionText: candidate.actionText || undefined,
      dialogue: candidate.dialogue || undefined,
      innerMonologue: candidate.innerMonologue || undefined,
      audioMode: 'VIDEO_NATIVE',
      description: candidate.description || undefined,
      resultText: candidate.resultText || undefined,
      atmosphere: candidate.atmosphere || undefined,
      imagePrompt: candidate.imagePrompt || prompts.imagePrompt,
      videoPrompt: candidate.videoPrompt || prompts.videoPrompt,
      bgmPrompt: candidate.bgmPrompt || undefined,
      soundEffect: candidate.soundEffect || undefined,
      durationSec: candidate.durationSec,
      reviewStatus: 'PENDING',
      status: 'DRAFT',
      version: 0,
      updatedAt: now,
    })
    createdStoryboards[candidate.candidateKey] = id
    shotNo += 1
  }
  await desktop.saveLocalProjectData(projectId, data)
  return {
    candidateId,
    createdStoryboards,
    createdCount: selected.length,
    appliedAt: now,
  }
}

function materializeEpisodeAssetCandidate(job: GenerationJob): EpisodeAssetCandidate {
  const base = candidateBase(job)
  try {
    return {
      ...base,
      id: `${EPISODE_CANDIDATE_PREFIX}${job.id}`,
      episodeId: job.targetId,
      schemaVersion: '1.0',
      status: 'READY',
      payload: parseEpisodeAssetPayload(job.resultText || ''),
      validationError: null,
      application: null,
    }
  } catch (error) {
    return {
      ...base,
      id: `${EPISODE_CANDIDATE_PREFIX}${job.id}`,
      episodeId: job.targetId,
      schemaVersion: '1.0',
      status: 'INVALID',
      payload: null,
      validationError: error instanceof Error ? error.message : '角色场景候选格式无效',
      application: null,
    }
  }
}

async function materializeStoryboardCandidate(job: GenerationJob): Promise<StoryboardCandidate> {
  const base = candidateBase(job)
  try {
    const data = await requiredDesktop().getLocalProjectData(job.projectId)
    return {
      ...base,
      id: `${STORYBOARD_CANDIDATE_PREFIX}${job.id}`,
      episodeId: job.targetId,
      schemaVersion: '1.0',
      status: 'READY',
      payload: parseStoryboardCandidatePayload(job.resultText || '', data, job.targetId),
      validationError: null,
      application: null,
    }
  } catch (error) {
    return {
      ...base,
      id: `${STORYBOARD_CANDIDATE_PREFIX}${job.id}`,
      episodeId: job.targetId,
      schemaVersion: '1.0',
      status: 'INVALID',
      payload: null,
      validationError: error instanceof Error ? error.message : '分镜候选格式无效',
      application: null,
    }
  }
}

function parseEpisodeAssetPayload(value: string): EpisodeAssetPayload {
  const parsed = parseJsonObject(value) as Record<string, unknown>
  if (parsed.schemaVersion !== '1.0') throw new Error('角色场景候选 schemaVersion 必须为 1.0')
  const characters = requiredArray(parsed.characters, 'characters', 200).map((item, index) => {
    const record = requiredRecord(item, `characters[${index}]`)
    return {
      candidateKey: candidateKey(record.candidateKey, `characters[${index}]`),
      name: requiredString(record.name, '角色名称', 120),
      roleType: optionalString(record.roleType, 120),
      description: optionalString(record.description, 2_000),
      identityPrompt: optionalString(record.identityPrompt, 4_000),
      negativePrompt: optionalString(record.negativePrompt, 2_000),
    }
  })
  const scenes = requiredArray(parsed.scenes, 'scenes', 300).map((item, index) => {
    const record = requiredRecord(item, `scenes[${index}]`)
    return {
      candidateKey: candidateKey(record.candidateKey, `scenes[${index}]`),
      title: requiredString(record.title, '场景名称', 160),
      location: optionalString(record.location, 300),
      timeOfDay: optionalString(record.timeOfDay, 120),
      description: optionalString(record.description, 2_000),
      environmentPrompt: optionalString(record.environmentPrompt, 4_000),
    }
  })
  assertUniqueKeys([...characters, ...scenes])
  return { schemaVersion: '1.0', characters, scenes }
}

function parseStoryboardCandidatePayload(
  value: string,
  data: LocalProjectData,
  episodeId: string,
): StoryboardCandidatePayload {
  const parsed = parseJsonObject(value) as Record<string, unknown>
  if (parsed.schemaVersion !== '1.0') throw new Error('分镜候选 schemaVersion 必须为 1.0')
  const sceneIds = new Set(
    data.scenes.filter((scene) => scene.episodeId === episodeId).map((scene) => scene.id),
  )
  const characterIds = new Set(data.characters.map((character) => character.id))
  const shots = requiredArray(parsed.shots, 'shots', 500).map((item, index) => {
    const record = requiredRecord(item, `shots[${index}]`)
    const sceneId = optionalString(record.sceneId, 160)
    if (sceneId && !sceneIds.has(sceneId)) throw new Error(`分镜引用了不存在的场景：${sceneId}`)
    const linkedCharacters = requiredArray(record.characterIds ?? [], 'characterIds', 30).map(
      (id) => requiredString(id, '角色标识', 160),
    )
    if (linkedCharacters.some((id) => !characterIds.has(id))) {
      throw new Error(`第 ${index + 1} 个分镜引用了不存在的角色`)
    }
    const durationSec = Number(record.durationSec)
    if (!Number.isFinite(durationSec) || durationSec < 1 || durationSec > 60) {
      throw new Error(`第 ${index + 1} 个分镜时长必须在 1 到 60 秒之间`)
    }
    return {
      candidateKey: candidateKey(record.candidateKey, `shots[${index}]`),
      title: requiredString(record.title, '分镜标题', 160),
      sceneId,
      characterIds: linkedCharacters,
      shotType: optionalString(record.shotType, 80),
      angle: optionalString(record.angle, 80),
      movement: optionalString(record.movement, 80),
      location: optionalString(record.location, 300),
      timeOfDay: optionalString(record.timeOfDay, 120),
      actionText: optionalString(record.actionText, 2_000),
      dialogue: optionalString(record.dialogue, 2_000),
      innerMonologue: optionalString(record.innerMonologue, 2_000),
      description: optionalString(record.description, 2_000),
      resultText: optionalString(record.resultText, 2_000),
      atmosphere: optionalString(record.atmosphere, 1_000),
      imagePrompt: optionalString(record.imagePrompt, 6_000),
      videoPrompt: optionalString(record.videoPrompt, 6_000),
      bgmPrompt: optionalString(record.bgmPrompt, 2_000),
      soundEffect: optionalString(record.soundEffect, 2_000),
      durationSec,
    }
  })
  assertUniqueKeys(shots)
  if (!shots.length) throw new Error('分镜候选不能为空')
  return { schemaVersion: '1.0', shots }
}

function storyboardPrompts(candidate: StoryboardShotCandidate, data: LocalProjectData) {
  const scene = data.scenes.find((item) => item.id === candidate.sceneId)
  const characters = candidate.characterIds
    .map((id) => data.characters.find((item) => item.id === id))
    .filter(Boolean)
  const imagePrompt = [
    scene?.environmentPrompt,
    characters.map((character) => character?.identityPrompt || character?.description).join('；'),
    candidate.shotType,
    candidate.angle,
    candidate.location,
    candidate.timeOfDay,
    candidate.actionText,
    candidate.description,
    candidate.atmosphere,
  ]
    .filter(Boolean)
    .join('，')
  const videoPrompt = [
    imagePrompt,
    candidate.movement ? `运镜：${candidate.movement}` : '',
    candidate.actionText ? `动作：${candidate.actionText}` : '',
    candidate.dialogue ? `对白：${candidate.dialogue}` : '',
    candidate.soundEffect ? `环境声音：${candidate.soundEffect}` : '',
  ]
    .filter(Boolean)
    .join('。')
  return { imagePrompt, videoPrompt }
}

async function latestSuccessfulJob(
  projectId: string,
  jobType: GenerationJob['jobType'],
  targetId: string,
) {
  const page = await requiredDesktop().listLocalGenerationJobs(projectId, 1, 500)
  return page.items.find(
    (job) => job.jobType === jobType && job.targetId === targetId && job.status === 'SUCCEEDED',
  )
}

async function requiredLocalJob(jobId: string, projectId: string) {
  const job = await requiredDesktop().getLocalGenerationJob(jobId)
  if (job.projectId !== projectId) throw new Error('本地候选不属于当前项目')
  if (job.status !== 'SUCCEEDED' || !job.resultText?.trim()) {
    throw new Error(job.errorMessage || '本地生成任务尚未完成')
  }
  return job
}

function candidateBase(job: GenerationJob) {
  return {
    projectId: job.projectId,
    generationJobId: job.id,
    version: 0,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  }
}

function candidateJobId(candidateId: string, prefix: string) {
  if (!candidateId.startsWith(prefix)) throw new Error('本地候选标识无效')
  return candidateId.slice(prefix.length)
}

function parseJsonObject(value: string) {
  const normalized = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = normalized.indexOf('{')
  const end = normalized.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型没有返回完整 JSON 对象')
  const parsed = JSON.parse(normalized.slice(start, end + 1))
  return requiredRecord(parsed, 'JSON')
}

function requiredArray(value: unknown, label: string, maxLength: number) {
  if (!Array.isArray(value) || value.length > maxLength) throw new Error(`${label} 数组格式无效`)
  return value
}

function requiredRecord(value: unknown, label: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 对象格式无效`)
  }
  return value as Record<string, unknown>
}

function requiredString(value: unknown, label: string, maxLength: number) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}不能为空`)
  const normalized = value.trim()
  if (normalized.length > maxLength) throw new Error(`${label}超过允许长度`)
  return normalized
}

function optionalString(value: unknown, maxLength: number) {
  if (value === null || value === undefined || value === '') return null
  const normalized = String(value).trim()
  if (normalized.length > maxLength) throw new Error('候选文本超过允许长度')
  return normalized || null
}

function candidateKey(value: unknown, label: string) {
  const key = requiredString(value, `${label}.candidateKey`, 120)
  if (!/^[a-zA-Z0-9_-]+$/.test(key)) throw new Error(`${label}.candidateKey 格式无效`)
  return key
}

function assertUniqueKeys(items: Array<{ candidateKey: string }>) {
  const keys = new Set<string>()
  for (const item of items) {
    if (keys.has(item.candidateKey)) throw new Error(`候选标识重复：${item.candidateKey}`)
    keys.add(item.candidateKey)
  }
}

function requiredDesktop() {
  const desktop = globalThis.window?.aiDramaDesktop
  if (!desktop) throw new Error('请在 Windows 客户端中使用本地候选')
  return desktop
}

function notFoundError(message: string) {
  return new ApiClientError(message, 'LOCAL_CANDIDATE_NOT_FOUND', 404)
}
