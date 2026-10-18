<script lang="ts">
export default { name: 'chat' }
</script>
<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch, onActivated, onDeactivated, onBeforeUnmount } from 'vue'
import {
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  Copy,
  ImagePlus,
  LoaderCircle,
  MessageSquarePlus,
  MessagesSquare,
  SendHorizontal,
  Sparkles,
  Trash2,
  X,
} from 'lucide-vue-next'
import StudioShell from '../layouts/StudioShell.vue'
import {
  chatApi,
  type ChatMessage,
  type ChatSession,
} from '../api/chat'
import {
  platformModelCatalogApi,
  platformModelOptionLabel,
  type PlatformModelCatalogItem,
} from '../api/model-catalog'
import { getStoredToken } from '../api/client'
import type { LocalAiConnection } from '../desktop/types'
import { router } from '../router'
import { useCreditStore } from '../stores/credits'
import { useChatStore } from '../stores/chat'
import { useDesktopStore } from '../stores/desktop'

type ChatModelOption = {
  id: string
  sourceType: 'LOCAL' | 'PLATFORM'
  label: string
  disabled: boolean
  localConnection?: LocalAiConnection
  platformModel?: PlatformModelCatalogItem
}

const credits = useCreditStore()
const chatStore = useChatStore()
const desktop = useDesktopStore()
const sessions = ref<ChatSession[]>([])
const messages = ref<ChatMessage[]>([])
const activeSessionId = ref('')
const models = ref<PlatformModelCatalogItem[]>([])
const modelOptions = ref<ChatModelOption[]>([])
const selectedModelId = ref('')
const draft = ref('')
const pendingImageDataUrl = ref('')
const pendingImageName = ref('')
const sessionPanelCollapsed = ref(true)
const loadingSessions = ref(false)
const loadingMessages = ref(false)
const sending = computed(() =>
  Boolean(activeSessionId.value && chatStore.isSendingMessage(activeSessionId.value)),
)
const error = ref('')
const notice = ref('')
const messagePane = ref<HTMLElement | null>(null)
const savedScrollTop = ref<number | null>(null)
const shouldStickToBottom = ref(true)
let scrollSaveTimer: ReturnType<typeof setTimeout> | null = null

function isNearBottom(el: HTMLElement, threshold = 80) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold
}

function rememberScroll() {
  const el = messagePane.value
  if (!el) return
  savedScrollTop.value = el.scrollTop
  shouldStickToBottom.value = isNearBottom(el)
}

function onMessagePaneScroll() {
  if (scrollSaveTimer) clearTimeout(scrollSaveTimer)
  scrollSaveTimer = setTimeout(() => rememberScroll(), 50)
}

async function restoreScroll() {
  await nextTick()
  const el = messagePane.value
  if (!el) return
  if (shouldStickToBottom.value || savedScrollTop.value == null) {
    el.scrollTop = el.scrollHeight
  } else {
    el.scrollTop = savedScrollTop.value
  }
}
const imageInput = ref<HTMLInputElement | null>(null)

const activeSession = computed(() =>
  sessions.value.find((item) => item.id === activeSessionId.value) || null,
)
const selectedModel = computed(() =>
  modelOptions.value.find((item) => item.id === selectedModelId.value) || null,
)
const selectedRoute = computed(() => selectedModel.value)
const routeMatchesSession = computed(() => {
  if (!activeSession.value || !selectedRoute.value) return true
  const localSession = Boolean(activeSession.value.localConnectionId)
  return localSession === (selectedRoute.value.sourceType === 'LOCAL')
})
const canSend = computed(
  () =>
    Boolean(
      activeSessionId.value &&
        selectedModelId.value &&
        selectedModel.value &&
        !selectedModel.value.disabled &&
        routeMatchesSession.value &&
        !sending.value &&
        (draft.value.trim() || pendingImageDataUrl.value),
    ),
)

const creatingProject = computed(() =>
  Boolean(activeSessionId.value && chatStore.isCreatingProject(activeSessionId.value)),
)


