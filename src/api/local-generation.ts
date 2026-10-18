import type { Project } from './client'
import type {
  CreateGenerationJobInput,
  GenerationExecutionRequest,
  GenerationJob,
} from './generation'
import type { LocalProjectData } from './local-project'
import { sourceDetailByRevision, sourceSegmentContent } from './local-source'

const SCRIPT_GENERATE_SYSTEM =
  '你是专业短剧编剧。根据分集剧情资料创作可直接制作的完整短剧剧本，包含场景、动作、对白和必要旁白。保持人物、事实和核心冲突一致。必须按目标时长写足剧情密度和完整的情绪推进，宁可略长供用户删减，也不能过短；不得用梗概、提纲或几句对白代替完整剧本。只输出剧本正文，不输出解释、前言或 Markdown 代码块。'
const SCRIPT_REWRITE_SYSTEM =
  '你是专业短剧编剧。保持人物、事实和核心冲突一致，优化节奏、对白、情绪推进和镜头可执行性。只输出改写后的完整剧本，不输出解释、前言或 Markdown 代码块。'
const VISUAL_BIBLE_SYSTEM =
  '你是短剧项目美术指导和 AI 影像提示词导演。根据项目剧情、角色和场景生成可直接约束后续角色图、场景图、分镜图和视频的项目视觉圣经。输出中文纯文本，覆盖世界观、整体画风、色调光影、角色一致性、场景道具、镜头语言和生成禁忌，不输出 JSON 或 Markdown 代码块。'
const VOICE_INSTRUCTION_SYSTEM =
  '你是短剧配音导演。把角色、动作、氛围和台词转换为可执行的发声参数。严格输出一行：情绪：值；音量：值；语速：0.50到2.00；停顿：具体词句后多少秒；句尾：上扬、下沉、发颤或短促收住；音质：值。不要改写台词，不输出模型、音色 ID 或解释。'
const CONTACT_SHEET_PLAN_SYSTEM =
  '你是 AI 视频分镜导演。把一个较长镜头规划为严格 9 格的连续画面节奏，供图片模型生成 3x3 九宫格参考图。九格保持角色、服装、场景、光线、轴线和空间位置连续。只输出 9 行，每行格式：数字. 时间段｜景别与机位｜角色与动作｜场景与关键物件｜运镜衔接。不得输出标题、解释、Markdown 或 JSON。'
const ASSET_EXTRACT_SYSTEM =
  '你是短剧制片数据整理师。从分集梗概或剧本中提取实际出现或明确提及的角色与可拍摄场景。只输出 JSON 对象，顶层只能包含 schemaVersion、characters、scenes，schemaVersion 固定为 1.0。characters 每项包含 candidateKey、name、roleType、description、identityPrompt、negativePrompt；scenes 每项包含 candidateKey、title、location、timeOfDay、description、environmentPrompt。candidateKey 必须唯一且只使用字母、数字、下划线或短横线。'
const STORYBOARD_SYSTEM =
  '你是专业短剧分镜导演和结构化数据工程师。把剧本拆解为连续、可执行、节奏清晰的镜头。只输出 JSON 对象，顶层只能包含 schemaVersion 和 shots，schemaVersion 固定为 1.0。每个镜头包含 candidateKey、title、sceneId、characterIds、shotType、angle、movement、location、timeOfDay、actionText、dialogue、innerMonologue、description、resultText、atmosphere、durationSec。sceneId 和 characterIds 只能使用提供目录中的 ID，无法绑定时使用 null 或空数组。'
const SOURCE_STRUCTURE_SYSTEM =
  '你是长文分集策划和结构化数据工程师。把原文按剧情节点拆成多集资料，不创作剧本，不精简、合并或跳过原文剧情。只输出 JSON 对象，顶层只能包含 schemaVersion、episodes、characters，schemaVersion 固定为 1.0。episodes 每项包含 candidateKey、title、synopsis、scriptText、targetDurationSec、scenes；scenes 每项包含 candidateKey、title、location、timeOfDay、description、environmentPrompt；characters 每项包含 candidateKey、name、roleType、description、identityPrompt、negativePrompt。candidateKey 必须唯一且只使用字母、数字、下划线或短横线。每集 synopsis 必须按发生顺序完整记录事件、因果、人物状态、信息差、关键线索、重要对白信息和结尾承接，宁可详细也不得精简；scriptText 必须固定输出空字符串，后续由独立的 AI 生成剧本功能完成。'
