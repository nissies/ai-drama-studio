const { randomUUID } = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')

const EXPORT_JOBS_FILE = 'export-jobs.json'
const MAX_EXPORT_JOBS = 500
const MAX_EXPORT_FILE_BYTES = 8 * 1024 * 1024
const LOCAL_EXPORT_ID_PATTERN = /^local-export-[A-Za-z0-9-]{8,80}$/
const FINAL_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'CANCELED'])

class LocalExportJobStore {
  constructor({ workspace }) {
    if (!workspace) throw new Error('workspace is required')
    this.workspace = workspace
    this.projectQueues = new Map()
  }

  async create(projectId, episodeId, input, idempotencyKey) {
    return this.withProjectLock(projectId, async () => {
      const state = await this.readState(projectId)
      const normalizedKey = requiredString(idempotencyKey, '导出幂等标识', 120)
      const existing = state.jobs.find((item) => item.idempotencyKey === normalizedKey)
      if (existing) return publicJob(existing)

      const now = new Date().toISOString()
      const job = {
        id: `local-export-${randomUUID()}`,
        projectId,
        episodeId: requiredString(episodeId, '分集标识', 120),
        idempotencyKey: normalizedKey,
        request: normalizeRequest(input),
        status: 'WAITING_LOCAL',
        stage: null,
        progress: 0,
        currentShotNo: null,
        clientExportId: null,
        outputAssetId: null,
        outputFilename: null,
        errorCode: null,
        errorMessage: null,
        version: 0,
        createdAt: now,
        updatedAt: now,
        finishedAt: null,
      }
      state.jobs.push(job)
      pruneJobs(state)
      await this.writeState(projectId, state)
      return publicJob(job)
    })
  }

  async list(projectId, episodeId) {
    const state = await this.readState(projectId)
    return state.jobs
      .filter((item) => item.episodeId === episodeId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(publicJob)
  }

  async get(jobId) {
    const located = await this.findJob(jobId)
    return publicJob(located.job)
  }

  async update(jobId, action, input = {}) {
    const located = await this.findJob(jobId)
    return this.withProjectLock(located.projectId, async () => {
      const state = await this.readState(located.projectId)
      const index = state.jobs.findIndex((item) => item.id === jobId)
      if (index < 0) throw new Error('本地导出任务不存在')
      const updated = transitionJob(state.jobs[index], action, input)
      state.jobs[index] = updated
      state.updatedAt = updated.updatedAt
      await this.writeState(located.projectId, state)
      return publicJob(updated)
    })
  }

  async findJob(jobId) {
    validateJobId(jobId)
    const settings = await this.workspace.getSettings()
    for (const projectId of Object.keys(settings.projects || {})) {
      try {
        const state = await this.readState(projectId)
        const job = state.jobs.find((item) => item.id === jobId)
        if (job) return { projectId, job }
      } catch {
        // A damaged or removed project must not hide jobs from healthy projects.
      }
    }
    throw new Error('本地导出任务不存在')
  }

  async readState(projectId) {
    const project = await this.workspace.getProject(projectId)
    const filePath = path.join(project.directory, EXPORT_JOBS_FILE)
    try {
      const stat = await fs.stat(filePath)
      if (!stat.isFile() || stat.size > MAX_EXPORT_FILE_BYTES) throw new Error('本地导出任务文件无效')
      const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'))
      return normalizeState(parsed, projectId)
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyState(projectId)
      throw error
    }
  }

  async writeState(projectId, state) {
    const project = await this.workspace.getProject(projectId)
    const normalized = normalizeState(state, projectId)
    const text = `${JSON.stringify(normalized, null, 2)}\n`
    if (Buffer.byteLength(text) > MAX_EXPORT_FILE_BYTES) throw new Error('本地导出任务记录过大')
    const filePath = path.join(project.directory, EXPORT_JOBS_FILE)
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temporaryPath, text, { encoding: 'utf8', flag: 'wx' })
      await fs.rename(temporaryPath, filePath)
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }

  withProjectLock(projectId, operation) {
    const previous = this.projectQueues.get(projectId) || Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    this.projectQueues.set(projectId, current)
    return current.finally(() => {
      if (this.projectQueues.get(projectId) === current) this.projectQueues.delete(projectId)
    })
  }
}

