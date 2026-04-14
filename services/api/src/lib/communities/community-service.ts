import {
  bootstrapLocalCommunityDb,
  buildLocalCommunityDbUrl,
  readLocalCommunity,
  type LocalCommunitySnapshot,
} from "./community-local-db"
import {
  canAccessCommunity,
  getCommunityJoinMode,
  getCommunityMembershipState,
  listActiveMembershipGateRules,
  satisfiesMembershipGateRules,
  upsertCommunityMembership,
  upsertMembershipRequest,
} from "./community-membership-store"
import { openCommunityDb } from "./community-db-factory"
import type { UserRepository } from "../auth/repositories"
import type { CommunityRow, JobRow } from "../auth/control-plane-auth-rows"
import type { CommunityRepository } from "./control-plane-community-repository"
import { badRequestError, eligibilityFailed, gateFailed, internalError, notFoundError } from "../errors"
import { envFlag, makeId, nowIso } from "../helpers"
import { verifyPirateAccessToken } from "../auth/pirate-session-token"
import { getRegistryPublicationAdapter } from "./registry-publication"
import type { VerificationRepository } from "../verification/control-plane-verification-repository"
import type {
  Community,
  CommunityCreateAcceptedResponse,
  CreateCommunityRequest,
  Env,
  Job,
  User,
} from "../../types"

