import type { Env, User } from "../../types"
import type { CommunityRow, JobRow } from "../auth/auth-db-rows"
import type { LocalCommunitySnapshot } from "./community-local-db"
import type { Community, Job } from "../../types"
import {
  buildDefaultMoneyPolicy,
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
import { unixSeconds } from "../../serializers/time"
import type { GateAtom, GateExpression } from "./membership/gate-types"

type HumanVerificationLane = NonNullable<Community["human_verification_lane"]>

function normalizeHumanVerificationLane(value: unknown): HumanVerificationLane | null {
  return value === "self" || value === "very" ? value : null
}

function parseStoredPositiveInteger(
  storedSettings: Record<string, unknown>,
  key: string,
): number | null {
  const rawValue = storedSettings[key]
  const parsed = typeof rawValue === "number" ? rawValue : typeof rawValue === "string" ? Number(rawValue) : NaN
  if (!Number.isFinite(parsed)) {
    return null
  }

  const normalized = Math.trunc(parsed)
  return normalized > 0 ? normalized : null
}

function normalizeDonationPolicyMode(
  mode: LocalCommunitySnapshot["donation_policy_mode"] | null | undefined,
): "none" | "optional_creator_sidecar" {
  if (mode === "optional_creator_sidecar" || mode === "fundraiser_default") {
    return "optional_creator_sidecar"
  }
  return "none"
}

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
  } catch (error) {
    console.warn("[community-serialization] failed to parse community settings JSON", {
      communityId: local.community_id,
      error,
    })
  }

  return {}
}

export function parseStoredReferenceLinks(
  storedSettings: Record<string, unknown>,
): NonNullable<Community["reference_links"]> {
  const rawLinks = storedSettings.reference_links
  if (!Array.isArray(rawLinks)) {
    return []
  }

  return rawLinks.flatMap((rawLink, index) => {
    if (!rawLink || typeof rawLink !== "object") {
      return []
    }

    const link = rawLink as Record<string, unknown>
    const metadata = link.metadata && typeof link.metadata === "object"
      ? link.metadata as Record<string, unknown>
      : {}

    if (typeof link.community_reference_link_id !== "string" || typeof link.platform !== "string" || typeof link.url !== "string") {
      return []
    }

    return [{
      community_reference_link: link.community_reference_link_id,
      platform: link.platform as NonNullable<Community["reference_links"]>[number]["platform"],
      url: link.url,
      label: typeof link.label === "string" ? link.label : null,
      link_status: link.link_status === "archived" ? "archived" : "active",
      verified: link.verified === true,
      metadata: {
        display_name: typeof metadata.display_name === "string" ? metadata.display_name : null,
        image_url: typeof metadata.image_url === "string" ? metadata.image_url : null,
      },
      position: typeof link.position === "number" ? link.position : index,
    } satisfies NonNullable<Community["reference_links"]>[number]]
  }).sort((left, right) => left.position - right.position)
}

function parseStoredLabelPolicy(
  storedSettings: Record<string, unknown>,
): Community["label_policy"] {
  const rawPolicy = storedSettings.label_policy
  if (!rawPolicy || typeof rawPolicy !== "object" || Array.isArray(rawPolicy)) {
    return null
  }

  const policy = rawPolicy as Record<string, unknown>
  if (
    typeof policy.label_enabled !== "boolean"
    || typeof policy.require_label_on_top_level_posts !== "boolean"
    || !Array.isArray(policy.definitions)
  ) {
    return null
  }

  const definitions = policy.definitions.flatMap((rawDefinition, index) => {
    if (!rawDefinition || typeof rawDefinition !== "object" || Array.isArray(rawDefinition)) {
      return []
    }

    const definition = rawDefinition as Record<string, unknown>
    if (typeof definition.label_id !== "string" || typeof definition.label !== "string") {
      return []
    }

    const allowedPostTypes = Array.isArray(definition.allowed_post_types)
      ? definition.allowed_post_types.filter((postType): postType is "text" | "image" | "video" | "song" =>
        postType === "text" || postType === "image" || postType === "video" || postType === "song")
      : null

    return [{
      id: `cld_${definition.label_id}`,
      object: "community_label_definition",
      label: definition.label,
      description: typeof definition.description === "string" ? definition.description : null,
      color_token: typeof definition.color_token === "string" ? definition.color_token : null,
      status: definition.status === "archived" ? "archived" : "active",
      position: typeof definition.position === "number" ? definition.position : index,
      allowed_post_types: allowedPostTypes,
    } satisfies NonNullable<Community["label_policy"]>["definitions"][number]]
  }).sort((left, right) => left.position - right.position)

  return {
    label_enabled: policy.label_enabled,
    require_label_on_top_level_posts: policy.require_label_on_top_level_posts,
    definitions,
  }
}

