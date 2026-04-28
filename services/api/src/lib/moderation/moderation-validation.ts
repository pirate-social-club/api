import { badRequestError } from "../errors"
import type {
  CreateModerationActionRequest,
  CreateUserReportRequest,
  ModerationSignalSeverity,
} from "./moderation-types"

export function reportPriority(reasonCode: CreateUserReportRequest["reason_code"]): ModerationSignalSeverity {
  switch (reasonCode) {
    case "harassment":
    case "hate":
    case "sexual_content":
    case "graphic_content":
      return "high"
    case "spam":
    case "misleading":
      return "medium"
    case "other":
    default:
      return "low"
  }
}

export function assertCreateUserReportRequest(body: CreateUserReportRequest): void {
  if (!body.reason_code) {
    throw badRequestError("reason_code is required")
  }
}

export function assertCreateModerationActionRequest(body: CreateModerationActionRequest): void {
  if (!body.action_type) {
    throw badRequestError("action_type is required")
  }
}
