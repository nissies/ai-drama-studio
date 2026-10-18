import { describe, expect, it } from 'vitest'
import { parseEnvelope } from './response-envelope'

describe('API envelope parsing', () => {
  it('returns null for empty and non-JSON responses', () => {
    expect(parseEnvelope('')).toBeNull()
    expect(parseEnvelope('<html>error</html>')).toBeNull()
  })

  it('parses a valid API response', () => {
    expect(
      parseEnvelope<{ status: string }>(
        '{"requestId":"req-1","data":{"status":"UP"},"error":null}',
      ),
    ).toMatchObject({ requestId: 'req-1', data: { status: 'UP' }, error: null })
  })
})
