import { afterEach, describe, expect, test } from "bun:test"
import type { Address, Hex } from "viem"

import { createControlPlaneTestClient } from "../../../tests/helpers"
import type { Client } from "../sql-client"
import { decodeEfpListOp } from "./list-op"
import {
  deriveAuthoritativeFollowerEdges,
  findEfpFollowersAffectedByChain,
  rebuildEfpProjectionAfterRangeReplacement,
  reconcileEfpFollowCounts,
  refreshEfpProjectionAvailability,
  replaceFollowerEffectiveEdges,
  replaceFollowersEffectiveEdgesInTransaction,
  type EfpProjectionRebuildStats,
} from "./materializer"
import { replaceEfpIndexerRange } from "./repository"
import { withTransaction } from "../transactions"

const FOLLOWER = "0x1111111111111111111111111111111111111111" as Address
const OLD_TARGET = "0x2222222222222222222222222222222222222222" as Address
const NEW_TARGET = "0x3333333333333333333333333333333333333333" as Address
const SECOND_TARGET = "0x4444444444444444444444444444444444444444" as Address
const SECOND_FOLLOWER = "0x5555555555555555555555555555555555555555" as Address
const UNRELATED = "0x6666666666666666666666666666666666666666" as Address
const CONTRACT = "0x41aa48ef3c0446b46a5b1cc6337ff3d3716e2a33" as Address
const HASH = `0x${"44".repeat(32)}` as Hex
const NOW = "2026-07-26T00:00:00.000Z"
const LATER = "2026-07-26T01:00:00.000Z"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())))

async function setup() {
  const database = await createControlPlaneTestClient()
  cleanups.push(database.cleanup)
  await database.client.batch([
    { sql: `CREATE TABLE efp_effective_follows (
      follower_address TEXT NOT NULL, followed_address TEXT NOT NULL,
      list_chain_id INTEGER NOT NULL, list_contract_address TEXT NOT NULL,
      list_slot TEXT NOT NULL, source_block_number INTEGER NOT NULL,
      source_transaction_hash TEXT NOT NULL, source_transaction_index INTEGER NOT NULL,
      source_log_index INTEGER NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (follower_address, followed_address))` },
    { sql: `CREATE TABLE efp_follow_counts (
      wallet_address TEXT PRIMARY KEY, follower_count INTEGER NOT NULL,
      following_count INTEGER NOT NULL, projection_revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL)` },
    { sql: `CREATE TABLE efp_follow_projection_state (
      projection_key TEXT PRIMARY KEY, status TEXT NOT NULL,
      projection_revision INTEGER NOT NULL, last_successful_at TEXT,
      status_changed_at TEXT NOT NULL, last_error TEXT, updated_at TEXT NOT NULL,
      last_reconciled_at TEXT, last_reconciliation_error TEXT)` },
    { sql: `INSERT INTO efp_follow_projection_state VALUES (
      'effective-graph', 'initializing', 0, NULL, ?1, NULL, ?1, NULL, NULL)`, args: [NOW] },
    { sql: `CREATE TABLE efp_follow_projection_expected_chains (
      chain_id INTEGER PRIMARY KEY, confirmation_buffer_blocks INTEGER NOT NULL,
      enabled INTEGER NOT NULL, updated_at TEXT NOT NULL)` },
    { sql: `CREATE TABLE efp_follow_projection_chain_watermarks (
      chain_id INTEGER PRIMARY KEY, applied_through_block INTEGER NOT NULL,
      applied_through_block_hash TEXT NOT NULL, projection_revision INTEGER NOT NULL,
      last_successful_at TEXT NOT NULL, updated_at TEXT NOT NULL)` },
    { sql: `CREATE TABLE efp_indexer_cursors (
      chain_id INTEGER PRIMARY KEY, indexed_through_block INTEGER NOT NULL,
      indexed_through_block_hash TEXT NOT NULL, safe_head_block INTEGER NOT NULL,
      last_scan_started_at TEXT, last_scan_completed_at TEXT, updated_at TEXT NOT NULL)` },
    { sql: `CREATE TABLE efp_primary_list_events (
      chain_id INTEGER, contract_address TEXT, account_address TEXT, metadata_key TEXT,
      raw_value TEXT, list_id TEXT, block_number INTEGER, block_hash TEXT,
      transaction_hash TEXT, transaction_index INTEGER, log_index INTEGER, created_at TEXT)` },
    { sql: `CREATE TABLE efp_list_storage_location_events (
      chain_id INTEGER, registry_address TEXT, list_id TEXT, raw_storage_location TEXT,
      storage_chain_id INTEGER, storage_contract_address TEXT, storage_slot TEXT,
      block_number INTEGER, block_hash TEXT, transaction_hash TEXT,
      transaction_index INTEGER, log_index INTEGER, created_at TEXT)` },
    { sql: `CREATE TABLE efp_list_ops (
      chain_id INTEGER, contract_address TEXT, slot TEXT, block_number INTEGER,
      block_hash TEXT, transaction_hash TEXT, transaction_index INTEGER,
      log_index INTEGER, raw_op TEXT, op_version INTEGER, opcode INTEGER,
      record_version INTEGER, record_type INTEGER, target_address TEXT,
      tag TEXT, created_at TEXT)` },
  ], "write")
  return database.client
}

