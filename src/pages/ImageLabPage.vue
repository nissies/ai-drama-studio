<script lang="ts">
export default { name: 'image-lab' }
</script>
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  Download,
  ImagePlus,
  LoaderCircle,
  Paperclip,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from 'lucide-vue-next'
import StudioShell from '../layouts/StudioShell.vue'
import { creditApi, type CreditQuote } from '../api/credits'
import { generationApi, type GenerationJob } from '../api/generation'
import { imageGenerationApi, type ImageCandidate } from '../api/image-generation'
import { imageLabApi } from '../api/image-lab'
import {
  platformModelCatalogApi,
  platformModelOptionLabel,
  type PlatformModelCatalogItem,
} from '../api/model-catalog'
import { IMAGE_SIZE_OPTIONS, type ImageSize } from '../domain/image-sizes'
import type { CachedPlatformImageResult, LocalImageGenerationResult } from '../desktop/types'
import { useCreditStore } from '../stores/credits'
import { useAuthStore } from '../stores/auth'
import { useDesktopStore } from '../stores/desktop'
import { useWorkspaceStore } from '../stores/workspace'

const LAB_PROJECT_ID = '00000000-image-lab-workspace'
const LAB_PROJECT_TITLE = '生图工作区'
const MAX_REFERENCE_FILES = 10
const MAX_REFERENCE_FILE_BYTES = 10 * 1024 * 1024
const HISTORY_STORAGE_KEY = 'ai-drama-image-lab-history-v2'
const LEGACY_HISTORY_STORAGE_KEY = 'ai-drama-image-lab-history-v1'
const MAX_HISTORY = 40
const PLATFORM_POLL_INTERVAL_MS = 1500
const PLATFORM_POLL_ATTEMPTS = 640

type SelectedModelKey = `platform:${string}` | `local:${string}`
type HistorySourceType = 'LOCAL' | 'PLATFORM'

interface LabHistoryItem {
  id: string
  sourceType: HistorySourceType
  projectId: string
  originalName: string
  mimeType: string
  sizeBytes: number
  width: number
  height: number
  providerCode: string
  modelName: string
  prompt: string
  negativePrompt?: string | null
  size: ImageSize
  createdAt: string
  revisedPrompt?: string | null
  serverCandidateId?: string
  serverVersion?: number
  localCached?: boolean
  localAssetId?: string
  localSaveFailed?: boolean
}

interface ReferenceItem {
  file: File
  previewUrl: string
}

const desktop = useDesktopStore()
const workspace = useWorkspaceStore()
const credits = useCreditStore()
const auth = useAuthStore()
const prompt = ref('')
const size = ref<ImageSize>('1024x1536')
const selectedModelKey = ref<SelectedModelKey | ''>('')
const platformModels = ref<PlatformModelCatalogItem[]>([])
const references = ref<ReferenceItem[]>([])
const history = ref<LabHistoryItem[]>([])
const generating = ref(false)
const activeJob = ref<GenerationJob | null>(null)
const initializing = ref(false)
const quoteLoading = ref(false)
const quote = ref<CreditQuote | null>(null)
const quoteError = ref('')
const error = ref('')
const notice = ref('')
const query = ref('')
const composerExpanded = ref(false)
const referenceInput = ref<HTMLInputElement | null>(null)
const selectedId = ref('')
const previewItem = ref<LabHistoryItem | null>(null)
const previewUrls = ref<Record<string, string>>({})
const previewLoadingIds = ref<Record<string, boolean>>({})

const imageConnections = computed(() =>
  desktop.localAiConnections.filter((item) => item.serviceType === 'IMAGE' && item.enabled),
)
const chargeablePlatformModels = computed(() =>
  platformModels.value.filter((item) => Boolean(item.creditPrice)),
)
const selectedPlatformModel = computed(() => {
  const id = selectedModelKey.value.startsWith('platform:')
    ? selectedModelKey.value.slice('platform:'.length)
    : ''
  return platformModels.value.find((item) => item.id === id) || null
})
const selectedConnection = computed(() => {
  const id = selectedModelKey.value.startsWith('local:')
    ? selectedModelKey.value.slice('local:'.length)
    : ''
  return imageConnections.value.find((item) => item.id === id) || null
})
const usingPlatformModel = computed(() => Boolean(selectedPlatformModel.value))
const selectedModelName = computed(
  () =>
    (selectedPlatformModel.value ? platformModelOptionLabel(selectedPlatformModel.value) : '') ||
    selectedConnection.value?.displayName ||
    selectedConnection.value?.modelName ||
    'auto',
)
const platformBalanceInsufficient = computed(
  () =>
    usingPlatformModel.value &&
    quote.value != null &&
    credits.wallet != null &&
    credits.wallet.availablePoints < quote.value.estimatedPoints,
)
const canGenerate = computed(() => {
  if (!prompt.value.trim() || generating.value || initializing.value) return false
  if (selectedPlatformModel.value) {
    return Boolean(selectedPlatformModel.value.creditPrice) && !platformBalanceInsufficient.value
  }
  return desktop.available && Boolean(selectedConnection.value)
})
const modelSelectLabel = computed(() => {
  if (initializing.value) return '正在加载模型...'
  if (!platformModels.value.length && !imageConnections.value.length) return '未配置图片模型'
  return '选择图片模型'
})
const quoteText = computed(() => {
  if (!usingPlatformModel.value) {
    return desktop.available ? '当前使用我的 API，本地生成不扣平台额度' : ''
  }
  if (!selectedPlatformModel.value?.creditPrice) return '该平台模型未配置额度价格，请先在管理端配置'
  if (quoteLoading.value) return '正在计算预计额度...'
  if (quoteError.value) return quoteError.value
  if (!quote.value) return ''
  const balance = credits.wallet?.availablePoints ?? 0
  return `预计 ${quote.value.estimatedPoints} 点 · 可用 ${balance} 点`
})
const filteredHistory = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  if (!keyword) return history.value
  return history.value.filter((item) => {
    const haystack =
      `${item.prompt} ${item.modelName} ${item.providerCode} ${item.size} ${item.width}x${item.height}`.toLowerCase()
    return haystack.includes(keyword)
  })
})
const runningProgress = computed(() => {
  if (!activeJob.value) return usingPlatformModel.value ? 8 : 20
  if (activeJob.value.status === 'SUCCEEDED') return 100
  return Math.max(activeJob.value.progress, 8)
})
const runningStatusText = computed(() =>
  activeJob.value
    ? statusLabel(activeJob.value.status)
    : usingPlatformModel.value
      ? '正在提交平台任务'
      : '本地生成中',
)
const previewUrl = computed(() => (previewItem.value ? candidatePreviewUrl(previewItem.value) : ''))

