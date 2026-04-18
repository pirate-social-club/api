import {
  bootstrapLocalCommunityDb,
  buildLocalCommunityDbUrl,
  type LocalCommunityRule,
  type LocalCommunitySnapshot,
} from "./community-local-db"
import { normalizeCommunityMediaRef } from "./community-identity-media"
import { openCommunityDb } from "./community-db-factory"
import { encryptCommunityDbCredential } from "./community-db-credential-crypto"
import {
  isCommunityProvisionOperatorConfigured,
  provisionCommunityViaOperator,
} from "./community-provision-operator-client"
import type { UserRepository } from "../auth/repositories"
import type { CommunityDatabaseBindingRow, CommunityRow, JobRow } from "../auth/auth-db-rows"
import type { CommunityRepository } from "./db-community-repository"
import { badRequestError, eligibilityFailed, internalError, notFoundError } from "../errors"
import { makeId, nowIso } from "../helpers"
import { getRegistryPublicationAdapter } from "./registry-publication"
import type { VerificationRepository } from "../verification/control-plane-verification-repository"
import type {
  Community,
  CommunityCreateAcceptedResponse,
  CreateCommunityRequest,
  Env,
  User,
} from "../../types"
import { serializeCommunity, serializeJob, getPrimaryWalletSnapshot } from "./community-serialization"

export type CreateCommunityRequestBody = CreateCommunityRequest

export type UpdateCommunityRulesRequestBody = {
  rules: Array<{
    rule_id?: string | null
    title: string
    body: string
    report_reason?: string | null
    position?: number | null
    status?: "active" | "archived" | null
  }>
}

export type UpdateCommunitySafetyRequestBody = {
  adult_content_policy: {
    suggestive: Community["adult_content_policy"]["suggestive"]
    artistic_nudity: Community["adult_content_policy"]["artistic_nudity"]
    explicit_nudity: Community["adult_content_policy"]["explicit_nudity"]
    explicit_sexual_content: Community["adult_content_policy"]["explicit_sexual_content"]
    fetish_content: Community["adult_content_policy"]["fetish_content"]
  }
  graphic_content_policy: {
    injury_medical: Community["graphic_content_policy"]["injury_medical"]
    gore: Community["graphic_content_policy"]["gore"]
    extreme_gore: Community["graphic_content_policy"]["extreme_gore"]
    body_horror_disturbing: Community["graphic_content_policy"]["body_horror_disturbing"]
    animal_harm: Community["graphic_content_policy"]["animal_harm"]
  }
  civility_policy: {
    group_directed_demeaning_language: Community["civility_policy"]["group_directed_demeaning_language"]
    targeted_insults: Community["civility_policy"]["targeted_insults"]
    targeted_harassment: Community["civility_policy"]["targeted_harassment"]
    threatening_language: Community["civility_policy"]["threatening_language"]
  }
  openai_moderation_settings: NonNullable<Community["openai_moderation_settings"]>
}

export type UpdateGateRuleInput = CreateCommunityRequestBody["gate_rules"] extends
  Array<infer T> | null | undefined
  ? Array<T & { gate_rule_id?: string | null }>
  : never

export type UpdateCommunityGatesRequestBody = {
  membership_mode: "open" | "request" | "gated"
  default_age_gate_policy?: "none" | "18_plus" | null
  allow_anonymous_identity: boolean
  anonymous_identity_scope?: "community_stable" | "thread_stable" | "post_ephemeral" | null
  gate_rules?: UpdateGateRuleInput
}

export type UpdateCommunityReferenceLinksRequestBody = {
  reference_links: Array<{
    community_reference_link_id?: string | null
    platform: NonNullable<Community["reference_links"]>[number]["platform"]
    url: string
    label?: string | null
    position?: number | null
  }>
}

export type UpdateCommunityDonationPolicyRequestBody = {
  donation_policy_mode: "none" | "optional_creator_sidecar" | "fundraiser_default"
  donation_partner_id?: string | null
  donation_partner?: {
    donation_partner_id: string
    display_name: string
    provider: "endaoment"
    provider_partner_ref?: string | null
    image_url?: string | null
  } | null
}

const VALID_PUBLIC_V0_PROVIDERS_BY_PROOF_TYPE = {
  unique_human: new Set(["self", "very"]),
  age_over_18: new Set(["self"]),
  nationality: new Set(["self"]),
  gender: new Set(["self"]),
  wallet_score: new Set(["passport"]),
  sanctions_clear: new Set(["passport"]),
} as const

function assertPublicV0GateConfiguration(
  body: {
    membership_mode?: "open" | "request" | "gated" | null
    default_age_gate_policy?: "none" | "18_plus" | null
    anonymous_identity_scope?: "community_stable" | "thread_stable" | "post_ephemeral" | null
    gate_rules?: CreateCommunityRequestBody["gate_rules"]
  },
  input: {
    ageOver18Verified: boolean
  },
): void {
  if (!["open", "request", "gated"].includes(body.membership_mode ?? "open")) {
    throw eligibilityFailed("Public v0 community creation only allows open, request, or gated membership")
  }
  if ((body.anonymous_identity_scope ?? null) === "post_ephemeral") {
    throw eligibilityFailed("post_ephemeral anonymous scope is not allowed in public v0 community creation")
  }
  if ((body.default_age_gate_policy ?? "none") === "18_plus" && !input.ageOver18Verified) {
    throw eligibilityFailed("age_over_18 verification is required for 18_plus communities")
  }
  if (
    body.gate_rules?.some(
      (rule) => rule.gate_family === "token_holding" || rule.scope === "viewer" || rule.scope === "posting",
    )
  ) {
    throw eligibilityFailed("Public v0 community creation only allows membership-scope identity-proof gates")
  }
  if (body.gate_rules?.some((rule) => rule.gate_type === "sanctions_clear")) {
    throw eligibilityFailed("Public v0 community creation does not support sanctions_clear gates")
  }
  let nationalityGateCount = 0
  let genderGateCount = 0
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
  for (const rule of body.gate_rules ?? []) {
    if (rule.gate_type !== "nationality") {
      if (rule.gate_type !== "gender") {
        continue
      }

      genderGateCount += 1
      if (genderGateCount > 1) {
        throw eligibilityFailed("Public v0 communities support at most one gender gate")
      }

      const requirements = rule.proof_requirements ?? []
      if (requirements.length !== 1 || requirements[0].proof_type !== "gender") {
        throw eligibilityFailed("Gender gate must have exactly one gender proof requirement")
      }

      const requirement = requirements[0]
      const acceptedProviders = requirement.accepted_providers ?? []
      if (acceptedProviders.length !== 1 || acceptedProviders[0] !== "self") {
        throw eligibilityFailed("Gender gate accepted_providers must be exactly [\"self\"]")
      }

      const config = (requirement.config ?? rule.gate_config ?? {}) as Record<string, unknown>
      const requiredValue = typeof config.required_value === "string" ? config.required_value : null
      if (!requiredValue) {
        throw eligibilityFailed("Gender gate requires a required_value in config")
      }
      if (requiredValue !== "M" && requiredValue !== "F") {
        throw eligibilityFailed("Gender gate required_value must be either \"M\" or \"F\"")
      }
      continue
    }

    nationalityGateCount += 1
    if (nationalityGateCount > 1) {
      throw eligibilityFailed("Public v0 communities support at most one nationality gate")
    }

    const requirements = rule.proof_requirements ?? []
    if (requirements.length !== 1 || requirements[0].proof_type !== "nationality") {
      throw eligibilityFailed("Nationality gate must have exactly one nationality proof requirement")
    }

    const requirement = requirements[0]
    const acceptedProviders = requirement.accepted_providers ?? []
    if (acceptedProviders.length !== 1 || acceptedProviders[0] !== "self") {
      throw eligibilityFailed("Nationality gate accepted_providers must be exactly [\"self\"]")
    }

    const config = (requirement.config ?? rule.gate_config ?? {}) as Record<string, unknown>
    const requiredValue = typeof config.required_value === "string" ? config.required_value : null
    if (!requiredValue) {
      throw eligibilityFailed("Nationality gate requires a required_value in config")
    }
    if (!/^[A-Z]{2}$/.test(requiredValue)) {
      throw eligibilityFailed("Nationality gate required_value must match ^[A-Z]{2}$")
    }
  }
}

