<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { BookOpenText, Clock3, FilePlus2, FileUp, Plus, Save, Trash2 } from 'lucide-vue-next'
import {
  sourceDocumentApi,
  structureCandidateApi,
  type SourceDocument,
  type SourceDocumentDetail,
  type SourceType,
  type StructureCandidate,
} from '../../api/source'
import { useWorkspaceStore } from '../../stores/workspace'
import StructureCandidateDialog from '../generation/StructureCandidateDialog.vue'

const props = withDefaults(defineProps<{ projectId: string; compact?: boolean }>(), {
  compact: false,
})
const emit = defineEmits<{ applied: [] }>()
const workspace = useWorkspaceStore()
const documents = ref<SourceDocument[]>([])
const activeDetail = ref<SourceDocumentDetail | null>(null)
const loading = ref(false)
const saving = ref(false)
const generating = ref(false)
const applying = ref(false)
const error = ref('')
const notice = ref('')
const fileInput = ref<{ click: () => void } | null>(null)
const showCandidateDialog = ref(false)
const candidate = ref<StructureCandidate | null>(null)
const form = reactive({
  id: '',
  title: '',
  sourceType: 'NOVEL' as SourceType,
  content: '',
  version: 0,
  revisionId: '',
})
const generationOptions = reactive({
  episodeCountMode: 'AUTO' as 'AUTO' | 'FIXED',
  targetEpisodeCount: 5,
  targetDurationSec: 60,
})

const estimatedEpisodeCount = computed(() => {
  return Math.max(1, Math.min(2_000, Math.ceil(form.content.length / 5_000)))
})

const dirty = computed(() => {
  if (!form.id) return Boolean(form.title || form.content)
  const detail = activeDetail.value
  return (
    !detail ||
    form.title !== detail.document.title ||
    form.sourceType !== detail.document.sourceType ||
    form.content !== detail.content
  )
})
const canGenerate = computed(
  () =>
    Boolean(form.id && form.revisionId && form.content.trim()) &&
    !dirty.value &&
    form.content.length <= 10_000_000 &&
    !generating.value,
)

onMounted(() => void loadDocuments())

async function loadDocuments(preferredId?: string) {
  loading.value = true
  error.value = ''
  try {
    documents.value = await sourceDocumentApi.list(props.projectId)
    const targetId =
      preferredId && documents.value.some((item) => item.id === preferredId)
        ? preferredId
        : documents.value[0]?.id
    if (targetId) await selectDocument(targetId)
    else newDocument()
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : '原文资料加载失败'
  } finally {
    loading.value = false
  }
}

async function selectDocument(documentId: string) {
  if (documentId === form.id) return
  if (dirty.value && !globalThis.confirm('当前原文尚未保存，确定切换吗？')) return
  error.value = ''
  try {
    const detail = await sourceDocumentApi.get(props.projectId, documentId)
    activeDetail.value = detail
    assignDetail(detail)
    const candidates = await structureCandidateApi.list(props.projectId)
    candidate.value = candidates.find((item) => item.documentId === documentId) ?? null
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : '原文资料读取失败'
  }
}

function assignDetail(detail: SourceDocumentDetail) {
  form.id = detail.document.id
  form.title = detail.document.title
  form.sourceType = detail.document.sourceType
  form.content = detail.content
  form.version = detail.document.version
  form.revisionId = detail.document.revisionId
}

function newDocument() {
  activeDetail.value = null
  candidate.value = null
  form.id = ''
  form.title = ''
  form.sourceType = 'NOVEL'
  form.content = ''
  form.version = 0
  form.revisionId = ''
  error.value = ''
  notice.value = ''
}

async function saveDocument() {
  if (saving.value) return
  if (!form.title.trim() || !form.content.trim()) {
    error.value = '标题和原文内容不能为空'
    return
  }
  saving.value = true
  error.value = ''
  notice.value = ''
  try {
    const input = {
      title: form.title.trim(),
      sourceType: form.sourceType,
      content: form.content,
      ...(form.id ? { version: form.version } : {}),
    }
    const detail = form.id
      ? await sourceDocumentApi.update(props.projectId, form.id, input)
      : await sourceDocumentApi.create(props.projectId, input)
    activeDetail.value = detail
    assignDetail(detail)
    documents.value = await sourceDocumentApi.list(props.projectId)
    notice.value = `已保存第 ${detail.document.revisionNo} 个版本`
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : '原文保存失败'
  } finally {
    saving.value = false
  }
}

