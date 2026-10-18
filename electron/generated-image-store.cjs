const { createHash, randomUUID } = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const sharp = require('sharp')
const { assertExistingInside, safeSegment } = require('./local-workspace.cjs')

const MAX_IMAGE_BYTES = 30 * 1024 * 1024
const MAX_IMAGE_PIXELS = 40_000_000
const CANDIDATE_ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/
const IMAGE_TYPES = Object.freeze({
  'image/png': { extension: '.png', signature: isPng },
  'image/jpeg': { extension: '.jpg', signature: isJpeg },
  'image/webp': { extension: '.webp', signature: isWebp },
})

class GeneratedImageStore {
  constructor({ workspace, fetchImpl = globalThis.fetch, apiOrigin }) {
    if (!workspace) throw new Error('workspace is required')
    if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required')
    if (!apiOrigin) throw new Error('apiOrigin is required')
    this.workspace = workspace
    this.fetchImpl = fetchImpl
    this.apiOrigin = apiOrigin.replace(/\/+$/, '')
  }

  async stage(projectId, bytes, input = {}) {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
    if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) {
      throw new Error('生成图片大小超出允许范围')
    }
    const mimeType = detectMimeType(buffer)
    if (input.mimeType && normalizeMimeType(input.mimeType) !== mimeType) {
      throw new Error('生成图片内容与响应类型不匹配')
    }
    const metadata = await imageMetadata(buffer)
    const projectDirectory = await workspaceProjectDirectory(this.workspace, projectId)
    const candidateId = input.candidateId || randomUUID()
    validateCandidateId(candidateId)
    const generatedDirectory = path.join(projectDirectory, 'cache', 'generated')
    await fs.mkdir(generatedDirectory, { recursive: true })
    await assertExistingInside(projectDirectory, generatedDirectory)
    const type = IMAGE_TYPES[mimeType]
    const baseName = safeSegment(input.originalName || 'ai-generated-image', 'ai-generated-image')
    const originalName = `${path.parse(baseName).name.slice(0, 80) || 'ai-generated-image'}${type.extension}`
    const imageFile = `${path.parse(originalName).name}-${candidateId.slice(0, 8)}${type.extension}`
    const imagePath = path.join(generatedDirectory, imageFile)
    const metadataPath = path.join(generatedDirectory, `${candidateId}.json`)
    const temporaryPath = `${imagePath}.${randomUUID()}.partial`
    const sha256 = createHash('sha256').update(buffer).digest('hex')
    const candidate = {
      id: candidateId,
      projectId,
      originalName,
      mimeType,
      sizeBytes: buffer.length,
      sha256,
      width: metadata.width,
      height: metadata.height,
      createdAt: new Date().toISOString(),
      imageFile,
    }
    try {
      await fs.writeFile(temporaryPath, buffer, { flag: 'wx' })
      const handle = await fs.open(temporaryPath, 'r+')
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
      await fs.rename(temporaryPath, imagePath)
      await writeJsonAtomic(metadataPath, candidate)
      return publicCandidate(candidate)
    } catch (error) {
      await Promise.all([
        fs.rm(temporaryPath, { force: true }),
        fs.rm(imagePath, { force: true }),
        fs.rm(metadataPath, { force: true }),
      ])
      throw error
    }
  }

  async resolve(projectId, candidateId) {
    validateCandidateId(candidateId)
    const projectDirectory = await workspaceProjectDirectory(this.workspace, projectId)
    const generatedDirectory = path.join(projectDirectory, 'cache', 'generated')
    await assertExistingInside(projectDirectory, generatedDirectory)
    const metadataPath = path.join(generatedDirectory, `${candidateId}.json`)
    const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'))
    validateMetadata(metadata, projectId, candidateId)
    const imagePath = path.join(generatedDirectory, metadata.imageFile)
    const realPath = await assertExistingInside(projectDirectory, imagePath)
    const stat = await fs.stat(realPath)
    if (!stat.isFile() || stat.size !== metadata.sizeBytes) throw new Error('生成候选文件已损坏')
    return { candidate: publicCandidate(metadata), path: realPath }
  }

  async discard(projectId, candidateId) {
    const resolved = await this.resolve(projectId, candidateId)
    const projectDirectory = await workspaceProjectDirectory(this.workspace, projectId)
    const generatedDirectory = path.join(projectDirectory, 'cache', 'generated')
    const metadata = JSON.parse(
      await fs.readFile(path.join(generatedDirectory, `${candidateId}.json`), 'utf8'),
    )
    validateMetadata(metadata, projectId, candidateId)
    await Promise.all([
      fs.rm(resolved.path, { force: true }),
      fs.rm(path.join(generatedDirectory, `${candidateId}.json`), { force: true }),
    ])
  }

  async promote(projectId, candidateId, category) {
    if (!['images', 'characters', 'scenes', 'storyboards'].includes(category)) {
      throw new Error('生成图片保存分类无效')
    }
    const resolved = await this.resolve(projectId, candidateId)
    const [asset] = await this.workspace.importFiles(projectId, category, [resolved.path])
    return asset
  }

  async downloadAndPromote({ projectId, candidateId, category, accessToken }) {
    const staged = await this.downloadToCache({ projectId, candidateId, accessToken })
    return this.promote(projectId, staged.id, category)
  }

  async downloadToCache({ projectId, candidateId, accessToken }) {
    validateCandidateId(candidateId)
    if (typeof accessToken !== 'string' || !accessToken.trim() || accessToken.length > 8192) {
      throw new Error('登录状态无效，无法下载平台图片')
    }
    try {
      return (await this.resolve(projectId, candidateId)).candidate
    } catch {
      // The platform candidate has not been cached on this device yet.
    }
    const response = await this.fetchImpl(
      `${this.apiOrigin}/api/v1/image-candidates/${encodeURIComponent(candidateId)}/content`,
      {
        method: 'GET',
        redirect: 'manual',
        headers: {
          // The content endpoint returns the same JSON envelope for expired or unavailable candidates.
          Accept: 'image/png,image/jpeg,image/webp,application/json',
          Authorization: `Bearer ${accessToken}`,
        },
      },
    )
    if (response.status >= 300 && response.status < 400) {
      await cancelResponse(response)
      throw new Error('平台图片下载发生重定向，已按安全策略拒绝')
    }
    if (!response.ok) {
      const detail = await readResponseError(response)
      throw new Error(`平台图片下载失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`)
    }
    const declared = Number(response.headers?.get?.('content-length') || 0)
    if (declared > MAX_IMAGE_BYTES) throw new Error('平台图片超过 30MB 上限')
    const bytes = await readLimited(response, MAX_IMAGE_BYTES)
    const staged = await this.stage(projectId, bytes, {
      candidateId,
      mimeType: response.headers?.get?.('content-type'),
      originalName: `platform-${candidateId}`,
    })
    return staged
  }
}

