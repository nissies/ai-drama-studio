const test = require('node:test')
const assert = require('node:assert/strict')
const { DesktopUpdaterService } = require('./desktop-updater.cjs')

test('DesktopUpdaterService constructs with api origin', () => {
  const service = new DesktopUpdaterService({
    apiOrigin: 'http://127.0.0.1:8080',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          data: { updateAvailable: false, mandatory: false, currentVersion: '0.1.0', latest: null },
        }),
      headers: { get: () => null },
    }),
  })
  assert.equal(typeof service.checkForUpdate, 'function')
  assert.equal(typeof service.downloadAndInstall, 'function')
})

test('checkForUpdate returns no update payload', async () => {
  const service = new DesktopUpdaterService({
    apiOrigin: 'http://127.0.0.1:8080/',
    fetchImpl: async (url) => {
      assert.match(String(url), /\/api\/v1\/desktop-releases\/latest/)
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () =>
          JSON.stringify({
            data: {
              updateAvailable: false,
              mandatory: false,
              currentVersion: '0.1.0',
              latest: null,
            },
          }),
      }
    },
  })
  const result = await service.checkForUpdate({ currentVersion: '0.1.0' })
  assert.equal(result.updateAvailable, false)
  assert.equal(result.currentVersion, '0.1.0')
  assert.equal(result.latest, null)
})

test('checkForUpdate maps latest release', async () => {
  const service = new DesktopUpdaterService({
    apiOrigin: 'http://api.example:18080',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () =>
        JSON.stringify({
          data: {
            updateAvailable: true,
            mandatory: true,
            currentVersion: '0.1.0',
            latest: {
              id: 'rel-1',
              versionName: '0.1.1',
              versionCode: 1001,
              channel: 'STABLE',
              platform: 'WIN_X64',
              title: 'fix',
              releaseNotes: 'bugfix',
              mandatory: true,
              sizeBytes: 12,
              sha256: 'a'.repeat(64),
              fileName: 'setup.exe',
              publishedAt: '2026-07-27T00:00:00',
            },
          },
        }),
    }),
  })
  const result = await service.checkForUpdate({ currentVersion: '0.1.0' })
  assert.equal(result.updateAvailable, true)
  assert.equal(result.mandatory, true)
  assert.equal(result.latest.versionName, '0.1.1')
  assert.equal(result.latest.sha256.length, 64)
})

test('cancelDownload keeps the active operation reserved until its request settles', () => {
  const service = new DesktopUpdaterService({
    apiOrigin: 'http://127.0.0.1:8080',
    fetchImpl: async () => {
      throw new Error('not used')
    },
  })
  const controller = new AbortController()
  service.activeDownload = { controller, targetPath: 'update.exe' }

  assert.equal(service.cancelDownload(), true)
  assert.equal(controller.signal.aborted, true)
  assert.notEqual(service.activeDownload, null)
})
