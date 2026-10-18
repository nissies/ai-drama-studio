<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'
import {
  Check,
  FilePlus2,
  ListChecks,
  Maximize2,
  Pencil,
  Plus,
  Save,
  ScanText,
  Sparkles,
  Trash2,
  X,
} from 'lucide-vue-next'
import {
  episodeAssetCandidateApi,
  type EpisodeAssetCandidate,
  type EpisodeCharacterDecision,
} from '../../api/episode-assets'
import { ApiClientError } from '../../api/client'
import { generationApi, type GenerationJob, type GenerationRoute } from '../../api/generation'
import { executeTextGeneration } from '../../composables/text-generation'
import EpisodeAssetCandidateDialog from '../generation/EpisodeAssetCandidateDialog.vue'
import GenerationRouteDialog from '../generation/GenerationRouteDialog.vue'
import { useDesktopStore } from '../../stores/desktop'
import { useWorkspaceStore } from '../../stores/workspace'
import {
  estimateScriptDurationSec,
  minimumGeneratedScriptCharacterCount,
  scriptCharacterCount,
  scriptGenerationMaxTokens,
} from '../../domain/episode-metrics'

const props = defineProps<{ projectId: string; active?: boolean }>()
const workspace = useWorkspaceStore()
const desktop = useDesktopStore()
const form = reactive({
  title: '',
  synopsis: '',
  scriptText: '',
  targetDurationSec: 60,
  version: 0,
})
const showCreate = ref(false)
const selectionMode = ref(false)
const selectedEpisodeIds = ref(new Set<string>())
const showRename = ref(false)
const renameEpisodeId = ref('')
const renameTitle = ref('')
const newEpisodeTitle = ref('')
const saving = ref(false)
const deleting = ref(false)
const renaming = ref(false)
const formError = ref('')
const formNotice = ref('')
const showRouteDialog = ref(false)
const showCandidate = ref(false)
const showAssetCandidate = ref(false)
const fullscreenField = ref<'synopsis' | 'script' | null>(null)
const generating = ref(false)
const applyingAssets = ref(false)
const checkingAssetCandidate = ref(false)
const generationJob = ref<GenerationJob | null>(null)
const candidateText = ref('')
const candidateMode = ref<'GENERATE' | 'REWRITE'>('GENERATE')
const pendingAiAction = ref<'SCRIPT' | 'ASSET'>('SCRIPT')
const assetCandidate = ref<EpisodeAssetCandidate | null>(null)

watch(
  () => workspace.activeEpisode,
  (episode) => {
    form.title = episode?.title ?? ''
    form.synopsis = episode?.synopsis ?? ''
    form.scriptText = episode?.scriptText ?? ''
    form.targetDurationSec = episode?.targetDurationSec ?? 60
    form.version = episode?.version ?? 0
    formError.value = ''
    formNotice.value = ''
    fullscreenField.value = null
  },
  { immediate: true },
)

const dirty = computed(() => {
  const episode = workspace.activeEpisode
  if (!episode) return false
  return (
    form.title !== episode.title ||
    form.synopsis !== (episode.synopsis ?? '') ||
    form.scriptText !== (episode.scriptText ?? '') ||
    form.targetDurationSec !== episode.targetDurationSec
  )
})
const characterCount = computed(() => scriptCharacterCount(form.scriptText))
const estimatedSeconds = computed(() => estimateScriptDurationSec(form.scriptText))
const candidateCharacterCount = computed(() => scriptCharacterCount(candidateText.value))
const candidateEstimatedSeconds = computed(() => estimateScriptDurationSec(candidateText.value))
const hasScript = computed(() => Boolean(form.scriptText.trim()))
const candidateMinimumCharacters = computed(() =>
  minimumGeneratedScriptCharacterCount(form.targetDurationSec),
)
const generatedCandidateIsShort = computed(
  () =>
    candidateMode.value === 'GENERATE' &&
    candidateCharacterCount.value < candidateMinimumCharacters.value,
)
const scriptGenerationParameters = computed(() => ({
  temperature: 0.7,
  max_tokens: scriptGenerationMaxTokens(
    form.targetDurationSec,
    hasScript.value ? characterCount.value : 0,
  ),
}))
const scriptActionLabel = computed(() => (hasScript.value ? 'AI 改写' : 'AI 生成剧本'))
const routeTitle = computed(() =>
  pendingAiAction.value === 'ASSET'
    ? '选择用于提取角色与场景的模型'
    : hasScript.value
      ? '选择用于改写剧本的模型'
      : '选择用于生成剧本的模型',
)
const allEpisodesSelected = computed(
  () =>
    workspace.episodes.length > 0 &&
    workspace.episodes.every((episode) => selectedEpisodeIds.value.has(episode.id)),
)
const renameTarget = computed(
  () => workspace.episodes.find((episode) => episode.id === renameEpisodeId.value) ?? null,
)