const SOURCE_SEGMENT_SYSTEM =
  '你是长篇原文剧情分析师。按原文顺序整理当前片段，完整保留关键事件、因果、人物关系变化、信息差、伏笔与回收、地点和时间变化。只输出 JSON 对象，顶层包含 schemaVersion、segmentNo、events、characters、locations、openThreads、endState。不要生成分集剧本，输出控制在 4000 个中文字符以内。'
const SOURCE_MERGE_SYSTEM =
  '你是长文分集策划和结构化数据工程师。根据顺序排列的分段剧情台账统一角色、时间线、伏笔和因果并完成剧情分集，不创作剧本。只输出 JSON 对象，格式与结构化结果一致：顶层 schemaVersion、episodes、characters，schemaVersion 固定为 1.0；每集 synopsis 必须按发生顺序完整记录事件、因果、人物状态、信息差、关键线索、重要对白信息和结尾承接，宁可详细也不得精简；scriptText 必须固定输出空字符串；不得遗漏任何分段。'

export async function createLocalGenerationJob(
  projectId: string,
  input: CreateGenerationJobInput,
): Promise<GenerationJob> {
  if (input.route.sourceType !== 'LOCAL') throw new Error('本地项目只能使用本地模型')
  const desktop = globalThis.window?.aiDramaDesktop
  if (!desktop) throw new Error('请在 Windows 客户端中使用本地生成任务')
  const [data, projects] = await Promise.all([
    desktop.getLocalProjectData(projectId),
    desktop.listLocalProjects(),
  ])
  const project = projects.find((item) => item.id === projectId)
  if (!project) throw new Error('本地项目不存在或已被移除')
  const resolved = await resolveExecutionRequest(project as Project, data, input, desktop)
  const now = new Date().toISOString()
  const job: GenerationJob = {
    id: `local-job-${globalThis.crypto.randomUUID()}`,
    projectId,
    jobType: input.jobType,
    serviceType: serviceTypeFor(input.jobType),
    targetType: input.targetType,
    targetId: input.targetId,
    targetVersion: resolved.targetVersion,
    sourceType: 'LOCAL',
    localConnectionId: input.route.localConnectionId,
    platformModelId: null,
    sourceDisplayName: input.route.localProviderCode || '我的 API',
    modelName: input.route.localModelName,
    status: 'WAITING_LOCAL',
    progress: 0,
    executionRequest: resolved.executionRequest,
    resultText: null,
    errorCode: null,
    errorMessage: null,
    attemptCount: 0,
    createdAt: now,
    updatedAt: now,
  }
  return desktop.createLocalGenerationJob(projectId, cloneForDesktopIpc(job))
}

export async function createLocalBinaryGenerationJob(input: {
  projectId: string
  jobType: 'IMAGE_GENERATION' | 'VIDEO_GENERATION' | 'TTS_GENERATION'
  targetType: GenerationJob['targetType']
  targetId: string
  prompt: string
  parameters?: Record<string, unknown>
  route: Extract<CreateGenerationJobInput['route'], { sourceType: 'LOCAL' }>
}) {
  const desktop = globalThis.window?.aiDramaDesktop
  if (!desktop) throw new Error('请在 Windows 客户端中使用本地生成任务')
  const data = await desktop.getLocalProjectData(input.projectId)
  const now = new Date().toISOString()
  const job: GenerationJob = {
    id: `local-job-${globalThis.crypto.randomUUID()}`,
    projectId: input.projectId,
    jobType: input.jobType,
    serviceType: serviceTypeFor(input.jobType),
    targetType: input.targetType,
    targetId: input.targetId,
    targetVersion: targetVersion(data, input.targetType, input.targetId),
    sourceType: 'LOCAL',
    localConnectionId: input.route.localConnectionId,
    platformModelId: null,
    sourceDisplayName: input.route.localProviderCode || '我的 API',
    modelName: input.route.localModelName,
    status: 'WAITING_LOCAL',
    progress: 0,
    executionRequest: {
      systemPrompt: '本地媒体生成参数快照',
      userPrompt: input.prompt.trim(),
      parameters: cloneGenerationParameters(input.parameters),
    },
    resultText: null,
    errorCode: null,
    errorMessage: null,
    attemptCount: 0,
    createdAt: now,
    updatedAt: now,
  }
  if (!job.executionRequest?.userPrompt) throw new Error('生成提示词不能为空')
  return desktop.createLocalGenerationJob(input.projectId, cloneForDesktopIpc(job))
}

