import type { CommunityHandle, CommunityHandleReserveRequest, CommunityHandleRevokeRequest, Env } from "../../../types"
import { badRequestError, conflictError, eligibilityFailed, internalError, notFoundError } from "../../errors"
import { makeId, nowIso } from "../../helpers"
import type { Client, QueryResultRow } from "../../sql-client"
import { requiredString } from "../../sql-row"
import { withTransaction } from "../../transactions"
import { openCommunityWriteClient } from "../community-read-access"
import { requireCommunityOwner } from "../commerce/access"
import { assertHandleLabelLength, handleAvailabilityDetails, isReservedHandleLabel } from "./handle-quote-domain"
import {
  type HandleCommunityRepository,
  getNamespacePolicy,
  normalizeCommunityHandleLabel,
  parseHandleClaimSettings,
} from "./handle-policy-service"
import { getBlockingHandleForLabel, serializeHandle } from "./handle-row-store"

function normalizeSubmittedHandleId(value: string): string {
  const trimmed = value.trim()
  return trimmed.startsWith("ch_ch_") ? trimmed.slice(3) : trimmed
}

export async function reserveCommunityHandle(input: {
  env: Env
  userId: string
  communityId: string
  namespaceVerificationId?: string | null
  body: CommunityHandleReserveRequest
  communityRepository: HandleCommunityRepository
}): Promise<CommunityHandle> {
  await requireCommunityOwner({
    communityId: input.communityId,
    userId: input.userId,
    communityRepository: input.communityRepository,
  })
  const desired = normalizeCommunityHandleLabel(input.body.desired_label)
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    return serializeHandle(await reserveCommunityHandleOnClient(db.client, {
      communityId: input.communityId,
      userId: input.userId,
      namespaceVerificationId: input.namespaceVerificationId,
      desired,
    }))
  } finally {
    db.close()
  }
}

/**
 * Buffer-safe reservation. The namespace policy + blocking-handle reads and all
 * validation run on the base client BEFORE the write tx (a buffered D1 write tx
 * can't read them back mid-flight); the tx body is a single INSERT guarded by the
 * namespace/label unique constraint (the real concurrency protection); the created
 * row is read back AFTER commit. Returns the raw handle row. Exported for buffer tests.
 */
export async function reserveCommunityHandleOnClient(
  client: Client,
  input: {
    communityId: string
    userId: string
    namespaceVerificationId?: string | null
    desired: { labelNormalized: string; labelDisplay: string }
  },
): Promise<QueryResultRow> {
  const policy = await getNamespacePolicy(client, input.communityId, {
    namespaceVerificationId: input.namespaceVerificationId,
  })
  if (!policy) {
    throw eligibilityFailed("Community names are not available for this community")
  }
  const settings = parseHandleClaimSettings(policy.settings_json)
  assertHandleLabelLength(input.desired.labelNormalized, settings)
  if (isReservedHandleLabel(input.desired.labelNormalized, settings)) {
    const reason = "Desired label is already reserved"
    throw conflictError(reason, handleAvailabilityDetails("reserved", reason))
  }
  const blockingHandle = await getBlockingHandleForLabel(client, policy.namespace_id, input.desired.labelNormalized)
  if (blockingHandle) {
    const status = requiredString(blockingHandle, "status")
    const reason = status === "reserved"
      ? "Desired label is already reserved"
      : "Desired label is unavailable"
    throw conflictError(reason, handleAvailabilityDetails(status === "reserved" ? "reserved" : "taken", reason))
  }

  const now = nowIso()
  const handleId = makeId("ch")
  await withTransaction(client, "write", async (tx) => {
    await tx.execute({
      sql: `
        INSERT INTO community_handles (
          community_handle_id, community_id, user_id, namespace_id, handle_claim_quote_id,
          label_normalized, label_display, status, issuance_source, price_cents, currency,
          pricing_model, pricing_tier, settlement_wallet_attachment_id, funding_tx_ref, settlement_tx_ref,
          lease_started_at, lease_expires_at, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, NULL,
          ?5, ?6, 'reserved', 'admin_grant', 0, 'USD',
          NULL, 'reserved', NULL, NULL, NULL,
          NULL, NULL, ?7, ?7
        )
      `,
      args: [
        handleId,
        input.communityId,
        input.userId,
        policy.namespace_id,
        input.desired.labelNormalized,
        input.desired.labelDisplay,
        now,
      ],
    })
  })

  const result = await client.execute({
    sql: `SELECT * FROM community_handles WHERE community_handle_id = ?1 LIMIT 1`,
    args: [handleId],
  })
  const handle = result.rows[0]
  if (!handle) {
    throw internalError("Created reserved community handle row is missing")
  }
  return handle
}

export async function revokeCommunityHandle(input: {
  env: Env
  userId: string
  communityId: string
  handleId: string
  body?: CommunityHandleRevokeRequest | null
  communityRepository: HandleCommunityRepository
}): Promise<CommunityHandle> {
  void input.body
  await requireCommunityOwner({
    communityId: input.communityId,
    userId: input.userId,
    communityRepository: input.communityRepository,
  })
  const rawHandleId = normalizeSubmittedHandleId(input.handleId)
  if (!rawHandleId) {
    throw badRequestError("handle id is required")
  }
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    const now = nowIso()
    await db.client.execute({
      sql: `
        UPDATE community_handles
        SET status = 'revoked',
            lease_expires_at = COALESCE(lease_expires_at, ?3),
            updated_at = ?3
        WHERE community_handle_id = ?1
          AND community_id = ?2
          AND status IN ('active', 'grace_period', 'reserved')
      `,
      args: [rawHandleId, input.communityId, now],
    })
    const result = await db.client.execute({
      sql: `
        SELECT *
        FROM community_handles
        WHERE community_handle_id = ?1
          AND community_id = ?2
        LIMIT 1
      `,
      args: [rawHandleId, input.communityId],
    })
    const handle = result.rows[0]
    if (!handle) {
      throw notFoundError("Community handle not found")
    }
    return serializeHandle(handle)
  } finally {
    db.close()
  }
}
