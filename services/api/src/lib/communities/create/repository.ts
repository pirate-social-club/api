import {
  bootstrapLocalCommunityDb,
  type LocalCommunityRule,
  type LocalCommunitySnapshot,
} from "../community-local-db"
import { serializeLocalDonationPartnerRow } from "../community-donation-partner-serialization"
import { normalizeCommunityMediaRef } from "../community-identity-media"
import type { CommunityDatabaseBindingRow, CommunityRow, JobRow } from "../../auth/auth-db-rows"
import type {
  CommunityDatabaseBindingRepository,
  CommunityReadRepository,
} from "../db-community-repository"
import { badRequestError, eligibilityFailed, internalError, notFoundError } from "../../errors"
import { makeId, nowIso } from "../../helpers"
import { writeAuditEventForEnv } from "../../audit"
import type { ActorContext, AdminActorContext } from "../../auth-middleware"
import type { Env } from "../../../env"
import type { Community } from "../../../types"
import { serializeCommunity } from "../community-serialization"
import { openCommunityDb } from "../community-db-factory"
import { normalizeCommunityCountryCode } from "../country-code"
import type { GateAtom, GateExpression, GatePolicy } from "../membership/gate-types"
import type {
  CreateCommunityAuth,
  CreateCommunityRequestBody,
} from "./validation"
import type { UpdateCommunityRulesRequestBody } from "./update-validation"

export type CommunityMutationActor = ActorContext | AdminActorContext

export function communityMutationActorFromUserId(userId: string): ActorContext {
  return {
    userId,
    authType: "user",
  }
}

export function resolveCommunityDbRoot(env: Env): string {
  const configured = String(env.LOCAL_COMMUNITY_DB_ROOT || "").trim()
  if (configured) {
    return configured
  }

  throw internalError("LOCAL_COMMUNITY_DB_ROOT is not configured")
}

