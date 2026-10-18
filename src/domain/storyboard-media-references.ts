import type { CharacterVoiceReference } from '../api/assets'
import type { StoryboardOutput } from '../api/storyboard-outputs'
import type { CharacterAsset, Storyboard } from '../api/workspace'

export type StoryboardMediaReferencePurpose =
  | 'FIRST_FRAME'
  | 'END_FRAME'
  | 'CONTINUITY'
  | 'VOICE_IDENTITY'
  | 'BACKGROUND_AUDIO'
  | 'MOTION_REFERENCE'
  | 'POSE_PROXY'

export interface StoryboardMediaReference {
  assetId: string
  label: string
  purpose: StoryboardMediaReferencePurpose
}

export function storyboardMediaReferences(
  storyboard: Pick<Storyboard, 'episodeId' | 'shotNo' | 'audioMode' | 'speakerCharacterId'> & {
    id?: string
  },
  storyboards: Array<Pick<Storyboard, 'id' | 'episodeId' | 'shotNo' | 'title'>>,
  outputs: Array<Pick<StoryboardOutput, 'storyboardId' | 'outputType' | 'mediaAssetId'>>,
  characters: Array<Pick<CharacterAsset, 'id' | 'name'>>,
  voiceReferences: CharacterVoiceReference[],
) {
  const result: StoryboardMediaReference[] = []
  const currentFirstFrame = outputs.find(
    (item) => item.storyboardId === storyboard.id && item.outputType === 'KEYFRAME',
  )
  if (currentFirstFrame) {
    result.push({
      assetId: currentFirstFrame.mediaAssetId,
      label: '当前镜头首帧',
      purpose: 'FIRST_FRAME',
    })
  }
  const currentEndFrame = outputs.find(
    (item) => item.storyboardId === storyboard.id && item.outputType === 'END_FRAME',
  )
  if (currentEndFrame) {
    result.push({
      assetId: currentEndFrame.mediaAssetId,
      label: '当前镜头尾帧',
      purpose: 'END_FRAME',
    })
  }
  const previous = storyboards
    .filter((item) => item.episodeId === storyboard.episodeId && item.shotNo < storyboard.shotNo)
    .sort((left, right) => right.shotNo - left.shotNo)[0]
  if (previous) {
    const endFrame = outputs.find(
      (item) => item.storyboardId === previous.id && item.outputType === 'END_FRAME',
    )
    const video = outputs.find(
      (item) => item.storyboardId === previous.id && item.outputType === 'VIDEO',
    )
    const continuity = endFrame ?? video
    if (continuity) {
      result.push({
        assetId: continuity.mediaAssetId,
        label: endFrame
          ? `上一镜头尾帧：镜头 ${previous.shotNo} · ${previous.title}`
          : `上一镜头视频：镜头 ${previous.shotNo} · ${previous.title}`,
        purpose: 'CONTINUITY',
      })
    }
  }

  if (storyboard.audioMode !== 'VIDEO_NATIVE') return result

  const backgroundAudio = outputs.find(
    (item) => item.storyboardId === storyboard.id && item.outputType === 'BGM',
  )
  if (backgroundAudio) {
    result.push({
      assetId: backgroundAudio.mediaAssetId,
      label: '当前分镜背景声音',
      purpose: 'BACKGROUND_AUDIO',
    })
  }

  if (!storyboard.speakerCharacterId) return result
  const references = voiceReferences.filter(
    (item) => item.characterId === storyboard.speakerCharacterId,
  )
  const voiceReference = references.find((item) => item.primaryReference) ?? references[0]
  if (!voiceReference) return result
  const speaker = characters.find((item) => item.id === storyboard.speakerCharacterId)
  result.push({
    assetId: voiceReference.assetId,
    label: `角色主声音样本：${speaker?.name || '主要说话角色'}`,
    purpose: 'VOICE_IDENTITY',
  })
  return result
}
