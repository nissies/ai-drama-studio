<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import { ArrowRight, Clapperboard, Grid2X2, List, Plus, Search, Trash2, X } from 'lucide-vue-next'
import StudioShell from '../layouts/StudioShell.vue'
import { useProjectsStore } from '../stores/projects'
import { router } from '../router'
import {
  PROJECT_ASPECT_RATIO_OPTIONS,
  projectAspectRatioLabel,
  type ProjectAspectRatio,
} from '../domain/project-aspect-ratios'
import {
  VISUAL_STYLE_PRESETS,
  resolveVisualStyle,
  visualStyleLabel,
} from '../domain/production-visual-style'

type ProjectFilter = 'ALL' | 'DRAFT' | 'ACTIVE' | 'DONE'

const route = useRoute()
const projects = useProjectsStore()
const showCreate = ref(false)
const creating = ref(false)
const deletingId = ref('')
const createError = ref('')
const pageNotice = ref('')
const query = ref('')
const filter = ref<ProjectFilter>('ALL')
const view = ref<'list' | 'grid'>('list')
const form = reactive({
  title: '',
  description: '',
  visualStyle: '',
  aspectRatio: 'UNSET' as ProjectAspectRatio,
})
const selectedVisualStyle = computed(() =>
  form.visualStyle ? resolveVisualStyle(form.visualStyle) : undefined,
)
const shortDramaWorkflow = [
  {
    title: '新建项目',
    body: '填写项目名和简介，选择画幅与视觉风格。',
    tip: '竖屏短剧通常选择 9:16。',
  },
  {
    title: '完成剧本',
    body: '在“剧本”中粘贴、编写或用 AI 生成分集内容。',
    tip: '剧情、人物关系和台词越清楚，分镜越准确。',
  },
  {
    title: '准备角色与场景',
    body: '生成或上传角色基础图、场景背景图，并按需生成一次视觉圣经。',
    tip: '这些素材会自动成为后续图片和视频的参考。',
  },
  {
    title: '分镜详细修改',
    body: '在“分镜”中拆解剧情，并逐镜检查角色、场景、动作、台词、时长和提示词。',
    tip: '这里用于精修单个镜头，也可以单独生成关键帧、视频和配音。',
  },
  {
    title: '批量快速生成',
    body: '在“批量视频”中一次选择多个分镜、声音方式和模型，统一提交生成。',
    tip: '不需要逐个打开镜头；失败项可以单独重试，失败不扣点。',
  },
  {
    title: '连续预览与导出',
    body: '在“合成与导出”连续播放全部镜头，确认后添加字幕并导出整集。',
    tip: '连续预览不会生成新文件；“导出整集”才会真正合并视频。',
  },
]

const filteredProjects = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return projects.items.filter((project) => {
    const matchesKeyword =
      !keyword ||
      project.title.toLowerCase().includes(keyword) ||
      project.description?.toLowerCase().includes(keyword)
    const matchesFilter = filter.value === 'ALL' || project.status === filter.value
    return matchesKeyword && matchesFilter
  })
})

onMounted(() => {
  const storedNotice = globalThis.sessionStorage?.getItem('ai-drama-project-required-notice')
  pageNotice.value = storedNotice || String(route.query.notice || '')
  globalThis.sessionStorage?.removeItem('ai-drama-project-required-notice')
  void projects.load()
})

function openCreate() {
  form.title = ''
  form.description = ''
  form.visualStyle = ''
  form.aspectRatio = 'UNSET'
  createError.value = ''
  showCreate.value = true
}

async function createProject() {
  if (!form.title.trim() || creating.value) return
  creating.value = true
  createError.value = ''
  try {
    const project = await projects.create(form)
    showCreate.value = false
    await router.push({ name: 'workspace', params: { projectId: project.id } })
  } catch (error) {
    createError.value = error instanceof Error ? error.message : '项目创建失败'
  } finally {
    creating.value = false
  }
}