export function assertCreateRequest(
  body: CreateCommunityRequestBody,
  input: {
    uniqueHumanVerified: boolean
    ageOver18Verified: boolean
  },
): asserts body is CreateCommunityRequestBody & {
  display_name: string
} {
  if (!body.display_name?.trim()) {
    throw badRequestError("display_name is required")
  }
  if (body.avatar_ref != null && typeof body.avatar_ref !== "string") {
    throw badRequestError("avatar_ref must be a string or null")
  }
  if (body.banner_ref != null && typeof body.banner_ref !== "string") {
    throw badRequestError("banner_ref must be a string or null")
  }
  if (body.namespace != null && !body.namespace.namespace_verification_id?.trim()) {
    throw badRequestError("namespace.namespace_verification_id is required when namespace is provided")
  }
  if (!input.uniqueHumanVerified) {
    throw eligibilityFailed("unique_human verification is required")
  }
  if ((body.governance_mode ?? "centralized") !== "centralized") {
    throw eligibilityFailed("Only centralized community creation is allowed in public v0")
  }
  if ((body.handle_policy?.policy_template ?? "standard") !== "standard") {
    throw eligibilityFailed("Public v0 community creation requires the standard handle policy")
  }
  if (body.donation_policy != null) {
    throw eligibilityFailed("Public v0 community creation does not accept donation payloads")
  }
  if (body.community_bootstrap?.label_policy != null || body.community_bootstrap?.resource_links != null) {
    throw eligibilityFailed("Public v0 community creation does not support labels or resource links yet")
  }
  assertPublicV0GateConfiguration(body, input)
}

export type CreateCommunityAuth = {
  userId: string
  user: User
  displayName: string
  actorPrimaryWalletSnapshot: string | null
  namespaceVerificationId: string | null
  createdAt: string
}

export async function resolveCreateCommunityAuth(input: {
  userId: string
  body: CreateCommunityRequestBody
  userRepository: UserRepository
}): Promise<CreateCommunityAuth> {
  const user = await input.userRepository.getUserById(input.userId)
  if (!user) {
    throw internalError("Resolved user row is missing for community create")
  }

  assertCreateRequest(input.body, {
    uniqueHumanVerified: user.verification_capabilities.unique_human.state === "verified",
    ageOver18Verified: user.verification_capabilities.age_over_18.state === "verified",
  })

  const walletAttachments = await input.userRepository.getWalletAttachmentsByUserId(input.userId)
  const actorPrimaryWalletSnapshot = getPrimaryWalletSnapshot(user, walletAttachments)

  return {
    userId: input.userId,
    user,
    displayName: input.body.display_name.trim(),
    actorPrimaryWalletSnapshot,
    namespaceVerificationId: input.body.namespace?.namespace_verification_id?.trim() || null,
    createdAt: nowIso(),
  }
}

function resolveCommunityDbRoot(env: Env): string {
  const configured = String(env.LOCAL_COMMUNITY_DB_ROOT || "").trim()
  if (configured) {
    return configured
  }

  throw internalError("LOCAL_COMMUNITY_DB_ROOT is not configured")
}

function resolveCommunityProvisionGroupLocation(env: Env): string {
  const configured = String(env.COMMUNITY_PROVISION_DEFAULT_GROUP_LOCATION || "").trim()
  if (configured) {
    return configured
  }

  throw internalError("COMMUNITY_PROVISION_DEFAULT_GROUP_LOCATION is not configured")
}

function resolveCommunityDbWrapKey(env: Env): string {
  const configured = String(env.TURSO_COMMUNITY_DB_WRAP_KEY || "").trim()
  if (configured) {
    return configured
  }

  throw internalError("TURSO_COMMUNITY_DB_WRAP_KEY is not configured")
}

function resolveCommunityDbWrapKeyVersion(env: Env): number {
  const parsed = Number(String(env.TURSO_COMMUNITY_DB_WRAP_KEY_VERSION || "").trim())
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed
  }

  throw internalError("TURSO_COMMUNITY_DB_WRAP_KEY_VERSION is not configured")
}

function buildPendingCommunityDatabaseUrl(communityId: string): string {
  return `libsql://pending-${communityId}.invalid`
}

function getUniqueHumanProviderForScope(
  body: CreateCommunityRequestBody,
  scope: "membership" | "posting",
): "self" | "very" | null {
  for (const rule of body.gate_rules ?? []) {
    if (rule.scope !== scope || rule.gate_family !== "identity_proof" || rule.gate_type !== "unique_human") {
      continue
    }

    const provider = rule.proof_requirements?.[0]?.accepted_providers?.[0]
    if (provider === "self" || provider === "very") {
      return provider
    }
  }

  return null
}

function buildProvisionOperatorBootstrapPayload(
  body: CreateCommunityRequestBody,
  namespaceLabel: string | null,
): {
  description: string | null
  membership_mode: "open" | "request" | "gated"
  default_age_gate_policy: "none" | "18_plus"
  membership_unique_human_provider: "self" | "very" | null
  posting_unique_human_provider: "self" | "very" | null
  handle_policy_template: "standard" | "premium" | "membership_gated" | "custom"
  handle_pricing_model: string | null
  namespace_label: string | null
} {
  return {
    description: body.description?.trim() || null,
    membership_mode: body.membership_mode ?? "open",
    default_age_gate_policy: body.default_age_gate_policy ?? "none",
    membership_unique_human_provider: getUniqueHumanProviderForScope(body, "membership"),
    posting_unique_human_provider: getUniqueHumanProviderForScope(body, "posting"),
    handle_policy_template: body.handle_policy?.policy_template ?? "standard",
    handle_pricing_model: null,
    namespace_label: namespaceLabel,
  }
}

export function isExpired(isoTimestamp: string): boolean {
  const expiresAt = Date.parse(isoTimestamp)
  if (!Number.isFinite(expiresAt)) {
    throw eligibilityFailed("Namespace verification expiry is invalid")
  }
  return expiresAt <= Date.now()
}

export function isPendingCommunityDatabaseUrl(value: string | null | undefined): boolean {
  const normalized = String(value ?? "").trim().toLowerCase()
  return normalized.startsWith("libsql://pending-") || normalized.endsWith(".invalid")
}

function isLocalCommunityDatabaseUrl(value: string | null | undefined): boolean {
  const normalized = String(value ?? "").trim().toLowerCase()
  return normalized.startsWith("file:")
}

const RUNNING_JOB_HEARTBEAT_TIMEOUT_MS = 30_000

export type ProvisioningRetryAction =
  | { action: "return_existing" }
  | { action: "retry" }
  | { action: "finalize"; binding: CommunityDatabaseBindingRow }

export async function resolveProvisioningRetryAction(
  repo: CommunityRepository,
  community: CommunityRow,
  latestJob: JobRow,
): Promise<ProvisioningRetryAction> {
  if (community.provisioning_state === "active") {
    return { action: "return_existing" }
  }

  if (latestJob.status === "failed") {
    return { action: "retry" }
  }

  if (latestJob.status === "running") {
    const jobAgeMs = Date.now() - Date.parse(latestJob.updated_at)
    if (Number.isFinite(jobAgeMs) && jobAgeMs < RUNNING_JOB_HEARTBEAT_TIMEOUT_MS) {
      return { action: "return_existing" }
    }
    return { action: "retry" }
  }

  const binding = await repo.getPrimaryCommunityDatabaseBinding(community.community_id)
  if (!binding || binding.status !== "active" || isPendingCommunityDatabaseUrl(binding.database_url)) {
    return { action: "retry" }
  }

  if (!isLocalCommunityDatabaseUrl(binding.database_url)) {
    const credential = await repo.getActiveCommunityDbCredential(binding.community_database_binding_id)
    if (!credential) {
      return { action: "retry" }
    }
  }

  return { action: "finalize", binding }
}

