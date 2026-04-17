import type { Client } from "../sql-client"
import { internalError } from "../errors"
import {
  getCommunityRowById,
  getCommunityRowByNamespaceVerificationId,
} from "../auth/control-plane-auth-queries"
import type { CommunityRow } from "../auth/control-plane-auth-rows"

export async function attachNamespaceToCommunity(
  client: Client,
  input: {
    communityId: string
    namespaceVerificationId: string
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
    if (existing.namespace_verification_id) {
      if (existing.namespace_verification_id === input.namespaceVerificationId) {
        await tx.rollback()
        return existing
      }
      throw internalError("Community already has a different namespace attached")
    }

    const result = await tx.execute({
      sql: `
        UPDATE communities
        SET namespace_verification_id = ?2,
            route_slug = ?3,
            registry_publication_state = 'pending_create',
            pending_namespace_verification_session_id = NULL,
            updated_at = ?4
        WHERE community_id = ?1
          AND namespace_verification_id IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM communities
            WHERE namespace_verification_id = ?2
              AND community_id != ?1
          )
      `,
      args: [input.communityId, input.namespaceVerificationId, input.routeSlug, input.updatedAt],
    })

    if ((result.rowsAffected ?? 0) === 0) {
      const conflict = await getCommunityRowByNamespaceVerificationId(tx, input.namespaceVerificationId)
      if (conflict && conflict.community_id !== input.communityId) {
        throw internalError("Namespace is already attached to another community")
      }
      throw internalError("Community namespace attach failed")
    }

    const updated = await getCommunityRowById(tx, input.communityId)
    if (!updated) {
      throw internalError("Community row is missing after namespace attach")
    }

    await tx.commit()
    return updated
  } catch (error) {
    try {
      await tx.rollback()
    } catch {}
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
