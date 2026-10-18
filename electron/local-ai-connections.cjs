const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { URL } = require('node:url')

const SERVICE_TYPES = new Set(['TEXT', 'IMAGE', 'VIDEO', 'TTS'])
const PROVIDER_CODE_PATTERN = /^[A-Za-z0-9_-]+$/
const DEFAULT_ENDPOINT_PATHS = Object.freeze({
  TEXT: '/v1/chat/completions',
  IMAGE: '/v1/images/generations',
  VIDEO: '/v1/videos',
  TTS: '/v1/audio/speech',
})
const PROVIDER_PROFILES = Object.freeze([
  {
    code: 'XAI',
    hostnames: ['api.x.ai'],
    modelListPath: '/v1/models',
    endpointPaths: {
      TEXT: '/v1/chat/completions',
      IMAGE: '/v1/images/generations',
      VIDEO: '/v1/videos/generations',
    },
  },
  {
    code: 'VOLCENGINE',
    hostnames: ['ark.cn-beijing.volces.com'],
    modelListPath: '/api/v3/models',
    endpointPaths: {
      TEXT: '/chat/completions',
      IMAGE: '/images/generations',
      VIDEO: '/contents/generations/tasks',
      TTS: '/audio/speech',
    },
  },
  {
    code: 'DASHSCOPE',
    hostnames: ['dashscope.aliyuncs.com'],
    modelListPath: '/compatible-mode/v1/models',
    endpointPaths: OPENAI_RELATIVE_ENDPOINT_PATHS(),
  },
  {
    code: 'DEEPSEEK',
    hostnames: ['api.deepseek.com'],
    modelListPath: '/models',
    endpointPaths: { TEXT: '/chat/completions' },
  },
  {
    code: 'ZHIPU',
    hostnames: ['open.bigmodel.cn'],
    modelListPath: '/api/paas/v4/models',
    endpointPaths: OPENAI_RELATIVE_ENDPOINT_PATHS(),
  },
  {
    code: 'MOONSHOT',
    hostnames: ['api.moonshot.cn'],
    modelListPath: '/v1/models',
    endpointPaths: { TEXT: '/chat/completions' },
  },
  {
    code: 'SILICONFLOW',
    hostnames: ['api.siliconflow.cn'],
    modelListPath: '/v1/models',
    endpointPaths: OPENAI_RELATIVE_ENDPOINT_PATHS(),
  },
  {
    code: 'QIANFAN',
    hostnames: ['qianfan.baidubce.com'],
    modelListPath: '/v2/models',
    endpointPaths: OPENAI_RELATIVE_ENDPOINT_PATHS(),
  },
  {
    code: 'HUNYUAN',
    hostnames: ['api.hunyuan.cloud.tencent.com'],
    modelListPath: '/v1/models',
    endpointPaths: OPENAI_RELATIVE_ENDPOINT_PATHS(),
  },
])
const MAX_DISCOVERED_MODELS = 500

function OPENAI_RELATIVE_ENDPOINT_PATHS() {
  return Object.freeze({
    TEXT: '/chat/completions',
    IMAGE: '/images/generations',
    VIDEO: '/videos',
    TTS: '/audio/speech',
  })
}

class LocalAiConnectionService {
  constructor({ appDataPath, encryption, fetchImpl = globalThis.fetch, now = () => new Date() }) {
    if (!appDataPath) throw new Error('appDataPath is required')
    if (!encryption) throw new Error('encryption adapter is required')
    this.filePath = path.join(appDataPath, 'local-ai-connections.json')
    this.encryption = encryption
    this.fetchImpl = fetchImpl
    this.now = now
    this.writeQueue = Promise.resolve()
  }

  async list() {
    const manifest = await this.readManifest()
    return manifest.connections.map(toPublicConnection)
  }