function parseAllowedCommunityProvisionGroupLocations(env: Env): Set<string> {
  return new Set(
    String(env.COMMUNITY_PROVISION_ALLOWED_GROUP_LOCATIONS || "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  )
}

export function resolveCommunityProvisionGroupLocation(
  env: Env,
  requestedLocation?: string | null,
): string {
  const configured = String(env.COMMUNITY_PROVISION_DEFAULT_GROUP_LOCATION || "").trim()
  const requested = String(requestedLocation || "").trim()
  const resolved = !requested || requested === "auto" ? configured : requested

  if (!resolved) {
    throw internalError("COMMUNITY_PROVISION_DEFAULT_GROUP_LOCATION is not configured")
  }

  const allowed = parseAllowedCommunityProvisionGroupLocations(env)
  if (allowed.size > 0 && !allowed.has(resolved)) {
    throw badRequestError("database_region is not supported")
  }

  return resolved
}

export function resolveCommunityDbWrapKey(env: Env): string {
  const configured = String(env.TURSO_COMMUNITY_DB_WRAP_KEY || "").trim()
  if (configured) {
    return configured
  }

  throw internalError("TURSO_COMMUNITY_DB_WRAP_KEY is not configured")
}

export function resolveCommunityDbWrapKeyVersion(env: Env): number {
  const parsed = Number(String(env.TURSO_COMMUNITY_DB_WRAP_KEY_VERSION || "").trim())
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed
  }

  throw internalError("TURSO_COMMUNITY_DB_WRAP_KEY_VERSION is not configured")
}

export function buildPendingCommunityDatabaseUrl(communityId: string): string {
  return `libsql://pending-${communityId}.invalid`
}

export function isExpired(timestamp: string | number): boolean {
  const expiresAt = typeof timestamp === "number" ? timestamp * 1000 : Date.parse(timestamp)
  if (!Number.isFinite(expiresAt)) {
    throw eligibilityFailed("Namespace verification expiry is invalid")
  }
  return expiresAt <= Date.now()
}

export function isPendingCommunityDatabaseUrl(value: string | null | undefined): boolean {
  const normalized = String(value ?? "").trim().toLowerCase()
  return normalized.startsWith("libsql://pending-") || normalized.endsWith(".invalid")
}

const RUNNING_JOB_HEARTBEAT_TIMEOUT_MS = 30_000

export type ProvisioningRetryAction =
  | { action: "return_existing" }
  | { action: "retry" }
  | { action: "finalize"; binding: CommunityDatabaseBindingRow }

export async function resolveProvisioningRetryAction(
  repo: CommunityDatabaseBindingRepository,
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

  if (binding.requires_credentials) {
    const credential = await repo.getActiveCommunityDbCredential(binding.community_database_binding_id)
    if (!credential) {
      return { action: "retry" }
    }
  }

  return { action: "finalize", binding }
}

export async function loadCommunityLocalSnapshot(
  env: Env,
  repo: CommunityDatabaseBindingRepository,
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

    const gatePolicyResult = await db.client.execute({
      sql: `
        SELECT expression_json
        FROM community_gate_policies
        WHERE community_id = ?1
          AND scope = 'membership'
        LIMIT 1
      `,
      args: [communityId],
    })
    const gate_policy = gatePolicyResult.rows[0]?.expression_json == null
      ? null
      : JSON.parse(String(gatePolicyResult.rows[0].expression_json)) as LocalCommunitySnapshot["gate_policy"]

    let donation_partner: LocalCommunitySnapshot["donation_partner"] = null
    if (row.donation_partner_id) {
      const partnerResult = await db.client.execute({
        sql: `
          SELECT donation_partner_id, display_name, provider, provider_partner_ref,
                 payout_destination_ref, image_url, review_status, status
          FROM donation_partners
          WHERE donation_partner_id = ?1
          LIMIT 1
        `,
        args: [String(row.donation_partner_id)],
      })
      const partnerRow = partnerResult.rows[0]
      if (partnerRow) {
        donation_partner = serializeLocalDonationPartnerRow(partnerRow)
      }
    }

    return {
      community_id: String(row.community_id),
      display_name: String(row.display_name),
      description: row.description == null ? null : String(row.description),
      avatar_ref: row.avatar_ref == null ? null : String(row.avatar_ref),
      banner_ref: row.banner_ref == null ? null : String(row.banner_ref),
      status: String(row.status) as LocalCommunitySnapshot["status"],
      membership_mode: String(row.membership_mode) as LocalCommunitySnapshot["membership_mode"],
      karaoke_enabled: Boolean(Number(row.karaoke_enabled ?? 0)),
      default_age_gate_policy: String(row.default_age_gate_policy) as LocalCommunitySnapshot["default_age_gate_policy"],
      allow_anonymous_identity: Boolean(Number(row.allow_anonymous_identity ?? 0)),
      anonymous_identity_scope: row.anonymous_identity_scope == null
        ? null
        : (String(row.anonymous_identity_scope) as LocalCommunitySnapshot["anonymous_identity_scope"]),
      donation_policy_mode: String(row.donation_policy_mode) as LocalCommunitySnapshot["donation_policy_mode"],
      donation_partner_id: row.donation_partner_id == null ? null : String(row.donation_partner_id),
      donation_partner_status: String(row.donation_partner_status) as LocalCommunitySnapshot["donation_partner_status"],
      donation_partner,
      settings_json: row.settings_json == null ? null : String(row.settings_json),
      gate_policy,
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
  repo: CommunityDatabaseBindingRepository,
  communityRow: CommunityRow,
): Promise<Community> {
  const local = await loadCommunityLocalSnapshot(env, repo, communityRow.community_id)
  return serializeCommunity(env, communityRow, local)
}

export async function requireOwnedCommunity(
  repo: Pick<CommunityReadRepository, "getCommunityById">,
  communityId: string,
  userId: string,
): Promise<CommunityRow> {
  const community = await repo.getCommunityById(communityId)
  if (!community || community.creator_user_id !== userId) {
    throw notFoundError("Community not found")
  }
  return community
}

export async function requireAdminOverrideOrOwnedCommunity(input: {
  env: Env
  repo: Pick<CommunityReadRepository, "getCommunityById">
  communityId: string
  actor: CommunityMutationActor
  action: string
}): Promise<CommunityRow> {
  if (!("adminOverride" in input.actor)) {
    return requireOwnedCommunity(input.repo, input.communityId, input.actor.userId)
  }

  const community = await input.repo.getCommunityById(input.communityId)
  if (!community) {
    throw notFoundError("Community not found")
  }

  const now = nowIso()
  await writeAuditEventForEnv(input.env, {
    action: input.action,
    actorId: input.actor.adminOverride.adminActorId,
    actorType: "operator",
    communityId: input.communityId,
    createdAt: now,
    targetId: input.communityId,
    targetType: "community",
    metadata: {
      scope: input.actor.adminOverride.scope,
      acting_user_id: input.actor.userId,
      owner_user_id: community.creator_user_id,
    },
  })

  return community
}

export function normalizeInputRules(
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

export function buildBootstrapGatePolicy(body: CreateCommunityRequestBody): GatePolicy | null {
  return body.membership_mode === "gated" ? (body.gate_policy as GatePolicy | null | undefined ?? null) : null
}

export function buildBootstrapRules(body: CreateCommunityRequestBody) {
  return (body.community_bootstrap?.rules ?? []).map((rule, index) => ({
    rule_id: makeId("rul"),
    title: rule.title.trim(),
    body: rule.body.trim(),
    report_reason: rule.report_reason?.trim() || rule.title.trim(),
    position: typeof rule.position === "number" ? rule.position : index,
    status: "active" as const,
  }))
}

export function buildBootstrapInitialSettings(body: CreateCommunityRequestBody): Record<string, unknown> | null {
  const settings: Record<string, unknown> = {}
  const countryCode = normalizeCommunityCountryCode(body.country_code)
  if (countryCode) {
    settings.country_code = countryCode
  }
  if (body.agent_posting_policy) {
    settings.agent_posting_policy = body.agent_posting_policy
  }
  if (body.guest_comment_policy) {
    settings.guest_comment_policy = body.guest_comment_policy
  }
  if (body.agent_posting_scope) {
    settings.agent_posting_scope = body.agent_posting_scope
  }
  if (body.agent_daily_post_cap != null) {
    settings.agent_daily_post_cap = body.agent_daily_post_cap
  }
  if (body.agent_daily_reply_cap != null) {
    settings.agent_daily_reply_cap = body.agent_daily_reply_cap
  }
  if (body.human_verification_lane) {
    settings.human_verification_lane = body.human_verification_lane
  }
  if (body.accepted_agent_ownership_providers) {
    settings.accepted_agent_ownership_providers = body.accepted_agent_ownership_providers
  }
  return Object.keys(settings).length > 0 ? settings : null
}

function normalizeHumanVerificationProvider(value: unknown): "self" | "very" | null {
  return value === "self" || value === "very" ? value : null
}

function resolveScopeUniqueHumanProvider(
  body: CreateCommunityRequestBody,
  scope: "membership" | "posting",
): "self" | "very" | null {
  if (scope === "membership") {
    const gatePolicy = body.gate_policy as GatePolicy | null | undefined
    const provider = findFirstHumanVerificationProvider(gatePolicy?.expression ?? null)
    if (provider) return provider
  }

  return normalizeHumanVerificationProvider(body.human_verification_lane)
}

function findFirstHumanVerificationProvider(expression: GateExpression | null): "self" | "very" | null {
  if (!expression) return null
  if (expression.op === "gate") {
    return humanVerificationProviderForAtom(expression.gate)
  }
  for (const child of expression.children) {
    const provider = findFirstHumanVerificationProvider(child)
    if (provider) return provider
  }
  return null
}

function humanVerificationProviderForAtom(atom: GateAtom): "self" | "very" | null {
  switch (atom.type) {
    case "unique_human":
      return atom.provider === "very" ? "very" : "self"
    case "minimum_age":
    case "nationality":
    case "gender":
      return "self"
    default:
      return null
  }
}

export function buildProvisionOperatorBootstrapPayload(
  body: CreateCommunityRequestBody,
  namespaceLabel: string | null,
) {
  return {
    description: body.description?.trim() || null,
    avatar_ref: normalizeCommunityMediaRef(body.avatar_ref),
    banner_ref: normalizeCommunityMediaRef(body.banner_ref),
    membership_mode: resolvePublicV0MembershipMode(body.membership_mode),
    default_age_gate_policy: body.default_age_gate_policy ?? "none",
    gate_policy: buildBootstrapGatePolicy(body) as Record<string, unknown> | null,
    membership_unique_human_provider: resolveScopeUniqueHumanProvider(body, "membership"),
    posting_unique_human_provider: resolveScopeUniqueHumanProvider(body, "posting"),
    handle_policy_template: body.handle_policy?.policy_template ?? "premium",
    handle_pricing_model: body.handle_policy?.pricing_model ?? "flat_by_length",
    namespace_label: namespaceLabel,
    initial_settings: buildBootstrapInitialSettings(body),
  }
}

function resolvePublicV0MembershipMode(mode: CreateCommunityRequestBody["membership_mode"] | null | undefined): "request" | "gated" {
  return mode === "request" ? "request" : "gated"
}

export async function bootstrapCommunityLocalSnapshot(input: {
  env: Env
  body: CreateCommunityRequestBody
  auth: CreateCommunityAuth
  communityId: string
  namespaceVerificationId: string | null
  namespaceLabel: string | null
}): Promise<LocalCommunitySnapshot> {
  const dbRoot = resolveCommunityDbRoot(input.env)
  return bootstrapLocalCommunityDb({
    rootDir: dbRoot,
    communityId: input.communityId,
    createdByUserId: input.auth.userId,
    displayName: input.auth.communityDisplayName,
    description: input.body.description?.trim() || null,
    avatarRef: normalizeCommunityMediaRef(input.body.avatar_ref),
    bannerRef: normalizeCommunityMediaRef(input.body.banner_ref),
    namespaceVerificationId: input.namespaceVerificationId,
    namespaceLabel: input.namespaceLabel,
    membershipMode: resolvePublicV0MembershipMode(input.body.membership_mode),
    defaultAgeGatePolicy: input.body.default_age_gate_policy ?? "none",
    allowAnonymousIdentity: input.body.allow_anonymous_identity ?? false,
    anonymousIdentityScope: input.body.allow_anonymous_identity ? (input.body.anonymous_identity_scope ?? null) : null,
    governanceMode: input.body.governance_mode ?? "centralized",
    handlePolicyTemplate: input.body.handle_policy?.policy_template ?? "premium",
    pricingModel: input.body.handle_policy?.pricing_model ?? "flat_by_length",
    handlePolicySettings: (input.body.handle_policy?.pricing_model ?? "flat_by_length") === "free"
      ? null
      : {
          flat_price_cents: 500,
          premium_price_cents: 2500,
          premium_max_length: 4,
          min_length: 3,
          max_length: 32,
          special_price_cents_by_label: {
            crown: 100000,
            "xn--2p8h": 100000,
            prince: 50000,
            "xn--tq9h": 50000,
            princess: 50000,
            "xn--6q8h": 50000,
            diamond: 75000,
            "xn--tr8h": 75000,
            ring: 50000,
            "xn--sr8h": 50000,
            "xn--cs8h": 50000,
            "xn--cz8h": 25000,
          },
        },
    gatePolicy: buildBootstrapGatePolicy(input.body),
    rules: buildBootstrapRules(input.body),
    initialSettings: buildBootstrapInitialSettings(input.body),
    now: input.auth.createdAt,
  })
}
