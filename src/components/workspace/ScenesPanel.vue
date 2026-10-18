<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'
import { ImagePlus, Pencil, Plus, RefreshCw, Trash2, WandSparkles, X } from 'lucide-vue-next'
import AssetPickerDialog from '../assets/AssetPickerDialog.vue'
import ImageGenerationDialog from '../generation/ImageGenerationDialog.vue'
import { mediaAssetApi } from '../../api/assets'
import type { Scene, SceneInput } from '../../api/workspace'
import { projectFrameProfile } from '../../domain/project-frame-profile'
import { useDesktopStore } from '../../stores/desktop'
import { useWorkspaceStore } from '../../stores/workspace'
import { loadBrowserImage, validateBrowserImage } from '../../browser/browser-image-store'

const props = defineProps<{ projectId: string; active?: boolean }>()
const workspace = useWorkspaceStore()
const desktop = useDesktopStore()
const showEditor = ref(false)
const editingId = ref<string>()
const saving = ref(false)
const formError = ref('')
const statusFilter = ref('ALL')
const form = reactive<SceneInput>(emptyForm())
const formSnapshot = ref('')
const assetPickerScene = ref<Scene | null>(null)
const imageScene = ref<Scene | null>(null)
const browserUploadInput = ref<globalThis.HTMLInputElement>()
const browserUploadScene = ref<Scene | null>(null)
const browserPreviewUrls = reactive(new Map<string, string>())
const filteredScenes = computed(() =>
  statusFilter.value === 'ALL'
    ? workspace.scenes
    : workspace.scenes.filter((scene) => scene.status === statusFilter.value),
)
const dirty = computed(() => showEditor.value && JSON.stringify(form) !== formSnapshot.value)
const selectedEpisodeId = computed({
  get: () => workspace.activeEpisodeId,
  set: (episodeId: string) => {
    if (episodeId === workspace.activeEpisodeId || !canDiscardChanges()) return
    resetEditor()
    void workspace.selectEpisode(props.projectId, episodeId)
  },
})
const editingScene = computed(() => workspace.scenes.find((scene) => scene.id === editingId.value))