onMounted(() => {
  void bootstrap()
})

onBeforeUnmount(() => {
  clearReferencePreviews()
  clearServerPreviewUrls()
})

watch(
  () => [selectedModelKey.value, size.value],
  () => {
    void refreshQuote()
  },
)

async function bootstrap() {
  error.value = ''
  notice.value = ''
  loadHistory()
  initializing.value = true
  try {
    const localTasks = desktop.available
      ? [desktop.initialize(), desktop.loadLocalAiConnections(), ensureLabWorkspace()]
      : []
    const cloudTasks = auth.isAuthenticated ? [loadPlatformModels(), credits.load(true)] : []
    await Promise.all([...localTasks, ...cloudTasks])
    restoreLocalAssetHistory()
    selectDefaultModel()
    if (auth.isAuthenticated) {
      await Promise.all([refreshQuote(), restorePlatformCandidates(), restoreActivePlatformJob()])
    }
    if (!platformModels.value.length && !imageConnections.value.length) {
      error.value = desktop.available
        ? '管理端和本地都还没有可用图片模型。请先在管理端配置平台图片模型，或在设置中添加我的 API。'
        : '管理端还没有可用图片模型。请先在管理端配置平台图片模型。'
    }
  } catch (caught) {
    error.value = messageFor(caught, '生图工作区初始化失败')
  } finally {
    initializing.value = false
  }
}

async function restoreActivePlatformJob() {
  if (!auth.isAuthenticated) return
  const jobs = await generationApi.listMine(1, 100)
  const active = jobs.items.find(
    (item) =>
      item.targetType === 'IMAGE_LAB' &&
      item.sourceType === 'PLATFORM' &&
      ['WAITING_LOCAL', 'QUEUED', 'RUNNING'].includes(item.status),
  )
  if (!active) return
  activeJob.value = active
  notice.value = '检测到未结束的生图任务，正在恢复进度'
  const finalJob = await pollPlatformJob(active.id)
  if (finalJob.status === 'FAILED') {
    error.value = finalJob.errorMessage || '恢复的生图任务执行失败'
  } else if (finalJob.status === 'SUCCEEDED') {
    await restorePlatformCandidates()
  }
}

async function loadPlatformModels() {
  if (!auth.isAuthenticated) {
    platformModels.value = []
    return
  }
  platformModels.value = await platformModelCatalogApi.list('IMAGE')
}

function selectDefaultModel() {
  if (selectedPlatformModel.value || selectedConnection.value) return
  const platform = chargeablePlatformModels.value[0] || platformModels.value[0]
  if (platform) {
    selectedModelKey.value = `platform:${platform.id}`
    return
  }
  const local =
    imageConnections.value.find((item) => item.defaultProvider) || imageConnections.value[0]
  selectedModelKey.value = local ? `local:${local.id}` : ''
}

async function ensureLabWorkspace() {
  if (!window.aiDramaDesktop) throw new Error('当前不是 Windows 桌面客户端')
  await desktop.ensureProject({ id: LAB_PROJECT_ID, title: LAB_PROJECT_TITLE })
}

function restoreLocalAssetHistory() {
  if (desktop.project?.projectId !== LAB_PROJECT_ID) return
  const knownAssetIds = new Set(history.value.map((item) => item.localAssetId).filter(Boolean))
  const restored = desktop.project.assets
    .filter(
      (asset) =>
        asset.category === 'images' &&
        asset.fileAvailable &&
        asset.mimeType.startsWith('image/') &&
        !knownAssetIds.has(asset.id),
    )
    .map<LabHistoryItem>((asset) => ({
      id: `local-archive-${asset.id}`,
      sourceType: 'LOCAL',
      projectId: LAB_PROJECT_ID,
      originalName: asset.originalName,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      width: 0,
      height: 0,
      providerCode: 'LOCAL_ARCHIVE',
      modelName: '本地永久素材',
      prompt: '从本地项目目录恢复的已保存图片',
      size: '1024x1536',
      createdAt: asset.importedAt,
      localCached: true,
      localAssetId: asset.id,
    }))
  if (!restored.length) return
  history.value = [...history.value, ...restored]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, MAX_HISTORY)
  if (!selectedId.value && history.value[0]) selectedId.value = history.value[0].id
  persistHistory()
}

