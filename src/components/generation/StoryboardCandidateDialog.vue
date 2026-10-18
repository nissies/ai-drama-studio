<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  ArrowDown,
  ArrowUp,
  Check,
  Clapperboard,
  Clock3,
  Combine,
  ListChecks,
  RefreshCw,
  X,
} from 'lucide-vue-next'
import type {
  StoryboardCandidate,
  StoryboardCandidatePayload,
  StoryboardShotCandidate,
} from '../../api/storyboard-candidates'
import type { CharacterAsset, Scene } from '../../api/workspace'
import {
  cloneStoryboardCandidatePayload,
  createSelectedStoryboardPayload,
  mergeStoryboardShotsByTargetDuration,
  selectedStoryboardDuration,
  validateStoryboardCandidateDraft,
} from './storyboard-candidate-draft'

const props = defineProps<{
  open: boolean
  candidate: StoryboardCandidate | null
  characters: CharacterAsset[]
  scenes: Scene[]
  existingCount: number
  applying?: boolean
  error?: string
}>()
const emit = defineEmits<{
  close: []
  regenerate: []
  apply: [
    input: {
      candidateVersion: number
      payloadJson: string
      selectedShotKeys: string[]
    },
  ]
}>()

const shotTypes = ['远景', '全景', '中景', '近景', '特写', '大特写']
const angles = ['平视', '仰视', '俯视', '侧拍', '背拍', '过肩', '主观视角']
const movements = ['固定', '推镜', '拉镜', '摇镜', '移镜', '跟拍', '环绕', '手持']
const draft = ref<StoryboardCandidatePayload | null>(null)
const selectedShotKeys = ref<string[]>([])
const expandedShotKeys = ref<string[]>([])
const initialSnapshot = ref('')

watch(
  () => [props.open, props.candidate] as const,
  ([open, candidate]) => {
    if (!open || !candidate?.payload) return
    draft.value = cloneStoryboardCandidatePayload(candidate.payload)
    selectedShotKeys.value = candidate.payload.shots.map((shot) => shot.candidateKey)
    expandedShotKeys.value = candidate.payload.shots[0]
      ? [candidate.payload.shots[0].candidateKey]
      : []
    initialSnapshot.value = snapshot()
  },
  { immediate: true },
)

const characterIdSet = computed(() => new Set(props.characters.map((item) => item.id)))
const sceneIdSet = computed(() => new Set(props.scenes.map((item) => item.id)))
const selectedCount = computed(() => selectedShotKeys.value.length)
const totalDuration = computed(() =>
  draft.value ? selectedStoryboardDuration(draft.value.shots, selectedShotKeys.value) : 0,
)
const invalidBindingCount = computed(() => {
  if (!draft.value) return 0
  const selected = new Set(selectedShotKeys.value)
  return draft.value.shots.filter(
    (shot) =>
      selected.has(shot.candidateKey) &&
      ((shot.sceneId && !sceneIdSet.value.has(shot.sceneId)) ||
        shot.characterIds.some((id) => !characterIdSet.value.has(id))),
  ).length
})
const validationError = computed(() =>
  draft.value ? validateStoryboardCandidateDraft(draft.value, selectedShotKeys.value) : '',
)
const canApply = computed(
  () =>
    !props.applying &&
    Boolean(draft.value) &&
    !validationError.value &&
    invalidBindingCount.value === 0,
)
const allSelected = computed(
  () => Boolean(draft.value?.shots.length) && selectedCount.value === draft.value?.shots.length,
)
const dirty = computed(() => Boolean(draft.value) && snapshot() !== initialSnapshot.value)
const selectedVisualStats = computed(() => {
  const selected = new Set(selectedShotKeys.value)
  const shots = draft.value?.shots.filter((shot) => selected.has(shot.candidateKey)) ?? []
  return {
    shotTypes: new Set(shots.map((shot) => shot.shotType || '未设置')).size,
    angles: new Set(shots.map((shot) => shot.angle || '未设置')).size,
    movements: new Set(shots.map((shot) => shot.movement || '未设置')).size,
  }
})
const visualVarietyWarning = computed(() => {
  if (selectedCount.value < 4) return ''
  const issues: string[] = []
  if (selectedVisualStats.value.shotTypes < 2) issues.push('景别变化不足')
  if (selectedVisualStats.value.angles < 2) issues.push('机位角度过于单一')
  if (selectedVisualStats.value.movements < 2) issues.push('运镜方式过于单一')
  return issues.length ? `${issues.join('、')}，建议调整后再应用。` : ''
})

