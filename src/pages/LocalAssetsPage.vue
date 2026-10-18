<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { FolderKanban, FolderOpen, HardDrive, Images, LoaderCircle, Plus, RefreshCw } from 'lucide-vue-next'
import LocalAssetsPanel from '../components/workspace/LocalAssetsPanel.vue'
import { useProjectContextPage } from '../composables/useProjectContextPage'
import StudioShell from '../layouts/StudioShell.vue'

const router = useRouter()
const {
  desktop,
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
} = useProjectContextPage('local-assets')

const workspaceLabel = computed(() => {
  if (!desktop.available) return '网页模式'
  return desktop.workspace?.workspaceRoot || '正在读取本地工作区'
})

function openProjectAssets() {
  if (!selectedProjectId.value) return
  void router.push({
    name: 'workspace',
    params: { projectId: selectedProjectId.value },
    query: { tab: 'assets' },
  })
}
</script>

<template>
  <StudioShell :project-title="selectedProject?.title" :project-id="selectedProjectId">
    <header class="page-header brand-page-hero asset-center-header">
      <div>
        <p class="eyebrow">支付与资产 / 本地素材</p>
        <h1>本地素材库</h1>
        <p>不再从侧栏强制打开项目；在这里选择项目范围后管理本地图片、音频、视频和导出素材。</p>
      </div>
      <div class="header-actions">
        <button class="button" type="button" :disabled="projects.loading" @click="refreshProjects">
          <RefreshCw :class="{ spin: projects.loading }" :size="16" />刷新项目
        </button>
        <button class="button" type="button" :disabled="!selectedProjectId" @click="openProjectAssets">
          <FolderOpen :size="16" />打开项目素材页
        </button>
        <RouterLink class="button primary" to="/projects">
          <Plus :size="16" />新建/管理项目
        </RouterLink>
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
          <article>
            <span><FolderKanban :size="16" />当前范围</span>
            <strong>{{ selectedProject?.title || '未选择项目' }}</strong>
          </article>
          <article>
            <span><HardDrive :size="16" />本地工作区</span>
            <strong :title="workspaceLabel">{{ workspaceLabel }}</strong>
          </article>
          <article>
            <span><Images :size="16" />已同步素材</span>
            <strong>{{ selectedLocalAssetCount }} 个</strong>
          </article>
        </div>

        <p v-if="projects.error" class="inline-error asset-center-message">{{ projects.error }}</p>

        <div v-if="!projects.loading && !projects.items.length" class="empty-state">
          <FolderKanban :size="34" />
          <strong>还没有项目可承载本地素材</strong>
          <p>当前桌面素材仍按项目目录存储；先创建项目后即可在这里独立进入素材库。</p>
          <RouterLink class="button primary" to="/projects">去创建项目</RouterLink>
        </div>

        <div v-else-if="loadingProject || workspace.loading" class="empty-state asset-center-loading">
          <LoaderCircle class="spin" :size="28" />
          <strong>正在准备素材库</strong>
          <p>正在同步当前项目的本地目录和服务端素材索引。</p>
        </div>

        <div v-else-if="projectError" class="empty-state asset-center-error">
          <Images :size="30" />
          <strong>素材库加载失败</strong>
          <p>{{ projectError }}</p>
          <button class="button" type="button" @click="retrySelectedProject">重新加载</button>
        </div>

        <LocalAssetsPanel v-else-if="projectReady" :project-id="selectedProjectId" />
      </main>
    </section>
  </StudioShell>
</template>