function loadHistory() {
  try {
    const raw =
      globalThis.localStorage?.getItem(HISTORY_STORAGE_KEY) ||
      globalThis.localStorage?.getItem(LEGACY_HISTORY_STORAGE_KEY)
    if (!raw) {
      history.value = []
      return
    }
    const parsed = JSON.parse(raw) as Array<Partial<LabHistoryItem>>
    history.value = Array.isArray(parsed)
      ? parsed
          .filter((item) => Boolean(item.id && item.prompt))
          .map((item) => ({
            ...item,
            sourceType: item.sourceType || 'LOCAL',
            projectId: item.projectId || LAB_PROJECT_ID,
            originalName: item.originalName || `${item.id}.png`,
            mimeType: item.mimeType || 'image/png',
            sizeBytes: item.sizeBytes || 0,
            width: item.width || 0,
            height: item.height || 0,
            providerCode: item.providerCode || '',
            modelName: item.modelName || 'auto',
            prompt: item.prompt || '',
            size: item.size || '1024x1536',
            createdAt: item.createdAt || new Date().toISOString(),
          }))
          .slice(0, MAX_HISTORY)
      : []
    if (history.value[0]) selectedId.value = history.value[0].id
  } catch {
    history.value = []
  }
}

function persistHistory() {
  const sanitized = history.value.slice(0, MAX_HISTORY).map((item) => ({ ...item }))
  globalThis.localStorage?.setItem(HISTORY_STORAGE_KEY, JSON.stringify(sanitized))
}

function clearReferencePreviews() {
  for (const item of references.value) globalThis.URL.revokeObjectURL(item.previewUrl)
  references.value = []
}

function clearServerPreviewUrls() {
  for (const url of Object.values(previewUrls.value)) globalThis.URL.revokeObjectURL(url)
  previewUrls.value = {}
}

function triggerReferencePicker() {
  referenceInput.value?.click()
}

async function onReferenceSelected(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  error.value = ''
  for (const file of files) {
    if (references.value.length >= MAX_REFERENCE_FILES) {
      error.value = `每次最多使用 ${MAX_REFERENCE_FILES} 张参考图`
      break
    }
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      error.value = '参考图仅支持 PNG / JPG / WEBP'
      continue
    }
    if (file.size > MAX_REFERENCE_FILE_BYTES) {
      error.value = '单张参考图不能超过 10MB'
      continue
    }
    references.value.push({
      file,
      previewUrl: globalThis.URL.createObjectURL(file),
    })
  }
}

function removeReference(index: number) {
  const [removed] = references.value.splice(index, 1)
  if (removed) globalThis.URL.revokeObjectURL(removed.previewUrl)
}

function candidatePreviewUrl(item: LabHistoryItem) {
  if (!item.id) return ''
  if (item.localAssetId && desktop.available && window.aiDramaDesktop) {
    return window.aiDramaDesktop.assetPreviewUrl(LAB_PROJECT_ID, item.localAssetId)
  }
  if (item.sourceType === 'PLATFORM' && (!desktop.available || item.localCached === false)) {
    return previewUrls.value[item.id] || ''
  }
  if (!desktop.available || !window.aiDramaDesktop) return previewUrls.value[item.id] || ''
  return window.aiDramaDesktop.generatedCandidatePreviewUrl(LAB_PROJECT_ID, item.id)
}

async function ensureItemPreview(item: LabHistoryItem) {
  if (item.localAssetId && desktop.available) return
  if (item.sourceType !== 'PLATFORM' || !item.serverCandidateId) return
  if (previewUrls.value[item.id] || previewLoadingIds.value[item.id]) return
  previewLoadingIds.value = { ...previewLoadingIds.value, [item.id]: true }
  try {
    const blob = await imageGenerationApi.preview(item.serverCandidateId)
    const url = globalThis.URL.createObjectURL(blob)
    const old = previewUrls.value[item.id]
    if (old) globalThis.URL.revokeObjectURL(old)
    previewUrls.value = { ...previewUrls.value, [item.id]: url }
  } catch {
    // 单张预览失败不影响列表和后续生成。
  } finally {
    const next = { ...previewLoadingIds.value }
    delete next[item.id]
    previewLoadingIds.value = next
  }
}

async function refreshQuote() {
  quote.value = null
  quoteError.value = ''
  const model = selectedPlatformModel.value
  if (!model) return
  if (!model.creditPrice) {
    quoteError.value = '该平台模型未配置额度价格'
    return
  }
  quoteLoading.value = true
  try {
    quote.value = await creditApi.quote({
      platformModelId: model.id,
      serviceType: 'IMAGE',
      parameters: quoteParameters(),
      prompt: prompt.value.trim() || undefined,
    })
  } catch (caught) {
    quoteError.value = messageFor(caught, '额度报价读取失败')
  } finally {
    quoteLoading.value = false
  }
}

