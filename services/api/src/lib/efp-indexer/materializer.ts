import type { Address, Hex } from "viem"

import type { Client, QueryResultRow, ReadClient, Transaction } from "../sql-client"
import { withTransaction } from "../transactions"
import { decodeEfpListOp, isEffectiveEfpFollow, type EffectiveEfpEntry } from "./list-op"
import type { EfpAffectedListSlot } from "./repository"

export type MaterializedFollowEdge = {
  followedAddress: Address
  listChainId: number
  listContractAddress: Address
  listSlot: bigint
  sourceBlockNumber: bigint
  sourceTransactionHash: Hex
  sourceTransactionIndex: number
  sourceLogIndex: number
}

type AuthoritativeListRow = {
  listChainId: number
  listContractAddress: Address
  listSlot: bigint
}

async function readAuthoritativeList(
  client: Pick<ReadClient, "execute">,
  follower: Address,
): Promise<AuthoritativeListRow | null> {
  const result = await client.execute({
    sql: `
      WITH latest_primary AS (
        SELECT list_id
        FROM efp_primary_list_events
        WHERE account_address = ?1
        ORDER BY block_number DESC, transaction_index DESC, log_index DESC
        LIMIT 1
      )
      SELECT storage_chain_id, storage_contract_address, storage_slot
      FROM efp_list_storage_location_events
      WHERE list_id = (SELECT list_id FROM latest_primary)
      ORDER BY block_number DESC, transaction_index DESC, log_index DESC
      LIMIT 1
    `,
    args: [follower],
  })
  const row = result.rows[0]
  if (
    row == null
    || row.storage_chain_id == null
    || typeof row.storage_contract_address !== "string"
    || typeof row.storage_slot !== "string"
  ) return null
  return {
    listChainId: Number(row.storage_chain_id),
    listContractAddress: row.storage_contract_address.toLowerCase() as Address,
    listSlot: BigInt(row.storage_slot),
  }
}

/**
 * Replays the authoritative slot from its complete retained history. Pointer
 * changes call this even when the slot's last op predates every watermark.
 */
export async function deriveAuthoritativeFollowerEdges(
  client: Pick<ReadClient, "execute">,
  followerAddress: Address,
): Promise<MaterializedFollowEdge[]> {
  const list = await readAuthoritativeList(client, followerAddress.toLowerCase() as Address)
  if (!list) return []
  const result = await client.execute({
    sql: `
      SELECT raw_op, block_number, transaction_hash, transaction_index, log_index
      FROM efp_list_ops
      WHERE chain_id = ?1 AND contract_address = ?2 AND slot = ?3
      ORDER BY block_number, transaction_index, log_index
    `,
    args: [list.listChainId, list.listContractAddress, list.listSlot.toString()],
  })
  const entries = new Map<Address, EffectiveEfpEntry & {
    sourceBlockNumber: bigint
    sourceTransactionHash: Hex
    sourceTransactionIndex: number
    sourceLogIndex: number
  }>()
  for (const row of result.rows) {
    if (typeof row.raw_op !== "string") {
      throw new Error("EFP authoritative slot contains an unreadable raw operation")
    }
    const decoded = decodeEfpListOp(row.raw_op as Hex)
    if (decoded.classification === "unsupported") continue
    if (!decoded.valid || !decoded.targetAddress || decoded.opcode == null) {
      throw new Error(
        `EFP authoritative slot contains a malformed operation at block ${String(row.block_number)}`,
      )
    }
    const current = entries.get(decoded.targetAddress) ?? {
      followed: false,
      tags: new Set<string>(),
      sourceBlockNumber: 0n,
      sourceTransactionHash: `0x${"0".repeat(64)}` as Hex,
      sourceTransactionIndex: 0,
      sourceLogIndex: 0,
    }
    if (decoded.opcode === 1) {
      entries.set(decoded.targetAddress, {
        ...current,
        followed: true,
        sourceBlockNumber: BigInt(String(row.block_number)),
        sourceTransactionHash: String(row.transaction_hash).toLowerCase() as Hex,
        sourceTransactionIndex: Number(row.transaction_index),
        sourceLogIndex: Number(row.log_index),
      })
    } else if (decoded.opcode === 2) {
      entries.delete(decoded.targetAddress)
    } else if (decoded.tag) {
      if (decoded.opcode === 3) current.tags.add(decoded.tag)
      if (decoded.opcode === 4) current.tags.delete(decoded.tag)
      entries.set(decoded.targetAddress, current)
    }
  }
  return [...entries.entries()]
    .filter(([, entry]) => isEffectiveEfpFollow(entry))
    .map(([followedAddress, entry]) => ({
      followedAddress,
      listChainId: list.listChainId,
      listContractAddress: list.listContractAddress,
      listSlot: list.listSlot,
      sourceBlockNumber: entry.sourceBlockNumber,
      sourceTransactionHash: entry.sourceTransactionHash,
      sourceTransactionIndex: entry.sourceTransactionIndex,
      sourceLogIndex: entry.sourceLogIndex,
    }))
}

