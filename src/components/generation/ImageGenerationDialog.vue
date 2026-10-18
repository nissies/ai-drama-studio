<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  Check,
  Download,
  Image as ImageIcon,
  LoaderCircle,
  RefreshCw,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-vue-next'
import {
  generationApi,
  startLocalJobHeartbeat,
  type GenerationJob,
  type GenerationRoute,
} from '../../api/generation'
import { mediaAssetApi } from '../../api/assets'
import {
  imageGenerationApi,
  type ImageCandidate,
  type ImageCompositionType,
  type ImageSize,
  type ImageTargetType,
} from '../../api/image-generation'
import { IMAGE_SIZE_OPTIONS, isImageSize } from '../../domain/image-sizes'
import { projectFrameProfile } from '../../domain/project-frame-profile'
import { latestActiveGenerationJob } from '../../domain/active-generation-job'
import {
  applyProjectVisualNegativeStyle,
  applyProjectVisualStyle,
} from '../../domain/production-visual-style'
import { useDesktopStore } from '../../stores/desktop'
import { useWorkspaceStore } from '../../stores/workspace'
import { mapSettledWithConcurrency } from '../../utils/concurrency'
import { fileExtension, normalizeImageBlob, normalizeImageFile } from '../../utils/image-files'
import { deleteBrowserImage, loadBrowserImage } from '../../browser/browser-image-store'
import {
  applyCharacterReferencePreset,
  applyCharacterNegativePreset,
  CHARACTER_COMPOSITION_OPTIONS,
  defaultImageComposition,
  recommendedImageSize,
  referencePreset,
  referenceViewType,
} from './character-reference-presets'
import GenerationRouteDialog from './GenerationRouteDialog.vue'

const props = defineProps<{
  open: boolean
  projectId: string
  targetType: ImageTargetType
  targetId: string
  title: string
  initialPrompt?: string
  initialNegativePrompt?: string
  initialSize?: ImageSize
  lockSize?: boolean
  linkedReferences?: Array<{ assetId: string; label: string }>
  category: 'characters' | 'scenes' | 'storyboards'
  characterId?: string
  characterFormId?: string
  characterRoleType?: string
  episodeId?: string
  sceneId?: string
  storyboardId?: string
}>()
const emit = defineEmits<{ close: []; referenced: []; backgrounded: [jobId: string] }>()

const desktop = useDesktopStore()
const workspace = useWorkspaceStore()
const prompt = ref('')
const negativePrompt = ref('')
const size = ref<ImageSize>('1152x2048')
const compositionType = ref<ImageCompositionType>('SINGLE')
const routeOpen = ref(false)
const routeError = ref('')
const submitting = ref(false)
const restoringJob = ref(false)
const loading = ref(false)
const actingId = ref('')
const referenceImages = ref<
  Array<{
    file: globalThis.File
    previewUrl: string
    linked: boolean
    label?: string
    assetId?: string
  }>
>([])
const referenceLoading = ref(false)
const referenceNotice = ref('')
const autoSaveNotice = ref('')
const error = ref('')
const job = ref<GenerationJob | null>(null)
const candidates = ref<ImageCandidate[]>([])
const remotePreviews = new Map<string, string>()
const remotePreviewBlobs = new Map<string, Awaited<ReturnType<typeof imageGenerationApi.preview>>>()
const previewErrors = new Map<string, string>()
const previewVersion = ref(0)
const REMOTE_PREVIEW_CONCURRENCY = 3
const PLATFORM_POLL_INTERVAL_MS = 1_500
const PLATFORM_POLL_ATTEMPTS = 640
const MAX_REFERENCE_FILES = 10
const MAX_REFERENCE_FILE_BYTES = 10 * 1024 * 1024
const MAX_REFERENCE_TOTAL_BYTES = 30 * 1024 * 1024
const autoSaveAttemptedIds = new Set<string>()
const autoSaveFailedIds = ref(new Set<string>())
let referenceLoadVersion = 0
let detached = false

const actionLabel = computed(() => (candidates.value.length ? '重新生成' : '生成图片'))

function resolveDefaultImageSize(
  composition: ImageCompositionType = compositionType.value,
): ImageSize {
  if (props.initialSize) return props.initialSize
  // 场景/分镜：始终跟随项目画幅
  if (props.category === 'scenes' || props.category === 'storyboards') {
    return projectFrameProfile(workspace.project?.aspectRatio).imageSize
  }
  // 角色多视图设定板保持横向构图；普通单图跟随项目
  if (composition === 'SINGLE') {
    return projectFrameProfile(workspace.project?.aspectRatio).imageSize
  }
  return recommendedImageSize(composition)
}

