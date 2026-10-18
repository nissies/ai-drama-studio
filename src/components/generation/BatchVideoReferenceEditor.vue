<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  AudioLines,
  Check,
  FileAudio,
  FileImage,
  FileVideo,
  Images,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-vue-next'
import { mediaAssetApi } from '../../api/assets'
import type { Storyboard } from '../../api/workspace'
import { loadBrowserImage, loadBrowserMedia } from '../../browser/browser-image-store'
import type { LocalAsset } from '../../desktop/types'
import {
  MAX_BATCH_REFERENCE_FILES,
  MAX_BATCH_REFERENCE_TOTAL_BYTES,
  batchReferencePurposeLabel,
  batchReferenceTypeLabel,
  cleanBatchReferenceLabel,
  isSupportedBatchReferenceMimeType,
  normalizeBatchReferenceFile,
  type BatchReferenceBindingType,
  type BatchReferenceMediaType,
  type BatchVideoReferenceDraft,
} from '../../domain/batch-video-references'
import type { StoryboardMediaReferencePurpose } from '../../domain/storyboard-media-references'
import { useDesktopStore } from '../../stores/desktop'
import { useWorkspaceStore } from '../../stores/workspace'

type AutomaticReference = {
  assetId: string
  label: string
  kind: 'KEYFRAME' | 'END_FRAME' | 'CONTACT_SHEET' | 'REFERENCE'
}
type ProjectReferenceAsset = {
  id: string
  label: string
  mimeType: string
  sizeBytes: number
  registered: boolean
  fileAvailable: boolean
  semanticHint: string
}

const props = defineProps<{
  open: boolean
  projectId: string
  shot?: Storyboard
  automaticReferences: AutomaticReference[]
  modelValue: BatchVideoReferenceDraft[]
}>()
const emit = defineEmits<{
  close: []
  'update:modelValue': [value: BatchVideoReferenceDraft[]]
  'remove-automatic': [assetId: string]
}>()

const workspace = useWorkspaceStore()
const desktop = useDesktopStore()
const drafts = ref<BatchVideoReferenceDraft[]>([])
const query = ref('')
const addingId = ref('')
const error = ref('')
const notice = ref('')
const bindingType = ref<BatchReferenceBindingType | 'AUTO'>('AUTO')
const bindingTargetId = ref('')
const bindingPurpose = ref<StoryboardMediaReferencePurpose | ''>('')
let lastEmittedValue: BatchVideoReferenceDraft[] | undefined

watch(
  () => props.modelValue,
  (value) => {
    if (value === lastEmittedValue) {
      lastEmittedValue = undefined
      return
    }
    drafts.value = value.map((item) => ({ ...item }))
  },
  { immediate: true },
)

watch(
  () => [props.open, props.shot?.id] as const,
  ([open]) => {
    if (!open) return
    query.value = ''
    error.value = ''
    notice.value = ''
    bindingType.value = 'AUTO'
    bindingPurpose.value = ''
    bindingTargetId.value = ''
  },
)

watch(bindingType, (value) => {
  const options = bindingTargetOptions(value)
  bindingTargetId.value = options[0]?.value ?? ''
})

const selectedDrafts = computed(() => drafts.value.filter((item) => item.selected))
const selectedBytes = computed(() => selectedDrafts.value.reduce((sum, item) => sum + item.file.size, 0))
const projectAssets = computed<ProjectReferenceAsset[]>(() => {
  const merged = new Map<string, ProjectReferenceAsset>()
  for (const asset of desktop.project?.assets ?? []) {
    if (!isSupportedProjectMime(asset.mimeType)) continue
    merged.set(asset.id, {
      id: asset.id,
      label: asset.originalName,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      registered: Boolean(workspace.mediaAssetById(asset.id)),
      fileAvailable: asset.fileAvailable,
      semanticHint: semanticHint(asset.id),
    })
  }
  for (const asset of workspace.mediaAssets) {
    if (!isSupportedProjectMime(asset.mimeType)) continue
    const current = merged.get(asset.id)
    merged.set(asset.id, {
      id: asset.id,
      label: asset.originalFilename,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      registered: true,
      fileAvailable: current?.fileAvailable || Boolean(asset.contentAvailable || asset.storageScope === 'SERVER'),
      semanticHint: semanticHint(asset.id),
    })
  }
  const keyword = query.value.trim().toLowerCase()
  return [...merged.values()]
    .filter((asset) => asset.fileAvailable)
    .filter((asset) => !drafts.value.some((item) => item.assetId === asset.id))
    .filter(
      (asset) =>
        !keyword ||
        asset.label.toLowerCase().includes(keyword) ||
        asset.semanticHint.toLowerCase().includes(keyword),
    )
    .sort((left, right) => Number(right.fileAvailable) - Number(left.fileAvailable) || left.label.localeCompare(right.label))
})

