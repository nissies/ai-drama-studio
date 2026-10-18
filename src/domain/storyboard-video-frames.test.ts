import { describe, expect, it, vi } from 'vitest'
import type { StoryboardOutput } from '../api/storyboard-outputs'
import { extractStoryboardVideoFrames } from './storyboard-video-frames'

const storyboard = { id: 'shot-1', shotNo: 1, title: '开场' }

describe('extractStoryboardVideoFrames', () => {
  it('extracts and associates both frames with the selected video candidate', async () => {
    const outputs: StoryboardOutput[] = []
    const extractVideoFrame = vi.fn(async ({ position }: { position?: 'FIRST' | 'LAST' }) => ({
      id: position === 'FIRST' ? 'local-first' : 'local-last',
      category: 'storyboards' as const,
      originalName: `${position}.png`,
      relativePath: `${position}.png`,
      sizeBytes: 12,
      sha256: position === 'FIRST' ? 'a'.repeat(64) : 'b'.repeat(64),
      mimeType: 'image/png',
      importedAt: new Date().toISOString(),
      fileAvailable: true,
      duplicate: false,
      repaired: false,
    }))
    const setStoryboardOutput = vi.fn(async (_projectId, storyboardId, input) => {
      const output = {
        id: input.outputType,
        projectId: 'project-1',
        episodeId: 'episode-1',
        storyboardId,
        version: 0,
        updatedAt: new Date().toISOString(),
        ...input,
      } as StoryboardOutput
      outputs.push(output)
      return output
    })

    const result = await extractStoryboardVideoFrames({
      projectId: 'project-1',
      storyboard,
      videoAssetId: 'video-1',
      sourceCandidateId: 'candidate-1',
      desktop: {
        available: true,
        extractVideoFrame,
        reconcileAssetIds: vi.fn(async () => undefined),
      },
      workspace: {
        outputForStoryboard: () => undefined,
        synchronizeLocalAssets: vi.fn(async () => [
          { clientAssetId: 'local-first', assetId: 'server-first' },
          { clientAssetId: 'local-last', assetId: 'server-last' },
        ]),
        setStoryboardOutput,
      },
    })

    expect(result).toEqual({ extracted: ['KEYFRAME', 'END_FRAME'], skipped: [], errors: [] })
    expect(extractVideoFrame).toHaveBeenCalledTimes(2)
    expect(outputs.map((item) => [item.outputType, item.mediaAssetId, item.sourceId])).toEqual([
      ['KEYFRAME', 'server-first', 'candidate-1'],
      ['END_FRAME', 'server-last', 'candidate-1'],
    ])
  })

  it('does not extract frames again for the same current video candidate', async () => {
    const current = (outputType: 'KEYFRAME' | 'END_FRAME') => ({
      id: outputType,
      projectId: 'project-1',
      episodeId: 'episode-1',
      storyboardId: storyboard.id,
      outputType,
      mediaAssetId: outputType,
      sourceType: 'MANUAL' as const,
      sourceId: 'candidate-1',
      version: 0,
      updatedAt: new Date().toISOString(),
    })
    const extractVideoFrame = vi.fn()

    const result = await extractStoryboardVideoFrames({
      projectId: 'project-1',
      storyboard,
      videoAssetId: 'video-1',
      sourceCandidateId: 'candidate-1',
      desktop: {
        available: true,
        extractVideoFrame,
        reconcileAssetIds: vi.fn(),
      },
      workspace: {
        outputForStoryboard: (_storyboardId, outputType) =>
          current(outputType as 'KEYFRAME' | 'END_FRAME'),
        synchronizeLocalAssets: vi.fn(),
        setStoryboardOutput: vi.fn(),
      },
    })

    expect(result.extracted).toEqual([])
    expect(result.skipped).toEqual(['KEYFRAME', 'END_FRAME'])
    expect(extractVideoFrame).not.toHaveBeenCalled()
  })
})