const compositionDescription = computed(() => referencePreset(compositionType.value).description)
const characterCompositionOptions = computed(() => CHARACTER_COMPOSITION_OPTIONS)

watch(
  () => props.open,
  (open) => {
    if (!open) {
      detached = true
      referenceLoadVersion += 1
      referenceLoading.value = false
      releasePreviews()
      clearReferenceImages()
      autoSaveAttemptedIds.clear()
      autoSaveFailedIds.value = new Set()
      return
    }
    detached = false
    compositionType.value = defaultImageComposition(props.category)
    const styledPrompt = applyProjectVisualStyle(
      props.initialPrompt?.trim() ?? '',
      props.category,
      workspace.project?.visualStyle,
    )
    prompt.value =
      props.category === 'characters'
        ? applyCharacterReferencePreset(styledPrompt, compositionType.value, undefined, {
            hasReferenceImages: Boolean(props.linkedReferences?.length),
          })
        : styledPrompt
    const styledNegativePrompt = applyProjectVisualNegativeStyle(
      props.initialNegativePrompt?.trim() ?? '',
      props.category,
      workspace.project?.visualStyle,
    )
    negativePrompt.value =
      props.category === 'characters'
        ? applyCharacterNegativePreset(styledNegativePrompt)
        : styledNegativePrompt
    size.value = resolveDefaultImageSize(compositionType.value)
    clearReferenceImages()
    error.value = ''
    autoSaveNotice.value = ''
    referenceNotice.value = ''
    routeError.value = ''
    job.value = null
    void loadLinkedReferences()
    void loadCandidates()
    void restoreActiveJob()
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  detached = true
  referenceLoadVersion += 1
  releasePreviews()
  clearReferenceImages()
})

async function loadCandidates() {
  if (detached || !props.open) return
  loading.value = true
  error.value = ''
  referenceNotice.value = ''
  try {
    const loaded = await imageGenerationApi.list(props.projectId, props.targetType, props.targetId)
    if (detached) return
    candidates.value = loaded.filter((candidate) => candidate.compositionType !== 'CONTACT_SHEET')
    await autoSaveLatestCandidate()
    void loadRemotePreviews()
  } catch (caught) {
    error.value = messageFor(caught, '图片候选读取失败')
  } finally {
    loading.value = false
  }
}

