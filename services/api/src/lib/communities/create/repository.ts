import {
  bootstrapLocalCommunityDb,
  buildCommunitySeedStatements,
  type LocalCommunityBootstrapInput,
  type LocalCommunityRule,
  type LocalCommunitySnapshot,
} from "../community-local-db"
import {
  COMMUNITY_SCHEMA_MIGRATIONS,
  COMMUNITY_SCHEMA_STATEMENTS,
} from "../provisioning/generated/community-schema-snapshot"
import { serializeLocalDonationPartnerRow } from "../community-donation-partner-serialization"
import { normalizeCommunityMediaRef } from "../community-identity-media"
import type { CommunityRow, JobRow } from "../../auth/auth-db-rows"
import type {
  CommunityDatabaseBindingRepository,
  CommunityReadRepository,
} from "../db-community-repository"
import { eligibilityFailed, internalError, notFoundError } from "../../errors"
import { makeId, nowIso } from "../../helpers"
import { writeAuditEventForEnv } from "../../audit"
import type { ActorContext, AdminActorContext } from "../../auth-middleware"
import type { Env } from "../../../env"
import type { Community } from "../../../types"
import { serializeCommunity } from "../community-serialization"
import { openCommunityReadClient } from "../community-read-access"
import { normalizeCommunityCountryCode } from "../country-code"
import type { GatePolicy } from "../membership/gate-types"
import { normalizeStoredGatePolicy } from "../membership/gate-policy-validation"
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

/**
 * Synthetic binding URL for a community that is being provisioned D1-native but
 * has not yet had a binding allocated from the shard pool. Resolved to
 * `d1://shard/<bindingName>` once allocation completes.
 */
export function buildPendingD1CommunityBindingUrl(communityId: string): string {
  return `d1://pending-${communityId}.invalid`
}

export function isPendingD1CommunityBindingUrl(value: string | null | undefined): boolean {
  const normalized = String(value ?? "").trim().toLowerCase()
  return normalized.startsWith("d1://pending-") && normalized.endsWith(".invalid")
}

export function isExpired(timestamp: string | number): boolean {
  const expiresAt = typeof timestamp === "number" ? timestamp * 1000 : Date.parse(timestamp)
  if (!Number.isFinite(expiresAt)) {
    throw eligibilityFailed("Namespace verification expiry is invalid")
  }
  return expiresAt <= Date.now()
}

const RUNNING_JOB_HEARTBEAT_TIMEOUT_MS = 30_000

export type ProvisioningRetryAction =
  | { action: "return_existing" }
  | { action: "retry" }

export async function resolveProvisioningRetryAction(
  _repo: CommunityDatabaseBindingRepository,
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

  return { action: "retry" }
}

export async function loadCommunityLocalSnapshot(
  env: Env,
  repo: CommunityDatabaseBindingRepository,
  communityId: string,
): Promise<LocalCommunitySnapshot | null> {
  // Routed read via the D1 shard read RPC. Read-only (SELECTs only). Closes #48 for
  // donation/rules/gate snapshot reads. Falls back to null on any open failure, as before.
  const db = await openCommunityReadClient(env, repo, communityId).catch(() => null)
  if (!db) {
    return null
  }

  try {
    const columnsResult = await db.client.execute("PRAGMA table_info(communities)")
    const communityColumns = new Set(columnsResult.rows.map((row) => String(row.name)))
    const hasKaraokeEnabledColumn = communityColumns.has("karaoke_enabled")
    const result = await db.client.execute({
      sql: `
        SELECT community_id, display_name, description, avatar_ref, banner_ref, status, membership_mode, default_age_gate_policy,
               allow_anonymous_identity, anonymous_identity_scope, donation_policy_mode, donation_partner_id, donation_partner_status,
               settings_json${hasKaraokeEnabledColumn ? ", karaoke_enabled" : ""},
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
      : normalizeStoredGatePolicy(JSON.parse(String(gatePolicyResult.rows[0].expression_json)))

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

function resolvePublicV0MembershipMode(mode: CreateCommunityRequestBody["membership_mode"] | null | undefined): "request" | "gated" {
  return mode === "request" ? "request" : "gated"
}

export type CommunityBootstrapRequest = {
  env: Env
  body: CreateCommunityRequestBody
  auth: CreateCommunityAuth
  communityId: string
  namespaceVerificationId: string | null
  namespaceLabel: string | null
}

/**
 * Build the `LocalCommunityBootstrapInput` from a community-create request.
 * Shared by `bootstrapCommunityLocalSnapshot` (operator/local path, which writes
 * it to a libsql file) and the d1_native translator (`localCommunityShardStatements`),
 * so the two paths derive the identical bootstrap input — no drift.
 */
export function buildLocalCommunityBootstrapInput(
  input: CommunityBootstrapRequest,
  rootDir: string,
): LocalCommunityBootstrapInput {
  return {
    rootDir,
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
  }
}

export async function bootstrapCommunityLocalSnapshot(input: CommunityBootstrapRequest): Promise<LocalCommunitySnapshot> {
  return bootstrapLocalCommunityDb(buildLocalCommunityBootstrapInput(input, resolveCommunityDbRoot(input.env)))
}

/**
 * §8.7: the d1_native schema+data load, as `ShardSqlStatement[]` for
 * `communityD1LoadSnapshot`. Three parts, all CREATE/INSERT (guard-compatible):
 *   1. the bundled final-form schema (COMMUNITY_SCHEMA_STATEMENTS — generated),
 *   2. a `schema_migrations` seed per template migration (so schema-state checks
 *      see the same applied set the operator records),
 *   3. the community data seed (buildCommunitySeedStatements — the SAME pure
 *      generator the operator path executes, so the two can't drift).
 */
export function localCommunityShardStatements(input: CommunityBootstrapRequest): { sql: string; args?: (string | number | null)[] }[] {
  // rootDir is a disk concern of bootstrapLocalCommunityDb; the d1 path never
  // writes to disk (buildCommunitySeedStatements ignores it), so a placeholder
  // avoids requiring LOCAL_COMMUNITY_DB_ROOT on the d1_native worker.
  const bootstrapInput = buildLocalCommunityBootstrapInput(input, "d1-native")
  return [
    ...COMMUNITY_SCHEMA_STATEMENTS.map((sql) => ({ sql })),
    ...COMMUNITY_SCHEMA_MIGRATIONS.map((m) => ({
      sql: "INSERT INTO schema_migrations (migration_name, migration_label, checksum) VALUES (?1, 'community-template', ?2)",
      args: [m.name, m.checksum] as (string | number | null)[],
    })),
    ...buildCommunitySeedStatements(bootstrapInput).map((s) => ({ sql: s.sql, args: s.args })),
  ]
}
