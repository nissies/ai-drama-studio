<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import {
  Download,
  Grid2X2,
  ImagePlus,
  List,
  LoaderCircle,
  Pencil,
  Plus,
  Search,
  Trash2,
  Upload,
  UserRound,
  Volume2,
  WandSparkles,
  X,
} from 'lucide-vue-next'
import AssetPickerDialog from '../assets/AssetPickerDialog.vue'
import ImageGenerationDialog from '../generation/ImageGenerationDialog.vue'
import { mediaAssetApi } from '../../api/assets'
import type {
  CharacterAsset,
  CharacterForm,
  CharacterFormInput,
  CharacterInput,
} from '../../api/workspace'
import { useDesktopStore } from '../../stores/desktop'
import { useWorkspaceStore } from '../../stores/workspace'
import {
  loadBrowserImage,
  loadBrowserMedia,
  saveBrowserMedia,
  sha256Hex,
  validateBrowserImage,
} from '../../browser/browser-image-store'
import type { LocalAsset } from '../../desktop/types'
import { isVoicePreset, voicePresetLabel, VOICE_PRESETS } from '../../domain/voice-presets'

const props = defineProps<{ projectId: string }>()
const workspace = useWorkspaceStore()
const desktop = useDesktopStore()
const query = ref('')
const roleFilter = ref('ALL')
const view = ref<'grid' | 'list'>('grid')
const showCharacterEditor = ref(false)
const showFormEditor = ref(false)
const editingCharacterId = ref<string>()
const formCharacterId = ref('')
const editingFormId = ref<string>()
const saving = ref(false)
const formError = ref('')
const characterForm = reactive<CharacterInput>(emptyCharacter())
const appearanceForm = reactive<CharacterFormInput>(emptyAppearanceForm())
const assetPicker = ref<{
  characterId: string
  characterName: string
  formId?: string
  formName?: string
} | null>(null)
const imageTarget = ref<{ character: CharacterAsset; form?: CharacterForm } | null>(null)
const browserUploadInput = ref<globalThis.HTMLInputElement>()
const browserUploadTarget = ref<{ character: CharacterAsset; form?: CharacterForm } | null>(null)
const browserVoiceUploadInput = ref<globalThis.HTMLInputElement>()
const browserVoiceUploadTarget = ref<CharacterAsset | null>(null)
const browserPreviewUrls = reactive(new Map<string, string>())
const browserVoicePreviewUrls = reactive(new Map<string, string>())
const voiceActingCharacterId = ref('')
let voicePreviewLoadVersion = 0

const MAX_VOICE_SAMPLE_BYTES = 30 * 1024 * 1024
const AUDIO_MIME_BY_EXTENSION = new Map([
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.m4a', 'audio/mp4'],
  ['.aac', 'audio/aac'],
  ['.ogg', 'audio/ogg'],
  ['.flac', 'audio/flac'],
])
const SUPPORTED_AUDIO_MIME_TYPES = new Set(AUDIO_MIME_BY_EXTENSION.values())

const filteredCharacters = computed(() =>
  workspace.characters.filter((character) => {
    const keyword = query.value.trim().toLowerCase()
    return (
      (!keyword ||
        character.name.toLowerCase().includes(keyword) ||
        character.description?.toLowerCase().includes(keyword)) &&
      (roleFilter.value === 'ALL' || character.roleType === roleFilter.value)
    )
  }),
)
const hasCustomCharacterVoice = computed(() =>
  Boolean(characterForm.ttsVoiceId && !isVoicePreset(characterForm.ttsVoiceId)),
)

function emptyCharacter(): CharacterInput {
  return {
    name: '',
    roleType: '主要角色',
    description: '',
    identityPrompt: '',
    negativePrompt: '',
    voiceDescription: '',
    ttsVoiceId: '',
  }
}
function emptyAppearanceForm(): CharacterFormInput {
  return {
    formCategory: 'APPEARANCE',
    displayName: '',
    appearancePrompt: '',
    negativePrompt: '',
    defaultForm: false,
  }
}

const formCategoryOptions = [
  { value: 'APPEARANCE', label: '形态' },
  { value: 'COSTUME', label: '服装' },
  { value: 'WEAPON', label: '武器' },
] as const

function formCategoryLabel(category?: string) {
  const value = (category || 'APPEARANCE').toUpperCase()
  return formCategoryOptions.find((item) => item.value === value)?.label || '形态'
}

function sortedForms(character: CharacterAsset) {
  const order = { APPEARANCE: 0, COSTUME: 1, WEAPON: 2 } as Record<string, number>
  return [...character.forms].sort((left, right) => {
    const leftOrder = order[(left.formCategory || 'APPEARANCE').toUpperCase()] ?? 9
    const rightOrder = order[(right.formCategory || 'APPEARANCE').toUpperCase()] ?? 9
    if (leftOrder !== rightOrder) return leftOrder - rightOrder
    return left.displayName.localeCompare(right.displayName, 'zh-CN')
  })
}

