import { describe, expect, it } from 'vitest'
import type { StoryboardCandidatePayload } from '../../api/storyboard-candidates'
import {
  cloneStoryboardCandidatePayload,
  createSelectedStoryboardPayload,
  mergeStoryboardShotsByTargetDuration,
  selectedStoryboardDuration,
  validateStoryboardCandidateDraft,
} from './storyboard-candidate-draft'

const payload: StoryboardCandidatePayload = {
  schemaVersion: '1.0',
  shots: [
    { candidateKey: 'shot_1', title: '开场', characterIds: ['char-1'], durationSec: 4 },
    { candidateKey: 'shot_2', title: '转折', characterIds: [], durationSec: 6 },
  ],
}

describe('storyboard candidate draft', () => {
  it('deep clones character bindings and totals selected duration', () => {
    const clone = cloneStoryboardCandidatePayload(payload)
    clone.shots[0]!.characterIds.push('char-2')

    expect(payload.shots[0]!.characterIds).toEqual(['char-1'])
    expect(selectedStoryboardDuration(clone.shots, ['shot_2'])).toBe(6)
  })

  it('validates only selected shots', () => {
    const draft = cloneStoryboardCandidatePayload(payload)
    draft.shots[0]!.title = ''
    expect(validateStoryboardCandidateDraft(draft, ['shot_2'])).toBe('')
    expect(validateStoryboardCandidateDraft(draft, ['shot_1'])).toContain('缺少标题')
    expect(validateStoryboardCandidateDraft(draft, [])).toContain('至少选择')
  })

  it('builds an apply payload containing selected shots only', () => {
    const selected = createSelectedStoryboardPayload(payload, ['shot_2'])

    expect(selected.shots.map((shot) => shot.candidateKey)).toEqual(['shot_2'])
  })
})

  it('merges short consecutive shots toward target duration', () => {
    const detailed: StoryboardCandidatePayload = {
      schemaVersion: '1.0',
      shots: [
        { candidateKey: 'a', title: '起', sceneId: 's1', characterIds: ['c1'], durationSec: 4, actionText: '抬头' },
        { candidateKey: 'b', title: '承', sceneId: 's1', characterIds: ['c1'], durationSec: 5, dialogue: '谁？' },
        { candidateKey: 'c', title: '转', sceneId: 's1', characterIds: ['c2'], durationSec: 6, actionText: '逼近' },
        { candidateKey: 'd', title: '换场', sceneId: 's2', characterIds: ['c1'], durationSec: 8, actionText: '离开' },
      ],
    }
    const result = mergeStoryboardShotsByTargetDuration(
      detailed,
      detailed.shots.map((shot) => shot.candidateKey),
      15,
    )
    expect(result.payload.shots.length).toBeLessThan(4)
    expect(result.payload.shots.reduce((sum, shot) => sum + shot.durationSec, 0)).toBe(23)
    expect(result.selectedKeys).toHaveLength(result.payload.shots.length)
  })
