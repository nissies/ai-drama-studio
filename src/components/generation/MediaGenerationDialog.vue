<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  AudioLines,
  Check,
  Download,
  FileAudio,
  FileImage,
  FileVideo,
  Film,
  LoaderCircle,
  Music2,
  RefreshCw,
  Sparkles,
  Trash2,
  Upload,
  WandSparkles,
  Volume2,
  X,
} from 'lucide-vue-next'
import {
  generationApi,
  startLocalJobHeartbeat,
  type GenerationJob,
  type GenerationRoute,
} from '../../api/generation'
import {
  mediaGenerationApi,
  type MediaCandidate,
  type MediaType,
  type UploadedMediaReference,
} from '../../api/media-generation'
import { mediaAssetApi } from '../../api/assets'
import { platformModelCatalogApi, type PlatformModelCatalogItem } from '../../api/model-catalog'
import { voiceCatalogApi, type VoiceCatalogOption } from '../../api/voice-catalog'
import { loadBrowserImage, loadBrowserMedia } from '../../browser/browser-image-store'
import {
  deleteBrowserMotionAsset,
  listBrowserMotionAssets,
  loadBrowserMotionAsset,
  saveBrowserMotionAsset,
  type BrowserMotionAssetMeta,
} from '../../browser/browser-motion-library'
import {
  MOTION_SHOT_TEMPLATES,
  type MotionShotTemplateId,
} from '../../domain/motion-shot-templates'
import { latestActiveGenerationJob } from '../../domain/active-generation-job'
import {
  generationRouteModelCode,
  grokVideoMode,
  grokVideoReferenceError,
  isGrokCompatibleRoute,
  type GrokVideoMode,
} from '../../domain/grok-video'
import type { EffectiveProjectAspectRatio } from '../../domain/project-frame-profile'
import type { StoryboardMediaReferencePurpose } from '../../domain/storyboard-media-references'
import type { StoryboardAudioMode } from '../../api/workspace'
import { extractStoryboardVideoFrames } from '../../domain/storyboard-video-frames'
import { createLocalPoseProxy } from '../../desktop/pose-proxy'
import type { LocalAsset, PoseProxyProgress } from '../../desktop/types'
import { executeTextGeneration } from '../../composables/text-generation'
import {
  DEFAULT_VOICE_PRESET,
  isVoicePreset,
  voicePresetLabel,
  VOICE_PRESETS,
} from '../../domain/voice-presets'
import { useDesktopStore } from '../../stores/desktop'
import { useWorkspaceStore } from '../../stores/workspace'
import { mapSettledWithConcurrency } from '../../utils/concurrency'
import { fileExtension, normalizeImageBlob, normalizeImageFile } from '../../utils/image-files'
import GenerationRouteDialog from './GenerationRouteDialog.vue'

const props = defineProps<{
  open: boolean
  projectId: string
  storyboardId: string
  title: string
  mediaType: MediaType
  initialPrompt: string
  durationSec: number
  linkedReferences?: Array<{ assetId: string; label: string }>
  linkedMediaReferences?: Array<{
    assetId?: string
    candidateId?: string
    label: string
    purpose?: StoryboardMediaReferencePurpose
  }>
  aspectRatio?: EffectiveProjectAspectRatio
  outputSize?: string
  audioMode?: StoryboardAudioMode
  speakerName?: string
  speakerCharacterId?: string
  initialVoice?: string
  initialInstructions?: string
}>()
const emit = defineEmits<{ close: []; referenced: []; backgrounded: [jobId: string] }>()

const desktop = useDesktopStore()
const workspace = useWorkspaceStore()
const prompt = ref('')
const voice = ref(DEFAULT_VOICE_PRESET)
const instructions = ref('')
const speed = ref(1)
const ttsModels = ref<PlatformModelCatalogItem[]>([])
const selectedTtsModelId = ref('')
const voiceOptions = ref<VoiceCatalogOption[]>([])
const voiceOptionsLoading = ref(false)
const cloneVoiceOpen = ref(false)
const cloneVoiceFile = ref<File | null>(null)
const cloneVoiceName = ref('')
const cloneVoiceTranscript = ref('')
const cloningVoice = ref(false)
const clonedVoiceResult = ref<VoiceCatalogOption | null>(null)
const clonedVoicePreviewUrl = ref('')
const clonedVoicePreviewLoading = ref(false)
const routeOpen = ref(false)
const instructionRouteOpen = ref(false)
const instructionGenerating = ref(false)
const instructionJob = ref<GenerationJob | null>(null)
const submitting = ref(false)
const restoringJob = ref(false)
const loading = ref(false)
const actingId = ref('')
const error = ref('')
const job = ref<GenerationJob | null>(null)
const candidates = ref<MediaCandidate[]>([])
const referenceInput = ref<globalThis.HTMLInputElement>()
const referenceLoading = ref(false)
const referenceNotice = ref('')
const autoSaveNotice = ref('')
const showProjectReferencePicker = ref(false)
const projectReferenceQuery = ref('')
const projectReferenceAddingId = ref('')
const projectReferenceBindingType = ref<ProjectReferenceBindingType>('AUTO')
const projectReferenceBindingTargetId = ref('')
const projectReferenceBindingPurpose = ref<StoryboardMediaReferencePurpose | ''>('')
type MotionPipelineMode = 'normal' | 'direct' | 'pose_proxy'
const motionMode = ref<MotionPipelineMode>('normal')
const showAdvancedMotion = ref(false)
const motionStage = ref('')
const poseProxyProgress = ref<PoseProxyProgress | null>(null)
const poseGateActive = ref(false)
const poseGateBusy = ref(false)
const poseGatePreviewUrl = ref('')
const poseGateRoute = ref<GenerationRoute | null>(null)
const poseGateParentJobId = ref('')
const preparedPoseProxyFiles = new Map<globalThis.File, globalThis.File>()
const motionAssets = ref<BrowserMotionAssetMeta[]>([])
const motionAssetsLoading = ref(false)
const motionAssetActingId = ref('')
const selectedMotionTemplateId = ref<MotionShotTemplateId | ''>('')
const pipelineLinkNotice = ref('')
const referenceItems = ref<VideoReferenceItem[]>([])
const remotePreviews = new Map<string, string>()
const previewVersion = ref(0)
const PLATFORM_POLL_INTERVAL_MS = 1_500
const PLATFORM_POLL_ATTEMPTS = 1_240
const MAX_REFERENCE_FILES = 20
const MAX_IMAGE_REFERENCE_BYTES = 10 * 1024 * 1024
const MAX_MEDIA_REFERENCE_BYTES = 50 * 1024 * 1024
const MAX_REFERENCE_TOTAL_BYTES = 100 * 1024 * 1024
const autoSaveAttemptedIds = new Set<string>()
const autoSaveFailedIds = ref(new Set<string>())
const SUPPORTED_VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime'])
const SUPPORTED_AUDIO_TYPES = new Set([
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/aac',
  'audio/mp4',
  'audio/ogg',
  'audio/flac',
])
const REFERENCE_MIME_BY_EXTENSION = new Map<string, string>([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.mov', 'video/quicktime'],
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.aac', 'audio/aac'],
  ['.m4a', 'audio/mp4'],
  ['.ogg', 'audio/ogg'],
  ['.flac', 'audio/flac'],
])
let referenceLoadVersion = 0
let detached = false

type ReferenceMediaType = UploadedMediaReference['mediaType']
type UploadedReferenceIds = {
  referenceImageIds: string[]
  referenceVideoIds: string[]
  referenceAudioIds: string[]
}
type ProjectReferenceAsset = {
  id: string
  label: string
  mimeType: string
  sizeBytes: number
  registered: boolean
  fileAvailable: boolean
  semanticHint: string
  inferredBinding?: InferredReferenceBinding
}
type ManualReferenceBindingType =
  'CHARACTER' | 'SCENE' | 'BACKGROUND' | 'PROP' | 'WEAPON' | 'MOTION' | 'VOICE' | 'SFX' | 'STYLE'
type ProjectReferenceBindingType = ManualReferenceBindingType | 'AUTO'
type ReferenceBindingOption = { value: string; label: string }
type InferredReferenceBinding = {
  bindingType: ManualReferenceBindingType
  bindingTargetId?: string
  bindingLabel: string
  purpose?: StoryboardMediaReferencePurpose
  usageNote?: string
}

interface VideoReferenceItem {
  file: globalThis.File
  mediaType: ReferenceMediaType
  label: string
  previewUrl: string
  linked: boolean
  selected: boolean
  purpose?: StoryboardMediaReferencePurpose
  assetId?: string
  candidateId?: string
  bindingType?: ManualReferenceBindingType
  bindingTargetId?: string
  bindingLabel?: string
  usageNote?: string
}

const isVideo = computed(() => props.mediaType === 'VIDEO')
const hasCustomVoice = computed(() => Boolean(voice.value && !isVoicePreset(voice.value)))
const selectedVoiceOption = computed(() =>
  voiceOptions.value.find((item) => item.id === voice.value),
)
const selectedClonedVoice = computed(() =>
  selectedVoiceOption.value?.type === 'CLONED' ? selectedVoiceOption.value : null,
)
const currentStoryboard = computed(() =>
  workspace.storyboards.find((item) => item.id === props.storyboardId),
)
const currentStoryboardCharacters = computed(() => {
  const ids = new Set(currentStoryboard.value?.characterIds ?? [])
  return workspace.characters
    .filter((character) => ids.has(character.id))
    .concat(workspace.characters.filter((character) => !ids.has(character.id)))
})
const currentStoryboardScene = computed(() => {
  const sceneId = currentStoryboard.value?.sceneId
  return sceneId ? workspace.scenes.find((scene) => scene.id === sceneId) : undefined
})
const currentStoryboardScenes = computed(() => {
  const currentId = currentStoryboardScene.value?.id
  return currentId
    ? workspace.scenes
        .filter((scene) => scene.id === currentId)
        .concat(workspace.scenes.filter((scene) => scene.id !== currentId))
    : workspace.scenes
})
const activeReferenceItems = computed(() => referenceItems.value.filter((item) => item.selected))
const poseProxyEnabled = computed(() => isVideo.value && motionMode.value === 'pose_proxy')
const motionEnhanced = computed(() => isVideo.value && motionMode.value !== 'normal')
const hasMotionReference = computed(() =>
  activeReferenceItems.value.some(
    (item) =>
      item.mediaType === 'VIDEO' &&
      (item.purpose === 'MOTION_REFERENCE' || item.purpose === 'POSE_PROXY'),
  ),
)
const hasVoiceIdentityReference = computed(() =>
  referenceItems.value.some((item) => item.purpose === 'VOICE_IDENTITY'),
)
const hasBackgroundAudioReference = computed(() =>
  referenceItems.value.some((item) => item.purpose === 'BACKGROUND_AUDIO'),
)
const voiceReferenceStatus = computed(() => {
  if (hasVoiceIdentityReference.value) {
    return `已关联${props.speakerName ? `“${props.speakerName}”` : '当前说话角色'}的主声音样本`
  }
  if (props.audioMode !== 'VIDEO_NATIVE') return '当前为后期 AI 配音，视频生成不自动发送角色声音'
  if (props.speakerName) {
    return `“${props.speakerName}”尚未保存主声音样本，请到角色资产页提取或上传声音`
  }
  return '未指定说话角色，请先在分镜编辑中选择说话角色'
})
const backgroundAudioStatus = computed(() => {
  if (hasBackgroundAudioReference.value) return '已关联当前分镜背景音频'
  if (props.audioMode !== 'VIDEO_NATIVE')
    return '视频将生成环境声和动作音效，角色对白在后期配音并与环境声混合'
  return '未关联：可在分镜中从视频提取背景音频，或在上方上传音频'
})
const projectReferenceAssets = computed<ProjectReferenceAsset[]>(() => {
  const keyword = projectReferenceQuery.value.trim().toLowerCase()
  const fromLocal = (desktop.project?.assets ?? [])
    .filter((asset) => isSupportedProjectReferenceMime(asset.mimeType))
    .map((asset) =>
      projectReferenceAssetView({
        id: asset.id,
        label: asset.originalName,
        mimeType: asset.mimeType,
        sizeBytes: asset.sizeBytes,
        registered: Boolean(workspace.mediaAssetById(asset.id)),
        fileAvailable: asset.fileAvailable,
      }),
    )
  const localIds = new Set(fromLocal.map((asset) => asset.id))
  const fromServer = workspace.mediaAssets
    .filter((asset) => !localIds.has(asset.id) && isSupportedProjectReferenceMime(asset.mimeType))
    .map((asset) =>
      projectReferenceAssetView({
        id: asset.id,
        label: asset.originalFilename,
        mimeType: asset.mimeType,
        sizeBytes: asset.sizeBytes,
        registered: true,
        fileAvailable: Boolean(asset.contentAvailable || asset.storageScope === 'SERVER'),
      }),
    )
  return [...fromLocal, ...fromServer]
    .filter((asset) => !keyword || asset.label.toLowerCase().includes(keyword))
    .sort((left, right) => Number(right.fileAvailable) - Number(left.fileAvailable))
})
const projectReferenceBindingTargets = computed(() =>
  bindingTargetOptions(projectReferenceBindingType.value),
)

function projectReferenceAssetView(
  asset: Omit<ProjectReferenceAsset, 'semanticHint' | 'inferredBinding'>,
): ProjectReferenceAsset {
  const inferredBinding = inferBindingForAsset(asset.id, referenceMediaType(asset.mimeType), false)
  return {
    ...asset,
    inferredBinding,
    semanticHint: inferredBinding?.bindingLabel ?? '未识别身份，添加前请选择它属于谁、干什么',
  }
}
const actionLabel = computed(() => {
  if (!isVideo.value) {
    return candidates.value.length ? '重新生成配音' : '生成配音'
  }
  if (poseProxyEnabled.value) {
    if (poseGateActive.value) return '继续生成最终成片'
    return '生成人物轮廓预览'
  }
  if (motionMode.value === 'direct')
    return candidates.value.length ? '按动作参考重生成' : '按动作参考生成'
  return candidates.value.length ? '重新生成视频' : '生成视频'
})
const preferredTtsRoute = computed<GenerationRoute | null>(() =>
  !isVideo.value && selectedTtsModelId.value
    ? { sourceType: 'PLATFORM', platformModelId: selectedTtsModelId.value }
    : null,
)

async function runPrimaryGeneration() {
  if (poseGateActive.value) {
    await confirmPoseProxyAndContinue()
    return
  }
  if (isVideo.value) {
    routeOpen.value = true
    return
  }
  const route = preferredTtsRoute.value
  if (!route) {
    error.value = '请先选择配音模型'
    return
  }
  await generate(route)
}
const poseGateReady = computed(() => {
  const videos = activeReferenceItems.value.filter((item) => item.mediaType === 'VIDEO')
  return (
    poseGateActive.value &&
    videos.length > 0 &&
    videos.every((item) => preparedPoseProxyFiles.has(item.file)) &&
    Boolean(poseGateRoute.value)
  )
})
const outputType = computed(() => (isVideo.value ? 'VIDEO' : 'VOICE') as const)
const category = computed(() => (isVideo.value ? 'videos' : 'audio') as const)
const jobType = computed<GenerationJob['jobType']>(() =>
  isVideo.value ? 'VIDEO_GENERATION' : 'TTS_GENERATION',
)
const referenceSummary = computed(() => {
  const imageCount = activeReferenceItems.value.filter((item) => item.mediaType === 'IMAGE').length
  const videoCount = activeReferenceItems.value.filter((item) => item.mediaType === 'VIDEO').length
  const audioCount = activeReferenceItems.value.filter((item) => item.mediaType === 'AUDIO').length
  if (!imageCount && !videoCount && !audioCount) return '未添加'
  return [
    imageCount ? `${imageCount} 图` : '',
    videoCount ? `${videoCount} 视频` : '',
    audioCount ? `${audioCount} 音频` : '',
  ]
    .filter(Boolean)
    .join(' / ')
})