function parseStoredAllowedDisclosedQualifiers(
  storedSettings: Record<string, unknown>,
): Community["allowed_disclosed_qualifiers"] {
  const rawQualifiers = storedSettings.allowed_disclosed_qualifiers
  if (!Array.isArray(rawQualifiers)) {
    return null
  }

  const qualifierIds = rawQualifiers
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean)

  return qualifierIds.length ? [...new Set(qualifierIds)] : null
}

function parseStoredAllowQualifiersOnAnonymousPosts(
  storedSettings: Record<string, unknown>,
): Community["allow_qualifiers_on_anonymous_posts"] {
  const rawValue = storedSettings.allow_qualifiers_on_anonymous_posts
  return typeof rawValue === "boolean" ? rawValue : null
}

function parseStoredAgentPostingPolicy(
  storedSettings: Record<string, unknown>,
): Community["agent_posting_policy"] {
  const rawValue = storedSettings.agent_posting_policy
  if (rawValue === "review" || rawValue === "allow_with_disclosure" || rawValue === "allow") {
    return rawValue
  }
  return "disallow"
}

function parseStoredAgentPostingScope(
  storedSettings: Record<string, unknown>,
): Community["agent_posting_scope"] {
  const rawValue = storedSettings.agent_posting_scope
  if (rawValue === "top_level_and_replies") {
    return rawValue
  }
  return "replies_only"
}

function gatePolicyHasAtom(
  expression: GateExpression | null | undefined,
  predicate: (atom: GateAtom) => boolean,
): boolean {
  if (!expression) return false
  if (expression.op === "gate") return predicate(expression.gate)
  return expression.children.some((child) => gatePolicyHasAtom(child, predicate))
}

function communityRequiresSelfLane(local: LocalCommunitySnapshot | null): boolean {
  return gatePolicyHasAtom(local?.gate_policy?.expression, (atom) => (
    (atom.type === "unique_human" && atom.provider === "self")
    || atom.type === "minimum_age"
    || atom.type === "nationality"
    || atom.type === "gender"
  ))
}

function communityAllowsVeryLane(local: LocalCommunitySnapshot | null): boolean {
  return gatePolicyHasAtom(local?.gate_policy?.expression, (atom) => atom.type === "unique_human" && atom.provider === "very")
}

function parseStoredHumanVerificationLane(
  storedSettings: Record<string, unknown>,
  local: LocalCommunitySnapshot | null,
): Community["human_verification_lane"] {
  if (communityRequiresSelfLane(local)) {
    return "self"
  }

  const explicitLane = normalizeHumanVerificationLane(storedSettings.human_verification_lane)
  if (explicitLane) {
    return explicitLane
  }

  if (communityAllowsVeryLane(local)) {
    return "very"
  }

  return "self"
}

function parseStoredHumanVerificationLaneOrigin(
  storedSettings: Record<string, unknown>,
): "derived" | "explicit" {
  return normalizeHumanVerificationLane(storedSettings.human_verification_lane) == null
    ? "derived"
    : "explicit"
}

function parseStoredAcceptedAgentOwnershipProviders(
  storedSettings: Record<string, unknown>,
): Community["accepted_agent_ownership_providers"] {
  const rawProviders = storedSettings.accepted_agent_ownership_providers
  if (!Array.isArray(rawProviders)) {
    return []
  }

  return [...new Set(rawProviders.filter((value): value is Community["accepted_agent_ownership_providers"][number] =>
    value === "self_agent_id" || value === "clawkey"
  ))]
}

function parseStoredAcceptedAgentOwnershipProvidersOrigin(
  storedSettings: Record<string, unknown>,
): "derived" | "explicit" {
  return Array.isArray(storedSettings.accepted_agent_ownership_providers) ? "explicit" : "derived"
}

