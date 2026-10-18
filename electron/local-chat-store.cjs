const { randomUUID } = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')

const CHAT_FILE = 'local-chats.json'
const MAX_SESSIONS = 200
const MAX_MESSAGES_PER_SESSION = 500
const MAX_FILE_BYTES = 64 * 1024 * 1024
const LOCAL_SESSION_PATTERN = /^local-chat-[A-Za-z0-9-]{8,80}$/

class LocalChatStore {
  constructor({ appDataPath }) {
    if (!path.isAbsolute(appDataPath)) throw new Error('本地聊天目录必须使用绝对路径')
    this.filePath = path.join(appDataPath, CHAT_FILE)
    this.writeQueue = Promise.resolve()
  }

  async list() {
    const state = await this.readState()
    return state.sessions
      .map(publicSession)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  async create(input = {}) {
    return this.withWriteLock(async () => {
      const state = await this.readState()
      const now = new Date().toISOString()
      const session = {
        id: `local-chat-${randomUUID()}`,
        title: optionalText(input.title, 100) || '新的创作聊天',
        status: 'ACTIVE',
        localConnectionId: requiredText(input.localConnectionId, '本地文本模型', 120),
        platformModelId: null,
        projectId: null,
        messages: [],
        createdAt: now,
        updatedAt: now,
      }
      state.sessions.unshift(session)
      if (state.sessions.length > MAX_SESSIONS) {
        state.sessions = state.sessions.slice(0, MAX_SESSIONS)
      }
      await this.writeState(state)
      return publicSession(session)
    })
  }

  async get(sessionId) {
    validateSessionId(sessionId)
    const state = await this.readState()
    const session = state.sessions.find((item) => item.id === sessionId)
    if (!session) throw new Error('本地聊天不存在')
    return { session: publicSession(session), messages: session.messages.map(publicMessage) }
  }

  async delete(sessionId) {
    validateSessionId(sessionId)
    return this.withWriteLock(async () => {
      const state = await this.readState()
      const next = state.sessions.filter((item) => item.id !== sessionId)
      if (next.length === state.sessions.length) throw new Error('本地聊天不存在')
      state.sessions = next
      await this.writeState(state)
    })
  }

  async appendTurn(sessionId, input) {
    validateSessionId(sessionId)
    return this.withWriteLock(async () => {
      const state = await this.readState()
      const session = state.sessions.find((item) => item.id === sessionId)
      if (!session) throw new Error('本地聊天不存在')
      const now = new Date().toISOString()
      const localConnectionId = requiredText(input.localConnectionId, '本地文本模型', 120)
      const userMessage = {
        id: `chat-message-${randomUUID()}`,
        role: 'user',
        content: requiredText(input.content, '聊天内容', 8_000),
        imageDataUrl: normalizeImageDataUrl(input.imageDataUrl),
        platformModelId: null,
        localConnectionId,
        modelName: null,
        chargedPoints: 0,
        createdAt: now,
      }
      const assistantMessage = {
        id: `chat-message-${randomUUID()}`,
        role: 'assistant',
        content: requiredText(input.assistantContent, 'AI 回复', 200_000),
        imageDataUrl: null,
        platformModelId: null,
        localConnectionId,
        modelName: optionalText(input.modelName, 160),
        chargedPoints: 0,
        createdAt: new Date(Date.now() + 1).toISOString(),
      }
      session.localConnectionId = localConnectionId
      session.messages.push(userMessage, assistantMessage)
      if (session.messages.length > MAX_MESSAGES_PER_SESSION) {
        session.messages = session.messages.slice(-MAX_MESSAGES_PER_SESSION)
      }
      session.updatedAt = assistantMessage.createdAt
      await this.writeState(state)
      return {
        session: publicSession(session),
        userMessage: publicMessage(userMessage),
        assistantMessage: publicMessage(assistantMessage),
        chargedPoints: 0,
      }
    })
  }

  async attachProject(sessionId, projectId) {
    validateSessionId(sessionId)
    return this.withWriteLock(async () => {
      const state = await this.readState()
      const session = state.sessions.find((item) => item.id === sessionId)
      if (!session) throw new Error('本地聊天不存在')
      session.projectId = requiredText(projectId, '项目标识', 160)
      session.updatedAt = new Date().toISOString()
      await this.writeState(state)
      return publicSession(session)
    })
  }

  async readState() {
    try {
      const stat = await fs.stat(this.filePath)
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('本地聊天文件无效')
      return normalizeState(JSON.parse(await fs.readFile(this.filePath, 'utf8')))
    } catch (error) {
      if (error?.code === 'ENOENT') return { version: 1, sessions: [] }
      throw error
    }
  }

  async writeState(state) {
    const normalized = normalizeState(state)
    const text = `${JSON.stringify(normalized, null, 2)}\n`
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error('本地聊天记录超过存储上限')
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temporaryPath, text, { encoding: 'utf8', flag: 'wx' })
      await fs.rename(temporaryPath, this.filePath)
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }

  withWriteLock(operation) {
    const current = this.writeQueue.catch(() => undefined).then(operation)
    this.writeQueue = current
    return current
  }
}

function normalizeState(input) {
  if (!input || input.version !== 1 || !Array.isArray(input.sessions)) {
    throw new Error('本地聊天文件格式无效')
  }
  if (input.sessions.length > MAX_SESSIONS) throw new Error('本地聊天数量超过限制')
  return { version: 1, sessions: input.sessions.map(normalizeSession) }
}

function normalizeSession(session) {
  validateSessionId(session?.id)
  if (!Array.isArray(session.messages) || session.messages.length > MAX_MESSAGES_PER_SESSION) {
    throw new Error('本地聊天消息数量无效')
  }
  return {
    ...session,
    title: requiredText(session.title, '聊天标题', 100),
    localConnectionId: requiredText(session.localConnectionId, '本地文本模型', 120),
    messages: session.messages.map(normalizeMessage),
  }
}

function normalizeMessage(message) {
  if (!message || !['user', 'assistant'].includes(message.role)) throw new Error('本地聊天消息无效')
  return {
    ...message,
    content: requiredText(message.content, '聊天消息', 200_000),
    imageDataUrl: normalizeImageDataUrl(message.imageDataUrl),
    chargedPoints: 0,
  }
}

function publicSession(session) {
  const lastMessage = session.messages[session.messages.length - 1]
  return {
    id: session.id,
    title: session.title,
    status: session.status,
    localConnectionId: session.localConnectionId,
    platformModelId: null,
    projectId: session.projectId,
    lastMessagePreview: lastMessage?.content?.replace(/\s+/g, ' ').slice(0, 80) || null,
    messageCount: session.messages.length,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  }
}

function publicMessage(message) {
  return { ...message }
}

function normalizeImageDataUrl(value) {
  if (value == null || value === '') return null
  if (typeof value !== 'string' || value.length > 3_000_000) throw new Error('聊天图片大小无效')
  if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value)) {
    throw new Error('聊天图片格式无效')
  }
  return value
}

function validateSessionId(value) {
  if (typeof value !== 'string' || !LOCAL_SESSION_PATTERN.test(value)) throw new Error('本地聊天标识无效')
}

function requiredText(value, label, maximum) {
  const text = optionalText(value, maximum)
  if (!text) throw new Error(`${label}不能为空`)
  return text
}

function optionalText(value, maximum) {
  if (value == null) return null
  const text = String(value).trim()
  if (!text) return null
  if (text.length > maximum) throw new Error('文本内容过长')
  return text
}

module.exports = { LocalChatStore }
