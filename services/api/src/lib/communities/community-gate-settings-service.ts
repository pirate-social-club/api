import type { UserRepository } from "../auth/repositories"
import type {
  CommunityDatabaseBindingRepository,
  CommunityReadRepository,
} from "./db-community-repository"
import { eligibilityFailed, internalError, notFoundError } from "../errors"
import { nowIso } from "../helpers"
import { writeAuditEventForEnv } from "../audit"
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

type CommunityGatePolicyAuditSnapshot = {
  scope: string
  version: number
  expression: unknown
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

function gatePolicySnapshotFromRow(row: Record<string, unknown>): CommunityGatePolicyAuditSnapshot {
  return {
    scope: String(row.scope),
    version: Number(row.version),
    expression: parseJsonSnapshot(row.expression_json),
  }
}

async function recordCommunityGateUpdateAudit(input: {
  env: Env
  actorUserId: string
  communityId: string
  previousAccess: CommunityAccessAuditSnapshot | null
  nextAccess: CommunityAccessAuditSnapshot
  previousGatePolicy: CommunityGatePolicyAuditSnapshot | null
  nextGatePolicy: CommunityGatePolicyAuditSnapshot | null
  createdAt: string
}): Promise<void> {
  await writeAuditEventForEnv(input.env, {
    action: "community.gates_updated",
    actorId: input.actorUserId,
    actorType: "user",
    communityId: input.communityId,
    createdAt: input.createdAt,
    targetId: input.communityId,
    targetType: "community",
    metadata: {
      previous_access: input.previousAccess,
      next_access: input.nextAccess,
      previous_gate_policy: input.previousGatePolicy,
      next_gate_policy: input.nextGatePolicy,
    },
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
    let previousGatePolicy: CommunityGatePolicyAuditSnapshot | null = null
    const nextAccess: CommunityAccessAuditSnapshot = {
      membership_mode: input.body.membership_mode,
      default_age_gate_policy: input.body.default_age_gate_policy ?? "none",
      allow_anonymous_identity: input.body.allow_anonymous_identity,
      anonymous_identity_scope: input.body.allow_anonymous_identity ? (input.body.anonymous_identity_scope ?? null) : null,
    }
    const nextGatePolicy: CommunityGatePolicyAuditSnapshot | null = input.body.gate_policy
      ? { scope: "membership", version: input.body.gate_policy.version, expression: input.body.gate_policy.expression }
      : null
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

      const currentGatePolicyRows = await tx.execute({
        sql: `
          SELECT scope, version, expression_json
          FROM community_gate_policies
          WHERE community_id = ?1
            AND scope = 'membership'
        `,
        args: [input.communityId],
      })
      previousGatePolicy = currentGatePolicyRows.rows[0]
        ? gatePolicySnapshotFromRow(currentGatePolicyRows.rows[0] as Record<string, unknown>)
        : null

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
          DELETE FROM community_gate_policies
          WHERE community_id = ?1
            AND scope = 'membership'
        `,
        args: [input.communityId],
      })

      if (input.body.gate_policy) {
        await tx.execute({
          sql: `
            INSERT INTO community_gate_policies (
              community_id, scope, version, expression_json, created_at, updated_at
            ) VALUES (
              ?1, 'membership', 1, ?2, ?3, ?3
            )
          `,
          args: [
            input.communityId,
            JSON.stringify(input.body.gate_policy),
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
      previousGatePolicy,
      nextGatePolicy,
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
