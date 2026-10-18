<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { Check, MapPinned, Users, X } from 'lucide-vue-next'
import type {
  EpisodeAssetCandidate,
  EpisodeAssetPayload,
  EpisodeCharacterDecision,
} from '../../api/episode-assets'
import type { CharacterAsset } from '../../api/workspace'
import { cloneEpisodeAssetPayload } from './episode-asset-draft'

const props = defineProps<{
  open: boolean
  candidate: EpisodeAssetCandidate | null
  characters: CharacterAsset[]
  applying?: boolean
}>()
const emit = defineEmits<{
  close: []
  apply: [
    input: {
      candidateVersion: number
      payloadJson: string
      selectedSceneKeys: string[]
      characterDecisions: EpisodeCharacterDecision[]
    },
  ]
}>()

const draft = ref<EpisodeAssetPayload | null>(null)
const selectedSceneKeys = ref<string[]>([])
const decisions = reactive<
  Record<string, { action: EpisodeCharacterDecision['action']; targetCharacterId: string }>
>({})

watch(
  () => [props.open, props.candidate] as const,
  ([open, candidate]) => {
    if (!open || !candidate?.payload) return
    draft.value = cloneEpisodeAssetPayload(candidate.payload)
    selectedSceneKeys.value = candidate.payload.scenes.map((scene) => scene.candidateKey)
    Object.keys(decisions).forEach((key) => delete decisions[key])
    candidate.payload.characters.forEach((character) => {
      const existing = props.characters.find((item) => item.name.trim() === character.name.trim())
      decisions[character.candidateKey] = existing
        ? { action: 'REUSE', targetCharacterId: existing.id }
        : { action: 'CREATE', targetCharacterId: '' }
    })
  },
  { immediate: true },
)

const enabledCharacterCount = computed(
  () => Object.values(decisions).filter((decision) => decision.action !== 'IGNORE').length,
)
const canApply = computed(
  () =>
    !props.applying &&
    Boolean(draft.value) &&
    (selectedSceneKeys.value.length > 0 || enabledCharacterCount.value > 0) &&
    Object.values(decisions).every(
      (decision) => decision.action !== 'REUSE' || Boolean(decision.targetCharacterId),
    ),
)

function apply() {
  if (!canApply.value || !draft.value || !props.candidate) return
  emit('apply', {
    candidateVersion: props.candidate.version,
    payloadJson: JSON.stringify(draft.value),
    selectedSceneKeys: selectedSceneKeys.value,
    characterDecisions: draft.value.characters.map((character) => {
      const decision = decisions[character.candidateKey] ?? {
        action: 'IGNORE' as const,
        targetCharacterId: '',
      }
      return {
        candidateKey: character.candidateKey,
        action: decision.action,
        ...(decision.action === 'REUSE'
          ? { targetCharacterId: decision.targetCharacterId }
          : {}),
      }
    }),
  })
}
</script>