async function ensureQuote() {
  await refreshQuote()
  if (quoteError.value) throw new Error(quoteError.value)
  if (!quote.value) throw new Error('额度报价不可用')
  if (credits.wallet && credits.wallet.availablePoints < quote.value.estimatedPoints) {
    throw new Error(
      `额度不足：预计 ${quote.value.estimatedPoints} 点，可用 ${credits.wallet.availablePoints} 点`,
    )
  }
  return quote.value
}

function quoteParameters() {
  return {
    size: size.value,
    n: 1,
  }
}

async function generateImage() {
  if (!canGenerate.value) return
  if (selectedPlatformModel.value) {
    await generatePlatformImage(selectedPlatformModel.value)
    return
  }
  if (selectedConnection.value) {
    await generateLocalImage()
  }
}

async function generateLocalImage() {
  if (!selectedConnection.value) return
  generating.value = true
  activeJob.value = null
  error.value = ''
  notice.value = ''
  try {
    await ensureLabWorkspace()
    const bridge = window.aiDramaDesktop
    if (!bridge) throw new Error('当前不是 Windows 桌面客户端')
    const result = await bridge.generateLocalImage({
      projectId: LAB_PROJECT_ID,
      connectionId: selectedConnection.value.id,
      prompt: prompt.value.trim(),
      size: size.value,
      referenceImages: await referenceImagesForLocal(),
    })
    const item = toLocalHistoryItem(result)
    try {
      const asset = await saveLabImageToLocal(result.id)
      item.localAssetId = asset.id
      notice.value = '图片已生成并自动保存到本地项目目录'
    } catch (caught) {
      item.localSaveFailed = true
      notice.value = `图片已生成，但自动保存到本地失败：${messageFor(caught, '可稍后重试')}`
    }
    upsertHistory(item)
    selectedId.value = item.id
    composerExpanded.value = false
  } catch (caught) {
    error.value = messageFor(caught, '图片生成失败')
  } finally {
    generating.value = false
  }
}

async function generatePlatformImage(model: PlatformModelCatalogItem) {
  generating.value = true
  activeJob.value = null
  error.value = ''
  notice.value = ''
  try {
    const currentQuote = await ensureQuote()
    const uploaded =
      references.value.length > 0
        ? await imageGenerationApi.uploadReferences(references.value.map((item) => item.file))
        : []
    const job = await imageLabApi.create(
      {
        prompt: prompt.value.trim(),
        size: size.value,
        platformModelId: model.id,
        parameters: {
          ...quoteParameters(),
          ...(uploaded.length ? { reference_image_ids: uploaded.map((item) => item.id) } : {}),
        },
      },
      createIdempotencyKey(),
    )
    activeJob.value = job
    notice.value = '平台图片生成中，可切换页面，完成后会自动显示'
    const finalJob = await pollPlatformJob(job.id)
    if (finalJob.status !== 'SUCCEEDED') {
      throw new Error(finalJob.errorMessage || '平台图片生成未成功')
    }
    const candidates = await imageLabApi.candidates()
    const candidate = candidates.find((item) => item.jobId === job.id)
    if (!candidate) throw new Error('平台已完成任务，但未返回图片候选')
    const item = await toPlatformHistoryItem(candidate)
    upsertHistory(item)
    selectedId.value = item.id
    await credits.load(true)
    notice.value = item.localCached
      ? `图片已生成并自动保存到本地缓存，预计消耗 ${currentQuote.estimatedPoints} 点`
      : `图片已生成，预计消耗 ${currentQuote.estimatedPoints} 点`
    composerExpanded.value = false
    if (item.sourceType === 'PLATFORM' && item.localCached === false) void ensureItemPreview(item)
  } catch (caught) {
    error.value = messageFor(caught, '图片生成失败')
  } finally {
    activeJob.value = null
    generating.value = false
  }
}

async function pollPlatformJob(jobId: string) {
  for (let attempt = 0; attempt < PLATFORM_POLL_ATTEMPTS; attempt += 1) {
    const job = await imageLabApi.get(jobId)
    activeJob.value = job
    if (['SUCCEEDED', 'FAILED', 'CANCELED'].includes(job.status)) return job
    await delay(PLATFORM_POLL_INTERVAL_MS)
  }
  throw new Error('平台图片生成超时，请稍后到生图记录查看')
}

async function referenceImagesForLocal() {
  return Promise.all(
    references.value.map(async (item) => ({
      name: item.file.name,
      mimeType: item.file.type as 'image/png' | 'image/jpeg' | 'image/webp',
      bytes: await item.file.arrayBuffer(),
    })),
  )
}

function toLocalHistoryItem(result: LocalImageGenerationResult): LabHistoryItem {
  return {
    id: result.id,
    sourceType: 'LOCAL',
    projectId: result.projectId,
    originalName: result.originalName,
    mimeType: result.mimeType,
    sizeBytes: result.sizeBytes,
    width: result.width,
    height: result.height,
    providerCode: result.providerCode,
    modelName: result.modelName,
    prompt: prompt.value.trim(),
    size: size.value,
    createdAt: result.createdAt,
    revisedPrompt: result.revisedPrompt,
    localCached: true,
  }
}

