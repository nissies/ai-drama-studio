<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  CheckCircle2,
  Clapperboard,
  Download,
  Film,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  SkipForward,
  Square,
  Volume2,
  XCircle,
} from 'lucide-vue-next'
import { exportJobApi, type ExportJob } from '../../api/export-jobs'
import { projectFrameProfile } from '../../domain/project-frame-profile'
import { useDesktopStore } from '../../stores/desktop'
import type { EpisodeExportInput, EpisodeExportShotInput } from '../../desktop/types'
import { useWorkspaceStore } from '../../stores/workspace'

const props = defineProps<{ projectId: string }>()
const desktop = useDesktopStore()
const workspace = useWorkspaceStore()
const selectedShotId = ref('')
const outputName = ref('episode-export')
const width = ref(1080)
const height = ref(1920)
const fps = ref(30)
const crf = ref(18)
const preset = ref<EpisodeExportInput['preset']>('medium')
const subtitles = ref(false)
const bgmVolume = ref(0.18)
const sfxVolume = ref(0.7)
const jobs = ref<ExportJob[]>([])
const activeJob = ref<ExportJob | null>(null)
const running = ref(false)
const cancelRequested = ref(false)
const error = ref('')
const notice = ref('')
const previewVideo = ref<HTMLVideoElement | null>(null)
const sequencePreviewing = ref(false)
let lastProgressReportAt = 0
const activeRequestSignature = ref('')
let sequenceTimer: ReturnType<typeof globalThis.setTimeout> | undefined

const activeEpisodeId = computed(() => workspace.activeEpisodeId)
const projectFrame = computed(() => projectFrameProfile(workspace.project?.aspectRatio))
const previewStageStyle = computed(() => ({
  aspectRatio: projectFrame.value.cssAspectRatio,
  width:
    projectFrame.value.aspectRatio === '9:16' || projectFrame.value.aspectRatio === '3:4'
      ? 'min(360px, calc(100% - 40px))'
      : projectFrame.value.aspectRatio === '1:1'
        ? 'min(520px, calc(100% - 40px))'
        : 'min(820px, calc(100% - 40px))',
}))
const selectedEpisodeId = computed({
  get: () => workspace.activeEpisodeId,
  set: (episodeId: string) => {
    if (episodeId !== workspace.activeEpisodeId)
      void workspace.selectEpisode(props.projectId, episodeId)
  },
})
const selectedStoryboard = computed(
  () =>
    workspace.storyboards.find((item) => item.id === selectedShotId.value) ??
    workspace.storyboards[0],
)
const localAssets = computed(() => desktop.project?.assets ?? [])
const localVideos = computed(() =>
  localAssets.value.filter(
    (asset) => asset.fileAvailable && (asset.category === 'videos' || asset.category === 'exports'),
  ),
)
const localAudio = computed(() =>
  localAssets.value.filter((asset) => asset.fileAvailable && asset.category === 'audio'),
)
const timeline = computed(() =>
  workspace.storyboards.map((storyboard) => {
    const video = workspace.outputForStoryboard(storyboard.id, 'VIDEO')
    const keyframe = workspace.outputForStoryboard(storyboard.id, 'KEYFRAME')
    const voice = workspace.outputForStoryboard(storyboard.id, 'VOICE')
    const bgm = workspace.outputForStoryboard(storyboard.id, 'BGM')
    const sfx = workspace.outputForStoryboard(storyboard.id, 'SFX')
    const visual = video ? 'VIDEO' : keyframe ? 'IMAGE' : null
    return {
      storyboard,
      video,
      keyframe,
      voice,
      bgm,
      sfx,
      visual,
      visualReady: visual
        ? assetAvailable(visual === 'VIDEO' ? video?.mediaAssetId : keyframe?.mediaAssetId)
        : false,
      voiceReady:
        storyboard.audioMode === 'VIDEO_NATIVE'
          ? visual === 'VIDEO' && assetAvailable(video?.mediaAssetId)
          : assetAvailable(voice?.mediaAssetId),
    }
  }),
)
const completeStats = computed(() => ({
  shots: timeline.value.length,
  visual: timeline.value.filter((item) => item.visualReady).length,
  video: timeline.value.filter((item) => item.visual === 'VIDEO' && item.visualReady).length,
  voice: timeline.value.filter((item) => item.voiceReady).length,
}))
const selectedTimelineItem = computed(() =>
  timeline.value.find((item) => item.storyboard.id === selectedStoryboard.value?.id),
)
const previewUrl = computed(() => {
  const assetId =
    selectedTimelineItem.value?.visual === 'VIDEO'
      ? selectedTimelineItem.value.video?.mediaAssetId
      : selectedTimelineItem.value?.keyframe?.mediaAssetId
  return assetPreviewUrl(assetId)
})
const previewIsVideo = computed(() => selectedTimelineItem.value?.visual === 'VIDEO')
const missingCount = computed(() => completeStats.value.shots - completeStats.value.visual)
const subtitleCount = computed(() =>
  workspace.storyboards.filter((storyboard) => Boolean(subtitleText(storyboard))).length,
)
const sequencePosition = computed(() => {
  const index = timeline.value.findIndex((item) => item.storyboard.id === selectedStoryboard.value?.id)
  return index >= 0 ? index + 1 : 0
})
const canExport = computed(() =>
  Boolean(
    desktop.available &&
    desktop.runtime?.ffmpeg.available &&
    timeline.value.length &&
    !missingCount.value &&
    !running.value,
  ),
)