function emitDrafts() {
  const value = drafts.value.map((item) => ({ ...item }))
  lastEmittedValue = value
  emit('update:modelValue', value)
}

async function addUploadedFiles(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  error.value = ''
  notice.value = ''
  for (const sourceFile of files) {
    if (drafts.value.length >= MAX_BATCH_REFERENCE_FILES) {
      error.value = `补充参考素材最多 ${MAX_BATCH_REFERENCE_FILES} 个`
      break
    }
    try {
      const normalized = await normalizeBatchReferenceFile(sourceFile)
      if (totalBytes() + normalized.file.size > MAX_BATCH_REFERENCE_TOTAL_BYTES) {
        throw new Error('补充参考素材总大小不能超过 100MB')
      }
      drafts.value.push({
        id: crypto.randomUUID(),
        file: normalized.file,
        previewUrl: URL.createObjectURL(normalized.file),
        mediaType: normalized.mediaType,
        source: 'UPLOAD',
        label: cleanBatchReferenceLabel(sourceFile.name),
        selected: true,
        usageNote: '',
      })
      notice.value = '新素材已加入，请在右侧说明它对应谁、用来做什么'
    } catch (caught) {
      error.value = messageFor(caught, `${sourceFile.name} 添加失败`)
    }
  }
  emitDrafts()
}

async function addProjectAsset(asset: ProjectReferenceAsset) {
  if (addingId.value || drafts.value.length >= MAX_BATCH_REFERENCE_FILES) return
  addingId.value = asset.id
  error.value = ''
  notice.value = ''
  try {
    const assetId = await ensureRegisteredAssetId(asset.id)
    const inferred = inferBinding(assetId)
    const explicit = bindingType.value === 'AUTO' ? inferred : explicitBinding()
    if (!explicit) throw new Error('该素材没有已有角色/场景绑定，请先在上方选择素材身份和绑定对象')
    const file = await loadProjectAssetFile(assetId, asset.label)
    const normalized = await normalizeBatchReferenceFile(file)
    if (totalBytes() + normalized.file.size > MAX_BATCH_REFERENCE_TOTAL_BYTES) {
      throw new Error('补充参考素材总大小不能超过 100MB')
    }
    drafts.value.push({
      id: crypto.randomUUID(),
      file: normalized.file,
      previewUrl: URL.createObjectURL(normalized.file),
      mediaType: normalized.mediaType,
      source: 'PROJECT',
      assetId,
      label: cleanBatchReferenceLabel(asset.label),
      selected: true,
      bindingType: explicit.bindingType,
      bindingTargetId: explicit.bindingTargetId,
      purpose: explicit.purpose,
      usageNote: explicit.usageNote,
    })
    notice.value = `已添加“${asset.label}”，角色/场景身份与用途会一起发送给模型`
    emitDrafts()
  } catch (caught) {
    error.value = messageFor(caught, '项目素材添加失败')
  } finally {
    addingId.value = ''
  }
}

function updateDraft(item: BatchVideoReferenceDraft) {
  normalizeDraftBinding(item)
  emitDrafts()
}

function removeDraft(index: number) {
  const [removed] = drafts.value.splice(index, 1)
  if (removed) URL.revokeObjectURL(removed.previewUrl)
  emitDrafts()
}

function normalizeDraftBinding(item: BatchVideoReferenceDraft) {
  if (!item.bindingType) {
    item.bindingTargetId = undefined
    return
  }
  const options = bindingTargetOptions(item.bindingType)
  if (options.length && !options.some((option) => option.value === item.bindingTargetId)) {
    item.bindingTargetId = options[0]?.value
  }
  if (item.bindingType === 'VOICE' && !item.purpose) item.purpose = 'VOICE_IDENTITY'
  if (item.bindingType === 'SFX' && !item.purpose) item.purpose = 'BACKGROUND_AUDIO'
  if (item.bindingType === 'MOTION' && !item.purpose) item.purpose = 'MOTION_REFERENCE'
  if (!item.usageNote.trim()) item.usageNote = defaultUsageNote(item.bindingType, item.bindingTargetId)
}

