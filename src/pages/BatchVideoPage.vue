<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  AudioLines,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Clipboard,
  Clapperboard,
  Download,
  Film,
  FolderOpen,
  History,
  Images,
  LayoutGrid,
  LoaderCircle,
  Pencil,
  RefreshCw,
  RotateCcw,
  Save,
  Sparkles,
  Trash2,
  Video,
  Volume2,
  XCircle,
} from 'lucide-vue-next'
import { useRoute } from 'vue-router'
import StudioShell from '../layouts/StudioShell.vue'
import BatchVideoReferenceEditor from '../components/generation/BatchVideoReferenceEditor.vue'
import GenerationRouteDialog from '../components/generation/GenerationRouteDialog.vue'
import { mediaAssetApi } from '../api/assets'
import { isLocalProjectId } from '../api/local-project'
import {
  generationApi,
  startLocalJobHeartbeat,
  type GenerationJob,
  type GenerationRoute,
} from '../api/generation'
import { imageGenerationApi, type ImageCandidate } from '../api/image-generation'
import {
  mediaGenerationApi,
  type BatchMediaGenerationItemResult,
  type BatchMediaGenerationPreviewItem,
  type MediaCandidate,
} from '../api/media-generation'
import type { Storyboard, StoryboardReviewStatus } from '../api/workspace'
import { loadBrowserImage, loadBrowserMedia } from '../browser/browser-image-store'
import {
  MAX_BATCH_REFERENCE_FILES,
  MAX_BATCH_REFERENCE_TOTAL_BYTES,
  buildBatchReferenceInstructions,
  needsLocalPoseProxy,
  normalizeBatchReferenceFile,
  type BatchReferenceMediaType,
  type BatchVideoReferenceDescriptor,
  type BatchVideoReferenceDraft,
} from '../domain/batch-video-references'
import { storyboardReferenceAssets } from '../domain/storyboard-reference-assets'
import { extractStoryboardVideoFrames } from '../domain/storyboard-video-frames'
import {
  generationRouteModelCode,
  grokVideoMode,
  isGrokCompatibleRoute,
  type GrokVideoMode,
} from '../domain/grok-video'
import { createLocalPoseProxy } from '../desktop/pose-proxy'
import {
  buildContactSheetImagePrompt,
  contactSheetRecommended,
  contactSheetTimelineInstruction,
  normalizeContactSheetPlan,
} from '../domain/batch-contact-sheet'
import { executeTextGeneration } from '../composables/text-generation'
import { useCreditStore } from '../stores/credits'
import { useDesktopStore } from '../stores/desktop'
import { useWorkspaceStore } from '../stores/workspace'
import { mapSettledWithConcurrency } from '../utils/concurrency'

type BatchStatus = 'IDLE' | 'CREATING' | GenerationJob['status']
type BatchFilter = 'ALL' | 'READY' | 'RUNNING' | 'FAILED' | 'DONE' | 'CHANGES'
type ShotState = {
  jobId?: string
  status: BatchStatus
  progress: number
  errorMessage?: string | null
  updatedAt?: string
}
type ReferenceView = {
  assetId: string
  label: string
  kind: 'KEYFRAME' | 'END_FRAME' | 'CONTACT_SHEET' | 'REFERENCE'
}
type FrameExtractionState = {
  status: 'EXTRACTING' | 'DONE' | 'PARTIAL' | 'FAILED'
  message: string
}
type BatchReferencePlan = {
  parameters: Record<string, unknown>
  instructions: string
}

const route = useRoute()
const workspace = useWorkspaceStore()
const desktop = useDesktopStore()
const credits = useCreditStore()
const projectId = computed(() => String(route.params.projectId || ''))
const project = computed(() => workspace.project)
const episodes = computed(() => workspace.episodes)
const activeEpisode = computed(() => workspace.activeEpisode)
const shots = computed(() =>
  [...workspace.storyboards].sort((left, right) => left.shotNo - right.shotNo),
)
const selectedIds = ref<string[]>([])
const candidatesByShot = ref<Record<string, MediaCandidate[]>>({})
const stateByShot = ref<Record<string, ShotState>>({})
const promptPreviews = ref<Record<string, BatchMediaGenerationPreviewItem>>({})
const promptDrafts = ref<Record<string, string>>({})
const promptEditingIds = ref<string[]>([])
const promptSavingIds = ref<string[]>([])
const supplementalReferencesByShot = ref<Record<string, BatchVideoReferenceDraft[]>>({})
const excludedAutomaticReferenceIdsByShot = ref<Record<string, string[]>>({})
const referenceEditorShotId = ref('')
const expandedHistoryIds = ref<string[]>([])
const reviewingIds = ref<string[]>([])
const candidateActionIds = ref<string[]>([])
const routeOpen = ref(false)
const routeSelection = ref<GenerationRoute | null>(null)
const routeDialogMode = ref<'CONFIGURE' | 'GENERATE'>('GENERATE')
const textRouteOpen = ref(false)
const imageRouteOpen = ref(false)
const textRouteSelection = ref<GenerationRoute | null>(null)
const imageRouteSelection = ref<GenerationRoute | null>(null)
const contactSheetPlans = ref<Record<string, string>>({})
const contactSheetGeneratingIds = ref<string[]>([])
const loading = ref(false)
const refreshing = ref(false)
const submitting = ref(false)
const downloading = ref(false)
const downloadCount = ref(0)
const error = ref('')
const notice = ref('')
const query = ref('')
const filter = ref<BatchFilter>('ALL')
const batchAudioMode = ref<Storyboard['audioMode']>('VIDEO_NATIVE')
const previewUrls = ref<Record<string, string>>({})
const previewLoading = ref<Record<string, boolean>>({})
const previewErrors = ref<Record<string, string>>({})
const frameStateByShot = ref<Record<string, FrameExtractionState>>({})
const excludedReferencesStoragePrefix = 'ai-drama-batch-excluded-references:'
let pollingTimer: ReturnType<typeof globalThis.setTimeout> | undefined
let loadToken = 0
let promptLoadToken = 0

const selectedShots = computed(() =>
  shots.value.filter((shot) => selectedIds.value.includes(shot.id)),
)
const selectedCount = computed(() => selectedShots.value.length)
const readyCount = computed(
  () => shots.value.filter((shot) => Boolean(displayCandidate(shot))).length,
)
const runningCount = computed(
  () => shots.value.filter((shot) => isRunningStatus(stateByShot.value[shot.id]?.status)).length,
)
const failedCount = computed(
  () => shots.value.filter((shot) => stateByShot.value[shot.id]?.status === 'FAILED').length,
)
const approvedCount = computed(
  () => shots.value.filter((shot) => shot.reviewStatus === 'APPROVED').length,
)
const selectedTotalDuration = computed(() =>
  selectedShots.value.reduce((sum, shot) => sum + durationFor(shot), 0),
)
const canSubmit = computed(() => Boolean(selectedCount.value && !submitting.value))
const hasActiveJobs = computed(() => runningCount.value > 0)
const textRouteLabel = computed(() => modelRouteLabel(textRouteSelection.value, '选择文本模型'))
const imageRouteLabel = computed(() => modelRouteLabel(imageRouteSelection.value, '选择图片模型'))
const routeLabel = computed(() => modelRouteLabel(routeSelection.value, '选择视频模型'))
const sortedCandidatesByShot = computed<Record<string, MediaCandidate[]>>(() =>
  Object.fromEntries(
    Object.entries(candidatesByShot.value).map(([storyboardId, candidates]) => [
      storyboardId,
      [...candidates]
        .filter((candidate) => ['AVAILABLE', 'SELECTED', 'LOCAL_SAVED'].includes(candidate.status))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    ]),
  ),
)
const referencesByShot = computed<Record<string, ReferenceView[]>>(() =>
  Object.fromEntries(shots.value.map((shot) => [shot.id, buildReferences(shot)])),
)
const filteredShots = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return shots.value.filter((shot) => {
    const state = stateByShot.value[shot.id]
    const candidate = displayCandidate(shot)
    const matchesKeyword =
      !keyword ||
      [shot.title, shot.shotNo, shot.videoPrompt, shot.actionText, shot.description, shot.dialogue]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(keyword))
    const matchesFilter =
      filter.value === 'ALL' ||
      (filter.value === 'READY' &&
        (!state?.status || ['IDLE', 'CANCELED'].includes(state.status)) &&
        !candidate) ||
      (filter.value === 'RUNNING' && isRunningStatus(state?.status)) ||
      (filter.value === 'FAILED' && state?.status === 'FAILED') ||
      (filter.value === 'DONE' && Boolean(candidate)) ||
      (filter.value === 'CHANGES' && shot.reviewStatus === 'CHANGES_REQUESTED')
    return matchesKeyword && matchesFilter
  })
})
const referenceEditorShot = computed(() =>
  shots.value.find((shot) => shot.id === referenceEditorShotId.value),
)

onMounted(() => void bootstrap())
onBeforeUnmount(() => {
  stopPolling()
  Object.values(previewUrls.value).forEach(releasePreviewUrl)
  releaseSupplementalReferences()
})

watch(projectId, (id) => {
  if (id) void bootstrap()
})

async function bootstrap() {
  if (!projectId.value) return
  stopPolling()
  excludedAutomaticReferenceIdsByShot.value = readExcludedAutomaticReferences(projectId.value)
  batchAudioMode.value = 'VIDEO_NATIVE'
  loading.value = true
  error.value = ''
  try {
    await desktop.initialize()
    await workspace.load(projectId.value)
    if (desktop.available && workspace.project) {
      await desktop.ensureProject({ id: workspace.project.id, title: workspace.project.title })
    }
    await Promise.all([loadEpisodeCandidates(), loadPromptPreviewsSafely()])
    await restoreJobs()
  } catch (caught) {
    error.value = messageFor(caught, '批量视频工作台加载失败')
  } finally {
    loading.value = false
  }
}

async function selectEpisode(event: Event) {
  const episodeId = (event.target as HTMLSelectElement).value
  if (!episodeId || episodeId === workspace.activeEpisodeId) return
  loading.value = true
  error.value = ''
  try {
    await workspace.selectEpisode(projectId.value, episodeId)
    selectedIds.value = []
    expandedHistoryIds.value = []
    promptPreviews.value = {}
    promptDrafts.value = {}
    promptEditingIds.value = []
    batchAudioMode.value = 'VIDEO_NATIVE'
    releaseSupplementalReferences()
    supplementalReferencesByShot.value = {}
    referenceEditorShotId.value = ''
    stateByShot.value = {}
    await Promise.all([loadEpisodeCandidates(), loadPromptPreviewsSafely()])
    await restoreJobs()
  } catch (caught) {
    error.value = messageFor(caught, '分集切换失败')
  } finally {
    loading.value = false
  }
}

async function loadEpisodeCandidates() {
  const token = ++loadToken
  const entries = await Promise.all(
    shots.value.map(
      async (shot) =>
        [shot.id, await mediaGenerationApi.list(projectId.value, shot.id, 'VIDEO')] as const,
    ),
  )
  if (token !== loadToken) return
  candidatesByShot.value = Object.fromEntries(entries)
  for (const shot of shots.value) {
    let candidate = latestCandidate(shot.id)
    try {
      candidate = await autoSaveLatestCandidate(shot.id)
    } catch (caught) {
      error.value = `镜头 ${shot.shotNo} 已生成，但自动保存到本地失败：${messageFor(caught, '平台临时媒体暂不可下载')}`
    }
    if (candidate) void loadPreview(candidate)
    const current = displayCandidate(shot)
    if (current?.localAssetId) await autoExtractVideoFrames(shot.id, current)
    if (current && current.id !== candidate?.id) void loadPreview(current)
  }
}

async function loadPromptPreviews(targetShots: Storyboard[] = shots.value) {
  const token = ++promptLoadToken
  const next = targetShots === shots.value ? {} : { ...promptPreviews.value }
  for (let offset = 0; offset < targetShots.length; offset += 20) {
    const group = targetShots.slice(offset, offset + 20)
    if (!group.length) continue
    const result = await mediaGenerationApi.previewBatch(projectId.value, {
      mediaType: 'VIDEO',
      parameters: {},
      items: buildItemsFor(group),
    })
    if (token !== promptLoadToken) return
    result.items.forEach((item) => (next[item.storyboardId] = item))
  }
  if (token === promptLoadToken) promptPreviews.value = next
}

async function loadPromptPreviewsSafely() {
  try {
    await loadPromptPreviews()
  } catch (caught) {
    error.value = messageFor(caught, '部分最终提示词读取失败，当前显示分镜原始信息')
  }
}

async function refreshWorkspace() {
  if (refreshing.value) return
  refreshing.value = true
  error.value = ''
  try {
    await Promise.all([loadEpisodeCandidates(), loadPromptPreviewsSafely()])
    await restoreJobs()
    notice.value = '分镜、最终提示词、视频候选和任务状态已刷新'
  } catch (caught) {
    error.value = messageFor(caught, '刷新批量视频工作台失败')
  } finally {
    refreshing.value = false
  }
}

async function restoreJobs() {
  const jobs = await generationApi.listMine(1, 100)
  const currentProjectJobs = jobs.items.filter(
    (job) =>
      job.projectId === projectId.value &&
      job.targetType === 'STORYBOARD' &&
      job.serviceType === 'VIDEO',
  )
  const next = { ...stateByShot.value }
  for (const job of currentProjectJobs) {
    if (!shots.value.some((shot) => shot.id === job.targetId)) continue
    next[job.targetId] = {
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      errorMessage: job.errorMessage,
      updatedAt: job.updatedAt,
    }
  }
  stateByShot.value = next
  if (hasActiveJobs.value) schedulePolling()
}

function candidateHistory(storyboardId: string) {
  return sortedCandidatesByShot.value[storyboardId] || []
}

function latestCandidate(storyboardId: string) {
  return candidateHistory(storyboardId)[0]
}

function displayCandidate(shot: Storyboard) {
  const candidates = candidateHistory(shot.id)
  const outputSourceId = workspace.outputForStoryboard(shot.id, 'VIDEO')?.sourceId
  return candidates.find((candidate) => candidate.id === outputSourceId) || candidates[0]
}

function effectivePrompt(shot: Storyboard) {
  return (
    promptDrafts.value[shot.id] ??
    shot.finalVideoPrompt ??
    promptPreviews.value[shot.id]?.effectivePrompt ??
    sourcePrompt(shot)
  )
}

function finalPromptFor(shot: Storyboard) {
  const value = promptDrafts.value[shot.id] ?? shot.finalVideoPrompt
  return value?.trim() || undefined
}

function sourcePrompt(shot: Storyboard) {
  const parts = [
    shot.videoPrompt,
    shot.description,
    shot.actionText ? `动作：${shot.actionText}` : '',
    shot.shotType ? `景别：${shot.shotType}` : '',
    shot.angle ? `角度：${shot.angle}` : '',
    shot.movement ? `运镜：${shot.movement}` : '',
    shot.atmosphere ? `氛围：${shot.atmosphere}` : '',
    shot.dialogue ? `对白：${shot.dialogue}` : '',
    shot.soundEffect ? `声音：${shot.soundEffect}` : '',
  ]
  return parts.filter((part) => part?.trim()).join('\n') || '该分镜暂未填写视频提示词'
}

function durationFor(shot: Storyboard) {
  return Math.max(1, Math.min(300, shot.durationSec || 5))
}

