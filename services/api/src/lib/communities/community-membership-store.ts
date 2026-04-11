import type { Client, InValue, Transaction } from "@libsql/client"
import { makeId } from "../helpers"
import { requiredString, rowValue, stringOrNull } from "../sql-row"
import type { Post, User, WalletAttachmentSummary } from "../../types"

type SqlExecutor = Pick<Client, "execute"> | Pick<Transaction, "execute">

export type CommunityMembershipRow = {
  membership_status: "member" | "left" | "banned" | null
  role_status: "active" | "revoked" | null
}

export type CommunityRoleAccessRow = {
  owner_active: boolean
  admin_active: boolean
  moderator_active: boolean
}

export type MembershipRequestRow = {
  membership_request_id: string
  community_id: string
  applicant_user_id: string
  status: "pending" | "approved" | "rejected" | "canceled" | "expired"
  note: string | null
  reviewed_by_user_id: string | null
  review_reason: string | null
  resolved_at: string | null
  expires_at: string | null
  created_at: string
  updated_at: string
}

type CommunityJoinModeRow = {
  membership_mode: "open" | "request" | "gated"
}

export type CommunityGateRuleRow = {
  gate_rule_id: string
  community_id: string
  scope: "membership" | "viewer" | "posting"
  gate_family: "identity_proof" | "token_holding"
  gate_type: string
  proof_requirements_json: string | null
  chain_namespace: string | null
  gate_config_json: string | null
  status: "active" | "disabled"
  created_at: string
  updated_at: string
}

type ProofRequirement = {
  proof_type: string
  accepted_providers?: string[] | null
  accepted_mechanisms?: string[] | null
  config?: Record<string, unknown> | null
}

export type TokenGateEvaluator = (input: {
  rule: CommunityGateRuleRow
  gateConfig: Record<string, unknown> | null
  wallets: WalletAttachmentSummary[]
}) => Promise<boolean>

export type GateEvaluationContext = {
  user: User
  wallets: WalletAttachmentSummary[]
  tokenGateEvaluator?: TokenGateEvaluator
}

async function firstRow(executor: SqlExecutor, sql: string, args: InValue[]): Promise<unknown | null> {
  const result = await executor.execute({ sql, args })
  return result.rows[0] ?? null
}

export async function getCommunityMembershipState(
  executor: SqlExecutor,
  communityId: string,
  userId: string,
): Promise<CommunityMembershipRow> {
  const row = await firstRow(
    executor,
    `
      SELECT
        (
          SELECT status
          FROM community_memberships
          WHERE community_id = ?1
            AND user_id = ?2
          ORDER BY created_at DESC
          LIMIT 1
        ) AS membership_status,
        (
          SELECT status
          FROM community_roles
          WHERE community_id = ?1
            AND user_id = ?2
            AND role = 'owner'
          ORDER BY created_at DESC
          LIMIT 1
        ) AS role_status
    `,
    [communityId, userId],
  )

  return {
    membership_status: stringOrNull(rowValue(row, "membership_status")) as CommunityMembershipRow["membership_status"],
    role_status: stringOrNull(rowValue(row, "role_status")) as CommunityMembershipRow["role_status"],
  }
}

export function canAccessCommunity(state: CommunityMembershipRow): boolean {
  return state.membership_status === "member" || state.role_status === "active"
}

export async function getCommunityJoinMode(executor: SqlExecutor, communityId: string): Promise<CommunityJoinModeRow["membership_mode"] | null> {
  const row = await firstRow(
    executor,
    `
      SELECT membership_mode
      FROM communities
      WHERE community_id = ?1
      LIMIT 1
    `,
    [communityId],
  )

  return row ? requiredString(row, "membership_mode") as CommunityJoinModeRow["membership_mode"] : null
}

