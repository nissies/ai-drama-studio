// @vitest-environment jsdom

import { reactive } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LocalProjectData } from './local-project'
import { createLocalBinaryGenerationJob, createLocalGenerationJob } from './local-generation'
import type { DesktopBridge } from '../desktop/types'

const projectId = 'local-project-1'

afterEach(() => {
  Reflect.deleteProperty(globalThis.window, 'aiDramaDesktop')
})

describe('local generation jobs', () => {
  it('builds and persists a script generation request without a backend', async () => {
    const createJob = vi.fn(async (_projectId, job) => job)
    installBridge(createJob, {
      ...emptyData(),
      episodes: [
        {
          id: 'episode-1',
          projectId,
          episodeNo: 1,
          title: 'Episode one',
          synopsis: 'The lead discovers a hidden letter.',
          targetDurationSec: 60,
          status: 'DRAFT',
          version: 2,
          updatedAt: new Date().toISOString(),
        },
      ],
    })

    const job = await createLocalGenerationJob(projectId, {
      jobType: 'SCRIPT_GENERATE',
      targetType: 'EPISODE',
      targetId: 'episode-1',
      route: {
        sourceType: 'LOCAL',
        localConnectionId: 'connection-1',
        localProviderCode: 'OLLAMA',
        localModelName: 'qwen3',
      },
    })

    expect(job.id).toMatch(/^local-job-/)
    expect(job.targetVersion).toBe(2)
    expect(job.executionRequest?.userPrompt).toContain('The lead discovers a hidden letter.')
    expect(job.executionRequest?.userPrompt).toContain('约 320 至 420 字')
    expect(job.executionRequest?.userPrompt).toContain('不得少于 320 字')
    expect(job.executionRequest?.userPrompt).toContain('宁可略长')
    expect(createJob).toHaveBeenCalledOnce()
  })

  it('keeps source structure requests focused on complete story material', async () => {
    const createJob = vi.fn(async (_projectId, job) => job)
    installBridge(createJob, {
      ...emptyData(),
      sourceDocuments: [
        {
          document: {
            id: 'source-1',
            projectId,
            title: 'Novel',
            sourceType: 'NOVEL',
            status: 'READY',
            revisionId: 'revision-1',
            revisionNo: 1,
            characterCount: 1_000,
            chunkCount: 0,
            contentSha256: 'test-sha256',
            version: 0,
            updatedAt: new Date().toISOString(),
          },
          content: 'A complete story.',
          chunks: [],
        },
      ],
    })

    const job = await createLocalGenerationJob(projectId, {
      jobType: 'SOURCE_STRUCTURE',
      targetType: 'SOURCE_REVISION',
      targetId: 'revision-1',
      parameters: { targetDurationSec: 60 },
      route: {
        sourceType: 'LOCAL',
        localConnectionId: 'connection-1',
        localProviderCode: 'OLLAMA',
        localModelName: 'qwen3',
      },
    })

    expect(job.executionRequest?.systemPrompt).toContain('不创作剧本')
    expect(job.executionRequest?.userPrompt).toContain('宁可详细也不得精简剧情')
    expect(job.executionRequest?.userPrompt).toContain('scriptText 固定输出空字符串')
  })

  it('includes project, episode, character and scene context in a visual bible request', async () => {
    const createJob = vi.fn(async (_projectId, job) => job)
    installBridge(createJob, {
      ...emptyData(),
      episodes: [
        {
          id: 'episode-1',
          projectId,
          episodeNo: 1,
          title: 'Episode one',
          synopsis: 'Rainy city mystery.',
          targetDurationSec: 60,
          status: 'DRAFT',
          version: 0,
          updatedAt: new Date().toISOString(),
        },
      ],
      characters: [
        {
          id: 'character-1',
          projectId,
          name: 'Lead',
          status: 'DRAFT',
          version: 0,
          forms: [],
          updatedAt: new Date().toISOString(),
        },
      ],
      scenes: [
        {
          id: 'scene-1',
          projectId,
          episodeId: 'episode-1',
          sceneNo: 1,
          title: 'Station',
          status: 'DRAFT',
          version: 0,
          updatedAt: new Date().toISOString(),
        },
      ],
    })

    const job = await createLocalGenerationJob(projectId, {
      jobType: 'PROJECT_VISUAL_BIBLE_GENERATE',
      targetType: 'PROJECT',
      targetId: projectId,
      route: {
        sourceType: 'LOCAL',
        localConnectionId: 'connection-1',
        localProviderCode: 'OLLAMA',
        localModelName: 'qwen3',
      },
    })

    expect(job.executionRequest?.userPrompt).toContain('Rainy city mystery.')
    expect(job.executionRequest?.userPrompt).toContain('Lead')
    expect(job.executionRequest?.userPrompt).toContain('Station')
  })

  it('builds a nine-beat contact sheet plan without a backend', async () => {
    const createJob = vi.fn(async (_projectId, job) => job)
    installBridge(createJob, {
      ...emptyData(),
      storyboards: [
        {
          id: 'shot-1',
          projectId,
          episodeId: 'episode-1',
          characterIds: [],
          shotNo: 1,
          title: 'Crossing the station',
          actionText: 'The lead runs through the station and enters the train.',
          audioMode: 'VIDEO_NATIVE',
          durationSec: 15,
          reviewStatus: 'PENDING',
          status: 'DRAFT',
          version: 3,
          updatedAt: new Date().toISOString(),
        },
      ],
    })

    const job = await createLocalGenerationJob(projectId, {
      jobType: 'STORYBOARD_CONTACT_SHEET_PLAN',
      targetType: 'STORYBOARD',
      targetId: 'shot-1',
      route: {
        sourceType: 'LOCAL',
        localConnectionId: 'connection-1',
        localProviderCode: 'OLLAMA',
        localModelName: 'qwen3',
      },
    })

    expect(job.targetVersion).toBe(3)
    expect(job.executionRequest?.systemPrompt).toContain('严格 9 格')
    expect(job.executionRequest?.userPrompt).toContain('15 秒')
    expect(job.executionRequest?.userPrompt).toContain('Crossing the station')
  })

  it('removes Vue proxies before sending generation jobs through Electron IPC', async () => {
    const createJob = vi.fn(async (_projectId, job) => structuredClone(job))
    installBridge(createJob, emptyData())
    const parameters = reactive({
      temperature: 0.6,
      nested: { targetDurationSec: 90 },
      tags: ['script', 'local'],
    })

    const job = await createLocalBinaryGenerationJob({
      projectId,
      jobType: 'IMAGE_GENERATION',
      targetType: 'PROJECT',
      targetId: projectId,
      prompt: 'cinematic workshop',
      parameters,
      route: {
        sourceType: 'LOCAL',
        localConnectionId: 'connection-1',
        localProviderCode: 'OPENAI_COMPATIBLE',
        localModelName: 'image-model',
      },
    })

    expect(job.executionRequest?.parameters).toEqual({
      temperature: 0.6,
      nested: { targetDurationSec: 90 },
      tags: ['script', 'local'],
    })
    expect(createJob).toHaveBeenCalledOnce()
  })
})

function installBridge(
  createJob: (
    projectId: string,
    job: Parameters<DesktopBridge['createLocalGenerationJob']>[1],
  ) => Promise<Parameters<DesktopBridge['createLocalGenerationJob']>[1]>,
  data: LocalProjectData,
) {
  Object.defineProperty(globalThis.window, 'aiDramaDesktop', {
    configurable: true,
    value: {
      isDesktop: true,
      getLocalProjectData: vi.fn(async () => data),
      listLocalProjects: vi.fn(async () => [
        {
          id: projectId,
          title: 'Offline drama',
          description: 'Local production',
          aspectRatio: '9:16',
          status: 'DRAFT',
          version: 0,
          updatedAt: new Date().toISOString(),
          storageMode: 'LOCAL',
        },
      ]),
      createLocalGenerationJob: createJob,
    } as unknown as DesktopBridge,
  })
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
    sourceDocuments: [],
    structureCandidates: [],
  }
}
