const { createHash, randomUUID } = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { assertExistingInside, safeSegment } = require('./local-workspace.cjs')

const execFileAsync = promisify(execFile)
const MAX_VIDEO_BYTES = 512 * 1024 * 1024
const MAX_AUDIO_BYTES = 100 * 1024 * 1024
const MEDIA_TYPES = Object.freeze({
  'video/mp4': { extension: '.mp4', category: 'videos', type: 'VIDEO' },
  'video/webm': { extension: '.webm', category: 'videos', type: 'VIDEO' },
  'video/quicktime': { extension: '.mov', category: 'videos', type: 'VIDEO' },
  'audio/mpeg': { extension: '.mp3', category: 'audio', type: 'TTS' },
  'audio/wav': { extension: '.wav', category: 'audio', type: 'TTS' },
  'audio/x-wav': { extension: '.wav', category: 'audio', type: 'TTS' },
  'audio/mp4': { extension: '.m4a', category: 'audio', type: 'TTS' },
  'audio/aac': { extension: '.aac', category: 'audio', type: 'TTS' },
  'audio/ogg': { extension: '.ogg', category: 'audio', type: 'TTS' },
  'audio/flac': { extension: '.flac', category: 'audio', type: 'TTS' },
})
const CANDIDATE_ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/
const RETRYABLE_DOWNLOAD_STATUSES = new Set([429, 500, 502, 503, 504])
const DOWNLOAD_RETRY_DELAYS_MS = [700, 1_800]

class GeneratedMediaStore {
  constructor({ workspace, ffprobePath = 'ffprobe' }) {
    if (!workspace) throw new Error('workspace is required')
    this.workspace = workspace
    this.ffprobePath = ffprobePath
  }

  async stage(projectId, source, input = {}) {
    const projectDirectory = await workspaceProjectDirectory(this.workspace, projectId)
    const directory = path.join(projectDirectory, 'cache', 'generated-media')
    await fs.mkdir(directory, { recursive: true })
    await assertExistingInside(projectDirectory, directory)
    const candidateId = randomUUID()
    const temporaryPath = path.join(directory, `${candidateId}.partial`)
    let mediaPath
    let metadataPath
    const declaredMimeType = normalizeMimeType(input.mimeType)
    let result
    try {
      result = await writeSource(temporaryPath, source, declaredMimeType)
      const mimeType = result.mimeType
      const metadata = await probeMedia(temporaryPath, mimeType, this.ffprobePath)
      const type = MEDIA_TYPES[mimeType]
      const baseName = safeSegment(input.originalName || 'ai-generated-media', 'ai-generated-media')
      const originalName = `${path.parse(baseName).name.slice(0, 80) || 'ai-generated-media'}${type.extension}`
      const mediaFile = `${path.parse(originalName).name}-${candidateId.slice(0, 8)}${type.extension}`
      mediaPath = path.join(directory, mediaFile)
      metadataPath = path.join(directory, `${candidateId}.json`)
      await fs.rename(temporaryPath, mediaPath)
      const candidate = {
        id: candidateId,
        projectId,
        originalName,
        mimeType,
        sizeBytes: result.sizeBytes,
        sha256: result.sha256,
        durationMs: Math.max(1, Math.round(metadata.duration * 1000)),
        width: metadata.width,
        height: metadata.height,
        createdAt: new Date().toISOString(),
        mediaFile,
      }
      await writeJsonAtomic(metadataPath, candidate)
      return publicCandidate(candidate)
    } catch (error) {
      await Promise.all([
        fs.rm(temporaryPath, { force: true }),
        mediaPath ? fs.rm(mediaPath, { force: true }) : Promise.resolve(),
        metadataPath ? fs.rm(metadataPath, { force: true }) : Promise.resolve(),
      ])
      throw error
    }
  }

  async resolve(projectId, candidateId) {
    validateCandidateId(candidateId)
    const projectDirectory = await workspaceProjectDirectory(this.workspace, projectId)
    const directory = path.join(projectDirectory, 'cache', 'generated-media')
    await assertExistingInside(projectDirectory, directory)
    const metadataPath = path.join(directory, `${candidateId}.json`)
    const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'))
    validateMetadata(metadata, projectId, candidateId)
    const mediaPath = path.join(directory, metadata.mediaFile)
    const realPath = await assertExistingInside(projectDirectory, mediaPath)
    const stat = await fs.stat(realPath)
    if (!stat.isFile() || stat.size !== metadata.sizeBytes) throw new Error('生成媒体候选文件已损坏')
    return { candidate: publicCandidate(metadata), path: realPath }
  }

