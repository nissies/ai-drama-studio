<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Cloud, HardDrive, LockKeyhole, LogIn, Sparkles, X } from 'lucide-vue-next'
import { useRoute, useRouter } from 'vue-router'
import { creditApi, type CreditQuote } from '../../api/credits'
import {
  platformModelCatalogApi,
  platformModelPriceLabel,
  type PlatformModelCatalogItem,
} from '../../api/model-catalog'
import type { GenerationRoute } from '../../api/generation'
import type { LocalAiConnection } from '../../desktop/types'
import { useDesktopStore } from '../../stores/desktop'
import { useCreditStore } from '../../stores/credits'
import { useAuthStore } from '../../stores/auth'

const props = defineProps<{
  open: boolean
  submitting?: boolean
  eyebrow?: string
  title?: string
  submitLabel?: string
  serviceType?: 'TEXT' | 'IMAGE' | 'VIDEO' | 'TTS'
  executionError?: string
  quotePrompt?: string
  quoteParameters?: Record<string, unknown>
  quoteItems?: Array<{ prompt?: string; parameters?: Record<string, unknown> }>
  /** 批量生成时按镜头数放大报价展示与余额校验 */
  quoteMultiplier?: number
  initialRoute?: GenerationRoute | null
}>()
const emit = defineEmits<{
  close: []
  submit: [route: GenerationRoute]
  selection: [route: GenerationRoute | null]
}>()

const desktop = useDesktopStore()
const credits = useCreditStore()
const auth = useAuthStore()
const currentRoute = useRoute()
const router = useRouter()
const sourceType = ref<'LOCAL' | 'PLATFORM'>('LOCAL')
const localConnectionId = ref('')
const platformModelId = ref('')
const platformModels = ref<PlatformModelCatalogItem[]>([])
const loading = ref(false)
const error = ref('')
const quote = ref<CreditQuote | null>(null)
const quoteLoading = ref(false)
const quoteError = ref('')
const cloudLoginRequired = ref(false)
let quoteRequest = 0
let optionsRequest = 0

const localConnections = computed(() =>
  desktop.localAiConnections.filter(
    (item) => item.serviceType === (props.serviceType ?? 'TEXT') && item.enabled,
  ),
)
const serviceLabel = computed(
  () => ({ TEXT: '文本', IMAGE: '图片', VIDEO: '视频', TTS: '配音' })[props.serviceType ?? 'TEXT'],
)
const selectedLocal = computed<LocalAiConnection | undefined>(() =>
  localConnections.value.find((item) => item.id === localConnectionId.value),
)
const selectedPlatform = computed(() =>
  platformModels.value.find((item) => item.id === platformModelId.value),
)
const quoteInputSignature = computed(() =>
  JSON.stringify({
    prompt: props.quotePrompt ?? '',
    parameters: props.quoteParameters ?? {},
    items: props.quoteItems ?? [],
  }),
)
const canSubmit = computed(
  () =>
    !props.submitting &&
    (sourceType.value === 'LOCAL'
      ? Boolean(selectedLocal.value && desktop.available)
      : Boolean(
          selectedPlatform.value?.creditPrice &&
          (!quote.value ||
            !credits.wallet ||
            (totalEstimatedPoints.value ?? quote.value.estimatedPoints) <=
              credits.wallet.availablePoints),
        )),
)
const quoteItemCount = computed(() => props.quoteItems?.length ?? 0)
const quoteCount = computed(() =>
  quoteItemCount.value > 0 ? 1 : Math.max(1, Math.floor(props.quoteMultiplier || 1)),
)
const totalEstimatedPoints = computed(() =>
  quote.value ? quote.value.estimatedPoints * quoteCount.value : null,
)
const remainingPoints = computed(() =>
  totalEstimatedPoints.value != null && credits.wallet
    ? Math.max(0, credits.wallet.availablePoints - totalEstimatedPoints.value)
    : null,
)

watch(
  () => props.open,
  (open) => {
    if (open) {
      cloudLoginRequired.value = false
      void loadOptions()
      return
    }
    optionsRequest += 1
    quoteRequest += 1
    quoteLoading.value = false
  },
)

