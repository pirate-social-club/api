import type { UserRepository } from "../auth/repositories"
import type {
  CommunityDatabaseBindingRepository,
  CommunityReadRepository,
} from "./db-community-repository"
import { eligibilityFailed, internalError, notFoundError } from "../errors"
import { makeId, nowIso } from "../helpers"
import { getControlPlaneClient } from "../runtime-deps"
import { openCommunityDb } from "./community-db-factory"
import {
  assertPublicV0GateConfiguration,
  assertUpdateCommunityGatesRequest,
  communityMutationActorFromUserId,
  loadCommunityProjection,
  requireAdminOverrideOrOwnedCommunity,
  type CommunityMutationActor,
  type UpdateCommunityGatesRequestBody,
} from "./create/shared"
import type {
  Community,
  Env,
} from "../../types"

type CommunityAccessAuditSnapshot = {
  membership_mode: string
  default_age_gate_policy: string
  allow_anonymous_identity: boolean
  anonymous_identity_scope: string | null
}

type CommunityGateRuleAuditSnapshot = {
  gate_rule_id: string
  scope: string
  gate_family: string
  gate_type: string
  proof_requirements: unknown
  chain_namespace: string | null
  gate_config: unknown
  status: string
}

function parseJsonSnapshot(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) {
    return null
  }
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function accessSnapshotFromRow(row: Record<string, unknown>): CommunityAccessAuditSnapshot {
  return {
    membership_mode: String(row.membership_mode),
    default_age_gate_policy: String(row.default_age_gate_policy),
    allow_anonymous_identity: Number(row.allow_anonymous_identity) === 1,
    anonymous_identity_scope: row.anonymous_identity_scope == null ? null : String(row.anonymous_identity_scope),
  }
}

function gateRuleSnapshotFromRow(row: Record<string, unknown>): CommunityGateRuleAuditSnapshot {
  return {
    gate_rule_id: String(row.gate_rule_id),
    scope: String(row.scope),
    gate_family: String(row.gate_family),
    gate_type: String(row.gate_type),
    proof_requirements: parseJsonSnapshot(row.proof_requirements_json),
    chain_namespace: row.chain_namespace == null ? null : String(row.chain_namespace),
    gate_config: parseJsonSnapshot(row.gate_config_json),
    status: String(row.status),
  }
}

async function recordCommunityGateUpdateAudit(input: {
  env: Env
  actorUserId: string
  communityId: string
  previousAccess: CommunityAccessAuditSnapshot | null
  nextAccess: CommunityAccessAuditSnapshot
  previousGateRules: CommunityGateRuleAuditSnapshot[]
  nextGateRules: CommunityGateRuleAuditSnapshot[]
  createdAt: string
}): Promise<void> {
  await getControlPlaneClient(input.env).execute({
    sql: `
      INSERT INTO audit_log (
        audit_event_id, actor_type, actor_id, action, target_type, target_id, community_id, metadata_json, created_at
      ) VALUES (
        ?1, 'user', ?2, 'community.gates_updated', 'community', ?3, ?3, ?4, ?5
      )
    `,
    args: [
      makeId("aud"),
      input.actorUserId,
      input.communityId,
      JSON.stringify({
        previous_access: input.previousAccess,
        next_access: input.nextAccess,
        previous_gate_rules: input.previousGateRules,
        next_gate_rules: input.nextGateRules,
      }),
      input.createdAt,
    ],
  })
}

type CommunityGateSettingsRepository = CommunityReadRepository & CommunityDatabaseBindingRepository

export async function updateCommunityGates(input: {
  env: Env
  userId?: string
  actor?: CommunityMutationActor
  communityId: string
  body: UpdateCommunityGatesRequestBody | null
  communityRepository: CommunityGateSettingsRepository
  userRepository: UserRepository
}): Promise<Community> {
  assertUpdateCommunityGatesRequest(input.body)
  const actor = input.actor ?? communityMutationActorFromUserId(input.userId ?? "")
  await requireAdminOverrideOrOwnedCommunity({
    env: input.env,
    repo: input.communityRepository,
    communityId: input.communityId,
    actor,
    action: "community.gates_updated",
  })

  const user = await input.userRepository.getUserById(actor.userId)
  if (!user) {
    throw internalError("Resolved user row is missing for community gates update")
  }

  assertPublicV0GateConfiguration(input.body, {
    ageOver18Verified: user.verification_capabilities.age_over_18.state === "verified",
  })

  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)

  try {
    const now = nowIso()
    let previousAccess: CommunityAccessAuditSnapshot | null = null
    let previousGateRules: CommunityGateRuleAuditSnapshot[] = []
    const nextAccess: CommunityAccessAuditSnapshot = {
      membership_mode: input.body.membership_mode,
      default_age_gate_policy: input.body.default_age_gate_policy ?? "none",
      allow_anonymous_identity: input.body.allow_anonymous_identity,
      anonymous_identity_scope: input.body.allow_anonymous_identity ? (input.body.anonymous_identity_scope ?? null) : null,
    }
    const nextGateRules: CommunityGateRuleAuditSnapshot[] = []
    const tx = await db.client.transaction("write")
    try {
      const currentAccessRows = await tx.execute({
        sql: `
          SELECT membership_mode, default_age_gate_policy, allow_anonymous_identity, anonymous_identity_scope
          FROM communities
          WHERE community_id = ?1
        `,
        args: [input.communityId],
      })
      previousAccess = currentAccessRows.rows[0]
        ? accessSnapshotFromRow(currentAccessRows.rows[0] as Record<string, unknown>)
        : null

      if (
        previousAccess?.default_age_gate_policy !== "18_plus"
        && nextAccess.default_age_gate_policy === "18_plus"
      ) {
        throw eligibilityFailed("18_plus can only be set during community creation")
      }

      const currentGateRuleRows = await tx.execute({
        sql: `
          SELECT gate_rule_id, scope, gate_family, gate_type, proof_requirements_json,
                 chain_namespace, gate_config_json, status
          FROM community_gate_rules
          WHERE community_id = ?1
          ORDER BY created_at ASC, gate_rule_id ASC
        `,
        args: [input.communityId],
      })
      previousGateRules = currentGateRuleRows.rows.map((row) => gateRuleSnapshotFromRow(row as Record<string, unknown>))

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
        const proofRequirementsJson = rule.proof_requirements ? JSON.stringify(rule.proof_requirements) : null
        const gateConfigJson = rule.gate_config ? JSON.stringify(rule.gate_config) : null
        nextGateRules.push({
          gate_rule_id: gateRuleId,
          scope: rule.scope,
          gate_family: rule.gate_family,
          gate_type: rule.gate_type,
          proof_requirements: rule.proof_requirements ?? null,
          chain_namespace: rule.chain_namespace ?? null,
          gate_config: rule.gate_config ?? null,
          status: "active",
        })
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
            proofRequirementsJson,
            rule.chain_namespace ?? null,
            gateConfigJson,
            now,
          ],
        })
      }

      await tx.commit()
    } catch (error) {
      try {
        await tx.rollback()
      } catch (rollbackError) {
        console.error("[community-gate-settings] rollback failed while updating gate settings", rollbackError)
      }
      throw error
    } finally {
      tx.close()
    }
    await recordCommunityGateUpdateAudit({
      env: input.env,
      actorUserId: actor.userId,
      communityId: input.communityId,
      previousAccess,
      nextAccess,
      previousGateRules,
      nextGateRules,
      createdAt: now,
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
