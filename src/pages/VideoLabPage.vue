<script lang="ts">
export default { name: 'video-lab' }
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  Activity,
  Clapperboard,
  Download,
  FileAudio,
  Film,
  HardDriveDownload,
  LoaderCircle,
  RefreshCw,
  ChevronDown,
  Sparkles,
  ScanLine,
  Smile,
  Trash2,
  Upload,
  X,
} from 'lucide-vue-next'
import StudioShell from '../layouts/StudioShell.vue'
import GenerationRouteDialog from '../components/generation/GenerationRouteDialog.vue'
import { chatApi } from '../api/chat'
import { creditApi, type CreditQuote } from '../api/credits'
import {
  generationApi,
  startLocalJobHeartbeat,
  type GenerationJob,
  type GenerationRoute,
} from '../api/generation'
import { mediaGenerationApi, type MediaCandidate } from '../api/media-generation'
import {
  platformModelCatalogApi,
  platformModelPriceLabel,
  type PlatformModelCatalogItem,
} from '../api/model-catalog'
import { videoLabApi, type VideoLabBootstrap } from '../api/video-lab'
import { LOCAL_VIDEO_LAB_PROJECT_ID } from '../api/local-project'
import { useCreditStore } from '../stores/credits'
import { useAuthStore } from '../stores/auth'
import { useDesktopStore } from '../stores/desktop'
import { useWorkspaceStore } from '../stores/workspace'
import { createLocalPoseProxy } from '../desktop/pose-proxy'
import type { PoseProxyProgress } from '../desktop/types'
import {
  buildExpressionPrompt,
  normalizeAiExpression,
  type ExpressionEmotion,
  type ExpressionGaze,
} from '../domain/video-expression'
import {
  generationRouteModelCode,
  grokVideoMode,
  grokVideoReferenceError,
  isGrokCompatibleRoute,
} from '../domain/grok-video'

type VideoMode = 'STANDARD' | 'MOTION_FINAL' | 'POSE_PROXY'
type AspectRatioChoice = '9:16' | '16:9' | '1:1'
type ResolutionChoice = 'AUTO' | '720P' | '1080P' | '4K'
type ReferencePurpose =
  | 'FIRST_FRAME'
  | 'CHARACTER'
  | 'SCENE'
  | 'BACKGROUND'
  | 'WEAPON'
  | 'COSTUME'
  | 'MOTION'
  | 'EXPRESSION'
  | 'AUDIO'
  | 'STYLE'
  | 'OTHER'
type ReferenceMediaType = 'IMAGE' | 'VIDEO' | 'AUDIO'

interface ReferenceItem {
  id: string
  file: File
  previewUrl: string
  mediaType: ReferenceMediaType
  purpose: ReferencePurpose
  note: string
}

interface PoseProxyDraft {
  sourceReferenceId: string
  sourceName: string
  file: File
  previewUrl: string
  detectedFrameRatio: number
}

const ROUTE_STORAGE_KEY = 'ai-drama-video-lab-route-v1'
const EXPRESSION_ROUTE_STORAGE_KEY = 'ai-drama-video-expression-route-v1'
const MAX_REFERENCE_FILES = 12
const MAX_REFERENCE_TOTAL_BYTES = 120 * 1024 * 1024
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_VIDEO_BYTES = 60 * 1024 * 1024
const MAX_AUDIO_BYTES = 20 * 1024 * 1024
const DEFAULT_DURATION_SEC = 5

const desktop = useDesktopStore()
const workspace = useWorkspaceStore()
const credits = useCreditStore()
const auth = useAuthStore()

const routeOpen = ref(false)
const expressionOpen = ref(false)
const expressionRouteOpen = ref(false)
const expressionRoute = ref<GenerationRoute | null>(null)
const expressionOptimizing = ref(false)
const expressionEmotion = ref<ExpressionEmotion>('RESTRAINED_ANGER')
const expressionIntensity = ref(3)
const expressionGaze = ref<ExpressionGaze>('LOCK_TARGET')
const expressionNote = ref('')
const expressionText = ref('')
const activeExpressionPrompt = ref('')
const query = ref('')
const bootstrap = ref<VideoLabBootstrap | null>(null)
const LOCAL_VIDEO_BOOTSTRAP: VideoLabBootstrap = {
  projectId: LOCAL_VIDEO_LAB_PROJECT_ID,
  projectTitle: '生视频工作区',
  episodeId: '00000000-video-lab-episode',
  episodeTitle: '独立视频',
  storyboardId: '00000000-video-lab-storyboard',
  storyboardTitle: '独立视频生成',
}
const platformModels = ref<PlatformModelCatalogItem[]>([])
const platformModelsLoaded = ref(false)
const route = ref<GenerationRoute | null>(null)
const prompt = ref('')
const references = ref<ReferenceItem[]>([])
const mode = ref<VideoMode>('STANDARD')
const aspectRatio = ref<AspectRatioChoice>('9:16')
const resolution = ref<ResolutionChoice>('AUTO')
const manualDurationSec = ref(DEFAULT_DURATION_SEC)
const quote = ref<CreditQuote | null>(null)
const quoteLoading = ref(false)
const quoteError = ref('')
const generating = ref(false)
const job = ref<GenerationJob | null>(null)
const candidates = ref<MediaCandidate[]>([])
const selectedCandidate = ref<MediaCandidate | null>(null)
const notice = ref('')
const error = ref('')
const referenceInput = ref<HTMLInputElement | null>(null)
const poseProxyProgress = ref<PoseProxyProgress | null>(null)
const poseProxyDrafts = ref<PoseProxyDraft[]>([])
const previewUrls = ref<Record<string, string>>({})
const previewLoading = ref<Record<string, boolean>>({})
const candidateSaveStates = ref<Record<string, 'SAVING' | 'FAILED'>>({})
const autoSavedCandidateIds = new Set<string>()
let quoteRequestId = 0
let platformModelsRequest = 0
let pendingPlatformModelId: string | null = null

const modeOptions: Array<{ value: VideoMode; label: string; hint: string }> = [
  {
    value: 'STANDARD',
    label: '普通视频',
    hint: '直接生成正常成片，适合常规短剧镜头。',
  },
  {
    value: 'MOTION_FINAL',
    label: '直接跟随动作',
    hint: '把动作视频直接交给平台参考，效果强但容易被平台真人/版权审核拦截。',
  },
  {
    value: 'POSE_PROXY',
    label: '人物轮廓动作参考',
    hint: 'Windows 客户端在本机逐帧提取人体轮廓，不调用平台模型，也不消耗点数。',
  },
]

const modeIcons = {
  STANDARD: Clapperboard,
  MOTION_FINAL: Activity,
  POSE_PROXY: ScanLine,
} as const

const aspectOptions: Array<{ value: AspectRatioChoice; label: string }> = [
  { value: '9:16', label: '9:16 竖屏' },
  { value: '16:9', label: '16:9 横屏' },
  { value: '1:1', label: '1:1 方形' },
]

const resolutionOptions: Array<{ value: ResolutionChoice; label: string }> = [
  { value: 'AUTO', label: '自动' },
  { value: '720P', label: '720P' },
  { value: '1080P', label: '1080P' },
  { value: '4K', label: '4K' },
]

