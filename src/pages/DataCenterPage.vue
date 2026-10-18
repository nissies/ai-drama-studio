<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import {
  BarChart3,
  Coins,
  Database,
  FolderKanban,
  LoaderCircle,
  RefreshCw,
  WalletCards,
} from 'lucide-vue-next'
import ProjectDataPanel from '../components/workspace/ProjectDataPanel.vue'
import { useProjectContextPage } from '../composables/useProjectContextPage'
import StudioShell from '../layouts/StudioShell.vue'

const router = useRouter()
const {
  loadingProject,
  projectError,
  projectReady,
  projects,
  refreshProjects,
  retrySelectedProject,
  selectProject,
  selectedLocalAssetCount,
  selectedProject,
  selectedProjectId,
  workspace,
} = useProjectContextPage('data-center')

const metricRows = computed(() => [
  { label: '分集', value: workspace.episodes.length },
  { label: '角色', value: workspace.characters.length },
  { label: '场景', value: workspace.scenes.length },
  { label: '本地素材', value: selectedLocalAssetCount.value },
])

function openProjectData() {
  if (!selectedProjectId.value) return
  void router.push({
    name: 'workspace',
    params: { projectId: selectedProjectId.value },
    query: { tab: 'data' },
  })
}
</script>

<template>
  <StudioShell :project-title="selectedProject?.title" :project-id="selectedProjectId">
    <header class="page-header brand-page-hero asset-center-header">
      <div>
        <p class="eyebrow">支付与资产 / 数据</p>
        <h1>数据中心</h1>
        <p>数据中心从项目工作台里独立出来，可在这里切换项目查看制作进度、资产分布和任务入口。</p>
      </div>
      <div class="header-actions">
        <button class="button" type="button" :disabled="projects.loading" @click="refreshProjects">
          <RefreshCw :class="{ spin: projects.loading }" :size="16" />刷新项目
        </button>
        <RouterLink class="button" to="/tasks">
          <BarChart3 :size="16" />生成任务
        </RouterLink>
        <RouterLink class="button" to="/credits">
          <WalletCards :size="16" />额度中心
        </RouterLink>
        <button class="button primary" type="button" :disabled="!selectedProjectId" @click="openProjectData">
          <Database :size="16" />打开项目数据页
        </button>
      </div>
    </header>

    <section class="asset-center-layout">
      <aside class="asset-project-rail">
        <header>
          <span>项目范围</span>
          <strong>{{ projects.items.length }} 个项目</strong>
        </header>
        <div v-if="projects.loading && !projects.items.length" class="asset-project-loading">
          <LoaderCircle class="spin" :size="18" />正在加载项目
        </div>
        <button
          v-for="project in projects.items"
          :key="project.id"
          type="button"
          :class="{ active: selectedProjectId === project.id }"
          @click="selectProject(project.id)"
        >
          <strong>{{ project.title }}</strong>
          <small>{{ project.description || '暂无项目简介' }}</small>
        </button>
      </aside>

      <main class="asset-center-main">
        <div class="asset-center-summary">
          <article v-for="row in metricRows" :key="row.label">
            <span><Coins v-if="row.label === '本地素材'" :size="16" /><FolderKanban v-else :size="16" />{{ row.label }}</span>
            <strong>{{ row.value }}</strong>
          </article>
        </div>

        <p v-if="projects.error" class="inline-error asset-center-message">{{ projects.error }}</p>

        <div v-if="!projects.loading && !projects.items.length" class="empty-state">
          <FolderKanban :size="34" />
          <strong>还没有项目数据</strong>
          <p>数据中心会按项目汇总制作进度与素材分布；先创建项目后即可在这里独立查看。</p>
          <RouterLink class="button primary" to="/projects">去创建项目</RouterLink>
        </div>

        <div v-else-if="loadingProject || workspace.loading" class="empty-state asset-center-loading">
          <LoaderCircle class="spin" :size="28" />
          <strong>正在准备数据中心</strong>
          <p>正在加载项目结构、分集资源和本地素材统计。</p>
        </div>

        <div v-else-if="projectError" class="empty-state asset-center-error">
          <Database :size="30" />
          <strong>数据中心加载失败</strong>
          <p>{{ projectError }}</p>
          <button class="button" type="button" @click="retrySelectedProject">重新加载</button>
        </div>

        <ProjectDataPanel v-else-if="projectReady" :project-id="selectedProjectId" />
      </main>
    </section>
  </StudioShell>
</template>