export function serializeCommunity(env: Env, row: CommunityRow, local: LocalCommunitySnapshot | null): Community {
  const storedSettings = parseStoredCommunitySettings(local)
  const referenceLinks = parseStoredReferenceLinks(storedSettings)
  const labelPolicy = parseStoredLabelPolicy(storedSettings)
  const donationPartner = local?.donation_partner
    ? {
        donation_partner: local.donation_partner.donation_partner_id,
        display_name: local.donation_partner.display_name,
        provider: local.donation_partner.provider,
        provider_partner_ref: local.donation_partner.provider_partner_ref,
        image_url: local.donation_partner.image_url,
        review_status: local.donation_partner.review_status,
        status: local.donation_partner.status,
      }
    : null
  const allowedDisclosedQualifiers = parseStoredAllowedDisclosedQualifiers(storedSettings)
  const allowQualifiersOnAnonymousPosts = parseStoredAllowQualifiersOnAnonymousPosts(storedSettings)
  const humanVerificationLane = parseStoredHumanVerificationLane(storedSettings, local)
  const humanVerificationLaneOrigin = parseStoredHumanVerificationLaneOrigin(storedSettings)
  const agentPostingPolicy = parseStoredAgentPostingPolicy(storedSettings)
  const agentPostingScope = parseStoredAgentPostingScope(storedSettings)
  const agentDailyPostCap = parseStoredPositiveInteger(storedSettings, "agent_daily_post_cap")
  const agentDailyReplyCap = parseStoredPositiveInteger(storedSettings, "agent_daily_reply_cap")
  const acceptedAgentOwnershipProviders = parseStoredAcceptedAgentOwnershipProviders(storedSettings)
  const acceptedAgentOwnershipProvidersOrigin = parseStoredAcceptedAgentOwnershipProvidersOrigin(storedSettings)
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
    membership_mode: local?.membership_mode ?? "gated",
    allow_anonymous_identity: local?.allow_anonymous_identity ?? false,
    anonymous_identity_scope: local?.anonymous_identity_scope ?? null,
    allowed_disclosed_qualifiers: allowedDisclosedQualifiers,
    allow_qualifiers_on_anonymous_posts: allowQualifiersOnAnonymousPosts,
    governance_mode: local?.governance_mode ?? "centralized",
    human_verification_lane: humanVerificationLane,
    human_verification_lane_origin: humanVerificationLaneOrigin,
    donation_policy_mode: normalizeDonationPolicyMode(local?.donation_policy_mode),
    donation_partner_status: donationPartnerStatus,
    donation_partner_id: local?.donation_partner_id ?? null,
    donation_partner: local?.donation_partner_id ? donationPartner : null,
    default_age_gate_policy: defaultAgeGatePolicy,
    agent_posting_policy: agentPostingPolicy,
    agent_posting_scope: agentPostingScope,
    agent_daily_post_cap: agentDailyPostCap,
    agent_daily_reply_cap: agentDailyReplyCap,
    agent_min_owner_trust_tier: null,
    agent_owner_active_limit: null,
    accepted_agent_ownership_providers_origin: acceptedAgentOwnershipProvidersOrigin,
    accepted_agent_ownership_providers: acceptedAgentOwnershipProviders,
    civic_scale_tier: "club",
    money_policy: buildDefaultMoneyPolicy(env, row.community_id),
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
    label_policy: labelPolicy,
    community_profile: local
      ? {
        rules: local.rules.map((rule) => ({
          id: `rule_${rule.rule_id}`,
          object: "community_rule",
          title: rule.title,
          body: rule.body,
          report_reason: rule.report_reason,
          position: rule.position,
          status: rule.status,
        })),
        resource_links: [],
      }
      : null,
    reference_links: referenceLinks,
    gate_policy: local?.gate_policy ?? null,
    created_by_user_id: row.creator_user_id,
    created_at: row.created_at,
    updated_at: local?.updated_at ?? row.updated_at,
  }
}

export function serializeJob(row: JobRow): Job {
  return {
    id: `job_${row.job_id}`,
    object: "job",
    job_type: row.job_type,
    status: row.status,
    subject_type: row.subject_type,
    subject: row.subject_id,
    result_ref: row.result_ref,
    error_code: row.error_code,
    created: unixSeconds(row.created_at),
  }
}

export function getPrimaryWalletSnapshot(user: User, walletAttachments: Array<{ wallet_attachment: string; wallet_address: string; is_primary: boolean }>): string | null {
  const primaryAttachmentId = user.primary_wallet_attachment_id
  if (primaryAttachmentId) {
    const primaryAttachment = walletAttachments.find((attachment) => attachment.wallet_attachment === primaryAttachmentId)
    if (primaryAttachment) {
      return primaryAttachment.wallet_address
    }
  }

  return walletAttachments.find((attachment) => attachment.is_primary)?.wallet_address
    ?? walletAttachments[0]?.wallet_address
    ?? null
}
