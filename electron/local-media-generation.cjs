const fs = require('node:fs/promises')
const { URL } = require('node:url')
const { safeRemoteUrl } = require('./local-image-generation.cjs')

const DEFAULT_TIMEOUT_MILLIS = 600_000
const MAX_JSON_BYTES = 2 * 1024 * 1024
const PENDING_STATES = new Set(['queued', 'pending', 'processing', 'in_progress', 'running'])
const SUCCESS_STATES = new Set(['completed', 'succeeded', 'success', 'done'])
const FAILED_STATES = new Set(['failed', 'error', 'canceled', 'cancelled', 'expired'])
const GROK_TEXT_TO_VIDEO_MODEL = 'grok-imagine-video'
const GROK_IMAGE_TO_VIDEO_MODEL = 'grok-imagine-video-1.5'
const MAX_GROK_REFERENCE_IMAGES = 7
const DEFAULT_VOICE_PRESET = 'preset:neutral_balanced'
const MINIMAX_VOICES = Object.freeze({
  [DEFAULT_VOICE_PRESET]: 'male-qn-qingse',
  'preset:female_young_bright': 'female-tianmei',
  'preset:female_calm_gentle': 'female-shaonv',
  'preset:female_mature_confident': 'female-yujie',
  'preset:male_young_clear': 'male-qn-qingse',
  'preset:male_calm_professional': 'male-qn-jingying',
  'preset:male_deep_powerful': 'male-qn-badao',
  'preset:narration_warm': 'audiobook_female_1',
})
const OPENAI_COMPATIBLE_VOICES = Object.freeze({
  [DEFAULT_VOICE_PRESET]: 'alloy',
  'preset:female_young_bright': 'nova',
  'preset:female_calm_gentle': 'shimmer',
  'preset:female_mature_confident': 'sage',
  'preset:male_young_clear': 'ash',
  'preset:male_calm_professional': 'echo',
  'preset:male_deep_powerful': 'onyx',
  'preset:narration_warm': 'fable',
})

class LocalMediaGenerationService {
  constructor({
    connections,
    generatedMedia,
    workspace,
    fetchImpl = globalThis.fetch,
    pollIntervalMillis = 2_000,
  }) {
    if (!connections) throw new Error('connections is required')
    if (!generatedMedia) throw new Error('generatedMedia is required')
    if (!workspace) throw new Error('workspace is required')
    if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required')
    if (!Number.isInteger(pollIntervalMillis) || pollIntervalMillis < 0 || pollIntervalMillis > 60_000)
      throw new Error('pollIntervalMillis is invalid')
    this.connections = connections
    this.generatedMedia = generatedMedia
    this.workspace = workspace
    this.fetchImpl = fetchImpl
    this.pollIntervalMillis = pollIntervalMillis
  }

  async generate(input) {
    const values = validateInput(input)
    const connection = await this.connections.getRuntimeConfig(
      values.connectionId,
      values.mediaType,
    )
    const endpoint = normalizeGrokVideoEndpoint(
      buildMediaEndpoint(connection.baseUrl, connection.endpointPath, values.mediaType),
      connection,
      values.mediaType,
    )
    const deadline = Date.now() + values.timeoutMillis
    try {
      const response =
        values.mediaType === 'TTS'
          ? await this.postTts(endpoint, connection, values, deadline)
          : await this.postVideo(endpoint, connection, values, deadline)
      const candidate = await this.resolveResponse(response, endpoint, connection, values, deadline)
      return {
        ...candidate,
        providerCode: connection.providerCode,
        modelName: connection.modelName,
      }
    } catch (error) {
      throw redact(error, connection.apiKey)
    }
  }

