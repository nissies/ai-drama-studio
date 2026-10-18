const crypto = require('node:crypto')
const { createReadStream, createWriteStream } = require('node:fs')
const fs = require('node:fs/promises')
const path = require('node:path')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')

const ASSETS = Object.freeze({
  'dwpose-model': Object.freeze({
    id: 'dwpose-model',
    label: 'DWPose 姿态模型',
    version: '1a7144101628d69ee7a3768d1ee3a094070dc388',
    fileName: 'dw-ll_ucoco_384.onnx',
    sizeBytes: 134399116,
    sha256: '724f4ff2439ed61afb86fb8a1951ec39c6220682803b4a8bd4f598cd913b1843',
    downloadUrl:
      'https://huggingface.co/yzd-v/DWPose/resolve/1a7144101628d69ee7a3768d1ee3a094070dc388/dw-ll_ucoco_384.onnx',
    sourceUrl: 'https://huggingface.co/yzd-v/DWPose',
    license: 'Apache-2.0',
  }),
})

const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000

class OptionalRuntimeAssetService {
  constructor({ appDataPath, fetchImpl = globalThis.fetch, assets = ASSETS }) {
    this.root = path.join(appDataPath, 'runtime-assets')
    this.fetch = fetchImpl
    this.assets = assets
    this.active = new Map()
  }

  async status(id) {
    const asset = requireAsset(id, this.assets)
    const filePath = this.filePath(asset)
    try {
      const stat = await fs.stat(filePath)
      if (!stat.isFile() || stat.size !== asset.sizeBytes) return publicStatus(asset, 'CORRUPT')
      const sha256 = await hashFile(filePath)
      return publicStatus(asset, sha256 === asset.sha256 ? 'READY' : 'CORRUPT')
    } catch (error) {
      if (error?.code === 'ENOENT') return publicStatus(asset, 'NOT_INSTALLED')
      throw error
    }
  }

  async install(id, onProgress = () => undefined) {
    const asset = requireAsset(id, this.assets)
    if (this.active.has(id)) throw new Error(`${asset.label}正在下载`)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('下载超时')), DOWNLOAD_TIMEOUT_MS)
    this.active.set(id, controller)
    const filePath = this.filePath(asset)
    const partialPath = `${filePath}.partial`
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await fs.rm(partialPath, { force: true })
      onProgress(progress(asset, 'DOWNLOADING', 0, 0))
      const response = await fetchTrusted(this.fetch, asset.downloadUrl, controller.signal)
      if (!response.ok || !response.body) throw new Error(`模型下载失败（HTTP ${response.status}）`)
      const declaredSize = Number(response.headers.get('content-length'))
      if (declaredSize && declaredSize !== asset.sizeBytes) throw new Error('模型文件大小与清单不一致')
      let receivedBytes = 0
      const hash = crypto.createHash('sha256')
      const meter = new TransformStream({
        transform(chunk, transformController) {
          receivedBytes += chunk.byteLength
          if (receivedBytes > asset.sizeBytes) throw new Error('模型文件超过清单大小')
          hash.update(chunk)
          onProgress(progress(asset, 'DOWNLOADING', receivedBytes, asset.sizeBytes))
          transformController.enqueue(chunk)
        },
      })
      await pipeline(
        Readable.fromWeb(response.body.pipeThrough(meter)),
        createWriteStream(partialPath, { flags: 'wx' }),
      )
      onProgress(progress(asset, 'VERIFYING', receivedBytes, asset.sizeBytes))
      if (receivedBytes !== asset.sizeBytes || hash.digest('hex') !== asset.sha256) {
        throw new Error('模型文件校验失败，已拒绝安装')
      }
      await fs.rm(filePath, { force: true })
      await fs.rename(partialPath, filePath)
      const result = publicStatus(asset, 'READY')
      onProgress({ ...progress(asset, 'SUCCEEDED', receivedBytes, asset.sizeBytes), status: result })
      return result
    } catch (error) {
      await fs.rm(partialPath, { force: true }).catch(() => undefined)
      if (controller.signal.aborted) throw new Error('模型下载已取消')
      throw error
    } finally {
      clearTimeout(timer)
      this.active.delete(id)
    }
  }

  cancel(id) {
    const controller = this.active.get(id)
    if (!controller) return false
    controller.abort()
    return true
  }

  async remove(id) {
    const asset = requireAsset(id, this.assets)
    if (this.active.has(id)) throw new Error('请先取消模型下载')
    await fs.rm(this.filePath(asset), { force: true })
    await fs.rm(`${this.filePath(asset)}.partial`, { force: true })
    return publicStatus(asset, 'NOT_INSTALLED')
  }

  async resolve(id) {
    const asset = requireAsset(id, this.assets)
    const status = await this.status(id)
    return status.state === 'READY' ? this.filePath(asset) : null
  }

  filePath(asset) {
    return path.join(this.root, asset.id, asset.fileName)
  }
}

function requireAsset(id, assets) {
  const asset = typeof id === 'string' ? assets[id] : null
  if (!asset) throw new Error('未知运行时资源')
  return asset
}

function publicStatus(asset, state) {
  return {
    id: asset.id,
    label: asset.label,
    version: asset.version,
    state,
    sizeBytes: asset.sizeBytes,
    sha256: asset.sha256,
    sourceUrl: asset.sourceUrl,
    license: asset.license,
  }
}

function progress(asset, stage, receivedBytes, totalBytes) {
  return {
    id: asset.id,
    stage,
    receivedBytes,
    totalBytes,
    progress: totalBytes ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100)) : 0,
  }
}

function assertTrustedDownloadUrl(value) {
  const url = new URL(value)
  const hostname = url.hostname.toLowerCase()
  const trusted =
    url.protocol === 'https:' &&
    (hostname === 'huggingface.co' || hostname.endsWith('.huggingface.co') || hostname.endsWith('.hf.co'))
  if (!trusted) throw new Error('模型下载被重定向到未受信任的地址')
}

async function fetchTrusted(fetchImpl, initialUrl, signal) {
  let currentUrl = initialUrl
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    assertTrustedDownloadUrl(currentUrl)
    const response = await fetchImpl(currentUrl, {
      redirect: 'manual',
      signal,
      headers: { 'user-agent': 'AI-Drama-Studio' },
    })
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    const location = response.headers.get('location')
    if (!location) throw new Error('模型下载重定向缺少目标地址')
    currentUrl = new URL(location, currentUrl).toString()
  }
  throw new Error('模型下载重定向次数过多')
}

async function hashFile(filePath) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

module.exports = { ASSETS, OptionalRuntimeAssetService, assertTrustedDownloadUrl, fetchTrusted }
