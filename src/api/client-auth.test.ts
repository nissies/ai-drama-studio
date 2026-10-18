// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PersistedAuthState } from '../desktop/types'

describe('desktop auth hydration', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
    Reflect.deleteProperty(globalThis.window, 'aiDramaDesktop')
  })

  afterEach(() => {
    localStorage.clear()
    Reflect.deleteProperty(globalThis.window, 'aiDramaDesktop')
  })

  it('shares the asynchronous credential read and exposes the token after it completes', async () => {
    let resolveState!: (state: PersistedAuthState) => void
    const getPersistedAuthState = vi.fn(
      () =>
        new Promise<PersistedAuthState>((resolve) => {
          resolveState = resolve
        }),
    )
    Object.defineProperty(globalThis.window, 'aiDramaDesktop', {
      configurable: true,
      value: { getPersistedAuthState },
    })

    const { getRememberedAuthState, getStoredToken, hydrateStoredAuth } = await import('./client')
    const firstHydration = hydrateStoredAuth()
    const secondHydration = hydrateStoredAuth()

    expect(getPersistedAuthState).toHaveBeenCalledOnce()
    expect(getStoredToken()).toBeNull()
    expect(getRememberedAuthState()).toBeNull()

    const state: PersistedAuthState = {
      account: 'creator@example.com',
      password: 'encrypted-by-electron',
      accessToken: 'desktop-access-token',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
    resolveState(state)

    await expect(firstHydration).resolves.toEqual(state)
    await expect(secondHydration).resolves.toEqual(state)
    expect(getStoredToken()).toBe('desktop-access-token')
    expect(getRememberedAuthState()).toEqual(state)
  })

  it('does not restore an expired access token', async () => {
    Object.defineProperty(globalThis.window, 'aiDramaDesktop', {
      configurable: true,
      value: {
        getPersistedAuthState: vi.fn(async () => ({
          account: 'creator@example.com',
          password: 'encrypted-by-electron',
          accessToken: 'expired-token',
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        })),
      },
    })

    const { getStoredToken, hydrateStoredAuth } = await import('./client')
    await hydrateStoredAuth()

    expect(getStoredToken()).toBeNull()
  })

  it('does not let delayed hydration overwrite newly saved credentials', async () => {
    let resolveState!: (state: PersistedAuthState) => void
    const getPersistedAuthState = vi.fn(
      () =>
        new Promise<PersistedAuthState>((resolve) => {
          resolveState = resolve
        }),
    )
    const savePersistedAuthState = vi.fn(async () => undefined)
    Object.defineProperty(globalThis.window, 'aiDramaDesktop', {
      configurable: true,
      value: { getPersistedAuthState, savePersistedAuthState },
    })

    const { getRememberedAuthState, getStoredToken, hydrateStoredAuth, saveRememberedAuth } =
      await import('./client')
    const hydration = hydrateStoredAuth()
    const newState: PersistedAuthState = {
      account: 'new@example.com',
      password: 'new-password',
      accessToken: 'new-token',
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    }
    await saveRememberedAuth(newState)
    localStorage.setItem('ai-drama-access-token', newState.accessToken)

    resolveState({
      account: 'old@example.com',
      password: 'old-password',
      accessToken: 'old-token',
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    })
    await hydration

    expect(getStoredToken()).toBe('new-token')
    expect(getRememberedAuthState()).toEqual(newState)
  })

  it('does not let delayed hydration restore credentials after logout', async () => {
    let resolveState!: (state: PersistedAuthState) => void
    Object.defineProperty(globalThis.window, 'aiDramaDesktop', {
      configurable: true,
      value: {
        getPersistedAuthState: vi.fn(
          () =>
            new Promise<PersistedAuthState>((resolve) => {
              resolveState = resolve
            }),
        ),
        clearPersistedAuthState: vi.fn(async () => undefined),
      },
    })

    const { clearRememberedAuth, getRememberedAuthState, getStoredToken, hydrateStoredAuth } =
      await import('./client')
    const hydration = hydrateStoredAuth()
    await clearRememberedAuth()
    localStorage.removeItem('ai-drama-access-token')
    resolveState({
      account: 'old@example.com',
      password: 'old-password',
      accessToken: 'old-token',
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    })
    await hydration

    expect(getStoredToken()).toBeNull()
    expect(getRememberedAuthState()).toBeNull()
  })

  it('rejects a token with a malformed expiry timestamp', async () => {
    Object.defineProperty(globalThis.window, 'aiDramaDesktop', {
      configurable: true,
      value: {
        getPersistedAuthState: vi.fn(async () => ({
          account: 'creator@example.com',
          password: 'password',
          accessToken: 'token-with-invalid-expiry',
          expiresAt: 'not-a-date',
        })),
      },
    })

    const { getStoredToken, hydrateStoredAuth } = await import('./client')
    await hydrateStoredAuth()

    expect(getStoredToken()).toBeNull()
  })

  it('suppresses stale disk credentials when saving a new account fails', async () => {
    const oldState: PersistedAuthState = {
      account: 'old@example.com',
      password: 'old-password',
      accessToken: 'old-token',
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    }
    const getPersistedAuthState = vi.fn(async () => oldState)
    Object.defineProperty(globalThis.window, 'aiDramaDesktop', {
      configurable: true,
      value: {
        getPersistedAuthState,
        savePersistedAuthState: vi.fn(async () => {
          throw new Error('disk write failed')
        }),
      },
    })

    const firstModule = await import('./client')
    await firstModule.hydrateStoredAuth()
    firstModule.storeToken('new-token')
    const saved = await firstModule.saveRememberedAuth({
      account: 'new@example.com',
      password: 'new-password',
      accessToken: 'new-token',
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    })

    expect(saved).toBe(false)
    expect(firstModule.getStoredToken()).toBe('new-token')
    expect(firstModule.getRememberedAuthState()).toBeNull()

    vi.resetModules()
    const restartedModule = await import('./client')
    await restartedModule.hydrateStoredAuth()
    expect(getPersistedAuthState).toHaveBeenCalledOnce()
    expect(restartedModule.getStoredToken()).toBe('new-token')
    expect(restartedModule.getRememberedAuthState()).toBeNull()
  })

  it('suppresses stale disk credentials when logout cannot delete them', async () => {
    const oldState: PersistedAuthState = {
      account: 'old@example.com',
      password: 'old-password',
      accessToken: 'old-token',
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    }
    const getPersistedAuthState = vi.fn(async () => oldState)
    Object.defineProperty(globalThis.window, 'aiDramaDesktop', {
      configurable: true,
      value: {
        getPersistedAuthState,
        clearPersistedAuthState: vi.fn(async () => {
          throw new Error('disk delete failed')
        }),
      },
    })

    const firstModule = await import('./client')
    await firstModule.hydrateStoredAuth()
    expect(await firstModule.clearRememberedAuth()).toBe(false)
    firstModule.clearToken()

    vi.resetModules()
    const restartedModule = await import('./client')
    await restartedModule.hydrateStoredAuth()
    expect(getPersistedAuthState).toHaveBeenCalledOnce()
    expect(restartedModule.getStoredToken()).toBeNull()
    expect(restartedModule.getRememberedAuthState()).toBeNull()
  })
})