function buildItemsFor(
  targetShots: Storyboard[],
  referencePlans: Record<string, BatchReferencePlan> = {},
  preferContactSheetInput = false,
  grokMode: GrokVideoMode = null,
) {
  return targetShots.map((shot) => {
    const keyframe = workspace.outputForStoryboard(shot.id, 'KEYFRAME')
    const contactSheet = workspace.outputForStoryboard(shot.id, 'CONTACT_SHEET')
    const excluded = new Set(excludedAutomaticReferenceIdsByShot.value[shot.id] || [])
    const usableKeyframe = keyframe && !excluded.has(keyframe.mediaAssetId) ? keyframe : null
    const usableContactSheet =
      contactSheet && !excluded.has(contactSheet.mediaAssetId) ? contactSheet : null
    return {
      storyboardId: shot.id,
      prompt: sourcePrompt(shot),
      finalPrompt: [
        effectivePrompt(shot),
        usableContactSheet && grokMode !== 'TEXT_TO_VIDEO'
          ? contactSheetVideoInstruction(shot)
          : '',
        audioModeGenerationInstruction(batchAudioMode.value, shot),
        referencePlans[shot.id]?.instructions,
      ]
        .filter(Boolean)
        .join('\n\n'),
      durationSec: durationFor(shot),
      inputAssetId:
        grokMode !== null
          ? null
          : (preferContactSheetInput
                ? usableContactSheet?.mediaAssetId
                : usableKeyframe?.mediaAssetId) ||
            usableKeyframe?.mediaAssetId ||
            null,
      parameters: {
        duration: durationFor(shot),
        seconds: durationFor(shot),
        duration_sec: durationFor(shot),
        generate_audio: true,
        audio_mode: batchAudioMode.value,
        ...(referencePlans[shot.id]?.parameters || {}),
      },
    }
  })
}

function contactSheetVideoInstruction(shot: Storyboard) {
  return [
    '【九宫格节奏参考】参考图是 3×3 连续电影分镜。',
    '必须按从左到右、从上到下的顺序理解 1 至 9 格，把各格视为同一视频时间线上的连续动作与构图节点。',
    `时间映射：${contactSheetTimelineInstruction(durationFor(shot))}。`,
    '允许按九格规划切换景别、机位、镜头角度或相邻场景；切换必须发生在对应时间节点，并通过动作、视线、声音或空间关系自然衔接。',
    '在节点之间生成自然运动和转场，保持角色身份、服装、场景结构、光线方向和空间位置连续；不要把九格直接作为画面拼贴输出。',
  ].join('\n')
}

async function prepareBatchReferencePlans(
  selectedRoute: GenerationRoute,
  targetShots: Storyboard[],
) {
  const selectedGrokMode = grokVideoMode(generationRouteModelCode(selectedRoute))
  const requireGrokImage = isGrokCompatibleRoute(selectedRoute)
  const hasSupplemental = targetShots.some((shot) =>
    supplementalReferencesFor(shot).some((item) => item.selected),
  )
  if (selectedGrokMode === 'TEXT_TO_VIDEO' && hasSupplemental) {
    throw new Error('grok-imagine-video 仅支持文生视频，请取消手动选择的参考素材')
  }
  if (selectedRoute.sourceType === 'LOCAL') {
    if (hasSupplemental) {
      throw new Error(
        '本地模型批量接口暂不支持发送多个补充参考文件，请选择平台模型，或在单镜头生成中使用本地模型',
      )
    }
    if (selectedGrokMode === 'IMAGE_TO_VIDEO') {
      return Object.fromEntries(
        targetShots.map((shot) => [shot.id, localGrokReferencePlan(shot, requireGrokImage)]),
      ) satisfies Record<string, BatchReferencePlan>
    }
    return {} satisfies Record<string, BatchReferencePlan>
  }

  const requiresLocalPoseWork =
    desktop.available &&
    targetShots.some((shot) =>
      supplementalReferencesFor(shot).some(
        (item) => item.selected && needsLocalPoseProxy(item),
      ),
    )
  const results = await mapSettledWithConcurrency(
    targetShots,
    requiresLocalPoseWork ? 1 : 2,
    async (shot) => [
      shot.id,
      await prepareReferencePlanForShot(shot, selectedGrokMode, requireGrokImage),
    ] as const,
  )
  const plans: Record<string, BatchReferencePlan> = {}
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index]
    if (result.status === 'rejected') {
      throw new Error(
        `镜头 ${targetShots[index].shotNo} 参考素材准备失败：${messageFor(result.reason, '请重试')}`,
      )
    }
    const [storyboardId, plan] = result.value
    plans[storyboardId] = plan
  }
  return plans
}

async function prepareReferencePlanForShot(
  shot: Storyboard,
  selectedGrokMode: GrokVideoMode = null,
  requireGrokImage = false,
): Promise<BatchReferencePlan> {
  const supplemental = supplementalReferencesFor(shot).filter((item) => item.selected)
  if (selectedGrokMode === 'TEXT_TO_VIDEO') return { parameters: {}, instructions: '' }
  if (selectedGrokMode === 'IMAGE_TO_VIDEO') {
    const invalid = supplemental.find((item) => item.mediaType !== 'IMAGE')
    if (invalid) {
      throw new Error(
        `grok-imagine-video-1.5 仅接受图片参考，不能发送“${invalid.label || invalid.file.name}”`,
      )
    }
  }
  const incomplete =
    selectedGrokMode === 'IMAGE_TO_VIDEO'
      ? []
      : supplemental.filter((item) => !item.usageNote.trim())
  if (incomplete.length) {
    throw new Error(`请先说明补充素材“${incomplete[0].label || incomplete[0].file.name}”的用途`)
  }

  const loaded: Array<{
    file: File
    mediaType: BatchReferenceMediaType
    descriptor: BatchVideoReferenceDescriptor
    assetId?: string
  }> = supplemental.map((item) => ({
    file: item.file,
    mediaType: item.mediaType,
    assetId: item.assetId,
    descriptor: {
      mediaType: item.mediaType,
      label: item.label.trim() || item.file.name,
      bindingLabel: supplementalBindingLabel(item),
      purpose: item.purpose,
      usageNote: item.usageNote,
    },
  }))
  const supplementalAssetIds = new Set(supplemental.map((item) => item.assetId).filter(Boolean))

  const automaticCandidates =
    selectedGrokMode === 'IMAGE_TO_VIDEO' ? grokReferenceViewsFor(shot) : referencesFor(shot)
  const availableAutomaticReferences = automaticCandidates.filter(
    (reference) => !supplementalAssetIds.has(reference.assetId),
  )
  const automaticReferences = availableAutomaticReferences
  if (
    selectedGrokMode === 'IMAGE_TO_VIDEO' &&
    availableAutomaticReferences.length > Math.max(0, 7 - supplemental.length)
  ) {
    notice.value = `镜头 ${shot.shotNo} 的参考图超过模型上限，已优先选择最相关的 7 张`
  }
  for (const reference of automaticReferences) {
    if (selectedGrokMode === 'IMAGE_TO_VIDEO' && loaded.length >= 7) break
    try {
      const file = await loadProjectReferenceFile(reference.assetId, reference.label)
      const normalized = await normalizeBatchReferenceFile(file)
      loaded.push({
        file: normalized.file,
        mediaType: normalized.mediaType,
        assetId: reference.assetId,
        descriptor: {
          mediaType: normalized.mediaType,
          label: reference.label,
          bindingLabel: automaticReferenceBindingLabel(reference),
          purpose:
            reference.kind === 'KEYFRAME'
              ? 'FIRST_FRAME'
              : reference.kind === 'END_FRAME'
                ? 'END_FRAME'
                : undefined,
          usageNote: automaticReferenceUsage(reference),
        },
      })
    } catch {
      // 自动素材不可读时继续生成；补充素材读取失败则在添加阶段已经明确提示。
    }
  }

  if (
    selectedGrokMode === 'IMAGE_TO_VIDEO' &&
    loaded.some((item) => item.mediaType !== 'IMAGE')
  ) {
    throw new Error('grok-imagine-video-1.5 仅接受图片参考，不能发送视频或音频素材')
  }
  if (selectedGrokMode === 'IMAGE_TO_VIDEO' && loaded.length > 7) {
    throw new Error('grok-imagine-video-1.5 每个镜头最多发送 7 张参考图片')
  }
  if (loaded.length > MAX_BATCH_REFERENCE_FILES) {
    throw new Error(`单个镜头最多发送 ${MAX_BATCH_REFERENCE_FILES} 个参考素材`)
  }
  let convertedMotionCount = 0
  if (desktop.available) {
    for (const item of loaded) {
      if (!needsLocalPoseProxy(item.descriptor)) continue
      const sourceName = item.file.name
      notice.value = `镜头 ${shot.shotNo} 正在本地提取动作参考的人物轮廓，原视频不会上传`
      const result = await createLocalPoseProxy(item.file, (progress) => {
        notice.value = `镜头 ${shot.shotNo} 姿态代理：${progress.message}`
      })
      convertedMotionCount += 1
      item.file = new File(
        [result.file],
        `pose-proxy-shot-${shot.shotNo}-${convertedMotionCount}.mp4`,
        { type: result.file.type || 'video/mp4', lastModified: Date.now() },
      )
      item.descriptor = {
        ...item.descriptor,
        label: `${item.descriptor.label}（本地姿态代理）`,
        purpose: 'POSE_PROXY',
        usageNote: `由“${sourceName}”在 Windows 客户端本地提取，只参考动作轨迹、节奏、姿态和站位，不包含原人物外观。`,
      }
    }
  }
  const totalBytes = loaded.reduce((sum, item) => sum + item.file.size, 0)
  if (totalBytes > MAX_BATCH_REFERENCE_TOTAL_BYTES) {
    throw new Error('单个镜头参考素材总大小不能超过 100MB')
  }
  if (!loaded.length && selectedGrokMode === 'IMAGE_TO_VIDEO' && requireGrokImage) {
    throw new Error('grok-imagine-video-1.5 仅支持图生视频，请至少生成或添加一张参考图片')
  }
  if (!loaded.length) return { parameters: {}, instructions: '' }

  const uploaded = await mediaGenerationApi.uploadReferences(loaded.map((item) => item.file))
  if (uploaded.length !== loaded.length) throw new Error('参考素材上传结果不完整，请重试')
  const referenceImageIds: string[] = []
  const referenceVideoIds: string[] = []
  const referenceAudioIds: string[] = []
  uploaded.forEach((item) => {
    if (item.mediaType === 'IMAGE') referenceImageIds.push(item.id)
    else if (item.mediaType === 'VIDEO') referenceVideoIds.push(item.id)
    else referenceAudioIds.push(item.id)
  })
  return {
    parameters: {
      ...(referenceImageIds.length ? { reference_image_ids: referenceImageIds } : {}),
      ...(referenceVideoIds.length ? { reference_video_ids: referenceVideoIds } : {}),
      ...(referenceAudioIds.length ? { reference_audio_ids: referenceAudioIds } : {}),
      ...(selectedGrokMode === 'IMAGE_TO_VIDEO'
        ? {
            reference_mode:
              loaded.length === 1 && loaded[0]?.descriptor.purpose === 'FIRST_FRAME'
                ? 'IMAGE_TO_VIDEO'
                : 'REFERENCE_TO_VIDEO',
          }
        : {}),
      ...(convertedMotionCount
        ? {
            motion_pipeline: 'MOTION_FINAL',
            video_mode: 'MOTION_FINAL',
            motion_reference_source: 'LOCAL_POSE_PROXY',
          }
        : {}),
    },
    instructions: buildBatchReferenceInstructions(loaded.map((item) => item.descriptor)),
  }
}

function localGrokReferencePlan(
  shot: Storyboard,
  requireGrokImage: boolean,
): BatchReferencePlan {
  const excluded = new Set(excludedAutomaticReferenceIdsByShot.value[shot.id] || [])
  const availableReferences = grokReferenceViewsFor(shot).filter(
    (reference) => !excluded.has(reference.assetId),
  )
  const references = availableReferences.slice(0, 7)
  if (!references.length) {
    if (!requireGrokImage) return { parameters: {}, instructions: '' }
    throw new Error(
      `镜头 ${shot.shotNo} 没有可用参考图片；grok-imagine-video-1.5 至少需要一张图片`,
    )
  }
  if (availableReferences.length > references.length) {
    notice.value = `镜头 ${shot.shotNo} 的参考图超过模型上限，已优先选择最相关的 7 张`
  }
  return {
    parameters: {
      reference_asset_ids: references.map((item) => item.assetId),
      reference_mode:
        references.length === 1 && references[0]?.kind === 'KEYFRAME'
          ? 'IMAGE_TO_VIDEO'
          : 'REFERENCE_TO_VIDEO',
    },
    instructions: buildBatchReferenceInstructions(
      references.map((reference) => ({
        mediaType: 'IMAGE' as const,
        label: reference.label,
        bindingLabel: automaticReferenceBindingLabel(reference),
        purpose:
          reference.kind === 'KEYFRAME'
            ? 'FIRST_FRAME'
            : reference.kind === 'END_FRAME'
              ? 'END_FRAME'
              : undefined,
        usageNote: automaticReferenceUsage(reference),
      })),
    ),
  }
}

function grokReferenceViewsFor(shot: Storyboard) {
  const priority: Record<ReferenceView['kind'], number> = {
    KEYFRAME: 0,
    CONTACT_SHEET: 1,
    REFERENCE: 2,
    END_FRAME: 3,
  }
  return [...referencesFor(shot)].sort(
    (left, right) => priority[left.kind] - priority[right.kind],
  )
}

function openReferenceEditor(shot: Storyboard) {
  referenceEditorShotId.value = shot.id
}

function updateSupplementalReferences(storyboardId: string, items: BatchVideoReferenceDraft[]) {
  supplementalReferencesByShot.value = {
    ...supplementalReferencesByShot.value,
    [storyboardId]: items,
  }
}

function supplementalReferencesFor(shot: Storyboard) {
  return supplementalReferencesByShot.value[shot.id] || []
}

function selectedSupplementalReferencesFor(shot: Storyboard) {
  return supplementalReferencesFor(shot).filter((item) => item.selected)
}

function releaseSupplementalReferences() {
  Object.values(supplementalReferencesByShot.value)
    .flat()
    .forEach((item) => URL.revokeObjectURL(item.previewUrl))
}

function supplementalBindingLabel(item: BatchVideoReferenceDraft) {
  if (
    item.bindingType === 'CHARACTER' ||
    item.bindingType === 'VOICE' ||
    item.bindingType === 'WEAPON'
  ) {
    const character = workspace.characters.find((entry) => entry.id === item.bindingTargetId)?.name
    if (item.bindingType === 'VOICE') return character ? `角色声音：${character}` : '角色声音'
    if (item.bindingType === 'WEAPON') return character ? `角色武器：${character}` : '武器参考'
    return character ? `角色：${character}` : '角色外观'
  }
  if (item.bindingType === 'SCENE' || item.bindingType === 'BACKGROUND') {
    const scene = workspace.scenes.find((entry) => entry.id === item.bindingTargetId)?.title
    return scene ? `${item.bindingType === 'SCENE' ? '场景' : '背景'}：${scene}` : '场景/背景'
  }
  if (item.bindingType === 'PROP') return '道具参考'
  if (item.bindingType === 'MOTION') return '动作参考'
  if (item.bindingType === 'SFX') return '音效/环境声'
  if (item.bindingType === 'STYLE') return '风格参考'
  return undefined
}

function automaticReferenceBindingLabel(reference: ReferenceView) {
  if (reference.label.startsWith('角色基础图：'))
    return reference.label.replace('角色基础图：', '角色：')
  if (reference.label.startsWith('场景：')) return reference.label
  if (reference.kind === 'KEYFRAME') return '当前分镜首帧'
  if (reference.kind === 'END_FRAME') return '当前分镜尾帧'
  if (reference.kind === 'CONTACT_SHEET') return '当前分镜九宫格节奏参考'
  return '项目参考素材'
}

