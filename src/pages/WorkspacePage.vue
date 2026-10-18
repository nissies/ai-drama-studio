<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { Check, ChevronDown, FileInput, Sparkles, X } from 'lucide-vue-next'
import GenerationRouteDialog from '../components/generation/GenerationRouteDialog.vue'
import CharacterAssetsPanel from '../components/workspace/CharacterAssetsPanel.vue'
import ComposeExportPanel from '../components/workspace/ComposeExportPanel.vue'
import EpisodeEditor from '../components/workspace/EpisodeEditor.vue'
import LocalAssetsPanel from '../components/workspace/LocalAssetsPanel.vue'
import ProjectDataPanel from '../components/workspace/ProjectDataPanel.vue'
import ScenesPanel from '../components/workspace/ScenesPanel.vue'
import SourceImportPanel from '../components/workspace/SourceImportPanel.vue'
import StoryboardsPanel from '../components/workspace/StoryboardsPanel.vue'
import TaskCenterPanel from '../components/workspace/TaskCenterPanel.vue'
import StudioShell from '../layouts/StudioShell.vue'
import { useDesktopStore } from '../stores/desktop'
import { useWorkspaceStore } from '../stores/workspace'
import { generationApi, type GenerationJob, type GenerationRoute } from '../api/generation'
import { executeTextGeneration } from '../composables/text-generation'
import {
  PROJECT_ASPECT_RATIO_OPTIONS,
  type ProjectAspectRatio,
} from '../domain/project-aspect-ratios'
import {
  VISUAL_STYLE_PRESETS,
  resolveVisualStyle,
  type VisualStyleId,
} from '../domain/production-visual-style'
import {
  estimateScriptDurationSec,
  minimumGeneratedScriptCharacterCount,
  scriptCharacterCount,
  scriptGenerationMaxTokens,
} from '../domain/episode-metrics'

type WorkspaceTab = 'script' | 'characters' | 'scenes' | 'storyboards' | 'tasks' | 'compose' | 'assets' | 'data'

