const { URL } = require('node:url')
const dns = require('node:dns').promises
const { readLimited } = require('./generated-image-store.cjs')

const MAX_JSON_BYTES = 42 * 1024 * 1024
const DEFAULT_TIMEOUT_MILLIS = 180_000
const ALLOWED_SIZES = new Set(['1152x2048', '1024x1024', '2048x1152', '1728x2304', '2304x1728', '1024x1536', '1536x1024'])

class LocalImageGenerationService {
  constructor({ connections, generatedImages, fetchImpl = globalThis.fetch }) {
    if (!connections) throw new Error('connections is required')
    if (!generatedImages) throw new Error('generatedImages is required')
    if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required')
    this.connections = connections
    this.generatedImages = generatedImages
    this.fetchImpl = fetchImpl
  }

  async generate(input) {
    const values = validateInput(input)
    const connection = await this.connections.getRuntimeConfig(values.connectionId, 'IMAGE')
    const endpoint = values.referenceImages.length
      ? buildImageEditEndpoint(connection.baseUrl, connection.endpointPath)
      : buildImageEndpoint(connection.baseUrl, connection.endpointPath)
    const controller = new globalThis.AbortController()
    const timeout = globalThis.setTimeout(() => controller.abort(), values.timeoutMillis)
    try {
      const body = values.referenceImages.length
        ? buildMultipartEditBody(connection, values)
        : JSON.stringify({
            model: connection.modelName,
            prompt: prompt(values.prompt, values.negativePrompt),
            n: 1,
            size: effectiveImageSize(connection.modelName, values.size),
            ...values.parameters,
          })
      const response = await this.fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(values.referenceImages.length ? {} : { 'Content-Type': 'application/json' }),
          ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}),
        },
        body,
      })
      if (response.status >= 300 && response.status < 400) {
        throw new Error('本地图片服务返回了重定向，已按安全策略拒绝')
      }
      const payload = await readJson(response)
      if (!response.ok) throw new Error(providerError(response.status, payload))
      const result = await extractImage(
        payload,
        this.fetchImpl,
        values.timeoutMillis,
        connection.baseUrl,
      )
      const candidate = await this.generatedImages.stage(values.projectId, result.bytes, {
        mimeType: result.mimeType,
        originalName: `ai-${connection.providerCode}-${Date.now()}`,
      })
      return {
        ...candidate,
        providerCode: connection.providerCode,
        modelName: connection.modelName,
        revisedPrompt: result.revisedPrompt,
      }
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('本地图片生成超时')
      throw redact(error, connection.apiKey)
    } finally {
      globalThis.clearTimeout(timeout)
    }
  }
}

function validateInput(input) {
  if (!input || typeof input !== 'object') throw new Error('本地图片生成参数无效')
  const projectId = requiredText(input.projectId, '项目标识', 36)
  const connectionId = requiredText(input.connectionId, '本地 AI 配置', 120)
  const prompt = requiredText(input.prompt, '图片提示词', 20_000)
  const negativePrompt = optionalText(input.negativePrompt, '负面提示词', 10_000)
  const size = input.size || '1024x1536'
  if (!ALLOWED_SIZES.has(size)) throw new Error('图片尺寸无效')
  const timeoutMillis = Number(input.timeoutMillis || DEFAULT_TIMEOUT_MILLIS)
  if (!Number.isInteger(timeoutMillis) || timeoutMillis < 10_000 || timeoutMillis > 300_000) {
    throw new Error('图片生成超时时间超出允许范围')
  }
  return {
    projectId,
    connectionId,
    prompt,
    negativePrompt,
    size,
    referenceImages: normalizeReferenceImages(input.referenceImages),
    timeoutMillis,
    parameters: normalizeParameters(input.parameters),
  }
}

