const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { afterEach, beforeEach, test } = require('node:test')
const { LocalWorkspaceService, resolveInside, safeSegment } = require('./local-workspace.cjs')

let temporaryRoot
let service

beforeEach(async () => {
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-drama-workspace-'))
  service = new LocalWorkspaceService({
    appDataPath: path.join(temporaryRoot, 'app-data'),
    documentsPath: path.join(temporaryRoot, 'documents'),
  })
})

afterEach(async () => {
  await fs.rm(temporaryRoot, { recursive: true, force: true })
})

test('creates a portable project workspace without media on the server', async () => {
  const project = await service.ensureProject({ id: 'project-12345678', title: 'Test: Drama?' })

  assert.match(project.directory, /Test_ Drama_-project1$/)
  assert.equal(project.assets.length, 0)
  const manifest = JSON.parse(await fs.readFile(project.manifestPath, 'utf8'))
  assert.equal(manifest.version, 2)
  assert.equal(manifest.projectId, 'project-12345678')
  assert.deepEqual(manifest.assets, [])
  await fs.access(path.join(project.directory, 'assets', 'videos'))
  await fs.access(path.join(project.directory, 'exports'))
  await fs.access(path.join(project.directory, 'cache'))
})

test('lists only local projects and keeps their project metadata', async () => {
  await service.ensureProject({ id: 'cloud-cache', title: 'Cloud cache' })
  const created = await service.createLocalProject({
    title: 'Offline drama',
    description: 'Local project description',
    visualStyle: 'ANIME_2D',
    aspectRatio: '9:16',
  })

  const projects = await service.listLocalProjects()

  assert.equal(projects.length, 1)
  assert.equal(projects[0].id, created.id)
  assert.equal(projects[0].title, 'Offline drama')
  assert.equal(projects[0].description, 'Local project description')
  assert.equal(projects[0].visualStyle, 'ANIME_2D')
  assert.equal(projects[0].aspectRatio, '9:16')
})

test('keeps the standalone video lab hidden while allowing offline generation data', async () => {
  const projectId = '00000000-video-lab-workspace'
  await service.ensureProject({ id: projectId, title: 'Video lab' })

  const data = await service.getLocalProjectData(projectId)
  assert.equal(data.projectId, projectId)
  assert.equal((await service.listLocalProjects()).some((item) => item.id === projectId), false)

  const now = new Date().toISOString()
  const job = await service.createLocalGenerationJob(projectId, {
    id: `local-job-${crypto.randomUUID()}`,
    projectId,
    jobType: 'VIDEO_GENERATION',
    serviceType: 'VIDEO',
    targetType: 'VIDEO_LAB',
    targetId: '00000000-video-lab-storyboard',
    targetVersion: 0,
    sourceType: 'LOCAL',
    localConnectionId: 'connection-1',
    status: 'WAITING_LOCAL',
    progress: 0,
    executionRequest: {
      systemPrompt: 'Local media snapshot',
      userPrompt: 'A standalone video prompt.',
      parameters: { duration_sec: 5 },
    },
    attemptCount: 0,
    createdAt: now,
    updatedAt: now,
  })
  assert.equal(job.projectId, projectId)
})

test('removes a local project from the registry without permanently deleting its files', async () => {
  const created = await service.createLocalProject({ title: 'Recoverable project' })
  const localProject = await service.getProject(created.id)

  const deleted = await service.deleteLocalProject(created.id)

  assert.equal((await service.listLocalProjects()).length, 0)
  await assert.rejects(service.getProject(created.id), /尚未初始化/)
  await fs.access(deleted.deletedDirectory)
  await fs.access(path.join(deleted.deletedDirectory, 'project.aidrama.json'))
  await assert.rejects(fs.access(localProject.directory))
})

test('persists local project business data with optimistic revisions', async () => {
  const created = await service.createLocalProject({ title: 'Offline production' })
  const initial = await service.getLocalProjectData(created.id)

  assert.equal(initial.revision, 0)
  assert.deepEqual(initial.episodes, [])

  const saved = await service.saveLocalProjectData(created.id, {
    ...initial,
    episodes: [
      {
        id: 'episode-1',
        projectId: created.id,
        episodeNo: 1,
        title: 'Episode one',
        targetDurationSec: 60,
        status: 'DRAFT',
        version: 0,
        updatedAt: new Date().toISOString(),
      },
    ],
  })

  assert.equal(saved.revision, 1)
  assert.equal(saved.episodes[0].title, 'Episode one')
  await assert.rejects(
    service.saveLocalProjectData(created.id, initial),
    /已被其他操作更新/,
  )

  const reopened = new LocalWorkspaceService({
    appDataPath: path.join(temporaryRoot, 'app-data'),
    documentsPath: path.join(temporaryRoot, 'documents'),
  })
  const persisted = await reopened.getLocalProjectData(created.id)
  assert.equal(persisted.revision, 1)
  assert.equal(persisted.episodes[0].id, 'episode-1')
})

