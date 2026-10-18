// @vitest-environment jsdom

import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopBridge, LocalAiConnection } from '../desktop/types'
import { useDesktopStore } from './desktop'

const savedConnection: LocalAiConnection = {
  id: 'connection-1',
  serviceType: 'TEXT',
  providerCode: 'OLLAMA',
  displayName: 'Ollama · qwen3',
  baseUrl: 'http://127.0.0.1:11434',
  endpointPath: '/api/chat',
  modelName: 'qwen3',
  apiKeyConfigured: false,
  apiKeyHint: null,
  enabled: true,
  defaultProvider: true,
  version: 1,
  updatedAt: '2026-09-16T00:00:00Z',
  storageMode: 'LOCAL',
}

beforeEach(() => setActivePinia(createPinia()))

afterEach(() => {
  Reflect.deleteProperty(globalThis.window, 'aiDramaDesktop')
})

describe('desktop local AI connections', () => {
  it('keeps a newly saved connection when an older list request finishes afterward', async () => {
    let resolveList!: (connections: LocalAiConnection[]) => void
    const staleList = new Promise<LocalAiConnection[]>((resolve) => {
      resolveList = resolve
    })
    const existingConnection = { ...savedConnection, id: 'connection-2', displayName: 'Existing' }
    const bridge = {
      listLocalAiConnections: vi
        .fn()
        .mockReturnValueOnce(staleList)
        .mockResolvedValueOnce([savedConnection, existingConnection]),
      saveLocalAiConnection: vi.fn(async () => savedConnection),
    } as unknown as DesktopBridge
    Object.defineProperty(globalThis.window, 'aiDramaDesktop', {
      configurable: true,
      value: bridge,
    })
    const store = useDesktopStore()

    const loading = store.loadLocalAiConnections()
    const saving = store.saveLocalAiConnection({
      serviceType: 'TEXT',
      providerCode: 'OLLAMA',
      displayName: 'Ollama · qwen3',
      baseUrl: 'http://127.0.0.1:11434',
      endpointPath: '/api/chat',
      modelName: 'qwen3',
      clearApiKey: false,
      enabled: true,
      defaultProvider: true,
    })
    await vi.waitFor(() => {
      expect(store.localAiConnections).toEqual([savedConnection])
    })
    expect(store.localAiConnections).toEqual([savedConnection])

    resolveList([])
    await saving
    await loading
    await vi.waitFor(() => {
      expect(store.localAiConnections).toEqual([savedConnection, existingConnection])
    })
    expect(bridge.listLocalAiConnections).toHaveBeenCalledTimes(2)
  })
})
