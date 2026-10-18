import { describe, expect, it } from 'vitest'
import type { CharacterVoiceReference } from '../api/assets'
import { storyboardMediaReferences } from './storyboard-media-references'

const voiceReferences: CharacterVoiceReference[] = [
  {
    id: 'voice-reference',
    characterId: 'character-1',
    assetId: 'voice-asset',
    primaryReference: true,
    version: 0,
    updatedAt: '',
  },
]

describe('storyboard media references', () => {
  it('links the previous video and the selected speaker voice sample in native audio mode', () => {
    const result = storyboardMediaReferences(
      {
        episodeId: 'episode-1',
        shotNo: 2,
        audioMode: 'VIDEO_NATIVE',
        speakerCharacterId: 'character-1',
      },
      [
        { id: 'shot-1', episodeId: 'episode-1', shotNo: 1, title: '开场' },
        { id: 'shot-2', episodeId: 'episode-1', shotNo: 2, title: '对白' },
      ],
      [
        {
          storyboardId: 'shot-1',
          outputType: 'VIDEO',
          mediaAssetId: 'previous-video',
        },
      ],
      [{ id: 'character-1', name: '霜鸾' }],
      voiceReferences,
    )

    expect(result).toEqual([
      {
        assetId: 'previous-video',
        label: '上一镜头视频：镜头 1 · 开场',
        purpose: 'CONTINUITY',
      },
      {
        assetId: 'voice-asset',
        label: '角色主声音样本：霜鸾',
        purpose: 'VOICE_IDENTITY',
      },
    ])
  })

  it('links the current storyboard background audio in native audio mode', () => {
    const result = storyboardMediaReferences(
      {
        id: 'shot-1',
        episodeId: 'episode-1',
        shotNo: 1,
        audioMode: 'VIDEO_NATIVE',
      },
      [],
      [{ storyboardId: 'shot-1', outputType: 'BGM', mediaAssetId: 'background-audio' }],
      [],
      [],
    )

    expect(result).toEqual([
      {
        assetId: 'background-audio',
        label: '当前分镜背景声音',
        purpose: 'BACKGROUND_AUDIO',
      },
    ])
  })

  it('does not send audio references to videos that use dedicated AI dubbing', () => {
    const result = storyboardMediaReferences(
      {
        episodeId: 'episode-1',
        shotNo: 1,
        audioMode: 'AI_DUB',
        speakerCharacterId: 'character-1',
      },
      [{ storyboardId: 'shot-1', outputType: 'BGM', mediaAssetId: 'background-audio' }],
      [],
      [{ id: 'character-1', name: '霜鸾' }],
      voiceReferences,
    )

    expect(result).toEqual([])
  })

  it('exposes current frame assets and prefers the previous end frame for continuity', () => {
    const result = storyboardMediaReferences(
      {
        id: 'shot-2',
        episodeId: 'episode-1',
        shotNo: 2,
        audioMode: 'AI_DUB',
        speakerCharacterId: null,
      },
      [
        { id: 'shot-1', episodeId: 'episode-1', shotNo: 1, title: '开场' },
        { id: 'shot-2', episodeId: 'episode-1', shotNo: 2, title: '承接' },
      ],
      [
        { storyboardId: 'shot-2', outputType: 'KEYFRAME', mediaAssetId: 'current-first' },
        { storyboardId: 'shot-2', outputType: 'END_FRAME', mediaAssetId: 'current-last' },
        { storyboardId: 'shot-1', outputType: 'END_FRAME', mediaAssetId: 'previous-last' },
        { storyboardId: 'shot-1', outputType: 'VIDEO', mediaAssetId: 'previous-video' },
      ],
      [],
      [],
    )

    expect(result).toEqual([
      { assetId: 'current-first', label: '当前镜头首帧', purpose: 'FIRST_FRAME' },
      { assetId: 'current-last', label: '当前镜头尾帧', purpose: 'END_FRAME' },
      {
        assetId: 'previous-last',
        label: '上一镜头尾帧：镜头 1 · 开场',
        purpose: 'CONTINUITY',
      },
    ])
  })
})
