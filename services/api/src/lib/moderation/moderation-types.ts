import type {
  CreateModerationActionRequest as ApiCreateModerationActionRequest,
  CreateUserReportRequest as ApiCreateUserReportRequest,
} from "../../types"
import type { Comment, Post } from "../../types"

export type ModerationSignalSeverity = "low" | "medium" | "high"
export type ModerationCaseStatus = "open" | "resolved"
export type ModerationQueueScope = "community" | "platform"
export type ModerationCaseOpenedBy = "platform_analysis" | "user_report" | "mixed"
export type UserReportReasonCode =
  | "spam"
  | "harassment"
  | "hate"
  | "sexual_content"
  | "graphic_content"
  | "misleading"
  | "other"
export type ModerationActionType = "dismiss" | "hide" | "remove" | "restore" | "age_gate"

export type CreateUserReportRequest = ApiCreateUserReportRequest
export type CreateModerationActionRequest = ApiCreateModerationActionRequest

export type UserReport = {
  user_report_id: string
  community_id: string
  post_id: string | null
  comment_id: string | null
  reporter_user_id: string
  reason_code: UserReportReasonCode
  note?: string | null
  created_at: string
}

export type ModerationSignal = {
  moderation_signal_id: string
  community_id: string
  post_id: string | null
  comment_id: string | null
  analysis_result_ref: string | null
  source: "platform_analysis"
  signal_type: string
  severity: ModerationSignalSeverity
  provider: string
  provider_label: string
  evidence_ref?: string | null
  created_at: string
}

export type ModerationAction = {
  moderation_action_id: string
  moderation_case_id: string
  community_id: string
  post_id: string | null
  comment_id: string | null
  actor_user_id: string
  action_type: ModerationActionType
  note?: string | null
  created_at: string
}

export type ModerationCase = {
  moderation_case_id: string
  community_id: string
  post_id: string | null
  comment_id: string | null
  status: ModerationCaseStatus
  queue_scope: ModerationQueueScope
  priority: ModerationSignalSeverity
  opened_by: ModerationCaseOpenedBy
  created_at: string
  updated_at: string
  resolved_at: string | null
}

export type ModerationCaseDetail = {
  case: ModerationCase
  post: Post | null
  comment: Comment | null
  signals: Array<ModerationSignal>
  reports: Array<UserReport>
  actions: Array<ModerationAction>
}

export type ModerationCaseListResponse = {
  items: Array<ModerationCase>
  next_cursor: string | null
}
