import { nowIso } from "../../helpers"
import type { Env } from "../../../env"
import { openCommunityWriteClient } from "../community-read-access"
import { logPipelineError, logPipelineInfo, sanitizeLogText, summarizeReference } from "../../observability/pipeline-log"
import {
  findNextRunnableCommunityJob,
  getCommunityJobById,
  markCommunityJobRunning,
  markCommunityJobSucceeded,
  recordCommunityJobCheckpoint,
  renewCommunityJobLease,
  resetStaleRunningCommunityJobById,
  resetStaleRunningCommunityJobs,
  type CommunityJobCheckpoint,
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

const DEFAULT_STALE_CHECKPOINT_TIMEOUT_MS = 2 * 60 * 1000
const DEFAULT_COMMUNITY_JOB_ATTEMPT_TIMEOUT_MS = 12 * 60 * 1000
const DEFAULT_DURABLE_ATTEMPT_DEADLINE_MS = 30 * 60 * 1000
const MAX_DURABLE_ATTEMPT_DEADLINE_MS = 60 * 60 * 1000

type CommunityJobCommunityProcessingSummary = {
  community_id: string
  processed_jobs: number
  jobs: CommunityJobRow[]
}

type CommunityJobCommunityFailureSummary = {
  community_id: string
  error: string
}

type CommunityJobProcessingSummary = {
  processed_jobs: number
  communities: CommunityJobCommunityProcessingSummary[]
  failed_communities: CommunityJobCommunityFailureSummary[]
  /** Communities whose stale-running jobs were checked this tick. */
  swept_communities: number
  /** Selected communities left unswept because the tick deadline passed. */
  deferred_sweep_communities: number
  /** Communities this tick began draining. */
  started_communities: number
  /** Communities left for the next tick because the tick deadline passed. */
  deferred_communities: number
  /** Wall time spent sweeping stale-running jobs. */
  sweep_ms: number
  /** Wall time spent draining runnable jobs. */
  process_ms: number
}

export type ExhaustedCommunityJob = {
  community_id: string
  job_id: string
  job_type: CommunityJobType
  subject_id: string
  /**
   * `community_jobs.error_code` is NOT a code — `recordCommunityJobFailure`
   * writes the raw exception message into it, which routinely carries provider
   * response bodies, URLs, and addresses (e.g. the OpenRouter 404 payload).
   * This value reaches console logs and the ops-alert sink, so it is redacted
   * and truncated on the way out rather than forwarded verbatim.
   */
  error: string | null
}

/**
 * Jobs that burned their last attempt in this tick.
 *
 * Exhaustion is the one community-job outcome nobody recovers from: no further
 * retry is scheduled and the subject is abandoned in place. It was previously
 * indistinguishable from ordinary retry noise, so batches of permanently dead
 * jobs accumulated unnoticed (one prod shard held 28, including 13 songs whose
 * Study content will never generate).
 *
 * Derived from the summary rather than alerted per-failure, so a tick raises at
 * most one alert no matter how many jobs died in it.
 */
export function exhaustedCommunityJobs(
  summary: Pick<CommunityJobProcessingSummary, "communities">,
): ExhaustedCommunityJob[] {
  return summary.communities.flatMap((community) =>
    community.jobs
      .filter((job) => job.status === "failed" && job.attempt_count >= COMMUNITY_JOB_MAX_ATTEMPTS)
      .map((job) => ({
        community_id: job.community_id,
        job_id: job.job_id,
        job_type: job.job_type,
        subject_id: job.subject_id,
        error: sanitizeLogText(job.error_code),
      })))
}

export class CommunityJobAttemptTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`community_job_attempt_timeout:${timeoutMs}`)
    this.name = "CommunityJobAttemptTimeoutError"
  }
}

class CommunityJobLeaseLostError extends Error {
  constructor(jobId: string) {
    super(`community_job_lease_lost:${jobId}`)
    this.name = "CommunityJobLeaseLostError"
  }
}

