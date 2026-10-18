import { request } from './client'
import type { GenerationJob } from './generation'
import type { ImageCandidate, ImageSize } from './image-generation'

export interface CreateImageLabGenerationInput {
  prompt: string
  size: ImageSize
  platformModelId: string
  parameters?: Record<string, unknown>
}

export const imageLabApi = {
  create: (input: CreateImageLabGenerationInput, idempotencyKey: string) =>
    request<GenerationJob>('/image-lab/generation-jobs', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ ...input, parameters: input.parameters ?? {} }),
    }),
  get: (jobId: string) =>
    request<GenerationJob>(`/image-lab/generation-jobs/${encodeURIComponent(jobId)}`),
  candidates: () => request<ImageCandidate[]>('/image-lab/candidates'),
}
