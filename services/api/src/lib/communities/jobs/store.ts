import type { DbExecutor } from "../../db-helpers"
import { executeFirst } from "../../db-helpers"
import { makeId } from "../../helpers"
import { requiredNumber, requiredString, rowValue, stringOrNull } from "../../sql-row"

export type CommunityJobType =
  | "comment_projection_sync"
  | "post_projection_sync"
  | "comment_body_mirror"
  | "thread_snapshot_publish"
  | "embed_hydrate"
  | "link_preview_fetch"
  | "post_label_materialize"
  | "post_translation_materialize"
  | "comment_translation_materialize"
  | "community_text_translation_materialize"
  | "link_summary_materialize"
  | "link_summary_translation_materialize"
  | "song_preview_generate"
  | "locked_asset_delivery_prepare"
  | "song_artifact_session_reaper"
  | "live_room_recording_ingest"
  | "live_room_viewer_sessions_prune"
export type CommunityJobStatus = "queued" | "running" | "succeeded" | "failed"

export type CommunityJobRow = {
  job_id: string
  community_id: string
  job_type: CommunityJobType
  subject_type: string
  subject_id: string
  status: CommunityJobStatus
  payload_json: string | null
  result_ref: string | null
  error_code: string | null
  attempt_count: number
  available_at: string | null
  created_at: string
  updated_at: string
}

const COMMUNITY_JOB_SELECT_COLUMNS = `
  job_id, community_id, job_type, subject_type, subject_id, status, payload_json, result_ref,
  error_code, attempt_count, available_at, created_at, updated_at
`

