import {
  bootstrapLocalCommunityDb,
  buildLocalCommunityDbUrl,
  makeLocalCommunityReferenceLinkId,
  makeLocalCommunityResourceLinkId,
  makeLocalCommunityRuleId,
  makeLocalCommunityFlairId,
  readLocalCommunity,
  readLocalCommunityWithExecutor,
  readLocalCommunityContentAuthenticityPolicy,
  readLocalCommunityContentAuthenticityDetectionPolicy,
  readLocalCommunityFlairPolicy,
  readLocalCommunityMarketContextPolicy,
  readLocalCommunityProfile,
  readLocalCommunityReferenceLinks,
  readLocalCommunitySourcePolicy,
  updateLocalCommunity,
  updateLocalCommunityDonationPolicy,
  updateLocalCommunityContentAuthenticityPolicy,
  updateLocalCommunityContentAuthenticityDetectionPolicy,
  updateLocalCommunityFlairPolicy,
  updateLocalCommunityMarketContextPolicy,
  updateLocalCommunityProfile,
  updateLocalCommunityReferenceLinks,
  updateLocalCommunitySourcePolicy,
  type LocalCommunityContentAuthenticityPolicySnapshot,
  type LocalCommunityContentAuthenticityDetectionPolicySnapshot,
  type LocalCommunityFlairPolicySnapshot,
  type LocalCommunityMarketContextPolicySnapshot,
  type LocalCommunitySourcePolicySnapshot,
  type LocalCommunitySnapshot,
} from "./community-local-db"
import {
  type CommunityGateRuleRow,
  listActiveCommunityMemberUserIds,
  listCommunityGateRules,
} from "./community-membership-store"
import { openCommunityDb } from "./community-db-factory"
import { normalizeGateRuleInput } from "./community-gate-rule-normalization"
import {
  allowLocalStubCommunityProvisioning,
  provisionCommunityWithOperator,
  requireCommunityDbWrapKeyVersion,
  requireCommunityProvisionGroupLocation,
  shouldUseCommunityProvisionOperator,
} from "./community-provision-operator"
import type { UserRepository } from "../auth/repositories"
import type { CommunityRow, JobRow } from "../auth/control-plane-auth-rows"
import type { CommunityRepository } from "./control-plane-community-repository"
import { badRequestError, eligibilityFailed, internalError, notFoundError } from "../errors"
import { envFlag, makeId, nowIso } from "../helpers"
import { verifyPirateAccessToken } from "../auth/pirate-session-token"
import { getRegistryPublicationAdapter } from "./registry-publication"
import type { VerificationRepository } from "../verification/control-plane-verification-repository"
import type {
  Community,
  CommunityGateRule,
  CommunityContentAuthenticityPolicy,
  CommunityContentAuthenticityDetectionPolicy,
  CommunityDonationPolicy,
  CommunityFlairPolicy,
  CommunityMarketContextPolicy,
  CommunityProfile,
  CommunityReferenceLinkAdmin,
  CommunityReferenceLinkMetadata,
  CommunityReferenceLinkPlatform,
  CommunityResourceLink,
  CommunityRule,
  CreateCommunityReferenceLinkRequest,
  CommunityCreateAcceptedResponse,
  CreateCommunityRequest,
  Env,
  Job,
  UpdateCommunityContentAuthenticityPolicyRequest,
  UpdateCommunityContentAuthenticityDetectionPolicyRequest,
  UpdateCommunityDonationPolicyRequest,
  UpdateCommunityFlairPolicyRequest,
  UpdateCommunityMarketContextPolicyRequest,
  UpdateCommunityReferenceLinkRequest,
  UpdateCommunitySourcePolicyRequest,
  UpdateCommunityRequest,
  UpdateCommunityProfileRequest,
  User,
} from "../../types"

export type CreateCommunityRequestBody = CreateCommunityRequest

type CommunityProofRequirementInput = {
  proof_type: string
  accepted_providers?: string[] | null
  accepted_mechanisms?: string[] | null
  config?: Record<string, unknown> | null
}

type CommunityGateRuleInput = {
  scope: "membership" | "viewer" | "posting"
  gate_family: "token_holding" | "identity_proof"
  gate_type: string
  proof_requirements?: CommunityProofRequirementInput[] | null
  chain_namespace?: string | null
  gate_config?: Record<string, unknown> | null
}

type CommunityListResponse = {
  items: Community[]
  next_cursor: string | null
}
type CommunityDerivedReadModel = {
  memberCount: number | null
  qualifiedMemberCount: number | null
  communityStage: Community["community_stage"]
  civicScaleTier: Community["civic_scale_tier"]
  stageEnteredAt: string | null
}

const VALID_PUBLIC_V0_PROVIDERS_BY_PROOF_TYPE = {
  unique_human: new Set(["self", "very"]),
  age_over_18: new Set(["self"]),
  nationality: new Set(["self"]),
  gender: new Set(["self"]),
  wallet_score: new Set(["passport"]),
  sanctions_clear: new Set(["passport"]),
} as const

function buildDefaultContentAuthenticityPolicy(communityId: string, updatedAt: string): Community["content_authenticity_policy"] {
  return {
    community_id: communityId,
    policy_origin: "default",
    authenticity_stance: "human_first",
    text_policy: {
      allow_ai_assisted_editing: false,
      allow_ai_generated: false,
    },
    image_policy: {
      allow_ai_upscale: false,
      allow_ai_restoration: false,
      allow_generative_editing: false,
      allow_ai_generated: false,
    },
    video_policy: {
      allow_ai_upscale: false,
      allow_ai_restoration: false,
      allow_ai_frame_interpolation: false,
      allow_generative_editing: false,
      allow_ai_generated: false,
    },
    song_policy: {
      allow_ai_assisted_mastering: false,
      allow_ai_stem_separation: false,
      allow_ai_generated_instrumentals: false,
      allow_ai_generated_lyrics: false,
      allow_ai_generated_vocals: false,
    },
    updated_at: updatedAt,
  }
}

function resolveCommunityContentAuthenticityPolicy(
  communityId: string,
  updatedAt: string,
  explicit: LocalCommunityContentAuthenticityPolicySnapshot | null,
): CommunityContentAuthenticityPolicy {
  if (explicit) {
    return explicit
  }
  return buildDefaultContentAuthenticityPolicy(communityId, updatedAt)
}

function resolveCommunityContentAuthenticityDetectionPolicy(
  communityId: string,
  updatedAt: string,
  explicit: LocalCommunityContentAuthenticityDetectionPolicySnapshot | null,
): CommunityContentAuthenticityDetectionPolicy {
  if (explicit) {
    return explicit
  }
  return buildDefaultContentAuthenticityDetectionPolicy(communityId, updatedAt)
}

function resolveCommunityFlairPolicy(
  explicit: LocalCommunityFlairPolicySnapshot | null,
): CommunityFlairPolicy {
  return explicit ?? {
    flair_enabled: false,
    require_flair_on_top_level_posts: false,
    definitions: [],
  }
}

function resolveCommunitySourcePolicy(
  communityId: string,
  updatedAt: string,
  explicit: LocalCommunitySourcePolicySnapshot | null,
): Community["source_policy"] {
  if (explicit) {
    return explicit
  }
  return buildDefaultSourcePolicy(communityId, updatedAt)
}

function resolveCommunityMarketContextPolicy(
  communityId: string,
  updatedAt: string,
  explicit: LocalCommunityMarketContextPolicySnapshot | null,
): CommunityMarketContextPolicy {
  if (explicit) {
    return explicit
  }
  return buildDefaultMarketContextPolicy(communityId, updatedAt)
}

function serializeCommunityDonationPolicy(local: LocalCommunitySnapshot): CommunityDonationPolicy {
  return {
    community_id: local.community_id,
    donation_policy_mode: local.donation_policy_mode,
    donation_partner_status: local.donation_partner_status === "inactive" ? "paused" : local.donation_partner_status,
    donation_partner_id: local.donation_partner_id,
    donation_partner: null,
    updated_at: local.updated_at,
  }
}

function buildDefaultSourcePolicy(communityId: string, updatedAt: string): Community["source_policy"] {
  return {
    community_id: communityId,
    policy_origin: "default",
    identified_person_media_scope: "subject_only",
    require_source_url_for_reposts: true,
    allow_human_made_fan_art_of_real_people: false,
    require_fan_art_disclosure: false,
    updated_at: updatedAt,
  }
}

function buildDefaultContentAuthenticityDetectionPolicy(
  communityId: string,
  updatedAt: string,
): Community["content_authenticity_detection_policy"] {
  return {
    community_id: communityId,
    policy_origin: "default",
    selection_mode: "platform_default",
    resolved_profile: {
      authenticity_detection_profile_id: "authdet_default_v0",
      profile_key: "platform-default-v0",
      provider_key: "platform_default",
      supported_capabilities: ["image_authenticity", "video_authenticity", "audio_authenticity", "deepfake_detection"],
      status: "active",
    },
    updated_at: updatedAt,
  }
}

function buildDefaultMarketContextPolicy(communityId: string, updatedAt: string): Community["market_context_policy"] {
  return {
    community_id: communityId,
    policy_origin: "default",
    mode: "off",
    enabled_post_types: ["link"],
    max_markets_per_post: 1,
    provider_set: "platform_default",
    resolved_profile: {
      market_context_profile_id: "marketctx_default_v0",
      profile_key: "platform-default-v0",
      provider_keys: ["platform_default"],
      status: "active",
    },
    updated_at: updatedAt,
  }
}

function buildDefaultCaptureEditPolicy(communityId: string, updatedAt: string): Community["capture_edit_policy"] {
  return {
    community_id: communityId,
    policy_origin: "default",
    basic_adjustments: "allow",
    retouching: "disallow",
    compositing: "disallow",
    documentary_editing: "disallow",
    require_edit_disclosure: false,
    updated_at: updatedAt,
  }
}

function buildDefaultAdultContentPolicy(
  communityId: string,
  updatedAt: string,
  defaultAgeGatePolicy: Community["default_age_gate_policy"],
): Community["adult_content_policy"] {
  if (defaultAgeGatePolicy === "18_plus") {
    return {
      community_id: communityId,
      policy_origin: "default",
      suggestive: "allow",
      artistic_nudity: "review",
      explicit_nudity: "disallow",
      explicit_sexual_content: "disallow",
      fetish_content: "disallow",
      updated_at: updatedAt,
    }
  }

  return {
    community_id: communityId,
    policy_origin: "default",
    suggestive: "review",
    artistic_nudity: "disallow",
    explicit_nudity: "disallow",
    explicit_sexual_content: "disallow",
    fetish_content: "disallow",
    updated_at: updatedAt,
  }
}

function buildDefaultGraphicContentPolicy(communityId: string, updatedAt: string): Community["graphic_content_policy"] {
  return {
    community_id: communityId,
    policy_origin: "default",
    injury_medical: "review",
    gore: "disallow",
    extreme_gore: "disallow",
    body_horror_disturbing: "disallow",
    animal_harm: "disallow",
    updated_at: updatedAt,
  }
}

function buildDefaultMotionMediaPolicy(communityId: string, updatedAt: string): Community["motion_media_policy"] {
  return {
    community_id: communityId,
    policy_origin: "default",
    allow_animated_images: true,
    allow_silent_looping_video: true,
    allow_audio_video: true,
    max_video_duration_seconds: null,
    require_video_transcription: false,
    updated_at: updatedAt,
  }
}

