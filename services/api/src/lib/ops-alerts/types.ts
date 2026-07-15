export type PublishFailureCount = {
  code: string
  count: number
}

export type StuckRoyaltyProjectionSample = {
  asset_id: string
  royalty_allocation_status: string
  updated_at: string | null
}

export type StaleLockedDeliveryAssetSample = {
  asset_id: string
  locked_delivery_status: string
  updated_at: string | null
}

export type RetriedLockedDeliveryJobSample = {
  job_id: string
  asset_id: string
  status: string
  attempt_count: number
  last_checkpoint: string | null
  updated_at: string | null
}

export type StoryRegistrationReconciliationSample = {
  asset_id: string
  status: string
  provider_tx_ref: string | null
  updated_at: string | null
}

export type CommunityPublishAlertSignals = {
  community_id: string
  failure_codes: PublishFailureCount[]
  terminal_failed_finalize_jobs: number
  stuck_royalty_allocation_projections: number
  stuck_royalty_allocation_projection_samples: StuckRoyaltyProjectionSample[]
  stale_locked_delivery_assets: number
  stale_locked_delivery_asset_samples: StaleLockedDeliveryAssetSample[]
  retried_locked_delivery_jobs: number
  retried_locked_delivery_job_samples: RetriedLockedDeliveryJobSample[]
  story_registration_reconciliation_required: number
  story_registration_reconciliation_samples: StoryRegistrationReconciliationSample[]
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
