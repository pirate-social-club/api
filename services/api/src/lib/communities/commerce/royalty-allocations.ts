// Initial royalty allocation persistence and Story RT distribution verification
// (spec: core/specs/domain/royalty-allocation.md). Asset creation snapshots the
// declared split, Story registration distributes RTs, and the scheduled verifier
// marks allocations verified once vault balances match the frozen split.
import { sha256Hex } from "../../crypto"
import { badRequestError, conflictError } from "../../errors"
import { nowIso } from "../../helpers"
import type { Env } from "../../../env"
import { resolveStoryChainId } from "../../story/story-runtime-config"
import type { UserRepository } from "../../auth/repositories"
import type { Client, InStatement } from "../../sql-client"
import { withTransaction } from "../../transactions"
import type { RoyaltyAllocationRequest } from "../../../types"

export const ROYALTY_ALLOCATION_VERSION = 1

// Story networks that attach a royalty vault (where RTs can distribute): Aeneid + mainnet.
export const SUPPORTED_STORY_ALLOCATION_CHAIN_IDS = new Set<number>([1315, 1514])

// Resolve the Story chain from runtime config and validate it is a supported EVM chain.
// Fingerprints and persisted allocation rows are bound to this resolved id.
export function resolveAllocationChainId(env: Pick<Env, "STORY_CHAIN_ID">): number {
  const chainId = resolveStoryChainId(env)
  if (!SUPPORTED_STORY_ALLOCATION_CHAIN_IDS.has(chainId)) {
    throw badRequestError(`royalty_allocations are not supported on Story chain ${chainId}`)
  }
  return chainId
}

// Minimal slice of the real repository — only what wallet snapshotting needs.
type CreatorWalletReader = Pick<UserRepository, "getUserById" | "getWalletAttachmentsByUserId">

export type CreatorWalletSnapshot = {
  walletAddressNormalized: string
  walletAttachmentId: string | null
}

export type AllocationRow = {
  allocationId: string
  assetId: string
  communityId: string
  recipientKind: "creator" | "collaborator"
  recipientUserId: string | null
  walletAttachmentId: string | null
  walletAddressNormalized: string
  walletAddressDisplay: string
  chainId: number
  shareBps: number
  position: number
  allocationFingerprint: string
  createdAt: string
}

export type StoryRoyaltyShareRow = {
  walletAddressNormalized: `0x${string}`
  shareBps: number
  percentage: number
}

export type PendingStoryRoyaltyAllocationAsset = {
  communityId: string
  assetId: string
  storyIpId: string
  ipRoyaltyVault: string
}

export type StoryRoyaltyVaultReader = {
  totalSupply: (vaultAddress: `0x${string}`) => Promise<bigint>
  decimals: (vaultAddress: `0x${string}`) => Promise<number>
  balanceOf: (input: { vaultAddress: `0x${string}`; walletAddress: `0x${string}` }) => Promise<bigint>
}

export type StoryRoyaltyAllocationVerificationResult =
  | { status: "verified"; assetId: string; checkedRows: number; totalSupply: string; decimals: number }
  | { status: "pending"; assetId: string; checkedRows: number; reason: string }
  | { status: "skipped"; assetId: string; reason: string }

export function buildStoryRoyaltySharesFromAllocationRows(rows: Array<{
  walletAddressNormalized: string
  shareBps: number
}>): StoryRoyaltyShareRow[] {
  if (rows.length === 0) return []
  const shares = rows.map((row) => {
    const wallet = String(row.walletAddressNormalized || "").trim().toLowerCase()
    const shareBps = Number(row.shareBps)
    if (!/^0x[0-9a-f]{40}$/.test(wallet)) {
      throw badRequestError("royalty_allocations wallet snapshot is invalid")
    }
    if (!Number.isInteger(shareBps) || shareBps <= 0 || shareBps > 10_000) {
      throw badRequestError("royalty_allocations share snapshot is invalid")
    }
    return {
      walletAddressNormalized: wallet as `0x${string}`,
      shareBps,
      percentage: shareBps / 100,
    }
  })
  const totalBps = shares.reduce((sum, row) => sum + row.shareBps, 0)
  if (totalBps !== 10_000) {
    throw badRequestError("royalty_allocations shares must total 10000 bps")
  }
  return shares
}

