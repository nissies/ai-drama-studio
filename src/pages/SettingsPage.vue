<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import {
  CheckCircle2,
  ChevronRight,
  Clapperboard,
  Cloud,
  Download,
  Cpu,
  Eye,
  EyeOff,
  FolderOpen,
  HardDrive,
  KeyRound,
  Laptop,
  LockKeyhole,
  Pencil,
  Package,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  TriangleAlert,
  Wifi,
  X,
} from 'lucide-vue-next'
import { platformModelCatalogApi, type PlatformModelCatalogItem } from '../api/model-catalog'
import type {
  AiServiceType,
  LocalAiConnection,
  LocalAiConnectionInput,
  LocalAiConnectivityResult,
  DesktopUpdateCheckResult,
  DesktopUpdateProgress,
  DesktopRuntimeAssetProgress,
  DesktopRuntimeAssetStatus,
} from '../desktop/types'
import StudioShell from '../layouts/StudioShell.vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { useDesktopStore } from '../stores/desktop'

type AiSourceView = 'LOCAL' | 'PLATFORM'

const desktop = useDesktopStore()
const auth = useAuthStore()
const router = useRouter()
const activeSource = ref<AiSourceView>('LOCAL')
const activeServiceType = ref<AiServiceType>('IMAGE')
const platformModels = ref<PlatformModelCatalogItem[]>([])
const platformLoading = ref(false)
const platformError = ref('')
const localError = ref('')
const localNotice = ref('')
const showEditor = ref(false)
const showApiKey = ref(false)
const apiKeyTouched = ref(false)
const editingId = ref('')
const testingId = ref('')
const testResults = reactive<Record<string, LocalAiConnectivityResult>>({})
const formSnapshot = ref('')
const discoveredModels = ref<string[]>([])
const discoveringModels = ref(false)
const discoveryNotice = ref('')
const selectedProviderPreset = ref('AUTO')

const defaultEndpointPaths: Record<AiServiceType, string> = {
  TEXT: '/v1/chat/completions',
  IMAGE: '/v1/images/generations',
  VIDEO: '/v1/videos',
  TTS: '/v1/audio/speech',
}
const form = reactive<LocalAiConnectionInput>(emptyForm('IMAGE'))

const serviceTypes: Array<{ value: AiServiceType; label: string }> = [
  { value: 'TEXT', label: '文本模型' },
  { value: 'IMAGE', label: '图片模型' },
  { value: 'VIDEO', label: '视频模型' },
  { value: 'TTS', label: '配音模型' },
]

type ProviderPreset = {
  code: string
  label: string
  baseUrl: string
  services: AiServiceType[]
  endpointPaths: Partial<Record<AiServiceType, string>>
}

const providerPresets: ProviderPreset[] = [
  {
    code: 'XAI',
    label: 'Grok 官方（xAI）',
    baseUrl: 'https://api.x.ai',
    services: ['TEXT', 'IMAGE', 'VIDEO'],
    endpointPaths: {
      TEXT: '/v1/chat/completions',
      IMAGE: '/v1/images/generations',
      VIDEO: '/v1/videos/generations',
    },
  },
  {
    code: 'OLLAMA',
    label: 'Ollama（本机）',
    baseUrl: 'http://127.0.0.1:11434',
    services: ['TEXT'],
    endpointPaths: { TEXT: '/api/chat' },
  },
  {
    code: 'VOLCENGINE',
    label: '火山方舟',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    services: ['TEXT', 'IMAGE', 'VIDEO', 'TTS'],
    endpointPaths: {
      TEXT: '/chat/completions',
      IMAGE: '/images/generations',
      VIDEO: '/contents/generations/tasks',
      TTS: '/audio/speech',
    },
  },
  {
    code: 'DASHSCOPE',
    label: '阿里云百炼',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    services: ['TEXT', 'IMAGE', 'VIDEO', 'TTS'],
    endpointPaths: relativeOpenAiEndpointPaths(),
  },
  {
    code: 'DEEPSEEK',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    services: ['TEXT'],
    endpointPaths: { TEXT: '/chat/completions' },
  },
  {
    code: 'ZHIPU',
    label: '智谱 BigModel',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    services: ['TEXT', 'IMAGE', 'VIDEO'],
    endpointPaths: relativeOpenAiEndpointPaths(),
  },
  {
    code: 'MOONSHOT',
    label: 'Moonshot Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    services: ['TEXT'],
    endpointPaths: { TEXT: '/chat/completions' },
  },
  {
    code: 'SILICONFLOW',
    label: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    services: ['TEXT', 'IMAGE', 'VIDEO', 'TTS'],
    endpointPaths: relativeOpenAiEndpointPaths(),
  },
  {
    code: 'QIANFAN',
    label: '百度千帆',
    baseUrl: 'https://qianfan.baidubce.com/v2',
    services: ['TEXT', 'IMAGE'],
    endpointPaths: relativeOpenAiEndpointPaths(),
  },
  {
    code: 'HUNYUAN',
    label: '腾讯混元',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    services: ['TEXT', 'IMAGE'],
    endpointPaths: relativeOpenAiEndpointPaths(),
  },
  {
    code: 'OPENAI_COMPATIBLE',
    label: '通用 OpenAI 兼容',
    baseUrl: '',
    services: ['TEXT', 'IMAGE', 'VIDEO', 'TTS'],
    endpointPaths: defaultEndpointPaths,
  },
]