  async postTts(endpoint, connection, values, deadline) {
    return fetchWithDeadline(
      this.fetchImpl,
      endpoint,
      {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg,audio/wav,audio/aac,audio/mp4,audio/ogg,audio/flac,application/json',
          ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: connection.modelName,
          input: values.prompt,
          voice: providerVoice(connection.providerCode, values.voice),
          response_format: values.responseFormat,
          speed: values.speed,
          ...values.parameters,
        }),
      },
      deadline,
    )
  }

  async postVideo(endpoint, connection, values, deadline) {
    if (usesGrokJsonVideoProtocol(connection)) {
      const payload = await this.grokVideoPayload(connection, values)
      return fetchWithDeadline(
        this.fetchImpl,
        endpoint,
        {
          method: 'POST',
          redirect: 'manual',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}),
          },
          body: JSON.stringify(payload),
        },
        deadline,
      )
    }

    const form = new globalThis.FormData()
    form.append('model', connection.modelName)
    form.append('prompt', values.prompt)
    form.append('seconds', String(values.durationSec))
    form.append('size', values.size)
    form.append('aspect_ratio', values.aspectRatio)
    for (const [key, value] of Object.entries(values.parameters)) form.append(key, String(value))
    if (values.inputAssetId) {
      const resolved = await this.workspace.resolveAsset(values.projectId, values.inputAssetId)
      if (!resolved.asset.mimeType.startsWith('image/'))
        throw new Error('视频输入参考必须是图片素材')
      const bytes = await fs.readFile(resolved.path)
      form.append(
        'input_reference',
        new globalThis.Blob([bytes], { type: resolved.asset.mimeType }),
        resolved.asset.originalName,
      )
    }
    return fetchWithDeadline(
      this.fetchImpl,
      endpoint,
      {
        method: 'POST',
        redirect: 'manual',
        headers: {
          Accept: 'video/mp4,video/webm,video/quicktime,application/json',
          ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}),
        },
        body: form,
      },
      deadline,
    )
  }

  async grokVideoPayload(connection, values) {
    const modelCode = String(connection.modelName || '').trim().toLowerCase()
    const providerCode = String(connection.providerCode || '').trim().toUpperCase()
    const referenceAssetIds = values.referenceAssetIds
    const referenceCount = referenceAssetIds.length + values.referenceImages.length
    if (modelCode === GROK_TEXT_TO_VIDEO_MODEL && referenceCount) {
      throw new Error('grok-imagine-video 仅支持文生视频，请移除所有参考图片')
    }
    if (
      providerCode === 'GROK' &&
      modelCode === GROK_IMAGE_TO_VIDEO_MODEL &&
      !referenceCount
    ) {
      throw new Error('grok-imagine-video-1.5 仅支持图生视频，请至少提供一张参考图片')
    }
    if (referenceCount > MAX_GROK_REFERENCE_IMAGES) {
      throw new Error(`Grok 视频生成每次最多提交 ${MAX_GROK_REFERENCE_IMAGES} 张参考图片`)
    }
    const payload = {
      model: connection.modelName,
      prompt: values.prompt,
      duration: values.durationSec,
      aspect_ratio: values.aspectRatio,
      resolution: xaiResolution(values.parameters.resolution, values.size),
    }
    const images = []
    for (const assetId of referenceAssetIds) {
      const resolved = await this.workspace.resolveAsset(values.projectId, assetId)
      if (!resolved.asset.mimeType.startsWith('image/')) {
        throw new Error('Grok 视频输入参考只能使用图片素材')
      }
      const bytes = await fs.readFile(resolved.path)
      images.push({ url: `data:${resolved.asset.mimeType};base64,${bytes.toString('base64')}` })
    }
    for (const reference of values.referenceImages) {
      images.push({ url: `data:${reference.mimeType};base64,${reference.bytes.toString('base64')}` })
    }
    if (images.length === 1 && values.parameters.reference_mode !== 'REFERENCE_TO_VIDEO') {
      payload.image = images[0]
    } else if (images.length) {
      payload.reference_images = images
    }
    return payload
  }

  async resolveResponse(response, endpoint, connection, values, deadline) {
    rejectRedirect(response)
    const contentType = normalizeMimeType(response.headers?.get?.('content-type'))
    if (!response.ok) {
      const payload = isJson(contentType) ? await readJson(response) : null
      throw new Error(providerError(values.mediaType, response.status, payload))
    }
    if (!isJson(contentType)) {
      return this.generatedMedia.stage(values.projectId, response, {
        mimeType: supportedResponseMime(contentType) ? contentType : fallbackMimeType(values),
        originalName: `ai-${connection.providerCode}-${Date.now()}`,
      })
    }

    const payload = await readJson(response)
    const direct = await this.extractPayload(payload, connection, values, deadline)
    if (direct) return direct
    const taskId = firstText(payload, ['id', 'task_id', 'request_id'])
    if (!taskId || !/^[A-Za-z0-9._:-]{1,160}$/.test(taskId)) {
      throw new Error('媒体服务响应缺少结果或任务标识')
    }
    return this.poll(endpoint, taskId, connection, values, deadline)
  }

  async poll(endpoint, taskId, connection, values, deadline) {
    const statusUrl = buildMediaStatusEndpoint(endpoint, taskId, connection, values.mediaType)
    while (Date.now() < deadline) {
      await delay(this.pollIntervalMillis)
      const response = await fetchWithDeadline(
        this.fetchImpl,
        statusUrl,
        {
          method: 'GET',
          redirect: 'manual',
          headers: {
            Accept:
              'application/json,video/mp4,video/webm,audio/mpeg,audio/wav,audio/mp4,audio/aac,audio/ogg,audio/flac',
            ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}),
          },
        },
        deadline,
      )
      rejectRedirect(response)
      const contentType = normalizeMimeType(response.headers?.get?.('content-type'))
      if (!response.ok) {
        const payload = isJson(contentType) ? await readJson(response) : null
        throw new Error(providerError(values.mediaType, response.status, payload))
      }
      if (!isJson(contentType)) {
        return this.generatedMedia.stage(values.projectId, response, {
          mimeType: supportedResponseMime(contentType) ? contentType : fallbackMimeType(values),
          originalName: `ai-${connection.providerCode}-${Date.now()}`,
        })
      }
      const payload = await readJson(response)
      const direct = await this.extractPayload(payload, connection, values, deadline)
      if (direct) return direct
      const state = firstText(payload, ['status', 'state'])?.toLowerCase()
      if (FAILED_STATES.has(state)) {
        throw new Error(state === 'expired' ? '媒体任务已过期，请重新生成' : providerMessage(payload))
      }
      if (SUCCESS_STATES.has(state)) {
        if (usesGrokJsonVideoProtocol(connection)) {
          throw new Error('Grok 视频任务已完成，但响应中没有视频地址')
        }
        const contentResponse = await fetchWithDeadline(
          this.fetchImpl,
          `${statusUrl}/content`,
          {
            method: 'GET',
            redirect: 'manual',
            headers: {
              Accept:
                values.mediaType === 'VIDEO'
                  ? 'video/mp4,video/webm'
                  : 'audio/mpeg,audio/wav,audio/mp4,audio/aac,audio/ogg,audio/flac',
              ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}),
            },
          },
          deadline,
        )
        rejectRedirect(contentResponse)
        if (!contentResponse.ok)
          throw new Error(`媒体内容下载失败（HTTP ${contentResponse.status}）`)
        return this.generatedMedia.stage(values.projectId, contentResponse, {
          mimeType: contentResponse.headers?.get?.('content-type'),
          originalName: `ai-${connection.providerCode}-${Date.now()}`,
        })
      }
      if (state && !PENDING_STATES.has(state)) throw new Error(`媒体任务状态无法识别：${state}`)
    }
    throw new Error('本地媒体生成超时')
  }

  async extractPayload(payload, connection, values, deadline) {
    const node = resultNode(payload)
    const encoded = firstText(node, ['b64_json', 'b64_video', 'audio_base64', 'video_base64'])
    if (encoded) {
      const bytes = Buffer.from(encoded, 'base64')
      if (!bytes.length) throw new Error('媒体响应中的 Base64 无效')
      return this.generatedMedia.stage(values.projectId, bytes, {
        mimeType: firstText(node, ['mime_type', 'content_type']) || fallbackMimeType(values),
        originalName: `ai-${connection.providerCode}-${Date.now()}`,
      })
    }
    const remoteUrl = firstText(node, ['url', 'video_url', 'audio_url', 'download_url'])
    if (!remoteUrl) return null
    const safeUrl = await safeRemoteUrl(remoteUrl, connection.baseUrl)
    const response = await fetchWithDeadline(
      this.fetchImpl,
      safeUrl,
      {
        method: 'GET',
        redirect: 'manual',
        headers: {
          Accept:
            values.mediaType === 'VIDEO'
              ? 'video/mp4,video/webm,video/quicktime'
              : 'audio/mpeg,audio/wav,audio/mp4,audio/aac,audio/ogg,audio/flac',
        },
      },
      deadline,
    )
    rejectRedirect(response)
    if (!response.ok) throw new Error(`媒体结果下载失败（HTTP ${response.status}）`)
    return this.generatedMedia.stage(values.projectId, response, {
      mimeType: supportedResponseMime(normalizeMimeType(response.headers?.get?.('content-type')))
        ? response.headers?.get?.('content-type')
        : fallbackMimeType(values),
      originalName: `ai-${connection.providerCode}-${Date.now()}`,
    })
  }
}