watch(
  () => props.open,
  (open) => {
    routeOpen.value = false
    instructionRouteOpen.value = false
    cloneVoiceOpen.value = false
    if (!open) {
      detached = true
      releasePreviews()
      return
    }
    detached = false
    prompt.value = props.initialPrompt.trim()
    motionMode.value = 'normal'
    showAdvancedMotion.value = false
    motionStage.value = ''
    poseProxyProgress.value = null
    selectedMotionTemplateId.value = ''
    pipelineLinkNotice.value = ''
    clearPoseGate({ revokePreview: true })
    voice.value = props.initialVoice?.trim() || DEFAULT_VOICE_PRESET
    instructions.value = props.initialInstructions?.trim() || ''
    instructionJob.value = null
    clearReferenceItems()
    referenceNotice.value = ''
    autoSaveNotice.value = ''
    error.value = ''
    job.value = null
    if (isVideo.value) {
      void loadAutomaticReferences()
      void loadMotionAssets()
    }
    if (!isVideo.value) void loadTtsModelsAndVoices()
    void loadCandidates()
    void restoreActiveJob()
  },
  { immediate: true },
)

watch(projectReferenceBindingType, () => {
  projectReferenceBindingTargetId.value = defaultBindingTargetId(projectReferenceBindingType.value)
})

watch(selectedTtsModelId, () => {
  if (!isVideo.value && props.open) void loadVoiceOptions()
})

watch(motionMode, (mode) => {
  if (!isVideo.value) return
  if (mode !== 'pose_proxy' && poseGateActive.value) {
    clearPoseGate({ revokePreview: true })
    motionStage.value = ''
  }
  if (mode === 'normal') return
  referenceItems.value.forEach((item) => {
    if (item.mediaType === 'VIDEO' && !item.linked && !item.purpose) {
      item.purpose = 'MOTION_REFERENCE'
      item.selected = true
    }
  })
})

async function loadTtsModelsAndVoices() {
  try {
    ttsModels.value = await platformModelCatalogApi.list('TTS')
    if (!ttsModels.value.some((item) => item.id === selectedTtsModelId.value)) {
      selectedTtsModelId.value =
        ttsModels.value.find((item) => item.creditPrice)?.id ?? ttsModels.value[0]?.id ?? ''
    }
    await loadVoiceOptions()
  } catch (caught) {
    error.value = messageFor(caught, '配音模型或音色读取失败')
  }
}

async function loadVoiceOptions() {
  const modelId = selectedTtsModelId.value
  if (!modelId) {
    voiceOptions.value = []
    return
  }
  voiceOptionsLoading.value = true
  try {
    voiceOptions.value = await voiceCatalogApi.list(
      props.projectId,
      modelId,
      props.speakerCharacterId,
    )
    if (
      !isVoicePreset(voice.value) &&
      !voiceOptions.value.some((item) => item.id === voice.value)
    ) {
      voice.value = DEFAULT_VOICE_PRESET
    }
  } catch (caught) {
    voiceOptions.value = []
    error.value = messageFor(caught, '音色列表读取失败')
  } finally {
    voiceOptionsLoading.value = false
  }
}

async function chooseCloneVoiceFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0] ?? null
  input.value = ''
  if (!file) return
  const extension = file.name.split('.').pop()?.toLowerCase()
  if (!extension || !['mp3', 'm4a', 'wav'].includes(extension)) {
    error.value = '音色复刻仅支持 MP3、M4A 或 WAV'
    return
  }
  if (file.size > 20 * 1024 * 1024) {
    error.value = '音色复刻样本不能超过 20MB'
    return
  }
  try {
    const duration = await audioFileDuration(file)
    if (duration < 10 || duration > 300) {
      error.value = '音色复刻样本时长必须在 10 秒至 5 分钟之间'
      return
    }
  } catch {
    error.value = '无法读取音频时长，请换用有效的 MP3、M4A 或 WAV 文件'
    return
  }
  cloneVoiceFile.value = file
  clearClonedVoicePreview()
  clonedVoiceResult.value = null
  if (!cloneVoiceName.value.trim()) {
    cloneVoiceName.value = `${props.speakerName || '角色'}专属音色`
  }
  cloneVoiceOpen.value = true
  error.value = ''
}

function audioFileDuration(file: File) {
  return new Promise<number>((resolve, reject) => {
    const url = globalThis.URL.createObjectURL(file)
    const audio = new Audio()
    const cleanup = () => {
      audio.removeAttribute('src')
      globalThis.URL.revokeObjectURL(url)
    }
    audio.onloadedmetadata = () => {
      const duration = audio.duration
      cleanup()
      if (Number.isFinite(duration)) resolve(duration)
      else reject(new Error('音频时长无效'))
    }
    audio.onerror = () => {
      cleanup()
      reject(new Error('音频读取失败'))
    }
    audio.preload = 'metadata'
    audio.src = url
  })
}

async function cloneVoice() {
  if (
    cloningVoice.value ||
    !selectedTtsModelId.value ||
    !cloneVoiceFile.value ||
    !cloneVoiceName.value.trim()
  ) {
    return
  }
  cloningVoice.value = true
  error.value = ''
  try {
    const cloned = await voiceCatalogApi.clone({
      projectId: props.projectId,
      platformModelId: selectedTtsModelId.value,
      characterId: props.speakerCharacterId,
      displayName: cloneVoiceName.value.trim(),
      transcript: cloneVoiceTranscript.value.trim() || undefined,
      audio: cloneVoiceFile.value,
    })
    voiceOptions.value = [cloned, ...voiceOptions.value.filter((item) => item.id !== cloned.id)]
    clonedVoiceResult.value = cloned
    await loadClonedVoicePreview(cloned)
    autoSaveNotice.value = '专属音色复刻成功，请先试听，确认后再使用'
  } catch (caught) {
    error.value = messageFor(caught, '音色复刻失败')
  } finally {
    cloningVoice.value = false
  }
}

async function loadClonedVoicePreview(option: VoiceCatalogOption) {
  if (!option.previewAvailable || clonedVoicePreviewLoading.value) return
  clonedVoicePreviewLoading.value = true
  clearClonedVoicePreview()
  try {
    const blob = await voiceCatalogApi.preview(option.id)
    clonedVoicePreviewUrl.value = globalThis.URL.createObjectURL(blob)
  } catch (caught) {
    error.value = messageFor(caught, '复刻成功，但试听读取失败')
  } finally {
    clonedVoicePreviewLoading.value = false
  }
}

function clearClonedVoicePreview() {
  if (clonedVoicePreviewUrl.value) globalThis.URL.revokeObjectURL(clonedVoicePreviewUrl.value)
  clonedVoicePreviewUrl.value = ''
}

async function useClonedVoice(option: VoiceCatalogOption) {
  voice.value = option.id
  if (props.speakerCharacterId) {
    const character = workspace.characters.find((item) => item.id === props.speakerCharacterId)
    if (character) {
      await workspace.saveCharacter(
        props.projectId,
        {
          name: character.name,
          roleType: character.roleType,
          description: character.description,
          identityPrompt: character.identityPrompt,
          negativePrompt: character.negativePrompt,
          voiceDescription: character.voiceDescription,
          ttsVoiceId: option.id,
          version: character.version,
        },
        character.id,
      )
    }
  }
  cloneVoiceOpen.value = false
  cloneVoiceFile.value = null
  cloneVoiceTranscript.value = ''
  autoSaveNotice.value = props.speakerName
    ? `已试听并绑定“${props.speakerName}”的专属音色`
    : '已选为本次配音音色'
}

async function previewSelectedClonedVoice() {
  if (!selectedClonedVoice.value) return
  clonedVoiceResult.value = selectedClonedVoice.value
  cloneVoiceFile.value = null
  cloneVoiceOpen.value = true
  await loadClonedVoicePreview(selectedClonedVoice.value)
}