const availableProviderPresets = computed(() =>
  providerPresets.filter((preset) => preset.services.includes(form.serviceType)),
)

function relativeOpenAiEndpointPaths(): Record<AiServiceType, string> {
  return {
    TEXT: '/chat/completions',
    IMAGE: '/images/generations',
    VIDEO: '/videos',
    TTS: '/audio/speech',
  }
}

const filteredLocalConnections = computed(() =>
  desktop.localAiConnections.filter((item) => item.serviceType === activeServiceType.value),
)
const filteredPlatformModels = computed(() =>
  platformModels.value.filter((item) => item.serviceType === activeServiceType.value),
)
const editingConnection = computed(
  () => desktop.localAiConnections.find((item) => item.id === editingId.value) ?? null,
)
const formDirty = computed(
  () => metadataSnapshot(form) !== formSnapshot.value || apiKeyTouched.value,
)
const diskUsage = computed(() => {
  const disk = desktop.workspace?.disk
  if (!disk || disk.totalBytes <= 0) return 0
  return Math.min(100, Math.max(0, ((disk.totalBytes - disk.freeBytes) / disk.totalBytes) * 100))
})
const workspaceDisk = computed(() => desktop.workspace?.disk ?? null)
const ffmpegRuntime = computed(() => desktop.runtime?.ffmpeg ?? null)
const ffmpegRuntimeHint = computed(
  () =>
    ffmpegRuntime.value?.version ||
    (desktop.available ? '请安装 FFmpeg 或使用内置运行库' : '仅 Windows 客户端可调用'),
)
const poseAsset = computed(
  () => desktop.runtime?.optionalAssets?.find((item) => item.id === 'dwpose-model') ?? null,
)
const poseAssetBusy = ref(false)
const poseAssetError = ref('')
const poseAssetNotice = ref('')
const poseAssetProgress = ref<DesktopRuntimeAssetProgress | null>(null)

watch(
  () => form.serviceType,
  (nextServiceType) => {
    const currentPath = form.endpointPath?.trim()
    const knownDefaults = new Set([
      ...Object.values(defaultEndpointPaths),
      ...providerPresets.flatMap((preset) => Object.values(preset.endpointPaths)),
    ])
    const selectedPreset = providerPreset(selectedProviderPreset.value)
    if (selectedPreset && !selectedPreset.services.includes(nextServiceType)) {
      selectedProviderPreset.value = 'AUTO'
    }
    if (!currentPath || knownDefaults.has(currentPath)) {
      form.endpointPath = suggestedEndpointPath(nextServiceType)
    }
    discoveredModels.value = []
    discoveryNotice.value = ''
  },
)

const updateChecking = ref(false)
const updateInstalling = ref(false)
const updateError = ref('')
const updateNotice = ref('')
const updateCheck = ref<DesktopUpdateCheckResult | null>(null)
const updateProgress = ref<DesktopUpdateProgress | null>(null)
let stopUpdateProgress: (() => void) | null = null
let stopRuntimeAssetProgress: (() => void) | null = null
onMounted(async () => {
  await desktop.initialize()
  if (auth.isAuthenticated) await loadPlatformModels()
  if (desktop.available) {
    await desktop.loadLocalAiConnections()
    const bridge = window.aiDramaDesktop
    if (bridge?.onUpdateProgress) {
      stopUpdateProgress = bridge.onUpdateProgress((progress) => {
        updateProgress.value = progress
      })
    }
    if (bridge?.onRuntimeAssetProgress) {
      stopRuntimeAssetProgress = bridge.onRuntimeAssetProgress((progress) => {
        if (progress.id === 'dwpose-model') poseAssetProgress.value = progress
      })
    }
    void checkForAppUpdate(true)
  }
})

onBeforeUnmount(() => {
  stopUpdateProgress?.()
  stopUpdateProgress = null
  stopRuntimeAssetProgress?.()
  stopRuntimeAssetProgress = null
})

function updatePoseAsset(status: DesktopRuntimeAssetStatus) {
  if (!desktop.runtime) return
  desktop.runtime.optionalAssets = [
    ...(desktop.runtime.optionalAssets || []).filter((item) => item.id !== status.id),
    status,
  ]
}

async function installPoseAsset() {
  const bridge = window.aiDramaDesktop
  if (!bridge || poseAssetBusy.value) return
  poseAssetBusy.value = true
  poseAssetError.value = ''
  poseAssetNotice.value = '正在从官方来源下载并校验模型…'
  try {
    updatePoseAsset(await bridge.installOptionalRuntimeAsset('dwpose-model'))
    poseAssetNotice.value = 'DWPose 姿态模型已安装，可以使用动作代理功能'
  } catch (error) {
    poseAssetError.value = error instanceof Error ? error.message : '模型安装失败'
    poseAssetNotice.value = ''
  } finally {
    poseAssetBusy.value = false
    poseAssetProgress.value = null
  }
}

async function cancelPoseAssetInstall() {
  const canceled = await window.aiDramaDesktop?.cancelOptionalRuntimeAsset('dwpose-model')
  if (canceled) poseAssetNotice.value = '正在取消下载…'
}