async function loadCommunityLocalSnapshot(
  env: Env,
  repo: CommunityRepository,
  communityId: string,
): Promise<LocalCommunitySnapshot | null> {
  const db = await openCommunityDb(env, repo, communityId).catch(() => null)
  if (!db) {
    return null
  }

  try {
    const result = await db.client.execute({
      sql: `
        SELECT community_id, display_name, description, avatar_ref, banner_ref, status, membership_mode, default_age_gate_policy,
               allow_anonymous_identity, anonymous_identity_scope, donation_policy_mode, donation_partner_id, donation_partner_status,
               settings_json,
               governance_mode, created_by_user_id, created_at, updated_at
        FROM communities
        WHERE community_id = ?1
        LIMIT 1
      `,
      args: [communityId],
    })
    const row = result.rows[0]
    if (!row) {
      return null
    }

    const rulesResult = await db.client.execute({
      sql: `
        SELECT rule_id, title, body, report_reason, position, status
        FROM community_rules
        WHERE community_id = ?1
        ORDER BY position ASC, created_at ASC
      `,
      args: [communityId],
    })
    const rules = rulesResult.rows.map((ruleRow, index) => ({
      rule_id: String(ruleRow.rule_id),
      title: String(ruleRow.title),
      body: String(ruleRow.body),
      report_reason:
        ruleRow.report_reason == null || String(ruleRow.report_reason).trim().length === 0
          ? String(ruleRow.title)
          : String(ruleRow.report_reason),
      position: typeof ruleRow.position === "number" ? ruleRow.position : index,
      status: ruleRow.status === "archived" ? "archived" : "active",
    } satisfies LocalCommunityRule))

    const gateRulesResult = await db.client.execute({
      sql: `
        SELECT gate_rule_id, scope, gate_family, gate_type, proof_requirements_json,
               chain_namespace, gate_config_json, status, created_at, updated_at
        FROM community_gate_rules
        WHERE community_id = ?1
        ORDER BY created_at ASC
      `,
      args: [communityId],
    })
    const gate_rules = gateRulesResult.rows.map((gateRow) => ({
      gate_rule_id: String(gateRow.gate_rule_id),
      scope: String(gateRow.scope) as LocalCommunitySnapshot["gate_rules"][number]["scope"],
      gate_family: String(gateRow.gate_family) as LocalCommunitySnapshot["gate_rules"][number]["gate_family"],
      gate_type: String(gateRow.gate_type),
      proof_requirements:
        gateRow.proof_requirements_json == null
          ? null
          : JSON.parse(String(gateRow.proof_requirements_json)) as Array<Record<string, unknown>>,
      chain_namespace: gateRow.chain_namespace == null ? null : String(gateRow.chain_namespace),
      gate_config:
        gateRow.gate_config_json == null
          ? null
          : JSON.parse(String(gateRow.gate_config_json)) as Record<string, unknown>,
      status: gateRow.status === "disabled" ? "disabled" : "active",
      created_at: String(gateRow.created_at),
      updated_at: String(gateRow.updated_at),
    } satisfies LocalCommunitySnapshot["gate_rules"][number]))

    return {
      community_id: String(row.community_id),
      display_name: String(row.display_name),
      description: row.description == null ? null : String(row.description),
      avatar_ref: row.avatar_ref == null ? null : String(row.avatar_ref),
      banner_ref: row.banner_ref == null ? null : String(row.banner_ref),
      status: String(row.status) as LocalCommunitySnapshot["status"],
      membership_mode: String(row.membership_mode) as LocalCommunitySnapshot["membership_mode"],
      default_age_gate_policy: String(row.default_age_gate_policy) as LocalCommunitySnapshot["default_age_gate_policy"],
      allow_anonymous_identity: Boolean(Number(row.allow_anonymous_identity ?? 0)),
      anonymous_identity_scope: row.anonymous_identity_scope == null
        ? null
        : (String(row.anonymous_identity_scope) as LocalCommunitySnapshot["anonymous_identity_scope"]),
      donation_policy_mode: String(row.donation_policy_mode) as LocalCommunitySnapshot["donation_policy_mode"],
      donation_partner_id: row.donation_partner_id == null ? null : String(row.donation_partner_id),
      donation_partner_status: String(row.donation_partner_status) as LocalCommunitySnapshot["donation_partner_status"],
      settings_json: row.settings_json == null ? null : String(row.settings_json),
      gate_rules,
      governance_mode: String(row.governance_mode) as LocalCommunitySnapshot["governance_mode"],
      rules,
      created_by_user_id: String(row.created_by_user_id),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    }
  } catch {
    return null
  } finally {
    db.close()
  }
}

export async function loadCommunityProjection(
  env: Env,
  repo: CommunityRepository,
  communityRow: CommunityRow,
): Promise<Community> {
  const local = await loadCommunityLocalSnapshot(env, repo, communityRow.community_id)
  return serializeCommunity(communityRow, local)
}

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

function normalizeInputRules(
  rules: UpdateCommunityRulesRequestBody["rules"],
): LocalCommunityRule[] {
  return rules
    .map((rule, index) => {
      const title = rule.title.trim()
      const body = rule.body.trim()
      const reportReason = rule.report_reason?.trim() || title
      const status = rule.status === "archived" ? "archived" : "active"
      const ruleId = typeof rule.rule_id === "string" && rule.rule_id.trim().length > 0
        ? rule.rule_id.trim()
        : makeId("rul")

      if (!title && !body) {
        return null
      }

      return {
        rule_id: ruleId,
        title,
        body,
        report_reason: reportReason,
        position: index,
        status,
      } satisfies LocalCommunityRule
    })
    .filter((rule): rule is LocalCommunityRule => rule !== null)
}

function isModerationDecisionLevel(
  value: unknown,
): value is Community["adult_content_policy"]["suggestive"] {
  return value === "allow" || value === "review" || value === "disallow"
}

function isEscalationDecisionLevel(
  value: unknown,
): value is Community["civility_policy"]["threatening_language"] {
  return value === "review" || value === "disallow"
}

function assertUpdateCommunitySafetyRequest(
  body: UpdateCommunitySafetyRequestBody | null,
): asserts body is UpdateCommunitySafetyRequestBody {
  if (!body) {
    throw badRequestError("Invalid community safety payload")
  }

  const adult = body.adult_content_policy
  const graphic = body.graphic_content_policy
  const civility = body.civility_policy
  const openai = body.openai_moderation_settings

  if (
    !adult
    || !isModerationDecisionLevel(adult.suggestive)
    || !isModerationDecisionLevel(adult.artistic_nudity)
    || !isModerationDecisionLevel(adult.explicit_nudity)
    || !isModerationDecisionLevel(adult.explicit_sexual_content)
    || !isModerationDecisionLevel(adult.fetish_content)
  ) {
    throw badRequestError("Invalid adult_content_policy payload")
  }

  if (
    !graphic
    || !isModerationDecisionLevel(graphic.injury_medical)
    || !isModerationDecisionLevel(graphic.gore)
    || !isModerationDecisionLevel(graphic.extreme_gore)
    || !isModerationDecisionLevel(graphic.body_horror_disturbing)
    || !isModerationDecisionLevel(graphic.animal_harm)
  ) {
    throw badRequestError("Invalid graphic_content_policy payload")
  }

  if (
    !civility
    || !isModerationDecisionLevel(civility.group_directed_demeaning_language)
    || !isModerationDecisionLevel(civility.targeted_insults)
    || !isModerationDecisionLevel(civility.targeted_harassment)
    || !isEscalationDecisionLevel(civility.threatening_language)
  ) {
    throw badRequestError("Invalid civility_policy payload")
  }

  if (
    !openai
    || typeof openai.scan_titles !== "boolean"
    || typeof openai.scan_post_bodies !== "boolean"
    || typeof openai.scan_captions !== "boolean"
    || typeof openai.scan_link_preview_text !== "boolean"
    || typeof openai.scan_images !== "boolean"
  ) {
    throw badRequestError("Invalid openai_moderation_settings payload")
  }
}

function assertUpdateCommunityGatesRequest(
  body: UpdateCommunityGatesRequestBody | null,
): asserts body is UpdateCommunityGatesRequestBody {
  if (!body) {
    throw badRequestError("Invalid community gates payload")
  }

  if (!["open", "request", "gated"].includes(body.membership_mode)) {
    throw badRequestError("Invalid membership_mode payload")
  }

  if (typeof body.allow_anonymous_identity !== "boolean") {
    throw badRequestError("Invalid allow_anonymous_identity payload")
  }

  if (
    body.anonymous_identity_scope != null
    && body.anonymous_identity_scope !== "community_stable"
    && body.anonymous_identity_scope !== "thread_stable"
    && body.anonymous_identity_scope !== "post_ephemeral"
  ) {
    throw badRequestError("Invalid anonymous_identity_scope payload")
  }

  if (
    body.default_age_gate_policy != null
    && body.default_age_gate_policy !== "none"
    && body.default_age_gate_policy !== "18_plus"
  ) {
    throw badRequestError("Invalid default_age_gate_policy payload")
  }

  if (body.gate_rules != null && !Array.isArray(body.gate_rules)) {
    throw badRequestError("Invalid gate_rules payload")
  }

  if (Array.isArray(body.gate_rules)) {
    const seenGateRuleIds = new Set<string>()
    for (const rule of body.gate_rules) {
      if (rule.gate_rule_id != null) {
        if (typeof rule.gate_rule_id !== "string") {
          throw badRequestError("Invalid gate_rule_id payload")
        }

        const normalizedGateRuleId = rule.gate_rule_id.trim()
        if (normalizedGateRuleId.length === 0) {
          throw badRequestError("gate_rule_id must not be blank")
        }
        if (seenGateRuleIds.has(normalizedGateRuleId)) {
          throw badRequestError("Duplicate gate_rule_id payload")
        }
        seenGateRuleIds.add(normalizedGateRuleId)
      }
    }
  }
}