test('updates local project settings without calling a server', async () => {
  const created = await service.createLocalProject({ title: 'Local settings' })

  const updated = await service.updateLocalProject(created.id, {
    visualStyle: 'ANIME_2D',
    visualBible: 'Keep the visual identity consistent.',
    aspectRatio: '16:9',
    version: created.version,
  })

  assert.equal(updated.visualStyle, 'ANIME_2D')
  assert.equal(updated.visualBible, 'Keep the visual identity consistent.')
  assert.equal(updated.aspectRatio, '16:9')
  assert.equal(updated.version, 1)
  await assert.rejects(
    service.updateLocalProject(created.id, {
      aspectRatio: '9:16',
      version: created.version,
    }),
    /已被其他操作更新/,
  )
})

test('persists local generation jobs and enforces state transitions', async () => {
  const created = await service.createLocalProject({ title: 'Local generation' })
  const now = new Date().toISOString()
  const job = await service.createLocalGenerationJob(created.id, {
    id: `local-job-${crypto.randomUUID()}`,
    projectId: created.id,
    jobType: 'SCRIPT_GENERATE',
    serviceType: 'TEXT',
    targetType: 'EPISODE',
    targetId: 'episode-1',
    targetVersion: 0,
    sourceType: 'LOCAL',
    localConnectionId: 'connection-1',
    sourceDisplayName: 'Ollama',
    modelName: 'qwen3',
    status: 'WAITING_LOCAL',
    progress: 0,
    executionRequest: {
      systemPrompt: 'Write a short drama script.',
      userPrompt: 'Episode synopsis',
      parameters: { temperature: 0.5 },
    },
    attemptCount: 0,
    createdAt: now,
    updatedAt: now,
  })

  const running = await service.updateLocalGenerationJob(job.id, 'START')
  assert.equal(running.status, 'RUNNING')
  const completed = await service.updateLocalGenerationJob(job.id, 'COMPLETE', {
    text: 'Generated script',
    providerCode: 'OLLAMA',
    modelName: 'qwen3',
  })
  assert.equal(completed.status, 'SUCCEEDED')
  assert.equal(completed.resultText, 'Generated script')
  await assert.rejects(service.updateLocalGenerationJob(job.id, 'START'), /不能开始执行/)

  const reopened = new LocalWorkspaceService({
    appDataPath: path.join(temporaryRoot, 'app-data'),
    documentsPath: path.join(temporaryRoot, 'documents'),
  })
  const page = await reopened.listLocalGenerationJobs(created.id, 1, 20)
  assert.equal(page.total, 1)
  assert.equal(page.items[0].status, 'SUCCEEDED')
})

test('supports canceling and retrying a failed local generation job', async () => {
  const created = await service.createLocalProject({ title: 'Retry local generation' })
  const now = new Date().toISOString()
  const job = await service.createLocalGenerationJob(created.id, {
    id: `local-job-${crypto.randomUUID()}`,
    projectId: created.id,
    jobType: 'SCRIPT_REWRITE',
    serviceType: 'TEXT',
    targetType: 'EPISODE',
    targetId: 'episode-1',
    targetVersion: 1,
    sourceType: 'LOCAL',
    localConnectionId: 'connection-1',
    status: 'WAITING_LOCAL',
    progress: 0,
    executionRequest: {
      systemPrompt: 'Rewrite the script.',
      userPrompt: 'Original script',
      parameters: {},
    },
    attemptCount: 0,
    createdAt: now,
    updatedAt: now,
  })

  await service.updateLocalGenerationJob(job.id, 'START')
  const failed = await service.updateLocalGenerationJob(job.id, 'FAIL', {
    message: 'Provider unavailable',
  })
  assert.equal(failed.status, 'FAILED')
  const retried = await service.updateLocalGenerationJob(job.id, 'RETRY')
  assert.equal(retried.status, 'WAITING_LOCAL')
  assert.equal(retried.attemptCount, 1)
  const canceled = await service.updateLocalGenerationJob(job.id, 'CANCEL')
  assert.equal(canceled.status, 'CANCELED')
})