function automaticReferenceUsage(reference: ReferenceView) {
  if (reference.kind === 'KEYFRAME')
    return '用于约束视频开场构图、人物位置和光线，从该画面自然起步。'
  if (reference.kind === 'END_FRAME') return '用于约束视频结束状态，动作和运镜应自然过渡到该画面。'
  if (reference.kind === 'CONTACT_SHEET')
    return '用于约束长镜头的九个时间节点、动作阶段、构图变化和自然转场，按从左到右、从上到下的顺序执行。'
  if (reference.label.startsWith('角色基础图：'))
    return '只用于保持对应角色身份、脸、发型、服装和身体比例一致。'
  if (reference.label.startsWith('场景：'))
    return '只用于保持对应场景空间结构、光线、陈设和氛围一致。'
  return '按素材名称和绑定关系作为当前镜头参考。'
}

async function loadProjectReferenceFile(assetId: string, label: string) {
  const local = desktop.project?.assets.find((item) => item.id === assetId)
  const server = workspace.mediaAssetById(assetId)
  let blob: Blob | null = null
  if (desktop.available && local?.fileAvailable) {
    blob = await tryLoadReferenceBlob(async () => {
      const response = await fetch(desktop.assetPreviewUrl(assetId))
      return response.ok ? response.blob() : null
    })
  }
  if (!blob && (server?.contentAvailable || server?.storageScope === 'SERVER')) {
    blob = await tryLoadReferenceBlob(() => mediaAssetApi.content(projectId.value, assetId))
  }
  if (!blob) {
    const mimeType = server?.mimeType || local?.mimeType || ''
    blob = await tryLoadReferenceBlob(() =>
      mimeType.startsWith('image/')
        ? loadBrowserImage(projectId.value, assetId)
        : loadBrowserMedia(projectId.value, assetId),
    )
  }
  if (!blob) throw new Error(`${label}的本地和服务端文件都不可用`)
  return new File([blob], server?.originalFilename || local?.originalName || label, {
    type: blob.type || server?.mimeType || local?.mimeType || '',
    lastModified: Date.now(),
  })
}

async function tryLoadReferenceBlob(load: () => Promise<Blob | null>) {
  try {
    return await load()
  } catch {
    return null
  }
}

async function openBatchDialog() {
  if (!selectedCount.value) {
    error.value = '请先选择要生成的分镜'
    return
  }
  if (selectedCount.value > 20) {
    error.value = '单次最多生成 20 个分镜，请分批提交'
    return
  }
  submitting.value = true
  error.value = ''
  try {
    await savePendingPromptDrafts(selectedShots.value)
    await applyBatchAudioMode(selectedShots.value)
    await loadPromptPreviews(selectedShots.value)
    routeDialogMode.value = 'GENERATE'
    routeOpen.value = true
  } catch (caught) {
    error.value = messageFor(caught, '最终提示词读取失败')
  } finally {
    submitting.value = false
  }
}

async function applyBatchAudioMode(targetShots: Storyboard[]) {
  const changed = targetShots.filter((shot) => shot.audioMode !== batchAudioMode.value)
  if (!changed.length) return
  const result = await workspace.updateStoryboardAudioModeBatch(
    projectId.value,
    changed,
    batchAudioMode.value,
  )
  notice.value = `已将 ${result.updatedCount} 个分镜设置为${audioModeLabel(batchAudioMode.value)}`
}

function audioModeLabel(audioMode: Storyboard['audioMode']) {
  return audioMode === 'VIDEO_NATIVE' ? '视频原声' : 'AI 配音'
}

function audioModeGenerationInstruction(audioMode: Storyboard['audioMode'], shot: Storyboard) {
  if (audioMode === 'VIDEO_NATIVE') {
    return [
      '【声音制作方式】视频原声。',
      '视频模型直接生成自然清晰的人声、环境声、动作音效和空间氛围声。',
      shot.dialogue?.trim()
        ? `台词必须准确说出，不得改写、漏字或增加内容：${shot.dialogue.trim()}`
        : '',
      shot.innerMonologue?.trim()
        ? `内心独白作为画外音呈现，人物嘴唇保持自然闭合：${shot.innerMonologue.trim()}`
        : '',
    ]
      .filter(Boolean)
      .join('\n')
  }
  return [
    '【声音制作方式】后期 AI 配音。',
    '视频中不要生成人物对白、旁白或其他人声；对白部分只保留自然匹配台词节奏的口型。',
    '必须保留并生成场景环境声、动作音效和空间氛围声，不能输出完全静音的视频。',
  ].join('\n')
}

function modelRouteLabel(selected: GenerationRoute | null, fallback: string) {
  if (!selected) return fallback
  return selected.sourceType === 'LOCAL'
    ? selected.localModelName
    : selected.modelName || '已选平台模型'
}

function openModelSelector(serviceType: 'TEXT' | 'IMAGE' | 'VIDEO') {
  if (serviceType === 'TEXT') textRouteOpen.value = true
  else if (serviceType === 'IMAGE') imageRouteOpen.value = true
  else {
    routeDialogMode.value = 'CONFIGURE'
    routeOpen.value = true
  }
}

function selectTextRoute(selectedRoute: GenerationRoute) {
  textRouteSelection.value = selectedRoute
  textRouteOpen.value = false
  notice.value = '九宫格规划文本模型已选择'
}

function selectImageRoute(selectedRoute: GenerationRoute) {
  imageRouteSelection.value = selectedRoute
  imageRouteOpen.value = false
  notice.value = '九宫格图片模型已选择'
}

function handleVideoRouteSubmit(selectedRoute: GenerationRoute) {
  if (routeDialogMode.value === 'CONFIGURE') {
    routeSelection.value = selectedRoute
    routeOpen.value = false
    notice.value = '批量视频模型已选择'
    return
  }
  void submitBatch(selectedRoute)
}

function editPrompt(shot: Storyboard) {
  if (!promptEditingIds.value.includes(shot.id)) {
    promptEditingIds.value = [...promptEditingIds.value, shot.id]
  }
  promptDrafts.value = { ...promptDrafts.value, [shot.id]: effectivePrompt(shot) }
}

function cancelPromptEdit(shot: Storyboard) {
  promptEditingIds.value = promptEditingIds.value.filter((id) => id !== shot.id)
  const next = { ...promptDrafts.value }
  delete next[shot.id]
  promptDrafts.value = next
}

async function savePromptOverride(shot: Storyboard, announce = true) {
  if (promptSavingIds.value.includes(shot.id)) return
  const finalVideoPrompt = finalPromptFor(shot)
  if (!finalVideoPrompt) throw new Error(`镜头 ${shot.shotNo} 的最终视频提示词不能为空`)
  promptSavingIds.value = [...promptSavingIds.value, shot.id]
  try {
    const saved = await workspace.updateFinalVideoPrompt(projectId.value, shot.id, finalVideoPrompt)
    promptPreviews.value = {
      ...promptPreviews.value,
      [shot.id]: {
        storyboardId: shot.id,
        durationSec: durationFor(saved),
        effectivePrompt: finalVideoPrompt,
        parameters: {
          ...(promptPreviews.value[shot.id]?.parameters || {}),
          prompt: finalVideoPrompt,
          raw_prompt: sourcePrompt(saved),
        },
      },
    }
    promptEditingIds.value = promptEditingIds.value.filter((id) => id !== shot.id)
    const next = { ...promptDrafts.value }
    delete next[shot.id]
    promptDrafts.value = next
    if (announce) notice.value = `镜头 ${shot.shotNo} 的最终视频提示词已保存`
  } finally {
    promptSavingIds.value = promptSavingIds.value.filter((id) => id !== shot.id)
  }
}

async function savePromptFromRow(shot: Storyboard) {
  error.value = ''
  try {
    await savePromptOverride(shot)
  } catch (caught) {
    error.value = messageFor(caught, '最终视频提示词保存失败')
  }
}

async function restoreAutomaticPrompt(shot: Storyboard) {
  if (promptSavingIds.value.includes(shot.id)) return
  promptSavingIds.value = [...promptSavingIds.value, shot.id]
  error.value = ''
  try {
    const saved = await workspace.updateFinalVideoPrompt(projectId.value, shot.id, null)
    promptEditingIds.value = promptEditingIds.value.filter((id) => id !== shot.id)
    const drafts = { ...promptDrafts.value }
    delete drafts[shot.id]
    promptDrafts.value = drafts
    await loadPromptPreviews([saved])
    notice.value = `镜头 ${shot.shotNo} 已恢复为自动整合提示词`
  } catch (caught) {
    error.value = messageFor(caught, '恢复自动整合提示词失败')
  } finally {
    promptSavingIds.value = promptSavingIds.value.filter((id) => id !== shot.id)
  }
}

async function savePendingPromptDrafts(targetShots: Storyboard[]) {
  for (const shot of targetShots) {
    if (!promptEditingIds.value.includes(shot.id)) continue
    await savePromptOverride(shot, false)
  }
}

async function generateContactSheet(shot: Storyboard) {
  if (contactSheetGeneratingIds.value.includes(shot.id)) return
  if (!textRouteSelection.value || !imageRouteSelection.value) {
    error.value = '请先在顶部选择文本模型和图片模型，再生成九宫格参考图'
    return
  }
  if (!desktop.available || !desktop.project) {
    error.value = '九宫格参考图需要在 Windows 客户端生成并保存到本地项目目录'
    return
  }
  contactSheetGeneratingIds.value = [...contactSheetGeneratingIds.value, shot.id]
  error.value = ''
  notice.value = `镜头 ${shot.shotNo} 正在规划九宫格节奏`
  try {
    const plan = await generateContactSheetPlan(shot, textRouteSelection.value)
    contactSheetPlans.value = { ...contactSheetPlans.value, [shot.id]: plan }
    notice.value = `镜头 ${shot.shotNo} 九宫格规划完成，正在生成参考图`
    const candidate = await generateContactSheetImage(shot, plan, imageRouteSelection.value)
    await persistContactSheetCandidate(shot, candidate)
    notice.value = `镜头 ${shot.shotNo} 九宫格已生成并自动保存到本地`
  } catch (caught) {
    error.value = `镜头 ${shot.shotNo} 九宫格生成失败：${messageFor(caught, '请重试')}`
  } finally {
    contactSheetGeneratingIds.value = contactSheetGeneratingIds.value.filter((id) => id !== shot.id)
  }
}

async function removeContactSheet(shot: Storyboard) {
  const output = workspace.outputForStoryboard(shot.id, 'CONTACT_SHEET')
  if (!output || contactSheetGeneratingIds.value.includes(shot.id)) return
  if (!globalThis.confirm(`确定删除镜头 ${shot.shotNo} 的九宫格图片吗？删除后生成视频不会再自动使用它。`)) {
    return
  }
  error.value = ''
  try {
    await workspace.deleteStoryboardOutput(projectId.value, shot.id, 'CONTACT_SHEET')
    const hasLocalAsset = Boolean(
      desktop.project?.assets.some((asset) => asset.id === output.mediaAssetId),
    )
    if (isLocalProjectId(projectId.value) && desktop.available && desktop.project && hasLocalAsset) {
      await desktop.removeAsset(output.mediaAssetId)
      if (desktop.error) throw new Error(desktop.error)
    }
    if (isLocalProjectId(projectId.value)) {
      workspace.forgetMediaAsset(output.mediaAssetId)
    } else {
      await workspace.deleteMediaAsset(projectId.value, output.mediaAssetId)
    }
    contactSheetPlans.value = Object.fromEntries(
      Object.entries(contactSheetPlans.value).filter(([id]) => id !== shot.id),
    )
    notice.value = `镜头 ${shot.shotNo} 的九宫格图片已删除，生成视频不再使用九宫格参考`
  } catch (caught) {
    error.value = `镜头 ${shot.shotNo} 九宫格删除失败：${messageFor(caught, '请重试')}`
  }
}

async function generateContactSheetPlan(shot: Storyboard, selectedRoute: GenerationRoute) {
  let job = await generationApi.create(
    projectId.value,
    {
      jobType: 'STORYBOARD_CONTACT_SHEET_PLAN',
      targetType: 'STORYBOARD',
      targetId: shot.id,
      parameters: { temperature: 0.25, max_tokens: 1800 },
      route: selectedRoute,
    },
    crypto.randomUUID(),
  )
  job = await executeTextGeneration(job, selectedRoute, desktop)
  if (job.status !== 'SUCCEEDED' || !job.resultText?.trim()) {
    throw new Error(job.errorMessage || '文本模型未返回九宫格规划')
  }
  const plan = normalizeContactSheetPlan(job.resultText.trim(), durationFor(shot))
  if (!plan) {
    throw new Error('文本模型未返回完整的 9 格画面规划，请重试')
  }
  return plan
}

async function generateContactSheetImage(
  shot: Storyboard,
  plan: string,
  selectedRoute: GenerationRoute,
) {
  const referenceFiles = await loadContactSheetReferenceFiles(shot)
  const uploadedReferences =
    selectedRoute.sourceType === 'PLATFORM' && referenceFiles.length
      ? await imageGenerationApi.uploadReferences(referenceFiles)
      : []
  let job = await imageGenerationApi.create(
    projectId.value,
    {
      targetType: 'STORYBOARD',
      targetId: shot.id,
      prompt: buildContactSheetImagePrompt(shot, plan),
      negativePrompt:
        '九张无关图片，角色换脸，服装变化，场景结构变化，文字，数字，标题，水印，对话框，拼贴遮挡，重复画格',
      size: '1024x1024',
      compositionType: 'CONTACT_SHEET',
      parameters: uploadedReferences.length
        ? { reference_image_ids: uploadedReferences.map((item) => item.id) }
        : undefined,
      route: selectedRoute,
    },
    crypto.randomUUID(),
  )
  if (selectedRoute.sourceType === 'LOCAL') {
    job = await generationApi.startLocal(job.id)
    const stopHeartbeat = startLocalJobHeartbeat(job.id, 30)
    try {
      const execution = job.executionRequest
      if (!execution) throw new Error('本地九宫格图片任务缺少执行参数')
      const local = await desktop.generateLocalImage({
        projectId: projectId.value,
        connectionId: selectedRoute.localConnectionId,
        prompt: execution.userPrompt,
        negativePrompt:
          typeof execution.parameters.negative_prompt === 'string'
            ? execution.parameters.negative_prompt
            : undefined,
        size: '1024x1024',
        referenceImages: await Promise.all(
          referenceFiles.map(async (file) => ({
            name: file.name,
            mimeType: file.type as 'image/png' | 'image/jpeg' | 'image/webp',
            bytes: await file.arrayBuffer(),
          })),
        ),
      })
      await imageGenerationApi.completeLocal(job.id, {
        clientCandidateId: local.id,
        providerCode: local.providerCode,
        modelName: local.modelName,
        mimeType: local.mimeType,
        sizeBytes: local.sizeBytes,
        sha256: local.sha256,
        width: local.width,
        height: local.height,
        revisedPrompt: local.revisedPrompt,
      })
    } catch (caught) {
      await generationApi
        .failLocal(job.id, messageFor(caught, '本地九宫格图片生成失败'))
        .catch(() => undefined)
      throw caught
    } finally {
      stopHeartbeat()
    }
  } else {
    job = await waitForGenerationJob(job.id, '九宫格图片')
    if (job.status !== 'SUCCEEDED') throw new Error(job.errorMessage || '平台九宫格图片生成失败')
  }
  const candidates = await imageGenerationApi.list(projectId.value, 'STORYBOARD', shot.id)
  const candidate = candidates.find((item) => item.jobId === job.id)
  if (!candidate) throw new Error('九宫格图片候选尚未就绪，请稍后重试')
  return candidate
}

