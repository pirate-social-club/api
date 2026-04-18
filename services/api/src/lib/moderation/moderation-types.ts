import type {
  CreateModerationActionRequest as ApiCreateModerationActionRequest,
  CreateUserReportRequest as ApiCreateUserReportRequest,
  ModerationAction as ApiModerationAction,
  ModerationCase as ApiModerationCase,
  ModerationCaseDetail as ApiModerationCaseDetail,
  ModerationCaseListResponse as ApiModerationCaseListResponse,
  ModerationSignal as ApiModerationSignal,
  UserReport as ApiUserReport,
} from "../../types"

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
export type UserReport = ApiUserReport
export type ModerationSignal = ApiModerationSignal
export type ModerationAction = ApiModerationAction
export type ModerationCase = ApiModerationCase
export type ModerationCaseListResponse = ApiModerationCaseListResponse
export type ModerationCaseDetail = ApiModerationCaseDetail
export type CreateModerationActionRequest = ApiCreateModerationActionRequest