function transitionJob(current, action, input) {
  const now = new Date().toISOString()
  const next = { ...current, updatedAt: now, version: current.version + 1 }
  if (action === 'START') {
    if (current.status !== 'WAITING_LOCAL') throw new Error('当前导出任务不能开始')
    next.status = 'RUNNING'
    next.stage = 'RENDERING'
    next.progress = Math.max(1, current.progress)
    next.clientExportId = requiredString(input.clientExportId, '客户端导出标识', 120)
    next.errorCode = null
    next.errorMessage = null
    next.finishedAt = null
  } else if (action === 'PROGRESS') {
    assertRunningClient(current, input.clientExportId)
    next.progress = clampInteger(input.progress, current.progress, 99)
    next.stage = ['RENDERING', 'CONCATENATING'].includes(input.stage) ? input.stage : current.stage
    next.currentShotNo = optionalPositiveInteger(input.shotNo)
  } else if (action === 'COMPLETE') {
    assertRunningClient(current, input.clientExportId)
    next.status = 'SUCCEEDED'
    next.stage = 'SUCCEEDED'
    next.progress = 100
    next.outputAssetId = requiredString(input.outputAssetId, '导出素材标识', 160)
    next.outputFilename = requiredString(input.outputFilename, '导出文件名', 255)
    next.finishedAt = now
  } else if (action === 'FAIL') {
    assertRunningClient(current, input.clientExportId)
    next.status = 'FAILED'
    next.errorCode = 'LOCAL_EXPORT_FAILED'
    next.errorMessage = requiredString(input.message, '失败原因', 1000)
    next.finishedAt = now
  } else if (action === 'CANCEL') {
    if (!['WAITING_LOCAL', 'RUNNING'].includes(current.status)) throw new Error('当前导出任务不能取消')
    next.status = 'CANCELED'
    next.finishedAt = now
  } else if (action === 'RETRY') {
    if (!['FAILED', 'CANCELED'].includes(current.status)) throw new Error('当前导出任务不能重试')
    next.status = 'WAITING_LOCAL'
    next.stage = null
    next.progress = 0
    next.currentShotNo = null
    next.clientExportId = null
    next.outputAssetId = null
    next.outputFilename = null
    next.errorCode = null
    next.errorMessage = null
    next.finishedAt = null
  } else {
    throw new Error('未知的本地导出任务操作')
  }
  return next
}

function assertRunningClient(job, clientExportId) {
  if (job.status !== 'RUNNING') throw new Error('本地导出任务未在执行')
  if (job.clientExportId !== clientExportId) throw new Error('客户端导出标识不匹配')
}

function normalizeRequest(input) {
  const settings = input?.settings || {}
  const shots = Array.isArray(input?.shots) ? input.shots : []
  if (!shots.length || shots.length > 500) throw new Error('导出镜头数量必须在 1 到 500 之间')
  return {
    outputName: requiredString(input?.outputName, '导出名称', 160),
    settings: {
      width: positiveInteger(settings.width, '导出宽度'),
      height: positiveInteger(settings.height, '导出高度'),
      fps: positiveInteger(settings.fps, '导出帧率'),
      crf: positiveInteger(settings.crf, '导出质量'),
      preset: requiredString(settings.preset, '导出预设', 20),
      subtitles: Boolean(settings.subtitles),
      bgmVolume: finiteNumber(settings.bgmVolume, '背景音乐音量'),
      sfxVolume: finiteNumber(settings.sfxVolume, '音效音量'),
    },
    shots: JSON.parse(JSON.stringify(shots)),
  }
}

function normalizeState(input, projectId) {
  if (!input || input.version !== 1 || input.projectId !== projectId || !Array.isArray(input.jobs)) {
    throw new Error('本地导出任务文件格式无效')
  }
  if (input.jobs.length > MAX_EXPORT_JOBS) throw new Error('本地导出任务数量超出限制')
  return {
    version: 1,
    projectId,
    updatedAt: String(input.updatedAt || new Date().toISOString()),
    jobs: input.jobs.map((job) => normalizeStoredJob(job, projectId)),
  }
}

function normalizeStoredJob(job, projectId) {
  validateJobId(job?.id)
  if (job.projectId !== projectId) throw new Error('本地导出任务项目不匹配')
  if (!['WAITING_LOCAL', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED'].includes(job.status)) {
    throw new Error('本地导出任务状态无效')
  }
  return { ...job, version: Number(job.version) || 0, progress: clampInteger(job.progress, 0, 100) }
}

function pruneJobs(state) {
  if (state.jobs.length <= MAX_EXPORT_JOBS) return
  const removable = state.jobs
    .filter((item) => FINAL_STATUSES.has(item.status))
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
  while (state.jobs.length > MAX_EXPORT_JOBS && removable.length) {
    const target = removable.shift()
    state.jobs = state.jobs.filter((item) => item.id !== target.id)
  }
  if (state.jobs.length > MAX_EXPORT_JOBS) throw new Error('本地进行中的导出任务过多')
}

function emptyState(projectId) {
  return { version: 1, projectId, updatedAt: new Date().toISOString(), jobs: [] }
}

function publicJob(job) {
  const result = { ...job }
  delete result.idempotencyKey
  delete result.request
  return result
}

function validateJobId(value) {
  if (typeof value !== 'string' || !LOCAL_EXPORT_ID_PATTERN.test(value)) throw new Error('本地导出任务标识无效')
}

function requiredString(value, label, maximum) {
  const normalized = String(value || '').trim()
  if (!normalized || normalized.length > maximum) throw new Error(`${label}无效`)
  return normalized
}

function positiveInteger(value, label) {
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${label}无效`)
  return number
}

function optionalPositiveInteger(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : null
}

function finiteNumber(value, label) {
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`${label}无效`)
  return number
}

function clampInteger(value, minimum, maximum) {
  const number = Number(value)
  if (!Number.isFinite(number)) return minimum
  return Math.max(minimum, Math.min(maximum, Math.round(number)))
}

module.exports = { LocalExportJobStore }
