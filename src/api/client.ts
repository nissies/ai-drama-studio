import { parseEnvelope } from './response-envelope'
import { normalizeImageBlob } from '../utils/image-files'
import type { ProjectAspectRatio } from '../domain/project-aspect-ratios'
import type { PersistedAuthState } from '../desktop/types'

const API_BASE = String(import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')
const TOKEN_KEY = 'ai-drama-access-token'
const PERSISTED_AUTH_SUPPRESSED_KEY = 'ai-drama-persisted-auth-suppressed'
let persistedAuthState: PersistedAuthState | null = null
let authHydrationPromise: Promise<PersistedAuthState | null> | null = null
let authStateRevision = 0

export interface LoginResponse {
  accessToken: string
  tokenType: string
  expiresAt: string
  account: string
  displayName: string
}

export interface CurrentUser {
  userId: string
  tenantId: string
  account: string
  email?: string | null
  phone?: string | null
  displayName: string
  hasAvatar: boolean
  avatarUrl?: string | null
  roles: string[]
}

export interface Project {
  id: string
  title: string
  description?: string
  visualStyle?: string
  visualBible?: string
  aspectRatio: ProjectAspectRatio
  status: string
  version: number
  updatedAt: string
  storageMode?: 'LOCAL' | 'CLOUD'
}

export interface CreateProjectInput {
  title: string
  description?: string
  visualStyle?: string
  visualBible?: string
  aspectRatio?: ProjectAspectRatio
}

export interface UpdateProjectSettingsInput {
  visualStyle?: string
  visualBible?: string
  aspectRatio: ProjectAspectRatio
  version: number
}

export class ApiClientError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message)
  }
}

export function getStoredToken() {
  return localStorage.getItem(TOKEN_KEY)
}

export function storeToken(token: string) {
  authStateRevision += 1
  authHydrationPromise = null
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken() {
  authStateRevision += 1
  authHydrationPromise = null
  localStorage.removeItem(TOKEN_KEY)
}

export async function hydrateStoredAuth() {
  if (authHydrationPromise) return authHydrationPromise
  if (localStorage.getItem(PERSISTED_AUTH_SUPPRESSED_KEY) === '1') {
    persistedAuthState = null
    authHydrationPromise = Promise.resolve(null)
    return authHydrationPromise
  }
  const hydrationRevision = authStateRevision
  authHydrationPromise = (async () => {
    const bridge = globalThis.window?.aiDramaDesktop
    if (!bridge) return null
    try {
      const hydratedState = await bridge.getPersistedAuthState()
      if (hydrationRevision !== authStateRevision) return persistedAuthState
      persistedAuthState = hydratedState
      const expiresAt = hydratedState?.expiresAt
      const parsedExpiresAt = expiresAt ? Date.parse(expiresAt) : Number.NaN
      const tokenIsValid =
        Boolean(hydratedState?.accessToken) && Boolean(expiresAt) && parsedExpiresAt > Date.now()
      if (tokenIsValid && hydratedState) localStorage.setItem(TOKEN_KEY, hydratedState.accessToken)
      return hydratedState
    } catch {
      if (hydrationRevision !== authStateRevision) return persistedAuthState
      persistedAuthState = null
      return null
    }
  })()
  return authHydrationPromise
}

export function getRememberedAuthState() {
  return persistedAuthState
}

export async function saveRememberedAuth(input: PersistedAuthState) {
  const bridge = globalThis.window?.aiDramaDesktop
  if (!bridge) return false
  const saveRevision = ++authStateRevision
  try {
    await bridge.savePersistedAuthState(input)
    if (saveRevision === authStateRevision) {
      persistedAuthState = input
      authHydrationPromise = Promise.resolve(input)
      localStorage.removeItem(PERSISTED_AUTH_SUPPRESSED_KEY)
    }
    return true
  } catch {
    if (saveRevision === authStateRevision) {
      persistedAuthState = null
      authHydrationPromise = Promise.resolve(null)
      localStorage.setItem(PERSISTED_AUTH_SUPPRESSED_KEY, '1')
    }
    return false
  }
}

export async function clearRememberedAuth() {
  authStateRevision += 1
  persistedAuthState = null
  authHydrationPromise = Promise.resolve(null)
  localStorage.setItem(PERSISTED_AUTH_SUPPRESSED_KEY, '1')
  const bridge = globalThis.window?.aiDramaDesktop
  if (!bridge) {
    localStorage.removeItem(PERSISTED_AUTH_SUPPRESSED_KEY)
    return true
  }
  try {
    await bridge.clearPersistedAuthState()
    localStorage.removeItem(PERSISTED_AUTH_SUPPRESSED_KEY)
    return true
  } catch {
    // Keep the suppression marker so a stale disk credential cannot revive the session.
    return false
  }
}

async function fetchApi(path: string, init: RequestInit) {
  try {
    return await fetch(`${API_BASE}${path}`, init)
  } catch {
    throw new ApiClientError(
      globalThis.navigator?.onLine === false
        ? '当前网络不可用，请检查网络连接'
        : '无法连接服务器，请稍后重试',
      'NETWORK_ERROR',
      0,
    )
  }
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getStoredToken()
  const response = await fetchApi(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  })
  const responseText = await response.text()
  const payload = parseEnvelope<T>(responseText)
  if (response.status === 401) {
    clearToken()
    redirectToLogin()
    throw new ApiClientError('登录状态已失效，请重新登录', 'AUTHENTICATION_REQUIRED', 401)
  }
  if (!response.ok || payload?.error) {
    throw new ApiClientError(
      payload?.error?.message || `请求失败（HTTP ${response.status}）`,
      payload?.error?.code || 'HTTP_ERROR',
      response.status,
    )
  }
  if (!payload) {
    throw new ApiClientError('服务器返回了无法解析的响应', 'INVALID_RESPONSE', response.status)
  }
  return payload.data
}

