<script setup lang="ts">
import { computed, ref } from 'vue'
import { FileImage, Import, Link2, Search, Trash2, X } from 'lucide-vue-next'
import type { CharacterViewType, SceneReferenceType } from '../../api/assets'
import type { LocalAsset } from '../../desktop/types'
import { imageAssetsForCategory } from '../../domain/local-asset-filter'
import { useDesktopStore } from '../../stores/desktop'
import { useWorkspaceStore } from '../../stores/workspace'

const props = defineProps<{
  projectId: string
  mode: 'character' | 'scene'
  title: string
  characterId?: string
  characterFormId?: string
  episodeId?: string
  sceneId?: string
}>()
const emit = defineEmits<{ close: [] }>()
const desktop = useDesktopStore()
const workspace = useWorkspaceStore()
const query = ref('')
const characterView = ref<CharacterViewType>('TURNAROUND_PORTRAIT')
const sceneType = ref<SceneReferenceType>('OVERVIEW')
const primaryReference = ref(true)
const savingAssetId = ref('')
const errorMessage = ref('')
const noticeMessage = ref('')

const purposeOptions = computed(() =>
  props.mode === 'character'
    ? [
        ['FRONT', '正面'],
        ['TURNAROUND_PORTRAIT', '三视图 + 上半身'],
        ['CHARACTER_SHEET', '完整角色设定版'],
        ['OTHER', '其他'],
      ]
    : [
        ['OVERVIEW', '全景'],
        ['DETAIL', '细节'],
        ['LIGHTING', '灯光'],
        ['STYLE', '风格'],
        ['OTHER', '其他'],
      ],
)

const historicalCharacterPurposeLabels: Partial<Record<CharacterViewType, string>> = {
  FRONT: '正面',
  THREE_QUARTER: '45 度',
  SIDE: '侧面',
  BACK: '背面',
  CLOSE_UP: '特写',
  TURNAROUND: '三视图设定图',
  TURNAROUND_PORTRAIT: '三视图 + 上半身',
  CHARACTER_SHEET: '完整角色设定版',
  OTHER: '其他',
}

const references = computed(() =>
  props.mode === 'character' && props.characterId
    ? workspace.referencesForCharacter(props.characterId, props.characterFormId)
    : props.sceneId
      ? workspace.referencesForScene(props.sceneId)
      : [],
)

const localImages = computed(() => {
  const category = props.mode === 'character' ? 'characters' : 'scenes'
  return imageAssetsForCategory(desktop.project?.assets ?? [], category, query.value).filter(
    (asset) => {
      const registered = workspace.mediaAssetById(asset.id)
      return !registered || registered.assetType === 'IMAGE'
    },
  )
})

const libraryOpenByDefault = computed(() => references.value.length === 0)
const currentReferenceTitle = computed(() =>
  props.mode === 'scene' ? '当前场景已绑定背景图' : '当前角色已绑定参考图',
)
const libraryTitle = computed(() =>
  props.mode === 'scene' ? '从本地素材库绑定/更换背景图' : '从本地素材库绑定/更换角色图',
)

function previewUrl(assetId: string) {
  const local = desktop.project?.assets.find((asset) => asset.id === assetId)
  return local?.fileAvailable ? desktop.assetPreviewUrl(assetId) : ''
}

function referenceLabel(reference: (typeof references.value)[number]) {
  const key = 'viewType' in reference ? reference.viewType : reference.referenceType
  if ('viewType' in reference) return historicalCharacterPurposeLabels[reference.viewType] ?? key
  return purposeOptions.value.find(([value]) => value === key)?.[1] ?? key
}

function assetName(assetId: string) {
  return (
    workspace.mediaAssetById(assetId)?.originalFilename ??
    desktop.project?.assets.find((asset) => asset.id === assetId)?.originalName ??
    '本地图片'
  )
}