// Deterministic, reorder-stable: recipients are canonicalised by sorting on normalized
// address before hashing, so UI reordering does not change registration identity.
export async function computeAllocationFingerprint(input: {
  version: number
  chainId: number
  allocations: Array<{ walletAddressNormalized: string; shareBps: number }>
}): Promise<string> {
  const sorted = [...input.allocations].sort((a, b) =>
    a.walletAddressNormalized < b.walletAddressNormalized
      ? -1
      : a.walletAddressNormalized > b.walletAddressNormalized
        ? 1
        : 0,
  )
  const canonical = JSON.stringify({
    v: input.version,
    chainId: input.chainId,
    allocations: sorted.map((allocation) => [allocation.walletAddressNormalized, allocation.shareBps]),
  })
  return sha256Hex(canonical)
}

export async function fingerprintForRequest(
  allocations: RoyaltyAllocationRequest[],
  chainId: number,
): Promise<string> {
  return computeAllocationFingerprint({
    version: ROYALTY_ALLOCATION_VERSION,
    chainId,
    allocations: allocations.map((allocation) => ({
      walletAddressNormalized: allocation.wallet_address.trim().toLowerCase(),
      shareBps: allocation.share_bps,
    })),
  })
}

// Resolve the creator's primary wallet SERVER-SIDE; never trust a client creator address.
export async function resolveCreatorWalletSnapshot(input: {
  userRepository: CreatorWalletReader
  userId: string
}): Promise<CreatorWalletSnapshot> {
  const user = await input.userRepository.getUserById(input.userId)
  if (!user) {
    throw badRequestError("Primary wallet is required for a royalty split")
  }
  const attachments = await input.userRepository.getWalletAttachmentsByUserId(input.userId)
  const primaryAttachmentId = user.primary_wallet_attachment_id
  const primaryAttachment = primaryAttachmentId
    ? attachments.find((attachment) => attachment.wallet_attachment === primaryAttachmentId)
    : undefined
  const resolved = primaryAttachment
    ?? attachments.find((attachment) => attachment.is_primary)
    ?? attachments[0]
  const address = resolved?.wallet_address?.trim()
  if (!address) {
    throw badRequestError("Primary wallet is required for a royalty split")
  }
  return {
    walletAddressNormalized: address.toLowerCase(),
    walletAttachmentId: resolved?.wallet_attachment ?? null,
  }
}

// Build the per-recipient rows, enforcing creator-wallet identity and snapshotting the
// creator's wallet attachment. Position preserves the declared (request) order.
export function buildAllocationRows(input: {
  assetId: string
  communityId: string
  creatorUserId: string
  allocations: RoyaltyAllocationRequest[]
  fingerprint: string
  creator: CreatorWalletSnapshot
  chainId: number
  now: string
  newId: () => string
}): AllocationRow[] {
  const rows: AllocationRow[] = []
  input.allocations.forEach((allocation, position) => {
    const normalized = allocation.wallet_address.trim().toLowerCase()
    const isCreator = allocation.recipient_kind === "creator"
    if (isCreator && normalized !== input.creator.walletAddressNormalized) {
      throw badRequestError("royalty_allocations creator wallet must match your primary wallet")
    }
    rows.push({
      allocationId: input.newId(),
      assetId: input.assetId,
      communityId: input.communityId,
      recipientKind: allocation.recipient_kind,
      // Only the creator's wallet is a server-owned, attachment-backed identity. Collaborator
      // wallets are externally declared: recipient_user_id and wallet_attachment_id stay NULL
      // (explicitly unverified), and the snapshot is the declared address itself.
      recipientUserId: isCreator ? input.creatorUserId : null,
      walletAttachmentId: isCreator ? input.creator.walletAttachmentId : null,
      walletAddressNormalized: normalized,
      walletAddressDisplay: allocation.wallet_address.trim(),
      chainId: input.chainId,
      shareBps: allocation.share_bps,
      position,
      allocationFingerprint: input.fingerprint,
      createdAt: input.now,
    })
  })
  return rows
}