export async function deriveAuthoritativeFollowersEdges(
  client: Pick<ReadClient, "execute">,
  followerAddresses: readonly Address[],
): Promise<Map<Address, MaterializedFollowEdge[]>> {
  const followers = [...new Set(
    followerAddresses.map((item) => item.toLowerCase() as Address),
  )]
  const derived = new Map<Address, MaterializedFollowEdge[]>(
    followers.map((follower) => [follower, []]),
  )
  if (followers.length === 0) return derived
  const values = followers.map((_, index) => `(?${index + 1})`).join(", ")
  const result = await client.execute({
    sql: `
      WITH requested(follower_address) AS (VALUES ${values}),
      ranked_primary AS (
        SELECT events.account_address, events.list_id,
               ROW_NUMBER() OVER (
                 PARTITION BY events.account_address
                 ORDER BY events.block_number DESC,
                          events.transaction_index DESC,
                          events.log_index DESC
               ) AS rank
        FROM efp_primary_list_events events
        JOIN requested
          ON requested.follower_address = events.account_address
      ),
      primary_lists AS (
        SELECT account_address, list_id
        FROM ranked_primary
        WHERE rank = 1
      ),
      ranked_storage AS (
        SELECT storage.list_id, storage.storage_chain_id,
               storage.storage_contract_address, storage.storage_slot,
               ROW_NUMBER() OVER (
                 PARTITION BY storage.list_id
                 ORDER BY storage.block_number DESC,
                          storage.transaction_index DESC,
                          storage.log_index DESC
               ) AS rank
        FROM efp_list_storage_location_events storage
        JOIN primary_lists ON primary_lists.list_id = storage.list_id
      ),
      authoritative AS (
        SELECT requested.follower_address,
               storage.storage_chain_id,
               storage.storage_contract_address,
               storage.storage_slot
        FROM requested
        LEFT JOIN primary_lists
          ON primary_lists.account_address = requested.follower_address
        LEFT JOIN ranked_storage storage
          ON storage.list_id = primary_lists.list_id AND storage.rank = 1
      )
      SELECT authoritative.follower_address,
             authoritative.storage_chain_id,
             authoritative.storage_contract_address,
             authoritative.storage_slot,
             ops.raw_op, ops.block_number, ops.transaction_hash,
             ops.transaction_index, ops.log_index
      FROM authoritative
      LEFT JOIN efp_list_ops ops
        ON ops.chain_id = authoritative.storage_chain_id
       AND ops.contract_address = authoritative.storage_contract_address
       AND ops.slot = authoritative.storage_slot
      ORDER BY authoritative.follower_address,
               ops.block_number, ops.transaction_index, ops.log_index
    `,
    args: followers,
  })
  const entriesByFollower = new Map<Address, Map<Address, EffectiveEfpEntry & {
    sourceBlockNumber: bigint
    sourceTransactionHash: Hex
    sourceTransactionIndex: number
    sourceLogIndex: number
  }>>()
  const listsByFollower = new Map<Address, AuthoritativeListRow>()
  for (const row of result.rows) {
    const follower = address(row, "follower_address")
    if (!follower) continue
    if (
      row.storage_chain_id != null
      && typeof row.storage_contract_address === "string"
      && typeof row.storage_slot === "string"
    ) {
      listsByFollower.set(follower, {
        listChainId: Number(row.storage_chain_id),
        listContractAddress: row.storage_contract_address.toLowerCase() as Address,
        listSlot: BigInt(row.storage_slot),
      })
    }
    if (row.raw_op == null) continue
    if (typeof row.raw_op !== "string") {
      throw new Error("EFP authoritative slot contains an unreadable raw operation")
    }
    const decoded = decodeEfpListOp(row.raw_op as Hex)
    if (decoded.classification === "unsupported") continue
    if (!decoded.valid || !decoded.targetAddress || decoded.opcode == null) {
      throw new Error(
        `EFP authoritative slot contains a malformed operation at block ${String(row.block_number)}`,
      )
    }
    const entries = entriesByFollower.get(follower) ?? new Map()
    const current = entries.get(decoded.targetAddress) ?? {
      followed: false,
      tags: new Set<string>(),
      sourceBlockNumber: 0n,
      sourceTransactionHash: `0x${"0".repeat(64)}` as Hex,
      sourceTransactionIndex: 0,
      sourceLogIndex: 0,
    }
    if (decoded.opcode === 1) {
      entries.set(decoded.targetAddress, {
        ...current,
        followed: true,
        sourceBlockNumber: BigInt(String(row.block_number)),
        sourceTransactionHash: String(row.transaction_hash).toLowerCase() as Hex,
        sourceTransactionIndex: Number(row.transaction_index),
        sourceLogIndex: Number(row.log_index),
      })
    } else if (decoded.opcode === 2) {
      entries.delete(decoded.targetAddress)
    } else if (decoded.tag) {
      if (decoded.opcode === 3) current.tags.add(decoded.tag)
      if (decoded.opcode === 4) current.tags.delete(decoded.tag)
      entries.set(decoded.targetAddress, current)
    }
    entriesByFollower.set(follower, entries)
  }
  for (const follower of followers) {
    const list = listsByFollower.get(follower)
    if (!list) continue
    const entries = entriesByFollower.get(follower) ?? new Map()
    derived.set(
      follower,
      [...entries.entries()]
        .filter(([, entry]) => isEffectiveEfpFollow(entry))
        .map(([followedAddress, entry]) => ({
          followedAddress,
          listChainId: list.listChainId,
          listContractAddress: list.listContractAddress,
          listSlot: list.listSlot,
          sourceBlockNumber: entry.sourceBlockNumber,
          sourceTransactionHash: entry.sourceTransactionHash,
          sourceTransactionIndex: entry.sourceTransactionIndex,
          sourceLogIndex: entry.sourceLogIndex,
        })),
    )
  }
  return derived
}