async function resolveExecutionRequest(
  project: Project,
  data: LocalProjectData,
  input: CreateGenerationJobInput,
  desktop: NonNullable<typeof globalThis.window.aiDramaDesktop>,
): Promise<{ targetVersion: number; executionRequest: GenerationExecutionRequest | null }> {
  const parameters = cloneGenerationParameters(input.parameters)
  if (['IMAGE_GENERATION', 'VIDEO_GENERATION', 'TTS_GENERATION'].includes(input.jobType)) {
    return { targetVersion: 0, executionRequest: null }
  }
  if (input.jobType === 'PROJECT_VISUAL_BIBLE_GENERATE') {
    const material = JSON.stringify({
      project,
      episodes: data.episodes.slice(0, 80).map((episode) => ({
        episodeNo: episode.episodeNo,
        title: episode.title,
        synopsis: clip(episode.synopsis, 2_000),
        scriptText: clip(episode.scriptText, 4_000),
      })),
      characters: data.characters.slice(0, 80),
      scenes: data.scenes.slice(0, 120),
    })
    if (!project.description?.trim() && !data.episodes.some(hasEpisodeMaterial)) {
      throw new Error('请先填写项目简介、分集剧情梗概或剧本')
    }
    return {
      targetVersion: project.version,
      executionRequest: {
        systemPrompt: VISUAL_BIBLE_SYSTEM,
        userPrompt: `根据以下项目资料生成统一视觉圣经：\n\n<project_material>\n${material}\n</project_material>`,
        parameters,
      },
    }
  }
  if (input.jobType === 'VOICE_INSTRUCTION_GENERATE') {
    const storyboard = requiredTarget(data.storyboards, input.targetId, '分镜')
    const speaker = data.characters.find((item) => item.id === storyboard.speakerCharacterId)
    const spokenText = storyboard.dialogue?.trim() || storyboard.innerMonologue?.trim()
    if (!spokenText) throw new Error('当前分镜没有可用于生成声音指令的对白或内心独白')
    return {
      targetVersion: storyboard.version,
      executionRequest: {
        systemPrompt: VOICE_INSTRUCTION_SYSTEM,
        userPrompt: [
          `镜头：${storyboard.title}`,
          `角色：${speaker?.name || '旁白或未指定角色'}`,
          `角色声线：${speaker?.voiceDescription || '未设置'}`,
          `动作：${storyboard.actionText || '未设置'}`,
          `氛围：${storyboard.atmosphere || '未设置'}`,
          `配音文本：${spokenText}`,
        ].join('\n'),
        parameters,
      },
    }
  }
  if (input.jobType === 'STORYBOARD_CONTACT_SHEET_PLAN') {
    const storyboard = requiredTarget(data.storyboards, input.targetId, '分镜')
    return {
      targetVersion: storyboard.version,
      executionRequest: {
        systemPrompt: CONTACT_SHEET_PLAN_SYSTEM,
        userPrompt: [
          `把以下 ${Math.max(1, storyboard.durationSec || 5)} 秒镜头拆为 9 个连续时间节点：`,
          `标题：${storyboard.title}`,
          `场景：${storyboard.location || '未指定'}`,
          `景别与角度：${storyboard.shotType || '未指定'}，${storyboard.angle || '未指定'}`,
          `运镜：${storyboard.movement || '未指定'}`,
          `动作：${storyboard.actionText || '未指定'}`,
          `对白：${storyboard.dialogue || '无'}`,
          `氛围：${storyboard.atmosphere || '未指定'}`,
          `最终视频提示词：${storyboard.finalVideoPrompt || storyboard.videoPrompt || storyboard.description || '未指定'}`,
        ].join('\n'),
        parameters,
      },
    }
  }
  if (input.jobType === 'SOURCE_STRUCTURE') {
    const source = sourceDetailByRevision(data, input.targetId)
    if (!source) throw new Error('原文版本不存在，请重新保存原文')
    return {
      targetVersion: source.document.revisionNo,
      executionRequest: {
        systemPrompt: SOURCE_STRUCTURE_SYSTEM,
        userPrompt: [
          sourceOptionsInstruction(parameters, source.document.characterCount),
          `<source_material>\n${source.content}\n</source_material>`,
        ].join('\n\n'),
        parameters,
      },
    }
  }
  if (input.jobType === 'SOURCE_STRUCTURE_SEGMENT') {
    const source = sourceDetailByRevision(data, input.targetId)
    if (!source) throw new Error('原文版本不存在，请重新保存原文')
    const segmentNo = Number(parameters.segmentNo)
    const segment = sourceSegmentContent(source, segmentNo)
    return {
      targetVersion: source.document.revisionNo,
      executionRequest: {
        systemPrompt: SOURCE_SEGMENT_SYSTEM,
        userPrompt: `这是第 ${segment.segmentNo} / ${segment.segmentCount} 段。\n\n<source_segment>\n${segment.content}\n</source_segment>`,
        parameters,
      },
    }
  }
  if (input.jobType === 'SOURCE_STRUCTURE_MERGE') {
    const source = sourceDetailByRevision(data, input.targetId)
    if (!source) throw new Error('原文版本不存在，请重新保存原文')
    const jobIds = Array.isArray(parameters.segmentJobIds)
      ? parameters.segmentJobIds.filter((item): item is string => typeof item === 'string')
      : []
    if (!jobIds.length) throw new Error('长文分段分析结果不完整')
    const analyses: Array<{ segmentNo: number; result: string }> = []
    for (let index = 0; index < jobIds.length; index += 1) {
      const job = await desktop.getLocalGenerationJob(jobIds[index])
      if (
        job.projectId !== project.id ||
        job.jobType !== 'SOURCE_STRUCTURE_SEGMENT' ||
        job.targetId !== input.targetId ||
        job.status !== 'SUCCEEDED' ||
        !job.resultText
      ) {
        throw new Error(`第 ${index + 1} 段分析结果不可用`)
      }
      analyses.push({ segmentNo: index + 1, result: job.resultText.slice(0, 12_000) })
    }
    const analysisJson = JSON.stringify(analyses)
    if (analysisJson.length > 280_000) throw new Error('分段分析结果过长，请减少原文长度或分批处理')
    return {
      targetVersion: source.document.revisionNo,
      executionRequest: {
        systemPrompt: SOURCE_MERGE_SYSTEM,
        userPrompt: [
          sourceOptionsInstruction(parameters, source.document.characterCount),
          `<segment_analyses>\n${analysisJson}\n</segment_analyses>`,
        ].join('\n\n'),
        parameters,
      },
    }
  }
  const episode = requiredTarget(data.episodes, input.targetId, '分集')
  if (input.jobType === 'SCRIPT_GENERATE') {
    if (!episode.synopsis?.trim()) throw new Error('请先填写本集剧情梗概')
    return {
      targetVersion: episode.version,
      executionRequest: {
        systemPrompt: SCRIPT_GENERATE_SYSTEM,
        userPrompt: `请根据以下剧情梗概创作一集目标时长约 ${episode.targetDurationSec} 秒的短剧剧本。${scriptLengthInstruction(episode.targetDurationSec)}\n\n<episode_synopsis>\n${episode.synopsis}\n</episode_synopsis>`,
        parameters,
      },
    }
  }
  if (input.jobType === 'SCRIPT_REWRITE') {
    if (!episode.scriptText?.trim()) throw new Error('请先填写需要改写的剧本')
    return {
      targetVersion: episode.version,
      executionRequest: {
        systemPrompt: SCRIPT_REWRITE_SYSTEM,
        userPrompt: `请改写以下短剧剧本：\n\n<episode_script>\n${episode.scriptText}\n</episode_script>`,
        parameters,
      },
    }
  }
  if (input.jobType === 'EPISODE_ASSET_EXTRACT') {
    const material = episode.scriptText?.trim() || episode.synopsis?.trim()
    if (!material) throw new Error('请先填写分集梗概或剧本')
    return {
      targetVersion: episode.version,
      executionRequest: {
        systemPrompt: ASSET_EXTRACT_SYSTEM,
        userPrompt: `提取以下分集资料中的角色和场景：\n\n<episode_material>\n${material}\n</episode_material>`,
        parameters,
      },
    }
  }
  if (input.jobType === 'STORYBOARD_GENERATE') {
    if (!episode.scriptText?.trim()) throw new Error('请先填写完整剧本')
    const characters = data.characters.map(
      ({ id, name, roleType, description, identityPrompt }) => ({
        id,
        name,
        roleType,
        description,
        identityPrompt,
      }),
    )
    const scenes = data.scenes
      .filter((scene) => scene.episodeId === episode.id)
      .map(({ id, title, location, timeOfDay, description, environmentPrompt }) => ({
        id,
        title,
        location,
        timeOfDay,
        description,
        environmentPrompt,
      }))
    return {
      targetVersion: episode.version,
      executionRequest: {
        systemPrompt: STORYBOARD_SYSTEM,
        userPrompt: [
          `将剧本拆解为约 ${suggestedShotCount(episode.targetDurationSec, parameters)} 个镜头，总时长接近 ${episode.targetDurationSec} 秒。`,
          `<character_catalog>\n${JSON.stringify(characters)}\n</character_catalog>`,
          `<scene_catalog>\n${JSON.stringify(scenes)}\n</scene_catalog>`,
          `<episode_script>\n${episode.scriptText}\n</episode_script>`,
        ].join('\n\n'),
        parameters,
      },
    }
  }
  throw new Error('该文本任务尚未支持完全离线执行')
}

