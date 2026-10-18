const { execFile } = require('node:child_process')
const { createReadStream } = require('node:fs')
const fs = require('node:fs/promises')
const path = require('node:path')
const { URL } = require('node:url')
const { promisify } = require('node:util')
const { Readable } = require('node:stream')
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  protocol,
  safeStorage,
  shell,
} = require('electron')
const { buildApplicationMenuTemplate } = require('./application-menu.cjs')
const { assertTrustedIpc, isTrustedRendererUrl } = require('./ipc-security.cjs')
const {
  LocalAiConnectionService,
  createSafeStorageEncryption,
} = require('./local-ai-connections.cjs')
const { LocalTextGenerationService } = require('./local-text-generation.cjs')
const { LocalImageGenerationService } = require('./local-image-generation.cjs')
const { LocalMediaGenerationService } = require('./local-media-generation.cjs')
const { GeneratedImageStore } = require('./generated-image-store.cjs')
const { GeneratedMediaStore } = require('./generated-media-store.cjs')
const { FfmpegComposer } = require('./ffmpeg-composer.cjs')
const { AudioExtractor } = require('./audio-extractor.cjs')
const { PoseProxyRenderer } = require('./pose-proxy-renderer.cjs')
const { LocalWorkspaceService } = require('./local-workspace.cjs')
const { LocalExportJobStore } = require('./local-export-jobs.cjs')
const { LocalChatStore } = require('./local-chat-store.cjs')
const { runtimeConfig } = require('./runtime-config.cjs')
const { DesktopUpdaterService } = require('./desktop-updater.cjs')
const { AuthStateService } = require('./auth-state.cjs')

const execFileAsync = promisify(execFile)
const isDevelopment = process.argv.includes('--dev')
const { apiOrigin, developmentUrl } = runtimeConfig
let mainWindow
let workspace
let localExportJobs
let localChats
let localAiConnections
let localTextGeneration
let localImageGeneration
let generatedImages
let localMediaGeneration
let generatedMedia
let ffmpegComposer
let audioExtractor
let poseProxyRenderer
let desktopUpdater
let authState
const protocolRequests = []
const rendererErrors = []

app.setAppUserModelId('com.aidrama.studio')
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
  {
    scheme: 'aidrama-asset',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
])

app.whenReady().then(async () => {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildApplicationMenuTemplate({ isDevelopment })))
  workspace = new LocalWorkspaceService({
    appDataPath: app.getPath('userData'),
    documentsPath: app.getPath('documents'),
  })
  localExportJobs = new LocalExportJobStore({ workspace })
  localChats = new LocalChatStore({ appDataPath: app.getPath('userData') })
  localAiConnections = new LocalAiConnectionService({
    appDataPath: app.getPath('userData'),
    encryption: createSafeStorageEncryption(safeStorage),
  })
  localTextGeneration = new LocalTextGenerationService({ connections: localAiConnections })
  generatedImages = new GeneratedImageStore({ workspace, apiOrigin })
  localImageGeneration = new LocalImageGenerationService({
    connections: localAiConnections,
    generatedImages,
  })
  generatedMedia = new GeneratedMediaStore({
    workspace,
    ffprobePath: await resolveMediaExecutable('ffprobe'),
  })
  localMediaGeneration = new LocalMediaGenerationService({
    connections: localAiConnections,
    generatedMedia,
    workspace,
  })
  ffmpegComposer = new FfmpegComposer({
    workspace,
    ffmpegPath: await resolveMediaExecutable('ffmpeg'),
    ffprobePath: await resolveMediaExecutable('ffprobe'),
  })
  audioExtractor = new AudioExtractor({
    workspace,
    ffmpegPath: await resolveMediaExecutable('ffmpeg'),
  })
  authState = new AuthStateService({
    appDataPath: app.getPath('userData'),
    encryption: createSafeStorageEncryption(safeStorage),
  })
  poseProxyRenderer = new PoseProxyRenderer({
    appDataPath: app.getPath('userData'),
    ffmpegPath: await resolveMediaExecutable('ffmpeg'),
  })
  if (!isDevelopment) registerAppProtocol()
  registerAssetProtocol()
  registerIpcHandlers()
  await createMainWindow()

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: '#f3f5f7',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.webContents.on('did-fail-load', (_, code, description, url) => {
    rendererErrors.push({ type: 'did-fail-load', code, description, url })
    console.error('Renderer failed to load', { code, description, url })
  })
  mainWindow.webContents.on('render-process-gone', (_, details) => {
    rendererErrors.push({ type: 'render-process-gone', details })
    console.error('Renderer process exited', details)
  })
  mainWindow.webContents.on('console-message', (_, details) => {
    if (details.level === 'error') {
      rendererErrors.push({ type: 'console', message: details.message })
      console.error('Renderer console error', details.message)
    }
  })
  mainWindow.webContents.on('did-finish-load', () => void writeDebugSnapshot())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isTrustedRendererUrl(url, { isDevelopment, developmentUrl })) return
    event.preventDefault()
    if (url.startsWith('https://')) void shell.openExternal(url)
  })

  if (isDevelopment) {
    await mainWindow.loadURL(developmentUrl)
  } else {
    await mainWindow.loadURL('app://studio/index.html')
  }
}