function validateInput(input) {
  if (!input || typeof input !== 'object') throw new Error('本地媒体生成参数无效')
  const mediaType = requiredText(input.mediaType, '媒体类型', 16).toUpperCase()
  if (!['VIDEO', 'TTS'].includes(mediaType)) throw new Error('媒体类型仅支持 VIDEO 或 TTS')
  const durationSec = Number(input.durationSec)
  if (!Number.isInteger(durationSec) || durationSec < 1 || durationSec > 300)
    throw new Error('媒体时长超出允许范围')
  const timeoutMillis = Number(input.timeoutMillis || DEFAULT_TIMEOUT_MILLIS)
  if (!Number.isInteger(timeoutMillis) || timeoutMillis < 30_000 || timeoutMillis > 1_800_000) {
    throw new Error('媒体生成超时时间超出允许范围')
  }
  return {
    projectId: requiredText(input.projectId, '项目标识', 36),
    connectionId: requiredText(input.connectionId, '本地 AI 配置', 120),
    mediaType,
    prompt: requiredText(input.prompt, mediaType === 'VIDEO' ? '视频提示词' : '配音文本', 20_000),
    durationSec,
    inputAssetId: optionalText(input.inputAssetId, 36),
    referenceAssetIds: normalizeReferenceAssetIds(input.referenceAssetIds, input.inputAssetId),
    referenceImages: normalizeReferenceImages(input.referenceImages),
    voice: optionalText(input.voice, 120) || DEFAULT_VOICE_PRESET,
    responseFormat: optionalText(input.responseFormat, 20) || 'mp3',
    speed: normalizeSpeed(input.speed),
    size: optionalText(input.size, 20) || '720x1280',
    aspectRatio: normalizeAspectRatio(input.aspectRatio),
    timeoutMillis,
    parameters: normalizeParameters(input.parameters),
  }
}