watch(
  () => (activeSessionId.value ? chatStore.messageTask(activeSessionId.value) : null),
  (task) => {
    if (!activeSessionId.value) return
    if (!task) {
      // 任务已被消费时，清掉残留“生成中...”
      if (messages.value.some((item) => item.content === '生成中...')) {
        messages.value = stripPendingBubbles(messages.value)
      }
      return
    }
    applyMessageTask(activeSessionId.value)
  },
  { deep: true, immediate: true },
)

watch(
  () => (activeSessionId.value ? chatStore.projectTask(activeSessionId.value) : null),
  (task) => {
    if (!task || !activeSessionId.value) return
    if (task.status === 'succeeded' && task.projectId) {
      notice.value = `已创建项目“${task.projectTitle || ''}”`
      error.value = ''
      const index = sessions.value.findIndex((item) => item.id === activeSessionId.value)
      if (index >= 0) {
        sessions.value[index] = {
          ...sessions.value[index],
          projectId: task.projectId,
        }
      }
      const consumed = chatStore.consumeSucceededTask(activeSessionId.value)
      if (consumed?.projectId) {
        void router.push({
          name: 'workspace',
          params: { projectId: consumed.projectId },
          query: { tab: 'script' },
        })
      }
    } else if (task.status === 'failed') {
      error.value = task.error || '创建剧本项目失败'
    } else if (task.status === 'running') {
      notice.value = '正在后台生成剧本项目，切换页面不会中断'
    }
  },
  { deep: true, immediate: true },
)

onMounted(async () => {
  await loadModels()
  await Promise.all([
    loadSessions(),
    getStoredToken() ? credits.load() : Promise.resolve(),
  ])
})

onActivated(() => {
  if (activeSessionId.value) {
    applyMessageTask(activeSessionId.value)
    if (!chatStore.isSendingMessage(activeSessionId.value)) {
      // 已完成时再清一次残留生成中
      messages.value = stripPendingBubbles(messages.value)
      void restoreScroll()
    } else {
      shouldStickToBottom.value = true
      void scrollToBottom(true)
    }
  } else {
    void restoreScroll()
  }
})

onDeactivated(() => {
  rememberScroll()
})

onBeforeUnmount(() => {
  rememberScroll()
  if (scrollSaveTimer) clearTimeout(scrollSaveTimer)
})

watch(activeSessionId, (sessionId) => {
  if (sessionId) void loadSessionDetail(sessionId)
  else messages.value = []
})

async function loadModels() {
  await desktop.loadLocalAiConnections()
  const localOptions: ChatModelOption[] = desktop.localAiConnections
    .filter((item) => item.serviceType === 'TEXT' && item.enabled)
    .sort((left, right) => Number(right.defaultProvider) - Number(left.defaultProvider))
    .map((connection) => ({
      id: `local:${connection.id}`,
      sourceType: 'LOCAL',
      label: `${connection.displayName} · ${connection.modelName} · 本地不扣点`,
      disabled: false,
      localConnection: connection,
    }))
  models.value = getStoredToken()
    ? await platformModelCatalogApi.list('TEXT').catch(() => [] as PlatformModelCatalogItem[])
    : []
  const platformOptions: ChatModelOption[] = models.value.map((model) => ({
    id: `platform:${model.id}`,
    sourceType: 'PLATFORM',
    label: platformModelOptionLabel(model),
    disabled: !model.creditPrice,
    platformModel: model,
  }))
  modelOptions.value = [...localOptions, ...platformOptions]
  selectedModelId.value = visibleModelId(selectedModelId.value)
  if (!modelOptions.value.length) {
    error.value = '还没有可用的文本模型，请先在设置中配置“我的 API”'
  }
}

function visibleModelId(preferredId?: string | null) {
  if (preferredId && modelOptions.value.some((item) => item.id === preferredId && !item.disabled)) {
    return preferredId
  }
  return modelOptions.value.find((item) => !item.disabled)?.id || ''
}

function modelIdForSession(session: ChatSession) {
  if (session.localConnectionId) return visibleModelId(`local:${session.localConnectionId}`)
  if (session.platformModelId) return visibleModelId(`platform:${session.platformModelId}`)
  return visibleModelId(selectedModelId.value)
}