function normalizeReferenceImages(images) {
  if (images == null) return []
  if (!Array.isArray(images) || images.length > 10) throw new Error('参考图数量必须在 1 到 10 张之间')
  return images.map((image) => {
    if (!image || typeof image !== 'object') throw new Error('参考图参数无效')
    const mimeType = requiredText(image.mimeType, '参考图格式', 40).toLowerCase()
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) {
      throw new Error('参考图仅支持 PNG、JPEG 和 WebP')
    }
    const bytes = Buffer.from(image.bytes)
    if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new Error('单张参考图必须小于 10MB')
    return {
      name: optionalText(image.name, '参考图文件名', 180) || `reference${extension(mimeType)}`,
      mimeType,
      bytes,
    }
  })
}

function buildMultipartEditBody(connection, values) {
  const form = new FormData()
  form.set('model', connection.modelName)
  form.set('prompt', prompt(values.prompt, values.negativePrompt))
  form.set('n', '1')
  form.set('size', effectiveImageSize(connection.modelName, values.size))
  for (const [key, value] of Object.entries(values.parameters)) form.set(key, String(value))
  const imageField = values.referenceImages.length === 1 ? 'image' : 'image[]'
  values.referenceImages.forEach((image, index) => {
    form.append(
      imageField,
      new Blob([image.bytes], { type: image.mimeType }),
      safeFilename(image.name || `reference-${index + 1}${extension(image.mimeType)}`),
    )
  })
  return form
}

function extension(mimeType) {
  return mimeType === 'image/png' ? '.png' : mimeType === 'image/webp' ? '.webp' : '.jpg'
}

function safeFilename(filename) {
  const normalized = String(filename || '').replace(/[\r\n\\/]+/g, '_').trim()
  return normalized || 'reference.png'
}

function effectiveImageSize(modelName, requestedSize) {
  if (!String(modelName || '').trim().toLowerCase().startsWith('doubao-seedream-5-0')) {
    return requestedSize
  }
  const match = /^(\d+)x(\d+)$/.exec(requestedSize)
  if (!match) return requestedSize
  const width = Number(match[1])
  const height = Number(match[2])
  const minimumPixels = 3_686_400
  if (width * height >= minimumPixels) return requestedSize
  const scale = Math.sqrt(minimumPixels / (width * height))
  const roundUp = (value) => Math.ceil(value / 8) * 8
  return `${roundUp(width * scale)}x${roundUp(height * scale)}`
}

function normalizeParameters(parameters) {
  if (parameters == null) return {}
  if (typeof parameters !== 'object' || Array.isArray(parameters)) throw new Error('图片参数无效')
  const result = {}
  for (const key of ['quality', 'style', 'background', 'output_format']) {
    if (parameters[key] != null) result[key] = requiredText(parameters[key], key, 40)
  }
  return result
}

function buildImageEndpoint(baseUrl, endpointPath) {
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
  if (endpointPath) return new URL(endpointPath.replace(/^\/+/, ''), base).toString()
  const defaultPath = base.pathname.replace(/\/+$/, '').endsWith('/v1')
    ? 'images/generations'
    : 'v1/images/generations'
  return new URL(defaultPath, base).toString()
}

function buildImageEditEndpoint(baseUrl, endpointPath) {
  const endpoint = buildImageEndpoint(baseUrl, endpointPath)
  const url = new URL(endpoint)
  url.pathname = imageEditPath(url.pathname)
  return url.toString()
}

function imageEditPath(pathname) {
  const normalized = String(pathname || '').replace(/\/+$/, '') || '/v1/images/generations'
  const lower = normalized.toLowerCase()
  if (lower.endsWith('/images/edits')) return normalized
  if (lower.endsWith('/images/generations')) {
    return `${normalized.slice(0, -'/images/generations'.length)}/images/edits`
  }
  if (lower.endsWith('/generations')) return `${normalized.slice(0, -'generations'.length)}edits`
  return lower.endsWith('/edits') ? normalized : `${normalized}/edits`
}

async function readJson(response) {
  const contentType = response.headers?.get?.('content-type') || ''
  if (!contentType.toLowerCase().includes('json')) {
    throw new Error(`本地图片服务返回了非 JSON 响应（HTTP ${response.status}）`)
  }
  const bytes = await readLimited(response, MAX_JSON_BYTES)
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error('本地图片服务返回的 JSON 无法解析')
  }
}

