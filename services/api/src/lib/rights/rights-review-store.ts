import type { DbExecutor } from "../db-helpers"
import { executeFirst } from "../db-helpers"
import { requiredString, rowValue, stringOrNull } from "../sql-row"
import type {
  MediaAnalysisResult,
  RightsReviewCase,
  RightsReviewCaseListItem,
  RightsReviewCaseStatus,
  RightsReviewResolution,
} from "./rights-review-types"

function parseJson(value: unknown): unknown | null {
  const text = stringOrNull(value)
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function serializeMediaAnalysisResult(row: unknown, prefix = ""): MediaAnalysisResult {
  return {
    media_analysis_result_id: requiredString(row, `${prefix}media_analysis_result_id`),
    community_id: requiredString(row, `${prefix}community_id`),
    source_post_id: stringOrNull(rowValue(row, `${prefix}source_post_id`)),
    source_asset_id: stringOrNull(rowValue(row, `${prefix}source_asset_id`)),
    outcome: requiredString(row, `${prefix}outcome`) as MediaAnalysisResult["outcome"],
    content_safety_state: requiredString(row, `${prefix}content_safety_state`) as MediaAnalysisResult["content_safety_state"],
    age_gate_policy: requiredString(row, `${prefix}age_gate_policy`) as MediaAnalysisResult["age_gate_policy"],
    trigger_sources: parseJson(rowValue(row, `${prefix}trigger_sources_json`)),
    acrcloud_music_match: parseJson(rowValue(row, `${prefix}acrcloud_music_match_json`)),
    acrcloud_custom_match: parseJson(rowValue(row, `${prefix}acrcloud_custom_match_json`)),
    acrcloud_error_code: stringOrNull(rowValue(row, `${prefix}acrcloud_error_code`)),
    acrcloud_error_message: stringOrNull(rowValue(row, `${prefix}acrcloud_error_message`)),
    acrcloud_checked_at: stringOrNull(rowValue(row, `${prefix}acrcloud_checked_at`)),
    safety_signals: parseJson(rowValue(row, `${prefix}safety_signals_json`)),
    authenticity_signals: parseJson(rowValue(row, `${prefix}authenticity_signals_json`)),
    policy_reason_code: stringOrNull(rowValue(row, `${prefix}policy_reason_code`)),
    policy_reason: stringOrNull(rowValue(row, `${prefix}policy_reason`)),
    resolved_at: stringOrNull(rowValue(row, `${prefix}resolved_at`)),
    created_at: requiredString(row, `${prefix}created_at`),
    updated_at: requiredString(row, `${prefix}updated_at`),
  }
}

function serializeRightsReviewCase(row: unknown, prefix = ""): RightsReviewCase {
  return {
    rights_review_case_id: requiredString(row, `${prefix}rights_review_case_id`),
    subject_type: requiredString(row, `${prefix}subject_type`) as RightsReviewCase["subject_type"],
    subject_id: requiredString(row, `${prefix}subject_id`),
    community_id: requiredString(row, `${prefix}community_id`),
    status: requiredString(row, `${prefix}status`) as RightsReviewCase["status"],
    trigger_source: requiredString(row, `${prefix}trigger_source`) as RightsReviewCase["trigger_source"],
    analysis_result_ref: stringOrNull(rowValue(row, `${prefix}analysis_result_ref`)),
    submitted_evidence_refs: parseJson(rowValue(row, `${prefix}submitted_evidence_refs_json`)),
    resolution: stringOrNull(rowValue(row, `${prefix}resolution`)) as RightsReviewCase["resolution"],
    resolver_user_id: stringOrNull(rowValue(row, `${prefix}resolver_user_id`)),
    created_at: requiredString(row, `${prefix}created_at`),
    updated_at: requiredString(row, `${prefix}updated_at`),
    resolved_at: stringOrNull(rowValue(row, `${prefix}resolved_at`)),
  }
}

function serializeRightsReviewCaseListItem(row: unknown): RightsReviewCaseListItem {
  const caseRow = serializeRightsReviewCase(row, "rrc_")
  const mediaAnalysisResultId = stringOrNull(rowValue(row, "mar_media_analysis_result_id"))
  const postId = stringOrNull(rowValue(row, "post_post_id"))
  return {
    ...caseRow,
    analysis: mediaAnalysisResultId ? serializeMediaAnalysisResult(row, "mar_") : null,
    post: postId
      ? {
          post_id: postId,
          post_type: requiredString(row, "post_type"),
          status: requiredString(row, "post_status"),
          title: stringOrNull(rowValue(row, "post_title")),
          body: stringOrNull(rowValue(row, "post_body")),
          caption: stringOrNull(rowValue(row, "post_caption")),
          media_refs_json: stringOrNull(rowValue(row, "media_refs_json")),
          author_handle: stringOrNull(rowValue(row, "author_handle")),
        }
      : null,
  }
}

const RIGHTS_REVIEW_CASE_COLUMNS = `
  rights_review_case_id, subject_type, subject_id, community_id, status, trigger_source,
  analysis_result_ref, submitted_evidence_refs_json, resolution, resolver_user_id,
  created_at, updated_at, resolved_at
`

const MEDIA_ANALYSIS_COLUMNS = `
  media_analysis_result_id, community_id, source_post_id, source_asset_id,
  outcome, content_safety_state, age_gate_policy, trigger_sources_json,
  acrcloud_music_match_json, acrcloud_custom_match_json,
  acrcloud_error_code, acrcloud_error_message, acrcloud_checked_at,
  safety_signals_json, authenticity_signals_json,
  policy_reason_code, policy_reason, resolved_at, created_at, updated_at
`

export async function listRightsReviewCases(input: {
  executor: DbExecutor
  communityId: string
  statuses: RightsReviewCaseStatus[]
  limit: number
}): Promise<RightsReviewCaseListItem[]> {
  const statuses = input.statuses.length ? input.statuses : ["open", "under_review"]
  const placeholders = statuses.map((_, index) => `?${index + 2}`).join(", ")
  const result = await input.executor.execute({
    sql: `
      SELECT
        rrc.rights_review_case_id as rrc_rights_review_case_id,
        rrc.subject_type as rrc_subject_type,
        rrc.subject_id as rrc_subject_id,
        rrc.community_id as rrc_community_id,
        rrc.status as rrc_status,
        rrc.trigger_source as rrc_trigger_source,
        rrc.analysis_result_ref as rrc_analysis_result_ref,
        rrc.submitted_evidence_refs_json as rrc_submitted_evidence_refs_json,
        rrc.resolution as rrc_resolution,
        rrc.resolver_user_id as rrc_resolver_user_id,
        rrc.created_at as rrc_created_at,
        rrc.updated_at as rrc_updated_at,
        rrc.resolved_at as rrc_resolved_at,
        mar.media_analysis_result_id as mar_media_analysis_result_id,
        mar.community_id as mar_community_id,
        mar.source_post_id as mar_source_post_id,
        mar.source_asset_id as mar_source_asset_id,
        mar.outcome as mar_outcome,
        mar.content_safety_state as mar_content_safety_state,
        mar.age_gate_policy as mar_age_gate_policy,
        mar.trigger_sources_json as mar_trigger_sources_json,
        mar.acrcloud_music_match_json as mar_acrcloud_music_match_json,
        mar.acrcloud_custom_match_json as mar_acrcloud_custom_match_json,
        mar.acrcloud_error_code as mar_acrcloud_error_code,
        mar.acrcloud_error_message as mar_acrcloud_error_message,
        mar.acrcloud_checked_at as mar_acrcloud_checked_at,
        mar.safety_signals_json as mar_safety_signals_json,
        mar.authenticity_signals_json as mar_authenticity_signals_json,
        mar.policy_reason_code as mar_policy_reason_code,
        mar.policy_reason as mar_policy_reason,
        mar.resolved_at as mar_resolved_at,
        mar.created_at as mar_created_at,
        mar.updated_at as mar_updated_at,
        p.post_id as post_post_id,
        p.post_type,
        p.status as post_status,
        p.title as post_title,
        p.body as post_body,
        p.caption as post_caption,
        p.media_refs_json,
        NULL as author_handle
      FROM rights_review_cases rrc
      LEFT JOIN media_analysis_results mar ON mar.media_analysis_result_id = rrc.analysis_result_ref
      LEFT JOIN posts p ON p.post_id = CASE
        WHEN rrc.subject_type = 'post' THEN rrc.subject_id
        ELSE mar.source_post_id
      END
      WHERE rrc.community_id = ?1
        AND rrc.status IN (${placeholders})
      ORDER BY rrc.updated_at DESC, rrc.rights_review_case_id DESC
      LIMIT ?${statuses.length + 2}
    `,
    args: [input.communityId, ...statuses, input.limit],
  })
  return result.rows.map((row) => serializeRightsReviewCaseListItem(row))
}

export async function getRightsReviewCaseById(input: {
  executor: DbExecutor
  rightsReviewCaseId: string
}): Promise<RightsReviewCase | null> {
  const row = await executeFirst(input.executor, {
    sql: `
      SELECT ${RIGHTS_REVIEW_CASE_COLUMNS}
      FROM rights_review_cases
      WHERE rights_review_case_id = ?1
      LIMIT 1
    `,
    args: [input.rightsReviewCaseId],
  })
  return row ? serializeRightsReviewCase(row) : null
}

export async function getMediaAnalysisResultById(input: {
  executor: DbExecutor
  mediaAnalysisResultId: string
}): Promise<MediaAnalysisResult | null> {
  const row = await executeFirst(input.executor, {
    sql: `
      SELECT ${MEDIA_ANALYSIS_COLUMNS}
      FROM media_analysis_results
      WHERE media_analysis_result_id = ?1
      LIMIT 1
    `,
    args: [input.mediaAnalysisResultId],
  })
  return row ? serializeMediaAnalysisResult(row) : null
}

export async function updateRightsReviewCaseAction(input: {
  executor: DbExecutor
  rightsReviewCaseId: string
  status: RightsReviewCaseStatus
  resolution: RightsReviewResolution | null
  resolverUserId: string | null
  evidenceRefs: string[] | null
  resolvedAt: string | null
  now: string
}): Promise<void> {
  await input.executor.execute({
    sql: `
      UPDATE rights_review_cases
      SET status = ?2,
          resolution = ?3,
          resolver_user_id = ?4,
          submitted_evidence_refs_json = COALESCE(?5, submitted_evidence_refs_json),
          resolved_at = ?6,
          updated_at = ?7
      WHERE rights_review_case_id = ?1
    `,
    args: [
      input.rightsReviewCaseId,
      input.status,
      input.resolution,
      input.resolverUserId,
      input.evidenceRefs ? JSON.stringify(input.evidenceRefs) : null,
      input.resolvedAt,
      input.now,
    ],
  })
}