function address(row: QueryResultRow, key: string): Address | null {
  const value = row[key]
  return typeof value === "string" && /^0x[0-9a-f]{40}$/u.test(value)
    ? value as Address
    : null
}

async function recomputeWalletCount(
  tx: Transaction,
  walletAddress: Address,
  revision: bigint,
  now: string,
): Promise<void> {
  await tx.execute({
    sql: `
      INSERT INTO efp_follow_counts (
        wallet_address, follower_count, following_count,
        projection_revision, updated_at
      )
      SELECT
        ?1,
        (SELECT COUNT(*) FROM efp_effective_follows WHERE followed_address = ?1),
        (SELECT COUNT(*) FROM efp_effective_follows WHERE follower_address = ?1),
        ?2,
        ?3
      ON CONFLICT(wallet_address) DO UPDATE SET
        follower_count = excluded.follower_count,
        following_count = excluded.following_count,
        projection_revision = excluded.projection_revision,
        updated_at = excluded.updated_at
    `,
    args: [walletAddress, revision.toString(), now],
  })
}

const PROJECTION_WRITE_BATCH_SIZE = 1_000

function chunks<T>(values: readonly T[], size = PROJECTION_WRITE_BATCH_SIZE): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size))
  }
  return result
}

async function recomputeWalletCounts(
  tx: Transaction,
  walletAddresses: readonly Address[],
  revision: bigint,
  now: string,
): Promise<void> {
  for (const batch of chunks([...new Set(walletAddresses)])) {
    const values = batch.map((_, index) => `(?${index + 1})`).join(", ")
    await tx.execute({
      sql: `
        WITH wallets(wallet_address) AS (VALUES ${values})
        INSERT INTO efp_follow_counts (
          wallet_address, follower_count, following_count,
          projection_revision, updated_at
        )
        SELECT
          wallets.wallet_address,
          (SELECT COUNT(*) FROM efp_effective_follows
           WHERE followed_address = wallets.wallet_address),
          (SELECT COUNT(*) FROM efp_effective_follows
           WHERE follower_address = wallets.wallet_address),
          ?${batch.length + 1},
          ?${batch.length + 2}
        FROM wallets
        WHERE TRUE
        ON CONFLICT(wallet_address) DO UPDATE SET
          follower_count = excluded.follower_count,
          following_count = excluded.following_count,
          projection_revision = excluded.projection_revision,
          updated_at = excluded.updated_at
      `,
      args: [...batch, revision.toString(), now],
    })
  }
}