function assertUpdateCommunityReferenceLinksRequest(
  body: UpdateCommunityReferenceLinksRequestBody | null,
): asserts body is UpdateCommunityReferenceLinksRequestBody {
  if (!body || !Array.isArray(body.reference_links)) {
    throw badRequestError("Invalid community reference links payload")
  }

  for (const link of body.reference_links) {
    if (typeof link?.platform !== "string" || link.platform.trim().length === 0) {
      throw badRequestError("Invalid reference link platform")
    }
    if (typeof link?.url !== "string" || link.url.trim().length === 0) {
      throw badRequestError("Invalid reference link url")
    }
    if (link.community_reference_link_id != null && typeof link.community_reference_link_id !== "string") {
      throw badRequestError("Invalid community_reference_link_id payload")
    }
    if (link.label != null && typeof link.label !== "string") {
      throw badRequestError("Invalid reference link label")
    }
  }
}

function parseCommunitySettingsJson(
  rawSettingsJson: unknown,
): Record<string, unknown> {
  if (typeof rawSettingsJson !== "string" || rawSettingsJson.trim().length === 0) {
    return {}
  }

  try {
    const parsed = JSON.parse(rawSettingsJson) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {}

  return {}
}

function parseStoredDonationPartnerSummary(
  settings: Record<string, unknown>,
): (NonNullable<Community["donation_partner"]> & { image_url?: string | null }) | null {
  const rawPartner = settings.donation_partner
  if (!rawPartner || typeof rawPartner !== "object" || Array.isArray(rawPartner)) {
    return null
  }

  const partner = rawPartner as Record<string, unknown>
  if (
    typeof partner.donation_partner_id !== "string"
    || typeof partner.display_name !== "string"
    || partner.provider !== "endaoment"
  ) {
    return null
  }

  return {
    donation_partner_id: partner.donation_partner_id,
    display_name: partner.display_name,
    provider: "endaoment",
    provider_partner_ref: typeof partner.provider_partner_ref === "string" ? partner.provider_partner_ref : null,
    image_url: typeof partner.image_url === "string" ? partner.image_url : null,
    review_status: partner.review_status === "pending" || partner.review_status === "rejected"
      ? partner.review_status
      : "approved",
    status: partner.status === "paused" || partner.status === "retired"
      ? partner.status
      : "active",
  }
}

function parseEndaomentLookupTerm(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }

  if (/^\d{9}$/u.test(trimmed)) {
    return trimmed
  }

  try {
    const url = new URL(trimmed)
    const host = url.hostname.toLowerCase()
    if (!host.endsWith("endaoment.org")) {
      return null
    }

    const segments = url.pathname.split("/").filter(Boolean)
    if (segments.length >= 2 && segments[0] === "orgs" && segments[1].trim()) {
      return decodeURIComponent(segments[1].trim())
    }
  } catch {
    return null
  }

  return null
}

type EndaomentOrganizationSearchResult = {
  id: string
  ein?: string | null
  name: string
  logo?: string | null
  isCompliant?: boolean
}

function selectEndaomentOrganizationMatch(
  organizations: EndaomentOrganizationSearchResult[],
  lookupTerm: string,
): EndaomentOrganizationSearchResult | null {
  const normalizedLookupTerm = lookupTerm.trim().toLowerCase()
  const exactEin = organizations.find((org) => (org.ein ?? "").trim().toLowerCase() === normalizedLookupTerm)
  if (exactEin) {
    return exactEin
  }

  return organizations.find((org) => org.id.trim().toLowerCase() === normalizedLookupTerm) ?? organizations[0] ?? null
}

export async function resolveCommunityDonationPartner(input: {
  env: Env
  userId: string
  communityId: string
  endaomentUrl: string
  communityRepository: CommunityRepository
}): Promise<{
  donation_partner_id: string
  display_name: string
  provider: "endaoment"
  provider_partner_ref: string | null
  image_url: string | null
}> {
  await requireOwnedCommunity(input.communityRepository, input.communityId, input.userId)
  const lookupTerm = parseEndaomentLookupTerm(input.endaomentUrl)
  if (!lookupTerm) {
    throw badRequestError("Enter a valid Endaoment organization URL.")
  }

  const endpoint = new URL("https://api.endaoment.org/v2/orgs/search")
  endpoint.searchParams.set("searchTerm", lookupTerm)
  endpoint.searchParams.set("count", "10")

  const response = await fetch(endpoint.toString(), {
    method: "GET",
    headers: {
      accept: "application/json",
    },
  }).catch((error: unknown) => {
    throw internalError(error instanceof Error ? error.message : "Failed to reach Endaoment.")
  })

  if (!response.ok) {
    throw internalError(`Endaoment lookup failed with status ${response.status}`)
  }

  const payload = await response.json().catch(() => null)
  if (!Array.isArray(payload)) {
    throw internalError("Endaoment lookup returned an invalid response.")
  }

  const organizations = payload.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return []
    }

    const record = entry as Record<string, unknown>
    if (typeof record.id !== "string" || typeof record.name !== "string") {
      return []
    }

    return [{
      id: record.id,
      ein: typeof record.ein === "string" ? record.ein : null,
      isCompliant: typeof record.isCompliant === "boolean" ? record.isCompliant : undefined,
      logo: typeof record.logo === "string" ? record.logo : null,
      name: record.name,
    } satisfies EndaomentOrganizationSearchResult]
  })

  const organization = selectEndaomentOrganizationMatch(organizations, lookupTerm)
  if (!organization) {
    throw notFoundError("This Endaoment organization was not found.")
  }
  if (organization.isCompliant === false) {
    throw badRequestError("This Endaoment organization is not available right now.")
  }

  return {
    donation_partner_id: `endaoment:${organization.id}`,
    display_name: organization.name,
    provider: "endaoment",
    provider_partner_ref: organization.ein ?? organization.id,
    image_url: organization.logo ?? null,
  }
}

export async function updateCommunityRules(input: {
  env: Env
  userId: string
  communityId: string
  body: UpdateCommunityRulesRequestBody
  communityRepository: CommunityRepository
}): Promise<Community> {
  await requireOwnedCommunity(input.communityRepository, input.communityId, input.userId)
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)

  try {
    const rules = normalizeInputRules(input.body.rules)
    const now = nowIso()
    const tx = await db.client.transaction("write")
    try {
      await tx.execute({
        sql: `
          DELETE FROM community_rules
          WHERE community_id = ?1
        `,
        args: [input.communityId],
      })

      for (const [index, rule] of rules.entries()) {
        await tx.execute({
          sql: `
            INSERT INTO community_rules (
              rule_id, community_id, title, body, report_reason, position, status, created_at, updated_at
            ) VALUES (
              ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8
            )
          `,
          args: [
            rule.rule_id,
            input.communityId,
            rule.title,
            rule.body,
            rule.report_reason,
            index,
            rule.status,
            now,
          ],
        })
      }

      await tx.execute({
        sql: `
          UPDATE communities
          SET updated_at = ?2
          WHERE community_id = ?1
        `,
        args: [input.communityId, now],
      })

      await tx.commit()
    } catch (error) {
      try {
        await tx.rollback()
      } catch {}
      throw error
    } finally {
      tx.close()
    }
  } finally {
    db.close()
  }

  const updated = await input.communityRepository.getCommunityById(input.communityId)
  if (!updated) {
    throw notFoundError("Community not found")
  }
  return loadCommunityProjection(input.env, input.communityRepository, updated)
}

export async function updateCommunitySafety(input: {
  env: Env
  userId: string
  communityId: string
  body: UpdateCommunitySafetyRequestBody | null
  communityRepository: CommunityRepository
}): Promise<Community> {
  assertUpdateCommunitySafetyRequest(input.body)
  await requireOwnedCommunity(input.communityRepository, input.communityId, input.userId)
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)

  try {
    const result = await db.client.execute({
      sql: `
        SELECT settings_json
        FROM communities
        WHERE community_id = ?1
        LIMIT 1
      `,
      args: [input.communityId],
    })
    const row = result.rows[0]
    const existingSettings = parseCommunitySettingsJson(row?.settings_json)
    const now = nowIso()

    const settings = {
      ...existingSettings,
      adult_content_policy: {
        community_id: input.communityId,
        policy_origin: "explicit" as const,
        updated_at: now,
        ...input.body.adult_content_policy,
      },
      graphic_content_policy: {
        community_id: input.communityId,
        policy_origin: "explicit" as const,
        updated_at: now,
        ...input.body.graphic_content_policy,
      },
      civility_policy: {
        community_id: input.communityId,
        policy_origin: "explicit" as const,
        updated_at: now,
        ...input.body.civility_policy,
      },
      openai_moderation_settings: input.body.openai_moderation_settings,
    }

    await db.client.execute({
      sql: `
        UPDATE communities
        SET settings_json = ?2,
            updated_at = ?3
        WHERE community_id = ?1
      `,
      args: [input.communityId, JSON.stringify(settings), now],
    })
  } finally {
    db.close()
  }

  const updated = await input.communityRepository.getCommunityById(input.communityId)
  if (!updated) {
    throw notFoundError("Community not found")
  }

  return loadCommunityProjection(input.env, input.communityRepository, updated)
}