async function extractImage(payload, fetchImpl, timeoutMillis, connectionBaseUrl) {
  const item = payload?.data?.[0]
  if (!item || typeof item !== 'object') throw new Error('本地图片响应缺少 data[0]')
  if (typeof item.b64_json === 'string' && item.b64_json) {
    const bytes = Buffer.from(item.b64_json, 'base64')
    if (!bytes.length) throw new Error('本地图片响应中的 Base64 无效')
    return {
      bytes,
      mimeType: item.mime_type || null,
      revisedPrompt: optionalValue(item.revised_prompt),
    }
  }
  if (typeof item.url !== 'string' || !item.url.trim()) {
    throw new Error('本地图片响应缺少 url 或 b64_json')
  }
  const url = await safeRemoteUrl(item.url, connectionBaseUrl)
  const controller = new globalThis.AbortController()
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMillis)
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { Accept: 'image/png,image/jpeg,image/webp' },
    })
    if (response.status >= 300 && response.status < 400) throw new Error('图片下载重定向已被拒绝')
    if (!response.ok) throw new Error(`图片下载失败（HTTP ${response.status}）`)
    return {
      bytes: await readLimited(response, 30 * 1024 * 1024),
      mimeType: response.headers?.get?.('content-type'),
      revisedPrompt: optionalValue(item.revised_prompt),
    }
  } finally {
    globalThis.clearTimeout(timeout)
  }
}

async function safeRemoteUrl(value, connectionBaseUrl) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('本地图片结果地址无效')
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('本地图片结果地址协议无效')
  }
  const configured = new URL(connectionBaseUrl)
  if (parsed.origin === configured.origin) return parsed.toString()
  if (parsed.protocol !== 'https:') {
    throw new Error('跨服务图片结果只允许公网 HTTPS 地址')
  }
  const host = parsed.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error('跨服务图片结果不能指向本机或内网')
  }
  let addresses
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true })
  } catch {
    throw new Error('跨服务图片结果地址无法解析')
  }
  if (!addresses.length || addresses.some((item) => !isPublicAddress(item.address))) {
    throw new Error('跨服务图片结果不能指向本机、内网或保留网络')
  }
  return parsed.toString()
}

function isPublicAddress(address) {
  const normalized = address.toLowerCase()
  if (normalized.includes(':')) {
    if (
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb') ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('ff') ||
      normalized.startsWith('2001:db8:')
    ) {
      return false
    }
    if (normalized.startsWith('::ffff:')) return isPublicIpv4(normalized.slice(7))
    return true
  }
  return isPublicIpv4(normalized)
}

function isPublicIpv4(address) {
  const parts = address.split('.').map(Number)
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false
  }
  const [first, second, third] = parts
  return !(
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 192 && second === 0 && (third === 0 || third === 2)) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113)
  )
}

function prompt(positive, negative) {
  return negative ? `${positive}\n\nAvoid: ${negative}` : positive
}

function providerError(status, payload) {
  const message = payload?.error?.message || payload?.message || '服务返回错误'
  return `本地图片调用失败（HTTP ${status}）：${String(message).slice(0, 500)}`
}

function redact(error, secret) {
  if (!(error instanceof Error) || !secret) return error
  return new Error(error.message.split(secret).join('[REDACTED]'))
}

function requiredText(value, fieldName, maximum) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${fieldName}不能为空`)
  const normalized = value.trim()
  if (normalized.length > maximum) throw new Error(`${fieldName}过长`)
  return normalized
}

function optionalText(value, fieldName, maximum) {
  if (value == null || value === '') return null
  return requiredText(value, fieldName, maximum)
}

function optionalValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 4000) : null
}

module.exports = {
  LocalImageGenerationService,
  buildImageEndpoint,
  buildImageEditEndpoint,
  effectiveImageSize,
  extractImage,
  safeRemoteUrl,
}