const route = useRoute()
const workspace = useWorkspaceStore()
const desktop = useDesktopStore()
const activeTab = ref<WorkspaceTab>('script')
const projectId = computed(() => String(route.params.projectId))
const aspectRatioSaving = ref(false)
const aspectRatioError = ref('')
const visualStyleSaving = ref(false)
const visualStyleError = ref('')
const visionSaving = ref(false)
const visionGenerating = ref(false)
const visionRouteOpen = ref(false)
const visionRouteError = ref('')
const visionGenerationJob = ref<GenerationJob | null>(null)
const visionError = ref('')
const visionNotice = ref('')
const visionPlannerExpanded = ref(false)
const visionForm = reactive({ visualBible: '' })
const showProjectSourceImport = ref(false)
const showProjectScriptGeneration = ref(false)
const showProjectScriptCandidate = ref(false)
const projectScriptGenerating = ref(false)
const projectScriptApplying = ref(false)
const projectScriptError = ref('')
const projectScriptRouteOpen = ref(false)
const projectScriptRouteError = ref('')
const projectScriptCandidate = ref('')
const projectScriptTargetEpisodeId = ref('')
const projectScriptForm = reactive({
  title: '第一集',
  synopsis: '',
  targetDurationSec: 60,
})
const projectScriptCandidateCharacters = computed(() =>
  scriptCharacterCount(projectScriptCandidate.value),
)
const projectScriptCandidateSeconds = computed(() =>
  estimateScriptDurationSec(projectScriptCandidate.value),
)
const projectScriptMinimumCharacters = computed(() =>
  minimumGeneratedScriptCharacterCount(projectScriptForm.targetDurationSec),
)
const projectScriptCandidateIsShort = computed(
  () => projectScriptCandidateCharacters.value < projectScriptMinimumCharacters.value,
)
const projectScriptSourceCharacters = computed(() => scriptCharacterCount(projectScriptForm.synopsis))
const projectScriptSourceLimit = 200_000
const projectScriptGenerationParameters = computed(() => ({
  temperature: 0.7,
  max_tokens: scriptGenerationMaxTokens(projectScriptForm.targetDurationSec),
}))
const projectVisualStyle = computed(() => resolveVisualStyle(workspace.project?.visualStyle))
const hasGeneratedVisualAssets = computed(
  () =>
    workspace.characterReferences.length > 0 ||
    workspace.sceneReferences.length > 0 ||
    workspace.storyboardOutputs.length > 0,
)
const visionStats = computed(() => [
  { label: '角色卡', value: workspace.characters.length },
  { label: '场景卡', value: workspace.scenes.length },
  { label: '分镜', value: workspace.storyboards.length },
  { label: '成品素材', value: workspace.storyboardOutputs.length },
])
const visionGuideItems = [
  { title: '固定项目风格', text: '统一画风、色调、材质、光影和画面质感。' },
  { title: '锁定世界观', text: '沉淀时代、城市、空间、道具和环境规则。' },
  { title: '约束生成结果', text: '让角色图、场景图、分镜图和视频提示词不跑偏。' },
]
const visionCompletion = computed(() => {
  let score = 0
  if (workspace.project?.visualStyle) score += 25
  if (workspace.project?.aspectRatio && workspace.project.aspectRatio !== 'UNSET') score += 20
  if (visionForm.visualBible.trim()) score += 25
  if (workspace.characters.length > 0) score += 15
  if (workspace.scenes.length > 0) score += 15
  return Math.min(score, 100)
})
const visionPlaceholder = computed(
  () =>
    `示例：
题材与世界观：近未来都市悬疑，城市长期阴雨，霓虹广告屏和冷色路灯是主要光源。
整体风格：电影感半写实数字人短剧，冷蓝色主调，低饱和，高反差，画面干净高级。
角色规则：主角发型、脸型、服装轮廓、标志性道具保持一致，不随镜头变化。
场景规则：旧城区、天台、地下通道保持潮湿、拥挤、霓虹反光的空间气质。
镜头语言：多用近景和中景，浅景深、压迫感构图，关键情绪用特写。
生成禁忌：不要卡通化、不要血腥暴露、不要水印文字、不要真实明星脸。`,
)
const hasVisionGenerationMaterial = computed(
  () =>
    Boolean(workspace.project?.description?.trim()) ||
    workspace.episodes.some((episode) => episode.synopsis?.trim() || episode.scriptText?.trim()),
)
const visionGenerateQuotePrompt = computed(() => {
  const project = workspace.project
  if (!project) return ''
  const parts = [`项目：${project.title}`]
  if (project.description?.trim()) parts.push(`项目简介：${clipText(project.description, 1200)}`)
  workspace.episodes.slice(0, 12).forEach((episode) => {
    const text = [episode.synopsis, episode.scriptText].filter(Boolean).join('\n')
    if (text.trim()) {
      parts.push(`第 ${episode.episodeNo} 集《${episode.title}》\n${clipText(text, 1800)}`)
    }
  })
  return parts.join('\n\n').slice(0, 20_000)
})
const visionGenerationProgressText = computed(() => {
  if (!visionGenerating.value) return ''
  const job = visionGenerationJob.value
  if (!job) return '正在创建视觉圣经生成任务...'
  return `AI 正在生成视觉圣经 · ${generationStatusLabel(job.status)} · ${job.progress}%`
})
const visionErrorTip = computed(() => {
  if (!visionError.value) return ''
  if (visionError.value.includes('色情') || visionError.value.includes('软色情')) {
    return '这是所选 AI 厂家的安全审核结果，本系统未做关键词拦截。不同厂家规则可能不同，可调整表述或改用符合业务要求的模型后重试。'
  }
  return ''
})