export async function updateCommunityDonationPolicy(input: {
  env: Env
  userId: string
  communityId: string
  body: UpdateCommunityDonationPolicyRequestBody
  communityRepository: CommunityRepository
}): Promise<Community> {
  const { donation_partner, donation_partner_id, donation_policy_mode } = input.body
  if (donation_policy_mode !== "none" && !donation_partner_id?.trim()) {
    throw badRequestError("donation_partner_id is required when donation_policy_mode is not none")
  }
  if (donation_policy_mode === "none" && donation_partner_id) {
    throw badRequestError("donation_partner_id must be null when donation_policy_mode is none")
  }
  if (
    donation_policy_mode !== "none"
    && (
      !donation_partner
      || donation_partner.provider !== "endaoment"
      || donation_partner.donation_partner_id.trim() !== donation_partner_id?.trim()
      || !donation_partner.display_name.trim()
    )
  ) {
    throw badRequestError("Resolved donation partner details are required when donations are enabled")
  }

  await requireOwnedCommunity(input.communityRepository, input.communityId, input.userId)
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)

  try {
    const result = await db.client.execute({
      sql: `
        SELECT settings_json
        FROM communities
        WHERE community_id = ?1
        LIMIT 1
      `,
      args: [input.communityId],
    })
    const row = result.rows[0]
    const existingSettings = parseCommunitySettingsJson(row?.settings_json)
    const now = nowIso()
    const partnerStatus = donation_policy_mode === "none" ? "unconfigured" : "active"
    const resolvedPartnerId = donation_policy_mode === "none" ? null : (donation_partner_id ?? null)
    const nextSettings = {
      ...existingSettings,
      donation_partner: donation_policy_mode === "none" || !donation_partner
        ? null
        : {
          donation_partner_id: donation_partner.donation_partner_id,
          display_name: donation_partner.display_name.trim(),
          provider: "endaoment" as const,
          provider_partner_ref: donation_partner.provider_partner_ref?.trim() || null,
          image_url: donation_partner.image_url?.trim() || null,
          review_status: "approved" as const,
          status: "active" as const,
        },
    }

    await db.client.execute({
      sql: `
        UPDATE communities
        SET donation_policy_mode = ?2,
            donation_partner_id = ?3,
            donation_partner_status = ?4,
            settings_json = ?5,
            updated_at = ?6
        WHERE community_id = ?1
      `,
      args: [input.communityId, donation_policy_mode, resolvedPartnerId, partnerStatus, JSON.stringify(nextSettings), now],
    })
  } finally {
    db.close()
  }

  const updated = await input.communityRepository.getCommunityById(input.communityId)
  if (!updated) {
    throw notFoundError("Community not found")
  }

  return loadCommunityProjection(input.env, input.communityRepository, updated)
}

export async function getCommunityDonationPolicy(input: {
  env: Env
  userId: string
  communityId: string
  communityRepository: CommunityRepository
}): Promise<{
  community_id: string
  donation_policy_mode: string
  donation_partner_status: string
  donation_partner_id: string | null
  donation_partner: (NonNullable<Community["donation_partner"]> & { image_url?: string | null }) | null
  updated_at: string
}> {
  await requireOwnedCommunity(input.communityRepository, input.communityId, input.userId)
  const local = await loadCommunityLocalSnapshot(input.env, input.communityRepository, input.communityId)
  const storedPartner = parseStoredDonationPartnerSummary(parseCommunitySettingsJson(local?.settings_json))

  const mode = local?.donation_policy_mode ?? "none"
  const status = local?.donation_partner_status ?? "unconfigured"
  const partnerId = local?.donation_partner_id ?? null
  const updatedAt = local?.updated_at ?? new Date().toISOString()

  return {
    community_id: input.communityId,
    donation_policy_mode: mode,
    donation_partner_status: status === "inactive" ? "paused" : status,
    donation_partner_id: partnerId,
    donation_partner: partnerId && storedPartner ? storedPartner : null,
    updated_at: updatedAt,
  }
}

export async function updateCommunityReferenceLinks(input: {
  env: Env
  userId: string
  communityId: string
  body: UpdateCommunityReferenceLinksRequestBody | null
  communityRepository: CommunityRepository
}): Promise<Community> {
  assertUpdateCommunityReferenceLinksRequest(input.body)
  await requireOwnedCommunity(input.communityRepository, input.communityId, input.userId)
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)

  try {
    const result = await db.client.execute({
      sql: `
        SELECT settings_json
        FROM communities
        WHERE community_id = ?1
        LIMIT 1
      `,
      args: [input.communityId],
    })
    const row = result.rows[0]
    const existingSettings = parseCommunitySettingsJson(row?.settings_json)
    const existingLinks = Array.isArray(existingSettings.reference_links)
      ? existingSettings.reference_links as NonNullable<Community["reference_links"]>
      : []
    const existingById = new Map(
      existingLinks.map((link) => [link.community_reference_link_id, link] as const),
    )
    const now = nowIso()

    const referenceLinks = input.body.reference_links
      .map((link, index) => {
        const communityReferenceLinkId = link.community_reference_link_id?.trim() || makeId("lnk")
        const existingLink = existingById.get(communityReferenceLinkId)
        const trimmedLabel = link.label?.trim() || null
        const trimmedUrl = link.url.trim()

        if (!trimmedUrl) {
          return null
        }

        return {
          community_reference_link_id: communityReferenceLinkId,
          platform: link.platform,
          url: trimmedUrl,
          label: trimmedLabel,
          link_status: "active" as const,
          verified: existingLink?.verified ?? false,
          metadata: {
            display_name: trimmedLabel,
            image_url: existingLink?.metadata.image_url ?? null,
          },
          position: typeof link.position === "number" ? link.position : index,
        } satisfies NonNullable<Community["reference_links"]>[number]
      })
      .filter((link) => link !== null) as NonNullable<Community["reference_links"]>

    await db.client.execute({
      sql: `
        UPDATE communities
        SET settings_json = ?2,
            updated_at = ?3
        WHERE community_id = ?1
      `,
      args: [
        input.communityId,
        JSON.stringify({
          ...existingSettings,
          reference_links: referenceLinks,
        }),
        now,
      ],
    })
  } finally {
    db.close()
  }

  const updated = await input.communityRepository.getCommunityById(input.communityId)
  if (!updated) {
    throw notFoundError("Community not found")
  }

  return loadCommunityProjection(input.env, input.communityRepository, updated)
}

export async function updateCommunityGates(input: {
  env: Env
  userId: string
  communityId: string
  body: UpdateCommunityGatesRequestBody | null
  communityRepository: CommunityRepository
  userRepository: UserRepository
}): Promise<Community> {
  assertUpdateCommunityGatesRequest(input.body)
  await requireOwnedCommunity(input.communityRepository, input.communityId, input.userId)

  const user = await input.userRepository.getUserById(input.userId)
  if (!user) {
    throw internalError("Resolved user row is missing for community gates update")
  }

  assertPublicV0GateConfiguration(input.body, {
    ageOver18Verified: user.verification_capabilities.age_over_18.state === "verified",
  })

  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)

  try {
    const now = nowIso()
    const tx = await db.client.transaction("write")
    try {
      await tx.execute({
        sql: `
          UPDATE communities
          SET membership_mode = ?2,
              default_age_gate_policy = ?3,
              allow_anonymous_identity = ?4,
              anonymous_identity_scope = ?5,
              updated_at = ?6
          WHERE community_id = ?1
        `,
        args: [
          input.communityId,
          input.body.membership_mode,
          input.body.default_age_gate_policy ?? "none",
          input.body.allow_anonymous_identity ? 1 : 0,
          input.body.allow_anonymous_identity ? (input.body.anonymous_identity_scope ?? null) : null,
          now,
        ],
      })

      await tx.execute({
        sql: `
          DELETE FROM community_gate_rules
          WHERE community_id = ?1
        `,
        args: [input.communityId],
      })

      for (const [index, rule] of (input.body.gate_rules ?? []).entries()) {
        const existingId = typeof rule.gate_rule_id === "string" && rule.gate_rule_id.trim().length > 0
          ? rule.gate_rule_id.trim()
          : null
        const gateRuleId = existingId ?? `grl_${input.communityId}_${index}_${nowIso().replace(/[^a-zA-Z0-9]/g, "")}_${index}`
        await tx.execute({
          sql: `
            INSERT INTO community_gate_rules (
              gate_rule_id, community_id, scope, gate_family, gate_type, proof_requirements_json,
              chain_namespace, gate_config_json, status, created_at, updated_at
            ) VALUES (
              ?1, ?2, ?3, ?4, ?5, ?6,
              ?7, ?8, 'active', ?9, ?9
            )
          `,
          args: [
            gateRuleId,
            input.communityId,
            rule.scope,
            rule.gate_family,
            rule.gate_type,
            rule.proof_requirements ? JSON.stringify(rule.proof_requirements) : null,
            rule.chain_namespace ?? null,
            rule.gate_config ? JSON.stringify(rule.gate_config) : null,
            now,
          ],
        })
      }

      await tx.commit()
    } catch (error) {
      try {
        await tx.rollback()
      } catch {}
      throw error
    } finally {
      tx.close()
    }
  } finally {
    db.close()
  }

  const updated = await input.communityRepository.getCommunityById(input.communityId)
  if (!updated) {
    throw notFoundError("Community not found")
  }

  return loadCommunityProjection(input.env, input.communityRepository, updated)
}

