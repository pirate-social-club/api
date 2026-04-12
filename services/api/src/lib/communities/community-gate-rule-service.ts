import { openCommunityDb } from "./community-db-factory"
import type { CommunityRepository } from "./control-plane-community-repository"
import {
  getCommunityGateRuleById,
  listCommunityGateRules as listLocalCommunityGateRules,
  type CommunityGateRuleRow,
  upsertCommunityGateRule as upsertLocalCommunityGateRule,
} from "./community-membership-store"
import { normalizeGateRuleInput } from "./community-gate-rule-normalization"
import { badRequestError, notFoundError } from "../errors"
import { makeId, nowIso } from "../helpers"
import { verifyPirateAccessToken } from "../auth/pirate-session-token"
import type { Env } from "../../types"

export type CommunityGateRuleResponse = {
  gate_rule_id: string
  community_id: string
  scope: CommunityGateRuleRow["scope"]
  gate_family: CommunityGateRuleRow["gate_family"]
  gate_type: CommunityGateRuleRow["gate_type"]
  proof_requirements: unknown[] | null
  chain_namespace: string | null
  gate_config: Record<string, unknown> | null
  status: CommunityGateRuleRow["status"]
  created_at: string
  updated_at: string
}

export type UpsertCommunityGateRuleRequest = {
  gate_rule_id?: string
  scope?: CommunityGateRuleRow["scope"]
  gate_family?: CommunityGateRuleRow["gate_family"]
  gate_type?: CommunityGateRuleRow["gate_type"]
  proof_requirements?: unknown[] | null
  chain_namespace?: string | null
  gate_config?: Record<string, unknown> | null
  status?: CommunityGateRuleRow["status"]
}

function serializeGateRule(row: CommunityGateRuleRow): CommunityGateRuleResponse {
  return {
    gate_rule_id: row.gate_rule_id,
    community_id: row.community_id,
    scope: row.scope,
    gate_family: row.gate_family,
    gate_type: row.gate_type,
    proof_requirements: row.proof_requirements_json ? JSON.parse(row.proof_requirements_json) as unknown[] : null,
    chain_namespace: row.chain_namespace,
    gate_config: row.gate_config_json ? JSON.parse(row.gate_config_json) as Record<string, unknown> : null,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

async function requireOwnedCommunity(
  repository: CommunityRepository,
  communityId: string,
  userId: string,
) {
  const community = await repository.getCommunityById(communityId)
  if (!community || community.creator_user_id !== userId) {
    throw notFoundError("Community not found")
  }
  return community
}

export async function listCommunityGateRules(input: {
  env: Env
  bearerToken: string
  communityId: string
  repository: CommunityRepository
}): Promise<CommunityGateRuleResponse[]> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  await requireOwnedCommunity(input.repository, input.communityId, session.userId)

  const db = await openCommunityDb(input.repository, input.communityId)
  try {
    const rules = await listLocalCommunityGateRules(db.client, input.communityId)
    return rules.map((rule) => serializeGateRule(rule))
  } finally {
    db.close()
  }
}

export async function upsertCommunityGateRule(input: {
  env: Env
  bearerToken: string
  communityId: string
  body: UpsertCommunityGateRuleRequest
  repository: CommunityRepository
}): Promise<CommunityGateRuleResponse> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  await requireOwnedCommunity(input.repository, input.communityId, session.userId)

  if (!input.body.scope || !input.body.gate_family || !input.body.gate_type) {
    throw badRequestError("scope, gate_family, and gate_type are required")
  }

  const normalized = normalizeGateRuleInput(input.body)
  const timestamp = nowIso()
  const gateRuleId = input.body.gate_rule_id?.trim() || makeId("gate")

  const db = await openCommunityDb(input.repository, input.communityId)
  try {
    const existing = await getCommunityGateRuleById(db.client, input.communityId, gateRuleId)
    await upsertLocalCommunityGateRule({
      client: db.client,
      gateRuleId,
      communityId: input.communityId,
      scope: input.body.scope,
      gateFamily: input.body.gate_family,
      gateType: input.body.gate_type,
      proofRequirementsJson: normalized.proofRequirementsJson,
      chainNamespace: normalized.chainNamespace,
      gateConfigJson: normalized.gateConfigJson,
      status: input.body.status ?? "active",
      createdAt: existing?.created_at ?? timestamp,
      updatedAt: timestamp,
    })

    const stored = await getCommunityGateRuleById(db.client, input.communityId, gateRuleId)
    if (!stored) {
      throw notFoundError("Community gate rule not found")
    }
    return serializeGateRule(stored)
  } finally {
    db.close()
  }
}