async function loadSessions() {
  loadingSessions.value = true
  error.value = ''
  try {
    sessions.value = await chatApi.listSessions()
    if (!activeSessionId.value && sessions.value.length) {
      activeSessionId.value = sessions.value[0].id
      selectedModelId.value = modelIdForSession(sessions.value[0])
    }
  } catch (cause) {
    sessions.value = []
    error.value = cause instanceof Error ? cause.message : '聊天列表加载失败'
  } finally {
    loadingSessions.value = false
  }
}

async function loadSessionDetail(sessionId: string) {
  loadingMessages.value = true
  error.value = ''
  try {
    const detail = await chatApi.getSession(sessionId)
    messages.value = detail.messages
    applyMessageTask(sessionId)
    if (!chatStore.isSendingMessage(sessionId)) {
      messages.value = stripPendingBubbles(messages.value)
    }
    const index = sessions.value.findIndex((item) => item.id === detail.session.id)
    if (index >= 0) sessions.value[index] = detail.session
    selectedModelId.value = modelIdForSession(detail.session)
    if (savedScrollTop.value == null || shouldStickToBottom.value) {
      shouldStickToBottom.value = true
      await scrollToBottom(true)
    } else {
      await restoreScroll()
    }
  } catch (cause) {
    messages.value = []
    error.value = cause instanceof Error ? cause.message : '聊天记录加载失败'
  } finally {
    loadingMessages.value = false
  }
}

async function createSession() {
  error.value = ''
  notice.value = ''
  try {
    const route = selectedRoute.value
    if (!route) throw new Error('请先选择文本模型')
    const session = await chatApi.createSession({
      title: '新的创作聊天',
      platformModelId: route.platformModel?.id,
      localConnectionId: route.localConnection?.id,
    })
    sessions.value = [session, ...sessions.value]
    activeSessionId.value = session.id
    messages.value = []
    draft.value = ''
    clearPendingImage()
    sessionPanelCollapsed.value = false
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '创建聊天失败'
  }
}

async function removeSession(session: ChatSession) {
  if (!window.confirm(`确定删除聊天“${session.title}”吗？`)) return
  error.value = ''
  try {
    await chatApi.deleteSession(session.id)
    sessions.value = sessions.value.filter((item) => item.id !== session.id)
    if (activeSessionId.value === session.id) {
      activeSessionId.value = sessions.value[0]?.id || ''
      if (!activeSessionId.value) messages.value = []
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '删除聊天失败'
  }
}

const copiedMessageId = ref('')
let copiedTimer: ReturnType<typeof setTimeout> | null = null

async function copyAssistantMessage(message: ChatMessage) {
  const text = (message.content || '').trim()
  if (!text || text === '生成中...') return
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
    } else {
      const area = document.createElement('textarea')
      area.value = text
      area.setAttribute('readonly', 'true')
      area.style.position = 'fixed'
      area.style.left = '-9999px'
      document.body.appendChild(area)
      area.select()
      document.execCommand('copy')
      document.body.removeChild(area)
    }
    copiedMessageId.value = message.id
    notice.value = '已复制 AI 回复'
    if (copiedTimer) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => {
      if (copiedMessageId.value === message.id) copiedMessageId.value = ''
    }, 1800)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '复制失败'
  }
}

async function sendMessage() {
  if (!routeMatchesSession.value) {
    error.value = '平台模型和我的 API 不能在同一会话中混用，请先用当前模型新建会话'
    return
  }
  if (!canSend.value || !activeSessionId.value) return
  if (chatStore.isSendingMessage(activeSessionId.value)) return
  const content = draft.value.trim()
  const imageDataUrl = pendingImageDataUrl.value || undefined
  const sessionId = activeSessionId.value
  error.value = ''
  notice.value = ''
  draft.value = ''
  clearPendingImage()

  const task = chatStore.sendMessageInBackground(sessionId, {
    content,
    platformModelId: selectedRoute.value?.platformModel?.id,
    localConnectionId: selectedRoute.value?.localConnection?.id,
    imageDataUrl,
    modelName: selectedModel.value?.label,
  })

  // 立即展示用户消息 + 生成中（即使切走页面，任务仍在 store 中）
  messages.value = [...messages.value, task.optimisticUser, task.pendingAssistant]
  notice.value = 'AI 正在回复，切换菜单不会中断'
  shouldStickToBottom.value = true
  await scrollToBottom(true)
}

