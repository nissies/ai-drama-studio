// @vitest-environment jsdom

import { createApp, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SettingsPage from './SettingsPage.vue'

const { desktopStore } = vi.hoisted(() => ({
  desktopStore: {
    available: true,
    runtime: { appVersion: '0.2.3' },
    workspace: { workspaceRoot: 'D:\\AI', projectCount: 1 },
    localAiConnections: [],
    localAiLoading: false,
    localAiSaving: false,
    error: '',
    initialize: vi.fn(async () => undefined),
    loadLocalAiConnections: vi.fn(async () => undefined),
    selectWorkspaceRoot: vi.fn(async () => undefined),
    discoverLocalAiModels: vi.fn(async () => ({
      providerCode: 'OPENAI_COMPATIBLE',
      endpointPath: '/v1/images/generations',
      models: ['qwen-image'],
    })),
    saveLocalAiConnection: vi.fn(async (input) => ({
      ...input,
      id: 'connection-1',
      apiKeyConfigured: false,
      apiKeyHint: null,
      version: 1,
      updatedAt: '2026-09-16T00:00:00Z',
      storageMode: 'LOCAL',
    })),
  },
}))

vi.mock('../layouts/StudioShell.vue', () => ({
  default: { template: '<main><slot /></main>' },
}))

vi.mock('../api/model-catalog', () => ({
  platformModelCatalogApi: {
    list: vi.fn(async () => [
      {
        id: 'video-1',
        serviceType: 'VIDEO',
        modelCode: 'seedance',
        displayName: 'Seedance',
        capabilities: [],
        defaultParameters: {},
        creditPrice: null,
        routeCount: 1,
        updatedAt: '',
      },
    ]),
  },
}))

vi.mock('../stores/desktop', () => ({
  useDesktopStore: () => desktopStore,
}))

vi.mock('../stores/auth', () => ({
  useAuthStore: () => ({ isAuthenticated: false }),
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn(async () => undefined) }),
}))

afterEach(() => {
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('SettingsPage', () => {
  it('renders instead of going blank when legacy desktop status lacks optional fields', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp(SettingsPage)
    app.mount(host)
    await nextTick()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(host.textContent).toContain('设置')
    expect(host.textContent).toContain('磁盘可用空间')
    expect(host.textContent).toContain('FFmpeg')
    app.unmount()
  })

  it('explains that discovered models must be saved and confirms a successful save', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp(SettingsPage)
    app.mount(host)
    await nextTick()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const addButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('添加第一条配置'),
    )
    addButton?.click()
    await nextTick()

    const baseUrlInput = Array.from(host.querySelectorAll('label'))
      .find((label) => label.textContent?.includes('基础地址'))
      ?.querySelector('input')
    expect(baseUrlInput).toBeTruthy()
    if (baseUrlInput) {
      baseUrlInput.value = 'https://api.example.com'
      baseUrlInput.dispatchEvent(new Event('input', { bubbles: true }))
    }
    await nextTick()
    const discoverButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('获取模型'),
    )
    expect(discoverButton?.disabled).toBe(false)
    discoverButton?.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()

    expect(host.textContent).toContain('保存后才会在生成页面出现')
    const displayNameInput = Array.from(host.querySelectorAll('label'))
      .find((label) => label.textContent?.includes('配置名称'))
      ?.querySelector('input')
    expect(displayNameInput?.value).toContain('qwen-image')

    host
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
    expect(desktopStore.saveLocalAiConnection).toHaveBeenCalledOnce()
    expect(host.textContent).toContain('已保存，可在图片模型生成入口中使用')
    app.unmount()
  })
})
