const { createHash, randomUUID } = require('node:crypto')
const { createReadStream, createWriteStream } = require('node:fs')
const fs = require('node:fs/promises')
const path = require('node:path')
const { Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')

const CATEGORY_DIRECTORIES = Object.freeze({
  images: 'assets/images',
  characters: 'assets/characters',
  scenes: 'assets/scenes',
  storyboards: 'assets/storyboards',
  audio: 'assets/audio',
  videos: 'assets/videos',
  exports: 'exports',
})

const CATEGORY_EXTENSIONS = Object.freeze({
  images: new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']),
  characters: new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']),
  scenes: new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']),
  storyboards: new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']),
  audio: new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac']),
  videos: new Set(['.mp4', '.mov', '.webm', '.mkv']),
  exports: new Set(['.mp4', '.mov', '.webm', '.mkv']),
})

const CATEGORY_SIZE_LIMITS = Object.freeze({
  images: 30 * 1024 * 1024,
  characters: 30 * 1024 * 1024,
  scenes: 30 * 1024 * 1024,
  storyboards: 30 * 1024 * 1024,
  audio: 500 * 1024 * 1024,
  videos: 2 * 1024 * 1024 * 1024,
  exports: 2 * 1024 * 1024 * 1024,
})

const PROJECT_DATA_FILE = 'project-data.json'
const LOCAL_GENERATION_FILE = 'local-generation.json'
const PROJECT_DATA_COLLECTIONS = Object.freeze([
  'episodes',
  'characters',
  'scenes',
  'storyboards',
  'storyboardOutputs',
  'characterReferences',
  'characterVoiceReferences',
  'sceneReferences',
  'sourceDocuments',
  'structureCandidates',
])
const OPTIONAL_PROJECT_DATA_COLLECTIONS = new Set(['sourceDocuments', 'structureCandidates'])
const MAX_PROJECT_DATA_BYTES = 256 * 1024 * 1024
const MAX_PROJECT_DATA_ITEMS = 100_000
const MAX_LOCAL_GENERATION_JOBS = 5_000
const MAX_LOCAL_GENERATION_BYTES = 64 * 1024 * 1024
const LOCAL_VIDEO_LAB_PROJECT_ID = '00000000-video-lab-workspace'
const MP3_SCAN_BYTES = 1024 * 1024

class LocalWorkspaceService {
  constructor({ appDataPath, documentsPath }) {
    if (!path.isAbsolute(appDataPath) || !path.isAbsolute(documentsPath)) {
      throw new Error('工作目录必须使用绝对路径')
    }
    this.appDataPath = appDataPath
    this.defaultWorkspaceRoot = path.join(documentsPath, '移光漫剧工坊')
    this.settingsPath = path.join(appDataPath, 'desktop-settings.json')
    this.projectQueues = new Map()
    this.settingsCache = null
    this.settingsLoadPromise = null
  }

  async getWorkspaceStatus() {
    const settings = await this.getSettings()
    await this.ensureDirectory(settings.workspaceRoot)
    const disk = await fs.statfs(settings.workspaceRoot)
    return {
      workspaceRoot: settings.workspaceRoot,
      projectCount: Object.keys(settings.projects).length,
      disk: {
        freeBytes: disk.bavail * disk.bsize,
        totalBytes: disk.blocks * disk.bsize,
      },
    }
  }

  async selectWorkspaceRoot(workspaceRoot) {
    if (!path.isAbsolute(workspaceRoot)) {
      throw new Error('工作目录必须使用绝对路径')
    }
    await this.ensureDirectory(workspaceRoot)
    const stat = await fs.stat(workspaceRoot)
    if (!stat.isDirectory()) {
      throw new Error('选择的工作目录无效')
    }
    const settings = await this.getSettings()
    settings.workspaceRoot = path.resolve(workspaceRoot)
    await this.discoverWorkspaceProjects(settings)
    await this.writeSettings(settings)
    return this.getWorkspaceStatus()
  }

  async ensureProject(project) {
    if (!project || typeof project.id !== 'string' || !project.id.trim()) {
      throw new Error('缺少项目标识')
    }
    if (typeof project.title !== 'string' || !project.title.trim()) {
      throw new Error('缺少项目名称')
    }

    return this.withProjectLock(project.id, async () => {
      const settings = await this.getSettings()
      await this.ensureDirectory(settings.workspaceRoot)
      let registration = settings.projects[project.id]
      if (!registration) {
        const suffix =
          project.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || randomUUID().slice(0, 8)
        registration = {
          directory: path.join(
            settings.workspaceRoot,
            `${safeSegment(project.title, 'project')}-${suffix}`,
          ),
          workspaceRoot: settings.workspaceRoot,
          createdAt: new Date().toISOString(),
        }
        settings.projects[project.id] = registration
        await this.writeSettings(settings)
      }

      await this.ensureProjectDirectories(registration.directory)
      const manifest = await this.readManifest(registration.directory, {
        version: 2,
        projectId: project.id,
        title: project.title.trim(),
        description: String(project.description || ''),
        visualStyle: String(project.visualStyle || ''),
        visualBible: String(project.visualBible || ''),
        aspectRatio: String(project.aspectRatio || 'UNSET'),
        status: String(project.status || 'DRAFT'),
        projectVersion: Number(project.version || 0),
        storageMode: String(project.storageMode || 'CLOUD_CACHE'),
        createdAt: registration.createdAt,
        updatedAt: new Date().toISOString(),
        assets: [],
      })
      manifest.version = 2
      manifest.title = project.title.trim()
      for (const key of [
        'description',
        'visualStyle',
        'visualBible',
        'aspectRatio',
        'status',
        'storageMode',
      ]) {
        if (project[key] !== undefined) manifest[key] = String(project[key] || '')
      }
      if (project.version !== undefined) manifest.projectVersion = Number(project.version || 0)
      manifest.updatedAt = new Date().toISOString()
      await this.writeManifest(registration.directory, manifest)
      return this.projectResult(registration.directory, manifest)
    })
  }

  async listLocalProjects() {
    const settings = await this.getSettings()
    const results = await Promise.allSettled(
      Object.values(settings.projects).map(async (registration) => {
        const manifest = await this.readManifest(registration.directory)
        return manifest.storageMode === 'LOCAL' ? projectRecord(manifest) : null
      }),
    )
    return results
      .filter((result) => result.status === 'fulfilled' && result.value)
      .map((result) => result.value)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  async createLocalProject(input) {
    if (!input || typeof input.title !== 'string' || !input.title.trim()) {
      throw new Error('项目名称不能为空')
    }
    const id = `local-${randomUUID()}`
    await this.ensureProject({
      id,
      title: input.title,
      description: input.description,
      visualStyle: input.visualStyle,
      visualBible: input.visualBible,
      aspectRatio: input.aspectRatio || 'UNSET',
      status: 'DRAFT',
      version: 0,
      storageMode: 'LOCAL',
    })
    const registration = await this.getProjectRegistration(id)
    await this.writeProjectData(
      registration.directory,
      emptyProjectData(id, new Date().toISOString()),
    )
    return projectRecord(await this.readManifest(registration.directory))
  }

  async deleteLocalProject(projectId) {
    return this.withProjectLock(projectId, async () => {
      const settings = await this.getSettings()
      const registration = settings.projects[projectId]
      if (!registration) throw new Error('本地项目不存在')
      const manifest = await this.readManifest(registration.directory)
      if (manifest.storageMode !== 'LOCAL') throw new Error('只能删除本地项目')

      const registeredRoot = registration.workspaceRoot || path.dirname(registration.directory)
      const deletedRoot = path.join(registeredRoot, '.deleted-projects')
      await this.ensureDirectory(deletedRoot)
      await assertExistingInside(registeredRoot, deletedRoot)
      const deletedDirectory = path.join(
        deletedRoot,
        `${safeSegment(manifest.title, 'project')}-${Date.now()}-${randomUUID().slice(0, 8)}`,
      )
      await fs.rename(registration.directory, deletedDirectory)
      delete settings.projects[projectId]
      try {
        await this.writeSettings(settings)
      } catch (error) {
        await fs.rename(deletedDirectory, registration.directory).catch(() => undefined)
        throw error
      }
      return { projectId, deletedDirectory }
    })
  }

  async getProject(projectId) {
    return this.withProjectLock(projectId, async () => {
      const registration = await this.getProjectRegistration(projectId)
      const manifest = await this.readManifest(registration.directory)
      return this.projectResult(registration.directory, manifest)
    })
  }

  async getLocalProjectData(projectId) {
    return this.withProjectLock(projectId, async () => {
      const registration = await this.getProjectRegistration(projectId)
      const manifest = await this.readManifest(registration.directory)
      if (!isLocalBusinessProject(manifest, projectId)) throw new Error('只能读取本地项目数据')
      return this.readProjectData(registration.directory, projectId)
    })
  }

  async saveLocalProjectData(projectId, input) {
    return this.withProjectLock(projectId, async () => {
      const registration = await this.getProjectRegistration(projectId)
      const manifest = await this.readManifest(registration.directory)
      if (!isLocalBusinessProject(manifest, projectId)) throw new Error('只能保存本地项目数据')
      const current = await this.readProjectData(registration.directory, projectId)
      const expectedRevision = Number(input?.revision)
      if (!Number.isInteger(expectedRevision) || expectedRevision !== current.revision) {
        throw new Error('本地项目数据已被其他操作更新，请重新打开项目后再试')
      }
      const now = new Date().toISOString()
      const next = normalizeProjectData(
        {
          ...input,
          projectId,
          revision: current.revision + 1,
          updatedAt: now,
        },
        projectId,
      )
      await this.writeProjectData(registration.directory, next)
      manifest.updatedAt = now
      await this.writeManifest(registration.directory, manifest)
      return next
    })
  }

  async updateLocalProject(projectId, input) {
    return this.withProjectLock(projectId, async () => {
      const registration = await this.getProjectRegistration(projectId)
      const manifest = await this.readManifest(registration.directory)
      if (manifest.storageMode !== 'LOCAL') throw new Error('只能修改本地项目')
      const expectedVersion = Number(input?.version)
      const currentVersion = Number(manifest.projectVersion || 0)
      if (!Number.isInteger(expectedVersion) || expectedVersion !== currentVersion) {
        throw new Error('项目已被其他操作更新，请重新打开项目后再试')
      }
      for (const key of ['title', 'description', 'visualStyle', 'visualBible', 'aspectRatio', 'status']) {
        if (input[key] !== undefined) manifest[key] = String(input[key] || '')
      }
      manifest.projectVersion = currentVersion + 1
      manifest.updatedAt = new Date().toISOString()
      await this.writeManifest(registration.directory, manifest)
      return projectRecord(manifest)
    })
  }

  async createLocalGenerationJob(projectId, input) {
    return this.withProjectLock(projectId, async () => {
      const registration = await this.getProjectRegistration(projectId)
      const manifest = await this.readManifest(registration.directory)
      if (!isLocalBusinessProject(manifest, projectId)) {
        throw new Error('只能为本地项目创建本地任务')
      }
      const state = await this.readLocalGenerationState(registration.directory, projectId)
      const job = normalizeLocalGenerationJob(input, projectId)
      if (state.jobs.some((item) => item.id === job.id)) throw new Error('本地任务标识已存在')
      state.jobs.push(job)
      if (state.jobs.length > MAX_LOCAL_GENERATION_JOBS) {
        const removable = state.jobs
          .filter((item) => ['SUCCEEDED', 'FAILED', 'CANCELED'].includes(item.status))
          .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
        while (state.jobs.length > MAX_LOCAL_GENERATION_JOBS && removable.length) {
          const target = removable.shift()
          state.jobs = state.jobs.filter((item) => item.id !== target.id)
        }
      }
      if (state.jobs.length > MAX_LOCAL_GENERATION_JOBS) {
        throw new Error('本地进行中的生成任务过多，请先处理已有任务')
      }
      state.updatedAt = new Date().toISOString()
      await this.writeLocalGenerationState(registration.directory, state)
      return job
    })
  }

  async getLocalGenerationJob(jobId) {
    const located = await this.findLocalGenerationJob(jobId)
    return located.job
  }

  async listLocalGenerationJobs(projectId, page = 1, pageSize = 100) {
    const registration = await this.getProjectRegistration(projectId)
    const state = await this.readLocalGenerationState(registration.directory, projectId)
    return pageResult(state.jobs, page, pageSize)
  }

  async listAllLocalGenerationJobs(page = 1, pageSize = 100) {
    const settings = await this.getSettings()
    const results = await Promise.allSettled(
      Object.keys(settings.projects).map(async (projectId) => {
        const registration = await this.getProjectRegistration(projectId)
        const manifest = await this.readManifest(registration.directory)
        if (!isLocalBusinessProject(manifest, projectId)) return []
        return (await this.readLocalGenerationState(registration.directory, projectId)).jobs
      }),
    )
    const jobs = results
      .filter((result) => result.status === 'fulfilled')
      .flatMap((result) => result.value)
    return pageResult(jobs, page, pageSize)
  }

  async updateLocalGenerationJob(jobId, action, input = {}) {
    const located = await this.findLocalGenerationJob(jobId)
    return this.withProjectLock(located.projectId, async () => {
      const state = await this.readLocalGenerationState(
        located.registration.directory,
        located.projectId,
      )
      const index = state.jobs.findIndex((item) => item.id === jobId)
      if (index < 0) throw new Error('本地生成任务不存在')
      const current = state.jobs[index]
      const updated = transitionLocalGenerationJob(current, action, input)
      state.jobs[index] = updated
      state.updatedAt = updated.updatedAt
      await this.writeLocalGenerationState(located.registration.directory, state)
      return updated
    })
  }

  async completeLocalImageGenerationJob(jobId, input) {
    return this.completeLocalBinaryGenerationJob(jobId, input, 'IMAGE')
  }

  async completeLocalMediaGenerationJob(jobId, input) {
    return this.completeLocalBinaryGenerationJob(jobId, input, 'MEDIA')
  }

  async completeLocalBinaryGenerationJob(jobId, input, candidateType) {
    const located = await this.findLocalGenerationJob(jobId)
    return this.withProjectLock(located.projectId, async () => {
      const state = await this.readLocalGenerationState(
        located.registration.directory,
        located.projectId,
      )
      const jobIndex = state.jobs.findIndex((item) => item.id === jobId)
      if (jobIndex < 0) throw new Error('本地生成任务不存在')
      const completed = transitionLocalGenerationJob(state.jobs[jobIndex], 'COMPLETE_BINARY', input)
      const candidate =
        candidateType === 'IMAGE'
          ? localImageCandidate(completed, input)
          : localMediaCandidate(completed, input)
      const collection = candidateType === 'IMAGE' ? state.imageCandidates : state.mediaCandidates
      if (collection.some((item) => item.id === candidate.id)) throw new Error('本地候选标识已存在')
      collection.unshift(candidate)
      state.jobs[jobIndex] = completed
      state.updatedAt = completed.updatedAt
      await this.writeLocalGenerationState(located.registration.directory, state)
      return candidate
    })
  }

  async listLocalImageCandidates(projectId, targetType, targetId) {
    const registration = await this.getProjectRegistration(projectId)
    const state = await this.readLocalGenerationState(registration.directory, projectId)
    return state.imageCandidates.filter(
      (candidate) => candidate.targetType === targetType && candidate.targetId === targetId,
    )
  }

  async listLocalMediaCandidates(projectId, storyboardId, mediaType) {
    const registration = await this.getProjectRegistration(projectId)
    const state = await this.readLocalGenerationState(registration.directory, projectId)
    return state.mediaCandidates.filter(
      (candidate) => candidate.storyboardId === storyboardId && candidate.mediaType === mediaType,
    )
  }

  async getLocalImageCandidate(candidateId) {
    return (await this.findLocalCandidate(candidateId, 'imageCandidates')).candidate
  }

  async getLocalMediaCandidate(candidateId) {
    return (await this.findLocalCandidate(candidateId, 'mediaCandidates')).candidate
  }

  async updateLocalImageCandidate(candidateId, action, input = {}) {
    return this.updateLocalCandidate(candidateId, 'imageCandidates', action, input)
  }

  async updateLocalMediaCandidate(candidateId, action, input = {}) {
    return this.updateLocalCandidate(candidateId, 'mediaCandidates', action, input)
  }

  async updateLocalCandidate(candidateId, collectionName, action, input) {
    const located = await this.findLocalCandidate(candidateId, collectionName)
    return this.withProjectLock(located.projectId, async () => {
      const state = await this.readLocalGenerationState(
        located.registration.directory,
        located.projectId,
      )
      const collection = state[collectionName]
      const index = collection.findIndex((candidate) => candidate.id === candidateId)
      if (index < 0) throw new Error('本地候选不存在')
      const current = collection[index]
      if (Number(input.version) !== current.version) throw new Error('本地候选已被其他操作更新')
      if (action === 'SELECT') {
        if (current.status === 'LOCAL_SAVED') return current
        collection.forEach((candidate, candidateIndex) => {
          if (
            candidateIndex !== index &&
            candidate.status === 'SELECTED' &&
            sameCandidateTarget(candidate, current)
          ) {
            collection[candidateIndex] = {
              ...candidate,
              status: 'AVAILABLE',
              version: candidate.version + 1,
              selectedAt: null,
            }
          }
        })
        collection[index] = {
          ...current,
          status: 'SELECTED',
          version: current.version + 1,
          selectedAt: new Date().toISOString(),
        }
      } else if (action === 'SAVE') {
        if (!['SELECTED', 'LOCAL_SAVED'].includes(current.status)) {
          throw new Error('请先选中候选再保存')
        }
        collection[index] = {
          ...current,
          status: 'LOCAL_SAVED',
          localAssetId: boundedText(input.assetId, '本地素材标识', 160),
          version: current.version + 1,
          savedAt: new Date().toISOString(),
        }
      } else if (action === 'DELETE') {
        let assetDeleted = false
        if (current.localAssetId) {
          const data = await this.readProjectData(located.registration.directory, located.projectId)
          assetDeleted = !projectDataReferencesAsset(data, current.localAssetId)
        }
        collection.splice(index, 1)
        state.updatedAt = new Date().toISOString()
        await this.writeLocalGenerationState(located.registration.directory, state)
        return {
          candidate: current,
          localAssetId: current.localAssetId || null,
          assetDeleted,
        }
      } else {
        throw new Error('不支持的本地候选操作')
      }
      state.updatedAt = new Date().toISOString()
      await this.writeLocalGenerationState(located.registration.directory, state)
      return collection[index]
    })
  }

  async importFiles(projectId, category, filePaths) {
    const categoryDirectory = CATEGORY_DIRECTORIES[category]
    if (!categoryDirectory) {
      throw new Error('不支持的素材分类')
    }
    if (!Array.isArray(filePaths) || filePaths.length === 0 || filePaths.length > 200) {
      throw new Error('每次请选择 1 到 200 个文件')
    }

    return this.withProjectLock(projectId, async () => {
      const registration = await this.getProjectRegistration(projectId)
      await this.ensureProjectDirectories(registration.directory)
      const manifest = await this.readManifest(registration.directory)
      const destinationDirectory = path.join(registration.directory, categoryDirectory)
      await assertExistingInside(registration.directory, destinationDirectory)
      const imported = []
      const createdFiles = []
      const temporaryFiles = []

      try {
        for (const sourcePath of filePaths) {
          const source = path.resolve(sourcePath)
          const stat = await fs.stat(source)
          if (!stat.isFile()) throw new Error('只能导入文件')
          validateImportCandidate(source, category, stat.size)

          const destinationName = `${Date.now()}-${randomUUID().slice(0, 8)}-${safeFileName(path.basename(source))}`
          const destination = path.join(destinationDirectory, destinationName)
          const temporary = `${destination}.${randomUUID().slice(0, 8)}.partial`
          temporaryFiles.push(temporary)
          const sha256 = await copyWithHash(source, temporary)
          const copiedStat = await fs.stat(temporary)
          validateImportCandidate(source, category, copiedStat.size)
          const mimeType = mimeTypeFor(source)
          await validateFileSignature(temporary, mimeType)

          const duplicate = manifest.assets.find(
            (asset) => asset.sha256 === sha256 && asset.sizeBytes === copiedStat.size,
          )
          if (duplicate) {
            const available = await this.assetFileAvailable(registration.directory, duplicate)
            if (available) {
              await fs.unlink(temporary)
            } else {
              const duplicatePath = resolveInside(registration.directory, duplicate.relativePath)
              await this.ensureDirectory(path.dirname(duplicatePath))
              await fs.rename(temporary, duplicatePath)
              createdFiles.push(duplicatePath)
            }
            imported.push({
              ...duplicate,
              duplicate: true,
              repaired: !available,
              fileAvailable: true,
            })
            continue
          }

          await fs.rename(temporary, destination)
          createdFiles.push(destination)
          const asset = {
            id: randomUUID(),
            category,
            originalName: path.basename(source),
            relativePath: toPortablePath(path.relative(registration.directory, destination)),
            sizeBytes: copiedStat.size,
            sha256,
            mimeType,
            importedAt: new Date().toISOString(),
          }
          manifest.assets.push(asset)
          imported.push({ ...asset, duplicate: false, repaired: false, fileAvailable: true })
        }

        manifest.version = 2
        manifest.updatedAt = new Date().toISOString()
        await this.writeManifest(registration.directory, manifest)
        return imported
      } catch (error) {
        await Promise.all(
          [...temporaryFiles, ...createdFiles].map((filePath) =>
            fs.unlink(filePath).catch(() => undefined),
          ),
        )
        throw error
      }
    })
  }

  async removeAsset(projectId, assetId) {
    return this.withProjectLock(projectId, async () => {
      const registration = await this.getProjectRegistration(projectId)
      const manifest = await this.readManifest(registration.directory)
      const index = manifest.assets.findIndex((asset) => asset.id === assetId)
      if (index < 0) throw new Error('本地素材不存在')
      const asset = manifest.assets[index]
      if (manifest.storageMode === 'LOCAL') {
        const data = await this.readProjectData(registration.directory, projectId)
        if (projectDataReferencesAsset(data, assetId)) {
          throw new Error('素材正在被角色、场景或分镜使用，请先解除关联')
        }
      }
      const trashDirectory = path.join(registration.directory, '.trash')
      await this.ensureDirectory(trashDirectory)
      await assertExistingInside(registration.directory, trashDirectory)
      const trashPath = path.join(
        trashDirectory,
        `${asset.id}-${randomUUID().slice(0, 8)}-${safeFileName(asset.originalName)}`,
      )
      let moved = false
      try {
        const assetPath = await this.resolveAssetPathUnlocked(registration.directory, asset)
        await fs.rename(assetPath, trashPath)
        moved = true
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }

      manifest.assets.splice(index, 1)
      manifest.version = 2
      manifest.updatedAt = new Date().toISOString()
      try {
        await this.writeManifest(registration.directory, manifest)
      } catch (error) {
        if (moved) {
          const originalPath = resolveInside(registration.directory, asset.relativePath)
          await fs.rename(trashPath, originalPath).catch(() => undefined)
        }
        throw error
      }
      if (moved) await fs.unlink(trashPath).catch(() => undefined)
      return { ...asset, fileAvailable: false }
    })
  }

  async resolveAssetPath(projectId, assetId) {
    const registration = await this.getProjectRegistration(projectId)
    const manifest = await this.readManifest(registration.directory)
    const asset = manifest.assets.find((item) => item.id === assetId)
    if (!asset) throw new Error('本地素材不存在')
    return this.resolveAssetPathUnlocked(registration.directory, asset)
  }

  async resolveAsset(projectId, assetId) {
    const registration = await this.getProjectRegistration(projectId)
    const manifest = await this.readManifest(registration.directory)
    const asset = manifest.assets.find((item) => item.id === assetId)
    if (!asset) throw new Error('本地素材不存在')
    return {
      asset: { ...asset, fileAvailable: true },
      path: await this.resolveAssetPathUnlocked(registration.directory, asset),
    }
  }

  async exportVideoAssets(projectId, items, destinationDirectory) {
    if (!Array.isArray(items) || items.length === 0 || items.length > 100) {
      throw new Error('批量导出视频数量必须在 1 到 100 之间')
    }
    if (!path.isAbsolute(destinationDirectory)) throw new Error('导出目录必须使用绝对路径')
    const destinationRoot = await fs.realpath(destinationDirectory)
    const destinationStat = await fs.stat(destinationRoot)
    if (!destinationStat.isDirectory()) throw new Error('导出目录无效')

    const registration = await this.getProjectRegistration(projectId)
    const manifest = await this.readManifest(registration.directory)
    const exported = []
    for (const item of items) {
      const asset = manifest.assets.find((candidate) => candidate.id === item?.assetId)
      if (!asset || !['videos', 'exports'].includes(asset.category)) {
        throw new Error('待导出视频不在本地项目清单中')
      }
      const sourcePath = await this.resolveAssetPathUnlocked(registration.directory, asset)
      const sourceExtension = path.extname(asset.originalName).toLowerCase()
      if (!CATEGORY_EXTENSIONS.videos.has(sourceExtension)) throw new Error('待导出文件不是视频')
      const requestedName = safeFileName(String(item.fileName || asset.originalName))
      const outputName = `${path.parse(requestedName).name || 'video'}${sourceExtension}`
      const destinationPath = await availableExportPath(destinationRoot, outputName)
      const temporaryPath = path.join(destinationRoot, `.${randomUUID()}.partial`)
      try {
        await fs.copyFile(sourcePath, temporaryPath)
        await fs.rename(temporaryPath, destinationPath)
      } catch (error) {
        await fs.rm(temporaryPath, { force: true })
        throw error
      }
      exported.push({
        assetId: asset.id,
        fileName: path.basename(destinationPath),
        filePath: destinationPath,
      })
    }
    return { canceled: false, directory: destinationRoot, files: exported }
  }

  async reconcileAssetIds(projectId, mappings) {
    if (!Array.isArray(mappings) || mappings.length > 500) {
      throw new Error('素材标识对账数据无效')
    }
    return this.withProjectLock(projectId, async () => {
      const registration = await this.getProjectRegistration(projectId)
      const manifest = await this.readManifest(registration.directory)
      let changed = false
      for (const mapping of mappings) {
        if (
          !mapping ||
          typeof mapping.clientAssetId !== 'string' ||
          typeof mapping.assetId !== 'string'
        ) {
          throw new Error('素材标识对账数据无效')
        }
        if (mapping.clientAssetId === mapping.assetId) continue
        const source = manifest.assets.find((asset) => asset.id === mapping.clientAssetId)
        if (!source) continue
        const collision = manifest.assets.find((asset) => asset.id === mapping.assetId)
        if (collision && collision !== source) throw new Error('服务端素材标识已在本地存在')
        source.id = mapping.assetId
        changed = true
      }
      if (changed) {
        manifest.version = 2
        manifest.updatedAt = new Date().toISOString()
        await this.writeManifest(registration.directory, manifest)
      }
      return this.projectResult(registration.directory, manifest)
    })
  }

  async getSettings() {
    if (this.settingsCache) return structuredClone(this.settingsCache)
    if (!this.settingsLoadPromise) {
      this.settingsLoadPromise = this.loadSettings()
    }
    try {
      const settings = await this.settingsLoadPromise
      return structuredClone(settings)
    } finally {
      this.settingsLoadPromise = null
    }
  }

  async loadSettings() {
    await this.ensureDirectory(this.appDataPath)
    const fallback = {
      version: 1,
      workspaceRoot: this.defaultWorkspaceRoot,
      projects: {},
    }
    const loaded = await readJson(this.settingsPath, fallback)
    const settings = {
      version: 1,
      workspaceRoot:
        typeof loaded?.workspaceRoot === 'string' && path.isAbsolute(loaded.workspaceRoot)
          ? path.resolve(loaded.workspaceRoot)
          : this.defaultWorkspaceRoot,
      projects:
        loaded?.projects && typeof loaded.projects === 'object' && !Array.isArray(loaded.projects)
          ? { ...loaded.projects }
          : {},
    }
    const changed = await this.discoverWorkspaceProjects(settings)
    if (changed) {
      await writeJsonAtomic(this.settingsPath, settings)
    }
    this.settingsCache = structuredClone(settings)
    return settings
  }

  async discoverWorkspaceProjects(settings) {
    await this.ensureDirectory(settings.workspaceRoot)
    let entries
    try {
      entries = await fs.readdir(settings.workspaceRoot, { withFileTypes: true })
    } catch {
      return false
    }
    let changed = false
    for (const entry of entries.slice(0, 5_000)) {
      if (!entry.isDirectory() || entry.name === '.deleted-projects') continue
      const directory = path.join(settings.workspaceRoot, entry.name)
      let manifest
      try {
        manifest = await readJson(path.join(directory, 'project.aidrama.json'))
      } catch {
        continue
      }
      if (
        !manifest ||
        typeof manifest.projectId !== 'string' ||
        !manifest.projectId.trim() ||
        !Array.isArray(manifest.assets)
      ) {
        continue
      }
      if (!settings.projects[manifest.projectId]) {
        settings.projects[manifest.projectId] = {
          directory,
          workspaceRoot: settings.workspaceRoot,
          createdAt: String(manifest.createdAt || manifest.updatedAt || new Date(0).toISOString()),
        }
        changed = true
      }
    }
    return changed
  }

  async writeSettings(settings) {
    await this.ensureDirectory(this.appDataPath)
    await writeJsonAtomic(this.settingsPath, settings)
    this.settingsCache = structuredClone(settings)
  }

  async getProjectDirectory(projectId) {
    return (await this.getProjectRegistration(projectId)).directory
  }

  async getProjectRegistration(projectId) {
    const settings = await this.getSettings()
    const registration = settings.projects[projectId]
    if (!registration || !path.isAbsolute(registration.directory)) {
      throw new Error('本地项目尚未初始化')
    }
    const registeredRoot = registration.workspaceRoot || path.dirname(registration.directory)
    await assertExistingInside(registeredRoot, registration.directory)
    return registration
  }

  async ensureProjectDirectories(projectDirectory) {
    await Promise.all([
      this.ensureDirectory(projectDirectory),
      ...Object.values(CATEGORY_DIRECTORIES).map((directory) =>
        this.ensureDirectory(path.join(projectDirectory, directory)),
      ),
      this.ensureDirectory(path.join(projectDirectory, 'cache')),
      this.ensureDirectory(path.join(projectDirectory, '.trash')),
    ])
  }

  async ensureDirectory(directory) {
    await fs.mkdir(directory, { recursive: true })
  }

  async readManifest(projectDirectory, fallback) {
    const manifest = await readJson(path.join(projectDirectory, 'project.aidrama.json'), fallback)
    if (!manifest || typeof manifest.projectId !== 'string' || !Array.isArray(manifest.assets)) {
      throw new Error('本地项目清单格式无效')
    }
    manifest.version = 2
    manifest.assets = manifest.assets.map(normalizeAsset)
    return manifest
  }

  async writeManifest(projectDirectory, manifest) {
    await writeJsonAtomic(path.join(projectDirectory, 'project.aidrama.json'), manifest)
  }

  async readProjectData(projectDirectory, projectId) {
    const fallback = emptyProjectData(projectId, new Date().toISOString())
    const data = await readJson(path.join(projectDirectory, PROJECT_DATA_FILE), fallback)
    return normalizeProjectData(data, projectId)
  }

  async writeProjectData(projectDirectory, data) {
    const serialized = JSON.stringify(data)
    if (Buffer.byteLength(serialized, 'utf8') > MAX_PROJECT_DATA_BYTES) {
      throw new Error('本地项目业务数据超过允许大小')
    }
    await writeJsonAtomic(path.join(projectDirectory, PROJECT_DATA_FILE), data)
  }

  async readLocalGenerationState(projectDirectory, projectId) {
    const fallback = {
      version: 1,
      projectId,
      updatedAt: new Date().toISOString(),
      jobs: [],
      imageCandidates: [],
      mediaCandidates: [],
    }
    const state = await readJson(path.join(projectDirectory, LOCAL_GENERATION_FILE), fallback)
    if (!state || state.projectId !== projectId || !Array.isArray(state.jobs)) {
      throw new Error('本地生成任务账本格式无效')
    }
    return {
      version: 1,
      projectId,
      updatedAt: String(state.updatedAt || new Date(0).toISOString()),
      jobs: state.jobs.map((job) => normalizeLocalGenerationJob(job, projectId)),
      imageCandidates: Array.isArray(state.imageCandidates)
        ? state.imageCandidates.map((candidate) => normalizeLocalImageCandidate(candidate))
        : [],
      mediaCandidates: Array.isArray(state.mediaCandidates)
        ? state.mediaCandidates.map((candidate) => normalizeLocalMediaCandidate(candidate))
        : [],
    }
  }

  async writeLocalGenerationState(projectDirectory, state) {
    const serialized = JSON.stringify(state)
    if (Buffer.byteLength(serialized, 'utf8') > MAX_LOCAL_GENERATION_BYTES) {
      throw new Error('本地生成任务账本超过允许大小，请清理历史任务')
    }
    await writeJsonAtomic(path.join(projectDirectory, LOCAL_GENERATION_FILE), state)
  }

  async findLocalGenerationJob(jobId) {
    if (typeof jobId !== 'string' || !jobId.startsWith('local-job-')) {
      throw new Error('本地生成任务标识无效')
    }
    const settings = await this.getSettings()
    for (const projectId of Object.keys(settings.projects)) {
      const registration = await this.getProjectRegistration(projectId).catch(() => null)
      if (!registration) continue
      const state = await this.readLocalGenerationState(registration.directory, projectId).catch(
        () => null,
      )
      const job = state?.jobs.find((item) => item.id === jobId)
      if (job) return { projectId, registration, job }
    }
    throw new Error('本地生成任务不存在')
  }

  async findLocalCandidate(candidateId, collectionName) {
    if (typeof candidateId !== 'string' || !candidateId.startsWith('local-')) {
      throw new Error('本地候选标识无效')
    }
    const settings = await this.getSettings()
    for (const projectId of Object.keys(settings.projects)) {
      const registration = await this.getProjectRegistration(projectId).catch(() => null)
      if (!registration) continue
      const state = await this.readLocalGenerationState(registration.directory, projectId).catch(
        () => null,
      )
      const candidate = state?.[collectionName]?.find((item) => item.id === candidateId)
      if (candidate) return { projectId, registration, candidate }
    }
    throw new Error('本地候选不存在')
  }

  async projectResult(directory, manifest) {
    return {
      directory,
      manifestPath: path.join(directory, 'project.aidrama.json'),
      projectId: manifest.projectId,
      title: manifest.title,
      updatedAt: manifest.updatedAt,
      assets: await Promise.all(
        manifest.assets.map(async (asset) => ({
          ...asset,
          fileAvailable: await this.assetFileAvailable(directory, asset),
        })),
      ),
    }
  }

  async assetFileAvailable(projectDirectory, asset) {
    try {
      await this.resolveAssetPathUnlocked(projectDirectory, asset)
      return true
    } catch {
      return false
    }
  }

  async resolveAssetPathUnlocked(projectDirectory, asset) {
    const lexicalPath = resolveInside(projectDirectory, asset.relativePath)
    return assertExistingInside(projectDirectory, lexicalPath)
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

async function copyWithHash(source, destination) {
  const hash = createHash('sha256')
  const tracker = new Transform({
    transform(chunk, encoding, callback) {
      hash.update(chunk)
      callback(null, chunk)
    },
  })
  await pipeline(createReadStream(source), tracker, createWriteStream(destination, { flags: 'wx' }))
  const handle = await fs.open(destination, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  return hash.digest('hex')
}

async function readJson(filePath, fallback) {
  try {
    const content = await fs.readFile(filePath, 'utf8')
    return JSON.parse(content)
  } catch (error) {
    if (error.code === 'ENOENT' && fallback) return structuredClone(fallback)
    throw error
  }
}

async function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await fs.rename(temporary, filePath)
}

function resolveInside(root, relativePath) {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(root, relativePath)
  const relative = path.relative(resolvedRoot, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('素材路径超出项目目录')
  }
  return resolved
}

async function assertExistingInside(root, target) {
  const lexical = resolveInside(root, path.relative(root, target))
  const [realRoot, realTarget] = await Promise.all([fs.realpath(root), fs.realpath(lexical)])
  const relative = path.relative(realRoot, realTarget)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('素材路径超出项目目录')
  }
  return realTarget
}

function safeSegment(value, fallback) {
  const safe = value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 60)
  const candidate = safe || fallback
  const stem = candidate.split('.', 1)[0].toUpperCase()
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) return `_${candidate}`
  return candidate
}

function safeFileName(value) {
  return safeSegment(value, 'asset')
}

async function availableExportPath(directory, fileName) {
  const parsed = path.parse(fileName)
  for (let suffix = 0; suffix < 10_000; suffix += 1) {
    const candidateName = suffix === 0 ? fileName : `${parsed.name} (${suffix + 1})${parsed.ext}`
    const candidate = path.join(directory, candidateName)
    try {
      await fs.access(candidate)
    } catch (error) {
      if (error.code === 'ENOENT') return candidate
      throw error
    }
  }
  throw new Error('导出目录中同名文件过多')
}

function toPortablePath(value) {
  return value.split(path.sep).join('/')
}

function mimeTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase()
  return (
    {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.webm': 'video/webm',
      '.mkv': 'video/webm',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.m4a': 'audio/mp4',
      '.aac': 'audio/aac',
      '.ogg': 'audio/ogg',
      '.flac': 'audio/flac',
    }[extension] || 'application/octet-stream'
  )
}

