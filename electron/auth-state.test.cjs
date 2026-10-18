const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { afterEach, beforeEach, test } = require('node:test')
const { AuthStateService } = require('./auth-state.cjs')

let temporaryRoot

beforeEach(async () => {
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-drama-auth-'))
})

afterEach(async () => {
  await fs.rm(temporaryRoot, { recursive: true, force: true })
})

test('encrypts credentials and restores them across service instances', async () => {
  const encryption = createEncryption()
  const first = new AuthStateService({ appDataPath: temporaryRoot, encryption })
  const input = {
    account: 'creator@example.com',
    password: ' secret-with-spaces ',
    accessToken: 'jwt-token',
    expiresAt: '2026-08-03T00:00:00Z',
  }

  await first.save(input)

  const raw = await fs.readFile(path.join(temporaryRoot, 'auth-state.json'), 'utf8')
  assert.doesNotMatch(raw, /creator@example\.com|secret-with-spaces|jwt-token/)
  const second = new AuthStateService({ appDataPath: temporaryRoot, encryption })
  assert.deepEqual(await second.load(), input)
})

test('clears persisted authentication state', async () => {
  const service = new AuthStateService({
    appDataPath: temporaryRoot,
    encryption: createEncryption(),
  })
  await service.save({
    account: 'creator@example.com',
    password: 'password123',
    accessToken: 'jwt-token',
    expiresAt: '',
  })

  await service.clear()

  assert.equal(await service.load(), null)
})

function createEncryption() {
  return {
    isAvailable: () => true,
    encrypt: (value) => Buffer.from(value, 'utf8').map((byte) => byte ^ 0x5a),
    decrypt: (value) => Buffer.from(value).map((byte) => byte ^ 0x5a).toString('utf8'),
  }
}
