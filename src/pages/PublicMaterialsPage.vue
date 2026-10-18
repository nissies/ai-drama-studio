<script setup lang="ts">
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Download,
  FileText,
  Image as ImageIcon,
  Library,
  LoaderCircle,
  Mic,
  Plus,
  RefreshCw,
  Send,
  Upload,
  X,
} from 'lucide-vue-next'
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { getStoredToken } from '../api/client'
import {
  PUBLIC_MATERIAL_RIGHTS_TEXT,
  PUBLIC_MATERIAL_STATUS_LABEL,
  PUBLIC_MATERIAL_TYPE_LABEL,
  publicMaterialApi,
  type ComplaintRightsType,
  type PublicMaterialItem,
  type PublicMaterialStatus,
  type PublicMaterialSubmission,
  type PublicMaterialType,
} from '../api/public-materials'
import StudioShell from '../layouts/StudioShell.vue'

type MainTab = 'catalog' | 'mine'
type CatalogType = PublicMaterialType

const mainTab = ref<MainTab>('catalog')
const catalogType = ref<CatalogType>('IMAGE')
const query = ref('')
const page = ref(1)
const pageSize = 24
const total = ref(0)
const items = ref<PublicMaterialItem[]>([])
const submissions = ref<PublicMaterialSubmission[]>([])
const submissionStatus = ref<PublicMaterialStatus | ''>('')
const submissionPage = ref(1)
const submissionTotal = ref(0)
const loading = ref(false)
const downloadingId = ref('')
const submitting = ref(false)
const error = ref('')
const notice = ref('')
const mediaUrls = ref<Record<string, string>>({})
const submitOpen = ref(false)
const submitType = ref<PublicMaterialType>('IMAGE')

const form = reactive({
  title: '',
  description: '',
  tags: '',
  contentText: '',
  rightsAccepted: false,
})
const selectedFile = ref<File | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

const complaintOpen = ref(false)
const complaintTarget = ref<PublicMaterialItem | null>(null)
const complaintSubmitting = ref(false)
const complaintError = ref('')
const complaintForm = reactive({
  complainantName: '',
  complainantContact: '',
  rightsType: 'COPYRIGHT' as ComplaintRightsType,
  statement: '',
  evidenceDescription: '',
})

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)))
const submissionPages = computed(() => Math.max(1, Math.ceil(submissionTotal.value / 20)))
const typeTabs: { value: CatalogType; label: string; icon: typeof ImageIcon; hint: string }[] = [
  { value: 'IMAGE', label: '图片', icon: ImageIcon, hint: 'PNG / JPG / WEBP' },
  { value: 'TEXT', label: '文本', icon: FileText, hint: '台词、旁白、提示词' },
  { value: 'AUDIO', label: '音频素材', icon: Mic, hint: 'MP3 / WAV，音效、环境声、旁白或台词' },
]
const currentTypeMeta = computed(
  () => typeTabs.find((item) => item.value === catalogType.value) || typeTabs[0],
)
const submitTypeMeta = computed(
  () => typeTabs.find((item) => item.value === submitType.value) || typeTabs[0],
)

onMounted(() => void loadCatalog())
onBeforeUnmount(() => revokeMediaUrls())

watch(mainTab, (tab) => {
  if (tab === 'catalog') void loadCatalog()
  if (tab === 'mine') void loadSubmissions()
})
watch(catalogType, () => {
  page.value = 1
  if (mainTab.value === 'catalog') void loadCatalog()
})

async function loadCatalog() {
  loading.value = true
  error.value = ''
  try {
    const result = await publicMaterialApi.list({
      page: page.value,
      pageSize,
      materialType: catalogType.value,
      query: query.value.trim() || undefined,
    })
    items.value = result.items
    total.value = result.total
    await resolveMediaUrls(result.items)
  } catch (cause) {
    items.value = []
    total.value = 0
    revokeMediaUrls()
    error.value = errorMessage(cause, '公共素材加载失败')
  } finally {
    loading.value = false
  }
}

function revokeMediaUrls() {
  Object.values(mediaUrls.value).forEach((url) => URL.revokeObjectURL(url))
  mediaUrls.value = {}
}