function buildDefaultLanguagePolicy(communityId: string, updatedAt: string): Community["language_policy"] {
  return {
    community_id: communityId,
    policy_origin: "default",
    profanity: "allow",
    slurs: "disallow",
    updated_at: updatedAt,
  }
}

function buildDefaultProvenancePolicy(communityId: string, updatedAt: string): Community["provenance_policy"] {
  return {
    community_id: communityId,
    policy_origin: "default",
    allowed_creator_relations: ["captured", "created", "subject", "authorized_repost", "fan_work", "found"],
    require_creator_relation: false,
    false_claim_consequence: "post_removed",
    allow_oc_claim: false,
    require_proof_for_original: false,
    updated_at: updatedAt,
  }
}

function buildDefaultPromotionPolicy(communityId: string, updatedAt: string): Community["promotion_policy"] {
  return {
    community_id: communityId,
    policy_origin: "default",
    self_promotion_mode: "limited_with_disclosure",
    require_affiliation_disclosure: true,
    max_promotional_posts_per_week: 1,
    promotional_participation_ratio: null,
    require_minimum_membership_days: 7,
    updated_at: updatedAt,
  }
}

function getPrimaryWalletSnapshot(user: User, walletAttachments: Array<{ wallet_attachment_id: string; wallet_address: string; is_primary: boolean }>): string | null {
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

function deriveCivicScaleTier(memberCount: number | null): Community["civic_scale_tier"] {
  if (memberCount == null) {
    return undefined
  }
  if (memberCount >= 100_000) {
    return "state"
  }
  if (memberCount >= 10_000) {
    return "city"
  }
  if (memberCount >= 1_000) {
    return "town"
  }
  if (memberCount >= 100) {
    return "village"
  }
  return "club"
}

function parseCommunityListLimit(limit: string | null | undefined): number {
  const normalized = String(limit ?? "").trim()
  if (!normalized) {
    return 25
  }
  const parsed = Number(normalized)
  if (!Number.isFinite(parsed)) {
    return 25
  }
  return Math.min(100, Math.max(1, Math.trunc(parsed)))
}

function compareDiscoverableCommunities(a: Community, b: Community): number {
  const qualifiedDiff = (b.qualified_member_count ?? 0) - (a.qualified_member_count ?? 0)
  if (qualifiedDiff !== 0) {
    return qualifiedDiff
  }

  const stageDiff = Date.parse(String(b.stage_entered_at || b.created_at)) - Date.parse(String(a.stage_entered_at || a.created_at))
  if (stageDiff !== 0) {
    return stageDiff
  }

  const createdDiff = Date.parse(b.created_at) - Date.parse(a.created_at)
  if (createdDiff !== 0) {
    return createdDiff
  }

  return a.community_id.localeCompare(b.community_id)
}

async function deriveCommunityReadModel(
  repo: CommunityRepository,
  userRepository: UserRepository,
  communityRow: CommunityRow,
): Promise<{ local: LocalCommunitySnapshot | null; derived: CommunityDerivedReadModel; databaseUrl: string | null }> {
  const binding = await repo.getPrimaryCommunityDatabaseBinding(communityRow.community_id)
  if (!binding) {
    return {
      local: null,
      databaseUrl: null,
      derived: {
        memberCount: null,
        qualifiedMemberCount: null,
        communityStage: "initial",
        civicScaleTier: undefined,
        stageEnteredAt: null,
      },
    }
  }

  const local = await readLocalCommunity(binding.database_url, communityRow.community_id).catch(() => null)
  if (local?.cached_member_count != null && local.cached_qualified_member_count != null) {
    return {
      local,
      databaseUrl: binding.database_url,
      derived: {
        memberCount: local.cached_member_count,
        qualifiedMemberCount: local.cached_qualified_member_count,
        communityStage: "initial",
        civicScaleTier: deriveCivicScaleTier(local.cached_member_count),
        stageEnteredAt: local.created_at ?? communityRow.created_at,
      },
    }
  }
  if (communityRow.projected_member_count != null && communityRow.projected_qualified_member_count != null) {
    return {
      local,
      databaseUrl: binding.database_url,
      derived: {
        memberCount: communityRow.projected_member_count,
        qualifiedMemberCount: communityRow.projected_qualified_member_count,
        communityStage: "initial",
        civicScaleTier: deriveCivicScaleTier(communityRow.projected_member_count),
        stageEnteredAt: local?.created_at ?? communityRow.created_at,
      },
    }
  }
  const db = await openCommunityDb(repo, communityRow.community_id)
  try {
    const memberUserIds = await listActiveCommunityMemberUserIds(db.client, communityRow.community_id)
    const users = await userRepository.listUsersByIds(memberUserIds)
    const usersById = new Map(users.map((user) => [user.user_id, user]))
    let qualifiedMemberCount = 0
    for (const userId of memberUserIds) {
      if (usersById.get(userId)?.verification_capabilities.unique_human.state === "verified") {
        qualifiedMemberCount += 1
      }
    }

    const memberCount = memberUserIds.length
    return {
      local,
      databaseUrl: binding.database_url,
      derived: {
        memberCount,
        qualifiedMemberCount,
        communityStage: "initial",
        civicScaleTier: deriveCivicScaleTier(memberCount),
        stageEnteredAt: local?.created_at ?? communityRow.created_at,
      },
    }
  } finally {
    db.close()
  }
}



function serializeCommunity(
  row: CommunityRow,
  local: LocalCommunitySnapshot | null,
  derived: CommunityDerivedReadModel,
  explicitContentAuthenticityPolicy: LocalCommunityContentAuthenticityPolicySnapshot | null,
  explicitContentAuthenticityDetectionPolicy: LocalCommunityContentAuthenticityDetectionPolicySnapshot | null,
  explicitFlairPolicy: LocalCommunityFlairPolicySnapshot | null,
  explicitMarketContextPolicy: LocalCommunityMarketContextPolicySnapshot | null,
  explicitSourcePolicy: LocalCommunitySourcePolicySnapshot | null,
  explicitGateRules: CommunityGateRule[] | null,
): Community {
  const policyUpdatedAt = row.created_at
  const donationPartnerStatus: Community["donation_partner_status"] =
    local?.donation_partner_status === "inactive" ? "paused" : (local?.donation_partner_status ?? "unconfigured")
  const defaultAgeGatePolicy: Community["default_age_gate_policy"] = local?.default_age_gate_policy ?? "none"
  return {
    community_id: row.community_id,
    display_name: local?.display_name ?? row.display_name,
    description: local?.description ?? null,
    namespace_verification_id: row.namespace_verification_id,
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
    agent_posting_policy: "disallow",
    agent_posting_scope: "replies_only",
    governance_mode: local?.governance_mode ?? "centralized",
    donation_policy_mode: local?.donation_policy_mode ?? "none",
    donation_partner_status: donationPartnerStatus,
    donation_partner_id: local?.donation_partner_id ?? null,
    donation_partner: null,
    default_age_gate_policy: defaultAgeGatePolicy,
    content_authenticity_policy: resolveCommunityContentAuthenticityPolicy(
      row.community_id,
      policyUpdatedAt,
      explicitContentAuthenticityPolicy,
    ),
    content_authenticity_detection_policy: resolveCommunityContentAuthenticityDetectionPolicy(
      row.community_id,
      policyUpdatedAt,
      explicitContentAuthenticityDetectionPolicy,
    ),
    market_context_policy: resolveCommunityMarketContextPolicy(row.community_id, policyUpdatedAt, explicitMarketContextPolicy),
    source_policy: resolveCommunitySourcePolicy(row.community_id, policyUpdatedAt, explicitSourcePolicy),
    capture_edit_policy: buildDefaultCaptureEditPolicy(row.community_id, policyUpdatedAt),
    adult_content_policy: buildDefaultAdultContentPolicy(row.community_id, policyUpdatedAt, defaultAgeGatePolicy),
    graphic_content_policy: buildDefaultGraphicContentPolicy(row.community_id, policyUpdatedAt),
    motion_media_policy: buildDefaultMotionMediaPolicy(row.community_id, policyUpdatedAt),
    language_policy: buildDefaultLanguagePolicy(row.community_id, policyUpdatedAt),
    provenance_policy: buildDefaultProvenancePolicy(row.community_id, policyUpdatedAt),
    promotion_policy: buildDefaultPromotionPolicy(row.community_id, policyUpdatedAt),
    flair_policy: resolveCommunityFlairPolicy(explicitFlairPolicy),
    gate_rules: explicitGateRules,
    community_stage: derived.communityStage,
    member_count: derived.memberCount,
    qualified_member_count: derived.qualifiedMemberCount,
    stage_entered_at: derived.stageEnteredAt,
    civic_scale_tier: derived.civicScaleTier,
    created_by_user_id: row.creator_user_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function serializeCommunityGateRules(rules: CommunityGateRuleRow[]): CommunityGateRule[] {
  return rules.map((rule) => ({
    gate_rule_id: rule.gate_rule_id,
    community_id: rule.community_id,
    scope: rule.scope,
    gate_family: rule.gate_family,
    gate_type: rule.gate_type as CommunityGateRule["gate_type"],
    proof_requirements: rule.proof_requirements_json
      ? JSON.parse(rule.proof_requirements_json) as CommunityGateRule["proof_requirements"]
      : null,
    chain_namespace: rule.chain_namespace,
    gate_config: rule.gate_config_json
      ? JSON.parse(rule.gate_config_json) as Record<string, unknown>
      : null,
    status: rule.status,
    created_at: rule.created_at,
    updated_at: rule.updated_at,
  }))
}

function serializeJob(row: JobRow): Job {
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

function resolveCommunityDbRoot(env: Env): string {
  const configured = String(env.LOCAL_COMMUNITY_DB_ROOT || "").trim()
  if (configured) {
    return configured
  }

  const environment = String(env.ENVIRONMENT || "").trim().toLowerCase()
  if (envFlag(env.DEV_MEMORY_STORE_ENABLED, false) || ["dev", "development", "local", "test"].includes(environment)) {
    return "/tmp/pirate-community-dbs"
  }

  throw internalError("LOCAL_COMMUNITY_DB_ROOT is not configured")
}

function normalizeCommunityTursoNamePart(communityId: string): string {
  return communityId.trim().toLowerCase().replace(/_/g, "-")
}

function buildPendingOperatorBindingSeed(input: {
  communityId: string
  location: string
}): {
  organizationSlug: string
  groupName: string
  databaseName: string
  databaseUrl: string
  location: string
  status: "inactive"
} {
  const normalizedCommunityId = normalizeCommunityTursoNamePart(input.communityId)
  return {
    organizationSlug: "operator-pending",
    groupName: `club-${normalizedCommunityId}`,
    databaseName: `main-${normalizedCommunityId}`,
    databaseUrl: `libsql://pending-${normalizedCommunityId}.invalid`,
    location: input.location,
    status: "inactive",
  }
}

function assertCreateRequest(
  body: CreateCommunityRequestBody,
  input: {
    uniqueHumanVerified: boolean
    ageOver18Verified: boolean
  },
): asserts body is CreateCommunityRequestBody & {
  display_name: string
  namespace: {
    namespace_verification_id: string
  }
  gate_rules?: CommunityGateRuleInput[] | null
} {
  if (!body.display_name?.trim() || !body.namespace?.namespace_verification_id?.trim()) {
    throw badRequestError("display_name and namespace.namespace_verification_id are required")
  }
  if (!input.uniqueHumanVerified) {
    throw eligibilityFailed("unique_human verification is required")
  }
  if ((body.governance_mode ?? "centralized") !== "centralized") {
    throw eligibilityFailed("Only centralized community creation is allowed in public v0")
  }
  if ((body.membership_mode ?? "open") !== "open" && (body.membership_mode ?? "open") !== "gated") {
    throw eligibilityFailed("Public v0 community creation only allows open or gated membership")
  }
  if ((body.handle_policy?.policy_template ?? "standard") !== "standard") {
    throw eligibilityFailed("Public v0 community creation requires the standard handle policy")
  }
  if ((body.anonymous_identity_scope ?? null) === "post_ephemeral") {
    throw eligibilityFailed("post_ephemeral anonymous scope is not allowed in public v0 community creation")
  }
  if ((body.default_age_gate_policy ?? "none") === "18_plus" && !input.ageOver18Verified) {
    throw eligibilityFailed("age_over_18 verification is required for 18_plus communities")
  }
  if (body.donation_policy != null || body.community_bootstrap != null) {
    throw eligibilityFailed("Public v0 community creation does not accept donation or bootstrap payloads")
  }
  if (body.gate_rules?.some((rule) => rule.scope === "viewer")) {
    throw eligibilityFailed("Public v0 community creation only allows membership-scope or posting-scope gates")
  }
  for (const rule of body.gate_rules ?? []) {
    if (!rule.scope || !rule.gate_family || !rule.gate_type) {
      throw badRequestError("Invalid gate_rules entry")
    }
    normalizeGateRuleInput(rule)
    for (const requirement of rule.proof_requirements ?? []) {
      if (!requirement.proof_type) {
        throw badRequestError("Invalid gate_rules proof requirement")
      }
      if (rule.gate_family !== "identity_proof") {
        continue
      }
      const acceptedProviders = requirement.accepted_providers ?? []
      if (acceptedProviders.length === 0) {
        continue
      }

      const validProviders = VALID_PUBLIC_V0_PROVIDERS_BY_PROOF_TYPE[
        requirement.proof_type as keyof typeof VALID_PUBLIC_V0_PROVIDERS_BY_PROOF_TYPE
      ]
      if (!validProviders) {
        continue
      }

      const invalidProviders = acceptedProviders.filter((provider) => !validProviders.has(provider))
      if (invalidProviders.length > 0) {
        throw eligibilityFailed(
          `Invalid accepted_providers for ${requirement.proof_type}: ${invalidProviders.join(", ")}`,
        )
      }
    }
  }
}

async function loadCommunityProjection(
  repo: CommunityRepository,
  userRepository: UserRepository,
  communityRow: CommunityRow,
): Promise<Community> {
  const { local, derived, databaseUrl } = await deriveCommunityReadModel(repo, userRepository, communityRow)
  let explicitContentAuthenticityPolicy: LocalCommunityContentAuthenticityPolicySnapshot | null = null
  let explicitContentAuthenticityDetectionPolicy: LocalCommunityContentAuthenticityDetectionPolicySnapshot | null = null
  let explicitFlairPolicy: LocalCommunityFlairPolicySnapshot | null = null
  let explicitMarketContextPolicy: LocalCommunityMarketContextPolicySnapshot | null = null
  let explicitSourcePolicy: LocalCommunitySourcePolicySnapshot | null = null
  let explicitGateRules: CommunityGateRule[] | null = null
  if (databaseUrl) {
    explicitContentAuthenticityPolicy = await readLocalCommunityContentAuthenticityPolicy(databaseUrl, communityRow.community_id).catch(() => null)
    explicitContentAuthenticityDetectionPolicy = await readLocalCommunityContentAuthenticityDetectionPolicy(databaseUrl, communityRow.community_id).catch(() => null)
    explicitFlairPolicy = await readLocalCommunityFlairPolicy(databaseUrl, communityRow.community_id).catch(() => null)
    explicitMarketContextPolicy = await readLocalCommunityMarketContextPolicy(databaseUrl, communityRow.community_id).catch(() => null)
    explicitSourcePolicy = await readLocalCommunitySourcePolicy(databaseUrl, communityRow.community_id).catch(() => null)
    const db = await openCommunityDb(repo, communityRow.community_id).catch(() => null)
    if (db) {
      try {
        explicitGateRules = serializeCommunityGateRules(
          await listCommunityGateRules(db.client, communityRow.community_id),
        )
      } finally {
        db.close()
      }
    }
  }
  return serializeCommunity(
    communityRow,
    local,
    derived,
    explicitContentAuthenticityPolicy,
    explicitContentAuthenticityDetectionPolicy,
    explicitFlairPolicy,
    explicitMarketContextPolicy,
    explicitSourcePolicy,
    explicitGateRules,
  )
}

function isExpired(isoTimestamp: string): boolean {
  const expiresAt = Date.parse(isoTimestamp)
  if (!Number.isFinite(expiresAt)) {
    throw eligibilityFailed("Namespace verification expiry is invalid")
  }
  return expiresAt <= Date.now()
}

export { satisfiesBaselineJoinGate, requireCommunityModerationAccess, recomputeAndPersistCommunityMembershipStats } from "./community-service-shared"

export async function requireOwnedCommunity(
  repo: CommunityRepository,
  communityId: string,
  userId: string,
): Promise<CommunityRow> {
  const community = await repo.getCommunityById(communityId)
  if (!community || community.creator_user_id !== userId) {
    throw notFoundError("Community not found")
  }
  return community
}

async function resolveCommunityByReference(
  repo: CommunityRepository,
  communityRef: string,
): Promise<CommunityRow | null> {
  const normalized = communityRef.trim()
  if (!normalized) {
    return null
  }

  const direct = await repo.getCommunityById(normalized)
  if (direct) {
    return direct
  }

  if (normalized.startsWith("@")) {
    const namespaceLabel = normalized.replace(/^@+/, "").toLowerCase()
    if (!namespaceLabel) {
      return null
    }

    return repo.getCommunityByNamespaceLabel({
      normalizedLabel: namespaceLabel,
      family: "spaces",
    })
  }

  const routeKey = normalized.replace(/^@+/, "").toLowerCase()
  if (!routeKey) {
    return null
  }

  return repo.getCommunityByRouteKey(routeKey)
}



export async function createCommunity(input: {
  env: Env
  bearerToken: string
  body: CreateCommunityRequestBody
  userRepository: UserRepository
  verificationRepository: VerificationRepository
  communityRepository: CommunityRepository
}): Promise<CommunityCreateAcceptedResponse> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  const user = await input.userRepository.getUserById(session.userId)
  if (!user) {
    throw internalError("Resolved user row is missing for community create")
  }

  assertCreateRequest(input.body, {
    uniqueHumanVerified: user.verification_capabilities.unique_human.state === "verified",
    ageOver18Verified: user.verification_capabilities.age_over_18.state === "verified",
  })
  const walletAttachments = await input.userRepository.getWalletAttachmentsByUserId(session.userId)
  const actorPrimaryWalletSnapshot = getPrimaryWalletSnapshot(user, walletAttachments)
  const actorGovernanceAddressSnapshot = null

  const namespaceVerificationId = input.body.namespace.namespace_verification_id.trim()
  const namespaceVerification = await input.verificationRepository.getNamespaceVerification(
    namespaceVerificationId,
    session.userId,
  )
  if (!namespaceVerification) {
    throw notFoundError("Namespace verification not found")
  }
  if (namespaceVerification.status !== "verified" || !namespaceVerification.capabilities.club_attach_allowed) {
    throw eligibilityFailed("Namespace verification is not currently attachable")
  }
  if (isExpired(namespaceVerification.expires_at)) {
    throw eligibilityFailed("Namespace verification has expired")
  }

  const useProvisionOperator = shouldUseCommunityProvisionOperator(input.env)
  if (!useProvisionOperator && !allowLocalStubCommunityProvisioning(input.env)) {
    throw internalError("COMMUNITY_PROVISION_OPERATOR_BASE_URL is not configured")
  }

  const dbRoot = useProvisionOperator ? null : resolveCommunityDbRoot(input.env)
  const groupLocation = useProvisionOperator ? requireCommunityProvisionGroupLocation(input.env) : null
  const provisioningMode = useProvisionOperator ? "turso_operator" : "local_stub"
  const registryPublication = getRegistryPublicationAdapter(input.env)
  const existingCommunity = await input.communityRepository.getCommunityByNamespaceVerificationId(
    namespaceVerificationId,
  )
  if (existingCommunity) {
    const existingJob = await input.communityRepository.getLatestCommunityProvisioningJob(existingCommunity.community_id)
    if (!existingJob) {
      throw notFoundError("Existing community provisioning job not found")
    }
    if (existingCommunity.provisioning_state === "active" || existingJob.status !== "failed") {
      return {
        community: await loadCommunityProjection(input.communityRepository, input.userRepository, existingCommunity),
        job: serializeJob(existingJob),
      }
    }
  }

  const createdAt = nowIso()
  const displayName = input.body.display_name.trim()
  const communityId = existingCommunity?.community_id ?? makeId("cmt")
  const bindingId = existingCommunity?.primary_database_binding_id ?? makeId("cdb")
  const jobId = makeId("job")
  const gateRules = (input.body.gate_rules ?? []) as CommunityGateRuleInput[]
  const normalizedGateRules = gateRules.map((rule) => {
    const normalized = normalizeGateRuleInput(rule)
    return {
      scope: rule.scope,
      gateFamily: rule.gate_family,
      gateType: rule.gate_type,
      proofRequirementsJson: normalized.proofRequirementsJson,
      chainNamespace: normalized.chainNamespace,
      gateConfigJson: normalized.gateConfigJson,
    }
  })
  const bindingSeed = useProvisionOperator
    ? buildPendingOperatorBindingSeed({
        communityId,
        location: groupLocation as string,
      })
    : {
        organizationSlug: "local-dev",
        groupName: `club-${communityId}`,
        databaseName: "main",
        databaseUrl: buildLocalCommunityDbUrl(dbRoot as string, communityId),
        location: "local",
        status: "active" as const,
      }
  const publicAttempt = await registryPublication.createCommunityCreateAttempt({
    actorUserId: session.userId,
    actorPrimaryWalletSnapshot,
    actorGovernanceAddressSnapshot,
    namespaceVerificationId,
    normalizedRootLabel: namespaceVerification.normalized_root_label,
    createdAt,
  })
  const registryAttempt = await input.communityRepository.createCommunityRegistryAttempt({
    registryAttemptId: publicAttempt.registryAttemptId,
    actorUserId: session.userId,
    actorPrimaryWalletSnapshot: publicAttempt.actorPrimaryWalletSnapshot,
    actorGovernanceAddressSnapshot: publicAttempt.actorGovernanceAddressSnapshot,
    namespaceVerificationId,
    normalizedRootLabel: namespaceVerification.normalized_root_label,
    createdAt,
  })

  const prepared = await (async () => {
    try {
      return existingCommunity
        ? await input.communityRepository.retryCommunityProvisioningRequest({
            communityId,
            fallbackBindingId: bindingId,
            registryAttemptId: registryAttempt.registry_attempt_id,
            jobId,
            namespaceVerificationId,
            provisioningMode,
            fallbackBindingSeed: bindingSeed,
            createdAt,
          })
        : await input.communityRepository.createCommunityProvisioningRequest({
            communityId,
            communityDatabaseBindingId: bindingId,
            registryAttemptId: registryAttempt.registry_attempt_id,
            jobId,
            creatorUserId: session.userId,
            displayName,
            namespaceVerificationId,
            provisioningMode,
            bindingSeed,
            createdAt,
          })
    } catch (error) {
      await input.communityRepository.markCommunityRegistryAttemptFailed({
        registryAttemptId: registryAttempt.registry_attempt_id,
        failureCode: "community_create_failed",
        updatedAt: nowIso(),
      }).catch(() => {})
      throw error
    }
  })()

  let provisioningCompleted = false
  let provisioningFinalized: { community: CommunityRow; job: JobRow } | null = null

  try {
    if (useProvisionOperator) {
      const provisioned = await provisionCommunityWithOperator(input.env, {
        communityId,
        creatorUserId: session.userId,
        displayName,
        namespaceVerificationId,
        groupLocation: groupLocation as string,
        createdAt,
        bootstrapPayload: {
          description: input.body.description?.trim() || null,
          namespaceLabel: namespaceVerification.normalized_root_label,
          membershipMode: input.body.membership_mode ?? "open",
          defaultAgeGatePolicy: input.body.default_age_gate_policy ?? "none",
          allowAnonymousIdentity: input.body.allow_anonymous_identity ?? false,
          anonymousIdentityScope:
            input.body.allow_anonymous_identity ? (input.body.anonymous_identity_scope ?? null) : null,
          governanceMode: input.body.governance_mode ?? "centralized",
          handlePolicyTemplate: input.body.handle_policy?.policy_template ?? "standard",
          pricingModel: null,
          gateRules: normalizedGateRules,
        },
      })

      const completed = await input.communityRepository.completeCommunityProvisioning({
        communityId,
        communityDatabaseBindingId: prepared.binding.community_database_binding_id,
        jobId: prepared.job.job_id,
        actorUserId: session.userId,
        resultRef: provisioned.databaseUrl,
        createdAt,
        metadata: {
          binding_id: prepared.binding.community_database_binding_id,
          database_url: provisioned.databaseUrl,
          mode: provisioningMode,
          organization_slug: provisioned.organizationSlug,
          group_name: provisioned.groupName,
          database_name: provisioned.databaseName,
          token_name: provisioned.tokenName,
        },
        binding: {
          organizationSlug: provisioned.organizationSlug,
          groupName: provisioned.groupName,
          groupId: provisioned.groupId,
          databaseName: provisioned.databaseName,
          databaseId: provisioned.databaseId,
          databaseUrl: provisioned.databaseUrl,
          location: provisioned.location,
          status: "active",
          createdAt: prepared.binding.created_at,
          updatedAt: createdAt,
        },
        credential: {
          tokenName: provisioned.tokenName,
          plaintextToken: provisioned.plaintextToken,
          encryptionKeyVersion: requireCommunityDbWrapKeyVersion(input.env),
          issuedAt: provisioned.issuedAt,
          expiresAt: provisioned.expiresAt,
          updatedAt: createdAt,
        },
      })

      provisioningFinalized = {
        community: completed.community,
        job: completed.job,
      }
    } else {
      await bootstrapLocalCommunityDb({
        rootDir: dbRoot as string,
        communityId,
        createdByUserId: session.userId,
        displayName,
        description: input.body.description?.trim() || null,
        namespaceVerificationId,
        namespaceLabel: namespaceVerification.normalized_root_label,
        membershipMode: input.body.membership_mode ?? "open",
        defaultAgeGatePolicy: input.body.default_age_gate_policy ?? "none",
        allowAnonymousIdentity: input.body.allow_anonymous_identity ?? false,
        anonymousIdentityScope: input.body.allow_anonymous_identity ? (input.body.anonymous_identity_scope ?? null) : null,
        governanceMode: input.body.governance_mode ?? "centralized",
        handlePolicyTemplate: input.body.handle_policy?.policy_template ?? "standard",
        pricingModel: null,
        gateRules: normalizedGateRules,
        now: createdAt,
      })

      provisioningFinalized = await input.communityRepository.markCommunityProvisioningSucceeded({
        communityId,
        communityDatabaseBindingId: prepared.binding.community_database_binding_id,
        jobId: prepared.job.job_id,
        actorUserId: session.userId,
        resultRef: prepared.binding.database_url,
        createdAt,
        metadata: {
          binding_id: prepared.binding.community_database_binding_id,
          database_url: prepared.binding.database_url,
          mode: provisioningMode,
        },
      })
    }

    provisioningCompleted = true

    const publicationFinalized = await registryPublication.publishCommunityCreate({
      repo: input.communityRepository,
      communityId,
      registryAttemptId: registryAttempt.registry_attempt_id,
      actorUserId: session.userId,
      namespaceVerificationId,
      normalizedRootLabel: namespaceVerification.normalized_root_label,
      canonicalSeed: {
        display_name: displayName,
        description: input.body.description?.trim() || null,
        governance_mode: input.body.governance_mode ?? "centralized",
      },
      createdAt,
    })

    return {
      community: await loadCommunityProjection(input.communityRepository, input.userRepository, publicationFinalized.community),
      job: serializeJob(provisioningFinalized.job),
    }
  } catch (error) {
    const failedAt = nowIso()
    const provisioningErrorCode = useProvisionOperator
      ? "community_provision_operator_failed"
      : "local_stub_bootstrap_failed"

    if (!provisioningCompleted) {
      await input.communityRepository.markCommunityProvisioningFailed({
        communityId,
        jobId: prepared.job.job_id,
        actorUserId: session.userId,
        errorCode: provisioningErrorCode,
        createdAt: failedAt,
        metadata: {
          binding_id: prepared.binding.community_database_binding_id,
          database_url: prepared.binding.database_url,
          mode: provisioningMode,
          message: error instanceof Error ? error.message : String(error),
        },
      }).catch(() => {})

      await input.communityRepository.markCommunityRegistryPublicationFailed({
        communityId,
        registryAttemptId: registryAttempt.registry_attempt_id,
        jobId: null,
        actorUserId: session.userId,
        errorCode: provisioningErrorCode,
        createdAt: failedAt,
        metadata: {
          mode: provisioningMode,
          message: error instanceof Error ? error.message : String(error),
        },
      }).catch(() => {})

      throw internalError("Community provisioning failed")
    }

    const communityRow = await input.communityRepository.getCommunityById(communityId)
    if (!communityRow || !provisioningFinalized) {
      throw internalError("Community registry publication failed")
    }

    return {
      community: await loadCommunityProjection(input.communityRepository, input.userRepository, communityRow),
      job: serializeJob(provisioningFinalized.job),
    }
  }
}

export async function getCommunity(input: {
  communityId: string
  repository: CommunityRepository
  userRepository: UserRepository
}): Promise<Community> {
  const community = await resolveCommunityByReference(input.repository, input.communityId)
  if (!community || community.provisioning_state !== "active" || community.status !== "active") {
    throw notFoundError("Community not found")
  }
  return loadCommunityProjection(input.repository, input.userRepository, community)
}

export async function getCommunityByNamespace(input: {
  namespaceLabel: string
  namespaceLabelPrefixed?: boolean
  repository: CommunityRepository
  userRepository: UserRepository
}): Promise<Community> {
  const normalizedLabel = input.namespaceLabel.trim().replace(/^@+/, "").toLowerCase()
  if (!normalizedLabel) {
    throw notFoundError("Community not found")
  }

  let community = await input.repository.getCommunityByNamespaceLabel({
    normalizedLabel,
    family: "spaces",
  })
  if (!community && !input.namespaceLabelPrefixed) {
    community = await input.repository.getCommunityByRouteKey(normalizedLabel)
  }
  if (!community || community.provisioning_state !== "active" || community.status !== "active") {
    throw notFoundError("Community not found")
  }
  return loadCommunityProjection(input.repository, input.userRepository, community)
}

function assertUpdateCommunityRequest(
  body: unknown,
  input: {
    ageOver18Verified: boolean
  },
): asserts body is UpdateCommunityRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequestError("Invalid community update payload")
  }

  const record = body as Record<string, unknown>
  const allowedKeys = new Set([
    "description",
    "membership_mode",
    "allow_anonymous_identity",
    "anonymous_identity_scope",
    "default_age_gate_policy",
  ])
  const unknownKeys = Object.keys(record).filter((key) => !allowedKeys.has(key))
  if (unknownKeys.length > 0) {
    throw eligibilityFailed(`Unsupported community update fields: ${unknownKeys.join(", ")}`)
  }

  if (record.description !== undefined && record.description !== null && typeof record.description !== "string") {
    throw badRequestError("description must be a string or null")
  }
  if (
    record.membership_mode !== undefined
    && record.membership_mode !== "open"
    && record.membership_mode !== "request"
    && record.membership_mode !== "gated"
  ) {
    throw badRequestError("membership_mode is invalid")
  }
  if (record.allow_anonymous_identity !== undefined && typeof record.allow_anonymous_identity !== "boolean") {
    throw badRequestError("allow_anonymous_identity must be a boolean")
  }
  if (
    record.anonymous_identity_scope !== undefined
    && record.anonymous_identity_scope !== null
    && record.anonymous_identity_scope !== "community_stable"
    && record.anonymous_identity_scope !== "thread_stable"
    && record.anonymous_identity_scope !== "post_ephemeral"
  ) {
    throw badRequestError("anonymous_identity_scope is invalid")
  }
  if (
    record.default_age_gate_policy !== undefined
    && record.default_age_gate_policy !== "none"
    && record.default_age_gate_policy !== "18_plus"
  ) {
    throw badRequestError("default_age_gate_policy is invalid")
  }
  if (record.anonymous_identity_scope === "post_ephemeral") {
    throw eligibilityFailed("post_ephemeral anonymous scope is not allowed in public v0 community updates")
  }
  if (record.allow_anonymous_identity === false && record.anonymous_identity_scope !== undefined && record.anonymous_identity_scope !== null) {
    throw badRequestError("anonymous_identity_scope must be null when allow_anonymous_identity is false")
  }
  if (record.allow_anonymous_identity === true && record.anonymous_identity_scope === undefined) {
    throw badRequestError("anonymous_identity_scope is required when allow_anonymous_identity is true")
  }
  if (record.default_age_gate_policy === "18_plus" && !input.ageOver18Verified) {
    throw eligibilityFailed("age_over_18 verification is required for 18_plus communities")
  }
}

export async function listCommunities(input: {
  env: Env
  bearerToken: string
  repository: CommunityRepository
  userRepository: UserRepository
}): Promise<CommunityListResponse> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  const rows = await input.repository.listCommunitiesByCreatorUserId(session.userId)
  const items = await Promise.all(rows.map((row) => loadCommunityProjection(input.repository, input.userRepository, row)))
  return {
    items,
    next_cursor: null,
  }
}