export type CreateCommunityRequestBody = CreateCommunityRequest
type MembershipResult = {
  community_id: string
  status: "joined" | "requested" | "left"
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

function serializeCommunity(row: CommunityRow, local: LocalCommunitySnapshot | null): Community {
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
    governance_mode: local?.governance_mode ?? "centralized",
    donation_policy_mode: local?.donation_policy_mode ?? "none",
    donation_partner_status: donationPartnerStatus,
    default_age_gate_policy: defaultAgeGatePolicy,
    content_authenticity_policy: buildDefaultContentAuthenticityPolicy(row.community_id, policyUpdatedAt),
    content_authenticity_detection_policy: buildDefaultContentAuthenticityDetectionPolicy(row.community_id, policyUpdatedAt),
    market_context_policy: buildDefaultMarketContextPolicy(row.community_id, policyUpdatedAt),
    source_policy: buildDefaultSourcePolicy(row.community_id, policyUpdatedAt),
    capture_edit_policy: buildDefaultCaptureEditPolicy(row.community_id, policyUpdatedAt),
    adult_content_policy: buildDefaultAdultContentPolicy(row.community_id, policyUpdatedAt, defaultAgeGatePolicy),
    graphic_content_policy: buildDefaultGraphicContentPolicy(row.community_id, policyUpdatedAt),
    motion_media_policy: buildDefaultMotionMediaPolicy(row.community_id, policyUpdatedAt),
    language_policy: buildDefaultLanguagePolicy(row.community_id, policyUpdatedAt),
    provenance_policy: buildDefaultProvenancePolicy(row.community_id, policyUpdatedAt),
    promotion_policy: buildDefaultPromotionPolicy(row.community_id, policyUpdatedAt),
    created_by_user_id: row.creator_user_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
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
  if (
    body.gate_rules?.some(
      (rule) => rule.gate_family === "token_holding" || rule.scope === "viewer" || rule.scope === "posting",
    )
  ) {
    throw eligibilityFailed("Public v0 community creation only allows membership-scope identity-proof gates")
  }
  for (const rule of body.gate_rules ?? []) {
    for (const requirement of rule.proof_requirements ?? []) {
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
  communityRow: CommunityRow,
): Promise<Community> {
  const binding = await repo.getPrimaryCommunityDatabaseBinding(communityRow.community_id)
  const local = binding ? await readLocalCommunity(binding.database_url, communityRow.community_id).catch(() => null) : null
  return serializeCommunity(communityRow, local)
}

function isExpired(isoTimestamp: string): boolean {
  const expiresAt = Date.parse(isoTimestamp)
  if (!Number.isFinite(expiresAt)) {
    throw eligibilityFailed("Namespace verification expiry is invalid")
  }
  return expiresAt <= Date.now()
}

function satisfiesBaselineJoinGate(user: User): boolean {
  if (user.verification_capabilities.unique_human.state === "verified") {
    return true
  }

  return user.verification_capabilities.wallet_score.state === "verified"
    && user.verification_capabilities.wallet_score.provider === "passport"
    && user.verification_capabilities.wallet_score.passing_score === true
}

async function requireOwnedCommunity(
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

  const dbRoot = resolveCommunityDbRoot(input.env)
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
        community: await loadCommunityProjection(input.communityRepository, existingCommunity),
        job: serializeJob(existingJob),
      }
    }
  }

  const createdAt = nowIso()
  const displayName = input.body.display_name.trim()
  const communityId = existingCommunity?.community_id ?? makeId("cmt")
  const bindingId = existingCommunity?.primary_database_binding_id ?? makeId("cdb")
  const jobId = makeId("job")
  const databaseUrl = buildLocalCommunityDbUrl(dbRoot, communityId)
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
            databaseUrl,
            createdAt,
          })
        : await input.communityRepository.createCommunityProvisioningRequest({
            communityId,
            communityDatabaseBindingId: bindingId,
            registryAttemptId: registryAttempt.registry_attempt_id,
            jobId,
            creatorUserId: session.userId,
            displayName,
            membershipMode: input.body.membership_mode ?? "open",
            namespaceVerificationId,
            databaseUrl,
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
  let localSnapshot: LocalCommunitySnapshot | null = null

  try {
    localSnapshot = await bootstrapLocalCommunityDb({
      rootDir: dbRoot,
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
      gateRules: (input.body.gate_rules ?? []).map((rule) => ({
        scope: rule.scope,
        gateFamily: rule.gate_family,
        gateType: rule.gate_type,
        proofRequirementsJson: rule.proof_requirements ? JSON.stringify(rule.proof_requirements) : null,
        chainNamespace: rule.chain_namespace ?? null,
        gateConfigJson: rule.gate_config ? JSON.stringify(rule.gate_config) : null,
      })),
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
        mode: "local_stub",
      },
    })
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
      community: serializeCommunity(publicationFinalized.community, localSnapshot),
      job: serializeJob(provisioningFinalized.job),
    }
  } catch (error) {
    const failedAt = nowIso()

    if (!provisioningCompleted) {
      await input.communityRepository.markCommunityProvisioningFailed({
        communityId,
        jobId: prepared.job.job_id,
        actorUserId: session.userId,
        errorCode: "local_stub_bootstrap_failed",
        createdAt: failedAt,
        metadata: {
          binding_id: prepared.binding.community_database_binding_id,
          database_url: prepared.binding.database_url,
          message: error instanceof Error ? error.message : String(error),
        },
      }).catch(() => {})

      await input.communityRepository.markCommunityRegistryPublicationFailed({
        communityId,
        registryAttemptId: registryAttempt.registry_attempt_id,
        jobId: null,
        actorUserId: session.userId,
        errorCode: "local_stub_bootstrap_failed",
        createdAt: failedAt,
        metadata: {
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
      community: serializeCommunity(communityRow, localSnapshot),
      job: serializeJob(provisioningFinalized.job),
    }
  }
}

export async function getCommunity(input: {
  env: Env
  bearerToken: string
  communityId: string
  repository: CommunityRepository
}): Promise<Community> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  const community = await requireOwnedCommunity(input.repository, input.communityId, session.userId)
  return loadCommunityProjection(input.repository, community)
}

export async function joinCommunity(input: {
  env: Env
  bearerToken: string
  communityId: string
  userRepository: UserRepository
  communityRepository: CommunityRepository
}): Promise<MembershipResult> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  const user = await input.userRepository.getUserById(session.userId)
  if (!user) {
    throw internalError("Resolved user row is missing for community join")
  }
  if (!satisfiesBaselineJoinGate(user)) {
    throw gateFailed("A platform trust credential is required to join this community")
  }

  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!community || community.provisioning_state !== "active" || community.status !== "active") {
    throw notFoundError("Community not found")
  }

  const db = await openCommunityDb(input.communityRepository, input.communityId)
  try {
    const membership = await getCommunityMembershipState(db.client, input.communityId, session.userId)
    if (canAccessCommunity(membership)) {
      return {
        community_id: input.communityId,
        status: "joined",
      }
    }
    if (membership.membership_status === "banned") {
      throw gateFailed("Community membership is not available for this account")
    }

    const membershipMode = await getCommunityJoinMode(db.client, input.communityId)
    if (!membershipMode) {
      throw notFoundError("Community not found")
    }

    const now = nowIso()
    if (membershipMode === "open") {
      await upsertCommunityMembership({
        client: db.client,
        communityId: input.communityId,
        userId: session.userId,
        now,
      })
      return {
        community_id: input.communityId,
        status: "joined",
      }
    }

    if (membershipMode === "request") {
      await upsertMembershipRequest({
        client: db.client,
        communityId: input.communityId,
        userId: session.userId,
        now,
      })
      return {
        community_id: input.communityId,
        status: "requested",
      }
    }

    const rules = await listActiveMembershipGateRules(db.client, input.communityId)
    if (!satisfiesMembershipGateRules(rules, user)) {
      throw gateFailed("Community membership requirements are not satisfied")
    }
    await upsertCommunityMembership({
      client: db.client,
      communityId: input.communityId,
      userId: session.userId,
      now,
    })
    return {
      community_id: input.communityId,
      status: "joined",
    }
  } finally {
    db.close()
  }
}

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
