import type {
  CharacterReference,
  CharacterVoiceReference,
  SceneReference,
} from './assets'
import type { StoryboardOutput } from './storyboard-outputs'
import type { CharacterAsset, Episode, Scene, Storyboard } from './workspace'
import type { SourceDocumentDetail, StructureCandidate } from './source'

export interface LocalProjectData {
  version: 1
  revision: number
  projectId: string
  updatedAt: string
  episodes: Episode[]
  characters: CharacterAsset[]
  scenes: Scene[]
  storyboards: Storyboard[]
  storyboardOutputs: StoryboardOutput[]
  characterReferences: CharacterReference[]
  characterVoiceReferences: CharacterVoiceReference[]
  sceneReferences: SceneReference[]
  sourceDocuments: SourceDocumentDetail[]
  structureCandidates: StructureCandidate[]
}

export const LOCAL_VIDEO_LAB_PROJECT_ID = '00000000-video-lab-workspace'

export function isLocalProjectId(projectId: string) {
  return (
    (projectId.startsWith('local-') || projectId === LOCAL_VIDEO_LAB_PROJECT_ID) &&
    Boolean(globalThis.window?.aiDramaDesktop)
  )
}