export async function listDiscoverableCommunities(input: {
  repository: CommunityRepository
  userRepository: UserRepository
  limit?: string | null
}): Promise<CommunityListResponse> {
  const rows = await input.repository.listActiveCommunities()
  const limit = parseCommunityListLimit(input.limit)
  const items: Community[] = []

  for (const row of rows) {
    let local: LocalCommunitySnapshot | null = null
    let memberCount: number | null = null
    let qualifiedMemberCount: number | null = null

    try {
      const db = await openCommunityDb(input.repository, row.community_id)
      try {
        local = await readLocalCommunityWithExecutor(db.client, row.community_id).catch(() => null)
        if (local?.cached_member_count != null && local.cached_qualified_member_count != null) {
          memberCount = local.cached_member_count
          qualifiedMemberCount = local.cached_qualified_member_count
        } else {
          const memberUserIds = await listActiveCommunityMemberUserIds(db.client, row.community_id)
          const users = await input.userRepository.listUsersByIds(memberUserIds)
          const usersById = new Map(users.map((user) => [user.user_id, user]))
          memberCount = memberUserIds.length
          qualifiedMemberCount = 0
          for (const userId of memberUserIds) {
            if (usersById.get(userId)?.verification_capabilities.unique_human.state === "verified") {
              qualifiedMemberCount += 1
            }
          }
        }
      } finally {
        db.close()
      }
    } catch {}
    if (memberCount == null || qualifiedMemberCount == null) {
      memberCount = row.projected_member_count
      qualifiedMemberCount = row.projected_qualified_member_count
    }

    const item = serializeCommunity(
      row,
      local,
      {
        memberCount,
        qualifiedMemberCount,
        communityStage: "initial",
        civicScaleTier: deriveCivicScaleTier(memberCount),
        stageEnteredAt: local?.created_at ?? row.created_at,
      },
      null,
      null,
      null,
      null,
      null,
      null,
    )

    items.push(item)
    items.sort(compareDiscoverableCommunities)
    if (items.length > limit) {
      items.length = limit
    }
  }

  return {
    items,
    next_cursor: null,
  }
}