function openCreateFormWithCategory(
  character: CharacterAsset,
  category: (typeof formCategoryOptions)[number]['value'],
) {
  openCreateForm(character)
  appearanceForm.formCategory = category
}
function openCreateCharacter() {
  editingCharacterId.value = undefined
  Object.assign(characterForm, emptyCharacter())
  formError.value = ''
  showCharacterEditor.value = true
}
function openEditCharacter(character: CharacterAsset) {
  editingCharacterId.value = character.id
  Object.assign(characterForm, {
    name: character.name,
    roleType: character.roleType ?? '',
    description: character.description ?? '',
    identityPrompt: character.identityPrompt ?? '',
    negativePrompt: character.negativePrompt ?? '',
    voiceDescription: character.voiceDescription ?? '',
    ttsVoiceId: character.ttsVoiceId ?? '',
    version: character.version,
  })
  formError.value = ''
  showCharacterEditor.value = true
}
function openCreateForm(character: CharacterAsset) {
  formCharacterId.value = character.id
  editingFormId.value = undefined
  Object.assign(appearanceForm, emptyAppearanceForm())
  formError.value = ''
  showFormEditor.value = true
}
function openEditForm(character: CharacterAsset, form: CharacterForm) {
  formCharacterId.value = character.id
  editingFormId.value = form.id
  Object.assign(appearanceForm, {
    formCategory: form.formCategory || 'APPEARANCE',
    displayName: form.displayName,
    appearancePrompt: form.appearancePrompt ?? '',
    negativePrompt: form.negativePrompt ?? '',
    defaultForm: form.defaultForm,
  })
  formError.value = ''
  showFormEditor.value = true
}
async function saveCharacter() {
  if (!characterForm.name.trim() || saving.value) return
  saving.value = true
  formError.value = ''
  try {
    await workspace.saveCharacter(props.projectId, characterForm, editingCharacterId.value)
    showCharacterEditor.value = false
  } catch (error) {
    formError.value = error instanceof Error ? error.message : '角色保存失败'
  } finally {
    saving.value = false
  }
}
async function saveAppearanceForm() {
  if (!appearanceForm.displayName.trim() || saving.value) return
  saving.value = true
  formError.value = ''
  try {
    await workspace.saveCharacterForm(
      props.projectId,
      formCharacterId.value,
      appearanceForm,
      editingFormId.value,
    )
    showFormEditor.value = false
  } catch (error) {
    formError.value = error instanceof Error ? error.message : '形态保存失败'
  } finally {
    saving.value = false
  }
}
async function deleteCharacter(character: CharacterAsset) {
  if (!globalThis.confirm(`确定删除角色“${character.name}”吗？`)) return
  try {
    await workspace.deleteCharacter(props.projectId, character.id)
  } catch (error) {
    formError.value = error instanceof Error ? error.message : '角色删除失败'
  }
}
async function deleteAppearanceForm(character: CharacterAsset, form: CharacterForm) {
  if (!globalThis.confirm(`确定删除形态“${form.displayName}”吗？`)) return
  try {
    await workspace.deleteCharacterForm(props.projectId, character.id, form.id)
  } catch (error) {
    formError.value = error instanceof Error ? error.message : '形态删除失败'
  }
}
function promptPreview(value?: string) {
  return value?.trim() || '未填写外观提示词'
}
function initial(name: string) {
  return name.trim().slice(0, 1) || '角'
}
function primaryReference(characterId: string, formId?: string) {
  const references = workspace.referencesForCharacter(characterId, formId)
  return references.find((reference) => reference.primaryReference) ?? references[0]
}
function previewUrl(characterId: string, formId?: string) {
  const reference = primaryReference(characterId, formId)
  if (!reference) return ''
  const local = desktop.project?.assets.find((asset) => asset.id === reference.assetId)
  if (local?.fileAvailable) return desktop.assetPreviewUrl(local.id)
  return browserPreviewUrls.get(reference.assetId) ?? ''
}
function primaryVoiceReference(characterId: string) {
  const references = workspace.voiceReferencesForCharacter(characterId)
  return references.find((reference) => reference.primaryReference) ?? references[0]
}
function voiceSampleUrl(characterId: string) {
  const reference = primaryVoiceReference(characterId)
  const local = desktop.project?.assets.find((asset) => asset.id === reference?.assetId)
  if (local?.fileAvailable) return desktop.assetPreviewUrl(local.id)
  return reference ? (browserVoicePreviewUrls.get(reference.assetId) ?? '') : ''
}
function voiceSampleName(character: CharacterAsset) {
  const reference = primaryVoiceReference(character.id)
  if (!reference) return ''
  return (
    workspace.mediaAssetById(reference.assetId)?.originalFilename ??
    desktop.project?.assets.find((asset) => asset.id === reference.assetId)?.originalName ??
    character.name + '-角色声音'
  )
}
async function openVoiceSampleUpload(character: CharacterAsset) {
  if (voiceActingCharacterId.value) return
  if (!desktop.available) {
    browserVoiceUploadTarget.value = character
    browserVoiceUploadInput.value?.click()
    return
  }
  voiceActingCharacterId.value = character.id
  formError.value = ''
  try {
    const imported = await desktop.importAssets('audio')
    if (!imported.length) {
      if (desktop.error) throw new Error(desktop.error)
      return
    }
    const selected = imported[0]!
    const mappings = await workspace.synchronizeLocalAssets(props.projectId, [selected])
    const canonicalId =
      mappings.find((item) => item.clientAssetId === selected.id)?.assetId ?? selected.id
    await desktop.reconcileAssetIds(mappings.filter((item) => item.clientAssetId !== item.assetId))
    await replaceVoiceSample(character, canonicalId)
  } catch (error) {
    formError.value = error instanceof Error ? error.message : '角色声音上传失败'
  } finally {
    voiceActingCharacterId.value = ''
  }
}
async function uploadBrowserVoiceSample(event: globalThis.Event) {
  const input = event.target as globalThis.HTMLInputElement
  const source = input.files?.[0]
  const character = browserVoiceUploadTarget.value
  input.value = ''
  browserVoiceUploadTarget.value = null
  if (!source || !character || voiceActingCharacterId.value) return
  voiceActingCharacterId.value = character.id
  formError.value = ''
  try {
    const file = normalizeVoiceSampleFile(source)
    const clientAssetId = globalThis.crypto.randomUUID()
    const localAsset: LocalAsset = {
      id: clientAssetId,
      category: 'audio',
      originalName: file.name,
      relativePath: 'browser/audio/' + clientAssetId,
      sizeBytes: file.size,
      sha256: await sha256Hex(file),
      mimeType: file.type,
      importedAt: new Date().toISOString(),
      fileAvailable: true,
    }
    const mappings = await workspace.synchronizeLocalAssets(props.projectId, [localAsset])
    const canonicalId =
      mappings.find((item) => item.clientAssetId === clientAssetId)?.assetId ?? clientAssetId
    await saveBrowserMedia(props.projectId, canonicalId, file)
    setBrowserVoicePreview(canonicalId, file)
    await replaceVoiceSample(character, canonicalId)
  } catch (error) {
    formError.value = error instanceof Error ? error.message : '角色声音上传失败'
  } finally {
    voiceActingCharacterId.value = ''
  }
}
function normalizeVoiceSampleFile(file: globalThis.File) {
  if (file.size <= 0 || file.size > MAX_VOICE_SAMPLE_BYTES) {
    throw new Error('角色声音文件必须小于 30MB')
  }
  const extension = file.name.match(/\.[^.]+$/)?.[0]?.toLowerCase() ?? ''
  const declared = file.type.split(';', 1)[0].trim().toLowerCase()
  const mimeType = SUPPORTED_AUDIO_MIME_TYPES.has(declared)
    ? declared
    : AUDIO_MIME_BY_EXTENSION.get(extension)
  if (!mimeType) throw new Error('仅支持 MP3、WAV、M4A、AAC、OGG 或 FLAC 音频')
  return file.type === mimeType
    ? file
    : new globalThis.File([file], file.name, { type: mimeType, lastModified: file.lastModified })
}
async function replaceVoiceSample(character: CharacterAsset, assetId: string) {
  const previous = [...workspace.voiceReferencesForCharacter(character.id)]
  const reference = await workspace.createCharacterVoiceReference(props.projectId, {
    characterId: character.id,
    assetId,
    primaryReference: true,
  })
  for (const item of previous) {
    if (item.id !== reference.id) {
      await workspace.deleteCharacterVoiceReference(props.projectId, item.id)
    }
  }
}
async function downloadVoiceSample(character: CharacterAsset) {
  const reference = primaryVoiceReference(character.id)
  if (!reference || voiceActingCharacterId.value) return
  voiceActingCharacterId.value = character.id
  formError.value = ''
  try {
    const blob = await loadVoiceSampleBlob(reference.assetId)
    const objectUrl = globalThis.URL.createObjectURL(blob)
    const anchor = globalThis.document.createElement('a')
    anchor.href = objectUrl
    anchor.download = voiceSampleName(character)
    globalThis.document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    globalThis.setTimeout(() => globalThis.URL.revokeObjectURL(objectUrl), 1_000)
  } catch (error) {
    formError.value = error instanceof Error ? error.message : '角色声音下载失败'
  } finally {
    voiceActingCharacterId.value = ''
  }
}
async function loadVoiceSampleBlob(assetId: string) {
  const local = desktop.project?.assets.find((asset) => asset.id === assetId)
  if (desktop.available && local?.fileAvailable) {
    try {
      const response = await globalThis.fetch(desktop.assetPreviewUrl(assetId))
      if (response.ok) return await response.blob()
    } catch {
      // Continue with server or browser-local fallback.
    }
  }
  const media = workspace.mediaAssetById(assetId)
  if (media?.contentAvailable || media?.storageScope === 'SERVER') {
    try {
      return await mediaAssetApi.content(props.projectId, assetId)
    } catch {
      // Continue with browser-local fallback.
    }
  }
  const browser = await loadBrowserMedia(props.projectId, assetId)
  if (browser) return browser
  throw new Error('声音文件不在当前本机，服务端也没有可下载文件')
}
function setBrowserVoicePreview(assetId: string, blob: globalThis.Blob) {
  const previous = browserVoicePreviewUrls.get(assetId)
  if (previous) globalThis.URL.revokeObjectURL(previous)
  browserVoicePreviewUrls.set(assetId, globalThis.URL.createObjectURL(blob))
}
async function deleteVoiceSample(character: CharacterAsset) {
  const references = workspace.voiceReferencesForCharacter(character.id)
  if (
    !references.length ||
    voiceActingCharacterId.value ||
    !globalThis.confirm(`确定解除“${character.name}”的这个声音样本吗？`)
  )
    return
  voiceActingCharacterId.value = character.id
  try {
    for (const reference of references) {
      await workspace.deleteCharacterVoiceReference(props.projectId, reference.id)
    }
  } catch (error) {
    formError.value = error instanceof Error ? error.message : '声音样本删除失败'
  } finally {
    voiceActingCharacterId.value = ''
  }
}
function openAssetPicker(character: CharacterAsset, form?: CharacterForm) {
  if (!desktop.available) {
    browserUploadTarget.value = { character, form }
    browserUploadInput.value?.click()
    return
  }
  assetPicker.value = {
    characterId: character.id,
    characterName: character.name,
    formId: form?.id,
    formName: form?.displayName,
  }
}

