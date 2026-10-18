import type { CharacterReference, SceneReference } from '../api/assets'
import type { CharacterAsset, CharacterForm, Scene, Storyboard } from '../api/workspace'

export interface StoryboardReferenceAsset {
  assetId: string
  label: string
}

type StoryboardReferenceInput = Pick<Storyboard, 'sceneId' | 'characterIds'> &
  Partial<
    Pick<
      Storyboard,
      'title' | 'location' | 'description' | 'actionText' | 'imagePrompt' | 'videoPrompt'
    >
  >
type SceneReferenceInput = Pick<Scene, 'id' | 'title'> &
  Partial<Pick<Scene, 'location' | 'description' | 'environmentPrompt'>>

const CHARACTER_VIEW_LABELS: Record<string, string> = {
  CHARACTER_SHEET: '完整设定板',
  TURNAROUND_PORTRAIT: '三视图/上半身',
  TURNAROUND: '三视图',
  FRONT: '正面',
  THREE_QUARTER: '45度',
  SIDE: '侧面',
  BACK: '背面',
  CLOSE_UP: '特写',
}

const FORM_CATEGORY_LABELS: Record<string, string> = {
  APPEARANCE: '默认形态',
}

const PREFERRED_CHARACTER_VIEW_TYPES = [
  'CHARACTER_SHEET',
  'TURNAROUND_PORTRAIT',
  'TURNAROUND',
  'FRONT',
]

export function storyboardReferenceAssets(
  storyboard: StoryboardReferenceInput,
  characters: Array<Pick<CharacterAsset, 'id' | 'name' | 'forms'>>,
  scenes: SceneReferenceInput[],
  characterReferences: CharacterReference[],
  sceneReferences: SceneReference[],
) {
  const result: StoryboardReferenceAsset[] = []
  const scene = resolveStoryboardScene(storyboard, scenes, sceneReferences)
  if (scene) {
    const references = sceneReferences.filter((item) => item.sceneId === scene.id)
    const reference = chooseReference(references, (item) => item.referenceType === 'OVERVIEW')
    if (reference) result.push({ assetId: reference.assetId, label: `场景：${scene.title}` })
  }

  for (const characterId of storyboard.characterIds) {
    const character = characters.find((item) => item.id === characterId)
    if (!character) continue
    const allReferences = characterReferences.filter((item) => item.characterId === character.id)
    const baseReferences = allReferences.filter((item) => !item.characterFormId)
    const baseReference = chooseCharacterReference(baseReferences)
    if (baseReference) {
      pushReference(
        result,
        baseReference.assetId,
        buildCharacterLabel(character.name, undefined, baseReference.viewType),
      )
      continue
    }

    const defaultAppearanceForm = pickDefaultAppearanceForm(character.forms)
    const formReferences = defaultAppearanceForm
      ? allReferences.filter((item) => item.characterFormId === defaultAppearanceForm.id)
      : []
    const reference = chooseCharacterReference(formReferences)
    if (!reference) continue
    pushReference(
      result,
      reference.assetId,
      buildCharacterLabel(character.name, defaultAppearanceForm, reference.viewType),
    )
  }

  return result
}

export function resolveStoryboardScene(
  storyboard: StoryboardReferenceInput,
  scenes: SceneReferenceInput[],
  sceneReferences: SceneReference[] = [],
) {
  const exact = scenes.find((item) => item.id === storyboard.sceneId)
  if (exact) return exact

  const scenesWithReference = scenes.filter((scene) =>
    sceneReferences.some((reference) => reference.sceneId === scene.id),
  )
  const candidates = scenesWithReference.length ? scenesWithReference : scenes
  const storyboardText = normalizeMatchText(
    [
      storyboard.location,
      storyboard.title,
      storyboard.description,
      storyboard.actionText,
      storyboard.imagePrompt,
      storyboard.videoPrompt,
    ].join(' '),
  )
  if (!storyboardText) return undefined

  let best: { scene: SceneReferenceInput; score: number } | undefined
  for (const scene of candidates) {
    const score = sceneMatchScore(storyboardText, scene)
    if (score > 0 && (!best || score > best.score)) best = { scene, score }
  }
  return best?.scene
}

function pickDefaultAppearanceForm(forms: CharacterForm[]) {
  const appearances = forms.filter((form) => normalizeCategory(form.formCategory) === 'APPEARANCE')
  return appearances.find((form) => form.defaultForm) ?? appearances[0]
}

function normalizeCategory(category?: string) {
  const value = (category || 'APPEARANCE').toUpperCase()
  if (value === 'APPEARANCE') return value
  return 'APPEARANCE'
}

function buildCharacterLabel(
  characterName: string,
  form: CharacterForm | undefined,
  viewType: string,
) {
  const viewLabel = CHARACTER_VIEW_LABELS[viewType]
  if (!form) return `角色基础图：${characterName}${viewLabel ? `（${viewLabel}）` : ''}`
  const categoryLabel = FORM_CATEGORY_LABELS[normalizeCategory(form.formCategory)] || '默认形态'
  const formLabel = `/${categoryLabel}·${form.displayName}`
  return `角色基础图：${characterName}${formLabel}${viewLabel ? `（${viewLabel}）` : ''}`
}

function pushReference(result: StoryboardReferenceAsset[], assetId: string, label: string) {
  const duplicate = result.find((item) => item.assetId === assetId)
  if (duplicate) duplicate.label = `${duplicate.label}、${label}`
  else result.push({ assetId, label })
}

function chooseReference<T extends { primaryReference: boolean }>(
  references: T[],
  preferred: (reference: T) => boolean,
) {
  return (
    references.find((reference) => reference.primaryReference && preferred(reference)) ??
    references.find((reference) => reference.primaryReference) ??
    references.find(preferred) ??
    references[0]
  )
}

function chooseCharacterReference<T extends { primaryReference: boolean; viewType: string }>(
  references: T[],
) {
  return chooseReference(references, (item) =>
    PREFERRED_CHARACTER_VIEW_TYPES.includes(item.viewType),
  )
}

function sceneMatchScore(storyboardText: string, scene: SceneReferenceInput) {
  let score = 0
  for (const token of sceneMatchTokens(scene)) {
    if (!token) continue
    if (storyboardText.includes(token)) {
      score += token.length <= 2 ? 3 : Math.min(8, token.length)
    }
  }
  return score
}

function sceneMatchTokens(scene: SceneReferenceInput) {
  const rawValues = [scene.title, scene.location, scene.description, scene.environmentPrompt]
    .filter(Boolean)
    .flatMap((value) => splitSceneMatchTokens(value || ''))
  return Array.from(new Set(rawValues.map(normalizeMatchText).filter((value) => value.length >= 2)))
}

function splitSceneMatchTokens(value: string) {
  return value
    .split(/[—\-–_｜|/\\、，,。.；;：:\s]+/u)
    .map((item) => item.trim())
    .concat(value.trim())
}

function normalizeMatchText(value: string) {
  return value
    .toLowerCase()
    .replace(/[《》「」『』【】[\]（）()“”"']/gu, '')
    .replace(/[—\-–_｜|/\\、，,。.；;：:\s]+/gu, '')
    .trim()
}
