import type { DbExecutor } from "../db-helpers"
import { executeFirst } from "../db-helpers"
import { makeId } from "../helpers"
import { requiredString, rowValue, stringOrNull } from "../sql-row"
import type { RightsHold, RightsHoldType, RightsReviewSubjectType } from "./rights-review-types"

const HOLD_TYPE_SEVERITY: Record<RightsHoldType, number> = {
  reference_required: 1,
  review_hold: 2,
  blocked: 3,
}

function serializeRightsHold(row: unknown): RightsHold {
  return {
    rights_hold_id: requiredString(row, "rights_hold_id"),
    subject_type: requiredString(row, "subject_type") as RightsReviewSubjectType,
    subject_id: requiredString(row, "subject_id"),
    community_id: requiredString(row, "community_id"),
    hold_type: requiredString(row, "hold_type") as RightsHoldType,
    source_case_id: stringOrNull(rowValue(row, "source_case_id")),
    analysis_result_ref: stringOrNull(rowValue(row, "analysis_result_ref")),
    status: requiredString(row, "status") as RightsHold["status"],
    reason_code: stringOrNull(rowValue(row, "reason_code")),
    reason: stringOrNull(rowValue(row, "reason")),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
    released_at: stringOrNull(rowValue(row, "released_at")),
  }
}

export async function getActiveRightsHoldForSubject(input: {
  executor: DbExecutor
  communityId: string
  subjectType: RightsReviewSubjectType
  subjectId: string
}): Promise<RightsHold | null> {
  const row = await executeFirst(input.executor, {
    sql: `
      SELECT rights_hold_id, subject_type, subject_id, community_id, hold_type,
             source_case_id, analysis_result_ref, status, reason_code, reason,
             created_at, updated_at, released_at
      FROM rights_holds
      WHERE community_id = ?1
        AND subject_type = ?2
        AND subject_id = ?3
        AND status = 'active'
      ORDER BY updated_at DESC, rights_hold_id DESC
      LIMIT 1
    `,
    args: [input.communityId, input.subjectType, input.subjectId],
  })
  return row ? serializeRightsHold(row) : null
}

export async function getActiveRightsHoldForAsset(input: {
  executor: DbExecutor
  communityId: string
  assetId: string
  sourcePostId?: string | null
}): Promise<RightsHold | null> {
  const subjects: Array<[RightsReviewSubjectType, string]> = [["asset", input.assetId]]
  if (input.sourcePostId?.trim()) {
    subjects.push(["post", input.sourcePostId.trim()])
  }
  for (const [subjectType, subjectId] of subjects) {
    const hold = await getActiveRightsHoldForSubject({
      executor: input.executor,
      communityId: input.communityId,
      subjectType,
      subjectId,
    })
    if (hold) return hold
  }
  return null
}

export async function upsertActiveRightsHold(input: {
  executor: DbExecutor
  communityId: string
  subjectType: RightsReviewSubjectType
  subjectId: string
  holdType: RightsHoldType
  sourceCaseId?: string | null
  analysisResultRef?: string | null
  reasonCode?: string | null
  reason?: string | null
  now: string
}): Promise<void> {
  const existing = await getActiveRightsHoldForSubject({
    executor: input.executor,
    communityId: input.communityId,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
  })
  if (existing) {
    const nextHoldType = HOLD_TYPE_SEVERITY[input.holdType] >= HOLD_TYPE_SEVERITY[existing.hold_type]
      ? input.holdType
      : existing.hold_type
    await input.executor.execute({
      sql: `
        UPDATE rights_holds
        SET hold_type = ?2,
            source_case_id = COALESCE(?3, source_case_id),
            analysis_result_ref = COALESCE(?4, analysis_result_ref),
            reason_code = COALESCE(?5, reason_code),
            reason = COALESCE(?6, reason),
            updated_at = ?7
        WHERE rights_hold_id = ?1
      `,
      args: [
        existing.rights_hold_id,
        nextHoldType,
        input.sourceCaseId ?? null,
        input.analysisResultRef ?? null,
        input.reasonCode ?? null,
        input.reason ?? null,
        input.now,
      ],
    })
    return
  }
  await input.executor.execute({
    sql: `
      INSERT INTO rights_holds (
        rights_hold_id, subject_type, subject_id, community_id, hold_type,
        source_case_id, analysis_result_ref, status, reason_code, reason,
        created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'active', ?8, ?9, ?10, ?10)
    `,
    args: [
      makeId("rhold"),
      input.subjectType,
      input.subjectId,
      input.communityId,
      input.holdType,
      input.sourceCaseId ?? null,
      input.analysisResultRef ?? null,
      input.reasonCode ?? null,
      input.reason ?? null,
      input.now,
    ],
  })
}

export async function releaseActiveRightsHoldsForSubject(input: {
  executor: DbExecutor
  communityId: string
  subjectType: RightsReviewSubjectType
  subjectId: string
  now: string
}): Promise<void> {
  await input.executor.execute({
    sql: `
      UPDATE rights_holds
      SET status = 'released',
          released_at = ?4,
          updated_at = ?4
      WHERE community_id = ?1
        AND subject_type = ?2
        AND subject_id = ?3
        AND status = 'active'
        AND hold_type != 'blocked'
    `,
    args: [input.communityId, input.subjectType, input.subjectId, input.now],
  })
}
