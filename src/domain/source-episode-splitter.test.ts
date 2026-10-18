import { describe, expect, it } from 'vitest'
import {
  MAX_SOURCE_CHARACTERS_PER_EPISODE,
  splitSourceIntoStructure,
} from './source-episode-splitter'

describe('system source episode splitter', () => {
  it('keeps every source character while splitting at chapter headings', () => {
    const content =
      '第一章 牢狱之灾\n许七安醒来。\n\n第二章 自救无门\n他开始寻找脱身办法。\n\n第三章 转机\n线索终于出现。'
    const payload = splitSourceIntoStructure(content, {
      episodeCountMode: 'AUTO',
      targetCharactersPerEpisode: 5_000,
      targetDurationSec: 60,
    })

    expect(payload.episodes.map((episode) => episode.synopsis).join('')).toBe(content)
    expect(payload.episodes.map((episode) => episode.title)).toEqual([
      '第一章 牢狱之灾',
      '第二章 自救无门',
      '第三章 转机',
    ])
    expect(payload.episodes.every((episode) => episode.scriptText === '')).toBe(true)
    expect(payload.characters).toEqual([])
  })

  it('adds episodes instead of truncating an oversized fixed split', () => {
    const content = `开场。${'连续剧情。'.repeat(8_000)}`
    const payload = splitSourceIntoStructure(content, {
      episodeCountMode: 'FIXED',
      targetEpisodeCount: 1,
      targetDurationSec: 60,
    })

    expect(payload.episodes.length).toBeGreaterThan(1)
    expect(payload.episodes.map((episode) => episode.synopsis).join('')).toBe(content)
    expect(
      payload.episodes.every(
        (episode) => (episode.synopsis?.length || 0) <= MAX_SOURCE_CHARACTERS_PER_EPISODE,
      ),
    ).toBe(true)
  })

  it('never creates more episodes than the source has characters', () => {
    const content = '剧情'
    const payload = splitSourceIntoStructure(content, {
      episodeCountMode: 'FIXED',
      targetEpisodeCount: 2_000,
      targetDurationSec: 60,
    })

    expect(payload.episodes).toHaveLength(2)
    expect(payload.episodes.map((episode) => episode.synopsis).join('')).toBe(content)
  })
})