function resolveCommunityJobAttemptTimeoutMs(env: Pick<Env, "COMMUNITY_JOB_ATTEMPT_TIMEOUT_MS">): number {
  const raw = String(env.COMMUNITY_JOB_ATTEMPT_TIMEOUT_MS || "").trim()
  const parsed = raw ? Number(raw) : DEFAULT_COMMUNITY_JOB_ATTEMPT_TIMEOUT_MS
  return Number.isInteger(parsed) && parsed >= 1_000 && parsed <= MAX_DURABLE_ATTEMPT_DEADLINE_MS
    ? parsed
    : DEFAULT_COMMUNITY_JOB_ATTEMPT_TIMEOUT_MS
}

function resolveCommunityJobDurableAttemptDeadlineMs(
  env: Pick<Env, "COMMUNITY_JOB_DURABLE_ATTEMPT_DEADLINE_MS">,
): number {
  const raw = String(env.COMMUNITY_JOB_DURABLE_ATTEMPT_DEADLINE_MS || "").trim()
  const parsed = raw ? Number(raw) : DEFAULT_DURABLE_ATTEMPT_DEADLINE_MS
  return Number.isInteger(parsed) && parsed >= 60_000 && parsed <= MAX_DURABLE_ATTEMPT_DEADLINE_MS
    ? parsed
    : DEFAULT_DURABLE_ATTEMPT_DEADLINE_MS
}

function resolveCommunityJobStaleCheckpointTimeoutMs(
  env: Pick<Env, "COMMUNITY_JOB_STALE_CHECKPOINT_TIMEOUT_MS">,
): number {
  const raw = String(env.COMMUNITY_JOB_STALE_CHECKPOINT_TIMEOUT_MS || "").trim()
  const parsed = raw ? Number(raw) : DEFAULT_STALE_CHECKPOINT_TIMEOUT_MS
  return Number.isInteger(parsed) && parsed >= 30_000 && parsed <= DEFAULT_DURABLE_ATTEMPT_DEADLINE_MS
    ? parsed
    : DEFAULT_STALE_CHECKPOINT_TIMEOUT_MS
}

export async function recoverCommunityJobByIdIfStale(input: {
  env: Env
  communityId: string
  jobId: string
  communityRepository: CommunityJobRepository
}): Promise<CommunityJobRow | null> {
  const now = nowIso()
  let job: CommunityJobRow | null = null
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    job = await getCommunityJobById({ client: db.client, jobId: input.jobId })
    if (!job || job.community_id !== input.communityId) return null

    if (job.status === "running") {
      const staleCheckpointBefore = new Date(
        Date.parse(now) - resolveCommunityJobStaleCheckpointTimeoutMs(input.env),
      ).toISOString()
      const reset = await resetStaleRunningCommunityJobById({
        client: db.client,
        jobId: job.job_id,
        communityId: input.communityId,
        now,
        staleCheckpointBefore,
      })
      if (!reset) return job
      job = await getCommunityJobById({ client: db.client, jobId: job.job_id })
    }
  } finally {
    db.close()
  }

  if (!job || (job.status !== "queued" && job.status !== "failed")) return job
  if (job.attempt_count >= COMMUNITY_JOB_MAX_ATTEMPTS) return job
  if (job.available_at && job.available_at > now) return job

  return processCommunityJobById({
    env: input.env,
    communityId: input.communityId,
    jobId: job.job_id,
    communityRepository: input.communityRepository,
  })
}

export async function withCommunityJobAttemptTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new CommunityJobAttemptTimeoutError(timeoutMs)), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function createCommunityJobCheckpointRecorder(input: {
  client: Parameters<typeof recordCommunityJobCheckpoint>[0]["client"]
  job: CommunityJobRow
}): (checkpoint: CommunityJobCheckpoint, details?: Record<string, unknown> | null) => Promise<void> {
  return async (checkpoint, details = null) => {
    if (!input.job.attempt_id) throw new CommunityJobLeaseLostError(input.job.job_id)
    const recorded = await recordCommunityJobCheckpoint({
      client: input.client,
      jobId: input.job.job_id,
      communityId: input.job.community_id,
      attemptId: input.job.attempt_id,
      checkpoint,
      now: nowIso(),
      detailsJson: details ? JSON.stringify(details) : null,
    })
    if (!recorded) throw new CommunityJobLeaseLostError(input.job.job_id)
  }
}