/**
 * Atomically replaces every effective edge for one follower. This is the only
 * primary-list repoint path: old-list edges are deleted before new-list edges
 * and affected counters are recomputed from the edge table in the same tx.
 */
export async function replaceFollowerEffectiveEdges(input: {
  client: Client
  followerAddress: Address
  edges: readonly MaterializedFollowEdge[]
  projectionRevision: bigint
  now: string
}): Promise<void> {
  const follower = input.followerAddress.toLowerCase() as Address
  await withTransaction(input.client, "write", async (tx) => {
    await replaceFollowerEffectiveEdgesInTransaction({
      tx,
      followerAddress: follower,
      edges: input.edges,
      projectionRevision: input.projectionRevision,
      now: input.now,
    })
  })
}

export async function replaceFollowerEffectiveEdgesInTransaction(input: {
  tx: Transaction
  followerAddress: Address
  edges: readonly MaterializedFollowEdge[]
  projectionRevision: bigint
  now: string
}): Promise<void> {
    const follower = input.followerAddress.toLowerCase() as Address
    const tx = input.tx
    const old = await tx.execute({
      sql: "SELECT followed_address FROM efp_effective_follows WHERE follower_address = ?1",
      args: [follower],
    })
    const affected = new Set<Address>([follower])
    for (const row of old.rows) {
      const target = address(row, "followed_address")
      if (target) affected.add(target)
    }

    await tx.execute({
      sql: "DELETE FROM efp_effective_follows WHERE follower_address = ?1",
      args: [follower],
    })
    const normalizedEdges = input.edges.map((edge) => {
      const followedAddress = edge.followedAddress.toLowerCase() as Address
      affected.add(followedAddress)
      return { ...edge, followedAddress }
    })
    for (const batch of chunks(normalizedEdges)) {
      const args: (string | number)[] = []
      const values = batch.map((edge) => {
        const offset = args.length
        args.push(
          follower,
          edge.followedAddress,
          edge.listChainId,
          edge.listContractAddress.toLowerCase(),
          edge.listSlot.toString(),
          edge.sourceBlockNumber.toString(),
          edge.sourceTransactionHash.toLowerCase(),
          edge.sourceTransactionIndex,
          edge.sourceLogIndex,
          input.now,
        )
        return `(${Array.from({ length: 10 }, (_, index) => `?${offset + index + 1}`).join(", ")})`
      }).join(", ")
      await tx.execute({
        sql: `
          INSERT INTO efp_effective_follows (
            follower_address, followed_address, list_chain_id,
            list_contract_address, list_slot, source_block_number,
            source_transaction_hash, source_transaction_index,
            source_log_index, updated_at
          ) VALUES ${values}
        `,
        args,
      })
    }

    await recomputeWalletCounts(
      tx,
      [...affected],
      input.projectionRevision,
      input.now,
    )
}