function sourceOptionsInstruction(parameters: Record<string, unknown>, characterCount: number) {
  const mode = String(parameters.episodeCountMode || 'AUTO')
  const duration = Math.max(15, Math.min(600, Number(parameters.targetDurationSec) || 60))
  const estimated = Math.max(
    1,
    Math.min(100, Math.ceil(characterCount / Math.max(600, duration * 15))),
  )
  const episodeInstruction =
    mode === 'FIXED'
      ? `严格生成 ${Math.max(1, Math.min(100, Number(parameters.targetEpisodeCount) || estimated))} 集`
      : `根据剧情节点自动分集，预计约 ${estimated} 集`
  return `${episodeInstruction}，每集目标时长约 ${duration} 秒，此时长只用于规划分集边界，不能作为删减剧情的理由。每集 synopsis 要完整覆盖分配到本集的原文内容，写清事件顺序、因果、人物动机与状态、信息差、关键线索、重要对白信息和结尾承接；宁可详细也不得精简剧情。scriptText 固定输出空字符串。`
}

function scriptLengthInstruction(targetDurationSec: number) {
  const minimumCharacters = Math.max(1, Math.ceil((targetDurationSec * 5.3) / 10) * 10)
  const recommendedMaximum = Math.max(
    minimumCharacters,
    Math.ceil((targetDurationSec * 7) / 10) * 10,
  )
  return `每集 scriptText 应写到约 ${minimumCharacters} 至 ${recommendedMaximum} 字，且不得少于 ${minimumCharacters} 字；字数包含场景、动作、对白和旁白，宁可略长供用户删减，也不能过短。`
}