async function toPlatformHistoryItem(candidate: ImageCandidate): Promise<LabHistoryItem> {
  let cached: CachedPlatformImageResult | null = null
  let localAssetId = ''
  let localSaveFailed = false
  if (candidate.status === 'LOCAL_SAVED' && candidate.localAssetId) {
    return {
      id: candidate.id,
      sourceType: 'PLATFORM',
      projectId: LAB_PROJECT_ID,
      originalName: `platform-${candidate.id.slice(0, 8)}.png`,
      mimeType: candidate.mimeType || 'image/png',
      sizeBytes: candidate.sizeBytes || 0,
      width: candidate.width || 0,
      height: candidate.height || 0,
      providerCode: candidate.providerCode,
      modelName: candidate.modelName,
      prompt: candidate.prompt,
      negativePrompt: candidate.negativePrompt,
      size: sizeFromCandidate(candidate) || size.value,
      createdAt: candidate.createdAt,
      revisedPrompt: candidate.revisedPrompt,
      serverCandidateId: candidate.id,
      serverVersion: candidate.version,
      localCached: true,
      localAssetId: candidate.localAssetId,
    }
  }
  if (desktop.available && window.aiDramaDesktop && imageGenerationApi.accessToken()) {
    try {
      const saved = await savePlatformCandidate(candidate)
      cached = saved.cached
      localAssetId = saved.asset.id
    } catch {
      localSaveFailed = true
      cached = null
    }
  }
  return {
    id: candidate.id,
    sourceType: 'PLATFORM',
    projectId: LAB_PROJECT_ID,
    originalName: cached?.originalName || `platform-${candidate.id.slice(0, 8)}.png`,
    mimeType: cached?.mimeType || candidate.mimeType || 'image/png',
    sizeBytes: cached?.sizeBytes || candidate.sizeBytes || 0,
    width: cached?.width || candidate.width || 0,
    height: cached?.height || candidate.height || 0,
    providerCode: candidate.providerCode,
    modelName: candidate.modelName,
    prompt: candidate.prompt,
    negativePrompt: candidate.negativePrompt,
    size: sizeFromCandidate(candidate) || size.value,
    createdAt: candidate.createdAt,
    revisedPrompt: candidate.revisedPrompt,
    serverCandidateId: candidate.id,
    serverVersion: candidate.version,
    localCached: Boolean(cached),
    localAssetId: localAssetId || undefined,
    localSaveFailed,
  }
}

async function saveLabImageToLocal(candidateId: string) {
  await ensureLabWorkspace()
  if (!desktop.available) throw new Error('当前不是 Windows 桌面客户端')
  return desktop.saveGeneratedImage({
    projectId: LAB_PROJECT_ID,
    projectTitle: LAB_PROJECT_TITLE,
    candidateId,
    deliveryType: 'LOCAL_CACHE',
    clientCandidateId: candidateId,
    category: 'images',
  })
}

async function savePlatformCandidate(candidate: ImageCandidate) {
  const token = imageGenerationApi.accessToken()
  if (!token) throw new Error('登录状态已失效，无法自动保存平台图片')
  const selected =
    candidate.status === 'AVAILABLE'
      ? await imageGenerationApi.select(candidate.id, candidate.version)
      : candidate
  const cached = await window.aiDramaDesktop!.cachePlatformImage({
    projectId: LAB_PROJECT_ID,
    candidateId: selected.id,
    accessToken: token,
  })
  const asset = await saveLabImageToLocal(selected.id)
  const serverProjectId = selected.projectId?.trim()
  if (!serverProjectId) throw new Error('平台候选缺少所属项目，无法同步本地素材')
  const mappings = await workspace.synchronizeLocalAssets(serverProjectId, [asset])
  const canonicalId = mappings.find((item) => item.clientAssetId === asset.id)?.assetId ?? asset.id
  const changedMappings = mappings.filter((item) => item.clientAssetId !== item.assetId)
  if (changedMappings.length) {
    await window.aiDramaDesktop!.reconcileAssetIds(LAB_PROJECT_ID, changedMappings)
  }
  await imageGenerationApi.confirmSaved(selected.id, canonicalId, selected.version)
  return { cached, asset: { ...asset, id: canonicalId } }
}

async function restorePlatformCandidates() {
  if (!platformModels.value.length) return
  try {
    const candidates = await imageLabApi.candidates()
    const known = new Set(history.value.map((item) => item.serverCandidateId || item.id))
    const restored: LabHistoryItem[] = []
    for (const candidate of candidates.slice(0, MAX_HISTORY)) {
      if (known.has(candidate.id)) continue
      restored.push(await toPlatformHistoryItem(candidate))
    }
    if (restored.length) {
      history.value = [...restored, ...history.value].slice(0, MAX_HISTORY)
      if (!selectedId.value && history.value[0]) selectedId.value = history.value[0].id
      persistHistory()
    }
    for (const item of history.value.slice(0, 12)) {
      if (item.sourceType === 'PLATFORM' && (!desktop.available || item.localCached === false)) {
        void ensureItemPreview(item)
      }
    }
  } catch {
    // 历史恢复失败不阻断本次生图；生成时仍会重新读取候选。
  }
}

function upsertHistory(item: LabHistoryItem) {
  history.value = [item, ...history.value.filter((entry) => entry.id !== item.id)].slice(
    0,
    MAX_HISTORY,
  )
  persistHistory()
}

