import type { GenerationJob } from '../api/generation'

const ACTIVE_STATUSES = new Set<GenerationJob['status']>([
  'WAITING_LOCAL',
  'QUEUED',
  'RUNNING',
])

export function latestActiveGenerationJob(
  jobs: GenerationJob[],
  jobType: GenerationJob['jobType'],
  targetType: GenerationJob['targetType'],
  targetId: string,
) {
  return jobs
    .filter(
      (job) =>
        job.jobType === jobType &&
        job.targetType === targetType &&
        job.targetId === targetId &&
        ACTIVE_STATUSES.has(job.status),
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
}