async function resolveMediaUrls(list: PublicMaterialItem[]) {
  revokeMediaUrls()
  const token = getStoredToken()
  const next: Record<string, string> = {}
  const failures: string[] = []
  await Promise.all(
    list
      .filter((item) => item.materialType === 'IMAGE' || item.materialType === 'AUDIO')
      .map(async (item) => {
        try {
          const response = await fetch(publicMaterialApi.fileUrl(item.id), {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          })
          if (!response.ok) {
            failures.push(
              `「${item.title}」预览失败：${await readErrorMessage(response, `HTTP ${response.status}`)}`,
            )
            return
          }
          const blob = await response.blob()
          if (!blob.size) {
            failures.push(`「${item.title}」预览失败：文件为空`)
            return
          }
          next[item.id] = URL.createObjectURL(blob)
        } catch (cause) {
          failures.push(`「${item.title}」预览失败：${errorMessage(cause, '网络异常')}`)
        }
      }),
  )
  mediaUrls.value = next
  if (failures.length && !error.value) {
    error.value = failures.slice(0, 3).join('；') + (failures.length > 3 ? ` 等 ${failures.length} 项` : '')
  }
}

async function loadSubmissions() {
  loading.value = true
  error.value = ''
  try {
    const result = await publicMaterialApi.mySubmissions({
      page: submissionPage.value,
      pageSize: 20,
      status: submissionStatus.value,
    })
    submissions.value = result.items
    submissionTotal.value = result.total
  } catch (cause) {
    submissions.value = []
    submissionTotal.value = 0
    error.value = errorMessage(cause, '投稿记录加载失败')
  } finally {
    loading.value = false
  }
}

function applyCatalogFilters() {
  page.value = 1
  void loadCatalog()
}
function changePage(next: number) {
  if (next < 1 || next > totalPages.value || next === page.value) return
  page.value = next
  void loadCatalog()
}
function changeSubmissionPage(next: number) {
  if (next < 1 || next > submissionPages.value || next === submissionPage.value) return
  submissionPage.value = next
  void loadSubmissions()
}

function openSubmit(type?: PublicMaterialType) {
  submitType.value = type || catalogType.value
  resetSubmitForm()
  submitOpen.value = true
}
function closeSubmit() {
  if (!submitting.value) submitOpen.value = false
}
function resetSubmitForm() {
  form.title = ''
  form.description = ''
  form.tags = ''
  form.contentText = ''
  form.rightsAccepted = false
  selectedFile.value = null
  if (fileInput.value) fileInput.value.value = ''
}
function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  selectedFile.value = input.files?.[0] ?? null
}

async function submitMaterial() {
  if (!form.title.trim()) {
    error.value = '请填写标题'
    return
  }
  if (!form.rightsAccepted) {
    error.value = '请先勾选权利承诺'
    return
  }
  if (submitType.value === 'TEXT' && !form.contentText.trim()) {
    error.value = '请填写文本内容'
    return
  }
  if (submitType.value !== 'TEXT' && !selectedFile.value) {
    error.value = '请选择要上传的文件'
    return
  }
  submitting.value = true
  error.value = ''
  notice.value = ''
  try {
    if (submitType.value === 'TEXT') {
      await publicMaterialApi.submitText({
        title: form.title.trim(),
        description: form.description.trim() || undefined,
        category: PUBLIC_MATERIAL_TYPE_LABEL[submitType.value],
        tags: form.tags.split(/[,，]/).map((i) => i.trim()).filter(Boolean),
        contentText: form.contentText.trim(),
        rightsAccepted: true,
      })
    } else {
      await publicMaterialApi.submitFile({
        materialType: submitType.value,
        title: form.title.trim(),
        description: form.description.trim() || undefined,
        category: PUBLIC_MATERIAL_TYPE_LABEL[submitType.value],
        tags: form.tags.trim() || undefined,
        rightsAccepted: true,
        file: selectedFile.value!,
      })
    }
    notice.value = '已提交审核，通过后会公开到对应分类'
    resetSubmitForm()
    submitOpen.value = false
    mainTab.value = 'mine'
    submissionStatus.value = 'PENDING_REVIEW'
    submissionPage.value = 1
    await loadSubmissions()
  } catch (cause) {
    error.value = errorMessage(cause, '投稿失败')
  } finally {
    submitting.value = false
  }
}

