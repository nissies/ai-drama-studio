import type { EpisodeCandidate, StructurePayload } from '../api/source'

export const MIN_SOURCE_CHARACTERS_PER_EPISODE = 600
export const DEFAULT_SOURCE_CHARACTERS_PER_EPISODE = 5_000
export const MAX_SOURCE_CHARACTERS_PER_EPISODE = 18_000
export const MAX_SYSTEM_EPISODES = 2_000

export interface SourceSplitOptions {
  episodeCountMode: 'AUTO' | 'FIXED'
  targetEpisodeCount?: number
  targetCharactersPerEpisode?: number
  targetDurationSec: number
}

interface Boundary {
  offset: number
  priority: number
}

const HEADING_LINE = /^(?:#{1,6}[\t ]+.+|第[^\r\n]{1,20}[章节回卷部集][^\r\n]*)$/u
const HEADING_PATTERN =
  /(?:^|\n)([\t ]*(?:#{1,6}[\t ]+[^\r\n]+|第[^\r\n]{1,20}[章节回卷部集][^\r\n]*))/gu
const PARAGRAPH_PATTERN = /\n[\t ]*\n+/gu
const SENTENCE_ENDINGS = new Set(['。', '！', '？', '!', '?', '；', ';'])

export function splitSourceIntoStructure(
  content: string,
  options: SourceSplitOptions,
): StructurePayload {
  if (!content.trim()) throw new Error('原文内容不能为空')
  const boundaries = collectBoundaries(content)
  const headingCount =
    boundaries.filter((item) => item.priority === 4).length + (detectTitle(content) ? 1 : 0)
  const episodeCount = resolveEpisodeCount(content.length, headingCount, options)
  const ranges = partitionContent(content, episodeCount, boundaries)
  const targetDurationSec = clamp(Math.round(options.targetDurationSec || 60), 5, 3_600)
  const episodes: EpisodeCandidate[] = ranges.map(([start, end], index) => ({
    candidateKey: `episode_${index + 1}`,
    title: detectTitle(content.slice(start, end)) || `第 ${index + 1} 集`,
    synopsis: content.slice(start, end),
    scriptText: '',
    targetDurationSec,
    scenes: [],
  }))
  return { schemaVersion: '1.0', episodes, characters: [] }
}

function resolveEpisodeCount(
  contentLength: number,
  headingCount: number,
  options: SourceSplitOptions,
) {
  const minimumForStorage = Math.ceil(contentLength / MAX_SOURCE_CHARACTERS_PER_EPISODE)
  let requested: number
  if (options.episodeCountMode === 'FIXED') {
    requested = clamp(Math.round(options.targetEpisodeCount || 1), 1, MAX_SYSTEM_EPISODES)
  } else {
    const targetCharacters = clamp(
      Math.round(options.targetCharactersPerEpisode || DEFAULT_SOURCE_CHARACTERS_PER_EPISODE),
      MIN_SOURCE_CHARACTERS_PER_EPISODE,
      MAX_SOURCE_CHARACTERS_PER_EPISODE,
    )
    requested = Math.max(Math.ceil(contentLength / targetCharacters), headingCount)
  }
  return Math.min(
    Math.max(1, contentLength),
    Math.min(MAX_SYSTEM_EPISODES, Math.max(requested, minimumForStorage)),
  )
}

function partitionContent(content: string, count: number, boundaries: Boundary[]) {
  const ranges: Array<[number, number]> = []
  const averageLength = content.length / count
  let start = 0
  for (let index = 1; index < count; index += 1) {
    const remainingEpisodes = count - index
    const target = Math.round((content.length * index) / count)
    const minimumEnd = Math.max(
      start + 1,
      content.length - remainingEpisodes * MAX_SOURCE_CHARACTERS_PER_EPISODE,
    )
    const maximumEnd = Math.min(
      start + MAX_SOURCE_CHARACTERS_PER_EPISODE,
      content.length - remainingEpisodes,
    )
    const candidates = boundaries.filter(
      (item) => item.offset >= minimumEnd && item.offset <= maximumEnd,
    )
    const end = candidates.length
      ? candidates.reduce((best, item) =>
          boundaryScore(item, target, averageLength) < boundaryScore(best, target, averageLength)
            ? item
            : best,
        ).offset
      : clamp(target, minimumEnd, maximumEnd)
    ranges.push([start, end])
    start = end
  }
  ranges.push([start, content.length])
  return ranges
}

function collectBoundaries(content: string) {
  const priorities = new Map<number, number>()
  const add = (offset: number, priority: number) => {
    if (offset <= 0 || offset >= content.length) return
    priorities.set(offset, Math.max(priority, priorities.get(offset) || 0))
  }
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]
    if (SENTENCE_ENDINGS.has(character)) add(index + 1, 2)
    if (character === '\n') add(index + 1, 1)
  }
  for (const match of content.matchAll(PARAGRAPH_PATTERN)) {
    add((match.index || 0) + match[0].length, 3)
  }
  for (const match of content.matchAll(HEADING_PATTERN)) {
    const heading = match[1]
    const offset = (match.index || 0) + match[0].lastIndexOf(heading)
    add(offset, 4)
  }
  return [...priorities.entries()]
    .map(([offset, priority]) => ({ offset, priority }))
    .sort((left, right) => left.offset - right.offset)
}

function boundaryScore(boundary: Boundary, target: number, averageLength: number) {
  return Math.abs(boundary.offset - target) - boundary.priority * averageLength * 0.08
}

function detectTitle(content: string) {
  for (const line of content.split(/\r?\n/u)) {
    const normalized = line.trim()
    if (!normalized) continue
    if (!HEADING_LINE.test(normalized)) return ''
    return normalized.replace(/^#{1,6}[\t ]+/u, '').slice(0, 120)
  }
  return ''
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value))
}
