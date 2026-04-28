import {
  bootstrapLocalCommunityDb,
  type LocalCommunityRule,
  type LocalCommunitySnapshot,
} from "../community-local-db"
import { serializeDonationPartnerRow } from "../community-donation-partner-serialization"
import { normalizeCommunityMediaRef } from "../community-identity-media"
import type { CommunityDatabaseBindingRow, CommunityRow, JobRow } from "../../auth/auth-db-rows"
import type {
  CommunityDatabaseBindingRepository,
  CommunityReadRepository,
} from "../db-community-repository"
import { badRequestError, eligibilityFailed, internalError, notFoundError } from "../../errors"
import { makeId, nowIso } from "../../helpers"
import { getControlPlaneClient } from "../../runtime-deps"
import type { ActorContext, AdminActorContext } from "../../auth-middleware"
import type { Community, Env } from "../../../types"
import { serializeCommunity } from "../community-serialization"
import { openCommunityDb } from "../community-db-factory"
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
        donation_partner = serializeDonationPartnerRow(partnerRow)
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
  await getControlPlaneClient(input.env).execute({
    sql: `
      INSERT INTO audit_log (
        audit_event_id, actor_type, actor_id, action, target_type, target_id, community_id, metadata_json, created_at
      ) VALUES (
        ?1, 'operator', ?2, ?3, 'community', ?4, ?4, ?5, ?6
      )
    `,
    args: [
      makeId("aud"),
      input.actor.adminOverride.adminActorId,
      input.action,
      input.communityId,
      JSON.stringify({
        scope: input.actor.adminOverride.scope,
        acting_user_id: input.actor.userId,
        owner_user_id: community.creator_user_id,
      }),
      now,
    ],
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

export function buildBootstrapGateRules(body: CreateCommunityRequestBody) {
  return (body.gate_rules ?? []).map((rule) => ({
    scope: rule.scope,
    gateFamily: rule.gate_family,
    gateType: rule.gate_type,
    proofRequirementsJson: rule.proof_requirements ? JSON.stringify(rule.proof_requirements) : null,
    chainNamespace: rule.chain_namespace ?? null,
    gateConfigJson: rule.gate_config ? JSON.stringify(rule.gate_config) : null,
  }))
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
  if (body.agent_posting_policy) {
    settings.agent_posting_policy = body.agent_posting_policy
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
  for (const rule of body.gate_rules ?? []) {
    if (rule.scope !== scope || rule.gate_family !== "identity_proof") {
      continue
    }

    for (const requirement of rule.proof_requirements ?? []) {
      if (
        requirement.proof_type !== "unique_human"
        && requirement.proof_type !== "age_over_18"
        && requirement.proof_type !== "minimum_age"
        && requirement.proof_type !== "nationality"
        && requirement.proof_type !== "gender"
      ) {
        continue
      }

      for (const provider of requirement.accepted_providers ?? []) {
        const normalized = normalizeHumanVerificationProvider(provider)
        if (normalized) {
          return normalized
        }
      }
    }
  }

  return normalizeHumanVerificationProvider(body.human_verification_lane)
}

export function buildProvisionOperatorBootstrapPayload(
  body: CreateCommunityRequestBody,
  namespaceLabel: string | null,
) {
  return {
    description: body.description?.trim() || null,
    membership_mode: body.membership_mode ?? "open",
    default_age_gate_policy: body.default_age_gate_policy ?? "none",
    membership_unique_human_provider: resolveScopeUniqueHumanProvider(body, "membership"),
    posting_unique_human_provider: resolveScopeUniqueHumanProvider(body, "posting"),
    handle_policy_template: body.handle_policy?.policy_template ?? "standard",
    handle_pricing_model: body.handle_policy?.pricing_model ?? null,
    namespace_label: namespaceLabel,
    initial_settings: buildBootstrapInitialSettings(body),
  }
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
    membershipMode: input.body.membership_mode ?? "open",
    defaultAgeGatePolicy: input.body.default_age_gate_policy ?? "none",
    allowAnonymousIdentity: input.body.allow_anonymous_identity ?? false,
    anonymousIdentityScope: input.body.allow_anonymous_identity ? (input.body.anonymous_identity_scope ?? null) : null,
    governanceMode: input.body.governance_mode ?? "centralized",
    handlePolicyTemplate: input.body.handle_policy?.policy_template ?? "standard",
    pricingModel: null,
    gateRules: buildBootstrapGateRules(input.body),
    rules: buildBootstrapRules(input.body),
    initialSettings: buildBootstrapInitialSettings(input.body),
    now: input.auth.createdAt,
  })
}