watch(
  () => workspace.episodes.map((episode) => episode.id),
  (episodeIds) => {
    const availableIds = new Set(episodeIds)
    selectedEpisodeIds.value = new Set(
      [...selectedEpisodeIds.value].filter((episodeId) => availableIds.has(episodeId)),
    )
    if (episodeIds.length === 0) selectionMode.value = false
  },
)

function confirmRouteChange() {
  if (props.active === false) return true
  return !dirty.value || globalThis.confirm('当前剧本尚未保存，确定离开本项目吗？')
}

onBeforeRouteLeave(confirmRouteChange)
onBeforeRouteUpdate(confirmRouteChange)

async function selectEpisode(episodeId: string) {
  if (episodeId === workspace.activeEpisodeId) return
  if (dirty.value && !globalThis.confirm('当前剧本尚未保存，确定切换分集吗？')) return
  await workspace.selectEpisode(props.projectId, episodeId)
}
async function saveEpisode() {
  const episode = workspace.activeEpisode
  if (!episode || !form.title.trim() || saving.value) return
  saving.value = true
  formError.value = ''
  try {
    const saved = await workspace.updateEpisode(props.projectId, episode.id, { ...form })
    form.version = saved.version
  } catch (error) {
    formError.value = error instanceof Error ? error.message : '剧本保存失败'
  } finally {
    saving.value = false
  }
}
async function createEpisode() {
  if (saving.value) return
  saving.value = true
  formError.value = ''
  try {
    await workspace.createEpisode(props.projectId, {
      title: newEpisodeTitle.value,
      synopsis: '',
      scriptText: '',
      targetDurationSec: 60,
    })
    newEpisodeTitle.value = ''
    showCreate.value = false
  } catch (error) {
    formError.value = error instanceof Error ? error.message : '分集创建失败'
  } finally {
    saving.value = false
  }
}
async function deleteEpisode() {
  const episode = workspace.activeEpisode
  if (!episode || !globalThis.confirm(`确定删除第 ${episode.episodeNo} 集吗？`)) return
  try {
    await workspace.deleteEpisode(props.projectId, episode.id)
  } catch (error) {
    formError.value = error instanceof Error ? error.message : '分集删除失败'
  }
}
function enterSelectionMode() {
  selectionMode.value = true
  selectedEpisodeIds.value = new Set()
}
function exitSelectionMode() {
  selectionMode.value = false
  selectedEpisodeIds.value = new Set()
}
function toggleEpisodeSelection(episodeId: string) {
  const selected = new Set(selectedEpisodeIds.value)
  if (selected.has(episodeId)) selected.delete(episodeId)
  else selected.add(episodeId)
  selectedEpisodeIds.value = selected
}
function toggleSelectAll() {
  selectedEpisodeIds.value = allEpisodesSelected.value
    ? new Set()
    : new Set(workspace.episodes.map((episode) => episode.id))
}
async function deleteSelectedEpisodes() {
  const episodeIds = [...selectedEpisodeIds.value]
  if (episodeIds.length === 0 || deleting.value) return
  const includesDirtyActive = dirty.value && selectedEpisodeIds.value.has(workspace.activeEpisodeId)
  const message = includesDirtyActive
    ? `已选择 ${episodeIds.length} 集，当前集还有未保存修改。确定一并删除吗？`
    : `确定删除选中的 ${episodeIds.length} 集吗？相关场景、分镜和输出也会一并移除。`
  if (!globalThis.confirm(message)) return
  deleting.value = true
  formError.value = ''
  try {
    await workspace.deleteEpisodes(props.projectId, episodeIds)
    exitSelectionMode()
  } catch (error) {
    formError.value = error instanceof Error ? error.message : '分集批量删除失败'
  } finally {
    deleting.value = false
  }
}
function openRenameEpisode(episodeId: string) {
  if (dirty.value) {
    formError.value = '请先保存当前分集的修改，再编辑分集标题'
    return
  }
  const episode = workspace.episodes.find((item) => item.id === episodeId)
  if (!episode) return
  renameEpisodeId.value = episodeId
  renameTitle.value = episode.title
  formError.value = ''
  showRename.value = true
}
async function submitRename() {
  const episode = renameTarget.value
  const title = renameTitle.value.trim()
  if (!episode || !title || renaming.value) return
  renaming.value = true
  formError.value = ''
  try {
    await workspace.updateEpisode(props.projectId, episode.id, {
      title,
      synopsis: episode.synopsis ?? '',
      scriptText: episode.scriptText ?? '',
      targetDurationSec: episode.targetDurationSec,
      version: episode.version,
    })
    showRename.value = false
  } catch (error) {
    formError.value = error instanceof Error ? error.message : '分集标题修改失败'
  } finally {
    renaming.value = false
  }
}
function openScriptGeneration() {
  if (dirty.value) {
    formError.value = '请先保存当前分集，再创建 AI 任务'
    return
  }
  if (!hasScript.value && !form.synopsis.trim()) {
    formError.value = '请先填写并保存分集剧情资料，AI 才能生成剧本'
    return
  }
  formError.value = ''
  formNotice.value = ''
  pendingAiAction.value = 'SCRIPT'
  showRouteDialog.value = true
}