onMounted(() => void desktop.initialize())
watch(
  projectId,
  (id) => {
    void workspace.load(id)
  },
  { immediate: true },
)
watch(
  () => route.query.tab,
  (tab) => {
    const raw = String(tab || 'script')
    // 原文导入已并入剧本页；兼容旧链接
    const nextTab = (raw === 'source' ? 'script' : raw) as WorkspaceTab
    activeTab.value = [
      'script',
      'characters',
      'scenes',
      'storyboards',
      'tasks',
      'compose',
      'assets',
      'data',
    ].includes(nextTab)
      ? nextTab
      : 'script'
  },
  { immediate: true },
)
watch(
  () => workspace.project,
  (project) => {
    if (project) void prepareLocalProject(project)
    visionForm.visualBible = project?.visualBible ?? ''
    visionError.value = ''
    visionNotice.value = ''
  },
  { immediate: true },
)

async function prepareLocalProject(project: { id: string; title: string }) {
  await desktop.ensureProject(project)
  if (!desktop.project || desktop.project.projectId !== project.id) return
  try {
    const mappings = await workspace.synchronizeLocalAssets(project.id, desktop.project.assets)
    await desktop.reconcileAssetIds(mappings.filter((item) => item.clientAssetId !== item.assetId))
  } catch (error) {
    desktop.error = error instanceof Error ? error.message : '本地素材同步失败'
  }
}

async function updateAspectRatio(event: globalThis.Event) {
  const project = workspace.project
  if (!project || aspectRatioSaving.value || visualStyleSaving.value) return
  const aspectRatio = (event.target as globalThis.HTMLSelectElement).value as ProjectAspectRatio
  if (aspectRatio === project.aspectRatio) return
  aspectRatioSaving.value = true
  aspectRatioError.value = ''
  try {
    workspace.project = await workspace.updateProjectSettings(project.id, {
      visualStyle: project.visualStyle,
      visualBible: project.visualBible,
      aspectRatio,
      version: project.version,
    })
  } catch (error) {
    aspectRatioError.value = error instanceof Error ? error.message : '项目画幅保存失败'
  } finally {
    aspectRatioSaving.value = false
  }
}

async function updateVisualStyle(event: globalThis.Event) {
  const project = workspace.project
  if (!project || aspectRatioSaving.value || visualStyleSaving.value) return
  const select = event.target as globalThis.HTMLSelectElement
  const visualStyle = select.value as VisualStyleId
  if (visualStyle === projectVisualStyle.value.id && project.visualStyle) return
  if (
    hasGeneratedVisualAssets.value &&
    !globalThis.confirm(
      '当前项目已经有角色图、场景图或分镜成品，切换风格后新旧素材可能不一致，确定继续吗？',
    )
  ) {
    select.value = projectVisualStyle.value.id
    return
  }
  visualStyleSaving.value = true
  visualStyleError.value = ''
  try {
    workspace.project = await workspace.updateProjectSettings(project.id, {
      visualStyle,
      visualBible: project.visualBible,
      aspectRatio: project.aspectRatio,
      version: project.version,
    })
  } catch (error) {
    visualStyleError.value = error instanceof Error ? error.message : '项目视觉风格保存失败'
    select.value = projectVisualStyle.value.id
  } finally {
    visualStyleSaving.value = false
  }
}

async function saveVisionBible() {
  const project = workspace.project
  if (
    !project ||
    aspectRatioSaving.value ||
    visualStyleSaving.value ||
    visionSaving.value ||
    visionGenerating.value
  ) {
    return
  }
  visionSaving.value = true
  visionError.value = ''
  visionNotice.value = ''
  try {
    workspace.project = await workspace.updateProjectSettings(project.id, {
      visualStyle: project.visualStyle,
      visualBible: visionForm.visualBible.trim() || undefined,
      aspectRatio: project.aspectRatio,
      version: project.version,
    })
    visionNotice.value = '视觉圣经已保存，后续生图和视频会自动继承'
    globalThis.setTimeout(() => {
      if (visionNotice.value.startsWith('视觉圣经')) visionNotice.value = ''
    }, 2500)
  } catch (error) {
    visionError.value = error instanceof Error ? error.message : '视觉圣经保存失败'
  } finally {
    visionSaving.value = false
  }
}