async function uploadBrowserCharacterImage(event: globalThis.Event) {
  const input = event.target as globalThis.HTMLInputElement
  const file = input.files?.[0]
  const target = browserUploadTarget.value
  input.value = ''
  if (!file || !target) return
  formError.value = ''
  try {
    const imageFile = await validateBrowserImage(file)
    // 网页端：素材二进制只落服务端；桌面 Windows 端才存用户本地工作区。
    const uploaded = await mediaAssetApi.upload(props.projectId, {
      localCategory: 'characters',
      file: imageFile,
    })
    setBrowserPreview(uploaded.id, imageFile)
    await workspace.createCharacterReference(props.projectId, {
      characterId: target.character.id,
      characterFormId: target.form?.id,
      assetId: uploaded.id,
      viewType: 'FRONT',
      primaryReference: true,
    })
    await workspace.loadAssetResources(props.projectId)
  } catch (error) {
    formError.value =
      error instanceof Error
        ? error.message
        : target.form
          ? `${target.form.displayName}图片上传失败`
          : '角色图上传失败'
  } finally {
    browserUploadTarget.value = null
  }
}

function setBrowserPreview(assetId: string, blob: globalThis.Blob) {
  const previous = browserPreviewUrls.get(assetId)
  if (previous) globalThis.URL.revokeObjectURL(previous)
  browserPreviewUrls.set(assetId, globalThis.URL.createObjectURL(blob))
}