function toCommunityJobRow(row: unknown): CommunityJobRow {
  return {
    job_id: requiredString(row, "job_id"),
    community_id: requiredString(row, "community_id"),
    job_type: requiredString(row, "job_type") as CommunityJobType,
    subject_type: requiredString(row, "subject_type"),
    subject_id: requiredString(row, "subject_id"),
    status: requiredString(row, "status") as CommunityJobStatus,
    payload_json: stringOrNull(rowValue(row, "payload_json")),
    result_ref: stringOrNull(rowValue(row, "result_ref")),
    error_code: stringOrNull(rowValue(row, "error_code")),
    attempt_count: requiredNumber(row, "attempt_count"),
    available_at: stringOrNull(rowValue(row, "available_at")),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

export async function getCommunityJobById(input: {
  client: DbExecutor
  jobId: string
}): Promise<CommunityJobRow | null> {
  const row = await executeFirst(input.client, {
    sql: `
      SELECT ${COMMUNITY_JOB_SELECT_COLUMNS}
      FROM community_jobs
      WHERE job_id = ?1
      LIMIT 1
    `,
    args: [input.jobId],
  })

  return row ? toCommunityJobRow(row) : null
}

export async function findLatestCommunityJobBySubjectAndType(input: {
  client: DbExecutor
  jobType: CommunityJobType
  subjectType: string
  subjectId: string
}): Promise<CommunityJobRow | null> {
  const row = await executeFirst(input.client, {
    sql: `
      SELECT ${COMMUNITY_JOB_SELECT_COLUMNS}
      FROM community_jobs
      WHERE job_type = ?1
        AND subject_type = ?2
        AND subject_id = ?3
      ORDER BY created_at DESC, job_id DESC
      LIMIT 1
    `,
    args: [input.jobType, input.subjectType, input.subjectId],
  })

  return row ? toCommunityJobRow(row) : null
}

export async function findNextRunnableCommunityJob(input: {
  client: DbExecutor
  now: string
  communityId?: string | null
  maxAttempts?: number
  skipJobTypes?: CommunityJobType[] | null
}): Promise<CommunityJobRow | null> {
  const skipJobTypes = [...new Set(input.skipJobTypes ?? [])]
  const skipJobTypePlaceholders = skipJobTypes.map((_, index) => `?${index + 4}`).join(", ")
  const row = await executeFirst(input.client, {
    sql: `
      SELECT ${COMMUNITY_JOB_SELECT_COLUMNS}
      FROM community_jobs
      WHERE status IN ('queued', 'failed')
        AND (?1 IS NULL OR community_id = ?1)
        AND (available_at IS NULL OR available_at <= ?2)
        AND (?3 IS NULL OR attempt_count < ?3)
        ${skipJobTypes.length > 0 ? `AND job_type NOT IN (${skipJobTypePlaceholders})` : ""}
      ORDER BY created_at ASC, job_id ASC
      LIMIT 1
    `,
    args: [input.communityId ?? null, input.now, input.maxAttempts ?? null, ...skipJobTypes],
  })

  return row ? toCommunityJobRow(row) : null
}

export async function resetStaleRunningCommunityJobs(input: {
  client: DbExecutor
  now: string
  staleBefore: string
  communityId?: string | null
}): Promise<number> {
  const result = await input.client.execute({
    sql: `
      UPDATE community_jobs
      SET status = 'failed',
          error_code = 'stale_running_timeout',
          available_at = ?2,
          updated_at = ?2
      WHERE status = 'running'
        AND updated_at <= ?1
        AND (?3 IS NULL OR community_id = ?3)
    `,
    args: [input.staleBefore, input.now, input.communityId ?? null],
  })

  return result.rowsAffected ?? 0
}

export async function enqueueCommunityJob(input: {
  client: DbExecutor
  communityId: string
  jobType: CommunityJobType
  subjectType: string
  subjectId: string
  payloadJson?: string | null
  availableAt?: string | null
  createdAt: string
  // Set false when enqueuing INSIDE a transaction("write"): the dedup lookup below is a
  // SELECT, which cannot run in the routed D1 write client's buffered batch (the shard
  // write guard rejects reads). Callers inside a write tx accept that a fresh subject's
  // job is enqueued without the dedup optimization (jobs are idempotent on the runner).
  dedupe?: boolean
}): Promise<CommunityJobRow> {
  if (input.dedupe !== false) {
    const existing = await findLatestCommunityJobBySubjectAndType({
      client: input.client,
      jobType: input.jobType,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
    })

    if (existing && (existing.status === "queued" || existing.status === "running")) {
      return existing
    }
  }

  const jobId = makeId("cjb")
  await input.client.execute({
    sql: `
      INSERT INTO community_jobs (
        job_id, community_id, job_type, subject_type, subject_id, status, payload_json,
        result_ref, error_code, attempt_count, available_at, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, 'queued', ?6,
        NULL, NULL, 0, ?7, ?8, ?8
      )
    `,
    args: [
      jobId,
      input.communityId,
      input.jobType,
      input.subjectType,
      input.subjectId,
      input.payloadJson ?? null,
      input.availableAt ?? null,
      input.createdAt,
    ],
  })

  // Deterministic return: the inserted row is fully known here, so construct it directly
  // instead of reading it back. A SELECT-after-INSERT would cross the routed write client's
  // separate write-RPC / read-RPC boundary, which is NOT read-after-write consistent on D1
  // (the readback can miss the just-written row). Mirrors the INSERT column values above.
  return {
    job_id: jobId,
    community_id: input.communityId,
    job_type: input.jobType,
    subject_type: input.subjectType,
    subject_id: input.subjectId,
    status: "queued" as CommunityJobStatus,
    payload_json: input.payloadJson ?? null,
    result_ref: null,
    error_code: null,
    attempt_count: 0,
    available_at: input.availableAt ?? null,
    created_at: input.createdAt,
    updated_at: input.createdAt,
  }
}

export async function markCommunityJobRunning(input: {
  client: DbExecutor
  jobId: string
  now: string
}): Promise<CommunityJobRow | null> {
  const row = await executeFirst(input.client, {
    sql: `
      UPDATE community_jobs
      SET status = 'running',
          attempt_count = attempt_count + 1,
          error_code = NULL,
          updated_at = ?2
      WHERE job_id = ?1
        AND status IN ('queued', 'failed')
      RETURNING ${COMMUNITY_JOB_SELECT_COLUMNS}
    `,
    args: [input.jobId, input.now],
  })

  return row ? toCommunityJobRow(row) : null
}

export async function markCommunityJobSucceeded(input: {
  client: DbExecutor
  jobId: string
  resultRef?: string | null
  now: string
}): Promise<CommunityJobRow | null> {
  await input.client.execute({
    sql: `
      UPDATE community_jobs
      SET status = 'succeeded',
          result_ref = ?2,
          error_code = NULL,
          available_at = NULL,
          updated_at = ?3
      WHERE job_id = ?1
    `,
    args: [input.jobId, input.resultRef ?? null, input.now],
  })

  return getCommunityJobById({
    client: input.client,
    jobId: input.jobId,
  })
}

export async function markCommunityJobFailed(input: {
  client: DbExecutor
  jobId: string
  errorCode: string
  availableAt?: string | null
  now: string
}): Promise<CommunityJobRow | null> {
  await input.client.execute({
    sql: `
      UPDATE community_jobs
      SET status = 'failed',
          error_code = ?2,
          available_at = ?3,
          updated_at = ?4
      WHERE job_id = ?1
    `,
    args: [input.jobId, input.errorCode, input.availableAt ?? null, input.now],
  })

  return getCommunityJobById({
    client: input.client,
    jobId: input.jobId,
  })
}
