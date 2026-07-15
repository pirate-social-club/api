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
}): Promise<CommunityJobRow | null> {
  const message = input.error instanceof Error ? input.error.message : String(input.error)
  logPipelineError("[community-job] failed", {
    job_id: input.job.job_id,
    job_type: input.job.job_type,
    community_id: input.job.community_id,
    ...summarizeReference("subject_id", input.job.subject_id),
    attempt_count: input.job.attempt_count,
    error: sanitizeLogText(message),
  })
  return await markCommunityJobFailed({
    client: input.client,
    jobId: input.job.job_id,
    attemptId: input.job.attempt_id ?? "missing_attempt_id",
    errorCode: message || "community_job_failed",
    availableAt: input.job.attempt_count >= COMMUNITY_JOB_MAX_ATTEMPTS
      ? null
      : computeNextRetryAt(input.failedAt, input.job.attempt_count),
    now: input.failedAt,
  })
}