async function openAssetExtraction() {
  if (dirty.value) {
    formError.value = '请先保存当前剧本，再提取角色与场景'
    return
  }
  if (!hasScript.value && !form.synopsis.trim()) {
    formError.value = '请先填写分集剧情资料或剧本并保存，再提取角色与场景'
    return
  }
  formError.value = ''
  formNotice.value = ''
  pendingAiAction.value = 'ASSET'
  checkingAssetCandidate.value = true
  try {
    const candidate = await episodeAssetCandidateApi.latest(
      props.projectId,
      workspace.activeEpisode!.id,
    )
    assetCandidate.value = candidate
    showAssetCandidate.value = true
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 404) {
      showRouteDialog.value = true
      return
    }
    formError.value = error instanceof Error ? error.message : '候选结果读取失败'
  } finally {
    checkingAssetCandidate.value = false
  }
}

async function runSelectedAction(route: GenerationRoute) {
  if (pendingAiAction.value === 'ASSET') {
    await createAssetExtraction(route)
    return
  }
  await createScriptCandidate(route)
}

async function createScriptCandidate(route: GenerationRoute) {
  const episode = workspace.activeEpisode
  if (!episode || generating.value) return
  generating.value = true
  formError.value = ''
  const mode = hasScript.value ? 'REWRITE' : 'GENERATE'
  candidateMode.value = mode
  try {
    let job = await generationApi.create(
      props.projectId,
      {
        jobType: mode === 'REWRITE' ? 'SCRIPT_REWRITE' : 'SCRIPT_GENERATE',
        targetType: 'EPISODE',
        targetId: episode.id,
        parameters: scriptGenerationParameters.value,
        route,
      },
      globalThis.crypto.randomUUID(),
    )
    generationJob.value = job
    showRouteDialog.value = false
    job = await executeTextGeneration(job, route, desktop, (updated) => {
      generationJob.value = updated
    })
    generationJob.value = job
    if (job.status !== 'SUCCEEDED' || !job.resultText) {
      throw new Error(job.errorMessage || 'AI 剧本任务未返回候选稿')
    }
    candidateText.value = job.resultText
    showCandidate.value = true
  } catch (error) {
    formError.value = error instanceof Error ? error.message : 'AI 剧本生成失败'
  } finally {
    generating.value = false
  }
}