function startCommunityJobLeaseHeartbeat(input: {
  client: Parameters<typeof renewCommunityJobLease>[0]["client"]
  job: CommunityJobRow
  leaseDurationMs: number
}): { stop: () => Promise<void>; leaseLost: () => boolean } {
  const attemptId = input.job.attempt_id
  if (!attemptId) throw new CommunityJobLeaseLostError(input.job.job_id)
  const intervalMs = Math.max(10_000, Math.min(30_000, Math.floor(input.leaseDurationMs / 3)))
  let stopped = false
  let lost = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: Promise<void> = Promise.resolve()

  const schedule = () => {
    if (stopped || lost) return
    timer = setTimeout(() => {
      const heartbeatAt = nowIso()
      pending = renewCommunityJobLease({
        client: input.client,
        jobId: input.job.job_id,
        communityId: input.job.community_id,
        attemptId,
        now: heartbeatAt,
        leaseExpiresAt: new Date(Date.parse(heartbeatAt) + input.leaseDurationMs).toISOString(),
      }).then((renewed) => {
        lost = !renewed
      }).catch((error) => {
        logPipelineError("[community-job] lease heartbeat failed", {
          job_id: input.job.job_id,
          community_id: input.job.community_id,
          error: error instanceof Error ? error.message : String(error),
        })
      }).finally(schedule)
    }, intervalMs)
  }
  schedule()

  return {
    leaseLost: () => lost,
    stop: async () => {
      stopped = true
      if (timer) clearTimeout(timer)
      await pending
    },
  }
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

export function rotateCommunityJobTickIds(ids: string[], nowMs: number): string[] {
  if (ids.length <= 1) return ids
  const start = Math.floor(nowMs / 60_000) % ids.length
  return ids.slice(start).concat(ids.slice(0, start))
}

/**
 * Attempt duration, scheduler pickup latency, and end-to-end job age.
 *
 * Completion timestamps alone cannot distinguish "the work is slow" from "the
 * work waited a long time for a runner" — the distinction that mattered when
 * song posts sat in `processing` for tens of minutes and nothing recorded which
 * half was responsible. Three separate numbers, because they answer different
 * questions and conflating them is how the original diagnosis went wrong:
 *
 * - `attempt_duration_ms` — how long THIS attempt executed.
 * - `pickup_latency_ms` — how long the job sat *eligible* before a runner
 *   claimed it. Measured from `available_at` (the retry-backoff expiry, or a
 *   deliberate delay) and only falling back to `created_at` for a job that was
 *   runnable the moment it was enqueued. This is the scheduler-health number:
 *   measuring from `created_at` on a retry would fold in the previous attempt's
 *   execution time and its backoff, which are not scheduler wait at all.
 * - `job_age_at_attempt_start_ms` — created_at → now, across every prior
 *   attempt and backoff. This is what the user actually waited.
 */
export function communityJobTimings(
  job: Pick<CommunityJobRow, "created_at" | "available_at">,
  startedAt: string,
): {
  attempt_duration_ms: number
  pickup_latency_ms: number | null
  job_age_at_attempt_start_ms: number | null
} {
  const startedMs = Date.parse(startedAt)
  const createdMs = Date.parse(job.created_at)
  const availableMs = job.available_at ? Date.parse(job.available_at) : Number.NaN
  const eligibleMs = Number.isFinite(availableMs) ? availableMs : createdMs
  return {
    attempt_duration_ms: Math.max(0, Date.now() - startedMs),
    pickup_latency_ms: Number.isFinite(eligibleMs) ? Math.max(0, startedMs - eligibleMs) : null,
    job_age_at_attempt_start_ms: Number.isFinite(createdMs) ? Math.max(0, startedMs - createdMs) : null,
  }
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

    const startedAt = nowIso()
    const attemptId = `cja_${crypto.randomUUID()}`
    const leaseDurationMs = resolveCommunityJobStaleCheckpointTimeoutMs(input.env)
    const running = await markCommunityJobRunning({
      client: db.client,
      jobId: input.jobId,
      now: startedAt,
      attemptDeadlineAt: new Date(
        Date.parse(startedAt) + resolveCommunityJobDurableAttemptDeadlineMs(input.env),
      ).toISOString(),
      attemptId,
      leaseExpiresAt: new Date(Date.parse(startedAt) + leaseDurationMs).toISOString(),
    })
    if (!running) {
      return null
    }

    const heartbeat = startCommunityJobLeaseHeartbeat({ client: db.client, job: running, leaseDurationMs })
    try {
      const operation = runCommunityJob({
          job: running,
          env: input.env,
          communityRepository: input.communityRepository,
          recordCheckpoint: createCommunityJobCheckpointRecorder({
            client: db.client,
            job: running,
          }),
        })
      // Story registration is not cooperatively cancellable. Racing it against a
      // timer abandons a live mint and lets a retry overlap it. Its durable lease
      // and effect journal are the timeout/recovery boundary instead.
      const resultRef = running.job_type === "post_publish_finalize"
        ? await operation
        : await withCommunityJobAttemptTimeout(operation, resolveCommunityJobAttemptTimeoutMs(input.env))
      if (heartbeat.leaseLost()) throw new CommunityJobLeaseLostError(running.job_id)

      const succeeded = await markCommunityJobSucceeded({
        client: db.client,
        jobId: running.job_id,
        attemptId,
        resultRef,
        now: nowIso(),
      })
      if (!succeeded) {
        logPipelineInfo("[community-job] obsolete attempt completion ignored", {
          job_id: running.job_id,
          job_type: running.job_type,
          community_id: running.community_id,
          attempt_count: running.attempt_count,
        })
        return null
      }

      logPipelineInfo("[community-job] completed", {
        job_id: running.job_id,
        job_type: running.job_type,
        community_id: running.community_id,
        ...summarizeReference("subject_id", running.subject_id),
        attempt_count: running.attempt_count,
        ...communityJobTimings(running, startedAt),
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

      return succeeded
    } catch (error) {
      if (error instanceof CommunityJobLeaseLostError) {
        logPipelineInfo("[community-job] obsolete attempt stopped after lease loss", {
          job_id: running.job_id,
          job_type: running.job_type,
          community_id: running.community_id,
          attempt_count: running.attempt_count,
        })
        return null
      }
      const failedAt = nowIso()
      return await recordCommunityJobFailure({
        timings: communityJobTimings(running, startedAt),
        client: db.client,
        env: input.env,
        job: running,
        error,
        failedAt,
      })
    } finally {
      await heartbeat.stop()
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
  deadlineAtMs?: number | null
  now?: () => number
}): Promise<CommunityJobCommunityProcessingSummary> {
  const maxJobs = Math.max(1, Math.trunc(input.maxJobs ?? 25))
  const jobs: CommunityJobRow[] = []
  const now = input.now ?? (() => Date.now())

  while (jobs.length < maxJobs) {
    if (input.deadlineAtMs != null && now() >= input.deadlineAtMs) {
      break
    }
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

async function sweepStaleRunningCommunityJobs(input: {
  env: Env
  communityRepository: CommunityJobRepository
  communityIds: string[]
  deadlineAtMs: number | null
  nowMs: () => number
}): Promise<{
  failures: CommunityJobCommunityFailureSummary[]
  sweptCommunityIds: string[]
}> {
  const failures: CommunityJobCommunityFailureSummary[] = []
  const sweptCommunityIds: string[] = []
  const now = nowIso()
  const staleCheckpointBefore = new Date(
    Date.parse(now) - resolveCommunityJobStaleCheckpointTimeoutMs(input.env),
  ).toISOString()
  for (const communityId of input.communityIds) {
    if (input.deadlineAtMs != null && input.nowMs() >= input.deadlineAtMs) {
      break
    }
    sweptCommunityIds.push(communityId)
    let db: Awaited<ReturnType<typeof openCommunityWriteClient>> | null = null
    try {
      db = await openCommunityWriteClient(input.env, input.communityRepository, communityId)
      const resetCount = await resetStaleRunningCommunityJobs({
        client: db.client,
        communityId,
        now,
        staleCheckpointBefore,
        deadlineBefore: now,
      })
      if (resetCount > 0) {
        logPipelineInfo("[community-job] reset stale running jobs", {
          community_id: communityId,
          reset_count: resetCount,
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failures.push({ community_id: communityId, error: message })
      logPipelineError("[community-job] failed to sweep stale running jobs", {
        community_id: communityId,
        error: message,
      })
    } finally {
      await db?.close()
    }
  }
  return { failures, sweptCommunityIds }
}

export async function processAvailableCommunityJobs(input: {
  env: Env
  communityRepository: CommunityJobRepository
  communityIds?: string[] | null
  maxCommunities?: number
  maxJobsPerCommunity?: number
  skipJobTypes?: CommunityJobType[] | null
  deadlineMs?: number | null
  now?: () => number
}): Promise<CommunityJobProcessingSummary> {
  const maxCommunities = Math.max(1, Math.trunc(input.maxCommunities ?? 100))
  const now = input.now ?? (() => Date.now())
  const startedAt = now()
  const deadlineMs = input.deadlineMs != null && input.deadlineMs > 0 ? input.deadlineMs : null
  const deadlineAtMs = deadlineMs == null ? null : startedAt + deadlineMs
  const activeCommunities = input.communityIds?.length
    ? []
    : await input.communityRepository.listActiveCommunities({ requireReadyRouting: true })
  const communityIds = input.communityIds?.length
    ? input.communityIds.slice(0, maxCommunities)
    : rotateCommunityJobTickIds(
      selectScheduledCommunityJobPollIds(activeCommunities, maxCommunities, startedAt),
      startedAt,
    )
  const communities: CommunityJobCommunityProcessingSummary[] = []
  const sweepStartedAt = now()
  const sweep = await sweepStaleRunningCommunityJobs({
    env: input.env,
    communityRepository: input.communityRepository,
    // Keep all per-tick database work within maxCommunities. Sweeping every
    // active community here made a bounded polling tick perform unbounded I/O.
    communityIds,
    deadlineAtMs,
    nowMs: now,
  })
  const sweepFinishedAt = now()
  const failedCommunities = sweep.failures
  const sweptCommunities = sweep.sweptCommunityIds.length
  const deferredSweepCommunities = communityIds.length - sweptCommunities
  const processStartedAt = sweepFinishedAt
  if (deferredSweepCommunities > 0) {
    console.warn("[community-job] stale sweep deadline reached", JSON.stringify({
      swept_communities: sweptCommunities,
      deferred_sweep_communities: deferredSweepCommunities,
      deadline_ms: deadlineMs,
      sweep_ms: Math.max(0, sweepFinishedAt - sweepStartedAt),
    }))
  }

  let startedCommunities = 0
  for (const communityId of sweep.sweptCommunityIds) {
    // The batch deadline stops this tick from starting more communities; it never
    // interrupts work already in flight. If the stale sweep consumed the budget,
    // start no job work so the outer scheduler can move on to reward monitors.
    if (deadlineAtMs != null && now() >= deadlineAtMs) {
      console.warn("[community-job] tick deadline reached", JSON.stringify({
        swept_communities: sweptCommunities,
        deferred_sweep_communities: deferredSweepCommunities,
        started_communities: startedCommunities,
        deferred_communities: communityIds.length - startedCommunities,
        deadline_ms: deadlineMs,
      }))
      break
    }
    startedCommunities += 1
    let processed: CommunityJobCommunityProcessingSummary
    try {
      processed = await processCommunityJobsForCommunity({
        env: input.env,
        communityId,
        communityRepository: input.communityRepository,
        maxJobs: input.maxJobsPerCommunity ?? 25,
        skipJobTypes: input.skipJobTypes,
        deadlineAtMs,
        now,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failedCommunities.push({ community_id: communityId, error: message })
      logPipelineError("[community-job] failed to process community", {
        community_id: communityId,
        error: message,
      })
      continue
    }
    if (processed.processed_jobs > 0) {
      communities.push(processed)
    }
  }
  const processFinishedAt = now()

  return {
    processed_jobs: communities.reduce((sum, community) => sum + community.processed_jobs, 0),
    communities,
    failed_communities: failedCommunities,
    swept_communities: sweptCommunities,
    deferred_sweep_communities: deferredSweepCommunities,
    started_communities: startedCommunities,
    deferred_communities: communityIds.length - startedCommunities,
    sweep_ms: Math.max(0, sweepFinishedAt - sweepStartedAt),
    process_ms: Math.max(0, processFinishedAt - processStartedAt),
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