function toggleVisionPlanner() {
  visionPlannerExpanded.value = !visionPlannerExpanded.value
}

function openVisionGeneration() {
  const project = workspace.project
  if (!project || visionSaving.value || visionGenerating.value) return
  visionPlannerExpanded.value = true
  if (!hasVisionGenerationMaterial.value) {
    visionError.value = '请先填写项目简介、分集剧情梗概或剧本，再让 AI 生成视觉圣经'
    return
  }
  if (
    visionForm.visualBible.trim() &&
    visionForm.visualBible.trim() !== (project.visualBible || '') &&
    !globalThis.confirm('当前视觉圣经有未保存修改，AI 生成结果会替换编辑框内容，确定继续吗？')
  ) {
    return
  }
  visionError.value = ''
  visionNotice.value = ''
  visionRouteError.value = ''
  visionRouteOpen.value = true
}

async function generateVisionBible(route: GenerationRoute) {
  const project = workspace.project
  if (!project || visionGenerating.value) return
  visionGenerating.value = true
  visionRouteError.value = ''
  visionError.value = ''
  visionNotice.value = ''
  visionGenerationJob.value = null
  try {
    let job = await generationApi.create(
      project.id,
      {
        jobType: 'PROJECT_VISUAL_BIBLE_GENERATE',
        targetType: 'PROJECT',
        targetId: project.id,
        parameters: { temperature: 0.35, max_tokens: 1200 },
        route,
      },
      globalThis.crypto.randomUUID(),
    )
    visionGenerationJob.value = job
    visionRouteOpen.value = false
    job = await executeTextGeneration(job, route, desktop, (updated) => {
      visionGenerationJob.value = updated
    })
    visionGenerationJob.value = job
    if (job.status !== 'SUCCEEDED' || !job.resultText?.trim()) {
      throw new Error(job.errorMessage || 'AI 未返回视觉圣经内容')
    }
    visionForm.visualBible = job.resultText.trim().slice(0, 8000)
    visionNotice.value = 'AI 已生成并填入，请检查后点击保存'
    globalThis.setTimeout(() => {
      if (visionNotice.value.startsWith('AI 已生成')) visionNotice.value = ''
    }, 3500)
  } catch (error) {
    const message = error instanceof Error ? error.message : '视觉圣经生成失败'
    if (visionRouteOpen.value) visionRouteError.value = message
    visionError.value = message
  } finally {
    visionGenerating.value = false
  }
}

function clipText(value: string, maximumLength: number) {
  const normalized = value.trim()
  if (normalized.length <= maximumLength) return normalized
  return `${normalized.slice(0, maximumLength)}…`
}

function generationStatusLabel(status: GenerationJob['status']) {
  return (
    {
      WAITING_LOCAL: '等待本地执行',
      QUEUED: '排队中',
      RUNNING: '执行中',
      SUCCEEDED: '已完成',
      FAILED: '失败',
      CANCELED: '已取消',
    }[status] || status
  )
}

function openProjectScriptGeneration() {
  const episode = workspace.activeEpisode
  projectScriptTargetEpisodeId.value = episode?.id ?? ''
  projectScriptForm.title = episode?.title || `第 ${Math.max(1, workspace.episodes.length + 1)} 集`
  projectScriptForm.synopsis = episode?.synopsis || workspace.project?.description || ''
  projectScriptForm.targetDurationSec = episode?.targetDurationSec || 60
  projectScriptError.value = ''
  showProjectScriptGeneration.value = true
}