async function generate(route: GenerationRoute) {
  if (!prompt.value.trim() || submitting.value || restoringJob.value || referenceLoading.value)
    return
  submitting.value = true
  error.value = ''
  routeError.value = ''
  let jobAccepted = false
  const referenceFiles = referenceImages.value.map((item) => item.file)
  try {
    if (props.category === 'characters') {
      prompt.value = applyCharacterReferencePreset(prompt.value, compositionType.value, undefined, {
        hasReferenceImages: referenceFiles.length > 0,
      })
      negativePrompt.value = applyCharacterNegativePreset(negativePrompt.value)
    }
    const uploadedReferences =
      route.sourceType === 'PLATFORM' && referenceFiles.length
        ? await imageGenerationApi.uploadReferences(referenceFiles)
        : []
    let current = await imageGenerationApi.create(
      props.projectId,
      {
        targetType: props.targetType,
        targetId: props.targetId,
        prompt: prompt.value,
        negativePrompt: negativePrompt.value,
        size: size.value,
        compositionType: compositionType.value,
        parameters: uploadedReferences.length
          ? { reference_image_ids: uploadedReferences.map((item) => item.id) }
          : undefined,
        route,
      },
      globalThis.crypto.randomUUID(),
    )
    jobAccepted = true
    routeOpen.value = false
    job.value = current
    if (route.sourceType === 'LOCAL') {
      current = await generationApi.startLocal(current.id)
      job.value = current
      const stopHeartbeat = startLocalJobHeartbeat(current.id, 25)
      try {
        const execution = current.executionRequest
        if (!execution) throw new Error('本地图片任务缺少不可变执行快照')
        const snapshotSize = execution.parameters.size
        const snapshotNegativePrompt = execution.parameters.negative_prompt
        const local = await desktop.generateLocalImage({
          projectId: props.projectId,
          connectionId: route.localConnectionId,
          prompt: execution.userPrompt,
          negativePrompt:
            typeof snapshotNegativePrompt === 'string' ? snapshotNegativePrompt : undefined,
          size: isImageSize(snapshotSize) ? snapshotSize : '1024x1536',
          referenceImages: await Promise.all(
            referenceFiles.map(async (file) => ({
              name: file.name,
              mimeType: file.type as 'image/png' | 'image/jpeg' | 'image/webp',
              bytes: await file.arrayBuffer(),
            })),
          ),
        })
        await imageGenerationApi.completeLocal(current.id, {
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
        job.value = await generationApi.get(current.id)
      } catch (caught) {
        const message = messageFor(caught, '本地图片生成失败')
        try {
          await generationApi.failLocal(current.id, message)
        } catch {
          // The provider failure is more useful than a secondary reporting error.
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
        throw new Error(completed.errorMessage || '平台图片生成失败')
      }
    }
    if (!detached) await loadCandidates()
  } catch (caught) {
    const message = messageFor(caught, '图片生成失败')
    if (!detached) error.value = message
    if (!detached && !jobAccepted) {
      routeError.value = message
      routeOpen.value = true
    }
  } finally {
    submitting.value = false
  }
}

async function addReferenceImages(event: globalThis.Event) {
  const input = event.target as globalThis.HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  error.value = ''
  for (const file of files) {
    if (referenceImages.value.length >= MAX_REFERENCE_FILES) {
      error.value = '每次最多使用 10 张参考图'
      break
    }
    try {
      const normalized = await normalizeImageFile(file, MAX_REFERENCE_FILE_BYTES)
      if (referenceBytes() + normalized.file.size > MAX_REFERENCE_TOTAL_BYTES) {
        error.value = '参考图总大小不能超过 30MB'
        break
      }
      referenceImages.value.push({
        file: normalized.file,
        previewUrl: globalThis.URL.createObjectURL(normalized.file),
        linked: false,
      })
      if (normalized.corrected) {
        referenceNotice.value = `${normalized.originalName} 的后缀与真实格式不一致，已自动按 ${normalized.file.name} 处理`
      }
    } catch (caught) {
      error.value = messageFor(caught, `${file.name} 不是支持的图片`)
    }
  }
  refreshCharacterPromptForReferences()
}

function removeReferenceImage(index: number) {
  const [removed] = referenceImages.value.splice(index, 1)
  if (removed) globalThis.URL.revokeObjectURL(removed.previewUrl)
  refreshCharacterPromptForReferences()
}

function clearReferenceImages() {
  referenceImages.value.forEach((item) => globalThis.URL.revokeObjectURL(item.previewUrl))
  referenceImages.value = []
}

async function loadLinkedReferences() {
  const linkedReferences = (props.linkedReferences ?? []).slice(0, MAX_REFERENCE_FILES)
  if (!linkedReferences.length) return
  const loadVersion = ++referenceLoadVersion
  referenceLoading.value = true
  let failed = 0
  try {
    for (const reference of linkedReferences) {
      if (referenceImages.value.some((item) => item.assetId === reference.assetId)) continue
      try {
        const file = await loadLinkedReferenceFile(reference.assetId, reference.label)
        if (loadVersion !== referenceLoadVersion || !props.open) return
        if (referenceBytes() + file.size > MAX_REFERENCE_TOTAL_BYTES) {
          failed += 1
          continue
        }
        referenceImages.value.push({
          file,
          previewUrl: globalThis.URL.createObjectURL(file),
          linked: true,
          label: reference.label,
          assetId: reference.assetId,
        })
      } catch {
        failed += 1
      }
    }
    const loaded = referenceImages.value.filter((item) => item.linked).length
    referenceNotice.value = failed
      ? `已自动关联 ${loaded} 张角色/场景图，${failed} 张本地文件读取失败`
      : `已自动关联 ${loaded} 张角色/场景图`
    if (loaded > 0) refreshCharacterPromptForReferences()
  } finally {
    if (loadVersion === referenceLoadVersion) referenceLoading.value = false
  }
}

async function loadLinkedReferenceFile(assetId: string, label: string) {
  const asset = workspace.mediaAssetById(assetId)
  if (!asset || asset.assetType !== 'IMAGE') throw new Error(`${label}不是有效图片素材`)
  let blob: globalThis.Blob | null
  if (desktop.available) {
    const local = desktop.project?.assets.find((item) => item.id === assetId)
    if (!local?.fileAvailable) throw new Error(`${label}的本地文件不存在`)
    const response = await globalThis.fetch(desktop.assetPreviewUrl(assetId))
    if (!response.ok) throw new Error(`${label}读取失败`)
    blob = await response.blob()
  } else {
    blob = await loadBrowserImage(props.projectId, assetId)
  }
  if (!blob) throw new Error(`${label}的本地文件不存在`)
  const normalizedBlob = await normalizeImageBlob(blob)
  const sourceFile = new globalThis.File([normalizedBlob], asset.originalFilename, {
    type: normalizedBlob.type,
    lastModified: Date.now(),
  })
  return (await normalizeImageFile(sourceFile, MAX_REFERENCE_FILE_BYTES)).file
}

function referenceBytes() {
  return referenceImages.value.reduce((total, item) => total + item.file.size, 0)
}

async function deleteCandidate(candidate: ImageCandidate) {
  const deletingSavedImage = Boolean(candidate.localAssetId)
  const confirmation = deletingSavedImage
    ? `确定删除这张已保存图片吗？${isCurrentReference(candidate) ? '它将不再作为当前使用的图片。' : ''}此操作无法撤销。`
    : '确定删除这张候选图记录吗？此操作无法撤销。'
  if (!globalThis.confirm(confirmation)) return
  await runCandidateAction(candidate, async () => {
    const deleted = await imageGenerationApi.delete(candidate.id, candidate.version)
    if (candidate.deliveryType === 'LOCAL_CACHE' && candidate.clientCandidateId) {
      try {
        await desktop.discardGeneratedImage(candidate.clientCandidateId)
      } catch {
        error.value = '候选记录已删除，但本地临时缓存清理失败，可稍后在缓存清理中处理'
      }
    }
    if (deleted.assetDeleted && candidate.localAssetId) {
      if (desktop.available) {
        await desktop.removeAsset(candidate.localAssetId)
        if (desktop.project?.assets.some((item) => item.id === candidate.localAssetId)) {
          error.value = '图片记录已删除，但 Windows 本地文件清理失败，请到本地素材页重试'
        }
      } else {
        await deleteBrowserImage(props.projectId, candidate.localAssetId).catch(() => {
          error.value = '图片记录已删除，但浏览器本地文件清理失败'
        })
      }
    }
    if (deletingSavedImage) await workspace.loadAssetResources(props.projectId)
    const preview = remotePreviews.get(candidate.id)
    if (preview) globalThis.URL.revokeObjectURL(preview)
    remotePreviews.delete(candidate.id)
    remotePreviewBlobs.delete(candidate.id)
    previewErrors.delete(candidate.id)
    candidates.value = candidates.value.filter((item) => item.id !== candidate.id)
    previewVersion.value += 1
  })
}

async function restoreActiveJob() {
  if (restoringJob.value || submitting.value) return
  restoringJob.value = true
  try {
    const page = await generationApi.list(props.projectId)
    if (detached) return
    const active = latestActiveGenerationJob(
      page.items,
      'IMAGE_GENERATION',
      props.targetType,
      props.targetId,
    )
    if (!active) return
    job.value = active
    submitting.value = true
    const completed = await waitForCompletion(active.id)
    if (!completed) return
    job.value = completed
    if (completed.status === 'FAILED') {
      error.value = completed.errorMessage || '后台图片生成失败'
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

async function selectCandidate(candidate: ImageCandidate) {
  await runCandidateAction(candidate, async () => {
    let selected = await ensureSelectedCandidate(candidate)
    replaceCandidate(selected)
    selected = await persistSelectedCandidate(selected)
    replaceCandidate(selected)
    await applyReference(selected)
  })
}

async function saveCandidate(candidate: ImageCandidate) {
  await runCandidateAction(candidate, async () => {
    const saved = await persistSelectedCandidate(candidate)
    replaceCandidate(saved)
    await applyReference(saved)
    autoSaveFailedIds.value = new Set(
      [...autoSaveFailedIds.value].filter((id) => id !== candidate.id),
    )
  })
}

async function setReference(candidate: ImageCandidate) {
  if (!candidate.localAssetId) return
  await runCandidateAction(candidate, async () => {
    await applyReference(candidate)
  })
}

async function autoSaveLatestCandidate() {
  if (!desktop.available || detached || !props.open) return
  const candidate = candidates.value.find(canAutoSaveCandidate)
  if (!candidate || autoSaveAttemptedIds.has(candidate.id)) return
  const saved = await runCandidateAction(
    candidate,
    async () => {
      let selected = await ensureSelectedCandidate(candidate)
      replaceCandidate(selected)
      selected = await persistSelectedCandidate(selected)
      replaceCandidate(selected)
      await applyReference(selected)
      autoSaveAttemptedIds.add(candidate.id)
      autoSaveFailedIds.value = new Set(
        [...autoSaveFailedIds.value].filter((id) => id !== candidate.id),
      )
      if (!detached) autoSaveNotice.value = '已自动保存到本地项目目录'
    },
    '自动保存到本地失败，候选已保留，可点击保存重试',
  )
  if (!saved) autoSaveFailedIds.value = new Set([...autoSaveFailedIds.value, candidate.id])
}

function canAutoSaveCandidate(candidate: ImageCandidate) {
  if (candidate.localAssetId || candidate.status === 'LOCAL_SAVED') return false
  if (!['AVAILABLE', 'SELECTED'].includes(candidate.status)) return false
  if (candidate.deliveryType === 'LOCAL_CACHE') return Boolean(candidate.clientCandidateId)
  return (
    candidate.previewAvailable &&
    ['PLATFORM_REMOTE', 'PLATFORM_CACHE'].includes(candidate.deliveryType)
  )
}

async function ensureSelectedCandidate(candidate: ImageCandidate) {
  if (candidate.status === 'AVAILABLE') {
    return imageGenerationApi.select(candidate.id, candidate.version)
  }
  return candidate
}

async function persistSelectedCandidate(candidate: ImageCandidate) {
  if (candidate.localAssetId || candidate.status === 'LOCAL_SAVED') return candidate
  if (candidate.status !== 'SELECTED') {
    throw new Error('请先选中候选图')
  }
  if (desktop.available) {
    const accessToken = imageGenerationApi.accessToken()
    if (candidate.deliveryType === 'PLATFORM_REMOTE' && !accessToken) {
      throw new Error('登录状态无效，无法保存平台图片')
    }
    const localAsset = await desktop.saveGeneratedImage(
      candidate.deliveryType === 'LOCAL_CACHE'
        ? {
            projectId: props.projectId,
            projectTitle: workspace.project?.title || props.title,
            candidateId: candidate.id,
            deliveryType: 'LOCAL_CACHE',
            clientCandidateId: requiredClientCandidateId(candidate),
            category: props.category,
          }
        : {
            projectId: props.projectId,
            projectTitle: workspace.project?.title || props.title,
            candidateId: candidate.id,
            deliveryType: 'PLATFORM_REMOTE',
            category: props.category,
            accessToken: accessToken!,
          },
    )
    if (!desktop.project) throw new Error('本地项目清单读取失败')
    const mappings = await workspace.synchronizeLocalAssets(props.projectId, [localAsset])
    const canonicalId =
      mappings.find((item) => item.clientAssetId === localAsset.id)?.assetId ?? localAsset.id
    await desktop.reconcileAssetIds(mappings.filter((item) => item.clientAssetId !== item.assetId))
    return imageGenerationApi.confirmSaved(candidate.id, canonicalId, candidate.version)
  }

  // 网页模式：生成结果保存到服务端，不落浏览器本地存档。
  // 桌面 Windows 模式走上方 local workspace 分支，保存到用户本机项目目录。
  const blob = await loadCandidatePreview(candidate)
  const file = new File([blob], `ai-image-${candidate.id.slice(0, 8)}${fileExtension(blob.type)}`, {
    type: blob.type || 'image/png',
  })
  const uploaded = await mediaAssetApi.upload(props.projectId, {
    localCategory: props.category,
    file,
  })
  await workspace.loadAssetResources(props.projectId)
  return imageGenerationApi.confirmSaved(candidate.id, uploaded.id, candidate.version)
}

async function applyReference(candidate: ImageCandidate) {
  if (!candidate.localAssetId) throw new Error('候选图尚未保存为本地素材')
  if (props.category === 'characters' && props.characterId) {
    await workspace.createCharacterReference(props.projectId, {
      characterId: props.characterId,
      characterFormId: props.characterFormId,
      assetId: candidate.localAssetId,
      viewType: referenceViewType(candidate.compositionType),
      primaryReference: true,
    })
  } else if (props.category === 'scenes' && props.episodeId && props.sceneId) {
    await workspace.createSceneReference(props.projectId, {
      episodeId: props.episodeId,
      sceneId: props.sceneId,
      assetId: candidate.localAssetId,
      referenceType: 'OVERVIEW',
      primaryReference: true,
    })
  } else if (props.category === 'storyboards' && props.storyboardId) {
    await workspace.setStoryboardOutput(props.projectId, props.storyboardId, {
      outputType: 'KEYFRAME',
      mediaAssetId: candidate.localAssetId,
      sourceType: 'IMAGE_CANDIDATE',
      sourceId: candidate.id,
    })
  } else {
    throw new Error('参考图目标信息不完整')
  }
  emit('referenced')
}

async function runCandidateAction(
  candidate: ImageCandidate,
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

function replaceCandidate(candidate: ImageCandidate) {
  const index = candidates.value.findIndex((item) => item.id === candidate.id)
  if (index >= 0) candidates.value[index] = candidate
  else candidates.value.unshift(candidate)
}

async function loadRemotePreviews() {
  releasePreviews()
  const platformCandidates = candidates.value.filter(
    (candidate) =>
      !localSavedPreviewUrl(candidate) &&
      ((!desktop.available && Boolean(candidate.localAssetId)) ||
        (candidate.deliveryType === 'PLATFORM_REMOTE' && candidate.previewAvailable)),
  )

  const results = await mapSettledWithConcurrency(
    platformCandidates,
    REMOTE_PREVIEW_CONCURRENCY,
    (candidate) => loadCandidatePreview(candidate),
  )
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      previewErrors.set(
        platformCandidates[index].id,
        messageFor(result.reason, '平台图片预览读取失败'),
      )
    }
  })
  previewVersion.value += 1
}

async function loadCandidatePreview(candidate: ImageCandidate) {
  if (detached) throw new Error('图片窗口已关闭')
  const cached = remotePreviewBlobs.get(candidate.id)
  if (cached) return cached
  const savedUrl = localSavedPreviewUrl(candidate)
  if (savedUrl) {
    const response = await globalThis.fetch(savedUrl)
    if (response.ok) {
      const local = await response.blob()
      remotePreviewBlobs.set(candidate.id, local)
      previewErrors.delete(candidate.id)
      return local
    }
  }
  if (!desktop.available && candidate.localAssetId) {
    const local = await loadBrowserImage(props.projectId, candidate.localAssetId)
    if (detached) throw new Error('图片窗口已关闭')
    if (local) {
      remotePreviewBlobs.set(candidate.id, local)
      remotePreviews.set(candidate.id, globalThis.URL.createObjectURL(local))
      previewErrors.delete(candidate.id)
      previewVersion.value += 1
      return local
    }
  }
  const blob = await imageGenerationApi.preview(candidate.id)
  if (detached) throw new Error('图片窗口已关闭')
  remotePreviewBlobs.set(candidate.id, blob)
  remotePreviews.set(candidate.id, globalThis.URL.createObjectURL(blob))
  previewErrors.delete(candidate.id)
  previewVersion.value += 1
  return blob
}

function releasePreviews() {
  remotePreviews.forEach((url) => globalThis.URL.revokeObjectURL(url))
  remotePreviews.clear()
  remotePreviewBlobs.clear()
  previewErrors.clear()
  previewVersion.value += 1
}

function previewUrl(candidate: ImageCandidate) {
  void previewVersion.value
  const savedUrl = localSavedPreviewUrl(candidate)
  if (savedUrl) return savedUrl
  if (candidate.deliveryType === 'LOCAL_CACHE' && candidate.clientCandidateId) {
    return desktop.generatedCandidatePreviewUrl(candidate.clientCandidateId)
  }
  return remotePreviews.get(candidate.id) ?? ''
}

function localSavedPreviewUrl(candidate: ImageCandidate) {
  if (!candidate.localAssetId || !desktop.available) return ''
  return (
    globalThis.window.aiDramaDesktop?.assetPreviewUrl(props.projectId, candidate.localAssetId) ?? ''
  )
}

function requiredClientCandidateId(candidate: ImageCandidate) {
  if (!candidate.clientCandidateId) throw new Error('本地候选缓存标识缺失')
  return candidate.clientCandidateId
}

async function downloadCandidate(candidate: ImageCandidate) {
  await runCandidateAction(candidate, async () => {
    const blob = await loadCandidatePreview(candidate)
    const objectUrl = globalThis.URL.createObjectURL(blob)
    const anchor = globalThis.document.createElement('a')
    anchor.href = objectUrl
    anchor.download = `ai-image-${candidate.id.slice(0, 8)}${fileExtension(blob.type)}`
    globalThis.document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    globalThis.setTimeout(() => globalThis.URL.revokeObjectURL(objectUrl), 1_000)
  })
}

function isReferenced(candidate: ImageCandidate) {
  if (!candidate.localAssetId) return false
  if (props.category === 'characters' && props.characterId) {
    return workspace
      .referencesForCharacter(props.characterId, props.characterFormId)
      .some((item) => item.assetId === candidate.localAssetId)
  }
  if (props.category === 'scenes' && props.sceneId) {
    return workspace
      .referencesForScene(props.sceneId)
      .some((item) => item.assetId === candidate.localAssetId)
  }
  if (props.category === 'storyboards' && props.storyboardId) {
    return (
      workspace.outputForStoryboard(props.storyboardId, 'KEYFRAME')?.mediaAssetId ===
      candidate.localAssetId
    )
  }
  return false
}

function isCurrentReference(candidate: ImageCandidate) {
  if (!candidate.localAssetId) return false
  if (props.category === 'characters' && props.characterId) {
    return workspace
      .referencesForCharacter(props.characterId, props.characterFormId)
      .some((item) => item.assetId === candidate.localAssetId && item.primaryReference)
  }
  if (props.category === 'scenes' && props.sceneId) {
    return workspace
      .referencesForScene(props.sceneId)
      .some((item) => item.assetId === candidate.localAssetId && item.primaryReference)
  }
  if (props.category === 'storyboards' && props.storyboardId) {
    return (
      workspace.outputForStoryboard(props.storyboardId, 'KEYFRAME')?.mediaAssetId ===
      candidate.localAssetId
    )
  }
  return false
}

function statusLabel(candidate: ImageCandidate) {
  if (isCurrentReference(candidate)) {
    return props.category === 'storyboards' ? '当前关键帧' : '当前使用'
  }
  if (candidate.status === 'LOCAL_SAVED' || isReferenced(candidate)) return '已保存，可切换'
  if (candidate.status === 'SELECTED') return '已选中，待保存'
  return '候选'
}

function createdAt(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function close() {
  if (actingId.value || (submitting.value && !job.value)) return
  if (submitting.value && job.value) emit('backgrounded', job.value.id)
  emit('close')
}

function selectComposition() {
  prompt.value = applyCharacterReferencePreset(prompt.value, compositionType.value, undefined, {
    hasReferenceImages: referenceImages.value.length > 0,
  })
  if (!props.lockSize) {
    size.value = resolveDefaultImageSize(compositionType.value)
  }
}

function refreshCharacterPromptForReferences() {
  if (props.category !== 'characters') return
  prompt.value = applyCharacterReferencePreset(prompt.value, compositionType.value, undefined, {
    hasReferenceImages: referenceImages.value.length > 0,
  })
}

function openRoute() {
  routeError.value = ''
  routeOpen.value = true
}

function compositionLabel(value: ImageCompositionType) {
  return referencePreset(value).label
}

function messageFor(caught: unknown, fallback: string) {
  return caught instanceof Error && caught.message ? caught.message : fallback
}
</script>

<template>
  <div v-if="open" class="modal-backdrop" @click.self="close">
    <section class="modal image-generation-modal" role="dialog" aria-modal="true">
      <header>
        <div>
          <p>
            {{
              category === 'characters'
                ? '角色参考图生成'
                : category === 'storyboards'
                  ? '分镜关键帧生成'
                  : '单张图片生成'
            }}
          </p>
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

      <div class="image-generation-layout">
        <aside class="image-prompt-editor">
          <label v-if="category === 'characters'" class="image-composition-field"
            >图片类型<select v-model="compositionType" @change="selectComposition">
              <option
                v-for="preset in characterCompositionOptions"
                :key="preset.value"
                :value="preset.value"
              >
                {{ preset.label }}
              </option>
            </select>
            <small>{{ compositionDescription }}</small></label
          >
          <label
            >正向提示词<textarea
              v-model="prompt"
              rows="10"
              maxlength="20000"
              placeholder="人物或场景主体、构图、光线、色彩、材质与画面风格"
            />
          </label>
          <label
            >负面提示词<textarea
              v-model="negativePrompt"
              rows="5"
              maxlength="10000"
              placeholder="不希望出现的元素与画面问题"
            />
          </label>
          <div class="image-reference-input">
            <header>
              <div>
                <strong>参考图</strong
                ><small>{{
                  referenceLoading
                    ? '正在读取已关联素材...'
                    : '有参考图时会强制锁定人物外貌与服装，请上传清晰正面或设定图'
                }}</small>
              </div>
              <label class="icon-button compact" title="添加参考图">
                <Upload :size="15" /><span class="visually-hidden">添加参考图</span>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  multiple
                  @change="addReferenceImages"
                />
              </label>
            </header>
            <div v-if="referenceImages.length" class="image-reference-list">
              <article v-for="(item, index) in referenceImages" :key="item.previewUrl">
                <img :src="item.previewUrl" :alt="item.file.name" />
                <span :title="item.label || item.file.name">
                  {{ item.linked ? '自动关联 · ' : '' }}{{ item.label || item.file.name }}
                </span>
                <button
                  class="icon-button compact danger"
                  type="button"
                  title="移除参考图"
                  @click="removeReferenceImage(index)"
                >
                  <Trash2 :size="13" />
                </button>
              </article>
            </div>
            <p v-if="referenceNotice" class="form-success image-reference-notice">
              {{ referenceNotice }}
            </p>
          </div>
          <label
            >{{ lockSize ? '画面尺寸（跟随项目）' : '画面尺寸'
            }}<select v-model="size" :disabled="lockSize">
              <option
                v-for="option in IMAGE_SIZE_OPTIONS"
                :key="option.value"
                :value="option.value"
              >
                {{ option.label }}
              </option>
            </select></label
          >
          <button
            class="button primary image-generate-button"
            type="button"
            :disabled="submitting || restoringJob || referenceLoading || !prompt.trim()"
            @click="openRoute"
          >
            <LoaderCircle v-if="submitting" class="spin" :size="17" />
            <Sparkles v-else :size="17" />{{ submitting ? '生成中' : actionLabel }}
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

        <main class="image-candidate-history">
          <header>
            <div>
              <h3>候选历史</h3>
              <span>{{ candidates.length }} 张</span>
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
            <ImageIcon :size="28" /><strong>暂无候选</strong
            ><span>编辑提示词后选择图片模型生成。</span>
          </div>
          <div v-else class="image-candidate-grid">
            <article
              v-for="candidate in candidates"
              :key="candidate.id"
              class="image-candidate-card"
            >
              <div class="image-candidate-preview">
                <img v-if="previewUrl(candidate)" :src="previewUrl(candidate)" alt="AI 图片候选" />
                <div v-else>
                  <ImageIcon :size="28" /><span>{{
                    previewErrors.get(candidate.id) ||
                    (candidate.previewAvailable ? '预览读取失败' : '临时预览已过期')
                  }}</span>
                </div>
                <em
                  :class="[
                    candidate.status.toLowerCase(),
                    { current: isCurrentReference(candidate) },
                  ]"
                  >{{ statusLabel(candidate) }}</em
                >
              </div>
              <div class="image-candidate-body">
                <header>
                  <strong>{{ candidate.providerCode }}</strong
                  ><time>{{ createdAt(candidate.createdAt) }}</time>
                </header>
                <p :title="candidate.prompt">{{ candidate.prompt }}</p>
                <small
                  ><template v-if="['CHARACTER', 'CHARACTER_FORM'].includes(candidate.targetType)"
                    >{{ compositionLabel(candidate.compositionType) }} · </template
                  >{{ candidate.modelName
                  }}<template v-if="candidate.width">
                    · {{ candidate.width }}×{{ candidate.height }}</template
                  ></small
                >
                <footer>
                  <template v-if="candidate.status === 'AVAILABLE'">
                    <button
                      class="button"
                      type="button"
                      :disabled="Boolean(actingId)"
                      @click="selectCandidate(candidate)"
                    >
                      <Check :size="15" />选中
                    </button>
                  </template>
                  <button
                    class="button"
                    type="button"
                    :disabled="Boolean(actingId)"
                    title="下载图片文件"
                    @click="downloadCandidate(candidate)"
                  >
                    <Download :size="15" />下载
                  </button>
                  <button
                    v-if="
                      candidate.status === 'SELECTED' &&
                      (!desktop.available || autoSaveFailedIds.has(candidate.id))
                    "
                    class="button primary"
                    type="button"
                    :disabled="Boolean(actingId)"
                    title="自动保存失败时重试，并设为当前目标的主参考图"
                    @click="saveCandidate(candidate)"
                  >
                    <Download :size="15" />{{
                      desktop.available ? '重试保存并使用' : '本地保存并使用'
                    }}
                  </button>
                  <button
                    v-else-if="!isCurrentReference(candidate)"
                    class="button primary"
                    type="button"
                    :disabled="Boolean(actingId)"
                    @click="setReference(candidate)"
                  >
                    <ImageIcon :size="15" />{{
                      category === 'storyboards' ? '使用此关键帧' : '使用此图'
                    }}
                  </button>
                  <span v-else class="image-reference-done"><Check :size="14" />当前使用</span>
                  <button
                    class="icon-button compact danger"
                    type="button"
                    :disabled="Boolean(actingId)"
                    :title="candidate.localAssetId ? '删除已保存图片' : '删除候选图'"
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
    :open="routeOpen"
    :submitting="submitting"
    service-type="IMAGE"
    eyebrow="图片生成"
    title="选择本次使用的图片模型"
    :submit-label="actionLabel"
    :execution-error="routeError"
    :quote-prompt="prompt"
    :quote-parameters="{ n: 1, size }"
    @close="routeOpen = false"
    @submit="generate"
  />
</template>
