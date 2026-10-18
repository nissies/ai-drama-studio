<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  FileAudio,
  FileImage,
  Film,
  FolderOpen,
  Grid2X2,
  HardDrive,
  Import,
  List,
  Search,
  Trash2,
} from 'lucide-vue-next'
import type { LocalAsset, LocalAssetCategory } from '../../desktop/types'
import { useDesktopStore } from '../../stores/desktop'
import { useWorkspaceStore } from '../../stores/workspace'

type AssetFilter = 'all' | LocalAssetCategory
type AssetListItem = LocalAsset & { relativePath: string }

const props = defineProps<{ projectId: string }>()
const desktop = useDesktopStore()
const workspace = useWorkspaceStore()
const activeCategory = ref<AssetFilter>('all')
const importCategory = ref<LocalAssetCategory>('images')
const query = ref('')
const view = ref<'list' | 'grid'>('list')

const categoryLabels: Record<LocalAssetCategory, string> = {
  images: '普通图片',
  characters: '角色',
  scenes: '场景',
  storyboards: '分镜图',
  audio: '音频',
  videos: '视频',
  exports: '导出成片',
}

const categories: Array<{ value: AssetFilter; label: string }> = [
  { value: 'all', label: '全部' },
  ...Object.entries(categoryLabels).map(([value, label]) => ({
    value: value as LocalAssetCategory,
    label,
  })),
]

const visibleAssets = computed<AssetListItem[]>(() => {
  if (desktop.available) return desktop.project?.assets ?? []
  return workspace.mediaAssets.map((asset) => ({
    id: asset.id,
    category: asset.localCategory,
    originalName: asset.originalFilename,
    relativePath: '',
    sizeBytes: asset.sizeBytes,
    sha256: asset.sha256,
    mimeType: asset.mimeType,
    importedAt: asset.createdAt,
    fileAvailable: false,
  }))
})

const sortedAssets = computed(() =>
  [...visibleAssets.value].sort((left, right) => right.importedAt.localeCompare(left.importedAt)),
)

const filteredAssets = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return sortedAssets.value.filter((asset) => {
    const matchesCategory =
      activeCategory.value === 'all' || asset.category === activeCategory.value
    const matchesKeyword =
      !keyword ||
      asset.originalName.toLowerCase().includes(keyword) ||
      asset.relativePath.toLowerCase().includes(keyword)
    return matchesCategory && matchesKeyword
  })
})

const categoryCounts = computed<Record<AssetFilter, number>>(() => {
  const counts: Record<AssetFilter, number> = {
    all: sortedAssets.value.length,
    images: 0,
    characters: 0,
    scenes: 0,
    storyboards: 0,
    audio: 0,
    videos: 0,
    exports: 0,
  }
  sortedAssets.value.forEach((asset) => {
    counts[asset.category] += 1
  })
  return counts
})

function categoryCount(category: AssetFilter) {
  return categoryCounts.value[category]
}

async function importAssets() {
  await desktop.importAssets(importCategory.value)
  if (desktop.error || !desktop.project) return
  try {
    const mappings = await workspace.synchronizeLocalAssets(props.projectId, desktop.project.assets)
    await desktop.reconcileAssetIds(mappings.filter((item) => item.clientAssetId !== item.assetId))
  } catch (error) {
    desktop.error = error instanceof Error ? error.message : '本地素材登记失败'
  }
}