function bindingTargetOptions(type?: BatchReferenceBindingType | 'AUTO') {
  if (type === 'CHARACTER' || type === 'VOICE') {
    const current = new Set(props.shot?.characterIds ?? [])
    return workspace.characters
      .map((character) => ({ value: character.id, label: character.name, current: current.has(character.id) }))
      .sort((left, right) => Number(right.current) - Number(left.current))
  }
  if (type === 'SCENE' || type === 'BACKGROUND') {
    return workspace.scenes
      .map((scene) => ({ value: scene.id, label: scene.title, current: scene.id === props.shot?.sceneId }))
      .sort((left, right) => Number(right.current) - Number(left.current))
  }
  return []
}

function inferBinding(assetId: string) {
  const voice = workspace.characterVoiceReferences.find((item) => item.assetId === assetId)
  if (voice) return bindingResult('VOICE', voice.characterId, 'VOICE_IDENTITY')
  const character = workspace.characterReferences.find((item) => item.assetId === assetId)
  if (character) return bindingResult('CHARACTER', character.characterId)
  const scene = workspace.sceneReferences.find((item) => item.assetId === assetId)
  if (scene) return bindingResult('SCENE', scene.sceneId)
  return undefined
}

function explicitBinding() {
  if (bindingType.value === 'AUTO') return undefined
  const purpose =
    bindingPurpose.value ||
    (bindingType.value === 'VOICE'
      ? 'VOICE_IDENTITY'
      : bindingType.value === 'SFX'
        ? 'BACKGROUND_AUDIO'
        : bindingType.value === 'MOTION'
          ? 'MOTION_REFERENCE'
          : undefined)
  return bindingResult(bindingType.value, bindingTargetId.value || undefined, purpose)
}

function bindingResult(
  type: BatchReferenceBindingType,
  targetId?: string,
  purpose?: StoryboardMediaReferencePurpose,
) {
  return {
    bindingType: type,
    bindingTargetId: targetId,
    purpose,
    usageNote: defaultUsageNote(type, targetId),
  }
}

function defaultUsageNote(type: BatchReferenceBindingType, targetId?: string) {
  const character = workspace.characters.find((item) => item.id === targetId)?.name
  const scene = workspace.scenes.find((item) => item.id === targetId)?.title
  if (type === 'CHARACTER') return `这是角色“${character || '指定角色'}”的外观参考，只用于保持脸、发型、服装和体型一致。`
  if (type === 'VOICE') return `这是角色“${character || '指定角色'}”的声音样本，只用于保持音色、年龄感和说话质感。`
  if (type === 'SCENE' || type === 'BACKGROUND') return `这是场景“${scene || '指定场景'}”的背景参考，只用于空间结构、光线、陈设和氛围。`
  if (type === 'PROP') return '这是当前镜头的道具参考，只用于道具外观、材质、尺寸和摆放方式。'
  if (type === 'WEAPON') return `这是${character ? `角色“${character}”的` : ''}武器参考，只用于武器外观、比例、握持方式和战斗动作。`
  if (type === 'MOTION') return '这是动作参考，只用于动作轨迹、节奏、身体姿态和镜头运动。'
  if (type === 'SFX') return '这是音效或环境声参考，只用于当前镜头的声音氛围、节奏和环境质感。'
  return '这是风格参考，只用于画风、光影、色彩、材质和镜头质感，不改变角色身份。'
}

function bindingLabel(item: Pick<BatchVideoReferenceDraft, 'bindingType' | 'bindingTargetId'>) {
  const type = item.bindingType
  if (!type) return '尚未指定素材身份'
  const character = workspace.characters.find((entry) => entry.id === item.bindingTargetId)?.name
  const scene = workspace.scenes.find((entry) => entry.id === item.bindingTargetId)?.title
  if (type === 'CHARACTER') return character ? `角色：${character}` : '角色参考'
  if (type === 'VOICE') return character ? `角色声音：${character}` : '角色声音'
  if (type === 'SCENE') return scene ? `场景：${scene}` : '场景参考'
  if (type === 'BACKGROUND') return scene ? `背景：${scene}` : '背景/环境'
  if (type === 'PROP') return '道具参考'
  if (type === 'WEAPON') return character ? `武器：${character}` : '武器参考'
  if (type === 'MOTION') return '动作参考'
  if (type === 'SFX') return '音效/环境声'
  return '风格参考'
}

