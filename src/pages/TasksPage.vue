<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  Ban,
  CircleAlert,
  Clock3,
  Coins,
  ExternalLink,
  ListChecks,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  WalletCards,
} from 'lucide-vue-next'
import StudioShell from '../layouts/StudioShell.vue'
import { creditApi, type CreditLedgerEntry } from '../api/credits'
import { generationApi, type GenerationJob } from '../api/generation'
import { getStoredToken } from '../api/client'

type ActiveTab = 'jobs' | 'credits'
type TaskRow = {
  id: string
  type: GenerationJob['jobType']
  serviceType: GenerationJob['serviceType']
  status: GenerationJob['status']
  progress: number
  sourceType: GenerationJob['sourceType']
  source: string
  projectId: string
  targetType: GenerationJob['targetType']
  targetId: string
  errorMessage?: string | null
  createdAt: string
  updatedAt: string
  raw: GenerationJob
}

const router = useRouter()
const activeTab = ref<ActiveTab>('jobs')
const generationJobs = ref<GenerationJob[]>([])
const ledgerEntries = ref<CreditLedgerEntry[]>([])
const loading = ref(false)
const actingId = ref('')
const error = ref('')
const statusFilter = ref('')
const typeFilter = ref('')
const ledgerFilter = ref('')
let timer: ReturnType<typeof globalThis.setInterval> | null = null

const taskLedgerTypes = ['GENERATION_JOB', 'CHAT_MESSAGE', 'CHAT_PROJECT']
const rows = computed<TaskRow[]>(() =>
  generationJobs.value
    .map((job) => ({
      id: job.id,
      type: job.jobType,
      serviceType: job.serviceType,
      status: job.status,
      progress: job.progress,
      sourceType: job.sourceType,
      source: `${job.sourceDisplayName || sourceLabel(job.sourceType)} · ${job.modelName || '模型未记录'}`,
      projectId: job.projectId,
      targetType: job.targetType,
      targetId: job.targetId,
      errorMessage: job.errorMessage,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      raw: job,
    }))
    .filter((row) => !statusFilter.value || row.status === statusFilter.value)
    .filter((row) => !typeFilter.value || row.serviceType === typeFilter.value)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
)
const ledgerRows = computed(() =>
  ledgerEntries.value
    .filter((entry) => taskLedgerTypes.includes(entry.businessType))
    .filter((entry) => !ledgerFilter.value || ledgerBusinessGroup(entry.businessType) === ledgerFilter.value),
)
const runningCount = computed(
  () => generationJobs.value.filter((job) => ['WAITING_LOCAL', 'QUEUED', 'RUNNING'].includes(job.status)).length,
)
const failedCount = computed(() => generationJobs.value.filter((job) => job.status === 'FAILED').length)
const imageLabCount = computed(
  () => generationJobs.value.filter((job) => job.targetType === 'IMAGE_LAB').length,
)
const hasActiveTasks = computed(() => runningCount.value > 0)

onMounted(() => {
  void load()
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
    const desktop = globalThis.window?.aiDramaDesktop
    const ledgerPromise = getStoredToken()
      ? creditApi.ledger(1, 100).catch((caught) => {
          if (!desktop) throw caught
          return { items: [], page: 1, pageSize: 100, total: 0 }
        })
      : Promise.resolve({ items: [], page: 1, pageSize: 100, total: 0 })
    const [jobs, ledger] = await Promise.all([generationApi.listMine(1, 100), ledgerPromise])
    generationJobs.value = jobs.items
    ledgerEntries.value = ledger.items
  } catch (caught) {
    error.value = messageFor(caught, '生成任务读取失败')
  } finally {
    loading.value = false
  }
}

async function retry(row: TaskRow) {
  if (actingId.value) return
  actingId.value = row.id
  error.value = ''
  try {
    await generationApi.retry(row.id)
    await load(false)
  } catch (caught) {
    error.value = messageFor(caught, '任务重试失败')
  } finally {
    actingId.value = ''
  }
}

async function cancel(row: TaskRow) {
  if (actingId.value || !globalThis.confirm('确定取消当前任务吗？')) return
  actingId.value = row.id
  error.value = ''
  try {
    await generationApi.cancel(row.id)
    await load(false)
  } catch (caught) {
    error.value = messageFor(caught, '任务取消失败')
  } finally {
    actingId.value = ''
  }
}

function locate(row: TaskRow) {
  if (row.targetType === 'IMAGE_LAB') {
    void router.push({ name: 'image-lab' })
    return
  }
  if (row.targetType === 'VIDEO_LAB') {
    void router.push({ name: 'video-lab' })
    return
  }
  void router.push({
    name: 'workspace',
    params: { projectId: row.projectId },
    query: { tab: tabFor(row) },
  })
}

function tabFor(row: TaskRow) {
  if (row.type === 'STORYBOARD_GENERATE' || row.targetType === 'STORYBOARD') return 'storyboards'
  if (row.targetType === 'CHARACTER' || row.targetType === 'CHARACTER_FORM') return 'characters'
  if (row.targetType === 'SCENE') return 'scenes'
  return 'script'
}

