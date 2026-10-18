const { createHash } = require('node:crypto')
const { spawn } = require('node:child_process')
const fs = require('node:fs/promises')
const path = require('node:path')
const { app } = require('electron')

const DEFAULT_CHANNEL = 'STABLE'
const DEFAULT_PLATFORM = 'WIN_X64'
const MAX_INSTALLER_BYTES = 1024 * 1024 * 1024
const UPDATE_CHECK_TIMEOUT_MS = 15_000
const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000

class DesktopUpdaterService {
  constructor({ apiOrigin, fetchImpl = globalThis.fetch }) {
    if (!apiOrigin) throw new Error('apiOrigin is required')
    if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required')
    this.apiOrigin = String(apiOrigin).replace(/\/+$/, '')
    this.fetchImpl = fetchImpl
    this.activeDownload = null
  }

  currentVersion() {
    return app.getVersion()
  }

  async checkForUpdate(input = {}) {
    const currentVersion = sanitizeVersion(input.currentVersion || this.currentVersion())
    const channel = sanitizeToken(input.channel || DEFAULT_CHANNEL, 'channel', 16)
    const platform = sanitizeToken(input.platform || DEFAULT_PLATFORM, 'platform', 16)
    const url =
      `${this.apiOrigin}/api/v1/desktop-releases/latest` +
      `?currentVersion=${encodeURIComponent(currentVersion)}` +
      `&channel=${encodeURIComponent(channel)}` +
      `&platform=${encodeURIComponent(platform)}`
    const controller = new globalThis.AbortController()
    const timeout = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS)
    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      })
      if (response.status >= 300 && response.status < 400) {
        throw new Error('更新检查发生重定向，已按安全策略拒绝')
      }
      const payload = await readJson(response)
      if (!response.ok)
        throw new Error(payload?.message || `更新检查失败（HTTP ${response.status}）`)
      const data = payload?.data ?? payload
      return {
        updateAvailable: Boolean(data?.updateAvailable),
        mandatory: Boolean(data?.mandatory),
        currentVersion: data?.currentVersion || currentVersion,
        latest: data?.latest
          ? {
              id: String(data.latest.id),
              versionName: String(data.latest.versionName),
              versionCode: Number(data.latest.versionCode) || 0,
              channel: String(data.latest.channel || channel),
              platform: String(data.latest.platform || platform),
              title: String(data.latest.title || ''),
              releaseNotes: data.latest.releaseNotes ? String(data.latest.releaseNotes) : '',
              mandatory: Boolean(data.latest.mandatory),
              sizeBytes: Number(data.latest.sizeBytes) || 0,
              sha256: String(data.latest.sha256 || ''),
              fileName: String(data.latest.fileName || 'AI-Drama-Studio-setup.exe'),
              publishedAt: data.latest.publishedAt ? String(data.latest.publishedAt) : null,
            }
          : null,
      }
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('更新检查超时，请检查网络后重试')
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  async downloadAndInstall(input = {}, onProgress) {
    if (this.activeDownload) throw new Error('已有更新下载正在进行')
    if (process.platform !== 'win32') throw new Error('当前仅支持 Windows 客户端自动更新')
    const releaseId = requiredText(input.releaseId, 'releaseId', 36)
    const expectedSha256 = requiredText(input.sha256, 'sha256', 64).toLowerCase()
    const expectedSize = Number(input.sizeBytes || 0)
    if (!Number.isFinite(expectedSize) || expectedSize <= 0 || expectedSize > MAX_INSTALLER_BYTES) {
      throw new Error('安装包大小无效')
    }
    const fileName = safeFileName(input.fileName || `AI-Drama-Studio-${releaseId}.exe`)
    const downloadDir = path.join(app.getPath('temp'), 'ai-drama-studio-updates')
    const targetPath = path.join(downloadDir, fileName)
    const temporaryPath = `${targetPath}.${Date.now()}.partial`
    const controller = new globalThis.AbortController()
    const operation = { controller, targetPath }
    this.activeDownload = operation
    let idleTimeout = null
    let idleTimedOut = false
    const armIdleTimeout = () => {
      clearTimeout(idleTimeout)
      idleTimeout = setTimeout(() => {
        idleTimedOut = true
        controller.abort()
      }, DOWNLOAD_IDLE_TIMEOUT_MS)
    }

    try {
      await fs.mkdir(downloadDir, { recursive: true })
      armIdleTimeout()
      report(onProgress, {
        stage: 'DOWNLOADING',
        progress: 0,
        receivedBytes: 0,
        totalBytes: expectedSize,
      })
      const response = await this.fetchImpl(
        `${this.apiOrigin}/api/v1/desktop-releases/${encodeURIComponent(releaseId)}/download`,
        {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            Accept: 'application/octet-stream,application/vnd.microsoft.portable-executable',
          },
        },
      )
      if (response.status >= 300 && response.status < 400) {
        throw new Error('安装包下载发生重定向，已按安全策略拒绝')
      }
      if (!response.ok) throw new Error(`安装包下载失败（HTTP ${response.status}）`)
      const declared = Number(response.headers?.get?.('content-length') || expectedSize)
      if (declared > MAX_INSTALLER_BYTES) throw new Error('安装包超过 1GB 上限')
      const headerSha = String(response.headers?.get?.('x-file-sha256') || '').toLowerCase()
      if (headerSha && headerSha !== expectedSha256) {
        throw new Error('安装包校验信息不匹配')
      }

      const digest = createHash('sha256')
      let received = 0
      const reader = response.body?.getReader?.()
      if (reader) {
        const file = await fs.open(temporaryPath, 'w')
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            if (!value?.length) continue
            armIdleTimeout()
            received += value.length
            if (
              received > MAX_INSTALLER_BYTES ||
              (expectedSize > 0 && received > expectedSize + 1024 * 1024)
            ) {
              throw new Error('安装包下载大小异常')
            }
            digest.update(value)
            await file.write(Buffer.from(value))
            const progress =
              expectedSize > 0 ? Math.min(99, Math.floor((received / expectedSize) * 100)) : 0
            report(onProgress, {
              stage: 'DOWNLOADING',
              progress,
              receivedBytes: received,
              totalBytes: expectedSize || declared || received,
            })
          }
        } finally {
          await file.close()
        }
      } else {
        // Fallback for environments without web streams.
        const buffer = Buffer.from(await response.arrayBuffer())
        armIdleTimeout()
        received = buffer.length
        if (received > MAX_INSTALLER_BYTES) throw new Error('安装包超过 1GB 上限')
        digest.update(buffer)
        await fs.writeFile(temporaryPath, buffer)
        report(onProgress, {
          stage: 'DOWNLOADING',
          progress: 99,
          receivedBytes: received,
          totalBytes: expectedSize || received,
        })
      }

      const actualSha = digest.digest('hex')
      if (actualSha !== expectedSha256) {
        throw new Error('安装包下载完成但校验失败，已取消安装')
      }
      if (expectedSize > 0 && received !== expectedSize) {
        throw new Error('安装包大小与发布信息不一致')
      }
      await fs.rename(temporaryPath, targetPath)
      report(onProgress, {
        stage: 'INSTALLING',
        progress: 100,
        receivedBytes: received,
        totalBytes: expectedSize || received,
      })

      clearTimeout(idleTimeout)
      await launchInstaller(targetPath)
      // Give installer a moment to start, then quit so files can be replaced.
      setTimeout(() => {
        app.quit()
      }, 800)
      return {
        installerPath: targetPath,
        sha256: actualSha,
        sizeBytes: received,
      }
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => {})
      if (error?.name === 'AbortError') {
        throw new Error(idleTimedOut ? '更新下载超时，请检查网络后重试' : '更新下载已取消')
      }
      throw error
    } finally {
      clearTimeout(idleTimeout)
      if (this.activeDownload === operation) this.activeDownload = null
    }
  }

  cancelDownload() {
    if (!this.activeDownload) return false
    this.activeDownload.controller.abort()
    return true
  }
}