watch([sourceType, platformModelId, quoteInputSignature], () => {
  if (props.open && sourceType.value === 'PLATFORM') void loadQuote()
  emit('selection', selectedRoute())
})

watch(localConnectionId, () => emit('selection', selectedRoute()))

async function loadOptions() {
  const requestNumber = ++optionsRequest
  loading.value = true
  error.value = ''
  try {
    const modelsPromise = auth.isAuthenticated
      ? platformModelCatalogApi.list(props.serviceType ?? 'TEXT').catch((caught) => {
          if (!desktop.available) throw caught
          return [] as PlatformModelCatalogItem[]
        })
      : Promise.resolve([] as PlatformModelCatalogItem[])
    const tasks: Promise<unknown>[] = [modelsPromise]
    if (auth.isAuthenticated) {
      tasks.push(
        credits.load(true).catch((caught) => {
          if (!desktop.available) throw caught
        }),
      )
    }
    if (desktop.available) tasks.push(desktop.loadLocalAiConnections())
    await Promise.all(tasks)
    if (requestNumber !== optionsRequest || !props.open) return
    platformModels.value = await modelsPromise

    const initialLocalId =
      props.initialRoute?.sourceType === 'LOCAL' ? props.initialRoute.localConnectionId : ''
    const initialPlatformId =
      props.initialRoute?.sourceType === 'PLATFORM' ? props.initialRoute.platformModelId : ''
    localConnectionId.value = localConnections.value.some((item) => item.id === initialLocalId)
      ? initialLocalId
      : (localConnections.value.find((item) => item.defaultProvider)?.id ??
        localConnections.value[0]?.id ??
        '')
    platformModelId.value = platformModels.value.some((item) => item.id === initialPlatformId)
      ? initialPlatformId
      : (platformModels.value.find((item) => item.creditPrice)?.id ??
        platformModels.value[0]?.id ??
        '')
    sourceType.value =
      props.initialRoute?.sourceType === 'LOCAL' && localConnectionId.value
        ? 'LOCAL'
        : auth.isAuthenticated &&
            props.initialRoute?.sourceType === 'PLATFORM' &&
            platformModelId.value
          ? 'PLATFORM'
          : localConnectionId.value
            ? 'LOCAL'
            : auth.isAuthenticated
              ? 'PLATFORM'
              : 'LOCAL'
    if (sourceType.value === 'PLATFORM') await loadQuote()
    emit('selection', selectedRoute())
  } catch (caught) {
    if (requestNumber === optionsRequest) {
      error.value = caught instanceof Error ? caught.message : 'AI 模型列表读取失败'
    }
  } finally {
    if (requestNumber === optionsRequest) loading.value = false
  }
}

function chooseSource(nextSource: 'LOCAL' | 'PLATFORM') {
  if (nextSource === 'PLATFORM' && !auth.isAuthenticated) {
    cloudLoginRequired.value = true
    return
  }
  cloudLoginRequired.value = false
  sourceType.value = nextSource
}

function continueLocally() {
  cloudLoginRequired.value = false
  sourceType.value = 'LOCAL'
}

async function openCloudLogin() {
  emit('close')
  await router.push({
    name: 'login',
    query: { redirect: currentRoute.fullPath, reason: 'cloud-service' },
  })
}

async function loadQuote() {
  const model = selectedPlatform.value
  if (!model?.creditPrice) {
    quote.value = null
    quoteError.value = ''
    return
  }
  const requestNumber = ++quoteRequest
  quoteLoading.value = true
  quoteError.value = ''
  try {
    const quoteItems = (props.quoteItems ?? []).filter(
      (item) => item.prompt?.trim() || item.parameters,
    )
    if (quoteItems.length) {
      const results = await Promise.all(
        quoteItems.map((item) =>
          creditApi.quote({
            platformModelId: model.id,
            serviceType: props.serviceType ?? 'TEXT',
            parameters: item.parameters,
            prompt: item.prompt?.slice(0, 20_000),
          }),
        ),
      )
      if (requestNumber === quoteRequest) {
        const first = results[0]
        quote.value = {
          ...first,
          estimatedPoints: results.reduce((sum, item) => sum + item.estimatedPoints, 0),
          maximumPoints: results.reduce((sum, item) => sum + item.maximumPoints, 0),
        }
      }
      return
    }
    const result = await creditApi.quote({
      platformModelId: model.id,
      serviceType: props.serviceType ?? 'TEXT',
      parameters: props.quoteParameters,
      prompt: props.quotePrompt?.slice(0, 20_000),
    })
    if (requestNumber === quoteRequest) quote.value = result
  } catch (caught) {
    if (requestNumber === quoteRequest) {
      quote.value = null
      quoteError.value = caught instanceof Error ? caught.message : '额度报价失败'
    }
  } finally {
    if (requestNumber === quoteRequest) quoteLoading.value = false
  }
}

