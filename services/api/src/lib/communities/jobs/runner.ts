import { nowIso } from "../../helpers"
import type { Env } from "../../../env"
import { openCommunityWriteClient } from "../community-read-access"
import { logPipelineError, logPipelineInfo, summarizeReference } from "../../observability/pipeline-log"
import {
  findNextRunnableCommunityJob,
  getCommunityJobById,
  markCommunityJobRunning,
  markCommunityJobSucceeded,
  resetStaleRunningCommunityJobs,
  type CommunityJobType,
  type CommunityJobRow,
} from "./store"
import { runCommunityJob } from "./handlers"
import {
  COMMUNITY_JOB_MAX_ATTEMPTS,
  type CommunityJobRepository,
} from "./runner-types"
import { recordCommunityJobFailure } from "./runner-failure"

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

const STALE_RUNNING_JOB_TIMEOUT_MS = 15 * 60 * 1000

type CommunityJobCommunityProcessingSummary = {
  community_id: string
  processed_jobs: number
  jobs: CommunityJobRow[]
}

type CommunityJobProcessingSummary = {
  processed_jobs: number
  communities: CommunityJobCommunityProcessingSummary[]
}

function createdAtMs(community: { created_at?: string | null }): number {
  const parsed = Date.parse(community.created_at ?? "")
  return Number.isFinite(parsed) ? parsed : 0
}

export function selectScheduledCommunityJobPollIds(
  communities: Array<{ community_id: string; created_at?: string | null }>,
  maxCommunities: number,
  nowMs: number = Date.now(),
): string[] {
  if (communities.length <= maxCommunities) {
    return communities.map((community) => community.community_id)
  }

  const recentCount = Math.max(1, Math.min(maxCommunities, Math.ceil(maxCommunities / 4)))
  const newest = communities
    .slice()
    .sort((left, right) => {
      const createdDiff = createdAtMs(right) - createdAtMs(left)
      return createdDiff !== 0 ? createdDiff : right.community_id.localeCompare(left.community_id)
    })
    .slice(0, recentCount)

  const selected = new Set(newest.map((community) => community.community_id))
  const remaining = communities.filter((community) => !selected.has(community.community_id))
  const rotatingCount = maxCommunities - selected.size
  if (rotatingCount <= 0 || remaining.length === 0) {
    return Array.from(selected)
  }

  const minuteBucket = Math.floor(nowMs / 60_000)
  const start = remaining.length === 0 ? 0 : (minuteBucket * rotatingCount) % remaining.length
  for (let index = 0; index < rotatingCount && index < remaining.length; index += 1) {
    selected.add(remaining[(start + index) % remaining.length]!.community_id)
  }

  return Array.from(selected)
}

export async function processCommunityJobById(input: {
  env: Env
  communityId: string
  jobId: string
  communityRepository: CommunityJobRepository
}): Promise<CommunityJobRow | null> {
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
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

      logPipelineInfo("[community-job] completed", {
        job_id: running.job_id,
        job_type: running.job_type,
        community_id: running.community_id,
        ...summarizeReference("subject_id", running.subject_id),
        attempt_count: running.attempt_count,
        ...summarizeReference("result_ref", resultRef),
      })
      if (resultRef?.startsWith("failed:")) {
        logPipelineError("[community-job] completed with failed result", {
          job_id: running.job_id,
          job_type: running.job_type,
          community_id: running.community_id,
          ...summarizeReference("subject_id", running.subject_id),
          attempt_count: running.attempt_count,
          ...summarizeReference("result_ref", resultRef),
        })
      }

      return await markCommunityJobSucceeded({
        client: db.client,
        jobId: running.job_id,
        resultRef,
        now: nowIso(),
      })
    } catch (error) {
      const failedAt = nowIso()
      return await recordCommunityJobFailure({
        client: db.client,
        env: input.env,
        job: running,
        error,
        failedAt,
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
  skipJobTypes?: CommunityJobType[] | null
}): Promise<CommunityJobRow | null> {
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    const next = await findNextRunnableCommunityJob({
      client: db.client,
      communityId: input.communityId,
      now: nowIso(),
      maxAttempts: COMMUNITY_JOB_MAX_ATTEMPTS,
      skipJobTypes: input.skipJobTypes,
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
  skipJobTypes?: CommunityJobType[] | null
}): Promise<CommunityJobCommunityProcessingSummary> {
  const maxJobs = Math.max(1, Math.trunc(input.maxJobs ?? 25))
  const jobs: CommunityJobRow[] = []
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    const now = nowIso()
    await resetStaleRunningCommunityJobs({
      client: db.client,
      communityId: input.communityId,
      now,
      staleBefore: new Date(Date.parse(now) - STALE_RUNNING_JOB_TIMEOUT_MS).toISOString(),
    })
  } finally {
    db.close()
  }

  while (jobs.length < maxJobs) {
    const processed = await processNextCommunityJob({
      env: input.env,
      communityId: input.communityId,
      communityRepository: input.communityRepository,
      skipJobTypes: input.skipJobTypes,
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
  skipJobTypes?: CommunityJobType[] | null
}): Promise<CommunityJobProcessingSummary> {
  const maxCommunities = Math.max(1, Math.trunc(input.maxCommunities ?? 100))
  const communityIds = input.communityIds?.length
    ? input.communityIds.slice(0, maxCommunities)
    : selectScheduledCommunityJobPollIds(
      await input.communityRepository.listActiveCommunities(),
      maxCommunities,
    )

  const communities: CommunityJobCommunityProcessingSummary[] = []

  for (const communityId of communityIds) {
    const processed = await processCommunityJobsForCommunity({
      env: input.env,
      communityId,
      communityRepository: input.communityRepository,
      maxJobs: input.maxJobsPerCommunity ?? 25,
      skipJobTypes: input.skipJobTypes,
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
  skipJobTypes?: CommunityJobType[] | null
  pollIntervalMs?: number
  stopWhenIdle?: boolean
  signal?: AbortSignal
  onTick?: (summary: CommunityJobProcessingSummary) => void | Promise<void>
}): Promise<void> {
  const pollIntervalMs = Math.max(100, Math.trunc(input.pollIntervalMs ?? 2000))

  while (!input.signal?.aborted) {
    const summary = await processAvailableCommunityJobs({
      env: input.env,
      communityRepository: input.communityRepository,
      communityIds: input.communityIds ?? null,
      maxCommunities: input.maxCommunities ?? 100,
      maxJobsPerCommunity: input.maxJobsPerCommunity ?? 25,
      skipJobTypes: input.skipJobTypes,
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
