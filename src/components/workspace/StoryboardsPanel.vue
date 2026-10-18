<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Clapperboard,
  Clock3,
  Download,
  Film,
  Image as ImageIcon,
  LoaderCircle,
  Music2,
  Plus,
  Save,
  Scissors,
  Sparkles,
  Trash2,
  Upload,
  Volume2,
  X,
} from 'lucide-vue-next'
import { ApiClientError } from '../../api/client'
import {
  generationApi,
  type GenerationJob,
  type GenerationJobStatus,
  type GenerationRoute,
} from '../../api/generation'
import {
  mediaGenerationApi,
  type BatchMediaGenerationItemInput,
  type BatchMediaGenerationPreviewItem,
  type BatchMediaGenerationResult,
  type MediaCandidate,
} from '../../api/media-generation'
import { storyboardCandidateApi, type StoryboardCandidate } from '../../api/storyboard-candidates'
import type { CharacterAsset, Storyboard, StoryboardInput } from '../../api/workspace'
import { executeTextGeneration } from '../../composables/text-generation'
import { projectFrameProfile } from '../../domain/project-frame-profile'
import {
  resolveStoryboardScene,
  storyboardReferenceAssets,
} from '../../domain/storyboard-reference-assets'
import { storyboardMediaReferences } from '../../domain/storyboard-media-references'
import {
  deleteBrowserImage,
  deleteBrowserMedia,
  loadBrowserImage,
  loadBrowserMedia,
  saveBrowserImage,
  saveBrowserMedia,
  sha256Hex,
  validateBrowserImage,
} from '../../browser/browser-image-store'
import {
  extractAudioSegment,
  extractVideoFrame,
  type VideoFramePosition,
} from '../../browser/browser-media-extractor'
import type { LocalAsset } from '../../desktop/types'
import GenerationRouteDialog from '../generation/GenerationRouteDialog.vue'
import MediaGenerationDialog from '../generation/MediaGenerationDialog.vue'
import StoryboardCandidateDialog from '../generation/StoryboardCandidateDialog.vue'
import { useCreditStore } from '../../stores/credits'
import { useDesktopStore } from '../../stores/desktop'
import { useWorkspaceStore } from '../../stores/workspace'
import { projectVideoStylePrompt } from '../../domain/production-visual-style'

const props = defineProps<{ projectId: string; active?: boolean }>()
type BatchVideoJobState = {
  jobId?: string | null
  status: GenerationJobStatus | 'CREATING'
  progress: number
  errorMessage?: string | null
  reservedPoints?: number
  updatedAt?: string | null
}
const workspace = useWorkspaceStore()
const desktop = useDesktopStore()
const credits = useCreditStore()
const selectedId = ref('')
const saving = ref(false)
const deletingStoryboards = ref(false)
const reordering = ref(false)
const formError = ref('')
const formNotice = ref('')
const showRouteDialog = ref(false)
const shotPaceMode = ref<'AUTO' | 'FIXED_15' | 'DETAILED'>('AUTO')
const showCandidateDialog = ref(false)
const generating = ref(false)
const checkingCandidate = ref(false)
const applyingCandidate = ref(false)
const storyboardCandidate = ref<StoryboardCandidate | null>(null)
const candidateError = ref('')
const generationIdempotencyKey = ref('')
const generationRequestSignature = ref('')
const applyIdempotencyKey = ref('')
const applyCandidateId = ref('')
const applyRequestSignature = ref('')
const videoStoryboard = ref<Storyboard | null>(null)
const batchVideoSelectedIds = ref<string[]>([])
const showBatchVideoDialog = ref(false)
const batchVideoSubmitting = ref(false)
const batchVideoResult = ref<BatchMediaGenerationResult | null>(null)
const batchVideoIdempotencyKey = ref('')
const batchVideoPreviewLoading = ref(false)
const batchVideoPreviewError = ref('')
const batchVideoPreviewItems = ref<Record<string, BatchMediaGenerationPreviewItem>>({})
const batchVideoJobStates = ref<Record<string, BatchVideoJobState>>({})
const voiceStoryboard = ref<Storyboard | null>(null)
const showVoiceSampleDialog = ref(false)
const extractingVoiceSample = ref(false)
const extractingFrame = ref<VideoFramePosition | ''>('')
const audioExtractionTarget = ref<'CHARACTER_VOICE' | 'BGM'>('CHARACTER_VOICE')
const voiceSampleCharacterId = ref('')
const voiceSampleStartSec = ref(0)
const voiceSampleEndSec = ref(10)
const browserUploadInput = ref<globalThis.HTMLInputElement>()
const browserUploadTarget = ref<{
  storyboardId: string
  outputType: 'KEYFRAME' | 'END_FRAME'
} | null>(null)
const browserKeyframePreviewUrl = ref('')
const browserKeyframeAssetId = ref('')
const browserEndFramePreviewUrl = ref('')
const browserEndFrameAssetId = ref('')
const browserBgmPreviewUrl = ref('')
const browserBgmAssetId = ref('')
const uploadingFrame = ref<'KEYFRAME' | 'END_FRAME' | ''>('')
const videoCandidates = ref<MediaCandidate[]>([])
const videoCandidatePreviewUrl = ref('')
const videoCandidateLoading = ref(false)
const videoCandidateError = ref('')
const downloadingVideoCandidate = ref(false)
const deletingVideoCandidate = ref(false)
let videoCandidateLoadToken = 0
let videoCandidateRefreshTimer: ReturnType<typeof globalThis.setTimeout> | undefined
let videoCandidateRefreshAttempts = 0
let batchVideoJobPollTimer: ReturnType<typeof globalThis.setTimeout> | undefined
let batchVideoJobPollAttempts = 0
const VIDEO_CANDIDATE_REFRESH_INTERVAL_MS = 5_000
const VIDEO_CANDIDATE_REFRESH_LIMIT = 120
const BATCH_VIDEO_JOB_POLL_INTERVAL_MS = 4_000
const BATCH_VIDEO_JOB_POLL_LIMIT = 180
const form = reactive<StoryboardInput>(emptyForm())
const formSnapshot = ref('')
const dirty = computed(() => JSON.stringify(form) !== formSnapshot.value)
const projectFrame = computed(() => projectFrameProfile(workspace.project?.aspectRatio))
const keyframePreviewStyle = computed(() => ({
  aspectRatio: projectFrame.value.cssAspectRatio,
  maxWidth: projectFrame.value.previewMaxWidth,
}))
const selectedEpisodeId = computed({
  get: () => workspace.activeEpisodeId,
  set: (episodeId: string) => {
    if (episodeId === workspace.activeEpisodeId || !canDiscardChanges()) return
    batchVideoSelectedIds.value = []
    batchVideoResult.value = null
    batchVideoPreviewItems.value = {}
    batchVideoJobStates.value = {}
    clearBatchVideoJobPoll()
    showBatchVideoDialog.value = false
    void workspace.selectEpisode(props.projectId, episodeId)
  },
})
const selectedStoryboard = computed(
  () => workspace.storyboards.find((item) => item.id === selectedId.value) ?? null,
)
const batchVideoSelectedStoryboards = computed(() =>
  workspace.storyboards.filter((item) => batchVideoSelectedIds.value.includes(item.id)),
)
const batchVideoSelectedCount = computed(() => batchVideoSelectedStoryboards.value.length)
const batchVideoTotalDurationSec = computed(() =>
  batchVideoSelectedStoryboards.value.reduce(
    (sum, item) => sum + Math.max(1, item.durationSec || 1),
    0,
  ),
)
const batchVideoPromptPreviews = computed(() =>
  batchVideoSelectedStoryboards.value.map((storyboard) => {
    const preview = batchVideoPreviewItems.value[storyboard.id]
    return {
      storyboardId: storyboard.id,
      shotNo: storyboard.shotNo,
      title: storyboard.title,
      durationSec: Math.max(1, Math.min(300, storyboard.durationSec || 10)),
      prompt: preview?.effectivePrompt || storyboardVideoPrompt(storyboard),
      parameters: preview?.parameters || batchVideoParameters(storyboard),
    }
  }),
)
const batchVideoQuoteItems = computed(() =>
  batchVideoPromptPreviews.value.map((item) => ({
    prompt: item.prompt,
    parameters: item.parameters,
  })),
)
const batchVideoCombinedPrompt = computed(() =>
  batchVideoPromptPreviews.value
    .map((item) => `镜头 ${item.shotNo} · ${item.title}\n${item.prompt}`)
    .join('\n\n---\n\n')
    .slice(0, 20_000),
)
const allEpisodeStoryboardsSelectedForBatch = computed(
  () =>
    workspace.storyboards.length > 0 &&
    workspace.storyboards.every((item) => batchVideoSelectedIds.value.includes(item.id)),
)
const selectedCharacters = computed(() =>
  workspace.characters.filter((item) => form.characterIds.includes(item.id)),
)
const aiBusy = computed(
  () => generating.value || checkingCandidate.value || applyingCandidate.value,
)
const hasSavedScript = computed(() => Boolean(workspace.activeEpisode?.scriptText?.trim()))
const hasVoiceContent = computed(() =>
  Boolean(form.dialogue?.trim() || form.innerMonologue?.trim()),
)
const keyframeOutput = computed(() =>
  selectedStoryboard.value
    ? workspace.outputForStoryboard(selectedStoryboard.value.id, 'KEYFRAME')
    : undefined,
)
const endFrameOutput = computed(() =>
  selectedStoryboard.value
    ? workspace.outputForStoryboard(selectedStoryboard.value.id, 'END_FRAME')
    : undefined,
)
const keyframePreviewUrl = computed(() => {
  const assetId = keyframeOutput.value?.mediaAssetId
  if (!assetId) return ''
  if (desktop.available) {
    const local = desktop.project?.assets.find((asset) => asset.id === assetId)
    return local?.fileAvailable ? desktop.assetPreviewUrl(local.id) : ''
  }
  return browserKeyframeAssetId.value === assetId ? browserKeyframePreviewUrl.value : ''
})
const videoOutput = computed(() =>
  selectedStoryboard.value
    ? workspace.outputForStoryboard(selectedStoryboard.value.id, 'VIDEO')
    : undefined,
)
const voiceOutput = computed(() =>
  selectedStoryboard.value
    ? workspace.outputForStoryboard(selectedStoryboard.value.id, 'VOICE')
    : undefined,
)
const bgmOutput = computed(() =>
  selectedStoryboard.value
    ? workspace.outputForStoryboard(selectedStoryboard.value.id, 'BGM')
    : undefined,
)
const videoPreviewUrl = computed(() => outputPreviewUrl(videoOutput.value?.mediaAssetId))
const voicePreviewUrl = computed(() => outputPreviewUrl(voiceOutput.value?.mediaAssetId))
const endFramePreviewUrl = computed(
  () =>
    outputPreviewUrl(endFrameOutput.value?.mediaAssetId) ||
    (browserEndFrameAssetId.value === endFrameOutput.value?.mediaAssetId
      ? browserEndFramePreviewUrl.value
      : ''),
)
const bgmPreviewUrl = computed(
  () =>
    outputPreviewUrl(bgmOutput.value?.mediaAssetId) ||
    (browserBgmAssetId.value === bgmOutput.value?.mediaAssetId ? browserBgmPreviewUrl.value : ''),
)
const latestVideoCandidate = computed(() => videoCandidates.value[0] ?? null)
const extractableVideoAssetId = computed(
  () => videoOutput.value?.mediaAssetId ?? latestVideoCandidate.value?.localAssetId ?? '',
)
const hasExtractableVideo = computed(() =>
  desktop.available
    ? Boolean(extractableVideoAssetId.value)
    : Boolean(latestVideoCandidate.value?.previewAvailable),
)
const extractionDurationSec = computed(() => {
  const candidateDuration = (latestVideoCandidate.value?.durationMs ?? 0) / 1000
  return Math.max(1, candidateDuration || selectedStoryboard.value?.durationSec || 10)
})
const voiceSampleCharacterOptions = computed(() =>
  selectedCharacters.value.length ? selectedCharacters.value : workspace.characters,
)
const visibleVideoPreviewUrl = computed(
  () => videoPreviewUrl.value || videoCandidatePreviewUrl.value,
)
const videoMediaReferences = computed(() =>
  videoStoryboard.value
    ? storyboardMediaReferences(
        videoStoryboard.value,
        workspace.storyboards,
        workspace.storyboardOutputs,
        workspace.characters,
        workspace.characterVoiceReferences,
      )
    : [],
)
const aiButtonTitle = computed(() => {
  if (!workspace.activeEpisode) return '请先创建分集'
  if (!workspace.activeEpisode.scriptText?.trim()) return '请先在剧本页生成或填写剧本并保存'
  if (dirty.value) return '请先保存当前分镜修改'
  return '根据已保存剧本生成可审核的分镜候选'
})