async function upsertLocalNamespaceAttachment(input: {
  env: Env
  repo: CommunityRepository
  communityId: string
  namespaceVerificationId: string
  namespaceLabel: string
  now: string
}): Promise<void> {
  const db = await openCommunityDb(input.env, input.repo, input.communityId)
  const namespaceId = `ns_${input.communityId}`
  const namespaceHandlePolicyId = `nhp_${input.communityId}`

  try {
    const tx = await db.client.transaction("write")
    try {
      await tx.execute({
        sql: `
          INSERT INTO namespace_bindings (
            namespace_id, community_id, namespace_verification_id, display_label, normalized_label,
            resolver_label, route_family, status, created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, ?4, ?5, NULL, NULL, 'active', ?6, ?6
          )
          ON CONFLICT(namespace_id) DO UPDATE SET
            namespace_verification_id = excluded.namespace_verification_id,
            display_label = excluded.display_label,
            normalized_label = excluded.normalized_label,
            status = excluded.status,
            updated_at = excluded.updated_at
        `,
        args: [
          namespaceId,
          input.communityId,
          input.namespaceVerificationId,
          input.namespaceLabel,
          input.namespaceLabel.toLowerCase(),
          input.now,
        ],
      })

      await tx.execute({
        sql: `
          INSERT INTO namespace_handle_policies (
            namespace_handle_policy_id, community_id, namespace_id, policy_template, pricing_model,
            membership_required_for_claim, settings_json, created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, 'standard', NULL, 1, NULL, ?4, ?4
          )
          ON CONFLICT(namespace_handle_policy_id) DO UPDATE SET
            namespace_id = excluded.namespace_id,
            membership_required_for_claim = excluded.membership_required_for_claim,
            updated_at = excluded.updated_at
        `,
        args: [
          namespaceHandlePolicyId,
          input.communityId,
          namespaceId,
          input.now,
        ],
      })

      await tx.commit()
    } catch (error) {
      try {
        await tx.rollback()
      } catch {}
      throw error
    } finally {
      tx.close()
    }
  } finally {
    db.close()
  }
}

async function createNamespacelessCommunity(input: {
  env: Env
  body: CreateCommunityRequestBody
  auth: CreateCommunityAuth
  communityRepository: CommunityRepository
}): Promise<CommunityCreateAcceptedResponse> {
  const communityId = makeId("cmt")
  const bindingId = makeId("cdb")
  const jobId = makeId("job")
  const useProvisionOperator = isCommunityProvisionOperatorConfigured(input.env)
  const databaseUrl = useProvisionOperator
    ? buildPendingCommunityDatabaseUrl(communityId)
    : buildLocalCommunityDbUrl(resolveCommunityDbRoot(input.env), communityId)
  const prepared = await input.communityRepository.createCommunityProvisioningRequest({
    communityId,
    communityDatabaseBindingId: bindingId,
    registryAttemptId: null,
    jobId,
    creatorUserId: input.auth.userId,
    displayName: input.auth.displayName,
    membershipMode: input.body.membership_mode ?? "open",
    namespaceVerificationId: null,
    routeSlug: null,
    databaseUrl,
    createdAt: input.auth.createdAt,
  })

  try {
    let localSnapshot: LocalCommunitySnapshot | null = null
    let resolvedBinding: CommunityDatabaseBindingRow | null | undefined

    if (useProvisionOperator) {
      const provisioned = await provisionCommunityViaOperator({
        env: input.env,
        communityId,
        creatorUserId: input.auth.userId,
        displayName: input.auth.displayName,
        namespaceVerificationId: null,
        groupLocation: resolveCommunityProvisionGroupLocation(input.env),
        bootstrapPayload: buildProvisionOperatorBootstrapPayload(
          input.body,
          null,
        ),
      })
      const encryptedToken = encryptCommunityDbCredential({
        plaintextToken: provisioned.plaintextToken,
        wrapKey: resolveCommunityDbWrapKey(input.env),
      })
      const communityDbCredentialId = provisioned.credentialId.trim() || (() => {
        const fallbackId = makeId("cdc")
        console.warn(
          "[community-provision] operator returned empty credential_id for namespaceless community %s; using fallback %s",
          communityId,
          fallbackId,
        )
        return fallbackId
      })()
      await input.communityRepository.persistProvisionedCommunityDatabaseAccess({
        communityDatabaseBindingId: prepared.binding.community_database_binding_id,
        communityDbCredentialId,
        organizationSlug: provisioned.organizationSlug,
        groupName: provisioned.groupName,
        groupId: provisioned.groupId,
        databaseName: provisioned.databaseName,
        databaseId: provisioned.databaseId,
        databaseUrl: provisioned.databaseUrl,
        location: provisioned.location,
        tokenName: provisioned.tokenName,
        encryptedToken,
        encryptionKeyVersion: resolveCommunityDbWrapKeyVersion(input.env),
        issuedAt: provisioned.issuedAt,
        expiresAt: provisioned.expiresAt,
        updatedAt: input.auth.createdAt,
      })
      localSnapshot = await loadCommunityLocalSnapshot(input.env, input.communityRepository, communityId)
      resolvedBinding = await input.communityRepository.getPrimaryCommunityDatabaseBinding(communityId)
    } else {
      const dbRoot = resolveCommunityDbRoot(input.env)
      localSnapshot = await bootstrapLocalCommunityDb({
        rootDir: dbRoot,
        communityId,
        createdByUserId: input.auth.userId,
        displayName: input.auth.displayName,
        description: input.body.description?.trim() || null,
        avatarRef: normalizeCommunityMediaRef(input.body.avatar_ref),
        bannerRef: normalizeCommunityMediaRef(input.body.banner_ref),
        namespaceVerificationId: null,
        namespaceLabel: null,
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
        rules: (input.body.community_bootstrap?.rules ?? []).map((rule, index) => ({
          rule_id: makeId("rul"),
          title: rule.title.trim(),
          body: rule.body.trim(),
          report_reason: rule.report_reason?.trim() || rule.title.trim(),
          position: typeof rule.position === "number" ? rule.position : index,
          status: "active",
        })),
        now: input.auth.createdAt,
      })
    }

    const finalized = await input.communityRepository.markCommunityProvisioningSucceeded({
      communityId,
      communityDatabaseBindingId: prepared.binding.community_database_binding_id,
      jobId: prepared.job.job_id,
      actorUserId: input.auth.userId,
      resultRef: useProvisionOperator
        ? resolvedBinding?.database_url ?? prepared.binding.database_url
        : prepared.binding.database_url,
      createdAt: input.auth.createdAt,
      metadata: {
        binding_id: prepared.binding.community_database_binding_id,
        database_url: useProvisionOperator
          ? resolvedBinding?.database_url ?? prepared.binding.database_url
          : prepared.binding.database_url,
        mode: useProvisionOperator ? "turso_operator" : "local_stub",
      },
    })

    return {
      community: serializeCommunity(finalized.community, localSnapshot),
      job: serializeJob(finalized.job),
    }
  } catch (error) {
    await input.communityRepository.markCommunityProvisioningFailed({
      communityId,
      jobId: prepared.job.job_id,
      actorUserId: input.auth.userId,
      errorCode: useProvisionOperator ? "turso_operator_provision_failed" : "local_stub_bootstrap_failed",
      createdAt: nowIso(),
      metadata: {
        binding_id: prepared.binding.community_database_binding_id,
        database_url: prepared.binding.database_url,
        message: error instanceof Error ? error.message : String(error),
      },
    }).catch(() => {})

    throw internalError("Community provisioning failed")
  }
}