function serviceTypeFor(jobType: GenerationJob['jobType']): GenerationJob['serviceType'] {
  if (jobType === 'IMAGE_GENERATION') return 'IMAGE'
  if (jobType === 'VIDEO_GENERATION') return 'VIDEO'
  if (jobType === 'TTS_GENERATION') return 'TTS'
  return 'TEXT'
}

function requiredTarget<T extends { id: string }>(items: T[], id: string, label: string) {
  const target = items.find((item) => item.id === id)
  if (!target) throw new Error(`${label}不存在`)
  return target
}

function hasEpisodeMaterial(episode: LocalProjectData['episodes'][number]) {
  return Boolean(episode.synopsis?.trim() || episode.scriptText?.trim())
}

function suggestedShotCount(durationSec: number, parameters: Record<string, unknown>) {
  const mode = String(parameters.shotPaceMode || 'BALANCED')
  const secondsPerShot = mode === 'FAST' ? 4 : mode === 'SLOW' ? 8 : 6
  return Math.max(1, Math.round(durationSec / secondsPerShot))
}

function clip(value: string | undefined, maxLength: number) {
  return value?.trim().slice(0, maxLength) || undefined
}

function cloneGenerationParameters(value?: Record<string, unknown>): Record<string, unknown> {
  return cloneForDesktopIpc(value ?? {})
}

function cloneForDesktopIpc<T>(value: T): T {
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) throw new Error('empty serialized value')
    return JSON.parse(serialized) as T
  } catch {
    throw new Error('生成参数包含无法传递的数据，请重新选择生成参数后重试')
  }
}

function targetVersion(
  data: LocalProjectData,
  targetType: GenerationJob['targetType'],
  targetId: string,
) {
  if (targetType === 'EPISODE')
    return data.episodes.find((item) => item.id === targetId)?.version ?? 0
  if (targetType === 'CHARACTER' || targetType === 'CHARACTER_FORM') {
    return data.characters.find((item) => item.id === targetId)?.version ?? 0
  }
  if (targetType === 'SCENE') return data.scenes.find((item) => item.id === targetId)?.version ?? 0
  if (targetType === 'STORYBOARD') {
    return data.storyboards.find((item) => item.id === targetId)?.version ?? 0
  }
  return 0
}