export async function updateCommunity(input: {
  env: Env
  bearerToken: string
  communityId: string
  body: unknown
  repository: CommunityRepository
  userRepository: UserRepository
}): Promise<Community> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  const user = await input.userRepository.getUserById(session.userId)
  if (!user) {
    throw internalError("Resolved user row is missing for community update")
  }
  assertUpdateCommunityRequest(input.body, {
    ageOver18Verified: user.verification_capabilities.age_over_18.state === "verified",
  })

  const community = await requireOwnedCommunity(input.repository, input.communityId, session.userId)
  const db = await openCommunityDb(input.repository, input.communityId)
  try {
    const updatedAt = nowIso()
    const body = input.body
    const disableAnonymousIdentity = body.allow_anonymous_identity === false
    const local = await updateLocalCommunity({
      databaseUrl: db.databaseUrl,
      communityId: input.communityId,
      description: Object.prototype.hasOwnProperty.call(body, "description")
        ? (body.description == null ? null : body.description.trim())
        : undefined,
      descriptionSet: Object.prototype.hasOwnProperty.call(body, "description"),
      membershipMode: body.membership_mode,
      allowAnonymousIdentity: body.allow_anonymous_identity,
      anonymousIdentityScope: disableAnonymousIdentity ? null : body.anonymous_identity_scope,
      anonymousIdentityScopeSet: disableAnonymousIdentity || Object.prototype.hasOwnProperty.call(body, "anonymous_identity_scope"),
      defaultAgeGatePolicy: body.default_age_gate_policy,
      updatedAt,
    })
    if (!local) {
      throw notFoundError("Community not found")
    }

    const refreshed = await input.repository.markCommunityRegistryStale({
      communityId: input.communityId,
      updatedAt,
    })
    return loadCommunityProjection(input.repository, input.userRepository, refreshed.status ? refreshed : community)
  } finally {
    db.close()
  }
}