function downloadClonedVoicePreview(option: VoiceCatalogOption) {
  if (!clonedVoicePreviewUrl.value) return
  const anchor = globalThis.document.createElement('a')
  anchor.href = clonedVoicePreviewUrl.value
  anchor.download = `${option.name || '复刻音色'}-试听.mp3`
  globalThis.document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

async function deleteClonedVoice(option: VoiceCatalogOption) {
  if (!globalThis.confirm(`确定删除“${option.name}”吗？删除后会解除角色绑定。`)) return
  try {
    await voiceCatalogApi.delete(option.id)
    voiceOptions.value = voiceOptions.value.filter((item) => item.id !== option.id)
    workspace.characters
      .filter((character) => character.ttsVoiceId === option.id)
      .forEach((character) => {
        character.ttsVoiceId = ''
      })
    if (voice.value === option.id) voice.value = DEFAULT_VOICE_PRESET
    if (clonedVoiceResult.value?.id === option.id) {
      clonedVoiceResult.value = null
      cloneVoiceOpen.value = false
      clearClonedVoicePreview()
    }
    autoSaveNotice.value = '音色已删除，原角色已解除该音色绑定'
  } catch (caught) {
    error.value = messageFor(caught, '删除复刻音色失败')
  }
}

onBeforeUnmount(() => {
  detached = true
  referenceLoadVersion += 1
  clearReferenceItems()
  clearPoseGate({ revokePreview: true })
  releasePreviews()
  clearClonedVoicePreview()
  poseProxyProgress.value = null
  autoSaveAttemptedIds.clear()
  autoSaveFailedIds.value = new Set()
})

async function loadCandidates(options: { autoSave?: boolean } = {}) {
  if (detached || !props.open) return
  loading.value = true
  error.value = ''
  try {
    const loaded = await mediaGenerationApi.list(
      props.projectId,
      props.storyboardId,
      props.mediaType,
    )
    if (detached) return
    candidates.value = loaded
    if (options.autoSave !== false) await autoSaveLatestCandidate()
    void loadRemotePreviews()
  } catch (caught) {
    error.value = messageFor(caught, '媒体候选读取失败')
  } finally {
    loading.value = false
  }
}

async function generate(route: GenerationRoute) {
  if (!prompt.value.trim() || submitting.value || restoringJob.value || referenceLoading.value)
    return
  if (poseGateActive.value) {
    await confirmPoseProxyAndContinue()
    return
  }
  const selectedGrokMode = isVideo.value
    ? grokVideoMode(generationRouteModelCode(route))
    : null
  if (selectedGrokMode && motionEnhanced.value) {
    error.value =
      '当前 Grok 视频模型不支持动作参考或姿态代理，请切换为普通生成，或选择支持动作参考的视频模型'
    routeOpen.value = false
    return
  }
  const grokReferenceError = validateGrokRouteReferences(
    selectedGrokMode,
    isGrokCompatibleRoute(route),
  )
  if (grokReferenceError) {
    error.value = grokReferenceError
    routeOpen.value = false
    return
  }
  if (isVideo.value && motionEnhanced.value && !hasMotionReference.value) {
    error.value = '动作增强模式需要至少 1 个动作参考视频（用途选“动作参考”）'
    return
  }
  if (isVideo.value && poseProxyEnabled.value && route.sourceType !== 'PLATFORM') {
    error.value = '姿态代理管线目前仅支持平台模型，请选择平台视频模型'
    return
  }
  if (isVideo.value && poseProxyEnabled.value && !desktop.available) {
    error.value = '人物轮廓动作代理需要 Windows 客户端本地处理，原始动作视频不会上传到服务器。'
    return
  }
  const referenceSemanticError = validateReferenceSemantics()
  if (referenceSemanticError) {
    error.value = referenceSemanticError
    routeOpen.value = false
    return
  }
  routeOpen.value = false
  if (!isVideo.value && route.sourceType === 'PLATFORM') {
    selectedTtsModelId.value = route.platformModelId
  }
  submitting.value = true
  error.value = ''
  motionStage.value = ''
  try {
    if (isVideo.value && poseProxyEnabled.value) {
      await runPoseProxyPipeline(route)
    } else {
      motionStage.value = isVideo.value && motionEnhanced.value ? '正在按动作参考生成最终视频…' : ''
      await runSingleMediaGeneration(route, {
        promptText:
          isVideo.value && selectedGrokMode !== 'TEXT_TO_VIDEO'
            ? promptWithReferenceInstructions(referencesForRoute(route))
            : prompt.value,
        motionPipeline: isVideo.value
          ? motionMode.value === 'direct'
            ? 'MOTION_FINAL'
            : undefined
          : undefined,
        pipelineStage: isVideo.value && motionMode.value === 'direct' ? 'MOTION_FINAL' : undefined,
      })
    }
    if (!detached && !poseGateActive.value) await loadCandidates()
  } catch (caught) {
    if (!detached) error.value = messageFor(caught, '媒体生成失败')
  } finally {
    submitting.value = false
    poseProxyProgress.value = null
    if (!detached && !poseGateActive.value) motionStage.value = ''
  }
}

async function generateVoiceInstructions(route: GenerationRoute) {
  if (isVideo.value || instructionGenerating.value || !prompt.value.trim()) return
  instructionGenerating.value = true
  error.value = ''
  try {
    let current = await generationApi.create(
      props.projectId,
      {
        jobType: 'VOICE_INSTRUCTION_GENERATE',
        targetType: 'STORYBOARD',
        targetId: props.storyboardId,
        parameters: { temperature: 0.3 },
        route,
      },
      globalThis.crypto.randomUUID(),
    )
    instructionJob.value = current
    instructionRouteOpen.value = false
    current = await executeTextGeneration(current, route, desktop, (updated) => {
      instructionJob.value = updated
    })
    instructionJob.value = current
    if (current.status !== 'SUCCEEDED' || !current.resultText?.trim()) {
      throw new Error(current.errorMessage || 'AI 未返回可用的声音指令')
    }
    instructions.value = normalizeVoiceInstructions(current.resultText)
  } catch (caught) {
    error.value = messageFor(caught, '声音指令生成失败')
  } finally {
    instructionGenerating.value = false
  }
}

function normalizeVoiceInstructions(value: string) {
  return value
    .replace(/^声音指令\s*[:：]\s*/i, '')
    .replace(/^[-*\s]+/, '')
    .trim()
    .slice(0, 1_000)
}

async function runPoseProxyPipeline(route: GenerationRoute) {
  clearPoseGate({ revokePreview: true })
  motionStage.value = '第 1/2 步：正在本地生成人物轮廓动作代理…'
  pipelineLinkNotice.value = ''
  referenceNotice.value = '原始动作视频只在本机处理，平台只会收到确认过的灰度人体轮廓代理。'
  const selected = activeReferenceItems.value
  await platformReferenceFiles(selected)
  const sourceVideo = selected.find((item) => item.mediaType === 'VIDEO')
  const proxyFile = sourceVideo ? preparedPoseProxyFiles.get(sourceVideo.file) : undefined
  if (!proxyFile) throw new Error('人物轮廓动作代理生成失败')
  poseGatePreviewUrl.value = globalThis.URL.createObjectURL(proxyFile)
  poseGateRoute.value = route
  poseGateParentJobId.value = crypto.randomUUID()
  poseGateActive.value = true
  motionStage.value = '人物轮廓代理已生成，请播放检查后确认生成最终成片'
  pipelineLinkNotice.value = '本地轮廓代理已就绪，尚未调用平台、尚未扣点'
}

async function continuePoseProxyFinal(route: GenerationRoute, parentJobId: string) {
  motionStage.value = '第 2/2 步：基于人物轮廓动作代理生成最终视频…'
  referenceNotice.value = '已确认人物轮廓动作代理，开始生成最终成片'
  pipelineLinkNotice.value = `任务链路：本地轮廓代理 ${parentJobId.slice(0, 8)} → 最终成片生成中`

  await runSingleMediaGeneration(route, {
    promptText: promptWithLocalPoseProxyInstructions(),
    motionPipeline: 'MOTION_FINAL',
    pipelineStage: 'MOTION_FINAL',
    pipelineParentJobId: parentJobId,
  })
  if (!detached && job.value?.id) {
    pipelineLinkNotice.value = `任务链路：本地轮廓代理 ${parentJobId.slice(0, 8)} → 最终成片 ${job.value.id.slice(0, 8)}`
  }
}

async function confirmPoseProxyAndContinue() {
  if (!poseGateReady.value || poseGateBusy.value || submitting.value) return
  const route = poseGateRoute.value
  const parentJobId = poseGateParentJobId.value
  if (!route || !parentJobId) return
  poseGateBusy.value = true
  submitting.value = true
  error.value = ''
  try {
    await continuePoseProxyFinal(route, parentJobId)
    clearPoseGate({ revokePreview: true })
    if (!detached) await loadCandidates()
  } catch (caught) {
    if (!detached) error.value = messageFor(caught, '最终动作视频生成失败')
  } finally {
    poseGateBusy.value = false
    submitting.value = false
    poseProxyProgress.value = null
    if (!detached && !poseGateActive.value) motionStage.value = ''
  }
}

function discardPoseProxyGate() {
  if (poseGateBusy.value || submitting.value) return
  clearPoseGate({ revokePreview: true })
  motionStage.value = ''
  referenceNotice.value = '已取消本次人物轮廓预览，原始参考素材仍保留'
}

function clearPoseGate(options: { revokePreview?: boolean } = {}) {
  if (options.revokePreview && poseGatePreviewUrl.value) {
    globalThis.URL.revokeObjectURL(poseGatePreviewUrl.value)
  }
  poseGatePreviewUrl.value = ''
  poseGateActive.value = false
  poseGateBusy.value = false
  poseGateRoute.value = null
  poseGateParentJobId.value = ''
  preparedPoseProxyFiles.clear()
}

async function runSingleMediaGeneration(
  route: GenerationRoute,
  options: {
    promptText: string
    motionPipeline?: string
    preferMotionVideosOnly?: boolean
    pipelineStage?: string
    pipelineParentJobId?: string
  },
) {
  const selectedReferences = referencesForRoute(route, options.preferMotionVideosOnly)
  const uploadedReferences = await uploadPlatformReferences(route, {
    preferMotionVideosOnly: options.preferMotionVideosOnly,
  })
  const selectedGrokMode = grokVideoMode(generationRouteModelCode(route))
  const referenceAssetIds =
    selectedGrokMode === 'IMAGE_TO_VIDEO'
      ? selectedReferences.map((item) => item.assetId).filter((id): id is string => Boolean(id))
      : []
  if (
    route.sourceType === 'LOCAL' &&
    selectedGrokMode === 'IMAGE_TO_VIDEO' &&
    referenceAssetIds.length !== selectedReferences.length
  ) {
    throw new Error('本地 Grok 图生视频只能使用已经保存到项目里的参考图片')
  }
  let current = await mediaGenerationApi.create(
    props.projectId,
    {
      mediaType: props.mediaType,
      storyboardId: props.storyboardId,
      prompt: options.promptText,
      durationSec: props.durationSec,
      voice: isVideo.value ? undefined : voice.value,
      parameters: isVideo.value
        ? {
            size: props.outputSize ?? '720x1280',
            aspect_ratio: props.aspectRatio ?? '9:16',
            duration: props.durationSec,
            seconds: props.durationSec,
            generate_audio: options.motionPipeline === 'POSE_PROXY' ? false : true,
            ...(referenceAssetIds.length ? { reference_asset_ids: referenceAssetIds } : {}),
            ...(selectedGrokMode === 'IMAGE_TO_VIDEO'
              ? {
                  reference_mode:
                    selectedReferences.length === 1 &&
                    selectedReferences[0]?.purpose === 'FIRST_FRAME'
                      ? 'IMAGE_TO_VIDEO'
                      : 'REFERENCE_TO_VIDEO',
                }
              : {}),
            ...(options.motionPipeline ? { motion_pipeline: options.motionPipeline } : {}),
            ...(options.motionPipeline ? { video_mode: options.motionPipeline } : {}),
            ...(options.pipelineStage ? { pipeline_stage: options.pipelineStage } : {}),
            ...(options.pipelineParentJobId
              ? { pipeline_parent_job_id: options.pipelineParentJobId }
              : {}),
            ...(options.motionPipeline === 'POSE_PROXY' || options.motionPipeline === 'MOTION_FINAL'
              ? {
                  motion_pipeline_label:
                    options.motionPipeline === 'POSE_PROXY' ? '姿态代理' : '动作成片',
                }
              : {}),
            ...(uploadedReferences.referenceImageIds.length
              ? { reference_image_ids: uploadedReferences.referenceImageIds }
              : {}),
            ...(uploadedReferences.referenceVideoIds.length
              ? { reference_video_ids: uploadedReferences.referenceVideoIds }
              : {}),
            ...(uploadedReferences.referenceAudioIds.length
              ? { reference_audio_ids: uploadedReferences.referenceAudioIds }
              : {}),
          }
        : {
            speed: speed.value,
            response_format: 'mp3',
            ...(instructions.value.trim() ? { instructions: instructions.value.trim() } : {}),
          },
      route,
    },
    globalThis.crypto.randomUUID(),
  )
  job.value = current
  if (route.sourceType === 'LOCAL') {
    current = await generationApi.startLocal(current.id)
    job.value = current
    const stopHeartbeat = startLocalJobHeartbeat(current.id, 25)
    try {
      const execution = current.executionRequest
      if (!execution) throw new Error('本地媒体任务缺少不可变执行快照')
      const local = await desktop.generateLocalMedia({
        projectId: props.projectId,
        connectionId: route.localConnectionId,
        mediaType: props.mediaType,
        prompt: execution.userPrompt,
        durationSec: numberParameter(execution.parameters.duration_sec, props.durationSec),
        inputAssetId: stringParameter(execution.parameters.input_asset_id),
        referenceAssetIds: stringArrayParameter(execution.parameters.reference_asset_ids),
        voice: stringParameter(execution.parameters.voice) ?? voice.value,
        responseFormat: 'mp3',
        speed: numberParameter(execution.parameters.speed, speed.value),
        size: stringParameter(execution.parameters.size) ?? props.outputSize ?? '720x1280',
        aspectRatio:
          (stringParameter(execution.parameters.aspect_ratio) as
            EffectiveProjectAspectRatio | undefined) ??
          props.aspectRatio ??
          '9:16',
        parameters: isVideo.value
          ? {
              generate_audio: true,
              ...(stringParameter(execution.parameters.reference_mode)
                ? { reference_mode: stringParameter(execution.parameters.reference_mode)! }
                : {}),
            }
          : stringParameter(execution.parameters.instructions)
            ? { instructions: stringParameter(execution.parameters.instructions)! }
            : undefined,
      })
      await mediaGenerationApi.completeLocal(current.id, {
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
      job.value = await generationApi.get(current.id)
    } catch (caught) {
      const message = messageFor(caught, '本地媒体生成失败')
      try {
        await generationApi.failLocal(current.id, message)
      } catch {
        // Keep the provider error as the primary failure shown to the user.
      }
      throw caught
    } finally {
      stopHeartbeat()
    }
  } else {
    const completed = await waitForCompletion(current.id)
    if (!completed) return
    job.value = completed
    if (completed.status === 'FAILED') {
      throw new Error(completed.errorMessage || '平台媒体生成失败')
    }
  }
}

async function uploadPlatformReferences(
  route: GenerationRoute,
  options: { preferMotionVideosOnly?: boolean } = {},
): Promise<UploadedReferenceIds> {
  const empty = { referenceImageIds: [], referenceVideoIds: [], referenceAudioIds: [] }
  if (!isVideo.value || route.sourceType !== 'PLATFORM') return empty
  if (referenceLoading.value) throw new Error('参考素材还在读取中，请稍后再生成')
  const selected = referencesForRoute(route, options.preferMotionVideosOnly)
  if (!selected.length) return empty
  const uploadFiles = await platformReferenceFiles(selected)
  const uploaded = await mediaGenerationApi.uploadReferences(uploadFiles)
  if (uploaded.length !== selected.length) {
    throw new Error('参考素材上传结果不完整，请重试')
  }
  const grouped: UploadedReferenceIds = {
    referenceImageIds: [],
    referenceVideoIds: [],
    referenceAudioIds: [],
  }
  uploaded.forEach((item, index) => {
    const purpose = selected[index]?.purpose
    if (item.mediaType === 'IMAGE') grouped.referenceImageIds.push(item.id)
    else if (item.mediaType === 'VIDEO') {
      // 姿态代理优先排在前面，增强动作跟随
      if (purpose === 'POSE_PROXY') grouped.referenceVideoIds.unshift(item.id)
      else grouped.referenceVideoIds.push(item.id)
    } else if (item.mediaType === 'AUDIO') grouped.referenceAudioIds.push(item.id)
  })
  return grouped
}

function validateGrokRouteReferences(mode: GrokVideoMode, requireImage: boolean) {
  return grokVideoReferenceError(
    mode,
    activeReferenceItems.value.map((item) => ({
      mediaType: item.mediaType,
      purpose: item.purpose,
      automatic: item.linked,
    })),
    requireImage,
  )
}

function referencesForRoute(route: GenerationRoute, preferMotionVideosOnly = false) {
  const selectedGrokMode = grokVideoMode(generationRouteModelCode(route))
  if (selectedGrokMode === 'TEXT_TO_VIDEO') return []
  if (selectedGrokMode === 'IMAGE_TO_VIDEO') {
    return activeReferenceItems.value.filter((item) => item.mediaType === 'IMAGE')
  }
  return preferMotionVideosOnly
    ? activeReferenceItems.value.filter(
        (item) =>
          item.mediaType === 'VIDEO' &&
          (item.purpose === 'MOTION_REFERENCE' ||
            item.purpose === 'POSE_PROXY' ||
            item.purpose === undefined),
      )
    : activeReferenceItems.value
}

async function platformReferenceFiles(selected: VideoReferenceItem[]) {
  if (!poseProxyEnabled.value) return selected.map((item) => item.file)
  if (!desktop.available) {
    throw new Error('人物轮廓动作代理需要在 Windows 客户端本地生成，不能直接上传原始动作视频。')
  }
  const videoTotal = selected.filter((item) => item.mediaType === 'VIDEO').length
  let converted = 0
  const files: globalThis.File[] = []
  for (const item of selected) {
    if (item.mediaType !== 'VIDEO') {
      files.push(item.file)
      continue
    }
    const prepared = preparedPoseProxyFiles.get(item.file)
    if (prepared) {
      files.push(prepared)
      converted += 1
      continue
    }
    if (poseGateActive.value) {
      throw new Error('动作参考素材已变化，请重新生成人物轮廓预览并确认')
    }
    const result = await createLocalPoseProxy(item.file, (progress) => {
      poseProxyProgress.value = {
        ...progress,
        message: `生成人物轮廓 ${converted + 1}/${videoTotal}：${progress.message}`,
      }
    })
    converted += 1
    const proxyFile = new globalThis.File(
      [result.file],
      `pose-proxy-${cleanReferenceLabel(item.label || item.file.name)}.mp4`,
      { type: result.file.type || 'video/mp4', lastModified: Date.now() },
    )
    preparedPoseProxyFiles.set(item.file, proxyFile)
    files.push(proxyFile)
    await savePoseProxyReference(proxyFile, item)
  }
  if (converted) {
    referenceNotice.value = '已在本地生成人物轮廓动作代理，原始动作视频没有上传到服务器。'
  }
  return files
}

async function savePoseProxyReference(file: globalThis.File, source: VideoReferenceItem) {
  if (!desktop.available) return
  try {
    await saveBrowserMotionAsset({
      projectId: props.projectId,
      kind: 'POSE_PROXY',
      label: `人物轮廓代理 · ${source.label || source.file.name}`,
      blob: file,
      sourceStoryboardId: props.storyboardId,
      notes: '本地人物轮廓动作代理自动保存',
    })
    await loadMotionAssets()
  } catch {
    // 保存动作库失败不阻断生成。
  }
}

async function addReferenceFiles(event: globalThis.Event) {
  const input = event.target as globalThis.HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  error.value = ''
  referenceNotice.value = ''
  for (const file of files) {
    if (referenceItems.value.length >= MAX_REFERENCE_FILES) {
      error.value = `参考素材最多 ${MAX_REFERENCE_FILES} 个`
      break
    }
    try {
      const inferredPurpose =
        isVideo.value &&
        (file.type.startsWith('video/') || /\.(mp4|webm|mov)$/i.test(file.name)) &&
        motionEnhanced.value
          ? ('MOTION_REFERENCE' as const)
          : undefined
      const item = await createReferenceItem(
        file,
        cleanReferenceLabel(file.name),
        false,
        inferredPurpose,
      )
      applyUploadedReferenceDefaults(item)
      if (referenceBytes() + item.file.size > MAX_REFERENCE_TOTAL_BYTES) {
        globalThis.URL.revokeObjectURL(item.previewUrl)
        error.value = '参考素材总大小不能超过 100MB'
        break
      }
      referenceItems.value.push(item)
    } catch (caught) {
      error.value = messageFor(caught, `${file.name} 不是支持的参考素材`)
    }
  }
}

async function addProjectReferenceAsset(asset: ProjectReferenceAsset) {
  if (projectReferenceAddingId.value || referenceLoading.value || submitting.value) return
  if (referenceItems.value.length >= MAX_REFERENCE_FILES) {
    error.value = `参考素材最多 ${MAX_REFERENCE_FILES} 个`
    return
  }
  if (referenceItems.value.some((item) => item.assetId === asset.id)) {
    referenceNotice.value = '这张项目素材已经在参考素材列表里'
    return
  }
  projectReferenceAddingId.value = asset.id
  error.value = ''
  referenceNotice.value = ''
  try {
    const registeredAssetId = await ensureProjectReferenceAssetId(asset.id)
    if (referenceItems.value.some((item) => item.assetId === registeredAssetId)) {
      referenceNotice.value = '这张项目素材已经在参考素材列表里'
      return
    }
    const file = await loadMediaReferenceFile({
      assetId: registeredAssetId,
      label: cleanReferenceLabel(asset.label),
    })
    const item = await createReferenceItem(file, cleanReferenceLabel(asset.label), false)
    item.assetId = registeredAssetId
    item.selected = true
    if (
      projectReferenceBindingType.value === 'AUTO' &&
      !inferBindingForAsset(registeredAssetId, item.mediaType, false)
    ) {
      throw new Error('这个素材还没有角色/场景/声音绑定，请先选择素材身份和绑定对象')
    }
    applyProjectReferenceBinding(item, registeredAssetId)
    if (referenceBytes() + item.file.size > MAX_REFERENCE_TOTAL_BYTES) {
      globalThis.URL.revokeObjectURL(item.previewUrl)
      throw new Error('参考素材总大小不能超过 100MB')
    }
    referenceItems.value.push(item)
    referenceNotice.value = `已从项目素材添加：${item.label}${semanticLabelForReference(item) ? `（${semanticLabelForReference(item)}）` : ''}`
  } catch (caught) {
    error.value = messageFor(caught, '项目素材添加失败')
  } finally {
    projectReferenceAddingId.value = ''
  }
}

async function ensureProjectReferenceAssetId(assetId: string) {
  if (workspace.mediaAssetById(assetId)) return assetId
  const local = desktop.project?.assets.find((asset) => asset.id === assetId)
  if (!local) return assetId
  const mappings = await workspace.synchronizeLocalAssets(props.projectId, [local as LocalAsset])
  await desktop.reconcileAssetIds(mappings.filter((item) => item.clientAssetId !== item.assetId))
  return mappings.find((item) => item.clientAssetId === assetId)?.assetId ?? assetId
}

function applyProjectReferenceBinding(item: VideoReferenceItem, assetId: string) {
  const inferred =
    projectReferenceBindingType.value === 'AUTO'
      ? inferBindingForAsset(assetId, item.mediaType, true)
      : explicitProjectReferenceBinding(item.mediaType)
  if (!inferred) return
  item.bindingType = inferred.bindingType
  item.bindingTargetId = inferred.bindingTargetId
  item.bindingLabel = inferred.bindingLabel
  item.usageNote =
    inferred.usageNote ?? defaultUsageNoteForBinding(inferred.bindingType, inferred.bindingTargetId)
  if (!item.purpose && inferred.purpose) item.purpose = inferred.purpose
}

function applyInferredReferenceBinding(item: VideoReferenceItem, assetId: string) {
  const inferred = inferBindingForAsset(assetId, item.mediaType, false)
  if (!inferred) return
  item.bindingType = inferred.bindingType
  item.bindingTargetId = inferred.bindingTargetId
  item.bindingLabel = inferred.bindingLabel
  item.usageNote =
    inferred.usageNote ?? defaultUsageNoteForBinding(inferred.bindingType, inferred.bindingTargetId)
  if (!item.purpose && inferred.purpose) item.purpose = inferred.purpose
}

function inferBindingForAsset(
  assetId: string,
  mediaType: ReferenceMediaType,
  allowExplicitFallback: boolean,
) {
  const voice = workspace.characterVoiceReferences.find(
    (reference) => reference.assetId === assetId,
  )
  if (voice) {
    const character = workspace.characters.find((item) => item.id === voice.characterId)
    return {
      bindingType: 'VOICE' as const,
      bindingTargetId: voice.characterId,
      bindingLabel: character ? `角色声音：${character.name}` : '角色声音',
      purpose: 'VOICE_IDENTITY' as const,
      usageNote: character
        ? `这是角色「${character.name}」的声音样本，只用于保持该角色音色、年龄感和说话质感。`
        : '这是角色声音样本，只用于保持对应角色音色和说话质感。',
    }
  }
  const characterReference = workspace.characterReferences.find(
    (reference) => reference.assetId === assetId,
  )
  if (characterReference) {
    const character = workspace.characters.find(
      (item) => item.id === characterReference.characterId,
    )
    return {
      bindingType: 'CHARACTER' as const,
      bindingTargetId: characterReference.characterId,
      bindingLabel: character ? `角色：${character.name}` : '角色参考',
      usageNote: character
        ? `这是角色「${character.name}」的外观参考图，只用于保持该角色身份、脸、发型、服装和体型。`
        : '这是角色外观参考图，只用于保持对应角色身份和外观。',
    }
  }
  const sceneReference = workspace.sceneReferences.find(
    (reference) => reference.assetId === assetId,
  )
  if (sceneReference) {
    const scene = workspace.scenes.find((item) => item.id === sceneReference.sceneId)
    return {
      bindingType: 'SCENE' as const,
      bindingTargetId: sceneReference.sceneId,
      bindingLabel: scene ? `场景：${scene.title}` : '场景参考',
      purpose: mediaType === 'AUDIO' ? ('BACKGROUND_AUDIO' as const) : undefined,
      usageNote: scene
        ? `这是场景「${scene.title}」的背景/环境参考，只用于保持空间结构、光线、陈设和氛围。`
        : '这是场景背景/环境参考，只用于保持空间结构、光线和氛围。',
    }
  }
  return allowExplicitFallback ? explicitProjectReferenceBinding(mediaType) : undefined
}

function explicitProjectReferenceBinding(mediaType: ReferenceMediaType) {
  const type = projectReferenceBindingType.value
  if (type === 'AUTO') return undefined
  const bindingTargetId = projectReferenceBindingTargetId.value || undefined
  const explicitPurpose = projectReferenceBindingPurpose.value || undefined
  const inferredPurpose =
    explicitPurpose ??
    (type === 'VOICE'
      ? ('VOICE_IDENTITY' as const)
      : type === 'SFX'
        ? ('BACKGROUND_AUDIO' as const)
        : type === 'MOTION'
          ? ('MOTION_REFERENCE' as const)
          : mediaType === 'AUDIO' && (type === 'SCENE' || type === 'BACKGROUND')
            ? ('BACKGROUND_AUDIO' as const)
            : undefined)
  return {
    bindingType: type,
    bindingTargetId,
    bindingLabel: bindingLabel(type, bindingTargetId),
    purpose: inferredPurpose,
    usageNote: defaultUsageNoteForBinding(type, bindingTargetId),
  }
}

function bindingTargetOptions(type?: ProjectReferenceBindingType | ManualReferenceBindingType) {
  if (type === 'CHARACTER' || type === 'VOICE') {
    return currentStoryboardCharacters.value.map((character) => ({
      value: character.id,
      label: character.name,
    }))
  }
  if (type === 'SCENE' || type === 'BACKGROUND') {
    return currentStoryboardScenes.value.map((scene) => ({
      value: scene.id,
      label: sceneLabel(scene),
    }))
  }
  return [] satisfies ReferenceBindingOption[]
}

function defaultBindingTargetId(type: ProjectReferenceBindingType | ManualReferenceBindingType) {
  if (type === 'CHARACTER' || type === 'VOICE') {
    return currentStoryboardCharacters.value[0]?.id ?? ''
  }
  if (type === 'SCENE' || type === 'BACKGROUND') {
    return currentStoryboardScene.value?.id ?? currentStoryboardScenes.value[0]?.id ?? ''
  }
  return ''
}

function bindingLabel(type?: ManualReferenceBindingType, targetId?: string) {
  if (!type) return ''
  if (type === 'CHARACTER' || type === 'VOICE') {
    const character = workspace.characters.find((item) => item.id === targetId)
    return character ? `${bindingTypeLabel(type)}：${character.name}` : bindingTypeLabel(type)
  }
  if (type === 'SCENE' || type === 'BACKGROUND') {
    const scene = workspace.scenes.find((item) => item.id === targetId)
    return scene ? `${bindingTypeLabel(type)}：${sceneLabel(scene)}` : bindingTypeLabel(type)
  }
  return bindingTypeLabel(type)
}

function sceneLabel(scene: { sceneNo?: number; title: string; location?: string }) {
  return [scene.sceneNo ? `场景${scene.sceneNo}` : '', scene.title, scene.location]
    .filter(Boolean)
    .join(' · ')
}

function bindingTypeLabel(type: ManualReferenceBindingType) {
  if (type === 'CHARACTER') return '绑定角色'
  if (type === 'SCENE') return '绑定场景'
  if (type === 'BACKGROUND') return '背景/环境'
  if (type === 'PROP') return '道具'
  if (type === 'WEAPON') return '武器'
  if (type === 'MOTION') return '动作参考'
  if (type === 'VOICE') return '角色声音'
  if (type === 'SFX') return '音效/环境声'
  return '风格参考'
}

function defaultUsageNoteForBinding(type?: ManualReferenceBindingType, targetId?: string) {
  if (!type) return ''
  const character =
    type === 'CHARACTER' || type === 'VOICE'
      ? workspace.characters.find((item) => item.id === targetId)
      : undefined
  const scene =
    type === 'SCENE' || type === 'BACKGROUND'
      ? workspace.scenes.find((item) => item.id === targetId)
      : undefined
  if (type === 'CHARACTER') {
    return character
      ? `这是角色「${character.name}」的补充形象参考，只用于该角色的外观、服装、形态或细节。`
      : '这是角色补充形象参考，只用于对应角色的外观、服装、形态或细节。'
  }
  if (type === 'SCENE') {
    return scene
      ? `这是场景「${scene.title}」的参考，只用于该场景的空间、陈设、光线和环境氛围。`
      : '这是场景参考，只用于对应场景的空间、陈设、光线和环境氛围。'
  }
  if (type === 'BACKGROUND') {
    return scene
      ? `这是场景「${scene.title}」的背景/环境图，只用于背景结构、光线、材质和氛围，不要凭空加入人物。`
      : '这是背景/环境图，只用于背景结构、光线、材质和氛围，不要凭空加入人物。'
  }
  if (type === 'PROP') return '这是当前镜头道具参考，只用于道具外观、材质、尺寸和摆放方式。'
  if (type === 'WEAPON') {
    return character
      ? `这是角色「${character.name}」的武器参考，只用于武器外观、材质、比例、握持方式和战斗动作。`
      : '这是角色武器参考，只用于武器外观、材质、比例、握持方式和战斗动作。'
  }
  if (type === 'MOTION') return '这是动作参考，只用于动作轨迹、节奏、身体姿态和镜头运动。'
  if (type === 'VOICE') {
    return character
      ? `这是角色「${character.name}」的声音参考，只用于该角色音色、年龄感和说话质感。`
      : '这是角色声音参考，只用于对应角色音色、年龄感和说话质感。'
  }
  if (type === 'SFX') return '这是音效/环境声参考，只用于当前镜头的声音氛围、节奏和环境质感。'
  return '这是风格参考，只用于画风、光影、色彩、材质和镜头质感，不改变角色身份。'
}

function semanticLabelForReference(item: VideoReferenceItem) {
  return item.bindingLabel || bindingLabel(item.bindingType, item.bindingTargetId)
}

function applyUploadedReferenceDefaults(item: VideoReferenceItem) {
  if (item.mediaType === 'VIDEO') {
    item.bindingType = motionEnhanced.value ? 'MOTION' : undefined
    if (motionEnhanced.value) item.purpose = 'MOTION_REFERENCE'
  } else if (item.mediaType === 'AUDIO') {
    item.bindingType = props.audioMode === 'VIDEO_NATIVE' ? 'SFX' : undefined
    if (props.audioMode === 'VIDEO_NATIVE') item.purpose = 'BACKGROUND_AUDIO'
  }
  normalizeReferenceItemBinding(item)
}

function validateReferenceSemantics() {
  if (!isVideo.value) return ''
  const incomplete = activeReferenceItems.value.filter((item) => {
    if (item.linked) return false
    const hasUsage = Boolean(item.usageNote?.trim())
    return !hasUsage
  })
  if (!incomplete.length) return ''
  return `请先给补充素材说明用途：${incomplete
    .slice(0, 3)
    .map((item) => item.label || item.file.name)
    .join('、')}`
}

function normalizeReferenceItemBinding(item: VideoReferenceItem) {
  item.bindingLabel = undefined
  if (!item.bindingType) {
    item.bindingTargetId = undefined
    return
  }
  const options = bindingTargetOptions(item.bindingType)
  if (options.length && !options.some((option) => option.value === item.bindingTargetId)) {
    item.bindingTargetId = defaultBindingTargetId(item.bindingType)
  }
  if (item.bindingType === 'VOICE' && !item.purpose) item.purpose = 'VOICE_IDENTITY'
  if (item.bindingType === 'SFX' && !item.purpose) item.purpose = 'BACKGROUND_AUDIO'
  if (item.bindingType === 'MOTION' && !item.purpose) item.purpose = 'MOTION_REFERENCE'
  item.usageNote = defaultUsageNoteForBinding(item.bindingType, item.bindingTargetId)
}

function removeReferenceItem(index: number) {
  const item = referenceItems.value[index]
  if (!item || item.linked) return
  const [removed] = referenceItems.value.splice(index, 1)
  if (removed) globalThis.URL.revokeObjectURL(removed.previewUrl)
}

function cleanReferenceLabel(filename: string) {
  return (
    filename
      .replace(/\.[^.]+$/, '')
      .replace(/[_-]+/g, ' ')
      .trim() || '补充参考素材'
  )
}

function isSupportedProjectReferenceMime(mimeType: string) {
  return (
    mimeType.startsWith('image/') ||
    SUPPORTED_VIDEO_TYPES.has(mimeType) ||
    SUPPORTED_AUDIO_TYPES.has(mimeType)
  )
}

function clearReferenceItems() {
  referenceItems.value.forEach((item) => globalThis.URL.revokeObjectURL(item.previewUrl))
  referenceItems.value = []
}

async function loadAutomaticReferences() {
  const references: Array<{ assetId: string; label: string }> = []
  for (const reference of props.linkedReferences ?? []) {
    if (references.some((item) => item.assetId === reference.assetId)) continue
    references.push(reference)
  }
  const mediaReferences = props.linkedMediaReferences ?? []
  if (!references.length && !mediaReferences.length) return
  const loadVersion = ++referenceLoadVersion
  referenceLoading.value = true
  let failed = 0
  const failureMessages: string[] = []
  try {
    for (const reference of references.slice(0, MAX_REFERENCE_FILES)) {
      if (referenceItems.value.some((item) => item.assetId === reference.assetId)) continue
      try {
        const file = await loadImageAssetFile(reference.assetId, reference.label)
        if (loadVersion !== referenceLoadVersion || detached || !props.open) return
        if (referenceBytes() + file.size > MAX_REFERENCE_TOTAL_BYTES) {
          failed += 1
          failureMessages.push(`${reference.label}超过参考素材总大小限制`)
          continue
        }
        const binding = inferBindingForAsset(reference.assetId, 'IMAGE', false)
        referenceItems.value.push({
          file,
          mediaType: 'IMAGE',
          label: reference.label,
          previewUrl: globalThis.URL.createObjectURL(file),
          linked: true,
          selected: true,
          purpose: undefined,
          assetId: reference.assetId,
          bindingType: binding?.bindingType,
          bindingTargetId: binding?.bindingTargetId,
          bindingLabel: binding?.bindingLabel,
        })
      } catch (caught) {
        failed += 1
        failureMessages.push(messageFor(caught, `${reference.label}读取失败`))
      }
    }
    for (const reference of mediaReferences.slice(0, MAX_REFERENCE_FILES)) {
      if (
        (reference.assetId &&
          referenceItems.value.some((item) => item.assetId === reference.assetId)) ||
        (reference.candidateId &&
          referenceItems.value.some((item) => item.candidateId === reference.candidateId))
      ) {
        continue
      }
      try {
        const file = await loadMediaReferenceFile(reference)
        if (loadVersion !== referenceLoadVersion || detached || !props.open) return
        if (referenceBytes() + file.size > MAX_REFERENCE_TOTAL_BYTES) {
          failed += 1
          failureMessages.push(`${reference.label}超过参考素材总大小限制`)
          continue
        }
        const item = await createReferenceItem(file, reference.label, true, reference.purpose)
        item.assetId = reference.assetId
        item.candidateId = reference.candidateId
        if (reference.assetId) applyInferredReferenceBinding(item, reference.assetId)
        referenceItems.value.push(item)
      } catch (caught) {
        failed += 1
        failureMessages.push(messageFor(caught, `${reference.label}读取失败`))
      }
    }
    const loaded = referenceItems.value.filter((item) => item.linked).length
    referenceNotice.value = failed
      ? `已自动关联 ${loaded} 个角色、场景、声音或连续性参考，${failed} 个文件读取失败：${failureMessages.slice(0, 2).join('；')}`
      : `已自动关联 ${loaded} 个角色、场景、声音或连续性参考`
  } finally {
    if (loadVersion === referenceLoadVersion) referenceLoading.value = false
  }
}

async function loadImageAssetFile(assetId: string, label: string) {
  const asset = workspace.mediaAssetById(assetId)
  if (asset && asset.assetType !== 'IMAGE') throw new Error(`${label}不是有效图片素材`)

  let blob: globalThis.Blob | null
  let filename = asset?.originalFilename
  const local = desktop.project?.assets.find((item) => item.id === assetId)
  if (!asset && local?.mimeType && !local.mimeType.startsWith('image/')) {
    throw new Error(`${label}不是有效图片素材`)
  }
  filename = filename || local?.originalName
  blob = await loadProjectAssetBlob(assetId, label, () =>
    loadBrowserImage(props.projectId, assetId),
  )

  const normalizedBlob = await normalizeImageBlob(blob)
  const sourceFile = new globalThis.File(
    [normalizedBlob],
    filename || `${cleanReferenceLabel(label)}${fileExtension(normalizedBlob.type)}`,
    { type: normalizedBlob.type, lastModified: Date.now() },
  )
  return (await normalizeImageFile(sourceFile, MAX_IMAGE_REFERENCE_BYTES)).file
}

async function loadMediaReferenceFile(reference: {
  assetId?: string
  candidateId?: string
  label: string
  purpose?: StoryboardMediaReferencePurpose
}) {
  if (reference.assetId) {
    const asset = workspace.mediaAssetById(reference.assetId)
    if (!asset || !['IMAGE', 'VIDEO', 'AUDIO'].includes(asset.assetType)) {
      throw new Error(`${reference.label}不是有效媒体素材`)
    }
    if (asset.assetType === 'IMAGE') return loadImageAssetFile(reference.assetId, reference.label)
    const blob = await loadProjectAssetBlob(reference.assetId, reference.label, () =>
      loadBrowserMedia(props.projectId, reference.assetId!),
    )
    const fallbackType = asset.assetType === 'AUDIO' ? 'audio/mpeg' : 'video/mp4'
    return new globalThis.File(
      [blob],
      asset.originalFilename || `${reference.label}${mediaExtension(blob.type || fallbackType)}`,
      {
        type: blob.type || asset.mimeType || fallbackType,
        lastModified: Date.now(),
      },
    )
  }
  if (reference.candidateId) {
    const blob = await mediaGenerationApi.preview(reference.candidateId)
    return new globalThis.File([blob], `${reference.label}${mediaExtension(blob.type)}`, {
      type: blob.type || 'video/mp4',
      lastModified: Date.now(),
    })
  }
  throw new Error(`${reference.label}缺少可读取的视频来源`)
}

async function loadProjectAssetBlob(
  assetId: string,
  label: string,
  loadBrowserFallback: () => Promise<globalThis.Blob | null>,
) {
  const local = desktop.project?.assets.find((item) => item.id === assetId)
  if (desktop.available && local?.fileAvailable) {
    const localBlob = await tryLoadBlob(async () => {
      const response = await globalThis.fetch(desktop.assetPreviewUrl(assetId))
      return response.ok ? response.blob() : null
    })
    if (localBlob) return localBlob
  }

  const asset = workspace.mediaAssetById(assetId)
  if (asset?.contentAvailable || asset?.storageScope === 'SERVER') {
    const serverBlob = await tryLoadBlob(() => mediaAssetApi.content(props.projectId, assetId))
    if (serverBlob) return serverBlob
  }

  const browserBlob = await loadBrowserFallback()
  if (browserBlob) return browserBlob
  throw new Error(`${label}的本地和服务端文件都不可用`)
}

async function tryLoadBlob(load: () => Promise<globalThis.Blob | null>) {
  try {
    return await load()
  } catch {
    return null
  }
}

async function createReferenceItem(
  file: globalThis.File,
  label: string,
  linked: boolean,
  purpose?: StoryboardMediaReferencePurpose,
) {
  const mimeType = inferReferenceMimeType(file)
  const mediaType = referenceMediaType(mimeType)
  let normalizedFile: globalThis.File
  if (mediaType === 'IMAGE') {
    normalizedFile = (await normalizeImageFile(file, MAX_IMAGE_REFERENCE_BYTES)).file
  } else {
    if (file.size <= 0 || file.size > MAX_MEDIA_REFERENCE_BYTES) {
      throw new Error(`单个视频或音频参考必须小于 ${MAX_MEDIA_REFERENCE_BYTES / 1024 / 1024}MB`)
    }
    normalizedFile =
      file.type === mimeType
        ? file
        : new globalThis.File([file], file.name, {
            type: mimeType,
            lastModified: file.lastModified,
          })
  }
  return {
    file: normalizedFile,
    mediaType,
    label,
    previewUrl: globalThis.URL.createObjectURL(normalizedFile),
    linked,
    selected: purpose !== 'FIRST_FRAME' && purpose !== 'END_FRAME',
    purpose,
  } satisfies VideoReferenceItem
}

function inferReferenceMimeType(file: globalThis.File) {
  const declared = file.type.split(';', 1)[0].trim().toLowerCase()
  if (isSupportedReferenceMimeType(declared)) return declared
  const extension = file.name.match(/\.[^.]+$/)?.[0]?.toLowerCase() ?? ''
  const inferred = REFERENCE_MIME_BY_EXTENSION.get(extension)
  if (inferred && isSupportedReferenceMimeType(inferred)) return inferred
  throw new Error('仅支持 PNG/JPEG/WebP 图片、MP4/WebM/MOV 视频和常见音频格式')
}

function isSupportedReferenceMimeType(value: string) {
  return (
    value === 'image/png' ||
    value === 'image/jpeg' ||
    value === 'image/webp' ||
    SUPPORTED_VIDEO_TYPES.has(value) ||
    SUPPORTED_AUDIO_TYPES.has(value)
  )
}

function referenceMediaType(mimeType: string): ReferenceMediaType {
  if (mimeType.startsWith('image/')) return 'IMAGE'
  if (SUPPORTED_VIDEO_TYPES.has(mimeType)) return 'VIDEO'
  if (SUPPORTED_AUDIO_TYPES.has(mimeType)) return 'AUDIO'
  throw new Error('参考素材类型无效')
}

function referenceBytes() {
  return referenceItems.value.reduce((total, item) => total + item.file.size, 0)
}

function promptWithReferenceInstructions(items = activeReferenceItems.value) {
  const base = prompt.value.trim()
  const instructions = referenceInstructions(items)
  return instructions ? `${base}\n\n${instructions}` : base
}

function promptWithLocalPoseProxyInstructions() {
  return [
    promptWithReferenceInstructions(),
    '动作参考说明：本次所有动作视频已在 Windows 客户端本地逐帧提取人体外轮廓，并转换为灰度深度动作代理。请严格跟随代理视频中的动作轨迹、身体朝向、重心、节奏、站位和运镜，只把它作为动作结构参考；角色身份、脸、服装和场景必须使用当前项目的角色图、场景图及提示词，不得生成火柴人、骨架线或灰模成片。',
  ]
    .filter(Boolean)
    .join('\n\n')
}

function referenceInstructions(items = activeReferenceItems.value) {
  if (!items.length) return ''
  const lines = ['参考素材对应关系：']
  appendReferenceInstructionLines(lines, items, 'IMAGE', '图片')
  appendReferenceInstructionLines(lines, items, 'VIDEO', '视频')
  appendReferenceInstructionLines(lines, items, 'AUDIO', '音频')
  const usesVoiceIdentityReference = items.some(
    (item) => item.mediaType === 'AUDIO' && item.purpose === 'VOICE_IDENTITY',
  )
  const usesBackgroundAudioReference = items.some(
    (item) => item.mediaType === 'AUDIO' && item.purpose === 'BACKGROUND_AUDIO',
  )
  lines.push(
    '生成要求：严格优先保持参考图片中的角色身份、脸部、发型、服装、身体比例和场景结构一致；参考视频只用于动作、镜头运动或连续性。不要把纯背景参考图里不存在的人物凭空加入画面。',
  )
  if (usesVoiceIdentityReference) {
    lines.push(
      '标注为“角色主声音样本”的音频只用于对应主要说话角色的音色、年龄感和说话质感；不得复制样本台词，不得把它当作背景音乐，也不得用于其他角色。',
    )
  }
  if (usesBackgroundAudioReference) {
    lines.push(
      '标注为“背景声音参考”的音频用于当前镜头的环境声、音乐氛围和节奏参考；不得把其中的人声当作角色台词或角色音色。',
    )
  }
  if (items.some((item) => item.purpose === 'FIRST_FRAME')) {
    lines.push(
      '标注为“首帧参考”的图片用于约束视频开场画面，开场构图、人物位置和光线应从该图片自然起步。',
    )
  }
  if (items.some((item) => item.purpose === 'END_FRAME')) {
    lines.push(
      '标注为“尾帧参考”的图片用于约束视频结束状态，动作和运镜应自然过渡到该画面，不得生硬跳切。',
    )
  }
  if (items.some((item) => item.purpose === 'CONTINUITY')) {
    lines.push(
      '标注为“连续性参考”的上一镜头尾帧或视频用于衔接当前镜头开场，保持人物位置、姿态、场景空间和光线连续。',
    )
  }
  if (items.some((item) => item.mediaType === 'AUDIO' && !item.purpose)) {
    lines.push('其他参考音频只用于用户明确要求的音乐、节奏或声音氛围。')
  }
  if (items.some((item) => !item.linked)) {
    lines.push(
      '手动补充素材按其名称或说明理解用途：可作为角色特殊形态、武器道具、背景图、动作视频或声音氛围参考；未手动补充的额外形态不要自动套用。',
    )
  }
  if (items.some((item) => item.purpose === 'MOTION_REFERENCE')) {
    lines.push(
      '标注为"动作参考"的视频只用于肢体轨迹、击打节奏、运镜和站位编排；不要复制参考人物的脸、服装材质或真实身份。',
    )
  }
  if (items.some((item) => item.purpose === 'POSE_PROXY')) {
    lines.push(
      '标注为"姿态代理"的视频是简洁关节/灰模动作参考，请严格跟随其动作轨迹与节奏生成最终画面。',
    )
  }
  if (motionEnhanced.value) {
    lines.push('当前为动作增强模式：优先保证高难度动作与武打编排准确，其次再优化光影和材质细节。')
  }

  return lines.join('\n')
}

function appendReferenceInstructionLines(
  lines: string[],
  items: VideoReferenceItem[],
  mediaType: ReferenceMediaType,
  label: string,
) {
  items
    .filter((item) => item.mediaType === mediaType)
    .forEach((item, index) => {
      const role = framePurposeLabel(item.purpose)
      const itemLabel = item.label.trim() || item.file.name || `${label}${index + 1}`
      const semantic = semanticPromptLabelForReference(item)
      const usage = item.usageNote?.trim()
      lines.push(
        `${label}${index + 1}：${itemLabel}${role ? `（${role}）` : ''}${semantic ? `（${semantic}）` : ''}${usage ? `；用途说明：${usage}` : ''}`,
      )
    })
}

function semanticPromptLabelForReference(item: VideoReferenceItem) {
  if (item.bindingLabel) return item.bindingLabel
  if (item.bindingType === 'CHARACTER') return bindingLabel('CHARACTER', item.bindingTargetId)
  if (item.bindingType === 'SCENE') return bindingLabel('SCENE', item.bindingTargetId)
  if (item.bindingType === 'BACKGROUND') return bindingLabel('BACKGROUND', item.bindingTargetId)
  if (item.bindingType === 'PROP') return '道具参考：只用于对应道具外观、材质和尺寸'
  if (item.bindingType === 'WEAPON') return '武器参考：只用于武器外观、材质、握持方式和比例'
  if (item.bindingType === 'MOTION') return '动作参考：只用于动作轨迹、节奏和运镜'
  if (item.bindingType === 'VOICE') return bindingLabel('VOICE', item.bindingTargetId)
  if (item.bindingType === 'SFX') return '音效/环境声参考：只用于当前镜头声音氛围'
  if (item.bindingType === 'STYLE') return '风格参考：只用于画风、光影、质感和色彩倾向'
  return ''
}

function framePurposeLabel(purpose?: StoryboardMediaReferencePurpose) {
  if (purpose === 'FIRST_FRAME') return '首帧参考'
  if (purpose === 'END_FRAME') return '尾帧参考'
  if (purpose === 'CONTINUITY') return '连续性参考'
  if (purpose === 'VOICE_IDENTITY') return '角色声音参考'
  if (purpose === 'BACKGROUND_AUDIO') return '背景声音参考'
  if (purpose === 'MOTION_REFERENCE') return '动作参考'
  if (purpose === 'POSE_PROXY') return '姿态代理'
  return ''
}

function referenceKindLabel(mediaType: ReferenceMediaType) {
  if (mediaType === 'IMAGE') return '图片'
  if (mediaType === 'VIDEO') return '视频'
  return '音频'
}

async function restoreActiveJob() {
  if (restoringJob.value || submitting.value) return
  restoringJob.value = true
  try {
    const page = await generationApi.list(props.projectId)
    if (detached) return
    const active = latestActiveGenerationJob(
      page.items,
      jobType.value,
      'STORYBOARD',
      props.storyboardId,
    )
    if (!active) return
    job.value = active
    submitting.value = true
    const completed = await waitForCompletion(active.id)
    if (!completed) return
    job.value = completed
    if (completed.status === 'FAILED') {
      error.value = completed.errorMessage || '后台媒体生成失败'
    } else if (completed.status === 'SUCCEEDED') {
      await loadCandidates()
    }
  } catch (caught) {
    if (!detached) error.value = messageFor(caught, '后台任务状态读取失败')
  } finally {
    restoringJob.value = false
    if (!detached) submitting.value = false
  }
}

async function waitForCompletion(jobId: string): Promise<GenerationJob | null> {
  for (let index = 0; index < PLATFORM_POLL_ATTEMPTS; index += 1) {
    if (detached) return null
    const current = await generationApi.get(jobId)
    if (detached) return null
    job.value = current
    if (['SUCCEEDED', 'FAILED', 'CANCELED'].includes(current.status)) return current
    await new Promise((resolve) => globalThis.setTimeout(resolve, PLATFORM_POLL_INTERVAL_MS))
  }
  throw new Error('平台模型仍在处理，可稍后重新打开候选窗口查看')
}

async function selectCandidate(candidate: MediaCandidate) {
  const completed = await runCandidateAction(
    candidate,
    async () => {
      const selected = await mediaGenerationApi.select(candidate.id, candidate.version)
      replaceCandidate(selected)
      if (!desktop.available) return
      const saved = await persistSelectedCandidate(selected)
      replaceCandidate(saved)
      const outputNotice = await applyOutput(saved)
      autoSaveFailedIds.value = new Set(
        [...autoSaveFailedIds.value].filter((id) => id !== candidate.id),
      )
      autoSaveNotice.value = outputNotice || '已自动保存到本地项目目录'
    },
    '候选已选中，但自动保存到本地失败；可在候选卡片上重试',
  )
  if (!completed && desktop.available) {
    autoSaveFailedIds.value = new Set([...autoSaveFailedIds.value, candidate.id])
  }
}

async function saveCandidate(candidate: MediaCandidate) {
  if (!desktop.available) {
    error.value = '请在 Windows 客户端中把候选保存到本地项目目录'
    return
  }
  await runCandidateAction(candidate, async () => {
    const selected = await ensureSelectedCandidate(candidate)
    replaceCandidate(selected)
    const saved = await persistSelectedCandidate(selected)
    replaceCandidate(saved)
    const outputNotice = await applyOutput(saved)
    autoSaveFailedIds.value = new Set(
      [...autoSaveFailedIds.value].filter((id) => id !== candidate.id),
    )
    autoSaveNotice.value =
      outputNotice ||
      (isVideo.value
        ? '视频已保存到本地项目目录，并设为当前视频'
        : '配音已保存到本地项目目录，并设为当前配音')
  })
}

async function autoSaveLatestCandidate() {
  if (!desktop.available || detached || !props.open) return
  const candidate = candidates.value.find(canAutoSaveCandidate)
  if (!candidate || autoSaveAttemptedIds.has(candidate.id)) return
  const saved = await runCandidateAction(
    candidate,
    async () => {
      const selected = await ensureSelectedCandidate(candidate)
      replaceCandidate(selected)
      const saved = await persistSelectedCandidate(selected)
      replaceCandidate(saved)
      autoSaveAttemptedIds.add(candidate.id)
      const outputNotice = await applyOutput(saved)
      autoSaveFailedIds.value = new Set(
        [...autoSaveFailedIds.value].filter((id) => id !== candidate.id),
      )
      if (!detached) autoSaveNotice.value = outputNotice || '已自动保存到本地项目目录'
    },
    '自动保存到本地失败，候选已保留，可点击保存重试',
  )
  if (!saved) autoSaveFailedIds.value = new Set([...autoSaveFailedIds.value, candidate.id])
}

function canAutoSaveCandidate(candidate: MediaCandidate) {
  if (candidate.localAssetId || candidate.status === 'LOCAL_SAVED') return false
  if (!['AVAILABLE', 'SELECTED'].includes(candidate.status)) return false
  if (candidate.deliveryType === 'LOCAL_CACHE') return Boolean(candidate.clientCandidateId)
  return (
    candidate.previewAvailable &&
    ['PLATFORM_REMOTE', 'PLATFORM_CACHE'].includes(candidate.deliveryType)
  )
}

async function ensureSelectedCandidate(candidate: MediaCandidate) {
  if (candidate.status === 'AVAILABLE') {
    return mediaGenerationApi.select(candidate.id, candidate.version)
  }
  return candidate
}

async function persistSelectedCandidate(candidate: MediaCandidate) {
  if (candidate.localAssetId || candidate.status === 'LOCAL_SAVED') return candidate
  if (candidate.status !== 'SELECTED') {
    throw new Error('请先选中候选，再保存到本地')
  }
  const accessToken = mediaGenerationApi.accessToken()
  if (candidate.deliveryType !== 'LOCAL_CACHE' && !accessToken) {
    throw new Error('登录状态无效，无法下载平台媒体')
  }
  const localAsset = await desktop.saveGeneratedMedia(
    candidate.deliveryType === 'LOCAL_CACHE'
      ? {
          projectId: props.projectId,
          projectTitle: workspace.project?.title || props.title,
          candidateId: candidate.id,
          deliveryType: 'LOCAL_CACHE',
          clientCandidateId: requiredClientCandidateId(candidate),
          category: category.value,
        }
      : {
          projectId: props.projectId,
          projectTitle: workspace.project?.title || props.title,
          candidateId: candidate.id,
          deliveryType: candidate.deliveryType,
          category: category.value,
          accessToken: accessToken!,
        },
  )
  if (desktop.project?.projectId !== props.projectId) {
    await desktop.loadProject(props.projectId)
  }
  if (!desktop.project) throw new Error('本地项目清单读取失败')
  const mappings = await workspace.synchronizeLocalAssets(props.projectId, [localAsset])
  const canonicalId =
    mappings.find((item) => item.clientAssetId === localAsset.id)?.assetId ?? localAsset.id
  await desktop.reconcileAssetIds(mappings.filter((item) => item.clientAssetId !== item.assetId))
  return mediaGenerationApi.confirmSaved(candidate.id, canonicalId, candidate.version)
}

async function applyOutput(candidate: MediaCandidate) {
  if (!candidate.localAssetId) throw new Error('候选尚未保存为本地素材')
  await workspace.setStoryboardOutput(props.projectId, props.storyboardId, {
    outputType: outputType.value,
    mediaAssetId: candidate.localAssetId!,
    sourceType: 'MEDIA_CANDIDATE',
    sourceId: candidate.id,
  })
  const frameNotice = isVideo.value ? await autoExtractCurrentVideoFrames(candidate) : ''
  emit('referenced')
  return frameNotice
}

async function autoExtractCurrentVideoFrames(candidate: MediaCandidate) {
  const storyboard = workspace.storyboards.find((item) => item.id === props.storyboardId)
  if (!storyboard || !candidate.localAssetId || !desktop.available) return ''
  try {
    const result = await extractStoryboardVideoFrames({
      projectId: props.projectId,
      storyboard,
      videoAssetId: candidate.localAssetId,
      sourceCandidateId: candidate.id,
      desktop,
      workspace,
    })
    if (result.errors.length) {
      const completed = result.extracted.length + result.skipped.length
      return completed
        ? `视频已保存，已关联 ${completed}/2 帧；${result.errors.join('；')}`
        : `视频已保存，但首尾帧提取失败：${result.errors.join('；')}`
    }
    return '视频已保存到本地项目目录，首帧和尾帧已自动提取并关联'
  } catch (caught) {
    return `视频已保存，但首尾帧提取失败：${messageFor(caught, '可在分镜中手动重试')}`
  }
}

async function downloadCandidate(candidate: MediaCandidate) {
  await runCandidateAction(candidate, async () => {
    const blob = await candidateMediaBlob(candidate)
    const objectUrl = globalThis.URL.createObjectURL(blob)
    const anchor = globalThis.document.createElement('a')
    anchor.href = objectUrl
    anchor.download = `ai-${isVideo.value ? 'video' : 'voice'}-${candidate.id.slice(0, 8)}${mediaExtension(blob.type)}`
    globalThis.document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    globalThis.setTimeout(() => globalThis.URL.revokeObjectURL(objectUrl), 1_000)
  })
}

async function candidateMediaBlob(candidate: MediaCandidate) {
  const savedUrl = localSavedPreviewUrl(candidate)
  if (savedUrl) {
    const response = await globalThis.fetch(savedUrl)
    if (response.ok) return response.blob()
  }
  if (candidate.deliveryType === 'LOCAL_CACHE' && candidate.clientCandidateId) {
    const cachedUrl = desktop.generatedCandidatePreviewUrl(candidate.clientCandidateId)
    if (cachedUrl) {
      const response = await globalThis.fetch(cachedUrl)
      if (response.ok) return response.blob()
    }
  }
  return mediaGenerationApi.preview(candidate.id)
}

async function setOutput(candidate: MediaCandidate) {
  if (!candidate.localAssetId) return
  await runCandidateAction(candidate, async () => {
    await applyOutput(candidate)
  })
}

async function deleteCandidate(candidate: MediaCandidate) {
  const savedNotice = candidate.localAssetId ? '对应的未使用本地素材也会一并清理。' : ''
  if (
    !globalThis.confirm(
      `确定删除这个${isVideo.value ? '视频' : '配音'}候选吗？${savedNotice}此操作无法撤销。`,
    )
  )
    return
  await runCandidateAction(candidate, async () => {
    const deleted = await mediaGenerationApi.delete(candidate.id, candidate.version)
    if (deleted.assetDeleted && deleted.localAssetId) {
      workspace.forgetMediaAsset(deleted.localAssetId)
      if (desktop.available) {
        await desktop.removeAsset(deleted.localAssetId)
      }
    }
    const preview = remotePreviews.get(candidate.id)
    if (preview) globalThis.URL.revokeObjectURL(preview)
    remotePreviews.delete(candidate.id)
    candidates.value = candidates.value.filter((item) => item.id !== candidate.id)
    previewVersion.value += 1
  })
}

async function runCandidateAction(
  candidate: MediaCandidate,
  action: () => Promise<void>,
  fallback = '候选操作失败',
) {
  if (actingId.value) return false
  actingId.value = candidate.id
  error.value = ''
  try {
    await action()
    return true
  } catch (caught) {
    error.value = messageFor(caught, fallback)
    return false
  } finally {
    actingId.value = ''
  }
}

function replaceCandidate(candidate: MediaCandidate) {
  const index = candidates.value.findIndex((item) => item.id === candidate.id)
  if (index >= 0) candidates.value[index] = candidate
  else candidates.value.unshift(candidate)
}

async function loadRemotePreviews() {
  releasePreviews()
  const remote = candidates.value.filter(
    (candidate) =>
      !localSavedPreviewUrl(candidate) &&
      candidate.deliveryType !== 'LOCAL_CACHE' &&
      candidate.previewAvailable,
  )
  await mapSettledWithConcurrency(remote, 2, async (candidate) => {
    if (detached) return
    const blob = await mediaGenerationApi.preview(candidate.id)
    if (detached) return
    remotePreviews.set(candidate.id, globalThis.URL.createObjectURL(blob))
  })
  if (detached) return
  previewVersion.value += 1
}

function releasePreviews() {
  remotePreviews.forEach((url) => globalThis.URL.revokeObjectURL(url))
  remotePreviews.clear()
  previewVersion.value += 1
}

function previewUrl(candidate: MediaCandidate) {
  void previewVersion.value
  const savedUrl = localSavedPreviewUrl(candidate)
  if (savedUrl) return savedUrl
  if (candidate.deliveryType === 'LOCAL_CACHE' && candidate.clientCandidateId) {
    return desktop.generatedCandidatePreviewUrl(candidate.clientCandidateId)
  }
  return remotePreviews.get(candidate.id) ?? ''
}

function localSavedPreviewUrl(candidate: MediaCandidate) {
  if (!candidate.localAssetId || !desktop.available) return ''
  return (
    globalThis.window.aiDramaDesktop?.assetPreviewUrl(props.projectId, candidate.localAssetId) ?? ''
  )
}

function requiredClientCandidateId(candidate: MediaCandidate) {
  if (!candidate.clientCandidateId) throw new Error('本地候选缓存标识缺失')
  return candidate.clientCandidateId
}

function isCurrentOutput(candidate: MediaCandidate) {
  return Boolean(
    candidate.localAssetId &&
    workspace.outputForStoryboard(props.storyboardId, outputType.value)?.mediaAssetId ===
      candidate.localAssetId,
  )
}

function statusLabel(candidate: MediaCandidate) {
  if (isCurrentOutput(candidate)) return isVideo.value ? '当前视频' : '当前配音'
  if (candidate.status === 'LOCAL_SAVED') return '已保存到本地'
  if (candidate.status === 'SELECTED') return '已选中，待保存'
  return '候选'
}

function duration(value?: number | null) {
  return value ? `${(value / 1000).toFixed(1)} 秒` : '时长未知'
}

function mediaExtension(mimeType: string) {
  if (mimeType === 'video/mp4') return '.mp4'
  if (mimeType === 'video/webm') return '.webm'
  if (mimeType === 'video/quicktime') return '.mov'
  if (mimeType === 'audio/mpeg') return '.mp3'
  if (mimeType === 'audio/wav' || mimeType === 'audio/x-wav') return '.wav'
  if (mimeType === 'audio/aac') return '.aac'
  if (mimeType === 'audio/mp4') return '.m4a'
  if (mimeType === 'audio/ogg') return '.ogg'
  if (mimeType === 'audio/flac') return '.flac'
  return isVideo.value ? '.mp4' : '.mp3'
}

function createdAt(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function stringParameter(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function stringArrayParameter(value: unknown) {
  if (!Array.isArray(value)) return undefined
  const normalized = value.filter(
    (item): item is string => typeof item === 'string' && Boolean(item.trim()),
  )
  return normalized.length ? normalized.map((item) => item.trim()) : undefined
}

function numberParameter(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

async function loadMotionAssets() {
  if (!isVideo.value) return
  motionAssetsLoading.value = true
  try {
    motionAssets.value = await listBrowserMotionAssets(props.projectId)
  } catch (caught) {
    if (!detached) error.value = messageFor(caught, '动作库读取失败')
  } finally {
    motionAssetsLoading.value = false
  }
}

async function attachMotionAsset(asset: BrowserMotionAssetMeta) {
  if (motionAssetActingId.value || referenceLoading.value || submitting.value) return
  if (referenceItems.value.length >= MAX_REFERENCE_FILES) {
    error.value = `参考素材最多 ${MAX_REFERENCE_FILES} 个`
    return
  }
  motionAssetActingId.value = asset.id
  error.value = ''
  try {
    const loaded = await loadBrowserMotionAsset(props.projectId, asset.id)
    if (!loaded) throw new Error('动作素材不存在或已删除')
    const file = new globalThis.File(
      [loaded.blob],
      `${asset.label}${mediaExtension(loaded.blob.type || asset.mimeType || 'video/mp4')}`,
      {
        type: loaded.blob.type || asset.mimeType || 'video/mp4',
        lastModified: Date.now(),
      },
    )
    if (referenceBytes() + file.size > MAX_REFERENCE_TOTAL_BYTES) {
      throw new Error('参考素材总大小不能超过 100MB')
    }
    const purpose = asset.kind === 'POSE_PROXY' ? 'POSE_PROXY' : 'MOTION_REFERENCE'
    const item = await createReferenceItem(file, asset.label, false, purpose)
    item.selected = true
    referenceItems.value.unshift(item)
    if (motionMode.value === 'normal') motionMode.value = 'direct'
    referenceNotice.value = `已从动作库挂载：${asset.label}`
  } catch (caught) {
    error.value = messageFor(caught, '动作素材挂载失败')
  } finally {
    motionAssetActingId.value = ''
  }
}

async function saveReferenceAsMotionAsset(index: number) {
  const item = referenceItems.value[index]
  if (!item || item.mediaType !== 'VIDEO' || motionAssetActingId.value) return
  motionAssetActingId.value = `ref-${index}`
  error.value = ''
  try {
    const kind = item.purpose === 'POSE_PROXY' ? 'POSE_PROXY' : 'MOTION_REFERENCE'
    await saveBrowserMotionAsset({
      projectId: props.projectId,
      kind,
      label: item.label || (kind === 'POSE_PROXY' ? '姿态代理' : '动作参考'),
      blob: item.file,
      sourceCandidateId: item.candidateId,
      sourceStoryboardId: props.storyboardId,
    })
    await loadMotionAssets()
    referenceNotice.value = `已保存到动作库：${item.label}`
  } catch (caught) {
    error.value = messageFor(caught, '保存到动作库失败')
  } finally {
    motionAssetActingId.value = ''
  }
}

async function saveCandidateToMotionLibrary(candidate: MediaCandidate) {
  if (!isVideo.value || motionAssetActingId.value) return
  motionAssetActingId.value = candidate.id
  error.value = ''
  try {
    const blob = await mediaGenerationApi.preview(candidate.id)
    const isPose =
      /姿态代理|pose-proxy|POSE_PROXY/i.test(candidate.prompt) ||
      candidate.prompt.includes('简洁人体姿态')
    await saveBrowserMotionAsset({
      projectId: props.projectId,
      kind: isPose ? 'POSE_PROXY' : 'MOTION_REFERENCE',
      label: `${isPose ? '姿态代理' : '动作成片'} · ${candidate.id.slice(0, 8)}`,
      blob,
      sourceCandidateId: candidate.id,
      sourceStoryboardId: props.storyboardId,
      notes: candidate.prompt.slice(0, 120),
    })
    await loadMotionAssets()
    referenceNotice.value = '候选视频已保存到动作库'
  } catch (caught) {
    error.value = messageFor(caught, '候选保存到动作库失败')
  } finally {
    motionAssetActingId.value = ''
  }
}

async function removeMotionAsset(asset: BrowserMotionAssetMeta) {
  if (motionAssetActingId.value) return
  motionAssetActingId.value = asset.id
  try {
    await deleteBrowserMotionAsset(props.projectId, asset.id)
    await loadMotionAssets()
  } catch (caught) {
    error.value = messageFor(caught, '动作素材删除失败')
  } finally {
    motionAssetActingId.value = ''
  }
}

function onMotionTemplateChange(event: Event) {
  const value = (event.target as HTMLSelectElement).value
  if (!value) {
    selectedMotionTemplateId.value = undefined
    return
  }
  applyMotionTemplate(value as MotionShotTemplateId)
}

function applyMotionTemplate(templateId: MotionShotTemplateId) {
  const template = MOTION_SHOT_TEMPLATES.find((item) => item.id === templateId)
  if (!template) return
  selectedMotionTemplateId.value = template.id
  motionMode.value = template.recommendedMode
  const marker = '【武打镜头模板】'
  const body = `${marker}${template.title}\n${template.prompt}`
  const current = prompt.value.trim()
  if (!current) {
    prompt.value = body
  } else if (current.includes(marker)) {
    prompt.value = current.replace(/【武打镜头模板】[\s\S]*?(?=\n\n|$)/, body).trim()
  } else {
    prompt.value = `${current}\n\n${body}`
  }
  referenceNotice.value = `已套用武打模板：${template.title}（建议时长约 ${template.durationHintSec}s）`
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function close() {
  if (actingId.value || (submitting.value && !job.value)) return
  if (submitting.value && job.value) emit('backgrounded', job.value.id)
  routeOpen.value = false
  instructionRouteOpen.value = false
  cloneVoiceOpen.value = false
  emit('close')
}

function messageFor(caught: unknown, fallback: string) {
  return caught instanceof Error && caught.message ? caught.message : fallback
}
</script>

<template>
  <div v-if="open" class="modal-backdrop" @click.self="close">
    <section class="modal media-generation-modal" role="dialog" aria-modal="true">
      <header>
        <div>
          <p>{{ isVideo ? '分镜视频生成' : '对白配音生成' }}</p>
          <h2>{{ title }}</h2>
        </div>
        <button
          class="icon-button"
          type="button"
          :title="submitting && job ? '关闭窗口，任务继续在后台运行' : '关闭'"
          :disabled="submitting && !job"
          @click="close"
        >
          <X :size="18" />
        </button>
      </header>

      <div class="media-generation-layout">
        <aside class="media-prompt-editor">
          <label>
            {{ isVideo ? '动态视频提示词' : '配音文本' }}
            <textarea v-model="prompt" rows="10" maxlength="20000" />
          </label>
          <template v-if="!isVideo">
            <label>
              配音模型
              <select v-model="selectedTtsModelId">
                <option v-for="model in ttsModels" :key="model.id" :value="model.id">
                  {{ model.displayName }}
                </option>
              </select>
              <span class="field-help">选择管理端已开放的配音模型，音色会随模型自动更新。</span>
            </label>
            <label class="voice-catalog-field"
              ><span class="field-label-row"
                ><span>角色音色</span><span v-if="voiceOptionsLoading">读取中...</span></span
              ><select v-model="voice">
                <option v-for="preset in VOICE_PRESETS" :key="preset.value" :value="preset.value">
                  {{ preset.label }} · {{ preset.description }}
                </option>
                <optgroup
                  v-if="voiceOptions.some((item) => item.type === 'SYSTEM')"
                  label="更多可用音色"
                >
                  <option
                    v-for="option in voiceOptions.filter((item) => item.type === 'SYSTEM')"
                    :key="option.id"
                    :value="option.id"
                  >
                    {{ option.name }}
                  </option>
                </optgroup>
                <optgroup
                  v-if="voiceOptions.some((item) => item.type === 'CLONED')"
                  label="我的复刻音色"
                >
                  <option
                    v-for="option in voiceOptions.filter((item) => item.type === 'CLONED')"
                    :key="option.id"
                    :value="option.id"
                  >
                    {{ option.name }}
                  </option>
                </optgroup>
                <option v-if="hasCustomVoice && !selectedVoiceOption" :value="voice">
                  角色已保存的专属音色
                </option></select
              ><span class="field-help">{{
                speakerName
                  ? `当前为角色“${speakerName}”选择音色，系统会自动适配所选配音模型。`
                  : '选择听感即可，系统会自动转换成配音模型支持的音色。'
              }}</span></label
            >
            <div v-if="selectedClonedVoice" class="voice-cloned-actions">
              <span><AudioLines :size="15" />该专属音色已通过试听验证</span>
              <button
                class="button compact"
                type="button"
                :disabled="!selectedClonedVoice.previewAvailable"
                @click="previewSelectedClonedVoice"
              >
                <Volume2 :size="15" />试听 / 下载
              </button>
              <button
                class="icon-button compact danger"
                type="button"
                title="删除复刻音色"
                @click="deleteClonedVoice(selectedClonedVoice)"
              >
                <Trash2 :size="14" />
              </button>
            </div>
            <div class="voice-clone-entry">
              <div>
                <strong>复刻角色声音</strong>
                <span>上传 10 秒至 5 分钟的清晰人声，系统会创建可直接选择的专属音色。</span>
              </div>
              <label class="button compact" :class="{ disabled: !selectedTtsModelId }">
                <WandSparkles :size="15" />上传声音样本
                <input
                  type="file"
                  accept="audio/mpeg,audio/mp4,audio/wav,.mp3,.m4a,.wav"
                  :disabled="!selectedTtsModelId"
                  @change="chooseCloneVoiceFile"
                />
              </label>
            </div>
            <label class="voice-instruction-field">
              <span class="field-label-row"
                ><span>声音指令</span
                ><button
                  class="button compact"
                  type="button"
                  :disabled="instructionGenerating || !prompt.trim()"
                  @click="instructionRouteOpen = true"
                >
                  <LoaderCircle v-if="instructionGenerating" class="spin" :size="14" />
                  <Sparkles v-else :size="14" />AI 生成
                </button></span
              >
              <textarea
                v-model="instructions"
                rows="3"
                maxlength="1000"
                placeholder="情绪：压抑愤怒；音量：偏低；语速：0.82；停顿：‘你骗我’后0.4秒；句尾：下沉收住；音质：低沉克制、呼吸加重"
              />
              <span class="field-help"
                >情绪、音量、语速、停顿和句尾会转换为模型可执行参数；写得越具体，变化越明显。</span
              >
            </label>
            <label
              >语速<input v-model.number="speed" type="number" min="0.25" max="4" step="0.05"
            /></label>
          </template>
          <section v-if="isVideo" class="motion-pipeline-panel">
            <button
              class="motion-advanced-toggle"
              type="button"
              :aria-expanded="showAdvancedMotion || motionEnhanced || poseGateActive"
              @click="showAdvancedMotion = !showAdvancedMotion"
            >
              <span>
                <strong>高级动作</strong>
                <small>{{
                  motionMode === 'pose_proxy'
                    ? '姿态代理成片'
                    : motionMode === 'direct'
                      ? '动作参考'
                      : '默认关闭，普通镜头可忽略'
                }}</small>
              </span>
              <span class="motion-advanced-toggle-meta">{{
                showAdvancedMotion || motionEnhanced || poseGateActive ? '收起' : '展开'
              }}</span>
            </button>

            <div
              v-if="showAdvancedMotion || motionEnhanced || poseGateActive"
              class="motion-advanced-body"
            >
              <label class="motion-mode-select">
                生成方式
                <select v-model="motionMode" :disabled="submitting || poseGateBusy">
                  <option value="normal">普通生成（提示词 + 角色/场景参考）</option>
                  <option value="direct">动作参考（上传动作视频，1 次生成）</option>
                  <option value="pose_proxy">人物轮廓代理（本地预览确认后成片）</option>
                </select>
              </label>

              <p v-if="motionEnhanced" class="motion-pipeline-tip">
                {{
                  poseProxyEnabled
                    ? '请上传动作视频，并把用途标为“动作参考”。客户端会从原视频逐帧提取人体外轮廓，生成可播放的深度代理，确认后只把代理 MP4 发给平台。'
                    : '请上传动作视频，并把用途标为“动作参考”。生成时优先跟随动作轨迹。'
                }}
              </p>
              <p v-if="motionStage" class="form-success image-reference-notice">
                {{ motionStage }}
              </p>
              <div v-if="poseProxyProgress" class="pose-proxy-progress" role="status">
                <LoaderCircle :size="16" class="spin" />
                <span>{{ poseProxyProgress.message }}</span>
                <progress :value="poseProxyProgress.progress" max="100" />
              </div>
              <p v-if="pipelineLinkNotice" class="motion-pipeline-link">{{ pipelineLinkNotice }}</p>

              <p v-if="poseProxyEnabled" class="motion-pipeline-tip">
                生成轮廓预览不会扣点；原视频只在本地解码，不会上传。确认成片后才调用平台。
              </p>

              <div v-if="poseGateActive" class="pose-gate-panel">
                <header>
                  <div>
                    <strong>人物轮廓动作预览</strong>
                    <small
                      >这就是即将上传的平台动作参考，请确认身体轮廓、节奏和站位后再生成最终成片</small
                    >
                  </div>
                </header>
                <video
                  v-if="poseGatePreviewUrl"
                  class="pose-gate-video"
                  :src="poseGatePreviewUrl"
                  controls
                  playsinline
                  preload="metadata"
                />
                <div class="pose-gate-actions">
                  <button
                    class="button primary"
                    type="button"
                    :disabled="poseGateBusy || submitting"
                    @click="confirmPoseProxyAndContinue"
                  >
                    <Sparkles :size="15" />确认并生成最终成片
                  </button>
                  <button
                    class="button"
                    type="button"
                    :disabled="poseGateBusy || submitting"
                    @click="discardPoseProxyGate"
                  >
                    稍后成片
                  </button>
                </div>
              </div>

              <label class="motion-mode-select">
                动作模板（可选）
                <select
                  :value="selectedMotionTemplateId || ''"
                  :disabled="submitting || poseGateBusy"
                  @change="onMotionTemplateChange"
                >
                  <option value="">不使用模板</option>
                  <option
                    v-for="template in MOTION_SHOT_TEMPLATES"
                    :key="template.id"
                    :value="template.id"
                  >
                    {{ template.title }} · {{ template.summary }}
                  </option>
                </select>
              </label>

              <details class="motion-asset-details">
                <summary>
                  项目动作库
                  <small>{{
                    motionAssetsLoading
                      ? '读取中…'
                      : motionAssets.length
                        ? motionAssets.length + ' 个可复用素材'
                        : '暂无'
                  }}</small>
                </summary>
                <div class="motion-asset-panel compact">
                  <div class="motion-asset-toolbar">
                    <button
                      class="icon-button compact"
                      type="button"
                      title="刷新动作库"
                      :disabled="motionAssetsLoading || submitting"
                      @click="loadMotionAssets"
                    >
                      <RefreshCw :size="15" />
                    </button>
                  </div>
                  <div
                    v-if="!motionAssets.length && !motionAssetsLoading"
                    class="motion-asset-empty"
                  >
                    上传动作参考后可入库，供后续镜头复用。
                  </div>
                  <div v-else class="motion-asset-list">
                    <article
                      v-for="asset in motionAssets"
                      :key="asset.id"
                      class="motion-asset-card"
                    >
                      <div>
                        <strong>{{ asset.label }}</strong>
                        <small
                          >{{ asset.kind === 'POSE_PROXY' ? '姿态代理' : '动作参考' }} ·
                          {{ formatBytes(asset.sizeBytes) }}</small
                        >
                      </div>
                      <div class="motion-asset-actions">
                        <button
                          class="button compact"
                          type="button"
                          :disabled="Boolean(motionAssetActingId) || submitting || referenceLoading"
                          @click="attachMotionAsset(asset)"
                        >
                          挂载
                        </button>
                        <button
                          class="icon-button compact"
                          type="button"
                          title="删除"
                          :disabled="Boolean(motionAssetActingId)"
                          @click="removeMotionAsset(asset)"
                        >
                          <Trash2 :size="14" />
                        </button>
                      </div>
                    </article>
                  </div>
                </div>
              </details>
            </div>
          </section>

          <div v-if="isVideo" class="media-reference-input">
            <header>
              <div>
                <strong>参考素材</strong
                ><small>{{
                  referenceLoading
                    ? '正在读取角色、场景和首尾帧资产...'
                    : '下方勾选的是本次发送给视频模型的参考素材，不会替换项目里的角色图或场景图'
                }}</small>
              </div>
              <div class="media-reference-actions">
                <button
                  class="button compact"
                  type="button"
                  @click="showProjectReferencePicker = !showProjectReferencePicker"
                >
                  <FileImage :size="15" /><span>从项目素材添加</span>
                </button>
                <label
                  class="button compact media-reference-upload"
                  title="添加参考图片、视频或音频"
                >
                  <Upload :size="15" /><span>上传新素材</span>
                  <input
                    ref="referenceInput"
                    type="file"
                    accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,video/quicktime,audio/mpeg,audio/wav,audio/x-wav,audio/aac,audio/mp4,audio/ogg,audio/flac,.mp3,.wav,.aac,.m4a,.ogg,.flac,.mp4,.webm,.mov"
                    multiple
                    @change="addReferenceFiles"
                  />
                </label>
              </div>
            </header>
            <div v-if="showProjectReferencePicker" class="media-project-reference-picker">
              <header>
                <div>
                  <strong>项目已有素材</strong>
                  <small>添加前先说明素材身份，视频模型会按角色、场景或用途理解它</small>
                </div>
                <input
                  v-model="projectReferenceQuery"
                  placeholder="搜索角色图、背景图、音频或视频"
                />
              </header>
              <div class="media-reference-binding-panel">
                <label>
                  <span>素材身份</span>
                  <select v-model="projectReferenceBindingType">
                    <option value="AUTO">自动识别已有绑定</option>
                    <option value="CHARACTER">绑定到角色</option>
                    <option value="SCENE">绑定到场景</option>
                    <option value="BACKGROUND">背景/环境图</option>
                    <option value="PROP">道具</option>
                    <option value="WEAPON">武器</option>
                    <option value="MOTION">动作参考</option>
                    <option value="VOICE">角色声音</option>
                    <option value="SFX">音效/环境声</option>
                    <option value="STYLE">风格参考</option>
                  </select>
                </label>
                <label v-if="projectReferenceBindingTargets.length">
                  <span>绑定对象</span>
                  <select v-model="projectReferenceBindingTargetId">
                    <option
                      v-for="option in projectReferenceBindingTargets"
                      :key="option.value"
                      :value="option.value"
                    >
                      {{ option.label }}
                    </option>
                  </select>
                </label>
                <label>
                  <span>发送用途</span>
                  <select v-model="projectReferenceBindingPurpose">
                    <option value="">按身份自动判断</option>
                    <option value="FIRST_FRAME">首帧参考</option>
                    <option value="END_FRAME">尾帧参考</option>
                    <option value="CONTINUITY">连续性参考</option>
                    <option value="MOTION_REFERENCE">动作参考</option>
                    <option value="VOICE_IDENTITY">角色声音参考</option>
                    <option value="BACKGROUND_AUDIO">背景声音参考</option>
                  </select>
                </label>
              </div>
              <div v-if="projectReferenceAssets.length" class="media-project-reference-list">
                <button
                  v-for="asset in projectReferenceAssets.slice(0, 24)"
                  :key="asset.id"
                  type="button"
                  :disabled="Boolean(projectReferenceAddingId) || !asset.fileAvailable"
                  @click="addProjectReferenceAsset(asset)"
                >
                  <span class="media-project-reference-icon">
                    <FileImage v-if="asset.mimeType.startsWith('image/')" :size="15" />
                    <FileVideo v-else-if="asset.mimeType.startsWith('video/')" :size="15" />
                    <FileAudio v-else :size="15" />
                  </span>
                  <span>
                    <strong :title="asset.label">{{ asset.label }}</strong>
                    <small
                      >{{ (asset.sizeBytes / 1024 / 1024).toFixed(1) }}MB ·
                      {{ asset.registered ? '已登记' : '将自动登记' }}</small
                    >
                    <small class="media-project-reference-semantic">
                      {{ asset.semanticHint }}
                    </small>
                  </span>
                  <em>{{
                    projectReferenceAddingId === asset.id
                      ? '添加中'
                      : asset.fileAvailable
                        ? '添加'
                        : '不可读取'
                  }}</em>
                </button>
              </div>
              <div v-else class="media-project-reference-empty">
                项目里还没有可用图片、视频或音频素材。
              </div>
            </div>
            <div v-if="referenceItems.length" class="media-reference-list">
              <article
                v-for="(item, index) in referenceItems"
                :key="item.previewUrl"
                :class="{ linked: item.linked, disabled: !item.selected }"
              >
                <input
                  v-model="item.selected"
                  class="media-reference-check"
                  type="checkbox"
                  :aria-label="`使用${item.label}`"
                  :title="`生成时${item.selected ? '不使用' : '使用'}此素材`"
                />
                <div class="media-reference-thumb">
                  <img v-if="item.mediaType === 'IMAGE'" :src="item.previewUrl" :alt="item.label" />
                  <video
                    v-else-if="item.mediaType === 'VIDEO'"
                    :src="item.previewUrl"
                    muted
                    preload="metadata"
                  />
                  <AudioLines v-else :size="18" />
                </div>
                <div>
                  <strong v-if="item.linked" :title="item.label">{{ item.label }}</strong>
                  <input
                    v-else
                    v-model="item.label"
                    class="media-reference-label-input"
                    type="text"
                    placeholder="说明用途，如：壹绝战斗形态 / 长剑武器 / 山洞背景"
                    :aria-label="`${item.file.name}的参考素材说明`"
                  />
                  <span
                    >{{ item.linked ? '自动关联' : '手动添加' }} ·
                    {{ framePurposeLabel(item.purpose) || referenceKindLabel(item.mediaType) }} ·
                    {{ (item.file.size / 1024 / 1024).toFixed(1) }}MB</span
                  >
                  <small v-if="semanticLabelForReference(item)" class="media-reference-semantic">
                    {{ semanticLabelForReference(item) }}
                  </small>
                  <div v-if="!item.linked" class="media-reference-semantic-controls">
                    <select
                      v-model="item.bindingType"
                      class="media-reference-purpose"
                      @change="normalizeReferenceItemBinding(item)"
                    >
                      <option :value="undefined">不绑定身份</option>
                      <option value="CHARACTER">绑定到角色</option>
                      <option value="SCENE">绑定到场景</option>
                      <option value="BACKGROUND">背景/环境图</option>
                      <option value="PROP">道具</option>
                      <option value="WEAPON">武器</option>
                      <option value="MOTION">动作参考</option>
                      <option value="VOICE">角色声音</option>
                      <option value="SFX">音效/环境声</option>
                      <option value="STYLE">风格参考</option>
                    </select>
                    <select
                      v-if="bindingTargetOptions(item.bindingType).length"
                      v-model="item.bindingTargetId"
                      class="media-reference-purpose"
                      @change="normalizeReferenceItemBinding(item)"
                    >
                      <option
                        v-for="option in bindingTargetOptions(item.bindingType)"
                        :key="option.value"
                        :value="option.value"
                      >
                        {{ option.label }}
                      </option>
                    </select>
                  </div>
                  <textarea
                    v-if="!item.linked"
                    v-model="item.usageNote"
                    class="media-reference-usage-note"
                    rows="2"
                    maxlength="300"
                    placeholder="必须说明：这张图/这段音频/视频拿来干什么，例如：这是壹绝的长剑武器参考，只用于武器外观和战斗动作"
                  />
                  <small v-else-if="item.usageNote" class="media-reference-usage-note readonly">
                    {{ item.usageNote }}
                  </small>
                  <select
                    v-if="item.mediaType === 'AUDIO' && !item.linked"
                    v-model="item.purpose"
                    class="media-reference-purpose"
                    :aria-label="`${item.label}的声音用途`"
                  >
                    <option :value="undefined">普通音频参考</option>
                    <option value="VOICE_IDENTITY">角色声音参考</option>
                    <option value="BACKGROUND_AUDIO">背景声音参考</option>
                  </select>
                  <select
                    v-else-if="item.mediaType === 'VIDEO' && !item.linked"
                    v-model="item.purpose"
                    class="media-reference-purpose"
                    :aria-label="`${item.label}的视频用途`"
                  >
                    <option :value="undefined">普通视频参考</option>
                    <option value="MOTION_REFERENCE">动作参考</option>
                    <option value="POSE_PROXY">姿态代理</option>
                    <option value="CONTINUITY">连续性参考</option>
                  </select>
                </div>
                <button
                  v-if="item.mediaType === 'VIDEO' && !item.linked"
                  class="icon-button compact"
                  type="button"
                  title="保存到动作库"
                  :disabled="Boolean(motionAssetActingId) || submitting"
                  @click="saveReferenceAsMotionAsset(index)"
                >
                  <Sparkles :size="14" />
                </button>
                <button
                  v-if="!item.linked"
                  class="icon-button compact danger"
                  type="button"
                  title="移除参考素材"
                  @click="removeReferenceItem(index)"
                >
                  <Trash2 :size="13" />
                </button>
                <span v-else class="media-reference-linked">{{
                  item.selected ? '使用' : '忽略'
                }}</span>
              </article>
            </div>
            <div v-else class="media-reference-empty">
              <FileVideo :size="18" /><span
                >暂无参考素材。请确认分镜已绑定场景且角色/场景有图片，或上传补充素材。</span
              >
            </div>
            <div class="media-audio-reference-status">
              <article :class="{ ready: hasVoiceIdentityReference }">
                <Volume2 :size="15" />
                <span
                  ><strong>角色声音</strong><small>{{ voiceReferenceStatus }}</small></span
                >
              </article>
              <article :class="{ ready: hasBackgroundAudioReference }">
                <Music2 :size="15" />
                <span
                  ><strong>背景声音</strong><small>{{ backgroundAudioStatus }}</small></span
                >
              </article>
            </div>
            <p v-if="referenceNotice" class="form-success image-reference-notice">
              {{ referenceNotice }}
            </p>
          </div>
          <dl class="media-generation-facts">
            <dt>目标时长</dt>
            <dd>{{ durationSec }} 秒</dd>
            <dt v-if="isVideo">画面参考</dt>
            <dd v-if="isVideo">角色图 + 场景图</dd>
            <dt v-if="isVideo">参考素材</dt>
            <dd v-if="isVideo">已选择 {{ referenceSummary }}</dd>
            <dt v-if="isVideo">动作模式</dt>
            <dd v-if="isVideo">
              {{
                motionMode === 'pose_proxy'
                  ? '姿态代理成片'
                  : motionMode === 'direct'
                    ? '直接动作参考'
                    : '普通生成'
              }}
            </dd>
            <dt v-if="isVideo">声音方式</dt>
            <dd v-if="isVideo">{{ audioMode === 'VIDEO_NATIVE' ? '视频原声' : '后期 AI 配音' }}</dd>
            <dt v-if="!isVideo">说话角色</dt>
            <dd v-if="!isVideo">{{ speakerName || '旁白 / 未指定' }}</dd>
            <dt v-if="!isVideo">角色音色</dt>
            <dd v-if="!isVideo">{{ selectedVoiceOption?.name || voicePresetLabel(voice) }}</dd>
          </dl>
          <button
            class="button primary"
            type="button"
            :disabled="
              submitting ||
              restoringJob ||
              referenceLoading ||
              poseGateBusy ||
              (!poseGateActive && !prompt.trim())
            "
            @click="runPrimaryGeneration"
          >
            <LoaderCircle
              v-if="submitting || referenceLoading || poseGateBusy"
              class="spin"
              :size="17"
            />
            <Sparkles v-else :size="17" />{{
              referenceLoading ? '读取素材' : submitting || poseGateBusy ? '生成中' : actionLabel
            }}
          </button>
          <div v-if="job" class="image-job-status">
            <span>最近任务</span><strong>{{ job.status }}</strong
            ><small>{{ job.sourceDisplayName }} · {{ job.modelName }}</small>
          </div>
          <p v-if="autoSaveNotice" class="form-success image-reference-notice">
            {{ autoSaveNotice }}
          </p>
          <p v-if="error" class="form-error">{{ error }}</p>
        </aside>

        <main class="media-candidate-history">
          <header>
            <div>
              <h3>候选历史</h3>
              <span>{{ candidates.length }} 个</span>
            </div>
            <button
              class="icon-button compact"
              type="button"
              title="刷新候选"
              @click="loadCandidates()"
            >
              <RefreshCw :size="15" />
            </button>
          </header>
          <div v-if="loading" class="image-candidate-empty">
            <LoaderCircle class="spin" :size="24" />正在读取候选...
          </div>
          <div v-else-if="!candidates.length" class="image-candidate-empty">
            <Film v-if="isVideo" :size="28" /><Volume2 v-else :size="28" /> <strong>暂无候选</strong
            ><span>编辑提示词后选择模型生成。</span>
          </div>
          <div v-else class="media-candidate-list">
            <article
              v-for="candidate in candidates"
              :key="candidate.id"
              class="media-candidate-card"
            >
              <div class="media-candidate-preview">
                <video
                  v-if="isVideo && previewUrl(candidate)"
                  :src="previewUrl(candidate)"
                  controls
                  preload="metadata"
                />
                <audio
                  v-else-if="!isVideo && previewUrl(candidate)"
                  :src="previewUrl(candidate)"
                  controls
                  preload="metadata"
                />
                <div v-else>
                  <Film v-if="isVideo" :size="28" /><Volume2 v-else :size="28" /><span>{{
                    candidate.previewAvailable ? '预览读取失败' : '临时内容已过期'
                  }}</span>
                </div>
                <em :class="candidate.status.toLowerCase()">{{ statusLabel(candidate) }}</em>
              </div>
              <div class="media-candidate-body">
                <header>
                  <strong>{{ candidate.providerCode }}</strong
                  ><time>{{ createdAt(candidate.createdAt) }}</time>
                </header>
                <p :title="candidate.prompt">{{ candidate.prompt }}</p>
                <small
                  >{{ candidate.modelName }} · {{ duration(candidate.durationMs)
                  }}<template v-if="candidate.width">
                    · {{ candidate.width }}×{{ candidate.height }}</template
                  ></small
                >
                <footer>
                  <button
                    v-if="candidate.status === 'AVAILABLE'"
                    class="button"
                    type="button"
                    :disabled="Boolean(actingId)"
                    @click="selectCandidate(candidate)"
                  >
                    <Check :size="15" />选中
                  </button>
                  <button
                    v-if="
                      candidate.status === 'SELECTED' &&
                      desktop.available &&
                      autoSaveFailedIds.has(candidate.id)
                    "
                    class="button primary"
                    type="button"
                    :disabled="Boolean(actingId)"
                    @click="saveCandidate(candidate)"
                  >
                    <Download :size="15" />重试保存
                  </button>
                  <button
                    v-if="candidate.status === 'LOCAL_SAVED' && !isCurrentOutput(candidate)"
                    class="button primary"
                    type="button"
                    :disabled="Boolean(actingId)"
                    @click="setOutput(candidate)"
                  >
                    <Film v-if="isVideo" :size="15" /><Volume2 v-else :size="15" />设为当前{{
                      isVideo ? '视频' : '配音'
                    }}
                  </button>
                  <button
                    class="button"
                    type="button"
                    :disabled="Boolean(actingId)"
                    title="下载媒体文件"
                    @click="downloadCandidate(candidate)"
                  >
                    <Download :size="15" />下载
                  </button>
                  <button
                    v-if="
                      isVideo &&
                      (candidate.status === 'AVAILABLE' ||
                        candidate.status === 'SELECTED' ||
                        candidate.status === 'LOCAL_SAVED')
                    "
                    class="button"
                    type="button"
                    :disabled="Boolean(actingId) || Boolean(motionAssetActingId)"
                    @click="saveCandidateToMotionLibrary(candidate)"
                  >
                    <FileVideo :size="15" />入库动作库
                  </button>
                  <span v-if="isCurrentOutput(candidate)" class="image-reference-done"
                    ><Check :size="14" />已完成</span
                  >
                  <button
                    v-if="!isCurrentOutput(candidate)"
                    class="icon-button compact danger"
                    type="button"
                    :disabled="Boolean(actingId)"
                    :title="`删除${isVideo ? '视频' : '配音'}候选`"
                    @click="deleteCandidate(candidate)"
                  >
                    <Trash2 :size="15" />
                  </button>
                </footer>
              </div>
            </article>
          </div>
        </main>
      </div>
    </section>
  </div>

  <GenerationRouteDialog
    v-if="isVideo"
    :open="routeOpen"
    :submitting="submitting"
    :service-type="mediaType"
    :eyebrow="isVideo ? '视频生成' : '配音生成'"
    :title="isVideo ? '选择本次使用的视频模型' : '选择本次使用的配音模型'"
    :submit-label="actionLabel"
    :quote-prompt="prompt"
    :quote-parameters="isVideo ? { duration: durationSec, seconds: durationSec } : {}"
    @close="routeOpen = false"
    @submit="generate"
  />
  <GenerationRouteDialog
    :open="instructionRouteOpen"
    :submitting="instructionGenerating"
    service-type="TEXT"
    eyebrow="声音导演"
    title="选择生成声音指令的文本模型"
    submit-label="生成声音指令"
    :quote-prompt="prompt"
    @close="instructionRouteOpen = false"
    @submit="generateVoiceInstructions"
  />
  <div
    v-if="cloneVoiceOpen"
    class="modal-backdrop nested"
    @click.self="!cloningVoice && (cloneVoiceOpen = false)"
  >
    <section class="modal voice-clone-modal" role="dialog" aria-modal="true">
      <header>
        <div>
          <p>角色声音</p>
          <h2>复刻专属音色</h2>
        </div>
        <button
          class="icon-button"
          type="button"
          title="关闭"
          :disabled="cloningVoice"
          @click="cloneVoiceOpen = false"
        >
          <X :size="18" />
        </button>
      </header>
      <div class="voice-clone-body">
        <template v-if="!clonedVoiceResult">
          <div class="voice-clone-file">
            <FileAudio :size="22" /><span
              ><strong>{{ cloneVoiceFile?.name }}</strong
              ><small>MP3 / M4A / WAV · 10 秒至 5 分钟 · 最大 20MB</small></span
            >
          </div>
          <label
            >音色名称<input
              v-model="cloneVoiceName"
              maxlength="120"
              placeholder="例如：壹绝·冷峻青年声"
          /></label>
          <label
            >试听文本<textarea
              v-model="cloneVoiceTranscript"
              rows="3"
              maxlength="200"
              placeholder="例如：欢迎来到移光漫剧工坊，这是我的角色声音。"
            />
          </label>
          <p class="route-notice">
            请只上传本人或已获授权的声音。样本仅转发用于复刻，不保存到服务器素材库；生成的试听仅临时缓存。
          </p>
        </template>
        <div v-else class="voice-clone-result">
          <div>
            <Check :size="22" /><span
              ><strong>{{ clonedVoiceResult.name }}</strong
              ><small>复刻成功，试听确认后才会绑定角色</small></span
            >
          </div>
          <div v-if="clonedVoicePreviewLoading" class="voice-clone-preview-loading">
            <LoaderCircle class="spin" :size="18" />正在读取试听...
          </div>
          <audio
            v-else-if="clonedVoicePreviewUrl"
            :src="clonedVoicePreviewUrl"
            controls
            preload="metadata"
          />
          <p v-else class="route-notice">试听已过期或暂不可用，音色本身仍可用于配音。</p>
          <small v-if="clonedVoiceResult.previewExpiresAt"
            >试听临时缓存至
            {{ new Date(clonedVoiceResult.previewExpiresAt).toLocaleString() }}</small
          >
        </div>
      </div>
      <footer>
        <button
          class="button"
          type="button"
          :disabled="cloningVoice"
          @click="cloneVoiceOpen = false"
        >
          关闭
        </button>
        <template v-if="clonedVoiceResult">
          <button
            class="button"
            type="button"
            :disabled="!clonedVoicePreviewUrl"
            @click="downloadClonedVoicePreview(clonedVoiceResult)"
          >
            <Download :size="16" />下载试听
          </button>
          <button class="button primary" type="button" @click="useClonedVoice(clonedVoiceResult)">
            <Check :size="16" />使用此音色
          </button>
        </template>
        <button
          v-else
          class="button primary"
          type="button"
          :disabled="cloningVoice || !cloneVoiceName.trim() || !cloneVoiceFile"
          @click="cloneVoice"
        >
          <LoaderCircle v-if="cloningVoice" class="spin" :size="16" /><WandSparkles
            v-else
            :size="16"
          />{{ cloningVoice ? '复刻并生成试听中...' : '复刻并生成试听' }}
        </button>
      </footer>
    </section>
  </div>
</template>