  async discard(projectId, candidateId) {
    const resolved = await this.resolve(projectId, candidateId)
    const projectDirectory = await workspaceProjectDirectory(this.workspace, projectId)
    const directory = path.join(projectDirectory, 'cache', 'generated-media')
    await Promise.all([
      fs.rm(resolved.path, { force: true }),
      fs.rm(path.join(directory, `${candidateId}.json`), { force: true }),
    ])
  }

  async promote(projectId, candidateId) {
    const resolved = await this.resolve(projectId, candidateId)
    const category = MEDIA_TYPES[resolved.candidate.mimeType].category
    const [asset] = await this.workspace.importFiles(projectId, category, [resolved.path])
    return asset
  }

  async downloadAndPromote({ projectId, candidateId, category, accessToken, fetchImpl = globalThis.fetch, apiOrigin }) {
    validateCandidateId(candidateId)
    if (!['audio', 'videos'].includes(category)) throw new Error('生成媒体保存分类无效')
    if (typeof accessToken !== 'string' || !accessToken.trim() || accessToken.length > 8192) {
      throw new Error('登录状态无效，无法下载平台媒体')
    }
    const response = await fetchPlatformMediaResponse({
      url: `${String(apiOrigin).replace(/\/+$/, '')}/api/v1/media-candidates/${encodeURIComponent(candidateId)}/content`,
      accessToken,
      fetchImpl,
    })
    const maximumBytes = category === 'audio' ? MAX_AUDIO_BYTES : MAX_VIDEO_BYTES
    const maximumLabel = category === 'audio' ? '100MB' : '512MB'
    const declared = Number(response.headers?.get?.('content-length') || 0)
    if (declared > maximumBytes) throw new Error(`平台媒体超过 ${maximumLabel} 上限`)
    const staged = await this.stage(projectId, response, {
      mimeType: response.headers?.get?.('content-type'),
      originalName: `platform-${candidateId}`,
    })
    if (MEDIA_TYPES[staged.mimeType].category !== category) throw new Error('平台媒体类型与保存分类不匹配')
    return this.promote(projectId, staged.id)
  }
}

async function workspaceProjectDirectory(workspace, projectId) {
  if (typeof workspace.getProjectDirectory === 'function') {
    return workspace.getProjectDirectory(projectId)
  }
  return (await workspace.getProject(projectId)).directory
}

async function fetchPlatformMediaResponse({
  url,
  accessToken,
  fetchImpl = globalThis.fetch,
  retryDelays = DOWNLOAD_RETRY_DELAYS_MS,
  sleepImpl = sleep,
}) {
  let lastError
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          // Keep JSON in Accept so backend error envelopes are readable by the desktop client.
          Accept: 'video/mp4,video/webm,video/quicktime,audio/mpeg,audio/wav,audio/mp4,audio/aac,audio/ogg,audio/flac,application/json',
          Authorization: `Bearer ${accessToken}`,
        },
      })
      if (response.status >= 300 && response.status < 400) {
        await cancelResponse(response)
        throw new Error('平台媒体下载发生重定向，已按安全策略拒绝')
      }
      if (response.ok) return response
      const detail = await readResponseError(response)
      const failure = new Error(
        `平台媒体下载失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`,
      )
      if (!RETRYABLE_DOWNLOAD_STATUSES.has(response.status) || attempt >= retryDelays.length) {
        throw failure
      }
      lastError = failure
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes('重定向') || error.message.includes('HTTP 4'))
      ) {
        throw error
      }
      lastError = error
      if (attempt >= retryDelays.length) throw error
    }
    await sleepImpl(retryDelays[attempt])
  }
  throw lastError instanceof Error ? lastError : new Error('平台媒体下载失败')
}

async function readResponseError(response) {
  const text = (await readLimitedText(response, 16 * 1024)).trim()
  if (!text) return ''
  try {
    const payload = JSON.parse(text)
    return String(
      payload?.message || payload?.error?.message || payload?.errorMessage || payload?.data?.message || '',
    )
      .replace(/\s+/g, ' ')
      .slice(0, 500)
  } catch {
    return text.replace(/\s+/g, ' ').slice(0, 500)
  }
}

async function readLimitedText(response, maximum) {
  if (!response?.body?.getReader) return ''
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (total < maximum) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value?.length) continue
      const remaining = maximum - total
      const chunk = value.length > remaining ? value.subarray(0, remaining) : value
      chunks.push(chunk)
      total += chunk.length
      if (chunk.length < value.length) break
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))))
}

