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
}): Promise<CommunityJobRow | null> {
  const row = await executeFirst(input.client, {
    sql: `
      SELECT ${COMMUNITY_JOB_SELECT_COLUMNS}
      FROM community_jobs
      WHERE status IN ('queued', 'failed')
        AND (?1 IS NULL OR community_id = ?1)
        AND (available_at IS NULL OR available_at <= ?2)
        AND (?3 IS NULL OR attempt_count < ?3)
      ORDER BY created_at ASC, job_id ASC
      LIMIT 1
    `,
    args: [input.communityId ?? null, input.now, input.maxAttempts ?? null],
  })

  return row ? toCommunityJobRow(row) : null
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
}): Promise<CommunityJobRow> {
  const existing = await findLatestCommunityJobBySubjectAndType({
    client: input.client,
    jobType: input.jobType,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
  })

  if (existing && (existing.status === "queued" || existing.status === "running")) {
    return existing
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

  const created = await executeFirst(input.client, {
    sql: `
      SELECT ${COMMUNITY_JOB_SELECT_COLUMNS}
      FROM community_jobs
      WHERE job_id = ?1
      LIMIT 1
    `,
    args: [jobId],
  })

  if (!created) {
    throw new Error("Community job is missing after enqueue")
  }

  return toCommunityJobRow(created)
}

export async function markCommunityJobRunning(input: {
  client: DbExecutor
  jobId: string
  now: string
}): Promise<CommunityJobRow | null> {
  await input.client.execute({
    sql: `
      UPDATE community_jobs
      SET status = 'running',
          attempt_count = attempt_count + 1,
          error_code = NULL,
          updated_at = ?2
      WHERE job_id = ?1
        AND status IN ('queued', 'failed')
    `,
    args: [input.jobId, input.now],
  })

  return getCommunityJobById({
    client: input.client,
    jobId: input.jobId,
  })
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