export async function getCommunityRoleAccessState(
  executor: SqlExecutor,
  communityId: string,
  userId: string,
): Promise<CommunityRoleAccessRow> {
  const row = await firstRow(
    executor,
    `
      SELECT
        EXISTS(
          SELECT 1
          FROM community_roles
          WHERE community_id = ?1
            AND user_id = ?2
            AND role = 'owner'
            AND status = 'active'
        ) AS owner_active,
        EXISTS(
          SELECT 1
          FROM community_roles
          WHERE community_id = ?1
            AND user_id = ?2
            AND role = 'admin'
            AND status = 'active'
        ) AS admin_active,
        EXISTS(
          SELECT 1
          FROM community_roles
          WHERE community_id = ?1
            AND user_id = ?2
            AND role = 'moderator'
            AND status = 'active'
        ) AS moderator_active
    `,
    [communityId, userId],
  )

  return {
    owner_active: Boolean(Number(rowValue(row, "owner_active") ?? 0)),
    admin_active: Boolean(Number(rowValue(row, "admin_active") ?? 0)),
    moderator_active: Boolean(Number(rowValue(row, "moderator_active") ?? 0)),
  }
}

export function canModerateMembershipRequests(state: CommunityRoleAccessRow): boolean {
  return state.owner_active || state.admin_active || state.moderator_active
}