async function loadBrowserPreviews() {
  try {
    const assetIds = new Set(workspace.characterReferences.map((reference) => reference.assetId))
    for (const assetId of assetIds) {
      if (browserPreviewUrls.has(assetId)) continue
      // Desktop local file wins when available.
      if (desktop.available) {
        const local = desktop.project?.assets.find((asset) => asset.id === assetId)
        if (local?.fileAvailable) continue
      }
      // 优先服务端文件；浏览器缓存仅作临时预览加速，不作为素材存档。
      const media = workspace.mediaAssetById(assetId)
      let blob: globalThis.Blob | null = null
      if (media?.contentAvailable || media?.storageScope === 'SERVER') {
        try {
          blob = await mediaAssetApi.content(props.projectId, assetId)
        } catch {
          blob = null
        }
      }
      if (!blob) {
        blob = await loadBrowserImage(props.projectId, assetId)
      }
      if (blob) setBrowserPreview(assetId, blob)
    }
  } catch (error) {
    formError.value = error instanceof Error ? error.message : '角色图读取失败'
  }
}

async function loadBrowserVoicePreviews() {
  const loadVersion = ++voicePreviewLoadVersion
  browserVoicePreviewUrls.forEach((url) => globalThis.URL.revokeObjectURL(url))
  browserVoicePreviewUrls.clear()
  try {
    const assetIds = new Set(
      workspace.characterVoiceReferences.map((reference) => reference.assetId),
    )
    for (const assetId of assetIds) {
      const local = desktop.project?.assets.find((asset) => asset.id === assetId)
      if (desktop.available && local?.fileAvailable) continue
      let blob: globalThis.Blob | null = null
      const media = workspace.mediaAssetById(assetId)
      if (media?.contentAvailable || media?.storageScope === 'SERVER') {
        try {
          blob = await mediaAssetApi.content(props.projectId, assetId)
        } catch {
          blob = null
        }
      }
      if (!blob) blob = await loadBrowserMedia(props.projectId, assetId)
      if (loadVersion !== voicePreviewLoadVersion) return
      if (blob) setBrowserVoicePreview(assetId, blob)
    }
  } catch (error) {
    formError.value = error instanceof Error ? error.message : '角色声音读取失败'
  }
}

watch(
  () =>
    `${workspace.characterReferences.map((reference) => reference.assetId).join(',')}|${workspace.mediaAssets
      .map((asset) => `${asset.id}:${asset.storageScope}:${asset.contentAvailable ? 1 : 0}`)
      .join(',')}|${desktop.available}:${desktop.project?.assets?.length ?? 0}`,
  () => void loadBrowserPreviews(),
  { immediate: true },
)

watch(
  () =>
    `${desktop.available}:${workspace.characterVoiceReferences
      .map((reference) => `${reference.id}:${reference.assetId}:${reference.primaryReference}`)
      .join(',')}`,
  () => void loadBrowserVoicePreviews(),
  { immediate: true },
)

onBeforeUnmount(() => {
  browserPreviewUrls.forEach((url) => globalThis.URL.revokeObjectURL(url))
  browserPreviewUrls.clear()
  voicePreviewLoadVersion += 1
  browserVoicePreviewUrls.forEach((url) => globalThis.URL.revokeObjectURL(url))
  browserVoicePreviewUrls.clear()
})