const canGenerate = computed(() => {
  if (generating.value) return false
  if (mode.value === 'POSE_PROXY') {
    return desktop.available && references.value.some((item) => item.mediaType === 'VIDEO')
  }
  return Boolean(route.value) && Boolean(prompt.value.trim() || references.value.length)
})
const poseProxyReady = computed(
  () =>
    mode.value === 'POSE_PROXY' &&
    poseProxyDrafts.value.length > 0 &&
    poseProxyDrafts.value.length ===
      references.value.filter((item) => item.mediaType === 'VIDEO').length,
)
const generateButtonLabel = computed(() => {
  if (generating.value) return mode.value === 'POSE_PROXY' ? '提取轮廓中' : '生成中'
  if (mode.value !== 'POSE_PROXY') return '生成视频'
  return poseProxyReady.value ? '重新生成轮廓预览' : '生成轮廓预览'
})
const activeDurationSec = computed(() => clampDuration(manualDurationSec.value))
const poseProxyVideoCount = computed(
  () => references.value.filter((item) => item.mediaType === 'VIDEO').length,
)
const currentModeHint = computed(
  () => modeOptions.find((item) => item.value === mode.value)?.hint || '',
)
const effectiveAspectRatio = computed(() => aspectRatio.value)
const videoSize = computed(() => resolveVideoSize(effectiveAspectRatio.value, resolution.value))
const motionPipeline = computed(() => {
  if (mode.value === 'MOTION_FINAL') return 'MOTION_FINAL'
  if (mode.value === 'POSE_PROXY') return 'POSE_PROXY'
  return undefined
})
const selectedRouteLabel = computed(() => {
  if (mode.value === 'POSE_PROXY') return '本地轮廓处理'
  if (!route.value) return '未选择模型'
  if (route.value.sourceType === 'LOCAL') {
    const connection = desktop.localAiConnections.find(
      (item) => item.id === route.value?.localConnectionId,
    )
    return connection?.displayName || connection?.modelName || '本地 API'
  }
  const model = platformModels.value.find((item) => item.id === route.value?.platformModelId)
  const routeModelName = route.value.modelName?.trim()
  const displayName =
    routeModelName && routeModelName !== '平台模型'
      ? routeModelName
      : model?.displayName?.trim() || route.value.platformModelCode?.trim() || '平台模型'
  return model?.creditPrice ? `${displayName} · ${platformModelPriceLabel(model)}` : displayName
})
const selectedRouteSubLabel = computed(() => {
  if (mode.value === 'POSE_PROXY') return 'Windows 客户端本机处理 · 免费'
  if (!route.value) return '先选一个生成模型'
  return route.value.sourceType === 'LOCAL' ? '本地 API · 不走平台额度' : '平台模型 · 走额度预估'
})
const selectedPlatformModel = computed(() => {
  if (route.value?.sourceType !== 'PLATFORM') return null
  return platformModels.value.find((item) => item.id === route.value?.platformModelId) || null
})
const currentQuoteText = computed(() => {
  if (mode.value === 'POSE_PROXY') return '本机执行，不调用平台模型，不消耗点数。'
  if (!route.value) return '请选择模型后再看额度。'
  if (route.value.sourceType === 'LOCAL') return '当前使用本地 API，不扣平台额度。'
  if (quoteLoading.value) return '正在计算额度预估...'
  if (quoteError.value) return quoteError.value
  if (!quote.value) return '暂无报价。'
  const available = credits.wallet?.availablePoints ?? 0
  return `预估 ${quote.value.estimatedPoints} 点 / 可用 ${available} 点`
})
const expressionDraft = computed(() =>
  buildExpressionPrompt({
    emotion: expressionEmotion.value,
    intensity: expressionIntensity.value,
    gaze: expressionGaze.value,
    performanceNote: expressionNote.value,
  }),
)
const referenceSummary = computed(() => {
  if (!references.value.length) return '未添加'
  return references.value
    .map(
      (item, index) =>
        `${index + 1}. ${referencePurposeLabel(item.purpose)}：${item.note.trim() || item.file.name}`,
    )
    .join('\n')
})
const referenceModeWarning = computed(() => {
  if (!references.value.length) return '支持图片、视频、音频一起作为参考素材。'
  if (route.value?.sourceType === 'LOCAL')
    return '本地 API 主要会读取提示词说明；如果要完整使用多参考，建议切平台模型。'
  return '平台模型会完整上传参考素材，并按文件类型拆分成图 / 视频 / 音频引用。'
})
const generationPrompt = computed(() => {
  const parts: string[] = []
  const text = prompt.value.trim()
  if (text) parts.push(text)
  if (activeExpressionPrompt.value) {
    parts.push(`角色表情与面部表演：\n${activeExpressionPrompt.value}`)
  }
  if (references.value.length) {
    parts.push(`参考素材说明：\n${referenceSummary.value}`)
  }
  return parts.join('\n\n').trim()
})
const quoteSignature = computed(() =>
  JSON.stringify({
    route: route.value,
    prompt: generationPrompt.value,
    durationSec: activeDurationSec.value,
    size: videoSize.value,
    aspectRatio: effectiveAspectRatio.value,
    mode: mode.value,
    expressionPrompt: activeExpressionPrompt.value,
    references: references.value.map((item) => ({
      mediaType: item.mediaType,
      purpose: item.purpose,
      note: item.note.trim(),
      name: item.file.name,
      size: item.file.size,
    })),
  }),
)
const jobStatusText = computed(() => {
  if (!job.value) return ''
  return (
    {
      WAITING_LOCAL: '等待本地执行',
      QUEUED: '排队中',
      RUNNING: '生成中',
      SUCCEEDED: '已完成',
      FAILED: '失败',
      CANCELED: '已取消',
    }[job.value.status] || job.value.status
  )
})
const activeCandidateCount = computed(() => candidates.value.length)
const jobActive = computed(() =>
  Boolean(job.value && ['WAITING_LOCAL', 'QUEUED', 'RUNNING'].includes(job.value.status)),
)
const jobFailed = computed(() =>
  Boolean(job.value && ['FAILED', 'CANCELED'].includes(job.value.status)),
)
const filteredCandidates = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  if (!keyword) return candidates.value
  return candidates.value.filter((candidate) =>
    [
      candidatePrompt(candidate),
      candidate.modelName,
      candidate.status,
      candidate.width && candidate.height ? `${candidate.width}x${candidate.height}` : '',
      candidate.width && candidate.height ? `${candidate.width}×${candidate.height}` : '',
    ]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(keyword)),
  )
})

onMounted(() => {
  void bootstrapPage()
})

onBeforeUnmount(() => {
  for (const item of references.value) globalThis.URL.revokeObjectURL(item.previewUrl)
  for (const url of Object.values(previewUrls.value)) globalThis.URL.revokeObjectURL(url)
  clearPoseProxyDrafts()
})

watch(quoteSignature, () => {
  void refreshQuote()
})

watch(mode, (next) => {
  if (next !== 'POSE_PROXY') clearPoseProxyDrafts()
})

watch([expressionEmotion, expressionIntensity, expressionGaze, expressionNote], () => {
  if (expressionOpen.value && !expressionOptimizing.value) {
    expressionText.value = expressionDraft.value
  }
})

watch(
  () =>
    [
      platformModels.value.length,
      desktop.localAiConnections.length,
      bootstrap.value?.projectId,
    ] as const,
  () => {
    if (!bootstrap.value) return
    if (route.value && isRouteValid(route.value)) return
    if (!ensureDefaultRoute()) {
      routeOpen.value = true
    }
  },
)

function clampDuration(value: number) {
  return Math.max(
    1,
    Math.min(300, Number.isFinite(value) ? Math.round(value) : DEFAULT_DURATION_SEC),
  )
}

function resolveVideoSize(aspect: string, resolutionPreset: ResolutionChoice) {
  if (resolutionPreset === '4K') {
    if (aspect === '16:9') return '3840x2160'
    if (aspect === '1:1') return '3840x3840'
    return '2160x3840'
  }
  const use1080 = resolutionPreset === '1080P'
  if (aspect === '16:9') return use1080 ? '1920x1080' : '1280x720'
  if (aspect === '1:1') return use1080 ? '1080x1080' : '1024x1024'
  return use1080 ? '1080x1920' : '720x1280'
}

function referencePurposeLabel(purpose: ReferencePurpose) {
  return (
    {
      CHARACTER: '角色',
      FIRST_FRAME: '首帧',
      SCENE: '场景',
      BACKGROUND: '背景',
      WEAPON: '武器',
      COSTUME: '服装',
      MOTION: '动作',
      EXPRESSION: '表情',
      AUDIO: '声音',
      STYLE: '风格',
      OTHER: '其他',
    }[purpose] || purpose
  )
}

function referenceMediaLabel(mediaType: ReferenceMediaType) {
  return (
    {
      IMAGE: '图片',
      VIDEO: '视频',
      AUDIO: '音频',
    }[mediaType] || mediaType
  )
}

function defaultPurpose(file: File): ReferencePurpose {
  if (file.type.startsWith('video/')) return 'MOTION'
  if (file.type.startsWith('audio/')) return 'AUDIO'
  return 'CHARACTER'
}

function detectMediaType(file: File): ReferenceMediaType {
  if (file.type.startsWith('video/')) return 'VIDEO'
  if (file.type.startsWith('audio/')) return 'AUDIO'
  return 'IMAGE'
}

function normalizedImageMimeType(file: File) {
  const declared = file.type.split(';', 1)[0].trim().toLowerCase()
  if (['image/png', 'image/jpeg', 'image/webp'].includes(declared)) return declared
  if (/\.png$/i.test(file.name)) return 'image/png'
  if (/\.jpe?g$/i.test(file.name)) return 'image/jpeg'
  if (/\.webp$/i.test(file.name)) return 'image/webp'
  return declared
}

function totalReferenceBytes() {
  return references.value.reduce((sum, item) => sum + item.file.size, 0)
}

function triggerReferencePicker() {
  referenceInput.value?.click()
}

function openRouteDialog() {
  if (generating.value) return
  routeOpen.value = true
}

function onReferenceSelected(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  error.value = ''
  notice.value = ''
  if (files.length) clearPoseProxyDrafts()
  for (const file of files) {
    if (references.value.length >= MAX_REFERENCE_FILES) {
      error.value = `最多只能添加 ${MAX_REFERENCE_FILES} 个参考素材`
      break
    }
    if (!isSupportedReference(file)) {
      error.value = `${file.name} 不是支持的图片、视频或音频文件`
      continue
    }
    if (file.size > maxSizeForFile(file)) {
      error.value = `${file.name} 超过单个素材大小限制`
      continue
    }
    const nextTotal = totalReferenceBytes() + file.size
    if (nextTotal > MAX_REFERENCE_TOTAL_BYTES) {
      error.value = '参考素材总大小不能超过 120MB'
      break
    }
    references.value.push({
      id: crypto.randomUUID(),
      file,
      previewUrl: URL.createObjectURL(file),
      mediaType: detectMediaType(file),
      purpose: defaultPurpose(file),
      note: '',
    })
  }
}

function isSupportedReference(file: File) {
  if (file.type.startsWith('image/')) return true
  if (file.type.startsWith('video/')) return true
  if (file.type.startsWith('audio/')) return true
  return /\.(png|jpe?g|webp|mp4|webm|mov|mp3|wav|aac|m4a|ogg|flac)$/i.test(file.name)
}

function maxSizeForFile(file: File) {
  if (file.type.startsWith('image/')) return MAX_IMAGE_BYTES
  if (file.type.startsWith('video/')) return MAX_VIDEO_BYTES
  return MAX_AUDIO_BYTES
}