export async function replaceFollowersEffectiveEdgesInTransaction(input: {
  tx: Transaction
  edgesByFollower: ReadonlyMap<Address, readonly MaterializedFollowEdge[]>
  projectionRevision: bigint
  now: string
}): Promise<void> {
  const followers = [...input.edgesByFollower.keys()].map(
    (item) => item.toLowerCase() as Address,
  )
  if (followers.length === 0) return
  const followerPlaceholders = followers.map((_, index) => `?${index + 1}`).join(", ")
  const old = await input.tx.execute({
    sql: `
      SELECT follower_address, followed_address
      FROM efp_effective_follows
      WHERE follower_address IN (${followerPlaceholders})
    `,
    args: followers,
  })
  const affected = new Set<Address>(followers)
  for (const row of old.rows) {
    const target = address(row, "followed_address")
    if (target) affected.add(target)
  }
  await input.tx.execute({
    sql: `DELETE FROM efp_effective_follows
          WHERE follower_address IN (${followerPlaceholders})`,
    args: followers,
  })

  const rows = followers.flatMap((follower) =>
    (input.edgesByFollower.get(follower) ?? []).map((edge) => {
      const followedAddress = edge.followedAddress.toLowerCase() as Address
      affected.add(followedAddress)
      return { follower, followedAddress, edge }
    }))
  for (const batch of chunks(rows)) {
    const args: (string | number)[] = []
    const values = batch.map(({ follower, followedAddress, edge }) => {
      const offset = args.length
      args.push(
        follower,
        followedAddress,
        edge.listChainId,
        edge.listContractAddress.toLowerCase(),
        edge.listSlot.toString(),
        edge.sourceBlockNumber.toString(),
        edge.sourceTransactionHash.toLowerCase(),
        edge.sourceTransactionIndex,
        edge.sourceLogIndex,
        input.now,
      )
      return `(${Array.from({ length: 10 }, (_, index) => `?${offset + index + 1}`).join(", ")})`
    }).join(", ")
    await input.tx.execute({
      sql: `
        INSERT INTO efp_effective_follows (
          follower_address, followed_address, list_chain_id,
          list_contract_address, list_slot, source_block_number,
          source_transaction_hash, source_transaction_index,
          source_log_index, updated_at
        ) VALUES ${values}
      `,
      args,
    })
  }
  await recomputeWalletCounts(
    input.tx,
    [...affected],
    input.projectionRevision,
    input.now,
  )
}

/**
 * Projection half of an indexer replay transaction. Call this through
 * replaceEfpIndexerRange.onRangeReplaced so old raw rows, replacement rows,
 * cursor movement, and full affected-follower replay commit atomically.
 */