function edge(target: Address, slot: bigint) {
  return {
    followedAddress: target,
    listChainId: 8453,
    listContractAddress: CONTRACT,
    listSlot: slot,
    sourceBlockNumber: 100n,
    sourceTransactionHash: HASH,
    sourceTransactionIndex: 0,
    sourceLogIndex: 0,
  }
}

const GRAPH_WRITE_PATTERN = /^\s*(?:INSERT INTO efp_effective_follows|DELETE FROM efp_effective_follows|UPDATE efp_effective_follows|INSERT INTO efp_follow_counts)/u

function spyGraphWrites(client: Client): { client: Client; statements: string[] } {
  const statements: string[] = []
  const wrap = (execute: Client["execute"]): Client["execute"] =>
    async (statement) => {
      const sql = typeof statement === "string" ? statement : statement.sql
      if (GRAPH_WRITE_PATTERN.test(sql)) statements.push(sql)
      return await execute(statement)
    }
  return {
    statements,
    client: {
      execute: wrap(client.execute.bind(client)),
      batch: client.batch.bind(client),
      transaction: async (mode) => {
        const tx = await client.transaction(mode)
        return {
          execute: wrap(tx.execute.bind(tx)),
          batch: tx.batch.bind(tx),
          commit: tx.commit.bind(tx),
          rollback: tx.rollback.bind(tx),
          close: tx.close.bind(tx),
        }
      },
    },
  }
}

