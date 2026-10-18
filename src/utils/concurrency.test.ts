import { describe, expect, it } from 'vitest'
import { mapSettledWithConcurrency } from './concurrency'

describe('mapSettledWithConcurrency', () => {
  it('never exceeds the configured concurrency and preserves result order', async () => {
    let active = 0
    let maxActive = 0

    const results = await mapSettledWithConcurrency(
      [1, 2, 3, 4, 5, 6, 7],
      3,
      async (value) => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => globalThis.setTimeout(resolve, 5))
        active -= 1
        return value * 2
      },
    )

    expect(maxActive).toBe(3)
    expect(results).toEqual(
      [2, 4, 6, 8, 10, 12, 14].map((value) => ({ status: 'fulfilled', value })),
    )
  })

  it('continues processing remaining items when one mapper call fails', async () => {
    const processed: number[] = []

    const results = await mapSettledWithConcurrency([1, 2, 3, 4], 2, async (value) => {
      processed.push(value)
      if (value === 2) throw new Error('preview failed')
      return value
    })

    expect(processed.sort((left, right) => left - right)).toEqual([1, 2, 3, 4])
    expect(results[0]).toEqual({ status: 'fulfilled', value: 1 })
    expect(results[1]).toMatchObject({ status: 'rejected', reason: new Error('preview failed') })
    expect(results[2]).toEqual({ status: 'fulfilled', value: 3 })
    expect(results[3]).toEqual({ status: 'fulfilled', value: 4 })
  })

  it('rejects invalid concurrency values', async () => {
    await expect(mapSettledWithConcurrency([], 0, async () => undefined)).rejects.toThrow(
      RangeError,
    )
  })
})