watch(
  () => [workspace.activeEpisodeId, workspace.storyboards.map((item) => item.id).join(',')],
  () => {
    stopSequencePreview()
    const first = workspace.storyboards[0]
    if (!workspace.storyboards.some((item) => item.id === selectedShotId.value))
      selectedShotId.value = first?.id ?? ''
    if (workspace.activeEpisode) outputName.value = `episode-${workspace.activeEpisode.episodeNo}`
    void loadJobs()
  },
  { immediate: true },
)

watch(
  () => workspace.project?.aspectRatio,
  () => {
    width.value = projectFrame.value.exportWidth
    height.value = projectFrame.value.exportHeight
  },
  { immediate: true },
)

watch(
  () => desktop.exportProgress,
  (progress) => {
    if (!progress || !activeJob.value || progress.exportId !== activeJob.value.clientExportId)
      return
    const now = Date.now()
    if (now - lastProgressReportAt < 1200 || progress.stage === 'SUCCEEDED') return
    lastProgressReportAt = now
    void exportJobApi
      .progress(activeJob.value.id, {
        clientExportId: activeJob.value.clientExportId!,
        progress: progress.progress,
        stage: progress.stage,
        shotNo: progress.shotNo,
      })
      .then((job) => {
        activeJob.value = job
      })
      .catch(() => undefined)
  },
)

onMounted(() => void desktop.initialize())
onBeforeUnmount(() => stopSequencePreview())

function selectTimelineShot(storyboardId: string) {
  stopSequencePreview()
  selectedShotId.value = storyboardId
}

function startSequencePreview() {
  const firstIndex = timeline.value.findIndex((item) => item.visualReady)
  if (firstIndex < 0) {
    error.value = '当前分集没有可连续播放的本地画面'
    return
  }
  error.value = ''
  notice.value = '连续审片只会按顺序播放镜头，不会生成或合并新文件。'
  sequencePreviewing.value = true
  playSequenceItem(firstIndex)
}

function playNextSequenceItem() {
  if (!sequencePreviewing.value) return
  const currentIndex = timeline.value.findIndex(
    (item) => item.storyboard.id === selectedStoryboard.value?.id,
  )
  const nextIndex = timeline.value.findIndex(
    (item, index) => index > currentIndex && item.visualReady,
  )
  if (nextIndex < 0) {
    stopSequencePreview()
    notice.value = '本集镜头已连续预览完成；确认无误后可点击“导出整集”真正合并。'
    return
  }
  playSequenceItem(nextIndex)
}