async function generateProjectScript(route: GenerationRoute) {
  if (projectScriptGenerating.value) return
  const title = projectScriptForm.title.trim()
  const synopsis = projectScriptForm.synopsis.trim()
  if (!title || !synopsis) {
    projectScriptRouteError.value = '请填写剧集标题和分集剧情资料后再生成'
    return
  }
  projectScriptGenerating.value = true
  projectScriptError.value = ''
  projectScriptRouteError.value = ''
  try {
    let episode = workspace.episodes.find((item) => item.id === projectScriptTargetEpisodeId.value)
    if (!episode) {
      episode = await workspace.createEpisode(projectId.value, {
        title,
        synopsis,
        scriptText: '',
        targetDurationSec: Math.max(5, Math.min(3600, Math.round(projectScriptForm.targetDurationSec || 60))),
      })
      projectScriptTargetEpisodeId.value = episode.id
    } else if (episode.synopsis !== synopsis || episode.title !== title) {
      episode = await workspace.updateEpisode(projectId.value, episode.id, {
        title,
        synopsis,
        scriptText: episode.scriptText || '',
        targetDurationSec: Math.max(5, Math.min(3600, Math.round(projectScriptForm.targetDurationSec || 60))),
        version: episode.version,
      })
    }
    let job = await generationApi.create(
      projectId.value,
      {
        jobType: 'SCRIPT_GENERATE',
        targetType: 'EPISODE',
        targetId: episode.id,
        parameters: projectScriptGenerationParameters.value,
        route,
      },
      globalThis.crypto.randomUUID(),
    )
    projectScriptRouteOpen.value = false
    showProjectScriptGeneration.value = false
    job = await executeTextGeneration(job, route, desktop)
    if (job.status !== 'SUCCEEDED' || !job.resultText?.trim()) {
      throw new Error(job.errorMessage || 'AI 剧本生成未返回候选稿')
    }
    projectScriptCandidate.value = job.resultText.trim()
    showProjectScriptCandidate.value = true
  } catch (error) {
    projectScriptError.value = error instanceof Error ? error.message : 'AI 剧本生成失败'
    showProjectScriptGeneration.value = true
    if (projectScriptRouteOpen.value) projectScriptRouteError.value = projectScriptError.value
  } finally {
    projectScriptGenerating.value = false
  }
}

async function applyProjectScriptCandidate() {
  const episode = workspace.episodes.find((item) => item.id === projectScriptTargetEpisodeId.value)
  if (!episode || !projectScriptCandidate.value.trim() || projectScriptApplying.value) return
  projectScriptApplying.value = true
  projectScriptError.value = ''
  try {
    await workspace.updateEpisode(projectId.value, episode.id, {
      title: episode.title,
      synopsis: episode.synopsis || projectScriptForm.synopsis.trim(),
      scriptText: projectScriptCandidate.value.trim(),
      targetDurationSec: episode.targetDurationSec,
      version: episode.version,
    })
    showProjectScriptCandidate.value = false
    await workspace.load(projectId.value)
  } catch (error) {
    projectScriptError.value = error instanceof Error ? error.message : '剧本写入失败'
  } finally {
    projectScriptApplying.value = false
  }
}
</script>