function selectHistory(item: LabHistoryItem) {
  selectedId.value = item.id
  prompt.value = item.prompt
  size.value = item.size
  notice.value = ''
  error.value = ''
  if (item.sourceType === 'PLATFORM') void ensureItemPreview(item)
}

function openPreview(item: LabHistoryItem) {
  selectedId.value = item.id
  previewItem.value = item
  if (item.sourceType === 'PLATFORM') void ensureItemPreview(item)
}

function closePreview() {
  previewItem.value = null
}

async function reusePrompt(item: LabHistoryItem) {
  prompt.value = item.prompt
  size.value = item.size
  selectedId.value = item.id
  composerExpanded.value = true
  notice.value = '已填入该提示词，可直接再次生成'
}

async function editFromHistory(item: LabHistoryItem) {
  if (generating.value) return
  if (references.value.length >= MAX_REFERENCE_FILES) {
    error.value = `每次最多使用 ${MAX_REFERENCE_FILES} 张参考图`
    return
  }
  error.value = ''
  notice.value = ''
  try {
    const blob = await imageBlobForItem(item)
    const file = new File([blob], item.originalName || `reference-${item.id.slice(0, 8)}.png`, {
      type: blob.type || item.mimeType || 'image/png',
    })
    references.value.push({
      file,
      previewUrl: globalThis.URL.createObjectURL(file),
    })
    prompt.value = item.prompt
    size.value = item.size
    selectedId.value = item.id
    composerExpanded.value = true
    closePreview()
    notice.value = '已把这张图加入参考图，可修改提示词后再次生成'
  } catch (caught) {
    error.value = messageFor(caught, '加入参考图失败')
  }
}

async function downloadItem(item: LabHistoryItem) {
  try {
    const blob = await imageBlobForItem(item)
    const objectUrl = globalThis.URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = objectUrl
    anchor.download = item.originalName || `ai-image-${item.id.slice(0, 8)}.png`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    globalThis.setTimeout(() => globalThis.URL.revokeObjectURL(objectUrl), 1_000)
    notice.value = '已开始下载'
  } catch (caught) {
    error.value = messageFor(caught, '下载失败')
  }
}

async function retrySaveItem(item: LabHistoryItem) {
  if (!desktop.available || !item.localSaveFailed) return
  error.value = ''
  try {
    if (item.sourceType === 'PLATFORM' && item.serverCandidateId) {
      const candidate = (await imageLabApi.candidates()).find(
        (entry) => entry.id === item.serverCandidateId,
      )
      if (!candidate) throw new Error('平台图片候选已不存在，请重新生成')
      const saved = await savePlatformCandidate(candidate)
      item.localCached = true
      item.localAssetId = saved.asset.id
    } else {
      const asset = await saveLabImageToLocal(item.id)
      item.localAssetId = asset.id
    }
    item.localSaveFailed = false
    upsertHistory(item)
    notice.value = '图片已重试保存到本地项目目录'
  } catch (caught) {
    error.value = messageFor(caught, '图片重试保存失败')
  }
}

async function imageBlobForItem(item: LabHistoryItem) {
  if (item.localAssetId && desktop.available && window.aiDramaDesktop) {
    const localUrl = window.aiDramaDesktop.assetPreviewUrl(LAB_PROJECT_ID, item.localAssetId)
    const response = await fetch(localUrl)
    if (response.ok) return response.blob()
  }
  if (item.sourceType === 'PLATFORM' && item.serverCandidateId) {
    return imageGenerationApi.preview(item.serverCandidateId)
  }
  const url = candidatePreviewUrl(item)
  if (!url) throw new Error('预览地址不可用，无法下载')
  const response = await fetch(url)
  if (!response.ok) throw new Error(`读取图片失败（HTTP ${response.status}）`)
  return response.blob()
}

async function discardItem(item: LabHistoryItem) {
  if (!globalThis.confirm('确定删除这张生图记录吗？')) return
  error.value = ''
  notice.value = ''
  try {
    if (item.sourceType === 'PLATFORM' && item.serverCandidateId && item.serverVersion != null) {
      await imageGenerationApi.delete(item.serverCandidateId, item.serverVersion)
    }
    const bridge = window.aiDramaDesktop
    if (bridge && (item.localCached || item.sourceType === 'LOCAL')) {
      try {
        await bridge.discardGeneratedImage(LAB_PROJECT_ID, item.id)
      } catch {
        // History can outlive cache files; still remove the list entry.
      }
    }
    const preview = previewUrls.value[item.id]
    if (preview) {
      globalThis.URL.revokeObjectURL(preview)
      const next = { ...previewUrls.value }
      delete next[item.id]
      previewUrls.value = next
    }
    history.value = history.value.filter((entry) => entry.id !== item.id)
    persistHistory()
    if (selectedId.value === item.id) selectedId.value = history.value[0]?.id || ''
    notice.value = '已从生图记录中移除'
  } catch (caught) {
    error.value = messageFor(caught, '删除失败')
  }
}

function onComposerKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    void generateImage()
  }
}

function relativeTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const diff = Date.now() - date.getTime()
  const sec = Math.max(0, Math.floor(diff / 1000))
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour}h`
  return date.toLocaleDateString('zh-CN')
}

function sizeLabel(item: LabHistoryItem) {
  if (item.width > 0 && item.height > 0) return `${item.width}×${item.height}`
  return item.size || 'auto'
}

function sizeFromCandidate(candidate: ImageCandidate): ImageSize | null {
  if (!candidate.width || !candidate.height) return null
  const value = `${candidate.width}x${candidate.height}`
  return IMAGE_SIZE_OPTIONS.some((option) => option.value === value) ? (value as ImageSize) : null
}

function sourceLabel(item: LabHistoryItem) {
  return item.sourceType === 'PLATFORM' ? '平台' : '我的 API'
}

function statusLabel(status: string) {
  return (
    {
      WAITING_LOCAL: '等待本地执行',
      QUEUED: '排队中',
      RUNNING: '执行中',
      SUCCEEDED: '已完成',
      FAILED: '失败',
      CANCELED: '已取消',
    }[status] || status
  )
}

function modelLabel(model: PlatformModelCatalogItem) {
  return platformModelOptionLabel(model)
}

function createIdempotencyKey() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function delay(ms: number) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms))
}

function messageFor(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}
</script>

<template>
  <StudioShell>
    <section class="image-lab-page">
      <header class="image-lab-toolbar">
        <div class="image-lab-toolbar-left">
          <span class="image-lab-chip active">
            <ImagePlus :size="15" />
            图像生成
          </span>
          <button
            class="image-lab-icon-btn"
            type="button"
            title="刷新模型"
            :disabled="initializing"
            @click="bootstrap"
          >
            <RefreshCw :size="15" :class="{ spinning: initializing }" />
          </button>
        </div>
        <div class="image-lab-toolbar-right">
          <label class="image-lab-search">
            <input v-model="query" type="search" placeholder="搜索提示词、参数..." />
          </label>
        </div>
      </header>

      <p v-if="notice" class="inline-success image-lab-banner" role="status">{{ notice }}</p>
      <p v-if="error" class="inline-error image-lab-banner" role="alert">{{ error }}</p>
      <div v-if="generating" class="image-lab-running-banner" role="status">
        <LoaderCircle :size="20" class="spinning" />
        <div>
          <strong>图片正在生成中</strong>
          <span>{{ runningStatusText }} · 切换页面不会中断，完成后回到生图会自动显示。</span>
        </div>
        <RouterLink to="/tasks">查看生成任务</RouterLink>
      </div>

      <div class="image-lab-board">
        <div v-if="initializing" class="image-lab-empty-state">
          <LoaderCircle :size="22" class="spinning" />
          <strong>正在初始化生图工作区</strong>
        </div>

        <div v-else-if="!filteredHistory.length && !generating" class="image-lab-empty-state">
          <ImagePlus :size="28" />
          <strong>{{ history.length ? '没有匹配结果' : '还没有生成记录' }}</strong>
          <p>在底部输入提示词，可选上传参考图，生成后会以卡片展示。</p>
        </div>

        <div v-else class="image-lab-grid">
          <article
            v-for="item in filteredHistory"
            :key="item.id"
            class="image-lab-card"
            :class="{ active: item.id === selectedId }"
            @click="selectHistory(item)"
          >
            <div class="image-lab-card-media" title="点击预览大图" @click.stop="openPreview(item)">
              <img
                v-if="candidatePreviewUrl(item)"
                :src="candidatePreviewUrl(item)"
                :alt="item.prompt"
                loading="lazy"
                @error="ensureItemPreview(item)"
              />
              <div v-else class="image-lab-card-media pending">
                <LoaderCircle v-if="previewLoadingIds[item.id]" :size="18" class="spinning" />
                <ImagePlus v-else :size="22" />
                <span>{{ previewLoadingIds[item.id] ? '读取预览中' : '预览待加载' }}</span>
              </div>
              <span class="image-lab-card-time">{{ relativeTime(item.createdAt) }}</span>
            </div>
            <div class="image-lab-card-body">
              <p class="image-lab-card-prompt" :title="item.prompt">{{ item.prompt }}</p>
              <div class="image-lab-card-tags">
                <span
                  :class="item.sourceType === 'PLATFORM' ? 'source-platform' : 'source-local'"
                  >{{ sourceLabel(item) }}</span
                >
                <span>{{ item.modelName || 'auto' }}</span>
                <span>{{ sizeLabel(item) }}</span>
              </div>
              <div class="image-lab-card-actions">
                <button
                  v-if="item.localSaveFailed"
                  type="button"
                  title="重试保存到本地"
                  @click.stop="retrySaveItem(item)"
                >
                  <RefreshCw :size="14" />
                </button>
                <button type="button" title="再次使用提示词" @click.stop="reusePrompt(item)">
                  <RefreshCw :size="14" />
                </button>
                <button type="button" title="基于此图编辑" @click.stop="editFromHistory(item)">
                  <Sparkles :size="14" />
                </button>
                <button type="button" title="下载" @click.stop="downloadItem(item)">
                  <Download :size="14" />
                </button>
                <button type="button" class="danger" title="删除" @click.stop="discardItem(item)">
                  <Trash2 :size="14" />
                </button>
              </div>
            </div>
          </article>

          <article v-if="generating" class="image-lab-card image-lab-card-pending">
            <div class="image-lab-card-media pending">
              <LoaderCircle :size="22" class="spinning" />
              <span>图片生成中</span>
            </div>
            <div class="image-lab-card-body">
              <p class="image-lab-card-prompt">{{ prompt.trim() || '正在生成...' }}</p>
              <div class="image-lab-card-tags">
                <span>{{ usingPlatformModel ? '平台' : '我的 API' }}</span>
                <span>{{ selectedModelName }}</span>
                <span>{{ size }}</span>
              </div>
              <div class="image-lab-pending-progress">
                <progress :value="runningProgress" max="100" />
                <span>{{ runningProgress }}%</span>
              </div>
              <small class="image-lab-pending-tip">{{ runningStatusText }}，可先去其他页面。</small>
            </div>
          </article>
        </div>
      </div>

      <footer
        class="image-lab-composer"
        :class="{ expanded: composerExpanded || references.length }"
      >
        <div class="image-lab-composer-options">
          <label>
            <span>模型</span>
            <select
              v-model="selectedModelKey"
              class="image-lab-select"
              :disabled="
                generating || initializing || (!platformModels.length && !imageConnections.length)
              "
            >
              <option disabled value="">{{ modelSelectLabel }}</option>
              <optgroup v-if="platformModels.length" label="平台模型">
                <option
                  v-for="item in platformModels"
                  :key="item.id"
                  :value="`platform:${item.id}`"
                  :disabled="!item.creditPrice"
                >
                  {{ modelLabel(item) }}
                </option>
              </optgroup>
              <optgroup v-if="imageConnections.length" label="我的 API">
                <option
                  v-for="item in imageConnections"
                  :key="item.id"
                  :value="`local:${item.id}`"
                  :disabled="!desktop.available"
                >
                  {{ item.displayName || item.modelName }} · {{ item.providerCode }}
                </option>
              </optgroup>
            </select>
          </label>
          <label>
            <span>比例</span>
            <select v-model="size" class="image-lab-select compact" :disabled="generating">
              <option
                v-for="option in IMAGE_SIZE_OPTIONS"
                :key="option.value"
                :value="option.value"
              >
                {{ option.label }}
              </option>
            </select>
          </label>
          <span
            v-if="quoteText"
            class="image-lab-credit-line"
            :class="{ danger: platformBalanceInsufficient || quoteError }"
          >
            {{ quoteText }}
          </span>
        </div>

        <div v-if="references.length" class="image-lab-composer-refs">
          <div
            v-for="(item, index) in references"
            :key="item.previewUrl"
            class="image-lab-composer-ref"
          >
            <img :src="item.previewUrl" :alt="item.file.name" />
            <button type="button" title="移除参考图" @click="removeReference(index)">
              <X :size="12" />
            </button>
          </div>
        </div>

        <div class="image-lab-composer-main">
          <textarea
            v-model="prompt"
            rows="1"
            maxlength="20000"
            placeholder="描述你想生成的图片..."
            :disabled="generating || initializing"
            @focus="composerExpanded = true"
            @keydown="onComposerKeydown"
          />
          <div class="image-lab-composer-actions">
            <input
              ref="referenceInput"
              class="avatar-file-input"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              @change="onReferenceSelected"
            />
            <button
              class="image-lab-icon-btn"
              type="button"
              title="上传参考图"
              :disabled="generating"
              @click="triggerReferencePicker"
            >
              <Paperclip :size="16" />
            </button>
            <button
              class="image-lab-generate-btn"
              type="button"
              :disabled="!canGenerate"
              @click="generateImage"
            >
              <LoaderCircle v-if="generating" :size="15" class="spinning" />
              <Sparkles v-else :size="15" />
              {{ generating ? '生成中' : '生成' }}
            </button>
          </div>
        </div>
        <small class="image-lab-composer-tip"
          >Enter 发送 · Shift+Enter 换行 · 参考图最多 {{ MAX_REFERENCE_FILES }} 张</small
        >
      </footer>

      <div
        v-if="previewItem"
        class="modal-backdrop image-lab-preview-backdrop"
        @click.self="closePreview"
      >
        <section class="modal image-lab-preview-modal" role="dialog" aria-modal="true">
          <header>
            <div>
              <h2>图片预览</h2>
              <small>{{ previewItem.modelName }} · {{ sizeLabel(previewItem) }}</small>
            </div>
            <button class="icon-button" type="button" title="关闭" @click="closePreview">
              <X :size="18" />
            </button>
          </header>
          <div class="image-lab-preview-stage">
            <img v-if="previewUrl" :src="previewUrl" :alt="previewItem.prompt" />
            <div v-else class="image-lab-card-media pending">
              <LoaderCircle :size="22" class="spinning" />
              <span>正在读取预览</span>
            </div>
          </div>
          <footer>
            <p>{{ previewItem.prompt }}</p>
            <div>
              <button
                v-if="previewItem.localSaveFailed"
                class="button"
                type="button"
                @click="retrySaveItem(previewItem)"
              >
                <RefreshCw :size="15" />重试保存
              </button>
              <button class="button" type="button" @click="editFromHistory(previewItem)">
                <Sparkles :size="15" />基于此图编辑
              </button>
              <button class="button primary" type="button" @click="downloadItem(previewItem)">
                <Download :size="15" />下载
              </button>
            </div>
          </footer>
        </section>
      </div>
    </section>
  </StudioShell>
</template>