test('persists and updates local image candidates', async () => {
  const created = await service.createLocalProject({ title: 'Local images' })
  const now = new Date().toISOString()
  const job = await service.createLocalGenerationJob(created.id, {
    id: `local-job-${crypto.randomUUID()}`,
    projectId: created.id,
    jobType: 'IMAGE_GENERATION',
    serviceType: 'IMAGE',
    targetType: 'CHARACTER',
    targetId: 'character-1',
    targetVersion: 0,
    sourceType: 'LOCAL',
    localConnectionId: 'connection-1',
    status: 'WAITING_LOCAL',
    progress: 0,
    executionRequest: {
      systemPrompt: 'Local image snapshot',
      userPrompt: 'Character portrait',
      parameters: { size: '1024x1536', composition_type: 'SINGLE' },
    },
    attemptCount: 0,
    createdAt: now,
    updatedAt: now,
  })
  await service.updateLocalGenerationJob(job.id, 'START')
  const candidate = await service.completeLocalImageGenerationJob(job.id, {
    clientCandidateId: crypto.randomUUID(),
    providerCode: 'OPENAI',
    modelName: 'gpt-image-1',
    mimeType: 'image/png',
    sizeBytes: 1024,
    sha256: 'a'.repeat(64),
    width: 1024,
    height: 1536,
  })

  assert.equal(candidate.status, 'AVAILABLE')
  assert.equal((await service.listLocalImageCandidates(created.id, 'CHARACTER', 'character-1')).length, 1)
  const selected = await service.updateLocalImageCandidate(candidate.id, 'SELECT', {
    version: candidate.version,
  })
  assert.equal(selected.status, 'SELECTED')
  const saved = await service.updateLocalImageCandidate(candidate.id, 'SAVE', {
    version: selected.version,
    assetId: 'asset-1',
  })
  assert.equal(saved.status, 'LOCAL_SAVED')
  assert.equal(saved.localAssetId, 'asset-1')
})

test('persists local video candidates independently from image candidates', async () => {
  const created = await service.createLocalProject({ title: 'Local videos' })
  const now = new Date().toISOString()
  const job = await service.createLocalGenerationJob(created.id, {
    id: `local-job-${crypto.randomUUID()}`,
    projectId: created.id,
    jobType: 'VIDEO_GENERATION',
    serviceType: 'VIDEO',
    targetType: 'STORYBOARD',
    targetId: 'storyboard-1',
    targetVersion: 0,
    sourceType: 'LOCAL',
    localConnectionId: 'connection-1',
    status: 'WAITING_LOCAL',
    progress: 0,
    executionRequest: {
      systemPrompt: 'Local media snapshot',
      userPrompt: 'Slow camera push toward the character.',
      parameters: { duration_sec: 6 },
    },
    attemptCount: 0,
    createdAt: now,
    updatedAt: now,
  })
  await service.updateLocalGenerationJob(job.id, 'START')
  const candidate = await service.completeLocalMediaGenerationJob(job.id, {
    clientCandidateId: crypto.randomUUID(),
    providerCode: 'LOCAL_VIDEO',
    modelName: 'video-model',
    mimeType: 'video/mp4',
    sizeBytes: 2048,
    sha256: 'b'.repeat(64),
    durationMs: 6000,
    width: 1280,
    height: 720,
  })

  assert.equal(candidate.mediaType, 'VIDEO')
  assert.equal(candidate.status, 'AVAILABLE')
  assert.equal(
    (await service.listLocalMediaCandidates(created.id, 'storyboard-1', 'VIDEO')).length,
    1,
  )
  assert.equal((await service.getLocalGenerationJob(job.id)).status, 'SUCCEEDED')
})

test('streams imported files into the project and deduplicates by sha256', async () => {
  await service.ensureProject({ id: 'p-1', title: 'Local project' })
  const source = path.join(temporaryRoot, 'shot.mp4')
  await fs.writeFile(source, Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from('ftypisom')]))

  const first = await service.importFiles('p-1', 'videos', [source])
  const second = await service.importFiles('p-1', 'videos', [source])
  const project = await service.getProject('p-1')

  assert.equal(first[0].duplicate, false)
  assert.equal(second[0].duplicate, true)
  assert.equal(second[0].id, first[0].id)
  assert.equal(project.assets.length, 1)
  assert.equal(project.assets[0].sizeBytes, 12)
  assert.equal(project.assets[0].fileAvailable, true)
  await fs.access(path.join(project.directory, project.assets[0].relativePath))
})

