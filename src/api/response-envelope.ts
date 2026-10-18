export interface ApiEnvelope<T> {
  requestId: string
  data: T
  error: { code: string; message: string } | null
}

export function parseEnvelope<T>(value: string): ApiEnvelope<T> | null {
  if (!value.trim()) return null
  try {
    return JSON.parse(value) as ApiEnvelope<T>
  } catch {
    return null
  }
}