  async save(input) {
    return this.withWriteLock(async () => {
      const manifest = await this.readManifest()
      const existingIndex = input.id
        ? manifest.connections.findIndex((connection) => connection.id === input.id)
        : -1
      const existing = existingIndex >= 0 ? manifest.connections[existingIndex] : null
      if (input.id && !existing) throw new Error('本地 AI 配置不存在')
      if (existing && input.version !== existing.version) {
        throw new Error('本地 AI 配置已被其他操作更新，请刷新后重试')
      }

      const values = validateInput(input)
      const apiKey = trimToNull(input.apiKey)
      if (
        existing?.encryptedApiKeyBase64 &&
        hostChanged(existing.baseUrl, values.baseUrl) &&
        !apiKey &&
        !input.clearApiKey
      ) {
        throw new Error('基础地址主机发生变化，请重新输入或清除 API Key')
      }

      let encryptedApiKeyBase64 = existing?.encryptedApiKeyBase64 || null
      let apiKeyHint = existing?.apiKeyHint || null
      if (input.clearApiKey) {
        encryptedApiKeyBase64 = null
        apiKeyHint = null
      } else if (apiKey) {
        assertEncryptionAvailable(this.encryption)
        encryptedApiKeyBase64 = this.encryption.encrypt(apiKey).toString('base64')
        apiKeyHint = apiKey.slice(-4)
      }

      const timestamp = this.now().toISOString()
      const connection = {
        id: existing?.id || randomUUID(),
        serviceType: values.serviceType,
        providerCode: values.providerCode,
        displayName: values.displayName,
        baseUrl: values.baseUrl,
        endpointPath: values.endpointPath,
        modelName: values.modelName,
        encryptedApiKeyBase64,
        apiKeyHint,
        enabled: values.enabled,
        defaultProvider: values.defaultProvider,
        version: existing ? existing.version + 1 : 0,
        updatedAt: timestamp,
      }

      if (connection.defaultProvider) {
        for (const other of manifest.connections) {
          if (
            other.id !== connection.id &&
            other.serviceType === connection.serviceType &&
            other.defaultProvider
          ) {
            other.defaultProvider = false
            other.version += 1
            other.updatedAt = timestamp
          }
        }
      }
      if (existingIndex >= 0) manifest.connections[existingIndex] = connection
      else manifest.connections.push(connection)
      await this.writeManifest(manifest)
      return toPublicConnection(connection)
    })
  }

  async delete(id, version) {
    return this.withWriteLock(async () => {
      const manifest = await this.readManifest()
      const index = manifest.connections.findIndex((connection) => connection.id === id)
      if (index < 0) throw new Error('本地 AI 配置不存在')
      if (manifest.connections[index].version !== version) {
        throw new Error('本地 AI 配置已被其他操作更新，请刷新后重试')
      }
      manifest.connections.splice(index, 1)
      await this.writeManifest(manifest)
    })
  }

  async testAddress(id) {
    const manifest = await this.readManifest()
    const connection = manifest.connections.find((item) => item.id === id)
    if (!connection) throw new Error('本地 AI 配置不存在')
    const controller = new globalThis.AbortController()
    const timeout = globalThis.setTimeout(() => controller.abort(), 8000)
    try {
      const response = await this.fetchImpl(connection.baseUrl, {
        method: 'HEAD',
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': 'AI-Drama-Studio-Local-Check/1.0' },
      })
      const reachable = response.status < 500
      return {
        status: reachable ? 'REACHABLE' : 'DEGRADED',
        httpStatus: response.status,
        message: reachable ? '地址可达，未调用模型' : '地址可达，但服务返回异常状态',
        checkedAt: this.now().toISOString(),
      }
    } catch {
      return {
        status: 'UNREACHABLE',
        httpStatus: null,
        message: '无法连接该地址',
        checkedAt: this.now().toISOString(),
      }
    } finally {
      globalThis.clearTimeout(timeout)
    }
  }