watch(
  () => [workspace.activeEpisodeId, workspace.storyboards.map((item) => item.id).join(',')],
  () => {
    const selected = workspace.storyboards.find((item) => item.id === selectedId.value)
    if (selected) return
    const first = workspace.storyboards[0]
    if (first) setStoryboard(first)
    else setCreate()
  },
  { immediate: true },
)

watch(
  () => `${desktop.available}:${keyframeOutput.value?.mediaAssetId ?? ''}`,
  () => void loadBrowserKeyframePreview(),
  { immediate: true },
)

watch(
  () =>
    `${desktop.available}:${endFrameOutput.value?.mediaAssetId ?? ''}:${bgmOutput.value?.mediaAssetId ?? ''}`,
  () => void loadBrowserExtractedPreviews(),
  { immediate: true },
)

watch(
  () => selectedStoryboard.value?.id ?? '',
  () => void loadVideoCandidates(),
  { immediate: true },
)

watch(
  () => form.characterIds.join(','),
  () => {
    if (form.speakerCharacterId && !form.characterIds.includes(form.speakerCharacterId)) {
      form.speakerCharacterId = ''
    }
  },
)

onBeforeUnmount(() => {
  clearBrowserKeyframePreview()
  clearBrowserEndFramePreview()
  clearBrowserBgmPreview()
  clearVideoCandidateRefresh()
  clearBatchVideoJobPoll()
  clearVideoCandidatePreview()
})

function emptyForm(): StoryboardInput {
  return {
    title: '',
    sceneId: '',
    characterIds: [],
    shotType: '中景',
    angle: '平视',
    movement: '固定',
    location: '',
    timeOfDay: '',
    actionText: '',
    dialogue: '',
    innerMonologue: '',
    audioMode: 'AI_DUB',
    speakerCharacterId: '',
    description: '',
    resultText: '',
    atmosphere: '',
    imagePrompt: '',
    videoPrompt: '',
    bgmPrompt: '',
    soundEffect: '',
    durationSec: 10,
  }
}
function rememberForm() {
  formSnapshot.value = JSON.stringify(form)
}
function canDiscardChanges() {
  if (props.active === false) return true
  return !dirty.value || globalThis.confirm('当前分镜有未保存修改，确定放弃吗？')
}
onBeforeRouteLeave(canDiscardChanges)
onBeforeRouteUpdate(canDiscardChanges)
function setCreate() {
  selectedId.value = ''
  Object.assign(form, emptyForm())
  rememberForm()
  formError.value = ''
}
function setStoryboard(storyboard: Storyboard) {
  selectedId.value = storyboard.id
  Object.assign(form, {
    title: storyboard.title,
    sceneId: storyboard.sceneId ?? '',
    characterIds: [...storyboard.characterIds],
    shotType: storyboard.shotType ?? '',
    angle: storyboard.angle ?? '',
    movement: storyboard.movement ?? '',
    location: storyboard.location ?? '',
    timeOfDay: storyboard.timeOfDay ?? '',
    actionText: storyboard.actionText ?? '',
    dialogue: storyboard.dialogue ?? '',
    innerMonologue: storyboard.innerMonologue ?? '',
    audioMode: storyboard.audioMode ?? 'AI_DUB',
    speakerCharacterId: storyboard.speakerCharacterId ?? '',
    description: storyboard.description ?? '',
    resultText: storyboard.resultText ?? '',
    atmosphere: storyboard.atmosphere ?? '',
    imagePrompt: storyboard.imagePrompt ?? '',
    videoPrompt: storyboard.videoPrompt ?? '',
    bgmPrompt: storyboard.bgmPrompt ?? '',
    soundEffect: storyboard.soundEffect ?? '',
    durationSec: storyboard.durationSec,
    version: storyboard.version,
  })
  rememberForm()
  formError.value = ''
}
function openCreate() {
  if (canDiscardChanges()) setCreate()
}
function openStoryboard(storyboard: Storyboard) {
  if (storyboard.id === selectedId.value || !canDiscardChanges()) return
  setStoryboard(storyboard)
}
async function uploadFrame(outputType: 'KEYFRAME' | 'END_FRAME') {
  const storyboard = selectedStoryboard.value
  const frameLabel = outputType === 'KEYFRAME' ? '首帧' : '尾帧'
  if (!storyboard || dirty.value || uploadingFrame.value) {
    formError.value = `请先保存当前分镜，再上传${frameLabel}`
    return
  }
  formError.value = ''
  formNotice.value = ''
  if (!desktop.available) {
    browserUploadTarget.value = { storyboardId: storyboard.id, outputType }
    browserUploadInput.value?.click()
    return
  }
  uploadingFrame.value = outputType
  try {
    const imported = await desktop.importAssets('storyboards')
    const selected = imported[0]
    if (!selected) {
      if (desktop.error) formError.value = desktop.error
      return
    }
    const mappings = await workspace.synchronizeLocalAssets(props.projectId, imported)
    const canonicalId =
      mappings.find((item) => item.clientAssetId === selected.id)?.assetId ?? selected.id
    await desktop.reconcileAssetIds(mappings.filter((item) => item.clientAssetId !== item.assetId))
    await workspace.setStoryboardOutput(props.projectId, storyboard.id, {
      outputType,
      mediaAssetId: canonicalId,
      sourceType: 'MANUAL',
    })
    formNotice.value =
      imported.length > 1
        ? `已导入 ${imported.length} 张图片，并将第一张设置为当前${frameLabel}`
        : `${frameLabel}已上传，可在视频生成时选择使用`
  } catch (error) {
    formError.value = error instanceof Error ? error.message : `${frameLabel}上传失败`
  } finally {
    uploadingFrame.value = ''
  }
}
async function uploadBrowserFrame(event: globalThis.Event) {
  const input = event.target as globalThis.HTMLInputElement
  const file = input.files?.[0]
  const target = browserUploadTarget.value
  const storyboard = workspace.storyboards.find((item) => item.id === target?.storyboardId)
  input.value = ''
  browserUploadTarget.value = null
  if (!file || !storyboard || !target || uploadingFrame.value) return
  const frameLabel = target.outputType === 'KEYFRAME' ? '首帧' : '尾帧'
  uploadingFrame.value = target.outputType
  formError.value = ''
  formNotice.value = ''
  const clientAssetId = globalThis.crypto.randomUUID()
  let canonicalId = ''
  let outputSet = false
  try {
    const imageFile = await validateBrowserImage(file)
    const localAsset: LocalAsset = {
      id: clientAssetId,
      category: 'storyboards',
      originalName: imageFile.name,
      relativePath: `browser-local/${clientAssetId}`,
      sizeBytes: imageFile.size,
      sha256: await sha256Hex(imageFile),
      mimeType: imageFile.type,
      importedAt: new Date().toISOString(),
      fileAvailable: true,
    }
    const mappings = await workspace.synchronizeLocalAssets(props.projectId, [localAsset])
    canonicalId = mappings[0]?.assetId ?? clientAssetId
    await saveBrowserImage(props.projectId, canonicalId, imageFile)
    await workspace.setStoryboardOutput(props.projectId, storyboard.id, {
      outputType: target.outputType,
      mediaAssetId: canonicalId,
      sourceType: 'MANUAL',
    })
    outputSet = true
    if (target.outputType === 'KEYFRAME') setBrowserKeyframePreview(canonicalId, imageFile)
    else setBrowserEndFramePreview(canonicalId, imageFile)
    formNotice.value = `${frameLabel}已上传，可在视频生成时选择使用`
  } catch (error) {
    if (!outputSet && canonicalId === clientAssetId) {
      await deleteBrowserImage(props.projectId, canonicalId).catch(() => undefined)
      await workspace.deleteMediaAsset(props.projectId, canonicalId).catch(() => undefined)
    }
    formError.value = error instanceof Error ? error.message : `${frameLabel}上传失败`
  } finally {
    uploadingFrame.value = ''
  }
}
async function loadBrowserKeyframePreview() {
  if (desktop.available) {
    clearBrowserKeyframePreview()
    return
  }
  const assetId = keyframeOutput.value?.mediaAssetId
  if (!assetId) {
    clearBrowserKeyframePreview()
    return
  }
  if (browserKeyframeAssetId.value && browserKeyframeAssetId.value !== assetId) {
    clearBrowserKeyframePreview()
  }
  const blob = await loadBrowserImage(props.projectId, assetId).catch(() => null)
  if (!blob || keyframeOutput.value?.mediaAssetId !== assetId) return
  setBrowserKeyframePreview(assetId, blob)
}
function setBrowserKeyframePreview(assetId: string, blob: globalThis.Blob) {
  clearBrowserKeyframePreview()
  browserKeyframeAssetId.value = assetId
  browserKeyframePreviewUrl.value = globalThis.URL.createObjectURL(blob)
}
function clearBrowserKeyframePreview() {
  if (browserKeyframePreviewUrl.value) {
    globalThis.URL.revokeObjectURL(browserKeyframePreviewUrl.value)
  }
  browserKeyframePreviewUrl.value = ''
  browserKeyframeAssetId.value = ''
}
async function loadBrowserExtractedPreviews() {
  if (desktop.available) {
    clearBrowserEndFramePreview()
    clearBrowserBgmPreview()
    return
  }
  const endFrameAssetId = endFrameOutput.value?.mediaAssetId ?? ''
  const bgmAssetId = bgmOutput.value?.mediaAssetId ?? ''
  if (browserEndFrameAssetId.value !== endFrameAssetId) clearBrowserEndFramePreview()
  if (browserBgmAssetId.value !== bgmAssetId) clearBrowserBgmPreview()
  const [endFrameBlob, bgmBlob] = await Promise.all([
    endFrameAssetId ? loadBrowserImage(props.projectId, endFrameAssetId).catch(() => null) : null,
    bgmAssetId ? loadBrowserMedia(props.projectId, bgmAssetId).catch(() => null) : null,
  ])
  if (endFrameBlob && endFrameOutput.value?.mediaAssetId === endFrameAssetId) {
    setBrowserEndFramePreview(endFrameAssetId, endFrameBlob)
  }
  if (bgmBlob && bgmOutput.value?.mediaAssetId === bgmAssetId) {
    setBrowserBgmPreview(bgmAssetId, bgmBlob)
  }
}
function setBrowserEndFramePreview(assetId: string, blob: globalThis.Blob) {
  clearBrowserEndFramePreview()
  browserEndFrameAssetId.value = assetId
  browserEndFramePreviewUrl.value = globalThis.URL.createObjectURL(blob)
}
function clearBrowserEndFramePreview() {
  if (browserEndFramePreviewUrl.value) {
    globalThis.URL.revokeObjectURL(browserEndFramePreviewUrl.value)
  }
  browserEndFramePreviewUrl.value = ''
  browserEndFrameAssetId.value = ''
}
function setBrowserBgmPreview(assetId: string, blob: globalThis.Blob) {
  clearBrowserBgmPreview()
  browserBgmAssetId.value = assetId
  browserBgmPreviewUrl.value = globalThis.URL.createObjectURL(blob)
}
function clearBrowserBgmPreview() {
  if (browserBgmPreviewUrl.value) globalThis.URL.revokeObjectURL(browserBgmPreviewUrl.value)
  browserBgmPreviewUrl.value = ''
  browserBgmAssetId.value = ''
}
async function currentBrowserVideoBlob() {
  const candidate = latestVideoCandidate.value
  if (!candidate?.previewAvailable) {
    throw new Error('当前视频没有可读取文件，远程预览可能已经过期')
  }
  return mediaGenerationApi.preview(candidate.id)
}
async function registerBrowserExtractedAsset(
  blob: globalThis.Blob,
  category: 'storyboards' | 'audio',
  originalName: string,
) {
  const clientAssetId = globalThis.crypto.randomUUID()
  const localAsset: LocalAsset = {
    id: clientAssetId,
    category,
    originalName,
    relativePath: `browser-local/${clientAssetId}`,
    sizeBytes: blob.size,
    sha256: await sha256Hex(blob),
    mimeType: blob.type,
    importedAt: new Date().toISOString(),
    fileAvailable: true,
  }
  const mappings = await workspace.synchronizeLocalAssets(props.projectId, [localAsset])
  const assetId = mappings[0]?.assetId ?? clientAssetId
  if (category === 'storyboards') await saveBrowserImage(props.projectId, assetId, blob)
  else await saveBrowserMedia(props.projectId, assetId, blob)
  return { assetId, clientAssetId }
}
async function extractVideoFrameAsset(position: VideoFramePosition) {
  const storyboard = selectedStoryboard.value
  if (!storyboard || dirty.value || extractingFrame.value || !hasExtractableVideo.value) return
  const outputType = position === 'FIRST' ? 'KEYFRAME' : 'END_FRAME'
  const frameLabel = position === 'FIRST' ? '首帧' : '尾帧'
  extractingFrame.value = position
  formError.value = ''
  formNotice.value = ''
  let browserAsset: { assetId: string; clientAssetId: string } | undefined
  try {
    let assetId: string
    let previewBlob: globalThis.Blob | undefined
    if (desktop.available) {
      const localAsset = await desktop.extractVideoFrame({
        projectId: props.projectId,
        videoAssetId: extractableVideoAssetId.value,
        outputName: `${storyboard.shotNo}-${storyboard.title}-${frameLabel}`,
        position,
      })
      const mappings = await workspace.synchronizeLocalAssets(props.projectId, [localAsset])
      assetId = mappings[0]?.assetId ?? localAsset.id
      await desktop.reconcileAssetIds(
        mappings.filter((item) => item.clientAssetId !== item.assetId),
      )
    } else {
      const extracted = await extractVideoFrame(await currentBrowserVideoBlob(), position)
      previewBlob = extracted.blob
      browserAsset = await registerBrowserExtractedAsset(
        extracted.blob,
        'storyboards',
        `${String(storyboard.shotNo).padStart(2, '0')}-${safeFilename(storyboard.title)}-${frameLabel}.png`,
      )
      assetId = browserAsset.assetId
    }
    await workspace.setStoryboardOutput(props.projectId, storyboard.id, {
      outputType,
      mediaAssetId: assetId,
      sourceType: 'MANUAL',
    })
    if (previewBlob) {
      if (outputType === 'KEYFRAME') setBrowserKeyframePreview(assetId, previewBlob)
      else setBrowserEndFramePreview(assetId, previewBlob)
    }
    formNotice.value = `视频${frameLabel}已提取并保存，可在后续视频生成时选择使用`
  } catch (error) {
    if (browserAsset?.assetId === browserAsset?.clientAssetId) {
      await deleteBrowserImage(props.projectId, browserAsset.assetId).catch(() => undefined)
      await workspace.deleteMediaAsset(props.projectId, browserAsset.assetId).catch(() => undefined)
    }
    formError.value = error instanceof Error ? error.message : `视频${frameLabel}提取失败`
  } finally {
    extractingFrame.value = ''
  }
}

