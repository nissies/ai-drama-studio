<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  BarChart3,
  CheckCircle2,
  CircleAlert,
  Film,
  HardDrive,
  Image,
  UsersRound,
  Volume2,
} from 'lucide-vue-next'
import { useDesktopStore } from '../../stores/desktop'
import { useWorkspaceStore } from '../../stores/workspace'

const props = defineProps<{ projectId: string }>()
const desktop = useDesktopStore()
const workspace = useWorkspaceStore()
const route = useRoute()
const router = useRouter()

const outputs = computed(() =>
  workspace.storyboards.map((storyboard) => ({
    storyboard,
    keyframe: workspace.outputForStoryboard(storyboard.id, 'KEYFRAME'),
    video: workspace.outputForStoryboard(storyboard.id, 'VIDEO'),
    voice: workspace.outputForStoryboard(storyboard.id, 'VOICE'),
  })),
)
const summary = computed(() => ({
  episodes: workspace.episodes.length,
  characters: workspace.characters.length,
  scenes: workspace.scenes.length,
  shots: workspace.storyboards.length,
  keyframes: outputs.value.filter((item) => item.keyframe).length,
  videos: outputs.value.filter((item) => item.video).length,
  voices: outputs.value.filter((item) => item.voice).length,
}))
const storageRows = computed(() => {
  const labels = {
    characters: '角色图片',
    scenes: '场景图片',
    storyboards: '分镜图片',
    audio: '音频',
    videos: '视频',
    exports: '导出成片',
    images: '普通图片',
  }
  const values = new Map<string, { count: number; bytes: number }>()
  for (const asset of desktop.project?.assets ?? []) {
    const row = values.get(asset.category) ?? { count: 0, bytes: 0 }
    row.count += 1
    row.bytes += asset.sizeBytes
    values.set(asset.category, row)
  }
  return Object.entries(labels).map(([category, label]) => ({
    category,
    label,
    ...(values.get(category) ?? { count: 0, bytes: 0 }),
  }))
})
const totalLocalBytes = computed(() => storageRows.value.reduce((sum, row) => sum + row.bytes, 0))
const activeCompletion = computed(() => {
  const shots = summary.value.shots
  if (!shots) return 0
  return Math.round(
    (summary.value.videos / shots) * 50 +
      (summary.value.voices / shots) * 30 +
      (summary.value.keyframes / shots) * 20,
  )
})

function openTab(tab: string) {
  void router.push({
    name: 'workspace',
    params: { projectId: props.projectId },
    query: { ...route.query, tab },
  })
}

function percent(value: number, total: number) {
  return total ? Math.round((value / total) * 100) : 0
}

function bytes(value: number) {
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(2)} GB`
}
</script>

<template>
  <section class="project-data-panel">
    <header class="panel-toolbar">
      <div>
        <h2>数据中心</h2>
        <p>仅统计当前项目的结构数据与本地素材。</p>
      </div>
      <div class="toolbar-actions">
        <button class="button" type="button" @click="openTab('tasks')">
          <BarChart3 :size="16" />查看任务</button
        ><button class="button" type="button" @click="openTab('compose')">
          <Film :size="16" />合成导出
        </button>
      </div>
    </header>
    <div class="project-metric-band">
      <article>
        <span><Film :size="17" />分集</span><strong>{{ summary.episodes }}</strong>
      </article>
      <article>
        <span><UsersRound :size="17" />角色</span><strong>{{ summary.characters }}</strong>
      </article>
      <article>
        <span><Image :size="17" />场景</span><strong>{{ summary.scenes }}</strong>
      </article>
      <article>
        <span><BarChart3 :size="17" />当前分镜</span><strong>{{ summary.shots }}</strong>
      </article>
      <article>
        <span><HardDrive :size="17" />本地素材</span
        ><strong>{{ desktop.project?.assets.length || 0 }}</strong>
      </article>
    </div>
    <div class="project-data-layout">
      <section class="production-progress-section">
        <header>
          <div>
            <h3>当前分集制作完整度</h3>
            <span>{{
              workspace.activeEpisode
                ? `第 ${workspace.activeEpisode.episodeNo} 集 · ${workspace.activeEpisode.title}`
                : '未选择分集'
            }}</span>
          </div>
          <strong>{{ activeCompletion }}%</strong>
        </header>
        <progress :value="activeCompletion" max="100" />
        <div class="production-progress-grid">
          <article>
            <span>视频首帧</span><strong>{{ summary.keyframes }}/{{ summary.shots }}</strong
            ><small>{{ percent(summary.keyframes, summary.shots) }}%</small>
          </article>
          <article>
            <span>动态视频</span><strong>{{ summary.videos }}/{{ summary.shots }}</strong
            ><small>{{ percent(summary.videos, summary.shots) }}%</small>
          </article>
          <article>
            <span>配音</span><strong>{{ summary.voices }}/{{ summary.shots }}</strong
            ><small>{{ percent(summary.voices, summary.shots) }}%</small>
          </article>
        </div>
        <p v-if="!summary.shots" class="data-guidance">
          <CircleAlert :size="15" />当前分集还没有分镜，请先完成剧本和分镜拆解。
        </p>
        <p v-else-if="summary.videos < summary.shots" class="data-guidance">
          <CircleAlert :size="15" />仍有
          {{
            summary.shots - summary.videos
          }}
          个镜头没有设置动态视频；存在首帧资产时可用于静态补位。
        </p>
        <p v-else class="data-guidance ready">
          <CheckCircle2 :size="15" />当前分集的动态视频已齐全。
        </p>
      </section>
      <section class="storage-breakdown-section">
        <header>
          <div>
            <h3>本地存储分布</h3>
            <span>{{
              desktop.workspace
                ? `可用 ${bytes(desktop.workspace.disk.freeBytes)}`
                : '桌面端可查看磁盘容量'
            }}</span>
          </div>
          <strong>{{ bytes(totalLocalBytes) }}</strong>
        </header>
        <div class="storage-breakdown-list">
          <article v-for="row in storageRows" :key="row.category">
            <span>{{ row.label }}</span>
            <div><i :style="{ width: `${percent(row.bytes, totalLocalBytes)}%` }" /></div>
            <strong>{{ row.count }} 个 · {{ bytes(row.bytes) }}</strong>
          </article>
        </div>
      </section>
    </div>
    <section class="project-data-actions">
      <button type="button" @click="openTab('characters')">
        <UsersRound :size="18" /><span
        ><strong>角色资产</strong><small>{{ summary.characters }} 个角色</small></span
        ></button
      ><button type="button" @click="openTab('storyboards')">
        <Image :size="18" /><span
        ><strong>分镜制作</strong><small>{{ summary.shots }} 个镜头</small></span
        ></button
      ><button type="button" @click="openTab('compose')">
        <Volume2 :size="18" /><span
        ><strong>音画合成</strong><small>{{ summary.voices }} 个配音</small></span
        ></button
      ><button type="button" @click="openTab('assets')">
        <HardDrive :size="18" /><span
        ><strong>本地素材</strong><small>{{ bytes(totalLocalBytes) }}</small></span
        >
      </button>
    </section>
  </section>
</template>