  async discoverModels(input) {
    const serviceType = normalizeServiceType(input?.serviceType)
    const baseUrl = normalizeBaseUrl(input?.baseUrl)
    const providerCode = normalizeProviderCode(input?.providerCode, baseUrl, input?.endpointPath)
    const endpointPath = effectiveEndpointPath(
      serviceType,
      providerCode,
      normalizeEndpointPath(input?.endpointPath),
    )
    const apiKey = await this.resolveDiscoveryApiKey(input, baseUrl)
    const endpoint = modelsEndpoint(baseUrl, endpointPath, providerCode)
    const controller = new globalThis.AbortController()
    const timeout = globalThis.setTimeout(() => controller.abort(), 12_000)
    try {
      const response = await this.fetchImpl(endpoint, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
      })
      if (response.status >= 300 && response.status < 400) {
        throw new Error('模型列表接口返回了重定向，已按安全策略拒绝')
      }
      const contentType = response.headers?.get?.('content-type') || ''
      if (!contentType.toLowerCase().includes('json')) {
        throw new Error(`模型列表接口返回了非 JSON 响应（HTTP ${response.status}）`)
      }
      const payload = await response.json()
      if (!response.ok) throw new Error(discoveryError(response.status, payload))
      const models = parseModels(payload)
      if (!models.length) throw new Error('模型列表为空，请检查基础地址、API Key 或手工填写模型 ID')
      return {
        providerCode,
        endpointPath,
        models,
      }
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('获取模型列表超时')
      throw redactError(error, apiKey)
    } finally {
      globalThis.clearTimeout(timeout)
    }
  }

  async resolveDiscoveryApiKey(input, baseUrl) {
    const supplied = trimToNull(input?.apiKey)
    if (supplied) return supplied
    const connectionId = trimToNull(input?.id)
    if (!connectionId) return null
    const manifest = await this.readManifest()
    const existing = manifest.connections.find((item) => item.id === connectionId)
    if (!existing || hostChanged(existing.baseUrl, baseUrl) || !existing.encryptedApiKeyBase64) {
      return null
    }
    assertEncryptionAvailable(this.encryption)
    return this.encryption.decrypt(Buffer.from(existing.encryptedApiKeyBase64, 'base64'))
  }

  async getRuntimeConfig(id, expectedServiceType) {
    const manifest = await this.readManifest()
    const connection = manifest.connections.find((item) => item.id === id)
    if (!connection) throw new Error('本地 AI 配置不存在')
    if (!connection.enabled) throw new Error('本地 AI 配置已停用')
    if (expectedServiceType && connection.serviceType !== expectedServiceType) {
      throw new Error('本地 AI 配置类型与当前任务不匹配')
    }
    let apiKey = null
    if (connection.encryptedApiKeyBase64) {
      assertEncryptionAvailable(this.encryption)
      apiKey = this.encryption.decrypt(Buffer.from(connection.encryptedApiKeyBase64, 'base64'))
    }
    return {
      id: connection.id,
      serviceType: connection.serviceType,
      providerCode: connection.providerCode,
      baseUrl: connection.baseUrl,
      endpointPath: connection.endpointPath,
      modelName: connection.modelName,
      apiKey,
    }
  }

  async readManifest() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      const manifest = JSON.parse(raw)
      validateManifest(manifest)
      return manifest
    } catch (error) {
      if (error?.code === 'ENOENT') return { version: 1, connections: [] }
      if (error instanceof SyntaxError) throw new Error('本地 AI 配置文件已损坏')
      throw error
    }
  }

  async writeManifest(manifest) {
    validateManifest(manifest)
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      })
      await fs.rename(temporaryPath, this.filePath)
    } finally {
      await fs.rm(temporaryPath, { force: true })
    }
  }

  withWriteLock(operation) {
    const result = this.writeQueue.then(operation, operation)
    this.writeQueue = result.catch(() => undefined)
    return result
  }
}

function createSafeStorageEncryption(safeStorage) {
  return {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value) => safeStorage.encryptString(value),
    decrypt: (value) => safeStorage.decryptString(value),
  }
}

function assertEncryptionAvailable(encryption) {
  if (!encryption.isAvailable()) {
    throw new Error('当前 Windows 安全存储不可用，无法保存或读取 API Key')
  }
}

