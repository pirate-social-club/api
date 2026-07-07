export type PublishFailureCount = {
  code: string
  count: number
}

export type CommunityPublishAlertSignals = {
  community_id: string
  failure_codes: PublishFailureCount[]
  terminal_failed_finalize_jobs: number
}

export type OpsAlertSeverity = "high" | "medium" | "low"

export type OpsAlert = {
  key: string
  severity: OpsAlertSeverity
  title: string
  count: number
  community_ids: string[]
  details?: Record<string, unknown>
}

export const OPS_ACTIONABLE_FAILURE_CODES = new Set([
  "internal_error",
  "provider_unavailable",
  "listing_creation_failed",
  "story_royalty_registration_failed",
  "catalog_sync_failed",
])

export const OPS_HIGH_SEVERITY_CODES = new Set([
  "listing_creation_failed",
  "story_royalty_registration_failed",
  "catalog_sync_failed",
])