export async function rebuildEfpProjectionAfterRangeReplacement(input: {
  tx: Transaction
  affectedSlots: readonly EfpAffectedListSlot[]
  affectedAccounts: readonly Address[]
  affectedListIds: readonly bigint[]
  chainId: number
  appliedThroughBlock: bigint
  appliedThroughBlockHash: Hex
  projectionRevision?: bigint
  now: string
}): Promise<void> {
  const state = await input.tx.execute(
    "SELECT projection_revision FROM efp_follow_projection_state WHERE projection_key = 'effective-graph'",
  )
  const projectionRevision = input.projectionRevision
    ?? BigInt(String(state.rows[0]?.projection_revision ?? "0")) + 1n
  await input.tx.execute({
    sql: `
      UPDATE efp_follow_projection_state
      SET status = 'rebuilding',
          projection_revision = ?2,
          status_changed_at = CASE WHEN status <> 'rebuilding' THEN ?1 ELSE status_changed_at END,
          updated_at = ?1
      WHERE projection_key = 'effective-graph'
    `,
    args: [input.now, projectionRevision.toString()],
  })

  const followers = new Set<Address>(
    input.affectedAccounts.map((item) => item.toLowerCase() as Address),
  )
  for (const slot of input.affectedSlots) {
    const projected = await input.tx.execute({
      sql: `
        SELECT DISTINCT follower_address
        FROM efp_effective_follows
        WHERE list_chain_id = ?1 AND list_contract_address = ?2 AND list_slot = ?3
      `,
      args: [slot.chainId, slot.contractAddress.toLowerCase(), slot.slot.toString()],
    })
    for (const row of projected.rows) {
      const follower = address(row, "follower_address")
      if (follower) followers.add(follower)
    }
    const authoritative = await input.tx.execute({
      sql: `
        WITH latest_primary AS (
          SELECT account_address, list_id,
                 ROW_NUMBER() OVER (
                   PARTITION BY account_address
                   ORDER BY block_number DESC, transaction_index DESC, log_index DESC
                 ) AS rank
          FROM efp_primary_list_events
        ), latest_storage AS (
          SELECT list_id, storage_chain_id, storage_contract_address, storage_slot,
                 ROW_NUMBER() OVER (
                   PARTITION BY list_id
                   ORDER BY block_number DESC, transaction_index DESC, log_index DESC
                 ) AS rank
          FROM efp_list_storage_location_events
        )
        SELECT primary_list.account_address AS follower_address
        FROM latest_primary primary_list
        JOIN latest_storage storage ON storage.list_id = primary_list.list_id
        WHERE primary_list.rank = 1 AND storage.rank = 1
          AND storage.storage_chain_id = ?1
          AND storage.storage_contract_address = ?2
          AND storage.storage_slot = ?3
      `,
      args: [slot.chainId, slot.contractAddress.toLowerCase(), slot.slot.toString()],
    })
    for (const row of authoritative.rows) {
      const follower = address(row, "follower_address")
      if (follower) followers.add(follower)
    }
  }
  for (const listId of input.affectedListIds) {
    const result = await input.tx.execute({
      sql: `
        WITH latest_primary AS (
          SELECT account_address, list_id,
                 ROW_NUMBER() OVER (
                   PARTITION BY account_address
                   ORDER BY block_number DESC, transaction_index DESC, log_index DESC
                 ) AS rank
          FROM efp_primary_list_events
        )
        SELECT account_address AS follower_address
        FROM latest_primary
        WHERE rank = 1 AND list_id = ?1
      `,
      args: [listId.toString()],
    })
    for (const row of result.rows) {
      const follower = address(row, "follower_address")
      if (follower) followers.add(follower)
    }
  }

  let blockedReason: string | null = null
  for (const follower of followers) {
    try {
      const edges = await deriveAuthoritativeFollowerEdges(input.tx, follower)
      await replaceFollowerEffectiveEdgesInTransaction({
        tx: input.tx,
        followerAddress: follower,
        edges,
        projectionRevision,
        now: input.now,
      })
    } catch (error) {
      blockedReason = error instanceof Error ? error.message : String(error)
    }
  }
  if (blockedReason) {
    await input.tx.execute({
      sql: `
        UPDATE efp_follow_projection_state
        SET status = 'unavailable',
            last_error = ?1,
            status_changed_at = ?2,
            updated_at = ?2
        WHERE projection_key = 'effective-graph'
      `,
      args: [blockedReason, input.now],
    })
    return
  }
  await input.tx.execute({
    sql: `
      INSERT INTO efp_follow_projection_chain_watermarks (
        chain_id, applied_through_block, applied_through_block_hash,
        projection_revision, last_successful_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
      ON CONFLICT(chain_id) DO UPDATE SET
        applied_through_block = excluded.applied_through_block,
        applied_through_block_hash = excluded.applied_through_block_hash,
        projection_revision = excluded.projection_revision,
        last_successful_at = excluded.last_successful_at,
        updated_at = excluded.updated_at
    `,
    args: [
      input.chainId,
      input.appliedThroughBlock.toString(),
      input.appliedThroughBlockHash.toLowerCase(),
      projectionRevision.toString(),
      input.now,
    ],
  })
  await input.tx.execute({
    sql: `
      UPDATE efp_follow_projection_state
      SET last_error = NULL, updated_at = ?1
      WHERE projection_key = 'effective-graph'
    `,
    args: [input.now],
  })
}