function validateInput(input) {
  const serviceType = normalizeServiceType(input.serviceType)
  const displayName = limitedText(input.displayName, '显示名称', 120)
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  const providerCode = normalizeProviderCode(input.providerCode, baseUrl, input.endpointPath)
  const endpointPath = effectiveEndpointPath(
    serviceType,
    providerCode,
    normalizeEndpointPath(input.endpointPath),
  )
  const modelName = limitedText(input.modelName, '模型名称', 160)
  const enabled = Boolean(input.enabled)
  const defaultProvider = Boolean(input.defaultProvider)
  if (defaultProvider && !enabled) throw new Error('默认配置必须处于启用状态')
  return {
    serviceType,
    providerCode,
    displayName,
    baseUrl,
    endpointPath,
    modelName,
    enabled,
    defaultProvider,
  }
}

function normalizeServiceType(value) {
  const serviceType = requiredText(value, 'AI 服务类型').toUpperCase()
  if (!SERVICE_TYPES.has(serviceType)) throw new Error('AI 服务类型无效')
  return serviceType
}

function normalizeProviderCode(value, baseUrl, endpointPath) {
  const explicit = trimToNull(value)?.toUpperCase()
  if (explicit) {
    if (!PROVIDER_CODE_PATTERN.test(explicit)) throw new Error('供应商编码格式无效')
    return explicit
  }
  const url = new URL(baseUrl)
  const pathValue = String(endpointPath || '').toLowerCase()
  if (
    url.port === '11434' ||
    pathValue.startsWith('/api/chat') ||
    pathValue.startsWith('/api/generate')
  ) {
    return 'OLLAMA'
  }
  const profile = providerProfileForHostname(url.hostname)
  if (profile) return profile.code
  if (pathValue.startsWith('/api/v3/')) return 'VOLCENGINE'
  return 'OPENAI_COMPATIBLE'
}

function defaultEndpointPath(serviceType, providerCode) {
  if (providerCode === 'OLLAMA' && serviceType === 'TEXT') return '/api/chat'
  const profile = providerProfileForCode(providerCode)
  if (profile?.endpointPaths[serviceType]) return profile.endpointPaths[serviceType]
  return DEFAULT_ENDPOINT_PATHS[serviceType]
}

function effectiveEndpointPath(serviceType, providerCode, requestedEndpointPath) {
  if (
    !requestedEndpointPath ||
    (providerCode !== 'OPENAI_COMPATIBLE' &&
      requestedEndpointPath === DEFAULT_ENDPOINT_PATHS[serviceType])
  ) {
    return defaultEndpointPath(serviceType, providerCode)
  }
  return requestedEndpointPath
}

function modelsEndpoint(baseUrl, endpointPath, providerCode) {
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
  if (providerCode === 'OLLAMA') return new URL('api/tags', base).toString()
  const profile = providerProfileForCode(providerCode)
  if (profile) return new URL(profile.modelListPath, base.origin).toString()
  const normalizedPath = String(endpointPath || '').replace(/\/+$/, '')
  const versionMatch = normalizedPath.match(/^(.*\/(?:v\d+|api\/v\d+))(?:\/.*)?$/i)
  if (versionMatch) return new URL(`${versionMatch[1]}/models`, base.origin).toString()
  const basePath = base.pathname.replace(/\/+$/, '')
  if (/\/(?:v\d+|api\/v\d+)$/i.test(basePath)) return new URL('models', base).toString()
  return new URL('v1/models', base).toString()
}

function parseModels(payload) {
  const source = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : Array.isArray(payload?.data?.models)
          ? payload.data.models
          : []
  const unique = new Map()
  for (const item of source) {
    const modelName = trimToNull(
      typeof item === 'string'
        ? item
        : item?.id ||
            item?.model ||
            item?.name ||
            item?.model_id ||
            item?.modelId ||
            item?.model_code ||
            item?.modelName,
    )
    if (!modelName || modelName.length > 160 || unique.has(modelName.toLowerCase())) continue
    unique.set(modelName.toLowerCase(), modelName)
    if (unique.size >= MAX_DISCOVERED_MODELS) break
  }
  return [...unique.values()].sort((left, right) => left.localeCompare(right, 'zh-CN'))
}

