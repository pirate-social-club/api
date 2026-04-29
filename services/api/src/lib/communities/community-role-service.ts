import type { UserRepository } from "../auth/repositories"
import type { CommunityRow } from "../auth/auth-db-rows"
import type {
  CommunityDatabaseBindingRepository,
  CommunityReadRepository,
} from "./db-community-repository"
import { badRequestError, notFoundError } from "../errors"
import { makeId, nowIso } from "../helpers"
import { getControlPlaneClient } from "../runtime-deps"
import { openCommunityDb } from "./community-db-factory"
import {
  loadCommunityProjection,
  type CommunityMutationActor,
} from "./create/shared"
import type { Community, Env } from "../../types"

export type ManageableCommunityRole = "admin" | "moderator"

export type CommunityRoleMutationBody = {
  user_id?: string | null
  role?: string | null
}

type CommunityRoleRepository = CommunityReadRepository & CommunityDatabaseBindingRepository

function normalizeManageableRole(value: unknown): ManageableCommunityRole {
  if (value === "admin" || value === "moderator") {
    return value
  }
  throw badRequestError("role must be admin or moderator")
}

function normalizeUserId(value: unknown): string {
  if (typeof value !== "string") {
    throw badRequestError("user_id is required")
  }
  const trimmed = value.trim()
  if (!/^usr_[a-zA-Z0-9]+$/.test(trimmed)) {
    throw badRequestError("user_id must be a Pirate user id")
  }
  return trimmed
}

function auditActor(input: { actor: CommunityMutationActor }): { actorType: "operator" | "user"; actorId: string } {
  if ("adminOverride" in input.actor) {
    return {
      actorType: "operator",
      actorId: input.actor.adminOverride.adminActorId,
    }
  }
  return {
    actorType: "user",
    actorId: input.actor.userId,
  }
}

async function recordCommunityRoleAudit(input: {
  env: Env
  actor: CommunityMutationActor
  action: "community.role_granted" | "community.role_revoked"
  communityId: string
  targetUserId: string
  role: ManageableCommunityRole
  changed: boolean
  createdAt: string
}): Promise<void> {
  const actor = auditActor({ actor: input.actor })
  await getControlPlaneClient(input.env).execute({
    sql: `
      INSERT INTO audit_log (
        audit_event_id, actor_type, actor_id, action, target_type, target_id, community_id, metadata_json, created_at
      ) VALUES (
        ?1, ?2, ?3, ?4, 'user', ?5, ?6, ?7, ?8
      )
    `,
    args: [
      makeId("aud"),
      actor.actorType,
      actor.actorId,
      input.action,
      input.targetUserId,
      input.communityId,
      JSON.stringify({
        role: input.role,
        changed: input.changed,
        acting_user_id: input.actor.userId,
        admin_scope: "adminOverride" in input.actor ? input.actor.adminOverride.scope : null,
      }),
      input.createdAt,
    ],
  })
}

async function requireTargetUser(input: {
  userRepository: UserRepository
  userId: string
}): Promise<void> {
  const user = await input.userRepository.getUserById(input.userId)
  if (!user) {
    throw notFoundError("Target user not found")
  }
}

async function hasActiveCommunityAdminRole(input: {
  env: Env
  communityRepository: CommunityRoleRepository
  communityId: string
  userId: string
}): Promise<boolean> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    const result = await db.client.execute({
      sql: `
        SELECT role_assignment_id
        FROM community_roles
        WHERE community_id = ?1
          AND user_id = ?2
          AND role = 'admin'
          AND status = 'active'
        LIMIT 1
      `,
      args: [input.communityId, input.userId],
    })
    return Boolean(result.rows[0])
  } finally {
    db.close()
  }
}

async function requireCommunityRoleMutationPermission(input: {
  env: Env
  communityRepository: CommunityRoleRepository
  communityId: string
  actor: CommunityMutationActor
  role: ManageableCommunityRole
}): Promise<CommunityRow> {
  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!community) {
    throw notFoundError("Community not found")
  }

  if ("adminOverride" in input.actor || community.creator_user_id === input.actor.userId) {
    return community
  }

  if (
    input.role === "moderator"
    && await hasActiveCommunityAdminRole({
      env: input.env,
      communityRepository: input.communityRepository,
      communityId: input.communityId,
      userId: input.actor.userId,
    })
  ) {
    return community
  }

  throw notFoundError("Community not found")
}