describe("EFP follow materializer", () => {
  test("finds projected and authoritative followers for a storage chain in one set", async () => {
    const client = await setup()
    await client.batch([
      {
        sql: `INSERT INTO efp_effective_follows VALUES (
          ?1, ?2, 10, ?3, '77', 100, ?4, 0, 0, ?5
        )`,
        args: [FOLLOWER, OLD_TARGET, CONTRACT, HASH, NOW],
      },
      {
        sql: `INSERT INTO efp_primary_list_events (
          chain_id, contract_address, account_address, metadata_key, raw_value,
          list_id, block_number, block_hash, transaction_hash, transaction_index,
          log_index, created_at
        ) VALUES (8453, ?2, ?1, 'primary-list', '0x09', '9', 100, ?3, ?3, 0, 0, ?4)`,
        args: [NEW_TARGET, CONTRACT, HASH, NOW],
      },
      {
        sql: `INSERT INTO efp_list_storage_location_events (
          chain_id, registry_address, list_id, raw_storage_location,
          storage_chain_id, storage_contract_address, storage_slot,
          block_number, block_hash, transaction_hash, transaction_index,
          log_index, created_at
        ) VALUES (8453, ?1, '9', '0x', 10, ?1, '88', 100, ?2, ?2, 0, 0, ?3)`,
        args: [CONTRACT, HASH, NOW],
      },
    ], "write")

    const followers = await withTransaction(client, "read", (tx) =>
      findEfpFollowersAffectedByChain({ tx, chainId: 10 }))

    expect(followers).toEqual([FOLLOWER, NEW_TARGET])
  })

  test("new pointer replays a slot whose complete history predates the watermark", async () => {
    const client = await setup()
    const rawAdd = `0x01010101${OLD_TARGET.slice(2)}a255609f59`.toLowerCase()
    const unsupportedNftRecord =
      "0x010180806569703135353a383435332f6572633732313a3078613130343365444245316230466665364331326132623865643541664437416342324445413339362f313132393038363537343435363530363530383133343638333733353438313231323839343030353239323636373437303434383234333334363638383933363934363233383932383031393433"
    await client.batch([
      {
        sql: `INSERT INTO efp_list_ops (
          chain_id, contract_address, slot, block_number, block_hash,
          transaction_hash, transaction_index, log_index, raw_op
        ) VALUES (8453, ?1, '77', 4, ?3, ?3, 0, 0, ?2)`,
        args: [CONTRACT, unsupportedNftRecord, HASH],
      },
      {
        sql: `INSERT INTO efp_list_ops (
          chain_id, contract_address, slot, block_number, block_hash,
          transaction_hash, transaction_index, log_index, raw_op
        ) VALUES (8453, ?1, '77', 5, ?3, ?3, 0, 0, ?2)`,
        args: [CONTRACT, rawAdd, HASH],
      },
      {
        sql: `INSERT INTO efp_primary_list_events (
          chain_id, contract_address, account_address, metadata_key, raw_value,
          list_id, block_number, block_hash, transaction_hash, transaction_index,
          log_index, created_at
        ) VALUES (8453, ?2, ?1, 'primary-list', '0x08', '8', 1000, ?3, ?3, 0, 0, ?4)`,
        args: [FOLLOWER, CONTRACT, HASH, NOW],
      },
      {
        sql: `INSERT INTO efp_list_storage_location_events (
          chain_id, registry_address, list_id, raw_storage_location,
          storage_chain_id, storage_contract_address, storage_slot,
          block_number, block_hash, transaction_hash, transaction_index,
          log_index, created_at
        ) VALUES (8453, ?1, '8', '0x', 8453, ?1, '77', 6, ?2, ?2, 0, 0, ?3)`,
        args: [CONTRACT, HASH, NOW],
      },
    ], "write")

    const derived = await deriveAuthoritativeFollowerEdges(client, FOLLOWER)
    expect(derived).toHaveLength(1)
    expect(derived[0]?.followedAddress).toBe(OLD_TARGET)
    expect(derived[0]?.sourceBlockNumber).toBe(5n)
  })

  test("primary-list repoint atomically strands no old edges and repairs counts", async () => {
    const client = await setup()
    await replaceFollowerEffectiveEdges({
      client, followerAddress: FOLLOWER, edges: [edge(OLD_TARGET, 1n)],
      projectionRevision: 1n, now: NOW,
    })
    await replaceFollowerEffectiveEdges({
      client, followerAddress: FOLLOWER, edges: [edge(NEW_TARGET, 2n)],
      projectionRevision: 2n, now: NOW,
    })

    const edges = await client.execute("SELECT followed_address, list_slot FROM efp_effective_follows")
    expect(edges.rows).toEqual([{ followed_address: NEW_TARGET, list_slot: "2" }])
    const counts = await client.execute({
      sql: "SELECT wallet_address, follower_count, following_count FROM efp_follow_counts ORDER BY wallet_address",
    })
    expect(counts.rows).toEqual([
      { wallet_address: FOLLOWER, follower_count: 0, following_count: 1 },
      { wallet_address: OLD_TARGET, follower_count: 0, following_count: 0 },
      { wallet_address: NEW_TARGET, follower_count: 1, following_count: 0 },
    ])
  })

  test("reorg rewind full-replays affected slots instead of range-deleting projection state", async () => {
    const client = await setup()
    const rawRemove = `0x01020101${NEW_TARGET.slice(2)}`.toLowerCase()
    const rawAdd = `0x01010101${NEW_TARGET.slice(2)}`.toLowerCase()
    await client.batch([
      {
        sql: `INSERT INTO efp_primary_list_events (
          chain_id, contract_address, account_address, metadata_key, raw_value,
          list_id, block_number, block_hash, transaction_hash, transaction_index,
          log_index, created_at
        ) VALUES (8453, ?2, ?1, 'primary-list', '0x08', '8', 20, ?3, ?3, 0, 0, ?4)`,
        args: [FOLLOWER, CONTRACT, HASH, NOW],
      },
      {
        sql: `INSERT INTO efp_list_storage_location_events (
          chain_id, registry_address, list_id, raw_storage_location,
          storage_chain_id, storage_contract_address, storage_slot,
          block_number, block_hash, transaction_hash, transaction_index,
          log_index, created_at
        ) VALUES (8453, ?1, '8', '0x', 8453, ?1, '77', 21, ?2, ?2, 0, 0, ?3)`,
        args: [CONTRACT, HASH, NOW],
      },
      {
        sql: `INSERT INTO efp_list_ops (
          chain_id, contract_address, slot, block_number, block_hash,
          transaction_hash, transaction_index, log_index, raw_op
        ) VALUES (8453, ?1, '77', 90, ?2, ?2, 0, 0, ?3)`,
        args: [CONTRACT, HASH, rawRemove],
      },
      {
        sql: `INSERT INTO efp_list_ops (
          chain_id, contract_address, slot, block_number, block_hash,
          transaction_hash, transaction_index, log_index, raw_op
        ) VALUES (8453, ?1, '77', 110, ?2, ?2, 0, 0, ?3)`,
        args: [CONTRACT, HASH, rawAdd],
      },
    ], "write")
    await replaceFollowerEffectiveEdges({
      client,
      followerAddress: FOLLOWER,
      edges: [edge(NEW_TARGET, 77n)],
      projectionRevision: 1n,
      now: NOW,
    })

    await replaceEfpIndexerRange({
      client,
      chainId: 8453,
      fromBlock: 100n,
      throughBlock: 120n,
      throughBlockHash: HASH,
      safeHeadBlock: 120n,
      listOps: [],
      primaryListEvents: [],
      storageLocationEvents: [],
      scanStartedAt: NOW,
      scanCompletedAt: NOW,
      onRangeReplaced: async (affected) => {
        await rebuildEfpProjectionAfterRangeReplacement({
          ...affected,
          chainId: 8453,
          appliedThroughBlock: 120n,
          appliedThroughBlockHash: HASH,
          projectionRevision: 2n,
          now: NOW,
        })
      },
    })

    const raw = await client.execute(
      "SELECT block_number FROM efp_list_ops ORDER BY block_number",
    )
    expect(raw.rows).toEqual([{ block_number: 90 }])
    const state = await client.execute(
      `SELECT status, projection_revision, last_error
       FROM efp_follow_projection_state WHERE projection_key = 'effective-graph'`,
    )
    expect(state.rows[0]?.last_error).toBeNull()
    const projected = await client.execute("SELECT * FROM efp_effective_follows")
    expect(projected.rows).toHaveLength(0)
    const counts = await client.execute({
      sql: "SELECT follower_count, following_count FROM efp_follow_counts WHERE wallet_address = ?1",
      args: [FOLLOWER],
    })
    expect(counts.rows[0]).toEqual({ follower_count: 0, following_count: 0 })
    expect(state.rows[0]).toEqual({
      status: "rebuilding",
      projection_revision: 2,
      last_error: null,
    })

    await replaceEfpIndexerRange({
      client,
      chainId: 8453,
      fromBlock: 121n,
      throughBlock: 121n,
      throughBlockHash: HASH,
      safeHeadBlock: 121n,
      listOps: [],
      primaryListEvents: [],
      storageLocationEvents: [],
      scanStartedAt: NOW,
      scanCompletedAt: NOW,
      onRangeReplaced: async (affected) => {
        await rebuildEfpProjectionAfterRangeReplacement({
          ...affected,
          chainId: 8453,
          appliedThroughBlock: 121n,
          appliedThroughBlockHash: HASH,
          now: NOW,
        })
      },
    })
    const advanced = await client.execute(
      `SELECT state.projection_revision, watermark.projection_revision AS watermark_revision
       FROM efp_follow_projection_state state
       JOIN efp_follow_projection_chain_watermarks watermark ON watermark.chain_id = 8453
       WHERE state.projection_key = 'effective-graph'`,
    )
    expect(advanced.rows[0]).toEqual({
      projection_revision: 3,
      watermark_revision: 3,
    })
  })

  test("retains an unknown raw op but makes its projection unavailable", async () => {
    const client = await setup()
    const rawAdd = `0x01010101${NEW_TARGET.slice(2)}`.toLowerCase() as Hex
    const unknown = "0x05" as Hex
    await client.batch([
      {
        sql: `INSERT INTO efp_primary_list_events (
          chain_id, contract_address, account_address, metadata_key, raw_value,
          list_id, block_number, block_hash, transaction_hash, transaction_index,
          log_index, created_at
        ) VALUES (8453, ?2, ?1, 'primary-list', '0x08', '8', 20, ?3, ?3, 0, 0, ?4)`,
        args: [FOLLOWER, CONTRACT, HASH, NOW],
      },
      {
        sql: `INSERT INTO efp_list_storage_location_events (
          chain_id, registry_address, list_id, raw_storage_location,
          storage_chain_id, storage_contract_address, storage_slot,
          block_number, block_hash, transaction_hash, transaction_index,
          log_index, created_at
        ) VALUES (8453, ?1, '8', '0x', 8453, ?1, '77', 21, ?2, ?2, 0, 0, ?3)`,
        args: [CONTRACT, HASH, NOW],
      },
      {
        sql: `INSERT INTO efp_list_ops (
          chain_id, contract_address, slot, block_number, block_hash,
          transaction_hash, transaction_index, log_index, raw_op
        ) VALUES (8453, ?1, '77', 90, ?2, ?2, 0, 0, ?3)`,
        args: [CONTRACT, HASH, rawAdd],
      },
    ], "write")
    await replaceFollowerEffectiveEdges({
      client,
      followerAddress: FOLLOWER,
      edges: [edge(NEW_TARGET, 77n)],
      projectionRevision: 1n,
      now: NOW,
    })

    await replaceEfpIndexerRange({
      client,
      chainId: 8453,
      fromBlock: 100n,
      throughBlock: 120n,
      throughBlockHash: HASH,
      safeHeadBlock: 120n,
      listOps: [{
        chainId: 8453,
        contractAddress: CONTRACT,
        slot: 77n,
        blockNumber: 110n,
        blockHash: HASH,
        transactionHash: HASH,
        transactionIndex: 0,
        logIndex: 0,
        rawOp: unknown,
        decoded: decodeEfpListOp(unknown),
      }],
      primaryListEvents: [],
      storageLocationEvents: [],
      scanStartedAt: NOW,
      scanCompletedAt: NOW,
      onRangeReplaced: async (affected) => {
        await rebuildEfpProjectionAfterRangeReplacement({
          ...affected,
          chainId: 8453,
          appliedThroughBlock: 120n,
          appliedThroughBlockHash: HASH,
          projectionRevision: 2n,
          now: NOW,
        })
      },
    })

    expect(await refreshEfpProjectionAvailability({ client, now: NOW })).toBe("unavailable")
    const raw = await client.execute(
      "SELECT raw_op FROM efp_list_ops WHERE block_number = 110",
    )
    expect(raw.rows).toEqual([{ raw_op: unknown }])
    const state = await client.execute(
      `SELECT status, projection_revision, last_error
       FROM efp_follow_projection_state WHERE projection_key = 'effective-graph'`,
    )
    expect(state.rows[0]).toEqual({
      status: "unavailable",
      projection_revision: 2,
      last_error: expect.stringContaining("malformed"),
    })
  })

  test("requires every runtime-configured chain and detects counter drift", async () => {
    const client = await setup()
    for (const chainId of [1, 10, 8453]) {
      await client.execute({
        sql: "INSERT INTO efp_follow_projection_expected_chains VALUES (?1, 64, 1, ?2)",
        args: [chainId, NOW],
      })
    }
    expect(await refreshEfpProjectionAvailability({
      client, projectionRevision: 1n, now: NOW,
    })).toBe("stale")

    for (const chainId of [1, 10, 8453]) {
      await client.execute({
        sql: "INSERT INTO efp_indexer_cursors VALUES (?1, 100, ?2, 90, ?3, ?3, ?3)",
        args: [chainId, HASH, NOW],
      })
      await client.execute({
        sql: "INSERT INTO efp_follow_projection_chain_watermarks VALUES (?1, 90, ?2, 1, ?3, ?3)",
        args: [chainId, HASH, NOW],
      })
    }
    expect(await refreshEfpProjectionAvailability({
      client, projectionRevision: 1n, now: NOW,
    })).toBe("current")
    await client.execute({
      sql: "UPDATE efp_indexer_cursors SET last_scan_completed_at = ?1 WHERE chain_id = 10",
      args: ["2026-07-25T00:00:00.000Z"],
    })
    expect(await refreshEfpProjectionAvailability({
      client,
      projectionRevision: 1n,
      now: NOW,
      maxCursorAgeMs: 60_000,
    })).toBe("stale")
    await client.execute({
      sql: "UPDATE efp_indexer_cursors SET last_scan_completed_at = ?1 WHERE chain_id = 10",
      args: [NOW],
    })

    await replaceFollowerEffectiveEdges({
      client, followerAddress: FOLLOWER, edges: [edge(CONTRACT, 2n)],
      projectionRevision: 2n, now: NOW,
    })
    await client.execute({
      sql: "UPDATE efp_follow_counts SET follower_count = 9 WHERE wallet_address = ?1",
      args: [CONTRACT],
    })
    const checksummedContract = "0x41AA48Ef3c0446b46a5b1cc6337FF3d3716E2A33" as Address
    const drift = await reconcileEfpFollowCounts({
      client,
      walletAddresses: [checksummedContract],
      now: NOW,
    })
    expect(drift).toHaveLength(1)
    expect(drift[0]?.walletAddress).toBe(CONTRACT)
    const state = await client.execute(
      "SELECT status, last_reconciliation_error FROM efp_follow_projection_state",
    )
    expect(state.rows[0]?.status).toBe("stale")
    expect(state.rows[0]?.last_reconciliation_error)
      .toBe("follow count drift repaired: 1 wallet(s)")
    const repaired = await client.execute({
      sql: "SELECT follower_count FROM efp_follow_counts WHERE wallet_address = ?1",
      args: [CONTRACT],
    })
    expect(repaired.rows[0]?.follower_count).toBe(1)
  })

  test("identical re-derivation performs no graph or count writes", async () => {
    const client = await setup()
    const edges = [edge(OLD_TARGET, 1n), edge(NEW_TARGET, 1n)]
    await replaceFollowerEffectiveEdges({
      client, followerAddress: FOLLOWER, edges, projectionRevision: 1n, now: NOW,
    })
    const spy = spyGraphWrites(client)

    const stats = await replaceFollowerEffectiveEdges({
      client: spy.client,
      followerAddress: FOLLOWER,
      edges,
      projectionRevision: 2n,
      now: LATER,
    })

    expect(stats).toEqual({
      derived: 2,
      unchanged: 2,
      inserted: 0,
      deleted: 0,
      metadataUpdated: 0,
      countsRecomputed: 0,
    })
    expect(spy.statements).toEqual([])
    const stored = await client.execute({
      sql: `SELECT updated_at FROM efp_effective_follows
            WHERE follower_address = ?1 ORDER BY followed_address`,
      args: [FOLLOWER],
    })
    expect(stored.rows).toEqual([{ updated_at: NOW }, { updated_at: NOW }])
    const counts = await client.execute(
      "SELECT projection_revision, updated_at FROM efp_follow_counts ORDER BY wallet_address",
    )
    expect(counts.rows).toEqual([
      { projection_revision: 1, updated_at: NOW },
      { projection_revision: 1, updated_at: NOW },
      { projection_revision: 1, updated_at: NOW },
    ])
  })

  test("source metadata change updates the edge row without touching counts", async () => {
    const client = await setup()
    await replaceFollowerEffectiveEdges({
      client, followerAddress: FOLLOWER, edges: [edge(OLD_TARGET, 1n)],
      projectionRevision: 1n, now: NOW,
    })
    const spy = spyGraphWrites(client)

    const stats = await replaceFollowerEffectiveEdges({
      client: spy.client,
      followerAddress: FOLLOWER,
      edges: [{ ...edge(OLD_TARGET, 1n), sourceBlockNumber: 101n }],
      projectionRevision: 2n,
      now: LATER,
    })

    expect(stats).toEqual({
      derived: 1,
      unchanged: 0,
      inserted: 0,
      deleted: 0,
      metadataUpdated: 1,
      countsRecomputed: 0,
    })
    expect(spy.statements).toEqual([
      expect.stringContaining("UPDATE efp_effective_follows"),
    ])
    const stored = await client.execute({
      sql: `SELECT source_block_number, updated_at FROM efp_effective_follows
            WHERE follower_address = ?1`,
      args: [FOLLOWER],
    })
    expect(stored.rows).toEqual([{ source_block_number: 101, updated_at: LATER }])
    const counts = await client.execute({
      sql: `SELECT projection_revision, updated_at FROM efp_follow_counts
            WHERE wallet_address = ?1`,
      args: [OLD_TARGET],
    })
    expect(counts.rows).toEqual([{ projection_revision: 1, updated_at: NOW }])
  })

  test("edge add and remove recompute counts only for membership-affected wallets", async () => {
    const client = await setup()
    await replaceFollowerEffectiveEdges({
      client, followerAddress: FOLLOWER, edges: [edge(OLD_TARGET, 1n)],
      projectionRevision: 1n, now: NOW,
    })
    await client.execute({
      sql: "INSERT INTO efp_follow_counts VALUES (?1, 5, 5, 1, ?2)",
      args: [UNRELATED, NOW],
    })

    const stats = await replaceFollowerEffectiveEdges({
      client, followerAddress: FOLLOWER, edges: [edge(NEW_TARGET, 1n)],
      projectionRevision: 2n, now: LATER,
    })

    expect(stats).toEqual({
      derived: 1,
      unchanged: 0,
      inserted: 1,
      deleted: 1,
      metadataUpdated: 0,
      countsRecomputed: 3,
    })
    const counts = await client.execute(
      `SELECT wallet_address, follower_count, following_count, projection_revision, updated_at
       FROM efp_follow_counts ORDER BY wallet_address`,
    )
    expect(counts.rows).toEqual([
      {
        wallet_address: FOLLOWER, follower_count: 0, following_count: 1,
        projection_revision: 2, updated_at: LATER,
      },
      {
        wallet_address: OLD_TARGET, follower_count: 0, following_count: 0,
        projection_revision: 2, updated_at: LATER,
      },
      {
        wallet_address: NEW_TARGET, follower_count: 1, following_count: 0,
        projection_revision: 2, updated_at: LATER,
      },
      {
        wallet_address: UNRELATED, follower_count: 5, following_count: 5,
        projection_revision: 1, updated_at: NOW,
      },
    ])
  })

  test("empty old and new edge sets perform no DML at all", async () => {
    const client = await setup()
    const spy = spyGraphWrites(client)

    const stats = await replaceFollowerEffectiveEdges({
      client: spy.client, followerAddress: FOLLOWER, edges: [],
      projectionRevision: 1n, now: NOW,
    })

    expect(stats).toEqual({
      derived: 0,
      unchanged: 0,
      inserted: 0,
      deleted: 0,
      metadataUpdated: 0,
      countsRecomputed: 0,
    })
    expect(spy.statements).toEqual([])
    const edges = await client.execute(
      "SELECT COUNT(*) AS edge_count FROM efp_effective_follows",
    )
    expect(Number(edges.rows[0]?.edge_count)).toBe(0)
    const counts = await client.execute(
      "SELECT COUNT(*) AS count_rows FROM efp_follow_counts",
    )
    expect(Number(counts.rows[0]?.count_rows)).toBe(0)
  })

  test("batched replacement diffs each follower and gates count recomputation", async () => {
    const client = await setup()
    await replaceFollowerEffectiveEdges({
      client, followerAddress: FOLLOWER, edges: [edge(OLD_TARGET, 1n)],
      projectionRevision: 1n, now: NOW,
    })

    const stats = await withTransaction(client, "write", async (tx) => {
      return await replaceFollowersEffectiveEdgesInTransaction({
        tx,
        edgesByFollower: new Map([
          [FOLLOWER, [edge(OLD_TARGET, 1n)]],
          [SECOND_FOLLOWER, [edge(NEW_TARGET, 1n)]],
        ]),
        projectionRevision: 2n,
        now: LATER,
      })
    })

    expect(stats).toEqual({
      derived: 2,
      unchanged: 1,
      inserted: 1,
      deleted: 0,
      metadataUpdated: 0,
      countsRecomputed: 2,
    })
    const stored = await client.execute({
      sql: `SELECT updated_at FROM efp_effective_follows
            WHERE follower_address = ?1 AND followed_address = ?2`,
      args: [FOLLOWER, OLD_TARGET],
    })
    expect(stored.rows).toEqual([{ updated_at: NOW }])
    const counts = await client.execute(
      `SELECT wallet_address, projection_revision, updated_at
       FROM efp_follow_counts ORDER BY wallet_address`,
    )
    expect(counts.rows).toEqual([
      { wallet_address: FOLLOWER, projection_revision: 1, updated_at: NOW },
      { wallet_address: OLD_TARGET, projection_revision: 1, updated_at: NOW },
      { wallet_address: NEW_TARGET, projection_revision: 2, updated_at: LATER },
      { wallet_address: SECOND_FOLLOWER, projection_revision: 2, updated_at: LATER },
    ])
  })

  test("all-unchanged rebuild advances the watermark with zeroed write stats", async () => {
    const client = await setup()
    const rawAdd = `0x01010101${NEW_TARGET.slice(2)}`.toLowerCase() as Hex
    await client.batch([
      {
        sql: `INSERT INTO efp_primary_list_events (
          chain_id, contract_address, account_address, metadata_key, raw_value,
          list_id, block_number, block_hash, transaction_hash, transaction_index,
          log_index, created_at
        ) VALUES (8453, ?2, ?1, 'primary-list', '0x08', '8', 20, ?3, ?3, 0, 0, ?4)`,
        args: [FOLLOWER, CONTRACT, HASH, NOW],
      },
      {
        sql: `INSERT INTO efp_list_storage_location_events (
          chain_id, registry_address, list_id, raw_storage_location,
          storage_chain_id, storage_contract_address, storage_slot,
          block_number, block_hash, transaction_hash, transaction_index,
          log_index, created_at
        ) VALUES (8453, ?1, '8', '0x', 8453, ?1, '77', 21, ?2, ?2, 0, 0, ?3)`,
        args: [CONTRACT, HASH, NOW],
      },
      {
        sql: `INSERT INTO efp_list_ops (
          chain_id, contract_address, slot, block_number, block_hash,
          transaction_hash, transaction_index, log_index, raw_op
        ) VALUES (8453, ?1, '77', 110, ?2, ?2, 0, 0, ?3)`,
        args: [CONTRACT, HASH, rawAdd],
      },
    ], "write")
    await replaceFollowerEffectiveEdges({
      client,
      followerAddress: FOLLOWER,
      edges: [{ ...edge(NEW_TARGET, 77n), sourceBlockNumber: 110n }],
      projectionRevision: 1n,
      now: NOW,
    })

    let stats: EfpProjectionRebuildStats | undefined
    await replaceEfpIndexerRange({
      client,
      chainId: 8453,
      fromBlock: 100n,
      throughBlock: 120n,
      throughBlockHash: HASH,
      safeHeadBlock: 120n,
      listOps: [{
        chainId: 8453,
        contractAddress: CONTRACT,
        slot: 77n,
        blockNumber: 110n,
        blockHash: HASH,
        transactionHash: HASH,
        transactionIndex: 0,
        logIndex: 0,
        rawOp: rawAdd,
        decoded: decodeEfpListOp(rawAdd),
      }],
      primaryListEvents: [],
      storageLocationEvents: [],
      scanStartedAt: NOW,
      scanCompletedAt: NOW,
      onRangeReplaced: async (affected) => {
        stats = await rebuildEfpProjectionAfterRangeReplacement({
          ...affected,
          chainId: 8453,
          appliedThroughBlock: 120n,
          appliedThroughBlockHash: HASH,
          projectionRevision: 2n,
          now: NOW,
        })
      },
    })

    expect(stats).toEqual({
      followers: 1,
      derived: 1,
      unchanged: 1,
      inserted: 0,
      deleted: 0,
      metadataUpdated: 0,
      countsRecomputed: 0,
    })
    const watermark = await client.execute(
      `SELECT applied_through_block, projection_revision
       FROM efp_follow_projection_chain_watermarks WHERE chain_id = 8453`,
    )
    expect(watermark.rows).toEqual([{ applied_through_block: 120, projection_revision: 2 }])
    const storedEdge = await client.execute({
      sql: `SELECT updated_at FROM efp_effective_follows
            WHERE follower_address = ?1`,
      args: [FOLLOWER],
    })
    expect(storedEdge.rows).toEqual([{ updated_at: NOW }])
    const counts = await client.execute({
      sql: `SELECT projection_revision, updated_at FROM efp_follow_counts
            WHERE wallet_address = ?1`,
      args: [NEW_TARGET],
    })
    expect(counts.rows).toEqual([{ projection_revision: 1, updated_at: NOW }])
  })

  test("changed rebuild reports insert, delete, and metadata-update counts", async () => {
    const client = await setup()
    const rawAdd = `0x01010101${NEW_TARGET.slice(2)}`.toLowerCase() as Hex
    const rawAddSecond = `0x01010101${SECOND_TARGET.slice(2)}`.toLowerCase() as Hex
    await client.batch([
      {
        sql: `INSERT INTO efp_primary_list_events (
          chain_id, contract_address, account_address, metadata_key, raw_value,
          list_id, block_number, block_hash, transaction_hash, transaction_index,
          log_index, created_at
        ) VALUES (8453, ?2, ?1, 'primary-list', '0x08', '8', 20, ?3, ?3, 0, 0, ?4)`,
        args: [FOLLOWER, CONTRACT, HASH, NOW],
      },
      {
        sql: `INSERT INTO efp_list_storage_location_events (
          chain_id, registry_address, list_id, raw_storage_location,
          storage_chain_id, storage_contract_address, storage_slot,
          block_number, block_hash, transaction_hash, transaction_index,
          log_index, created_at
        ) VALUES (8453, ?1, '8', '0x', 8453, ?1, '77', 21, ?2, ?2, 0, 0, ?3)`,
        args: [CONTRACT, HASH, NOW],
      },
      {
        sql: `INSERT INTO efp_list_ops (
          chain_id, contract_address, slot, block_number, block_hash,
          transaction_hash, transaction_index, log_index, raw_op
        ) VALUES (8453, ?1, '77', 110, ?2, ?2, 0, 0, ?3)`,
        args: [CONTRACT, HASH, rawAdd],
      },
    ], "write")
    await replaceFollowerEffectiveEdges({
      client,
      followerAddress: FOLLOWER,
      edges: [
        { ...edge(NEW_TARGET, 77n), sourceBlockNumber: 95n },
        edge(OLD_TARGET, 77n),
      ],
      projectionRevision: 1n,
      now: NOW,
    })

    let stats: EfpProjectionRebuildStats | undefined
    await replaceEfpIndexerRange({
      client,
      chainId: 8453,
      fromBlock: 100n,
      throughBlock: 120n,
      throughBlockHash: HASH,
      safeHeadBlock: 120n,
      listOps: [
        {
          chainId: 8453,
          contractAddress: CONTRACT,
          slot: 77n,
          blockNumber: 110n,
          blockHash: HASH,
          transactionHash: HASH,
          transactionIndex: 0,
          logIndex: 0,
          rawOp: rawAdd,
          decoded: decodeEfpListOp(rawAdd),
        },
        {
          chainId: 8453,
          contractAddress: CONTRACT,
          slot: 77n,
          blockNumber: 112n,
          blockHash: HASH,
          transactionHash: HASH,
          transactionIndex: 0,
          logIndex: 0,
          rawOp: rawAddSecond,
          decoded: decodeEfpListOp(rawAddSecond),
        },
      ],
      primaryListEvents: [],
      storageLocationEvents: [],
      scanStartedAt: NOW,
      scanCompletedAt: NOW,
      onRangeReplaced: async (affected) => {
        stats = await rebuildEfpProjectionAfterRangeReplacement({
          ...affected,
          chainId: 8453,
          appliedThroughBlock: 120n,
          appliedThroughBlockHash: HASH,
          projectionRevision: 2n,
          now: NOW,
        })
      },
    })

    expect(stats).toEqual({
      followers: 1,
      derived: 2,
      unchanged: 0,
      inserted: 1,
      deleted: 1,
      metadataUpdated: 1,
      countsRecomputed: 3,
    })
    const edges = await client.execute({
      sql: `SELECT followed_address, source_block_number FROM efp_effective_follows
            WHERE follower_address = ?1 ORDER BY followed_address`,
      args: [FOLLOWER],
    })
    expect(edges.rows).toEqual([
      { followed_address: NEW_TARGET, source_block_number: 110 },
      { followed_address: SECOND_TARGET, source_block_number: 112 },
    ])
    const metadataOnlyTarget = await client.execute({
      sql: "SELECT projection_revision FROM efp_follow_counts WHERE wallet_address = ?1",
      args: [NEW_TARGET],
    })
    expect(metadataOnlyTarget.rows).toEqual([{ projection_revision: 1 }])
    const watermark = await client.execute(
      `SELECT applied_through_block, projection_revision
       FROM efp_follow_projection_chain_watermarks WHERE chain_id = 8453`,
    )
    expect(watermark.rows).toEqual([{ applied_through_block: 120, projection_revision: 2 }])
  })
})