async function removePoseAsset() {
  const bridge = window.aiDramaDesktop
  if (!bridge || poseAssetBusy.value) return
  if (!window.confirm('删除 DWPose 姿态模型？普通图片、视频生成和本地项目不会受影响。')) return
  poseAssetBusy.value = true
  poseAssetError.value = ''
  try {
    updatePoseAsset(await bridge.removeOptionalRuntimeAsset('dwpose-model'))
    poseAssetNotice.value = '姿态模型已删除'
  } catch (error) {
    poseAssetError.value = error instanceof Error ? error.message : '模型删除失败'
  } finally {
    poseAssetBusy.value = false
  }
}

async function checkForAppUpdate(silent = false) {
  if (!desktop.available || updateChecking.value || updateInstalling.value) return
  updateChecking.value = true
  if (!silent) {
    updateError.value = ''
    updateNotice.value = ''
  }
  try {
    const bridge = window.aiDramaDesktop
    if (!bridge?.checkForUpdate) throw new Error('当前客户端不支持自动更新')
    updateCheck.value = await bridge.checkForUpdate({
      currentVersion: desktop.runtime?.appVersion,
      channel: 'STABLE',
      platform: 'WIN_X64',
    })
    if (!silent) {
      updateNotice.value = updateCheck.value.updateAvailable
        ? `发现新版本 ${updateCheck.value.latest?.versionName}`
        : '当前已是最新版本'
    }
  } catch (error) {
    if (!silent) updateError.value = error instanceof Error ? error.message : '检查更新失败'
  } finally {
    updateChecking.value = false
  }
}

async function installAppUpdate() {
  const latest = updateCheck.value?.latest
  if (!latest || !desktop.available || updateInstalling.value) return
  if (
    !window.confirm(
      `即将下载并安装 ${latest.versionName}。\n安装程序启动后客户端会自动退出，本地项目与 API 配置会保留。是否继续？`,
    )
  ) {
    return
  }
  updateInstalling.value = true
  updateError.value = ''
  updateNotice.value = '正在下载安装包...'
  updateProgress.value = {
    stage: 'DOWNLOADING',
    progress: 0,
    receivedBytes: 0,
    totalBytes: latest.sizeBytes,
  }
  try {
    const bridge = window.aiDramaDesktop
    if (!bridge?.downloadAndInstallUpdate) throw new Error('当前客户端不支持自动更新')
    await bridge.downloadAndInstallUpdate({
      releaseId: latest.id,
      sha256: latest.sha256,
      sizeBytes: latest.sizeBytes,
      fileName: latest.fileName,
    })
    updateNotice.value = '安装程序已启动，客户端即将退出'
  } catch (error) {
    updateError.value = error instanceof Error ? error.message : '更新安装失败'
    updateNotice.value = ''
    updateProgress.value = null
  } finally {
    updateInstalling.value = false
  }
}

async function cancelAppUpdate() {
  if (!updateInstalling.value || updateProgress.value?.stage !== 'DOWNLOADING') return
  try {
    const bridge = window.aiDramaDesktop
    if (!bridge?.cancelUpdateDownload) throw new Error('当前客户端不支持取消更新')
    const canceled = await bridge.cancelUpdateDownload()
    if (canceled) updateNotice.value = '正在取消更新下载...'
  } catch (error) {
    updateError.value = error instanceof Error ? error.message : '取消更新失败'
  }
}

