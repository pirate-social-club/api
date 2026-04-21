import { nowIso } from "../helpers"
import type { Env } from "../../types"
import { openCommunityDb } from "./community-db-factory"
import {
  findNextRunnableCommunityJob,
  getCommunityJobById,
  markCommunityJobFailed,
  markCommunityJobRunning,
  markCommunityJobSucceeded,
  type CommunityJobRow,
} from "./community-job-store"
import { runCommunityJob } from "./community-job-handlers"
import {
  COMMUNITY_JOB_MAX_ATTEMPTS,
  COMMUNITY_JOB_RETRY_BASE_MS,
  COMMUNITY_JOB_RETRY_MAX_MS,
  type CommunityJobRepository,
} from "./community-job-runner-types"

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function computeRetryDelayMs(attemptCount: number): number {
  const exponent = Math.max(0, attemptCount - 1)
  return Math.min(COMMUNITY_JOB_RETRY_BASE_MS * (2 ** exponent), COMMUNITY_JOB_RETRY_MAX_MS)
}

function computeNextRetryAt(now: string, attemptCount: number): string {
  return new Date(Date.parse(now) + computeRetryDelayMs(attemptCount)).toISOString()
}

export async function processCommunityJobById(input: {
  env: Env
  communityId: string
  jobId: string
  communityRepository: CommunityJobRepository
}): Promise<CommunityJobRow | null> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    const existing = await getCommunityJobById({
      client: db.client,
      jobId: input.jobId,
    })
    if (!existing || existing.community_id !== input.communityId) {
      return null
    }

    const running = await markCommunityJobRunning({
      client: db.client,
      jobId: input.jobId,
      now: nowIso(),
    })
    if (!running) {
      return null
    }

    try {
      const resultRef = await runCommunityJob({
        job: running,
        env: input.env,
        communityRepository: input.communityRepository,
      })

      return await markCommunityJobSucceeded({
        client: db.client,
        jobId: running.job_id,
        resultRef,
        now: nowIso(),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const failedAt = nowIso()
      return await markCommunityJobFailed({
        client: db.client,
        jobId: running.job_id,
        errorCode: message || "community_job_failed",
        availableAt: running.attempt_count >= COMMUNITY_JOB_MAX_ATTEMPTS
          ? null
          : computeNextRetryAt(failedAt, running.attempt_count),
        now: failedAt,
      })
    }
  } finally {
    db.close()
  }
}

export async function processNextCommunityJob(input: {
  env: Env
  communityId: string
  communityRepository: CommunityJobRepository
}): Promise<CommunityJobRow | null> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    const next = await findNextRunnableCommunityJob({
      client: db.client,
      communityId: input.communityId,
      now: nowIso(),
      maxAttempts: COMMUNITY_JOB_MAX_ATTEMPTS,
    })
    if (!next) {
      return null
    }
    return processCommunityJobById({
      env: input.env,
      communityId: input.communityId,
      jobId: next.job_id,
      communityRepository: input.communityRepository,
    })
  } finally {
    db.close()
  }
}

export async function processCommunityJobsForCommunity(input: {
  env: Env
  communityId: string
  communityRepository: CommunityJobRepository
  maxJobs?: number
}): Promise<{
  community_id: string
  processed_jobs: number
  jobs: CommunityJobRow[]
}> {
  const maxJobs = Math.max(1, Math.trunc(input.maxJobs ?? 25))
  const jobs: CommunityJobRow[] = []

  while (jobs.length < maxJobs) {
    const processed = await processNextCommunityJob({
      env: input.env,
      communityId: input.communityId,
      communityRepository: input.communityRepository,
    })
    if (!processed) {
      break
    }
    jobs.push(processed)
  }

  return {
    community_id: input.communityId,
    processed_jobs: jobs.length,
    jobs,
  }
}

export async function processAvailableCommunityJobs(input: {
  env: Env
  communityRepository: CommunityJobRepository
  communityIds?: string[] | null
  maxCommunities?: number
  maxJobsPerCommunity?: number
}): Promise<{
  processed_jobs: number
  communities: Array<{
    community_id: string
    processed_jobs: number
    jobs: CommunityJobRow[]
  }>
}> {
  const communityIds = (input.communityIds?.length
    ? input.communityIds
    : (await input.communityRepository.listActiveCommunities()).map((community) => community.community_id))
    .slice(0, Math.max(1, Math.trunc(input.maxCommunities ?? 100)))

  const communities: Array<{
    community_id: string
    processed_jobs: number
    jobs: CommunityJobRow[]
  }> = []

  for (const communityId of communityIds) {
    const processed = await processCommunityJobsForCommunity({
      env: input.env,
      communityId,
      communityRepository: input.communityRepository,
      maxJobs: input.maxJobsPerCommunity ?? 25,
    })
    if (processed.processed_jobs > 0) {
      communities.push(processed)
    }
  }

  return {
    processed_jobs: communities.reduce((sum, community) => sum + community.processed_jobs, 0),
    communities,
  }
}

export async function runCommunityJobWorkerLoop(input: {
  env: Env
  communityRepository: CommunityJobRepository
  communityIds?: string[] | null
  maxCommunities?: number
  maxJobsPerCommunity?: number
  pollIntervalMs?: number
  stopWhenIdle?: boolean
  signal?: AbortSignal
  onTick?: (summary: {
    processed_jobs: number
    communities: Array<{
      community_id: string
      processed_jobs: number
      jobs: CommunityJobRow[]
    }>
  }) => void | Promise<void>
}): Promise<void> {
  const pollIntervalMs = Math.max(100, Math.trunc(input.pollIntervalMs ?? 2000))

  while (!input.signal?.aborted) {
    const summary = await processAvailableCommunityJobs({
      env: input.env,
      communityRepository: input.communityRepository,
      communityIds: input.communityIds ?? null,
      maxCommunities: input.maxCommunities ?? 100,
      maxJobsPerCommunity: input.maxJobsPerCommunity ?? 25,
    })

    await input.onTick?.(summary)

    if (summary.processed_jobs === 0 && input.stopWhenIdle) {
      return
    }

    if (input.signal?.aborted) {
      return
    }

    await sleep(pollIntervalMs)
  }
}