async function cancelResponse(response) {
  await response?.body?.cancel?.().catch(() => undefined)
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function writeSource(filePath, source, declaredMimeType) {
  const handle = await fs.open(filePath, 'wx')
  const digest = createHash('sha256')
  let sizeBytes = 0
  const header = Buffer.alloc(16)
  let headerLength = 0
  try {
    const chunks = toAsyncIterable(source)
    for await (const chunk of chunks) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (!bytes.length) continue
      sizeBytes += bytes.length
      if (sizeBytes > MAX_VIDEO_BYTES) throw new Error('生成媒体大小超出允许范围')
      digest.update(bytes)
      if (headerLength < header.length) {
        const copied = Math.min(bytes.length, header.length - headerLength)
        bytes.copy(header, headerLength, 0, copied)
        headerLength += copied
      }
      await handle.write(bytes)
    }
    const mimeType = detectMimeType(header, headerLength, declaredMimeType)
    if (!mimeType) throw new Error('生成结果不是受支持的视频或音频')
    if (MEDIA_TYPES[mimeType].type === 'TTS' && sizeBytes > MAX_AUDIO_BYTES) {
      throw new Error('生成音频超过 100MB 上限')
    }
    return { mimeType, sizeBytes, sha256: digest.digest('hex') }
  } finally {
    await handle.close()
  }
}

async function* toAsyncIterable(source) {
  if (Buffer.isBuffer(source) || source instanceof Uint8Array) {
    yield source
    return
  }
  if (source?.body?.getReader) {
    const reader = source.body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        yield value
      }
    } finally {
      reader.releaseLock()
    }
    return
  }
  if (source?.pipe) {
    for await (const chunk of source) yield chunk
    return
  }
  throw new Error('媒体响应流无效')
}

async function probeMedia(filePath, mimeType, ffprobePath) {
  try {
    const { stdout } = await execFileAsync(
      ffprobePath,
      ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', filePath],
      { timeout: 30_000, windowsHide: true, maxBuffer: 1024 * 1024 },
    )
    const payload = JSON.parse(stdout)
    const formatDuration = Number(payload?.format?.duration)
    const stream = payload?.streams?.find((item) => item.codec_type === (mimeType.startsWith('video/') ? 'video' : 'audio'))
    const duration = Number(stream?.duration || formatDuration)
    if (!Number.isFinite(duration) || duration <= 0 || duration > 300) throw new Error('媒体时长超出允许范围')
    const width = Number.isInteger(stream?.width) ? stream.width : null
    const height = Number.isInteger(stream?.height) ? stream.height : null
    if (mimeType.startsWith('video/') && (!width || !height || width > 8192 || height > 8192)) {
      throw new Error('视频尺寸无法安全识别')
    }
    return { duration, width, height }
  } catch (error) {
    throw new Error(error instanceof Error && error.message ? error.message : '媒体无法安全解析')
  }
}

function detectMimeType(header, length, declared) {
  const normalized = normalizeMimeType(declared)
  if (MEDIA_TYPES[normalized] && matchesSignature(header, length, normalized)) return normalized
  for (const mimeType of Object.keys(MEDIA_TYPES)) {
    if (matchesSignature(header, length, mimeType)) return mimeType
  }
  return null
}

function matchesSignature(header, length, mimeType) {
  const ascii = header.subarray(0, length).toString('latin1')
  if (mimeType === 'video/mp4' || mimeType === 'video/quicktime' || mimeType === 'audio/mp4') return length >= 8 && ascii.slice(4, 8) === 'ftyp'
  if (mimeType === 'video/webm') return length >= 4 && header.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex'))
  if (mimeType === 'audio/mpeg') return ascii.startsWith('ID3') || (length >= 2 && header[0] === 0xff && (header[1] & 0xe0) === 0xe0)
  if (mimeType === 'audio/wav' || mimeType === 'audio/x-wav') return length >= 12 && ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE'
  if (mimeType === 'audio/aac') return length >= 2 && header[0] === 0xff && (header[1] & 0xf6) === 0xf0
  if (mimeType === 'audio/ogg') return ascii.startsWith('OggS')
  return mimeType === 'audio/flac' && ascii.startsWith('fLaC')
}

function normalizeMimeType(value) {
  return String(value || '').split(';', 1)[0].trim().toLowerCase()
}

function validateCandidateId(value) {
  if (typeof value !== 'string' || !CANDIDATE_ID_PATTERN.test(value)) throw new Error('生成候选标识无效')
}

function validateMetadata(metadata, projectId, candidateId) {
  if (!metadata || metadata.id !== candidateId || metadata.projectId !== projectId || !MEDIA_TYPES[metadata.mimeType] || typeof metadata.mediaFile !== 'string' || path.basename(metadata.mediaFile) !== metadata.mediaFile) {
    throw new Error('生成媒体元数据无效')
  }
}

function publicCandidate(candidate) {
  const values = { ...candidate }
  delete values.mediaFile
  return values
}

async function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
    await fs.rename(temporary, filePath)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

module.exports = {
  GeneratedMediaStore,
  MEDIA_TYPES,
  detectMimeType,
  fetchPlatformMediaResponse,
  probeMedia,
}