function playSequenceItem(index: number) {
  const item = timeline.value[index]
  if (!item?.visualReady) return
  clearSequenceTimer()
  selectedShotId.value = item.storyboard.id
  void nextTick(() => {
    if (item.visual === 'VIDEO') {
      previewVideo.value?.load()
      void previewVideo.value?.play().catch(() => {
        error.value = `镜头 ${item.storyboard.shotNo} 无法自动播放，请点击播放器后继续`
      })
      return
    }
    sequenceTimer = globalThis.setTimeout(
      playNextSequenceItem,
      Math.max(1, item.storyboard.durationSec) * 1000,
    )
  })
}

function stopSequencePreview() {
  clearSequenceTimer()
  sequencePreviewing.value = false
  previewVideo.value?.pause()
}

function clearSequenceTimer() {
  if (sequenceTimer) globalThis.clearTimeout(sequenceTimer)
  sequenceTimer = undefined
}

async function loadJobs() {
  if (!activeEpisodeId.value) return
  try {
    jobs.value = await exportJobApi.list(props.projectId, activeEpisodeId.value)
  } catch (caught) {
    error.value = messageFor(caught, '导出历史读取失败')
  }
}

async function exportEpisode() {
  if (!activeEpisodeId.value || !canExport.value) return
  error.value = ''
  notice.value = ''
  cancelRequested.value = false
  let input: EpisodeExportInput
  try {
    input = buildExportInput()
  } catch (caught) {
    error.value = messageFor(caught, '导出素材检查失败')
    return
  }
  running.value = true
  try {
    const signature = JSON.stringify(input)
    const existingFailed =
      activeJob.value?.status === 'FAILED' && activeRequestSignature.value === signature
    let job =
      existingFailed && activeJob.value
        ? await exportJobApi.retry(activeJob.value.id)
        : await exportJobApi.create(
            props.projectId,
            activeEpisodeId.value,
            {
              outputName: input.outputName,
              settings: {
                width: input.width,
                height: input.height,
                fps: input.fps,
                crf: input.crf,
                preset: input.preset,
                subtitles: input.subtitles,
                bgmVolume: input.bgmVolume,
                sfxVolume: input.sfxVolume,
              },
              shots: input.shots,
            },
            globalThis.crypto.randomUUID(),
          )
    activeJob.value = job
    activeRequestSignature.value = signature
    if (job.status === 'SUCCEEDED') {
      notice.value = '相同导出请求已经完成，可在导出成片中查看。'
      return
    }
    const clientExportId = job.clientExportId || input.exportId
    job = await exportJobApi.start(job.id, clientExportId)
    activeJob.value = job
    const result = await desktop.composeEpisode(input)
    if (!desktop.project) throw new Error('本地项目清单读取失败')
    const mappings = await workspace.synchronizeLocalAssets(props.projectId, desktop.project.assets)
    const canonicalId =
      mappings.find((item) => item.clientAssetId === result.asset.id)?.assetId ?? result.asset.id
    await desktop.reconcileAssetIds(mappings.filter((item) => item.clientAssetId !== item.assetId))
    activeJob.value = await exportJobApi.complete(job.id, {
      clientExportId,
      outputAssetId: canonicalId,
      outputFilename: result.asset.originalName,
    })
    notice.value = '整集已导出到本地 exports 文件夹。'
    await loadJobs()
  } catch (caught) {
    if (cancelRequested.value) {
      notice.value = '导出已取消。'
    } else {
      error.value = messageFor(caught, '整集导出失败')
      if (activeJob.value?.status === 'RUNNING' && activeJob.value.clientExportId) {
        activeJob.value = await exportJobApi
          .fail(activeJob.value.id, activeJob.value.clientExportId, error.value)
          .catch(() => activeJob.value)
      }
    }
    await loadJobs()
  } finally {
    running.value = false
  }
}