export async function requestBlob(path: string): Promise<Blob> {
  const token = getStoredToken()
  const response = await fetchApi(path, {
    headers: {
      Accept: 'image/png,image/jpeg,image/webp,application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
  if (response.status === 401) {
    clearToken()
    redirectToLogin()
    throw new ApiClientError('登录状态已失效，请重新登录', 'AUTHENTICATION_REQUIRED', 401)
  }
  if (!response.ok) {
    const responseText = await response.text()
    const payload = parseEnvelope<never>(responseText)
    throw new ApiClientError(
      payload?.error?.message || responseText || `图片读取失败（HTTP ${response.status}）`,
      payload?.error?.code || 'HTTP_ERROR',
      response.status,
    )
  }
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]
  if (!contentType || !['image/png', 'image/jpeg', 'image/webp'].includes(contentType)) {
    throw new ApiClientError(
      '服务器返回了不支持的图片格式',
      'INVALID_IMAGE_RESPONSE',
      response.status,
    )
  }
  try {
    return await normalizeImageBlob(await response.blob())
  } catch (error) {
    throw new ApiClientError(
      error instanceof Error ? error.message : '服务器返回的内容不是有效图片',
      'INVALID_IMAGE_RESPONSE',
      response.status,
    )
  }
}

export async function requestBinary(path: string, acceptedMimeTypes: readonly string[]): Promise<Blob> {
  const token = getStoredToken()
  const response = await fetchApi(path, {
      headers: {
        // Binary endpoints return the same JSON envelope when a candidate is unavailable.
        Accept: [...acceptedMimeTypes, 'application/json'].join(','),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
  if (response.status === 401) {
    clearToken()
    redirectToLogin()
    throw new ApiClientError('登录状态已失效，请重新登录', 'AUTHENTICATION_REQUIRED', 401)
  }
  if (!response.ok) {
    const responseText = await response.text()
    const payload = parseEnvelope<never>(responseText)
    throw new ApiClientError(
      payload?.error?.message || responseText || `媒体读取失败（HTTP ${response.status}）`,
      payload?.error?.code || 'HTTP_ERROR',
      response.status,
    )
  }
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (!contentType || !acceptedMimeTypes.includes(contentType)) {
    throw new ApiClientError(
      '服务器返回了不支持的媒体格式',
      'INVALID_MEDIA_RESPONSE',
      response.status,
    )
  }
  return response.blob()
}

export async function requestForm<T>(path: string, body: FormData): Promise<T> {
  const token = getStoredToken()
  const response = await fetchApi(path, {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body,
  })
  const responseText = await response.text()
  const payload = parseEnvelope<T>(responseText)
  if (response.status === 401) {
    clearToken()
    redirectToLogin()
    throw new ApiClientError('登录状态已失效，请重新登录', 'AUTHENTICATION_REQUIRED', 401)
  }
  if (!response.ok || payload?.error) {
    throw new ApiClientError(
      payload?.error?.message || `请求失败（HTTP ${response.status}）`,
      payload?.error?.code || 'HTTP_ERROR',
      response.status,
    )
  }
  if (!payload) {
    throw new ApiClientError('服务器返回了无法解析的响应', 'INVALID_RESPONSE', response.status)
  }
  return payload.data
}

function redirectToLogin() {
  const loginUrl = globalThis.window?.aiDramaDesktop ? '#/login' : '/login'
  if (!globalThis.location.href.endsWith(loginUrl)) globalThis.location.assign(loginUrl)
}

export interface SendEmailCodeResult {
  email: string
  expiresInSeconds: number
  resendIntervalSeconds: number
}

export const authApi = {
  login: (account: string, password: string) =>
    request<LoginResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ account, password }),
    }),
  sendEmailCode: (email: string) =>
    request<SendEmailCodeResult>('/auth/email/send-code', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  register: (input: {
    email: string
    code: string
    displayName: string
    password: string
  }) =>
    request<LoginResponse>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  me: () => request<CurrentUser>('/auth/me'),
  uploadAvatar: (file: File) => {
    const body = new FormData()
    body.set('file', file)
    return requestForm<CurrentUser>('/auth/me/avatar', body)
  },
  deleteAvatar: () =>
    request<CurrentUser>('/auth/me/avatar', {
      method: 'DELETE',
    }),
  avatarBlob: () => requestBlob('/auth/me/avatar'),
}

export const projectApi = {
  list: () => request<Project[]>('/projects'),
  get: (projectId: string) => request<Project>(`/projects/${encodeURIComponent(projectId)}`),
  create: (input: CreateProjectInput) =>
    request<Project>('/projects', { method: 'POST', body: JSON.stringify(input) }),
  updateSettings: (projectId: string, input: UpdateProjectSettingsInput) =>
    request<Project>(`/projects/${encodeURIComponent(projectId)}/settings`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  delete: (projectId: string) =>
    request<void>(`/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' }),
}