async function waitForGenerationJob(jobId: string, label: string) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const job = await generationApi.get(jobId)
    if (['SUCCEEDED', 'FAILED', 'CANCELED'].includes(job.status)) return job
    await new Promise((resolve) => globalThis.setTimeout(resolve, 1500))
  }
  throw new Error(`${label}仍在处理中，可稍后刷新查看`)
}

async function loadContactSheetReferenceFiles(shot: Storyboard) {
  const imageReferences = referencesFor(shot).filter(
    (reference) => reference.kind !== 'CONTACT_SHEET',
  )
  const files: File[] = []
  for (const reference of imageReferences.slice(0, 8)) {
    try {
      const file = await loadProjectReferenceFile(reference.assetId, reference.label)
      if (file.type.startsWith('image/')) files.push(file)
    } catch {
      // A missing optional reference must not block the entire contact sheet.
    }
  }
  return files
}

async function persistContactSheetCandidate(shot: Storyboard, candidate: ImageCandidate) {
  const selected =
    candidate.status === 'AVAILABLE'
      ? await imageGenerationApi.select(candidate.id, candidate.version)
      : candidate
  const accessToken = imageGenerationApi.accessToken()
  if (selected.deliveryType !== 'LOCAL_CACHE' && !accessToken) {
    throw new Error('登录状态已失效，九宫格候选无法下载到本地')
  }
  const localAsset = await desktop.saveGeneratedImage(
    selected.deliveryType === 'LOCAL_CACHE'
      ? {
          projectId: projectId.value,
          projectTitle: project.value?.title || '漫剧项目',
          candidateId: selected.id,
          deliveryType: 'LOCAL_CACHE',
          clientCandidateId: requiredImageClientCandidateId(selected),
          category: 'storyboards',
        }
      : {
          projectId: projectId.value,
          projectTitle: project.value?.title || '漫剧项目',
          candidateId: selected.id,
          deliveryType: 'PLATFORM_REMOTE',
          category: 'storyboards',
          accessToken: accessToken!,
        },
  )
  const mappings = await workspace.synchronizeLocalAssets(projectId.value, [localAsset])
  const canonicalId =
    mappings.find((item) => item.clientAssetId === localAsset.id)?.assetId || localAsset.id
  await desktop.reconcileAssetIds(mappings.filter((item) => item.clientAssetId !== item.assetId))
  const saved = await imageGenerationApi.confirmSaved(selected.id, canonicalId, selected.version)
  if (!saved.localAssetId) throw new Error('九宫格图片本地素材标识缺失')
  await workspace.setStoryboardOutput(projectId.value, shot.id, {
    outputType: 'CONTACT_SHEET',
    mediaAssetId: saved.localAssetId,
    sourceType: 'IMAGE_CANDIDATE',
    sourceId: saved.id,
  })
}

async function submitBatch(selectedRoute: GenerationRoute) {
  if (!canSubmit.value) return
  submitting.value = true
  routeSelection.value = selectedRoute
  error.value = ''
  try {
    const selectedGrokMode = grokVideoMode(generationRouteModelCode(selectedRoute))
    const referencePlans = await prepareBatchReferencePlans(selectedRoute, selectedShots.value)
    const result = await mediaGenerationApi.createBatch(
      projectId.value,
      {
        mediaType: 'VIDEO',
        route: selectedRoute,
        parameters: {},
        items: buildItemsFor(
          selectedShots.value,
          referencePlans,
          selectedRoute.sourceType === 'LOCAL' && selectedGrokMode === null,
          selectedGrokMode,
        ),
      },
      crypto.randomUUID(),
    )
    const next = { ...stateByShot.value }
    for (const item of result.items) {
      next[item.storyboardId] = {
        jobId: item.jobId || undefined,
        status: item.success ? normalizeStatus(item.status) : 'FAILED',
        progress: item.success ? 0 : 100,
        errorMessage: item.errorMessage,
      }
    }
    stateByShot.value = next
    routeOpen.value = false
    const failedDetails = result.items
      .filter((item) => !item.success)
      .map((item) => {
        const shot = shots.value.find((candidate) => candidate.id === item.storyboardId)
        return `镜头 ${shot?.shotNo ?? item.storyboardId}：${item.errorMessage || '任务创建失败'}`
      })
      .join('；')
    if (result.failedCount > 0) {
      error.value =
        result.successCount > 0
          ? `部分视频任务提交失败（${result.successCount}/${result.totalCount} 已提交）：${failedDetails}`
          : `视频任务未提交：${failedDetails}`
      notice.value = result.successCount > 0 ? '已提交的任务仍会继续执行，失败项不会扣点' : ''
    } else {
      notice.value = `已提交 ${result.successCount}/${result.totalCount} 个视频任务`
    }
    if (selectedRoute.sourceType === 'PLATFORM') await credits.load(true)
    selectedIds.value = result.items
      .filter((item) => !item.success)
      .map((item) => item.storyboardId)
    if (selectedRoute.sourceType === 'LOCAL') void executeLocalBatch(selectedRoute, result.items)
    else schedulePolling()
  } catch (caught) {
    error.value = messageFor(caught, '批量视频提交失败')
  } finally {
    submitting.value = false
  }
}

async function executeLocalBatch(
  selectedRoute: Extract<GenerationRoute, { sourceType: 'LOCAL' }>,
  items: BatchMediaGenerationItemResult[],
) {
  const pending = items.filter((item) => item.success && item.jobId)
  const completedShotIds: string[] = []
  await mapSettledWithConcurrency(pending, 2, async (item) => {
    const jobId = item.jobId!
    updateShotState(item.storyboardId, { jobId, status: 'RUNNING', progress: 10 })
    let stopHeartbeat = () => undefined
    try {
      const running = await generationApi.startLocal(jobId)
      stopHeartbeat = startLocalJobHeartbeat(jobId, 25)
      const execution = running.executionRequest
      if (!execution) throw new Error('本地视频任务缺少执行参数')
      const durationSec = numberParameter(execution.parameters.duration_sec, 5)
      const aspectRatio = workspace.project?.aspectRatio === '16:9' ? '16:9' : '9:16'
      const local = await desktop.generateLocalMedia({
        projectId: projectId.value,
        connectionId: selectedRoute.localConnectionId,
        mediaType: 'VIDEO',
        prompt: execution.userPrompt,
        durationSec,
        inputAssetId: stringParameter(execution.parameters.input_asset_id),
        referenceAssetIds: stringArrayParameter(execution.parameters.reference_asset_ids),
        size: aspectRatio === '16:9' ? '1280x720' : '720x1280',
        aspectRatio,
        parameters: {
          generate_audio: true,
          ...(stringParameter(execution.parameters.reference_mode)
            ? { reference_mode: stringParameter(execution.parameters.reference_mode)! }
            : {}),
        },
      })
      await mediaGenerationApi.completeLocal(jobId, {
        clientCandidateId: local.id,
        providerCode: local.providerCode,
        modelName: local.modelName,
        mimeType: local.mimeType,
        sizeBytes: local.sizeBytes,
        sha256: local.sha256,
        durationMs: local.durationMs,
        width: local.width,
        height: local.height,
      })
      updateShotState(item.storyboardId, { jobId, status: 'SUCCEEDED', progress: 100 })
      const candidates = await mediaGenerationApi.list(projectId.value, item.storyboardId, 'VIDEO')
      candidatesByShot.value = { ...candidatesByShot.value, [item.storyboardId]: candidates }
      completedShotIds.push(item.storyboardId)
      const candidate = latestCandidate(item.storyboardId)
      if (candidate) void loadPreview(candidate)
    } catch (caught) {
      const message = messageFor(caught, '本地视频生成失败')
      await generationApi.failLocal(jobId, message).catch(() => undefined)
      updateShotState(item.storyboardId, {
        jobId,
        status: 'FAILED',
        progress: 100,
        errorMessage: message,
      })
    } finally {
      stopHeartbeat()
    }
  })
  for (const storyboardId of completedShotIds) {
    const candidate = await autoSaveLatestCandidate(storyboardId)
    if (candidate) void loadPreview(candidate)
  }
  notice.value = failedCount.value
    ? `批量执行结束：${readyCount.value} 个已有视频，${failedCount.value} 个失败`
    : '本地批量视频已全部生成完成'
}

function updateShotState(storyboardId: string, state: ShotState) {
  stateByShot.value = { ...stateByShot.value, [storyboardId]: state }
}

function numberParameter(value: unknown, fallback: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function stringParameter(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function stringArrayParameter(value: unknown) {
  if (!Array.isArray(value)) return undefined
  const normalized = value.filter(
    (item): item is string => typeof item === 'string' && Boolean(item.trim()),
  )
  return normalized.length ? normalized.map((item) => item.trim()) : undefined
}

async function retryFailed() {
  const failed = shots.value.filter((shot) => stateByShot.value[shot.id]?.status === 'FAILED')
  selectedIds.value = failed.map((shot) => shot.id)
  await openBatchDialog()
}

function regenerateShot(shot: Storyboard) {
  selectedIds.value = [shot.id]
  void openBatchDialog()
}

function normalizeStatus(status?: string | null): BatchStatus {
  if (
    status === 'WAITING_LOCAL' ||
    status === 'QUEUED' ||
    status === 'RUNNING' ||
    status === 'SUCCEEDED' ||
    status === 'FAILED' ||
    status === 'CANCELED'
  )
    return status
  return 'QUEUED'
}

function schedulePolling() {
  stopPolling()
  if (!hasActiveJobs.value) return
  pollingTimer = globalThis.setTimeout(() => void pollJobs(), 1800)
}

function stopPolling() {
  if (pollingTimer) globalThis.clearTimeout(pollingTimer)
  pollingTimer = undefined
}

async function pollJobs() {
  const active = Object.entries(stateByShot.value).filter(
    ([, state]) => state.jobId && isRunningStatus(state.status),
  )
  if (!active.length) return
  const updates = await Promise.allSettled(
    active.map(([, state]) => generationApi.get(state.jobId!)),
  )
  const next = { ...stateByShot.value }
  for (const update of updates) {
    if (update.status !== 'fulfilled') continue
    const job = update.value
    next[job.targetId] = {
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      errorMessage: job.errorMessage,
      updatedAt: job.updatedAt,
    }
    if (job.status === 'SUCCEEDED') {
      const candidates = await mediaGenerationApi.list(projectId.value, job.targetId, 'VIDEO')
      candidatesByShot.value = { ...candidatesByShot.value, [job.targetId]: candidates }
      const candidate = await autoSaveLatestCandidate(job.targetId)
      if (candidate) void loadPreview(candidate)
    }
  }
  stateByShot.value = next
  schedulePolling()
}

async function autoSaveLatestCandidate(storyboardId: string) {
  const candidate = latestCandidate(storyboardId)
  if (!candidate || candidate.status === 'LOCAL_SAVED' || candidate.localAssetId) return candidate
  if (!desktop.available || !desktop.project) return candidate
  return persistCandidateToLocal(storyboardId, candidate)
}

async function persistCandidateToLocal(storyboardId: string, candidate: MediaCandidate) {
  if (!desktop.available || !desktop.project) throw new Error('本地保存需要 Windows 客户端')
  if (candidate.localAssetId || candidate.status === 'LOCAL_SAVED') {
    if (!candidate.localAssetId) throw new Error('候选缺少本地素材标识')
    await setCurrentStoryboardVideo(storyboardId, candidate)
    return candidate
  }
  const selected =
    candidate.status === 'AVAILABLE'
      ? await mediaGenerationApi.select(candidate.id, candidate.version)
      : candidate
  const accessToken = mediaGenerationApi.accessToken()
  if (selected.deliveryType !== 'LOCAL_CACHE' && !accessToken) {
    throw new Error('登录状态已失效，视频候选暂未保存到本地')
  }
  const localAsset = await desktop.saveGeneratedMedia(
    selected.deliveryType === 'LOCAL_CACHE'
      ? {
          projectId: projectId.value,
          projectTitle: project.value?.title || '漫剧项目',
          candidateId: selected.id,
          deliveryType: 'LOCAL_CACHE',
          clientCandidateId: requiredClientCandidateId(selected),
          category: 'videos',
        }
      : {
          projectId: projectId.value,
          projectTitle: project.value?.title || '漫剧项目',
          candidateId: selected.id,
          deliveryType: selected.deliveryType,
          category: 'videos',
          accessToken: accessToken!,
        },
  )
  const mappings = await workspace.synchronizeLocalAssets(projectId.value, [localAsset])
  const canonicalId =
    mappings.find((item) => item.clientAssetId === localAsset.id)?.assetId || localAsset.id
  await desktop.reconcileAssetIds(mappings.filter((item) => item.clientAssetId !== item.assetId))
  const saved = await mediaGenerationApi.confirmSaved(selected.id, canonicalId, selected.version)
  replaceCandidate(storyboardId, saved)
  await setCurrentStoryboardVideo(storyboardId, saved)
  return saved
}

async function setCurrentStoryboardVideo(storyboardId: string, candidate: MediaCandidate) {
  if (!candidate.localAssetId) throw new Error('候选尚未保存到本地')
  await workspace.setStoryboardOutput(projectId.value, storyboardId, {
    outputType: 'VIDEO',
    mediaAssetId: candidate.localAssetId,
    sourceType: 'MEDIA_CANDIDATE',
    sourceId: candidate.id,
  })
  await autoExtractVideoFrames(storyboardId, candidate)
}

async function autoExtractVideoFrames(storyboardId: string, candidate: MediaCandidate) {
  const shot = shots.value.find((item) => item.id === storyboardId)
  if (!shot || !candidate.localAssetId || !desktop.available) return
  frameStateByShot.value = {
    ...frameStateByShot.value,
    [storyboardId]: { status: 'EXTRACTING', message: '正在自动提取首尾帧' },
  }
  try {
    const result = await extractStoryboardVideoFrames({
      projectId: projectId.value,
      storyboard: shot,
      videoAssetId: candidate.localAssetId,
      sourceCandidateId: candidate.id,
      desktop,
      workspace,
    })
    const completed = result.extracted.length + result.skipped.length
    frameStateByShot.value = {
      ...frameStateByShot.value,
      [storyboardId]: result.errors.length
        ? {
            status: completed ? 'PARTIAL' : 'FAILED',
            message: completed
              ? `已关联 ${completed}/2 帧；${result.errors.join('；')}`
              : `首尾帧自动提取失败：${result.errors.join('；')}`,
          }
        : { status: 'DONE', message: '首帧和尾帧已自动提取并关联' },
    }
  } catch (caught) {
    frameStateByShot.value = {
      ...frameStateByShot.value,
      [storyboardId]: {
        status: 'FAILED',
        message: messageFor(caught, '首尾帧自动提取失败，可在分镜中重试'),
      },
    }
  }
}

function replaceCandidate(storyboardId: string, candidate: MediaCandidate) {
  const current = candidatesByShot.value[storyboardId] || []
  candidatesByShot.value = {
    ...candidatesByShot.value,
    [storyboardId]: current.some((item) => item.id === candidate.id)
      ? current.map((item) => (item.id === candidate.id ? candidate : item))
      : [candidate, ...current],
  }
}

async function activateCandidate(shot: Storyboard, candidate: MediaCandidate) {
  if (candidateActionIds.value.includes(candidate.id)) return
  candidateActionIds.value = [...candidateActionIds.value, candidate.id]
  error.value = ''
  try {
    const saved = await persistCandidateToLocal(shot.id, candidate)
    replaceCandidate(shot.id, saved)
    notice.value = `镜头 ${shot.shotNo} 已切换为所选候选视频`
  } catch (caught) {
    error.value = messageFor(caught, '候选视频切换失败')
  } finally {
    candidateActionIds.value = candidateActionIds.value.filter((id) => id !== candidate.id)
  }
}

async function loadPreview(candidate: MediaCandidate) {
  if (previewUrls.value[candidate.id] || previewLoading.value[candidate.id]) return
  clearPreviewError(candidate.id)
  const savedUrl = localSavedPreviewUrl(candidate)
  if (savedUrl) {
    previewUrls.value = { ...previewUrls.value, [candidate.id]: savedUrl }
    return
  }
  if (
    candidate.deliveryType === 'LOCAL_CACHE' &&
    candidate.clientCandidateId &&
    desktop.available
  ) {
    const localUrl = desktop.generatedCandidatePreviewUrl(candidate.clientCandidateId)
    if (localUrl) {
      previewUrls.value = { ...previewUrls.value, [candidate.id]: localUrl }
      return
    }
  }
  if (!candidate.previewAvailable) {
    previewErrors.value = {
      ...previewErrors.value,
      [candidate.id]: candidate.localAssetId
        ? '视频已经生成，但本地文件当前不可用，且服务端临时预览已过期'
        : '视频候选记录仍在，但服务端临时预览已过期，需要重新生成或切换其他候选',
    }
    return
  }
  previewLoading.value = { ...previewLoading.value, [candidate.id]: true }
  try {
    const blob = await mediaGenerationApi.preview(candidate.id)
    previewUrls.value = { ...previewUrls.value, [candidate.id]: URL.createObjectURL(blob) }
  } catch (caught) {
    previewErrors.value = {
      ...previewErrors.value,
      [candidate.id]: `视频已生成，但预览读取失败：${messageFor(caught, '网络或临时缓存不可用')}`,
    }
  } finally {
    const next = { ...previewLoading.value }
    delete next[candidate.id]
    previewLoading.value = next
  }
}

function handleVideoPreviewError(candidate: MediaCandidate) {
  previewErrors.value = {
    ...previewErrors.value,
    [candidate.id]: '视频文件已经生成，但当前文件格式或本地文件读取失败，可重试预览或重新生成',
  }
}

function handleVideoPreviewReady(candidateId: string) {
  clearPreviewError(candidateId)
}

function retryPreview(candidate: MediaCandidate) {
  const current = previewUrls.value[candidate.id]
  if (current) releasePreviewUrl(current)
  const next = { ...previewUrls.value }
  delete next[candidate.id]
  previewUrls.value = next
  clearPreviewError(candidate.id)
  void loadPreview(candidate)
}

function clearPreviewError(candidateId: string) {
  if (!previewErrors.value[candidateId]) return
  const next = { ...previewErrors.value }
  delete next[candidateId]
  previewErrors.value = next
}

function releasePreviewUrl(url: string) {
  if (url.startsWith('blob:')) URL.revokeObjectURL(url)
}

async function toggleHistory(shot: Storyboard) {
  const open = expandedHistoryIds.value.includes(shot.id)
  expandedHistoryIds.value = open
    ? expandedHistoryIds.value.filter((id) => id !== shot.id)
    : [...expandedHistoryIds.value, shot.id]
  if (!open) candidateHistory(shot.id).forEach((candidate) => void loadPreview(candidate))
}

function pauseOtherVideos(event: Event) {
  const current = event.currentTarget as HTMLVideoElement
  document.querySelectorAll<HTMLVideoElement>('.batch-video-player').forEach((video) => {
    if (video !== current && !video.paused) video.pause()
  })
}

function referencesFor(shot: Storyboard): ReferenceView[] {
  return referencesByShot.value[shot.id] || []
}

function removeAutomaticReference(storyboardId: string, assetId: string) {
  const current = excludedAutomaticReferenceIdsByShot.value[storyboardId] || []
  if (current.includes(assetId)) return
  excludedAutomaticReferenceIdsByShot.value = {
    ...excludedAutomaticReferenceIdsByShot.value,
    [storyboardId]: [...current, assetId],
  }
  persistExcludedAutomaticReferences(projectId.value)
  notice.value = '已移除该素材的本次自动关联，项目文件未删除'
}

function excludedReferencesStorageKey(projectIdValue: string) {
  return `${excludedReferencesStoragePrefix}${projectIdValue}`
}

function readExcludedAutomaticReferences(projectIdValue: string) {
  try {
    const raw = globalThis.localStorage?.getItem(excludedReferencesStorageKey(projectIdValue))
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([, value]) =>
          Array.isArray(value) && value.every((item) => typeof item === 'string'),
      ),
    ) as Record<string, string[]>
  } catch {
    return {}
  }
}