async function createAssetExtraction(route: GenerationRoute) {
  const episode = workspace.activeEpisode
  if (!episode || generating.value) return
  generating.value = true
  formError.value = ''
  try {
    let job = await generationApi.create(
      props.projectId,
      {
        jobType: 'EPISODE_ASSET_EXTRACT',
        targetType: 'EPISODE',
        targetId: episode.id,
        parameters: { temperature: 0.2 },
        route,
      },
      globalThis.crypto.randomUUID(),
    )
    generationJob.value = job
    showRouteDialog.value = false
    job = await executeTextGeneration(job, route, desktop, (updated) => {
      generationJob.value = updated
    })
    generationJob.value = job
    if (job.status !== 'SUCCEEDED') {
      throw new Error(job.errorMessage || '角色与场景提取失败')
    }
    const candidate = await episodeAssetCandidateApi.getByJob(props.projectId, job.id)
    if (candidate.status !== 'READY' || !candidate.payload) {
      throw new Error(candidate.validationError || 'AI 返回的角色与场景格式无法识别')
    }
    assetCandidate.value = candidate
    showAssetCandidate.value = true
  } catch (error) {
    formError.value = error instanceof Error ? error.message : '角色与场景提取失败'
  } finally {
    generating.value = false
  }
}

async function applyAssetCandidate(input: {
  candidateVersion: number
  payloadJson: string
  selectedSceneKeys: string[]
  characterDecisions: EpisodeCharacterDecision[]
}) {
  if (!assetCandidate.value || applyingAssets.value) return
  applyingAssets.value = true
  formError.value = ''
  try {
    const summary = await episodeAssetCandidateApi.apply(
      props.projectId,
      assetCandidate.value.id,
      input,
      globalThis.crypto.randomUUID(),
    )
    showAssetCandidate.value = false
    await workspace.load(props.projectId)
    formNotice.value = `已写入 ${Object.keys(summary.createdCharacters).length} 个新角色、复用 ${Object.keys(summary.reusedCharacters).length} 个角色，并创建 ${summary.createdSceneIds.length} 个场景`
  } catch (error) {
    formError.value = error instanceof Error ? error.message : '角色与场景应用失败'
  } finally {
    applyingAssets.value = false
  }
}

function applyCandidate() {
  if (!candidateText.value.trim()) return
  form.scriptText = candidateText.value
  showCandidate.value = false
}
function openFullscreen(field: 'synopsis' | 'script') {
  fullscreenField.value = field
}
function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60)
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}
</script>

