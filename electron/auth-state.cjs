const fs = require('node:fs/promises')
const path = require('node:path')

const AUTH_STATE_VERSION = 1

class AuthStateService {
  constructor({ appDataPath, encryption }) {
    if (!appDataPath) throw new Error('appDataPath is required')
    if (!encryption) throw new Error('encryption adapter is required')
    this.filePath = path.join(appDataPath, 'auth-state.json')
    this.encryption = encryption
  }

  async load() {
    let state
    try {
      state = JSON.parse(await fs.readFile(this.filePath, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      if (error instanceof SyntaxError) return null
      throw error
    }
    if (!isValidState(state) || !this.encryption.isAvailable()) return null
    try {
      return {
        account: this.encryption.decrypt(Buffer.from(state.account, 'base64')),
        password: this.encryption.decrypt(Buffer.from(state.password, 'base64')),
        accessToken: state.accessToken
          ? this.encryption.decrypt(Buffer.from(state.accessToken, 'base64'))
          : '',
        expiresAt: typeof state.expiresAt === 'string' ? state.expiresAt : '',
      }
    } catch {
      return null
    }
  }

  async save({ account, password, accessToken, expiresAt }) {
    if (!this.encryption.isAvailable()) {
      throw new Error('当前系统不支持安全保存登录信息')
    }
    const normalizedAccount = typeof account === 'string' ? account.trim() : ''
    const normalizedPassword = typeof password === 'string' ? password : ''
    const normalizedAccessToken = typeof accessToken === 'string' ? accessToken.trim() : ''
    if (!normalizedAccount || !normalizedPassword || !normalizedAccessToken) {
      throw new Error('登录信息不完整，无法保存')
    }
    const state = {
      version: AUTH_STATE_VERSION,
      account: this.encryption.encrypt(normalizedAccount).toString('base64'),
      password: this.encryption.encrypt(normalizedPassword).toString('base64'),
      accessToken: this.encryption.encrypt(normalizedAccessToken).toString('base64'),
      expiresAt: typeof expiresAt === 'string' ? expiresAt : '',
    }
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.tmp`
    await fs.writeFile(temporaryPath, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 })
    await fs.rename(temporaryPath, this.filePath)
  }

  async clear() {
    try {
      await fs.unlink(this.filePath)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
}

function isValidState(value) {
  return (
    value &&
    value.version === AUTH_STATE_VERSION &&
    typeof value.account === 'string' &&
    typeof value.password === 'string' &&
    typeof value.accessToken === 'string'
  )
}

module.exports = { AuthStateService }