function toCommunityGateRuleRow(row: unknown): CommunityGateRuleRow {
  return {
    gate_rule_id: requiredString(row, "gate_rule_id"),
    community_id: requiredString(row, "community_id"),
    scope: requiredString(row, "scope") as CommunityGateRuleRow["scope"],
    gate_family: requiredString(row, "gate_family") as CommunityGateRuleRow["gate_family"],
    gate_type: requiredString(row, "gate_type"),
    proof_requirements_json: stringOrNull(rowValue(row, "proof_requirements_json")),
    chain_namespace: stringOrNull(rowValue(row, "chain_namespace")),
    gate_config_json: stringOrNull(rowValue(row, "gate_config_json")),
    status: requiredString(row, "status") as CommunityGateRuleRow["status"],
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

export async function listCommunityGateRules(client: Client, communityId: string): Promise<CommunityGateRuleRow[]> {
  const result = await client.execute({
    sql: `
      SELECT gate_rule_id, community_id, scope, gate_family, gate_type, proof_requirements_json, chain_namespace, gate_config_json, status, created_at, updated_at
      FROM community_gate_rules
      WHERE community_id = ?1
      ORDER BY created_at ASC
    `,
    args: [communityId],
  })

  return result.rows.map((row) => toCommunityGateRuleRow(row))
}

export async function listActiveCommunityGateRules(
  client: Client,
  communityId: string,
  scope: CommunityGateRuleRow["scope"],
): Promise<CommunityGateRuleRow[]> {
  const result = await client.execute({
    sql: `
      SELECT gate_rule_id, community_id, scope, gate_family, gate_type, proof_requirements_json, chain_namespace, gate_config_json, status, created_at, updated_at
      FROM community_gate_rules
      WHERE community_id = ?1
        AND scope = ?2
        AND status = 'active'
      ORDER BY created_at ASC
    `,
    args: [communityId, scope],
  })

  return result.rows.map((row) => toCommunityGateRuleRow(row))
}

export async function listActiveMembershipGateRules(client: Client, communityId: string): Promise<CommunityGateRuleRow[]> {
  return listActiveCommunityGateRules(client, communityId, "membership")
}

export async function getCommunityGateRuleById(
  client: Client,
  communityId: string,
  gateRuleId: string,
): Promise<CommunityGateRuleRow | null> {
  const row = await firstRow(
    client,
    `
      SELECT gate_rule_id, community_id, scope, gate_family, gate_type, proof_requirements_json, chain_namespace, gate_config_json, status, created_at, updated_at
      FROM community_gate_rules
      WHERE community_id = ?1
        AND gate_rule_id = ?2
      LIMIT 1
    `,
    [communityId, gateRuleId],
  )

  return row ? toCommunityGateRuleRow(row) : null
}

function toMembershipRequestRow(row: unknown): MembershipRequestRow {
  return {
    membership_request_id: requiredString(row, "membership_request_id"),
    community_id: requiredString(row, "community_id"),
    applicant_user_id: requiredString(row, "applicant_user_id"),
    status: requiredString(row, "status") as MembershipRequestRow["status"],
    note: stringOrNull(rowValue(row, "note")),
    reviewed_by_user_id: stringOrNull(rowValue(row, "reviewed_by_user_id")),
    review_reason: stringOrNull(rowValue(row, "review_reason")),
    resolved_at: stringOrNull(rowValue(row, "resolved_at")),
    expires_at: stringOrNull(rowValue(row, "expires_at")),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

export async function listPendingMembershipRequests(client: Client, communityId: string): Promise<MembershipRequestRow[]> {
  const result = await client.execute({
    sql: `
      SELECT membership_request_id, community_id, applicant_user_id, status, note, reviewed_by_user_id,
             review_reason, resolved_at, expires_at, created_at, updated_at
      FROM membership_requests
      WHERE community_id = ?1
        AND status = 'pending'
      ORDER BY created_at ASC
    `,
    args: [communityId],
  })

  return result.rows.map((row) => toMembershipRequestRow(row))
}

export async function listActiveCommunityMemberUserIds(
  executor: SqlExecutor,
  communityId: string,
): Promise<string[]> {
  const result = await executor.execute({
    sql: `
      SELECT user_id
      FROM community_memberships
      WHERE community_id = ?1
        AND status = 'member'
      ORDER BY joined_at ASC, created_at ASC
    `,
    args: [communityId],
  })

  return result.rows
    .map((row) => stringOrNull(rowValue(row, "user_id")))
    .filter((userId): userId is string => Boolean(userId))
}

export async function getMembershipRequestById(
  executor: SqlExecutor,
  communityId: string,
  membershipRequestId: string,
): Promise<MembershipRequestRow | null> {
  const row = await firstRow(
    executor,
    `
      SELECT membership_request_id, community_id, applicant_user_id, status, note, reviewed_by_user_id,
             review_reason, resolved_at, expires_at, created_at, updated_at
      FROM membership_requests
      WHERE community_id = ?1
        AND membership_request_id = ?2
      LIMIT 1
    `,
    [communityId, membershipRequestId],
  )

  return row ? toMembershipRequestRow(row) : null
}

function parseProofRequirements(raw: string | null, fallbackGateType: string): ProofRequirement[] {
  if (!raw) {
    return [{ proof_type: fallbackGateType }]
  }
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed as ProofRequirement[] : [{ proof_type: fallbackGateType }]
  } catch {
    return [{ proof_type: fallbackGateType }]
  }
}

function parseGateConfig(raw: string | null): Record<string, unknown> | null {
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function includesAcceptedProvider(acceptedProviders: string[] | null | undefined, provider: string | null | undefined): boolean {
  if (!acceptedProviders?.length) {
    return true
  }
  return provider != null && acceptedProviders.includes(provider)
}

function gateAppliesToPostType(
  gateConfig: Record<string, unknown> | null,
  postType: Post["post_type"] | null | undefined,
): boolean {
  if (!postType) {
    return true
  }

  const configuredPostTypes = Array.isArray(gateConfig?.post_types)
    ? gateConfig.post_types.filter((value): value is Post["post_type"] => (
      value === "text"
      || value === "image"
      || value === "video"
      || value === "link"
      || value === "song"
    ))
    : []

  if (configuredPostTypes.length === 0) {
    return true
  }

  return configuredPostTypes.includes(postType)
}

function satisfiesProofRequirement(user: User, requirement: ProofRequirement, gateConfig: Record<string, unknown> | null): boolean {
  switch (requirement.proof_type) {
    case "unique_human":
      return user.verification_capabilities.unique_human.state === "verified"
        && includesAcceptedProvider(requirement.accepted_providers, user.verification_capabilities.unique_human.provider)
    case "age_over_18":
      return user.verification_capabilities.age_over_18.state === "verified"
        && includesAcceptedProvider(requirement.accepted_providers, user.verification_capabilities.age_over_18.provider)
    case "nationality": {
      const capability = user.verification_capabilities.nationality
      if (capability.state !== "verified" || !includesAcceptedProvider(requirement.accepted_providers, capability.provider)) {
        return false
      }
      const config = (requirement.config ?? gateConfig ?? {}) as Record<string, unknown>
      const requiredValue = typeof config.required_value === "string" ? config.required_value : null
      const excludedValues = Array.isArray(config.excluded_values) ? config.excluded_values.filter((value): value is string => typeof value === "string") : []
      if (requiredValue && capability.value !== requiredValue) {
        return false
      }
      if (capability.value && excludedValues.includes(capability.value)) {
        return false
      }
      return true
    }
    case "gender": {
      const capability = user.verification_capabilities.gender
      if (capability.state !== "verified" || !includesAcceptedProvider(requirement.accepted_providers, capability.provider)) {
        return false
      }
      const config = (requirement.config ?? gateConfig ?? {}) as Record<string, unknown>
      const requiredValue = typeof config.required_value === "string" ? config.required_value : null
      return requiredValue ? capability.value === requiredValue : true
    }
    case "sanctions_clear":
      return user.verification_capabilities.sanctions_clear.state === "verified"
        && includesAcceptedProvider(requirement.accepted_providers, user.verification_capabilities.sanctions_clear.provider)
    case "wallet_score": {
      const capability = user.verification_capabilities.wallet_score
      if (
        capability.state !== "verified"
        || capability.passing_score !== true
        || !includesAcceptedProvider(requirement.accepted_providers, capability.provider)
      ) {
        return false
      }
      const config = (requirement.config ?? gateConfig ?? {}) as Record<string, unknown>
      const minimumScore = typeof config.minimum_score === "number" ? config.minimum_score : null
      return minimumScore == null || (typeof capability.score === "number" && capability.score >= minimumScore)
    }
    default:
      return false
  }
}

export async function satisfiesCommunityGateRules(
  rules: CommunityGateRuleRow[],
  context: GateEvaluationContext,
  options?: {
    postType?: Post["post_type"] | null
  },
): Promise<boolean> {
  if (rules.length === 0) {
    return false
  }

  for (const rule of rules) {
    const gateConfig = parseGateConfig(rule.gate_config_json)
    if (!gateAppliesToPostType(gateConfig, options?.postType)) {
      continue
    }

    if (rule.gate_family === "token_holding") {
      if (!context.tokenGateEvaluator) {
        return false
      }

      const passesTokenGate = await context.tokenGateEvaluator({
        rule,
        gateConfig,
        wallets: context.wallets,
      })
      if (!passesTokenGate) {
        return false
      }
      continue
    }

    if (rule.gate_family !== "identity_proof") {
      return false
    }

    const requirements = parseProofRequirements(rule.proof_requirements_json, rule.gate_type)
    const passesIdentityGate = requirements.every((requirement) => satisfiesProofRequirement(context.user, requirement, gateConfig))
    if (!passesIdentityGate) {
      return false
    }
  }

  return true
}

export async function satisfiesMembershipGateRules(
  rules: CommunityGateRuleRow[],
  context: GateEvaluationContext,
): Promise<boolean> {
  return await satisfiesCommunityGateRules(rules, context)
}

export async function upsertCommunityGateRule(input: {
  client: SqlExecutor
  gateRuleId: string
  communityId: string
  scope: CommunityGateRuleRow["scope"]
  gateFamily: CommunityGateRuleRow["gate_family"]
  gateType: CommunityGateRuleRow["gate_type"]
  proofRequirementsJson: string | null
  chainNamespace: string | null
  gateConfigJson: string | null
  status: CommunityGateRuleRow["status"]
  createdAt: string
  updatedAt: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      INSERT INTO community_gate_rules (
        gate_rule_id, community_id, scope, gate_family, gate_type, proof_requirements_json,
        chain_namespace, gate_config_json, status, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6,
        ?7, ?8, ?9, ?10, ?11
      )
      ON CONFLICT(gate_rule_id) DO UPDATE SET
        community_id = excluded.community_id,
        scope = excluded.scope,
        gate_family = excluded.gate_family,
        gate_type = excluded.gate_type,
        proof_requirements_json = excluded.proof_requirements_json,
        chain_namespace = excluded.chain_namespace,
        gate_config_json = excluded.gate_config_json,
        status = excluded.status,
        updated_at = excluded.updated_at
    `,
    args: [
      input.gateRuleId,
      input.communityId,
      input.scope,
      input.gateFamily,
      input.gateType,
      input.proofRequirementsJson,
      input.chainNamespace,
      input.gateConfigJson,
      input.status,
      input.createdAt,
      input.updatedAt,
    ],
  })
}

export async function upsertCommunityMembership(input: {
  client: SqlExecutor
  communityId: string
  userId: string
  now: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      INSERT INTO community_memberships (
        membership_id, community_id, user_id, status, joined_at, left_at, banned_at, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, 'member', ?4, NULL, NULL, ?4, ?4
      )
      ON CONFLICT(membership_id) DO UPDATE SET
        status = excluded.status,
        joined_at = excluded.joined_at,
        left_at = excluded.left_at,
        banned_at = excluded.banned_at,
        updated_at = excluded.updated_at
    `,
    args: [`mbr_${input.communityId}_${input.userId}`, input.communityId, input.userId, input.now],
  })
}

export async function upsertMembershipRequest(input: {
  client: SqlExecutor
  communityId: string
  userId: string
  now: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      INSERT INTO membership_requests (
        membership_request_id, community_id, applicant_user_id, status, note, reviewed_by_user_id,
        review_reason, resolved_at, expires_at, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, 'pending', NULL, NULL,
        NULL, NULL, NULL, ?4, ?4
      )
      ON CONFLICT(community_id, applicant_user_id) WHERE status = 'pending' DO UPDATE SET
        updated_at = excluded.updated_at
    `,
    args: [makeId("mrq"), input.communityId, input.userId, input.now],
  })
}

export async function resolvePendingMembershipRequestsAsApproved(input: {
  client: SqlExecutor
  communityId: string
  userId: string
  reviewerUserId: string | null
  reviewReason: string | null
  now: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      UPDATE membership_requests
      SET status = 'approved',
          reviewed_by_user_id = ?4,
          review_reason = ?5,
          resolved_at = ?3,
          updated_at = ?3
      WHERE community_id = ?1
        AND applicant_user_id = ?2
        AND status = 'pending'
    `,
    args: [input.communityId, input.userId, input.now, input.reviewerUserId, input.reviewReason],
  })
}

export async function resolveMembershipRequestAsApproved(input: {
  client: SqlExecutor
  membershipRequestId: string
  reviewerUserId: string
  reviewReason: string | null
  now: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      UPDATE membership_requests
      SET status = 'approved',
          reviewed_by_user_id = ?2,
          review_reason = ?3,
          resolved_at = ?4,
          updated_at = ?4
      WHERE membership_request_id = ?1
        AND status = 'pending'
    `,
    args: [input.membershipRequestId, input.reviewerUserId, input.reviewReason, input.now],
  })
}

export async function resolveMembershipRequestAsRejected(input: {
  client: SqlExecutor
  membershipRequestId: string
  reviewerUserId: string
  reviewReason: string | null
  now: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      UPDATE membership_requests
      SET status = 'rejected',
          reviewed_by_user_id = ?2,
          review_reason = ?3,
          resolved_at = ?4,
          updated_at = ?4
      WHERE membership_request_id = ?1
        AND status = 'pending'
    `,
    args: [input.membershipRequestId, input.reviewerUserId, input.reviewReason, input.now],
  })
}