async function finalizeExistingCommunity(input: {
  env: Env
  body: CreateCommunityRequestBody
  auth: CreateCommunityAuth
  existingCommunity: CommunityRow
  existingJob: JobRow
  binding: CommunityDatabaseBindingRow
  communityRepository: CommunityRepository
  namespaceVerificationId: string
  namespaceVerification: { normalized_root_label: string }
}): Promise<CommunityCreateAcceptedResponse> {
  const finalized = await input.communityRepository.markCommunityProvisioningSucceeded({
    communityId: input.existingCommunity.community_id,
    communityDatabaseBindingId: input.binding.community_database_binding_id,
    jobId: input.existingJob.job_id,
    actorUserId: input.auth.userId,
    resultRef: input.binding.database_url,
    createdAt: nowIso(),
    metadata: {
      binding_id: input.binding.community_database_binding_id,
      database_url: input.binding.database_url,
      mode: "finalize_after_crash",
    },
  })
  const local = await loadCommunityLocalSnapshot(input.env, input.communityRepository, input.existingCommunity.community_id)
  try {
    const registryPublication = getRegistryPublicationAdapter(input.env)
    const finalizePublicAttempt = await registryPublication.createCommunityCreateAttempt({
      actorUserId: input.auth.userId,
      actorPrimaryWalletSnapshot: input.auth.actorPrimaryWalletSnapshot,
      actorGovernanceAddressSnapshot: null,
      namespaceVerificationId: input.namespaceVerificationId,
      normalizedRootLabel: input.namespaceVerification.normalized_root_label,
      createdAt: input.auth.createdAt,
    })
    const finalizeRegistryAttempt = await input.communityRepository.createCommunityRegistryAttempt({
      registryAttemptId: finalizePublicAttempt.registryAttemptId,
      actorUserId: input.auth.userId,
      actorPrimaryWalletSnapshot: finalizePublicAttempt.actorPrimaryWalletSnapshot,
      actorGovernanceAddressSnapshot: finalizePublicAttempt.actorGovernanceAddressSnapshot,
      namespaceVerificationId: input.namespaceVerificationId,
      normalizedRootLabel: input.namespaceVerification.normalized_root_label,
      createdAt: input.auth.createdAt,
    })
    const publicationFinalized = await registryPublication.publishCommunityCreate({
      repo: input.communityRepository,
      communityId: input.existingCommunity.community_id,
      registryAttemptId: finalizeRegistryAttempt.registry_attempt_id,
      actorUserId: input.auth.userId,
      namespaceVerificationId: input.namespaceVerificationId,
      normalizedRootLabel: input.namespaceVerification.normalized_root_label,
      canonicalSeed: {
        display_name: input.auth.displayName,
        description: input.body.description?.trim() || null,
        governance_mode: input.body.governance_mode ?? "centralized",
      },
      createdAt: input.auth.createdAt,
    })
    return {
      community: serializeCommunity(publicationFinalized.community, local),
      job: serializeJob(finalized.job),
    }
  } catch {
    const communityRow = await input.communityRepository.getCommunityById(input.existingCommunity.community_id)
    if (!communityRow) {
      throw internalError("Community registry publication failed")
    }

    return {
      community: serializeCommunity(communityRow, local),
      job: serializeJob(finalized.job),
    }
  }
}