function stripPendingBubbles(list: ChatMessage[], task?: { optimisticUser?: ChatMessage; pendingAssistant?: ChatMessage } | null) {
  return list.filter((item) => {
    if (task?.optimisticUser && item.id === task.optimisticUser.id) return false
    if (task?.pendingAssistant && item.id === task.pendingAssistant.id) return false
    if (String(item.id).startsWith('temp-') || String(item.id).startsWith('local-')) return false
    if (item.role === 'assistant' && item.content === '生成中...') return false
    return true
  })
}

function applyMessageTask(sessionId: string) {
  if (!sessionId) return
  // 仅同步当前会话
  if (activeSessionId.value && activeSessionId.value !== sessionId) return
  const task = chatStore.messageTask(sessionId)
  if (!task) return

  if (task.status === 'running') {
    const hasPending = messages.value.some((item) => item.id === task.pendingAssistant.id)
    if (!hasPending) {
      const base = stripPendingBubbles(messages.value, task)
      messages.value = [...base, task.optimisticUser, task.pendingAssistant]
      notice.value = 'AI 正在回复，切换菜单不会中断'
      void scrollToBottom(true)
    }
    return
  }

  if (task.status === 'succeeded' && task.result) {
    const result = task.result
    const base = stripPendingBubbles(messages.value, task)
    const hasUser = base.some((item) => item.id === result.userMessage.id)
    const hasAssistant = base.some((item) => item.id === result.assistantMessage.id)
    const next = [...base]
    if (!hasUser) next.push(result.userMessage)
    if (!hasAssistant) next.push(result.assistantMessage)
    // 按时间排序，避免插入顺序错乱
    next.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    messages.value = next
    const index = sessions.value.findIndex((item) => item.id === sessionId)
    if (index >= 0) sessions.value[index] = result.session
    notice.value =
      result.chargedPoints > 0 ? `已回复，消耗 ${result.chargedPoints} 点` : '已回复'
    error.value = ''
    chatStore.consumeMessageTask(sessionId)
    shouldStickToBottom.value = true
    void scrollToBottom(true)
    return
  }

  if (task.status === 'failed') {
    messages.value = stripPendingBubbles(messages.value, task)
    error.value = task.error || '发送失败'
    notice.value = ''
    chatStore.consumeMessageTask(sessionId)
  }
}

function createProjectFromChat() {
  if (!activeSessionId.value) return
  if (chatStore.isCreatingProject(activeSessionId.value)) return
  if (!selectedModelId.value) {
    error.value = '请先选择文本模型'
    return
  }
  if (!routeMatchesSession.value) {
    error.value = '当前会话与所选模型来源不同，请切回该会话原来源的模型'
    return
  }
  if (!messages.value.length) {
    error.value = '请先和 AI 聊几轮创意，再生成剧本项目'
    return
  }
  error.value = ''
  notice.value = '正在后台生成剧本项目，切换页面不会中断'
  chatStore.createProjectInBackground(activeSessionId.value, {
    platformModelId: selectedRoute.value?.platformModel?.id,
    localConnectionId: selectedRoute.value?.localConnection?.id,
  })
}

function triggerImagePick() {
  imageInput.value?.click()
}

async function onImageSelected(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (!file.type.startsWith('image/')) {
    error.value = '请选择 PNG / JPG / WEBP 图片'
    return
  }
  if (file.size > 2 * 1024 * 1024) {
    error.value = '图片大小不能超过 2MB'
    return
  }
  try {
    pendingImageDataUrl.value = await readFileAsDataUrl(file)
    pendingImageName.value = file.name
    error.value = ''
  } catch {
    error.value = '图片读取失败'
  }
}

