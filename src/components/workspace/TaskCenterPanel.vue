<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Ban, CircleAlert, Clapperboard, Clock3, ExternalLink, ListChecks, LoaderCircle, RefreshCw, RotateCcw } from 'lucide-vue-next'
import { exportJobApi, type ExportJob } from '../../api/export-jobs'
import { generationApi, type GenerationJob } from '../../api/generation'
import { useWorkspaceStore } from '../../stores/workspace'

const props = defineProps<{ projectId: string }>()
const workspace = useWorkspaceStore()
const router = useRouter()
const route = useRoute()
const generationJobs = ref<GenerationJob[]>([])
const exportJobs = ref<ExportJob[]>([])
const loading = ref(false)
const actingId = ref('')
const error = ref('')
const statusFilter = ref('')
const typeFilter = ref('')
let timer: ReturnType<typeof globalThis.setInterval> | null = null

const rows = computed(() => {
  const generationRows = generationJobs.value.map((job) => ({
    id: job.id,
    kind: 'GENERATION' as const,
    type: job.jobType,
    status: job.status,
    progress: job.progress,
    sourceType: job.sourceType,
    source: `${job.sourceDisplayName || sourceLabel(job.sourceType)} · ${job.modelName || '模型未记录'}`,
    targetType: job.targetType,
    targetId: job.targetId,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    raw: job,
  }))
  const exportRows = exportJobs.value.map((job) => ({
    id: job.id,
    kind: 'EXPORT' as const,
    type: 'EPISODE_EXPORT',
    status: job.status,
    progress: job.progress,
    sourceType: null,
    source: '本地 FFmpeg',
    targetType: 'EPISODE',
    targetId: job.episodeId,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    raw: job,
  }))
  return [...generationRows, ...exportRows]
    .filter((row) => !statusFilter.value || row.status === statusFilter.value)
    .filter((row) => !typeFilter.value || serviceGroup(row.type) === typeFilter.value)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
})
const hasActiveTasks = computed(() => rows.value.some((row) => ['WAITING_LOCAL', 'QUEUED', 'RUNNING'].includes(row.status)))

watch(() => props.projectId, () => void load(), { immediate: true })
onMounted(() => {
  timer = globalThis.setInterval(() => {
    if (hasActiveTasks.value && !loading.value) void load(false)
  }, 5000)
})
onBeforeUnmount(() => {
  if (timer) globalThis.clearInterval(timer)
})

async function load(showLoading = true) {
  if (showLoading) loading.value = true
  error.value = ''
  try {
    const [generationPage, exportsByEpisode] = await Promise.all([
      generationApi.list(props.projectId),
      Promise.all(
        workspace.episodes.map((episode) => exportJobApi.list(props.projectId, episode.id)),
      ),
    ])
    generationJobs.value = generationPage.items
    exportJobs.value = exportsByEpisode.flat()
  } catch (caught) {
    error.value = messageFor(caught, '任务列表读取失败')
  } finally {
    loading.value = false
  }
}

async function retry(row: (typeof rows.value)[number]) {
  if (actingId.value) return
  actingId.value = row.id
  error.value = ''
  try {
    if (row.kind === 'GENERATION') await generationApi.retry(row.id)
    else await exportJobApi.retry(row.id)
    await load(false)
  } catch (caught) {
    error.value = messageFor(caught, '任务重试失败')
  } finally {
    actingId.value = ''
  }
}

async function cancel(row: (typeof rows.value)[number]) {
  if (actingId.value || !globalThis.confirm('确定取消当前任务吗？')) return
  actingId.value = row.id
  error.value = ''
  try {
    if (row.kind === 'GENERATION') await generationApi.cancel(row.id)
    else await exportJobApi.cancel(row.id)
    await load(false)
  } catch (caught) {
    error.value = messageFor(caught, '任务取消失败')
  } finally {
    actingId.value = ''
  }
}

function locate(row: (typeof rows.value)[number]) {
  const tab = row.kind === 'EXPORT'
    ? 'compose'
    : row.type === 'STORYBOARD_GENERATE' || row.targetType === 'STORYBOARD'
      ? 'storyboards'
      : row.targetType === 'SOURCE_REVISION'
        ? 'source'
        : 'script'
  void router.push({
    name: 'workspace',
    params: { projectId: props.projectId },
    query: { ...route.query, tab },
  })
}

function requiresFreshGeneration(row: (typeof rows.value)[number]) {
  return row.kind === 'GENERATION' && row.type === 'STORYBOARD_GENERATE'
}

function serviceGroup(type: string) {
  if (type.includes('IMAGE')) return 'IMAGE'
  if (type.includes('VIDEO')) return 'VIDEO'
  if (type.includes('TTS')) return 'TTS'
  if (type.includes('EXPORT')) return 'EXPORT'
  return 'TEXT'
}