export function buildAllocationInsertStatements(rows: AllocationRow[]): InStatement[] {
  return rows.map((row) => ({
    sql: `
      INSERT INTO initial_royalty_allocations (
        allocation_id, asset_id, community_id, recipient_kind, recipient_user_id,
        wallet_attachment_id, wallet_address_normalized, wallet_address_display, chain_id,
        share_bps, position, allocation_fingerprint, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
    `,
    args: [
      row.allocationId, row.assetId, row.communityId, row.recipientKind, row.recipientUserId,
      row.walletAttachmentId, row.walletAddressNormalized, row.walletAddressDisplay, row.chainId,
      row.shareBps, row.position, row.allocationFingerprint, row.createdAt,
    ],
  }))
}

// Insert the asset and its allocations through the buffered write transaction only.
// Any failure rolls back the asset. No reads occur inside the transaction.
export async function persistAssetWithAllocations(input: {
  client: Pick<Client, "transaction">
  assetInsert: InStatement
  allocationStatements: InStatement[]
}): Promise<void> {
  await withTransaction(input.client, "write", async (tx) => {
    await tx.execute(input.assetInsert)
    for (const statement of input.allocationStatements) {
      await tx.execute(statement)
    }
  })
}

// Idempotent-retry guard: a retry with the same split returns the existing asset; a
// different split for the same asset is a hard conflict (never a silent overwrite).
export async function assertExistingAssetAllocationMatches(input: {
  client: Pick<Client, "execute">
  communityId: string
  assetId: string
  requestedFingerprint: string
}): Promise<void> {
  const result = await input.client.execute({
    sql: `SELECT royalty_allocation_fingerprint FROM assets WHERE community_id = ?1 AND asset_id = ?2`,
    args: [input.communityId, input.assetId],
  })
  const storedFingerprint = (result.rows[0]?.royalty_allocation_fingerprint as string | null | undefined) ?? null
  if (storedFingerprint !== input.requestedFingerprint) {
    throw conflictError("royalty_allocations do not match the already-created asset")
  }
}

export async function loadStoryRoyaltySharesForAsset(input: {
  client: Pick<Client, "execute">
  communityId: string
  assetId: string
}): Promise<StoryRoyaltyShareRow[]> {
  const result = await input.client.execute({
    sql: `
      SELECT wallet_address_normalized, share_bps
      FROM initial_royalty_allocations
      WHERE community_id = ?1
        AND asset_id = ?2
      ORDER BY position ASC
    `,
    args: [input.communityId, input.assetId],
  })
  if (result.rows.length === 0) return []

  return buildStoryRoyaltySharesFromAllocationRows(result.rows.map((row) => ({
    walletAddressNormalized: String(row.wallet_address_normalized || ""),
    shareBps: Number(row.share_bps),
  })))
}