function snapshot() {
  return JSON.stringify({ payload: draft.value, selected: selectedShotKeys.value })
}

function unknownCharacterIds(shot: StoryboardShotCandidate) {
  return shot.characterIds.filter((id) => !characterIdSet.value.has(id))
}

function toggleAll() {
  if (!draft.value) return
  selectedShotKeys.value = allSelected.value
    ? []
    : draft.value.shots.map((shot) => shot.candidateKey)
}

function mergeSelectedToAbout15() {
  if (!draft.value || !selectedShotKeys.value.length) return
  const result = mergeStoryboardShotsByTargetDuration(
    draft.value,
    selectedShotKeys.value,
    15,
  )
  draft.value = result.payload
  selectedShotKeys.value = result.selectedKeys
  expandedShotKeys.value = []
}

function mergeSelectedToAbout12() {
  if (!draft.value || !selectedShotKeys.value.length) return
  const result = mergeStoryboardShotsByTargetDuration(
    draft.value,
    selectedShotKeys.value,
    12,
  )
  draft.value = result.payload
  selectedShotKeys.value = result.selectedKeys
  expandedShotKeys.value = []
}

function move(index: number, offset: -1 | 1) {
  if (!draft.value) return
  const target = index + offset
  if (target < 0 || target >= draft.value.shots.length) return
  const [shot] = draft.value.shots.splice(index, 1)
  if (shot) draft.value.shots.splice(target, 0, shot)
}

function toggleExpanded(event: globalThis.Event, candidateKey: string) {
  const details = event.currentTarget as globalThis.HTMLDetailsElement
  const expanded = new Set(expandedShotKeys.value)
  if (details.open) expanded.add(candidateKey)
  else expanded.delete(candidateKey)
  expandedShotKeys.value = [...expanded]
}

function requestClose() {
  if (props.applying) return
  if (dirty.value && !globalThis.confirm('当前候选有未应用的修改，确定关闭吗？')) return
  emit('close')
}

function requestRegenerate() {
  if (props.applying) return
  if (dirty.value && !globalThis.confirm('当前修改不会保留，确定重新生成分镜吗？')) return
  emit('regenerate')
}

function apply() {
  if (!canApply.value || !draft.value || !props.candidate) return
  emit('apply', {
    candidateVersion: props.candidate.version,
    payloadJson: JSON.stringify(
      createSelectedStoryboardPayload(draft.value, selectedShotKeys.value),
    ),
    selectedShotKeys: selectedShotKeys.value,
  })
}
</script>