test('imports valid MP3 audio with a large ID3v2 tag before MPEG Layer III frames', async () => {
  await service.ensureProject({ id: 'p-mp3', title: 'MP3 project' })
  const source = path.join(temporaryRoot, 'voice.mp3')
  const tagPayload = Buffer.alloc(64 * 1024, 0x20)
  const tagHeader = Buffer.from([
    0x49,
    0x44,
    0x33,
    0x04,
    0x00,
    0x00,
    (tagPayload.length >> 21) & 0x7f,
    (tagPayload.length >> 14) & 0x7f,
    (tagPayload.length >> 7) & 0x7f,
    tagPayload.length & 0x7f,
  ])
  await fs.writeFile(source, Buffer.concat([tagHeader, tagPayload, mp3Frames(3)]))

  const [asset] = await service.importFiles('p-mp3', 'audio', [source])

  assert.equal(asset.mimeType, 'audio/mpeg')
  assert.equal(asset.duplicate, false)
  assert.equal(asset.fileAvailable, true)
})

test('imports valid MP3 audio without ID3 and rejects a tag-only fake MP3', async () => {
  await service.ensureProject({ id: 'p-mp3-raw', title: 'Raw MP3 project' })
  const valid = path.join(temporaryRoot, 'raw.mp3')
  const fake = path.join(temporaryRoot, 'fake.mp3')
  await fs.writeFile(valid, mp3Frames(2))
  await fs.writeFile(fake, Buffer.concat([Buffer.from('ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0010'), Buffer.alloc(16)]))

  const [asset] = await service.importFiles('p-mp3-raw', 'audio', [valid])

  assert.equal(asset.mimeType, 'audio/mpeg')
  await assert.rejects(service.importFiles('p-mp3-raw', 'audio', [fake]), /不匹配/)
})

test('repairs a missing duplicate instead of discarding the replacement', async () => {
  await service.ensureProject({ id: 'p-repair', title: 'Repair project' })
  const source = path.join(temporaryRoot, 'portrait.png')
  await fs.writeFile(
    source,
    Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('image-content')]),
  )
  const [first] = await service.importFiles('p-repair', 'characters', [source])
  const project = await service.getProject('p-repair')
  await fs.unlink(path.join(project.directory, first.relativePath))

  const [repaired] = await service.importFiles('p-repair', 'characters', [source])
  const reloaded = await service.getProject('p-repair')

  assert.equal(repaired.id, first.id)
  assert.equal(repaired.duplicate, true)
  assert.equal(repaired.repaired, true)
  assert.equal(reloaded.assets[0].fileAvailable, true)
})

test('does not delete a local asset while business data still references it', async () => {
  const created = await service.createLocalProject({ title: 'Referenced assets' })
  const source = path.join(temporaryRoot, 'scene.png')
  await fs.writeFile(
    source,
    Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('scene-image')]),
  )
  const [asset] = await service.importFiles(created.id, 'scenes', [source])
  const data = await service.getLocalProjectData(created.id)
  await service.saveLocalProjectData(created.id, {
    ...data,
    sceneReferences: [
      {
        id: 'reference-1',
        episodeId: 'episode-1',
        sceneId: 'scene-1',
        assetId: asset.id,
        referenceType: 'OVERVIEW',
        primaryReference: true,
        sortOrder: 0,
        version: 0,
        updatedAt: new Date().toISOString(),
      },
    ],
  })

  await assert.rejects(service.removeAsset(created.id, asset.id), /正在被角色、场景或分镜使用/)
  assert.equal((await service.getProject(created.id)).assets.length, 1)
})

test('rejects a file whose content does not match its image extension', async () => {
  await service.ensureProject({ id: 'p-invalid', title: 'Invalid project' })
  const source = path.join(temporaryRoot, 'fake.png')
  await fs.writeFile(source, Buffer.from('this-is-not-a-png'))

  await assert.rejects(service.importFiles('p-invalid', 'characters', [source]), /不匹配/)
  assert.equal((await service.getProject('p-invalid')).assets.length, 0)
})

test('reconciles local ids with canonical server asset ids', async () => {
  await service.ensureProject({ id: 'p-sync', title: 'Sync project' })
  const source = path.join(temporaryRoot, 'portrait.png')
  await fs.writeFile(
    source,
    Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('image-content')]),
  )
  const [asset] = await service.importFiles('p-sync', 'characters', [source])
  const canonicalId = '22222222-2222-4222-8222-222222222222'

  const project = await service.reconcileAssetIds('p-sync', [
    { clientAssetId: asset.id, assetId: canonicalId },
  ])

  assert.equal(project.assets[0].id, canonicalId)
  assert.equal((await service.resolveAsset('p-sync', canonicalId)).asset.id, canonicalId)
})