function providerProfileForHostname(hostname) {
  const normalized = String(hostname || '').toLowerCase()
  return (
    PROVIDER_PROFILES.find((profile) =>
      profile.hostnames.some(
        (candidate) => normalized === candidate || normalized.endsWith(`.${candidate}`),
      ),
    ) || null
  )
}

function providerProfileForCode(providerCode) {
  return PROVIDER_PROFILES.find((profile) => profile.code === providerCode) || null
}

function discoveryError(status, payload) {
  const message =
    trimToNull(payload?.error?.message) || trimToNull(payload?.message) || '服务拒绝了模型列表请求'
  const hint =
    status === 401
      ? '，请检查 API Key'
      : status === 403
        ? '，API Key 没有模型列表权限'
        : status === 404
          ? '，请检查基础地址，或手工填写模型 ID'
          : ''
  return `获取模型列表失败（HTTP ${status}）：${message.slice(0, 500)}${hint}`
}

function redactError(error, secret) {
  if (!(error instanceof Error) || !secret) return error
  return new Error(error.message.split(secret).join('[REDACTED]'))
}

function normalizeBaseUrl(value) {
  const raw = requiredText(value, '基础地址')
  if (raw.length > 500) throw new Error('基础地址不能超过 500 个字符')
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('基础地址格式无效')
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('基础地址必须是无账号信息的 HTTP 或 HTTPS 地址')
  }
  if (parsed.search || parsed.hash) throw new Error('基础地址不能包含查询参数或片段')
  return parsed.toString().replace(/\/+$/, '')
}

function normalizeEndpointPath(value) {
  const normalized = trimToNull(value)
  if (!normalized) return null
  if (
    normalized.length > 300 ||
    !normalized.startsWith('/') ||
    normalized.startsWith('//') ||
    normalized.includes('://') ||
    normalized.includes('?') ||
    normalized.includes('#') ||
    normalized.split('/').includes('..')
  ) {
    throw new Error('接口路径必须是安全的相对路径')
  }
  return normalized
}

function validateManifest(manifest) {
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.connections)) {
    throw new Error('本地 AI 配置文件版本无效')
  }
  const ids = new Set()
  const defaults = new Set()
  for (const connection of manifest.connections) {
    if (!connection?.id || ids.has(connection.id)) throw new Error('本地 AI 配置标识无效')
    ids.add(connection.id)
    if (!Number.isInteger(connection.version) || connection.version < 0) {
      throw new Error('本地 AI 配置版本无效')
    }
    if (connection.defaultProvider) {
      if (defaults.has(connection.serviceType)) throw new Error('同类服务只能有一个默认配置')
      defaults.add(connection.serviceType)
    }
    if (
      connection.encryptedApiKeyBase64 !== null &&
      typeof connection.encryptedApiKeyBase64 !== 'string'
    ) {
      throw new Error('本地 AI 密钥格式无效')
    }
  }
}

function toPublicConnection(connection) {
  return {
    id: connection.id,
    serviceType: connection.serviceType,
    providerCode: connection.providerCode,
    displayName: connection.displayName,
    baseUrl: connection.baseUrl,
    endpointPath: connection.endpointPath,
    modelName: connection.modelName,
    apiKeyConfigured: Boolean(connection.encryptedApiKeyBase64),
    apiKeyHint: connection.apiKeyHint,
    enabled: connection.enabled,
    defaultProvider: connection.defaultProvider,
    version: connection.version,
    updatedAt: connection.updatedAt,
  }
}

function hostChanged(current, next) {
  const currentUrl = new URL(current)
  const nextUrl = new URL(next)
  return currentUrl.host.toLowerCase() !== nextUrl.host.toLowerCase()
}

function limitedText(value, fieldName, maxLength) {
  const normalized = requiredText(value, fieldName)
  if (normalized.length > maxLength) throw new Error(`${fieldName}不能超过 ${maxLength} 个字符`)
  return normalized
}

function requiredText(value, fieldName) {
  const normalized = trimToNull(value)
  if (!normalized) throw new Error(`${fieldName}不能为空`)
  return normalized
}

function trimToNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

module.exports = { LocalAiConnectionService, createSafeStorageEncryption }