const formPresets = [
  {
    id: 'soft-cute',
    label: '软萌矮小可爱',
    formCategory: 'APPEARANCE' as const,
    displayName: '软萌可爱形态',
    appearancePrompt:
      '软萌可爱形态，身材矮小娇小，圆润脸型，大眼睛，柔和表情，Q版偏写实，服饰轻盈明快，整体干净，保持与原角色五官身份一致',
    negativePrompt: '成人化过度，畸形肢体，脸崩，低清晰度，水印，多人，多余手指',
  },
  {
    id: 'school-uniform',
    label: '校服造型',
    formCategory: 'COSTUME' as const,
    displayName: '校服造型',
    appearancePrompt:
      '同一角色换装为清爽校服造型，保持原有五官与身份特征不变，服装整洁得体，校园感，干净光线，半身或全身立绘',
    negativePrompt: '畸形肢体，脸崩，低清晰度，水印，多人，多余手指',
  },
  {
    id: 'formal-suit',
    label: '正装西装',
    formCategory: 'COSTUME' as const,
    displayName: '正装西装',
    appearancePrompt:
      '同一角色换装为正装西装造型，保持原有五官与身份特征不变，服装挺括利落，商务感，干净背景，半身或全身立绘',
    negativePrompt: '破损服装，畸形肢体，脸崩，低清晰度，水印，多人，多余手指',
  },
  {
    id: 'hanfu',
    label: '古风服饰',
    formCategory: 'COSTUME' as const,
    displayName: '古风服饰',
    appearancePrompt:
      '同一角色换装为古风服饰造型，保持原有五官与身份特征不变，服饰层次清晰、颜色克制，古典气质，半身或全身立绘',
    negativePrompt: '现代服装，畸形肢体，脸崩，低清晰度，水印，多人，多余手指',
  },
  {
    id: 'battle',
    label: '战斗装',
    formCategory: 'COSTUME' as const,
    displayName: '战斗装',
    appearancePrompt:
      '同一角色换装为战斗装造型，保持原有五官与身份特征不变，服装具备防护感与行动感，材质清晰，姿态稳定，半身或全身立绘',
    negativePrompt: '血腥过度，畸形肢体，脸崩，低清晰度，水印，多人，多余手指',
  },
  {
    id: 'long-sword',
    label: '长剑',
    formCategory: 'WEAPON' as const,
    displayName: '长剑',
    appearancePrompt:
      '同一角色持握一把造型清晰的长剑，保持原有五官与身份特征不变，武器结构清楚、金属质感真实，手部持握自然，半身或全身立绘',
    negativePrompt: '血腥过度，畸形肢体，脸崩，低清晰度，水印，多人，多余手指',
  },
  {
    id: 'spear',
    label: '长枪',
    formCategory: 'WEAPON' as const,
    displayName: '长枪',
    appearancePrompt:
      '同一角色持握一杆长枪，保持原有五官与身份特征不变，枪头与枪杆比例合理，材质清晰，姿态稳定，半身或全身立绘',
    negativePrompt: '血腥过度，畸形肢体，脸崩，低清晰度，水印，多人，多余手指',
  },
]

function applyFormPreset(presetId: string) {
  const preset = formPresets.find((item) => item.id === presetId)
  if (!preset) return
  appearanceForm.formCategory = preset.formCategory
  appearanceForm.displayName = appearanceForm.displayName.trim() || preset.displayName
  appearanceForm.appearancePrompt = preset.appearancePrompt
  appearanceForm.negativePrompt = preset.negativePrompt
}

function polishAppearancePrompt(mode: 'soft-cute' | 'outfit' | 'generic' = 'generic') {
  const base = [appearanceForm.appearancePrompt, appearanceForm.displayName]
    .filter(Boolean)
    .join('，')
    .trim()
  const seed = base || '同一角色的新形态'
  if (mode === 'soft-cute') {
    appearanceForm.formCategory = 'APPEARANCE'
    appearanceForm.displayName = appearanceForm.displayName.trim() || '软萌可爱形态'
    appearanceForm.appearancePrompt = `${seed}。保持与原角色同一身份与五官特征，转换为软萌矮小可爱形态，身材娇小，表情柔和，服装干净明快，画风统一，无 thrash 细节，适合角色立绘。`
    appearanceForm.negativePrompt =
      appearanceForm.negativePrompt || '成人化过度，畸形肢体，脸崩，低清晰度，水印，多人，多余手指'
    return
  }
  if (mode === 'outfit') {
    appearanceForm.formCategory = 'COSTUME'
    appearanceForm.displayName = appearanceForm.displayName.trim() || '换装形态'
    appearanceForm.appearancePrompt = `${seed}。保持与原角色同一身份、五官、发色与体型特征，仅更换服装与配饰，服装结构清楚，材质真实，适合角色立绘。`
    appearanceForm.negativePrompt =
      appearanceForm.negativePrompt || '换脸，身份不一致，畸形肢体，脸崩，低清晰度，水印，多人'
    return
  }
  appearanceForm.appearancePrompt = `${seed}。保持角色身份一致性，补充清晰可见的服装、体型、表情与配色细节，避免 thrash 描写，适合角色立绘。`
  if (!appearanceForm.negativePrompt.trim()) {
    appearanceForm.negativePrompt = '畸形肢体，脸崩，低清晰度，水印，多人，多余手指'
  }
}

async function saveAndGenerateAppearance() {
  if (!appearanceForm.displayName.trim() || saving.value) return
  saving.value = true
  formError.value = ''
  try {
    const character = workspace.characters.find((item) => item.id === formCharacterId.value)
    if (!character) throw new Error('角色不存在')
    await workspace.saveCharacterForm(
      props.projectId,
      formCharacterId.value,
      appearanceForm,
      editingFormId.value,
    )
    // reload to get latest form id/name
    await workspace.load(props.projectId)
    const latest = workspace.characters.find((item) => item.id === formCharacterId.value)
    const form =
      latest?.forms.find((item) => item.displayName === appearanceForm.displayName.trim()) ||
      latest?.forms[0]
    showFormEditor.value = false
    if (latest) openImageGeneration(latest, form)
  } catch (error) {
    formError.value = error instanceof Error ? error.message : '形态保存失败'
  } finally {
    saving.value = false
  }
}