test('keeps existing projects available after changing the default workspace root', async () => {
  const project = await service.ensureProject({ id: 'p-old-root', title: 'Old root project' })
  const nextRoot = path.join(temporaryRoot, 'another-workspace')

  await service.selectWorkspaceRoot(nextRoot)
  const reopened = await service.getProject('p-old-root')

  assert.equal(reopened.directory, project.directory)
  assert.notEqual(path.dirname(reopened.directory), nextRoot)
})

test('keeps imported project media after an app update or reinstall', async () => {
  const appDataPath = path.join(temporaryRoot, 'app-data')
  const documentsPath = path.join(temporaryRoot, 'documents')
  const project = await service.ensureProject({ id: 'p-update', title: 'Persistent project' })
  const source = path.join(temporaryRoot, 'character.png')
  await fs.writeFile(
    source,
    Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('persistent-image')]),
  )
  const [imported] = await service.importFiles('p-update', 'characters', [source])

  const serviceAfterUpdate = new LocalWorkspaceService({ appDataPath, documentsPath })
  const reopened = await serviceAfterUpdate.getProject('p-update')

  assert.equal(reopened.directory, project.directory)
  assert.equal(reopened.assets.length, 1)
  assert.equal(reopened.assets[0].id, imported.id)
  assert.equal(reopened.assets[0].fileAvailable, true)
  await fs.access(path.join(reopened.directory, reopened.assets[0].relativePath))
})

test('recovers project registrations from manifests when app settings are lost during an update', async () => {
  const appDataPath = path.join(temporaryRoot, 'app-data')
  const documentsPath = path.join(temporaryRoot, 'documents')
  const project = await service.ensureProject({ id: 'p-registry-recovery', title: 'Recovered project' })
  const source = path.join(temporaryRoot, 'recovered.png')
  await fs.writeFile(
    source,
    Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('recovered-image')]),
  )
  const [imported] = await service.importFiles('p-registry-recovery', 'images', [source])
  await fs.rm(path.join(appDataPath, 'desktop-settings.json'))

  const serviceAfterUpdate = new LocalWorkspaceService({ appDataPath, documentsPath })
  const reopened = await serviceAfterUpdate.getProject('p-registry-recovery')

  assert.equal(reopened.directory, project.directory)
  assert.equal(reopened.assets[0].id, imported.id)
  assert.equal(reopened.assets[0].fileAvailable, true)
})

test('keeps paths inside the project directory', () => {
  const root = path.join(temporaryRoot, 'project')
  assert.throws(() => resolveInside(root, '../outside.mp4'), /超出项目目录/)
  assert.equal(safeSegment('A<>:"/\\|?*B. ', 'project'), 'A_________B')
  assert.equal(safeSegment('CON.png', 'asset'), '_CON.png')
})

test('exports registered videos with ordered names without overwriting existing files', async () => {
  await service.ensureProject({ id: 'p-export', title: 'Export project' })
  const source = path.join(temporaryRoot, 'shot.mp4')
  await fs.writeFile(source, Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from('ftypisom')]))
  const [asset] = await service.importFiles('p-export', 'videos', [source])
  const destination = path.join(temporaryRoot, 'delivery')
  await fs.mkdir(destination)
  await fs.writeFile(path.join(destination, '001-opening.mp4'), 'existing')

  const result = await service.exportVideoAssets(
    'p-export',
    [{ assetId: asset.id, fileName: '001-opening.mp4' }],
    destination,
  )

  assert.equal(result.canceled, false)
  assert.equal(result.files[0].fileName, '001-opening (2).mp4')
  assert.deepEqual(await fs.readFile(result.files[0].filePath), await fs.readFile(source))
})

function mp3Frames(count) {
  const frameLength = 417
  return Buffer.concat(
    Array.from({ length: count }, () => {
      const frame = Buffer.alloc(frameLength)
      Buffer.from([0xff, 0xfb, 0x90, 0x64]).copy(frame)
      return frame
    }),
  )
}

test('rejects exporting non-video project assets', async () => {
  await service.ensureProject({ id: 'p-export-image', title: 'Export image' })
  const source = path.join(temporaryRoot, 'frame.png')
  await fs.writeFile(
    source,
    Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('frame')]),
  )
  const [asset] = await service.importFiles('p-export-image', 'storyboards', [source])
  const destination = path.join(temporaryRoot, 'delivery-image')
  await fs.mkdir(destination)

  await assert.rejects(
    service.exportVideoAssets(
      'p-export-image',
      [{ assetId: asset.id, fileName: 'frame.mp4' }],
      destination,
    ),
    /不是视频|不在本地项目清单/,
  )
})
