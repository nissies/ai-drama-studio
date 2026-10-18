import { defineStore } from 'pinia'
import {
  ApiClientError,
  authApi,
  clearRememberedAuth,
  clearToken,
  getStoredToken,
  hydrateStoredAuth,
  saveRememberedAuth,
  storeToken,
  type CurrentUser,
} from '../api/client'
import { router } from '../router'
import { useCreditStore } from './credits'

const PROFILE_KEY = 'ai-drama-user-profile'

function readProfile() {
  try {
    const raw = globalThis.localStorage?.getItem(PROFILE_KEY)
    if (!raw) return { account: '', displayName: '', hasAvatar: false }
    const parsed = JSON.parse(raw) as {
      account?: string
      displayName?: string
      hasAvatar?: boolean
    }
    return {
      account: parsed.account || '',
      displayName: parsed.displayName || '',
      hasAvatar: Boolean(parsed.hasAvatar),
    }
  } catch {
    return { account: '', displayName: '', hasAvatar: false }
  }
}

function writeProfile(account: string, displayName: string, hasAvatar: boolean) {
  globalThis.localStorage?.setItem(PROFILE_KEY, JSON.stringify({ account, displayName, hasAvatar }))
}

function clearProfile() {
  globalThis.localStorage?.removeItem(PROFILE_KEY)
}

const initial = readProfile()

export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: getStoredToken() as string | null,
    account: initial.account as string,
    displayName: initial.displayName as string,
    hasAvatar: initial.hasAvatar as boolean,
    avatarObjectUrl: '' as string,
    avatarLoading: false,
    loading: false,
    error: '',
  }),
  getters: {
    isAuthenticated: (state) => Boolean(state.token),
  },
  actions: {
    revokeAvatarObjectUrl() {
      if (this.avatarObjectUrl) {
        URL.revokeObjectURL(this.avatarObjectUrl)
        this.avatarObjectUrl = ''
      }
    },
    applyProfile(profile: Pick<CurrentUser, 'account' | 'displayName' | 'hasAvatar'>) {
      this.account = profile.account || this.account
      this.displayName = profile.displayName || this.displayName
      this.hasAvatar = Boolean(profile.hasAvatar)
      writeProfile(this.account, this.displayName, this.hasAvatar)
    },
    async refreshAvatarObjectUrl() {
      this.revokeAvatarObjectUrl()
      if (!this.hasAvatar || !this.token) return
      this.avatarLoading = true
      try {
        const blob = await authApi.avatarBlob()
        this.avatarObjectUrl = URL.createObjectURL(blob)
      } catch {
        this.hasAvatar = false
        writeProfile(this.account, this.displayName, false)
      } finally {
        this.avatarLoading = false
      }
    },
    async restoreSession() {
      await hydrateStoredAuth()
      const storedToken = getStoredToken()
      if (!storedToken) return false
      this.token = storedToken
      try {
        const me = await authApi.me()
        this.token = getStoredToken()
        this.applyProfile(me)
        await this.refreshAvatarObjectUrl()
        return true
      } catch (error) {
        if (!(error instanceof ApiClientError) || error.status !== 401) {
          this.error = error instanceof Error ? error.message : '会话恢复失败，请稍后重试'
          return false
        }
        this.token = null
        this.account = ''
        this.displayName = ''
        this.hasAvatar = false
        this.revokeAvatarObjectUrl()
        clearToken()
        clearProfile()
        return false
      }
    },
    async login(account: string, password: string, rememberPassword = false, redirectTo?: string) {
      this.loading = true
      this.error = ''
      try {
        const response = await authApi.login(account, password)
        storeToken(response.accessToken)
        this.token = response.accessToken
        this.account = response.account || account
        this.displayName = response.displayName || account
        writeProfile(this.account, this.displayName, this.hasAvatar)
        if (rememberPassword) {
          await saveRememberedAuth({
            account: account.trim(),
            password,
            accessToken: response.accessToken,
            expiresAt: response.expiresAt,
          })
        } else {
          await clearRememberedAuth()
        }
        await this.restoreSession()
        await router.push(safeRedirect(redirectTo))
      } catch (error) {
        this.error = error instanceof Error ? error.message : '登录失败'
      } finally {
        this.loading = false
      }
    },
    async sendEmailCode(email: string) {
      this.error = ''
      return authApi.sendEmailCode(email)
    },
    async register(
      input: {
        email: string
        code: string
        displayName: string
        password: string
      },
      redirectTo?: string,
    ) {
      this.loading = true
      this.error = ''
      try {
        const response = await authApi.register(input)
        storeToken(response.accessToken)
        this.token = response.accessToken
        this.account = response.account || input.email
        this.displayName = response.displayName || input.displayName
        writeProfile(this.account, this.displayName, false)
        await clearRememberedAuth()
        await this.restoreSession()
        await router.push(safeRedirect(redirectTo))
      } catch (error) {
        this.error = error instanceof Error ? error.message : '注册失败'
      } finally {
        this.loading = false
      }
    },
    async uploadAvatar(file: File) {
      this.error = ''
      const profile = await authApi.uploadAvatar(file)
      this.applyProfile(profile)
      await this.refreshAvatarObjectUrl()
      return profile
    },
    async deleteAvatar() {
      this.error = ''
      const profile = await authApi.deleteAvatar()
      this.applyProfile(profile)
      this.revokeAvatarObjectUrl()
      return profile
    },
    async logout() {
      clearToken()
      // 退出只结束当前会话；“记住密码”凭据保留到用户主动取消勾选。
      clearProfile()
      this.token = null
      this.account = ''
      this.displayName = ''
      this.hasAvatar = false
      this.revokeAvatarObjectUrl()
      useCreditStore().clear()
      await router.push({ name: 'projects' })
    },
  },
})

function safeRedirect(redirectTo?: string) {
  return redirectTo?.startsWith('/') && !redirectTo.startsWith('//')
    ? redirectTo
    : { name: 'projects' as const }
}