async function cancelExport() {
  if (!activeJob.value || !running.value) return
  cancelRequested.value = true
  await desktop.cancelEpisodeExport(activeJob.value.clientExportId || '')
  await exportJobApi
    .cancel(activeJob.value.id)
    .then((job) => {
      activeJob.value = job
    })
    .catch(() => undefined)
}

async function setManualOutput(outputType: 'VIDEO' | 'VOICE' | 'BGM' | 'SFX', assetId: string) {
  if (!selectedStoryboard.value) return
  error.value = ''
  try {
    if (!assetId) {
      await workspace.deleteStoryboardOutput(
        props.projectId,
        selectedStoryboard.value.id,
        outputType,
      )
      return
    }
    await workspace.setStoryboardOutput(props.projectId, selectedStoryboard.value.id, {
      outputType,
      mediaAssetId: assetId,
      sourceType: 'MANUAL',
    })
  } catch (caught) {
    error.value = messageFor(caught, '当前镜头素材设置失败')
  }
}

function buildExportInput(): EpisodeExportInput {
  if (!activeEpisodeId.value) throw new Error('请先选择分集')
  return {
    exportId:
      activeJob.value?.status === 'FAILED' && activeJob.value.clientExportId
        ? activeJob.value.clientExportId
        : globalThis.crypto.randomUUID(),
    projectId: props.projectId,
    episodeId: activeEpisodeId.value,
    outputName:
      outputName.value.trim().replace(/\.mp4$/i, '') ||
      `episode-${workspace.activeEpisode?.episodeNo || 1}`,
    width: width.value,
    height: height.value,
    fps: fps.value,
    crf: crf.value,
    preset: preset.value,
    subtitles: subtitles.value,
    bgmVolume: bgmVolume.value,
    sfxVolume: sfxVolume.value,
    shots: timeline.value.map((item) => {
      if (!item.visual || !item.visualReady)
        throw new Error(`镜头 ${item.storyboard.shotNo} 缺少本地画面素材`)
      const visualAssetId =
        item.visual === 'VIDEO' ? item.video!.mediaAssetId : item.keyframe!.mediaAssetId
      return {
        storyboardId: item.storyboard.id,
        shotNo: item.storyboard.shotNo,
        durationSec: item.storyboard.durationSec,
        visualType: item.visual,
        visualAssetId,
        audioMode: item.storyboard.audioMode,
        voiceAssetId:
          item.storyboard.audioMode === 'AI_DUB' && item.voiceReady
            ? item.voice!.mediaAssetId
            : undefined,
        bgmAssetId: assetAvailable(item.bgm?.mediaAssetId) ? item.bgm!.mediaAssetId : undefined,
        sfxAssetId: assetAvailable(item.sfx?.mediaAssetId) ? item.sfx!.mediaAssetId : undefined,
        subtitle: subtitles.value ? subtitleText(item.storyboard) : undefined,
      } satisfies EpisodeExportShotInput
    }),
  }
}

function subtitleText(storyboard: (typeof workspace.storyboards)[number]) {
  return [storyboard.dialogue?.trim(), storyboard.innerMonologue?.trim()]
    .filter(Boolean)
    .join('\n')
}

function assetAvailable(assetId?: string | null) {
  if (!assetId) return false
  return localAssets.value.some((asset) => asset.id === assetId && asset.fileAvailable)
}

function assetPreviewUrl(assetId?: string | null) {
  if (!assetId) return ''
  const asset = localAssets.value.find((item) => item.id === assetId)
  return asset?.fileAvailable ? desktop.assetPreviewUrl(asset.id) : ''
}

