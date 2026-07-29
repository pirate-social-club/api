import {
  createPublicClient,
  encodeFunctionData,
  http,
  type Address,
  type Hex,
} from "viem"
import { base, mainnet, optimism } from "viem/chains"

import {
  accountMetadataAbi,
  buildFollowTransactions,
  decodePrimaryListId,
  decodeStorageLocation,
  listRecordsAbi,
  listRegistryAbi,
  normalizeAddress,
  type FollowWriteTransaction,
} from "./follow-contracts"
import type { Env } from "../../env"
import {
  badRequestError,
  conflictError,
  eligibilityFailed,
  rateLimited,
  retryableConflictError,
} from "../errors"
import type { Client, QueryResultRow } from "../sql-client"
import type { UserRepository } from "../auth/repositories"
import { withTransaction } from "../transactions"
import { canonicalFollowWallet } from "./profile-follow-read-service"

const BASE_CHAIN_ID = 8453
const ACCOUNT_METADATA = "0x5289fe5dabc021d02fddf23d4a4df96f4e0f17ef" as Address
const LIST_REGISTRY = "0x0e688f5dca4a0a4729946acbc44c792341714e08" as Address
const LIST_MINTER = "0xdb17bfc64abf7b7f080a49f0bbbf799ddbb48ce5" as Address
const LIST_RECORDS: Record<number, Address> = {
  1: "0x5289fe5dabc021d02fddf23d4a4df96f4e0f17ef",
  10: "0x4ca00413d850dcfa3516e14d21dae2772f2acb85",
  8453: "0x41aa48ef3c0446b46a5b1cc6337ff3d3716e2a33",
}
const DEFAULT_INTENT_TTL_SECONDS = 10 * 60
const DEFAULT_ACCOUNT_LIMIT_PER_HOUR = 20

export type PrimaryListStorageResolution =
  | { kind: "none" }
  | { kind: "found"; chainId: number; listId: string; slot: bigint }
  | { kind: "unresolved" }

type PreparedTransaction = {
  chain_id: number
  data: Hex
  to: Address
}

export type PreparedFollowWrite = {
  object: "profile_follow_write"
  intent_id: string | null
  target_user_id: string
  desired_following: boolean
  consistency: {
    status: "already_reflected" | "accepted_not_yet_reflected"
  }
  sponsorship: {
    eligible: boolean
    reserved_transaction_count: number
  }
  transactions: PreparedTransaction[]
  expires_at: string | null
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function rpcClient(env: Env, chainId: number) {
  if (chainId === BASE_CHAIN_ID && env.BASE_MAINNET_RPC_URL) {
    return createPublicClient({ chain: base, transport: http(env.BASE_MAINNET_RPC_URL) })
  }
  if (chainId === 10 && env.OPTIMISM_MAINNET_RPC_URL) {
    return createPublicClient({ chain: optimism, transport: http(env.OPTIMISM_MAINNET_RPC_URL) })
  }
  if (chainId === 1 && env.ETHEREUM_RPC_URL) {
    return createPublicClient({ chain: mainnet, transport: http(env.ETHEREUM_RPC_URL) })
  }
  throw new Error(`EFP RPC is unavailable for chain ${chainId}`)
}

export async function resolvePrimaryListStorage(
  env: Env,
  address: Address,
): Promise<PrimaryListStorageResolution> {
  try {
    const baseClient = rpcClient(env, BASE_CHAIN_ID)
    const encoded = await baseClient.readContract({
      address: ACCOUNT_METADATA,
      abi: accountMetadataAbi,
      functionName: "getValue",
      args: [address, "primary-list"],
    })
    if (!encoded || encoded === "0x") return { kind: "none" }
    const listId = decodePrimaryListId(encoded)
    if (!listId) return { kind: "unresolved" }
    const storageBytes = await baseClient.readContract({
      address: LIST_REGISTRY,
      abi: listRegistryAbi,
      functionName: "getListStorageLocation",
      args: [BigInt(listId)],
    })
    const storage = decodeStorageLocation(storageBytes)
    const records = LIST_RECORDS[storage.chainId]
    if (!records) return { kind: "unresolved" }
    const user = normalizeAddress(await rpcClient(env, storage.chainId).readContract({
      address: records,
      abi: listRecordsAbi,
      functionName: "getListUser",
      args: [storage.slot],
    }))
    return user === address
      ? { kind: "found", chainId: storage.chainId, listId, slot: storage.slot }
      : { kind: "unresolved" }
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error))
      .replaceAll(/https?:\/\/[^\s)]+/giu, "[redacted-url]")
      .slice(0, 2_000)
    console.warn("[efp-follow-write] Primary-list resolution failed", {
      address,
      error_name: error instanceof Error ? error.name : typeof error,
      message,
    })
    return { kind: "unresolved" }
  }
}