function launchInstaller(installerPath) {
  return new Promise((resolve, reject) => {
    // NSIS: /S can silent-install, but keep interactive so user can confirm path.
    const child = spawn(installerPath, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

function report(onProgress, payload) {
  if (typeof onProgress === 'function') onProgress(payload)
}

async function readJson(response) {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('更新服务返回了无法解析的响应')
  }
}

function sanitizeVersion(value) {
  const text = String(value || '0.0.0').trim()
  if (!/^[0-9A-Za-z.+-]{1,32}$/.test(text)) throw new Error('当前版本号无效')
  return text
}

function sanitizeToken(value, fieldName, maximum) {
  const text = String(value || '')
    .trim()
    .toUpperCase()
  if (!text || text.length > maximum || !/^[A-Z0-9_]+$/.test(text)) {
    throw new Error(`${fieldName}无效`)
  }
  return text
}

function requiredText(value, fieldName, maximum) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${fieldName}不能为空`)
  const normalized = value.trim()
  if (normalized.length > maximum) throw new Error(`${fieldName}过长`)
  return normalized
}

function safeFileName(value) {
  const base = path
    .basename(String(value || 'AI-Drama-Studio-setup.exe'))
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
  return base.toLowerCase().endsWith('.exe') ? base.slice(0, 180) : `${base.slice(0, 176)}.exe`
}

module.exports = {
  DesktopUpdaterService,
  MAX_INSTALLER_BYTES,
  UPDATE_CHECK_TIMEOUT_MS,
  DOWNLOAD_IDLE_TIMEOUT_MS,
}