function submit() {
  if (!canSubmit.value) return
  if (sourceType.value === 'LOCAL' && selectedLocal.value) {
    emit('submit', {
      sourceType: 'LOCAL',
      localConnectionId: selectedLocal.value.id,
      localProviderCode: selectedLocal.value.providerCode,
      localModelName: selectedLocal.value.modelName,
    })
    return
  }
  if (sourceType.value === 'PLATFORM' && selectedPlatform.value) {
    emit('submit', {
      sourceType: 'PLATFORM',
      platformModelId: selectedPlatform.value.id,
      platformModelCode: selectedPlatform.value.modelCode,
      platformProtocolProfile: selectedPlatform.value.protocolProfile,
      modelName: selectedPlatform.value.displayName,
    })
  }
}

function selectedRoute(): GenerationRoute | null {
  if (sourceType.value === 'LOCAL' && selectedLocal.value) {
    return {
      sourceType: 'LOCAL',
      localConnectionId: selectedLocal.value.id,
      localProviderCode: selectedLocal.value.providerCode,
      localModelName: selectedLocal.value.modelName,
    }
  }
  if (sourceType.value === 'PLATFORM' && selectedPlatform.value) {
    return {
      sourceType: 'PLATFORM',
      platformModelId: selectedPlatform.value.id,
      platformModelCode: selectedPlatform.value.modelCode,
      platformProtocolProfile: selectedPlatform.value.protocolProfile,
      modelName: selectedPlatform.value.displayName,
    }
  }
  return null
}

function platformPrice(model: PlatformModelCatalogItem) {
  return model.creditPrice ? platformModelPriceLabel(model) : '管理员尚未配置额度价格'
}

function platformRouteLabel(model: PlatformModelCatalogItem) {
  return model.modelCode
}
</script>