function assertCommunityProfileRequest(body: unknown): asserts body is UpdateCommunityProfileRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequestError("Invalid community profile payload")
  }
  const record = body as Record<string, unknown>
  const unknownKeys = Object.keys(record).filter((key) => key !== "rules" && key !== "resource_links")
  if (unknownKeys.length > 0) {
    throw eligibilityFailed(`Unsupported community profile fields: ${unknownKeys.join(", ")}`)
  }
  if (record.rules !== undefined && !Array.isArray(record.rules)) {
    throw badRequestError("rules must be an array")
  }
  if (record.resource_links !== undefined && !Array.isArray(record.resource_links)) {
    throw badRequestError("resource_links must be an array")
  }
}

function assertUpdateCommunityDonationPolicyRequest(body: unknown): asserts body is UpdateCommunityDonationPolicyRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequestError("Invalid community donation policy payload")
  }

  const record = body as Record<string, unknown>
  const unknownKeys = Object.keys(record).filter((key) => !["donation_policy_mode", "donation_partner_id", "donation_partner_status"].includes(key))
  if (unknownKeys.length > 0) {
    throw eligibilityFailed(`Unsupported community donation policy fields: ${unknownKeys.join(", ")}`)
  }

  if (
    record.donation_policy_mode !== "none"
    && record.donation_policy_mode !== "optional_creator_sidecar"
    && record.donation_policy_mode !== "fundraiser_default"
  ) {
    throw badRequestError("donation_policy_mode is invalid")
  }

  if (record.donation_partner_id !== undefined && record.donation_partner_id !== null && typeof record.donation_partner_id !== "string") {
    throw badRequestError("donation_partner_id must be a string or null")
  }

  if (
    record.donation_partner_status !== undefined
    && record.donation_partner_status !== null
    && record.donation_partner_status !== "unconfigured"
    && record.donation_partner_status !== "active"
    && record.donation_partner_status !== "paused"
  ) {
    throw badRequestError("donation_partner_status is invalid")
  }

  const partnerId = typeof record.donation_partner_id === "string" ? record.donation_partner_id.trim() : null
  if (record.donation_policy_mode === "none" && partnerId !== null) {
    throw badRequestError("donation_partner_id must be null when donation_policy_mode is none")
  }
  if (
    (record.donation_policy_mode === "optional_creator_sidecar" || record.donation_policy_mode === "fundraiser_default")
    && partnerId == null
  ) {
    throw badRequestError("donation_partner_id is required when donations are enabled")
  }
}

function assertUpdateCommunityContentAuthenticityPolicyRequest(
  body: unknown,
): asserts body is UpdateCommunityContentAuthenticityPolicyRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequestError("Invalid community content authenticity policy payload")
  }

  const record = body as Record<string, unknown>
  const unknownKeys = Object.keys(record).filter((key) => !["authenticity_stance", "text_policy", "image_policy", "video_policy", "song_policy"].includes(key))
  if (unknownKeys.length > 0) {
    throw eligibilityFailed(`Unsupported community content authenticity policy fields: ${unknownKeys.join(", ")}`)
  }

  if (
    record.authenticity_stance !== "human_only"
    && record.authenticity_stance !== "human_first"
    && record.authenticity_stance !== "ai_allowed_with_disclosure"
    && record.authenticity_stance !== "ai_allowed"
  ) {
    throw badRequestError("authenticity_stance is invalid")
  }

  const assertBooleanRecord = (value: unknown, fieldName: string, requiredKeys: string[]) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw badRequestError(`${fieldName} must be an object`)
    }
    const nested = value as Record<string, unknown>
    const unknownNestedKeys = Object.keys(nested).filter((key) => !requiredKeys.includes(key))
    if (unknownNestedKeys.length > 0) {
      throw eligibilityFailed(`Unsupported ${fieldName} fields: ${unknownNestedKeys.join(", ")}`)
    }
    for (const key of requiredKeys) {
      if (typeof nested[key] !== "boolean") {
        throw badRequestError(`${fieldName}.${key} must be a boolean`)
      }
    }
  }

  assertBooleanRecord(record.text_policy, "text_policy", [
    "allow_ai_assisted_editing",
    "allow_ai_generated",
  ])
  assertBooleanRecord(record.image_policy, "image_policy", [
    "allow_ai_upscale",
    "allow_ai_restoration",
    "allow_generative_editing",
    "allow_ai_generated",
  ])
  assertBooleanRecord(record.video_policy, "video_policy", [
    "allow_ai_upscale",
    "allow_ai_restoration",
    "allow_ai_frame_interpolation",
    "allow_generative_editing",
    "allow_ai_generated",
  ])
  assertBooleanRecord(record.song_policy, "song_policy", [
    "allow_ai_assisted_mastering",
    "allow_ai_stem_separation",
    "allow_ai_generated_instrumentals",
    "allow_ai_generated_lyrics",
    "allow_ai_generated_vocals",
  ])
}

function assertUpdateCommunitySourcePolicyRequest(
  body: unknown,
): asserts body is UpdateCommunitySourcePolicyRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequestError("Invalid community source policy payload")
  }

  const record = body as Record<string, unknown>
  const unknownKeys = Object.keys(record).filter((key) => ![
    "identified_person_media_scope",
    "require_source_url_for_reposts",
    "allow_human_made_fan_art_of_real_people",
    "require_fan_art_disclosure",
  ].includes(key))
  if (unknownKeys.length > 0) {
    throw eligibilityFailed(`Unsupported community source policy fields: ${unknownKeys.join(", ")}`)
  }

  if (
    record.identified_person_media_scope !== "subject_only"
    && record.identified_person_media_scope !== "subject_or_authorized"
    && record.identified_person_media_scope !== "public_source_allowed"
  ) {
    throw badRequestError("identified_person_media_scope is invalid")
  }
  if (typeof record.require_source_url_for_reposts !== "boolean") {
    throw badRequestError("require_source_url_for_reposts must be a boolean")
  }
  if (typeof record.allow_human_made_fan_art_of_real_people !== "boolean") {
    throw badRequestError("allow_human_made_fan_art_of_real_people must be a boolean")
  }
  if (typeof record.require_fan_art_disclosure !== "boolean") {
    throw badRequestError("require_fan_art_disclosure must be a boolean")
  }
}

function assertUpdateCommunityMarketContextPolicyRequest(
  body: unknown,
): asserts body is UpdateCommunityMarketContextPolicyRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequestError("Invalid community market-context policy payload")
  }

  const record = body as Record<string, unknown>
  const unknownKeys = Object.keys(record).filter((key) => ![
    "mode",
    "enabled_post_types",
    "max_markets_per_post",
    "provider_set",
    "market_context_profile_id",
  ].includes(key))
  if (unknownKeys.length > 0) {
    throw eligibilityFailed(`Unsupported community market-context policy fields: ${unknownKeys.join(", ")}`)
  }

  if (record.mode !== "off" && record.mode !== "on") {
    throw badRequestError("mode is invalid")
  }

  if (record.enabled_post_types !== undefined && record.enabled_post_types !== null) {
    if (!Array.isArray(record.enabled_post_types) || record.enabled_post_types.length === 0) {
      throw badRequestError("enabled_post_types must be a non-empty array or null")
    }
    for (const [index, item] of record.enabled_post_types.entries()) {
      if (item !== "link" && item !== "image" && item !== "video") {
        throw badRequestError(`enabled_post_types[${index}] is invalid`)
      }
    }
  }

  if (
    record.max_markets_per_post !== undefined
    && record.max_markets_per_post !== null
    && (!Number.isInteger(record.max_markets_per_post) || Number(record.max_markets_per_post) < 1 || Number(record.max_markets_per_post) > 3)
  ) {
    throw badRequestError("max_markets_per_post must be an integer between 1 and 3 or null")
  }

  if (
    record.provider_set !== undefined
    && record.provider_set !== null
    && record.provider_set !== "platform_default"
    && record.provider_set !== "approved_profile"
  ) {
    throw badRequestError("provider_set is invalid")
  }

  if (
    record.market_context_profile_id !== undefined
    && record.market_context_profile_id !== null
    && (typeof record.market_context_profile_id !== "string" || record.market_context_profile_id.trim().length === 0)
  ) {
    throw badRequestError("market_context_profile_id must be a non-empty string or null")
  }

  const providerSet = record.provider_set ?? "platform_default"
  const profileId = typeof record.market_context_profile_id === "string" ? record.market_context_profile_id.trim() : null
  if (providerSet === "approved_profile" && !profileId) {
    throw badRequestError("market_context_profile_id is required when provider_set is approved_profile")
  }
  if (providerSet === "platform_default" && profileId) {
    throw badRequestError("market_context_profile_id must be null when provider_set is platform_default")
  }
}