async function provisionNamespacedCommunity(input: {
  env: Env
  body: CreateCommunityRequestBody
  auth: CreateCommunityAuth
  existingCommunity: CommunityRow | null
  namespaceVerificationId: string
  namespaceVerification: { normalized_root_label: string }
  communityRepository: CommunityRepository
}): Promise<CommunityCreateAcceptedResponse> {
  const { env, body, auth, existingCommunity, namespaceVerificationId, namespaceVerification, communityRepository: repo } = input
  const communityId = existingCommunity?.community_id ?? makeId("cmt")
  const bindingId = existingCommunity?.primary_database_binding_id ?? makeId("cdb")
  const jobId = makeId("job")
  const useProvisionOperator = isCommunityProvisionOperatorConfigured(env)
  const databaseUrl = useProvisionOperator
    ? buildPendingCommunityDatabaseUrl(communityId)
    : buildLocalCommunityDbUrl(resolveCommunityDbRoot(env), communityId)
  const registryPublication = getRegistryPublicationAdapter(env)
  const publicAttempt = await registryPublication.createCommunityCreateAttempt({
    actorUserId: auth.userId,
    actorPrimaryWalletSnapshot: auth.actorPrimaryWalletSnapshot,
    actorGovernanceAddressSnapshot: null,
    namespaceVerificationId,
    normalizedRootLabel: namespaceVerification.normalized_root_label,
    createdAt: auth.createdAt,
  })
  const registryAttempt = await repo.createCommunityRegistryAttempt({
    registryAttemptId: publicAttempt.registryAttemptId,
    actorUserId: auth.userId,
    actorPrimaryWalletSnapshot: publicAttempt.actorPrimaryWalletSnapshot,
    actorGovernanceAddressSnapshot: publicAttempt.actorGovernanceAddressSnapshot,
    namespaceVerificationId,
    normalizedRootLabel: namespaceVerification.normalized_root_label,
    createdAt: auth.createdAt,
  })

  const prepared = await (async () => {
    try {
      return existingCommunity
        ? await repo.retryCommunityProvisioningRequest({
            communityId,
            fallbackBindingId: bindingId,
            registryAttemptId: registryAttempt.registry_attempt_id,
            jobId,
            namespaceVerificationId,
            routeSlug: namespaceVerification.normalized_root_label,
            databaseUrl,
            createdAt: auth.createdAt,
          })
        : await repo.createCommunityProvisioningRequest({
            communityId,
            communityDatabaseBindingId: bindingId,
            registryAttemptId: registryAttempt.registry_attempt_id,
            jobId,
            creatorUserId: auth.userId,
            displayName: auth.displayName,
            membershipMode: body.membership_mode ?? "open",
            namespaceVerificationId,
            routeSlug: namespaceVerification.normalized_root_label,
            databaseUrl,
            createdAt: auth.createdAt,
          })
    } catch (error) {
      await repo.markCommunityRegistryAttemptFailed({
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
  let resolvedBinding: CommunityDatabaseBindingRow | null | undefined

  try {
    if (useProvisionOperator) {
      const provisioned = await provisionCommunityViaOperator({
        env,
        communityId,
        creatorUserId: auth.userId,
        displayName: auth.displayName,
        namespaceVerificationId,
        groupLocation: resolveCommunityProvisionGroupLocation(env),
        bootstrapPayload: buildProvisionOperatorBootstrapPayload(
          body,
          namespaceVerification.normalized_root_label,
        ),
      })
      const encryptedToken = encryptCommunityDbCredential({
        plaintextToken: provisioned.plaintextToken,
        wrapKey: resolveCommunityDbWrapKey(env),
      })
      const communityDbCredentialId = provisioned.credentialId.trim() || (() => {
        const fallbackId = makeId("cdc")
        console.warn(
          "[community-provision] operator returned empty credential_id for community %s; using fallback %s",
          communityId,
          fallbackId,
        )
        return fallbackId
      })()
      await repo.persistProvisionedCommunityDatabaseAccess({
        communityDatabaseBindingId: prepared.binding.community_database_binding_id,
        communityDbCredentialId,
        organizationSlug: provisioned.organizationSlug,
        groupName: provisioned.groupName,
        groupId: provisioned.groupId,
        databaseName: provisioned.databaseName,
        databaseId: provisioned.databaseId,
        databaseUrl: provisioned.databaseUrl,
        location: provisioned.location,
        tokenName: provisioned.tokenName,
        encryptedToken,
        encryptionKeyVersion: resolveCommunityDbWrapKeyVersion(env),
        issuedAt: provisioned.issuedAt,
        expiresAt: provisioned.expiresAt,
        updatedAt: auth.createdAt,
      })
      localSnapshot = await loadCommunityLocalSnapshot(env, repo, communityId)
    } else {
      const dbRoot = resolveCommunityDbRoot(env)
      localSnapshot = await bootstrapLocalCommunityDb({
        rootDir: dbRoot,
        communityId,
        createdByUserId: auth.userId,
        displayName: auth.displayName,
        description: body.description?.trim() || null,
        avatarRef: normalizeCommunityMediaRef(body.avatar_ref),
        bannerRef: normalizeCommunityMediaRef(body.banner_ref),
        namespaceVerificationId,
        namespaceLabel: namespaceVerification.normalized_root_label,
        membershipMode: body.membership_mode ?? "open",
        defaultAgeGatePolicy: body.default_age_gate_policy ?? "none",
        allowAnonymousIdentity: body.allow_anonymous_identity ?? false,
        anonymousIdentityScope: body.allow_anonymous_identity ? (body.anonymous_identity_scope ?? null) : null,
        governanceMode: body.governance_mode ?? "centralized",
        handlePolicyTemplate: body.handle_policy?.policy_template ?? "standard",
        pricingModel: null,
        gateRules: (body.gate_rules ?? []).map((rule) => ({
          scope: rule.scope,
          gateFamily: rule.gate_family,
          gateType: rule.gate_type,
          proofRequirementsJson: rule.proof_requirements ? JSON.stringify(rule.proof_requirements) : null,
          chainNamespace: rule.chain_namespace ?? null,
          gateConfigJson: rule.gate_config ? JSON.stringify(rule.gate_config) : null,
        })),
        rules: (body.community_bootstrap?.rules ?? []).map((rule, index) => ({
          rule_id: makeId("rul"),
          title: rule.title.trim(),
          body: rule.body.trim(),
          report_reason: rule.report_reason?.trim() || rule.title.trim(),
          position: typeof rule.position === "number" ? rule.position : index,
          status: "active",
        })),
        now: auth.createdAt,
      })
    }

    provisioningFinalized = await repo.markCommunityProvisioningSucceeded({
      communityId,
      communityDatabaseBindingId: prepared.binding.community_database_binding_id,
      jobId: prepared.job.job_id,
      actorUserId: auth.userId,
      resultRef: useProvisionOperator
        ? (resolvedBinding ??= await repo.getPrimaryCommunityDatabaseBinding(communityId))?.database_url ?? prepared.binding.database_url
        : prepared.binding.database_url,
      createdAt: auth.createdAt,
      metadata: {
        binding_id: prepared.binding.community_database_binding_id,
        database_url: useProvisionOperator
          ? resolvedBinding?.database_url ?? prepared.binding.database_url
          : prepared.binding.database_url,
        mode: useProvisionOperator ? "turso_operator" : "local_stub",
      },
    })
    provisioningCompleted = true

    const publicationFinalized = await registryPublication.publishCommunityCreate({
      repo,
      communityId,
      registryAttemptId: registryAttempt.registry_attempt_id,
      actorUserId: auth.userId,
      namespaceVerificationId,
      normalizedRootLabel: namespaceVerification.normalized_root_label,
      canonicalSeed: {
        display_name: auth.displayName,
        description: body.description?.trim() || null,
        governance_mode: body.governance_mode ?? "centralized",
      },
      createdAt: auth.createdAt,
    })

    return {
      community: serializeCommunity(publicationFinalized.community, localSnapshot),
      job: serializeJob(provisioningFinalized.job),
    }
  } catch (error) {
    const failedAt = nowIso()

    if (!provisioningCompleted) {
      await repo.markCommunityProvisioningFailed({
        communityId,
        jobId: prepared.job.job_id,
        actorUserId: auth.userId,
        errorCode: useProvisionOperator ? "turso_operator_provision_failed" : "local_stub_bootstrap_failed",
        createdAt: failedAt,
        metadata: {
          binding_id: prepared.binding.community_database_binding_id,
          database_url: prepared.binding.database_url,
          message: error instanceof Error ? error.message : String(error),
        },
      }).catch(() => {})

      await repo.markCommunityRegistryPublicationFailed({
        communityId,
        registryAttemptId: registryAttempt.registry_attempt_id,
        jobId: null,
        actorUserId: auth.userId,
        errorCode: useProvisionOperator ? "turso_operator_provision_failed" : "local_stub_bootstrap_failed",
        createdAt: failedAt,
        metadata: {
          message: error instanceof Error ? error.message : String(error),
        },
      }).catch(() => {})

      throw internalError("Community provisioning failed")
    }

    const communityRow = await repo.getCommunityById(communityId)
    if (!communityRow || !provisioningFinalized) {
      throw internalError("Community registry publication failed")
    }

    return {
      community: serializeCommunity(communityRow, localSnapshot),
      job: serializeJob(provisioningFinalized.job),
    }
  }
}

export async function createCommunity(input: {
  env: Env
  userId: string
  body: CreateCommunityRequestBody
  userRepository: UserRepository
  verificationRepository: VerificationRepository
  communityRepository: CommunityRepository
}): Promise<CommunityCreateAcceptedResponse> {
  const auth = await resolveCreateCommunityAuth(input)

  if (!auth.namespaceVerificationId) {
    return createNamespacelessCommunity({
      env: input.env,
      body: input.body,
      auth,
      communityRepository: input.communityRepository,
    })
  }

  const namespaceVerification = await input.verificationRepository.getNamespaceVerification(
    auth.namespaceVerificationId,
    auth.userId,
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

  const existingCommunity = await input.communityRepository.getCommunityByNamespaceVerificationId(
    auth.namespaceVerificationId,
  )
  if (existingCommunity) {
    const existingJob = await input.communityRepository.getLatestCommunityProvisioningJob(existingCommunity.community_id)
    if (!existingJob) {
      throw notFoundError("Existing community provisioning job not found")
    }
    const retryAction = await resolveProvisioningRetryAction(input.communityRepository, existingCommunity, existingJob)
    if (retryAction.action === "return_existing") {
      return {
        community: await loadCommunityProjection(input.env, input.communityRepository, existingCommunity),
        job: serializeJob(existingJob),
      }
    }
    if (retryAction.action === "finalize") {
      return finalizeExistingCommunity({
        env: input.env,
        body: input.body,
        auth,
        existingCommunity,
        existingJob,
        binding: retryAction.binding,
        communityRepository: input.communityRepository,
        namespaceVerificationId: auth.namespaceVerificationId,
        namespaceVerification,
      })
    }
  }

  return provisionNamespacedCommunity({
    env: input.env,
    body: input.body,
    auth,
    existingCommunity,
    namespaceVerificationId: auth.namespaceVerificationId,
    namespaceVerification,
    communityRepository: input.communityRepository,
  })
}

export async function attachNamespaceToCommunity(input: {
  env: Env
  userId: string
  communityId: string
  namespaceVerificationId: string
  userRepository: UserRepository
  verificationRepository: VerificationRepository
  communityRepository: CommunityRepository
}): Promise<Community> {
  const user = await input.userRepository.getUserById(input.userId)
  if (!user) {
    throw internalError("Resolved user row is missing for namespace attach")
  }

  const community = await requireOwnedCommunity(input.communityRepository, input.communityId, input.userId)
  if (community.namespace_verification_id && community.namespace_verification_id !== input.namespaceVerificationId) {
    throw eligibilityFailed("Community already has a different namespace attached")
  }

  const namespaceVerification = await input.verificationRepository.getNamespaceVerification(
    input.namespaceVerificationId,
    input.userId,
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

  const createdAt = nowIso()
  const attachedCommunity = community.namespace_verification_id === input.namespaceVerificationId
    ? community
    : await input.communityRepository.attachNamespaceToCommunity({
        communityId: input.communityId,
        namespaceVerificationId: input.namespaceVerificationId,
        routeSlug: namespaceVerification.normalized_root_label,
        updatedAt: createdAt,
      })

  await upsertLocalNamespaceAttachment({
    env: input.env,
    repo: input.communityRepository,
    communityId: input.communityId,
    namespaceVerificationId: input.namespaceVerificationId,
    namespaceLabel: namespaceVerification.normalized_root_label,
    now: createdAt,
  })

  let finalCommunity = attachedCommunity
  if (attachedCommunity.registry_publication_state !== "published") {
    const walletAttachments = await input.userRepository.getWalletAttachmentsByUserId(input.userId)
    const actorPrimaryWalletSnapshot = getPrimaryWalletSnapshot(user, walletAttachments)
    const registryPublication = getRegistryPublicationAdapter(input.env)
    const publicAttempt = await registryPublication.createCommunityCreateAttempt({
      actorUserId: input.userId,
      actorPrimaryWalletSnapshot,
      actorGovernanceAddressSnapshot: null,
      namespaceVerificationId: input.namespaceVerificationId,
      normalizedRootLabel: namespaceVerification.normalized_root_label,
      createdAt,
    })
    const registryAttempt = await input.communityRepository.createCommunityRegistryAttempt({
      registryAttemptId: publicAttempt.registryAttemptId,
      actorUserId: input.userId,
      actorPrimaryWalletSnapshot: publicAttempt.actorPrimaryWalletSnapshot,
      actorGovernanceAddressSnapshot: publicAttempt.actorGovernanceAddressSnapshot,
      namespaceVerificationId: input.namespaceVerificationId,
      normalizedRootLabel: namespaceVerification.normalized_root_label,
      createdAt,
    })
    const local = await loadCommunityProjection(input.env, input.communityRepository, attachedCommunity)
    const publication = await registryPublication.publishCommunityCreate({
      repo: input.communityRepository,
      communityId: input.communityId,
      registryAttemptId: registryAttempt.registry_attempt_id,
      actorUserId: input.userId,
      namespaceVerificationId: input.namespaceVerificationId,
      normalizedRootLabel: namespaceVerification.normalized_root_label,
      canonicalSeed: {
        display_name: local.display_name,
        description: local.description ?? null,
        governance_mode: local.governance_mode,
      },
      createdAt,
    })
    finalCommunity = publication.community
  }

  return loadCommunityProjection(input.env, input.communityRepository, finalCommunity)
}