async function deleteDocument() {
  if (!form.id || !globalThis.confirm(`确定删除原文“${form.title}”吗？`)) return
  try {
    await sourceDocumentApi.delete(props.projectId, form.id)
    await loadDocuments()
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : '原文删除失败'
  }
}

async function importTextFile(event: unknown) {
  const input = (
    event as {
      target: {
        files?: ArrayLike<{
          name: string
          size: number
          text: () => Promise<string>
        }> | null
        value: string
      }
    }
  ).target
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  const extension = file.name.toLowerCase().split('.').pop()
  if (!['txt', 'md', 'markdown'].includes(extension ?? '')) {
    error.value = '首期只支持 TXT 和 Markdown 文件'
    return
  }
  if (file.size > 40 * 1024 * 1024) {
    error.value = '文件过大，单份原文不能超过 1000 万字符'
    return
  }
  const content = await file.text()
  if (content.length > 10_000_000) {
    error.value = '单份原文不能超过 1000 万字符'
    return
  }
  form.content = content
  if (!form.title.trim()) form.title = file.name.replace(/\.(txt|md|markdown)$/i, '')
  error.value = ''
}

function openGeneration() {
  if (!canGenerate.value) {
    error.value = dirty.value ? '请先保存当前原文，再进行系统分集' : '请先保存原文资料'
    return
  }
  error.value = ''
  void createStructure()
}

async function createStructure() {
  if (!form.revisionId || generating.value) return
  generating.value = true
  error.value = ''
  notice.value = ''
  try {
    const materialized = await structureCandidateApi.systemSplit(
      props.projectId,
      {
        documentId: form.id,
        episodeCountMode: generationOptions.episodeCountMode,
        targetEpisodeCount: generationOptions.targetEpisodeCount,
        targetCharactersPerEpisode: 5_000,
        targetDurationSec: generationOptions.targetDurationSec,
      },
      globalThis.crypto.randomUUID(),
    )
    candidate.value = materialized
    showCandidateDialog.value = true
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : '系统分集失败'
  } finally {
    generating.value = false
  }
}

async function applyCandidate(input: Parameters<typeof structureCandidateApi.apply>[2]) {
  if (!candidate.value || applying.value) return
  applying.value = true
  error.value = ''
  try {
    const summary = await structureCandidateApi.apply(
      props.projectId,
      candidate.value.id,
      input,
      globalThis.crypto.randomUUID(),
    )
    showCandidateDialog.value = false
    notice.value = `已新增 ${Object.keys(summary.createdEpisodes).length} 集、${Object.keys(summary.createdCharacters).length} 个角色和 ${summary.createdSceneIds.length} 个场景`
    await Promise.all([workspace.load(props.projectId), loadDocuments(form.id)])
    emit('applied')
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : '候选应用失败'
  } finally {
    applying.value = false
  }
}
</script>

