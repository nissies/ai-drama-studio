import { reactive } from 'vue'
import { describe, expect, it } from 'vitest'
import { cloneEpisodeAssetPayload } from '../components/generation/episode-asset-draft'
import type { EpisodeAssetPayload } from './episode-assets'

describe('episode asset candidate draft', () => {
  it('clones a Vue reactive payload without mutating the source candidate', () => {
    const source = reactive<EpisodeAssetPayload>({
      schemaVersion: '1.0',
      characters: [
        {
          candidateKey: 'character-1',
          name: '林默',
          roleType: 'PROTAGONIST',
          description: '调查者',
          identityPrompt: '黑色短发',
          negativePrompt: null,
        },
      ],
      scenes: [
        {
          candidateKey: 'scene-1',
          title: '旧楼走廊',
          location: '废弃居民楼',
          timeOfDay: '深夜',
          description: '昏暗走廊',
          environmentPrompt: '老旧居民楼，白炽灯',
        },
      ],
    })

    const draft = cloneEpisodeAssetPayload(source)
    draft.characters[0]!.name = '修改后的角色'
    draft.scenes[0]!.title = '修改后的场景'

    expect(source.characters[0]!.name).toBe('林默')
    expect(source.scenes[0]!.title).toBe('旧楼走廊')
    expect(draft).not.toBe(source)
    expect(draft.characters[0]).not.toBe(source.characters[0])
  })
})
