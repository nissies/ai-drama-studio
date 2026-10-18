import type { EpisodeAssetPayload } from '../../api/episode-assets'

export function cloneEpisodeAssetPayload(payload: EpisodeAssetPayload): EpisodeAssetPayload {
  return {
    schemaVersion: payload.schemaVersion,
    characters: payload.characters.map((character) => ({ ...character })),
    scenes: payload.scenes.map((scene) => ({ ...scene })),
  }
}