function openImageGeneration(character: CharacterAsset, form?: CharacterForm) {
  imageTarget.value = { character, form }
}
function imagePrompt(character: CharacterAsset, form?: CharacterForm) {
  return [character.identityPrompt, form?.appearancePrompt].filter(Boolean).join('\n')
}
function imageNegativePrompt(character: CharacterAsset, form?: CharacterForm) {
  return [character.negativePrompt, form?.negativePrompt].filter(Boolean).join(', ')
}
</script>

<template>
  <section class="asset-panel character-panel">
    <header class="panel-toolbar">
      <div>
        <h2>角色资产</h2>
        <p>固定角色形象，并按形态 / 服装 / 武器统一管理，生成视频时自动携带。</p>
      </div>
      <div class="toolbar-actions">
        <label class="search-control character-search"
        ><Search :size="16" /><input v-model="query" placeholder="搜索角色名称或描述"
        /></label>
        <select v-model="roleFilter">
          <option value="ALL">全部类型</option>
          <option>主要角色</option>
          <option>配角</option>
          <option>群像角色</option>
        </select>
        <button class="button" disabled title="配置文本模型后开放">从剧本提取角色</button>
        <button class="button primary" @click="openCreateCharacter">
          <Plus :size="17" />新建角色
        </button>
      </div>
    </header>
    <div class="asset-view-toolbar">
      <div>
        <span class="active asset-view-label"
        >全部角色 <span>{{ filteredCharacters.length }}</span></span
        >
      </div>
      <div class="view-switch">
        <button :class="{ active: view === 'grid' }" title="网格" @click="view = 'grid'">
          <Grid2X2 :size="16" /></button
        ><button :class="{ active: view === 'list' }" title="列表" @click="view = 'list'">
          <List :size="16" />
        </button>
      </div>
    </div>
    <p v-if="formError && !showCharacterEditor && !showFormEditor" class="inline-error">
      {{ formError }}
    </p>

    <div v-if="filteredCharacters.length === 0" class="workspace-empty bordered">
      <UserRound :size="32" /><strong>{{
        workspace.characters.length ? '没有符合条件的角色' : '还没有角色'
      }}</strong>
      <p>先录入稳定身份特征，再按需添加形态、服装与武器。</p>
      <button class="button primary" @click="openCreateCharacter">
        <Plus :size="17" />新建角色
      </button>
    </div>
    <div v-else class="character-grid" :class="{ list: view === 'list' }">
      <article v-for="character in filteredCharacters" :key="character.id" class="character-card">
        <div class="character-summary">
          <div class="character-visual">
            <img
              v-if="previewUrl(character.id)"
              :src="previewUrl(character.id)"
              :alt="character.name"
            />
            <span v-else>{{ initial(character.name) }}</span>
            <button
              class="visual-image-action"
              title="上传或管理角色图"
              type="button"
              @click="openAssetPicker(character)"
            >
              <ImagePlus :size="15" />上传角色图
            </button>
          </div>
          <div class="character-card-body">
            <header>
              <div>
                <h3>
                  {{ character.name }} <small>{{ character.roleType || '未分类角色' }}</small>
                </h3>
                <p><i />基础信息已保存</p>
              </div>
              <div class="row-actions">
                <button
                  class="icon-button compact"
                  title="生成角色图片"
                  @click="openImageGeneration(character)"
                >
                  <WandSparkles :size="15" />
                </button>
                <button
                  class="icon-button compact"
                  title="编辑角色"
                  @click="openEditCharacter(character)"
                >
                  <Pencil :size="15" /></button
                ><button
                  class="icon-button compact danger"
                  title="删除角色"
                  @click="deleteCharacter(character)"
                >
                  <Trash2 :size="15" />
                </button>
              </div>
            </header>
            <dl>
              <dt>角色类型</dt>
              <dd>{{ character.roleType || '未分类' }}</dd>
              <dt>描述</dt>
              <dd>{{ character.description || '暂无角色说明' }}</dd>
              <dt>身份一致性提示词摘要</dt>
              <dd>{{ promptPreview(character.identityPrompt) }}</dd>
            </dl>
            <div
              class="character-voice-sample"
              :class="{ ready: workspace.voiceReferencesForCharacter(character.id).length }"
            >
              <span>
                <Volume2 :size="15" />
                <span>
                  <strong>角色声音</strong>
                  <small>视频原声模型可参考声音样本；后期配音使用角色默认音色</small>
                </span>
              </span>
              <div class="character-voice-details">
                <small>配音音色：{{ voicePresetLabel(character.ttsVoiceId) }}</small>
                <audio
                  v-if="voiceSampleUrl(character.id)"
                  :src="voiceSampleUrl(character.id)"
                  controls
                  preload="metadata"
                />
                <small v-else-if="workspace.voiceReferencesForCharacter(character.id).length"
                >样本文件不在当前本机工作目录</small
                >
                <small v-else>建议上传 3-20 秒、单人、无背景音乐的清晰声音</small>
              </div>
              <div class="character-voice-actions">
                <button
                  class="icon-button compact"
                  type="button"
                  :title="
                    workspace.voiceReferencesForCharacter(character.id).length
                      ? '替换角色声音'
                      : '上传角色声音'
                  "
                  :disabled="Boolean(voiceActingCharacterId)"
                  @click="openVoiceSampleUpload(character)"
                >
                  <LoaderCircle
                    v-if="voiceActingCharacterId === character.id"
                    class="spin"
                    :size="14"
                  />
                  <Upload v-else :size="14" />
                </button>
                <button
                  v-if="workspace.voiceReferencesForCharacter(character.id).length"
                  class="icon-button compact"
                  type="button"
                  title="下载角色声音"
                  :disabled="Boolean(voiceActingCharacterId)"
                  @click="downloadVoiceSample(character)"
                >
                  <Download :size="14" />
                </button>
                <button
                  v-if="workspace.voiceReferencesForCharacter(character.id).length"
                  class="icon-button compact danger"
                  type="button"
                  title="清除角色声音绑定"
                  :disabled="Boolean(voiceActingCharacterId)"
                  @click="deleteVoiceSample(character)"
                >
                  <Trash2 :size="14" />
                </button>
              </div>
            </div>
          </div>
        </div>
        <div class="character-forms">
          <header>
            <div class="character-forms-title">
              <strong>形态 / 服装 / 武器</strong>
              <span class="form-count-chip">{{ character.forms.length }}</span>
            </div>
          </header>

          <div class="character-form-toolbar" role="group" aria-label="添加形态服装武器">
            <button
              v-for="category in formCategoryOptions"
              :key="category.value"
              class="form-add-chip"
              type="button"
              :title="`添加${category.label}`"
              @click="openCreateFormWithCategory(character, category.value)"
            >
              <Plus :size="13" />{{ category.label }}
            </button>
          </div>

          <p v-if="character.forms.length === 0" class="form-empty-hint">
            点击上方按钮添加；生成视频时会自动携带已添加项
          </p>

          <div v-else class="character-form-chip-list">
            <article
              v-for="form in sortedForms(character)"
              :key="form.id"
              class="character-form-chip"
            >
              <button
                class="form-thumb"
                type="button"
                :title="previewUrl(character.id, form.id) ? '更换图片' : '上传图片'"
                @click="openAssetPicker(character, form)"
              >
                <img
                  v-if="previewUrl(character.id, form.id)"
                  :src="previewUrl(character.id, form.id)"
                  :alt="form.displayName"
                />
                <template v-else>
                  <ImagePlus :size="14" />
                  <span class="visually-hidden">上传{{ form.displayName }}图片</span>
                </template>
              </button>

              <button
                class="form-chip-main"
                type="button"
                :title="`编辑${form.displayName}`"
                @click="openEditForm(character, form)"
              >
                <strong>{{ form.displayName }}</strong>
                <small>
                  <em class="form-category-tag">{{ formCategoryLabel(form.formCategory) }}</em>
                  <em v-if="form.defaultForm">默认</em>
                  <span>{{ promptPreview(form.appearancePrompt) || '未填写外观提示词' }}</span>
                </small>
              </button>

              <div class="row-actions">
                <button
                  class="icon-button compact"
                  title="生成图片"
                  type="button"
                  @click="openImageGeneration(character, form)"
                >
                  <WandSparkles :size="14" />
                </button>
                <button
                  class="icon-button compact"
                  :title="previewUrl(character.id, form.id) ? '管理参考图' : '上传图片'"
                  type="button"
                  @click="openAssetPicker(character, form)"
                >
                  <ImagePlus :size="14" />
                </button>
                <button
                  class="icon-button compact"
                  title="编辑"
                  type="button"
                  @click="openEditForm(character, form)"
                >
                  <Pencil :size="14" />
                </button>
                <button
                  class="icon-button compact danger"
                  title="删除"
                  type="button"
                  @click="deleteAppearanceForm(character, form)"
                >
                  <Trash2 :size="14" />
                </button>
              </div>
            </article>
          </div>
        </div>
      </article>
    </div>
  </section>

  <input
    ref="browserUploadInput"
    class="visually-hidden"
    type="file"
    accept="image/png,image/jpeg,image/webp"
    @change="uploadBrowserCharacterImage"
  />
  <input
    ref="browserVoiceUploadInput"
    class="visually-hidden"
    type="file"
    accept="audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/aac,audio/ogg,audio/flac,.mp3,.wav,.m4a,.aac,.ogg,.flac"
    @change="uploadBrowserVoiceSample"
  />

  <div v-if="showCharacterEditor" class="modal-backdrop" @click.self="showCharacterEditor = false">
    <section class="modal modal-wide" role="dialog" aria-modal="true">
      <header>
        <h2>{{ editingCharacterId ? '编辑角色' : '新建角色' }}</h2>
        <button class="icon-button" title="关闭" @click="showCharacterEditor = false">
          <X :size="18" />
        </button>
      </header>
      <form @submit.prevent="saveCharacter">
        <div class="form-grid two-columns">
          <label
          >角色名称<input
            v-model="characterForm.name"
            maxlength="120"
            required
            autofocus /></label
          ><label
          >角色类型<select v-model="characterForm.roleType">
            <option>主要角色</option>
            <option>配角</option>
            <option>群像角色</option>
          </select></label
          >
        </div>
        <label
        >角色说明<textarea v-model="characterForm.description" rows="3" maxlength="5000" /></label
        ><label
        >身份一致性提示词<textarea
          v-model="characterForm.identityPrompt"
          rows="5"
          maxlength="10000"
          placeholder="脸部、发型、服装标识、配色等稳定特征"
        /></label
        ><label
        >通用负面词<textarea v-model="characterForm.negativePrompt" rows="3" maxlength="5000" />
        </label>
        <fieldset class="character-voice-profile-editor">
          <legend>声音设定</legend>
          <label
          >声音描述<textarea
            v-model="characterForm.voiceDescription"
            rows="3"
            maxlength="1000"
            placeholder="情绪：压抑愤怒；音量：偏低；语速：0.82；停顿：冲突词后0.35秒；句尾：下沉收住；音质：低沉克制、呼吸加重"
          />
          <span class="field-help">发声效果 = 情绪 + 音量 + 语速 + 停顿节点 + 句尾变化；视频原声和后期配音都会使用。</span>
          </label>
          <label
          >默认角色音色<select v-model="characterForm.ttsVoiceId">
            <option value="">跟随所选配音模型的默认音色</option>
            <option v-for="preset in VOICE_PRESETS" :key="preset.value" :value="preset.value">
              {{ preset.label }} · {{ preset.description }}
            </option>
            <option v-if="hasCustomCharacterVoice" :value="characterForm.ttsVoiceId">
              已保存专属音色
            </option>
          </select><span class="field-help"
          >生成配音时会自动转换成所选模型支持的音色，直接按听感选择即可。</span
          ></label
          >
          <details class="voice-id-advanced">
            <summary>高级：使用厂商专属音色</summary>
            <label
            >专属音色标识<input
              v-model="characterForm.ttsVoiceId"
              maxlength="160"
              placeholder="仅在使用克隆音色或厂商自定义音色时填写"
            /><span class="field-help">切换配音厂商后，该专属音色可能不可用。</span></label
            >
          </details>
        </fieldset>
        <p v-if="formError" class="form-error">{{ formError }}</p>
        <footer>
          <button class="button" type="button" @click="showCharacterEditor = false">取消</button
          ><button
            class="button primary"
            type="submit"
            :disabled="saving || !characterForm.name.trim()"
          >
            {{ saving ? '保存中' : '保存角色' }}
          </button>
        </footer>
      </form>
    </section>
  </div>
  <div v-if="showFormEditor" class="modal-backdrop" @click.self="showFormEditor = false">
    <section class="modal" role="dialog" aria-modal="true">
      <header>
        <h2>
          {{ editingFormId ? '编辑' : '添加' }}{{ formCategoryLabel(appearanceForm.formCategory) }}
        </h2>
        <button class="icon-button" title="关闭" @click="showFormEditor = false">
          <X :size="18" />
        </button>
      </header>
      <form @submit.prevent="saveAppearanceForm">
        <label
        >分类
          <select v-model="appearanceForm.formCategory" required>
            <option v-for="item in formCategoryOptions" :key="item.value" :value="item.value">
              {{ item.label }}
            </option>
          </select>
        </label>
        <div class="form-preset-row">
          <span>快捷预设</span>
          <button
            v-for="preset in formPresets"
            :key="preset.id"
            class="button compact"
            type="button"
            @click="applyFormPreset(preset.id)"
          >
            {{ preset.label }}
          </button>
        </div>
        <label
        >名称<input
          v-model="appearanceForm.displayName"
          maxlength="80"
          required
          autofocus
          placeholder="例如：软萌可爱 / 校服 / 长剑"
        /></label>
        <label
        >外观提示词
          <textarea
            v-model="appearanceForm.appearancePrompt"
            rows="6"
            maxlength="10000"
            placeholder="描述体型、服装、气质等；可先点快捷形态或 AI 润色"
          />
          <div class="form-inline-actions">
            <button
              class="button compact"
              type="button"
              @click="polishAppearancePrompt('soft-cute')"
            >
              AI润色成软萌
            </button>
            <button class="button compact" type="button" @click="polishAppearancePrompt('outfit')">
              AI润色成换装
            </button>
            <button class="button compact" type="button" @click="polishAppearancePrompt('generic')">
              AI润色提示词
            </button>
          </div> </label
        ><label class="checkbox-field"
        ><input v-model="appearanceForm.defaultForm" type="checkbox" />设为该分类默认项</label
        >
        <p class="form-help">
          可先保存，再点卡片中的生成图片；生成视频默认使用基础角色图，需要形态、服装或武器时请在视频弹窗手动补充。
        </p>
        <p v-if="formError" class="form-error">{{ formError }}</p>
        <footer>
          <button class="button" type="button" @click="showFormEditor = false">取消</button>
          <button
            class="button"
            type="submit"
            :disabled="saving || !appearanceForm.displayName.trim()"
          >
            {{ saving ? '保存中' : '仅保存' }}
          </button>
          <button
            class="button primary"
            type="button"
            :disabled="saving || !appearanceForm.displayName.trim()"
            @click="saveAndGenerateAppearance"
          >
            {{ saving ? '处理中' : '保存并生图' }}
          </button>
        </footer>
      </form>
    </section>
  </div>
  <AssetPickerDialog
    v-if="assetPicker"
    :project-id="projectId"
    mode="character"
    :title="
      assetPicker.formName
        ? `${assetPicker.characterName} / ${assetPicker.formName}参考图`
        : `${assetPicker.characterName}基础参考图`
    "
    :character-id="assetPicker.characterId"
    :character-form-id="assetPicker.formId"
    @close="assetPicker = null"
  />
  <ImageGenerationDialog
    v-if="imageTarget"
    open
    :project-id="projectId"
    :target-type="imageTarget.form ? 'CHARACTER_FORM' : 'CHARACTER'"
    :target-id="imageTarget.form?.id || imageTarget.character.id"
    :title="
      imageTarget.form
        ? `${imageTarget.character.name} / ${imageTarget.form.displayName}`
        : `${imageTarget.character.name}基础形象`
    "
    :initial-prompt="imagePrompt(imageTarget.character, imageTarget.form)"
    :initial-negative-prompt="imageNegativePrompt(imageTarget.character, imageTarget.form)"
    category="characters"
    :character-id="imageTarget.character.id"
    :character-form-id="imageTarget.form?.id"
    :character-role-type="imageTarget.character.roleType"
    @close="imageTarget = null"
  />
</template>