function providerVoice(providerCode, requestedVoice) {
  if (!requestedVoice.startsWith('preset:')) return requestedVoice
  const voices =
    String(providerCode).trim().toUpperCase() === 'MINIMAX'
      ? MINIMAX_VOICES
      : OPENAI_COMPATIBLE_VOICES
  return voices[requestedVoice] || voices[DEFAULT_VOICE_PRESET]
}

function normalizeParameters(parameters) {
  if (parameters == null) return {}
  if (typeof parameters !== 'object' || Array.isArray(parameters)) throw new Error('媒体参数无效')
  const result = {}
  for (const [key, value] of Object.entries(parameters)) {
    if (
      ![
        'fps',
        'seed',
        'resolution',
        'instructions',
        'generate_audio',
        'reference_mode',
      ].includes(key)
    )
      continue
    if (!['string', 'number', 'boolean'].includes(typeof value))
      throw new Error(`媒体参数 ${key} 无效`)
    result[key] = value
  }
  return result
}

function normalizeReferenceAssetIds(referenceAssetIds, inputAssetId) {
  if (referenceAssetIds != null && !Array.isArray(referenceAssetIds)) {
    throw new Error('Grok 参考图片参数无效')
  }
  const values = referenceAssetIds?.length ? referenceAssetIds : inputAssetId ? [inputAssetId] : []
  const normalized = values.map((value) => requiredText(value, '参考图片标识', 36))
  const unique = [...new Set(normalized)]
  if (unique.length > MAX_GROK_REFERENCE_IMAGES) {
    throw new Error(`Grok 视频生成每次最多提交 ${MAX_GROK_REFERENCE_IMAGES} 张参考图片`)
  }
  return unique
}

