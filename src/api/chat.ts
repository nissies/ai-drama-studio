import { getStoredToken, request } from './client'

export interface ChatSession {
  id: string
  title: string
  status: string
  platformModelId?: string | null
  localConnectionId?: string | null
  projectId?: string | null
  lastMessagePreview?: string | null
  messageCount: number
  createdAt: string
  updatedAt: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | string
  content: string
  imageDataUrl?: string | null
  platformModelId?: string | null
  localConnectionId?: string | null
  modelName?: string | null
  chargedPoints: number
  createdAt: string
}

export interface ChatSessionDetail {
  session: ChatSession
  messages: ChatMessage[]
}

export interface ChatTurnResult {
  session: ChatSession
  userMessage: ChatMessage
  assistantMessage: ChatMessage
  chargedPoints: number
}

export interface ChatCreateProjectResult {
  session: ChatSession
  projectId: string
  projectTitle: string
  episodeId: string
  chargedPoints: number
}

export const chatApi = {
  listSessions: async () => {
    const desktop = globalThis.window?.aiDramaDesktop
    const local = desktop ? await desktop.listLocalChatSessions() : []
    const cloud = getStoredToken()
      ? await request<ChatSession[]>('/chat/sessions').catch((caught) => {
          if (!desktop) throw caught
          return []
        })
      : []
    return [...local, ...cloud].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  },
  createSession: (
    input: { title?: string; platformModelId?: string; localConnectionId?: string } = {},
  ) => {
    if (input.localConnectionId) {
      return requiredDesktop().createLocalChatSession({
        title: input.title,
        localConnectionId: input.localConnectionId,
      })
    }
    if (!getStoredToken()) throw new Error('使用平台聊天前请先登录，或选择我的 API')
    return request<ChatSession>('/chat/sessions', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },
  getSession: (sessionId: string) =>
    isLocalChatId(sessionId)
      ? requiredDesktop().getLocalChatSession(sessionId)
      : request<ChatSessionDetail>(`/chat/sessions/${encodeURIComponent(sessionId)}`),
  deleteSession: (sessionId: string) =>
    isLocalChatId(sessionId)
      ? requiredDesktop().deleteLocalChatSession(sessionId)
      : request<void>(`/chat/sessions/${encodeURIComponent(sessionId)}`, {
          method: 'DELETE',
        }),
  sendMessage: (
    sessionId: string,
    input: {
      content?: string
      platformModelId?: string
      localConnectionId?: string
      imageDataUrl?: string
    },
  ) => isLocalChatId(sessionId)
    ? sendLocalMessage(sessionId, input)
    : request<ChatTurnResult>(
        `/chat/sessions/${encodeURIComponent(sessionId)}/messages`,
        {
          method: 'POST',
          body: JSON.stringify(input),
        },
      ),
  createProject: (
    sessionId: string,
    input: { title?: string; platformModelId?: string; localConnectionId?: string } = {},
  ) => isLocalChatId(sessionId)
    ? createLocalProjectFromChat(sessionId, input)
    : request<ChatCreateProjectResult>(
        `/chat/sessions/${encodeURIComponent(sessionId)}/create-project`,
        {
          method: 'POST',
          body: JSON.stringify(input),
        },
      ),
}

function isLocalChatId(sessionId: string) {
  return sessionId.startsWith('local-chat-')
}

function requiredDesktop() {
  const desktop = globalThis.window?.aiDramaDesktop
  if (!desktop) throw new Error('请在 Windows 客户端中使用本地聊天')
  return desktop
}

async function sendLocalMessage(
  sessionId: string,
  input: { content?: string; localConnectionId?: string; imageDataUrl?: string },
): Promise<ChatTurnResult> {
  const desktop = requiredDesktop()
  const detail = await desktop.getLocalChatSession(sessionId)
  const connectionId = input.localConnectionId || detail.session.localConnectionId
  if (!connectionId) throw new Error('请选择本地文本模型')
  const content = (input.content || '').trim() || (input.imageDataUrl ? '请分析这张图片并继续完善短剧创意。' : '')
  if (!content) throw new Error('请输入聊天内容')
  const result = await desktop.generateLocalText({
    connectionId,
    systemPrompt:
      '你是专业的短剧编剧与导演助理。围绕用户的创作目标给出具体、可执行的建议；主动保持人物、冲突、世界观和前文一致；不要声称调用了未提供的工具。',
    userPrompt: buildConversationPrompt(detail.messages, content),
    imageDataUrl: input.imageDataUrl,
    parameters: { temperature: 0.7 },
  })
  return desktop.appendLocalChatTurn(sessionId, {
    content,
    imageDataUrl: input.imageDataUrl,
    assistantContent: result.text,
    localConnectionId: connectionId,
    modelName: result.modelName,
  })
}

async function createLocalProjectFromChat(
  sessionId: string,
  input: { title?: string; localConnectionId?: string },
): Promise<ChatCreateProjectResult> {
  const desktop = requiredDesktop()
  const detail = await desktop.getLocalChatSession(sessionId)
  if (!detail.messages.length) throw new Error('请先和 AI 聊几轮创意，再生成剧本项目')
  const connectionId = input.localConnectionId || detail.session.localConnectionId
  if (!connectionId) throw new Error('请选择本地文本模型')
  const result = await desktop.generateLocalText({
    connectionId,
    systemPrompt:
      '你是短剧总编剧。把创作会话整理为可直接制作的项目。只输出 JSON，不要 Markdown。JSON 必须包含 projectTitle、synopsis、episodeTitle、scriptText、targetDurationSec。scriptText 使用标准剧本格式，包含场次、动作和对白。',
    userPrompt: `请根据以下创作会话生成第一集完整剧本：\n\n${conversationTranscript(detail.messages)}`,
    parameters: { temperature: 0.5, max_tokens: 12_000 },
    timeoutMillis: 300_000,
  })
  const generated = parseProjectDraft(result.text)
  const projectTitle = cleanTitle(input.title || generated.projectTitle || detail.session.title)
  const project = await desktop.createLocalProject({
    title: projectTitle,
    description: generated.synopsis,
    aspectRatio: '9:16',
  })
  try {
    const data = await desktop.getLocalProjectData(project.id)
    const episodeId = globalThis.crypto.randomUUID()
    const now = new Date().toISOString()
    await desktop.saveLocalProjectData(project.id, {
      ...data,
      episodes: [
        {
          id: episodeId,
          projectId: project.id,
          episodeNo: 1,
          title: generated.episodeTitle || '第一集',
          synopsis: generated.synopsis,
          scriptText: generated.scriptText,
          targetDurationSec: generated.targetDurationSec,
          status: 'DRAFT',
          version: 0,
          updatedAt: now,
        },
      ],
    })
    await desktop.attachLocalChatProject(sessionId, project.id)
    return {
      session: { ...detail.session, projectId: project.id, updatedAt: now },
      projectId: project.id,
      projectTitle,
      episodeId,
      chargedPoints: 0,
    }
  } catch (error) {
    await desktop.deleteLocalProject(project.id).catch(() => undefined)
    throw error
  }
}

function buildConversationPrompt(messages: ChatMessage[], content: string) {
  const transcript = conversationTranscript(messages)
  return transcript
    ? `已有会话：\n${transcript}\n\n用户的新消息：\n${content}`
    : content
}

function conversationTranscript(messages: ChatMessage[]) {
  let remaining = 50_000
  const lines: string[] = []
  for (const message of messages.slice(-30).reverse()) {
    const text = String(message.content || '').trim().slice(0, remaining)
    if (!text) continue
    lines.unshift(`${message.role === 'assistant' ? 'AI' : '用户'}：${text}`)
    remaining -= text.length
    if (remaining <= 0) break
  }
  return lines.join('\n\n')
}

function parseProjectDraft(text: string) {
  const fallback = {
    projectTitle: '未命名短剧',
    synopsis: text.slice(0, 500),
    episodeTitle: '第一集',
    scriptText: text,
    targetDurationSec: 90,
  }
  const candidate = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>
    const scriptText = String(parsed.scriptText || '').trim()
    if (!scriptText) return fallback
    const duration = Number(parsed.targetDurationSec)
    return {
      projectTitle: String(parsed.projectTitle || fallback.projectTitle).trim(),
      synopsis: String(parsed.synopsis || '').trim().slice(0, 5_000),
      episodeTitle: String(parsed.episodeTitle || fallback.episodeTitle).trim().slice(0, 100),
      scriptText: scriptText.slice(0, 500_000),
      targetDurationSec: Number.isFinite(duration) ? Math.max(15, Math.min(3_600, Math.round(duration))) : 90,
    }
  } catch {
    return fallback
  }
}

function cleanTitle(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || '未命名短剧'
}