async function downloadFrame(outputType: 'KEYFRAME' | 'END_FRAME') {
  const output = outputType === 'KEYFRAME' ? keyframeOutput.value : endFrameOutput.value
  const storyboard = selectedStoryboard.value
  if (!output || !storyboard) return
  const frameLabel = outputType === 'KEYFRAME' ? '首帧' : '尾帧'
  formError.value = ''
  try {
    let blob: globalThis.Blob | null
    if (desktop.available) {
      const response = await globalThis.fetch(desktop.assetPreviewUrl(output.mediaAssetId))
      if (!response.ok) throw new Error(`${frameLabel}文件读取失败`)
      blob = await response.blob()
    } else {
      blob = await loadBrowserImage(props.projectId, output.mediaAssetId)
    }
    if (!blob) throw new Error(`${frameLabel}文件不在当前本机工作目录`)
    const url = globalThis.URL.createObjectURL(blob)
    const anchor = globalThis.document.createElement('a')
    anchor.href = url
    anchor.download = `${String(storyboard.shotNo).padStart(2, '0')}-${safeFilename(storyboard.title)}-${frameLabel}.png`
    globalThis.document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    globalThis.setTimeout(() => globalThis.URL.revokeObjectURL(url), 1_000)
  } catch (error) {
    formError.value = error instanceof Error ? error.message : `${frameLabel}下载失败`
  }
}

