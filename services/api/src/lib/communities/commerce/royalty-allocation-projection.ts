import { makeId, nowIso } from "../../helpers"
import { getControlPlaneClient } from "../../runtime-deps"
import type { Client } from "../../sql-client"
import type { Env } from "../../../types"
import { logPipelineInfo } from "../../observability/pipeline-log"
import { numberOrNull, requiredString, stringOrNull } from "./row-types"

export type StoryRoyaltyAllocationProjectionRow = {
  communityId: string
  assetId: string
  storyIpId: string
  ipRoyaltyVault: string | null
  recipientKind: "creator" | "collaborator"
  recipientUserId: string | null
  walletAttachmentId: string | null
  walletAddressNormalized: string
  chainId: number
  initialShareBps: number
  allocationFingerprint: string
  distributionStatus: "pending" | "verified" | "failed"
  allocationStatus: string
  failureReason: string | null
  sourceUpdatedAt: string
  createdAt: string
}

export async function listPendingStoryRoyaltyAllocationProjectionCommunities(input: {
  env: Env
  limit: number
  controlPlaneClient?: Pick<Client, "execute">
}): Promise<string[]> {
  const client = input.controlPlaneClient ?? getControlPlaneClient(input.env)
  const result = await client.execute({
    sql: `
      SELECT community_id, MIN(created_at) AS first_pending_at
      FROM story_royalty_allocation_projections
      WHERE allocation_status = 'verification_pending'
      GROUP BY community_id
      ORDER BY MIN(created_at) ASC, community_id ASC
      LIMIT ?1
    `,
    args: [Math.max(1, Math.trunc(input.limit))],
  })
  return result.rows.map((row) => requiredString(row, "community_id"))
}

function isProjectableAssetRow(row: unknown): boolean {
  const storyIpId = stringOrNull(row, "story_ip_id")?.trim()
  const status = stringOrNull(row, "royalty_allocation_status")
  return Boolean(storyIpId) && status != null && status !== "none"
}

export async function loadStoryRoyaltyAllocationProjectionRows(input: {
  client: Pick<Client, "execute">
  communityId: string
  assetId: string
  sourceUpdatedAt?: string | null
}): Promise<StoryRoyaltyAllocationProjectionRow[]> {
  const result = await input.client.execute({
    sql: `
      SELECT
        a.community_id,
        a.asset_id,
        a.story_ip_id,
        a.ip_royalty_vault,
        a.royalty_allocation_status,
        a.updated_at,
        ira.recipient_kind,
        ira.recipient_user_id,
        ira.wallet_attachment_id,
        ira.wallet_address_normalized,
        ira.chain_id,
        ira.share_bps,
        ira.allocation_fingerprint,
        ira.distribution_status,
        ira.failure_reason,
        ira.created_at
      FROM assets a
      JOIN initial_royalty_allocations ira
        ON ira.community_id = a.community_id
       AND ira.asset_id = a.asset_id
      WHERE a.community_id = ?1
        AND a.asset_id = ?2
      ORDER BY ira.position ASC
    `,
    args: [input.communityId, input.assetId],
  })
  if (result.rows.length === 0 || !isProjectableAssetRow(result.rows[0])) {
    return []
  }
  return result.rows.map((row) => ({
    communityId: requiredString(row, "community_id"),
    assetId: requiredString(row, "asset_id"),
    storyIpId: requiredString(row, "story_ip_id"),
    ipRoyaltyVault: stringOrNull(row, "ip_royalty_vault"),
    recipientKind: requiredString(row, "recipient_kind") as "creator" | "collaborator",
    recipientUserId: stringOrNull(row, "recipient_user_id"),
    walletAttachmentId: stringOrNull(row, "wallet_attachment_id"),
    walletAddressNormalized: requiredString(row, "wallet_address_normalized"),
    chainId: numberOrNull(row, "chain_id") ?? 0,
    initialShareBps: numberOrNull(row, "share_bps") ?? 0,
    allocationFingerprint: requiredString(row, "allocation_fingerprint"),
    distributionStatus: requiredString(row, "distribution_status") as "pending" | "verified" | "failed",
    allocationStatus: requiredString(row, "royalty_allocation_status"),
    failureReason: stringOrNull(row, "failure_reason"),
    sourceUpdatedAt: input.sourceUpdatedAt?.trim() || requiredString(row, "updated_at"),
    createdAt: requiredString(row, "created_at"),
  }))
}