function buildResolvedMarketContextProfile(
  providerSet: "platform_default" | "approved_profile",
  marketContextProfileId: string | null,
): CommunityMarketContextPolicy["resolved_profile"] {
  if (providerSet === "approved_profile" && marketContextProfileId) {
    return {
      market_context_profile_id: marketContextProfileId,
      profile_key: marketContextProfileId,
      provider_keys: ["approved_profile"],
      status: "active",
    }
  }
  return {
    market_context_profile_id: "marketctx_default_v0",
    profile_key: "platform-default-v0",
    provider_keys: ["platform_default"],
    status: "active",
  }
}

function assertUpdateCommunityContentAuthenticityDetectionPolicyRequest(
  body: unknown,
): asserts body is UpdateCommunityContentAuthenticityDetectionPolicyRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequestError("Invalid community content authenticity detection policy payload")
  }

  const record = body as Record<string, unknown>
  const unknownKeys = Object.keys(record).filter((key) => !["selection_mode", "authenticity_detection_profile_id"].includes(key))
  if (unknownKeys.length > 0) {
    throw eligibilityFailed(`Unsupported community content authenticity detection policy fields: ${unknownKeys.join(", ")}`)
  }

  if (record.selection_mode !== "platform_default" && record.selection_mode !== "approved_profile") {
    throw badRequestError("selection_mode is invalid")
  }

  if (
    record.authenticity_detection_profile_id !== undefined
    && record.authenticity_detection_profile_id !== null
    && (typeof record.authenticity_detection_profile_id !== "string" || record.authenticity_detection_profile_id.trim().length === 0)
  ) {
    throw badRequestError("authenticity_detection_profile_id must be a non-empty string or null")
  }

  const profileId = typeof record.authenticity_detection_profile_id === "string"
    ? record.authenticity_detection_profile_id.trim()
    : null
  if (record.selection_mode === "approved_profile" && !profileId) {
    throw badRequestError("authenticity_detection_profile_id is required when selection_mode is approved_profile")
  }
  if (record.selection_mode === "platform_default" && profileId) {
    throw badRequestError("authenticity_detection_profile_id must be null when selection_mode is platform_default")
  }
}

function buildResolvedAuthenticityDetectionProfile(
  selectionMode: "platform_default" | "approved_profile",
  authenticityDetectionProfileId: string | null,
): CommunityContentAuthenticityDetectionPolicy["resolved_profile"] {
  if (selectionMode === "approved_profile" && authenticityDetectionProfileId) {
    return {
      authenticity_detection_profile_id: authenticityDetectionProfileId,
      profile_key: authenticityDetectionProfileId,
      provider_key: "approved_profile",
      supported_capabilities: ["image_authenticity", "video_authenticity", "audio_authenticity", "deepfake_detection"],
      status: "active",
    }
  }
  return {
    authenticity_detection_profile_id: "authdet_default_v0",
    profile_key: "platform-default-v0",
    provider_key: "platform_default",
    supported_capabilities: ["image_authenticity", "video_authenticity", "audio_authenticity", "deepfake_detection"],
    status: "active",
  }
}

function assertUpdateCommunityFlairPolicyRequest(
  body: unknown,
): asserts body is UpdateCommunityFlairPolicyRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequestError("Invalid community flair policy payload")
  }

  const record = body as Record<string, unknown>
  const unknownKeys = Object.keys(record).filter((key) => !["flair_enabled", "require_flair_on_top_level_posts", "definitions"].includes(key))
  if (unknownKeys.length > 0) {
    throw eligibilityFailed(`Unsupported community flair policy fields: ${unknownKeys.join(", ")}`)
  }
  if (record.flair_enabled !== undefined && typeof record.flair_enabled !== "boolean") {
    throw badRequestError("flair_enabled must be a boolean")
  }
  if (
    record.require_flair_on_top_level_posts !== undefined
    && typeof record.require_flair_on_top_level_posts !== "boolean"
  ) {
    throw badRequestError("require_flair_on_top_level_posts must be a boolean")
  }
  if (record.definitions !== undefined && !Array.isArray(record.definitions)) {
    throw badRequestError("definitions must be an array")
  }
}

function normalizeCommunityFlairDefinitions(
  input: UpdateCommunityFlairPolicyRequest["definitions"],
): LocalCommunityFlairPolicySnapshot["definitions"] {
  return (input ?? []).map((definition, index) => {
    if (!definition || typeof definition !== "object") {
      throw badRequestError(`definitions[${index}] must be an object`)
    }
    if (typeof definition.label !== "string" || definition.label.trim().length === 0) {
      throw badRequestError(`definitions[${index}].label is required`)
    }
    if (definition.description !== undefined && definition.description !== null && typeof definition.description !== "string") {
      throw badRequestError(`definitions[${index}].description must be a string or null`)
    }
    if (definition.color_token !== undefined && definition.color_token !== null && typeof definition.color_token !== "string") {
      throw badRequestError(`definitions[${index}].color_token must be a string or null`)
    }
    if (!Number.isInteger(definition.position) || Number(definition.position) < 0) {
      throw badRequestError(`definitions[${index}].position must be a non-negative integer`)
    }
    if (
      definition.status !== undefined
      && definition.status !== "active"
      && definition.status !== "archived"
    ) {
      throw badRequestError(`definitions[${index}].status is invalid`)
    }
    if (definition.allowed_post_types !== undefined && definition.allowed_post_types !== null) {
      if (!Array.isArray(definition.allowed_post_types)) {
        throw badRequestError(`definitions[${index}].allowed_post_types must be an array or null`)
      }
      for (const [allowedIndex, postType] of definition.allowed_post_types.entries()) {
        if (postType !== "text" && postType !== "image" && postType !== "video" && postType !== "song") {
          throw badRequestError(`definitions[${index}].allowed_post_types[${allowedIndex}] is invalid`)
        }
      }
    }
    return {
      flair_id: typeof definition.flair_id === "string" && definition.flair_id.trim().length > 0
        ? definition.flair_id.trim()
        : makeLocalCommunityFlairId(),
      label: definition.label.trim(),
      description: definition.description == null ? null : definition.description.trim(),
      color_token: definition.color_token == null ? null : definition.color_token.trim(),
      status: definition.status ?? "active",
      position: Number(definition.position),
      allowed_post_types: definition.allowed_post_types ?? null,
    }
  }).sort((a, b) => a.position - b.position || a.flair_id.localeCompare(b.flair_id))
}

export async function getCommunityDonationPolicy(input: {
  env: Env
  bearerToken: string
  communityId: string
  repository: CommunityRepository
}): Promise<CommunityDonationPolicy> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  await requireOwnedCommunity(input.repository, input.communityId, session.userId)
  const db = await openCommunityDb(input.repository, input.communityId)
  try {
    const local = await readLocalCommunity(db.databaseUrl, input.communityId)
    if (!local) {
      throw notFoundError("Community not found")
    }
    return serializeCommunityDonationPolicy(local)
  } finally {
    db.close()
  }
}

export async function updateCommunityDonationPolicy(input: {
  env: Env
  bearerToken: string
  communityId: string
  body: unknown
  repository: CommunityRepository
}): Promise<CommunityDonationPolicy> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  assertUpdateCommunityDonationPolicyRequest(input.body)
  await requireOwnedCommunity(input.repository, input.communityId, session.userId)

  const db = await openCommunityDb(input.repository, input.communityId)
  try {
    const updatedAt = nowIso()
    const partnerId = input.body.donation_partner_id == null ? null : input.body.donation_partner_id.trim()
    const local = await updateLocalCommunityDonationPolicy({
      databaseUrl: db.databaseUrl,
      communityId: input.communityId,
      donationPartnerId: partnerId,
      donationPolicyMode: input.body.donation_policy_mode,
      donationPartnerStatus: input.body.donation_partner_status === "paused"
        ? "inactive"
        : (input.body.donation_partner_status ?? (partnerId == null ? "unconfigured" : "active")),
      updatedAt,
    })
    if (!local) {
      throw notFoundError("Community not found")
    }
    await input.repository.markCommunityRegistryStale({
      communityId: input.communityId,
      updatedAt,
    })
    return serializeCommunityDonationPolicy(local)
  } finally {
    db.close()
  }
}

export async function getCommunityContentAuthenticityPolicy(input: {
  env: Env
  bearerToken: string
  communityId: string
  repository: CommunityRepository
}): Promise<CommunityContentAuthenticityPolicy> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  const community = await requireOwnedCommunity(input.repository, input.communityId, session.userId)
  const db = await openCommunityDb(input.repository, input.communityId)
  try {
    const local = await readLocalCommunityContentAuthenticityPolicy(db.databaseUrl, input.communityId)
    return resolveCommunityContentAuthenticityPolicy(
      input.communityId,
      local?.updated_at ?? community.created_at,
      local,
    )
  } finally {
    db.close()
  }
}

export async function updateCommunityContentAuthenticityPolicy(input: {
  env: Env
  bearerToken: string
  communityId: string
  body: unknown
  repository: CommunityRepository
}): Promise<CommunityContentAuthenticityPolicy> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  assertUpdateCommunityContentAuthenticityPolicyRequest(input.body)
  await requireOwnedCommunity(input.repository, input.communityId, session.userId)

  const db = await openCommunityDb(input.repository, input.communityId)
  try {
    const updatedAt = nowIso()
    const policy = await updateLocalCommunityContentAuthenticityPolicy({
      databaseUrl: db.databaseUrl,
      communityId: input.communityId,
      policy: {
        community_id: input.communityId,
        policy_origin: "explicit",
        authenticity_stance: input.body.authenticity_stance,
        text_policy: input.body.text_policy,
        image_policy: input.body.image_policy,
        video_policy: input.body.video_policy,
        song_policy: input.body.song_policy,
        updated_at: updatedAt,
      },
      updatedAt,
    })
    if (!policy) {
      throw notFoundError("Community not found")
    }
    await input.repository.markCommunityRegistryStale({
      communityId: input.communityId,
      updatedAt,
    })
    return policy
  } finally {
    db.close()
  }
}