function formatUpdateBytes(value?: number | null) {
  if (!value || value <= 0) return '--'
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function emptyForm(serviceType: AiServiceType): LocalAiConnectionInput {
  return {
    serviceType,
    providerCode: '',
    displayName: '',
    baseUrl: '',
    endpointPath: defaultEndpointPaths[serviceType],
    modelName: '',
    apiKey: '',
    clearApiKey: false,
    enabled: true,
    defaultProvider: false,
  }
}

async function loadPlatformModels() {
  if (!auth.isAuthenticated) {
    platformModels.value = []
    platformError.value = ''
    return
  }
  platformLoading.value = true
  platformError.value = ''
  try {
    platformModels.value = await platformModelCatalogApi.list()
  } catch (error) {
    platformError.value = messageFor(error, '平台模型目录加载失败')
  } finally {
    platformLoading.value = false
  }
}

function openPlatformModels() {
  if (auth.isAuthenticated) {
    activeSource.value = 'PLATFORM'
    void loadPlatformModels()
    return
  }
  void router.push({
    name: 'login',
    query: { redirect: '/settings', reason: 'cloud-service' },
  })
}

function openCreate() {
  editingId.value = ''
  Object.assign(form, emptyForm(activeServiceType.value))
  rememberForm()
  localError.value = ''
  localNotice.value = ''
  showApiKey.value = false
  apiKeyTouched.value = false
  discoveredModels.value = []
  discoveryNotice.value = ''
  selectedProviderPreset.value = 'AUTO'
  showEditor.value = true
}

function openEdit(connection: LocalAiConnection) {
  editingId.value = connection.id
  activeServiceType.value = connection.serviceType
  Object.assign(form, {
    id: connection.id,
    serviceType: connection.serviceType,
    providerCode: connection.providerCode,
    displayName: connection.displayName,
    baseUrl: connection.baseUrl,
    endpointPath: connection.endpointPath ?? '',
    modelName: connection.modelName,
    apiKey: '',
    clearApiKey: false,
    enabled: connection.enabled,
    defaultProvider: connection.defaultProvider,
    version: connection.version,
  })
  rememberForm()
  localError.value = ''
  localNotice.value = ''
  showApiKey.value = false
  apiKeyTouched.value = false
  discoveredModels.value = [connection.modelName]
  discoveryNotice.value = ''
  selectedProviderPreset.value = providerPreset(connection.providerCode)?.code || 'AUTO'
  showEditor.value = true
}

function applyProviderPreset() {
  const preset = providerPreset(selectedProviderPreset.value)
  if (!preset) return
  form.providerCode = preset.code
  if (preset.baseUrl) form.baseUrl = preset.baseUrl
  form.endpointPath =
    preset.endpointPaths[form.serviceType] || defaultEndpointPaths[form.serviceType]
  discoveredModels.value = []
  discoveryNotice.value = ''
}

async function discoverModels() {
  localError.value = ''
  localNotice.value = ''
  discoveryNotice.value = ''
  if (!form.baseUrl.trim()) {
    localError.value = '请先填写基础地址'
    return
  }
  discoveringModels.value = true
  try {
    const result = await desktop.discoverLocalAiModels({
      id: editingId.value || undefined,
      serviceType: form.serviceType,
      providerCode: form.providerCode.trim() || undefined,
      baseUrl: form.baseUrl.trim(),
      endpointPath: form.endpointPath?.trim() || undefined,
      apiKey: form.apiKey?.trim() || undefined,
    })
    form.providerCode = form.providerCode.trim() || result.providerCode
    selectedProviderPreset.value = providerPreset(result.providerCode)?.code || 'AUTO'
    const currentPath = form.endpointPath?.trim()
    form.endpointPath =
      !currentPath || currentPath === defaultEndpointPaths[form.serviceType]
        ? result.endpointPath
        : currentPath
    discoveredModels.value = result.models
    if (!result.models.includes(form.modelName.trim())) form.modelName = result.models[0] || ''
    if (!form.displayName.trim()) {
      const modelLabel = form.modelName.trim() || `${serviceTypeLabel(form.serviceType)}配置`
      form.displayName = `${form.providerCode.trim() || '本地'} · ${modelLabel}`
    }
    discoveryNotice.value = `已获取 ${result.models.length} 个模型，当前选中“${form.modelName || '未选择'}”。请点击“保存”，保存后才会在生成页面出现。`
  } catch (error) {
    localError.value = messageFor(error, '模型列表获取失败')
  } finally {
    discoveringModels.value = false
  }
}

function applyConnectionDefaults() {
  const inferredProvider = inferProviderCode(form.baseUrl, form.endpointPath)
  const configuredProvider = form.providerCode.trim().toUpperCase() || inferredProvider
  if (!form.providerCode.trim() && form.baseUrl.trim()) form.providerCode = configuredProvider
  selectedProviderPreset.value = providerPreset(configuredProvider)?.code || 'AUTO'
  const currentPath = form.endpointPath?.trim()
  if (
    !currentPath ||
    (configuredProvider !== 'OPENAI_COMPATIBLE' &&
      currentPath === defaultEndpointPaths[form.serviceType])
  ) {
    form.endpointPath = suggestedEndpointPath(form.serviceType)
  }
}

function suggestedEndpointPath(serviceType: AiServiceType) {
  const preset = providerPreset(
    selectedProviderPreset.value !== 'AUTO'
      ? selectedProviderPreset.value
      : inferProviderCode(form.baseUrl, form.endpointPath),
  )
  if (preset?.endpointPaths[serviceType]) return preset.endpointPaths[serviceType]
  return defaultEndpointPaths[serviceType]
}

function inferProviderCode(baseUrl: string, endpointPath?: string | null) {
  const normalizedUrl = baseUrl.trim().toLowerCase()
  const normalizedPath = String(endpointPath || '')
    .trim()
    .toLowerCase()
  if (normalizedUrl.includes(':11434') || normalizedPath.startsWith('/api/chat')) return 'OLLAMA'
  const matched = providerPresets.find(
    (preset) => preset.baseUrl && normalizedUrl.includes(new URL(preset.baseUrl).hostname),
  )
  if (matched) return matched.code
  if (normalizedPath.startsWith('/api/v3/')) return 'VOLCENGINE'
  return 'OPENAI_COMPATIBLE'
}

function providerPreset(code: string) {
  return providerPresets.find((preset) => preset.code === code) || null
}

async function saveConnection() {
  localError.value = ''
  localNotice.value = ''
  try {
    const saved = await desktop.saveLocalAiConnection({ ...form })
    form.apiKey = ''
    showApiKey.value = false
    apiKeyTouched.value = false
    if (saved) {
      showEditor.value = false
      localNotice.value = `“${saved.displayName}”已保存，可在${serviceTypeLabel(saved.serviceType)}生成入口中使用。`
    }
  } catch (error) {
    form.apiKey = ''
    showApiKey.value = false
    apiKeyTouched.value = false
    localError.value = messageFor(error, '本地 AI 配置保存失败')
  }
}

async function deleteConnection(connection: LocalAiConnection) {
  if (!globalThis.confirm(`确定删除“${connection.displayName}”吗？`)) return
  localError.value = ''
  try {
    await desktop.deleteLocalAiConnection(connection.id, connection.version)
    delete testResults[connection.id]
  } catch (error) {
    localError.value = messageFor(error, '本地 AI 配置删除失败')
  }
}

async function testAddress(connection: LocalAiConnection) {
  if (testingId.value) return
  testingId.value = connection.id
  localError.value = ''
  try {
    const result = await desktop.testLocalAiAddress(connection.id)
    if (result) testResults[connection.id] = result
  } catch (error) {
    localError.value = messageFor(error, '地址测试失败')
  } finally {
    testingId.value = ''
  }
}

function closeEditor() {
  if (desktop.localAiSaving) return
  if (formDirty.value && !globalThis.confirm('配置尚未保存，确定关闭吗？')) return
  form.apiKey = ''
  localError.value = ''
  showApiKey.value = false
  apiKeyTouched.value = false
  showEditor.value = false
}

function rememberForm() {
  formSnapshot.value = metadataSnapshot(form)
}

function metadataSnapshot(value: LocalAiConnectionInput) {
  const metadata = { ...value }
  delete metadata.apiKey
  return JSON.stringify(metadata)
}

function serviceTypeLabel(serviceType: AiServiceType) {
  return serviceTypes.find((item) => item.value === serviceType)?.label ?? serviceType
}

function formatBytes(bytes?: number) {
  if (bytes === undefined) return '--'
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

function statusLabel(result?: LocalAiConnectivityResult) {
  if (!result) return ''
  if (result.status === 'REACHABLE') return '可达'
  if (result.status === 'DEGRADED') return '服务异常'
  return '不可达'
}

function messageFor(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}
</script>

<template>
  <StudioShell>
    <div class="settings-page">
      <header class="page-header brand-page-hero settings-page-header">
        <div>
          <p>系统配置</p>
          <h1>设置</h1>
          <span>管理本地运行环境、客户端更新和 AI 模型线路</span>
        </div>
      </header>

      <section class="settings-overview">
        <p v-if="desktop.error" class="inline-error">{{ desktop.error }}</p>
        <div class="runtime-grid">
          <div class="runtime-item workspace-runtime-item">
            <span class="runtime-icon"><FolderOpen :size="22" /></span>
            <div>
              <span>工作目录</span>
              <strong :title="desktop.workspace?.workspaceRoot">{{
                desktop.available ? desktop.workspace?.workspaceRoot || '未设置' : '仅桌面端可用'
              }}</strong>
              <button
                v-if="desktop.available"
                type="button"
                class="text-action"
                @click="desktop.selectWorkspaceRoot"
              >
                更改目录
              </button>
            </div>
            <ChevronRight :size="17" />
          </div>
          <div class="runtime-item">
            <span class="runtime-icon"><HardDrive :size="22" /></span>
            <div>
              <span>磁盘可用空间</span>
              <strong>{{
                desktop.available ? formatBytes(workspaceDisk?.freeBytes) : '--'
              }}</strong>
              <small>{{
                desktop.available
                  ? `共 ${formatBytes(workspaceDisk?.totalBytes)} · 已使用 ${Math.round(diskUsage)}%`
                  : '桌面端读取'
              }}</small>
            </div>
            <ChevronRight :size="17" />
          </div>
          <div class="runtime-item">
            <span class="runtime-icon"><Clapperboard :size="22" /></span>
            <div>
              <span>本地项目</span
              ><strong>{{
                desktop.available ? (desktop.workspace?.projectCount ?? 0) : '--'
              }}</strong
              ><small>项目目录</small>
            </div>
            <ChevronRight :size="17" />
          </div>
          <div class="runtime-item">
            <span class="runtime-icon"><Package :size="22" /></span>
            <div>
              <span>客户端版本</span>
              <strong>{{
                desktop.available ? desktop.runtime?.appVersion || '--' : '网页模式'
              }}</strong>
              <small>{{
                desktop.available
                  ? '更新时请安装新版安装包；用户数据与本地工作区会保留'
                  : '请使用 Windows 安装包获取版本更新'
              }}</small>
            </div>
            <ChevronRight :size="17" />
          </div>
          <div class="runtime-item">
            <span class="runtime-icon"><Cpu :size="22" /></span>
            <div>
              <span>FFmpeg</span>
              <strong class="runtime-status" :class="{ ready: ffmpegRuntime?.available }">
                <CheckCircle2 v-if="ffmpegRuntime?.available" :size="16" />
                <TriangleAlert v-else :size="16" />
                {{
                  ffmpegRuntime?.available
                    ? '可用'
                    : desktop.available
                      ? '未检测到'
                      : '网页模式不可用'
                }}
              </strong>
              <small>{{ ffmpegRuntimeHint }}</small>
            </div>
            <ChevronRight :size="17" />
          </div>
        </div>
      </section>

      <section class="runtime-panel optional-runtime-panel">
        <header>
          <div>
            <h2>可选姿态模型</h2>
            <p>仅动作代理需要；文本、图片、视频和配音模型配置不受影响</p>
          </div>
          <strong
            class="runtime-status"
            :class="{ ready: poseAsset?.state === 'READY' }"
          >
            <CheckCircle2 v-if="poseAsset?.state === 'READY'" :size="16" />
            <TriangleAlert v-else :size="16" />
            {{
              poseAsset?.state === 'READY'
                ? '已安装'
                : poseAsset?.state === 'CORRUPT'
                  ? '校验失败'
                  : '未安装'
            }}
          </strong>
        </header>
        <p v-if="poseAssetNotice" class="inline-success" role="status">{{ poseAssetNotice }}</p>
        <p v-if="poseAssetError" class="inline-error" role="alert">{{ poseAssetError }}</p>
        <div class="optional-runtime-card">
          <div>
            <strong>{{ poseAsset?.label || 'DWPose 姿态模型' }}</strong>
            <span>
              {{ formatUpdateBytes(poseAsset?.sizeBytes) }} · {{ poseAsset?.license || 'Apache-2.0' }}
              · 下载后保存在当前用户数据目录
            </span>
            <a
              v-if="poseAsset?.sourceUrl"
              :href="poseAsset.sourceUrl"
              target="_blank"
              rel="noopener noreferrer"
            >查看官方来源与许可证</a>
          </div>
          <div class="optional-runtime-actions">
            <button
              v-if="poseAsset?.state !== 'READY'"
              class="button primary"
              type="button"
              :disabled="!desktop.available || poseAssetBusy"
              @click="installPoseAsset"
            >
              <Download :size="16" />
              {{ poseAssetBusy ? '下载安装中…' : poseAsset?.state === 'CORRUPT' ? '重新安装' : '下载并安装' }}
            </button>
            <button
              v-if="poseAssetBusy"
              class="button"
              type="button"
              @click="cancelPoseAssetInstall"
            >取消</button>
            <button
              v-if="poseAsset?.state === 'READY'"
              class="button danger-text"
              type="button"
              :disabled="poseAssetBusy"
              @click="removePoseAsset"
            >
              <Trash2 :size="16" /> 删除模型
            </button>
          </div>
        </div>
        <div v-if="poseAssetProgress" class="runtime-download-progress" role="status">
          <progress :value="poseAssetProgress.progress" max="100" />
          <span>
            {{ poseAssetProgress.stage === 'VERIFYING' ? '正在校验 SHA-256' : '正在下载' }}
            · {{ poseAssetProgress.progress }}%
            · {{ formatUpdateBytes(poseAssetProgress.receivedBytes) }} /
            {{ formatUpdateBytes(poseAssetProgress.totalBytes) }}
          </span>
        </div>
      </section>

      <section class="runtime-panel update-guide-panel">
        <header>
          <div>
            <h2>客户端更新</h2>
            <p>检查到新版本后，一键下载最新安装包并自动启动安装</p>
          </div>
          <button
            class="button"
            type="button"
            :disabled="!desktop.available || updateChecking || updateInstalling"
            @click="checkForAppUpdate(false)"
          >
            <RefreshCw :size="16" :class="{ spin: updateChecking }" />
            {{ updateChecking ? '检查中...' : '检查更新' }}
          </button>
        </header>

        <p v-if="updateNotice" class="inline-success" role="status">{{ updateNotice }}</p>
        <p v-if="updateError" class="inline-error" role="alert">{{ updateError }}</p>

        <div v-if="!desktop.available" class="provider-empty desktop-required">
          <Laptop :size="28" />
          <strong>请在 Windows 客户端检查更新</strong>
          <span>网页模式不支持安装包自动升级</span>
        </div>

        <div v-else class="update-status-card">
          <div class="update-status-main">
            <strong>当前版本 {{ desktop.runtime?.appVersion || '--' }}</strong>
            <span v-if="updateCheck?.updateAvailable && updateCheck.latest">
              发现新版本 {{ updateCheck.latest.versionName }} ·
              {{ formatUpdateBytes(updateCheck.latest.sizeBytes) }}
              <em v-if="updateCheck.latest.mandatory">（强制更新）</em>
            </span>
            <span v-else-if="updateCheck && !updateCheck.updateAvailable">已是最新版本</span>
            <span v-else>点击“检查更新”获取服务端最新安装包</span>
          </div>

          <div v-if="updateCheck?.latest?.releaseNotes" class="update-notes">
            <strong>更新说明</strong>
            <pre>{{ updateCheck.latest.releaseNotes }}</pre>
          </div>

          <div v-if="updateInstalling || updateProgress" class="update-progress">
            <div class="update-progress-bar">
              <i
                :style="{ width: `${Math.max(0, Math.min(100, updateProgress?.progress || 0))}%` }"
              />
            </div>
            <small>
              {{
                updateProgress?.stage === 'INSTALLING'
                  ? '正在启动安装程序...'
                  : `下载中 ${updateProgress?.progress || 0}% · ${formatUpdateBytes(updateProgress?.receivedBytes)} / ${formatUpdateBytes(updateProgress?.totalBytes)}`
              }}
            </small>
          </div>

          <div class="update-actions">
            <button
              v-if="updateInstalling && updateProgress?.stage === 'DOWNLOADING'"
              class="button"
              type="button"
              @click="cancelAppUpdate"
            >
              <X :size="16" />取消下载
            </button>
            <button
              class="button primary"
              type="button"
              :disabled="!updateCheck?.updateAvailable || updateInstalling || updateChecking"
              @click="installAppUpdate"
            >
              <Download :size="16" />
              {{ updateInstalling ? '下载安装中...' : '一键更新并安装' }}
            </button>
          </div>
        </div>
      </section>

      <section class="provider-settings ai-settings-panel">
        <header>
          <div>
            <h2>AI 模型</h2>
            <p>
              {{
                activeSource === 'LOCAL' ? '密钥保存在当前 Windows 设备' : '使用平台统一提供的模型'
              }}
            </p>
          </div>
          <button
            v-if="activeSource === 'LOCAL' && desktop.available"
            class="button primary"
            type="button"
            @click="openCreate"
          >
            <Plus :size="17" />新增 API
          </button>
          <button
            v-if="activeSource === 'PLATFORM'"
            class="icon-button"
            type="button"
            title="刷新平台模型"
            :disabled="platformLoading"
            @click="loadPlatformModels"
          >
            <RefreshCw :size="17" />
          </button>
        </header>

        <div class="ai-source-tabs" role="tablist" aria-label="AI 来源">
          <button
            type="button"
            role="tab"
            :aria-selected="activeSource === 'LOCAL'"
            :class="{ active: activeSource === 'LOCAL' }"
            @click="activeSource = 'LOCAL'"
          >
            <Laptop :size="16" />我的 API
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="activeSource === 'PLATFORM'"
            :class="{ active: activeSource === 'PLATFORM' }"
            @click="openPlatformModels"
          >
            <Cloud :size="16" />平台模型<LockKeyhole v-if="!auth.isAuthenticated" :size="12" />
          </button>
        </div>

        <div class="provider-tabs" role="tablist" aria-label="AI 服务类型">
          <button
            v-for="item in serviceTypes"
            :key="item.value"
            type="button"
            role="tab"
            :aria-selected="activeServiceType === item.value"
            :class="{ active: activeServiceType === item.value }"
            @click="activeServiceType = item.value"
          >
            {{ item.label }}
          </button>
        </div>

        <template v-if="activeSource === 'LOCAL'">
          <p v-if="localError" class="inline-error">{{ localError }}</p>
          <p v-if="localNotice" class="inline-success">{{ localNotice }}</p>
          <div v-if="!desktop.available" class="provider-empty desktop-required">
            <Laptop :size="28" />
            <strong>请在 Windows 客户端管理本机 API</strong>
            <span>浏览器不会保存或读取本地密钥</span>
          </div>
          <div v-else-if="desktop.localAiLoading" class="provider-empty">正在读取本地配置...</div>
          <div v-else-if="filteredLocalConnections.length === 0" class="provider-empty">
            <KeyRound :size="28" />
            <strong>尚未配置{{ serviceTypeLabel(activeServiceType) }}</strong>
            <button class="button" type="button" @click="openCreate">
              <Plus :size="16" />添加第一条配置
            </button>
          </div>
          <div v-else class="table-wrap provider-table">
            <table>
              <thead>
                <tr>
                  <th>名称</th>
                  <th>供应商</th>
                  <th>模型</th>
                  <th>基础地址</th>
                  <th>密钥</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="connection in filteredLocalConnections" :key="connection.id">
                  <td>
                    <strong>{{
                      connection.defaultProvider
                        ? `默认 · ${connection.displayName}`
                        : connection.displayName
                    }}</strong>
                  </td>
                  <td>{{ connection.providerCode }}</td>
                  <td>{{ connection.modelName }}</td>
                  <td class="provider-url" :title="connection.baseUrl">{{ connection.baseUrl }}</td>
                  <td>
                    <span class="key-status" :class="{ configured: connection.apiKeyConfigured }"
                      ><KeyRound :size="14" />{{
                        connection.apiKeyConfigured ? `末四位 ${connection.apiKeyHint}` : '无密钥'
                      }}</span
                    >
                  </td>
                  <td>
                    <span class="provider-state" :class="{ enabled: connection.enabled }"
                      ><i />{{ connection.enabled ? '启用' : '停用' }}</span
                    >
                    <small
                      v-if="testResults[connection.id]"
                      class="connection-test-result"
                      :class="testResults[connection.id].status.toLowerCase()"
                      >{{ statusLabel(testResults[connection.id]) }}</small
                    >
                  </td>
                  <td>
                    <div class="row-actions">
                      <button
                        class="icon-button compact"
                        type="button"
                        title="地址可达测试，不调用模型"
                        :disabled="Boolean(testingId)"
                        @click="testAddress(connection)"
                      >
                        <Wifi :size="15" />
                      </button>
                      <button
                        class="icon-button compact"
                        type="button"
                        title="编辑"
                        @click="openEdit(connection)"
                      >
                        <Pencil :size="15" />
                      </button>
                      <button
                        class="icon-button compact danger"
                        type="button"
                        title="删除"
                        @click="deleteConnection(connection)"
                      >
                        <Trash2 :size="15" />
                      </button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <footer v-if="desktop.available" class="provider-count">
            共 {{ filteredLocalConnections.length }} 条 · 地址测试不调用模型
          </footer>
        </template>

        <template v-else>
          <p v-if="platformError" class="inline-error">{{ platformError }}</p>
          <div v-if="platformLoading" class="provider-empty">正在加载平台模型...</div>
          <div v-else-if="filteredPlatformModels.length === 0" class="provider-empty">
            <Cloud :size="28" />
            <strong>暂无可用的{{ serviceTypeLabel(activeServiceType) }}</strong>
          </div>
          <div v-else class="table-wrap provider-table platform-model-table">
            <table>
              <thead>
                <tr>
                  <th>模型</th>
                  <th>模型编码</th>
                  <th>额度消耗</th>
                  <th>能力</th>
                  <th>更新时间</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="model in filteredPlatformModels" :key="model.id">
                  <td>
                    <strong>{{ model.displayName }}</strong>
                  </td>
                  <td>{{ model.modelCode }}</td>
                  <td>
                    <span class="platform-price" :class="{ configured: model.creditPrice }">
                      {{ model.creditPrice?.description || '未配置额度' }}
                    </span>
                  </td>
                  <td>
                    <div class="capability-list">
                      <span v-for="capability in model.capabilities || []" :key="capability">{{
                        capability
                      }}</span
                      ><span v-if="!model.capabilities?.length">通用</span>
                    </div>
                  </td>
                  <td>{{ new Date(model.updatedAt).toLocaleDateString('zh-CN') }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <footer class="provider-count">共 {{ filteredPlatformModels.length }} 个可用模型</footer>
        </template>
      </section>
    </div>
  </StudioShell>

  <div v-if="showEditor" class="modal-backdrop provider-backdrop" @click.self="closeEditor">
    <section
      class="modal provider-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="local-api-editor-title"
    >
      <header>
        <div>
          <h2 id="local-api-editor-title">{{ editingId ? '编辑我的 API' : '新增我的 API' }}</h2>
          <p>{{ serviceTypeLabel(form.serviceType) }}</p>
        </div>
        <button
          class="icon-button"
          title="关闭"
          type="button"
          :disabled="desktop.localAiSaving"
          @click="closeEditor"
        >
          <X :size="18" />
        </button>
      </header>
      <form @submit.prevent="saveConnection">
        <div class="provider-form-columns">
          <div class="provider-form-column">
            <label
              >常用供应商<select v-model="selectedProviderPreset" @change="applyProviderPreset">
                <option value="AUTO">自动识别 / 手动配置</option>
                <option
                  v-for="preset in availableProviderPresets"
                  :key="preset.code"
                  :value="preset.code"
                >
                  {{ preset.label }}
                </option></select
              ><small>选择后自动填写地址和接口路径，仍可手动修改</small></label
            >
            <label
              >服务类型<select v-model="form.serviceType">
                <option v-for="item in serviceTypes" :key="item.value" :value="item.value">
                  {{ item.label }}
                </option>
              </select></label
            >
            <label
              >配置名称<input
                v-model="form.displayName"
                maxlength="120"
                placeholder="例如：本机 Ollama"
                required
            /></label>
            <label
              >供应商编码（选填）<input
                v-model="form.providerCode"
                maxlength="60"
                placeholder="留空自动识别"
                pattern="[A-Za-z0-9_\x2D]+"
            /></label>
            <label
              >基础地址<input
                v-model="form.baseUrl"
                maxlength="500"
                placeholder="http://127.0.0.1:11434"
                required
                @blur="applyConnectionDefaults"
            /></label>
            <label
              >接口路径<input
                v-model="form.endpointPath"
                maxlength="300"
                :placeholder="defaultEndpointPaths[form.serviceType]"
              /><small>留空时会按服务类型自动补齐，也可以填写厂商专用路径</small></label
            >
          </div>
          <div class="provider-form-column">
            <label
              >模型名称<span class="provider-model-input"
                ><input
                  v-model="form.modelName"
                  list="local-ai-model-options"
                  maxlength="160"
                  placeholder="先获取模型，或手工填写模型 ID"
                  required
                /><button
                  class="button"
                  type="button"
                  :disabled="discoveringModels || !form.baseUrl.trim()"
                  @click="discoverModels"
                >
                  <RefreshCw :size="16" :class="{ spinning: discoveringModels }" />{{
                    discoveringModels ? '获取中' : '获取模型'
                  }}
                </button></span
              ><datalist id="local-ai-model-options">
                <option v-for="model in discoveredModels" :key="model" :value="model" /></datalist
              ><small v-if="discoveryNotice" class="provider-discovery-notice">{{
                discoveryNotice
              }}</small></label
            >
            <label
              >API Key<span class="provider-key-input"
                ><input
                  v-model="form.apiKey"
                  :type="showApiKey ? 'text' : 'password'"
                  maxlength="2000"
                  autocomplete="new-password"
                  :placeholder="
                    editingConnection?.apiKeyConfigured
                      ? `留空保留当前密钥（末四位 ${editingConnection.apiKeyHint}）`
                      : '无密钥服务可留空'
                  "
                  @input="apiKeyTouched = true" /><button
                  type="button"
                  :title="showApiKey ? '隐藏密钥' : '显示密钥'"
                  @click="showApiKey = !showApiKey"
                >
                  <EyeOff v-if="showApiKey" :size="17" /><Eye v-else :size="17" /></button></span
            ></label>
            <div class="provider-flags">
              <label class="switch-field"
                ><span>启用配置</span
                ><input
                  v-model="form.enabled"
                  type="checkbox"
                  :disabled="form.defaultProvider" /><i
              /></label>
              <label class="switch-field"
                ><span>设为默认</span
                ><input
                  v-model="form.defaultProvider"
                  type="checkbox"
                  @change="form.defaultProvider && (form.enabled = true)" /><i
              /></label>
            </div>
            <label v-if="editingConnection?.apiKeyConfigured" class="checkbox-field danger-option"
              ><input v-model="form.clearApiKey" type="checkbox" />清除已保存的 API Key</label
            >
          </div>
        </div>
        <p v-if="localError" class="provider-form-error">{{ localError }}</p>
        <footer>
          <button
            class="button"
            type="button"
            :disabled="desktop.localAiSaving"
            @click="closeEditor"
          >
            取消</button
          ><button class="button primary" type="submit" :disabled="desktop.localAiSaving">
            <Save :size="16" />{{ desktop.localAiSaving ? '保存中' : '保存' }}
          </button>
        </footer>
      </form>
    </section>
  </div>
</template>