<template>
  <section class="episode-workspace">
    <aside class="episode-list">
      <header>
        <strong>分集列表</strong>
        <span class="episode-list-actions">
          <button
            class="icon-button compact"
            :title="selectionMode ? '退出批量管理' : '批量管理分集'"
            @click="selectionMode ? exitSelectionMode() : enterSelectionMode()"
          >
            <X v-if="selectionMode" :size="16" />
            <ListChecks v-else :size="16" />
          </button>
          <button class="icon-button compact" title="新建分集" @click="showCreate = true">
            <Plus :size="16" />
          </button>
        </span>
      </header>
      <div v-if="selectionMode" class="episode-batch-toolbar">
        <button type="button" @click="toggleSelectAll">
          {{ allEpisodesSelected ? '清空' : '全选' }}
        </button>
        <span>已选 {{ selectedEpisodeIds.size }} 集</span>
      </div>
      <div
        v-for="episode in workspace.episodes"
        :key="episode.id"
        class="episode-list-item"
        :class="{
          active: episode.id === workspace.activeEpisodeId,
          selected: selectedEpisodeIds.has(episode.id),
        }"
      >
        <label v-if="selectionMode" class="episode-select-control" title="选择本集">
          <input
            type="checkbox"
            :checked="selectedEpisodeIds.has(episode.id)"
            @change="toggleEpisodeSelection(episode.id)"
          />
          <span><Check :size="12" /></span>
        </label>
        <button
          class="episode-list-main"
          type="button"
          @click="selectionMode ? toggleEpisodeSelection(episode.id) : selectEpisode(episode.id)"
        >
          <span>第 {{ episode.episodeNo }} 集</span><strong>{{ episode.title }}</strong>
        </button>
        <button
          v-if="!selectionMode"
          class="icon-button compact episode-rename-button"
          type="button"
          title="修改本集标题"
          @click="openRenameEpisode(episode.id)"
        >
          <Pencil :size="14" />
        </button>
      </div>
      <button
        v-if="selectionMode"
        class="button danger wide episode-batch-delete"
        type="button"
        :disabled="selectedEpisodeIds.size === 0 || deleting"
        @click="deleteSelectedEpisodes"
      >
        <Trash2 :size="15" />{{ deleting ? '删除中...' : '删除已选' }}
      </button>
    </aside>

    <div v-if="!workspace.activeEpisode" class="workspace-empty">
      <FilePlus2 :size="32" /><strong>先创建第一集</strong>
      <p>剧本、场景和分镜均按分集管理。</p>
      <button class="button primary" @click="showCreate = true"><Plus :size="17" />新建分集</button>
    </div>
    <template v-else>
      <main class="script-editor">
        <header class="script-editor-toolbar">
          <label class="episode-title-field">
            <span class="episode-number-label">第 {{ workspace.activeEpisode.episodeNo }} 集</span>
            <input v-model="form.title" maxlength="120" />
          </label>
          <div class="row-actions">
            <button
              class="button"
              :disabled="generating || checkingAssetCandidate"
              :title="dirty ? '请先保存剧本' : '选择模型并生成候选稿'"
              @click="openScriptGeneration"
            >
              <Sparkles :size="16" />{{
                generating && pendingAiAction === 'SCRIPT' ? '生成中...' : scriptActionLabel
              }}
            </button>
            <button
              class="button"
              :disabled="generating || checkingAssetCandidate"
              :title="dirty ? '请先保存内容' : '从已保存的分集剧情资料或剧本提取角色与场景'"
              @click="openAssetExtraction"
            >
              <ScanText :size="16" />{{
                checkingAssetCandidate
                  ? '检查候选...'
                  : generating && pendingAiAction === 'ASSET'
                    ? '提取中...'
                    : '提取角色与场景'
              }}
            </button>
          </div>
        </header>
        <details class="synopsis-editor" open>
          <summary>
            <span>分集剧情资料</span>
            <button
              class="icon-button compact"
              type="button"
              title="全屏查看和修改分集剧情资料"
              @click.prevent.stop="openFullscreen('synopsis')"
            >
              <Maximize2 :size="15" />
            </button>
          </summary>
          <textarea
            v-model="form.synopsis"
            rows="3"
            maxlength="200000"
            placeholder="完整记录本集事件、因果、人物状态、关键信息和结尾承接"
          />
        </details>
        <label class="script-field">
          <span class="script-field-heading">
            <strong>剧本文本</strong>
            <button
              class="icon-button compact"
              type="button"
              title="全屏查看和修改剧本文本"
              @click.prevent.stop="openFullscreen('script')"
            >
              <Maximize2 :size="15" />
            </button>
          </span>
          <textarea
            v-model="form.scriptText"
            aria-label="剧本文本"
            placeholder="输入场景、动作、对白和旁白..."
          />
        </label>
        <footer class="script-status">
          <span>字数：{{ characterCount.toLocaleString() }}</span
          ><span>预计时长：{{ formatDuration(estimatedSeconds) }}</span
          ><span>{{ dirty ? '有未保存修改' : '已保存' }}</span>
        </footer>
      </main>
      <aside class="editor-inspector">
        <header>
          <h2>分集属性</h2>
          <span class="status-badge" :class="workspace.activeEpisode.status.toLowerCase()">{{
            workspace.activeEpisode.status === 'DRAFT'
              ? '草稿'
              : workspace.activeEpisode.status === 'ACTIVE'
                ? '制作中'
                : workspace.activeEpisode.status
          }}</span>
        </header>
        <label>
          目标时长
          <input v-model.number="form.targetDurationSec" type="number" min="5" max="3600" />
          <small>秒，约 {{ formatDuration(form.targetDurationSec) }}</small>
        </label>
        <div class="inspector-metric">
          <span>当前字数</span><strong>{{ characterCount.toLocaleString() }}</strong>
        </div>
        <div class="inspector-metric">
          <span>预计时长</span><strong>{{ formatDuration(estimatedSeconds) }}</strong>
        </div>
        <div class="inspector-metric">
          <span>数据版本</span><strong>#{{ form.version }}</strong>
        </div>
        <div v-if="generationJob" class="generation-progress">
          <span>最近 AI 任务</span>
          <strong>{{
            generationJob.status === 'SUCCEEDED'
              ? '已完成'
              : generationJob.status === 'FAILED'
                ? '失败'
                : generationJob.status === 'CANCELED'
                  ? '已取消'
                  : generationJob.status === 'QUEUED'
                    ? '排队中'
                    : generationJob.status === 'RUNNING'
                      ? '生成中'
                      : '等待本机'
          }}</strong>
        </div>
        <p v-if="formError" class="form-error">{{ formError }}</p>
        <p v-if="formNotice" class="inline-success">{{ formNotice }}</p>
        <button class="button primary wide" :disabled="saving || !dirty" @click="saveEpisode">
          <Save :size="17" />{{ saving ? '保存中' : dirty ? '保存剧本' : '已保存' }}
        </button>
        <button class="button danger-text wide" @click="deleteEpisode">
          <Trash2 :size="16" />删除本集
        </button>
      </aside>
    </template>
  </section>

  <div
    v-if="fullscreenField"
    class="modal-backdrop script-fullscreen-backdrop"
    @click.self="fullscreenField = null"
    @keydown.esc="fullscreenField = null"
  >
    <section
      class="script-fullscreen-dialog"
      role="dialog"
      aria-modal="true"
      :aria-label="fullscreenField === 'synopsis' ? '全屏编辑分集剧情资料' : '全屏编辑剧本文本'"
    >
      <header>
        <div>
          <span>第 {{ workspace.activeEpisode?.episodeNo }} 集</span>
          <h2>{{ fullscreenField === 'synopsis' ? '分集剧情资料' : '剧本文本' }}</h2>
        </div>
        <button class="icon-button" type="button" title="关闭全屏" @click="fullscreenField = null">
          <X :size="20" />
        </button>
      </header>
      <textarea
        v-if="fullscreenField === 'synopsis'"
        v-model="form.synopsis"
        autofocus
        maxlength="200000"
        aria-label="全屏分集剧情资料"
        placeholder="完整记录本集事件、因果、人物状态、关键信息和结尾承接"
      />
      <textarea
        v-else
        v-model="form.scriptText"
        autofocus
        aria-label="全屏剧本文本"
        placeholder="输入场景、动作、对白和旁白..."
      />
      <footer>
        <div>
          <span>{{
            fullscreenField === 'synopsis'
              ? `${form.synopsis.length} / 5,000 字`
              : `字数：${characterCount.toLocaleString()}`
          }}</span>
          <span>{{ dirty ? '有未保存修改' : '内容已保存' }}</span>
        </div>
        <button
          class="button primary"
          type="button"
          :disabled="saving || !dirty"
          @click="saveEpisode"
        >
          <Save :size="17" />{{ saving ? '保存中' : dirty ? '保存修改' : '已保存' }}
        </button>
      </footer>
    </section>
  </div>

  <div v-if="showCreate" class="modal-backdrop" @click.self="showCreate = false">
    <section class="modal" role="dialog" aria-modal="true">
      <header>
        <h2>新建分集</h2>
        <button class="icon-button" title="关闭" @click="showCreate = false">
          <X :size="18" />
        </button>
      </header>
      <form @submit.prevent="createEpisode">
        <label>
          分集标题
          <input v-model="newEpisodeTitle" maxlength="120" placeholder="留空将自动命名" autofocus />
        </label>
        <p v-if="formError" class="form-error">{{ formError }}</p>
        <footer>
          <button class="button" type="button" @click="showCreate = false">取消</button>
          <button class="button primary" type="submit" :disabled="saving">
            <Plus :size="17" />创建分集
          </button>
        </footer>
      </form>
    </section>
  </div>

  <div v-if="showRename" class="modal-backdrop" @click.self="showRename = false">
    <section class="modal episode-rename-modal" role="dialog" aria-modal="true">
      <header>
        <div>
          <p>第 {{ renameTarget?.episodeNo }} 集</p>
          <h2>修改分集标题</h2>
        </div>
        <button class="icon-button" title="关闭" @click="showRename = false">
          <X :size="18" />
        </button>
      </header>
      <form @submit.prevent="submitRename">
        <label>
          分集标题
          <input v-model="renameTitle" maxlength="120" autofocus />
        </label>
        <p v-if="formError" class="form-error">{{ formError }}</p>
        <footer>
          <button class="button" type="button" @click="showRename = false">取消</button>
          <button class="button primary" type="submit" :disabled="renaming || !renameTitle.trim()">
            <Save :size="16" />{{ renaming ? '保存中...' : '保存标题' }}
          </button>
        </footer>
      </form>
    </section>
  </div>

  <GenerationRouteDialog
    :open="showRouteDialog"
    :submitting="generating"
    eyebrow="文本 AI"
    :title="routeTitle"
    :submit-label="pendingAiAction === 'ASSET' ? '开始提取' : scriptActionLabel"
    :quote-prompt="`${form.synopsis}\n${form.scriptText}`"
    :quote-parameters="
      pendingAiAction === 'SCRIPT' ? scriptGenerationParameters : { temperature: 0.2 }
    "
    @close="!generating && (showRouteDialog = false)"
    @submit="runSelectedAction"
  />

  <div v-if="showCandidate" class="modal-backdrop" @click.self="showCandidate = false">
    <section class="modal generation-candidate-modal" role="dialog" aria-modal="true">
      <header>
        <div>
          <p>AI 候选稿</p>
          <h2>{{ candidateMode === 'GENERATE' ? '检查生成结果' : '检查改写结果' }}</h2>
        </div>
        <button class="icon-button" type="button" title="关闭" @click="showCandidate = false">
          <X :size="18" />
        </button>
      </header>
      <div class="generation-candidate-body">
        <p>结果尚未写入剧本。应用后仍需点击“保存剧本”，原版本不会被后台直接覆盖。</p>
        <p class="generation-candidate-metrics" :class="{ warning: generatedCandidateIsShort }">
          当前 {{ candidateCharacterCount.toLocaleString() }} 字，预计约
          {{ formatDuration(candidateEstimatedSeconds) }}。<template
            v-if="generatedCandidateIsShort"
          >
            低于本集建议最低
            {{ candidateMinimumCharacters.toLocaleString() }} 字，可先补充或重新生成。
          </template>
        </p>
        <textarea v-model="candidateText" aria-label="AI 剧本候选稿" />
      </div>
      <footer>
        <button class="button" type="button" @click="showCandidate = false">保留原稿</button>
        <button
          class="button primary"
          type="button"
          :disabled="!candidateText.trim()"
          @click="applyCandidate"
        >
          <Check :size="16" />应用到编辑器
        </button>
      </footer>
    </section>
  </div>

  <EpisodeAssetCandidateDialog
    :open="showAssetCandidate"
    :candidate="assetCandidate"
    :characters="workspace.characters"
    :applying="applyingAssets"
    @close="!applyingAssets && (showAssetCandidate = false)"
    @apply="applyAssetCandidate"
  />
</template>
