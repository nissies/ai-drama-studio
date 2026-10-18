import type { CreateGenerationJobInput } from './generation'

export function toCreatePayload(input: CreateGenerationJobInput) {
  return {
    jobType: input.jobType,
    targetType: input.targetType,
    targetId: input.targetId,
    parameters: input.parameters ?? {},
    sourceType: input.route.sourceType,
    ...(input.route.sourceType === 'LOCAL'
      ? {
          localConnectionId: input.route.localConnectionId,
          localProviderCode: input.route.localProviderCode,
          localModelName: input.route.localModelName,
        }
      : { platformModelId: input.route.platformModelId }),
  }
}
