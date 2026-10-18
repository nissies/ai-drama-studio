import { describe, expect, it } from 'vitest'
import type { GenerationJob } from '../api/generation'
import { latestActiveGenerationJob } from './active-generation-job'

function job(overrides: Partial<GenerationJob>): GenerationJob {
  return {
    id: 'job-1',
    projectId: 'project-1',
    jobType: 'VIDEO_GENERATION',
    serviceType: 'VIDEO',
    targetType: 'STORYBOARD',
    targetId: 'storyboard-1',
    targetVersion: 0,
    sourceType: 'PLATFORM',
    status: 'RUNNING',
    progress: 20,
    attemptCount: 1,
    createdAt: '2026-07-21T10:00:00Z',
    updatedAt: '2026-07-21T10:00:00Z',
    ...overrides,
  }
}

describe('latest active generation job', () => {
  it('finds the newest active job for the exact target', () => {
    const result = latestActiveGenerationJob(
      [
        job({ id: 'completed', status: 'SUCCEEDED' }),
        job({ id: 'older', createdAt: '2026-07-21T09:00:00Z' }),
        job({ id: 'newer', status: 'QUEUED', createdAt: '2026-07-21T11:00:00Z' }),
        job({ id: 'other-target', targetId: 'storyboard-2' }),
      ],
      'VIDEO_GENERATION',
      'STORYBOARD',
      'storyboard-1',
    )

    expect(result?.id).toBe('newer')
  })

  it('does not restore failed or canceled jobs', () => {
    expect(
      latestActiveGenerationJob(
        [job({ status: 'FAILED' }), job({ id: 'canceled', status: 'CANCELED' })],
        'VIDEO_GENERATION',
        'STORYBOARD',
        'storyboard-1',
      ),
    ).toBeUndefined()
  })
})