function persistExcludedAutomaticReferences(projectIdValue: string) {
  try {
    globalThis.localStorage?.setItem(
      excludedReferencesStorageKey(projectIdValue),
      JSON.stringify(excludedAutomaticReferenceIdsByShot.value),
    )
  } catch {
    // Local storage can be unavailable in restricted browser profiles; the in-memory state remains active.
  }
}

function buildReferences(shot: Storyboard): ReferenceView[] {
  const result: ReferenceView[] = []
  const excluded = new Set(excludedAutomaticReferenceIdsByShot.value[shot.id] || [])
  const keyframe = workspace.outputForStoryboard(shot.id, 'KEYFRAME')
  const endFrame = workspace.outputForStoryboard(shot.id, 'END_FRAME')
  const contactSheet = workspace.outputForStoryboard(shot.id, 'CONTACT_SHEET')
  if (keyframe && !excluded.has(keyframe.mediaAssetId)) {
    result.push({ assetId: keyframe.mediaAssetId, label: '分镜首帧', kind: 'KEYFRAME' })
  }
  storyboardReferenceAssets(
    shot,
    workspace.characters,
    workspace.scenes,
    workspace.characterReferences,
    workspace.sceneReferences,
  ).forEach((reference) => {
    if (!excluded.has(reference.assetId) && !result.some((item) => item.assetId === reference.assetId)) {
      result.push({ ...reference, kind: 'REFERENCE' })
    }
  })
  if (endFrame && !excluded.has(endFrame.mediaAssetId) && !result.some((item) => item.assetId === endFrame.mediaAssetId)) {
    result.push({ assetId: endFrame.mediaAssetId, label: '分镜尾帧', kind: 'END_FRAME' })
  }
  if (contactSheet && !excluded.has(contactSheet.mediaAssetId) && !result.some((item) => item.assetId === contactSheet.mediaAssetId)) {
    result.push({
      assetId: contactSheet.mediaAssetId,
      label: '九宫格节奏参考',
      kind: 'CONTACT_SHEET',
    })
  }
  return result
}

function referencePreviewUrl(assetId: string) {
  if (!desktop.available || !desktop.project) return ''
  const local = desktop.project.assets.find((asset) => asset.id === assetId)
  return local?.fileAvailable ? desktop.assetPreviewUrl(local.id) : ''
}

function sceneLabel(shot: Storyboard) {
  return (
    workspace.scenes.find((scene) => scene.id === shot.sceneId)?.title ||
    shot.location ||
    '未绑定场景'
  )
}

function characterLabel(shot: Storyboard) {
  const names = workspace.characters
    .filter((character) => shot.characterIds.includes(character.id))
    .map((character) => character.name)
  return names.length ? names.join('、') : '无角色'
}

function referenceWarning(shot: Storyboard) {
  const references = referencesFor(shot)
  const supplemental = selectedSupplementalReferencesFor(shot)
  const warnings: string[] = []
  if (!references.some((item) => item.kind === 'KEYFRAME')) warnings.push('缺少首帧')
  if (
    shot.sceneId &&
    !references.some((item) => item.label.startsWith('场景：')) &&
    !supplemental.some((item) => item.bindingType === 'SCENE' || item.bindingType === 'BACKGROUND')
  )
    warnings.push('缺少场景图')
  if (
    shot.characterIds.length &&
    !references.some((item) => item.label.startsWith('角色基础图：')) &&
    !supplemental.some((item) => item.bindingType === 'CHARACTER')
  )
    warnings.push('缺少角色图')
  return warnings.join('、')
}

async function copyPrompt(shot: Storyboard) {
  try {
    await navigator.clipboard.writeText(effectivePrompt(shot))
    notice.value = `镜头 ${shot.shotNo} 的整合提示词已复制`
  } catch {
    error.value = '提示词复制失败，请手动选择文本复制'
  }
}

async function markReview(
  shot: Storyboard,
  reviewStatus: Exclude<StoryboardReviewStatus, 'PENDING'>,
) {
  if (reviewingIds.value.includes(shot.id)) return
  reviewingIds.value = [...reviewingIds.value, shot.id]
  error.value = ''
  try {
    await workspace.reviewStoryboard(
      projectId.value,
      shot.id,
      reviewStatus,
      reviewStatus === 'CHANGES_REQUESTED' ? '批量视频工作台标记为需要重新生成或调整' : undefined,
    )
    notice.value =
      reviewStatus === 'APPROVED'
        ? `镜头 ${shot.shotNo} 已标记为通过`
        : `镜头 ${shot.shotNo} 已标记为需重做`
  } catch (caught) {
    error.value = messageFor(caught, '分镜审核状态保存失败')
  } finally {
    reviewingIds.value = reviewingIds.value.filter((id) => id !== shot.id)
  }
}

function reviewLabel(status: StoryboardReviewStatus) {
  if (status === 'APPROVED') return '已通过'
  if (status === 'CHANGES_REQUESTED') return '需重做'
  return '待检查'
}

function toggleShot(shotId: string) {
  selectedIds.value = selectedIds.value.includes(shotId)
    ? selectedIds.value.filter((id) => id !== shotId)
    : [...selectedIds.value, shotId]
}

function toggleAllVisible() {
  const visibleIds = filteredShots.value.map((shot) => shot.id)
  const allSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selectedIds.value.includes(id))
  selectedIds.value = allSelected
    ? selectedIds.value.filter((id) => !visibleIds.includes(id))
    : Array.from(new Set([...selectedIds.value, ...visibleIds]))
}

function selectUngenerated() {
  selectedIds.value = shots.value.filter((shot) => !displayCandidate(shot)).map((shot) => shot.id)
}

async function downloadCandidate(shot: Storyboard, candidate: MediaCandidate) {
  const blob = await getCandidateBlob(candidate)
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${String(shot.shotNo).padStart(3, '0')}-${safeFilename(shot.title)}${videoExtension(blob.type || candidate.mimeType)}`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function downloadContactSheet(shot: Storyboard) {
  const output = workspace.outputForStoryboard(shot.id, 'CONTACT_SHEET')
  if (!output) return
  const source = referencePreviewUrl(output.mediaAssetId)
  if (!source) {
    error.value = '九宫格本地文件不可用'
    return
  }
  try {
    const response = await fetch(source)
    if (!response.ok) throw new Error(`读取九宫格失败（HTTP ${response.status}）`)
    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${String(shot.shotNo).padStart(3, '0')}-${safeFilename(shot.title)}-九宫格${imageExtension(blob.type)}`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    globalThis.setTimeout(() => URL.revokeObjectURL(url), 1_000)
  } catch (caught) {
    error.value = messageFor(caught, '九宫格下载失败')
  }
}

async function exportVideos() {
  if (downloading.value) return
  const targetShots = selectedCount.value ? selectedShots.value : shots.value
  const completed = targetShots
    .map((shot) => ({ shot, candidate: displayCandidate(shot) }))
    .filter((item): item is { shot: Storyboard; candidate: MediaCandidate } =>
      Boolean(item.candidate),
    )
  if (!completed.length) {
    error.value = '当前选择中没有可导出的视频'
    return
  }
  downloading.value = true
  downloadCount.value = 0
  error.value = ''
  try {
    if (desktop.available) {
      const exportItems = []
      for (const item of completed) {
        const saved = item.candidate.localAssetId
          ? item.candidate
          : await persistCandidateToLocal(item.shot.id, item.candidate)
        if (!saved.localAssetId) throw new Error(`镜头 ${item.shot.shotNo} 尚未保存到本地`)
        exportItems.push({
          assetId: saved.localAssetId,
          fileName: `${episodePrefix()}-${String(item.shot.shotNo).padStart(3, '0')}-${safeFilename(item.shot.title)}${videoExtension(saved.mimeType)}`,
        })
      }
      const result = await desktop.exportVideoAssets(exportItems)
      if (result.canceled) {
        notice.value = '已取消批量导出'
        return
      }
      downloadCount.value = result.files.length
      notice.value = `已导出 ${result.files.length} 个视频到 ${result.directory}`
      return
    }
    for (const item of completed) {
      await downloadCandidate(item.shot, item.candidate)
      downloadCount.value += 1
    }
    notice.value = `已下载 ${downloadCount.value} 个视频`
  } catch (caught) {
    error.value = messageFor(caught, '批量视频导出中断')
  } finally {
    downloading.value = false
  }
}

function episodePrefix() {
  return `第${String(activeEpisode.value?.episodeNo || 1).padStart(2, '0')}集`
}

async function getCandidateBlob(candidate: MediaCandidate) {
  const savedUrl = localSavedPreviewUrl(candidate)
  if (savedUrl) {
    const response = await fetch(savedUrl)
    if (response.ok) return response.blob()
  }
  if (
    candidate.deliveryType === 'LOCAL_CACHE' &&
    candidate.clientCandidateId &&
    desktop.available
  ) {
    const localUrl = desktop.generatedCandidatePreviewUrl(candidate.clientCandidateId)
    if (localUrl) {
      const response = await fetch(localUrl)
      if (response.ok) return response.blob()
    }
  }
  return mediaGenerationApi.preview(candidate.id)
}

function localSavedPreviewUrl(candidate: MediaCandidate) {
  if (!candidate.localAssetId || !desktop.available || !desktop.project) return ''
  const localAsset = desktop.project.assets.find((asset) => asset.id === candidate.localAssetId)
  return localAsset?.fileAvailable ? desktop.assetPreviewUrl(localAsset.id) : ''
}

function safeFilename(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, '-').trim() || 'video'
}

function videoExtension(mimeType?: string | null) {
  if (mimeType?.includes('webm')) return '.webm'
  if (mimeType?.includes('quicktime')) return '.mov'
  return '.mp4'
}

function imageExtension(mimeType?: string | null) {
  if (mimeType?.includes('jpeg')) return '.jpg'
  if (mimeType?.includes('webp')) return '.webp'
  return '.png'
}

function requiredClientCandidateId(candidate: MediaCandidate) {
  if (!candidate.clientCandidateId) throw new Error('本地视频候选文件已失效，请重新生成')
  return candidate.clientCandidateId
}

function requiredImageClientCandidateId(candidate: ImageCandidate) {
  if (!candidate.clientCandidateId) throw new Error('本地九宫格图片候选文件已失效，请重新生成')
  return candidate.clientCandidateId
}

function isRunningStatus(status?: BatchStatus) {
  return Boolean(status && ['CREATING', 'WAITING_LOCAL', 'QUEUED', 'RUNNING'].includes(status))
}

function statusLabel(status?: BatchStatus) {
  return (
    {
      IDLE: '待生成',
      CREATING: '创建中',
      WAITING_LOCAL: '等待本地',
      QUEUED: '排队中',
      RUNNING: '生成中',
      SUCCEEDED: '已完成',
      FAILED: '失败',
      CANCELED: '已取消',
    }[status || 'IDLE'] || '待生成'
  )
}

