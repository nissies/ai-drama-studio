import type {
  StoryboardCandidatePayload,
  StoryboardShotCandidate,
} from '../../api/storyboard-candidates'

export function cloneStoryboardCandidatePayload(
  payload: StoryboardCandidatePayload,
): StoryboardCandidatePayload {
  return {
    schemaVersion: '1.0',
    shots: payload.shots.map((shot) => ({
      ...shot,
      characterIds: [...shot.characterIds],
    })),
  }
}

export function selectedStoryboardDuration(
  shots: StoryboardShotCandidate[],
  selectedKeys: string[],
) {
  const selected = new Set(selectedKeys)
  return shots.reduce(
    (total, shot) => total + (selected.has(shot.candidateKey) ? Number(shot.durationSec) || 0 : 0),
    0,
  )
}

export function createSelectedStoryboardPayload(
  payload: StoryboardCandidatePayload,
  selectedKeys: string[],
): StoryboardCandidatePayload {
  const selected = new Set(selectedKeys)
  return {
    schemaVersion: '1.0',
    shots: payload.shots
      .filter((shot) => selected.has(shot.candidateKey))
      .map((shot) => ({ ...shot, characterIds: [...shot.characterIds] })),
  }
}

export function validateStoryboardCandidateDraft(
  payload: StoryboardCandidatePayload,
  selectedKeys: string[],
) {
  const selected = new Set(selectedKeys)
  if (!selected.size) return '至少选择一个镜头'
  for (const [index, shot] of payload.shots.entries()) {
    if (!selected.has(shot.candidateKey)) continue
    if (!shot.title.trim()) return `镜头 ${index + 1} 缺少标题`
    if (!Number.isInteger(shot.durationSec) || shot.durationSec < 1 || shot.durationSec > 300) {
      return `镜头 ${index + 1} 的时长必须是 1 到 300 秒的整数`
    }
  }
  return ''
}


export function mergeStoryboardShotsByTargetDuration(
  payload: StoryboardCandidatePayload,
  selectedKeys: string[],
  targetSeconds = 15,
): { payload: StoryboardCandidatePayload; selectedKeys: string[] } {
  const selected = new Set(selectedKeys)
  const source = payload.shots.filter((shot) => selected.has(shot.candidateKey))
  if (source.length <= 1) {
    return {
      payload: {
        schemaVersion: '1.0',
        shots: source.map((shot) => ({ ...shot, characterIds: [...shot.characterIds] })),
      },
      selectedKeys: source.map((shot) => shot.candidateKey),
    }
  }

  const groups: StoryboardShotCandidate[][] = []
  let bucket: StoryboardShotCandidate[] = []
  let bucketDuration = 0

  for (const shot of source) {
    const duration = Math.max(1, Number(shot.durationSec) || 1)
    const sameScene =
      bucket.length === 0 || (bucket[0]?.sceneId || null) === (shot.sceneId || null)
    const wouldExceed = bucketDuration + duration > targetSeconds + 4
    if (bucket.length > 0 && (!sameScene || (wouldExceed && bucketDuration >= Math.max(8, targetSeconds - 4)))) {
      groups.push(bucket)
      bucket = []
      bucketDuration = 0
    }
    bucket.push(shot)
    bucketDuration += duration
    if (bucketDuration >= targetSeconds) {
      groups.push(bucket)
      bucket = []
      bucketDuration = 0
    }
  }
  if (bucket.length) groups.push(bucket)

  const merged = groups.map((group, index) => mergeShotGroup(group, index))
  return {
    payload: { schemaVersion: '1.0', shots: merged },
    selectedKeys: merged.map((shot) => shot.candidateKey),
  }
}

function mergeShotGroup(group: StoryboardShotCandidate[], index: number): StoryboardShotCandidate {
  if (group.length === 1) {
    const only = group[0]!
    return { ...only, characterIds: [...only.characterIds] }
  }
  const characterIds = [...new Set(group.flatMap((shot) => shot.characterIds))]
  const durationSec = Math.min(
    300,
    Math.max(1, group.reduce((sum, shot) => sum + (Number(shot.durationSec) || 0), 0)),
  )
  const first = group[0]!
  const last = group[group.length - 1]!
  const join = (picker: (shot: StoryboardShotCandidate) => string | null | undefined, separator = ' / ') => {
    const values = group
      .map(picker)
      .map((value) => (value || '').trim())
      .filter(Boolean)
    return values.length ? [...new Set(values)].join(separator) : null
  }
  return {
    candidateKey: `merged_${index + 1}_${first.candidateKey}`,
    title: first.title.trim() || `合并镜头 ${index + 1}`,
    sceneId: first.sceneId ?? null,
    characterIds,
    shotType: first.shotType ?? null,
    angle: first.angle ?? null,
    movement: first.movement ?? null,
    location: first.location ?? last.location ?? null,
    timeOfDay: first.timeOfDay ?? last.timeOfDay ?? null,
    actionText: join((shot) => shot.actionText, '；'),
    dialogue: join((shot) => shot.dialogue, '\n'),
    innerMonologue: join((shot) => shot.innerMonologue, '\n'),
    description: join((shot) => shot.description || shot.actionText, '；'),
    resultText: last.resultText ?? first.resultText ?? null,
    atmosphere: first.atmosphere ?? last.atmosphere ?? null,
    imagePrompt: first.imagePrompt ?? null,
    videoPrompt: join((shot) => shot.videoPrompt || shot.description || shot.actionText, '；'),
    bgmPrompt: first.bgmPrompt ?? null,
    soundEffect: join((shot) => shot.soundEffect, '，'),
    durationSec,
  }
}