<template>
  <div v-if="open" class="modal-backdrop" @click.self="emit('close')">
    <section
      class="modal structure-candidate-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="episode-asset-candidate-title"
    >
      <header>
        <div>
          <p>AI 提取候选</p>
          <h2 id="episode-asset-candidate-title">审核角色与场景</h2>
        </div>
        <button
          class="icon-button"
          type="button"
          title="关闭"
          aria-label="关闭角色与场景审核"
          @click="emit('close')"
        >
          <X :size="18" />
        </button>
      </header>

      <div v-if="draft" class="structure-review-body">
        <div class="structure-review-summary">
          <span><Users :size="16" />将导入 {{ enabledCharacterCount }} 个角色</span>
          <span><MapPinned :size="16" />将导入 {{ selectedSceneKeys.length }} 个场景</span>
        </div>

        <section class="structure-review-section">
          <header>
            <h3>角色处理</h3>
            <span>同名角色默认复用，不会覆盖已有角色资料</span>
          </header>
          <div v-if="draft.characters.length" class="candidate-character-table">
            <div
              v-for="character in draft.characters"
              :key="character.candidateKey"
              class="candidate-character-row episode-asset-character-row"
            >
              <div class="candidate-character-fields episode-asset-character-fields">
                <label class="episode-asset-field episode-asset-field--character-name">
                  <span><strong>角色名称</strong><small>角色在项目中的名称</small></span>
                  <input v-model="character.name" maxlength="120" />
                </label>
                <label class="episode-asset-field episode-asset-field--character-role">
                  <span><strong>角色定位</strong><small>主角、配角等剧情身份</small></span>
                  <input v-model="character.roleType" maxlength="40" />
                </label>
                <label class="episode-asset-field episode-asset-field--character-description">
                  <span><strong>角色简介</strong><small>身份背景、性格与剧情作用</small></span>
                  <textarea v-model="character.description" rows="3" />
                </label>
                <label class="episode-asset-field episode-asset-field--character-visual">
                  <span><strong>角色视觉设定</strong><small>外貌、年龄与服装，用于生成人物图</small></span>
                  <textarea v-model="character.identityPrompt" rows="3" />
                </label>
                <label class="episode-asset-field episode-asset-field--character-negative">
                  <span><strong>避免内容</strong><small>生成图片时不希望出现的特征</small></span>
                  <textarea v-model="character.negativePrompt" rows="3" />
                </label>
              </div>
              <div class="candidate-character-decision episode-asset-character-decision">
                <label class="episode-asset-field">
                  <span><strong>导入方式</strong><small>新建、关联已有角色或不导入</small></span>
                  <select v-model="decisions[character.candidateKey].action">
                    <option value="CREATE">新建角色</option>
                    <option value="REUSE">关联已有角色</option>
                    <option value="IGNORE">不导入</option>
                  </select>
                </label>
                <label
                  v-if="decisions[character.candidateKey].action === 'REUSE'"
                  class="episode-asset-field"
                >
                  <span><strong>关联到</strong><small>选择项目中的已有角色</small></span>
                  <select v-model="decisions[character.candidateKey].targetCharacterId">
                    <option value="" disabled>选择已有角色</option>
                    <option v-for="item in characters" :key="item.id" :value="item.id">
                      {{ item.name }}
                    </option>
                  </select>
                </label>
              </div>
            </div>
          </div>
          <p v-else class="route-empty">本次没有提取到角色</p>
        </section>

        <section class="structure-review-section">
          <header>
            <h3>场景</h3>
            <span>取消勾选的场景不会写入本集</span>
          </header>
          <div v-if="draft.scenes.length" class="candidate-scenes episode-asset-scenes">
            <div
              v-for="scene in draft.scenes"
              :key="scene.candidateKey"
              class="episode-asset-scene-row"
            >
              <label class="episode-asset-field episode-asset-field--scene-enabled">
                <span><strong>是否导入</strong><small>取消后不写入本集</small></span>
                <span class="episode-asset-checkbox">
                  <input
                    v-model="selectedSceneKeys"
                    type="checkbox"
                    :value="scene.candidateKey"
                  />
                  导入场景
                </span>
              </label>
              <label class="episode-asset-field episode-asset-field--scene-title">
                <span><strong>场景名称</strong><small>用于场景列表识别</small></span>
                <input v-model="scene.title" maxlength="120" />
              </label>
              <label class="episode-asset-field episode-asset-field--scene-location">
                <span><strong>地点</strong><small>故事发生的具体空间</small></span>
                <input v-model="scene.location" maxlength="160" />
              </label>
              <label class="episode-asset-field episode-asset-field--scene-time">
                <span><strong>时间</strong><small>白天、深夜等</small></span>
                <input v-model="scene.timeOfDay" maxlength="40" />
              </label>
              <label class="episode-asset-field episode-asset-field--scene-description">
                <span><strong>场景说明</strong><small>环境特征与剧情用途</small></span>
                <textarea v-model="scene.description" rows="3" />
              </label>
              <label class="episode-asset-field episode-asset-field--scene-visual">
                <span><strong>场景视觉设定</strong><small>用于生成背景图的画面描述</small></span>
                <textarea v-model="scene.environmentPrompt" rows="3" />
              </label>
            </div>
          </div>
          <p v-else class="route-empty">本次没有提取到场景</p>
        </section>
      </div>

      <footer>
        <span>确认后一次性写入；任一步失败都会整体回滚。</span>
        <div>
          <button class="button" type="button" @click="emit('close')">取消</button>
          <button class="button primary" type="button" :disabled="!canApply" @click="apply">
            <Check :size="16" />{{ applying ? '应用中...' : '确认应用' }}
          </button>
        </div>
      </footer>
    </section>
  </div>
</template>