function openComplaint(item: PublicMaterialItem) {
  complaintTarget.value = item
  complaintForm.complainantName = ''
  complaintForm.complainantContact = ''
  complaintForm.rightsType = item.materialType === 'AUDIO' ? 'VOICE' : 'COPYRIGHT'
  complaintForm.statement = ''
  complaintForm.evidenceDescription = ''
  complaintError.value = ''
  complaintOpen.value = true
}
function closeComplaint() {
  if (!complaintSubmitting.value) complaintOpen.value = false
}
async function submitComplaint() {
  if (!complaintTarget.value) return
  if (!complaintForm.complainantName.trim() || !complaintForm.complainantContact.trim() || !complaintForm.statement.trim()) {
    complaintError.value = '投诉人、联系方式和声明不能为空'
    return
  }
  complaintSubmitting.value = true
  complaintError.value = ''
  try {
    await publicMaterialApi.submitComplaint(complaintTarget.value.id, {
      complainantName: complaintForm.complainantName.trim(),
      complainantContact: complaintForm.complainantContact.trim(),
      rightsType: complaintForm.rightsType,
      statement: complaintForm.statement.trim(),
      evidenceDescription: complaintForm.evidenceDescription.trim() || undefined,
    })
    complaintOpen.value = false
    notice.value = '投诉已提交，素材已下架'
    await loadCatalog()
  } catch (cause) {
    complaintError.value = errorMessage(cause, '投诉失败')
  } finally {
    complaintSubmitting.value = false
  }
}

async function downloadMaterial(item: PublicMaterialItem) {
  if (item.materialType === 'TEXT') {
    await copyTextMaterial(item)
    return
  }
  if (downloadingId.value) return
  downloadingId.value = item.id
  error.value = ''
  notice.value = ''
  try {
    const token = getStoredToken()
    const response = await fetch(publicMaterialApi.fileUrl(item.id, true), {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (!response.ok) {
      throw new Error(await readErrorMessage(response, '素材下载失败'))
    }
    const blob = await response.blob()
    const objectUrl = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = objectUrl
    anchor.download = downloadFilename(item, response)
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(objectUrl)
    notice.value = `已开始下载「${item.title}」`
  } catch (cause) {
    error.value = errorMessage(cause, '素材下载失败')
  } finally {
    downloadingId.value = ''
  }
}

async function copyTextMaterial(item: PublicMaterialItem) {
  const content = item.contentText?.trim()
  if (!content) {
    error.value = '该文本素材没有可复制内容'
    return
  }
  error.value = ''
  notice.value = ''
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(content)
    } else {
      const area = document.createElement('textarea')
      area.value = content
      area.setAttribute('readonly', 'true')
      area.style.position = 'fixed'
      area.style.left = '-9999px'
      document.body.appendChild(area)
      area.select()
      document.execCommand('copy')
      area.remove()
    }
    notice.value = `已复制「${item.title}」文本内容`
  } catch {
    error.value = '复制失败，请手动选择文本'
  }
}

function downloadFilename(item: PublicMaterialItem, response: Response) {
  const disposition = response.headers.get('Content-Disposition') || ''
  const utfMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i)
  if (utfMatch?.[1]) {
    try {
      return decodeURIComponent(utfMatch[1].trim().replace(/^"|"$/g, ''))
    } catch {
      // fall through
    }
  }
  const plainMatch = disposition.match(/filename="?([^";]+)"?/i)
  if (plainMatch?.[1]) return plainMatch[1]
  if (item.originalFilename?.trim()) return item.originalFilename.trim()
  const ext =
    item.materialType === 'AUDIO'
      ? item.mimeType?.includes('wav')
        ? '.wav'
        : '.mp3'
      : item.mimeType?.includes('png')
        ? '.png'
        : item.mimeType?.includes('webp')
          ? '.webp'
          : '.jpg'
  return `${item.title.trim() || 'public-material'}${ext}`
}

async function readErrorMessage(response: Response, fallback: string) {
  try {
    const payload = (await response.json()) as {
      message?: string
      error?: string | { code?: string; message?: string } | null
    }
    if (typeof payload.message === 'string' && payload.message.trim()) return payload.message
    if (typeof payload.error === 'string' && payload.error.trim()) return payload.error
    if (payload.error && typeof payload.error === 'object' && typeof payload.error.message === 'string') {
      return payload.error.message
    }
    return fallback
  } catch {
    return fallback
  }
}

function errorMessage(cause: unknown, fallback: string) {
  if (cause instanceof Error && cause.message.trim()) return cause.message
  if (typeof cause === 'string' && cause.trim()) return cause
  if (cause && typeof cause === 'object') {
    const record = cause as { message?: unknown; error?: unknown }
    if (typeof record.message === 'string' && record.message.trim()) return record.message
    if (typeof record.error === 'string' && record.error.trim()) return record.error
    if (record.error && typeof record.error === 'object') {
      const nested = record.error as { message?: unknown }
      if (typeof nested.message === 'string' && nested.message.trim()) return nested.message
    }
  }
  return fallback
}