function stateClass(shotId: string) {
  return (stateByShot.value[shotId]?.status || 'IDLE').toLowerCase().replaceAll('_', '-')
}

function messageFor(caught: unknown, fallback: string) {
  if (!(caught instanceof Error) || !caught.message) return fallback
  return caught.message.replace(/^Error invoking remote method '[^']+': Error:\s*/i, '')
}
</script>

<template>
  <StudioShell :project-id="project?.id" :project-title="project?.title">
    <header class="batch-video-hero">
      <div>
        <p class="batch-eyebrow"><Film :size="15" />项目视频总览</p>
        <h1>批量视频</h1>
        <span>逐镜查看参考素材、最终提示词、生成进度和视频结果，无需来回切换分镜。</span>
      </div>
      <div class="batch-hero-actions">
        <label class="batch-episode-select">
          <span>当前分集</span>
          <select :value="workspace.activeEpisodeId" @change="selectEpisode">
            <option v-for="episode in episodes" :key="episode.id" :value="episode.id">
              第 {{ episode.episodeNo }} 集 · {{ episode.title }}
            </option>
          </select>
          <ChevronDown :size="16" />
        </label>
        <button
          class="button"
          type="button"
          :disabled="loading || refreshing"
          @click="refreshWorkspace"
        >
          <RefreshCw :size="16" :class="{ spin: refreshing }" />刷新
        </button>
      </div>
    </header>

    <main class="batch-video-page">
      <p v-if="error" class="batch-notice error"><CircleAlert :size="16" />{{ error }}</p>
      <p v-if="notice" class="batch-notice success"><CheckCircle2 :size="16" />{{ notice }}</p>

      <section class="batch-command-bar">
        <div class="batch-metrics">
          <span
            ><strong>{{ shots.length }}</strong> 本集分镜</span
          >
          <span
            ><strong>{{ readyCount }}</strong> 已有成片</span
          >
          <span
            ><strong>{{ runningCount }}</strong> 进行中</span
          >
          <span :class="{ danger: failedCount }"
            ><strong>{{ failedCount }}</strong> 失败</span
          >
          <span
            ><strong>{{ approvedCount }}</strong> 已通过</span
          >
        </div>
        <div class="batch-controls-row">
          <div class="batch-selection-actions">
            <button
              class="button compact"
              type="button"
              :disabled="!filteredShots.length"
              @click="toggleAllVisible"
            >
              <Check :size="15" />全选当前
            </button>
            <button
              class="button compact"
              type="button"
              :disabled="!shots.length"
              @click="selectUngenerated"
            >
              <Video :size="15" />只选未生成
            </button>
            <button
              class="button compact"
              type="button"
              :disabled="!failedCount || submitting"
              @click="retryFailed"
            >
              <RotateCcw :size="15" />重试失败
            </button>
          </div>
          <div class="batch-model-pipeline" aria-label="批量视频模型流程">
            <button type="button" @click="openModelSelector('TEXT')">
              <span>文本规划</span><strong :title="textRouteLabel">{{ textRouteLabel }}</strong>
            </button>
            <button type="button" @click="openModelSelector('IMAGE')">
              <span>九宫格图片</span><strong :title="imageRouteLabel">{{ imageRouteLabel }}</strong>
            </button>
            <button type="button" @click="openModelSelector('VIDEO')">
              <span>最终视频</span><strong :title="routeLabel">{{ routeLabel }}</strong>
            </button>
          </div>
          <label class="batch-audio-compact">
            <Volume2 :size="14" />
            <span>声音</span>
            <select v-model="batchAudioMode" aria-label="批量视频声音制作方式">
              <option value="VIDEO_NATIVE">视频原声</option>
              <option value="AI_DUB">后期 AI 配音</option>
            </select>
          </label>
          <div class="batch-main-actions">
            <span class="batch-selected-summary"
              >已选 {{ selectedCount }} 个 · {{ selectedTotalDuration }} 秒</span
            >
            <button
              class="button primary"
              type="button"
              :disabled="!selectedCount || submitting"
              @click="openBatchDialog"
            >
              <Sparkles :size="16" />批量生成
            </button>
            <button
              class="button"
              type="button"
              :disabled="!readyCount || downloading"
              @click="exportVideos"
            >
              <Download :size="16" />{{
                downloading ? `导出 ${downloadCount}` : selectedCount ? '导出选中' : '导出本集'
              }}
            </button>
          </div>
        </div>
        <div class="batch-filter-row">
          <div class="batch-toolbar-title">
            <Clapperboard :size="17" /><strong>分镜视频清单</strong
            ><span>{{ filteredShots.length }}</span>
          </div>
          <div class="batch-toolbar-controls">
            <input
              v-model="query"
              type="search"
              placeholder="搜索镜头、对白或提示词"
              aria-label="搜索分镜"
            />
            <select v-model="filter" aria-label="筛选状态">
              <option value="ALL">全部状态</option>
              <option value="READY">待生成</option>
              <option value="RUNNING">生成中</option>
              <option value="DONE">已有成片</option>
              <option value="FAILED">生成失败</option>
              <option value="CHANGES">需重做</option>
            </select>
          </div>
        </div>
        <p class="batch-audio-guidance">
          <strong>{{ audioModeLabel(batchAudioMode) }}</strong>
          <span v-if="batchAudioMode === 'VIDEO_NATIVE'">
            视频模型同时生成对白与环境声；角色声音参考只能提高相似度，无法保证不同视频的音色完全一致。
          </span>
          <span v-else>
            视频保留环境声和动作音效，人物对白使用固定或复刻音色后期生成，更适合多镜头角色音色统一。
          </span>
        </p>
      </section>

      <section v-if="loading && !shots.length" class="batch-empty">
        <LoaderCircle class="spin" :size="28" /><strong>正在加载本集分镜</strong>
      </section>
      <section v-else-if="!shots.length" class="batch-empty">
        <FolderOpen :size="30" /><strong>本集还没有分镜</strong
        ><span>先在“剧本 · 分镜”中完成分镜拆解，再回来批量生成。</span>
      </section>
      <section v-else class="batch-list-shell">
        <header class="batch-list-header">
          <span>分镜与审核</span><span>参考素材</span><span>整合后提示词</span
          ><span>九宫格节奏参考</span><span>视频结果</span>
        </header>
        <div class="batch-shot-list">
          <article
            v-for="shot in filteredShots"
            :key="shot.id"
            class="batch-shot-row"
            :class="{ selected: selectedIds.includes(shot.id) }"
          >
            <section class="shot-overview">
              <div class="shot-overview-top">
                <button
                  class="shot-selector"
                  type="button"
                  :title="selectedIds.includes(shot.id) ? '取消选择' : '选择分镜'"
                  @click="toggleShot(shot.id)"
                >
                  <Check v-if="selectedIds.includes(shot.id)" :size="14" />
                </button>
                <span class="shot-number">{{ String(shot.shotNo).padStart(2, '0') }}</span>
                <span class="batch-status" :class="stateClass(shot.id)">
                  <LoaderCircle
                    v-if="isRunningStatus(stateByShot[shot.id]?.status)"
                    :size="12"
                    class="spin"
                  />
                  <CheckCircle2 v-else-if="displayCandidate(shot)" :size="12" />
                  {{
                    statusLabel(
                      stateByShot[shot.id]?.status ||
                        (displayCandidate(shot) ? 'SUCCEEDED' : 'IDLE'),
                    )
                  }}
                </span>
              </div>
              <h2>{{ shot.title }}</h2>
              <div class="shot-meta">
                <span>{{ shot.shotType || '未设景别' }}</span
                ><span>{{ durationFor(shot) }} 秒</span
                ><span>{{ shot.movement || '固定镜头' }}</span
                ><span>{{ audioModeLabel(shot.audioMode) }}</span>
              </div>
              <dl class="shot-relations">
                <div>
                  <dt>场景</dt>
                  <dd>{{ sceneLabel(shot) }}</dd>
                </div>
                <div>
                  <dt>角色</dt>
                  <dd>{{ characterLabel(shot) }}</dd>
                </div>
              </dl>
              <div class="review-state" :class="shot.reviewStatus.toLowerCase()">
                {{ reviewLabel(shot.reviewStatus) }}
              </div>
              <div class="review-actions">
                <button
                  type="button"
                  :disabled="reviewingIds.includes(shot.id) || !displayCandidate(shot)"
                  @click="markReview(shot, 'APPROVED')"
                >
                  <CheckCircle2 :size="14" />通过
                </button>
                <button
                  type="button"
                  :disabled="reviewingIds.includes(shot.id)"
                  @click="markReview(shot, 'CHANGES_REQUESTED')"
                >
                  <XCircle :size="14" />需重做
                </button>
              </div>
            </section>

            <section class="shot-references">
              <header>
                <div>
                  <Images :size="15" /><span
                    >{{ referencesFor(shot).length }} 项自动<span
                      v-if="selectedSupplementalReferencesFor(shot).length"
                    >
                      · {{ selectedSupplementalReferencesFor(shot).length }} 项补充</span
                    ></span
                  >
                </div>
                <button
                  v-if="workspace.outputForStoryboard(shot.id, 'CONTACT_SHEET')"
                  type="button"
                  title="下载九宫格"
                  @click="downloadContactSheet(shot)"
                >
                  <Download :size="13" />下载
                </button>
                <button
                  type="button"
                  title="从项目素材添加或上传新素材"
                  @click="openReferenceEditor(shot)"
                >
                  管理素材
                </button>
              </header>
              <p v-if="referencesFor(shot).some((item) => item.kind === 'CONTACT_SHEET')" class="reference-warning">
                <CircleAlert :size="13" />当前已自动关联九宫格图片，部分视频模型可能因多画面或版权审核拒绝生成；可在“管理素材”中移除本次关联。
              </p>
              <div v-if="referencesFor(shot).length" class="reference-grid">
                <figure
                  v-for="reference in referencesFor(shot)"
                  :key="`${reference.kind}-${reference.assetId}`"
                >
                  <img
                    v-if="referencePreviewUrl(reference.assetId)"
                    :src="referencePreviewUrl(reference.assetId)"
                    :alt="reference.label"
                    loading="lazy"
                  />
                  <span v-else class="reference-placeholder"><Images :size="20" /></span>
                  <figcaption :title="reference.label">{{ reference.label }}</figcaption>
                </figure>
                <figure
                  v-for="reference in selectedSupplementalReferencesFor(shot)"
                  :key="reference.id"
                  class="supplemental-reference"
                >
                  <img
                    v-if="reference.mediaType === 'IMAGE'"
                    :src="reference.previewUrl"
                    :alt="reference.label"
                    loading="lazy"
                  />
                  <video
                    v-else-if="reference.mediaType === 'VIDEO'"
                    :src="reference.previewUrl"
                    muted
                    preload="metadata"
                  />
                  <span v-else class="reference-placeholder"><AudioLines :size="20" /></span>
                  <figcaption :title="reference.label">补充：{{ reference.label }}</figcaption>
                </figure>
              </div>
              <div
                v-else-if="selectedSupplementalReferencesFor(shot).length"
                class="reference-grid"
              >
                <figure
                  v-for="reference in selectedSupplementalReferencesFor(shot)"
                  :key="reference.id"
                  class="supplemental-reference"
                >
                  <img
                    v-if="reference.mediaType === 'IMAGE'"
                    :src="reference.previewUrl"
                    :alt="reference.label"
                    loading="lazy"
                  />
                  <video
                    v-else-if="reference.mediaType === 'VIDEO'"
                    :src="reference.previewUrl"
                    muted
                    preload="metadata"
                  />
                  <span v-else class="reference-placeholder"><AudioLines :size="20" /></span>
                  <figcaption :title="reference.label">补充：{{ reference.label }}</figcaption>
                </figure>
              </div>
              <div v-else class="reference-empty">
                <Images :size="24" /><span>暂无关联素材</span
                ><button type="button" @click="openReferenceEditor(shot)">添加参考素材</button>
              </div>
              <p v-if="referenceWarning(shot)" class="reference-warning">
                <CircleAlert :size="13" />{{ referenceWarning(shot) }}
              </p>
            </section>

            <section class="shot-prompt">
              <header>
                <div><Sparkles :size="15" /><strong>最终视频提示词</strong></div>
                <div class="prompt-actions">
                  <button
                    v-if="!promptEditingIds.includes(shot.id)"
                    class="icon-button compact"
                    type="button"
                    title="编辑最终视频提示词"
                    @click="editPrompt(shot)"
                  >
                    <Pencil :size="14" />
                  </button>
                  <button
                    class="icon-button compact"
                    type="button"
                    title="复制最终视频提示词"
                    @click="copyPrompt(shot)"
                  >
                    <Clipboard :size="15" />
                  </button>
                </div>
              </header>
              <textarea
                v-if="promptEditingIds.includes(shot.id)"
                v-model="promptDrafts[shot.id]"
                class="prompt-editor"
                maxlength="20000"
                aria-label="编辑最终视频提示词"
                @beforeinput.stop
                @input.stop
                @keydown.stop
                @keyup.stop
              />
              <pre v-else>{{ effectivePrompt(shot) }}</pre>
              <footer>
                <span>{{
                  shot.finalVideoPrompt
                    ? '使用已保存的人工覆盖稿'
                    : promptPreviews[shot.id]
                      ? '使用服务端自动整合稿'
                      : '正在使用分镜原始信息'
                }}</span>
                <div v-if="promptEditingIds.includes(shot.id)" class="prompt-edit-actions">
                  <button
                    type="button"
                    :disabled="promptSavingIds.includes(shot.id)"
                    @click="cancelPromptEdit(shot)"
                  >
                    取消
                  </button>
                  <button
                    class="save"
                    type="button"
                    :disabled="promptSavingIds.includes(shot.id)"
                    @click="savePromptFromRow(shot)"
                  >
                    <Save :size="12" />{{ promptSavingIds.includes(shot.id) ? '保存中' : '保存' }}
                  </button>
                </div>
                <button
                  v-else-if="shot.finalVideoPrompt"
                  class="prompt-reset"
                  type="button"
                  :disabled="promptSavingIds.includes(shot.id)"
                  @click="restoreAutomaticPrompt(shot)"
                >
                  恢复自动整合
                </button>
                <span v-else>{{ effectivePrompt(shot).length }} 字</span>
              </footer>
            </section>

            <section class="shot-contact-sheet">
              <header>
                <div>
                  <LayoutGrid :size="15" /><strong>3×3 九宫格</strong>
                  <span v-if="contactSheetRecommended(shot)" class="recommended">长镜头建议</span>
                </div>
                <button
                  type="button"
                  :disabled="contactSheetGeneratingIds.includes(shot.id)"
                  @click="generateContactSheet(shot)"
                >
                  <LoaderCircle
                    v-if="contactSheetGeneratingIds.includes(shot.id)"
                    class="spin"
                    :size="13"
                  />
                  <Sparkles v-else :size="13" />
                  {{
                    contactSheetGeneratingIds.includes(shot.id)
                      ? '生成中'
                      : workspace.outputForStoryboard(shot.id, 'CONTACT_SHEET')
                        ? '重新生成'
                        : '生成九宫格'
                  }}
                </button>
                <button
                  v-if="workspace.outputForStoryboard(shot.id, 'CONTACT_SHEET')"
                  class="icon-button compact contact-sheet-delete"
                  type="button"
                  title="删除九宫格图片"
                  aria-label="删除九宫格图片"
                  :disabled="contactSheetGeneratingIds.includes(shot.id)"
                  @click="removeContactSheet(shot)"
                >
                  <Trash2 :size="14" />
                </button>
              </header>
              <div
                v-if="workspace.outputForStoryboard(shot.id, 'CONTACT_SHEET')"
                class="contact-sheet-preview"
              >
                <img
                  v-if="
                    referencePreviewUrl(
                      workspace.outputForStoryboard(shot.id, 'CONTACT_SHEET')!.mediaAssetId,
                    )
                  "
                  :src="
                    referencePreviewUrl(
                      workspace.outputForStoryboard(shot.id, 'CONTACT_SHEET')!.mediaAssetId,
                    )
                  "
                  alt="九宫格节奏参考图"
                  loading="lazy"
                />
                <span v-else><Images :size="27" />九宫格本地文件不可用</span>
              </div>
              <div v-else class="contact-sheet-empty">
                <LayoutGrid :size="29" />
                <strong>{{
                  contactSheetRecommended(shot) ? '建议先生成九宫格' : '可选九宫格参考'
                }}</strong>
                <span>将镜头拆为 9 个连续时间节点，适合 10 秒以上或包含转场的长视频；不生成也可以直接生成视频。</span>
              </div>
              <details v-if="contactSheetPlans[shot.id]" class="contact-sheet-plan">
                <summary>查看九格规划文本</summary>
                <pre>{{ contactSheetPlans[shot.id] }}</pre>
              </details>
            </section>

            <section class="shot-result">
              <template v-if="displayCandidate(shot)">
                <div
                  v-if="
                    previewUrls[displayCandidate(shot)!.id] &&
                    !previewErrors[displayCandidate(shot)!.id]
                  "
                  class="shot-video-wrap"
                >
                  <video
                    class="batch-video-player"
                    :src="previewUrls[displayCandidate(shot)!.id]"
                    controls
                    playsinline
                    preload="metadata"
                    @play="pauseOtherVideos"
                    @loadedmetadata="handleVideoPreviewReady(displayCandidate(shot)!.id)"
                    @error="handleVideoPreviewError(displayCandidate(shot)!)"
                  />
                </div>
                <div v-else class="shot-video-empty">
                  <LoaderCircle
                    v-if="previewLoading[displayCandidate(shot)!.id]"
                    class="spin"
                    :size="24"
                  />
                  <CircleAlert v-else-if="previewErrors[displayCandidate(shot)!.id]" :size="27" />
                  <Video v-else :size="28" />
                  <span>{{ previewErrors[displayCandidate(shot)!.id] || '正在读取视频' }}</span>
                  <button
                    v-if="
                      previewErrors[displayCandidate(shot)!.id] &&
                      displayCandidate(shot)!.previewAvailable
                    "
                    class="preview-retry"
                    type="button"
                    @click="retryPreview(displayCandidate(shot)!)"
                  >
                    <RefreshCw :size="13" />重试预览
                  </button>
                </div>
                <div class="result-meta">
                  <span>{{ displayCandidate(shot)!.modelName || '视频模型' }}</span>
                  <span>{{
                    displayCandidate(shot)!.localAssetId ? '已保存本地' : '等待本地保存'
                  }}</span>
                </div>
                <p
                  v-if="frameStateByShot[shot.id]"
                  class="frame-extraction-state"
                  :class="frameStateByShot[shot.id].status.toLowerCase()"
                >
                  <LoaderCircle
                    v-if="frameStateByShot[shot.id].status === 'EXTRACTING'"
                    class="spin"
                    :size="12"
                  />
                  <CheckCircle2
                    v-else-if="frameStateByShot[shot.id].status === 'DONE'"
                    :size="12"
                  />
                  <CircleAlert v-else :size="12" />
                  {{ frameStateByShot[shot.id].message }}
                </p>
                <div class="result-actions">
                  <button
                    type="button"
                    title="下载当前视频"
                    @click="downloadCandidate(shot, displayCandidate(shot)!)"
                  >
                    <Download :size="14" />下载
                  </button>
                  <button
                    type="button"
                    :disabled="candidateHistory(shot.id).length < 2"
                    @click="toggleHistory(shot)"
                  >
                    <History :size="14" />候选 {{ candidateHistory(shot.id).length }}
                  </button>
                  <button type="button" @click="regenerateShot(shot)">
                    <RotateCcw :size="14" />重新生成
                  </button>
                </div>
              </template>
              <div
                v-else
                class="shot-video-empty"
                :class="{ failed: stateByShot[shot.id]?.status === 'FAILED' }"
              >
                <LoaderCircle
                  v-if="isRunningStatus(stateByShot[shot.id]?.status)"
                  class="spin"
                  :size="25"
                />
                <CircleAlert v-else-if="stateByShot[shot.id]?.status === 'FAILED'" :size="27" />
                <Video v-else :size="28" />
                <strong>{{
                  stateByShot[shot.id]?.status === 'FAILED'
                    ? '生成失败'
                    : isRunningStatus(stateByShot[shot.id]?.status)
                      ? '视频生成中'
                      : '等待生成视频'
                }}</strong>
                <span v-if="stateByShot[shot.id]?.errorMessage">{{
                  stateByShot[shot.id]?.errorMessage
                }}</span>
              </div>
              <div v-if="isRunningStatus(stateByShot[shot.id]?.status)" class="task-progress">
                <span :style="{ width: `${Math.max(5, stateByShot[shot.id]?.progress || 0)}%` }" />
              </div>
            </section>

            <section v-if="expandedHistoryIds.includes(shot.id)" class="candidate-history">
              <header>
                <History :size="16" /><strong>镜头 {{ shot.shotNo }} 候选历史</strong
                ><span>点击“设为当前”即可切换成片</span>
              </header>
              <div class="candidate-strip">
                <article
                  v-for="candidate in candidateHistory(shot.id)"
                  :key="candidate.id"
                  :class="{
                    current:
                      workspace.outputForStoryboard(shot.id, 'VIDEO')?.sourceId === candidate.id,
                  }"
                >
                  <video
                    v-if="previewUrls[candidate.id] && !previewErrors[candidate.id]"
                    class="batch-video-player"
                    :src="previewUrls[candidate.id]"
                    controls
                    playsinline
                    preload="metadata"
                    @play="pauseOtherVideos"
                    @loadedmetadata="handleVideoPreviewReady(candidate.id)"
                    @error="handleVideoPreviewError(candidate)"
                  />
                  <div v-else class="candidate-preview-empty" :title="previewErrors[candidate.id]">
                    <LoaderCircle
                      v-if="previewLoading[candidate.id]"
                      class="spin"
                      :size="20"
                    /><CircleAlert v-else-if="previewErrors[candidate.id]" :size="22" /><Video
                      v-else
                      :size="22"
                    />
                  </div>
                  <div>
                    <strong>{{ candidate.modelName || '视频候选' }}</strong
                    ><span>{{ new Date(candidate.createdAt).toLocaleString() }}</span>
                  </div>
                  <button
                    type="button"
                    :disabled="
                      candidateActionIds.includes(candidate.id) ||
                      workspace.outputForStoryboard(shot.id, 'VIDEO')?.sourceId === candidate.id
                    "
                    @click="activateCandidate(shot, candidate)"
                  >
                    {{
                      workspace.outputForStoryboard(shot.id, 'VIDEO')?.sourceId === candidate.id
                        ? '当前成片'
                        : candidateActionIds.includes(candidate.id)
                          ? '切换中'
                          : '设为当前'
                    }}
                  </button>
                </article>
              </div>
            </section>
          </article>
        </div>
      </section>
    </main>

    <BatchVideoReferenceEditor
      v-if="referenceEditorShot"
      :open="Boolean(referenceEditorShotId)"
      :project-id="projectId"
      :shot="referenceEditorShot"
      :automatic-references="referencesFor(referenceEditorShot)"
      :model-value="supplementalReferencesFor(referenceEditorShot)"
      @close="referenceEditorShotId = ''"
      @update:model-value="updateSupplementalReferences(referenceEditorShot.id, $event)"
      @remove-automatic="removeAutomaticReference(referenceEditorShot.id, $event)"
    />

    <GenerationRouteDialog
      :open="routeOpen"
      :submitting="submitting"
      service-type="VIDEO"
      eyebrow="批量视频生成"
      :title="
        routeDialogMode === 'CONFIGURE' ? '选择批量视频模型' : `提交 ${selectedCount} 个分镜视频`
      "
      :submit-label="routeDialogMode === 'CONFIGURE' ? '使用此模型' : '确认生成'"
      :quote-prompt="selectedShots.map((shot) => sourcePrompt(shot)).join('\n\n')"
      :quote-items="
        selectedShots.map((shot) => ({
          prompt: effectivePrompt(shot),
          parameters: promptPreviews[shot.id]?.parameters,
        }))
      "
      :quote-parameters="{
        duration: Math.max(1, selectedTotalDuration),
        seconds: Math.max(1, selectedTotalDuration),
      }"
      :initial-route="routeSelection"
      @close="routeOpen = false"
      @submit="handleVideoRouteSubmit"
    >
      <div v-if="routeDialogMode === 'GENERATE'" class="batch-dialog-summary">
        <strong>已选 {{ selectedCount }} 个分镜 · {{ audioModeLabel(batchAudioMode) }}</strong
        ><span>预计总时长 {{ selectedTotalDuration }} 秒 · 失败任务不会扣点</span>
      </div>
    </GenerationRouteDialog>

    <GenerationRouteDialog
      :open="textRouteOpen"
      service-type="TEXT"
      eyebrow="九宫格节奏规划"
      title="选择文本规划模型"
      submit-label="使用此模型"
      :initial-route="textRouteSelection"
      @close="textRouteOpen = false"
      @submit="selectTextRoute"
    />

    <GenerationRouteDialog
      :open="imageRouteOpen"
      service-type="IMAGE"
      eyebrow="九宫格参考图"
      title="选择九宫格图片模型"
      submit-label="使用此模型"
      :initial-route="imageRouteSelection"
      @close="imageRouteOpen = false"
      @submit="selectImageRoute"
    />
  </StudioShell>