function validateImportCandidate(filePath, category, sizeBytes) {
  const extension = path.extname(filePath).toLowerCase()
  if (!CATEGORY_EXTENSIONS[category]?.has(extension)) throw new Error('不支持的文件类型')
  if (sizeBytes <= 0) throw new Error('不能导入空文件')
  if (sizeBytes > CATEGORY_SIZE_LIMITS[category]) throw new Error('文件超过允许的大小上限')
}

async function validateFileSignature(filePath, mimeType) {
  const handle = await fs.open(filePath, 'r')
  try {
    if (mimeType === 'audio/mpeg') {
      if (!(await hasMp3AudioFrames(handle))) throw new Error('文件内容与扩展名不匹配')
      return
    }
    const bytes = Buffer.alloc(16)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    const header = bytes.subarray(0, bytesRead)
    const ascii = header.toString('ascii')
    const valid =
      (mimeType === 'image/png' &&
        header.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) ||
      (mimeType === 'image/jpeg' && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) ||
      (mimeType === 'image/webp' && ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') ||
      (mimeType === 'image/gif' && (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a'))) ||
      (mimeType === 'video/mp4' && ascii.slice(4, 8) === 'ftyp') ||
      (mimeType === 'video/quicktime' && ascii.slice(4, 8) === 'ftyp') ||
      (mimeType === 'video/webm' && header.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex'))) ||
      (mimeType === 'audio/wav' && ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE') ||
      (mimeType === 'audio/mp4' && ascii.slice(4, 8) === 'ftyp') ||
      (mimeType === 'audio/aac' &&
        header[0] === 0xff &&
        (header[1] === 0xf1 || header[1] === 0xf9)) ||
      (mimeType === 'audio/ogg' && ascii.startsWith('OggS')) ||
      (mimeType === 'audio/flac' && ascii.startsWith('fLaC'))
    if (!valid) throw new Error('文件内容与扩展名不匹配')
  } finally {
    await handle.close()
  }
}

async function hasMp3AudioFrames(handle) {
  const stat = await handle.stat()
  if (stat.size < 8) return false
  const tagHeader = Buffer.alloc(10)
  const tagRead = await handle.read(tagHeader, 0, tagHeader.length, 0)
  let audioOffset = 0
  if (tagRead.bytesRead === tagHeader.length && tagHeader.subarray(0, 3).toString('ascii') === 'ID3') {
    const tagSize = synchsafeInteger(tagHeader.subarray(6, 10))
    if (tagSize === null) return false
    audioOffset = 10 + tagSize + ((tagHeader[5] & 0x10) === 0x10 ? 10 : 0)
    if (audioOffset >= stat.size) return false
  }
  const scanLength = Math.min(MP3_SCAN_BYTES, stat.size - audioOffset)
  const bytes = Buffer.alloc(scanLength)
  const { bytesRead } = await handle.read(bytes, 0, scanLength, audioOffset)
  const data = bytes.subarray(0, bytesRead)
  for (let offset = 0; offset + 4 <= data.length; offset += 1) {
    const first = mp3FrameHeader(data, offset)
    if (!first) continue
    const nextOffset = offset + first.frameLength
    if (nextOffset + 4 <= data.length) {
      const next = mp3FrameHeader(data, nextOffset)
      if (next && compatibleMp3Frames(first, next)) return true
      continue
    }
    if (audioOffset + nextOffset + 4 > stat.size) continue
    const nextHeader = Buffer.alloc(4)
    const nextRead = await handle.read(nextHeader, 0, 4, audioOffset + nextOffset)
    const next = nextRead.bytesRead === 4 ? mp3FrameHeader(nextHeader, 0) : null
    if (next && compatibleMp3Frames(first, next)) return true
  }
  return false
}

function synchsafeInteger(bytes) {
  if (bytes.length !== 4 || [...bytes].some((value) => (value & 0x80) !== 0)) return null
  return ((bytes[0] & 0x7f) << 21) | ((bytes[1] & 0x7f) << 14) | ((bytes[2] & 0x7f) << 7) | (bytes[3] & 0x7f)
}

function mp3FrameHeader(bytes, offset) {
  if (offset + 4 > bytes.length) return null
  const first = bytes[offset]
  const second = bytes[offset + 1]
  const third = bytes[offset + 2]
  if (first !== 0xff || (second & 0xe0) !== 0xe0) return null
  const versionBits = (second >> 3) & 0x03
  const layerBits = (second >> 1) & 0x03
  if (versionBits === 0x01 || layerBits !== 0x01) return null
  const bitrateIndex = (third >> 4) & 0x0f
  const sampleRateIndex = (third >> 2) & 0x03
  if (bitrateIndex === 0 || bitrateIndex === 0x0f || sampleRateIndex === 0x03) return null
  const version = versionBits === 0x03 ? 1 : versionBits === 0x02 ? 2 : 2.5
  const bitrates =
    version === 1
      ? [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
      : [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
  const sampleRates = version === 1 ? [44100, 48000, 32000] : version === 2 ? [22050, 24000, 16000] : [11025, 12000, 8000]
  const bitrate = bitrates[bitrateIndex - 1]
  const sampleRate = sampleRates[sampleRateIndex]
  const padding = (third >> 1) & 0x01
  const frameLength = Math.floor(((version === 1 ? 144 : 72) * bitrate * 1000) / sampleRate) + padding
  return frameLength >= 24 ? { version, layerBits, sampleRate, frameLength } : null
}

function compatibleMp3Frames(first, second) {
  return first.version === second.version && first.layerBits === second.layerBits && first.sampleRate === second.sampleRate
}

function normalizeAsset(asset) {
  if (
    !asset ||
    typeof asset.id !== 'string' ||
    typeof asset.category !== 'string' ||
    !CATEGORY_DIRECTORIES[asset.category] ||
    typeof asset.relativePath !== 'string' ||
    typeof asset.sha256 !== 'string'
  ) {
    throw new Error('本地素材清单条目无效')
  }
  return {
    id: asset.id,
    category: asset.category,
    originalName: String(asset.originalName || 'asset'),
    relativePath: toPortablePath(asset.relativePath),
    sizeBytes: Number(asset.sizeBytes),
    sha256: asset.sha256,
    mimeType: String(asset.mimeType || mimeTypeFor(asset.originalName || '')),
    importedAt: String(asset.importedAt || new Date(0).toISOString()),
  }
}

function projectRecord(manifest) {
  return {
    id: manifest.projectId,
    title: String(manifest.title || '未命名项目'),
    description: String(manifest.description || ''),
    visualStyle: String(manifest.visualStyle || ''),
    visualBible: String(manifest.visualBible || ''),
    aspectRatio: String(manifest.aspectRatio || 'UNSET'),
    status: String(manifest.status || 'DRAFT'),
    version: Number(manifest.projectVersion || 0),
    updatedAt: String(manifest.updatedAt || manifest.createdAt || new Date(0).toISOString()),
    storageMode: 'LOCAL',
  }
}

function emptyProjectData(projectId, updatedAt) {
  return {
    version: 1,
    revision: 0,
    projectId,
    updatedAt,
    episodes: [],
    characters: [],
    scenes: [],
    storyboards: [],
    storyboardOutputs: [],
    characterReferences: [],
    characterVoiceReferences: [],
    sceneReferences: [],
    sourceDocuments: [],
    structureCandidates: [],
  }
}

function normalizeProjectData(input, projectId) {
  if (!input || typeof input !== 'object' || input.projectId !== projectId) {
    throw new Error('本地项目业务数据格式无效')
  }
  const normalized = {
    version: 1,
    revision: Number(input.revision || 0),
    projectId,
    updatedAt: String(input.updatedAt || new Date(0).toISOString()),
  }
  if (!Number.isInteger(normalized.revision) || normalized.revision < 0) {
    throw new Error('本地项目业务数据修订号无效')
  }
  let itemCount = 0
  for (const collection of PROJECT_DATA_COLLECTIONS) {
    const values = input[collection] ?? (OPTIONAL_PROJECT_DATA_COLLECTIONS.has(collection) ? [] : null)
    if (!Array.isArray(values)) throw new Error('本地项目业务数据集合无效')
    itemCount += values.length
    normalized[collection] = structuredClone(values)
  }
  if (itemCount > MAX_PROJECT_DATA_ITEMS) throw new Error('本地项目业务数据条目过多')
  return normalized
}

function projectDataReferencesAsset(data, assetId) {
  return (
    data.characterReferences.some((reference) => reference.assetId === assetId) ||
    data.characterVoiceReferences.some((reference) => reference.assetId === assetId) ||
    data.sceneReferences.some((reference) => reference.assetId === assetId) ||
    data.storyboardOutputs.some((output) => output.mediaAssetId === assetId)
  )
}

function isLocalBusinessProject(manifest, projectId) {
  return manifest.storageMode === 'LOCAL' || projectId === LOCAL_VIDEO_LAB_PROJECT_ID
}

function normalizeLocalGenerationJob(input, projectId) {
  if (!input || typeof input !== 'object' || input.projectId !== projectId) {
    throw new Error('本地生成任务格式无效')
  }
  const id = String(input.id || '')
  if (!/^local-job-[a-zA-Z0-9-]{8,120}$/.test(id)) throw new Error('本地生成任务标识无效')
  const status = String(input.status || 'WAITING_LOCAL')
  if (!['WAITING_LOCAL', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED'].includes(status)) {
    throw new Error('本地生成任务状态无效')
  }
  const executionRequest = input.executionRequest
    ? {
        systemPrompt: boundedText(input.executionRequest.systemPrompt, '系统提示词', 40_000),
        userPrompt: boundedText(input.executionRequest.userPrompt, '用户提示词', 400_000),
        parameters:
          input.executionRequest.parameters && typeof input.executionRequest.parameters === 'object'
            ? structuredClone(input.executionRequest.parameters)
            : {},
      }
    : null
  return {
    id,
    projectId,
    jobType: boundedText(input.jobType, '任务类型', 80),
    serviceType: boundedText(input.serviceType || 'TEXT', '服务类型', 20),
    targetType: boundedText(input.targetType, '目标类型', 80),
    targetId: boundedText(input.targetId, '目标标识', 160),
    targetVersion: Math.max(0, Number(input.targetVersion || 0)),
    sourceType: 'LOCAL',
    localConnectionId: boundedText(input.localConnectionId, '本地连接标识', 160),
    platformModelId: null,
    sourceDisplayName: boundedOptionalText(input.sourceDisplayName, 200),
    modelName: boundedOptionalText(input.modelName, 300),
    status,
    progress: Math.max(0, Math.min(100, Math.round(Number(input.progress || 0)))),
    executionRequest,
    resultText: boundedOptionalText(input.resultText, 500_000),
    errorCode: boundedOptionalText(input.errorCode, 100),
    errorMessage: boundedOptionalText(input.errorMessage, 4_000),
    attemptCount: Math.max(0, Math.round(Number(input.attemptCount || 0))),
    createdAt: String(input.createdAt || new Date().toISOString()),
    updatedAt: String(input.updatedAt || input.createdAt || new Date().toISOString()),
  }
}

function transitionLocalGenerationJob(current, action, input) {
  const now = new Date().toISOString()
  if (action === 'START') {
    if (current.status !== 'WAITING_LOCAL') throw new Error('当前本地任务不能开始执行')
    return { ...current, status: 'RUNNING', progress: 10, updatedAt: now }
  }
  if (action === 'HEARTBEAT') {
    if (current.status !== 'RUNNING') return current
    const progress = Math.max(10, Math.min(95, Math.round(Number(input.progress || 20))))
    return { ...current, progress, updatedAt: now }
  }
  if (action === 'COMPLETE') {
    if (current.status !== 'RUNNING') throw new Error('当前本地任务不能提交结果')
    return {
      ...current,
      status: 'SUCCEEDED',
      progress: 100,
      resultText: boundedText(input.text, '生成结果', 500_000),
      sourceDisplayName: boundedOptionalText(input.providerCode, 200) || current.sourceDisplayName,
      modelName: boundedOptionalText(input.modelName, 300) || current.modelName,
      errorCode: null,
      errorMessage: null,
      updatedAt: now,
    }
  }
  if (action === 'COMPLETE_BINARY') {
    if (current.status !== 'RUNNING') throw new Error('当前本地任务不能提交结果')
    return {
      ...current,
      status: 'SUCCEEDED',
      progress: 100,
      sourceDisplayName: boundedOptionalText(input.providerCode, 200) || current.sourceDisplayName,
      modelName: boundedOptionalText(input.modelName, 300) || current.modelName,
      errorCode: null,
      errorMessage: null,
      updatedAt: now,
    }
  }
  if (action === 'FAIL') {
    if (!['WAITING_LOCAL', 'RUNNING'].includes(current.status)) {
      throw new Error('当前本地任务不能标记为失败')
    }
    return {
      ...current,
      status: 'FAILED',
      errorCode: 'LOCAL_EXECUTION_FAILED',
      errorMessage: boundedText(input.message, '失败原因', 4_000),
      updatedAt: now,
    }
  }
  if (action === 'CANCEL') {
    if (!['WAITING_LOCAL', 'RUNNING'].includes(current.status)) return current
    return { ...current, status: 'CANCELED', errorCode: null, errorMessage: null, updatedAt: now }
  }
  if (action === 'RETRY') {
    if (!['FAILED', 'CANCELED'].includes(current.status)) throw new Error('当前本地任务不能重试')
    return {
      ...current,
      status: 'WAITING_LOCAL',
      progress: 0,
      resultText: null,
      errorCode: null,
      errorMessage: null,
      attemptCount: current.attemptCount + 1,
      updatedAt: now,
    }
  }
  throw new Error('不支持的本地任务操作')
}

function localImageCandidate(job, input) {
  if (job.serviceType !== 'IMAGE' || !job.executionRequest) throw new Error('本地图片任务快照无效')
  const clientCandidateId = boundedText(input.clientCandidateId, '客户端候选标识', 120)
  return normalizeLocalImageCandidate({
    id: `local-image-${clientCandidateId}`,
    projectId: job.projectId,
    jobId: job.id,
    targetType: job.targetType,
    targetId: job.targetId,
    compositionType: String(job.executionRequest.parameters.composition_type || 'SINGLE'),
    providerCode: String(input.providerCode || job.sourceDisplayName || 'LOCAL'),
    modelName: String(input.modelName || job.modelName || 'LOCAL'),
    deliveryType: 'LOCAL_CACHE',
    clientCandidateId,
    previewAvailable: true,
    prompt: job.executionRequest.userPrompt,
    negativePrompt: job.executionRequest.parameters.negative_prompt,
    revisedPrompt: input.revisedPrompt,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    sha256: input.sha256,
    width: input.width,
    height: input.height,
    status: 'AVAILABLE',
    localAssetId: null,
    version: 0,
    selectedAt: null,
    savedAt: null,
    createdAt: new Date().toISOString(),
  })
}

function localMediaCandidate(job, input) {
  if (!['VIDEO', 'TTS'].includes(job.serviceType) || !job.executionRequest) {
    throw new Error('本地媒体任务快照无效')
  }
  const clientCandidateId = boundedText(input.clientCandidateId, '客户端候选标识', 120)
  return normalizeLocalMediaCandidate({
    id: `local-media-${clientCandidateId}`,
    projectId: job.projectId,
    jobId: job.id,
    storyboardId: job.targetId,
    mediaType: job.serviceType === 'VIDEO' ? 'VIDEO' : 'TTS',
    providerCode: String(input.providerCode || job.sourceDisplayName || 'LOCAL'),
    modelName: String(input.modelName || job.modelName || 'LOCAL'),
    deliveryType: 'LOCAL_CACHE',
    clientCandidateId,
    previewAvailable: true,
    prompt: job.executionRequest.userPrompt,
    inputAssetId: job.executionRequest.parameters.input_asset_id,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    sha256: input.sha256,
    durationMs: input.durationMs,
    width: input.width,
    height: input.height,
    status: 'AVAILABLE',
    localAssetId: null,
    version: 0,
    selectedAt: null,
    savedAt: null,
    createdAt: new Date().toISOString(),
  })
}

function normalizeLocalImageCandidate(input) {
  const status = normalizeCandidateStatus(input.status)
  return {
    id: boundedText(input.id, '图片候选标识', 160),
    projectId: boundedText(input.projectId, '项目标识', 160),
    jobId: boundedText(input.jobId, '任务标识', 160),
    targetType: boundedText(input.targetType, '目标类型', 80),
    targetId: boundedText(input.targetId, '目标标识', 160),
    compositionType: boundedText(input.compositionType || 'SINGLE', '构图类型', 80),
    providerCode: boundedText(input.providerCode, '供应来源', 200),
    modelName: boundedText(input.modelName, '模型名称', 300),
    deliveryType: 'LOCAL_CACHE',
    clientCandidateId: boundedText(input.clientCandidateId, '客户端候选标识', 120),
    previewAvailable: Boolean(input.previewAvailable),
    remoteExpiresAt: null,
    prompt: boundedText(input.prompt, '图片提示词', 40_000),
    negativePrompt: boundedOptionalText(input.negativePrompt, 10_000),
    revisedPrompt: boundedOptionalText(input.revisedPrompt, 40_000),
    mimeType: boundedOptionalText(input.mimeType, 120),
    sizeBytes: Math.max(0, Number(input.sizeBytes || 0)),
    sha256: boundedOptionalText(input.sha256, 128),
    width: Math.max(0, Number(input.width || 0)),
    height: Math.max(0, Number(input.height || 0)),
    status,
    localAssetId: boundedOptionalText(input.localAssetId, 160),
    version: Math.max(0, Math.round(Number(input.version || 0))),
    selectedAt: boundedOptionalText(input.selectedAt, 80),
    savedAt: boundedOptionalText(input.savedAt, 80),
    createdAt: String(input.createdAt || new Date().toISOString()),
  }
}

function normalizeLocalMediaCandidate(input) {
  const status = normalizeCandidateStatus(input.status)
  const mediaType = String(input.mediaType)
  if (!['VIDEO', 'TTS'].includes(mediaType)) throw new Error('本地媒体候选类型无效')
  return {
    id: boundedText(input.id, '媒体候选标识', 160),
    projectId: boundedText(input.projectId, '项目标识', 160),
    jobId: boundedText(input.jobId, '任务标识', 160),
    storyboardId: boundedText(input.storyboardId, '分镜标识', 160),
    mediaType,
    providerCode: boundedText(input.providerCode, '供应来源', 200),
    modelName: boundedText(input.modelName, '模型名称', 300),
    deliveryType: 'LOCAL_CACHE',
    clientCandidateId: boundedText(input.clientCandidateId, '客户端候选标识', 120),
    previewAvailable: Boolean(input.previewAvailable),
    remoteExpiresAt: null,
    prompt: boundedText(input.prompt, '媒体提示词', 40_000),
    inputAssetId: boundedOptionalText(input.inputAssetId, 160),
    mimeType: boundedOptionalText(input.mimeType, 120),
    sizeBytes: Math.max(0, Number(input.sizeBytes || 0)),
    sha256: boundedOptionalText(input.sha256, 128),
    durationMs: Math.max(0, Number(input.durationMs || 0)),
    width: input.width == null ? null : Math.max(0, Number(input.width)),
    height: input.height == null ? null : Math.max(0, Number(input.height)),
    status,
    localAssetId: boundedOptionalText(input.localAssetId, 160),
    version: Math.max(0, Math.round(Number(input.version || 0))),
    selectedAt: boundedOptionalText(input.selectedAt, 80),
    savedAt: boundedOptionalText(input.savedAt, 80),
    createdAt: String(input.createdAt || new Date().toISOString()),
  }
}

function normalizeCandidateStatus(value) {
  const status = String(value || 'AVAILABLE')
  if (!['AVAILABLE', 'SELECTED', 'LOCAL_SAVED'].includes(status)) {
    throw new Error('本地候选状态无效')
  }
  return status
}

function sameCandidateTarget(left, right) {
  if ('targetType' in left && 'targetType' in right) {
    return left.targetType === right.targetType && left.targetId === right.targetId
  }
  return left.storyboardId === right.storyboardId && left.mediaType === right.mediaType
}

function pageResult(items, page, pageSize) {
  const safePage = Math.max(1, Math.round(Number(page || 1)))
  const safePageSize = Math.max(1, Math.min(500, Math.round(Number(pageSize || 100))))
  const sorted = [...items].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  const offset = (safePage - 1) * safePageSize
  return {
    items: sorted.slice(offset, offset + safePageSize),
    page: safePage,
    pageSize: safePageSize,
    total: sorted.length,
  }
}

function boundedText(value, label, maxLength) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}不能为空`)
  const normalized = value.trim()
  if (normalized.length > maxLength) throw new Error(`${label}超过允许长度`)
  return normalized
}

function boundedOptionalText(value, maxLength) {
  if (value === undefined || value === null || value === '') return null
  const normalized = String(value).trim()
  if (normalized.length > maxLength) throw new Error('本地生成任务文本超过允许长度')
  return normalized || null
}

module.exports = {
  CATEGORY_DIRECTORIES,
  LocalWorkspaceService,
  assertExistingInside,
  resolveInside,
  safeSegment,
  projectRecord,
  emptyProjectData,
  normalizeProjectData,
  projectDataReferencesAsset,
  normalizeLocalGenerationJob,
  transitionLocalGenerationJob,
  validateFileSignature,
}