async function deleteProject(projectId: string, title: string) {
  if (deletingId.value) return
  if (
    !globalThis.confirm(`确定删除项目“${title}”吗？相关剧本、角色、场景和任务将一并从工作台移除。`)
  )
    return
  deletingId.value = projectId
  projects.error = ''
  try {
    await projects.delete(projectId)
  } catch (error) {
    projects.error = error instanceof Error ? error.message : '项目删除失败'
  } finally {
    deletingId.value = ''
  }
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function statusLabel(status: string) {
  if (status === 'DONE') return '已完成'
  if (status === 'ACTIVE') return '制作中'
  return '草稿'
}
</script>

<template>
  <StudioShell>
    <header class="page-header brand-page-hero projects-header">
      <div>
        <h1>短剧项目</h1>
        <p>管理本地优先的短剧制作项目</p>
      </div>
      <div class="header-actions">
        <button class="button primary" type="button" @click="openCreate">
          <Plus :size="17" />新建项目
        </button>
        <label class="search-control"
          ><Search :size="16" /><input v-model="query" placeholder="搜索项目名称"
        /></label>
        <select v-model="filter" class="compact-select" aria-label="项目状态">
          <option value="ALL">全部状态</option>
          <option value="DRAFT">草稿</option>
          <option value="ACTIVE">制作中</option>
          <option value="DONE">已完成</option>
        </select>
        <div class="view-switch" aria-label="项目视图">
          <button
            type="button"
            :class="{ active: view === 'list' }"
            title="列表视图"
            @click="view = 'list'"
          >
            <List :size="17" />
          </button>
          <button
            type="button"
            :class="{ active: view === 'grid' }"
            title="网格视图"
            @click="view = 'grid'"
          >
            <Grid2X2 :size="17" />
          </button>
        </div>
      </div>
    </header>

    <p v-if="pageNotice" class="inline-warning project-route-notice">
      {{ pageNotice }}，请先选择或新建项目。
    </p>

    <section class="quickstart-card" aria-labelledby="quickstart-title">
      <div class="quickstart-intro">
        <p class="eyebrow">快速上手</p>
        <h2 id="quickstart-title">一条流程生成短剧</h2>
        <p>
          简单六步：准备项目和剧本，补齐角色与场景，在分镜页详细修改，再到批量视频快速生成，最后连续预览并导出成片。
        </p>
        <div class="quickstart-actions">
          <button class="button primary" type="button" @click="openCreate">
            <Plus :size="16" />新建项目开始
          </button>
          <RouterLink class="button" to="/chat">用聊天生成项目</RouterLink>
        </div>
      </div>
      <div class="quickstart-flow">
        <article v-for="(step, index) in shortDramaWorkflow" :key="step.title">
          <span>{{ index + 1 }}</span>
          <div>
            <strong>{{ step.title }}</strong>
            <p>{{ step.body }}</p>
            <small>{{ step.tip }}</small>
          </div>
        </article>
      </div>
    </section>

    <section class="projects-content">
      <div class="project-filters" role="tablist" aria-label="项目筛选">
        <button :class="{ active: filter === 'ALL' }" @click="filter = 'ALL'">
          全部项目 <span>{{ projects.items.length }}</span>
        </button>
        <button :class="{ active: filter === 'ACTIVE' }" @click="filter = 'ACTIVE'">
          制作中 <span>{{ projects.items.filter((item) => item.status === 'ACTIVE').length }}</span>
        </button>
        <button :class="{ active: filter === 'DRAFT' }" @click="filter = 'DRAFT'">
          草稿 <span>{{ projects.items.filter((item) => item.status === 'DRAFT').length }}</span>
        </button>
        <button :class="{ active: filter === 'DONE' }" @click="filter = 'DONE'">
          已完成 <span>{{ projects.items.filter((item) => item.status === 'DONE').length }}</span>
        </button>
      </div>

      <p v-if="projects.error" class="inline-error">{{ projects.error }}</p>
      <div v-if="projects.loading" class="empty-state">正在加载项目...</div>
      <div v-else-if="filteredProjects.length === 0" class="empty-state project-empty">
        <Clapperboard :size="34" /><strong>{{
          projects.items.length ? '没有符合条件的项目' : '还没有项目'
        }}</strong>
        <span v-if="!projects.items.length">新建第一个项目，开始短剧制作流程</span>
        <button v-if="!projects.items.length" class="button primary" @click="openCreate">
          <Plus :size="16" />新建第一个项目
        </button>
      </div>

      <div v-else-if="view === 'list'" class="table-wrap project-table">
        <table>
          <thead>
            <tr>
              <th>项目名称</th>
              <th>视觉风格</th>
              <th>画幅</th>
              <th>状态</th>
              <th>最近更新时间</th>
              <th aria-label="操作" />
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="project in filteredProjects"
              :key="project.id"
              @click="router.push(`/projects/${project.id}`)"
            >
              <td>
                <div class="project-name-cell">
                  <span class="project-thumb"><Clapperboard :size="22" /></span>
                  <div>
                    <strong>{{ project.title }}</strong
                    ><span v-if="project.storageMode === 'LOCAL'" class="project-storage-badge"
                      >本地</span
                    ><small>{{ project.description || '暂无项目简介' }}</small>
                  </div>
                </div>
              </td>
              <td>{{ project.visualStyle ? visualStyleLabel(project.visualStyle) : '未设置' }}</td>
              <td>{{ projectAspectRatioLabel(project.aspectRatio) }}</td>
              <td>
                <span class="status-badge" :class="project.status.toLowerCase()">{{
                  statusLabel(project.status)
                }}</span>
              </td>
              <td>{{ formatTime(project.updatedAt) }}</td>
              <td>
                <div class="row-actions">
                  <button
                    class="icon-button compact"
                    type="button"
                    title="打开项目"
                    @click.stop="router.push(`/projects/${project.id}`)"
                  >
                    <ArrowRight :size="16" /></button
                  ><button
                    class="icon-button compact danger"
                    type="button"
                    title="删除项目"
                    :disabled="Boolean(deletingId)"
                    @click.stop="deleteProject(project.id, project.title)"
                  >
                    <Trash2 :size="15" />
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-else class="project-card-grid">
        <article
          v-for="project in filteredProjects"
          :key="project.id"
          @click="router.push(`/projects/${project.id}`)"
        >
          <div class="project-card-cover"><Clapperboard :size="34" /></div>
          <div class="project-card-body">
            <header>
              <strong>{{ project.title }}</strong
              ><span v-if="project.storageMode === 'LOCAL'" class="project-storage-badge">本地</span>
              <div class="row-actions">
                <span class="status-badge" :class="project.status.toLowerCase()">{{
                  statusLabel(project.status)
                }}</span
                ><button
                  class="icon-button compact danger"
                  type="button"
                  title="删除项目"
                  :disabled="Boolean(deletingId)"
                  @click.stop="deleteProject(project.id, project.title)"
                >
                  <Trash2 :size="15" />
                </button>
              </div>
            </header>
            <p>{{ project.description || '暂无项目简介' }}</p>
            <footer>
              <span>{{
                project.visualStyle ? visualStyleLabel(project.visualStyle) : '未设置风格'
              }}</span
              ><span>{{ projectAspectRatioLabel(project.aspectRatio) }}</span
              ><span>{{ formatTime(project.updatedAt) }}</span>
            </footer>
          </div>
        </article>
      </div>
    </section>

    <div v-if="showCreate" class="modal-backdrop" @click.self="showCreate = false">
      <section
        class="modal project-create-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-title"
      >
        <header>
          <h2 id="create-title">新建短剧项目</h2>
          <button class="icon-button" title="关闭" type="button" @click="showCreate = false">
            <X :size="18" />
          </button>
        </header>
        <form @submit.prevent="createProject">
          <label>项目名称<input v-model="form.title" maxlength="120" autofocus required /></label>
          <label class="visual-style-field"
            >视觉风格<select v-model="form.visualStyle" required>
              <option disabled value="">请选择项目视觉风格</option>
              <option v-for="preset in VISUAL_STYLE_PRESETS" :key="preset.id" :value="preset.id">
                {{ preset.label }}
              </option>
            </select>
            <small v-if="selectedVisualStyle" class="field-help">{{
              selectedVisualStyle.description
            }}</small>
            <small v-if="selectedVisualStyle?.moderationNotice" class="field-warning">{{
              selectedVisualStyle.moderationNotice
            }}</small>
          </label>
          <label>
            项目画幅
            <select v-model="form.aspectRatio">
              <option
                v-for="option in PROJECT_ASPECT_RATIO_OPTIONS"
                :key="option.value"
                :value="option.value"
              >
                {{ option.label }}
              </option>
            </select>
          </label>
          <label>项目简介<textarea v-model="form.description" rows="4" maxlength="2000" /></label>
          <p v-if="createError" class="form-error">{{ createError }}</p>
          <footer>
            <button class="button" type="button" @click="showCreate = false">取消</button
            ><button class="button primary" type="submit" :disabled="creating">
              <Plus :size="17" />{{ creating ? '创建中' : '创建项目' }}
            </button>
          </footer>
        </form>
      </section>
    </div>
  </StudioShell>
</template>
