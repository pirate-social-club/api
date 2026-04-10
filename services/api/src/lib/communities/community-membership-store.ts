import type { Client, InValue } from "@libsql/client"
import { makeId } from "../helpers"
import { requiredString, rowValue, stringOrNull } from "../sql-row"
import type { User } from "../../types"

export type CommunityMembershipRow = {
  membership_status: "member" | "left" | "banned" | null
  role_status: "active" | "revoked" | null
}

type CommunityJoinModeRow = {
  membership_mode: "open" | "request" | "gated"
}

type CommunityGateRuleRow = {
  gate_rule_id: string
  scope: "membership" | "viewer" | "posting"
  gate_family: "identity_proof" | "token_holding"
  gate_type: string
  proof_requirements_json: string | null
  chain_namespace: string | null
  gate_config_json: string | null
  status: "active" | "disabled"
}

type ProofRequirement = {
  proof_type: string
  accepted_providers?: string[] | null
  accepted_mechanisms?: string[] | null
  config?: Record<string, unknown> | null
}

async function firstRow(client: Client, sql: string, args: InValue[]): Promise<unknown | null> {
  const result = await client.execute({ sql, args })
  return result.rows[0] ?? null
}

export async function getCommunityMembershipState(
  client: Client,
  communityId: string,
  userId: string,
): Promise<CommunityMembershipRow> {
  const row = await firstRow(
    client,
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

export async function getCommunityJoinMode(client: Client, communityId: string): Promise<CommunityJoinModeRow["membership_mode"] | null> {
  const row = await firstRow(
    client,
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

function toCommunityGateRuleRow(row: unknown): CommunityGateRuleRow {
  return {
    gate_rule_id: requiredString(row, "gate_rule_id"),
    scope: requiredString(row, "scope") as CommunityGateRuleRow["scope"],
    gate_family: requiredString(row, "gate_family") as CommunityGateRuleRow["gate_family"],
    gate_type: requiredString(row, "gate_type"),
    proof_requirements_json: stringOrNull(rowValue(row, "proof_requirements_json")),
    chain_namespace: stringOrNull(rowValue(row, "chain_namespace")),
    gate_config_json: stringOrNull(rowValue(row, "gate_config_json")),
    status: requiredString(row, "status") as CommunityGateRuleRow["status"],
  }
}

export async function listActiveMembershipGateRules(client: Client, communityId: string): Promise<CommunityGateRuleRow[]> {
  const result = await client.execute({
    sql: `
      SELECT gate_rule_id, scope, gate_family, gate_type, proof_requirements_json, chain_namespace, gate_config_json, status
      FROM community_gate_rules
      WHERE community_id = ?1
        AND scope = 'membership'
        AND status = 'active'
      ORDER BY created_at ASC
    `,
    args: [communityId],
  })

  return result.rows.map((row) => toCommunityGateRuleRow(row))
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

export function satisfiesMembershipGateRules(rules: CommunityGateRuleRow[], user: User): boolean {
  if (rules.length === 0) {
    return false
  }

  return rules.every((rule) => {
    if (rule.gate_family !== "identity_proof") {
      return false
    }
    const gateConfig = parseGateConfig(rule.gate_config_json)
    const requirements = parseProofRequirements(rule.proof_requirements_json, rule.gate_type)
    return requirements.every((requirement) => satisfiesProofRequirement(user, requirement, gateConfig))
  })
}

export async function upsertCommunityMembership(input: {
  client: Client
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
  client: Client
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