function fileSrc(item: PublicMaterialItem) {
  return mediaUrls.value[item.id] || ''
}
function formatSize(value?: number | null) {
  if (!value) return '--'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}
function formatDateTime(value?: string | null) {
  if (!value) return '--'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}
function statusTone(status: PublicMaterialStatus) {
  return { PENDING_REVIEW: 'warning', PUBLISHED: 'positive', REJECTED: 'danger', OFFLINE: 'neutral' }[status]
}
function acceptForType(type: PublicMaterialType) {
  if (type === 'IMAGE') return 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp'
  if (type === 'AUDIO') return 'audio/mpeg,audio/wav,.mp3,.wav'
  return ''
}
</script>

<template>
  <StudioShell>
    <header class="page-header brand-page-hero public-material-header">
      <div>
        <h1>公共素材区</h1>
        <p>浏览公开素材，或投稿图片 / 文本 / 音频素材。</p>
      </div>
      <div class="header-actions">
        <button class="icon-button" type="button" title="刷新" :disabled="loading" @click="mainTab === 'mine' ? loadSubmissions() : loadCatalog()">
          <RefreshCw :size="17" :class="{ spin: loading }" />
        </button>
        <button class="button primary" type="button" @click="openSubmit()">
          <Plus :size="16" />投稿素材
        </button>
      </div>
    </header>

    <section class="public-material-tabs" aria-label="公共素材视图">
      <button type="button" :class="{ active: mainTab === 'catalog' }" @click="mainTab = 'catalog'">
        <Library :size="16" />素材库
      </button>
      <button type="button" :class="{ active: mainTab === 'mine' }" @click="mainTab = 'mine'">
        <Send :size="16" />我的投稿
      </button>
    </section>

    <main class="public-material-content">
      <p v-if="notice" class="inline-success" role="status"><CheckCircle2 :size="15" />{{ notice }}</p>
      <p v-if="error" class="inline-error" role="alert">{{ error }}</p>

      <template v-if="mainTab === 'catalog'">
        <div class="public-type-text-tabs" role="tablist" aria-label="素材分类">
          <button
            v-for="tab in typeTabs"
            :key="tab.value"
            type="button"
            :class="{ active: catalogType === tab.value }"
            @click="catalogType = tab.value"
          >
            {{ tab.label }}
          </button>
        </div>

        <form class="public-filter-bar" @submit.prevent="applyCatalogFilters">
          <input v-model="query" type="search" maxlength="120" :placeholder="`搜索${currentTypeMeta.label}`" />
          <button class="button" type="submit">查询</button>
        </form>

        <div v-if="loading && !items.length" class="empty-state">
          <LoaderCircle class="spin" :size="26" /><strong>正在加载{{ currentTypeMeta.label }}</strong>
        </div>
        <div v-else-if="!items.length" class="empty-state">
          <component :is="currentTypeMeta.icon" :size="28" />
          <strong>暂无公开的{{ currentTypeMeta.label }}</strong>
          <p>审核通过后会显示在这里。</p>
          <button class="button primary" type="button" @click="openSubmit(catalogType)">投稿{{ currentTypeMeta.label }}</button>
        </div>
        <div v-else class="public-material-grid">
          <article v-for="item in items" :key="item.id" class="public-material-card">
            <div v-if="item.materialType === 'IMAGE'" class="public-preview image">
              <img v-if="fileSrc(item)" :src="fileSrc(item)" :alt="item.title" loading="lazy" />
              <div v-else class="public-preview-fallback"><ImageIcon :size="22" /><span>{{ loading ? '加载中' : '预览失败' }}</span></div>
            </div>
            <div v-else-if="item.materialType === 'AUDIO'" class="public-preview audio">
              <div class="public-audio-head"><Mic :size="18" /><span>音频素材</span></div>
              <audio v-if="fileSrc(item)" controls preload="none" :src="fileSrc(item)" />
              <small v-else>{{ loading ? '音频加载中' : '音频预览失败' }}</small>
              <small>{{ item.originalFilename || '音频文件' }} · {{ formatSize(item.sizeBytes) }}</small>
            </div>
            <div v-else class="public-preview text"><p>{{ item.contentText }}</p></div>
            <div class="public-card-body">
              <h3>{{ item.title }}</h3>
              <p>{{ item.description || '暂无说明' }}</p>
              <div v-if="item.tags?.length" class="public-tag-list">
                <span v-for="tag in item.tags" :key="tag">{{ tag }}</span>
              </div>
              <footer>
                <small>{{ formatDateTime(item.publishedAt) }}</small>
                <div class="public-card-actions">
                  <button
                    class="button compact"
                    type="button"
                    :disabled="downloadingId === item.id"
                    :title="item.materialType === 'TEXT' ? '复制文本' : '下载素材'"
                    @click="downloadMaterial(item)"
                  >
                    <LoaderCircle v-if="downloadingId === item.id" class="spin" :size="14" />
                    <Copy v-else-if="item.materialType === 'TEXT'" :size="14" />
                    <Download v-else :size="14" />
                    {{
                      downloadingId === item.id
                        ? '下载中'
                        : item.materialType === 'TEXT'
                          ? '复制'
                          : '下载'
                    }}
                  </button>
                  <button class="button danger-text" type="button" @click="openComplaint(item)">投诉</button>
                </div>
              </footer>
            </div>
          </article>
        </div>
        <footer v-if="total > pageSize" class="public-pagination">
          <span>共 {{ total }} 条 · 第 {{ page }} / {{ totalPages }} 页</span>
          <div>
            <button class="button" type="button" :disabled="page <= 1 || loading" @click="changePage(page - 1)">上一页</button>
            <button class="button" type="button" :disabled="page >= totalPages || loading" @click="changePage(page + 1)">下一页</button>
          </div>
        </footer>
      </template>

      <section v-else class="public-mine-panel polished full-width">
        <div class="public-mine-toolbar polished">
          <form class="public-filter-bar compact mine-filter polished" @submit.prevent="loadSubmissions">
            <select v-model="submissionStatus" @change="submissionPage = 1; loadSubmissions()">
              <option value="">全部状态</option>
              <option value="PENDING_REVIEW">待审核</option>
              <option value="PUBLISHED">已公开</option>
              <option value="REJECTED">已拒绝</option>
              <option value="OFFLINE">已下架</option>
            </select>
            <button class="button" type="submit">刷新</button>
          </form>
          <button class="button primary" type="button" @click="openSubmit()"><Plus :size="15" />继续投稿</button>
        </div>

        <div v-if="loading && !submissions.length" class="public-mine-empty">
          <LoaderCircle class="spin" :size="26" /><strong>正在加载投稿</strong>
        </div>
        <div v-else-if="!submissions.length" class="public-mine-empty">
          <div class="public-mine-empty-icon"><Send :size="24" /></div>
          <strong>还没有投稿</strong>
          <p>支持投稿图片、文本和音频素材。提交后进入待审核，通过后展示在素材库。</p>
          <div class="public-mine-empty-actions">
            <button class="button primary" type="button" @click="openSubmit('IMAGE')">投稿图片</button>
            <button class="button" type="button" @click="openSubmit('TEXT')">投稿文本</button>
            <button class="button" type="button" @click="openSubmit('AUDIO')">投稿音频</button>
          </div>
        </div>
        <div v-else class="public-mine-list polished">
          <article v-for="item in submissions" :key="item.id" class="public-mine-item polished">
            <div class="public-mine-main">
              <div class="public-mine-badges">
                <span class="public-type-chip">{{ PUBLIC_MATERIAL_TYPE_LABEL[item.materialType] }}</span>
                <span class="public-status-badge" :class="`tone-${statusTone(item.status)}`">
                  {{ PUBLIC_MATERIAL_STATUS_LABEL[item.status] }}
                </span>
              </div>
              <h3>{{ item.title }}</h3>
              <p>{{ item.description || '无说明' }}</p>
              <small>{{ formatDateTime(item.updatedAt) }}</small>
            </div>
            <div v-if="item.reviewNote" class="public-mine-meta">
              <span>审核备注</span>
              <p>{{ item.reviewNote }}</p>
            </div>
          </article>
        </div>
        <footer v-if="submissionTotal > 20" class="public-pagination">
          <span>共 {{ submissionTotal }} 条 · 第 {{ submissionPage }} / {{ submissionPages }} 页</span>
          <div>
            <button class="button" type="button" :disabled="submissionPage <= 1 || loading" @click="changeSubmissionPage(submissionPage - 1)">上一页</button>
            <button class="button" type="button" :disabled="submissionPage >= submissionPages || loading" @click="changeSubmissionPage(submissionPage + 1)">下一页</button>
          </div>
        </footer>
      </section>
    </main>

    <div v-if="submitOpen" class="modal-backdrop" @click.self="closeSubmit">
      <section class="modal public-submit-modal" role="dialog" aria-modal="true">
        <header>
          <div>
            <h2>投稿素材</h2>
            <small>选择分类并填写内容，提交后进入待审核</small>
          </div>
          <button class="icon-button" type="button" :disabled="submitting" @click="closeSubmit"><X :size="18" /></button>
        </header>
        <form class="public-submit-modal-form" @submit.prevent="submitMaterial">
          <div class="public-submit-type-row" role="tablist" aria-label="投稿分类">
            <button
              v-for="tab in typeTabs"
              :key="tab.value"
              type="button"
              :class="{ active: submitType === tab.value }"
              @click="submitType = tab.value"
            >
              {{ tab.label }}
            </button>
          </div>
          <p class="public-submit-hint">{{ submitTypeMeta.hint }}</p>

          <label>标题<input v-model="form.title" type="text" maxlength="160" required placeholder="素材名称" /></label>
          <label>说明（可选）<input v-model="form.description" type="text" maxlength="500" placeholder="使用场景或补充说明" /></label>
          <label>标签（可选）<input v-model="form.tags" type="text" maxlength="200" placeholder="逗号分隔" /></label>

          <label v-if="submitType === 'TEXT'">
            文本内容
            <textarea v-model="form.contentText" rows="8" maxlength="50000" required placeholder="粘贴台词、旁白或文本片段" />
          </label>
          <label v-else class="public-file-drop modal-file">
            <span class="public-file-drop-title">
              <Upload :size="18" />{{ selectedFile ? selectedFile.name : `选择${submitTypeMeta.label}文件` }}
            </span>
            <input ref="fileInput" type="file" :accept="acceptForType(submitType)" required @change="onFileChange" />
            <small v-if="submitType === 'IMAGE'">支持 PNG / JPG / WEBP，最大约 30MB</small>
            <small v-else>支持 MP3 / WAV，可投稿音效、环境声、旁白或角色台词</small>
          </label>

          <label class="rights-box">
            <input v-model="form.rightsAccepted" type="checkbox" />
            <span><strong>权利承诺</strong>{{ PUBLIC_MATERIAL_RIGHTS_TEXT }}</span>
          </label>
          <footer>
            <button class="button" type="button" :disabled="submitting" @click="resetSubmitForm">清空</button>
            <button class="button primary" type="submit" :disabled="submitting">
              <Upload :size="16" />{{ submitting ? '提交中…' : '提交审核' }}
            </button>
          </footer>
        </form>
      </section>
    </div>

    <div v-if="complaintOpen && complaintTarget" class="modal-backdrop" @click.self="closeComplaint">
      <section class="modal public-complaint-modal" role="dialog" aria-modal="true">
        <header>
          <div>
            <h2>提交投诉</h2>
            <small>{{ complaintTarget.title }} · {{ PUBLIC_MATERIAL_TYPE_LABEL[complaintTarget.materialType] }}</small>
          </div>
          <button class="icon-button" type="button" :disabled="complaintSubmitting" @click="closeComplaint"><X :size="18" /></button>
        </header>
        <form @submit.prevent="submitComplaint">
          <p class="modal-note">提交后系统会立即下架该素材，并保留不可删除的投诉与审核记录。</p>
          <label>投诉人姓名/机构<input v-model="complaintForm.complainantName" type="text" maxlength="120" required /></label>
          <label>联系方式<input v-model="complaintForm.complainantContact" type="text" maxlength="255" required /></label>
          <label>
            权利类型
            <select v-model="complaintForm.rightsType">
              <option value="PORTRAIT">肖像权</option>
              <option value="COPYRIGHT">著作权</option>
              <option value="TRADEMARK">商标权</option>
              <option value="VOICE">声音权</option>
              <option value="OTHER">其他</option>
            </select>
          </label>
          <label>投诉声明<textarea v-model="complaintForm.statement" rows="5" maxlength="20000" required /></label>
          <label>证据说明（可选）<textarea v-model="complaintForm.evidenceDescription" rows="3" maxlength="1000" /></label>
          <p v-if="complaintError" class="form-error" role="alert">{{ complaintError }}</p>
          <footer>
            <button class="button" type="button" :disabled="complaintSubmitting" @click="closeComplaint">取消</button>
            <button class="button danger" type="submit" :disabled="complaintSubmitting">
              <AlertTriangle :size="16" />{{ complaintSubmitting ? '提交中…' : '确认投诉' }}
            </button>
          </footer>
        </form>
      </section>
    </div>
  </StudioShell>
</template>