<template>
  <section class="source-workspace" :class="{ compact: props.compact }">
    <aside class="source-list">
      <header>
        <strong>原文资料</strong>
        <button class="icon-button compact" type="button" title="新建原文" @click="newDocument">
          <Plus :size="16" />
        </button>
      </header>
      <button
        v-for="document in documents"
        :key="document.id"
        class="source-list-item"
        :class="{ active: document.id === form.id }"
        type="button"
        @click="selectDocument(document.id)"
      >
        <span>
          {{ document.sourceType === 'NOVEL' ? '小说' : '剧本' }} · V{{ document.revisionNo }}
        </span>
        <strong>{{ document.title }}</strong>
        <small>{{ document.characterCount.toLocaleString() }} 字 · {{ document.chunkCount }} 段</small>
      </button>
      <div v-if="!documents.length && !loading" class="source-list-empty">
        <FilePlus2 :size="26" /><span>暂无原文资料</span>
      </div>
    </aside>

    <main class="source-editor">
      <header class="source-editor-toolbar">
        <div class="source-title-fields">
          <input
            v-model="form.title"
            maxlength="160"
            placeholder="原文标题"
            aria-label="原文标题"
          />
          <select v-model="form.sourceType" aria-label="原文类型">
            <option value="NOVEL">小说原文</option>
            <option value="SCRIPT">已有剧本</option>
          </select>
        </div>
        <div class="row-actions">
          <input
            ref="fileInput"
            class="visually-hidden"
            type="file"
            accept=".txt,.md,.markdown,text/plain,text/markdown"
            @change="importTextFile"
          />
          <button class="button" type="button" @click="fileInput?.click()">
            <FileUp :size="16" />导入文本
          </button>
          <button class="button primary" type="button" :disabled="saving" @click="saveDocument">
            <Save :size="16" />{{ saving ? '保存中...' : '保存版本' }}
          </button>
        </div>
      </header>
      <label class="source-content-field">
        <span>原文内容</span>
        <textarea v-model="form.content" maxlength="10000000" placeholder="粘贴小说或剧本内容..." />
      </label>
      <footer class="source-editor-status">
        <span>{{ form.content.length.toLocaleString() }} / 10,000,000 字</span>
        <span v-if="activeDetail">
          V{{ activeDetail.document.revisionNo }} · {{ activeDetail.document.chunkCount }} 段
        </span>
        <span>{{ dirty ? '有未保存修改' : '已保存' }}</span>
      </footer>
    </main>

    <aside class="source-analysis-panel">
      <header>
        <div>
          <p>长文分集</p>
          <h2>完整剧情拆分参数</h2>
        </div>
        <button
          v-if="form.id"
          class="icon-button danger"
          type="button"
          title="删除原文"
          @click="deleteDocument"
        >
          <Trash2 :size="17" />
        </button>
      </header>
      <label>
        <span><BookOpenText :size="15" />分集方式</span>
        <select v-model="generationOptions.episodeCountMode">
          <option value="AUTO">按章节和原文长度自动分集</option>
          <option value="FIXED">指定固定集数</option>
        </select>
        <small v-if="generationOptions.episodeCountMode === 'AUTO'">
          当前原文预计约 {{ estimatedEpisodeCount }} 集，系统只切分原文，不摘要、不改写
        </small>
      </label>
      <label v-if="generationOptions.episodeCountMode === 'FIXED'">
        <span><BookOpenText :size="15" />固定集数</span>
        <input
          v-model.number="generationOptions.targetEpisodeCount"
          type="number"
          min="1"
          max="2000"
        />
      </label>
      <label>
        <span><Clock3 :size="15" />每集时长（秒）</span>
        <input
          v-model.number="generationOptions.targetDurationSec"
          type="number"
          min="15"
          max="600"
        />
      </label>
      <button
        class="button primary source-generate-button"
        type="button"
        :disabled="!canGenerate"
        @click="openGeneration"
      >
        <BookOpenText :size="17" />{{ generating ? '正在按原文分集...' : '按原文分集' }}
      </button>
      <button
        v-if="candidate?.status === 'READY'"
        class="button"
        type="button"
        @click="showCandidateDialog = true"
      >
        审核最近候选
      </button>
      <div v-if="candidate?.status === 'APPLIED'" class="source-applied-state">最近候选已应用</div>
      <p class="source-batch-hint">
        分集资料保留原文全部内容，后续可单独使用“AI 生成剧本”进行改编；系统分集不会调用模型。
      </p>
      <p v-if="error" class="form-error">{{ error }}</p>
      <p v-if="notice" class="form-success">{{ notice }}</p>
    </aside>
  </section>

  <StructureCandidateDialog
    :open="showCandidateDialog"
    :candidate="candidate"
    :characters="workspace.characters"
    :applying="applying"
    @close="showCandidateDialog = false"
    @apply="applyCandidate"
  />
</template>
