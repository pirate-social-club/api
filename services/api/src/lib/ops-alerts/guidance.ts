import type { OpsAlert } from "./types"

export type OpsAlertGuidance = {
  owner: string
  recommendedAction: string
  runbookUrl?: string
}

const STORY_REGISTRATION_RUNBOOK_URL =
  "https://github.com/pirate-social-club/api/blob/main/services/api/docs/runbooks/story-registration-effect-resolution.md"

export function opsAlertGuidance(alert: OpsAlert): OpsAlertGuidance {
  if (alert.key === "stuck_royalty_allocation_projection_sync") {
    return {
      owner: "API commerce",
      recommendedAction: "Inspect the verified shard asset and retry its control-plane royalty projection; do not repeat vault verification.",
    }
  }
  if (alert.key === "story_registration_reconciliation_required") {
    return {
      owner: "Story operations",
      recommendedAction: "Inspect signer history and every configured RPC before resolving or retrying; never infer no-broadcast from a missing transaction reference.",
      runbookUrl: STORY_REGISTRATION_RUNBOOK_URL,
    }
  }
  if (alert.key.startsWith("scheduled_error:")) {
    return {
      owner: "API runtime",
      recommendedAction: "Inspect the named scheduled task logs and its environment bindings; treat repeated configuration errors as one deployment incident.",
    }
  }
  if (alert.key.startsWith("scheduled_warning:ops_alert_smoke_test:")) {
    return {
      owner: "API operations",
      recommendedAction: "No incident action is required when an authorized operator intentionally requested this delivery test.",
    }
  }
  return {
    owner: "API operations",
    recommendedAction: `Inspect logs and current state for alert key ${alert.key}; close the underlying condition rather than suppressing the email.`,
  }
}