export async function getCommunitySourcePolicy(input: {
  env: Env
  bearerToken: string
  communityId: string
  repository: CommunityRepository
}): Promise<Community["source_policy"]> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  const community = await requireOwnedCommunity(input.repository, input.communityId, session.userId)
  const db = await openCommunityDb(input.repository, input.communityId)
  try {
    const local = await readLocalCommunitySourcePolicy(db.databaseUrl, input.communityId)
    return resolveCommunitySourcePolicy(
      input.communityId,
      local?.updated_at ?? community.created_at,
      local,
    )
  } finally {
    db.close()
  }
}

export async function updateCommunitySourcePolicy(input: {
  env: Env
  bearerToken: string
  communityId: string
  body: unknown
  repository: CommunityRepository
}): Promise<Community["source_policy"]> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  assertUpdateCommunitySourcePolicyRequest(input.body)
  await requireOwnedCommunity(input.repository, input.communityId, session.userId)

  const db = await openCommunityDb(input.repository, input.communityId)
  try {
    const updatedAt = nowIso()
    const policy = await updateLocalCommunitySourcePolicy({
      databaseUrl: db.databaseUrl,
      communityId: input.communityId,
      policy: {
        community_id: input.communityId,
        policy_origin: "explicit",
        identified_person_media_scope: input.body.identified_person_media_scope,
        require_source_url_for_reposts: input.body.require_source_url_for_reposts,
        allow_human_made_fan_art_of_real_people: input.body.allow_human_made_fan_art_of_real_people,
        require_fan_art_disclosure: input.body.require_fan_art_disclosure,
        updated_at: updatedAt,
      },
      updatedAt,
    })
    if (!policy) {
      throw notFoundError("Community not found")
    }
    await input.repository.markCommunityRegistryStale({
      communityId: input.communityId,
      updatedAt,
    })
    return policy
  } finally {
    db.close()
  }
}

export async function getCommunityMarketContextPolicy(input: {
  env: Env
  bearerToken: string
  communityId: string
  repository: CommunityRepository
}): Promise<CommunityMarketContextPolicy> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  const community = await requireOwnedCommunity(input.repository, input.communityId, session.userId)
  const db = await openCommunityDb(input.repository, input.communityId)
  try {
    const local = await readLocalCommunityMarketContextPolicy(db.databaseUrl, input.communityId)
    return resolveCommunityMarketContextPolicy(
      input.communityId,
      local?.updated_at ?? community.created_at,
      local,
    )
  } finally {
    db.close()
  }
}

export async function updateCommunityMarketContextPolicy(input: {
  env: Env
  bearerToken: string
  communityId: string
  body: unknown
  repository: CommunityRepository
}): Promise<CommunityMarketContextPolicy> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  assertUpdateCommunityMarketContextPolicyRequest(input.body)
  await requireOwnedCommunity(input.repository, input.communityId, session.userId)

  const db = await openCommunityDb(input.repository, input.communityId)
  try {
    const updatedAt = nowIso()
    const providerSet = input.body.provider_set ?? "platform_default"
    const marketContextProfileId = input.body.market_context_profile_id == null ? null : input.body.market_context_profile_id.trim()
    const policy = await updateLocalCommunityMarketContextPolicy({
      databaseUrl: db.databaseUrl,
      communityId: input.communityId,
      policy: {
        community_id: input.communityId,
        policy_origin: "explicit",
        mode: input.body.mode,
        enabled_post_types: input.body.enabled_post_types ?? ["link"],
        max_markets_per_post: input.body.max_markets_per_post ?? 1,
        provider_set: providerSet,
        market_context_profile_id: marketContextProfileId,
        resolved_profile: buildResolvedMarketContextProfile(providerSet, marketContextProfileId),
        updated_at: updatedAt,
      },
      updatedAt,
    })
    if (!policy) {
      throw notFoundError("Community not found")
    }
    await input.repository.markCommunityRegistryStale({
      communityId: input.communityId,
      updatedAt,
    })
    return policy
  } finally {
    db.close()
  }
}

export async function getCommunityContentAuthenticityDetectionPolicy(input: {
  env: Env
  bearerToken: string
  communityId: string
  repository: CommunityRepository
}): Promise<CommunityContentAuthenticityDetectionPolicy> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  const community = await requireOwnedCommunity(input.repository, input.communityId, session.userId)
  const db = await openCommunityDb(input.repository, input.communityId)
  try {
    const local = await readLocalCommunityContentAuthenticityDetectionPolicy(db.databaseUrl, input.communityId)
    return resolveCommunityContentAuthenticityDetectionPolicy(
      input.communityId,
      local?.updated_at ?? community.created_at,
      local,
    )
  } finally {
    db.close()
  }
}

export async function updateCommunityContentAuthenticityDetectionPolicy(input: {
  env: Env
  bearerToken: string
  communityId: string
  body: unknown
  repository: CommunityRepository
}): Promise<CommunityContentAuthenticityDetectionPolicy> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  assertUpdateCommunityContentAuthenticityDetectionPolicyRequest(input.body)
  await requireOwnedCommunity(input.repository, input.communityId, session.userId)

  const db = await openCommunityDb(input.repository, input.communityId)
  try {
    const updatedAt = nowIso()
    const profileId = input.body.authenticity_detection_profile_id == null ? null : input.body.authenticity_detection_profile_id.trim()
    const policy = await updateLocalCommunityContentAuthenticityDetectionPolicy({
      databaseUrl: db.databaseUrl,
      communityId: input.communityId,
      policy: {
        community_id: input.communityId,
        policy_origin: "explicit",
        selection_mode: input.body.selection_mode,
        authenticity_detection_profile_id: profileId,
        resolved_profile: buildResolvedAuthenticityDetectionProfile(input.body.selection_mode, profileId),
        updated_at: updatedAt,
      },
      updatedAt,
    })
    if (!policy) {
      throw notFoundError("Community not found")
    }
    await input.repository.markCommunityRegistryStale({
      communityId: input.communityId,
      updatedAt,
    })
    return policy
  } finally {
    db.close()
  }
}

export async function getCommunityFlairPolicy(input: {
  env: Env
  bearerToken: string
  communityId: string
  repository: CommunityRepository
}): Promise<CommunityFlairPolicy> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  await requireOwnedCommunity(input.repository, input.communityId, session.userId)
  const db = await openCommunityDb(input.repository, input.communityId)
  try {
    const local = await readLocalCommunityFlairPolicy(db.databaseUrl, input.communityId)
    if (!local) {
      throw notFoundError("Community not found")
    }
    return resolveCommunityFlairPolicy(local)
  } finally {
    db.close()
  }
}

export async function updateCommunityFlairPolicy(input: {
  env: Env
  bearerToken: string
  communityId: string
  body: unknown
  repository: CommunityRepository
}): Promise<CommunityFlairPolicy> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  assertUpdateCommunityFlairPolicyRequest(input.body)
  await requireOwnedCommunity(input.repository, input.communityId, session.userId)

  const db = await openCommunityDb(input.repository, input.communityId)
  try {
    const updatedAt = nowIso()
    const existing = await readLocalCommunityFlairPolicy(db.databaseUrl, input.communityId)
    if (!existing) {
      throw notFoundError("Community not found")
    }
    const policy = await updateLocalCommunityFlairPolicy({
      databaseUrl: db.databaseUrl,
      communityId: input.communityId,
      policy: {
        flair_enabled: input.body.flair_enabled ?? existing.flair_enabled,
        require_flair_on_top_level_posts: input.body.require_flair_on_top_level_posts ?? existing.require_flair_on_top_level_posts,
        definitions: input.body.definitions !== undefined
          ? normalizeCommunityFlairDefinitions(input.body.definitions)
          : existing.definitions,
      },
      updatedAt,
    })
    if (!policy) {
      throw notFoundError("Community not found")
    }
    await input.repository.markCommunityRegistryStale({
      communityId: input.communityId,
      updatedAt,
    })
    return policy
  } finally {
    db.close()
  }
}

function normalizeCommunityRules(input: UpdateCommunityProfileRequest["rules"]): CommunityRule[] {
  return (input ?? []).map((rule, index) => {
    if (!rule || typeof rule !== "object") {
      throw badRequestError(`rules[${index}] must be an object`)
    }
    if (typeof rule.title !== "string" || rule.title.trim().length === 0) {
      throw badRequestError(`rules[${index}].title is required`)
    }
    if (typeof rule.body !== "string" || rule.body.trim().length === 0) {
      throw badRequestError(`rules[${index}].body is required`)
    }
    if (!Number.isInteger(rule.position) || Number(rule.position) < 0) {
      throw badRequestError(`rules[${index}].position must be a non-negative integer`)
    }
    const position = Number(rule.position)
    if (rule.status !== undefined && rule.status !== "active" && rule.status !== "archived") {
      throw badRequestError(`rules[${index}].status is invalid`)
    }
    return {
      rule_id: typeof rule.rule_id === "string" && rule.rule_id.trim().length > 0 ? rule.rule_id.trim() : makeLocalCommunityRuleId(),
      title: rule.title.trim(),
      body: rule.body.trim(),
      position,
      status: rule.status ?? "active",
    }
  }).sort((a, b) => a.position - b.position || a.rule_id.localeCompare(b.rule_id))
}

function normalizeCommunityResourceLinks(input: UpdateCommunityProfileRequest["resource_links"]): CommunityResourceLink[] {
  return (input ?? []).map((link, index) => {
    if (!link || typeof link !== "object") {
      throw badRequestError(`resource_links[${index}] must be an object`)
    }
    if (typeof link.label !== "string" || link.label.trim().length === 0) {
      throw badRequestError(`resource_links[${index}].label is required`)
    }
    if (typeof link.url !== "string" || link.url.trim().length === 0) {
      throw badRequestError(`resource_links[${index}].url is required`)
    }
    try {
      new URL(link.url)
    } catch {
      throw badRequestError(`resource_links[${index}].url must be a valid absolute URL`)
    }
    if (
      link.resource_kind !== "link"
      && link.resource_kind !== "playlist"
      && link.resource_kind !== "document"
      && link.resource_kind !== "discord"
      && link.resource_kind !== "website"
      && link.resource_kind !== "other"
    ) {
      throw badRequestError(`resource_links[${index}].resource_kind is invalid`)
    }
    if (!Number.isInteger(link.position) || Number(link.position) < 0) {
      throw badRequestError(`resource_links[${index}].position must be a non-negative integer`)
    }
    const position = Number(link.position)
    if (link.status !== undefined && link.status !== "active" && link.status !== "archived") {
      throw badRequestError(`resource_links[${index}].status is invalid`)
    }
    return {
      resource_link_id: typeof link.resource_link_id === "string" && link.resource_link_id.trim().length > 0
        ? link.resource_link_id.trim()
        : makeLocalCommunityResourceLinkId(),
      label: link.label.trim(),
      url: link.url.trim(),
      resource_kind: link.resource_kind,
      position,
      status: link.status ?? "active",
    }
  }).sort((a, b) => a.position - b.position || a.resource_link_id.localeCompare(b.resource_link_id))
}

export async function getCommunityProfile(input: {
  env: Env
  bearerToken: string
  communityId: string
  repository: CommunityRepository
}): Promise<CommunityProfile> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  await requireOwnedCommunity(input.repository, input.communityId, session.userId)
  const db = await openCommunityDb(input.repository, input.communityId)
  try {
    const profile = await readLocalCommunityProfile(db.databaseUrl, input.communityId)
    if (!profile) {
      throw notFoundError("Community not found")
    }
    return profile
  } finally {
    db.close()
  }
}

