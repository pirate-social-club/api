// Initial royalty allocation persistence (spec: core/specs/domain/royalty-allocation.md).
// PR1 scope: validate + snapshot + persist the declared split as a `draft` agreement,
// atomically with asset creation. On-chain registration/verification are later slices.
import { sha256Hex } from "../../crypto"
import { badRequestError, conflictError } from "../../errors"
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