function rowInteger(row: QueryResultRow | undefined, key: string): number {
  const value = Number(row?.[key])
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

async function requireActorStanding(input: {
  client: Client
  userId: string
  wallet: Address
}): Promise<boolean> {
  const result = await input.client.execute({
    sql: `
      SELECT wa.attachment_kind, wa.source_provider, u.verification_state
      FROM wallet_attachments wa
      JOIN users u ON u.user_id = wa.user_id
      WHERE wa.user_id = ?1
        AND wa.wallet_address_normalized = ?2
        AND wa.status = 'active'
        AND wa.is_primary = 1
      LIMIT 1
    `,
    args: [input.userId, input.wallet],
  })
  const row = result.rows[0]
  if (!row) throw eligibilityFailed("A current primary wallet is required to follow profiles")
  return row.attachment_kind === "embedded"
    && row.source_provider === "privy"
    && row.verification_state === "verified"
}

async function enforceAccountRateLimit(input: {
  client: Client
  env: Env
  userId: string
  now: string
}): Promise<void> {
  const limit = positiveInteger(input.env.EFP_FOLLOW_ACCOUNT_HOURLY_LIMIT, DEFAULT_ACCOUNT_LIMIT_PER_HOUR)
  const result = await input.client.execute({
    sql: `
      SELECT COUNT(*) AS write_count
      FROM efp_follow_write_intents
      WHERE actor_user_id = ?1
        AND created_at >= CAST(?2 AS TIMESTAMPTZ) - INTERVAL '1 hour'
    `,
    args: [input.userId, input.now],
  })
  if (rowInteger(result.rows[0], "write_count") >= limit) {
    throw rateLimited("Follow write rate limit reached", { scope: "account_hour" })
  }
}

function serializeTransactions(transactions: FollowWriteTransaction[]): PreparedTransaction[] {
  return transactions.map((transaction) => ({
    chain_id: transaction.chainId,
    data: encodeFunctionData({
      abi: transaction.abi,
      functionName: transaction.functionName,
      args: transaction.args,
    } as never),
    to: transaction.address,
  }))
}

function intentId(): string {
  return `efw_${crypto.randomUUID().replaceAll("-", "")}`
}

export async function prepareProfileFollowWrite(input: {
  client: Client
  env: Env
  users: UserRepository
  actorUserId: string
  targetUserId: string
  targetPublicUserId: string
  desiredFollowing: boolean
  idempotencyKey: string
  now?: Date
  resolvePrimaryList?: typeof resolvePrimaryListStorage
}): Promise<PreparedFollowWrite> {
  if (input.actorUserId === input.targetUserId) throw badRequestError("Cannot follow yourself")
  const now = input.now ?? new Date()
  const nowIso = now.toISOString()
  const [actorWallet, targetWallet] = await Promise.all([
    canonicalFollowWallet(input.users, input.actorUserId),
    canonicalFollowWallet(input.users, input.targetUserId),
  ])
  if (!actorWallet) throw eligibilityFailed("Your profile has no canonical follow wallet")
  if (!targetWallet) throw eligibilityFailed("This profile has no canonical follow wallet")

  const sponsorshipEligible = await requireActorStanding({
    client: input.client,
    userId: input.actorUserId,
    wallet: actorWallet,
  })
  const existing = await input.client.execute({
    sql: `
      SELECT desired_following, prepared_transactions_json, follow_write_intent_id,
             target_user_id, expires_at, sponsorship_reserved_transaction_count
      FROM efp_follow_write_intents
      WHERE actor_user_id = ?1 AND idempotency_key = ?2
      LIMIT 1
    `,
    args: [input.actorUserId, input.idempotencyKey],
  })
  if (existing.rows[0]) {
    const row = existing.rows[0]
    if (
      Boolean(row.desired_following) !== input.desiredFollowing
      || String(row.target_user_id) !== input.targetUserId
    ) {
      throw conflictError("Idempotency key was reused for a different follow action")
    }
    return {
      object: "profile_follow_write",
      intent_id: String(row.follow_write_intent_id),
      target_user_id: input.targetPublicUserId,
      desired_following: input.desiredFollowing,
      consistency: { status: "accepted_not_yet_reflected" },
      sponsorship: {
        eligible: sponsorshipEligible,
        reserved_transaction_count: rowInteger(row, "sponsorship_reserved_transaction_count"),
      },
      transactions: row.prepared_transactions_json as PreparedTransaction[],
      expires_at: String(row.expires_at),
    }
  }
  await enforceAccountRateLimit({
    client: input.client,
    env: input.env,
    userId: input.actorUserId,
    now: nowIso,
  })

  const relationship = await input.client.execute({
    sql: `
      SELECT 1 AS edge
      FROM efp_effective_follows
      WHERE follower_address = ?1 AND followed_address = ?2
      LIMIT 1
    `,
    args: [actorWallet, targetWallet],
  })
  const reflected = relationship.rows.length > 0
  if (reflected === input.desiredFollowing) {
    return {
      object: "profile_follow_write",
      intent_id: null,
      target_user_id: input.targetPublicUserId,
      desired_following: input.desiredFollowing,
      consistency: { status: "already_reflected" },
      sponsorship: { eligible: false, reserved_transaction_count: 0 },
      transactions: [],
      expires_at: null,
    }
  }

  const resolution = await (input.resolvePrimaryList ?? resolvePrimaryListStorage)(input.env, actorWallet)
  if (resolution.kind === "unresolved") {
    throw retryableConflictError("Unable to load your follow list right now")
  }
  const transactions = buildFollowTransactions({
    existingStorage: resolution.kind === "found"
      ? { chainId: resolution.chainId, slot: resolution.slot }
      : undefined,
    followed: input.desiredFollowing,
    listMinter: LIST_MINTER,
    listRecordsAddress: LIST_RECORDS[BASE_CHAIN_ID] as Address,
    listRecordsByChain: LIST_RECORDS,
    primaryListChainId: BASE_CHAIN_ID,
    targetAddress: targetWallet,
    viewerAddress: actorWallet,
  })
  const prepared = serializeTransactions(transactions)
  const id = intentId()
  const expiresAt = new Date(now.getTime() + positiveInteger(
    input.env.EFP_FOLLOW_INTENT_TTL_SECONDS,
    DEFAULT_INTENT_TTL_SECONDS,
  ) * 1_000).toISOString()
  const slot = resolution.kind === "found"
    ? resolution.slot
    : BigInt((transactions[0]?.args[0] as bigint | undefined) ?? 0n)
  await input.client.execute({
    sql: `
      INSERT INTO efp_follow_write_intents (
        follow_write_intent_id, idempotency_key, actor_user_id, actor_wallet_address,
        target_user_id, target_wallet_address, desired_following, primary_list_resolution,
        list_chain_id, list_slot, prepared_transactions_json, prepared_transaction_count,
        status, expires_at, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
        'prepared', ?13, ?14, ?14
      )
    `,
    args: [
      id, input.idempotencyKey, input.actorUserId, actorWallet, input.targetUserId,
      targetWallet, input.desiredFollowing ? 1 : 0, resolution.kind,
      resolution.kind === "found" ? resolution.chainId : BASE_CHAIN_ID,
      slot.toString(), JSON.stringify(prepared), prepared.length, expiresAt, nowIso,
    ],
  })

  return {
    object: "profile_follow_write",
    intent_id: id,
    target_user_id: input.targetPublicUserId,
    desired_following: input.desiredFollowing,
    consistency: { status: "accepted_not_yet_reflected" },
    sponsorship: {
      eligible: sponsorshipEligible && transactions.every((tx) => tx.chainId === BASE_CHAIN_ID),
      reserved_transaction_count: 0,
    },
    transactions: prepared,
    expires_at: expiresAt,
  }
}

export async function confirmProfileFollowWrite(input: {
  client: Client
  env: Env
  actorUserId: string
  intentId: string
  transactionHashes: Hex[]
  now?: Date
}): Promise<{ intent_id: string; consistency: { status: "accepted_not_yet_reflected" } }> {
  const result = await input.client.execute({
    sql: `
      SELECT actor_wallet_address, target_wallet_address, prepared_transactions_json,
             prepared_transaction_count, status
      FROM efp_follow_write_intents
      WHERE follow_write_intent_id = ?1 AND actor_user_id = ?2
      LIMIT 1
    `,
    args: [input.intentId, input.actorUserId],
  })
  const row = result.rows[0]
  if (!row) throw conflictError("Follow write intent was not found")
  const transactions = (typeof row.prepared_transactions_json === "string"
    ? JSON.parse(row.prepared_transactions_json)
    : row.prepared_transactions_json) as PreparedTransaction[]
  if (
    transactions.length !== input.transactionHashes.length
    || transactions.length !== Number(row.prepared_transaction_count)
  ) {
    throw badRequestError("Every prepared follow transaction must be confirmed")
  }
  const actorWallet = String(row.actor_wallet_address).toLowerCase()
  for (const [index, hash] of input.transactionHashes.entries()) {
    if (!/^0x[a-f0-9]{64}$/u.test(hash)) throw badRequestError("Invalid follow transaction hash")
    const expected = transactions[index]
    if (!expected) throw conflictError("Prepared follow transaction is missing")
    const client = rpcClient(input.env, expected.chain_id)
    const [transaction, receipt] = await Promise.all([
      client.getTransaction({ hash }),
      client.getTransactionReceipt({ hash }),
    ])
    if (
      receipt.status !== "success"
      || transaction.from.toLowerCase() !== actorWallet
      || transaction.to?.toLowerCase() !== expected.to.toLowerCase()
      || transaction.input.toLowerCase() !== expected.data.toLowerCase()
    ) {
      throw conflictError("On-chain transaction does not match the prepared follow write")
    }
  }
  const now = (input.now ?? new Date()).toISOString()
  await withTransaction(input.client, "write", async (tx) => {
    await tx.execute({
      sql: `
        UPDATE efp_follow_write_intents
        SET status = 'confirmed', transaction_hashes_json = ?2,
            submitted_at = COALESCE(submitted_at, ?3), confirmed_at = ?3, updated_at = ?3
        WHERE follow_write_intent_id = ?1
      `,
      args: [input.intentId, JSON.stringify(input.transactionHashes), now],
    })
    for (const wallet of [actorWallet, String(row.target_wallet_address).toLowerCase()]) {
      await tx.execute({
        sql: `
          INSERT INTO efp_follow_reconciliation_queue (
            wallet_address, requested_by_follow_write_intent_id, status,
            requested_at, available_at, updated_at
          ) VALUES (?1, ?2, 'pending', ?3, ?3, ?3)
          ON CONFLICT (wallet_address) DO UPDATE SET
            requested_by_follow_write_intent_id = excluded.requested_by_follow_write_intent_id,
            status = 'pending', requested_at = excluded.requested_at,
            available_at = excluded.available_at, completed_at = NULL,
            last_error = NULL, updated_at = excluded.updated_at
        `,
        args: [wallet, input.intentId, now],
      })
    }
  })
  return { intent_id: input.intentId, consistency: { status: "accepted_not_yet_reflected" } }
}

export async function reconcilePendingFollowWrites(input: {
  client: Client
  now?: Date
  limit?: number
}): Promise<{ examined: number; reflected: number }> {
  const pending = await input.client.execute({
    sql: `
      SELECT DISTINCT i.follow_write_intent_id, i.actor_wallet_address,
             i.target_wallet_address, i.desired_following
      FROM efp_follow_write_intents i
      JOIN efp_follow_reconciliation_queue q
        ON q.requested_by_follow_write_intent_id = i.follow_write_intent_id
      WHERE i.status IN ('submitted', 'confirmed')
        AND q.status IN ('pending', 'failed')
        AND q.available_at <= CURRENT_TIMESTAMP
      ORDER BY i.updated_at ASC
      LIMIT ?1
    `,
    args: [Math.max(1, Math.min(input.limit ?? 100, 500))],
  })
  let reflected = 0
  const now = (input.now ?? new Date()).toISOString()
  for (const row of pending.rows) {
    const edge = await input.client.execute({
      sql: `
        SELECT 1 AS edge FROM efp_effective_follows
        WHERE follower_address = ?1 AND followed_address = ?2
        LIMIT 1
      `,
      args: [String(row.actor_wallet_address), String(row.target_wallet_address)],
    })
    const desired = Boolean(row.desired_following)
    if ((edge.rows.length > 0) !== desired) continue
    const intentId = String(row.follow_write_intent_id)
    await withTransaction(input.client, "write", async (tx) => {
      await tx.execute({
        sql: `
          UPDATE efp_follow_write_intents
          SET status = 'reflected', reflected_at = ?2, updated_at = ?2
          WHERE follow_write_intent_id = ?1
            AND status IN ('submitted', 'confirmed')
        `,
        args: [intentId, now],
      })
      await tx.execute({
        sql: `
          UPDATE efp_follow_reconciliation_queue
          SET status = 'complete', completed_at = ?2, last_error = NULL, updated_at = ?2
          WHERE requested_by_follow_write_intent_id = ?1
        `,
        args: [intentId, now],
      })
    })
    reflected += 1
  }
  return { examined: pending.rows.length, reflected }
}

export async function recordEfpFollowAdoptionSnapshot(input: {
  client: Client
  now?: Date
}): Promise<void> {
  const now = (input.now ?? new Date()).toISOString()
  await input.client.execute({
    sql: `
      INSERT INTO efp_follow_adoption_daily (
        snapshot_date, attached_wallets_in_graph, edges_by_attached_wallets, captured_at
      )
      SELECT
        CAST(?1 AS DATE),
        COUNT(DISTINCT CASE
          WHEN graph.wallet_address IS NOT NULL THEN wa.wallet_address_normalized
        END),
        COUNT(DISTINCT CASE
          WHEN edge.follower_address IS NOT NULL
            THEN edge.follower_address || ':' || edge.followed_address
        END),
        ?1
      FROM wallet_attachments wa
      LEFT JOIN (
        SELECT follower_address AS wallet_address FROM efp_effective_follows
        UNION
        SELECT followed_address AS wallet_address FROM efp_effective_follows
      ) graph ON graph.wallet_address = wa.wallet_address_normalized
      LEFT JOIN efp_effective_follows edge
        ON edge.follower_address = wa.wallet_address_normalized
      WHERE wa.status = 'active'
        AND wa.chain_namespace LIKE 'eip155%'
      ON CONFLICT (snapshot_date) DO UPDATE SET
        attached_wallets_in_graph = excluded.attached_wallets_in_graph,
        edges_by_attached_wallets = excluded.edges_by_attached_wallets,
        captured_at = excluded.captured_at
    `,
    args: [now],
  })
}