function registerAppProtocol() {
  const rendererRoot = path.resolve(__dirname, '..', 'dist')
  protocol.handle('app', async (request) => {
    const requestUrl = new URL(request.url)
    protocolRequests.push(requestUrl.toString())
    const relativePath = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, '') || 'index.html'
    const filePath = path.resolve(rendererRoot, relativePath)
    const relative = path.relative(rendererRoot, filePath)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return new Response('Forbidden', { status: 403 })
    }
    try {
      const stat = await fs.stat(filePath)
      if (!stat.isFile()) return new Response('Not found', { status: 404 })
      return new Response(await fs.readFile(filePath), {
        headers: {
          'content-type': contentTypeFor(filePath),
          ...(path.extname(filePath).toLowerCase() === '.html'
            ? {
                'content-security-policy': `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: aidrama-asset:; media-src 'self' blob: aidrama-asset:; connect-src 'self' aidrama-asset: ${apiOrigin}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
              }
            : {}),
        },
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

function registerAssetProtocol() {
  protocol.handle('aidrama-asset', async (request) => {
    try {
      if (!['GET', 'HEAD'].includes(request.method))
        return new Response('Method not allowed', { status: 405 })
      const requestUrl = new URL(request.url)
      if (requestUrl.hostname !== 'preview') return new Response('Not found', { status: 404 })
      const parts = requestUrl.pathname.split('/').filter(Boolean).map(decodeURIComponent)
      if (parts.length !== 4 || parts[0] !== 'project') {
        return new Response('Not found', { status: 404 })
      }
      const resolved =
        parts[2] === 'asset'
          ? await workspace.resolveAsset(parts[1], parts[3])
          : parts[2] === 'candidate'
            ? await resolveGeneratedCandidate(parts[1], parts[3])
            : null
      if (!resolved) return new Response('Not found', { status: 404 })
      const media = resolved.asset || resolved.candidate
      if (!['image/', 'audio/', 'video/'].some((prefix) => media.mimeType.startsWith(prefix))) {
        return new Response('Unsupported media type', { status: 415 })
      }
      const stat = await fs.stat(resolved.path)
      const headers = {
        'content-type': media.mimeType,
        'content-length': String(stat.size),
        etag: `"${media.sha256}"`,
        'cache-control': 'private, max-age=300',
        'x-content-type-options': 'nosniff',
        'accept-ranges': 'bytes',
      }
      if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
      const range = parseRange(request.headers.get('range'), stat.size)
      if (range === false) {
        return new Response(null, {
          status: 416,
          headers: { ...headers, 'content-range': `bytes */${stat.size}` },
        })
      }
      if (range) {
        const body = Readable.toWeb(createReadStream(resolved.path, range))
        return new Response(body, {
          status: 206,
          headers: {
            ...headers,
            'content-length': String(range.end - range.start + 1),
            'content-range': `bytes ${range.start}-${range.end}/${stat.size}`,
          },
        })
      }
      return new Response(Readable.toWeb(createReadStream(resolved.path)), { status: 200, headers })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

async function writeDebugSnapshot() {
  const output = process.env.AI_DRAMA_DESKTOP_DEBUG_LOG
  if (!output) return
  const renderer = await mainWindow.webContents.executeJavaScript(`({
    href: location.href,
    title: document.title,
    body: document.body.innerHTML,
    scripts: Array.from(document.scripts).map((script) => script.src),
    styles: Array.from(document.styleSheets).map((sheet) => sheet.href)
  })`)
  await fs.writeFile(
    output,
    JSON.stringify({ protocolRequests, rendererErrors, renderer }, null, 2),
    'utf8',
  )
}

function contentTypeFor(filePath) {
  return (
    {
      '.css': 'text/css; charset=utf-8',
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.wasm': 'application/wasm',
      '.webp': 'image/webp',
    }[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
  )
}

function ensureDesktopUpdater() {
  if (!desktopUpdater) {
    desktopUpdater = new DesktopUpdaterService({ apiOrigin })
  }
  return desktopUpdater
}
function registerIpcHandlers() {
  const handle = (channel, listener) => {
    ipcMain.handle(channel, (event, ...args) => {
      assertTrustedIpc(event, { isDevelopment, developmentUrl })
      return listener(...args)
    })
  }
  handle('desktop:get-runtime-status', async () => ({
    platform: process.platform,
    appVersion: app.getVersion(),
    ffmpeg: await detectFfmpeg(),
  }))
  handle('desktop:check-for-update', async (input) => {
    const updater = ensureDesktopUpdater()
    return updater.checkForUpdate(input || {})
  })
  handle('desktop:download-and-install-update', async (input) => {
    const updater = ensureDesktopUpdater()
    return updater.downloadAndInstall(input || {}, (progress) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('desktop:update-progress', progress)
      }
    })
  })
  handle('desktop:cancel-update-download', () => {
    const updater = ensureDesktopUpdater()
    return updater.cancelDownload()
  })
  handle('auth:get-persisted-state', () => authState.load())
  handle('auth:save-persisted-state', (input) => authState.save(input || {}))
  handle('auth:clear-persisted-state', () => authState.clear())
  handle('workspace:get-status', () => workspace.getWorkspaceStatus())
  handle('workspace:list-local-projects', () => workspace.listLocalProjects())
  handle('workspace:create-local-project', (input) => workspace.createLocalProject(input || {}))
  handle('workspace:delete-local-project', (projectId) => workspace.deleteLocalProject(projectId))
  handle('workspace:get-local-project-data', (projectId) =>
    workspace.getLocalProjectData(projectId),
  )
  handle('workspace:save-local-project-data', ({ projectId, data }) =>
    workspace.saveLocalProjectData(projectId, data),
  )
  handle('workspace:update-local-project', ({ projectId, input }) =>
    workspace.updateLocalProject(projectId, input || {}),
  )
  handle('workspace:create-local-generation-job', ({ projectId, job }) =>
    workspace.createLocalGenerationJob(projectId, job),
  )
  handle('workspace:get-local-generation-job', (jobId) => workspace.getLocalGenerationJob(jobId))
  handle('workspace:list-local-generation-jobs', ({ projectId, page, pageSize }) =>
    workspace.listLocalGenerationJobs(projectId, page, pageSize),
  )
  handle('workspace:list-all-local-generation-jobs', ({ page, pageSize }) =>
    workspace.listAllLocalGenerationJobs(page, pageSize),
  )
  handle('workspace:update-local-generation-job', ({ jobId, action, input }) =>
    workspace.updateLocalGenerationJob(jobId, action, input || {}),
  )
  handle('workspace:create-local-export-job', ({ projectId, episodeId, input, idempotencyKey }) =>
    localExportJobs.create(projectId, episodeId, input || {}, idempotencyKey),
  )
  handle('workspace:list-local-export-jobs', ({ projectId, episodeId }) =>
    localExportJobs.list(projectId, episodeId),
  )
  handle('workspace:get-local-export-job', (jobId) => localExportJobs.get(jobId))
  handle('workspace:update-local-export-job', ({ jobId, action, input }) =>
    localExportJobs.update(jobId, action, input || {}),
  )
  handle('local-chat:list', () => localChats.list())
  handle('local-chat:create', (input) => localChats.create(input || {}))
  handle('local-chat:get', (sessionId) => localChats.get(sessionId))
  handle('local-chat:delete', (sessionId) => localChats.delete(sessionId))
  handle('local-chat:append-turn', ({ sessionId, input }) =>
    localChats.appendTurn(sessionId, input || {}),
  )
  handle('local-chat:attach-project', ({ sessionId, projectId }) =>
    localChats.attachProject(sessionId, projectId),
  )
  handle('workspace:complete-local-image-job', ({ jobId, input }) =>
    workspace.completeLocalImageGenerationJob(jobId, input || {}),
  )
  handle('workspace:complete-local-media-job', ({ jobId, input }) =>
    workspace.completeLocalMediaGenerationJob(jobId, input || {}),
  )
  handle('workspace:list-local-image-candidates', ({ projectId, targetType, targetId }) =>
    workspace.listLocalImageCandidates(projectId, targetType, targetId),
  )
  handle('workspace:list-local-media-candidates', ({ projectId, storyboardId, mediaType }) =>
    workspace.listLocalMediaCandidates(projectId, storyboardId, mediaType),
  )
  handle('workspace:get-local-image-candidate', (candidateId) =>
    workspace.getLocalImageCandidate(candidateId),
  )
  handle('workspace:get-local-media-candidate', (candidateId) =>
    workspace.getLocalMediaCandidate(candidateId),
  )
  handle('workspace:update-local-image-candidate', ({ candidateId, action, input }) =>
    workspace.updateLocalImageCandidate(candidateId, action, input || {}),
  )
  handle('workspace:update-local-media-candidate', ({ candidateId, action, input }) =>
    workspace.updateLocalMediaCandidate(candidateId, action, input || {}),
  )
  handle('workspace:select-root', async () => {
    const current = await workspace.getWorkspaceStatus()
    const selection = await showOpenDialog({
      title: '选择本地素材工作目录',
      defaultPath: current.workspaceRoot,
      properties: ['openDirectory', 'createDirectory'],
    })
    if (selection.canceled || selection.filePaths.length === 0) return current
    return workspace.selectWorkspaceRoot(selection.filePaths[0])
  })
  handle('workspace:ensure-project', (project) => workspace.ensureProject(project))
  handle('workspace:get-project', (projectId) => workspace.getProject(projectId))
  handle('workspace:import-assets', async (request) => {
    const filters = filtersFor(request.category)
    const selection = await showOpenDialog({
      title: '导入本地素材',
      properties: ['openFile', 'multiSelections'],
      filters,
    })
    if (selection.canceled || selection.filePaths.length === 0) return []
    return workspace.importFiles(request.projectId, request.category, selection.filePaths)
  })
  handle('workspace:remove-asset', (request) =>
    workspace.removeAsset(request.projectId, request.assetId),
  )
  handle('workspace:reconcile-asset-ids', (request) =>
    workspace.reconcileAssetIds(request.projectId, request.mappings),
  )
  handle('workspace:reveal-asset', async (request) => {
    const assetPath = await workspace.resolveAssetPath(request.projectId, request.assetId)
    shell.showItemInFolder(assetPath)
  })
  handle('workspace:reveal-project', async (projectId) => {
    const project = await workspace.getProject(projectId)
    await shell.openPath(project.directory)
  })
  handle('workspace:export-video-assets', async (request) => {
    const selection = await showOpenDialog({
      title: '选择批量视频导出目录',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (selection.canceled || selection.filePaths.length === 0) {
      return { canceled: true, directory: null, files: [] }
    }
    const result = await workspace.exportVideoAssets(
      request.projectId,
      request.items,
      selection.filePaths[0],
    )
    if (result.files[0]) shell.showItemInFolder(result.files[0].filePath)
    return result
  })
  handle('local-ai:list', () => localAiConnections.list())
  handle('local-ai:save', (input) => localAiConnections.save(input))
  handle('local-ai:discover-models', (input) => localAiConnections.discoverModels(input))
  handle('local-ai:delete', ({ id, version }) => localAiConnections.delete(id, version))
  handle('local-ai:test-address', (id) => localAiConnections.testAddress(id))
  handle('local-ai:generate-text', (input) => localTextGeneration.generate(input))
  handle('local-ai:generate-image', (input) => localImageGeneration.generate(input))
  handle('workspace:discard-generated-image', ({ projectId, candidateId }) =>
    generatedImages.discard(projectId, candidateId),
  )
  handle('workspace:discard-generated-media', ({ projectId, candidateId }) =>
    generatedMedia.discard(projectId, candidateId),
  )
  handle('workspace:cache-platform-image', (input) => generatedImages.downloadToCache(input))
  handle('local-ai:generate-media', (input) => localMediaGeneration.generate(input))
  handle('workspace:save-generated-image', async (input) => {
    await workspace.ensureProject({ id: input?.projectId, title: input?.projectTitle })
    if (input?.deliveryType === 'LOCAL_CACHE') {
      return generatedImages.promote(input.projectId, input.clientCandidateId, input.category)
    }
    if (input?.deliveryType === 'PLATFORM_REMOTE') {
      return generatedImages.downloadAndPromote({
        projectId: input.projectId,
        candidateId: input.candidateId,
        category: input.category,
        accessToken: input.accessToken,
      })
    }
    throw new Error('生成图片来源无效')
  })
  handle('workspace:save-generated-media', async (input) => {
    await workspace.ensureProject({ id: input?.projectId, title: input?.projectTitle })
    if (input?.deliveryType === 'LOCAL_CACHE') {
      return generatedMedia.promote(input.projectId, input.clientCandidateId)
    }
    if (['PLATFORM_REMOTE', 'PLATFORM_CACHE'].includes(input?.deliveryType)) {
      return generatedMedia.downloadAndPromote({
        projectId: input.projectId,
        candidateId: input.candidateId,
        category: input.category,
        accessToken: input.accessToken,
        apiOrigin,
      })
    }
    throw new Error('生成媒体来源无效')
  })
  handle('desktop:compose-episode', (input) =>
    ffmpegComposer.compose(input, (progress) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('desktop:export-progress', progress)
      }
    }),
  )
  handle('desktop:cancel-export', (exportId) => ffmpegComposer.cancel(exportId))
  handle('desktop:extract-voice-sample', (input) => audioExtractor.extractVoiceSample(input))
  handle('desktop:extract-last-video-frame', (input) => audioExtractor.extractLastVideoFrame(input))
  handle('desktop:extract-video-frame', (input) => audioExtractor.extractVideoFrame(input))
  handle('desktop:render-pose-proxy', (input) =>
    poseProxyRenderer.render(input, (progress) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('desktop:pose-proxy-progress', progress)
      }
    }),
  )
  handle('desktop:cancel-pose-proxy', (taskId) => poseProxyRenderer.cancel(taskId))
}

function showOpenDialog(options) {
  const owner = BrowserWindow.getFocusedWindow() || mainWindow
  return owner && !owner.isDestroyed()
    ? dialog.showOpenDialog(owner, options)
    : dialog.showOpenDialog(options)
}

async function detectFfmpeg() {
  const executable = await resolveMediaExecutable('ffmpeg')
  const bundled = path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe')
  try {
    const { stdout } = await execFileAsync(executable, ['-version'], {
      timeout: 5000,
      windowsHide: true,
    })
    const version = stdout.split(/\r?\n/, 1)[0] || 'FFmpeg available'
    return { available: true, bundled: executable === bundled, executable, version }
  } catch {
    return { available: false, bundled: false, executable, version: null }
  }
}

async function resolveMediaExecutable(name) {
  const executableName = process.platform === 'win32' ? `${name}.exe` : name
  const bundled = path.join(process.resourcesPath, 'ffmpeg', executableName)
  return (await fileExists(bundled)) ? bundled : name
}

async function resolveGeneratedCandidate(projectId, candidateId) {
  try {
    return await generatedImages.resolve(projectId, candidateId)
  } catch {
    return generatedMedia.resolve(projectId, candidateId)
  }
}

function parseRange(value, size) {
  if (!value) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
  if (!match || (!match[1] && !match[2])) return false
  let start
  let end
  if (!match[1]) {
    const suffix = Number(match[2])
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] ? Number(match[2]) : size - 1
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  )
    return false
  return { start, end: Math.min(end, size - 1) }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

function filtersFor(category) {
  if (['images', 'characters', 'scenes', 'storyboards'].includes(category)) {
    return [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
  }
  if (category === 'audio') {
    return [{ name: '音频', extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'] }]
  }
  if (['videos', 'exports'].includes(category)) {
    return [{ name: '视频', extensions: ['mp4', 'mov', 'webm', 'mkv'] }]
  }
  return [{ name: '全部文件', extensions: ['*'] }]
}