function requiresFreshGeneration(row: TaskRow) {
  return row.type === 'STORYBOARD_GENERATE'
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
  }[type] || type
}

function targetLabel(targetType: string) {
  return {
    EPISODE: '剧本项目',
    PROJECT: '项目',
    SOURCE_REVISION: '原文改写',
    CHARACTER: '角色图片',
    CHARACTER_FORM: '角色形态',
    SCENE: '场景图片',
    STORYBOARD: '分镜素材',
    IMAGE_LAB: '独立生图',
    VIDEO_LAB: '独立生视频',
  }[targetType] || targetType
}

function serviceLabel(serviceType: string) {
  return {
    TEXT: '文本',
    IMAGE: '图片',
    VIDEO: '视频',
    TTS: '配音',
  }[serviceType] || serviceType
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

function entryLabel(type: string) {
  return {
    RESERVE: '预冻结',
    SETTLE: '结算',
    RELEASE: '释放',
    CONSUME: '扣费',
    RECHARGE_GRANT: '充值到账',
    CHECK_IN: '签到',
    ADMIN_ADJUST: '调账',
  }[type] || type
}

function businessLabel(type: string) {
  return {
    GENERATION_JOB: '模型生成任务',
    CHAT_MESSAGE: '聊天回复',
    CHAT_PROJECT: '聊天生成项目',
  }[type] || type
}

function ledgerBusinessGroup(type: string) {
  if (type === 'CHAT_MESSAGE' || type === 'CHAT_PROJECT') return 'CHAT'
  if (type === 'GENERATION_JOB') return 'GENERATION'
  return 'OTHER'
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

function signedPoints(value: number) {
  if (value > 0) return `+${value.toLocaleString('zh-CN')}`
  return value.toLocaleString('zh-CN')
}

function deltaClass(value: number) {
  if (value < 0) return 'negative'
  if (value > 0) return 'positive'
  return 'neutral'
}

function canCancel(status: string) {
  return ['WAITING_LOCAL', 'QUEUED', 'RUNNING'].includes(status)
}

function messageFor(caught: unknown, fallback: string) {
  return caught instanceof Error && caught.message ? caught.message : fallback
}
</script>

<template>
  <StudioShell>
    <header class="page-header brand-page-hero tasks-page-header">
      <div>
        <p>全局工作台</p>
        <h1>生成任务</h1>
        <span>不打开项目也能查看聊天、生图和平台生成任务的状态与额度消耗。</span>
      </div>
      <div class="header-actions">
        <button class="button" type="button" :disabled="loading" @click="load()">
          <RefreshCw :size="16" :class="{ spin: loading }" />刷新
        </button>
      </div>
    </header>

    <section class="global-tasks-page">
      <p v-if="error" class="workspace-inline-notice error">{{ error }}</p>

      <div class="task-summary-grid">
        <article>
          <ListChecks :size="18" />
          <span>全部任务</span>
          <strong>{{ generationJobs.length }}</strong>
        </article>
        <article>
          <LoaderCircle :size="18" :class="{ spin: runningCount > 0 }" />
          <span>正在生成</span>
          <strong>{{ runningCount }}</strong>
        </article>
        <article>
          <CircleAlert :size="18" />
          <span>失败任务</span>
          <strong>{{ failedCount }}</strong>
        </article>
        <article>
          <WalletCards :size="18" />
          <span>独立生图</span>
          <strong>{{ imageLabCount }}</strong>
        </article>
      </div>

      <div class="task-page-tabs" role="tablist" aria-label="生成任务视图">
        <button type="button" :class="{ active: activeTab === 'jobs' }" @click="activeTab = 'jobs'">
          <ListChecks :size="15" />任务状态
        </button>
        <button type="button" :class="{ active: activeTab === 'credits' }" @click="activeTab = 'credits'">
          <Coins :size="15" />额度消耗
        </button>
      </div>

      <section v-if="activeTab === 'jobs'" class="task-center-panel global-task-panel">
        <header class="panel-toolbar">
          <div>
            <h2>模型生成任务</h2>
            <p>这里显示当前账号创建的所有平台 / 本地生成任务。</p>
          </div>
          <div class="toolbar-actions">
            <select v-model="typeFilter" aria-label="任务类型">
              <option value="">全部类型</option>
              <option value="TEXT">文本</option>
              <option value="IMAGE">图片</option>
              <option value="VIDEO">视频</option>
              <option value="TTS">配音</option>
            </select>
            <select v-model="statusFilter" aria-label="任务状态">
              <option value="">全部状态</option>
              <option value="WAITING_LOCAL">等待本地</option>
              <option value="QUEUED">排队中</option>
              <option value="RUNNING">执行中</option>
              <option value="SUCCEEDED">已完成</option>
              <option value="FAILED">失败</option>
              <option value="CANCELED">已取消</option>
            </select>
          </div>
        </header>

        <div v-if="loading && !rows.length" class="workspace-empty bordered">
          <LoaderCircle class="spin" :size="30" /><strong>正在读取任务...</strong>
        </div>
        <div v-else-if="!rows.length" class="workspace-empty bordered">
          <ListChecks :size="34" /><strong>没有符合条件的任务</strong>
        </div>
        <div v-else class="task-table-wrap">
          <table class="task-table">
            <thead>
              <tr>
                <th>任务</th>
                <th>来源 / 模型</th>
                <th>进度</th>
                <th>状态</th>
                <th>创建 / 更新</th>
                <th aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in rows" :key="row.id">
                <td>
                  <strong>{{ typeLabel(row.type) }}</strong>
                  <small>{{ targetLabel(row.targetType) }} · {{ serviceLabel(row.serviceType) }}</small>
                </td>
                <td>
                  <span>{{ row.source }}</span>
                  <small v-if="row.errorMessage" class="task-error" :title="row.errorMessage">
                    <CircleAlert :size="12" />{{ row.errorMessage }}
                  </small>
                  <small v-else-if="row.status === 'RUNNING' && row.sourceType === 'PLATFORM'">
                    {{ heartbeatText(row.updatedAt) }}
                  </small>
                </td>
                <td>
                  <div class="task-progress">
                    <progress :value="row.progress" max="100" />
                    <span>{{ row.progress }}%</span>
                  </div>
                </td>
                <td>
                  <span class="task-status" :class="row.status.toLowerCase()">
                    <LoaderCircle v-if="['QUEUED', 'RUNNING'].includes(row.status)" class="spin" :size="13" />
                    <Clock3 v-else :size="13" />{{ statusLabel(row.status) }}
                  </span>
                </td>
                <td>
                  <time>{{ time(row.createdAt) }}</time>
                  <small v-if="row.updatedAt !== row.createdAt">更新 {{ time(row.updatedAt) }}</small>
                </td>
                <td>
                  <div class="row-actions">
                    <button
                      v-if="row.status === 'FAILED' && requiresFreshGeneration(row)"
                      class="icon-button compact"
                      type="button"
                      title="返回业务页重新生成"
                      @click="locate(row)"
                    >
                      <ExternalLink :size="14" />
                    </button>
                    <button
                      v-else-if="row.status === 'FAILED'"
                      class="icon-button compact"
                      type="button"
                      title="重试"
                      :disabled="Boolean(actingId)"
                      @click="retry(row)"
                    >
                      <RotateCcw :size="14" />
                    </button>
                    <button
                      v-if="canCancel(row.status)"
                      class="icon-button compact danger"
                      type="button"
                      title="取消"
                      :disabled="Boolean(actingId)"
                      @click="cancel(row)"
                    >
                      <Ban :size="14" />
                    </button>
                    <button class="icon-button compact" type="button" title="定位到业务页面" @click="locate(row)">
                      <ExternalLink :size="14" />
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section v-else class="task-center-panel global-task-panel">
        <header class="panel-toolbar">
          <div>
            <h2>额度消耗</h2>
            <p>聊天回复、聊天生成项目、平台生图和其他平台生成的扣费都在这里。</p>
          </div>
          <div class="toolbar-actions">
            <select v-model="ledgerFilter" aria-label="额度来源">
              <option value="">全部来源</option>
              <option value="CHAT">聊天</option>
              <option value="GENERATION">平台生成</option>
            </select>
          </div>
        </header>

        <div v-if="loading && !ledgerRows.length" class="workspace-empty bordered">
          <LoaderCircle class="spin" :size="30" /><strong>正在读取额度消耗...</strong>
        </div>
        <div v-else-if="!ledgerRows.length" class="workspace-empty bordered">
          <Coins :size="34" /><strong>暂无聊天或生成任务额度记录</strong>
        </div>
        <div v-else class="task-table-wrap">
          <table class="task-table ledger-table">
            <thead>
              <tr>
                <th>业务</th>
                <th>动作</th>
                <th>可用额度</th>
                <th>冻结额度</th>
                <th>说明</th>
                <th>时间</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="entry in ledgerRows" :key="entry.id">
                <td>
                  <strong>{{ businessLabel(entry.businessType) }}</strong>
                  <small>{{ entry.businessId }}</small>
                </td>
                <td>
                  <span>{{ entryLabel(entry.entryType) }}</span>
                </td>
                <td>
                  <span class="ledger-delta" :class="deltaClass(entry.availableDelta)">
                    {{ signedPoints(entry.availableDelta) }}
                  </span>
                </td>
                <td>
                  <span class="ledger-delta" :class="deltaClass(entry.reservedDelta)">
                    {{ signedPoints(entry.reservedDelta) }}
                  </span>
                </td>
                <td>
                  <span :title="entry.remark || ''">{{ entry.remark || '—' }}</span>
                </td>
                <td>
                  <time>{{ time(entry.createdAt) }}</time>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </section>
  </StudioShell>
</template>