function normalizeReferenceImages(referenceImages) {
  if (referenceImages == null) return []
  if (!Array.isArray(referenceImages)) throw new Error('Grok 参考图片参数无效')
  if (referenceImages.length > MAX_GROK_REFERENCE_IMAGES) {
    throw new Error(`Grok 视频生成每次最多提交 ${MAX_GROK_REFERENCE_IMAGES} 张参考图片`)
  }
  let totalBytes = 0
  return referenceImages.map((reference) => {
    if (!reference || typeof reference !== 'object') throw new Error('Grok 参考图片参数无效')
    const mimeType = optionalText(reference.mimeType, 80)?.toLowerCase()
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) {
      throw new Error('Grok 视频输入参考仅支持 PNG、JPEG 或 WebP 图片')
    }
    let bytes
    if (reference.bytes instanceof ArrayBuffer) bytes = Buffer.from(reference.bytes)
    else if (ArrayBuffer.isView(reference.bytes)) {
      bytes = Buffer.from(reference.bytes.buffer, reference.bytes.byteOffset, reference.bytes.byteLength)
    } else {
      throw new Error('Grok 参考图片内容无效')
    }
    if (!bytes.length || bytes.length > 10 * 1024 * 1024) {
      throw new Error('Grok 单张参考图片必须小于 10MB')
    }
    totalBytes += bytes.length
    if (totalBytes > 70 * 1024 * 1024) throw new Error('Grok 参考图片总大小不能超过 70MB')
    return { mimeType, bytes }
  })
}

function buildMediaEndpoint(baseUrl, endpointPath, mediaType) {
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
  if (endpointPath) return new URL(endpointPath.replace(/^\/+/, ''), base).toString()
  const path = mediaType === 'VIDEO' ? 'videos' : 'audio/speech'
  const defaultPath = base.pathname.replace(/\/+$/, '').endsWith('/v1') ? path : `v1/${path}`
  return new URL(defaultPath, base).toString()
}

function buildMediaStatusEndpoint(endpoint, taskId, connection, mediaType) {
  const encodedTaskId = encodeURIComponent(taskId)
  if (mediaType === 'VIDEO' && usesGrokJsonVideoProtocol(connection)) {
    const url = new URL(endpoint)
    url.pathname = `${url.pathname.replace(/\/generations\/?$/i, '').replace(/\/+$/, '')}/${encodedTaskId}`
    url.search = ''
    url.hash = ''
    return url.toString()
  }
  return `${endpoint.replace(/\/+$/, '')}/${encodedTaskId}`
}

function usesGrokJsonVideoProtocol(connection) {
  const providerCode = String(connection?.providerCode || '')
    .trim()
    .toUpperCase()
  if (providerCode === 'XAI' || providerCode === 'GROK') return true
  try {
    return new URL(connection?.baseUrl).hostname.toLowerCase() === 'api.x.ai'
  } catch {
    return false
  }
}

