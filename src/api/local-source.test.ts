// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GenerationJob } from './generation'
import type { LocalProjectData } from './local-project'
import {
  applyLocalStructureCandidate,
  createLocalSourceDocument,
  localSourceGenerationPlan,
  materializeLocalStructureCandidate,
  updateLocalSourceDocument,
} from './local-source'

describe('local source workflow', () => {
  let data: LocalProjectData
  let jobs: Record<string, GenerationJob>

  beforeEach(() => {
    data = emptyData()
    jobs = {}
    Object.defineProperty(window, 'aiDramaDesktop', {
      configurable: true,
      value: {
        getLocalProjectData: vi.fn(async () => structuredClone(data)),
        saveLocalProjectData: vi.fn(async (_projectId: string, next: LocalProjectData) => {
          data = structuredClone({ ...next, revision: next.revision + 1 })
          return structuredClone(data)
        }),
        getLocalGenerationJob: vi.fn(async (jobId: string) => structuredClone(jobs[jobId])),
      },
    })
  })

  afterEach(() => {
    Reflect.deleteProperty(globalThis.window, 'aiDramaDesktop')
  })

  it('stores revisions and creates deterministic long-form segments', async () => {
    const created = await createLocalSourceDocument('local-project-1', {
      title: '长篇原文',
      sourceType: 'NOVEL',
      content: '第一章\n' + '剧情内容。'.repeat(30_000),
    })
    expect(created.document.revisionNo).toBe(1)
    expect(created.chunks.length).toBeGreaterThan(1)
    const plan = await localSourceGenerationPlan('local-project-1', created.document.id)
    expect(plan.segments.length).toBeGreaterThan(1)
    expect(plan.segments.every((item) => item.segmentCount === plan.segments.length)).toBe(true)

    const updated = await updateLocalSourceDocument('local-project-1', created.document.id, {
      title: '长篇原文修订',
      sourceType: 'NOVEL',
      content: `${created.content}\n结局`,
      version: created.document.version,
    })
    expect(updated.document.revisionNo).toBe(2)
    expect(updated.document.revisionId).not.toBe(created.document.revisionId)
  })

  it('materializes and atomically applies episodes, characters and scenes', async () => {
    const source = await createLocalSourceDocument('local-project-1', {
      title: '测试原文',
      sourceType: 'SCRIPT',
      content: '主角在雨夜车站发现一封信。',
    })
    jobs['local-job-1'] = successfulJob(source.document.revisionId)
    const candidate = await materializeLocalStructureCandidate('local-project-1', 'local-job-1')
    expect(candidate.status).toBe('READY')
    expect(candidate.payload?.episodes).toHaveLength(1)
    expect(candidate.payload?.episodes[0].scriptText).toBe('')

    const submittedPayload = structuredClone(candidate.payload!)
    submittedPayload.episodes[0]!.scriptText = '应用请求中重新注入的未审核剧本'
    const summary = await applyLocalStructureCandidate('local-project-1', candidate.id, {
      candidateVersion: candidate.version,
      payloadJson: JSON.stringify(submittedPayload),
      selectedEpisodeKeys: ['episode_1'],
      characterDecisions: [{ candidateKey: 'lead', action: 'CREATE' }],
    })
    expect(Object.keys(summary.createdEpisodes)).toEqual(['episode_1'])
    expect(data.episodes).toHaveLength(1)
    expect(data.episodes[0].scriptText).toBe('')
    expect(data.characters).toHaveLength(1)
    expect(data.scenes).toHaveLength(1)
    expect(data.structureCandidates[0].status).toBe('APPLIED')
  })
})

function emptyData(): LocalProjectData {
  return {
    version: 1,
    revision: 0,
    projectId: 'local-project-1',
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

function successfulJob(targetId: string): GenerationJob {
  const now = new Date().toISOString()
  return {
    id: 'local-job-1',
    projectId: 'local-project-1',
    jobType: 'SOURCE_STRUCTURE',
    serviceType: 'TEXT',
    targetType: 'SOURCE_REVISION',
    targetId,
    targetVersion: 1,
    sourceType: 'LOCAL',
    status: 'SUCCEEDED',
    progress: 100,
    resultText: JSON.stringify({
      schemaVersion: '1.0',
      episodes: [
        {
          candidateKey: 'episode_1',
          title: '雨夜来信',
          synopsis: '主角发现秘密。',
          scriptText: '模型违规返回的未审核短剧本',
          targetDurationSec: 60,
          scenes: [
            {
              candidateKey: 'station',
              title: '雨夜车站',
              location: '旧车站',
              timeOfDay: '夜晚',
              description: '暴雨中的空站台',
              environmentPrompt: '冷色雨夜，旧车站',
            },
          ],
        },
      ],
      characters: [
        {
          candidateKey: 'lead',
          name: '林夏',
          roleType: '主角',
          description: '年轻调查员',
          identityPrompt: '黑色短发，灰色风衣',
          negativePrompt: '发色变化',
        },
      ],
    }),
    attemptCount: 1,
    createdAt: now,
    updatedAt: now,
  }
}
