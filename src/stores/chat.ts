import { defineStore } from 'pinia'
import {
  chatApi,
  type ChatCreateProjectResult,
  type ChatMessage,
  type ChatTurnResult,
} from '../api/chat'
import { useCreditStore } from './credits'

export type ChatProjectTaskStatus = 'running' | 'succeeded' | 'failed'
export type ChatMessageTaskStatus = 'running' | 'succeeded' | 'failed'

export interface ChatProjectTask {
  sessionId: string
  status: ChatProjectTaskStatus
  startedAt: number
  projectId?: string
  projectTitle?: string
  episodeId?: string
  chargedPoints?: number
  error?: string
}

export interface ChatMessageTask {
  sessionId: string
  status: ChatMessageTaskStatus
  startedAt: number
  optimisticUser: ChatMessage
  pendingAssistant: ChatMessage
  result?: ChatTurnResult
  error?: string
}

export const useChatStore = defineStore('chat', {
  state: () => ({
    projectTasks: {} as Record<string, ChatProjectTask>,
    messageTasks: {} as Record<string, ChatMessageTask>,
    lastNotice: '' as string,
    lastError: '' as string,
  }),
  getters: {
    isCreatingProject:
      (state) =>
      (sessionId: string): boolean =>
        state.projectTasks[sessionId]?.status === 'running',
    projectTask:
      (state) =>
      (sessionId: string): ChatProjectTask | null =>
        state.projectTasks[sessionId] || null,
    isSendingMessage:
      (state) =>
      (sessionId: string): boolean =>
        state.messageTasks[sessionId]?.status === 'running',
    messageTask:
      (state) =>
      (sessionId: string): ChatMessageTask | null =>
        state.messageTasks[sessionId] || null,
  },
  actions: {
    clearFlash() {
      this.lastNotice = ''
      this.lastError = ''
    },

    /**
     * 后台发送聊天消息：切换菜单不会中断请求。
     * 页面可随时根据 messageTasks 恢复“生成中...”状态。
     */
    sendMessageInBackground(
      sessionId: string,
      input: {
        content?: string
        platformModelId?: string
        localConnectionId?: string
        imageDataUrl?: string
        modelName?: string
      },
    ) {
      const existing = this.messageTasks[sessionId]
      if (existing?.status === 'running') {
        return existing
      }

      const now = new Date().toISOString()
      const content =
        (input.content || '').trim() ||
        (input.imageDataUrl ? '请结合这张图片，帮我继续完善短剧创意。' : '')
      const optimisticUser: ChatMessage = {
        id: `temp-user-${Date.now()}`,
        role: 'user',
        content,
        imageDataUrl: input.imageDataUrl || null,
        platformModelId: null,
        modelName: null,
        chargedPoints: 0,
        createdAt: now,
      }
      const pendingAssistant: ChatMessage = {
        id: `temp-assistant-${Date.now()}`,
        role: 'assistant',
        content: '生成中...',
        imageDataUrl: null,
        platformModelId: input.platformModelId || null,
        localConnectionId: input.localConnectionId || null,
        modelName: input.modelName || null,
        chargedPoints: 0,
        createdAt: now,
      }

      const task: ChatMessageTask = {
        sessionId,
        status: 'running',
        startedAt: Date.now(),
        optimisticUser,
        pendingAssistant,
      }
      this.messageTasks = { ...this.messageTasks, [sessionId]: task }
      this.lastError = ''
      this.lastNotice = 'AI 正在后台回复，切换菜单不会中断'

      void this.runSendMessage(sessionId, {
        content: input.content,
        platformModelId: input.platformModelId,
        localConnectionId: input.localConnectionId,
        imageDataUrl: input.imageDataUrl,
      })
      return task
    },

    async runSendMessage(
      sessionId: string,
      input: {
        content?: string
        platformModelId?: string
        localConnectionId?: string
        imageDataUrl?: string
      },
    ) {
      try {
        const result = await chatApi.sendMessage(sessionId, input)
        const prev = this.messageTasks[sessionId]
        this.messageTasks = {
          ...this.messageTasks,
          [sessionId]: {
            sessionId,
            status: 'succeeded',
            startedAt: prev?.startedAt || Date.now(),
            optimisticUser: prev?.optimisticUser || result.userMessage,
            pendingAssistant: prev?.pendingAssistant || result.assistantMessage,
            result,
          },
        }
        this.lastNotice = 'AI 回复已完成'
        this.lastError = ''
        if (result.chargedPoints > 0) {
          void useCreditStore().load()
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : '发送失败'
        const prev = this.messageTasks[sessionId]
        if (!prev) return
        this.messageTasks = {
          ...this.messageTasks,
          [sessionId]: {
            ...prev,
            status: 'failed',
            error: message,
          },
        }
        this.lastError = message
      }
    },

    /** 页面已展示成功结果后清理任务，避免重复插入 */
    consumeMessageTask(sessionId: string) {
      const task = this.messageTasks[sessionId]
      if (!task || task.status === 'running') return null
      const copy = { ...task }
      const next = { ...this.messageTasks }
      delete next[sessionId]
      this.messageTasks = next
      return copy
    },

    createProjectInBackground(
      sessionId: string,
      input: { title?: string; platformModelId?: string; localConnectionId?: string } = {},
    ) {
      const existing = this.projectTasks[sessionId]
      if (existing?.status === 'running') return existing

      const task: ChatProjectTask = {
        sessionId,
        status: 'running',
        startedAt: Date.now(),
      }
      this.projectTasks = { ...this.projectTasks, [sessionId]: task }
      this.lastError = ''
      this.lastNotice = '正在后台生成剧本项目，可继续浏览其他页面'

      void this.runCreateProject(sessionId, input)
      return task
    },

    async runCreateProject(
      sessionId: string,
      input: { title?: string; platformModelId?: string; localConnectionId?: string },
    ) {
      try {
        const result: ChatCreateProjectResult = await chatApi.createProject(sessionId, input)
        this.projectTasks = {
          ...this.projectTasks,
          [sessionId]: {
            sessionId,
            status: 'succeeded',
            startedAt: this.projectTasks[sessionId]?.startedAt || Date.now(),
            projectId: result.projectId,
            projectTitle: result.projectTitle,
            episodeId: result.episodeId,
            chargedPoints: result.chargedPoints,
          },
        }
        this.lastNotice = `已创建项目“${result.projectTitle}”`
        this.lastError = ''
        if (result.chargedPoints > 0) void useCreditStore().load()
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : '创建剧本项目失败'
        this.projectTasks = {
          ...this.projectTasks,
          [sessionId]: {
            sessionId,
            status: 'failed',
            startedAt: this.projectTasks[sessionId]?.startedAt || Date.now(),
            error: message,
          },
        }
        this.lastError = message
      }
    },

    consumeSucceededTask(sessionId: string) {
      const task = this.projectTasks[sessionId]
      if (!task || task.status !== 'succeeded') return null
      const copy = { ...task }
      const next = { ...this.projectTasks }
      delete next[sessionId]
      this.projectTasks = next
      return copy
    },
  },
})
