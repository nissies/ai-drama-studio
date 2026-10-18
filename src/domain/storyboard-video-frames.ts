import type { StoryboardOutput, StoryboardOutputType } from '../api/storyboard-outputs'
import type { Storyboard } from '../api/workspace'
import type {
  AssetIdMapping,
  ImportedLocalAsset,
  VideoFrameExtractionInput,
} from '../desktop/types'

type FrameDesktopPort = {
  available: boolean
  extractVideoFrame(input: VideoFrameExtractionInput): Promise<ImportedLocalAsset>
  reconcileAssetIds(mappings: AssetIdMapping[]): Promise<void>
}

type FrameWorkspacePort = {
  outputForStoryboard(
    storyboardId: string,
    outputType: StoryboardOutputType,
  ): StoryboardOutput | undefined
  synchronizeLocalAssets(
    projectId: string,
    assets: ImportedLocalAsset[],
  ): Promise<AssetIdMapping[]>
  setStoryboardOutput(
    projectId: string,
    storyboardId: string,
    input: {
      outputType: StoryboardOutputType
      mediaAssetId: string
      sourceType: 'MANUAL'
      sourceId: string
    },
  ): Promise<StoryboardOutput>
}

export interface StoryboardVideoFrameExtractionResult {
  extracted: StoryboardOutputType[]
  skipped: StoryboardOutputType[]
  errors: string[]
}

export async function extractStoryboardVideoFrames(input: {
  projectId: string
  storyboard: Pick<Storyboard, 'id' | 'shotNo' | 'title'>
  videoAssetId: string
  sourceCandidateId: string
  desktop: FrameDesktopPort
  workspace: FrameWorkspacePort
}): Promise<StoryboardVideoFrameExtractionResult> {
  const result: StoryboardVideoFrameExtractionResult = { extracted: [], skipped: [], errors: [] }
  if (!input.desktop.available) return result

  const targets = [
    { position: 'FIRST' as const, outputType: 'KEYFRAME' as const, label: '首帧' },
    { position: 'LAST' as const, outputType: 'END_FRAME' as const, label: '尾帧' },
  ]
  const pending = targets.filter((target) => {
    const current = input.workspace.outputForStoryboard(input.storyboard.id, target.outputType)
    if (current?.sourceType === 'MANUAL' && current.sourceId === input.sourceCandidateId) {
      result.skipped.push(target.outputType)
      return false
    }
    return true
  })
  if (!pending.length) return result

  const extracted: Array<{ target: (typeof targets)[number]; asset: ImportedLocalAsset }> = []
  for (const target of pending) {
    try {
      const asset = await input.desktop.extractVideoFrame({
        projectId: input.projectId,
        videoAssetId: input.videoAssetId,
        outputName: `${String(input.storyboard.shotNo).padStart(3, '0')}-${input.storyboard.title}-${target.label}`,
        position: target.position,
      })
      extracted.push({ target, asset })
    } catch (error) {
      result.errors.push(`${target.label}：${messageFor(error, '提取失败')}`)
    }
  }
  if (!extracted.length) return result

  const mappings = await input.workspace.synchronizeLocalAssets(
    input.projectId,
    extracted.map((item) => item.asset),
  )
  const assetIds = new Map(mappings.map((item) => [item.clientAssetId, item.assetId]))
  await input.desktop.reconcileAssetIds(
    mappings.filter((item) => item.clientAssetId !== item.assetId),
  )
  for (const item of extracted) {
    await input.workspace.setStoryboardOutput(input.projectId, input.storyboard.id, {
      outputType: item.target.outputType,
      mediaAssetId: assetIds.get(item.asset.id) || item.asset.id,
      sourceType: 'MANUAL',
      sourceId: input.sourceCandidateId,
    })
    result.extracted.push(item.target.outputType)
  }
  return result
}

function messageFor(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}
