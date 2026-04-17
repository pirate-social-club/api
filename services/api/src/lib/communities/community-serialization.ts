import type { User } from "../../types"
import type { CommunityRow, JobRow } from "../auth/auth-db-rows"
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
import {
  resolveCommunityAvatarRef,
  resolveCommunityBannerRef,
} from "./community-identity-media"

function parseStoredCommunitySettings(
  local: LocalCommunitySnapshot | null,
): Record<string, unknown> {
  if (!local?.settings_json?.trim()) {
    return {}
  }

  try {
    const parsed = JSON.parse(local.settings_json) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {}

  return {}
}

export function serializeCommunity(row: CommunityRow, local: LocalCommunitySnapshot | null): Community {
  const storedSettings = parseStoredCommunitySettings(local)
  const policyUpdatedAt = local?.updated_at ?? row.created_at
  const donationPartnerStatus: Community["donation_partner_status"] =
    local?.donation_partner_status === "inactive" ? "paused" : (local?.donation_partner_status ?? "unconfigured")
  const defaultAgeGatePolicy: Community["default_age_gate_policy"] = local?.default_age_gate_policy ?? "none"
  const displayName = local?.display_name ?? row.display_name
  const adultContentPolicy = storedSettings.adult_content_policy as Community["adult_content_policy"] | undefined
  const graphicContentPolicy = storedSettings.graphic_content_policy as Community["graphic_content_policy"] | undefined
  const civilityPolicy = storedSettings.civility_policy as Community["civility_policy"] | undefined
  const openAIModerationSettings = storedSettings.openai_moderation_settings as {
    scan_titles: boolean
    scan_post_bodies: boolean
    scan_captions: boolean
    scan_link_preview_text: boolean
    scan_images: boolean
  } | undefined
  return {
    community_id: row.community_id,
    display_name: displayName,
    description: local?.description ?? null,
    avatar_ref: resolveCommunityAvatarRef({
      communityId: row.community_id,
      displayName,
      avatarRef: local?.avatar_ref,
    }),
    banner_ref: resolveCommunityBannerRef({
      communityId: row.community_id,
      displayName,
      bannerRef: local?.banner_ref,
    }),
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
    human_verification_lane: "self",
    donation_policy_mode: local?.donation_policy_mode ?? "none",
    donation_partner_status: donationPartnerStatus,
    default_age_gate_policy: defaultAgeGatePolicy,
    agent_posting_policy: "disallow",
    agent_posting_scope: "replies_only",
    agent_daily_post_cap: null,
    agent_daily_reply_cap: null,
    agent_min_owner_trust_tier: null,
    agent_owner_active_limit: null,
    accepted_agent_ownership_providers: [],
    civic_scale_tier: "club",
    content_authenticity_policy: buildDefaultContentAuthenticityPolicy(row.community_id, policyUpdatedAt),
    content_authenticity_detection_policy: buildDefaultContentAuthenticityDetectionPolicy(row.community_id, policyUpdatedAt),
    market_context_policy: buildDefaultMarketContextPolicy(row.community_id, policyUpdatedAt),
    source_policy: buildDefaultSourcePolicy(row.community_id, policyUpdatedAt),
    capture_edit_policy: buildDefaultCaptureEditPolicy(row.community_id, policyUpdatedAt),
    adult_content_policy:
      adultContentPolicy ?? buildDefaultAdultContentPolicy(row.community_id, policyUpdatedAt, defaultAgeGatePolicy),
    graphic_content_policy:
      graphicContentPolicy ?? buildDefaultGraphicContentPolicy(row.community_id, policyUpdatedAt),
    motion_media_policy: buildDefaultMotionMediaPolicy(row.community_id, policyUpdatedAt),
    language_policy: buildDefaultLanguagePolicy(row.community_id, policyUpdatedAt),
    civility_policy: civilityPolicy ?? buildDefaultCivilityPolicy(row.community_id, policyUpdatedAt),
    openai_moderation_settings: openAIModerationSettings ?? null,
    provenance_policy: buildDefaultProvenancePolicy(row.community_id, policyUpdatedAt),
    promotion_policy: buildDefaultPromotionPolicy(row.community_id, policyUpdatedAt),
    community_profile: local
      ? {
        rules: local.rules.map((rule) => ({
          rule_id: rule.rule_id,
          title: rule.title,
          body: rule.body,
          report_reason: rule.report_reason,
          position: rule.position,
          status: rule.status,
        })),
        resource_links: [],
      }
      : null,
    gate_rules: (local?.gate_rules?.map((rule) => ({
      community_id: row.community_id,
      gate_rule_id: rule.gate_rule_id,
      scope: rule.scope,
      gate_family: rule.gate_family,
      gate_type: rule.gate_type,
      proof_requirements: rule.proof_requirements,
      chain_namespace: rule.chain_namespace,
      gate_config: rule.gate_config,
      status: rule.status,
      created_at: rule.created_at,
      updated_at: rule.updated_at,
    })) as NonNullable<Community["gate_rules"]>) ?? null,
    created_by_user_id: row.creator_user_id,
    created_at: row.created_at,
    updated_at: local?.updated_at ?? row.updated_at,
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