export async function updateCommunityProfile(input: {
  env: Env
  bearerToken: string
  communityId: string
  body: unknown
  repository: CommunityRepository
}): Promise<CommunityProfile> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  assertCommunityProfileRequest(input.body)
  await requireOwnedCommunity(input.repository, input.communityId, session.userId)

  const db = await openCommunityDb(input.repository, input.communityId)
  try {
    const updatedAt = nowIso()
    const profile = await updateLocalCommunityProfile({
      databaseUrl: db.databaseUrl,
      communityId: input.communityId,
      profile: {
        rules: normalizeCommunityRules(input.body.rules),
        resource_links: normalizeCommunityResourceLinks(input.body.resource_links),
      },
      updatedAt,
    })
    if (!profile) {
      throw notFoundError("Community not found")
    }
    await input.repository.markCommunityRegistryStale({
      communityId: input.communityId,
      updatedAt,
    })
    return profile
  } finally {
    db.close()
  }
}

const VALID_REFERENCE_LINK_PLATFORMS = new Set<CommunityReferenceLinkPlatform>([
  "musicbrainz",
  "genius",
  "spotify",
  "apple_music",
  "wikipedia",
  "instagram",
  "tiktok",
  "x",
  "official_website",
  "youtube",
  "bandcamp",
  "soundcloud",
  "other",
])

function normalizeReferenceLinkUrl(value: string): string {
  try {
    return new URL(value).toString()
  } catch {
    throw badRequestError("url must be a valid absolute URL")
  }
}

function resolveReferenceLinkVerificationApplicability(platform: CommunityReferenceLinkPlatform): "eligible" | "not_applicable" {
  return platform === "other" ? "not_applicable" : "eligible"
}

function emptyReferenceLinkMetadata(): CommunityReferenceLinkMetadata {
  return {}
}

function assertCreateCommunityReferenceLinkRequest(body: unknown): asserts body is CreateCommunityReferenceLinkRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequestError("Invalid community reference link payload")
  }
  const record = body as Record<string, unknown>
  if (!VALID_REFERENCE_LINK_PLATFORMS.has(record.platform as CommunityReferenceLinkPlatform)) {
    throw badRequestError("platform is invalid")
  }
  if (typeof record.url !== "string" || record.url.trim().length === 0) {
    throw badRequestError("url is required")
  }
  if (record.label !== undefined && record.label !== null && typeof record.label !== "string") {
    throw badRequestError("label must be a string or null")
  }
  if (record.position !== undefined && record.position !== null && (!Number.isInteger(record.position) || Number(record.position) < 0)) {
    throw badRequestError("position must be a non-negative integer or null")
  }
}

function assertUpdateCommunityReferenceLinkRequest(body: unknown): asserts body is UpdateCommunityReferenceLinkRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequestError("Invalid community reference link update payload")
  }
  const record = body as Record<string, unknown>
  if (
    Object.keys(record).some((key) => !["platform", "url", "label", "position"].includes(key))
  ) {
    throw eligibilityFailed("Unsupported reference link update fields")
  }
  if (record.platform !== undefined && !VALID_REFERENCE_LINK_PLATFORMS.has(record.platform as CommunityReferenceLinkPlatform)) {
    throw badRequestError("platform is invalid")
  }
  if (record.url !== undefined && (typeof record.url !== "string" || record.url.trim().length === 0)) {
    throw badRequestError("url must be a non-empty string")
  }
  if (record.label !== undefined && record.label !== null && typeof record.label !== "string") {
    throw badRequestError("label must be a string or null")
  }
  if (record.position !== undefined && record.position !== null && (!Number.isInteger(record.position) || Number(record.position) < 0)) {
    throw badRequestError("position must be a non-negative integer or null")
  }
}

export async function listCommunityReferenceLinks(input: {
  env: Env
  bearerToken: string
  communityId: string
  repository: CommunityRepository
}): Promise<{ items: CommunityReferenceLinkAdmin[] }> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  await requireOwnedCommunity(input.repository, input.communityId, session.userId)
  const db = await openCommunityDb(input.repository, input.communityId)
  try {
    const links = await readLocalCommunityReferenceLinks(db.databaseUrl, input.communityId)
    if (!links) {
      throw notFoundError("Community not found")
    }
    return {
      items: [...links].sort((a, b) => a.position - b.position || a.community_reference_link_id.localeCompare(b.community_reference_link_id)),
    }
  } finally {
    db.close()
  }
}

export async function getCommunityReferenceLink(input: {
  env: Env
  bearerToken: string
  communityId: string
  communityReferenceLinkId: string
  repository: CommunityRepository
}): Promise<CommunityReferenceLinkAdmin> {
  const listed = await listCommunityReferenceLinks({
    env: input.env,
    bearerToken: input.bearerToken,
    communityId: input.communityId,
    repository: input.repository,
  })
  const match = listed.items.find((item) => item.community_reference_link_id === input.communityReferenceLinkId)
  if (!match) {
    throw notFoundError("Community reference link not found")
  }
  return match
}

export async function createCommunityReferenceLink(input: {
  env: Env
  bearerToken: string
  communityId: string
  body: unknown
  repository: CommunityRepository
}): Promise<CommunityReferenceLinkAdmin> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  assertCreateCommunityReferenceLinkRequest(input.body)
  await requireOwnedCommunity(input.repository, input.communityId, session.userId)
  const db = await openCommunityDb(input.repository, input.communityId)
  try {
    const updatedAt = nowIso()
    const existing = await readLocalCommunityReferenceLinks(db.databaseUrl, input.communityId)
    if (!existing) {
      throw notFoundError("Community not found")
    }
    const normalizedUrl = normalizeReferenceLinkUrl(input.body.url)
    const nextPosition = input.body.position ?? existing.length
    const created: CommunityReferenceLinkAdmin = {
      community_reference_link_id: makeLocalCommunityReferenceLinkId(),
      community_id: input.communityId,
      platform: input.body.platform,
      url: input.body.url.trim(),
      normalized_url: normalizedUrl,
      external_id: null,
      label: input.body.label == null ? null : input.body.label.trim() || null,
      link_status: "active",
      verification_applicability: resolveReferenceLinkVerificationApplicability(input.body.platform),
      verification_state: resolveReferenceLinkVerificationApplicability(input.body.platform) === "eligible" ? "unverified" : null,
      verification_method: null,
      verified_at: null,
      last_verification_checked_at: null,
      active_proof_id: null,
      metadata: emptyReferenceLinkMetadata(),
      position: nextPosition,
      created_at: updatedAt,
      updated_at: updatedAt,
    }
    const nextLinks = [...existing, created].sort((a, b) => a.position - b.position || a.community_reference_link_id.localeCompare(b.community_reference_link_id))
    await updateLocalCommunityReferenceLinks({
      databaseUrl: db.databaseUrl,
      communityId: input.communityId,
      referenceLinks: nextLinks,
      updatedAt,
    })
    await input.repository.markCommunityRegistryStale({
      communityId: input.communityId,
      updatedAt,
    })
    return created
  } finally {
    db.close()
  }
}

export async function updateCommunityReferenceLink(input: {
  env: Env
  bearerToken: string
  communityId: string
  communityReferenceLinkId: string
  body: unknown
  repository: CommunityRepository
}): Promise<CommunityReferenceLinkAdmin> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  assertUpdateCommunityReferenceLinkRequest(input.body)
  await requireOwnedCommunity(input.repository, input.communityId, session.userId)
  const db = await openCommunityDb(input.repository, input.communityId)
  try {
    const updatedAt = nowIso()
    const existing = await readLocalCommunityReferenceLinks(db.databaseUrl, input.communityId)
    if (!existing) {
      throw notFoundError("Community not found")
    }
    const current = existing.find((item) => item.community_reference_link_id === input.communityReferenceLinkId)
    if (!current) {
      throw notFoundError("Community reference link not found")
    }
    const platform = input.body.platform ?? current.platform
    const next: CommunityReferenceLinkAdmin = {
      ...current,
      platform,
      url: input.body.url !== undefined ? input.body.url.trim() : current.url,
      normalized_url: input.body.url !== undefined ? normalizeReferenceLinkUrl(input.body.url) : current.normalized_url,
      label: input.body.label !== undefined ? (input.body.label == null ? null : input.body.label.trim() || null) : current.label,
      position: input.body.position ?? current.position,
      verification_applicability: resolveReferenceLinkVerificationApplicability(platform),
      verification_state: resolveReferenceLinkVerificationApplicability(platform) === "eligible" ? current.verification_state ?? "unverified" : null,
      updated_at: updatedAt,
    }
    const nextLinks = existing
      .map((item) => item.community_reference_link_id === input.communityReferenceLinkId ? next : item)
      .sort((a, b) => a.position - b.position || a.community_reference_link_id.localeCompare(b.community_reference_link_id))
    await updateLocalCommunityReferenceLinks({
      databaseUrl: db.databaseUrl,
      communityId: input.communityId,
      referenceLinks: nextLinks,
      updatedAt,
    })
    await input.repository.markCommunityRegistryStale({
      communityId: input.communityId,
      updatedAt,
    })
    return next
  } finally {
    db.close()
  }
}

export async function archiveCommunityReferenceLink(input: {
  env: Env
  bearerToken: string
  communityId: string
  communityReferenceLinkId: string
  repository: CommunityRepository
}): Promise<CommunityReferenceLinkAdmin> {
  return updateCommunityReferenceLink({
    env: input.env,
    bearerToken: input.bearerToken,
    communityId: input.communityId,
    communityReferenceLinkId: input.communityReferenceLinkId,
    body: {},
    repository: input.repository,
  }).then(async (current) => {
    const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
    await requireOwnedCommunity(input.repository, input.communityId, session.userId)
    const db = await openCommunityDb(input.repository, input.communityId)
    try {
      const updatedAt = nowIso()
      const existing = await readLocalCommunityReferenceLinks(db.databaseUrl, input.communityId)
      if (!existing) {
        throw notFoundError("Community not found")
      }
      const archived = {
        ...current,
        link_status: "archived" as const,
        updated_at: updatedAt,
      }
      const nextLinks = existing.map((item) => item.community_reference_link_id === input.communityReferenceLinkId ? archived : item)
      await updateLocalCommunityReferenceLinks({
        databaseUrl: db.databaseUrl,
        communityId: input.communityId,
        referenceLinks: nextLinks,
        updatedAt,
      })
      await input.repository.markCommunityRegistryStale({
        communityId: input.communityId,
        updatedAt,
      })
      return archived
    } finally {
      db.close()
    }
  })
}

export { joinCommunity, listMembershipRequests, approveMembershipRequest, rejectMembershipRequest } from "./community-membership-service"

export async function getJob(input: {
  env: Env
  bearerToken: string
  jobId: string
  repository: CommunityRepository
}): Promise<Job> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  const job = await input.repository.getJobById(input.jobId)
  if (!job) {
    throw notFoundError("Job not found")
  }
  if (!job.community_id) {
    throw notFoundError("Job not found")
  }
  await requireOwnedCommunity(input.repository, job.community_id, session.userId)
  return serializeJob(job)
}
