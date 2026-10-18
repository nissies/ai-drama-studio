<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { Check, ChevronDown, FileText, Users, X } from 'lucide-vue-next'
import type { CharacterAsset } from '../../api/workspace'
import type { CharacterDecision, StructureCandidate, StructurePayload } from '../../api/source'
import {
  cloneStructureCandidatePayload,
  selectedEpisodesHaveContent,
} from './structure-candidate-draft'

const props = defineProps<{
  open: boolean
  candidate: StructureCandidate | null
  characters: CharacterAsset[]
  applying?: boolean
}>()
const emit = defineEmits<{
  close: []
  apply: [
    input: {
      candidateVersion: number
      payloadJson: string
      selectedEpisodeKeys: string[]
      characterDecisions: CharacterDecision[]
    },
  ]
}>()

const draft = ref<StructurePayload | null>(null)
const selectedEpisodeKeys = ref<string[]>([])
const decisions = reactive<
  Record<string, { action: CharacterDecision['action']; targetCharacterId: string }>
>({})

watch(
  () => [props.open, props.candidate] as const,
  ([open, candidate]) => {
    if (!open || !candidate?.payload) {
      draft.value = null
      selectedEpisodeKeys.value = []
      Object.keys(decisions).forEach((key) => delete decisions[key])
      return
    }
    draft.value = cloneStructureCandidatePayload(candidate.payload)
    selectedEpisodeKeys.value = candidate.payload.episodes.map((episode) => episode.candidateKey)
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

const selectedSceneCount = computed(
  () =>
    draft.value?.episodes
      .filter((episode) => selectedEpisodeKeys.value.includes(episode.candidateKey))
      .reduce((total, episode) => total + episode.scenes.length, 0) ?? 0,
)
const enabledCharacterCount = computed(
  () => Object.values(decisions).filter((decision) => decision.action !== 'IGNORE').length,
)
const isSystemSplitCandidate = computed(() => props.candidate?.generationJobId == null)
const hasCharacters = computed(() => Boolean(draft.value?.characters.length))
const hasScenes = computed(() => selectedSceneCount.value > 0)
const canApply = computed(
  () =>
    !props.applying &&
    Boolean(draft.value) &&
    selectedEpisodeKeys.value.length > 0 &&
    selectedEpisodesHaveContent(draft.value!, selectedEpisodeKeys.value) &&
    Object.values(decisions).every(
      (decision) => decision.action !== 'REUSE' || Boolean(decision.targetCharacterId),
    ),
)

function apply() {
  if (!canApply.value || !draft.value || !props.candidate) return
  emit('apply', {
    candidateVersion: props.candidate.version,
    payloadJson: JSON.stringify(draft.value),
    selectedEpisodeKeys: selectedEpisodeKeys.value,
    characterDecisions: draft.value.characters.map((character) => {
      const decision = decisions[character.candidateKey] ?? {
        action: 'IGNORE' as const,
        targetCharacterId: '',
      }
      return {
        candidateKey: character.candidateKey,
        action: decision.action,
        ...(decision.action === 'REUSE' ? { targetCharacterId: decision.targetCharacterId } : {}),
      }
    }),
  })
}

function storyCharacterCount(synopsis?: string | null) {
  return Array.from(synopsis?.trim() || '').filter((character) => !/\s/u.test(character)).length
}
</script>

<template>
  <div v-if="open" class="modal-backdrop" @click.self="emit('close')">
    <section class="modal structure-candidate-modal" role="dialog" aria-modal="true">
      <header>
        <div>
          <p>{{ isSystemSplitCandidate ? '系统无损分集' : '长文分集候选' }}</p>
          <h2>{{ isSystemSplitCandidate ? '审核原文分集内容' : '审核分集剧情、角色与场景' }}</h2>
        </div>
        <button class="icon-button" type="button" title="关闭" @click="emit('close')">
          <X :size="18" />
        </button>
      </header>

      <div v-if="draft" class="structure-review-body">
        <div class="structure-review-summary">
          <span><FileText :size="16" />已选 {{ selectedEpisodeKeys.length }} 集</span>
          <span v-if="hasCharacters"><Users :size="16" />处理 {{ enabledCharacterCount }} 个角色</span>
          <span v-if="hasScenes">创建 {{ selectedSceneCount }} 个场景</span>
          <span v-if="isSystemSplitCandidate">原文仅切分，不摘要、不改写</span>
        </div>

        <section class="structure-review-section">
          <header>
            <h3>{{ isSystemSplitCandidate ? '分集原文' : '分集与场景' }}</h3>
            <span>取消勾选的分集不会写入项目</span>
          </header>
          <div class="structure-candidate-list">
            <details v-for="episode in draft.episodes" :key="episode.candidateKey" open>
              <summary>
                <label class="candidate-episode-toggle" title="选择本集" @click.stop>
                  <input
                    v-model="selectedEpisodeKeys"
                    type="checkbox"
                    :value="episode.candidateKey"
                    :aria-label="`选择分集：${episode.title}`"
                  />
                  <span aria-hidden="true"><Check :size="14" /></span>
                </label>
                <span class="candidate-episode-heading">
                  <strong>{{ episode.title }}</strong>
                  <small>
                    {{ isSystemSplitCandidate ? '原文' : '剧情资料' }}
                    {{ storyCharacterCount(episode.synopsis) }} 字 ·
                    <template v-if="episode.scenes.length">{{ episode.scenes.length }} 个场景 · </template>
                    目标 {{ episode.targetDurationSec }} 秒
                  </small>
                </span>
                <ChevronDown class="candidate-expand-icon" :size="18" aria-hidden="true" />
              </summary>
              <div class="candidate-form-grid">
                <label>标题<input v-model="episode.title" maxlength="120" /></label>
                <label>
                  目标时长（秒）
                  <input
                    v-model.number="episode.targetDurationSec"
                    type="number"
                    min="5"
                    max="3600"
                  />
                </label>
                <label class="span-all">
                  {{
                    isSystemSplitCandidate
                      ? '分集原文（完整保存，不摘要、不改写）'
                      : '分集剧情资料（后续用于 AI 生成剧本）'
                  }}
                  <textarea v-model="episode.synopsis" rows="10" maxlength="200000" />
                </label>
                <label v-if="episode.scriptText.trim()" class="span-all">
                  历史候选剧本（审核后可保留或清空）
                  <textarea v-model="episode.scriptText" rows="8" maxlength="200000" />
                </label>
              </div>
              <div v-if="episode.scenes.length" class="candidate-scenes">
                <h4>场景</h4>
                <div
                  v-for="scene in episode.scenes"
                  :key="scene.candidateKey"
                  class="candidate-scene-row"
                >
                  <input v-model="scene.title" maxlength="120" aria-label="场景标题" />
                  <input v-model="scene.location" maxlength="160" placeholder="地点" />
                  <input v-model="scene.timeOfDay" maxlength="40" placeholder="时间" />
                  <textarea v-model="scene.description" rows="2" placeholder="环境与剧情用途" />
                  <textarea
                    v-model="scene.environmentPrompt"
                    rows="2"
                    placeholder="环境生成提示词"
                  />
                </div>
              </div>
            </details>
          </div>
        </section>

        <section v-if="hasCharacters" class="structure-review-section">
          <header>
            <h3>角色处理</h3>
            <span>同名角色只做复用建议，不会自动覆盖</span>
          </header>
          <div class="candidate-character-table">
            <div
              v-for="character in draft.characters"
              :key="character.candidateKey"
              class="candidate-character-row"
            >
              <div class="candidate-character-fields">
                <input v-model="character.name" maxlength="120" aria-label="角色名称" />
                <input v-model="character.roleType" maxlength="40" placeholder="角色类型" />
                <textarea v-model="character.description" rows="2" placeholder="角色描述" />
                <textarea
                  v-model="character.identityPrompt"
                  rows="2"
                  placeholder="身份一致性提示词"
                />
              </div>
              <div class="candidate-character-decision">
                <select
                  v-model="decisions[character.candidateKey].action"
                  aria-label="角色处理方式"
                >
                  <option value="CREATE">新建角色</option>
                  <option value="REUSE">复用已有角色</option>
                  <option value="IGNORE">忽略</option>
                </select>
                <select
                  v-if="decisions[character.candidateKey].action === 'REUSE'"
                  v-model="decisions[character.candidateKey].targetCharacterId"
                  aria-label="已有角色"
                >
                  <option value="" disabled>选择已有角色</option>
                  <option v-for="item in characters" :key="item.id" :value="item.id">
                    {{ item.name }}
                  </option>
                </select>
              </div>
            </div>
          </div>
        </section>
      </div>
      <div v-else class="structure-review-empty" role="alert">
        候选内容未能加载，请关闭后重新打开；若仍然为空，请重新生成候选。
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
