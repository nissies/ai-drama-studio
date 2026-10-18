// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerationJob } from './generation'
import type { LocalProjectData } from './local-project'
import {
  applyLocalEpisodeAssetCandidate,
  applyLocalStoryboardCandidate,
  localEpisodeAssetCandidateByJob,
  localStoryboardCandidateByJob,
} from './local-candidates'
import type { DesktopBridge } from '../desktop/types'

const projectId = 'local-project-1'
const episodeId = 'episode-1'

afterEach(() => {
  Reflect.deleteProperty(globalThis.window, 'aiDramaDesktop')
})

describe('local structured candidates', () => {
  it('materializes and applies local character and scene candidates', async () => {
    const job = completedJob(
      'EPISODE_ASSET_EXTRACT',
      JSON.stringify({
        schemaVersion: '1.0',
        characters: [
          {
            candidateKey: 'lead',
            name: 'Lead',
            roleType: 'PROTAGONIST',
            description: 'A determined investigator.',
            identityPrompt: 'Short black hair and a dark coat.',
            negativePrompt: 'Wrong coat color.',
          },
        ],
        scenes: [
          {
            candidateKey: 'station',
            title: 'Old station',
            location: 'Platform',
            timeOfDay: 'Night',
            description: 'Rainy abandoned station.',
            environmentPrompt: 'Wet platform and cold fluorescent light.',
          },
        ],
      }),
    )
    const data = emptyData()
    const save = installBridge(job, data)

    const candidate = await localEpisodeAssetCandidateByJob(projectId, job.id)
    expect(candidate.status).toBe('READY')
    expect(candidate.payload?.characters[0].name).toBe('Lead')

    const summary = await applyLocalEpisodeAssetCandidate(projectId, candidate.id, {
      candidateVersion: candidate.version,
      payloadJson: JSON.stringify(candidate.payload),
      selectedSceneKeys: ['station'],
      characterDecisions: [{ candidateKey: 'lead', action: 'CREATE' }],
    })

    expect(summary.createdSceneIds).toHaveLength(1)
    expect(Object.keys(summary.createdCharacters)).toEqual(['lead'])
    const saved = save.mock.calls[0][1]
    expect(saved.characters[0].name).toBe('Lead')
    expect(saved.scenes[0].title).toBe('Old station')
  })

  it('validates and applies local storyboard candidates with generated prompts', async () => {
    const data = emptyData()
    data.characters.push({
      id: 'character-1',
      projectId,
      name: 'Lead',
      identityPrompt: 'Short black hair and a dark coat.',
      status: 'DRAFT',
      version: 0,
      forms: [],
      updatedAt: new Date().toISOString(),
    })
    data.scenes.push({
      id: 'scene-1',
      projectId,
      episodeId,
      sceneNo: 1,
      title: 'Old station',
      environmentPrompt: 'Wet platform at night.',
      status: 'DRAFT',
      version: 0,
      updatedAt: new Date().toISOString(),
    })
    const job = completedJob(
      'STORYBOARD_GENERATE',
      JSON.stringify({
        schemaVersion: '1.0',
        shots: [
          {
            candidateKey: 'shot_1',
            title: 'Arrival',
            sceneId: 'scene-1',
            characterIds: ['character-1'],
            shotType: 'Wide',
            angle: 'Eye level',
            movement: 'Push in',
            actionText: 'The lead steps onto the platform.',
            dialogue: null,
            innerMonologue: null,
            description: 'Establish the empty station.',
            resultText: null,
            atmosphere: 'Tense and quiet',
            durationSec: 6,
          },
        ],
      }),
    )
    const save = installBridge(job, data)

    const candidate = await localStoryboardCandidateByJob(projectId, job.id)
    expect(candidate.status).toBe('READY')
    const summary = await applyLocalStoryboardCandidate(projectId, candidate.id, {
      candidateVersion: candidate.version,
      payloadJson: JSON.stringify(candidate.payload),
      selectedShotKeys: ['shot_1'],
    })

    expect(summary.createdCount).toBe(1)
    const storyboard = save.mock.calls[0][1].storyboards[0]
    expect(storyboard.imagePrompt).toContain('Wet platform at night.')
    expect(storyboard.imagePrompt).toContain('Short black hair and a dark coat.')
    expect(storyboard.videoPrompt).toContain('Push in')
  })
})

function installBridge(job: GenerationJob, data: LocalProjectData) {
  const save = vi.fn(async (_projectId: string, next: LocalProjectData) => ({
    ...next,
    revision: next.revision + 1,
  }))
  Object.defineProperty(globalThis.window, 'aiDramaDesktop', {
    configurable: true,
    value: {
      isDesktop: true,
      getLocalGenerationJob: vi.fn(async () => job),
      getLocalProjectData: vi.fn(async () => structuredClone(data)),
      saveLocalProjectData: save,
    } as unknown as DesktopBridge,
  })
  return save
}

function completedJob(jobType: GenerationJob['jobType'], resultText: string): GenerationJob {
  const now = new Date().toISOString()
  return {
    id: `local-job-${globalThis.crypto.randomUUID()}`,
    projectId,
    jobType,
    serviceType: 'TEXT',
    targetType: 'EPISODE',
    targetId: episodeId,
    targetVersion: 0,
    sourceType: 'LOCAL',
    localConnectionId: 'connection-1',
    platformModelId: null,
    status: 'SUCCEEDED',
    progress: 100,
    resultText,
    attemptCount: 0,
    createdAt: now,
    updatedAt: now,
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