export async function findEfpFollowersAffectedByChain(input: {
  tx: Transaction
  chainId: number
}): Promise<Address[]> {
  const result = await input.tx.execute({
    sql: `
      WITH latest_primary AS (
        SELECT account_address, list_id,
               ROW_NUMBER() OVER (
                 PARTITION BY account_address
                 ORDER BY block_number DESC, transaction_index DESC, log_index DESC
               ) AS rank
        FROM efp_primary_list_events
      ), latest_storage AS (
        SELECT list_id, storage_chain_id,
               ROW_NUMBER() OVER (
                 PARTITION BY list_id
                 ORDER BY block_number DESC, transaction_index DESC, log_index DESC
               ) AS rank
        FROM efp_list_storage_location_events
      ), affected_followers AS (
        SELECT follower_address
        FROM efp_effective_follows
        WHERE list_chain_id = ?1
        UNION
        SELECT primary_list.account_address AS follower_address
        FROM latest_primary primary_list
        JOIN latest_storage storage ON storage.list_id = primary_list.list_id
        WHERE primary_list.rank = 1 AND storage.rank = 1
          AND storage.storage_chain_id = ?1
      )
      SELECT DISTINCT follower_address
      FROM affected_followers
      ORDER BY follower_address
    `,
    args: [input.chainId],
  })
  return result.rows.flatMap((row) => {
    const followerAddress = address(row, "follower_address")
    return followerAddress ? [followerAddress] : []
  })
}

export async function refreshEfpProjectionAvailability(input: {
  client: Client
  projectionRevision?: bigint
  now: string
  maxCursorAgeMs?: number
}): Promise<"current" | "stale" | "unavailable"> {
  return await withTransaction(input.client, "write", async (tx) => {
    const state = await tx.execute(
      `SELECT status, projection_revision, last_error
       FROM efp_follow_projection_state
       WHERE projection_key = 'effective-graph'`,
    )
    if (
      state.rows[0]?.status === "unavailable"
      && typeof state.rows[0]?.last_error === "string"
    ) return "unavailable"
    const projectionRevision = input.projectionRevision
      ?? BigInt(String(state.rows[0]?.projection_revision ?? "0"))
    const coverage = await tx.execute(`
      SELECT
        expected.chain_id,
        cursor.safe_head_block,
        cursor.last_scan_completed_at,
        watermark.applied_through_block
      FROM efp_follow_projection_expected_chains expected
      LEFT JOIN efp_indexer_cursors cursor ON cursor.chain_id = expected.chain_id
      LEFT JOIN efp_follow_projection_chain_watermarks watermark
        ON watermark.chain_id = expected.chain_id
      WHERE expected.enabled
    `)
    const nowMs = Date.parse(input.now)
    const maxCursorAgeMs = input.maxCursorAgeMs ?? 15 * 60 * 1_000
    const incomplete = coverage.rows.some((row) => {
      const scannedAt = typeof row.last_scan_completed_at === "string"
        ? Date.parse(row.last_scan_completed_at)
        : Number.NaN
      return row.safe_head_block == null
        || row.applied_through_block == null
        || BigInt(String(row.applied_through_block)) < BigInt(String(row.safe_head_block))
        || !Number.isFinite(scannedAt)
        || !Number.isFinite(nowMs)
        || nowMs - scannedAt > maxCursorAgeMs
    })
    const status = coverage.rows.length === 0 || incomplete ? "stale" : "current"
    await tx.execute({
      sql: `
        UPDATE efp_follow_projection_state
        SET status = ?1,
            projection_revision = ?2,
            last_successful_at = CASE WHEN ?1 = 'current' THEN ?3 ELSE last_successful_at END,
            status_changed_at = CASE WHEN status <> ?1 THEN ?3 ELSE status_changed_at END,
            last_error = NULL,
            updated_at = ?3
        WHERE projection_key = 'effective-graph'
      `,
      args: [status, projectionRevision.toString(), input.now],
    })
    return status
  })
}

