export const SCRIPT_CHARACTERS_PER_SECOND = 4.2
export const CLEARLY_SHORT_SCRIPT_RATIO = 0.8
export const GENERATED_SCRIPT_MIN_CHARACTERS_PER_SECOND = 5.3
export const MIN_SCRIPT_GENERATION_TOKENS = 4_000
export const MAX_SCRIPT_GENERATION_TOKENS = 50_000
export const STRUCTURE_DETAIL_TOKENS_PER_EPISODE = 1_200

export function scriptCharacterCount(scriptText?: string | null) {
  return Array.from(scriptText?.trim() || '').filter((character) => !/\s/u.test(character)).length
}

export function estimateScriptDurationSec(scriptText?: string | null) {
  return Math.max(0, Math.round(scriptCharacterCount(scriptText) / SCRIPT_CHARACTERS_PER_SECOND))
}

export function recommendedScriptCharacterCount(targetDurationSec: number) {
  return Math.max(1, Math.round(Math.max(0, targetDurationSec) * SCRIPT_CHARACTERS_PER_SECOND))
}

export function minimumGeneratedScriptCharacterCount(targetDurationSec: number) {
  return Math.max(
    1,
    Math.ceil((Math.max(0, targetDurationSec) * GENERATED_SCRIPT_MIN_CHARACTERS_PER_SECOND) / 10) *
      10,
  )
}

export function scriptGenerationMaxTokens(
  targetDurationSec: number,
  sourceScriptCharacterCount = 0,
) {
  const expectedCharacters = Math.max(
    minimumGeneratedScriptCharacterCount(targetDurationSec),
    Math.max(0, sourceScriptCharacterCount),
  )
  const estimatedTokens =
    Math.ceil((expectedCharacters * 1.5) / 100) * 100
  return Math.max(
    MIN_SCRIPT_GENERATION_TOKENS,
    Math.min(MAX_SCRIPT_GENERATION_TOKENS, estimatedTokens),
  )
}

export function structureGenerationMaxTokens(episodeCount: number) {
  const estimatedTokens =
    Math.ceil((Math.max(1, episodeCount) * STRUCTURE_DETAIL_TOKENS_PER_EPISODE) / 1_000) * 1_000
  return Math.max(
    MIN_SCRIPT_GENERATION_TOKENS,
    Math.min(MAX_SCRIPT_GENERATION_TOKENS, estimatedTokens),
  )
}

export function isScriptClearlyShort(
  scriptText: string | null | undefined,
  targetDurationSec: number,
) {
  if (targetDurationSec <= 0) return false
  return (
    scriptCharacterCount(scriptText) <
    recommendedScriptCharacterCount(targetDurationSec) * CLEARLY_SHORT_SCRIPT_RATIO
  )
}

export function resequenceEpisodes<T extends { episodeNo: number; title?: string }>(
  episodes: T[],
): T[] {
  return [...episodes]
    .sort((left, right) => left.episodeNo - right.episodeNo)
    .map((episode, index) => {
      const episodeNo = index + 1
      if (episode.episodeNo === episodeNo) return episode
      const defaultTitle = `第${episode.episodeNo}集`
      return {
        ...episode,
        episodeNo,
        ...(episode.title === defaultTitle ? { title: `第${episodeNo}集` } : {}),
      }
    })
}
