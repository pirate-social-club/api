import { executeFirst } from "../db-helpers"
import type { InStatement, ReadClient } from "../sql-client"

export type StudyAttemptResponseSnapshot<T> = {
  commitToken: string
  httpStatus: number
  materializationContext: { completed_at: string; study_timezone: string | null } | null
  requestFingerprint: string
  responseStatus: "pending" | "final"
  response: T
  resultKind: "graded" | "ungradable" | "revision_conflict"
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null
}

/**
 * Stable equivalence input for idempotency. session_revision is deliberately
 * included: reusing a key for a semantically different request is a conflict,
 * while an exact old request still replays before revision validation.
 */
export function studyAttemptRequestFingerprint(input: {
  attemptNumber: number
  exerciseId: string
  selectedOptionId: string | null
  sessionId: string
  sessionRevision: number | null
  transcript: string | null
  transcriptionLanguageCode: string | null
  transcriptionLanguageProbability: number | null
  type: string
}): string {
  return JSON.stringify({
    attempt_number: input.attemptNumber,
    exercise_id: input.exerciseId,
    selected_option_id: input.selectedOptionId,
    session_id: input.sessionId,
    session_revision: input.sessionRevision,
    transcript: input.transcript,
    transcription_language_code: input.transcriptionLanguageCode,
    transcription_language_probability: input.transcriptionLanguageProbability,
    type: input.type,
  })
}

export async function getStudyAttemptResponseSnapshot<T>(input: {
  client: ReadClient
  idempotencyKey: string
  userId: string
}): Promise<StudyAttemptResponseSnapshot<T> | null> {
  const row = await executeFirst(input.client, {
    sql: `
      SELECT request_fingerprint, response_json, result_kind, http_status, commit_token,
             response_status, materialization_context_json
      FROM song_study_attempt_response
      WHERE user_id = ?1 AND idempotency_key = ?2
      LIMIT 1
    `,
    args: [input.userId, input.idempotencyKey],
  }) as Record<string, unknown> | null
  const responseJson = readString(row?.response_json)
  const requestFingerprint = readString(row?.request_fingerprint)
  const resultKind = readString(row?.result_kind)
  const responseStatus = readString(row?.response_status)
  const materializationContextJson = readString(row?.materialization_context_json)
  if (!responseJson || !requestFingerprint
    || (responseStatus !== "pending" && responseStatus !== "final")
    || (resultKind !== "graded" && resultKind !== "ungradable" && resultKind !== "revision_conflict")) {
    return null
  }
  return {
    commitToken: readString(row?.commit_token) ?? "",
    httpStatus: Number(row?.http_status ?? 200),
    materializationContext: materializationContextJson
      ? JSON.parse(materializationContextJson) as StudyAttemptResponseSnapshot<T>["materializationContext"]
      : null,
    requestFingerprint,
    response: JSON.parse(responseJson) as T,
    responseStatus,
    resultKind,
  }
}

export function buildStudyResponseSnapshotCasStatement<T>(input: {
  commitToken: string
  exerciseId: string
  expectedRevision: number
  httpStatus?: number
  idempotencyKey: string
  materializationContext?: StudyAttemptResponseSnapshot<T>["materializationContext"]
  now: string
  requestFingerprint: string
  response: T
  responseStatus?: "pending" | "final"
  resultKind: StudyAttemptResponseSnapshot<T>["resultKind"]
  sessionId: string
  userId: string
}): InStatement {
  return {
    sql: `
      INSERT INTO song_study_attempt_response (
        user_id, idempotency_key, session_id, exercise_id,
        request_fingerprint, commit_token, response_json, response_status,
        materialization_context_json, http_status, result_kind, created_at
      )
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12
      FROM song_study_session s
      WHERE s.id = ?3 AND s.session_revision = ?13
        AND NOT EXISTS (
          SELECT 1 FROM song_study_attempt_response existing
          WHERE existing.user_id = ?1 AND existing.idempotency_key = ?2
        )
    `,
    args: [
      input.userId,
      input.idempotencyKey,
      input.sessionId,
      input.exerciseId,
      input.requestFingerprint,
      input.commitToken,
      JSON.stringify(input.response),
      input.responseStatus ?? "final",
      input.materializationContext ? JSON.stringify(input.materializationContext) : null,
      input.httpStatus ?? 200,
      input.resultKind,
      input.now,
      input.expectedRevision,
    ],
  }
}

export async function hasUngradableReceipt(input: {
  appearanceOrdinal: number
  client: ReadClient
  exerciseId: string
  sessionId: string
}): Promise<boolean> {
  const row = await executeFirst(input.client, {
    sql: `
      SELECT 1 AS present FROM song_study_ungradable_receipt
      WHERE session_id = ?1 AND exercise_id = ?2 AND appearance_ordinal = ?3
      LIMIT 1
    `,
    args: [input.sessionId, input.exerciseId, input.appearanceOrdinal],
  })
  return Boolean(row)
}

export async function recordOwnedUngradableReceipt(input: {
  appearanceOrdinal: number
  client: ReadClient
  commitToken: string
  exerciseId: string
  idempotencyKey: string
  now: string
  sessionId: string
  userId: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      INSERT INTO song_study_ungradable_receipt (
        session_id, exercise_id, appearance_ordinal,
        user_id, idempotency_key, created_at
      )
      SELECT ?1, ?2, ?3, ?4, ?5, ?6
      WHERE EXISTS (
        SELECT 1 FROM song_study_attempt_response r
        WHERE r.user_id = ?4 AND r.idempotency_key = ?5 AND r.commit_token = ?7
      )
    `,
    args: [
      input.sessionId,
      input.exerciseId,
      input.appearanceOrdinal,
      input.userId,
      input.idempotencyKey,
      input.now,
      input.commitToken,
    ],
  })
}

export async function finalizeStudyAttemptResponseSnapshot<T>(input: {
  client: ReadClient
  idempotencyKey: string
  response: T
  userId: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      UPDATE song_study_attempt_response
      SET response_json = ?3, response_status = 'final'
      WHERE user_id = ?1 AND idempotency_key = ?2 AND response_status = 'pending'
    `,
    args: [input.userId, input.idempotencyKey, JSON.stringify(input.response)],
  })
}