function removeReference(index: number) {
  clearPoseProxyDrafts()
  const [removed] = references.value.splice(index, 1)
  if (removed) URL.revokeObjectURL(removed.previewUrl)
}

function clearReferences() {
  clearPoseProxyDrafts()
  for (const item of references.value) URL.revokeObjectURL(item.previewUrl)
  references.value = []
}

function setRoute(next: GenerationRoute) {
  platformModelsRequest += 1
  route.value = next
  pendingPlatformModelId =
    next.sourceType === 'PLATFORM' &&
    !platformModels.value.some((item) => item.id === next.platformModelId)
      ? next.platformModelId
      : null
  globalThis.localStorage?.setItem(ROUTE_STORAGE_KEY, JSON.stringify(next))
  routeOpen.value = false
  void refreshQuote()
  if (
    next.sourceType === 'PLATFORM' &&
    pendingPlatformModelId === next.platformModelId
  ) {
    void refreshSelectedPlatformRoute(next.platformModelId)
  }
}

function openExpressionControl() {
  expressionText.value = activeExpressionPrompt.value || expressionDraft.value
  expressionOpen.value = true
}

function closeExpressionControl() {
  if (expressionOptimizing.value) return
  expressionOpen.value = false
}

function applyExpressionControl() {
  const next = expressionText.value.trim() || expressionDraft.value
  activeExpressionPrompt.value = next
  expressionText.value = next
  expressionOpen.value = false
  notice.value = '表情控制已加入本次视频提示词'
}

function clearExpressionControl() {
  activeExpressionPrompt.value = ''
  expressionText.value = expressionDraft.value
  expressionOpen.value = false
  notice.value = '已移除表情控制'
}

async function requestExpressionOptimization() {
  if (expressionOptimizing.value) return
  if (!expressionRoute.value) {
    expressionRouteOpen.value = true
    return
  }
  await optimizeExpression(expressionRoute.value)
}

async function setExpressionRoute(next: GenerationRoute) {
  expressionRoute.value = next
  globalThis.localStorage?.setItem(EXPRESSION_ROUTE_STORAGE_KEY, JSON.stringify(next))
  expressionRouteOpen.value = false
  await optimizeExpression(next)
}

async function optimizeExpression(selectedRoute: GenerationRoute) {
  expressionOptimizing.value = true
  error.value = ''
  try {
    const userPrompt = [
      '把下面的表情意图改写为一段视频生成模型可执行的中文面部表演提示词。',
      '必须明确眉毛、眼睑、视线、嘴唇或下颌、呼吸与停顿；保留强度；不要改变角色身份和脸型；不要解释。',
      expressionText.value.trim() || expressionDraft.value,
    ].join('\n\n')
    let optimized = ''
    if (selectedRoute.sourceType === 'LOCAL') {
      const result = await desktop.generateLocalText({
        connectionId: selectedRoute.localConnectionId,
        systemPrompt:
          '你是影视表演指导和视频提示词工程师。只输出一段简洁、可执行、可观察的面部表演参数，不输出标题、Markdown或解释。',
        userPrompt,
        parameters: { temperature: 0.3, max_tokens: 600 },
      })
      optimized = result.text
    } else {
      const session = await chatApi.createSession({
        title: '视频表情提示优化',
        platformModelId: selectedRoute.platformModelId,
      })
      try {
        const result = await chatApi.sendMessage(session.id, {
          content: userPrompt,
          platformModelId: selectedRoute.platformModelId,
        })
        optimized = result.assistantMessage.content
      } finally {
        await chatApi.deleteSession(session.id).catch(() => undefined)
      }
    }
    const normalized = normalizeAiExpression(optimized)
    if (!normalized) throw new Error('AI 未返回可用的表情描述')
    expressionText.value = normalized
    notice.value = '表情描述已优化，请确认后应用'
  } catch (caught) {
    error.value = messageFor(caught, '表情描述优化失败')
  } finally {
    expressionOptimizing.value = false
  }
}

function restoreRoute() {
  const raw = globalThis.localStorage?.getItem(ROUTE_STORAGE_KEY)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as GenerationRoute
      if (parsed && parsed.sourceType === 'LOCAL' && 'localConnectionId' in parsed) {
        route.value = parsed
      } else if (
        parsed &&
        parsed.sourceType === 'PLATFORM' &&
        typeof parsed.platformModelId === 'string' &&
        parsed.platformModelId.trim()
      ) {
        route.value = parsed
      }
    } catch {
      globalThis.localStorage?.removeItem(ROUTE_STORAGE_KEY)
    }
  }
  const expressionRaw = globalThis.localStorage?.getItem(EXPRESSION_ROUTE_STORAGE_KEY)
  if (!expressionRaw) return
  try {
    expressionRoute.value = JSON.parse(expressionRaw) as GenerationRoute
  } catch {
    globalThis.localStorage?.removeItem(EXPRESSION_ROUTE_STORAGE_KEY)
  }
}

function isRouteValid(next: GenerationRoute) {
  if (next.sourceType === 'LOCAL') {
    return desktop.localAiConnections.some(
      (item) => item.id === next.localConnectionId && item.serviceType === 'VIDEO' && item.enabled,
    )
  }
  if (!next.platformModelId?.trim()) return false
  if (platformModels.value.some((item) => item.id === next.platformModelId)) return true
  return (
    (!platformModelsLoaded.value &&
      Boolean(next.platformModelCode?.trim() || next.modelName?.trim())) ||
    pendingPlatformModelId === next.platformModelId
  )
}

function ensureDefaultRoute() {
  if (route.value && isRouteValid(route.value)) {
    if (route.value.sourceType === 'PLATFORM') {
      const model = platformModels.value.find((item) => item.id === route.value!.platformModelId)
      if (model) {
        setRoute({
          sourceType: 'PLATFORM',
          platformModelId: model.id,
          platformModelCode: model.modelCode,
          platformProtocolProfile: model.protocolProfile,
          modelName: model.displayName,
        })
      }
    }
    return true
  }

  const platform = platformModels.value.find((item) => item.creditPrice) || platformModels.value[0]
  if (platform) {
    setRoute({
      sourceType: 'PLATFORM',
      platformModelId: platform.id,
      platformModelCode: platform.modelCode,
      platformProtocolProfile: platform.protocolProfile,
      modelName: platform.displayName,
    })
    return true
  }

  const localConnections = desktop.localAiConnections.filter(
    (item) => item.serviceType === 'VIDEO' && item.enabled,
  )
  const local = localConnections.find((item) => item.defaultProvider) || localConnections[0]
  if (local) {
    setRoute({
      sourceType: 'LOCAL',
      localConnectionId: local.id,
      localProviderCode: local.providerCode,
      localModelName: local.modelName,
    })
    return true
  }

  route.value = null
  return false
}

async function bootstrapPage() {
  error.value = ''
  notice.value = ''
  restoreRoute()
  try {
    await Promise.all([desktop.initialize(), desktop.loadLocalAiConnections()])
    if (auth.isAuthenticated) {
      await Promise.all([
        credits.load(true).catch(() => undefined),
        loadPlatformModels().catch(() => {
          platformModels.value = []
          platformModelsLoaded.value = false
        }),
        loadBootstrap(),
      ])
    } else {
      platformModels.value = []
      platformModelsLoaded.value = false
      bootstrap.value = LOCAL_VIDEO_BOOTSTRAP
      if (route.value?.sourceType === 'PLATFORM') route.value = null
    }
    if (desktop.available && bootstrap.value) {
      await desktop.ensureProject({
        id: bootstrap.value.projectId,
        title: bootstrap.value.projectTitle,
      })
    }
    if (!ensureDefaultRoute()) {
      routeOpen.value = true
    }
    await loadCandidates({ autoSave: true })
    if (auth.isAuthenticated) {
      await restoreActivePlatformJob()
      void refreshQuote()
    }
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : '生视频工作台初始化失败'
  }
}

async function restoreActivePlatformJob() {
  if (!auth.isAuthenticated) return
  const jobs = await generationApi.listMine(1, 100)
  const active = jobs.items.find(
    (item) =>
      item.targetType === 'VIDEO_LAB' &&
      item.sourceType === 'PLATFORM' &&
      ['WAITING_LOCAL', 'QUEUED', 'RUNNING'].includes(item.status),
  )
  if (!active) return
  job.value = active
  notice.value = '检测到未结束的视频任务，正在恢复进度'
  const finalJob = await waitForCompletion(active.id)
  if (finalJob.status === 'SUCCEEDED') {
    await loadCandidates({ autoSave: true })
  } else if (finalJob.status === 'FAILED') {
    error.value = finalJob.errorMessage || '恢复的视频任务执行失败'
  }
}

async function loadBootstrap() {
  if (!auth.isAuthenticated) {
    bootstrap.value = LOCAL_VIDEO_BOOTSTRAP
    return
  }
  try {
    bootstrap.value = await videoLabApi.bootstrap()
  } catch (caught) {
    if (!desktop.available) throw caught
    bootstrap.value = LOCAL_VIDEO_BOOTSTRAP
  }
}

async function loadPlatformModels() {
  if (!auth.isAuthenticated) return false
  const requestNumber = ++platformModelsRequest
  const models = await platformModelCatalogApi.list('VIDEO')
  if (requestNumber !== platformModelsRequest) return false
  platformModels.value = models
  platformModelsLoaded.value = true
  return true
}