async function removeAsset(asset: AssetListItem) {
  const references = referenceLabels(asset.id)
  if (references.length) {
    globalThis.alert(`该素材仍关联：${references.join('、')}。请先在对应页面解除关联。`)
    return
  }
  if (!globalThis.confirm(`确定从本地磁盘删除“${asset.originalName}”吗？`)) return
  try {
    await workspace.deleteMediaAsset(props.projectId, asset.id)
    await desktop.removeAsset(asset.id)
    if (desktop.error && desktop.project?.assets.some((item) => item.id === asset.id)) {
      await workspace.synchronizeLocalAssets(props.projectId, desktop.project.assets)
    }
  } catch (error) {
    desktop.error = error instanceof Error ? error.message : '本地素材删除失败'
  }
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
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

function isAudio(asset: AssetListItem) {
  return asset.category === 'audio'
}

function isVideo(asset: AssetListItem) {
  return asset.category === 'videos' || asset.category === 'exports'
}

function isImage(asset: AssetListItem) {
  return asset.mimeType.startsWith('image/')
}

function previewUrl(asset: AssetListItem) {
  return desktop.available && asset.fileAvailable && isImage(asset)
    ? desktop.assetPreviewUrl(asset.id)
    : ''
}

function referenceLabels(assetId: string) {
  const labels: string[] = []
  workspace.characterReferences
    .filter((reference) => reference.assetId === assetId)
    .forEach((reference) => {
      const character = workspace.characters.find((item) => item.id === reference.characterId)
      const form = character?.forms.find((item) => item.id === reference.characterFormId)
      labels.push(
        form ? `${character?.name || '角色'} / ${form.displayName}` : character?.name || '角色',
      )
    })
  workspace.sceneReferences
    .filter((reference) => reference.assetId === assetId)
    .forEach((reference) => {
      labels.push(workspace.scenes.find((scene) => scene.id === reference.sceneId)?.title || '场景')
    })
  return [...new Set(labels)]
}

function referenceText(assetId: string) {
  const labels = referenceLabels(assetId)
  return labels.length ? labels.join('、') : '未关联'
}

function assetState(asset: AssetListItem) {
  if (!desktop.available) return '本地文件不可访问'
  if (!asset.fileAvailable) return '本机文件缺失'
  return workspace.mediaAssetById(asset.id) ? '已登记' : '待同步'
}
</script>

<template>
  <section class="asset-panel local-assets-panel">
    <header class="panel-toolbar local-assets-header">
      <div>
        <h2>本地素材</h2>
        <p>大文件保存在当前电脑，仅结构与任务信息同步到服务端。</p>
      </div>
      <div v-if="desktop.available" class="toolbar-actions">
        <span class="workspace-path" :title="desktop.project?.directory">
          <HardDrive :size="15" />{{ desktop.project?.directory || '正在准备项目目录' }}
        </span>
        <button class="button" type="button" title="打开项目文件夹" @click="desktop.revealProject">
          <FolderOpen :size="17" />打开项目文件夹
        </button>
        <select v-model="importCategory" class="asset-import-select" aria-label="导入素材类型">
          <option v-for="(label, value) in categoryLabels" :key="value" :value="value">
            {{ label }}
          </option>
        </select>
        <button
          class="button primary"
          type="button"
          :disabled="desktop.importing || !desktop.project"
          @click="importAssets"
        >
          <Import :size="17" />{{ desktop.importing ? '导入中' : '导入素材' }}
        </button>
      </div>
    </header>

    <nav class="asset-category-tabs" aria-label="素材分类">
      <button
        v-for="item in categories"
        :key="item.value"
        type="button"
        :class="{ active: activeCategory === item.value }"
        @click="activeCategory = item.value"
      >
        {{ item.label }}<span>{{ categoryCount(item.value) }}</span>
      </button>
    </nav>

    <div class="asset-filterbar">
      <label class="search-control asset-search">
        <Search :size="16" /><input v-model="query" placeholder="搜索文件名或本地路径" />
      </label>
      <span class="asset-result-count">共 {{ filteredAssets.length }} 项</span>
      <div class="view-switch" aria-label="素材视图">
        <button
          type="button"
          :class="{ active: view === 'grid' }"
          title="网格视图"
          @click="view = 'grid'"
        >
          <Grid2X2 :size="16" />
        </button>
        <button
          type="button"
          :class="{ active: view === 'list' }"
          title="列表视图"
          @click="view = 'list'"
        >
          <List :size="16" />
        </button>
      </div>
    </div>

    <p v-if="desktop.error" class="inline-error">{{ desktop.error }}</p>
    <div v-if="!desktop.available && filteredAssets.length === 0" class="workspace-empty bordered">
      <HardDrive :size="32" />
      <strong>当前是浏览器模式</strong>
      <p>当前项目还没有已登记素材，本地导入仅在 Windows 桌面客户端中开放。</p>
    </div>
    <div v-else-if="filteredAssets.length === 0" class="workspace-empty bordered">
      <HardDrive :size="32" />
      <strong>{{ sortedAssets.length ? '没有符合条件的素材' : '本地项目还没有素材' }}</strong>
      <p>
        {{
          sortedAssets.length
            ? '调整分类或搜索条件后重试。'
            : '导入的图片、音频和视频不会上传到业务服务器。'
        }}
      </p>
    </div>

    <div v-else-if="view === 'list'" class="table-wrap local-assets-table">
      <table>
        <thead>
          <tr>
            <th>预览</th>
            <th>文件名</th>
            <th>分类</th>
            <th>大小</th>
            <th>关联对象</th>
            <th>导入时间</th>
            <th>状态</th>
            <th aria-label="操作" />
          </tr>
        </thead>
        <tbody>
          <tr v-for="asset in filteredAssets" :key="asset.id">
            <td>
              <img
                v-if="previewUrl(asset)"
                class="asset-table-thumb"
                :src="previewUrl(asset)"
                :alt="asset.originalName"
              />
              <span v-else class="asset-file-icon">
                <FileAudio v-if="isAudio(asset)" :size="19" />
                <Film v-else-if="isVideo(asset)" :size="19" />
                <FileImage v-else :size="19" />
              </span>
            </td>
            <td>
              <strong>{{ asset.originalName }}</strong
              ><small :title="asset.relativePath">{{
                asset.relativePath || '路径仅在本机可见'
              }}</small>
            </td>
            <td>
              <span class="asset-category-chip" :class="asset.category">{{
                categoryLabels[asset.category]
              }}</span>
            </td>
            <td>{{ formatBytes(asset.sizeBytes) }}</td>
            <td class="muted-cell" :title="referenceText(asset.id)">
              {{ referenceText(asset.id) }}
            </td>
            <td>{{ formatTime(asset.importedAt) }}</td>
            <td>
              <span class="asset-state" :class="{ warning: !asset.fileAvailable }"
              ><i />{{ assetState(asset) }}</span
              >
            </td>
            <td>
              <div v-if="desktop.available" class="row-actions">
                <button
                  class="icon-button compact"
                  title="在文件夹中显示"
                  type="button"
                  @click="desktop.revealAsset(asset.id)"
                >
                  <FolderOpen :size="15" />
                </button>
                <button
                  class="icon-button compact danger"
                  title="删除本地文件"
                  type="button"
                  @click="removeAsset(asset)"
                >
                  <Trash2 :size="15" />
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-else class="local-asset-grid">
      <article v-for="asset in filteredAssets" :key="asset.id" class="local-asset-card">
        <div class="local-asset-preview">
          <img v-if="previewUrl(asset)" :src="previewUrl(asset)" :alt="asset.originalName" />
          <FileAudio v-else-if="isAudio(asset)" :size="30" />
          <Film v-else-if="isVideo(asset)" :size="30" />
          <FileImage v-else :size="30" />
        </div>
        <div class="local-asset-card-body">
          <strong :title="asset.originalName">{{ asset.originalName }}</strong>
          <span>{{ categoryLabels[asset.category] }} · {{ formatBytes(asset.sizeBytes) }}</span>
          <small :title="referenceText(asset.id)">{{ referenceText(asset.id) }}</small>
          <footer v-if="desktop.available">
            <button
              class="icon-button compact"
              title="在文件夹中显示"
              @click="desktop.revealAsset(asset.id)"
            >
              <FolderOpen :size="15" />
            </button>
            <button
              class="icon-button compact danger"
              title="删除本地文件"
              @click="removeAsset(asset)"
            >
              <Trash2 :size="15" />
            </button>
          </footer>
        </div>
      </article>
    </div>
  </section>
</template>
