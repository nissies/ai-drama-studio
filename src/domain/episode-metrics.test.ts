import { describe, expect, it } from 'vitest'
import {
  estimateScriptDurationSec,
  isScriptClearlyShort,
  minimumGeneratedScriptCharacterCount,
  recommendedScriptCharacterCount,
  resequenceEpisodes,
  scriptCharacterCount,
  scriptGenerationMaxTokens,
  structureGenerationMaxTokens,
} from './episode-metrics'

describe('episode metrics', () => {
  it('estimates script length using the editor pacing rule', () => {
    expect(recommendedScriptCharacterCount(60)).toBe(252)
    expect(minimumGeneratedScriptCharacterCount(60)).toBe(320)
    expect(scriptGenerationMaxTokens(60)).toBe(4000)
    expect(scriptGenerationMaxTokens(3600)).toBe(28700)
    expect(scriptGenerationMaxTokens(60, 10_000)).toBe(15000)
    expect(structureGenerationMaxTokens(1)).toBe(4000)
    expect(structureGenerationMaxTokens(5)).toBe(6000)
    expect(structureGenerationMaxTokens(100)).toBe(50000)
    expect(estimateScriptDurationSec('剧'.repeat(126))).toBe(30)
    expect(scriptCharacterCount(' 场景一\n  角色：对白 ')).toBe(8)
    expect(isScriptClearlyShort('剧'.repeat(126), 60)).toBe(true)
    expect(isScriptClearlyShort('剧'.repeat(220), 60)).toBe(false)
  })

  it('sorts and resequences episodes without changing their ids', () => {
    const episodes = [
      { id: 'episode-3', episodeNo: 3, title: '第3集' },
      { id: 'episode-2', episodeNo: 2, title: '剧情转折' },
    ]

    expect(resequenceEpisodes(episodes)).toEqual([
      { id: 'episode-2', episodeNo: 1, title: '剧情转折' },
      { id: 'episode-3', episodeNo: 2, title: '第2集' },
    ])
    expect(episodes[0].episodeNo).toBe(3)
  })
})
