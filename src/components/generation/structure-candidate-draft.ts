import type { StructurePayload } from '../../api/source'

export function cloneStructureCandidatePayload(payload: StructurePayload): StructurePayload {
  return {
    schemaVersion: payload.schemaVersion,
    episodes: payload.episodes.map((episode) => ({
      ...episode,
      scenes: episode.scenes.map((scene) => ({ ...scene })),
    })),
    characters: payload.characters.map((character) => ({ ...character })),
  }
}

export function selectedEpisodesHaveContent(
  payload: StructurePayload,
  selectedEpisodeKeys: string[],
) {
  const episodes = new Map(payload.episodes.map((episode) => [episode.candidateKey, episode]))
  return selectedEpisodeKeys.every((key) => {
    const episode = episodes.get(key)
    return Boolean(episode && (episode.synopsis?.trim() || episode.scriptText?.trim()))
  })
}
