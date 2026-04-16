import type { User } from "../../types"
import type { CommunityRow, JobRow } from "../auth/control-plane-auth-rows"
import type { LocalCommunitySnapshot } from "./community-local-db"
import type { Community, Job } from "../../types"
import {
  buildDefaultContentAuthenticityPolicy,
  buildDefaultContentAuthenticityDetectionPolicy,
  buildDefaultMarketContextPolicy,
  buildDefaultSourcePolicy,
  buildDefaultCaptureEditPolicy,
  buildDefaultAdultContentPolicy,
  buildDefaultGraphicContentPolicy,
  buildDefaultMotionMediaPolicy,
  buildDefaultLanguagePolicy,
  buildDefaultProvenancePolicy,
  buildDefaultPromotionPolicy,
  buildDefaultCivilityPolicy,
} from "./community-policy-defaults"

export function serializeCommunity(row: CommunityRow, local: LocalCommunitySnapshot | null): Community {
  const policyUpdatedAt = row.created_at
  const donationPartnerStatus: Community["donation_partner_status"] =
    local?.donation_partner_status === "inactive" ? "paused" : (local?.donation_partner_status ?? "unconfigured")
  const defaultAgeGatePolicy: Community["default_age_gate_policy"] = local?.default_age_gate_policy ?? "none"
  return {
    community_id: row.community_id,
    display_name: local?.display_name ?? row.display_name,
    description: local?.description ?? null,
    namespace_verification_id: row.namespace_verification_id,
    route_slug: row.route_slug,
    pending_namespace_verification_session_id: row.pending_namespace_verification_session_id,
    status: row.status === "suspended" ? "frozen" : row.status,
    provisioning_state: row.provisioning_state,
    registry_publication_state: row.registry_publication_state,
    registry_attempt_id: row.registry_attempt_id,
    registry_published_at: row.registry_published_at,
    registry_publication_job_id: row.registry_publication_job_id,
    registry_error_code: row.registry_error_code,
    membership_mode: local?.membership_mode ?? "open",
    allow_anonymous_identity: local?.allow_anonymous_identity ?? false,
    anonymous_identity_scope: local?.anonymous_identity_scope ?? null,
    governance_mode: local?.governance_mode ?? "centralized",
    donation_policy_mode: local?.donation_policy_mode ?? "none",
    donation_partner_status: donationPartnerStatus,
    default_age_gate_policy: defaultAgeGatePolicy,
    agent_posting_policy: "disallow",
    agent_posting_scope: "replies_only",
    agent_daily_post_cap: null,
    agent_daily_reply_cap: null,
    agent_min_owner_trust_tier: null,
    agent_owner_active_limit: null,
    civic_scale_tier: "club",
    content_authenticity_policy: buildDefaultContentAuthenticityPolicy(row.community_id, policyUpdatedAt),
    content_authenticity_detection_policy: buildDefaultContentAuthenticityDetectionPolicy(row.community_id, policyUpdatedAt),
    market_context_policy: buildDefaultMarketContextPolicy(row.community_id, policyUpdatedAt),
    source_policy: buildDefaultSourcePolicy(row.community_id, policyUpdatedAt),
    capture_edit_policy: buildDefaultCaptureEditPolicy(row.community_id, policyUpdatedAt),
    adult_content_policy: buildDefaultAdultContentPolicy(row.community_id, policyUpdatedAt, defaultAgeGatePolicy),
    graphic_content_policy: buildDefaultGraphicContentPolicy(row.community_id, policyUpdatedAt),
    motion_media_policy: buildDefaultMotionMediaPolicy(row.community_id, policyUpdatedAt),
    language_policy: buildDefaultLanguagePolicy(row.community_id, policyUpdatedAt),
    civility_policy: buildDefaultCivilityPolicy(row.community_id, policyUpdatedAt),
    provenance_policy: buildDefaultProvenancePolicy(row.community_id, policyUpdatedAt),
    promotion_policy: buildDefaultPromotionPolicy(row.community_id, policyUpdatedAt),
    created_by_user_id: row.creator_user_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export function serializeJob(row: JobRow): Job {
  return {
    job_id: row.job_id,
    job_type: row.job_type,
    status: row.status,
    subject_type: row.subject_type,
    subject_id: row.subject_id,
    result_ref: row.result_ref,
    error_code: row.error_code,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export function getPrimaryWalletSnapshot(user: User, walletAttachments: Array<{ wallet_attachment_id: string; wallet_address: string; is_primary: boolean }>): string | null {
  const primaryAttachmentId = user.primary_wallet_attachment_id
  if (primaryAttachmentId) {
    const primaryAttachment = walletAttachments.find((attachment) => attachment.wallet_attachment_id === primaryAttachmentId)
    if (primaryAttachment) {
      return primaryAttachment.wallet_address
    }
  }

  return walletAttachments.find((attachment) => attachment.is_primary)?.wallet_address
    ?? walletAttachments[0]?.wallet_address
    ?? null
}
