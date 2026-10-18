import type { CreateProjectInput } from './client'

export function buildProjectPayload(input: CreateProjectInput): CreateProjectInput {
  return {
    title: input.title.trim(),
    description: input.description?.trim() || undefined,
    visualStyle: input.visualStyle?.trim() || undefined,
    visualBible: input.visualBible?.trim() || undefined,
    aspectRatio: input.aspectRatio ?? 'UNSET',
  }
}