<template>
  <div v-if="open" class="modal-backdrop" @click.self="emit('close')">
    <section class="modal generation-route-modal" role="dialog" aria-modal="true">
      <header>
        <div>
          <p>{{ eyebrow || 'AI 生成' }}</p>
          <h2>{{ title || '选择本次使用的模型' }}</h2>
        </div>
        <button class="icon-button" type="button" title="关闭" @click="emit('close')">
          <X :size="18" />
        </button>
      </header>

      <div class="generation-route-body">
        <div class="source-segments" role="tablist" aria-label="AI 来源">
          <button
            type="button"
            role="tab"
            :aria-selected="sourceType === 'LOCAL'"
            :class="{ active: sourceType === 'LOCAL' }"
            :disabled="!desktop.available"
            @click="chooseSource('LOCAL')"
          >
            <HardDrive :size="17" />我的 API
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="sourceType === 'PLATFORM'"
            :class="{ active: sourceType === 'PLATFORM' }"
            @click="chooseSource('PLATFORM')"
          >
            <Cloud :size="17" />平台模型<LockKeyhole v-if="!auth.isAuthenticated" :size="13" />
          </button>
        </div>

        <p v-if="!desktop.available" class="route-notice">
          浏览器模式不能读取本机密钥；使用“我的 API”请在 Windows 客户端中打开。
        </p>
        <div v-if="$slots.default" class="route-extra">
          <slot />
        </div>
        <div v-if="cloudLoginRequired" class="route-cloud-gate">
          <span class="route-cloud-gate-icon"><Cloud :size="24" /></span>
          <div>
            <strong>使用平台模型需要登录</strong>
            <p>
              平台模型由移光漫剧工坊提供，需要登录账号并按实际生成消耗点数。本地模型和本地轮廓处理无需登录，也不会扣除点数。
            </p>
          </div>
          <div class="route-cloud-gate-actions">
            <button class="button" type="button" @click="continueLocally">
              <HardDrive :size="15" />继续使用本地模型
            </button>
            <button class="button primary" type="button" @click="openCloudLogin">
              <LogIn :size="15" />登录或注册
            </button>
          </div>
        </div>
        <div v-else-if="loading" class="route-empty">正在读取可用模型...</div>
        <template v-else-if="sourceType === 'LOCAL'">
          <div v-if="localConnections.length" class="route-options">
            <label v-for="connection in localConnections" :key="connection.id" class="route-option">
              <input v-model="localConnectionId" type="radio" :value="connection.id" />
              <span>
                <strong>{{ connection.displayName }}</strong>
                <small
                  >{{ connection.providerCode }} · {{ connection.modelName }} ·
                  不消耗平台额度</small
                >
              </span>
              <em>{{ connection.defaultProvider ? '默认 · 0 点' : '0 点' }}</em>
            </label>
          </div>
          <div v-else class="route-empty">
            <HardDrive :size="24" />
            <strong>没有可用的{{ serviceLabel }} API</strong>
            <span>请先到设置中新增并启用{{ serviceLabel }}模型。</span>
          </div>
        </template>
        <template v-else>
          <div v-if="platformModels.length" class="route-options">
            <label v-for="model in platformModels" :key="model.id" class="route-option">
              <input
                v-model="platformModelId"
                type="radio"
                :value="model.id"
                :disabled="!model.creditPrice"
              />
              <span>
                <strong>{{ model.displayName }}</strong>
                <small>{{ platformRouteLabel(model) }}</small>
                <small>{{ platformPrice(model) }}</small>
              </span>
              <em v-if="model.creditPrice">计费</em>
            </label>
          </div>
          <div v-else class="route-empty">
            <Cloud :size="24" />
            <strong>平台暂未开放{{ serviceLabel }}模型</strong>
            <span>平台管理员需要先启用连接和模型。</span>
          </div>
        </template>
        <div v-if="sourceType === 'PLATFORM' && selectedPlatform?.creditPrice" class="credit-quote">
          <template v-if="quoteLoading">
            <span>正在计算本次预计消耗...</span>
          </template>
          <template v-else-if="quote">
            <span>本次预计</span
            ><strong
              >{{ totalEstimatedPoints ?? quote.estimatedPoints }} 点<span
                v-if="quoteCount > 1"
                class="quote-batch-hint"
                >（{{ quote.estimatedPoints }}×{{ quoteCount }}）</span
              ><span v-else-if="quoteItemCount > 1" class="quote-batch-hint"
                >（{{ quoteItemCount }} 项合计）</span
              ></strong
            >
            <span>当前可用</span><strong>{{ credits.wallet?.availablePoints ?? '--' }} 点</strong>
            <span>生成后约剩</span><strong>{{ remainingPoints ?? '--' }} 点</strong>
          </template>
          <span v-else>{{ quoteError || '提交时由服务端计算并冻结额度' }}</span>
        </div>
        <p
          v-if="
            totalEstimatedPoints != null &&
            credits.wallet &&
            totalEstimatedPoints > credits.wallet.availablePoints
          "
          class="form-error"
        >
          平台额度不足，还需
          {{ totalEstimatedPoints - credits.wallet.availablePoints }} 点。可切换到“我的
          API”，不会消耗平台额度。
        </p>
        <p v-if="error || executionError" class="form-error">{{ executionError || error }}</p>
      </div>

      <footer v-if="!cloudLoginRequired">
        <span>{{
          sourceType === 'LOCAL'
            ? '我的 API 使用本机密钥，平台额度消耗为 0。'
            : `平台任务创建时冻结额度，失败自动返还。可用 ${credits.wallet?.availablePoints ?? '--'} 点。`
        }}</span>
        <div>
          <button class="button" type="button" @click="emit('close')">取消</button>
          <button class="button primary" type="button" :disabled="!canSubmit" @click="submit">
            <Sparkles :size="16" />{{ submitting ? '创建中...' : submitLabel || '开始生成' }}
          </button>
        </div>
      </footer>
    </section>
  </div>
</template>
