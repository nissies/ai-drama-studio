import type { GenerationRoute } from './generation'
import type { CreateImageGenerationInput } from './image-generation'

function routePayload(route: GenerationRoute) {
  return route.sourceType === 'LOCAL'
    ? {
        sourceType: route.sourceType,
        localConnectionId: route.localConnectionId,
        localProviderCode: route.localProviderCode,
        localModelName: route.localModelName,
      }
    : { sourceType: route.sourceType, platformModelId: route.platformModelId }
}

export function toImageGenerationPayload(input: CreateImageGenerationInput) {
  return {
    targetType: input.targetType,
    targetId: input.targetId,
    prompt: input.prompt,
    negativePrompt: input.negativePrompt,
    size: input.size,
    compositionType: input.compositionType,
    parameters: input.parameters ?? {},
    ...routePayload(input.route),
  }
}
