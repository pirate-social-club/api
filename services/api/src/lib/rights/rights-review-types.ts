import type { Post } from "../../types"

export type RightsReviewCaseStatus = "open" | "under_review" | "resolved" | "blocked"
export type RightsReviewSubjectType = "asset" | "post" | "live_room" | "replay_asset"
export type RightsReviewTriggerSource =
  | "acrcloud_match"
  | "declared_reference_mismatch"
  | "manual_report"
  | "operator_escalation"
export type RightsReviewResolution = "clear" | "clear_with_upstream_refs" | "block" | "needs_more_evidence"
export type RightsReviewActionType = "start_review" | RightsReviewResolution

export type MediaAnalysisResult = {
  media_analysis_result_id: string
  community_id: string
  source_post_id: string | null
  source_asset_id: string | null
  outcome: "allow" | "allow_with_required_reference" | "review_required" | "blocked"
  content_safety_state: "pending" | "safe" | "sensitive" | "adult"
  age_gate_policy: "none" | "18_plus"
  trigger_sources: unknown | null
  acrcloud_music_match: unknown | null
  acrcloud_custom_match: unknown | null
  acrcloud_error_code: string | null
  acrcloud_error_message: string | null
  acrcloud_checked_at: string | null
  safety_signals: unknown | null
  authenticity_signals: unknown | null
  policy_reason_code: string | null
  policy_reason: string | null
  resolved_at: string | null
  created_at: string
  updated_at: string
}

export type RightsReviewCase = {
  rights_review_case_id: string
  subject_type: RightsReviewSubjectType
  subject_id: string
  community_id: string
  status: RightsReviewCaseStatus
  trigger_source: RightsReviewTriggerSource
  analysis_result_ref: string | null
  submitted_evidence_refs: unknown | null
  resolution: RightsReviewResolution | null
  resolver_user_id: string | null
  created_at: string
  updated_at: string
  resolved_at: string | null
}

export type RightsReviewCaseListItem = RightsReviewCase & {
  analysis: MediaAnalysisResult | null
  post: {
    post_id: string
    post_type: string
    status: string
    title: string | null
    body: string | null
    caption: string | null
    media_refs_json: string | null
    author_handle: string | null
  } | null
}

export type RightsReviewCaseListResponse = {
  items: RightsReviewCaseListItem[]
  next_cursor: string | null
}

export type RightsReviewCaseDetail = {
  case: RightsReviewCase
  analysis: MediaAnalysisResult | null
  post: Post | null
}

export type CreateRightsReviewActionRequest = {
  action_type?: RightsReviewActionType
  evidence_refs?: string[] | null
}