async function refreshSelectedPlatformRoute(platformModelId: string) {
  try {
    if (!(await loadPlatformModels())) return
  } catch {
    return
  }
  if (
    route.value?.sourceType !== 'PLATFORM' ||
    route.value.platformModelId !== platformModelId
  ) {
    return
  }
  const model = platformModels.value.find((item) => item.id === platformModelId)
  if (!model) return
  pendingPlatformModelId = null
  route.value = {
    sourceType: 'PLATFORM',
    platformModelId: model.id,
    platformModelCode: model.modelCode,
    platformProtocolProfile: model.protocolProfile,
    modelName: model.displayName,
  }
  globalThis.localStorage?.setItem(ROUTE_STORAGE_KEY, JSON.stringify(route.value))
  await refreshQuote()
}

async function refreshQuote() {
  const currentRequestId = ++quoteRequestId
  quote.value = null
  quoteError.value = ''
  quoteLoading.value = false
  if (mode.value === 'POSE_PROXY') return
  if (!auth.isAuthenticated) return
  if (!route.value || route.value.sourceType !== 'PLATFORM') return
  const model = selectedPlatformModel.value
  if (!model?.creditPrice) return
  if (!generationPrompt.value.trim()) return
  quoteLoading.value = true
  try {
    const result = await creditApi.quote({
      platformModelId: model.id,
      serviceType: 'VIDEO',
      parameters: videoQuoteParameters(),
      prompt: generationPrompt.value,
    })
    if (currentRequestId === quoteRequestId) quote.value = result
  } catch (caught) {
    if (currentRequestId === quoteRequestId) {
      quoteError.value = caught instanceof Error ? caught.message : '额度预估失败'
    }
  } finally {
    if (currentRequestId === quoteRequestId) quoteLoading.value = false
  }
}

function videoQuoteParameters() {
  if (mode.value === 'POSE_PROXY') {
    return {
      local_processing: true,
      estimated_points: 0,
      motion_pipeline: 'POSE_PROXY',
      video_mode: 'POSE_PROXY',
    }
  }
  return {
    size: videoSize.value,
    aspect_ratio: effectiveAspectRatio.value,
    ...(resolution.value !== 'AUTO' ? { resolution: resolution.value } : {}),
    duration_sec: activeDurationSec.value,
    seconds: activeDurationSec.value,
    generate_audio: mode.value !== 'POSE_PROXY',
    watermark: false,
    ...(motionPipeline.value
      ? { motion_pipeline: motionPipeline.value, video_mode: motionPipeline.value }
      : {}),
  }
}