async function importImages() {
  errorMessage.value = ''
  noticeMessage.value = ''
  try {
    if (!desktop.available) throw new Error('请在 Windows 桌面客户端中导入本地图片')
    if (!desktop.project || desktop.project.projectId !== props.projectId) {
      const project = workspace.project
      if (!project || project.id !== props.projectId) throw new Error('当前项目信息尚未加载完成')
      await desktop.ensureProject({ id: project.id, title: project.title })
    }
    if (!desktop.project || desktop.project.projectId !== props.projectId) {
      throw new Error(desktop.error || '本地项目目录尚未初始化，请稍后重试')
    }
    const imported = await desktop.importAssets(
      props.mode === 'character' ? 'characters' : 'scenes',
    )
    if (desktop.error) throw new Error(desktop.error)
    if (!imported.length) return
    const mappings = await workspace.synchronizeLocalAssets(props.projectId, imported)
    await desktop.reconcileAssetIds(mappings.filter((item) => item.clientAssetId !== item.assetId))
    if (props.mode === 'scene' && imported.length) {
      const mappingByClientId = new Map(mappings.map((item) => [item.clientAssetId, item.assetId]))
      const importedImageIds = imported
        .filter((asset) => asset.mimeType.startsWith('image/'))
        .map((asset) => mappingByClientId.get(asset.id) ?? asset.id)
      let attachedCount = 0
      for (const [index, assetId] of importedImageIds.entries()) {
        if (references.value.some((reference) => reference.assetId === assetId)) continue
        await attach(assetId, index === 0)
        attachedCount += 1
      }
      if (attachedCount) noticeMessage.value = `已导入并绑定 ${attachedCount} 张当前场景背景图`
    } else {
      noticeMessage.value = `已导入 ${imported.length} 张角色图片，请在下方选择并绑定`
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '素材登记失败'
  }
}

async function attach(assetId: string, primaryOverride = primaryReference.value) {
  if (savingAssetId.value) return
  savingAssetId.value = assetId
  errorMessage.value = ''
  noticeMessage.value = ''
  try {
    const registeredAssetId = await ensureRegisteredAssetId(assetId)
    if (references.value.some((reference) => reference.assetId === registeredAssetId)) {
      noticeMessage.value = '这张图片已绑定到当前目标'
      return
    }
    if (props.mode === 'character') {
      if (!props.characterId) throw new Error('角色信息不完整')
      await workspace.createCharacterReference(props.projectId, {
        characterId: props.characterId,
        characterFormId: props.characterFormId,
        assetId: registeredAssetId,
        viewType: characterView.value,
        primaryReference: primaryOverride,
      })
    } else {
      if (!props.episodeId || !props.sceneId) throw new Error('场景信息不完整')
      await workspace.createSceneReference(props.projectId, {
        episodeId: props.episodeId,
        sceneId: props.sceneId,
        assetId: registeredAssetId,
        referenceType: sceneType.value,
        primaryReference: primaryOverride,
      })
    }
    noticeMessage.value =
      props.mode === 'scene' ? '已绑定为当前场景背景图' : '已绑定为当前角色参考图'
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '关联参考图失败'
  } finally {
    savingAssetId.value = ''
  }
}

async function ensureRegisteredAssetId(assetId: string) {
  if (workspace.mediaAssetById(assetId)) return assetId
  const local = desktop.project?.assets.find((asset) => asset.id === assetId)
  if (!local) return assetId
  const mappings = await workspace.synchronizeLocalAssets(props.projectId, [local as LocalAsset])
  await desktop.reconcileAssetIds(mappings.filter((item) => item.clientAssetId !== item.assetId))
  return mappings.find((item) => item.clientAssetId === assetId)?.assetId ?? assetId
}

async function unlink(referenceId: string) {
  errorMessage.value = ''
  noticeMessage.value = ''
  try {
    if (props.mode === 'character') {
      await workspace.deleteCharacterReference(props.projectId, referenceId)
    } else {
      await workspace.deleteSceneReference(props.projectId, referenceId)
    }
    noticeMessage.value = '已解除当前绑定'
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '解除关联失败'
  }
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <section class="modal modal-wide asset-picker-modal" role="dialog" aria-modal="true">
      <header>
        <div>
          <h2>{{ title }}</h2>
          <p>
            上方只显示当前目标已绑定图片；下方素材库用于从本机图片中绑定或更换，不会自动替换其他场景。
          </p>
        </div>
        <button class="icon-button" title="关闭" type="button" @click="emit('close')">
          <X :size="18" />
        </button>
      </header>

      <section class="linked-reference-panel">
        <header>
          <div>
            <strong>{{ currentReferenceTitle }}</strong>
            <small>这里才是当前场景/角色真正会被自动带入的图片</small>
          </div>
          <span>{{ references.length }} 张</span>
        </header>
        <div v-if="references.length" class="linked-reference-strip">
          <article v-for="reference in references" :key="reference.id">
            <img
              v-if="previewUrl(reference.assetId)"
              :src="previewUrl(reference.assetId)"
              :alt="assetName(reference.assetId)"
            />
            <FileImage v-else :size="20" />
            <div>
              <strong>{{ referenceLabel(reference) }}</strong
              ><span
              >{{ assetName(reference.assetId)
              }}<em v-if="reference.primaryReference">主图</em></span
              >
            </div>
            <button
              class="icon-button compact danger"
              title="解除关联"
              type="button"
              @click="unlink(reference.id)"
            >
              <Trash2 :size="14" />
            </button>
          </article>
        </div>
        <div v-else class="linked-reference-empty">
          <FileImage :size="24" />
          <strong>当前还没有绑定图片</strong>
          <span>请展开下方素材库，导入并绑定一张背景图。</span>
        </div>
      </section>

      <details class="asset-picker-library" :open="libraryOpenByDefault">
        <summary>
          <span>
            <strong>{{ libraryTitle }}</strong>
            <small>只有点“绑定”的图片才会归类到当前目标</small>
          </span>
          <em>{{ localImages.length }} 张可用图片</em>
        </summary>
        <div class="asset-picker-toolbar">
          <label class="search-control"
          ><Search :size="16" /><input v-model="query" placeholder="搜索本地图片"
          /></label>
          <label
          >用途
            <select v-if="mode === 'character'" v-model="characterView">
              <option v-for="option in purposeOptions" :key="option[0]" :value="option[0]">
                {{ option[1] }}
              </option>
            </select>
            <select v-else v-model="sceneType">
              <option v-for="option in purposeOptions" :key="option[0]" :value="option[0]">
                {{ option[1] }}
              </option>
            </select>
          </label>
          <label class="checkbox-field"
          ><input v-model="primaryReference" type="checkbox" />设为主参考图</label
          >
          <button
            class="button"
            type="button"
            :disabled="desktop.importing"
            @click="importImages"
          >
            <Import :size="16" />{{
              desktop.importing ? '导入中' : mode === 'scene' ? '导入并绑定当前场景' : '导入图片'
            }}
          </button>
        </div>

        <div v-if="!desktop.available" class="workspace-empty bordered">
          <strong>当前是浏览器模式</strong>
          <p>请在 Windows 桌面客户端中关联本地图片。</p>
        </div>
        <div v-else-if="localImages.length === 0" class="workspace-empty bordered">
          <FileImage :size="30" /><strong>没有可用的本地图片</strong>
          <p>导入图片后即可设置角色或场景参考图。</p>
        </div>
        <div v-else class="asset-picker-grid">
          <article v-for="asset in localImages" :key="asset.id">
            <img :src="previewUrl(asset.id)" :alt="asset.originalName" />
            <div>
              <strong :title="asset.originalName">{{ asset.originalName }}</strong
              ><span>{{ (asset.sizeBytes / 1024 / 1024).toFixed(1) }} MB</span>
            </div>
            <button
              class="button primary"
              type="button"
              :disabled="Boolean(savingAssetId)"
              @click="attach(asset.id)"
            >
              <Link2 :size="15" />{{ savingAssetId === asset.id ? '绑定中' : '绑定到当前目标' }}
            </button>
          </article>
        </div>
      </details>

      <p v-if="errorMessage || desktop.error" class="form-error">
        {{ errorMessage || desktop.error }}
      </p>
      <p v-if="noticeMessage" class="form-success">{{ noticeMessage }}</p>
    </section>
  </div>
</template>