export async function markStoryRoyaltyAllocationRegistrationPendingVerification(input: {
  client: Pick<Client, "execute">
  communityId: string
  assetId: string
  ipRoyaltyVault: string | null
  distributionTxHash: string | null
  registeredAt: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      UPDATE initial_royalty_allocations
      SET distribution_status = 'pending',
          failure_reason = NULL,
          registered_at = ?3
      WHERE community_id = ?1
        AND asset_id = ?2
    `,
    args: [input.communityId, input.assetId, input.registeredAt],
  })
  await input.client.execute({
    sql: `
      UPDATE assets
      SET royalty_allocation_status = 'verification_pending',
          royalty_allocation_effect_key = asset_id || ':' || royalty_allocation_fingerprint,
          royalty_allocation_tx_hash = ?3,
          ip_royalty_vault = COALESCE(?4, ip_royalty_vault),
          royalty_allocation_registered_at = ?5,
          royalty_allocation_projection_synced = 0,
          updated_at = ?5
      WHERE community_id = ?1
        AND asset_id = ?2
        AND royalty_allocation_status <> 'none'
    `,
    args: [
      input.communityId,
      input.assetId,
      input.distributionTxHash,
      input.ipRoyaltyVault,
      input.registeredAt,
    ],
  })
}

function parseEvmAddress(raw: string | null | undefined): `0x${string}` | null {
  const normalized = String(raw || "").trim().toLowerCase()
  return /^0x[0-9a-f]{40}$/.test(normalized) ? normalized as `0x${string}` : null
}

function failureReason(message: string): string {
  return message.slice(0, 500)
}

export async function listPendingStoryRoyaltyAllocationAssets(input: {
  client: Pick<Client, "execute">
  limit: number
}): Promise<PendingStoryRoyaltyAllocationAsset[]> {
  const limit = Number.isInteger(input.limit) && input.limit > 0 ? Math.min(input.limit, 100) : 25
  const result = await input.client.execute({
    sql: `
      SELECT community_id, asset_id, story_ip_id, ip_royalty_vault
      FROM assets
      WHERE royalty_allocation_status = 'verification_pending'
        AND story_ip_id IS NOT NULL
        AND story_ip_id != ''
        AND ip_royalty_vault IS NOT NULL
        AND ip_royalty_vault != ''
      ORDER BY royalty_allocation_registered_at ASC, updated_at ASC, asset_id ASC
      LIMIT ?1
    `,
    args: [limit],
  })

  return result.rows.map((row) => ({
    communityId: String(row.community_id || ""),
    assetId: String(row.asset_id || ""),
    storyIpId: String(row.story_ip_id || ""),
    ipRoyaltyVault: String(row.ip_royalty_vault || ""),
  })).filter((row) => row.communityId && row.assetId && row.storyIpId && row.ipRoyaltyVault)
}

export async function verifyStoryRoyaltyAllocationForAsset(input: {
  client: Pick<Client, "execute" | "transaction">
  communityId: string
  assetId: string
  vaultReader: StoryRoyaltyVaultReader
  checkedAt?: string
}): Promise<StoryRoyaltyAllocationVerificationResult> {
  const assetResult = await input.client.execute({
    sql: `
      SELECT asset_id, community_id, royalty_allocation_status, ip_royalty_vault
      FROM assets
      WHERE community_id = ?1
        AND asset_id = ?2
    `,
    args: [input.communityId, input.assetId],
  })
  const asset = assetResult.rows[0]
  if (!asset) return { status: "skipped", assetId: input.assetId, reason: "asset_not_found" }
  if (String(asset.royalty_allocation_status || "") === "verified") {
    return { status: "skipped", assetId: input.assetId, reason: "already_verified" }
  }
  if (String(asset.royalty_allocation_status || "") !== "verification_pending") {
    return { status: "skipped", assetId: input.assetId, reason: "not_verification_pending" }
  }

  const vaultAddress = parseEvmAddress(String(asset.ip_royalty_vault || ""))
  if (!vaultAddress) {
    return await markStoryRoyaltyAllocationVerificationPending(input.client, input.communityId, input.assetId, "missing_or_invalid_royalty_vault")
  }

  const allocationResult = await input.client.execute({
    sql: `
      SELECT wallet_address_normalized, share_bps
      FROM initial_royalty_allocations
      WHERE community_id = ?1
        AND asset_id = ?2
      ORDER BY position ASC
    `,
    args: [input.communityId, input.assetId],
  })
  if (allocationResult.rows.length === 0) {
    return await markStoryRoyaltyAllocationVerificationPending(input.client, input.communityId, input.assetId, "missing_allocation_rows")
  }

  const rows = allocationResult.rows.map((row) => ({
    walletAddress: parseEvmAddress(String(row.wallet_address_normalized || "")),
    shareBps: Number(row.share_bps),
  }))
  const invalidRow = rows.find((row) => !row.walletAddress || !Number.isInteger(row.shareBps) || row.shareBps <= 0)
  if (invalidRow) {
    return await markStoryRoyaltyAllocationVerificationPending(input.client, input.communityId, input.assetId, "invalid_allocation_row")
  }
  const totalBps = rows.reduce((sum, row) => sum + row.shareBps, 0)
  if (totalBps !== 10_000) {
    return await markStoryRoyaltyAllocationVerificationPending(input.client, input.communityId, input.assetId, "allocation_bps_total_mismatch")
  }

  const totalSupply = await input.vaultReader.totalSupply(vaultAddress)
  if (totalSupply <= 0n) {
    return await markStoryRoyaltyAllocationVerificationPending(input.client, input.communityId, input.assetId, "royalty_vault_total_supply_zero")
  }
  const decimals = await input.vaultReader.decimals(vaultAddress)
  const observed: Array<{
    walletAddress: `0x${string}`
    expected: bigint
    actual: bigint
  }> = []
  for (const row of rows) {
    const expectedNumerator = totalSupply * BigInt(row.shareBps)
    if (expectedNumerator % 10_000n !== 0n) {
      return await markStoryRoyaltyAllocationVerificationPending(input.client, input.communityId, input.assetId, "royalty_vault_supply_not_divisible_by_bps")
    }
    const expected = expectedNumerator / 10_000n
    const actual = await input.vaultReader.balanceOf({
      vaultAddress,
      walletAddress: row.walletAddress as `0x${string}`,
    })
    observed.push({
      walletAddress: row.walletAddress as `0x${string}`,
      expected,
      actual,
    })
    if (actual < expected) {
      return await markStoryRoyaltyAllocationVerificationPending(
        input.client,
        input.communityId,
        input.assetId,
        `royalty_vault_balance_mismatch:${row.walletAddress}:${actual.toString()}:${expected.toString()}`,
      )
    }
  }

  const checkedAt = input.checkedAt ?? nowIso()
  await withTransaction(input.client, "write", async (tx) => {
    for (const row of observed) {
      await tx.execute({
        sql: `
          UPDATE initial_royalty_allocations
          SET distribution_status = 'verified',
              expected_rt_units = ?3,
              verified_rt_units = ?4,
              failure_reason = NULL
          WHERE community_id = ?1
            AND asset_id = ?2
            AND wallet_address_normalized = ?5
        `,
        args: [
          input.communityId,
          input.assetId,
          row.expected.toString(),
          row.actual.toString(),
          row.walletAddress,
        ],
      })
    }
    await tx.execute({
      sql: `
        UPDATE assets
        SET royalty_allocation_status = 'verified',
            royalty_vault_total_supply = ?3,
            royalty_vault_decimals = ?4,
            royalty_allocation_projection_synced = 0,
            updated_at = ?5
        WHERE community_id = ?1
          AND asset_id = ?2
          AND royalty_allocation_status = 'verification_pending'
      `,
      args: [input.communityId, input.assetId, totalSupply.toString(), decimals, checkedAt],
    })
  })

  return {
    status: "verified",
    assetId: input.assetId,
    checkedRows: observed.length,
    totalSupply: totalSupply.toString(),
    decimals,
  }
}

async function markStoryRoyaltyAllocationVerificationPending(
  client: Pick<Client, "execute">,
  communityId: string,
  assetId: string,
  reason: string,
): Promise<StoryRoyaltyAllocationVerificationResult> {
  await client.execute({
    sql: `
      UPDATE initial_royalty_allocations
      SET failure_reason = ?3
      WHERE community_id = ?1
        AND asset_id = ?2
        AND distribution_status = 'pending'
    `,
    args: [communityId, assetId, failureReason(reason)],
  })
  await client.execute({
    sql: `
      UPDATE assets
      SET royalty_allocation_projection_synced = 0,
          updated_at = ?3
      WHERE community_id = ?1
        AND asset_id = ?2
        AND royalty_allocation_status = 'verification_pending'
    `,
    args: [communityId, assetId, nowIso()],
  })
  return { status: "pending", assetId, checkedRows: 0, reason }
}