async function upsertStoryRoyaltyAllocationProjection(input: {
  env: Env
  projection: StoryRoyaltyAllocationProjectionRow
  controlPlaneClient?: Pick<Client, "execute">
}): Promise<void> {
  const client = input.controlPlaneClient ?? getControlPlaneClient(input.env)
  const p = input.projection
  const updatedAt = nowIso()
  await client.execute({
    sql: `
      INSERT INTO story_royalty_allocation_projections (
        projection_id, community_id, asset_id, story_ip_id, ip_royalty_vault,
        recipient_kind, recipient_user_id, wallet_attachment_id, wallet_address_normalized,
        chain_id, initial_share_bps, allocation_fingerprint, distribution_status,
        allocation_status, failure_reason, source_updated_at, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5,
        ?6, ?7, ?8, ?9,
        ?10, ?11, ?12, ?13,
        ?14, ?15, ?16, ?17, ?18
      )
      ON CONFLICT (community_id, asset_id, wallet_address_normalized) DO UPDATE SET
        story_ip_id = excluded.story_ip_id,
        ip_royalty_vault = excluded.ip_royalty_vault,
        recipient_kind = excluded.recipient_kind,
        recipient_user_id = excluded.recipient_user_id,
        wallet_attachment_id = excluded.wallet_attachment_id,
        chain_id = excluded.chain_id,
        initial_share_bps = excluded.initial_share_bps,
        allocation_fingerprint = excluded.allocation_fingerprint,
        distribution_status = excluded.distribution_status,
        allocation_status = excluded.allocation_status,
        failure_reason = excluded.failure_reason,
        source_updated_at = excluded.source_updated_at,
        updated_at = excluded.updated_at
    `,
    args: [
      makeId("srapa"),
      p.communityId,
      p.assetId,
      p.storyIpId,
      p.ipRoyaltyVault,
      p.recipientKind,
      p.recipientUserId,
      p.walletAttachmentId,
      p.walletAddressNormalized,
      p.chainId,
      p.initialShareBps,
      p.allocationFingerprint,
      p.distributionStatus,
      p.allocationStatus,
      p.failureReason,
      p.sourceUpdatedAt,
      p.createdAt,
      updatedAt,
    ],
  })
}

export async function syncStoryRoyaltyAllocationProjectionForAsset(input: {
  env: Env
  client: Pick<Client, "execute">
  controlPlaneClient?: Pick<Client, "execute">
  communityId: string
  assetId: string
  sourceUpdatedAt?: string | null
}): Promise<{ projectedRows: number }> {
  const rows = await loadStoryRoyaltyAllocationProjectionRows(input)
  if (rows.length === 0) {
    return { projectedRows: 0 }
  }
  for (const row of rows) {
    await upsertStoryRoyaltyAllocationProjection({
      env: input.env,
      projection: row,
      controlPlaneClient: input.controlPlaneClient,
    })
  }
  await input.client.execute({
    sql: `
      UPDATE assets
      SET royalty_allocation_projection_synced = 1,
          updated_at = ?1
      WHERE community_id = ?2
        AND asset_id = ?3
    `,
    args: [nowIso(), input.communityId, input.assetId],
  })
  return { projectedRows: rows.length }
}

export async function syncStoryRoyaltyAllocationProjectionSafely(input: {
  env: Env
  client: Pick<Client, "execute">
  communityId: string
  postId: string
  assetId: string
  sourceUpdatedAt?: string | null
  required?: boolean
}): Promise<void> {
  const maxAttempts = input.required ? 3 : 1
  let lastError: unknown = null
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await syncStoryRoyaltyAllocationProjectionForAsset(input)
      if (input.required && result.projectedRows === 0) {
        throw new Error("royalty_allocation_projection_rows_missing")
      }
      if (result.projectedRows > 0) {
        logPipelineInfo("[commerce] Story royalty allocation projection synced", {
          community_id: input.communityId,
          post_id: input.postId,
          asset_id: input.assetId,
          projected_rows: result.projectedRows,
          attempt,
        })
      }
      return
    } catch (error) {
      lastError = error
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 250))
      }
    }
  }
  logPipelineInfo("[commerce] Story royalty allocation projection sync failed", {
    level: "warn",
    community_id: input.communityId,
    post_id: input.postId,
    asset_id: input.assetId,
    attempts: maxAttempts,
    error: lastError instanceof Error ? lastError.message : String(lastError),
  })
  if (input.required) throw lastError
}
