import { reactive } from 'vue'
import { describe, expect, it } from 'vitest'
import type { StructurePayload } from '../../api/source'
import {
  cloneStructureCandidatePayload,
  selectedEpisodesHaveContent,
} from './structure-candidate-draft'

describe('structure candidate draft', () => {
  it('clones a Vue reactive payload without mutating the source candidate', () => {
    const source = reactive<StructurePayload>({
      schemaVersion: '1.0',
      episodes: [
        {
          candidateKey: 'episode-1',
          title: '牢狱之灾',
          synopsis: '主角在监牢中醒来。',
          scriptText: '场景一：京兆府监牢。',
          targetDurationSec: 60,
          scenes: [
            {
              candidateKey: 'scene-1',
              title: '京兆府监牢',
              location: '监牢',
              timeOfDay: '清晨',
            },
          ],
        },
      ],
      characters: [
        {
          candidateKey: 'character-1',
          name: '许七安',
          roleType: 'PROTAGONIST',
        },
      ],
    })

    const draft = cloneStructureCandidatePayload(source)
    draft.episodes[0]!.title = '修改后的分集'
    draft.episodes[0]!.scenes[0]!.title = '修改后的场景'
    draft.characters[0]!.name = '修改后的角色'

    expect(source.episodes[0]!.title).toBe('牢狱之灾')
    expect(source.episodes[0]!.scenes[0]!.title).toBe('京兆府监牢')
    expect(source.characters[0]!.name).toBe('许七安')
    expect(draft.episodes[0]).not.toBe(source.episodes[0])
    expect(draft.episodes[0]!.scenes[0]).not.toBe(source.episodes[0]!.scenes[0])
  })

  it('requires every selected episode to retain reviewable content', () => {
    const payload: StructurePayload = {
      schemaVersion: '1.0',
      episodes: [
        {
          candidateKey: 'episode-1',
          title: '第一集',
          synopsis: '完整剧情资料',
          scriptText: '',
          targetDurationSec: 60,
          scenes: [],
        },
        {
          candidateKey: 'legacy-episode',
          title: '历史候选',
          synopsis: '',
          scriptText: '历史剧本',
          targetDurationSec: 60,
          scenes: [],
        },
      ],
      characters: [],
    }

    expect(selectedEpisodesHaveContent(payload, ['episode-1', 'legacy-episode'])).toBe(true)
    payload.episodes[0]!.synopsis = ''
    expect(selectedEpisodesHaveContent(payload, ['episode-1'])).toBe(false)
  })
})