<template>
  <StudioShell :project-title="workspace.project?.title" :project-id="projectId">
    <header class="page-header workspace-header workspace-hero">
      <div class="workspace-title-block">
        <p>当前项目</p>
        <h1>{{ workspace.project?.title || '正在加载项目...' }}</h1>
        <div v-if="workspace.project" class="workspace-hero-tags">
          <span>{{ projectVisualStyle.label }}</span>
          <span>{{ workspace.project.aspectRatio === 'UNSET' ? '未设置画幅' : workspace.project.aspectRatio }}</span>
          <span v-if="activeTab === 'script'">视觉完整度 {{ visionCompletion }}%</span>
        </div>
      </div>
      <div v-if="workspace.project" class="project-meta">
        <select
          class="project-aspect-select project-style-select"
          :value="projectVisualStyle.id"
          :disabled="visualStyleSaving || aspectRatioSaving"
          :title="projectVisualStyle.description"
          aria-label="项目视觉风格"
          @change="updateVisualStyle"
        >
          <option v-for="preset in VISUAL_STYLE_PRESETS" :key="preset.id" :value="preset.id">
            {{ preset.label }}
          </option>
        </select>
        <select
          class="project-aspect-select"
          :value="workspace.project.aspectRatio"
          :disabled="aspectRatioSaving || visualStyleSaving"
          aria-label="项目画幅"
          @change="updateAspectRatio"
        >
          <option
            v-for="option in PROJECT_ASPECT_RATIO_OPTIONS"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </option>
        </select>
        <span v-if="aspectRatioError" class="project-setting-error">{{ aspectRatioError }}</span>
        <span v-if="visualStyleError" class="project-setting-error">{{ visualStyleError }}</span>
      </div>
    </header>

    <section
      v-if="workspace.project && activeTab === 'script'"
      class="vision-planner-card"
      :class="{ collapsed: !visionPlannerExpanded }"
    >
      <button class="vision-planner-summary" type="button" @click="toggleVisionPlanner">
        <span>
          <small>视觉规划 · {{ projectVisualStyle.label }}</small>
          <strong>项目视觉圣经</strong>
          <em>{{ visionForm.visualBible.trim() ? '已配置，后续生图和视频会自动继承' : '建议配置一次，用来固定项目画风、世界观和镜头语言' }}</em>
        </span>
        <span class="vision-summary-meta">
          <b>完整度 {{ visionCompletion }}%</b>
          <ChevronDown :size="18" :class="{ open: visionPlannerExpanded }" />
        </span>
      </button>
      <div v-show="visionPlannerExpanded" class="vision-planner-body">
        <div class="vision-planner-copy">
          <p class="eyebrow">视觉规划</p>
          <h2>项目视觉圣经</h2>
          <p>
            它不是剧本正文，而是给 AI 的全项目视觉规则：固定画风、世界观、美术质感、角色/场景一致性和镜头语言。保存后，后续角色图、场景图、分镜图、视频提示词会自动引用它。
          </p>
          <div class="vision-guide-grid">
            <span v-for="item in visionGuideItems" :key="item.title">
              <strong>{{ item.title }}</strong>
              {{ item.text }}
            </span>
          </div>
          <div class="vision-progress">
            <span>完整度 {{ visionCompletion }}%</span>
            <i><b :style="{ width: `${visionCompletion}%` }" /></i>
          </div>
          <div class="vision-stats">
            <span v-for="item in visionStats" :key="item.label">
              <strong>{{ item.value }}</strong>{{ item.label }}
            </span>
          </div>
        </div>
        <div class="vision-editor">
          <textarea
            v-model="visionForm.visualBible"
            maxlength="8000"
            :placeholder="visionPlaceholder"
          />
          <div class="vision-editor-footer">
            <span v-if="visionError" class="inline-error">{{ visionError }}</span>
            <span v-else-if="visionGenerating" class="inline-success">{{ visionGenerationProgressText }}</span>
            <span v-else-if="visionNotice" class="inline-success">{{ visionNotice }}</span>
            <span v-else>建议控制在 200～800 字，越具体越能稳定画风；AI 生成会把剧情提炼为公开传播的美术规则。</span>
            <div class="vision-editor-actions">
              <button
                class="button"
                type="button"
                :disabled="visionGenerating || visionSaving"
                @click="openVisionGeneration"
              >
                <Sparkles :size="16" />{{ visionGenerating ? '生成中...' : 'AI 生成视觉圣经' }}
              </button>
              <button
                class="button primary"
                type="button"
                :disabled="visionSaving || visionGenerating || visionForm.visualBible.trim() === (workspace.project.visualBible || '')"
                @click="saveVisionBible"
              >
                {{ visionSaving ? '保存中...' : '保存视觉圣经' }}
              </button>
            </div>
          </div>
          <p v-if="visionErrorTip" class="vision-error-tip">{{ visionErrorTip }}</p>
        </div>
      </div>
    </section>

    <div v-if="workspace.loading" class="workspace-loading">正在加载工作台...</div>
    <div v-else-if="workspace.error" class="workspace-error">
      <strong>工作台加载失败</strong>
      <p>{{ workspace.error }}</p>
      <button class="button" @click="workspace.load(projectId)">重新加载</button>
    </div>
    <template v-else>
      <section v-if="activeTab === 'script'" class="project-creation-tools">
        <div>
          <p class="eyebrow">项目创作工具</p>
          <h2>先拆分完整剧情，再按集生成剧本</h2>
          <p>长文分集只保留详细剧情资料；确认分集后，再用 AI 生成每一集的完整剧本。</p>
        </div>
        <div class="project-creation-actions">
          <button class="button" type="button" @click="showProjectSourceImport = true">
            <FileInput :size="16" />长文分集
          </button>
          <button class="button primary" type="button" @click="openProjectScriptGeneration">
            <Sparkles :size="16" />AI 生成剧本
          </button>
          <span v-if="workspace.episodes.length" class="project-creation-hint">
            当前 {{ workspace.episodes.length }} 集，生成结果可写入当前分集
          </span>
        </div>
      </section>
      <div v-show="activeTab === 'script'" class="workspace-panel-host">
        <EpisodeEditor :project-id="projectId" :active="activeTab === 'script'" />
      </div>
      <div v-show="activeTab === 'characters'" class="workspace-panel-host">
        <CharacterAssetsPanel :project-id="projectId" />
      </div>
      <div v-show="activeTab === 'scenes'" class="workspace-panel-host">
        <ScenesPanel :project-id="projectId" :active="activeTab === 'scenes'" />
      </div>
      <div v-show="activeTab === 'storyboards'" class="workspace-panel-host">
        <StoryboardsPanel :project-id="projectId" :active="activeTab === 'storyboards'" />
      </div>
      <div v-show="activeTab === 'tasks'" class="workspace-panel-host">
        <TaskCenterPanel :project-id="projectId" />
      </div>
      <div v-show="activeTab === 'compose'" class="workspace-panel-host">
        <ComposeExportPanel :project-id="projectId" />
      </div>
      <div v-show="activeTab === 'assets'" class="workspace-panel-host">
        <LocalAssetsPanel :project-id="projectId" />
      </div>
      <div v-show="activeTab === 'data'" class="workspace-panel-host">
        <ProjectDataPanel :project-id="projectId" />
      </div>
    </template>

    <div
      v-if="showProjectSourceImport"
      class="modal-backdrop source-import-drawer-backdrop"
      @click.self="showProjectSourceImport = false"
    >
      <section class="modal source-import-drawer" role="dialog" aria-modal="true" aria-label="项目级长文自动分集">
        <header class="source-import-drawer-header">
          <div>
            <p>项目创作工具</p>
            <h2>导入原文并自动分集</h2>
          </div>
          <button class="icon-button" type="button" title="关闭" @click="showProjectSourceImport = false">
            <X :size="18" />
          </button>
        </header>
        <div class="source-import-drawer-body">
          <SourceImportPanel :project-id="projectId" @applied="showProjectSourceImport = false" />
        </div>
      </section>
    </div>

    <div
      v-if="showProjectScriptGeneration"
      class="modal-backdrop"
      @click.self="!projectScriptGenerating && (showProjectScriptGeneration = false)"
    >
      <section class="modal project-script-dialog" role="dialog" aria-modal="true" aria-label="项目级 AI 生成剧本">
        <header>
          <div>
            <p>项目创作工具 · {{ projectScriptTargetEpisodeId ? '当前分集' : '新建分集' }}</p>
            <h2>把剧情资料写成可拍摄剧本</h2>
          </div>
          <button class="icon-button" type="button" title="关闭" :disabled="projectScriptGenerating" @click="showProjectScriptGeneration = false">
            <X :size="18" />
          </button>
        </header>
        <p class="project-script-intro">保留剧情资料的完整细节，AI 只负责把它改写成场次、动作、对白和必要旁白。</p>
        <div class="project-script-form-grid">
          <label>
            分集标题
            <input v-model="projectScriptForm.title" maxlength="120" placeholder="例如：第一集·牢狱之灾" />
          </label>
          <label>
            目标时长（秒）
            <input v-model.number="projectScriptForm.targetDurationSec" type="number" min="5" max="3600" />
          </label>
        </div>
        <label class="project-script-material-field">
          <span>剧情资料</span>
          <textarea v-model="projectScriptForm.synopsis" rows="8" :maxlength="projectScriptSourceLimit" placeholder="粘贴本集完整剧情资料。内容越完整，生成的剧本越可编辑。" />
          <small>{{ projectScriptSourceCharacters.toLocaleString() }} 字 · 最多 {{ projectScriptSourceLimit.toLocaleString() }} 字</small>
        </label>
        <p v-if="projectScriptError" class="form-error">{{ projectScriptError }}</p>
        <footer>
          <button class="button" type="button" :disabled="projectScriptGenerating" @click="showProjectScriptGeneration = false">取消</button>
          <button class="button primary" type="button" :disabled="projectScriptGenerating || !projectScriptForm.title.trim() || !projectScriptForm.synopsis.trim()" @click="projectScriptRouteOpen = true">
            <Sparkles :size="16" />选择模型并生成
          </button>
        </footer>
      </section>
    </div>

    <div v-if="showProjectScriptCandidate" class="modal-backdrop" @click.self="showProjectScriptCandidate = false">
      <section class="modal project-script-candidate-dialog" role="dialog" aria-modal="true" aria-label="AI 剧本候选稿">
        <header>
          <div>
            <p>AI 剧本候选稿</p>
            <h2>确认后写入分集</h2>
          </div>
          <button class="icon-button" type="button" title="关闭" @click="showProjectScriptCandidate = false"><X :size="18" /></button>
        </header>
        <textarea v-model="projectScriptCandidate" aria-label="AI 剧本候选稿" />
        <p class="project-script-candidate-metrics" :class="{ warning: projectScriptCandidateIsShort }">
          当前 {{ projectScriptCandidateCharacters.toLocaleString() }} 字，预计约
          {{ Math.floor(projectScriptCandidateSeconds / 60) }} 分
          {{ projectScriptCandidateSeconds % 60 }} 秒。<template v-if="projectScriptCandidateIsShort">
            低于本集建议最低 {{ projectScriptMinimumCharacters.toLocaleString() }} 字，可先补充或重新生成。
          </template>
        </p>
        <p v-if="projectScriptError" class="form-error">{{ projectScriptError }}</p>
        <footer>
          <button class="button" type="button" @click="showProjectScriptCandidate = false">稍后处理</button>
          <button class="button primary" type="button" :disabled="projectScriptApplying || !projectScriptCandidate.trim()" @click="applyProjectScriptCandidate">
            <Check :size="16" />{{ projectScriptApplying ? '写入中...' : '确认写入当前分集' }}
          </button>
        </footer>
      </section>
    </div>

    <GenerationRouteDialog
      :open="visionRouteOpen"
      :submitting="visionGenerating"
      eyebrow="视觉规划"
      title="选择用于生成视觉圣经的模型"
      submit-label="开始生成"
      service-type="TEXT"
      :execution-error="visionRouteError"
      :quote-prompt="visionGenerateQuotePrompt"
      :quote-parameters="{ temperature: 0.35, max_tokens: 1200 }"
      @close="!visionGenerating && (visionRouteOpen = false)"
      @submit="generateVisionBible"
    />
    <GenerationRouteDialog
      :open="projectScriptRouteOpen"
      :submitting="projectScriptGenerating"
      eyebrow="项目创作"
      title="选择用于生成剧本的模型"
      submit-label="开始生成"
      service-type="TEXT"
      :execution-error="projectScriptRouteError"
      :quote-prompt="projectScriptForm.synopsis"
      :quote-parameters="projectScriptGenerationParameters"
      @close="!projectScriptGenerating && (projectScriptRouteOpen = false)"
      @submit="generateProjectScript"
    />
  </StudioShell>
</template>
