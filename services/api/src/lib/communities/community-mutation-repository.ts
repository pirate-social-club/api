import type { Client } from "../sql-client"
import { conflictError, internalError, notFoundError } from "../errors"
import {
  getCommunityRowById,
} from "../auth/auth-db-community-queries"
import type { CommunityRow } from "../auth/auth-db-rows"
import type { CommunityNamespaceRole } from "./community-repository-types"

export type CommunityLifecycleStatus = CommunityRow["status"]

export async function attachNamespaceToCommunity(
  client: Client,
  input: {
    communityNamespaceBindingId: string
    communityId: string
    namespaceVerificationId: string
    namespaceRole: CommunityNamespaceRole
    replacesNamespaceVerificationId?: string
    routeSlug: string
    updatedAt: string
  },
): Promise<CommunityRow> {
  const tx = await client.transaction("write")

  try {
    const existing = await getCommunityRowById(tx, input.communityId)
    if (!existing) {
      throw internalError("Community not found for namespace attach")
    }
    const activeBinding = await tx.execute({
      sql: `
        SELECT community_id, namespace_role
        FROM community_namespace_bindings
        WHERE namespace_verification_id = ?1
          AND status = 'active'
        LIMIT 1
      `,
      args: [input.namespaceVerificationId],
    })
    const bindingCommunityId = activeBinding.rows[0]?.community_id
    const bindingRole = activeBinding.rows[0]?.namespace_role
    if (bindingCommunityId) {
      if (bindingCommunityId === input.communityId && bindingRole === input.namespaceRole) {
        await tx.rollback()
        return existing
      }
      throw conflictError("Namespace is already attached with a different community or role")
    }

    const replacingPrimary = input.namespaceRole === "primary" && Boolean(input.replacesNamespaceVerificationId)
    if (replacingPrimary && existing.namespace_verification_id !== input.replacesNamespaceVerificationId) {
      throw conflictError("Community primary namespace changed before recovery completed")
    }
    if (input.namespaceRole === "primary" && existing.namespace_verification_id && !replacingPrimary) {
      throw conflictError("Community already has a different primary namespace attached")
    }
    if (input.namespaceRole === "mirror" && !existing.namespace_verification_id) {
      throw conflictError("Community must have a primary namespace before attaching mirrors")
    }

    if (replacingPrimary) {
      const superseded = await tx.execute({
        sql: `
          UPDATE community_namespace_bindings
          SET status = 'superseded',
              updated_at = ?3
          WHERE community_id = ?1
            AND namespace_verification_id = ?2
            AND namespace_role = 'primary'
            AND status = 'active'
        `,
        args: [
          input.communityId,
          input.replacesNamespaceVerificationId!,
          input.updatedAt,
        ],
      })
      if ((superseded.rowsAffected ?? 0) !== 1) {
        throw conflictError("Active primary namespace binding is missing during recovery")
      }
    }

    await tx.execute({
      sql: `
        UPDATE communities
        SET namespace_verification_id = CASE WHEN ?2 = 'primary' THEN ?3 ELSE namespace_verification_id END,
            route_slug = CASE WHEN ?2 = 'primary' THEN ?4 ELSE route_slug END,
            pending_namespace_verification_session_id = NULL,
            updated_at = ?5
        WHERE community_id = ?1
      `,
      args: [
        input.communityId,
        input.namespaceRole,
        input.namespaceVerificationId,
        input.routeSlug,
        input.updatedAt,
      ],
    })

    await tx.execute({
      sql: `
        INSERT INTO community_namespace_bindings (
          community_namespace_binding_id,
          community_id,
          namespace_verification_id,
          namespace_role,
          status,
          created_at,
          updated_at
        ) VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?5)
      `,
      args: [
        input.communityNamespaceBindingId,
        input.communityId,
        input.namespaceVerificationId,
        input.namespaceRole,
        input.updatedAt,
      ],
    })

    const updated = await getCommunityRowById(tx, input.communityId)
    if (!updated) {
      throw internalError("Community row is missing after namespace attach")
    }

    await tx.commit()
    return updated
  } catch (error) {
    try {
      await tx.rollback()
    } catch (rollbackError) {
      console.error("[community-mutations] rollback failed while attaching namespace", rollbackError)
    }
    throw error
  } finally {
    tx.close()
  }
}

export async function setPendingNamespaceVerificationSession(
  client: Client,
  input: {
    communityId: string
    sessionId: string | null
    updatedAt: string
  },
): Promise<void> {
  await client.execute({
    sql: `
      UPDATE communities
      SET pending_namespace_verification_session_id = ?2,
          updated_at = ?3
      WHERE community_id = ?1
    `,
    args: [input.communityId, input.sessionId, input.updatedAt],
  })
}

/**
 * Transitions the canonical control-plane community lifecycle status. The control-plane
 * `communities.status` is the source of truth for enforcement (isCommunityLive reads it).
 * The transition is validated transactionally against `allowedFromStatuses`; a no-op when
 * the community is already at `targetStatus` (idempotent archive/unarchive).
 */
export async function setCommunityLifecycleStatus(
  client: Client,
  input: {
    communityId: string
    targetStatus: CommunityLifecycleStatus
    allowedFromStatuses: readonly CommunityLifecycleStatus[]
    updatedAt: string
  },
): Promise<CommunityRow> {
  const tx = await client.transaction("write")

  try {
    const existing = await getCommunityRowById(tx, input.communityId)
    if (!existing) {
      throw notFoundError("Community not found")
    }

    if (existing.status === input.targetStatus) {
      await tx.rollback()
      return existing
    }

    if (!input.allowedFromStatuses.includes(existing.status)) {
      throw conflictError(
        `Cannot transition community from ${existing.status} to ${input.targetStatus}`,
      )
    }

    await tx.execute({
      sql: `
        UPDATE communities
        SET status = ?2,
            updated_at = ?3
        WHERE community_id = ?1
      `,
      args: [input.communityId, input.targetStatus, input.updatedAt],
    })

    const updated = await getCommunityRowById(tx, input.communityId)
    if (!updated) {
      throw internalError("Community row is missing after lifecycle status update")
    }

    await tx.commit()
    return updated
  } catch (error) {
    try {
      await tx.rollback()
    } catch (rollbackError) {
      console.error("[community-mutations] rollback failed while updating lifecycle status", rollbackError)
    }
    throw error
  } finally {
    tx.close()
  }
}