function formatBytes(bytes: number) {
  return bytes > 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

async function revealExport(assetId: string) {
  if (assetAvailable(assetId)) await desktop.revealAsset(assetId)
  else error.value = '导出记录存在，但成片文件不在当前本地工作目录'
}

function messageFor(caught: unknown, fallback: string) {
  return caught instanceof Error && caught.message ? caught.message : fallback
}
</script>

<template>
  <section class="compose-panel">
    <header class="panel-toolbar">
      <div>
        <h2>合成与导出</h2>
        <p>先连续审片检查全部镜头，再按顺序合并音画、字幕并导出 {{ projectFrame.label }} 成片。</p>
      </div>
      <div class="toolbar-actions">
        <select v-if="workspace.episodes.length" v-model="selectedEpisodeId">
          <option v-for="episode in workspace.episodes" :key="episode.id" :value="episode.id">
            第 {{ episode.episodeNo }} 集 · {{ episode.title }}
          </option></select
        ><button class="button primary" type="button" :disabled="!canExport" title="真正合并全部镜头并生成一个本地视频文件" @click="exportEpisode">
          <LoaderCircle v-if="running" class="spin" :size="16" /><Download v-else :size="16" />{{
            running ? '导出中...' : '导出整集'
          }}</button
        ><button
          v-if="running"
          class="icon-button danger"
          type="button"
          title="取消导出"
          @click="cancelExport"
        >
          <XCircle :size="17" />
        </button>
      </div>
    </header>
    <p v-if="notice" class="workspace-inline-notice success">{{ notice }}</p>
    <p v-if="error" class="workspace-inline-notice error">{{ error }}</p>
    <div v-if="!desktop.available" class="workspace-empty bordered">
      <Film :size="34" /><strong>合成需要 Windows 桌面客户端</strong>
      <p>浏览器模式只展示结构数据，不能读取本地媒体或运行 FFmpeg。</p>
    </div>
    <template v-else>
      <div class="compose-completeness">
        <span
        >镜头 <strong>{{ completeStats.shots }}/{{ completeStats.shots }}</strong></span
        ><span :class="{ ready: completeStats.visual === completeStats.shots }"
        >画面 <strong>{{ completeStats.visual }}/{{ completeStats.shots }}</strong></span
        ><span :class="{ ready: completeStats.video === completeStats.shots }"
        >视频 <strong>{{ completeStats.video }}/{{ completeStats.shots }}</strong></span
        ><span :class="{ ready: completeStats.voice === completeStats.shots }"
        >配音 <strong>{{ completeStats.voice }}/{{ completeStats.shots }}</strong></span
        ><span :class="{ ready: desktop.runtime?.ffmpeg.available }"
        >FFmpeg
          <strong>{{ desktop.runtime?.ffmpeg.available ? '已就绪' : '未检测到' }}</strong></span
        >
      </div>
      <div v-if="!timeline.length" class="workspace-empty bordered">
        <Clapperboard :size="34" /><strong>当前分集没有分镜</strong>
        <p>先在分镜制作页生成并保存分镜。</p>
      </div>
      <div v-else class="compose-layout">
        <aside class="compose-timeline">
          <header>
            <strong>镜头时间线</strong><span>{{ timeline.length }}</span>
          </header>
          <button
            v-for="item in timeline"
            :key="item.storyboard.id"
            class="compose-shot-row"
            :class="{ active: item.storyboard.id === selectedStoryboard?.id }"
            type="button"
            @click="selectTimelineShot(item.storyboard.id)"
          >
            <span class="compose-shot-number">{{
              String(item.storyboard.shotNo).padStart(2, '0')
            }}</span
            ><span class="compose-shot-copy"
            ><strong>{{ item.storyboard.title }}</strong
            ><small
            >{{ item.storyboard.durationSec }} 秒 ·
              {{
                item.visual === 'VIDEO' ? '视频' : item.visual === 'IMAGE' ? '首帧补位' : '缺画面'
              }}</small
            ></span
            ><span class="compose-shot-status"
            ><CheckCircle2 v-if="item.visualReady" :size="14" /><Film v-else :size="14" /><Volume2
              :class="{ ready: item.voiceReady }"
              :size="14"
            /></span>
          </button>
        </aside>
        <main class="compose-preview">
          <header>
            <strong>{{ selectedStoryboard?.title || '选择镜头' }}</strong
            ><div class="compose-preview-actions">
              <span v-if="sequencePreviewing">连续审片 {{ sequencePosition }}/{{ timeline.length }}</span>
              <span v-else>单镜头预览</span>
              <button v-if="!sequencePreviewing" type="button" :disabled="!completeStats.visual" @click="startSequencePreview"><Play :size="13" />连续预览</button>
              <template v-else>
                <button type="button" @click="playNextSequenceItem"><SkipForward :size="13" />下一镜</button>
                <button type="button" @click="stopSequencePreview"><Square :size="12" />停止</button>
              </template>
            </div>
          </header>
          <div class="compose-preview-stage" :style="previewStageStyle">
            <video
              v-if="previewIsVideo && previewUrl"
              ref="previewVideo"
              :src="previewUrl"
              controls
              preload="metadata"
              @ended="playNextSequenceItem"
            /><img
              v-else-if="previewUrl"
              :src="previewUrl"
              :alt="selectedStoryboard?.title || '首帧画面'"
            /><template v-else><Film :size="34" /><span>当前画面文件不在本机</span></template>
          </div>
          <div v-if="selectedStoryboard" class="compose-manual-controls">
            <label
            >视频素材<select
              :value="selectedTimelineItem?.video?.mediaAssetId || ''"
              @change="setManualOutput('VIDEO', ($event.target as HTMLSelectElement).value)"
            >
              <option value="">使用生成视频 / 无</option>
              <option v-for="asset in localVideos" :key="asset.id" :value="asset.id">
                {{ asset.originalName }} · {{ formatBytes(asset.sizeBytes) }}
              </option>
            </select></label
            ><label
            >配音素材<select
              :value="selectedTimelineItem?.voice?.mediaAssetId || ''"
              :disabled="selectedStoryboard.audioMode === 'VIDEO_NATIVE'"
              @change="setManualOutput('VOICE', ($event.target as HTMLSelectElement).value)"
            >
              <option value="">
                {{ selectedStoryboard.audioMode === 'VIDEO_NATIVE' ? '使用视频原声' : '无配音' }}
              </option>
              <option v-for="asset in localAudio" :key="asset.id" :value="asset.id">
                {{ asset.originalName }}
              </option>
            </select></label
            ><label
            >背景音乐<select
              :value="selectedTimelineItem?.bgm?.mediaAssetId || ''"
              @change="setManualOutput('BGM', ($event.target as HTMLSelectElement).value)"
            >
              <option value="">无背景音乐</option>
              <option v-for="asset in localAudio" :key="asset.id" :value="asset.id">
                {{ asset.originalName }}
              </option>
            </select></label
            ><label
            >音效<select
              :value="selectedTimelineItem?.sfx?.mediaAssetId || ''"
              @change="setManualOutput('SFX', ($event.target as HTMLSelectElement).value)"
            >
              <option value="">无音效</option>
              <option v-for="asset in localAudio" :key="asset.id" :value="asset.id">
                {{ asset.originalName }}
              </option>
            </select></label
            >
          </div>
        </main>
        <aside class="compose-inspector">
          <header><strong>导出检查器</strong></header>
          <div class="compose-inspector-section">
            <label>输出文件名<input v-model="outputName" maxlength="100" /></label>
            <div class="form-grid two-columns">
              <label>宽度<input v-model.number="width" type="number" min="360" max="2160" /></label
              ><label
              >高度<input v-model.number="height" type="number" min="640" max="3840" /></label
              ><label>帧率<input v-model.number="fps" type="number" min="20" max="60" /></label
              ><label>质量<input v-model.number="crf" type="number" min="14" max="30" /></label>
            </div>
            <label
            >编码速度<select v-model="preset">
              <option value="veryfast">很快</option>
              <option value="faster">较快</option>
              <option value="fast">快速</option>
              <option value="medium">均衡</option>
              <option value="slow">高质量</option>
            </select></label
            ><label class="checkbox-field subtitle-option"
            ><input v-model="subtitles" type="checkbox" /><span><strong>添加字幕</strong><small>自动使用每个分镜的对白与内心独白，导出时直接烧录到画面</small></span></label
            ><label
            >背景音乐音量<input
              v-model.number="bgmVolume"
              type="range"
              min="0"
              max="1"
              step="0.01"
            /><small>{{ Math.round(bgmVolume * 100) }}%</small></label
            ><label
            >音效音量<input
              v-model.number="sfxVolume"
              type="range"
              min="0"
              max="2"
              step="0.05"
            /><small>{{ Math.round(sfxVolume * 100) }}%</small></label
            >
          </div>
          <div class="compose-inspector-section">
            <strong>检查结果</strong>
            <p class="compose-check" :class="{ ready: !missingCount }">
              <CheckCircle2 :size="15" />{{
                missingCount ? `还有 ${missingCount} 个镜头缺少本地画面` : '所有镜头都有可用画面'
              }}
            </p>
            <p class="compose-check" :class="{ ready: desktop.runtime?.ffmpeg.available }">
              <CheckCircle2 :size="15" />{{
                desktop.runtime?.ffmpeg.available ? 'FFmpeg 已就绪' : '请安装并加入 PATH'
              }}
            </p>
            <p class="compose-check">
              <Volume2 :size="15" />{{ completeStats.voice }} 个镜头已有视频原声或 AI
              配音，其余将保持静音
            </p>
            <p class="compose-check" :class="{ ready: !subtitles || subtitleCount }">
              <CheckCircle2 :size="15" />{{ subtitles ? `${subtitleCount} 个镜头包含可烧录字幕` : '本次导出不添加字幕' }}
            </p>
          </div>
          <div v-if="running && desktop.exportProgress" class="compose-progress">
            <div>
              <strong>{{
                desktop.exportProgress.stage === 'CONCATENATING'
                  ? '正在拼接整集'
                  : `正在处理第 ${desktop.exportProgress.shotNo || '-'} 镜头`
              }}</strong
              ><span>{{ desktop.exportProgress.progress }}%</span>
            </div>
            <progress :value="desktop.exportProgress.progress" max="100" />
          </div>
        </aside>
      </div>
      <section class="compose-history">
        <header>
          <div>
            <h3>导出历史</h3>
            <span>后端只保存任务记录，成片保存在本机 exports 文件夹。</span>
          </div>
          <button class="icon-button compact" type="button" title="刷新导出历史" @click="loadJobs">
            <RefreshCw :size="15" />
          </button>
        </header>
        <div v-if="!jobs.length" class="compose-history-empty">暂无导出记录</div>
        <article v-for="job in jobs" :key="job.id" class="compose-history-row">
          <span class="compose-history-icon"
          ><CheckCircle2 v-if="job.status === 'SUCCEEDED'" :size="17" /><LoaderCircle
            v-else-if="job.status === 'RUNNING'"
            class="spin"
            :size="17" /><Pause v-else :size="17"
            /></span>
          <div>
            <strong>{{ job.outputFilename || '未命名导出' }}</strong
            ><small>{{
              job.status === 'SUCCEEDED'
                ? '已完成'
                : job.status === 'FAILED'
                  ? job.errorMessage
                  : job.status === 'RUNNING'
                    ? `${job.progress}% · ${job.stage || '处理中'}`
                    : '待执行'
            }}</small>
          </div>
          <button
            v-if="job.status === 'SUCCEEDED' && job.outputAssetId"
            class="icon-button compact"
            title="在资源管理器中显示"
            @click="revealExport(job.outputAssetId)"
          >
            <Download :size="15" />
          </button>
        </article>
      </section>
    </template>
  </section>
</template>