<template>
  <div v-if="open" class="modal-backdrop" @click.self="requestClose">
    <section
      class="modal storyboard-candidate-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="storyboard-candidate-title"
    >
      <header>
        <div>
          <p>AI 分镜候选</p>
          <h2 id="storyboard-candidate-title">审核并追加分镜</h2>
        </div>
        <button class="icon-button" type="button" title="关闭" @click="requestClose">
          <X :size="18" />
        </button>
      </header>

      <div v-if="draft" class="storyboard-review-body">
        <div class="storyboard-review-summary">
          <span
          ><ListChecks :size="16" />已选 {{ selectedCount }} / {{ draft.shots.length }} 镜</span
          >
          <span><Clock3 :size="16" />总时长 {{ totalDuration }} 秒</span>
          <span><Clapperboard :size="16" />现有 {{ existingCount }} 镜</span>
          <button class="button compact" type="button" @click="toggleAll">
            {{ allSelected ? '取消全选' : '全部选择' }}
          </button>
          <button
            class="button compact"
            type="button"
            title="把已选碎镜头合并为约 12 秒一段，减少视频生成次数"
            :disabled="selectedCount < 2"
            @click="mergeSelectedToAbout12"
          >
            <Combine :size="15" />合并约 12 秒
          </button>
          <button
            class="button compact primary"
            type="button"
            title="把已选碎镜头合并为约 15 秒一段，适合视频模型一次生成"
            :disabled="selectedCount < 2"
            @click="mergeSelectedToAbout15"
          >
            <Combine :size="15" />合并约 15 秒
          </button>
        </div>

        <p class="storyboard-append-notice">
          确认后只会把选中镜头追加到本集末尾，不会修改、替换或删除现有分镜。
        </p>
        <p class="storyboard-visual-summary">
          镜头语言：{{ selectedVisualStats.shotTypes }} 种景别 ·
          {{ selectedVisualStats.angles }} 种角度 · {{ selectedVisualStats.movements }} 种运镜
        </p>
        <p v-if="visualVarietyWarning" class="storyboard-variety-warning">
          {{ visualVarietyWarning }}
        </p>
        <p v-if="invalidBindingCount" class="form-error">
          {{ invalidBindingCount }} 个镜头引用了已删除的角色或场景，请重新选择或取消绑定。
        </p>

        <div class="storyboard-candidate-list">
          <details
            v-for="(shot, index) in draft.shots"
            :key="shot.candidateKey"
            :open="expandedShotKeys.includes(shot.candidateKey)"
            @toggle="toggleExpanded($event, shot.candidateKey)"
          >
            <summary>
              <input
                v-model="selectedShotKeys"
                type="checkbox"
                :value="shot.candidateKey"
                :aria-label="`选择镜头 ${index + 1}`"
                @click.stop
              />
              <span class="storyboard-candidate-index">{{
                String(index + 1).padStart(2, '0')
              }}</span>
              <strong>{{ shot.title || '未命名镜头' }}</strong>
              <span>
                {{ shot.shotType || '未设景别' }} · {{ shot.angle || '未设角度' }} ·
                {{ shot.movement || '未设运镜' }} · {{ shot.durationSec }} 秒</span
              >
              <div class="storyboard-candidate-order" @click.stop>
                <button
                  class="icon-button compact"
                  type="button"
                  title="上移"
                  :disabled="index === 0"
                  @click.prevent="move(index, -1)"
                >
                  <ArrowUp :size="14" />
                </button>
                <button
                  class="icon-button compact"
                  type="button"
                  title="下移"
                  :disabled="index === draft.shots.length - 1"
                  @click.prevent="move(index, 1)"
                >
                  <ArrowDown :size="14" />
                </button>
              </div>
            </summary>

            <div
              v-if="expandedShotKeys.includes(shot.candidateKey)"
              class="storyboard-candidate-fields"
            >
              <label class="storyboard-field storyboard-field--title">
                <span><strong>镜头标题</strong><small>用于镜头列表快速识别</small></span>
                <input v-model="shot.title" maxlength="120" />
              </label>
              <label class="storyboard-field">
                <span><strong>时长（秒）</strong><small>单镜 1 到 300 秒</small></span>
                <input v-model.number="shot.durationSec" type="number" min="1" max="300" />
              </label>
              <label class="storyboard-field">
                <span><strong>所属场景</strong><small>关联本集已有场景</small></span>
                <select v-model="shot.sceneId">
                  <option :value="null">不绑定场景</option>
                  <option
                    v-if="shot.sceneId && !sceneIdSet.has(shot.sceneId)"
                    :value="shot.sceneId"
                    disabled
                  >
                    原场景已不存在
                  </option>
                  <option v-for="scene in scenes" :key="scene.id" :value="scene.id">
                    {{ scene.sceneNo }} · {{ scene.title }}
                  </option>
                </select>
              </label>
              <label class="storyboard-field">
                <span><strong>景别</strong><small>画面覆盖范围</small></span>
                <select v-model="shot.shotType">
                  <option
                    v-if="shot.shotType && !shotTypes.includes(shot.shotType)"
                    :value="shot.shotType"
                  >
                    {{ shot.shotType }}
                  </option>
                  <option v-for="item in shotTypes" :key="item">{{ item }}</option>
                </select>
              </label>
              <label class="storyboard-field">
                <span><strong>拍摄角度</strong><small>机位观察方向</small></span>
                <select v-model="shot.angle">
                  <option v-if="shot.angle && !angles.includes(shot.angle)" :value="shot.angle">
                    {{ shot.angle }}
                  </option>
                  <option v-for="item in angles" :key="item">{{ item }}</option>
                </select>
              </label>
              <label class="storyboard-field">
                <span><strong>运镜方式</strong><small>镜头移动与节奏</small></span>
                <select v-model="shot.movement">
                  <option
                    v-if="shot.movement && !movements.includes(shot.movement)"
                    :value="shot.movement"
                  >
                    {{ shot.movement }}
                  </option>
                  <option v-for="item in movements" :key="item">{{ item }}</option>
                </select>
              </label>

              <fieldset class="storyboard-candidate-characters">
                <legend>涉及角色 <small>用于后续保持人物形象一致</small></legend>
                <p v-if="!characters.length && !unknownCharacterIds(shot).length">
                  项目中还没有角色
                </p>
                <label v-for="character in characters" :key="character.id">
                  <input v-model="shot.characterIds" type="checkbox" :value="character.id" />
                  <span>{{ character.name }}</span>
                </label>
                <label
                  v-for="characterId in unknownCharacterIds(shot)"
                  :key="characterId"
                  class="invalid-binding"
                >
                  <input v-model="shot.characterIds" type="checkbox" :value="characterId" />
                  <span>已失效角色（取消勾选）</span>
                </label>
              </fieldset>

              <label class="storyboard-field">
                <span><strong>地点</strong><small>镜头发生的具体空间</small></span>
                <input v-model="shot.location" maxlength="160" />
              </label>
              <label class="storyboard-field">
                <span><strong>时间</strong><small>白天、黄昏、深夜等</small></span>
                <input v-model="shot.timeOfDay" maxlength="40" />
              </label>
              <label class="storyboard-field storyboard-field--wide">
                <span><strong>镜头概述</strong><small>画面构成和本镜头的叙事目的</small></span>
                <textarea v-model="shot.description" rows="3" maxlength="5000" />
              </label>
              <label class="storyboard-field storyboard-field--wide">
                <span><strong>人物动作</strong><small>演员在镜头内执行的动作</small></span>
                <textarea v-model="shot.actionText" rows="3" maxlength="5000" />
              </label>
              <label class="storyboard-field storyboard-field--wide">
                <span><strong>对白 / 旁白</strong><small>角色开口说话或普通画外旁白</small></span>
                <textarea v-model="shot.dialogue" rows="3" maxlength="10000" />
              </label>
              <label class="storyboard-field storyboard-field--wide">
                <span
                ><strong>内心独白</strong
                ><small>作为画外音播放，角色不张嘴、不做口型</small></span
                >
                <textarea v-model="shot.innerMonologue" rows="3" maxlength="10000" />
              </label>
              <label class="storyboard-field">
                <span><strong>镜头结果</strong><small>镜头结束时发生的变化</small></span>
                <textarea v-model="shot.resultText" rows="3" maxlength="5000" />
              </label>
              <label class="storyboard-field">
                <span><strong>氛围</strong><small>情绪、光线和节奏基调</small></span>
                <textarea v-model="shot.atmosphere" rows="3" maxlength="2000" />
              </label>
              <label class="storyboard-field storyboard-field--wide">
                <span
                ><strong>画面构图参考</strong><small>用于完善视频提示词与镜头执行</small></span
                >
                <textarea v-model="shot.imagePrompt" rows="4" maxlength="20000" />
              </label>
              <label class="storyboard-field storyboard-field--wide">
                <span><strong>动态视频提示词</strong><small>用于生成镜头动作和运镜</small></span>
                <textarea v-model="shot.videoPrompt" rows="4" maxlength="20000" />
              </label>
              <label class="storyboard-field">
                <span><strong>配乐提示词</strong><small>本镜头的音乐情绪</small></span>
                <textarea v-model="shot.bgmPrompt" rows="3" maxlength="5000" />
              </label>
              <label class="storyboard-field">
                <span><strong>关键音效</strong><small>环境声和动作音效</small></span>
                <textarea v-model="shot.soundEffect" rows="3" maxlength="5000" />
              </label>
            </div>
          </details>
        </div>
      </div>

      <footer>
        <span v-if="error" class="form-error">{{ error }}</span>
        <span v-else-if="validationError" class="form-error">{{ validationError }}</span>
        <span v-else>确认后一次性追加；任一步失败都会整体回滚。</span>
        <div>
          <button class="button" type="button" @click="requestClose">取消</button>
          <button class="button" type="button" :disabled="applying" @click="requestRegenerate">
            <RefreshCw :size="16" />重新生成
          </button>
          <button class="button primary" type="button" :disabled="!canApply" @click="apply">
            <Check :size="16" />{{ applying ? '应用中...' : `追加 ${selectedCount} 个镜头` }}
          </button>
        </div>
      </footer>
    </section>
  </div>
</template>