export async function grantCommunityRole(input: {
  env: Env
  actor: CommunityMutationActor
  communityId: string
  body: CommunityRoleMutationBody | null
  communityRepository: CommunityRoleRepository
  userRepository: UserRepository
}): Promise<Community> {
  const targetUserId = normalizeUserId(input.body?.user_id)
  const role = normalizeManageableRole(input.body?.role)

  const community = await requireCommunityRoleMutationPermission({
    env: input.env,
    communityRepository: input.communityRepository,
    communityId: input.communityId,
    actor: input.actor,
    role,
  })
  await requireTargetUser({ userRepository: input.userRepository, userId: targetUserId })

  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  let changed = false
  const now = nowIso()
  try {
    const tx = await db.client.transaction("write")
    try {
      const existing = await tx.execute({
        sql: `
          SELECT role_assignment_id
          FROM community_roles
          WHERE community_id = ?1
            AND user_id = ?2
            AND role = ?3
            AND status = 'active'
          LIMIT 1
        `,
        args: [input.communityId, targetUserId, role],
      })

      if (!existing.rows[0]) {
        await tx.execute({
          sql: `
            INSERT INTO community_roles (
              role_assignment_id, community_id, user_id, role, status,
              granted_by_user_id, granted_at, revoked_at, created_at, updated_at
            ) VALUES (
              ?1, ?2, ?3, ?4, 'active',
              ?5, ?6, NULL, ?6, ?6
            )
          `,
          args: [
            makeId("rol"),
            input.communityId,
            targetUserId,
            role,
            input.actor.userId,
            now,
          ],
        })
        changed = true
      }

      await tx.commit()
    } catch (error) {
      await tx.rollback().catch((rollbackError) => {
        console.error("[community-roles] rollback failed while assigning community role", rollbackError)
      })
      throw error
    }
  } finally {
    db.close()
  }

  await recordCommunityRoleAudit({
    env: input.env,
    actor: input.actor,
    action: "community.role_granted",
    communityId: input.communityId,
    targetUserId,
    role,
    changed,
    createdAt: now,
  })

  return loadCommunityProjection(input.env, input.communityRepository, community)
}

export async function revokeCommunityRole(input: {
  env: Env
  actor: CommunityMutationActor
  communityId: string
  body: CommunityRoleMutationBody | null
  communityRepository: CommunityRoleRepository
  userRepository: UserRepository
}): Promise<Community> {
  const targetUserId = normalizeUserId(input.body?.user_id)
  const role = normalizeManageableRole(input.body?.role)

  const community = await requireCommunityRoleMutationPermission({
    env: input.env,
    communityRepository: input.communityRepository,
    communityId: input.communityId,
    actor: input.actor,
    role,
  })
  await requireTargetUser({ userRepository: input.userRepository, userId: targetUserId })

  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  let changed = false
  const now = nowIso()
  try {
    const tx = await db.client.transaction("write")
    try {
      const result = await tx.execute({
        sql: `
          UPDATE community_roles
          SET status = 'revoked',
              revoked_at = ?4,
              updated_at = ?4
          WHERE community_id = ?1
            AND user_id = ?2
            AND role = ?3
            AND status = 'active'
        `,
        args: [input.communityId, targetUserId, role, now],
      })
      changed = Number(result.rowsAffected ?? 0) > 0
      await tx.commit()
    } catch (error) {
      await tx.rollback().catch((rollbackError) => {
        console.error("[community-roles] rollback failed while revoking community role", rollbackError)
      })
      throw error
    }
  } finally {
    db.close()
  }

  await recordCommunityRoleAudit({
    env: input.env,
    actor: input.actor,
    action: "community.role_revoked",
    communityId: input.communityId,
    targetUserId,
    role,
    changed,
    createdAt: now,
  })

  return loadCommunityProjection(input.env, input.communityRepository, community)
}