function clearPendingImage() {
  pendingImageDataUrl.value = ''
  pendingImageName.value = ''
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

async function scrollToBottom(force = false) {
  await nextTick()
  const el = messagePane.value
  if (!el) return
  if (force || shouldStickToBottom.value) {
    el.scrollTop = el.scrollHeight
    savedScrollTop.value = el.scrollTop
    shouldStickToBottom.value = true
  }
}

function formatTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString('zh-CN', { hour12: false })
}

function onComposerKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    void sendMessage()
  }
}
</script>

<template>
  <StudioShell>
    <section class="chat-page" :class="{ 'session-collapsed': sessionPanelCollapsed }">
      <aside class="chat-session-panel">
        <header class="chat-panel-header">
          <div>
            <h1>创作聊天</h1>
            <p>和 AI 讨论创意，一键生成剧本项目</p>
          </div>
          <div class="chat-panel-header-actions">
            <button class="button primary" type="button" @click="createSession">
              <MessageSquarePlus :size="16" /><span>新建</span>
            </button>
            <button
              class="icon-button"
              type="button"
              :title="sessionPanelCollapsed ? '展开会话列表' : '收起会话列表'"
              @click="sessionPanelCollapsed = !sessionPanelCollapsed"
            >
              <ChevronLeft v-if="!sessionPanelCollapsed" :size="16" />
              <ChevronRight v-else :size="16" />
            </button>
          </div>
        </header>

        <div v-if="!sessionPanelCollapsed" class="chat-session-body">
          <div v-if="loadingSessions" class="chat-empty">正在加载聊天列表...</div>
          <div v-else-if="!sessions.length" class="chat-empty">
            还没有聊天，先新建一个，把你的短剧灵感丢给 AI。
          </div>
          <div v-else class="chat-session-list">
            <button
              v-for="session in sessions"
              :key="session.id"
              type="button"
              class="chat-session-item"
              :class="{ active: session.id === activeSessionId }"
              @click="activeSessionId = session.id"
            >
              <div class="chat-session-main">
                <strong>{{ session.title }}</strong>
                <small>{{ session.lastMessagePreview || '还没有消息' }}</small>
                <span>{{ formatTime(session.updatedAt) }} · {{ session.messageCount }} 条</span>
              </div>
              <button
                class="icon-button compact danger"
                type="button"
                title="删除聊天"
                @click.stop="removeSession(session)"
              >
                <Trash2 :size="14" />
              </button>
            </button>
          </div>
        </div>
        <div v-else class="chat-session-collapsed-hint">
          <button class="chat-rail-label" type="button" @click="sessionPanelCollapsed = false">
            <span>展开会话</span>
          </button>
        </div>
      </aside>

      <section class="chat-main-panel">
        <header class="chat-main-header">
          <div>
            <h2>{{ activeSession?.title || '选择或新建一个聊天' }}</h2>
            <p>
              {{
                activeSession?.projectId
                  ? '该聊天已生成过剧本项目，可继续补充后再重新生成。'
                  : '聊清楚人物、冲突和结局后，点右上角生成剧本项目。'
              }}
            </p>
          </div>
          <div class="chat-main-actions">
            <button
              class="button primary"
              type="button"
              :disabled="!activeSessionId || creatingProject || sending"
              @click="createProjectFromChat"
            >
              <Clapperboard :size="16" />
              {{ creatingProject ? '后台生成中...' : '生成剧本项目' }}
            </button>
          </div>
        </header>

        <p v-if="notice" class="inline-success" role="status">{{ notice }}</p>
        <p v-if="error" class="inline-error" role="alert">{{ error }}</p>

        <div ref="messagePane" class="chat-message-pane" @scroll="onMessagePaneScroll">
          <div v-if="!activeSessionId" class="chat-empty large">
            <MessagesSquare :size="28" />
            <strong>从灵感聊天开始</strong>
            <p>告诉 AI 你想拍什么题材、主角是谁、核心冲突是什么。聊完后一键生成项目和剧本。</p>
          </div>
          <div v-else-if="loadingMessages" class="chat-empty">
            <LoaderCircle :size="18" class="spinning" /> 正在加载消息...
          </div>
          <div v-else-if="!messages.length" class="chat-empty large">
            <Sparkles :size="28" />
            <strong>开始第一句</strong>
            <p>例如：帮我构思一部都市复仇短剧，女主是被公司开除的设计师。</p>
          </div>
          <template v-else>
            <article
              v-for="message in messages"
              :key="message.id"
              class="chat-bubble"
              :class="message.role === 'user' ? 'user' : 'assistant'"
            >
              <header>
                <strong>{{ message.role === 'user' ? '我' : 'AI 助手' }}</strong>
                <small>
                  {{ formatTime(message.createdAt) }}
                  <template v-if="message.modelName"> · {{ message.modelName }}</template>
                  <template v-if="message.chargedPoints"> · 消耗 {{ message.chargedPoints }} 点</template>
                </small>
              </header>
              <img
                v-if="message.imageDataUrl"
                :src="message.imageDataUrl"
                alt="聊天图片"
                class="chat-message-image"
              />
              <pre :class="{ generating: message.content === '生成中...' }">{{ message.content }}</pre>
              <footer
                v-if="message.role === 'assistant' && message.content && message.content !== '生成中...'"
                class="chat-bubble-actions"
              >
                <button
                  class="chat-copy-btn"
                  type="button"
                  :title="copiedMessageId === message.id ? '已复制' : '复制文本'"
                  @click="copyAssistantMessage(message)"
                >
                  <Copy :size="14" />
                  <span>{{ copiedMessageId === message.id ? '已复制' : '复制' }}</span>
                </button>
              </footer>
            </article>
          </template>
          <div v-if="activeSessionId" class="chat-mascot" aria-hidden="true">
            <span class="chat-mascot-head">
              <i></i>
              <i></i>
            </span>
            <span class="chat-mascot-body"></span>
          </div>
        </div>

        <footer class="chat-composer">
          <input
            ref="imageInput"
            class="avatar-file-input"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            @change="onImageSelected"
          />

          <div v-if="pendingImageDataUrl" class="chat-image-preview">
            <img :src="pendingImageDataUrl" alt="待发送图片" />
            <div>
              <strong>{{ pendingImageName || '待发送图片' }}</strong>
              <small>支持 PNG / JPG / WEBP，最大 2MB</small>
            </div>
            <button class="icon-button compact" type="button" title="移除图片" @click="clearPendingImage">
              <X :size="14" />
            </button>
          </div>

          <textarea
            v-model="draft"
            rows="3"
            maxlength="8000"
            placeholder="描述你的短剧灵感、人物、冲突、想要的结局... Enter 发送，Shift+Enter 换行"
            :disabled="!activeSessionId || sending"
            @keydown="onComposerKeydown"
          />

          <div class="chat-composer-actions">
            <div class="chat-composer-left">
              <button
                class="icon-button"
                type="button"
                title="上传图片"
                :disabled="!activeSessionId || sending"
                @click="triggerImagePick"
              >
                <ImagePlus :size="16" />
              </button>
              <label class="chat-model-select">
                <span>模型</span>
                <select v-model="selectedModelId" :disabled="!modelOptions.length || sending">
                  <option disabled value="">请选择文本模型</option>
                  <option
                    v-for="model in modelOptions"
                    :key="model.id"
                    :value="model.id"
                    :disabled="model.disabled"
                  >
                    {{ model.label }}
                  </option>
                </select>
              </label>
              <small v-if="!routeMatchesSession" class="form-error">
                当前会话不能跨平台模型与我的 API 混用，请新建会话。
              </small>
            </div>
            <button class="button primary" type="button" :disabled="!canSend" @click="sendMessage">
              <SendHorizontal :size="16" />
              {{ sending ? '已发送' : '发送' }}
            </button>
          </div>
        </footer>
      </section>
    </section>
  </StudioShell>
</template>
<style scoped>
.chat-bubble pre.generating {
  color: #7c6cff;
  font-style: italic;
}
</style>