export type FollowCountDrift = {
  walletAddress: Address
  storedFollowerCount: number | null
  storedFollowingCount: number | null
  actualFollowerCount: number
  actualFollowingCount: number
}

export async function reconcileEfpFollowCounts(input: {
  client: Client
  walletAddresses?: readonly Address[]
  now: string
  systemicDriftThreshold?: number
}): Promise<FollowCountDrift[]> {
  const requestedWallets = input.walletAddresses
    ? [...new Set(input.walletAddresses.map((item) => item.toLowerCase() as Address))]
    : undefined
  const filter = requestedWallets?.length
    ? `WHERE wallets.wallet_address IN (${requestedWallets.map((_, index) => `?${index + 1}`).join(", ")})`
    : ""
  const wallets = await input.client.execute({
    sql: `
      WITH wallets AS (
        SELECT follower_address AS wallet_address FROM efp_effective_follows
        UNION
        SELECT followed_address FROM efp_effective_follows
        UNION
        SELECT wallet_address FROM efp_follow_counts
      )
      SELECT
        wallets.wallet_address,
        counts.follower_count,
        counts.following_count,
        (SELECT COUNT(*) FROM efp_effective_follows e WHERE e.followed_address = wallets.wallet_address)
          AS actual_follower_count,
        (SELECT COUNT(*) FROM efp_effective_follows e WHERE e.follower_address = wallets.wallet_address)
          AS actual_following_count
      FROM wallets
      LEFT JOIN efp_follow_counts counts ON counts.wallet_address = wallets.wallet_address
      ${filter}
    `,
    args: requestedWallets ?? [],
  })
  const drift: FollowCountDrift[] = []
  for (const row of wallets.rows) {
    const walletAddress = address(row, "wallet_address")
    if (!walletAddress) continue
    const storedFollowerCount = row.follower_count == null ? null : Number(row.follower_count)
    const storedFollowingCount = row.following_count == null ? null : Number(row.following_count)
    const actualFollowerCount = Number(row.actual_follower_count)
    const actualFollowingCount = Number(row.actual_following_count)
    if (
      storedFollowerCount !== actualFollowerCount
      || storedFollowingCount !== actualFollowingCount
    ) {
      drift.push({
        walletAddress,
        storedFollowerCount,
        storedFollowingCount,
        actualFollowerCount,
        actualFollowingCount,
      })
    }
  }

  const threshold = input.systemicDriftThreshold ?? 50
  const systemic = drift.length >= threshold
  const state = await input.client.execute(
    "SELECT projection_revision FROM efp_follow_projection_state WHERE projection_key = 'effective-graph'",
  )
  const projectionRevision = BigInt(String(state.rows[0]?.projection_revision ?? "0"))
  await withTransaction(input.client, "write", async (tx) => {
    // Isolated drift repairs only the affected wallets. The graph becomes
    // unavailable only when drift crosses the explicit systemic threshold.
    for (const item of drift) {
      await recomputeWalletCount(tx, item.walletAddress, projectionRevision, input.now)
    }
    await tx.execute({
      sql: `
        UPDATE efp_follow_projection_state
        SET last_reconciled_at = ?1,
            last_reconciliation_error = ?2,
            status = CASE WHEN ?3 = 1 THEN 'unavailable' ELSE status END,
            status_changed_at = CASE WHEN ?3 = 1 THEN ?1 ELSE status_changed_at END,
            updated_at = ?1
        WHERE projection_key = 'effective-graph'
      `,
      args: [
        input.now,
        drift.length === 0 ? null : `follow count drift repaired: ${drift.length} wallet(s)`,
        systemic ? 1 : 0,
      ],
    })
  })
  return drift
}
