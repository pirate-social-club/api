import type { Env } from "../../../env"
import type { DbExecutor } from "../../db-helpers"
import { logPipelineError, sanitizeLogText, summarizeReference } from "../../observability/pipeline-log"
import {
  markCommunityJobFailed,
  type CommunityJobRow,
} from "./store"
import {
  COMMUNITY_JOB_MAX_ATTEMPTS,
  COMMUNITY_JOB_RETRY_BASE_MS,
  COMMUNITY_JOB_RETRY_MAX_MS,
} from "./runner-types"

function computeRetryDelayMs(attemptCount: number): number {
  const exponent = Math.max(0, attemptCount - 1)
  return Math.min(COMMUNITY_JOB_RETRY_BASE_MS * (2 ** exponent), COMMUNITY_JOB_RETRY_MAX_MS)
}

function computeNextRetryAt(now: string, attemptCount: number): string {
  return new Date(Date.parse(now) + computeRetryDelayMs(attemptCount)).toISOString()
}

export async function recordCommunityJobFailure(input: {
  client: DbExecutor
  env: Env
  job: CommunityJobRow
  error: unknown
  failedAt: string
  timings?: {
    attempt_duration_ms: number
    pickup_latency_ms: number | null
    job_age_at_attempt_start_ms: number | null
  }
}): Promise<CommunityJobRow | null> {
  const message = input.error instanceof Error ? input.error.message : String(input.error)
  // Attempt N has already been counted by markCommunityJobRunning, so this is the
  // terminal attempt when it has reached the cap: no further retry is scheduled
  // and the subject is abandoned in place, silently, unless someone is told.
  const exhausted = input.job.attempt_count >= COMMUNITY_JOB_MAX_ATTEMPTS
  logPipelineError(exhausted ? "[community-job] exhausted" : "[community-job] failed", {
    job_id: input.job.job_id,
    job_type: input.job.job_type,
    community_id: input.job.community_id,
    ...summarizeReference("subject_id", input.job.subject_id),
    attempt_count: input.job.attempt_count,
    max_attempts: COMMUNITY_JOB_MAX_ATTEMPTS,
    terminal: exhausted,
    ...(input.timings ?? {}),
    error: sanitizeLogText(message),
  })
  // NOTE: no alert is delivered from here. This runs once per failed attempt
  // inside the drain, so alerting per call would page on ordinary retry noise.
  // Exhaustion is aggregated into the tick summary and alerted once per tick by
  // the scheduled caller instead.
  return await markCommunityJobFailed({
    client: input.client,
    jobId: input.job.job_id,
    // A NULL attempt id can only come from a job claimed by the pre-lease runtime.
    // The sentinel deliberately cannot match: leave that transition to the legacy
    // sweep instead of allowing an unfenced failure write during the deploy window.
    attemptId: input.job.attempt_id ?? "missing_attempt_id",
    errorCode: message || "community_job_failed",
    availableAt: input.job.attempt_count >= COMMUNITY_JOB_MAX_ATTEMPTS
      ? null
      : computeNextRetryAt(input.failedAt, input.job.attempt_count),
    now: input.failedAt,
  })
}