function semanticHint(assetId: string) {
  const inferred = inferBinding(assetId)
  if (!inferred) return '尚未绑定角色或场景，可手动指定用途'
  return bindingLabel({ bindingType: inferred.bindingType, bindingTargetId: inferred.bindingTargetId })
}

function automaticPreviewUrl(assetId: string) {
  const local = desktop.project?.assets.find((item) => item.id === assetId)
  return local?.fileAvailable ? desktop.assetPreviewUrl(assetId) : ''
}

async function ensureRegisteredAssetId(assetId: string) {
  if (workspace.mediaAssetById(assetId)) return assetId
  const local = desktop.project?.assets.find((asset) => asset.id === assetId)
  if (!local) return assetId
  const mappings = await workspace.synchronizeLocalAssets(props.projectId, [local as LocalAsset])
  await desktop.reconcileAssetIds(mappings.filter((item) => item.clientAssetId !== item.assetId))
  return mappings.find((item) => item.clientAssetId === assetId)?.assetId ?? assetId
}

async function loadProjectAssetFile(assetId: string, label: string) {
  const local = desktop.project?.assets.find((item) => item.id === assetId)
  const server = workspace.mediaAssetById(assetId)
  let blob: Blob | null = null
  if (desktop.available && local?.fileAvailable) {
    blob = await tryLoadBlob(async () => {
      const response = await fetch(desktop.assetPreviewUrl(assetId))
      return response.ok ? response.blob() : null
    })
  }
  if (!blob && (server?.contentAvailable || server?.storageScope === 'SERVER')) {
    blob = await tryLoadBlob(() => mediaAssetApi.content(props.projectId, assetId))
  }
  if (!blob) {
    blob = await tryLoadBlob(() =>
      (server?.mimeType || local?.mimeType || '').startsWith('image/')
        ? loadBrowserImage(props.projectId, assetId)
        : loadBrowserMedia(props.projectId, assetId),
    )
  }
  if (!blob) throw new Error(`${label}的本地和服务端文件都不可用`)
  const mimeType = blob.type || server?.mimeType || local?.mimeType || ''
  return new File([blob], server?.originalFilename || local?.originalName || label, {
    type: mimeType,
    lastModified: Date.now(),
  })
}

async function tryLoadBlob(load: () => Promise<Blob | null>) {
  try {
    return await load()
  } catch {
    return null
  }
}

function isSupportedProjectMime(mimeType: string) {
  return isSupportedBatchReferenceMimeType(mimeType.split(';', 1)[0].trim().toLowerCase())
}

function totalBytes() {
  return drafts.value.reduce((sum, item) => sum + item.file.size, 0)
}