function typeLabel(type: string) {
  return {
    SCRIPT_GENERATE: '生成剧本',
    SCRIPT_REWRITE: '改写剧本',
    EPISODE_ASSET_EXTRACT: '提取角色场景',
    STORYBOARD_GENERATE: '拆解分镜',
    PROJECT_VISUAL_BIBLE_GENERATE: '生成视觉圣经',
    SOURCE_STRUCTURE: '原文结构化',
    SOURCE_STRUCTURE_SEGMENT: '原文分段分析',
    SOURCE_STRUCTURE_MERGE: '长文合并生成',
    IMAGE_GENERATION: '生成图片',
    VIDEO_GENERATION: '生成视频',
    TTS_GENERATION: '生成配音',
    VOICE_INSTRUCTION_GENERATE: '生成声音指令',
    EPISODE_EXPORT: '整集导出',
  }[type] || type
}

function statusLabel(status: string) {
  return {
    WAITING_LOCAL: '等待本地执行',
    QUEUED: '排队中',
    RUNNING: '执行中',
    SUCCEEDED: '已完成',
    FAILED: '失败',
    CANCELED: '已取消',
  }[status] || status
}

function sourceLabel(source: string) {
  return source === 'LOCAL' ? '我的 API' : '平台模型'
}

function time(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function heartbeatText(value: string) {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000))
  if (elapsedSeconds < 15) return '刚刚收到平台响应'
  if (elapsedSeconds < 60) return `${elapsedSeconds} 秒前收到平台响应`
  return `最后响应 ${time(value)}`
}

function canCancel(status: string) {
  return ['WAITING_LOCAL', 'QUEUED', 'RUNNING'].includes(status)
}

function messageFor(caught: unknown, fallback: string) {
  return caught instanceof Error && caught.message ? caught.message : fallback
}
</script>

<template>
  <section class="task-center-panel">
    <header class="panel-toolbar"><div><h2>生成任务</h2><p>集中查看模型生成与本地导出状态。</p></div><div class="toolbar-actions"><select v-model="typeFilter" aria-label="任务类型"><option value="">全部类型</option><option value="TEXT">文本</option><option value="IMAGE">图片</option><option value="VIDEO">视频</option><option value="TTS">配音</option><option value="EXPORT">导出</option></select><select v-model="statusFilter" aria-label="任务状态"><option value="">全部状态</option><option value="WAITING_LOCAL">等待本地</option><option value="QUEUED">排队中</option><option value="RUNNING">执行中</option><option value="SUCCEEDED">已完成</option><option value="FAILED">失败</option><option value="CANCELED">已取消</option></select><button class="icon-button" type="button" title="刷新任务" :disabled="loading" @click="load()"><RefreshCw :class="{ spin: loading }" :size="17" /></button></div></header>
    <p v-if="error" class="workspace-inline-notice error">{{ error }}</p>
    <div v-if="loading && !rows.length" class="workspace-empty bordered"><LoaderCircle class="spin" :size="30" /><strong>正在读取任务...</strong></div>
    <div v-else-if="!rows.length" class="workspace-empty bordered"><ListChecks :size="34" /><strong>没有符合条件的任务</strong></div>
    <div v-else class="task-table-wrap"><table class="task-table"><thead><tr><th>任务</th><th>来源 / 模型</th><th>进度</th><th>状态</th><th>创建 / 更新</th><th aria-label="操作" /></tr></thead><tbody><tr v-for="row in rows" :key="row.id"><td><strong>{{ typeLabel(row.type) }}</strong><small>{{ row.targetType }}</small></td><td><span>{{ row.source }}</span><small v-if="row.errorMessage" class="task-error" :title="row.errorMessage"><CircleAlert :size="12" />{{ row.errorMessage }}</small><small v-else-if="row.status === 'RUNNING' && row.sourceType === 'PLATFORM'">{{ heartbeatText(row.updatedAt) }}</small></td><td><div class="task-progress"><progress :value="row.progress" max="100" /><span>{{ row.progress }}%</span></div></td><td><span class="task-status" :class="row.status.toLowerCase()"><LoaderCircle v-if="['QUEUED', 'RUNNING'].includes(row.status)" class="spin" :size="13" /><Clock3 v-else :size="13" />{{ statusLabel(row.status) }}</span></td><td><time>{{ time(row.createdAt) }}</time><small v-if="row.updatedAt !== row.createdAt">更新 {{ time(row.updatedAt) }}</small></td><td><div class="row-actions"><button v-if="row.status === 'FAILED' && requiresFreshGeneration(row)" class="icon-button compact" type="button" title="返回分镜页重新生成" @click="locate(row)"><Clapperboard :size="14" /></button><button v-else-if="row.status === 'FAILED'" class="icon-button compact" type="button" title="重试" :disabled="Boolean(actingId)" @click="retry(row)"><RotateCcw :size="14" /></button><button v-if="canCancel(row.status)" class="icon-button compact danger" type="button" title="取消" :disabled="Boolean(actingId)" @click="cancel(row)"><Ban :size="14" /></button><button class="icon-button compact" type="button" title="定位到业务页面" @click="locate(row)"><ExternalLink :size="14" /></button></div></td></tr></tbody></table></div>
  </section>
</template>
