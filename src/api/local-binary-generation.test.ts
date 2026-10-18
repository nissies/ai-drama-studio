// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { imageGenerationApi, type ImageCandidate } from './image-generation'
import { mediaGenerationApi, type MediaCandidate } from './media-generation'
import type { LocalProjectData } from './local-project'
import type { DesktopBridge } from '../desktop/types'

const projectId = 'local-project-1'

afterEach(() => {
  Reflect.deleteProperty(globalThis.window, 'aiDramaDesktop')
})

describe('local image and media generation APIs', () => {
  it('creates an image job locally with an immutable execution snapshot', async () => {
    const createJob = vi.fn(async (_projectId, job) => job)
    installBridge({ createLocalGenerationJob: createJob })

    const job = await imageGenerationApi.create(
      projectId,
      {
        targetType: 'CHARACTER',
        targetId: 'character-1',
        prompt: 'A clean character portrait.',
        negativePrompt: 'blurred face',
        size: '1024x1536',
        compositionType: 'SINGLE',
        route: localRoute(),
      },
      'request-1',
    )

    expect(job.id).toMatch(/^local-job-/)
    expect(job.executionRequest?.parameters).toMatchObject({
      negative_prompt: 'blurred face',
      size: '1024x1536',
      composition_type: 'SINGLE',
    })
    expect(createJob).toHaveBeenCalledOnce()
  })

  it('creates every local batch video job without a server request', async () => {
    const createJob = vi.fn(async (_projectId, job) => job)
    installBridge({ createLocalGenerationJob: createJob })

    const result = await mediaGenerationApi.createBatch(
      projectId,
      {
        mediaType: 'VIDEO',
        route: localRoute(),
        items: [
          { storyboardId: 'shot-1', prompt: 'First shot', durationSec: 5 },
          { storyboardId: 'shot-2', prompt: 'Second shot', durationSec: 6 },
        ],
      },
      'request-2',
    )

    expect(result.successCount).toBe(2)
    expect(result.reservedPoints).toBe(0)
    expect(createJob).toHaveBeenCalledTimes(2)
  })
})

function installBridge(overrides: Partial<DesktopBridge>) {
  const imageCandidate = {} as ImageCandidate
  const mediaCandidate = {} as MediaCandidate
  Object.defineProperty(globalThis.window, 'aiDramaDesktop', {
    configurable: true,
    value: {
      isDesktop: true,
      getLocalProjectData: vi.fn(async () => emptyData()),
      createLocalGenerationJob: vi.fn(async (_projectId, job) => job),
      completeLocalImageGenerationJob: vi.fn(async () => imageCandidate),
      completeLocalMediaGenerationJob: vi.fn(async () => mediaCandidate),
      ...overrides,
    } as unknown as DesktopBridge,
  })
}

function localRoute() {
  return {
    sourceType: 'LOCAL' as const,
    localConnectionId: 'connection-1',
    localProviderCode: 'LOCAL',
    localModelName: 'local-model',
  }
}

function emptyData(): LocalProjectData {
  return {
    version: 1,
    revision: 0,
    projectId,
    updatedAt: new Date().toISOString(),
    episodes: [],
    characters: [],
    scenes: [],
    storyboards: [],
    storyboardOutputs: [],
    characterReferences: [],
    characterVoiceReferences: [],
    sceneReferences: [],
  }
}