async function workspaceProjectDirectory(workspace, projectId) {
  if (typeof workspace.getProjectDirectory === 'function') {
    return workspace.getProjectDirectory(projectId)
  }
  return (await workspace.getProject(projectId)).directory
}

async function readLimited(response, maximum) {
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > maximum) throw new Error('图片超过允许的大小上限')
    return bytes
  }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maximum) throw new Error('图片超过允许的大小上限')
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks, total)
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
}

async function readResponseError(response) {
  const text = (await readLimitedText(response, 16 * 1024)).trim()
  if (!text) return ''
  try {
    const payload = JSON.parse(text)
    return String(
      payload?.message ||
        payload?.error?.message ||
        payload?.errorMessage ||
        payload?.data?.message ||
        '',
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

async function imageMetadata(buffer) {
  let metadata
  try {
    metadata = await sharp(buffer, { limitInputPixels: MAX_IMAGE_PIXELS }).metadata()
  } catch {
    throw new Error('生成图片无法安全解码')
  }
  if (
    !Number.isInteger(metadata.width) ||
    !Number.isInteger(metadata.height) ||
    metadata.width < 64 ||
    metadata.height < 64 ||
    metadata.width > 8192 ||
    metadata.height > 8192 ||
    metadata.width * metadata.height > MAX_IMAGE_PIXELS
  ) {
    throw new Error('生成图片尺寸超出允许范围')
  }
  return metadata
}

function detectMimeType(buffer) {
  for (const [mimeType, type] of Object.entries(IMAGE_TYPES)) {
    if (type.signature(buffer)) return mimeType
  }
  throw new Error('生成结果不是受支持的 PNG、JPEG 或 WebP 图片')
}

function normalizeMimeType(value) {
  return String(value || '').split(';', 1)[0].trim().toLowerCase()
}

function isPng(buffer) {
  return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
}
function isJpeg(buffer) {
  return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
}
function isWebp(buffer) {
  return (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  )
}

function validateCandidateId(candidateId) {
  if (typeof candidateId !== 'string' || !CANDIDATE_ID_PATTERN.test(candidateId)) {
    throw new Error('生成候选标识无效')
  }
}

function validateMetadata(metadata, projectId, candidateId) {
  if (
    !metadata ||
    metadata.id !== candidateId ||
    metadata.projectId !== projectId ||
    !IMAGE_TYPES[metadata.mimeType] ||
    typeof metadata.imageFile !== 'string' ||
    path.basename(metadata.imageFile) !== metadata.imageFile
  ) {
    throw new Error('生成候选元数据无效')
  }
}

function publicCandidate(candidate) {
  const publicValues = { ...candidate }
  delete publicValues.imageFile
  return publicValues
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

module.exports = { GeneratedImageStore, detectMimeType, readLimited }