function mediaIcon(mediaType: BatchReferenceMediaType) {
  return mediaType
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

function messageFor(caught: unknown, fallback: string) {
  return caught instanceof Error && caught.message ? caught.message : fallback
}
</script>

<template>
  <div v-if="open" class="batch-reference-backdrop" @click.self="emit('close')">
    <section class="batch-reference-dialog" role="dialog" aria-modal="true" aria-label="管理批量视频参考素材">
      <header class="batch-reference-hero">
        <div>
          <span><Images :size="15" />镜头参考素材</span>
          <h2>镜头 {{ shot?.shotNo }} · {{ shot?.title }}</h2>
          <p>项目素材会自动携带角色或场景身份；新上传素材必须说明用途，生成时才不会被模型误解。</p>
        </div>
        <button type="button" title="关闭" @click="emit('close')"><X :size="20" /></button>
      </header>

      <div v-if="error" class="batch-reference-message error">{{ error }}</div>
      <div v-if="notice" class="batch-reference-message success"><Check :size="14" />{{ notice }}</div>

      <section class="automatic-reference-strip">
        <div class="automatic-reference-heading">
          <div><strong>自动关联素材</strong><span>系统根据当前分镜的角色、场景和首尾帧自动识别</span></div>
          <em>{{ automaticReferences.length }} 项</em>
        </div>
        <div v-if="automaticReferences.length" class="automatic-reference-list">
          <article v-for="item in automaticReferences" :key="`${item.kind}-${item.assetId}`">
            <img v-if="automaticPreviewUrl(item.assetId)" :src="automaticPreviewUrl(item.assetId)" :alt="item.label" />
            <span v-else><FileImage :size="18" /></span>
            <div><strong :title="item.label">{{ item.label }}</strong><small>{{ item.kind === 'KEYFRAME' ? '首帧输入' : item.kind === 'END_FRAME' ? '尾帧参考' : item.kind === 'CONTACT_SHEET' ? '九宫格节奏参考' : '角色/场景参考' }}</small></div>
            <button
              type="button"
              class="automatic-reference-remove"
              title="移除本次关联，不删除项目文件"
              :aria-label="`移除${item.label}的本次关联`"
              @click="emit('remove-automatic', item.assetId)"
            >
              <X :size="13" />
            </button>
          </article>
        </div>
        <div v-else class="automatic-reference-empty">当前分镜还没有自动关联素材，可从下方项目素材中补充。</div>
        <p v-if="automaticReferences.some((item) => item.kind === 'CONTACT_SHEET')" class="automatic-reference-warning">
          <FileImage :size="13" />九宫格图片可能被部分视频模型判定为多画面或版权风险，导致生成被拒；可移除本次关联后再生成。
        </p>
      </section>

      <div class="batch-reference-workspace">
        <section class="project-reference-pane">
          <header>
            <div><strong>从项目素材添加</strong><span>选择素材身份后添加，模型会知道它对应哪个角色或场景</span></div>
            <label class="upload-reference-button">
              <Upload :size="15" />上传新素材
              <input type="file" multiple accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,video/quicktime,audio/mpeg,audio/wav,audio/x-wav,audio/aac,audio/mp4,audio/ogg,audio/flac,.png,.jpg,.jpeg,.webp,.mp4,.webm,.mov,.mp3,.wav,.aac,.m4a,.ogg,.flac" @change="addUploadedFiles" />
            </label>
          </header>

          <div class="project-reference-binding">
            <label><span>素材身份</span><select v-model="bindingType"><option value="AUTO">自动识别已有绑定</option><option value="CHARACTER">角色外观</option><option value="SCENE">所属场景</option><option value="BACKGROUND">背景/环境</option><option value="PROP">道具</option><option value="WEAPON">角色武器</option><option value="MOTION">动作参考</option><option value="VOICE">角色声音</option><option value="SFX">音效/环境声</option><option value="STYLE">视觉风格</option></select></label>
            <label v-if="bindingTargetOptions(bindingType).length"><span>绑定对象</span><select v-model="bindingTargetId"><option v-for="option in bindingTargetOptions(bindingType)" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
            <label><span>发送用途</span><select v-model="bindingPurpose"><option value="">按身份自动判断</option><option value="FIRST_FRAME">首帧参考</option><option value="END_FRAME">尾帧参考</option><option value="CONTINUITY">连续性参考</option><option value="MOTION_REFERENCE">动作参考</option><option value="VOICE_IDENTITY">角色声音</option><option value="BACKGROUND_AUDIO">背景声音</option></select></label>
          </div>

          <label class="project-reference-search"><Search :size="15" /><input v-model="query" placeholder="搜索角色图、场景图、视频或音频" /></label>
          <div class="project-reference-grid">
            <button v-for="asset in projectAssets.slice(0, 40)" :key="asset.id" type="button" :disabled="Boolean(addingId) || !asset.fileAvailable" @click="addProjectAsset(asset)">
              <span class="project-reference-icon"><FileImage v-if="asset.mimeType.startsWith('image/')" :size="17" /><FileVideo v-else-if="asset.mimeType.startsWith('video/')" :size="17" /><FileAudio v-else :size="17" /></span>
              <span><strong :title="asset.label">{{ asset.label }}</strong><small>{{ asset.semanticHint }}</small><small>{{ formatBytes(asset.sizeBytes) }} · {{ asset.registered ? '已登记' : '添加时自动登记' }}</small></span>
              <em>{{ addingId === asset.id ? '读取中' : asset.fileAvailable ? '添加' : '文件不可用' }}</em>
            </button>
            <div v-if="!projectAssets.length" class="project-reference-empty"><Images :size="26" /><span>没有匹配的可用项目素材</span></div>
          </div>
        </section>

        <section class="selected-reference-pane">
          <header>
            <div><strong>本次补充素材</strong><span>选中的素材会随当前镜头发送，不会替换项目原素材</span></div>
            <em>{{ selectedDrafts.length }} 项 · {{ formatBytes(selectedBytes) }}</em>
          </header>
          <div v-if="drafts.length" class="selected-reference-list">
            <article v-for="(item, index) in drafts" :key="item.id" :class="{ disabled: !item.selected, incomplete: item.source === 'UPLOAD' && !item.usageNote.trim() }">
              <div class="selected-reference-top">
                <label class="selected-reference-check"><input v-model="item.selected" type="checkbox" @change="emitDrafts" /><span><Check :size="12" /></span></label>
                <div class="selected-reference-preview"><img v-if="mediaIcon(item.mediaType) === 'IMAGE'" :src="item.previewUrl" :alt="item.label" /><video v-else-if="mediaIcon(item.mediaType) === 'VIDEO'" :src="item.previewUrl" muted preload="metadata" /><AudioLines v-else :size="22" /></div>
                <div class="selected-reference-title"><input v-model="item.label" maxlength="120" @input="emitDrafts" /><span>{{ item.source === 'PROJECT' ? '项目素材' : '临时上传' }} · {{ batchReferenceTypeLabel(item.mediaType) }} · {{ formatBytes(item.file.size) }}</span></div>
                <button type="button" title="移除" @click="removeDraft(index)"><Trash2 :size="15" /></button>
              </div>
              <div class="selected-reference-controls">
                <select v-model="item.bindingType" @change="updateDraft(item)"><option :value="undefined">选择素材身份</option><option value="CHARACTER">角色外观</option><option value="SCENE">所属场景</option><option value="BACKGROUND">背景/环境</option><option value="PROP">道具</option><option value="WEAPON">角色武器</option><option value="MOTION">动作参考</option><option value="VOICE">角色声音</option><option value="SFX">音效/环境声</option><option value="STYLE">视觉风格</option></select>
                <select v-if="bindingTargetOptions(item.bindingType).length" v-model="item.bindingTargetId" @change="updateDraft(item)"><option v-for="option in bindingTargetOptions(item.bindingType)" :key="option.value" :value="option.value">{{ option.label }}</option></select>
                <select v-model="item.purpose" @change="emitDrafts"><option :value="undefined">普通参考</option><option value="FIRST_FRAME">首帧参考</option><option value="END_FRAME">尾帧参考</option><option value="CONTINUITY">连续性参考</option><option value="MOTION_REFERENCE">动作参考</option><option value="VOICE_IDENTITY">角色声音</option><option value="BACKGROUND_AUDIO">背景声音</option></select>
              </div>
              <textarea v-model="item.usageNote" rows="2" maxlength="300" placeholder="必须说明素材用途，例如：这是许七安的佩刀，只用于武器外观、比例和握持动作" @input="emitDrafts" />
              <footer><span>{{ bindingLabel(item) }}</span><em v-if="item.purpose">{{ batchReferencePurposeLabel(item.purpose) }}</em><strong v-if="item.source === 'UPLOAD' && !item.usageNote.trim()">请补充用途说明</strong></footer>
            </article>
          </div>
          <div v-else class="selected-reference-empty"><Upload :size="28" /><strong>尚未添加补充素材</strong><span>从左侧项目素材添加，或上传图片、视频、音频后说明用途。</span></div>
        </section>
      </div>

      <footer class="batch-reference-footer">
        <span>平台视频模型会收到自动素材和已勾选的补充素材；本地模型仍按其自身接口能力处理。</span>
        <button type="button" @click="emit('close')"><Check :size="15" />完成</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.batch-reference-backdrop{position:fixed;inset:0;z-index:90;display:grid;place-items:center;padding:24px;background:rgba(16,27,40,.62);backdrop-filter:blur(7px)}
.batch-reference-dialog{display:flex;flex-direction:column;width:min(1120px,96vw);max-height:92vh;overflow:hidden;border:1px solid rgba(211,221,232,.95);border-radius:18px;background:#f6f8fb;box-shadow:0 30px 90px rgba(9,24,42,.32)}
.batch-reference-hero{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding:22px 25px 18px;border-bottom:1px solid #dfe6ee;background:linear-gradient(135deg,#fff 0%,#f3f7fd 62%,#edf5ff 100%)}
.batch-reference-hero>div>span{display:flex;align-items:center;gap:7px;color:#2d6dc3;font-size:12px;font-weight:850}.batch-reference-hero h2{margin:6px 0 4px;color:#1d334b;font-size:23px}.batch-reference-hero p{margin:0;color:#6d7f93;font-size:12px}.batch-reference-hero>button{display:grid;place-items:center;width:36px;height:36px;border:1px solid #d7e1eb;border-radius:10px;background:#fff;color:#607286;cursor:pointer}
.batch-reference-message{display:flex;align-items:center;gap:7px;margin:12px 20px 0;padding:9px 12px;border-radius:9px;font-size:12px}.batch-reference-message.error{border:1px solid #efc7c2;background:#fff2f0;color:#ae4138}.batch-reference-message.success{border:1px solid #c9e5d4;background:#eff9f3;color:#28774d}
.automatic-reference-strip{margin:14px 20px 0;padding:13px;border:1px solid #dde6ef;border-radius:12px;background:#fff}.automatic-reference-heading,.project-reference-pane>header,.selected-reference-pane>header{display:flex;align-items:center;justify-content:space-between;gap:14px}.automatic-reference-heading>div,.project-reference-pane>header>div,.selected-reference-pane>header>div{display:grid;gap:3px}.automatic-reference-heading strong,.project-reference-pane strong,.selected-reference-pane strong{color:#283f57;font-size:13px}.automatic-reference-heading span,.project-reference-pane header span,.selected-reference-pane header span{color:#8694a4;font-size:10px}.automatic-reference-heading em,.selected-reference-pane>header>em{padding:4px 8px;border-radius:12px;background:#edf4fd;color:#2f6ebf;font-size:10px;font-style:normal;font-weight:800}.automatic-reference-list{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:10px}.automatic-reference-list article{display:flex;align-items:center;gap:8px;min-width:0;padding:7px;border:1px solid #e4e9ef;border-radius:8px;background:#fafbfd}.automatic-reference-list img,.automatic-reference-list article>span{display:grid;place-items:center;width:44px;height:38px;flex:none;border-radius:6px;background:#edf2f7;color:#8b9bad;object-fit:cover}.automatic-reference-list article>div{display:grid;min-width:0;gap:3px}.automatic-reference-list strong{overflow:hidden;color:#465b71;font-size:10px;text-overflow:ellipsis;white-space:nowrap}.automatic-reference-list small{color:#94a0ad;font-size:9px}.automatic-reference-empty{margin-top:9px;color:#93a0ae;font-size:11px}.automatic-reference-remove{display:grid;place-items:center;flex:none;width:22px;height:22px;margin-left:auto;border:1px solid #d8e2ec;border-radius:6px;background:#fff;color:#8495a6;cursor:pointer}.automatic-reference-remove:hover{border-color:#d88d85;background:#fff5f3;color:#b54e45}.automatic-reference-warning{display:flex;align-items:flex-start;gap:5px;margin:10px 0 0;padding:8px 10px;border:1px solid #f0d3a1;border-radius:8px;background:#fff8e9;color:#94651e;font-size:11px;line-height:1.5}
.batch-reference-workspace{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(390px,.95fr);gap:14px;min-height:0;padding:14px 20px 18px;overflow:auto}.project-reference-pane,.selected-reference-pane{min-height:480px;padding:15px;border:1px solid #dce5ee;border-radius:12px;background:#fff}.upload-reference-button{display:flex;align-items:center;gap:6px;padding:8px 11px;border:1px solid #b9d0eb;border-radius:8px;background:#f4f8fd;color:#2a68b5;font-size:11px;font-weight:800;cursor:pointer}.upload-reference-button input{display:none}
.project-reference-binding{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:13px 0 9px;padding:10px;border:1px solid #e3eaf1;border-radius:9px;background:#f8fafc}.project-reference-binding label{display:grid;gap:4px}.project-reference-binding span{color:#8492a1;font-size:9px;font-weight:800}.project-reference-binding select,.selected-reference-controls select{min-width:0;height:32px;border:1px solid #d6e0e9;border-radius:7px;background:#fff;padding:0 8px;color:#40566d;font-size:10px}
.project-reference-search{display:flex;align-items:center;gap:7px;height:35px;padding:0 10px;border:1px solid #d8e1ea;border-radius:8px;color:#8d9aa8}.project-reference-search input{min-width:0;flex:1;border:0;outline:0;background:transparent;color:#42576c;font-size:11px}.project-reference-grid{display:grid;gap:7px;max-height:360px;margin-top:9px;overflow:auto;padding-right:4px}.project-reference-grid>button{display:grid;grid-template-columns:38px minmax(0,1fr) auto;align-items:center;gap:9px;width:100%;padding:8px;border:1px solid #e2e8ee;border-radius:8px;background:#fff;text-align:left;cursor:pointer}.project-reference-grid>button:hover:not(:disabled){border-color:#8eb4df;background:#f7faff}.project-reference-grid>button:disabled{cursor:not-allowed;opacity:.52}.project-reference-icon{display:grid;place-items:center;width:38px;height:38px;border-radius:7px;background:#edf3fa;color:#557697}.project-reference-grid button>span:nth-child(2){display:grid;min-width:0;gap:2px}.project-reference-grid strong{overflow:hidden;font-size:10px;text-overflow:ellipsis;white-space:nowrap}.project-reference-grid small{overflow:hidden;color:#8795a4;font-size:9px;text-overflow:ellipsis;white-space:nowrap}.project-reference-grid em{color:#3271bf;font-size:9px;font-style:normal;font-weight:800}.project-reference-empty,.selected-reference-empty{display:grid;place-items:center;gap:7px;min-height:180px;color:#98a5b2;font-size:11px;text-align:center}
.selected-reference-list{display:grid;gap:9px;max-height:440px;margin-top:12px;overflow:auto;padding-right:4px}.selected-reference-list article{padding:10px;border:1px solid #dde5ed;border-radius:10px;background:#fbfcfd;transition:.15s}.selected-reference-list article.incomplete{border-color:#e7bb87;background:#fffaf2}.selected-reference-list article.disabled{opacity:.55}.selected-reference-top{display:grid;grid-template-columns:22px 54px minmax(0,1fr) 28px;align-items:center;gap:8px}.selected-reference-check input{display:none}.selected-reference-check span{display:grid;place-items:center;width:19px;height:19px;border:1px solid #c5d0dc;border-radius:5px;background:#fff;color:transparent}.selected-reference-check input:checked+span{border-color:#2873d2;background:#2873d2;color:#fff}.selected-reference-preview{display:grid;place-items:center;width:54px;height:46px;overflow:hidden;border-radius:7px;background:#edf2f7;color:#8092a5}.selected-reference-preview img,.selected-reference-preview video{width:100%;height:100%;object-fit:cover}.selected-reference-title{display:grid;min-width:0;gap:3px}.selected-reference-title input{min-width:0;border:0;border-bottom:1px solid transparent;outline:0;background:transparent;color:#344b62;font-size:11px;font-weight:800}.selected-reference-title input:focus{border-bottom-color:#80aadd}.selected-reference-title span{color:#8c99a6;font-size:9px}.selected-reference-top>button{display:grid;place-items:center;width:28px;height:28px;border:0;border-radius:7px;background:transparent;color:#9a6870;cursor:pointer}.selected-reference-top>button:hover{background:#fff0ef;color:#b2473f}.selected-reference-controls{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin-top:9px}.selected-reference-list textarea{box-sizing:border-box;width:100%;margin-top:7px;padding:8px;border:1px solid #d9e2ea;border-radius:7px;outline:0;background:#fff;color:#465a6f;font-family:inherit;font-size:10px;line-height:1.5;resize:vertical}.selected-reference-list textarea:focus{border-color:#80a9d7;box-shadow:0 0 0 3px rgba(52,119,196,.09)}.selected-reference-list footer{display:flex;align-items:center;gap:6px;margin-top:6px;color:#6d8296;font-size:9px}.selected-reference-list footer em{padding:2px 5px;border-radius:5px;background:#eaf3fd;color:#3975b9;font-style:normal}.selected-reference-list footer strong{margin-left:auto;color:#bc6a32;font-size:9px}.selected-reference-empty strong{color:#5f7184;font-size:12px}.selected-reference-empty span{max-width:280px;line-height:1.6}
.batch-reference-footer{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:13px 20px;border-top:1px solid #dce4ec;background:#fff}.batch-reference-footer>span{color:#7d8c9c;font-size:10px}.batch-reference-footer button{display:flex;align-items:center;gap:6px;padding:9px 18px;border:0;border-radius:9px;background:#2872cf;color:#fff;font-size:12px;font-weight:800;cursor:pointer;box-shadow:0 7px 16px rgba(40,114,207,.2)}
@media(max-width:900px){.batch-reference-workspace{grid-template-columns:1fr}.automatic-reference-list{grid-template-columns:repeat(2,minmax(0,1fr))}.project-reference-pane,.selected-reference-pane{min-height:0}}
</style>