async function generate() {
  if (mode.value === 'POSE_PROXY') {
    if (!desktop.available) {
      error.value = '人物轮廓动作参考需要在 Windows 客户端本地处理，不会调用平台模型。'
      return
    }
    if (!poseProxyVideoCount.value) {
      error.value = '请先上传一段人物动作视频'
      return
    }
    generating.value = true
    error.value = ''
    notice.value = ''
    poseProxyProgress.value = null
    try {
      await preparePoseProxyDrafts()
      notice.value =
        '人物轮廓动作参考已在本机生成，不消耗点数。确认动作没问题后，可直接用于生成正式视频。'
    } catch (caught) {
      clearPoseProxyDrafts()
      error.value = messageFor(caught, '人物轮廓提取失败')
    } finally {
      generating.value = false
      poseProxyProgress.value = null
    }
    return
  }
  if (!bootstrap.value) {
    error.value = auth.isAuthenticated
      ? '视频工作台尚未就绪'
      : '使用平台视频模型需要先登录云端；本地轮廓动作参考无需登录。'
    return
  }
  if (!generationPrompt.value.trim()) {
    error.value = '请至少输入一句描述，或者添加参考素材'
    return
  }
  if (!route.value) {
    openRouteDialog()
    error.value = '请先选择一个生成模型'
    return
  }
  const requestRoute = route.value
  const selectedGrokMode = grokVideoMode(generationRouteModelCode(requestRoute))
  if (selectedGrokMode && mode.value !== 'STANDARD') {
    error.value = '当前 Grok 视频模型不支持动作参考或姿态代理，请切换到普通视频模式'
    return
  }
  const grokReferenceError = grokVideoReferenceError(
    selectedGrokMode,
    references.value.map((item) => ({ mediaType: item.mediaType, purpose: item.purpose })),
    isGrokCompatibleRoute(requestRoute),
  )
  if (grokReferenceError) {
    error.value = grokReferenceError
    return
  }
  if (mode.value !== 'STANDARD' && !references.value.some((item) => item.mediaType === 'VIDEO')) {
    error.value = '动作参考模式至少需要上传一个视频参考'
    return
  }
  generating.value = true
  error.value = ''
  notice.value = ''
  poseProxyProgress.value = null
  try {
    const selectedReferences =
      selectedGrokMode === 'TEXT_TO_VIDEO'
        ? []
        : selectedGrokMode === 'IMAGE_TO_VIDEO'
          ? references.value.filter((item) => item.mediaType === 'IMAGE')
          : references.value
    const referenceMode =
      selectedGrokMode === 'IMAGE_TO_VIDEO'
        ? selectedReferences.length === 1 && selectedReferences[0]?.purpose === 'FIRST_FRAME'
          ? 'IMAGE_TO_VIDEO'
          : 'REFERENCE_TO_VIDEO'
        : undefined
    let uploadedReferenceIds: {
      referenceImageIds: string[]
      referenceVideoIds: string[]
      referenceAudioIds: string[]
    } = {
      referenceImageIds: [],
      referenceVideoIds: [],
      referenceAudioIds: [],
    }
    if (requestRoute.sourceType === 'PLATFORM' && selectedReferences.length) {
      uploadedReferenceIds = await uploadPlatformReferences(selectedReferences)
    }
    const jobRequest = await mediaGenerationApi.create(
      bootstrap.value.projectId,
      {
        mediaType: 'VIDEO',
        storyboardId: bootstrap.value.storyboardId,
        prompt: generationPrompt.value,
        durationSec: activeDurationSec.value,
        route: requestRoute,
        parameters: {
          size: videoSize.value,
          aspect_ratio: effectiveAspectRatio.value,
          ...(resolution.value !== 'AUTO' ? { resolution: resolution.value } : {}),
          duration_sec: activeDurationSec.value,
          seconds: activeDurationSec.value,
          generate_audio: mode.value !== 'POSE_PROXY',
          watermark: false,
          ...(referenceMode ? { reference_mode: referenceMode } : {}),
          ...(motionPipeline.value
            ? { motion_pipeline: motionPipeline.value, video_mode: motionPipeline.value }
            : {}),
          ...(uploadedReferenceIds.referenceImageIds.length
            ? { reference_image_ids: uploadedReferenceIds.referenceImageIds }
            : {}),
          ...(uploadedReferenceIds.referenceVideoIds.length
            ? { reference_video_ids: uploadedReferenceIds.referenceVideoIds }
            : {}),
          ...(uploadedReferenceIds.referenceAudioIds.length
            ? { reference_audio_ids: uploadedReferenceIds.referenceAudioIds }
            : {}),
        },
      },
      crypto.randomUUID(),
    )
    job.value = jobRequest
    if (requestRoute.sourceType === 'LOCAL') {
      const running = await generationApi.startLocal(jobRequest.id)
      job.value = running
      const stopHeartbeat = startLocalJobHeartbeat(running.id, 25)
      try {
        const execution = running.executionRequest
        if (!execution) throw new Error('本地媒体任务缺少执行参数')
        if (!desktop.available) throw new Error('当前不是 Windows 客户端，无法执行本地生成')
        const local = await desktop.generateLocalMedia({
          projectId: bootstrap.value.projectId,
          connectionId: requestRoute.localConnectionId,
          mediaType: 'VIDEO',
          prompt: execution.userPrompt,
          durationSec: activeDurationSec.value,
          size: videoSize.value,
          aspectRatio: effectiveAspectRatio.value === '16:9' ? '16:9' : '9:16',
          referenceImages:
            selectedGrokMode === 'IMAGE_TO_VIDEO'
              ? await Promise.all(
                  selectedReferences.map(async (item) => ({
                    mimeType: normalizedImageMimeType(item.file),
                    bytes: await item.file.arrayBuffer(),
                  })),
                )
              : undefined,
          parameters: {
            ...(resolution.value !== 'AUTO' ? { resolution: resolution.value } : {}),
            generate_audio: mode.value !== 'POSE_PROXY',
            ...(referenceMode ? { reference_mode: referenceMode } : {}),
            watermark: false,
            ...(motionPipeline.value ? { motion_pipeline: motionPipeline.value } : {}),
            reference_notes: referenceSummary.value,
          },
        })
        await mediaGenerationApi.completeLocal(running.id, {
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
        job.value = await generationApi.get(running.id)
      } catch (caught) {
        const message = messageFor(caught, '本地视频生成失败')
        await generationApi.failLocal(running.id, message).catch(() => undefined)
        throw caught
      } finally {
        stopHeartbeat()
      }
    } else {
      job.value = await waitForCompletion(jobRequest.id)
    }
    if (job.value.status !== 'SUCCEEDED') {
      throw new Error(job.value.errorMessage || '平台视频生成未成功')
    }
    const saved = await loadCandidates({ autoSave: true })
    if (saved?.localAssetId || saved?.status === 'LOCAL_SAVED') {
      notice.value = '视频已生成并自动保存到本地'
    } else if (!desktop.available) {
      notice.value = '视频已生成并出现在候选区；Windows 客户端会自动保存到本地'
    }
  } catch (caught) {
    notice.value = ''
    error.value = messageFor(caught, '视频生成失败')
  } finally {
    generating.value = false
    poseProxyProgress.value = null
  }
}

async function waitForCompletion(jobId: string) {
  for (let attempt = 0; attempt < 900; attempt += 1) {
    const current = await generationApi.get(jobId)
    job.value = current
    if (['SUCCEEDED', 'FAILED', 'CANCELED'].includes(current.status)) return current
    await sleep(1500)
  }
  throw new Error('视频任务超时，请到生成任务里查看详情')
}

async function loadCandidates(options: { autoSave?: boolean } = {}) {
  if (!bootstrap.value) return null
  const remoteOrLedgerCandidates = await mediaGenerationApi.list(
    bootstrap.value.projectId,
    bootstrap.value.storyboardId,
    'VIDEO',
  )
  candidates.value = mergeLocalVideoArchive(remoteOrLedgerCandidates)
  if (options.autoSave !== false) {
    return autoSaveLatestCandidate()
  }
  return null
}

function mergeLocalVideoArchive(current: MediaCandidate[]) {
  if (desktop.project?.projectId !== bootstrap.value?.projectId) return current
  const knownAssetIds = new Set(current.map((item) => item.localAssetId).filter(Boolean))
  const archived = desktop.project.assets
    .filter(
      (asset) =>
        asset.category === 'videos' &&
        asset.fileAvailable &&
        asset.mimeType.startsWith('video/') &&
        !knownAssetIds.has(asset.id),
    )
    .map<MediaCandidate>((asset) => ({
      id: `local-archive-${asset.id}`,
      jobId: 'local-archive',
      storyboardId: bootstrap.value!.storyboardId,
      mediaType: 'VIDEO',
      providerCode: 'LOCAL_ARCHIVE',
      modelName: '本地永久素材',
      deliveryType: 'LOCAL_CACHE',
      clientCandidateId: null,
      previewAvailable: true,
      prompt: '从本地项目目录恢复的已保存视频',
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      status: 'LOCAL_SAVED',
      localAssetId: asset.id,
      version: 0,
      createdAt: asset.importedAt,
    }))
  return [...current, ...archived].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  )
}

async function autoSaveLatestCandidate() {
  if (!desktop.available || !bootstrap.value || !desktop.project) return null
  const candidate = candidates.value.find(canAutoSaveCandidate)
  if (
    !candidate ||
    autoSavedCandidateIds.has(candidate.id) ||
    candidateSaveStates.value[candidate.id] === 'SAVING'
  ) {
    return null
  }
  setCandidateSaveState(candidate.id, 'SAVING')
  try {
    const selected =
      candidate.status === 'AVAILABLE'
        ? await mediaGenerationApi.select(candidate.id, candidate.version)
        : candidate
    replaceCandidate(selected)
    const saved = await persistCandidateToLocal(selected)
    replaceCandidate(saved)
    clearCandidateSaveState(candidate.id)
    autoSavedCandidateIds.add(candidate.id)
    notice.value = '最新视频候选已自动保存到本地项目目录'
    return saved
  } catch (caught) {
    setCandidateSaveState(candidate.id, 'FAILED')
    error.value = messageFor(caught, '自动保存到本地失败，可在视频卡片上重试')
    return null
  }
}

function canAutoSaveCandidate(candidate: MediaCandidate) {
  if (candidate.status === 'LOCAL_SAVED' || candidate.localAssetId) return false
  return ['AVAILABLE', 'SELECTED'].includes(candidate.status)
}

async function persistCandidateToLocal(candidate: MediaCandidate) {
  if (!desktop.available || !bootstrap.value || !desktop.project) {
    throw new Error('本地保存需要 Windows 客户端')
  }
  if (candidate.localAssetId || candidate.status === 'LOCAL_SAVED') return candidate
  if (candidate.status !== 'SELECTED') {
    throw new Error('请先选中候选，再保存到本地')
  }
  const accessToken = mediaGenerationApi.accessToken()
  if (candidate.deliveryType !== 'LOCAL_CACHE' && !accessToken) {
    throw new Error('登录状态已失效，无法下载平台视频')
  }
  const localAsset = await desktop.saveGeneratedMedia(
    candidate.deliveryType === 'LOCAL_CACHE'
      ? {
          projectId: bootstrap.value.projectId,
          projectTitle: bootstrap.value.projectTitle,
          candidateId: candidate.id,
          deliveryType: 'LOCAL_CACHE',
          clientCandidateId: requiredClientCandidateId(candidate),
          category: 'videos',
        }
      : {
          projectId: bootstrap.value.projectId,
          projectTitle: bootstrap.value.projectTitle,
          candidateId: candidate.id,
          deliveryType: candidate.deliveryType,
          category: 'videos',
          accessToken: accessToken!,
        },
  )
  const mappings = await workspace.synchronizeLocalAssets(bootstrap.value.projectId, [localAsset])
  const canonicalId =
    mappings.find((item) => item.clientAssetId === localAsset.id)?.assetId ?? localAsset.id
  await desktop.reconcileAssetIds(mappings.filter((item) => item.clientAssetId !== item.assetId))
  return mediaGenerationApi.confirmSaved(candidate.id, canonicalId, candidate.version)
}

function replaceCandidate(candidate: MediaCandidate) {
  const index = candidates.value.findIndex((item) => item.id === candidate.id)
  if (index < 0) {
    candidates.value = [candidate, ...candidates.value]
    return
  }
  candidates.value = candidates.value.map((item) => (item.id === candidate.id ? candidate : item))
  if (selectedCandidate.value?.id === candidate.id) selectedCandidate.value = candidate
}

function setCandidateSaveState(candidateId: string, state: 'SAVING' | 'FAILED') {
  candidateSaveStates.value = { ...candidateSaveStates.value, [candidateId]: state }
}

function clearCandidateSaveState(candidateId: string) {
  const next = { ...candidateSaveStates.value }
  delete next[candidateId]
  candidateSaveStates.value = next
}

async function uploadPlatformReferences(selected: ReferenceItem[]) {
  if (!selected.length)
    return {
      referenceImageIds: [],
      referenceVideoIds: [],
      referenceAudioIds: [],
    }
  const uploadFiles = await platformReferenceFiles(selected)
  const uploaded = await mediaGenerationApi.uploadReferences(uploadFiles)
  if (uploaded.length !== selected.length) {
    throw new Error('参考素材上传结果不完整，请重试')
  }
  const grouped = {
    referenceImageIds: [] as string[],
    referenceVideoIds: [] as string[],
    referenceAudioIds: [] as string[],
  }
  uploaded.forEach((item, index) => {
    if (item.mediaType === 'IMAGE') grouped.referenceImageIds.push(item.id)
    else if (item.mediaType === 'VIDEO') grouped.referenceVideoIds.push(item.id)
    else grouped.referenceAudioIds.push(item.id)
  })
  return grouped
}

async function platformReferenceFiles(selected: ReferenceItem[]) {
  return selected.map((item) => item.file)
}

async function preparePoseProxyDrafts() {
  const videos = references.value.filter((item) => item.mediaType === 'VIDEO')
  if (!videos.length) throw new Error('请先添加动作参考视频')
  clearPoseProxyDrafts()
  const drafts: PoseProxyDraft[] = []
  try {
    for (let index = 0; index < videos.length; index += 1) {
      const item = videos[index]
      const result = await createLocalPoseProxy(item.file, (progress) => {
        poseProxyProgress.value = {
          ...progress,
          message: `生成人物轮廓 ${index + 1}/${videos.length}：${progress.message}`,
        }
      })
      drafts.push({
        sourceReferenceId: item.id,
        sourceName: item.file.name,
        file: result.file,
        previewUrl: globalThis.URL.createObjectURL(result.file),
        detectedFrameRatio: result.detectedFrameRatio,
      })
    }
    poseProxyDrafts.value = drafts
  } catch (caught) {
    for (const draft of drafts) globalThis.URL.revokeObjectURL(draft.previewUrl)
    throw caught
  }
}

function clearPoseProxyDrafts() {
  for (const draft of poseProxyDrafts.value) globalThis.URL.revokeObjectURL(draft.previewUrl)
  poseProxyDrafts.value = []
  poseProxyProgress.value = null
}

function regeneratePoseProxyDrafts() {
  if (generating.value) return
  clearPoseProxyDrafts()
  void generate()
}

function usePoseProxyForFinalVideo() {
  if (!poseProxyDrafts.value.length) {
    error.value = '请先生成可用的人物轮廓动作参考'
    return
  }
  const originalVideoIds = new Set(poseProxyDrafts.value.map((draft) => draft.sourceReferenceId))
  const retainedReferences = references.value.filter((item) => {
    const replaced = originalVideoIds.has(item.id)
    if (replaced) URL.revokeObjectURL(item.previewUrl)
    return !replaced
  })
  const proxyReferences = poseProxyDrafts.value.map((draft) => ({
    id: crypto.randomUUID(),
    file: draft.file,
    previewUrl: URL.createObjectURL(draft.file),
    mediaType: 'VIDEO' as const,
    purpose: 'MOTION' as const,
    note: `本地提取的人物轮廓动作参考，来自 ${draft.sourceName}，只用于动作、节奏、姿态和站位`,
  }))
  references.value = [...retainedReferences, ...proxyReferences]
  mode.value = 'MOTION_FINAL'
  clearPoseProxyDrafts()
  notice.value =
    '已切到正式视频生成，并自动带入本地轮廓动作参考。现在补角色图、场景图和正式镜头描述即可生成。'
  error.value = ''
}

function generationModeLabel(candidate: MediaCandidate) {
  const text = `${candidate.prompt || ''} ${candidate.modelName || ''}`.toLowerCase()
  if (text.includes('pose_proxy') || text.includes('姿态代理') || text.includes('轮廓动作')) {
    return '人物轮廓动作参考'
  }
  if (text.includes('motion_final') || text.includes('动作成片') || text.includes('动作参考')) {
    return '直接跟随动作'
  }
  return '普通视频'
}

function downloadPoseProxyDraft(draft: PoseProxyDraft) {
  const anchor = document.createElement('a')
  anchor.href = draft.previewUrl
  anchor.download = draft.file.name
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

function requiredClientCandidateId(candidate: MediaCandidate) {
  if (!candidate.clientCandidateId) throw new Error('本地候选缺少客户端标识')
  return candidate.clientCandidateId
}

async function ensurePreview(candidate: MediaCandidate) {
  if (previewSource(candidate) || previewLoading.value[candidate.id]) return
  await ensurePreviewBlob(candidate)
}

async function ensurePreviewBlob(candidate: MediaCandidate) {
  const permanentUrl = localSavedPreviewUrl(candidate)
  if (permanentUrl) {
    const response = await fetch(permanentUrl)
    if (response.ok) return response.blob()
  }
  const cachedCandidateUrl = localCandidatePreviewUrl(candidate)
  if (cachedCandidateUrl) {
    const response = await fetch(cachedCandidateUrl)
    if (response.ok) return response.blob()
  }
  const cachedUrl = previewUrls.value[candidate.id]
  if (cachedUrl) {
    const response = await fetch(cachedUrl)
    return response.blob()
  }
  if (previewLoading.value[candidate.id]) return null
  previewLoading.value = { ...previewLoading.value, [candidate.id]: true }
  try {
    const blob = await mediaGenerationApi.preview(candidate.id)
    const url = URL.createObjectURL(blob)
    const old = previewUrls.value[candidate.id]
    if (old) URL.revokeObjectURL(old)
    previewUrls.value = { ...previewUrls.value, [candidate.id]: url }
    return blob
  } catch {
    // 预览失败不影响列表
    return null
  } finally {
    const next = { ...previewLoading.value }
    delete next[candidate.id]
    previewLoading.value = next
  }
}

async function openPreview(candidate: MediaCandidate) {
  selectedCandidate.value = candidate
  await ensurePreview(candidate)
}

function closePreview() {
  selectedCandidate.value = null
}

function previewSource(candidate: MediaCandidate) {
  return (
    localSavedPreviewUrl(candidate) ||
    localCandidatePreviewUrl(candidate) ||
    previewUrls.value[candidate.id] ||
    ''
  )
}

function localSavedPreviewUrl(candidate: MediaCandidate) {
  if (!desktop.available || !bootstrap.value || !candidate.localAssetId) return ''
  return (
    window.aiDramaDesktop?.assetPreviewUrl(bootstrap.value.projectId, candidate.localAssetId) || ''
  )
}

function localCandidatePreviewUrl(candidate: MediaCandidate) {
  if (
    !desktop.available ||
    !bootstrap.value ||
    candidate.deliveryType !== 'LOCAL_CACHE' ||
    !candidate.clientCandidateId
  ) {
    return ''
  }
  return (
    window.aiDramaDesktop?.generatedCandidatePreviewUrl(
      bootstrap.value.projectId,
      candidate.clientCandidateId,
    ) || ''
  )
}

function statusLabel(candidate: MediaCandidate) {
  const saveState = candidateSaveStates.value[candidate.id]
  if (saveState === 'SAVING') return '保存中'
  if (saveState === 'FAILED') return '保存失败'
  return (
    {
      AVAILABLE: '待保存',
      SELECTED: '已选中',
      LOCAL_SAVED: '已保存',
    }[candidate.status] || candidate.status
  )
}

function messageFor(error: unknown, fallback: string) {
  if (!(error instanceof Error) || !error.message) return fallback
  const message = error.message
  if (message.includes('The parameter `content`') || message.includes('parameter content')) {
    return '平台拒绝了参考素材参数：当前模型可能不支持你上传的视频/音频参考，或服务端未配置公网临时素材地址。请先移除视频/音频参考重试，或上线后配置 APP_MEDIA_REFERENCE_PUBLIC_BASE_URL。'
  }
  if (message.includes('may contain real person')) {
    return '动作参考视频被厂商判定包含真人。批量视频会自动生成姿态代理；单镜头请先选择姿态代理模式后再提交。'
  }
  return message
}

function candidateTime(candidate: MediaCandidate) {
  return new Date(candidate.createdAt).toLocaleString('zh-CN', { hour12: false })
}

function candidatePrompt(candidate: MediaCandidate) {
  return candidate.prompt || '无提示词'
}

async function rerunFromCandidate(candidate: MediaCandidate) {
  prompt.value = candidate.prompt || prompt.value
  notice.value = '已把候选提示词带回输入框，可以继续修改后重新生成'
}

async function deleteCandidate(candidate: MediaCandidate) {
  if (!window.confirm('确定删除这个候选吗？')) return
  error.value = ''
  try {
    if (candidate.id.startsWith('local-archive-') && candidate.localAssetId) {
      await desktop.removeAsset(candidate.localAssetId)
      candidates.value = candidates.value.filter((item) => item.id !== candidate.id)
      if (selectedCandidate.value?.id === candidate.id) closePreview()
      notice.value = '本地视频已删除'
      return
    }
    await mediaGenerationApi.delete(candidate.id, candidate.version)
    if (selectedCandidate.value?.id === candidate.id) closePreview()
    await loadCandidates({ autoSave: false })
    notice.value = '候选视频已删除'
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : '删除候选视频失败'
  }
}

async function saveCandidate(candidate: MediaCandidate) {
  if (candidate.localAssetId || candidate.status === 'LOCAL_SAVED') {
    notice.value = '该视频已经保存在本地项目目录'
    return
  }
  if (candidateSaveStates.value[candidate.id] === 'SAVING') return
  error.value = ''
  autoSavedCandidateIds.delete(candidate.id)
  setCandidateSaveState(candidate.id, 'SAVING')
  try {
    const selected =
      candidate.status === 'AVAILABLE'
        ? await mediaGenerationApi.select(candidate.id, candidate.version)
        : candidate
    replaceCandidate(selected)
    const saved = await persistCandidateToLocal(selected)
    replaceCandidate(saved)
    autoSavedCandidateIds.add(candidate.id)
    clearCandidateSaveState(candidate.id)
    notice.value = '视频已保存到本地'
  } catch (caught) {
    setCandidateSaveState(candidate.id, 'FAILED')
    error.value = caught instanceof Error ? caught.message : '保存视频到本地失败'
  }
}

async function downloadCandidate(candidate: MediaCandidate) {
  error.value = ''
  try {
    const blob = await ensurePreviewBlob(candidate)
    if (!blob) throw new Error('视频预览读取失败，请稍后重试')
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${candidate.modelName || 'video'}-${candidate.id.slice(0, 8)}${videoDownloadExtension(candidate.mimeType || blob.type)}`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : '下载视频失败'
  }
}

function videoDownloadExtension(mimeType?: string | null) {
  if (mimeType?.includes('webm')) return '.webm'
  if (mimeType?.includes('quicktime')) return '.mov'
  return '.mp4'
}

function onComposerKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  if (canGenerate.value) void generate()
}

function sleep(ms: number) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms))
}
</script>

<template>
  <StudioShell>
    <div class="video-lab-page">
      <header class="video-lab-toolbar">
        <div class="video-lab-toolbar-left">
          <span class="video-lab-chip active">
            <Film :size="15" />
            视频生成
          </span>
          <button
            class="video-lab-chip video-lab-model-chip"
            type="button"
            :title="selectedRouteSubLabel"
            @click="openRouteDialog"
          >
            <Sparkles :size="14" />
            <span>{{ selectedRouteLabel }}</span>
            <ChevronDown :size="13" />
          </button>
          <span v-if="jobStatusText" class="video-lab-chip" :class="{ running: jobActive }">
            <LoaderCircle v-if="jobActive" :size="14" class="spinner" />
            {{ jobStatusText }}<template v-if="jobActive"> · {{ job?.progress || 0 }}%</template>
          </span>
          <span class="video-lab-chip muted">{{ activeCandidateCount }} 个结果</span>
        </div>
        <div class="video-lab-toolbar-right">
          <label class="video-lab-search">
            <input v-model="query" type="search" placeholder="搜索提示词、模型、规格..." />
          </label>
          <button
            class="video-lab-icon-btn"
            type="button"
            title="刷新生成结果"
            :disabled="!bootstrap"
            @click="loadCandidates({ autoSave: false })"
          >
            <RefreshCw :size="15" />
          </button>
        </div>
      </header>

      <div v-if="notice || error" class="video-lab-toast-stack">
        <p v-if="notice" class="inline-success video-lab-banner" role="status">
          <span>{{ notice }}</span>
          <button type="button" title="关闭提示" @click="notice = ''"><X :size="13" /></button>
        </p>
        <p v-if="error" class="inline-error video-lab-banner" role="alert">
          <span>{{ error }}</span>
          <button type="button" title="关闭提示" @click="error = ''"><X :size="13" /></button>
        </p>
      </div>

      <div v-if="jobActive" class="video-lab-running-banner" role="status">
        <LoaderCircle :size="20" class="spinner" />
        <div>
          <strong>视频正在{{ jobStatusText }}</strong>
          <span
            >当前进度 {{ job?.progress || 0 }}%，切换页面不会中断，完成后会自动保存到本地。</span
          >
        </div>
        <progress :value="job?.progress || 0" max="100" />
      </div>

      <div v-if="poseProxyProgress" class="video-lab-pose-progress" role="status">
        <LoaderCircle :size="18" class="spinner" />
        <div>
          <strong>正在本地生成人物轮廓代理</strong>
          <span>{{ poseProxyProgress.message }}</span>
        </div>
        <progress :value="poseProxyProgress.progress" max="100" />
      </div>

      <main class="video-lab-board">
        <section v-if="poseProxyDrafts.length" class="video-lab-pose-gate">
          <header>
            <div>
              <span class="video-lab-section-kicker">提交前检查</span>
              <strong>人物轮廓动作代理</strong>
              <small>原视频只在本机逐帧识别，不调用厂商模型，不上传原视频，也不消耗点数。</small>
            </div>
            <button type="button" :disabled="generating" @click="regeneratePoseProxyDrafts">
              <RefreshCw :size="15" />重新提取
            </button>
          </header>
          <div class="video-lab-pose-steps" aria-label="动作参考处理流程">
            <div class="video-lab-pose-step done">
              <span>01</span>
              <div><strong>本地识别</strong><small>DWPose 全身关键点</small></div>
            </div>
            <div class="video-lab-pose-step done">
              <span>02</span>
              <div><strong>稳定轨迹</strong><small>补偿短暂遮挡与抖动</small></div>
            </div>
            <div class="video-lab-pose-step current">
              <span>03</span>
              <div><strong>用于正式视频</strong><small>自动带入动作参考</small></div>
            </div>
          </div>
          <div class="video-lab-pose-grid">
            <article v-for="draft in poseProxyDrafts" :key="draft.sourceReferenceId">
              <video :src="draft.previewUrl" controls playsinline preload="metadata" />
              <footer>
                <div>
                  <strong>{{ draft.sourceName }}</strong>
                  <small
                    ><ScanLine :size="12" />识别覆盖
                    {{ Math.round(draft.detectedFrameRatio * 100) }}%</small
                  >
                </div>
                <button
                  type="button"
                  title="下载这段轮廓代理"
                  @click="downloadPoseProxyDraft(draft)"
                >
                  <Download :size="15" />
                </button>
              </footer>
            </article>
          </div>
          <div class="video-lab-pose-gate-actions">
            <span>确认动作和轮廓没问题后，把它作为参考素材用于正式生视频。</span>
            <button
              class="video-lab-generate-btn"
              type="button"
              :disabled="generating"
              @click="usePoseProxyForFinalVideo"
            >
              <Sparkles :size="15" />
              用于生成正式视频
            </button>
          </div>
        </section>

        <div v-if="mode === 'POSE_PROXY' && !poseProxyDrafts.length" class="video-lab-empty-state">
          <ScanLine :size="30" />
          <strong>添加人物动作视频开始本机处理</strong>
          <p>原视频只在当前电脑逐帧分析，生成轮廓动作参考，全程免费且无需登录。</p>
        </div>

        <div v-else-if="!bootstrap" class="video-lab-empty-state">
          <LoaderCircle :size="22" class="spinner" />
          <strong>{{
            auth.isAuthenticated ? '正在初始化生视频工作区' : '平台视频服务尚未登录'
          }}</strong>
          <p v-if="!auth.isAuthenticated">
            可选择人物轮廓动作参考进行本机处理，或登录后使用平台模型。
          </p>
        </div>

        <div
          v-else-if="!filteredCandidates.length && !jobActive && !jobFailed"
          class="video-lab-empty-state"
        >
          <Film :size="30" />
          <strong>{{ candidates.length ? '没有匹配结果' : '还没有生成记录' }}</strong>
          <p>在底部描述镜头，可上传角色、场景、动作或声音参考，生成后会以视频卡片展示。</p>
        </div>

        <div v-else class="video-lab-card-grid">
          <article
            v-for="candidate in filteredCandidates"
            :key="candidate.id"
            class="video-lab-card"
            :class="{ active: selectedCandidate?.id === candidate.id }"
            @mouseenter="ensurePreview(candidate)"
            @click="openPreview(candidate)"
          >
            <div class="video-lab-card-media" title="点击预览视频">
              <video
                v-if="previewSource(candidate)"
                :src="previewSource(candidate)"
                muted
                playsinline
                preload="metadata"
              />
              <div v-else class="video-lab-card-placeholder">
                <LoaderCircle v-if="previewLoading[candidate.id]" :size="19" class="spinner" />
                <Film v-else :size="26" />
                <span>{{ previewLoading[candidate.id] ? '读取预览中' : '点击预览' }}</span>
              </div>
              <span class="video-lab-card-status">{{ statusLabel(candidate) }}</span>
              <div class="video-lab-card-meta">
                <strong>{{ generationModeLabel(candidate) }}</strong>
                <span>
                  {{
                    candidate.width && candidate.height
                      ? `${candidate.width}×${candidate.height}`
                      : videoSize
                  }}
                  <template v-if="candidate.durationMs">
                    · {{ Math.max(1, Math.round(candidate.durationMs / 1000)) }} 秒
                  </template>
                </span>
              </div>
              <div class="video-lab-card-actions">
                <button
                  type="button"
                  title="复用提示词"
                  @click.stop="rerunFromCandidate(candidate)"
                >
                  <RefreshCw :size="14" />
                </button>
                <button
                  v-if="
                    !candidate.localAssetId &&
                    candidate.status !== 'LOCAL_SAVED' &&
                    (!desktop.available || candidateSaveStates[candidate.id] === 'FAILED')
                  "
                  type="button"
                  :title="'重试保存到本地'"
                  :disabled="candidateSaveStates[candidate.id] === 'SAVING'"
                  @click.stop="saveCandidate(candidate)"
                >
                  <LoaderCircle
                    v-if="candidateSaveStates[candidate.id] === 'SAVING'"
                    :size="14"
                    class="spinner"
                  />
                  <HardDriveDownload v-else :size="14" />
                </button>
                <button type="button" title="下载" @click.stop="downloadCandidate(candidate)">
                  <Download :size="14" />
                </button>
                <button
                  type="button"
                  class="danger"
                  title="删除"
                  @click.stop="deleteCandidate(candidate)"
                >
                  <Trash2 :size="14" />
                </button>
              </div>
            </div>
          </article>

          <article v-if="jobActive" class="video-lab-card video-lab-card-pending">
            <div class="video-lab-card-media">
              <div class="video-lab-card-placeholder">
                <LoaderCircle :size="24" class="spinner" />
                <span>视频生成中</span>
              </div>
              <div class="video-lab-card-progress">
                <progress :value="job?.progress || 0" max="100" />
                <span>{{ job?.progress || 0 }}%</span>
              </div>
            </div>
          </article>

          <article v-if="jobFailed" class="video-lab-card video-lab-card-pending">
            <div class="video-lab-card-media">
              <div class="video-lab-card-placeholder">
                <Film :size="24" />
                <span>{{ jobStatusText }}</span>
              </div>
              <span class="video-lab-card-status">生成失败</span>
            </div>
          </article>
        </div>
      </main>

      <footer class="video-lab-composer" :class="{ expanded: references.length }">
        <div class="video-lab-composer-options">
          <div class="video-lab-mode-control">
            <span class="video-lab-control-label">生成模式</span>
            <div class="video-lab-mode-switch" role="group" aria-label="选择视频生成模式">
              <button
                v-for="item in modeOptions"
                :key="item.value"
                type="button"
                class="video-lab-mode-option"
                :class="{ active: mode === item.value }"
                :disabled="generating"
                :title="item.hint"
                :aria-pressed="mode === item.value"
                @click="mode = item.value"
              >
                <component :is="modeIcons[item.value]" :size="15" />
                <span>{{ item.label }}</span>
              </button>
            </div>
          </div>
          <button
            class="video-lab-model-select"
            type="button"
            :disabled="generating || mode === 'POSE_PROXY'"
            @click="openRouteDialog"
          >
            <span>模型</span>
            <strong>{{ selectedRouteLabel }}</strong>
            <small>{{ mode === 'POSE_PROXY' ? '本机处理 · 免费' : '点击切换' }}</small>
            <ChevronDown v-if="mode !== 'POSE_PROXY'" :size="14" />
          </button>
          <label class="video-lab-option-aspect">
            <span>画幅</span>
            <select v-model="aspectRatio" class="video-lab-select compact" :disabled="generating">
              <option v-for="item in aspectOptions" :key="item.value" :value="item.value">
                {{ item.label }}
              </option>
            </select>
          </label>
          <label class="video-lab-option-resolution">
            <span>清晰度</span>
            <select v-model="resolution" class="video-lab-select compact" :disabled="generating">
              <option v-for="item in resolutionOptions" :key="item.value" :value="item.value">
                {{ item.label }}
              </option>
            </select>
          </label>
          <label class="video-lab-duration-input">
            <span>时长</span>
            <input
              v-model.number="manualDurationSec"
              type="number"
              min="1"
              max="300"
              step="1"
              :disabled="generating"
            />
            <span>秒</span>
          </label>
          <span class="video-lab-credit-line" :class="{ danger: quoteError }">{{
            currentQuoteText
          }}</span>
        </div>

        <div v-if="references.length" class="video-lab-reference-strip">
          <article
            v-for="(item, index) in references"
            :key="item.id"
            class="video-lab-reference-card"
          >
            <div class="video-lab-reference-thumb">
              <img v-if="item.mediaType === 'IMAGE'" :src="item.previewUrl" :alt="item.file.name" />
              <video
                v-else-if="item.mediaType === 'VIDEO'"
                :src="item.previewUrl"
                muted
                playsinline
              />
              <FileAudio v-else :size="18" />
            </div>
            <div class="video-lab-reference-fields">
              <div>
                <strong :title="item.file.name">{{ item.file.name }}</strong>
                <small>{{ referenceMediaLabel(item.mediaType) }}</small>
              </div>
              <select v-model="item.purpose" :aria-label="`${item.file.name} 的用途`">
                <option v-if="item.mediaType === 'IMAGE'" value="FIRST_FRAME">首帧</option>
                <option value="CHARACTER">角色</option>
                <option value="SCENE">场景</option>
                <option value="BACKGROUND">背景</option>
                <option value="WEAPON">武器</option>
                <option value="COSTUME">服装</option>
                <option value="MOTION">动作</option>
                <option value="EXPRESSION">表情</option>
                <option value="AUDIO">声音</option>
                <option value="STYLE">风格</option>
                <option value="OTHER">其他</option>
              </select>
              <input
                v-model="item.note"
                type="text"
                maxlength="200"
                placeholder="说明它在视频中的作用"
              />
            </div>
            <button type="button" title="移除素材" @click="removeReference(index)">
              <X :size="13" />
            </button>
          </article>
          <button class="video-lab-clear-references" type="button" @click="clearReferences">
            清空全部
          </button>
        </div>

        <div class="video-lab-composer-main">
          <textarea
            v-model="prompt"
            rows="1"
            maxlength="20000"
            placeholder="描述镜头内容、角色动作、运镜、节奏和画面风格..."
            :disabled="generating || !bootstrap"
            @keydown="onComposerKeydown"
          />
          <div class="video-lab-composer-actions">
            <input
              ref="referenceInput"
              type="file"
              multiple
              hidden
              accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,video/quicktime,audio/mpeg,audio/wav,audio/x-wav,audio/aac,audio/mp4,audio/ogg,audio/flac,.png,.jpg,.jpeg,.webp,.mp4,.webm,.mov,.mp3,.wav,.aac,.m4a,.ogg,.flac"
              @change="onReferenceSelected"
            />
            <button
              class="video-lab-icon-btn"
              :class="{ active: activeExpressionPrompt }"
              type="button"
              title="设置角色表情与面部表演"
              :disabled="generating"
              @click="openExpressionControl"
            >
              <Smile :size="16" />
            </button>
            <button
              class="video-lab-icon-btn"
              type="button"
              :title="referenceModeWarning"
              :disabled="generating"
              @click="triggerReferencePicker"
            >
              <Upload :size="16" />
            </button>
            <button
              class="video-lab-generate-btn"
              type="button"
              :disabled="!canGenerate"
              @click="generate"
            >
              <LoaderCircle v-if="generating" :size="15" class="spinner" />
              <Sparkles v-else :size="15" />
              {{ generateButtonLabel }}
            </button>
          </div>
        </div>
        <small class="video-lab-composer-tip">
          {{ currentModeHint }} · {{ references.length }} 个参考素材 · {{ videoSize }} ·
          {{ activeDurationSec }} 秒<span v-if="activeExpressionPrompt"> · 已加入表情控制</span>
        </small>
      </footer>
    </div>

    <GenerationRouteDialog
      :open="routeOpen"
      :initial-route="route"
      service-type="VIDEO"
      eyebrow="生视频"
      title="选择本次生视频模型"
      submit-label="使用这个模型"
      :quote-prompt="generationPrompt"
      :quote-parameters="videoQuoteParameters()"
      @close="routeOpen = false"
      @submit="setRoute"
    />

    <GenerationRouteDialog
      :open="expressionRouteOpen"
      :initial-route="expressionRoute"
      service-type="TEXT"
      eyebrow="表情优化"
      title="选择表情描述优化模型"
      submit-label="使用并优化"
      :submitting="expressionOptimizing"
      :quote-prompt="expressionText || expressionDraft"
      @close="expressionRouteOpen = false"
      @submit="setExpressionRoute"
    />

    <div
      v-if="expressionOpen"
      class="video-lab-preview-backdrop"
      @click.self="closeExpressionControl"
    >
      <section class="video-lab-expression-modal" role="dialog" aria-modal="true">
        <header>
          <div>
            <p>表情控制</p>
            <h3>把情绪变成模型能执行的面部动作</h3>
          </div>
          <button type="button" class="video-lab-preview-close" @click="closeExpressionControl">
            <X :size="16" />
          </button>
        </header>
        <div class="video-lab-expression-grid">
          <label>
            <span>情绪类型</span>
            <select v-model="expressionEmotion">
              <option value="RESTRAINED_ANGER">压抑愤怒</option>
              <option value="GRIEF">悲伤哭腔</option>
              <option value="FEAR">紧张恐惧</option>
              <option value="SHOCK">震惊错愕</option>
              <option value="DISTANT">冷漠疏离</option>
              <option value="GENTLE_JOY">温柔喜悦</option>
              <option value="CUSTOM">自定义</option>
            </select>
          </label>
          <label>
            <span>视线方向</span>
            <select v-model="expressionGaze">
              <option value="LOCK_TARGET">锁定对方</option>
              <option value="AVOID">避开视线</option>
              <option value="CAMERA">看向镜头</option>
              <option value="DOWN">低头垂眼</option>
              <option value="FOLLOW_ACTION">跟随动作</option>
            </select>
          </label>
          <label class="video-lab-expression-intensity">
            <span>表情强度 {{ expressionIntensity }}/5</span>
            <input v-model.number="expressionIntensity" type="range" min="1" max="5" step="1" />
          </label>
          <label class="wide">
            <span>补充表演要求</span>
            <input
              v-model="expressionNote"
              type="text"
              maxlength="500"
              placeholder="例如：说话前停顿半秒，鼻翼随加重呼吸轻微起伏"
            />
          </label>
        </div>
        <label class="video-lab-expression-output">
          <span>最终表情提示词</span>
          <textarea v-model="expressionText" rows="5" maxlength="1200" />
        </label>
        <footer>
          <div>
            <button
              type="button"
              :disabled="expressionOptimizing"
              @click="requestExpressionOptimization"
            >
              <LoaderCircle v-if="expressionOptimizing" :size="14" class="spinner" />
              <Sparkles v-else :size="14" />
              {{ expressionOptimizing ? '优化中' : 'AI 优化' }}
            </button>
            <button
              type="button"
              :disabled="expressionOptimizing"
              @click="expressionRouteOpen = true"
            >
              <ChevronDown :size="14" />更换文本模型
            </button>
          </div>
          <div>
            <button v-if="activeExpressionPrompt" type="button" @click="clearExpressionControl">
              移除
            </button>
            <button class="primary" type="button" @click="applyExpressionControl">
              应用到提示词
            </button>
          </div>
        </footer>
      </section>
    </div>

    <div v-if="selectedCandidate" class="video-lab-preview-backdrop" @click.self="closePreview">
      <section class="video-lab-preview-modal" role="dialog" aria-modal="true">
        <header>
          <div>
            <p>{{ statusLabel(selectedCandidate) }} · {{ candidateTime(selectedCandidate) }}</p>
            <h3>{{ selectedCandidate.modelName }}</h3>
          </div>
          <button type="button" class="video-lab-preview-close" @click="closePreview">
            <X :size="16" />
          </button>
        </header>
        <div class="video-lab-preview-stage">
          <video
            v-if="previewSource(selectedCandidate)"
            :src="previewSource(selectedCandidate)"
            controls
            autoplay
            playsinline
          />
          <div v-else class="video-lab-preview-loading">
            <LoaderCircle :size="20" class="spinner" />
            <span>正在加载预览</span>
          </div>
        </div>
        <footer>
          <p>{{ selectedCandidate.prompt }}</p>
          <div>
            <button type="button" @click="rerunFromCandidate(selectedCandidate)">复用提示词</button>
            <button
              v-if="
                !selectedCandidate.localAssetId &&
                selectedCandidate.status !== 'LOCAL_SAVED' &&
                (!desktop.available || candidateSaveStates[selectedCandidate.id] === 'FAILED')
              "
              type="button"
              :disabled="candidateSaveStates[selectedCandidate.id] === 'SAVING'"
              @click="saveCandidate(selectedCandidate)"
            >
              <HardDriveDownload :size="14" />
              <span>{{ '重试保存' }}</span>
            </button>
            <button type="button" @click="downloadCandidate(selectedCandidate)">
              <Download :size="14" />
              <span>下载</span>
            </button>
            <button type="button" @click="deleteCandidate(selectedCandidate)">
              <Trash2 :size="14" />
              <span>删除</span>
            </button>
          </div>
        </footer>
      </section>
    </div>
  </StudioShell>
</template>