function emptyForm(): SceneInput {
  return { title: '', location: '', timeOfDay: '白天', description: '', environmentPrompt: '' }
}
function rememberForm() {
  formSnapshot.value = JSON.stringify(form)
}
function canDiscardChanges() {
  if (props.active === false) return true
  return !dirty.value || globalThis.confirm('当前场景有未保存修改，确定放弃吗？')
}
onBeforeRouteLeave(canDiscardChanges)
onBeforeRouteUpdate(canDiscardChanges)
function resetEditor() {
  showEditor.value = false
  editingId.value = undefined
  formError.value = ''
  Object.assign(form, emptyForm())
  rememberForm()
}
function closeEditor() {
  if (canDiscardChanges()) resetEditor()
}
function openCreate() {
  if (!canDiscardChanges()) return
  editingId.value = undefined
  Object.assign(form, emptyForm())
  rememberForm()
  formError.value = ''
  showEditor.value = true
}
function openEdit(scene: Scene) {
  if (editingId.value !== scene.id && !canDiscardChanges()) return
  editingId.value = scene.id
  Object.assign(form, {
    title: scene.title,
    location: scene.location ?? '',
    timeOfDay: scene.timeOfDay ?? '',
    description: scene.description ?? '',
    environmentPrompt: scene.environmentPrompt ?? '',
    version: scene.version,
  })
  rememberForm()
  formError.value = ''
  showEditor.value = true
}
async function saveScene() {
  if (saving.value) return
  saving.value = true
  formError.value = ''
  try {
    await workspace.saveScene(props.projectId, form, editingId.value)
    rememberForm()
    showEditor.value = false
  } catch (error) {
    formError.value = error instanceof Error ? error.message : '场景保存失败'
  } finally {
    saving.value = false
  }
}
async function deleteScene(scene: Scene) {
  if (!globalThis.confirm(`确定删除场景“${scene.title}”吗？`)) return
  try {
    await workspace.deleteScene(props.projectId, scene.id)
    if (editingId.value === scene.id) showEditor.value = false
  } catch (error) {
    formError.value = error instanceof Error ? error.message : '场景删除失败'
  }
}
function previewUrl(sceneId: string) {
  const references = workspace.referencesForScene(sceneId)
  const reference = references.find((item) => item.primaryReference) ?? references[0]
  if (!reference) return ''
  const local = desktop.project?.assets.find((asset) => asset.id === reference.assetId)
  if (local?.fileAvailable) return desktop.assetPreviewUrl(local.id)
  return browserPreviewUrls.get(reference.assetId) ?? ''
}
function openAssetPicker(scene: Scene) {
  if (desktop.available) {
    assetPickerScene.value = scene
    return
  }
  browserUploadScene.value = scene
  browserUploadInput.value?.click()
}
async function uploadBrowserSceneImage(event: globalThis.Event) {
  const input = event.target as globalThis.HTMLInputElement
  const file = input.files?.[0]
  const scene = browserUploadScene.value
  input.value = ''
  if (!file || !scene) return
  formError.value = ''
  try {
    const imageFile = await validateBrowserImage(file)
    // 网页端只上传服务端；Windows 客户端本地落盘在桌面工作区完成。
    const uploaded = await mediaAssetApi.upload(props.projectId, {
      localCategory: 'scenes',
      file: imageFile,
    })
    setBrowserPreview(uploaded.id, imageFile)
    await workspace.createSceneReference(props.projectId, {
      episodeId: scene.episodeId,
      sceneId: scene.id,
      assetId: uploaded.id,
      referenceType: 'OVERVIEW',
      primaryReference: true,
    })
    await workspace.loadAssetResources(props.projectId)
  } catch (error) {
    formError.value = error instanceof Error ? error.message : '背景图上传失败'
  } finally {
    browserUploadScene.value = null
  }
}
function setBrowserPreview(assetId: string, blob: globalThis.Blob) {
  const previous = browserPreviewUrls.get(assetId)
  if (previous) globalThis.URL.revokeObjectURL(previous)
  browserPreviewUrls.set(assetId, globalThis.URL.createObjectURL(blob))
}
async function loadBrowserPreviews() {
  try {
    const assetIds = new Set(workspace.sceneReferences.map((reference) => reference.assetId))
    for (const assetId of assetIds) {
      if (browserPreviewUrls.has(assetId)) continue
      if (desktop.available) {
        const local = desktop.project?.assets.find((asset) => asset.id === assetId)
        if (local?.fileAvailable) continue
      }
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
    formError.value = error instanceof Error ? error.message : '背景图读取失败'
  }
}
function scenePrompt(scene: Scene) {
  return [
    '纯环境背景设定图，只表现空间、建筑、陈设、材质、光线、天气和氛围。画面中不得出现人物、人体、脸、手、倒影中的人、人物照片、雕像或人形剪影。保留足够清晰的空间层次，供后续叠加指定角色和生成短剧关键帧。',
    scene.environmentPrompt,
    scene.location,
    scene.timeOfDay,
    scene.description,
  ]
    .filter(Boolean)
    .join('\n')
}

function sceneNegativePrompt() {
  return '人物，人类，角色，脸，人脸，头部，身体，手，脚，人群，人影，人形剪影，倒影中的人，人物照片，海报人物，雕像，人体模型，文字，水印，标志'
}
watch(
  () =>
    `${workspace.sceneReferences.map((reference) => reference.assetId).join(',')}|${workspace.mediaAssets
      .map((asset) => `${asset.id}:${asset.storageScope}:${asset.contentAvailable ? 1 : 0}`)
      .join(',')}|${desktop.available}:${desktop.project?.assets?.length ?? 0}`,
  () => void loadBrowserPreviews(),
  { immediate: true },
)
onBeforeUnmount(() => {
  browserPreviewUrls.forEach((url) => globalThis.URL.revokeObjectURL(url))
  browserPreviewUrls.clear()
})
</script>

<template>
  <section class="asset-panel scene-panel" :class="{ 'has-inspector': showEditor }">
    <header class="panel-toolbar">
      <div class="toolbar-actions">
        <label class="inline-select-label"
          >分集选择<select v-if="workspace.episodes.length" v-model="selectedEpisodeId">
            <option v-for="episode in workspace.episodes" :key="episode.id" :value="episode.id">
              第 {{ episode.episodeNo }} 集 · {{ episode.title }}
            </option>
          </select></label
        >
      </div>
      <div class="toolbar-actions">
        <button class="button primary" :disabled="!workspace.activeEpisodeId" @click="openCreate">
          <Plus :size="17" />新建场景</button
        ><button class="button" disabled title="配置文本模型后开放">从剧本提取</button>
      </div>
    </header>
    <div class="scene-subtoolbar">
      <button class="text-action" @click="workspace.loadScenes(projectId)">
        <RefreshCw :size="15" />刷新</button
      ><label
        >状态<select v-model="statusFilter">
          <option value="ALL">全部</option>
          <option value="DRAFT">草稿</option>
        </select></label
      ><span>共 {{ filteredScenes.length }} 个场景</span>
    </div>
    <p v-if="formError && !showEditor" class="inline-error">{{ formError }}</p>

    <div v-if="!workspace.activeEpisodeId" class="workspace-empty bordered">
      <strong>请先创建分集</strong>
      <p>场景必须属于一个具体分集。</p>
    </div>
    <div v-else-if="workspace.scenesLoading" class="workspace-empty bordered">正在加载场景...</div>
    <div v-else class="scene-content">
      <div v-if="filteredScenes.length === 0" class="workspace-empty bordered">
        <strong>本集暂无符合条件的场景</strong>
        <p>新建场景后可上传或生成背景图。</p>
      </div>
      <div v-else class="scene-card-grid">
        <article
          v-for="scene in filteredScenes"
          :key="scene.id"
          class="scene-card"
          :class="{ selected: editingId === scene.id }"
        >
          <div class="scene-visual">
            <img v-if="previewUrl(scene.id)" :src="previewUrl(scene.id)" :alt="scene.title" />
            <div v-else class="scene-visual-empty">
              <ImagePlus :size="30" /><span>暂无背景图</span>
            </div>
            <div class="scene-visual-actions">
              <button type="button" @click="openAssetPicker(scene)">
                <ImagePlus :size="15" />{{ desktop.available ? '绑定/更换背景图' : '上传背景图' }}
              </button>
              <button type="button" @click="imageScene = scene">
                <WandSparkles :size="15" />生成背景图
              </button>
            </div>
          </div>
          <div class="scene-card-body">
            <header>
              <div>
                <span>场景 {{ String(scene.sceneNo).padStart(2, '0') }}</span>
                <h3>{{ scene.title }}</h3>
              </div>
              <div class="row-actions">
                <button class="icon-button compact" title="编辑场景" @click="openEdit(scene)">
                  <Pencil :size="15" />
                </button>
                <button
                  class="icon-button compact danger"
                  title="删除场景"
                  @click="deleteScene(scene)"
                >
                  <Trash2 :size="15" />
                </button>
              </div>
            </header>
            <dl>
              <dt>地点</dt>
              <dd>{{ scene.location || '未设置' }}</dd>
              <dt>时间</dt>
              <dd>{{ scene.timeOfDay || '未设置' }}</dd>
              <dt>状态</dt>
              <dd>
                <span class="scene-state"
                  ><i />{{ scene.status === 'DRAFT' ? '草稿' : scene.status }}</span
                >
              </dd>
            </dl>
            <p>{{ scene.description || '暂无场景说明' }}</p>
            <small :title="scene.environmentPrompt">{{
              scene.environmentPrompt || '未填写环境提示词'
            }}</small>
          </div>
        </article>
      </div>

      <aside v-if="showEditor" class="scene-inspector">
        <header>
          <h2>{{ editingId ? '场景编辑' : '新建场景' }}</h2>
          <button class="icon-button compact" title="关闭" @click="closeEditor">
            <X :size="17" />
          </button>
        </header>
        <form @submit.prevent="saveScene">
          <label
            >场景名称<input
              v-model="form.title"
              maxlength="120"
              placeholder="留空将自动命名" /></label
          ><label>地点<input v-model="form.location" maxlength="160" /></label
          ><label
            >时间<select v-model="form.timeOfDay">
              <option>清晨</option>
              <option>白天</option>
              <option>黄昏</option>
              <option>夜晚</option>
            </select></label
          ><label>场景说明<textarea v-model="form.description" rows="5" maxlength="5000" /></label
          ><label
            >环境提示词<textarea
              v-model="form.environmentPrompt"
              rows="8"
              maxlength="10000"
              placeholder="空间布局、光线、材质、色彩和氛围"
            />
          </label>
          <div v-if="editingScene" class="scene-reference-manager">
            <img
              v-if="previewUrl(editingScene.id)"
              :src="previewUrl(editingScene.id)"
              :alt="editingScene.title"
            />
            <div v-else class="reference-placeholder">
              <span>暂无参考图</span>
              <p>可关联一张主图和多张补充图</p>
            </div>
            <button class="button" type="button" @click="openAssetPicker(editingScene)">
              <ImagePlus :size="15" />{{ desktop.available ? '绑定/更换背景图' : '上传背景图' }}
            </button>
            <button class="button" type="button" @click="imageScene = editingScene">
              <WandSparkles :size="15" />生成场景图片
            </button>
          </div>
          <div v-else class="reference-placeholder">
            <span>保存后可关联参考图</span>
            <p>场景参考图不会上传到业务服务器</p>
          </div>
          <p v-if="formError" class="form-error">{{ formError }}</p>
          <footer>
            <button class="button" type="button" @click="closeEditor">取消</button
            ><button class="button primary" type="submit" :disabled="saving">
              {{ saving ? '保存中' : '保存' }}
            </button>
          </footer>
        </form>
      </aside>
    </div>
  </section>
  <input
    ref="browserUploadInput"
    class="visually-hidden"
    type="file"
    accept="image/png,image/jpeg,image/webp"
    @change="uploadBrowserSceneImage"
  />
  <AssetPickerDialog
    v-if="assetPickerScene"
    :project-id="projectId"
    mode="scene"
    :title="`${assetPickerScene.title}参考图`"
    :episode-id="assetPickerScene.episodeId"
    :scene-id="assetPickerScene.id"
    @close="assetPickerScene = null"
  />
  <ImageGenerationDialog
    v-if="imageScene"
    open
    :project-id="projectId"
    target-type="SCENE"
    :target-id="imageScene.id"
    :title="`${imageScene.title}场景图`"
    :initial-prompt="scenePrompt(imageScene)"
    :initial-negative-prompt="sceneNegativePrompt()"
    :initial-size="projectFrameProfile(workspace.project?.aspectRatio).imageSize"
    lock-size
    category="scenes"
    :episode-id="imageScene.episodeId"
    :scene-id="imageScene.id"
    @close="imageScene = null"
  />
</template>