function normalizeGrokVideoEndpoint(endpoint, connection, mediaType) {
  if (mediaType !== 'VIDEO') return endpoint
  if (String(connection?.providerCode || '').trim().toUpperCase() !== 'GROK') return endpoint
  const url = new URL(endpoint)
  if (url.pathname.replace(/\/+$/, '').toLowerCase().endsWith('/videos')) {
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/generations`
  }
  return url.toString()
}

function xaiResolution(requestedResolution, size) {
  const requested = String(requestedResolution || '').trim().toLowerCase()
  if (['480p', '720p', '1080p'].includes(requested)) return requested
  const dimensions = String(size || '')
    .toLowerCase()
    .match(/^(\d{3,4})x(\d{3,4})$/)
  if (!dimensions) return '720p'
  const shortestEdge = Math.min(Number(dimensions[1]), Number(dimensions[2]))
  if (shortestEdge >= 1080) return '1080p'
  if (shortestEdge <= 480) return '480p'
  return '720p'
}

async function fetchWithDeadline(fetchImpl, url, options, deadline) {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new Error('本地媒体生成超时')
  const controller = new globalThis.AbortController()
  const timeout = globalThis.setTimeout(() => controller.abort(), remaining)
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal })
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('本地媒体生成超时')
    throw error
  } finally {
    globalThis.clearTimeout(timeout)
  }
}

async function readJson(response) {
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > MAX_JSON_BYTES) throw new Error('媒体服务 JSON 响应过大')
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error('媒体服务返回的 JSON 无法解析')
  }
}

function resultNode(payload) {
  return findMediaResultNode(payload) || payload || {}
}

function findMediaResultNode(node, depth = 0) {
  if (!node || depth > 6) return null
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findMediaResultNode(item, depth + 1)
      if (found) return found
    }
    return null
  }
  if (typeof node !== 'object') return null
  if (
    firstText(node, [
      'b64_json',
      'b64_video',
      'audio_base64',
      'video_base64',
      'url',
      'video_url',
      'audio_url',
      'download_url',
    ])
  ) {
    return node
  }
  for (const field of ['data', 'output', 'result', 'content', 'video', 'audio', 'video_url', 'audio_url']) {
    const found = findMediaResultNode(node[field], depth + 1)
    if (found) return found
  }
  return null
}

function firstText(node, fields) {
  for (const field of fields) {
    if (typeof node?.[field] === 'string' && node[field].trim()) return node[field].trim()
  }
  return null
}

function rejectRedirect(response) {
  if (response.status >= 300 && response.status < 400)
    throw new Error('媒体服务返回重定向，已按安全策略拒绝')
}

function providerError(mediaType, status, payload) {
  return `${mediaType === 'VIDEO' ? '视频' : '配音'}调用失败（HTTP ${status}）：${providerMessage(payload)}`
}

function providerMessage(payload) {
  return String(payload?.error?.message || payload?.message || '服务返回错误').slice(0, 500)
}

function isJson(contentType) {
  return contentType === 'application/json' || contentType.endsWith('+json')
}

function normalizeMimeType(value) {
  return String(value || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase()
}

function supportedResponseMime(value) {
  return value.startsWith('video/') || value.startsWith('audio/')
}

function fallbackMimeType(values) {
  if (values.mediaType === 'VIDEO') return 'video/mp4'
  return (
    {
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      aac: 'audio/aac',
      opus: 'audio/ogg',
      flac: 'audio/flac',
    }[values.responseFormat] || 'audio/mpeg'
  )
}

function normalizeSpeed(value) {
  if (value == null) return 1
  const speed = Number(value)
  if (!Number.isFinite(speed) || speed < 0.25 || speed > 4) throw new Error('配音语速超出允许范围')
  return speed
}

function normalizeAspectRatio(value) {
  const normalized = optionalText(value, 8) || '9:16'
  if (!['9:16', '16:9'].includes(normalized)) throw new Error('视频比例仅支持 9:16 或 16:9')
  return normalized
}

function requiredText(value, fieldName, maximum) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${fieldName}不能为空`)
  const normalized = value.trim()
  if (normalized.length > maximum) throw new Error(`${fieldName}过长`)
  return normalized
}

function optionalText(value, maximum) {
  if (value == null || value === '') return null
  const normalized = String(value).trim()
  if (!normalized) return null
  if (normalized.length > maximum) throw new Error('可选参数过长')
  return normalized
}

function redact(error, secret) {
  if (!(error instanceof Error) || !secret) return error
  return new Error(error.message.split(secret).join('[REDACTED]'))
}

function delay(milliseconds) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds))
}

module.exports = {
  LocalMediaGenerationService,
  buildMediaEndpoint,
  buildMediaStatusEndpoint,
  providerVoice,
  validateInput,
  xaiResolution,
}
