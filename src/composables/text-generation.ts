import {
  generationApi,
  startLocalJobHeartbeat,
  type GenerationJob,
  type GenerationRoute,
} from '../api/generation'
import type { useDesktopStore } from '../stores/desktop'

type DesktopStore = ReturnType<typeof useDesktopStore>

const PLATFORM_POLL_INTERVAL_MS = 1500
const PLATFORM_POLL_ATTEMPTS = 240

export async function executeTextGeneration(
  initialJob: GenerationJob,
  route: GenerationRoute,
  desktop: DesktopStore,
  onUpdate?: (job: GenerationJob) => void,
) {
  if (['SUCCEEDED', 'FAILED', 'CANCELED'].includes(initialJob.status)) {
    onUpdate?.(initialJob)
    return initialJob
  }
  if (route.sourceType === 'LOCAL') {
    const execution = initialJob.executionRequest
    if (!execution) throw new Error('本地任务缺少执行请求，请刷新后重试')
    await generationApi.startLocal(initialJob.id)
    const stopHeartbeat = startLocalJobHeartbeat(initialJob.id, 25)
    try {
      const result = await desktop.generateLocalText({
        connectionId: route.localConnectionId,
        systemPrompt: execution.systemPrompt,
        userPrompt: execution.userPrompt,
        parameters: execution.parameters,
      })
      const latest = await generationApi.get(initialJob.id)
      if (latest.status === 'CANCELED') {
        onUpdate?.(latest)
        return latest
      }
      const completed = await generationApi.completeLocal(initialJob.id, result)
      onUpdate?.(completed)
      return completed
    } catch (error) {
      const latest = await generationApi.get(initialJob.id).catch(() => null)
      if (latest?.status === 'CANCELED') {
        onUpdate?.(latest)
        return latest
      }
      const message = error instanceof Error ? error.message : '本地 AI 执行失败'
      try {
        await generationApi.failLocal(initialJob.id, message)
      } catch {
        // Keep the provider error because it is more actionable than a reporting failure.
      }
      throw error
    } finally {
      stopHeartbeat()
    }
  }

  for (let attempt = 0; attempt < PLATFORM_POLL_ATTEMPTS; attempt += 1) {
    const job = await generationApi.get(initialJob.id)
    onUpdate?.(job)
    if (['SUCCEEDED', 'FAILED', 'CANCELED'].includes(job.status)) return job
    await new Promise((resolve) => globalThis.setTimeout(resolve, PLATFORM_POLL_INTERVAL_MS))
  }
  throw new Error('平台模型仍在处理，可稍后在任务中心查看结果')
}