async function deleteFrame(outputType: 'KEYFRAME' | 'END_FRAME') {
  const output = outputType === 'KEYFRAME' ? keyframeOutput.value : endFrameOutput.value
  const storyboard = selectedStoryboard.value
  if (!output || !storyboard) return
  const frameLabel = outputType === 'KEYFRAME' ? '首帧' : '尾帧'
  if (!globalThis.confirm(`确定删除当前${frameLabel}资产吗？`)) return
  formError.value = ''
  try {
    await workspace.deleteStoryboardOutput(props.projectId, storyboard.id, outputType)
    const usedElsewhere =
      workspace.storyboardOutputs.some(
        (item) => item.id !== output.id && item.mediaAssetId === output.mediaAssetId,
      ) ||
      workspace.characterReferences.some((item) => item.assetId === output.mediaAssetId) ||
      workspace.characterVoiceReferences.some((item) => item.assetId === output.mediaAssetId) ||
      workspace.sceneReferences.some((item) => item.assetId === output.mediaAssetId)
    if (!usedElsewhere) {
      if (desktop.available) await desktop.removeAsset(output.mediaAssetId)
      else await deleteBrowserImage(props.projectId, output.mediaAssetId)
      await workspace.deleteMediaAsset(props.projectId, output.mediaAssetId).catch(() => undefined)
    }
    if (outputType === 'KEYFRAME') clearBrowserKeyframePreview()
    else clearBrowserEndFramePreview()
    formNotice.value = `${frameLabel}资产已删除`
  } catch (error) {
    formError.value = error instanceof Error ? error.message : `${frameLabel}删除失败`
  }
}
async function loadVideoCandidates() {
  const storyboardId = selectedStoryboard.value?.id
  const token = ++videoCandidateLoadToken
  clearVideoCandidatePreview()
  videoCandidates.value = []
  videoCandidateError.value = ''
  if (!storyboardId) return
  videoCandidateLoading.value = true
  try {
    const candidates = await mediaGenerationApi.list(props.projectId, storyboardId, 'VIDEO')
    if (token !== videoCandidateLoadToken || selectedStoryboard.value?.id !== storyboardId) return
    videoCandidates.value = candidates
    const candidate = candidates.find((item) => item.previewAvailable)
    if (!candidate) return
    if (candidate.localAssetId && desktop.available) {
      if (desktop.project?.projectId !== props.projectId) {
        await desktop.loadProject(props.projectId).catch(() => null)
      }
      const local = desktop.project?.assets.find((asset) => asset.id === candidate.localAssetId)
      if (local?.fileAvailable) {
        videoCandidatePreviewUrl.value = desktop.assetPreviewUrl(local.id)
        return
      }
    }
    if (
      candidate.deliveryType === 'LOCAL_CACHE' &&
      candidate.clientCandidateId &&
      desktop.available
    ) {
      videoCandidatePreviewUrl.value = desktop.generatedCandidatePreviewUrl(
        candidate.clientCandidateId,
      )
      if (videoCandidatePreviewUrl.value) return
    }
    const blob = await mediaGenerationApi.preview(candidate.id)
    if (token !== videoCandidateLoadToken || selectedStoryboard.value?.id !== storyboardId) return
    videoCandidatePreviewUrl.value = globalThis.URL.createObjectURL(blob)
  } catch (error) {
    if (token !== videoCandidateLoadToken) return
    videoCandidateError.value = error instanceof Error ? error.message : '视频候选读取失败'
  } finally {
    if (token === videoCandidateLoadToken) videoCandidateLoading.value = false
  }
}
function scheduleVideoCandidateRefresh(storyboardId: string) {
  clearVideoCandidateRefresh(false)
  if (videoCandidateRefreshAttempts >= VIDEO_CANDIDATE_REFRESH_LIMIT) return
  videoCandidateRefreshTimer = globalThis.setTimeout(async () => {
    videoCandidateRefreshTimer = undefined
    if (selectedStoryboard.value?.id !== storyboardId) return
    videoCandidateRefreshAttempts += 1
    await loadVideoCandidates()
    if (selectedStoryboard.value?.id !== storyboardId) return
    if (videoCandidates.value.length || videoOutput.value) {
      clearVideoCandidateRefresh()
      return
    }
    scheduleVideoCandidateRefresh(storyboardId)
  }, VIDEO_CANDIDATE_REFRESH_INTERVAL_MS)
}
function clearVideoCandidateRefresh(resetAttempts = true) {
  if (videoCandidateRefreshTimer !== undefined) {
    globalThis.clearTimeout(videoCandidateRefreshTimer)
    videoCandidateRefreshTimer = undefined
  }
  if (resetAttempts) videoCandidateRefreshAttempts = 0
}
function clearVideoCandidatePreview() {
  if (videoCandidatePreviewUrl.value.startsWith('blob:')) {
    globalThis.URL.revokeObjectURL(videoCandidatePreviewUrl.value)
  }
  videoCandidatePreviewUrl.value = ''
}
async function downloadLatestVideoCandidate() {
  const candidate = latestVideoCandidate.value
  const storyboard = selectedStoryboard.value
  if (!candidate || !storyboard || downloadingVideoCandidate.value) return
  downloadingVideoCandidate.value = true
  formError.value = ''
  try {
    const blob = await mediaGenerationApi.preview(candidate.id)
    const objectUrl = globalThis.URL.createObjectURL(blob)
    const anchor = globalThis.document.createElement('a')
    const safeTitle =
      storyboard.title.replace(/[\\/:*?"<>|]/g, '-').trim() || `镜头-${storyboard.shotNo}`
    anchor.href = objectUrl
    anchor.download = `${String(storyboard.shotNo).padStart(2, '0')}-${safeTitle}${mediaExtension(blob.type)}`
    globalThis.document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    globalThis.setTimeout(() => globalThis.URL.revokeObjectURL(objectUrl), 1_000)
    formNotice.value = '视频已下载到浏览器默认下载目录'
  } catch (error) {
    formError.value = error instanceof Error ? error.message : '视频下载失败'
  } finally {
    downloadingVideoCandidate.value = false
  }
}
async function deleteLatestVideoCandidate() {
  const candidate = latestVideoCandidate.value
  if (!candidate || deletingVideoCandidate.value) return
  if (!globalThis.confirm('确定删除这个视频候选吗？此操作无法撤销。')) return
  deletingVideoCandidate.value = true
  formError.value = ''
  try {
    await mediaGenerationApi.delete(candidate.id, candidate.version)
    clearVideoCandidatePreview()
    videoCandidates.value = videoCandidates.value.filter((item) => item.id !== candidate.id)
    await loadVideoCandidates()
    formNotice.value = '视频候选已删除'
  } catch (error) {
    formError.value = error instanceof Error ? error.message : '视频候选删除失败'
  } finally {
    deletingVideoCandidate.value = false
  }
}
function mediaExtension(mimeType: string) {
  if (mimeType === 'video/webm') return '.webm'
  if (mimeType === 'video/quicktime') return '.mov'
  return '.mp4'
}
function safeFilename(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, '-').trim() || 'media'
}
function markGenerationBackgrounded() {
  formError.value = ''
  formNotice.value = '生成任务已转入后台，可在“生成任务”中查看进度。'
}
function markVideoGenerationBackgrounded() {
  formError.value = ''
  formNotice.value = '视频任务已转入后台，完成后会自动显示在右侧预览区。'
  const storyboardId = videoStoryboard.value?.id
  if (!storyboardId) return
  videoCandidateRefreshAttempts = 0
  scheduleVideoCandidateRefresh(storyboardId)
}

function batchVideoParameters(storyboard: Storyboard) {
  const durationSec = Math.max(1, Math.min(300, storyboard.durationSec || 10))
  return {
    duration: durationSec,
    seconds: durationSec,
    duration_sec: durationSec,
    generate_audio: true,
  }
}

function buildBatchVideoItems(): BatchMediaGenerationItemInput[] {
  return batchVideoSelectedStoryboards.value.map((storyboard) => {
    const keyframe = workspace.outputForStoryboard(storyboard.id, 'KEYFRAME')
    const durationSec = Math.max(1, Math.min(300, storyboard.durationSec || 10))
    return {
      storyboardId: storyboard.id,
      prompt: storyboardVideoPrompt(storyboard),
      durationSec,
      inputAssetId: keyframe?.mediaAssetId || null,
      parameters: batchVideoParameters(storyboard),
    }
  })
}

async function loadBatchVideoPreview() {
  const items = buildBatchVideoItems()
  if (!items.length) return
  batchVideoPreviewLoading.value = true
  batchVideoPreviewError.value = ''
  try {
    const result = await mediaGenerationApi.previewBatch(props.projectId, {
      mediaType: 'VIDEO',
      parameters: {},
      items,
    })
    batchVideoPreviewItems.value = Object.fromEntries(
      result.items.map((item) => [item.storyboardId, item]),
    )
  } catch (error) {
    batchVideoPreviewError.value = error instanceof Error ? error.message : '批量视频提示词预览失败'
  } finally {
    batchVideoPreviewLoading.value = false
  }
}

function markBatchVideoCreating() {
  const next = { ...batchVideoJobStates.value }
  for (const storyboard of batchVideoSelectedStoryboards.value) {
    next[storyboard.id] = {
      status: 'CREATING',
      progress: 0,
      errorMessage: null,
      reservedPoints: 0,
    }
  }
  batchVideoJobStates.value = next
}

function applyBatchVideoCreateResult(result: BatchMediaGenerationResult) {
  const next = { ...batchVideoJobStates.value }
  for (const item of result.items) {
    next[item.storyboardId] = {
      jobId: item.jobId,
      status: item.success ? normalizeBatchVideoStatus(item.status) : 'FAILED',
      progress: item.success ? 0 : 100,
      errorMessage: item.errorMessage,
      reservedPoints: item.reservedPoints,
    }
  }
  batchVideoJobStates.value = next
  batchVideoJobPollAttempts = 0
  scheduleBatchVideoJobPoll()
}

function normalizeBatchVideoStatus(status?: string | null): GenerationJobStatus {
  if (
    status === 'WAITING_LOCAL' ||
    status === 'QUEUED' ||
    status === 'RUNNING' ||
    status === 'SUCCEEDED' ||
    status === 'FAILED' ||
    status === 'CANCELED'
  ) {
    return status
  }
  return 'QUEUED'
}

function batchVideoStateFor(storyboardId: string) {
  return batchVideoJobStates.value[storyboardId]
}

function isBatchVideoTerminal(status: BatchVideoJobState['status']) {
  return status === 'SUCCEEDED' || status === 'FAILED' || status === 'CANCELED'
}

function batchVideoStatusClass(state?: BatchVideoJobState) {
  return state ? state.status.toLowerCase().replaceAll('_', '-') : ''
}

function batchVideoStatusLabel(state?: BatchVideoJobState) {
  switch (state?.status) {
    case 'CREATING':
      return '创建中'
    case 'WAITING_LOCAL':
      return '等待本地'
    case 'QUEUED':
      return '排队中'
    case 'RUNNING':
      return state.progress > 0 ? `生成中 ${state.progress}%` : '生成中'
    case 'SUCCEEDED':
      return '成功'
    case 'FAILED':
      return '失败'
    case 'CANCELED':
      return '已取消'
    default:
      return ''
  }
}

function batchVideoStatusTitle(state?: BatchVideoJobState) {
  if (!state) return ''
  if (state.errorMessage) return state.errorMessage
  if (state.reservedPoints) return `本项预估冻结 ${state.reservedPoints} 点`
  return batchVideoStatusLabel(state)
}

function scheduleBatchVideoJobPoll() {
  clearBatchVideoJobPoll(false)
  if (batchVideoJobPollAttempts >= BATCH_VIDEO_JOB_POLL_LIMIT) return
  const activeStates = Object.values(batchVideoJobStates.value).filter(
    (state) => state.jobId && !isBatchVideoTerminal(state.status),
  )
  if (!activeStates.length) return
  batchVideoJobPollTimer = globalThis.setTimeout(() => {
    batchVideoJobPollTimer = undefined
    void pollBatchVideoJobs()
  }, BATCH_VIDEO_JOB_POLL_INTERVAL_MS)
}

async function pollBatchVideoJobs() {
  const activeStates = Object.values(batchVideoJobStates.value).filter(
    (state) => state.jobId && !isBatchVideoTerminal(state.status),
  )
  if (!activeStates.length) return
  batchVideoJobPollAttempts += 1
  const updates = await Promise.allSettled(
    activeStates.map((state) => generationApi.get(state.jobId!)),
  )
  const next = { ...batchVideoJobStates.value }
  for (const update of updates) {
    if (update.status !== 'fulfilled') continue
    const job = update.value
    const current = next[job.targetId]
    if (!current) continue
    next[job.targetId] = {
      ...current,
      jobId: job.id,
      status: normalizeBatchVideoStatus(job.status),
      progress: job.progress,
      errorMessage: job.errorMessage,
      updatedAt: job.updatedAt,
    }
    if (job.status === 'SUCCEEDED' && selectedStoryboard.value?.id === job.targetId) {
      videoCandidateRefreshAttempts = 0
      scheduleVideoCandidateRefresh(job.targetId)
    }
  }
  batchVideoJobStates.value = next
  scheduleBatchVideoJobPoll()
}

function clearBatchVideoJobPoll(resetAttempts = true) {
  if (batchVideoJobPollTimer !== undefined) {
    globalThis.clearTimeout(batchVideoJobPollTimer)
    batchVideoJobPollTimer = undefined
  }
  if (resetAttempts) batchVideoJobPollAttempts = 0
}

function toggleBatchVideoSelection(storyboardId: string, selected?: boolean) {
  const exists = batchVideoSelectedIds.value.includes(storyboardId)
  const next = selected ?? !exists
  if (next && !exists) {
    batchVideoSelectedIds.value = [...batchVideoSelectedIds.value, storyboardId]
  } else if (!next && exists) {
    batchVideoSelectedIds.value = batchVideoSelectedIds.value.filter((id) => id !== storyboardId)
  }
}

function toggleSelectAllBatchVideos() {
  if (allEpisodeStoryboardsSelectedForBatch.value) {
    batchVideoSelectedIds.value = []
    return
  }
  batchVideoSelectedIds.value = workspace.storyboards.map((item) => item.id)
}

function clearBatchVideoSelection() {
  batchVideoSelectedIds.value = []
}

function openBatchVideoGeneration() {
  if (dirty.value) {
    formError.value = '请先保存当前分镜修改，再批量生成视频'
    return
  }
  if (!batchVideoSelectedCount.value) {
    formError.value = '请先在镜头列表勾选要生成的分镜'
    return
  }
  if (batchVideoSelectedCount.value > 20) {
    formError.value = '单次最多批量生成 20 个分镜视频，请减少选择后重试'
    return
  }
  const blocked: string[] = []
  for (const storyboard of batchVideoSelectedStoryboards.value) {
    const missing = missingVideoReferenceLabels(storyboard)
    if (missing.length) {
      blocked.push(`镜头${storyboard.shotNo} 缺少：${missing.join('、')}`)
    }
  }
  if (blocked.length) {
    formError.value = `以下分镜参考图不完整，无法批量生成：\n${blocked.slice(0, 5).join('\n')}${
      blocked.length > 5 ? `\n…另有 ${blocked.length - 5} 个` : ''
    }`
    return
  }
  batchVideoResult.value = null
  batchVideoPreviewItems.value = {}
  batchVideoPreviewError.value = ''
  batchVideoIdempotencyKey.value = globalThis.crypto.randomUUID()
  showBatchVideoDialog.value = true
  formError.value = ''
  void credits.load(true)
  void loadBatchVideoPreview()
}

function closeBatchVideoGeneration() {
  if (batchVideoSubmitting.value) return
  showBatchVideoDialog.value = false
  batchVideoResult.value = null
  batchVideoIdempotencyKey.value = ''
}

async function submitBatchVideoGeneration(route: GenerationRoute) {
  if (batchVideoSubmitting.value || !batchVideoSelectedCount.value) return
  batchVideoSubmitting.value = true
  formError.value = ''
  formNotice.value = ''
  try {
    if (!batchVideoIdempotencyKey.value) {
      batchVideoIdempotencyKey.value = globalThis.crypto.randomUUID()
    }
    markBatchVideoCreating()
    const items = buildBatchVideoItems()
    const result = await mediaGenerationApi.createBatch(
      props.projectId,
      {
        mediaType: 'VIDEO',
        route,
        parameters: {},
        items,
      },
      batchVideoIdempotencyKey.value,
    )
    batchVideoResult.value = result
    applyBatchVideoCreateResult(result)
    await credits.load(true)
    if (result.successCount > 0) {
      formNotice.value = `已创建 ${result.successCount}/${result.totalCount} 个视频任务；平台任务会按镜头分别冻结额度，失败自动返还。`
      // 刷新首个成功镜头候选，便于用户看到进度
      const firstSuccess = result.items.find((item) => item.success && item.storyboardId)
      if (firstSuccess?.storyboardId) {
        videoCandidateRefreshAttempts = 0
        scheduleVideoCandidateRefresh(firstSuccess.storyboardId)
      }
    }
    if (result.failedCount > 0 && result.successCount === 0) {
      formError.value =
        result.items.find((item) => item.errorMessage)?.errorMessage || '批量生成全部失败'
    } else if (result.failedCount > 0) {
      formError.value = `${result.failedCount} 个分镜创建失败，可查看弹窗明细后重试失败项`
    }
    if (result.successCount === result.totalCount) {
      showBatchVideoDialog.value = false
      batchVideoSelectedIds.value = []
      batchVideoIdempotencyKey.value = ''
    } else {
      // 保留失败项勾选，去掉成功项
      const failedIds = new Set(
        result.items.filter((item) => !item.success).map((item) => item.storyboardId),
      )
      batchVideoSelectedIds.value = batchVideoSelectedIds.value.filter((id) => failedIds.has(id))
      batchVideoIdempotencyKey.value = globalThis.crypto.randomUUID()
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '批量生成视频失败'
    const next = { ...batchVideoJobStates.value }
    for (const storyboardId of batchVideoSelectedIds.value) {
      if (next[storyboardId]?.status === 'CREATING') {
        next[storyboardId] = {
          ...next[storyboardId],
          status: 'FAILED',
          progress: 100,
          errorMessage: message,
        }
      }
    }
    batchVideoJobStates.value = next
    formError.value = message
  } finally {
    batchVideoSubmitting.value = false
  }
}

function openVideoGeneration() {
  if (!selectedStoryboard.value || dirty.value) {
    formError.value = '请先保存当前分镜修改，再生成视频'
    return
  }
  const missingReferences = missingVideoReferenceLabels(selectedStoryboard.value)
  if (missingReferences.length) {
    formError.value = `请先补充视频参考图：${missingReferences.join('、')}`
    return
  }
  voiceStoryboard.value = null
  showVoiceSampleDialog.value = false
  videoStoryboard.value = selectedStoryboard.value
}

function missingVideoReferenceLabels(storyboard: Storyboard) {
  const missing: string[] = []
  const scene = resolveStoryboardScene(storyboard, workspace.scenes, workspace.sceneReferences)
  if (!scene) {
    missing.push('分镜未绑定场景，且未能按标题或地点匹配场景背景图')
  } else if (!workspace.referencesForScene(scene.id).length) {
    missing.push(`场景“${scene.title}”的背景图`)
  }
  workspace.characters
    .filter((item) => storyboard.characterIds.includes(item.id))
    .forEach((character) => {
      if (!hasBaseVideoCharacterReference(character)) {
        missing.push(`角色“${character.name}”的基础角色图`)
      }
    })
  return missing
}
function hasBaseVideoCharacterReference(character: CharacterAsset) {
  const references = workspace.characterReferences.filter(
    (reference) => reference.characterId === character.id,
  )
  if (references.some((reference) => !reference.characterFormId)) return true
  const defaultAppearance = defaultAppearanceFormForVideo(character)
  return Boolean(
    defaultAppearance &&
    references.some((reference) => reference.characterFormId === defaultAppearance.id),
  )
}
function defaultAppearanceFormForVideo(character: CharacterAsset) {
  const appearances = character.forms.filter(
    (form) => (form.formCategory || 'APPEARANCE') === 'APPEARANCE',
  )
  return appearances.find((form) => form.defaultForm) ?? appearances[0]
}
function closeVideoGeneration() {
  videoStoryboard.value = null
  void loadVideoCandidates()
}
function openVoiceGeneration() {
  if (!selectedStoryboard.value || dirty.value) {
    formError.value = '请先保存当前分镜修改，再生成配音'
    return
  }
  if (selectedStoryboard.value.audioMode !== 'AI_DUB') {
    formError.value = '当前镜头使用视频原声；如需单独配音，请先切换为 AI 配音并保存'
    return
  }
  if (
    !selectedStoryboard.value.dialogue?.trim() &&
    !selectedStoryboard.value.innerMonologue?.trim()
  ) {
    formError.value = '当前分镜没有对白、旁白或内心独白，无法生成配音'
    return
  }
  videoStoryboard.value = null
  showVoiceSampleDialog.value = false
  voiceStoryboard.value = selectedStoryboard.value
}
function openAudioExtraction(target: 'CHARACTER_VOICE' | 'BGM') {
  const storyboard = selectedStoryboard.value
  if (!storyboard || dirty.value) {
    formError.value = '请先保存当前分镜修改，再提取视频音频'
    return
  }
  if (!hasExtractableVideo.value) {
    formError.value = '当前视频没有可读取文件，请先完成视频生成并确认预览可以播放'
    return
  }
  const defaultCharacterId = storyboard.speakerCharacterId || selectedCharacters.value[0]?.id || ''
  if (target === 'CHARACTER_VOICE' && !defaultCharacterId) {
    formError.value = '当前分镜没有可绑定的角色，请先关联角色或指定说话角色'
    return
  }
  videoStoryboard.value = null
  voiceStoryboard.value = null
  audioExtractionTarget.value = target
  voiceSampleCharacterId.value = defaultCharacterId
  voiceSampleStartSec.value = 0
  voiceSampleEndSec.value = Math.min(15, extractionDurationSec.value)
  formError.value = ''
  showVoiceSampleDialog.value = true
}
async function extractVideoAudio() {
  const storyboard = selectedStoryboard.value
  if (!storyboard || extractingVoiceSample.value) return
  const startSec = voiceSampleStartSec.value
  const endSec = voiceSampleEndSec.value
  if (
    startSec < 0 ||
    endSec > extractionDurationSec.value + 0.1 ||
    endSec - startSec < 1 ||
    endSec - startSec > 60
  ) {
    formError.value = `截取范围必须位于 0 到 ${extractionDurationSec.value.toFixed(1)} 秒之间，且时长为 1 到 60 秒`
    return
  }
  const character = workspace.characters.find((item) => item.id === voiceSampleCharacterId.value)
  if (audioExtractionTarget.value === 'CHARACTER_VOICE' && !character) {
    formError.value = '请选择要绑定声音的角色'
    return
  }

  extractingVoiceSample.value = true
  formError.value = ''
  formNotice.value = ''
  let browserAsset: { assetId: string; clientAssetId: string } | undefined
  try {
    const outputLabel =
      audioExtractionTarget.value === 'CHARACTER_VOICE'
        ? `${character?.name || '角色'}-声音样本`
        : `镜头${storyboard.shotNo}-${storyboard.title}-背景音频`
    let assetId: string
    let previewBlob: globalThis.Blob | undefined
    if (desktop.available) {
      const localAsset = await desktop.extractVoiceSample({
        projectId: props.projectId,
        videoAssetId: extractableVideoAssetId.value,
        outputName: outputLabel,
        startSec,
        endSec,
      })
      const mappings = await workspace.synchronizeLocalAssets(props.projectId, [localAsset])
      assetId = mappings[0]?.assetId ?? localAsset.id
      await desktop.reconcileAssetIds(
        mappings.filter((item) => item.clientAssetId !== item.assetId),
      )
    } else {
      const extracted = await extractAudioSegment(await currentBrowserVideoBlob(), startSec, endSec)
      previewBlob = extracted.blob
      browserAsset = await registerBrowserExtractedAsset(
        extracted.blob,
        'audio',
        `${safeFilename(outputLabel)}.wav`,
      )
      assetId = browserAsset.assetId
    }

    if (audioExtractionTarget.value === 'CHARACTER_VOICE') {
      await workspace.createCharacterVoiceReference(props.projectId, {
        characterId: character!.id,
        assetId,
        sourceStoryboardId: storyboard.id,
        primaryReference: true,
      })
      formNotice.value = `已提取并绑定为“${character!.name}”的主要声音样本`
    } else {
      await workspace.setStoryboardOutput(props.projectId, storyboard.id, {
        outputType: 'BGM',
        mediaAssetId: assetId,
        sourceType: 'MANUAL',
      })
      if (previewBlob) setBrowserBgmPreview(assetId, previewBlob)
      formNotice.value = '已提取并设置为当前分镜背景音频'
    }
    showVoiceSampleDialog.value = false
  } catch (error) {
    if (browserAsset?.assetId === browserAsset?.clientAssetId) {
      await deleteBrowserMedia(props.projectId, browserAsset.assetId).catch(() => undefined)
      await workspace.deleteMediaAsset(props.projectId, browserAsset.assetId).catch(() => undefined)
    }
    formError.value = error instanceof Error ? error.message : '视频音频提取失败'
  } finally {
    extractingVoiceSample.value = false
  }
}
function outputPreviewUrl(assetId?: string) {
  if (!assetId || !desktop.available) return ''
  const local = desktop.project?.assets.find((asset) => asset.id === assetId)
  return local?.fileAvailable ? desktop.assetPreviewUrl(local.id) : ''
}
function previousVideoReferenceForStoryboard(storyboard: Storyboard) {
  const previous = workspace.storyboards
    .filter((item) => item.episodeId === storyboard.episodeId && item.shotNo < storyboard.shotNo)
    .sort((left, right) => right.shotNo - left.shotNo)[0]
  if (!previous) return undefined

  const output =
    workspace.outputForStoryboard(previous.id, 'END_FRAME') ??
    workspace.outputForStoryboard(previous.id, 'VIDEO')
  if (output?.mediaAssetId) {
    return {
      assetId: output.mediaAssetId,
      label: `上一镜头连续性素材：镜头 ${previous.shotNo} · ${previous.title}`,
    }
  }
  return undefined
}
function linkedReferencesForStoryboard(storyboard: Storyboard) {
  return storyboardReferenceAssets(
    storyboard,
    workspace.characters,
    workspace.scenes,
    workspace.characterReferences,
    workspace.sceneReferences,
  ).slice(0, 16)
}

function characterBasePromptForStoryboard(storyboard: Storyboard) {
  const lines: string[] = []
  for (const characterId of storyboard.characterIds) {
    const character = workspace.characters.find((item) => item.id === characterId)
    if (!character) continue
    const details = [character.identityPrompt?.trim(), character.description?.trim()].filter(
      Boolean,
    )
    if (details.length) lines.push(`角色${character.name}基础设定：${details.join('；')}`)
  }
  if (!lines.length) return ''
  return [
    '角色基础形象设定：视频默认使用角色原始形象和基础角色图，不自动切换到额外形态、服装或武器。',
    ...lines,
    '如本镜头确实需要特殊形态、武器、服装或补充背景，请在参考素材里手动上传并在提示词中明确说明。',
  ].join('\n')
}
function storyboardVideoPrompt(storyboard: Storyboard) {
  const continuity = previousVideoReferenceForStoryboard(storyboard)
    ? '使用上一镜头尾帧或视频参考建立连续性：当前镜头开场应自然承接上一镜头结束时的人物位置、姿态、光线方向和场景空间，不要突然换脸、换服装或改变背景结构。'
    : ''
  const speaker = workspace.characters.find((item) => item.id === storyboard.speakerCharacterId)
  const voiceReference = storyboardMediaReferences(
    storyboard,
    workspace.storyboards,
    workspace.storyboardOutputs,
    workspace.characters,
    workspace.characterVoiceReferences,
  ).find((item) => item.purpose === 'VOICE_IDENTITY')
  const speechDirection =
    storyboard.audioMode === 'VIDEO_NATIVE'
      ? [
          '本镜头使用视频模型原声，生成自然清晰的人声、环境声和动作音效。',
          speaker?.voiceDescription
            ? `角色发声参数（必须落实为可听见的音量、语速、停顿和句尾变化，不得仅当作氛围描述）：${speaker.voiceDescription}`
            : '',
          voiceReference
            ? '已关联主要说话角色的主声音样本。该音频只用于保持音色、年龄感和说话质感，不复制样本台词，也不作为背景音乐。'
            : '',
          storyboard.dialogue?.trim()
            ? `${speaker ? `主要说话角色是${speaker.name}。` : ''}准确说出以下台词并自然匹配口型，不得改写、漏字或增加其他台词：${storyboard.dialogue.trim()}`
            : '',
          storyboard.innerMonologue?.trim()
            ? `以下内容是画外内心独白，人物嘴唇保持自然闭合，不做口型：${storyboard.innerMonologue.trim()}`
            : '',
        ]
          .filter(Boolean)
          .join('\n')
      : storyboard.innerMonologue?.trim()
        ? storyboard.dialogue?.trim()
          ? '不要生成对白、旁白或其他人声。仅对白部分预留自然口型；内心独白由后期 AI 配音呈现，独白期间人物嘴唇自然闭合。必须保留并生成符合场景的环境声、动作音效和空间氛围声。'
          : '不要生成对白、旁白或其他人声。内心独白由后期 AI 配音呈现，画面中的人物嘴唇自然闭合。必须保留并生成符合场景的环境声、动作音效和空间氛围声。'
        : storyboard.dialogue?.trim()
          ? '不要生成对白、旁白或其他人声。角色对白由后期 AI 配音，画面只生成自然匹配台词节奏的口型。必须保留并生成符合场景的环境声、动作音效和空间氛围声。'
          : '不要生成对白、旁白或其他人声。必须保留并生成符合场景的环境声、动作音效和空间氛围声。'
  return [
    storyboard.videoPrompt,
    characterBasePromptForStoryboard(storyboard),
    projectVideoStylePrompt(workspace.project?.visualStyle),
    `${projectFrame.value.label}短剧镜头，${storyboard.shotType || '中景'}，${storyboard.angle || '平视'}，${storyboard.movement || '固定'}运镜`,
    storyboard.description,
    storyboard.actionText,
    speechDirection,
    storyboard.resultText ? `镜头结束状态：${storyboard.resultText}` : '',
    storyboard.atmosphere ? `氛围：${storyboard.atmosphere}` : '',
    storyboard.soundEffect ? `动作与场景音效：${storyboard.soundEffect}` : '',
    storyboard.bgmPrompt ? `背景音乐方向：${storyboard.bgmPrompt}` : '',
    continuity,
    '保持已选择的角色图、场景图和首尾帧参考中的人物身份、服装、发型、场景布局与画面风格一致，动作自然连续。',
  ]
    .filter(Boolean)
    .join('\n')
}
function storyboardVoiceText(storyboard: Storyboard) {
  return [storyboard.dialogue, storyboard.innerMonologue]
    .filter((value) => value?.trim())
    .join('\n')
}
function speakerForStoryboard(storyboard: Storyboard) {
  return workspace.characters.find((item) => item.id === storyboard.speakerCharacterId)
}
async function saveStoryboard() {
  if (!form.title.trim() || saving.value) return
  saving.value = true
  formError.value = ''
  try {
    const saved = await workspace.saveStoryboard(
      props.projectId,
      { ...form, characterIds: [...form.characterIds] },
      selectedId.value || undefined,
    )
    setStoryboard(saved)
  } catch (error) {
    formError.value = error instanceof Error ? error.message : '分镜保存失败'
  } finally {
    saving.value = false
  }
}
async function deleteStoryboard() {
  const storyboard = selectedStoryboard.value
  if (
    !storyboard ||
    !globalThis.confirm(`确定删除镜头 ${storyboard.shotNo}“${storyboard.title}”吗？`)
  )
    return
  saving.value = true
  try {
    await workspace.deleteStoryboard(props.projectId, storyboard.id)
    const next =
      workspace.storyboards[Math.min(storyboard.shotNo - 1, workspace.storyboards.length - 1)]
    if (next) setStoryboard(next)
    else setCreate()
  } catch (error) {
    formError.value = error instanceof Error ? error.message : '分镜删除失败'
  } finally {
    saving.value = false
  }
}
async function deleteSelectedStoryboards() {
  if (deletingStoryboards.value || !batchVideoSelectedCount.value) return
  const selected = batchVideoSelectedStoryboards.value
  const deletedIds = new Set(selected.map((storyboard) => storyboard.id))
  const currentWillBeDeleted = deletedIds.has(selectedId.value)
  if (dirty.value && !currentWillBeDeleted) {
    formError.value = '请先保存当前分镜修改，再批量删除其他分镜'
    return
  }
  const unsavedWarning = dirty.value ? '\n当前分镜尚未保存的修改也会丢失。' : ''
  if (
    !globalThis.confirm(
      `确定删除已选的 ${selected.length} 个分镜吗？\n仅从本集制作流程中删除，不会删除本地素材文件。${unsavedWarning}`,
    )
  )
    return

  const firstDeletedShotNo = Math.min(...selected.map((storyboard) => storyboard.shotNo))
  deletingStoryboards.value = true
  formError.value = ''
  formNotice.value = ''
  try {
    const result = await workspace.deleteStoryboards(props.projectId, [...deletedIds])
    batchVideoSelectedIds.value = []
    batchVideoResult.value = null
    batchVideoIdempotencyKey.value = ''
    batchVideoPreviewItems.value = Object.fromEntries(
      Object.entries(batchVideoPreviewItems.value).filter(([id]) => !deletedIds.has(id)),
    )
    batchVideoJobStates.value = Object.fromEntries(
      Object.entries(batchVideoJobStates.value).filter(([id]) => !deletedIds.has(id)),
    )
    if (videoStoryboard.value && deletedIds.has(videoStoryboard.value.id))
      videoStoryboard.value = null
    if (voiceStoryboard.value && deletedIds.has(voiceStoryboard.value.id))
      voiceStoryboard.value = null

    if (currentWillBeDeleted) {
      const next =
        workspace.storyboards[Math.min(firstDeletedShotNo - 1, workspace.storyboards.length - 1)]
      if (next) setStoryboard(next)
      else setCreate()
    } else if (selectedId.value) {
      const refreshed = workspace.storyboards.find(
        (storyboard) => storyboard.id === selectedId.value,
      )
      if (refreshed) setStoryboard(refreshed)
    }
    formNotice.value = `已删除 ${result.deletedCount} 个分镜，本地素材文件未受影响`
  } catch (error) {
    formError.value = error instanceof Error ? error.message : '批量删除分镜失败'
  } finally {
    deletingStoryboards.value = false
  }
}
async function moveStoryboard(index: number, offset: -1 | 1) {
  const target = index + offset
  if (
    target < 0 ||
    target >= workspace.storyboards.length ||
    reordering.value ||
    !canDiscardChanges()
  )
    return
  const ordered = [...workspace.storyboards]
  const [moved] = ordered.splice(index, 1)
  if (!moved) return
  ordered.splice(target, 0, moved)
  reordering.value = true
  try {
    await workspace.reorderStoryboards(props.projectId, ordered)
    const refreshed = workspace.storyboards.find((item) => item.id === moved.id)
    if (refreshed) setStoryboard(refreshed)
  } catch (error) {
    formError.value = error instanceof Error ? error.message : '分镜排序失败'
  } finally {
    reordering.value = false
  }
}
async function openAiGeneration() {
  const episode = workspace.activeEpisode
  if (!episode) return
  if (dirty.value) {
    formError.value = '请先保存当前分镜修改，再生成 AI 分镜'
    return
  }
  if (!episode.scriptText?.trim()) {
    formError.value = '请先在剧本页生成或填写完整剧本并保存，再拆解分镜'
    return
  }
  formError.value = ''
  formNotice.value = ''
  candidateError.value = ''
  checkingCandidate.value = true
  try {
    const candidate = await storyboardCandidateApi.latest(props.projectId, episode.id)
    openCandidate(candidate)
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 404) {
      showRouteDialog.value = true
      return
    }
    formError.value = error instanceof Error ? error.message : '分镜候选读取失败'
  } finally {
    checkingCandidate.value = false
  }
}
async function createStoryboardCandidate(route: GenerationRoute) {
  const episode = workspace.activeEpisode
  if (!episode || generating.value) return
  let job: GenerationJob | null = null
  generating.value = true
  formError.value = ''
  formNotice.value = ''
  candidateError.value = ''
  try {
    const requestSignature = JSON.stringify({ route, shotPaceMode: shotPaceMode.value })
    if (!generationIdempotencyKey.value || generationRequestSignature.value !== requestSignature) {
      generationIdempotencyKey.value = globalThis.crypto.randomUUID()
      generationRequestSignature.value = requestSignature
    }
    job = await generationApi.create(
      props.projectId,
      {
        jobType: 'STORYBOARD_GENERATE',
        targetType: 'EPISODE',
        targetId: episode.id,
        parameters: {
          temperature: 0.2,
          max_tokens: 8000,
          json_mode: true,
          shotPaceMode: shotPaceMode.value,
        },
        route,
      },
      generationIdempotencyKey.value,
    )
    showRouteDialog.value = false
    if (job.status !== 'SUCCEEDED') {
      job = await executeTextGeneration(job, route, desktop)
    }
    if (job.status !== 'SUCCEEDED') {
      throw new Error(job.errorMessage || 'AI 分镜生成失败')
    }
    const candidate = await storyboardCandidateApi.getByJob(props.projectId, job.id)
    if (candidate.status !== 'READY' || !candidate.payload) {
      throw new Error(candidate.validationError || 'AI 返回的分镜格式无法识别')
    }
    generationIdempotencyKey.value = ''
    generationRequestSignature.value = ''
    openCandidate(candidate)
  } catch (error) {
    if (job && ['SUCCEEDED', 'FAILED', 'CANCELED'].includes(job.status)) {
      generationIdempotencyKey.value = ''
      generationRequestSignature.value = ''
    }
    formError.value = error instanceof Error ? error.message : 'AI 分镜生成失败'
  } finally {
    generating.value = false
  }
}
function openCandidate(candidate: StoryboardCandidate) {
  storyboardCandidate.value = candidate
  candidateError.value = ''
  if (applyCandidateId.value !== candidate.id) {
    applyCandidateId.value = candidate.id
    applyIdempotencyKey.value = globalThis.crypto.randomUUID()
    applyRequestSignature.value = ''
  }
  showCandidateDialog.value = true
}
function regenerateStoryboardCandidate() {
  if (applyingCandidate.value) return
  showCandidateDialog.value = false
  storyboardCandidate.value = null
  candidateError.value = ''
  generationIdempotencyKey.value = ''
  generationRequestSignature.value = ''
  showRouteDialog.value = true
}
function closeGenerationRoute() {
  if (generating.value) return
  showRouteDialog.value = false
  generationIdempotencyKey.value = ''
  generationRequestSignature.value = ''
}
async function applyStoryboardCandidate(input: {
  candidateVersion: number
  payloadJson: string
  selectedShotKeys: string[]
}) {
  const candidate = storyboardCandidate.value
  if (!candidate || applyingCandidate.value) return
  applyingCandidate.value = true
  formError.value = ''
  candidateError.value = ''
  try {
    const requestSignature = JSON.stringify(input)
    if (!applyIdempotencyKey.value || applyRequestSignature.value !== requestSignature) {
      applyIdempotencyKey.value = globalThis.crypto.randomUUID()
      applyRequestSignature.value = requestSignature
    }
    const summary = await storyboardCandidateApi.apply(
      props.projectId,
      candidate.id,
      input,
      applyIdempotencyKey.value,
    )
    await workspace.loadStoryboards(props.projectId)
    const firstCreatedId = Object.values(summary.createdStoryboards)[0]
    const firstCreated = workspace.storyboards.find((item) => item.id === firstCreatedId)
    if (firstCreated) setStoryboard(firstCreated)
    showCandidateDialog.value = false
    storyboardCandidate.value = null
    applyCandidateId.value = ''
    applyIdempotencyKey.value = ''
    applyRequestSignature.value = ''
    formNotice.value = `已追加 ${summary.createdCount} 个分镜，原有分镜未改动。`
  } catch (error) {
    candidateError.value = error instanceof Error ? error.message : '分镜候选应用失败'
  } finally {
    applyingCandidate.value = false
  }
}
function reviewLabel(status?: Storyboard['reviewStatus']) {
  if (status === 'APPROVED') return '已通过'
  if (status === 'CHANGES_REQUESTED') return '需修改'
  return '待审核'
}
</script>

<template>
  <section class="storyboard-panel">
    <header class="panel-toolbar storyboard-toolbar">
      <div>
        <h2>分镜制作</h2>
        <p>
          镜头顺序即最终合成顺序。拆镜过碎会增加视频生成次数，建议使用「合适时长」或「约 15
          秒/镜」。
        </p>
      </div>
      <div class="toolbar-actions">
        <select v-if="workspace.episodes.length" v-model="selectedEpisodeId">
          <option v-for="episode in workspace.episodes" :key="episode.id" :value="episode.id">
            第 {{ episode.episodeNo }} 集 · {{ episode.title }}
          </option></select
        ><label class="storyboard-pace-select" title="控制 AI 拆镜粗细，减少过碎镜头带来的视频请求">
          <span>拆镜节奏</span>
          <select v-model="shotPaceMode" :disabled="aiBusy">
            <option value="AUTO">合适时长（推荐，约 8-15 秒/镜）</option>
            <option value="FIXED_15">固定约 15 秒/镜</option>
            <option value="DETAILED">细拆镜头（约 3-8 秒/镜）</option>
          </select> </label
        ><button
          class="button"
          type="button"
          :disabled="!workspace.activeEpisodeId || !hasSavedScript || dirty || aiBusy"
          :title="aiButtonTitle"
          @click="openAiGeneration"
        >
          <LoaderCircle v-if="aiBusy" class="spin" :size="16" /><Sparkles v-else :size="16" />{{
            checkingCandidate
              ? '检查候选...'
              : generating
                ? 'AI 自动配置中...'
                : applyingCandidate
                  ? '应用中...'
                  : 'AI 拆解分镜'
          }}</button
        ><button class="button primary" :disabled="!workspace.activeEpisodeId" @click="openCreate">
          <Plus :size="17" />手动新建
        </button>
        <button
          class="button"
          type="button"
          :disabled="!workspace.activeEpisodeId || dirty || batchVideoSubmitting"
          :title="
            dirty
              ? '请先保存当前分镜'
              : batchVideoSelectedCount
                ? `已选 ${batchVideoSelectedCount} 个分镜，批量生成视频`
                : '先在左侧镜头列表勾选分镜'
          "
          @click="openBatchVideoGeneration"
        >
          <Film :size="16" />批量生成视频{{
            batchVideoSelectedCount ? ` (${batchVideoSelectedCount})` : ''
          }}
        </button>
      </div>
    </header>
    <p v-if="workspace.activeEpisodeId && !hasSavedScript" class="workspace-inline-notice neutral">
      请先在剧本页完成并保存剧本，之后即可使用 AI 拆解分镜。
    </p>
    <p v-if="formNotice" class="workspace-inline-notice success">{{ formNotice }}</p>
    <p v-if="formError" class="workspace-inline-notice error">{{ formError }}</p>
    <div v-if="!workspace.activeEpisodeId" class="workspace-empty bordered">
      <Clapperboard :size="34" /><strong>请先创建分集</strong>
    </div>
    <div v-else-if="workspace.storyboardsLoading" class="workspace-empty bordered">
      正在加载分镜...
    </div>
    <div
      v-else-if="generating && !workspace.storyboards.length"
      class="workspace-empty bordered storyboard-ai-progress"
    >
      <LoaderCircle class="spin" :size="34" /><strong>AI 正在自动配置整集分镜</strong
      ><span
      >正在生成镜头标题、场景、角色、时长、景别、角度和运镜，并自动补全画面与视频提示词。</span
      >
    </div>
    <div v-else class="storyboard-workspace">
      <aside class="shot-list">
        <header class="shot-list-header">
          <div class="shot-list-header-title">
            <strong>镜头列表</strong><span>{{ workspace.storyboards.length }}</span>
          </div>
          <div class="shot-list-batch-actions" @click.stop>
            <button
              class="button compact"
              type="button"
              :disabled="!workspace.storyboards.length || deletingStoryboards"
              @click="toggleSelectAllBatchVideos"
            >
              {{ allEpisodeStoryboardsSelectedForBatch ? '取消全选' : '全选' }}
            </button>
            <button
              class="button compact"
              type="button"
              :disabled="!batchVideoSelectedCount || deletingStoryboards"
              @click="clearBatchVideoSelection"
            >
              取消选择
            </button>
            <button
              class="button compact danger-text"
              type="button"
              :disabled="!batchVideoSelectedCount || deletingStoryboards || batchVideoSubmitting"
              :title="`删除已选的 ${batchVideoSelectedCount} 个分镜`"
              @click="deleteSelectedStoryboards"
            >
              <LoaderCircle v-if="deletingStoryboards" class="spin" :size="14" />
              <Trash2 v-else :size="14" />删除 {{ batchVideoSelectedCount }}
            </button>
          </div>
        </header>
        <div v-if="!workspace.storyboards.length" class="shot-list-empty">本集尚未创建分镜</div>
        <article
          v-for="(storyboard, index) in workspace.storyboards"
          :key="storyboard.id"
          class="shot-list-item"
          :class="{
            active: storyboard.id === selectedId,
            'batch-selected': batchVideoSelectedIds.includes(storyboard.id),
          }"
          @click="openStoryboard(storyboard)"
        >
          <label class="shot-batch-check" title="勾选后可批量生成视频或删除" @click.stop>
            <input
              type="checkbox"
              :checked="batchVideoSelectedIds.includes(storyboard.id)"
              @change="
                toggleBatchVideoSelection(
                  storyboard.id,
                  ($event.target as HTMLInputElement).checked,
                )
              "
            />
          </label>
          <div class="shot-number">{{ String(storyboard.shotNo).padStart(2, '0') }}</div>
          <div class="shot-copy">
            <strong>{{ storyboard.title }}</strong
            ><span
            >{{ storyboard.shotType || '未设景别' }} · {{ storyboard.angle || '未设角度' }} ·
              {{ storyboard.movement || '未设运镜' }} · {{ storyboard.durationSec }} 秒</span
            >
            <span
              v-if="batchVideoStateFor(storyboard.id)"
              class="batch-video-state"
              :class="batchVideoStatusClass(batchVideoStateFor(storyboard.id))"
              :title="batchVideoStatusTitle(batchVideoStateFor(storyboard.id))"
            >
              <LoaderCircle
                v-if="
                  ['CREATING', 'QUEUED', 'RUNNING'].includes(
                    batchVideoStateFor(storyboard.id)?.status || '',
                  )
                "
                class="spin"
                :size="12"
              />
              {{ batchVideoStatusLabel(batchVideoStateFor(storyboard.id)) }}
            </span>
          </div>
          <span class="review-chip" :class="storyboard.reviewStatus.toLowerCase()">{{
            reviewLabel(storyboard.reviewStatus)
          }}</span>
          <div class="shot-order-actions" @click.stop>
            <button
              class="icon-button compact"
              title="上移"
              :disabled="index === 0 || reordering"
              @click="moveStoryboard(index, -1)"
            >
              <ArrowUp :size="14" /></button
            ><button
              class="icon-button compact"
              title="下移"
              :disabled="index === workspace.storyboards.length - 1 || reordering"
              @click="moveStoryboard(index, 1)"
            >
              <ArrowDown :size="14" />
            </button>
          </div>
        </article>
      </aside>

      <form class="shot-editor" @submit.prevent="saveStoryboard">
        <header class="shot-editor-header">
          <div>
            <span>{{
              selectedStoryboard ? `镜头 ${selectedStoryboard.shotNo}` : '手动新建镜头'
            }}</span
            ><strong>{{
              selectedStoryboard ? reviewLabel(selectedStoryboard.reviewStatus) : '待保存'
            }}</strong>
          </div>
          <div class="row-actions">
            <button
              v-if="selectedStoryboard"
              class="button danger-text"
              type="button"
              @click="deleteStoryboard"
            >
              <Trash2 :size="16" />删除</button
            ><button class="button primary" type="submit" :disabled="saving || !form.title.trim()">
              <Save :size="16" />{{ saving ? '保存中' : '保存' }}
            </button>
          </div>
        </header>
        <div class="form-grid shot-basics-grid">
          <label>镜头标题<input v-model="form.title" maxlength="120" /></label
          ><label
          >所属场景<select v-model="form.sceneId">
            <option value="">不绑定场景</option>
            <option v-for="scene in workspace.scenes" :key="scene.id" :value="scene.id">
              {{ scene.sceneNo }} · {{ scene.title }}
            </option>
          </select></label
          ><label
          >时长（秒）<input v-model.number="form.durationSec" type="number" min="1" max="300"
          /></label>
        </div>
        <div class="form-grid three-columns">
          <label
          >景别<select v-model="form.shotType">
            <option>远景</option>
            <option>全景</option>
            <option>中景</option>
            <option>近景</option>
            <option>特写</option>
            <option>大特写</option>
          </select></label
          ><label
          >角度<select v-model="form.angle">
            <option>平视</option>
            <option>仰视</option>
            <option>俯视</option>
            <option>侧拍</option>
            <option>背拍</option>
            <option>过肩</option>
            <option>主观视角</option>
          </select></label
          ><label
          >运镜<select v-model="form.movement">
            <option>固定</option>
            <option>推镜</option>
            <option>拉镜</option>
            <option>摇镜</option>
            <option>移镜</option>
            <option>跟拍</option>
            <option>环绕</option>
            <option>手持</option>
          </select></label
          >
        </div>
        <fieldset class="character-picker">
          <legend>涉及角色</legend>
          <p v-if="!workspace.characters.length">项目中还没有角色</p>
          <label v-for="character in workspace.characters" :key="character.id"
          ><input v-model="form.characterIds" type="checkbox" :value="character.id" /><span>{{
            character.name
          }}</span></label
          >
        </fieldset>
        <section class="audio-production-settings">
          <header>
            <div>
              <strong>声音制作方式</strong><span>每个镜头独立设置，默认使用专门的 AI 配音</span>
            </div>
          </header>
          <div class="audio-mode-control" role="radiogroup" aria-label="声音制作方式">
            <label :class="{ active: form.audioMode === 'AI_DUB' }">
              <input v-model="form.audioMode" type="radio" value="AI_DUB" />
              <span
              ><strong>AI 配音</strong
              ><small>视频保留环境声和动作音效，角色人声后期生成并混音</small></span
              >
            </label>
            <label :class="{ active: form.audioMode === 'VIDEO_NATIVE' }">
              <input v-model="form.audioMode" type="radio" value="VIDEO_NATIVE" />
              <span><strong>视频原声</strong><small>视频模型直接生成台词与环境声音</small></span>
            </label>
          </div>
          <label class="audio-speaker-field">
            主要说话角色
            <select v-model="form.speakerCharacterId" :disabled="!form.characterIds.length">
              <option value="">旁白 / 暂不指定</option>
              <option
                v-for="character in selectedCharacters"
                :key="character.id"
                :value="character.id"
              >
                {{ character.name }}
              </option>
            </select>
            <span class="field-help"
            >单人对白建议指定；多人同镜头仍建议使用 AI 配音分别控制声线</span
            >
          </label>
        </section>
        <div class="form-grid two-columns">
          <label>地点<input v-model="form.location" maxlength="160" /></label
          ><label>时间<input v-model="form.timeOfDay" maxlength="40" /></label>
        </div>
        <label>镜头概述<textarea v-model="form.description" rows="3" maxlength="5000" /></label>
        <div class="form-grid two-columns">
          <label>动作<textarea v-model="form.actionText" rows="4" maxlength="5000" /></label
          ><label
          >对白 / 旁白<span class="field-help">角色开口说话或普通画外旁白</span
          ><textarea v-model="form.dialogue" rows="4" maxlength="10000" /></label
          ><label
          >内心独白<span class="field-help">作为画外音播放，角色不张嘴、不做口型</span
          ><textarea v-model="form.innerMonologue" rows="4" maxlength="10000" /></label
          ><label>镜头结果<textarea v-model="form.resultText" rows="3" maxlength="5000" /></label
          ><label>氛围<textarea v-model="form.atmosphere" rows="3" maxlength="2000" /></label>
        </div>
        <details class="prompt-editor" open>
          <summary>生成提示词</summary>
          <div class="form-grid two-columns">
            <label
            >画面构图参考<textarea v-model="form.imagePrompt" rows="5" maxlength="20000" /></label
            ><label
            >动态视频提示词<textarea
              v-model="form.videoPrompt"
              rows="5"
              maxlength="20000"
            /></label
            ><label>配乐提示词<textarea v-model="form.bgmPrompt" rows="3" maxlength="5000" /></label
            ><label
            >关键音效<textarea v-model="form.soundEffect" rows="3" maxlength="5000" />
            </label>
          </div>
        </details>
        <div v-if="selectedStoryboard?.reviewNote" class="review-note">
          <strong>审核意见</strong>
          <p>{{ selectedStoryboard.reviewNote }}</p>
        </div>
      </form>

      <aside class="storyboard-preview">
        <header>
          <strong>视频首尾帧资产（{{ projectFrame.aspectRatio }}）</strong>
        </header>
        <p v-if="selectedStoryboard" class="storyboard-video-requirement">
          首尾帧只从已生成视频提取或由你上传，不再调用生图模型。生成视频时可明确选择是否携带。
        </p>
        <section class="storyboard-frame-asset">
          <header>
            <div><strong>首帧</strong><small>当前镜头的起始画面</small></div>
            <span :class="{ ready: keyframeOutput }">{{
              keyframeOutput ? '已保存' : '未设置'
            }}</span>
          </header>
          <div
            class="preview-frame storyboard-frame-preview"
            :class="{ filled: keyframePreviewUrl }"
            :style="keyframePreviewStyle"
          >
            <img
              v-if="keyframePreviewUrl"
              :src="keyframePreviewUrl"
              :alt="`${form.title || '分镜'}首帧`"
            />
            <template v-else>
              <ImageIcon :size="28" />
              <span>{{ keyframeOutput ? '首帧文件不在本机' : '尚未保存首帧' }}</span>
            </template>
          </div>
          <div class="storyboard-frame-actions">
            <button
              class="button"
              type="button"
              :disabled="!selectedStoryboard || dirty || Boolean(uploadingFrame)"
              @click="uploadFrame('KEYFRAME')"
            >
              <LoaderCircle v-if="uploadingFrame === 'KEYFRAME'" class="spin" :size="14" />
              <Upload v-else :size="14" />{{ keyframeOutput ? '替换' : '上传' }}
            </button>
            <button
              class="button"
              type="button"
              :disabled="!hasExtractableVideo || dirty || Boolean(extractingFrame)"
              @click="extractVideoFrameAsset('FIRST')"
            >
              <LoaderCircle v-if="extractingFrame === 'FIRST'" class="spin" :size="14" />
              <Scissors v-else :size="14" />提取
            </button>
            <button
              class="icon-button compact"
              type="button"
              title="下载首帧"
              :disabled="!keyframeOutput"
              @click="downloadFrame('KEYFRAME')"
            >
              <Download :size="14" />
            </button>
            <button
              class="icon-button compact danger"
              type="button"
              title="删除首帧"
              :disabled="!keyframeOutput"
              @click="deleteFrame('KEYFRAME')"
            >
              <Trash2 :size="14" />
            </button>
          </div>
        </section>
        <section class="storyboard-frame-asset">
          <header>
            <div><strong>尾帧</strong><small>供后续镜头延续画面</small></div>
            <span :class="{ ready: endFrameOutput }">{{
              endFrameOutput ? '已保存' : '未设置'
            }}</span>
          </header>
          <div
            class="preview-frame storyboard-frame-preview"
            :class="{ filled: endFramePreviewUrl }"
            :style="keyframePreviewStyle"
          >
            <img
              v-if="endFramePreviewUrl"
              :src="endFramePreviewUrl"
              :alt="`${form.title || '分镜'}尾帧`"
            />
            <template v-else>
              <ImageIcon :size="28" />
              <span>{{ endFrameOutput ? '尾帧文件不在本机' : '尚未保存尾帧' }}</span>
            </template>
          </div>
          <div class="storyboard-frame-actions">
            <button
              class="button"
              type="button"
              :disabled="!selectedStoryboard || dirty || Boolean(uploadingFrame)"
              @click="uploadFrame('END_FRAME')"
            >
              <LoaderCircle v-if="uploadingFrame === 'END_FRAME'" class="spin" :size="14" />
              <Upload v-else :size="14" />{{ endFrameOutput ? '替换' : '上传' }}
            </button>
            <button
              class="button"
              type="button"
              :disabled="!hasExtractableVideo || dirty || Boolean(extractingFrame)"
              @click="extractVideoFrameAsset('LAST')"
            >
              <LoaderCircle v-if="extractingFrame === 'LAST'" class="spin" :size="14" />
              <Scissors v-else :size="14" />提取
            </button>
            <button
              class="icon-button compact"
              type="button"
              title="下载尾帧"
              :disabled="!endFrameOutput"
              @click="downloadFrame('END_FRAME')"
            >
              <Download :size="14" />
            </button>
            <button
              class="icon-button compact danger"
              type="button"
              title="删除尾帧"
              :disabled="!endFrameOutput"
              @click="deleteFrame('END_FRAME')"
            >
              <Trash2 :size="14" />
            </button>
          </div>
        </section>
        <div class="storyboard-media-actions">
          <button
            class="button"
            type="button"
            :disabled="!selectedStoryboard || dirty"
            title="使用角色图与场景图生成分镜视频"
            @click="openVideoGeneration"
          >
            <Film :size="15" />{{
              videoOutput ? '管理视频' : latestVideoCandidate ? '查看视频' : '生成视频'
            }}</button
          ><button
            class="button"
            type="button"
            :disabled="
              !selectedStoryboard || dirty || !hasVoiceContent || form.audioMode !== 'AI_DUB'
            "
            :title="
              form.audioMode !== 'AI_DUB'
                ? '当前使用视频原声，无需单独生成配音'
                : !hasVoiceContent
                  ? '请先填写对白、旁白或内心独白'
                  : '生成配音'
            "
            @click="openVoiceGeneration"
          >
            <Volume2 :size="15" />{{ voiceOutput ? '管理配音' : '生成配音' }}
          </button>
          <button
            v-if="hasExtractableVideo"
            class="button"
            type="button"
            :disabled="!selectedStoryboard || dirty || !voiceSampleCharacterOptions.length"
            title="从当前视频截取声音并绑定到角色"
            @click="openAudioExtraction('CHARACTER_VOICE')"
          >
            <Scissors :size="15" />提取角色声音
          </button>
          <button
            v-if="hasExtractableVideo"
            class="button"
            type="button"
            :disabled="!selectedStoryboard || dirty"
            title="从当前视频截取音频并设置为分镜背景音频"
            @click="openAudioExtraction('BGM')"
          >
            <Music2 :size="15" />提取背景音频
          </button>
        </div>
        <section
          v-if="latestVideoCandidate || videoCandidateLoading || videoCandidateError"
          class="storyboard-video-candidate"
        >
          <header>
            <strong>最新视频候选</strong
            ><span v-if="latestVideoCandidate"
            >{{ ((latestVideoCandidate.durationMs || 0) / 1000).toFixed(1) }} 秒 ·
              {{ latestVideoCandidate.width || '-' }}×{{ latestVideoCandidate.height || '-' }}</span
            >
          </header>
          <div v-if="videoCandidateLoading" class="storyboard-video-empty">
            <LoaderCircle class="spin" :size="20" /><span>正在读取视频...</span>
          </div>
          <video
            v-else-if="visibleVideoPreviewUrl"
            class="storyboard-output-player"
            :src="visibleVideoPreviewUrl"
            controls
            preload="metadata"
          />
          <div v-else class="storyboard-video-empty">
            <Film :size="22" /><span>{{ videoCandidateError || '视频文件当前不可读取' }}</span>
          </div>
          <button
            v-if="latestVideoCandidate && !desktop.available"
            class="button storyboard-video-download"
            type="button"
            :disabled="downloadingVideoCandidate || !latestVideoCandidate.previewAvailable"
            @click="downloadLatestVideoCandidate"
          >
            <LoaderCircle v-if="downloadingVideoCandidate" class="spin" :size="15" />
            <Download v-else :size="15" />{{ downloadingVideoCandidate ? '下载中' : '下载视频' }}
          </button>
          <button
            v-if="latestVideoCandidate && !latestVideoCandidate.localAssetId"
            class="button danger-text storyboard-video-download"
            type="button"
            :disabled="deletingVideoCandidate"
            @click="deleteLatestVideoCandidate"
          >
            <LoaderCircle v-if="deletingVideoCandidate" class="spin" :size="15" />
            <Trash2 v-else :size="15" />{{ deletingVideoCandidate ? '删除中' : '删除视频候选' }}
          </button>
        </section>
        <video
          v-else-if="videoPreviewUrl"
          class="storyboard-output-player"
          :src="videoPreviewUrl"
          controls
          preload="metadata"
        /><audio
          v-if="voicePreviewUrl"
          class="storyboard-audio-player"
          :src="voicePreviewUrl"
          controls
          preload="metadata"
        />
        <section v-if="hasExtractableVideo" class="storyboard-video-tools">
          <header>
            <strong>视频提取工具</strong>
            <small>提取结果会保存到当前项目，可分别用于角色声线或分镜背景音频。</small>
          </header>
          <audio
            v-if="bgmPreviewUrl"
            class="storyboard-audio-player"
            :src="bgmPreviewUrl"
            controls
            preload="metadata"
          />
        </section>
        <section>
          <h3>镜头摘要</h3>
          <dl>
            <dt>角色</dt>
            <dd>{{ selectedCharacters.map((item) => item.name).join('、') || '无角色' }}</dd>
            <dt>景别</dt>
            <dd>{{ form.shotType || '未设置' }}</dd>
            <dt>角度</dt>
            <dd>{{ form.angle || '未设置' }}</dd>
            <dt>运镜</dt>
            <dd>{{ form.movement || '未设置' }}</dd>
          </dl>
        </section>
        <section>
          <h3>生成状态</h3>
          <p class="generation-state" :class="{ ready: selectedStoryboard && !dirty }">
            <CheckCircle2 v-if="selectedStoryboard && !dirty" :size="15" /><Clock3
              v-else
              :size="15"
            />{{
              !selectedStoryboard
                ? '新镜头尚未保存'
                : dirty
                  ? '结构数据有未保存修改'
                  : '结构数据已保存'
            }}
          </p>
          <p class="generation-state" :class="{ ready: keyframeOutput || endFrameOutput }">
            <CheckCircle2 v-if="keyframeOutput || endFrameOutput" :size="15" /><Clock3
              v-else
              :size="15"
            />{{
              keyframeOutput || endFrameOutput
                ? `首帧${keyframeOutput ? '已设置' : '未设置'}，尾帧${endFrameOutput ? '已设置' : '未设置'}`
                : '首尾帧资产未设置'
            }}
          </p>
          <p class="generation-state" :class="{ ready: videoOutput || latestVideoCandidate }">
            <CheckCircle2 v-if="videoOutput || latestVideoCandidate" :size="15" /><Clock3
              v-else
              :size="15"
            />{{
              videoOutput
                ? '动态视频已设置'
                : latestVideoCandidate
                  ? '视频候选已生成，待保存'
                  : '动态视频待生成'
            }}
          </p>
          <p class="generation-state" :class="{ ready: voiceOutput }">
            <CheckCircle2
              v-if="voiceOutput || form.audioMode === 'VIDEO_NATIVE'"
              :size="15"
            /><Clock3 v-else :size="15" />{{
              form.audioMode === 'VIDEO_NATIVE'
                ? '使用视频模型原声'
                : voiceOutput
                  ? 'AI 配音已设置'
                  : 'AI 配音待生成'
            }}
          </p>
        </section>
      </aside>
    </div>

    <GenerationRouteDialog
      :open="showBatchVideoDialog"
      :submitting="batchVideoSubmitting"
      service-type="VIDEO"
      eyebrow="批量视频生成"
      :title="`为 ${batchVideoSelectedCount} 个分镜创建视频任务`"
      :submit-label="
        batchVideoSubmitting
          ? '创建中...'
          : batchVideoResult?.failedCount
            ? `重试失败项 (${batchVideoSelectedCount})`
            : `开始批量生成 (${batchVideoSelectedCount})`
      "
      :quote-prompt="batchVideoCombinedPrompt"
      :quote-items="batchVideoQuoteItems"
      :quote-parameters="{
        duration: Math.max(1, batchVideoTotalDurationSec),
        seconds: Math.max(1, batchVideoTotalDurationSec),
        duration_sec: Math.max(1, batchVideoTotalDurationSec),
      }"
      :quote-multiplier="1"
      @close="closeBatchVideoGeneration"
      @submit="submitBatchVideoGeneration"
    >
      <section class="batch-video-preview-card">
        <header>
          <div>
            <strong>最终视频提示词预览</strong>
            <span>提交前可逐条确认；服务端会按这里的增强提示词创建任务。</span>
          </div>
          <em>{{ batchVideoSelectedCount }} 镜头 · {{ batchVideoTotalDurationSec }} 秒</em>
        </header>
        <p v-if="batchVideoPreviewLoading" class="batch-video-preview-hint">
          正在加载服务端最终提示词，当前先显示本地组装版本...
        </p>
        <p v-else-if="batchVideoPreviewError" class="batch-video-preview-hint error">
          {{ batchVideoPreviewError }}
        </p>
        <div class="batch-video-prompt-list">
          <details
            v-for="item in batchVideoPromptPreviews"
            :key="item.storyboardId"
            class="batch-video-prompt-item"
          >
            <summary>
              <span>镜头 {{ item.shotNo }} · {{ item.title }}</span>
              <em>{{ item.durationSec }} 秒</em>
            </summary>
            <pre>{{ item.prompt }}</pre>
          </details>
        </div>
        <div v-if="batchVideoResult" class="batch-video-result-card">
          <header>
            <span>创建结果</span>
            <strong>{{ batchVideoResult.successCount }}/{{ batchVideoResult.totalCount }}</strong>
          </header>
          <p v-if="batchVideoResult.failedCount" class="batch-video-preview-hint error">
            失败项已自动保留勾选，点击下方“重试失败项”只会重跑失败分镜。
          </p>
          <ul>
            <li
              v-for="item in batchVideoResult.items"
              :key="item.storyboardId"
              :class="{ failed: !item.success }"
            >
              <span>{{ batchVideoStatusLabel(batchVideoStateFor(item.storyboardId)) }}</span>
              <strong>{{
                workspace.storyboards.find((shot) => shot.id === item.storyboardId)?.title ||
                  item.storyboardId
              }}</strong>
              <em v-if="item.reservedPoints">{{ item.reservedPoints }} 点</em>
              <small v-if="item.errorMessage">{{ item.errorMessage }}</small>
            </li>
          </ul>
        </div>
      </section>
    </GenerationRouteDialog>

    <GenerationRouteDialog
      :open="showRouteDialog"
      :submitting="generating"
      eyebrow="文本 AI"
      title="选择用于拆解分镜的模型"
      submit-label="开始拆解"
      :quote-prompt="workspace.activeEpisode?.scriptText || ''"
      @close="closeGenerationRoute"
      @submit="createStoryboardCandidate"
    />
    <StoryboardCandidateDialog
      :open="showCandidateDialog"
      :candidate="storyboardCandidate"
      :characters="workspace.characters"
      :scenes="workspace.scenes"
      :existing-count="workspace.storyboards.length"
      :applying="applyingCandidate"
      :error="candidateError"
      @close="!applyingCandidate && (showCandidateDialog = false)"
      @regenerate="regenerateStoryboardCandidate"
      @apply="applyStoryboardCandidate"
    />
    <MediaGenerationDialog
      v-if="videoStoryboard"
      open
      :project-id="projectId"
      :storyboard-id="videoStoryboard.id"
      :title="`镜头 ${videoStoryboard.shotNo} · ${videoStoryboard.title}`"
      media-type="VIDEO"
      :initial-prompt="storyboardVideoPrompt(videoStoryboard)"
      :duration-sec="videoStoryboard.durationSec"
      :linked-references="linkedReferencesForStoryboard(videoStoryboard)"
      :linked-media-references="videoMediaReferences"
      :aspect-ratio="projectFrame.aspectRatio"
      :output-size="projectFrame.videoSize"
      :audio-mode="videoStoryboard.audioMode"
      :speaker-name="speakerForStoryboard(videoStoryboard)?.name"
      @backgrounded="markVideoGenerationBackgrounded"
      @close="closeVideoGeneration"
    />
    <MediaGenerationDialog
      v-if="voiceStoryboard"
      open
      :project-id="projectId"
      :storyboard-id="voiceStoryboard.id"
      :title="`镜头 ${voiceStoryboard.shotNo} · ${voiceStoryboard.title} · 对白/内心独白`"
      media-type="TTS"
      :initial-prompt="storyboardVoiceText(voiceStoryboard)"
      :speaker-name="speakerForStoryboard(voiceStoryboard)?.name"
      :speaker-character-id="speakerForStoryboard(voiceStoryboard)?.id"
      :initial-voice="speakerForStoryboard(voiceStoryboard)?.ttsVoiceId"
      :initial-instructions="speakerForStoryboard(voiceStoryboard)?.voiceDescription"
      :duration-sec="voiceStoryboard.durationSec"
      @backgrounded="markGenerationBackgrounded"
      @close="voiceStoryboard = null"
    />
    <div
      v-if="showVoiceSampleDialog && selectedStoryboard"
      class="modal-backdrop"
      @click.self="!extractingVoiceSample && (showVoiceSampleDialog = false)"
    >
      <section class="modal voice-sample-modal" role="dialog" aria-modal="true">
        <header>
          <div>
            <p>{{ desktop.available ? '本地 FFmpeg' : '浏览器本地处理' }}</p>
            <h2>
              {{ audioExtractionTarget === 'CHARACTER_VOICE' ? '提取角色声音' : '提取背景音频' }}
            </h2>
          </div>
          <button
            class="icon-button"
            type="button"
            title="关闭"
            :disabled="extractingVoiceSample"
            @click="showVoiceSampleDialog = false"
          >
            <X :size="18" />
          </button>
        </header>
        <div class="voice-sample-body">
          <p>
            {{
              audioExtractionTarget === 'CHARACTER_VOICE'
                ? '请选择只有目标角色单独说话的片段。其他人声、音乐和明显音效会降低后续声线一致性。'
                : '截取的音轨会作为当前分镜背景音频。若片段中包含对白，合成时会与角色配音同时播放，请选择合适的时间范围。'
            }}
          </p>
          <label v-if="audioExtractionTarget === 'CHARACTER_VOICE'">
            绑定角色
            <select v-model="voiceSampleCharacterId">
              <option
                v-for="character in voiceSampleCharacterOptions"
                :key="character.id"
                :value="character.id"
              >
                {{ character.name }}
              </option>
            </select>
          </label>
          <div class="form-grid two-columns">
            <label
            >开始时间（秒）<input
              v-model.number="voiceSampleStartSec"
              type="number"
              min="0"
              :max="extractionDurationSec - 1"
              step="0.1"
            /></label>
            <label
            >结束时间（秒）<input
              v-model.number="voiceSampleEndSec"
              type="number"
              min="1"
              :max="extractionDurationSec"
              step="0.1"
            /></label>
          </div>
          <small
          >当前视频可截取时长约 {{ extractionDurationSec.toFixed(1) }} 秒，单次最多 60 秒。</small
          >
        </div>
        <footer>
          <button
            class="button"
            type="button"
            :disabled="extractingVoiceSample"
            @click="showVoiceSampleDialog = false"
          >
            取消
          </button>
          <button
            class="button primary"
            type="button"
            :disabled="extractingVoiceSample"
            @click="extractVideoAudio"
          >
            <LoaderCircle v-if="extractingVoiceSample" class="spin" :size="16" />
            <Scissors v-else :size="16" />{{
              extractingVoiceSample
                ? '提取中'
                : audioExtractionTarget === 'CHARACTER_VOICE'
                  ? '提取并绑定角色'
                  : '提取并设为背景音频'
            }}
          </button>
        </footer>
      </section>
    </div>
    <input
      ref="browserUploadInput"
      class="visually-hidden"
      type="file"
      accept="image/png,image/jpeg,image/webp"
      @change="uploadBrowserFrame"
    />
  </section>
</template>
