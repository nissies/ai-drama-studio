const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { afterEach, beforeEach, test } = require('node:test')
const { LocalWorkspaceService } = require('./local-workspace.cjs')
const { LocalExportJobStore } = require('./local-export-jobs.cjs')

let temporaryRoot
let workspace
let store
let project

beforeEach(async () => {
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-drama-export-'))
  workspace = new LocalWorkspaceService({
    appDataPath: path.join(temporaryRoot, 'app-data'),
    documentsPath: path.join(temporaryRoot, 'documents'),
  })
  project = await workspace.createLocalProject({ title: 'Offline export' })
  store = new LocalExportJobStore({ workspace })
})

afterEach(async () => {
  await fs.rm(temporaryRoot, { recursive: true, force: true })
})

test('persists a complete local export lifecycle', async () => {
  const created = await store.create(project.id, 'episode-1', request(), 'request-1')
  assert.equal(created.status, 'WAITING_LOCAL')

  const duplicate = await store.create(project.id, 'episode-1', request(), 'request-1')
  assert.equal(duplicate.id, created.id)

  const running = await store.update(created.id, 'START', { clientExportId: 'client-export-1' })
  assert.equal(running.status, 'RUNNING')
  const progressed = await store.update(created.id, 'PROGRESS', {
    clientExportId: 'client-export-1',
    progress: 64,
    stage: 'CONCATENATING',
    shotNo: 2,
  })
  assert.equal(progressed.progress, 64)
  assert.equal(progressed.stage, 'CONCATENATING')

  const completed = await store.update(created.id, 'COMPLETE', {
    clientExportId: 'client-export-1',
    outputAssetId: 'asset-1',
    outputFilename: 'episode-1.mp4',
  })
  assert.equal(completed.status, 'SUCCEEDED')
  assert.equal(completed.progress, 100)

  const reopened = new LocalExportJobStore({ workspace })
  const jobs = await reopened.list(project.id, 'episode-1')
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].outputFilename, 'episode-1.mp4')
})

test('supports failure, retry and cancel while rejecting stale clients', async () => {
  const created = await store.create(project.id, 'episode-1', request(), 'request-2')
  await store.update(created.id, 'START', { clientExportId: 'client-a' })
  await assert.rejects(
    store.update(created.id, 'PROGRESS', { clientExportId: 'client-b', progress: 20 }),
    /不匹配/,
  )
  const failed = await store.update(created.id, 'FAIL', {
    clientExportId: 'client-a',
    message: 'ffmpeg unavailable',
  })
  assert.equal(failed.status, 'FAILED')
  const waiting = await store.update(created.id, 'RETRY')
  assert.equal(waiting.status, 'WAITING_LOCAL')
  const canceled = await store.update(created.id, 'CANCEL')
  assert.equal(canceled.status, 'CANCELED')
})

function request() {
  return {
    outputName: 'Episode 1',
    settings: {
      width: 1920,
      height: 1080,
      fps: 25,
      crf: 20,
      preset: 'fast',
      subtitles: false,
      bgmVolume: 0.5,
      sfxVolume: 0.8,
    },
    shots: [
      {
        storyboardId: 'storyboard-1',
        shotNo: 1,
        durationSec: 5,
        visualType: 'VIDEO',
        visualAssetId: 'video-1',
        audioMode: 'VIDEO_NATIVE',
      },
    ],
  }
}
