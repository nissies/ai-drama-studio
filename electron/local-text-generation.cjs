const { URL } = require('node:url')

const MAX_PROMPT_LENGTH = 400_000
const MAX_ERROR_MESSAGE_LENGTH = 500
const DEFAULT_TIMEOUT_MILLIS = 120_000

class LocalTextGenerationService {
  constructor({ connections, fetchImpl = globalThis.fetch, now = () => new Date() }) {
    if (!connections) throw new Error('connections is required')
    if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required')
    this.connections = connections
    this.fetchImpl = fetchImpl
    this.now = now
  }

  async generate(input) {
    const values = validateInput(input)
    const connection = await this.connections.getRuntimeConfig(values.connectionId, 'TEXT')
    const endpoint = buildEndpoint(connection.baseUrl, connection.endpointPath)
    const controller = new globalThis.AbortController()
    const timeout = globalThis.setTimeout(() => controller.abort(), values.timeoutMillis)
    try {
      const response = await this.fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: connection.modelName,
          messages: [
            { role: 'system', content: values.systemPrompt },
            {
              role: 'user',
              content: values.imageDataUrl
                ? [
                    { type: 'text', text: values.userPrompt },
                    { type: 'image_url', image_url: { url: values.imageDataUrl } },
                  ]
                : values.userPrompt,
            },
          ],
          stream: false,
          ...values.parameters,
        }),
      })
      if (response.status >= 300 && response.status < 400) {
        throw new Error('本地 AI 服务返回了重定向，已按安全策略拒绝')
      }
      const payload = await readJson(response)
      if (!response.ok) {
        throw new Error(providerErrorMessage(response.status, payload))
      }
      const text = extractText(payload)
      return {
        text,
        providerCode: connection.providerCode,
        modelName: connection.modelName,
        usage: normalizeUsage(payload.usage),
        completedAt: this.now().toISOString(),
      }
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('本地 AI 生成超时')
      throw sanitizeError(error, connection.apiKey)
    } finally {
      globalThis.clearTimeout(timeout)
    }
  }
}

function sanitizeError(error, secret) {
  if (!(error instanceof Error) || !secret) return error
  return new Error(error.message.split(secret).join('[REDACTED]'))
}

function validateInput(input) {
  if (!input || typeof input !== 'object') throw new Error('本地文本生成参数无效')
  const connectionId = requiredText(input.connectionId, '本地 AI 配置')
  const systemPrompt = limitedText(input.systemPrompt, '系统提示词', MAX_PROMPT_LENGTH)
  const userPrompt = limitedText(input.userPrompt, '用户提示词', MAX_PROMPT_LENGTH)
  const timeoutMillis = normalizeTimeout(input.timeoutMillis)
  return {
    connectionId,
    systemPrompt,
    userPrompt,
    imageDataUrl: normalizeImageDataUrl(input.imageDataUrl),
    timeoutMillis,
    parameters: normalizeParameters(input.parameters),
  }
}

function normalizeImageDataUrl(value) {
  if (value == null || value === '') return null
  if (typeof value !== 'string' || value.length > 3_000_000) throw new Error('参考图片大小无效')
  if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value)) {
    throw new Error('参考图片格式无效')
  }
  return value
}

function normalizeParameters(parameters) {
  if (parameters == null) return {}
  if (typeof parameters !== 'object' || Array.isArray(parameters)) {
    throw new Error('模型参数格式无效')
  }
  const normalized = {}
  copyNumber(parameters, normalized, 'temperature', 0, 2)
  copyNumber(parameters, normalized, 'top_p', 0, 1)
  copyNumber(parameters, normalized, 'presence_penalty', -2, 2)
  copyNumber(parameters, normalized, 'frequency_penalty', -2, 2)
  if (parameters.max_tokens != null) {
    const value = Number(parameters.max_tokens)
    if (!Number.isInteger(value) || value < 1 || value > 100_000) {
      throw new Error('max_tokens 参数超出允许范围')
    }
    normalized.max_tokens = value
  }
  return normalized
}

function copyNumber(source, target, key, minimum, maximum) {
  if (source[key] == null) return
  const value = Number(source[key])
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${key} 参数超出允许范围`)
  }
  target[key] = value
}

function normalizeTimeout(value) {
  if (value == null) return DEFAULT_TIMEOUT_MILLIS
  const timeout = Number(value)
  if (!Number.isInteger(timeout) || timeout < 5_000 || timeout > 300_000) {
    throw new Error('生成超时时间超出允许范围')
  }
  return timeout
}

function buildEndpoint(baseUrl, endpointPath) {
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
  if (endpointPath) return new URL(endpointPath.replace(/^\/+/, ''), base).toString()
  const defaultPath = base.pathname.replace(/\/+$/, '').endsWith('/v1')
    ? 'chat/completions'
    : 'v1/chat/completions'
  return new URL(defaultPath, base).toString()
}

async function readJson(response) {
  const contentType = response.headers?.get?.('content-type') || ''
  if (!contentType.toLowerCase().includes('json')) {
    throw new Error(`本地 AI 服务返回了非 JSON 响应（HTTP ${response.status}）`)
  }
  try {
    return await response.json()
  } catch {
    throw new Error('本地 AI 服务返回的 JSON 无法解析')
  }
}

function providerErrorMessage(status, payload) {
  const message =
    typeof payload?.error?.message === 'string'
      ? payload.error.message
      : typeof payload?.message === 'string'
        ? payload.message
        : '服务返回错误'
  return `本地 AI 调用失败（HTTP ${status}）：${message.slice(0, MAX_ERROR_MESSAGE_LENGTH)}`
}

function extractText(payload) {
  const content = payload?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('本地 AI 响应缺少 choices[0].message.content')
  }
  return content.trim()
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null
  const promptTokens = integerOrNull(usage.prompt_tokens)
  const completionTokens = integerOrNull(usage.completion_tokens)
  const totalTokens = integerOrNull(usage.total_tokens)
  if (promptTokens == null && completionTokens == null && totalTokens == null) return null
  return { promptTokens, completionTokens, totalTokens }
}

function integerOrNull(value) {
  return Number.isInteger(value) && value >= 0 ? value : null
}

function limitedText(value, fieldName, maximum) {
  const normalized = requiredText(value, fieldName)
  if (normalized.length > maximum) throw new Error(`${fieldName}过长`)
  return normalized
}

function requiredText(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${fieldName}不能为空`)
  return value.trim()
}

module.exports = { LocalTextGenerationService, buildEndpoint }