</template>

<style scoped>
.batch-video-hero {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 24px;
  padding: 23px 32px 20px;
  border-bottom: 1px solid #dfe6ee;
  background: #f8fafc;
}
.batch-eyebrow {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0 0 6px;
  color: #2865b8;
  font-size: 12px;
  font-weight: 800;
}
.batch-video-hero h1 {
  margin: 0;
  color: #1e3043;
  font-size: 27px;
  letter-spacing: 0;
}
.batch-video-hero > div > span {
  display: block;
  margin-top: 7px;
  color: #68788a;
  font-size: 13px;
}
.batch-hero-actions {
  display: flex;
  align-items: flex-end;
  gap: 9px;
}
.batch-episode-select {
  position: relative;
  display: grid;
  gap: 4px;
  min-width: 260px;
  color: #66768a;
  font-size: 11px;
  font-weight: 800;
}
.batch-episode-select select {
  height: 39px;
  appearance: none;
  padding: 0 34px 0 12px;
  border: 1px solid #d7e0e9;
  border-radius: 7px;
  background: #fff;
  color: #26394e;
  font-size: 13px;
}
.batch-episode-select svg {
  position: absolute;
  right: 10px;
  bottom: 11px;
  pointer-events: none;
}
.batch-video-page {
  max-width: 1800px;
  margin: 0 auto;
  padding: 18px 24px 42px;
}
.batch-notice {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 12px;
  padding: 10px 13px;
  border-radius: 7px;
  font-size: 12px;
}
.batch-notice.error {
  border: 1px solid #efc7c2;
  background: #fff3f1;
  color: #ae4037;
}
.batch-notice.success {
  border: 1px solid #c8e5d3;
  background: #eff9f3;
  color: #28754d;
}
.batch-command-bar {
  position: sticky;
  top: 0;
  z-index: 5;
  margin-bottom: 12px;
  border: 1px solid #dce4ec;
  border-radius: 8px;
  background: #fff;
  box-shadow: 0 5px 18px #29445f0c;
}
.batch-metrics {
  display: flex;
  align-items: center;
  gap: 24px;
  min-height: 40px;
  padding: 0 15px;
  border-bottom: 1px solid #edf1f5;
  color: #7a8898;
  font-size: 11px;
}
.batch-metrics strong {
  margin-right: 4px;
  color: #253a50;
  font-size: 16px;
}
.batch-metrics .danger strong {
  color: #bd493f;
}
.batch-controls-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 13px;
}
.batch-selection-actions,
.batch-main-actions {
  display: flex;
  align-items: center;
  gap: 7px;
}
.batch-main-actions {
  margin-left: auto;
}
.batch-model-pipeline {
  display: grid;
  grid-template-columns: repeat(3, minmax(112px, 1fr));
  min-width: 370px;
  overflow: hidden;
  border: 1px solid #d8e2ec;
  border-radius: 7px;
  background: #f7f9fc;
}
.batch-model-pipeline button {
  display: grid;
  gap: 2px;
  min-width: 0;
  min-height: 42px;
  padding: 5px 9px;
  border: 0;
  border-right: 1px solid #dfe6ee;
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.batch-model-pipeline button:last-child {
  border-right: 0;
}
.batch-model-pipeline button:hover {
  background: #edf5ff;
}
.batch-model-pipeline span,
.batch-selected-summary {
  color: #8995a3;
  font-size: 9px;
}
.batch-model-pipeline strong {
  overflow: hidden;
  color: #36526f;
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.batch-audio-compact {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  height: 42px;
  padding: 0 8px;
  border: 1px solid #dbe3eb;
  border-radius: 6px;
  background: #f8fafc;
  color: #557089;
  font-size: 10px;
  font-weight: 800;
  white-space: nowrap;
}
.batch-audio-compact select {
  width: 112px;
  height: 30px;
  min-width: 112px;
  border: 0;
  outline: 0;
  background: transparent;
  color: #304b65;
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
}
.batch-audio-guidance {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0;
  padding: 7px 13px;
  border-top: 1px solid #edf1f5;
  background: #f7fafc;
  color: #687b8e;
  font-size: 10px;
  line-height: 1.5;
}
.batch-audio-guidance strong {
  flex: 0 0 auto;
  color: #365f8d;
}
.batch-filter-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 10px 13px;
  border-top: 1px solid #edf1f5;
  background: #fafbfd;
}
.batch-toolbar-title {
  display: flex;
  align-items: center;
  gap: 7px;
  color: #304459;
  font-size: 13px;
}
.batch-toolbar-title span {
  min-width: 22px;
  padding: 2px 6px;
  border-radius: 9px;
  background: #eaf2fd;
  color: #2f6ec3;
  text-align: center;
  font-size: 10px;
}
.batch-toolbar-controls {
  display: flex;
  gap: 7px;
}
.batch-toolbar-controls input,
.batch-toolbar-controls select {
  height: 33px;
  border: 1px solid #d8e1ea;
  border-radius: 6px;
  background: #fff;
  padding: 0 10px;
  color: #3a4e64;
  font-size: 12px;
}
.batch-toolbar-controls input {
  width: 230px;
}
.batch-list-shell {
  border: 1px solid #dbe3eb;
  border-radius: 8px;
  overflow: hidden;
  background: #edf2f6;
}
.batch-list-header {
  display: grid;
  grid-template-columns: 150px 180px minmax(280px, 1fr) minmax(230px, 280px) minmax(250px, 300px);
  gap: 12px;
  padding: 9px 13px;
  border-bottom: 1px solid #dbe3eb;
  background: #f5f7fa;
  color: #718094;
  font-size: 11px;
  font-weight: 800;
}
.batch-shot-list {
  display: grid;
  gap: 1px;
}
.batch-shot-row {
  display: grid;
  grid-template-columns: 150px 180px minmax(280px, 1fr) minmax(230px, 280px) minmax(250px, 300px);
  gap: 12px;
  min-width: 0;
  padding: 13px;
  background: #fff;
  transition: background 0.15s ease;
}
.batch-shot-row.selected {
  background: #f5f9ff;
}
.batch-shot-row + .batch-shot-row {
  border-top: 1px solid #e0e6ed;
}
.shot-overview,
.shot-references,
.shot-prompt,
.shot-result {
  min-width: 0;
}
.shot-overview {
  position: relative;
  padding-right: 5px;
}
.shot-overview-top {
  display: flex;
  align-items: center;
  gap: 7px;
}
.shot-selector {
  display: grid;
  place-items: center;
  width: 19px;
  height: 19px;
  padding: 0;
  border: 1px solid #c5d0dc;
  border-radius: 4px;
  background: #fff;
  color: #fff;
  cursor: pointer;
}
.selected .shot-selector {
  border-color: #2772d8;
  background: #2772d8;
}
.shot-number {
  display: grid;
  place-items: center;
  width: 29px;
  height: 27px;
  border-radius: 6px;
  background: #edf2f7;
  color: #53677c;
  font-size: 11px;
  font-weight: 900;
}
.shot-overview h2 {
  overflow: hidden;
  margin: 10px 0 7px;
  color: #273b50;
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.shot-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.shot-meta span {
  padding: 3px 6px;
  border-radius: 4px;
  background: #f0f3f6;
  color: #718092;
  font-size: 10px;
}
.shot-relations {
  display: grid;
  gap: 5px;
  margin: 10px 0;
}
.shot-relations div {
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr);
  gap: 5px;
}
.shot-relations dt {
  color: #93a0ae;
  font-size: 10px;
}
.shot-relations dd {
  overflow: hidden;
  margin: 0;
  color: #596b7e;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.review-state {
  display: inline-flex;
  padding: 3px 7px;
  border-radius: 4px;
  background: #f1f3f5;
  color: #718092;
  font-size: 10px;
  font-weight: 800;
}
.review-state.approved {
  background: #eaf7ef;
  color: #2c7d51;
}
.review-state.changes_requested {
  background: #fff1ee;
  color: #b34a40;
}
.review-actions {
  display: flex;
  gap: 5px;
  margin-top: 8px;
}
.review-actions button,
.result-actions button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-height: 28px;
  padding: 0 7px;
  border: 1px solid #dbe3eb;
  border-radius: 5px;
  background: #fff;
  color: #5d7085;
  font-size: 10px;
  cursor: pointer;
}
.review-actions button:hover,
.result-actions button:hover {
  border-color: #88acd8;
  color: #2767b6;
}
.review-actions button:disabled,
.result-actions button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.shot-references {
  padding: 9px;
  border: 1px solid #e2e7ed;
  border-radius: 7px;
  background: #fafbfd;
}
.shot-references > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  margin-bottom: 8px;
  color: #65778b;
  font-size: 11px;
  font-weight: 800;
}
.shot-references > header > div {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.shot-references > header button,
.reference-empty button {
  padding: 4px 7px;
  border: 1px solid #c9d9ea;
  border-radius: 5px;
  background: #fff;
  color: #3470b5;
  font-size: 9px;
  font-weight: 800;
  cursor: pointer;
}
.shot-references > header button:hover,
.reference-empty button:hover {
  border-color: #7ea8d5;
  background: #f3f8fe;
}
.reference-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 7px;
}
.reference-grid figure {
  position: relative;
  min-width: 0;
  margin: 0;
}
.reference-grid img,
.reference-grid video,
.reference-placeholder {
  display: grid;
  place-items: center;
  width: 100%;
  aspect-ratio: 4 / 3;
  border: 1px solid #dde4eb;
  border-radius: 5px;
  background: #edf2f6;
  color: #98a6b4;
  object-fit: cover;
}
.reference-grid figure.supplemental-reference::after {
  position: absolute;
  top: 4px;
  right: 4px;
  padding: 2px 4px;
  border-radius: 4px;
  background: rgba(39, 103, 180, 0.88);
  color: #fff;
  content: '补充';
  font-size: 7px;
  font-weight: 800;
}
.reference-grid figcaption {
  overflow: hidden;
  margin-top: 3px;
  color: #6f7e8e;
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.reference-empty {
  display: grid;
  place-items: center;
  gap: 6px;
  min-height: 112px;
  color: #98a6b4;
  font-size: 10px;
}
.reference-warning {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  margin: 8px 0 0;
  color: #b85c42;
  font-size: 9px;
  line-height: 1.45;
}
.shot-prompt {
  display: flex;
  flex-direction: column;
  min-height: 210px;
  border: 1px solid #dde5ed;
  border-radius: 7px;
  overflow: hidden;
  background: #f8fafc;
}
.shot-prompt > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 36px;
  padding: 0 10px;
  border-bottom: 1px solid #e4e9ee;
  background: #fff;
}
.shot-prompt > header > div {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #385777;
  font-size: 11px;
}
.prompt-actions {
  margin-left: auto;
}
.shot-prompt pre,
.prompt-editor {
  flex: 1;
  width: 100%;
  min-height: 170px;
  max-height: 188px;
  overflow: auto;
  margin: 0;
  padding: 10px 11px;
  border: 0;
  outline: 0;
  background: transparent;
  color: #35495e;
  font-family: inherit;
  font-size: 11px;
  line-height: 1.7;
  white-space: pre-wrap;
  resize: none;
}
.prompt-editor {
  background: #fffdf7;
  box-shadow: inset 0 0 0 1px #e8d59d;
}
.shot-prompt footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 31px;
  padding: 6px 10px;
  border-top: 1px solid #e5eaf0;
  color: #929eaa;
  font-size: 9px;
}
.prompt-edit-actions {
  display: flex;
  gap: 5px;
  margin-left: auto;
}
.prompt-edit-actions button,
.prompt-reset {
  display: flex;
  align-items: center;
  gap: 3px;
  min-height: 23px;
  padding: 0 7px;
  border: 1px solid #d8e1ea;
  border-radius: 4px;
  background: #fff;
  color: #60748a;
  font-size: 9px;
  cursor: pointer;
}
.prompt-edit-actions .save {
  border-color: #77a7dd;
  background: #edf5ff;
  color: #2467b7;
}
.prompt-reset {
  margin-left: auto;
  border: 0;
  color: #3774bc;
}
.shot-result {
  display: flex;
  flex-direction: column;
}
.shot-contact-sheet {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 7px;
}
.shot-contact-sheet > header {
  display: flex;
  min-height: 30px;
  align-items: center;
  justify-content: space-between;
  gap: 7px;
}
.shot-contact-sheet > header > div {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 5px;
  color: #405b76;
  font-size: 10px;
}
.shot-contact-sheet .recommended {
  padding: 2px 5px;
  border-radius: 4px;
  background: #fff1d9;
  color: #9a641c;
  font-size: 8px;
  font-weight: 800;
  white-space: nowrap;
}
.shot-contact-sheet > header button {
  display: inline-flex;
  min-height: 27px;
  flex: 0 0 auto;
  align-items: center;
  gap: 4px;
  padding: 0 7px;
  border: 1px solid #b9d0ea;
  border-radius: 5px;
  background: #f2f7fd;
  color: #2868b2;
  font-size: 9px;
  font-weight: 800;
  cursor: pointer;
}
.shot-contact-sheet > header button:disabled {
  cursor: wait;
  opacity: 0.65;
}
.shot-contact-sheet > header .contact-sheet-delete {
  width: 27px;
  min-height: 27px;
  padding: 0;
  border-color: #e7c4c0;
  background: #fff8f7;
  color: #b42318;
}
.contact-sheet-preview,
.contact-sheet-empty {
  display: grid;
  width: 100%;
  overflow: hidden;
  place-items: center;
  aspect-ratio: 1;
  border: 1px solid #dce4ec;
  border-radius: 7px;
  background: #eef2f6;
}
.contact-sheet-preview img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.contact-sheet-preview span,
.contact-sheet-empty {
  gap: 6px;
  padding: 16px;
  color: #8392a2;
  text-align: center;
  font-size: 9px;
  line-height: 1.5;
}
.contact-sheet-preview span {
  display: grid;
  place-items: center;
}
.contact-sheet-empty strong {
  color: #52687e;
  font-size: 11px;
}
.contact-sheet-plan {
  border: 1px solid #e0e6ed;
  border-radius: 5px;
  background: #fafbfd;
}
.contact-sheet-plan summary {
  padding: 6px 8px;
  color: #4f6f91;
  font-size: 9px;
  cursor: pointer;
}
.contact-sheet-plan pre {
  max-height: 150px;
  overflow: auto;
  margin: 0;
  padding: 8px;
  border-top: 1px solid #e5eaf0;
  color: #526579;
  font-family: inherit;
  font-size: 9px;
  line-height: 1.55;
  white-space: pre-wrap;
}
.shot-video-wrap {
  width: 100%;
  overflow: hidden;
  border-radius: 7px;
  background: #111923;
  aspect-ratio: 16 / 9;
}
.shot-video-wrap video {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.shot-video-empty {
  display: grid;
  place-items: center;
  gap: 6px;
  width: 100%;
  min-height: 150px;
  padding: 10px;
  border: 1px dashed #d4dde6;
  border-radius: 7px;
  background: #f4f7fa;
  color: #8795a4;
  text-align: center;
}
.shot-video-empty.failed {
  border-color: #efc8c3;
  background: #fff4f2;
  color: #b64b42;
}
.shot-video-empty strong {
  color: inherit;
  font-size: 12px;
}
.shot-video-empty span {
  max-width: 250px;
  font-size: 9px;
  line-height: 1.45;
}
.preview-retry {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 25px;
  padding: 0 8px;
  border: 1px solid #ccdae8;
  border-radius: 5px;
  background: #fff;
  color: #356fae;
  font-size: 9px;
  cursor: pointer;
}
.result-meta {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-top: 6px;
  color: #7d8b99;
  font-size: 9px;
}
.frame-extraction-state {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  margin: 5px 0 0;
  color: #5c7289;
  font-size: 9px;
  line-height: 1.4;
}
.frame-extraction-state.done {
  color: #2f8056;
}
.frame-extraction-state.partial,
.frame-extraction-state.failed {
  color: #b35a3f;
}
.result-actions {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 5px;
  margin-top: 7px;
}
.task-progress {
  height: 4px;
  margin-top: 7px;
  overflow: hidden;
  border-radius: 3px;
  background: #e5ebf1;
}
.task-progress span {
  display: block;
  height: 100%;
  background: #347bd3;
  transition: width 0.3s ease;
}
.candidate-history {
  grid-column: 1 / -1;
  padding: 12px;
  border-top: 1px solid #dbe3eb;
  border-radius: 6px;
  background: #f5f8fb;
}
.candidate-history > header {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 9px;
  color: #40566d;
  font-size: 11px;
}
.candidate-history > header span {
  color: #8a97a5;
  font-size: 10px;
}
.candidate-strip {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 8px;
}
.candidate-strip > article {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  gap: 8px;
  align-items: center;
  padding: 7px;
  border: 1px solid #dce4ec;
  border-radius: 6px;
  background: #fff;
}
.candidate-strip > article.current {
  border-color: #6fa0da;
  background: #f2f7fe;
}
.candidate-strip video,
.candidate-preview-empty {
  width: 96px;
  height: 64px;
  border-radius: 5px;
  background: #14202c;
  object-fit: contain;
}
.candidate-preview-empty {
  display: grid;
  place-items: center;
  color: #8d9aa7;
}
.candidate-strip article > div strong,
.candidate-strip article > div span {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.candidate-strip article > div strong {
  color: #3c5066;
  font-size: 10px;
}
.candidate-strip article > div span {
  margin-top: 4px;
  color: #8b98a5;
  font-size: 8px;
}
.candidate-strip button {
  grid-column: 2;
  min-height: 26px;
  border: 1px solid #d6e0ea;
  border-radius: 5px;
  background: #fff;
  color: #3570b6;
  font-size: 9px;
  cursor: pointer;
}
.batch-status {
  display: flex;
  align-items: center;
  gap: 3px;
  margin-left: auto;
  color: #7d8a98;
  font-size: 9px;
  white-space: nowrap;
}
.batch-status.succeeded,
.batch-status.local-saved {
  color: #2d8559;
}
.batch-status.failed {
  color: #bd4d43;
}
.batch-status.running,
.batch-status.queued,
.batch-status.waiting-local,
.batch-status.creating {
  color: #2f70bf;
}
.batch-empty {
  display: grid;
  place-items: center;
  gap: 9px;
  min-height: 390px;
  border: 1px solid #dfe6ed;
  border-radius: 8px;
  background: #fff;
  color: #8190a0;
}
.batch-empty strong {
  color: #42576c;
}
.batch-empty span {
  font-size: 11px;
}
.batch-dialog-summary {
  display: grid;
  gap: 4px;
  padding: 11px 13px;
  border: 1px solid #d9e6f7;
  border-radius: 7px;
  background: #f4f8fe;
  color: #3c6b9f;
}
.batch-dialog-summary span {
  font-size: 11px;
}
@media (max-width: 1350px) {
  .batch-list-header,
  .batch-shot-row {
    grid-template-columns: 140px 165px minmax(250px, 1fr) 220px 240px;
  }
  .batch-video-page {
    padding-inline: 16px;
  }
  .batch-controls-row {
    flex-wrap: wrap;
  }
  .batch-main-actions {
    margin-left: 0;
  }
  .batch-model-pipeline {
    order: 3;
    width: 100%;
  }
}
@media (max-width: 1080px) {
  .batch-list-header {
    display: none;
  }
  .batch-shot-row {
    grid-template-columns: minmax(190px, 0.7fr) minmax(300px, 1.3fr);
  }
  .shot-references {
    grid-column: 1;
  }
  .shot-prompt {
    grid-column: 2;
    grid-row: 1 / span 2;
  }
  .shot-contact-sheet {
    grid-column: 1;
    grid-row: 3;
  }
  .shot-result {
    grid-column: 2;
    grid-row: 3;
    display: flex;
  }
  .batch-metrics {
    flex-wrap: wrap;
    gap: 12px;
    padding-block: 7px;
  }
  .batch-filter-row {
    flex-wrap: wrap;
  }
}
@media (max-width: 760px) {
  .batch-video-hero {
    display: grid;
    padding: 18px;
  }
  .batch-hero-actions {
    align-items: stretch;
    flex-direction: column;
  }
  .batch-video-page {
    padding: 12px;
  }
  .batch-command-bar {
    position: static;
  }
  .batch-controls-row,
  .batch-main-actions,
  .batch-selection-actions {
    align-items: stretch;
    flex-direction: column;
  }
  .batch-model-pipeline {
    width: 100%;
    min-width: 0;
    grid-template-columns: 1fr;
  }
  .batch-model-pipeline button {
    border-right: 0;
    border-bottom: 1px solid #dfe6ee;
  }
  .batch-model-pipeline button:last-child {
    border-bottom: 0;
  }
  .batch-audio-compact {
    width: 100%;
    justify-content: space-between;
  }
  .batch-toolbar-controls {
    width: 100%;
  }
  .batch-toolbar-controls input {
    flex: 1;
    width: auto;
  }
  .batch-shot-row {
    display: block;
  }
  .shot-overview,
  .shot-references,
  .shot-prompt,
  .shot-contact-sheet,
  .shot-result {
    margin-bottom: 10px;
  }
  .shot-result {
    display: flex;
  }
  .candidate-history {
    margin-top: 5px;
  }
  .reference-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
</style>
