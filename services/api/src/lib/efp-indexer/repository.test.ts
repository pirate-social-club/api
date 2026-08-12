import { afterEach, describe, expect, test } from "bun:test"
import type { Address, Hex } from "viem"

import { createControlPlaneTestClient } from "../../../tests/helpers"
import type { Client, Transaction } from "../sql-client"
import { decodeEfpListOp } from "./list-op"
import { rebuildEfpProjectionAfterRangeReplacement } from "./materializer"
import {
  replaceEfpIndexerRange,
  type EfpAffectedListSlot,
  type PersistedEfpListOp,
  type PersistedListStorageLocationEvent,
  type PersistedPrimaryListEvent,
} from "./repository"

const CHAIN_ID = 8453
const CONTRACT = "0x41aa48ef3c0446b46a5b1cc6337ff3d3716e2a33" as Address
const METADATA_CONTRACT = "0x5289fe5dabc021d02fddf23d4a4df96f4e0f17ef" as Address
const REGISTRY = "0x0e688f5dca4a0a4729946acbc44c792341714e08" as Address
const ACCOUNT = "0xf8526fa519ba7dff36e50b1003b74fafc8dde8fc" as Address
const TARGET = "0xd69e335d0b803f7dac27c130db90f5808a30b559" as Address
const HASH = `0x${"44".repeat(32)}` as Hex
const TX_OP = `0x${"aa".repeat(32)}` as Hex
const TX_META = `0x${"bb".repeat(32)}` as Hex
const TX_STORAGE = `0x${"cc".repeat(32)}` as Hex
const TX_REORG = `0x${"dd".repeat(32)}` as Hex
const T0 = "2026-07-26T00:00:00.000Z"
const T1 = "2026-07-26T00:01:00.000Z"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())))

async function setup(options?: { withProjection?: boolean }) {
  const database = await createControlPlaneTestClient()
  cleanups.push(database.cleanup)
  await database.client.batch([
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
  if (options?.withProjection) {
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
        'effective-graph', 'initializing', 0, NULL, ?1, NULL, ?1, NULL, NULL)`, args: [T0] },
      { sql: `CREATE TABLE efp_follow_projection_expected_chains (
        chain_id INTEGER PRIMARY KEY, confirmation_buffer_blocks INTEGER NOT NULL,
        enabled INTEGER NOT NULL, updated_at TEXT NOT NULL)` },
      { sql: `CREATE TABLE efp_follow_projection_chain_watermarks (
        chain_id INTEGER PRIMARY KEY, applied_through_block INTEGER NOT NULL,
        applied_through_block_hash TEXT NOT NULL, projection_revision INTEGER NOT NULL,
        last_successful_at TEXT NOT NULL, updated_at TEXT NOT NULL)` },
    ], "write")
  }
  return database.client
}

function listOp(overrides?: Partial<PersistedEfpListOp>): PersistedEfpListOp {
  const rawOp = `0x01010101${TARGET.slice(2)}`.toLowerCase() as Hex
  return {
    chainId: CHAIN_ID,
    contractAddress: CONTRACT,
    slot: 77n,
    blockNumber: 100n,
    blockHash: HASH,
    transactionHash: TX_OP,
    transactionIndex: 0,
    logIndex: 0,
    rawOp,
    decoded: decodeEfpListOp(rawOp),
    ...overrides,
  }
}

function primaryListEvent(
  overrides?: Partial<PersistedPrimaryListEvent>,
): PersistedPrimaryListEvent {
  return {
    chainId: CHAIN_ID,
    contractAddress: METADATA_CONTRACT,
    accountAddress: ACCOUNT,
    rawValue: "0x07" as Hex,
    listId: 7n,
    blockNumber: 100n,
    blockHash: HASH,
    transactionHash: TX_META,
    transactionIndex: 0,
    logIndex: 0,
    ...overrides,
  }
}

function storageLocationEvent(
  overrides?: Partial<PersistedListStorageLocationEvent>,
): PersistedListStorageLocationEvent {
  return {
    chainId: CHAIN_ID,
    registryAddress: REGISTRY,
    listId: 7n,
    rawStorageLocation: "0x0101" as Hex,
    storageChainId: CHAIN_ID,
    storageContractAddress: CONTRACT,
    storageSlot: 77n,
    blockNumber: 100n,
    blockHash: HASH,
    transactionHash: TX_STORAGE,
    transactionIndex: 0,
    logIndex: 0,
    ...overrides,
  }
}

type CapturedAffected = {
  affectedSlots: readonly EfpAffectedListSlot[]
  affectedAccounts: readonly Address[]
  affectedListIds: readonly bigint[]
}

type OnRangeReplaced = (input: CapturedAffected & { tx: Transaction }) => Promise<void>

function rangeInput(events?: {
  fromBlock?: bigint
  throughBlock?: bigint
  safeHeadBlock?: bigint
  listOps?: readonly PersistedEfpListOp[]
  primaryListEvents?: readonly PersistedPrimaryListEvent[]
  storageLocationEvents?: readonly PersistedListStorageLocationEvent[]
  scanCompletedAt?: string
  onRangeReplaced?: OnRangeReplaced
}) {
  return {
    chainId: CHAIN_ID,
    fromBlock: events?.fromBlock ?? 100n,
    throughBlock: events?.throughBlock ?? 120n,
    throughBlockHash: HASH,
    safeHeadBlock: events?.safeHeadBlock ?? events?.throughBlock ?? 120n,
    listOps: events?.listOps ?? [listOp()],
    primaryListEvents: events?.primaryListEvents ?? [primaryListEvent()],
    storageLocationEvents: events?.storageLocationEvents ?? [storageLocationEvent()],
    scanStartedAt: events?.scanCompletedAt ?? T0,
    scanCompletedAt: events?.scanCompletedAt ?? T0,
    onRangeReplaced: events?.onRangeReplaced,
  }
}

function captureAffected(store: { current: CapturedAffected | null }): OnRangeReplaced {
  return async ({ affectedSlots, affectedAccounts, affectedListIds }) => {
    store.current = { affectedSlots, affectedAccounts, affectedListIds }
  }
}

function spyRawTableDml(client: Client) {
  const dml: string[] = []
  const record = (statement: string | { sql: string }) => {
    const sql = typeof statement === "string" ? statement : statement.sql
    if (
      /\b(?:INSERT INTO|DELETE FROM|UPDATE)\s+efp_(?:list_ops|primary_list_events|list_storage_location_events)\b/u
        .test(sql)
    ) {
      dml.push(sql)
    }
  }
  const wrapped: Client = {
    execute: async (statement) => {
      record(statement)
      return await client.execute(statement)
    },
    batch: async (statements, mode) => await client.batch(statements, mode),
    transaction: async (mode) => {
      const tx = await client.transaction(mode)
      return {
        execute: async (statement) => {
          record(statement)
          return await tx.execute(statement)
        },
        batch: async (statements, batchMode) => await tx.batch(statements, batchMode),
        commit: async () => await tx.commit(),
        rollback: async () => await tx.rollback(),
        close: () => tx.close(),
      }
    },
  }
  return { client: wrapped, dml }
}

async function rawCreatedAt(client: Client) {
  const timestamps: Record<string, unknown[]> = {}
  for (const table of [
    "efp_list_ops",
    "efp_primary_list_events",
    "efp_list_storage_location_events",
  ]) {
    const rows = await client.execute(`SELECT created_at FROM ${table} ORDER BY created_at`)
    timestamps[table] = rows.rows.map((row) => row.created_at)
  }
  return timestamps
}

describe("replaceEfpIndexerRange differential replay", () => {
  test("identical replay produces zero raw-table DML and does not restamp created_at", async () => {
    const client = await setup()
    const first = await replaceEfpIndexerRange({ client, ...rangeInput() })
    expect(first).toEqual({
      listOps: { existing: 0, inserted: 1, deleted: 0, changed: 0 },
      primaryListEvents: { existing: 0, inserted: 1, deleted: 0, changed: 0 },
      storageLocationEvents: { existing: 0, inserted: 1, deleted: 0, changed: 0 },
      affectedSlotCount: 1,
      affectedAccountCount: 1,
      affectedListIdCount: 1,
    })
    const createdAtBefore = await rawCreatedAt(client)

    const spy = spyRawTableDml(client)
    const affected = { current: null as CapturedAffected | null }
    const second = await replaceEfpIndexerRange({
      client: spy.client,
      ...rangeInput({
        scanCompletedAt: T1,
        onRangeReplaced: captureAffected(affected),
      }),
    })

    expect(second).toEqual({
      listOps: { existing: 1, inserted: 0, deleted: 0, changed: 0 },
      primaryListEvents: { existing: 1, inserted: 0, deleted: 0, changed: 0 },
      storageLocationEvents: { existing: 1, inserted: 0, deleted: 0, changed: 0 },
      affectedSlotCount: 0,
      affectedAccountCount: 0,
      affectedListIdCount: 0,
    })
    expect(spy.dml).toEqual([])
    expect(await rawCreatedAt(client)).toEqual(createdAtBefore)
    expect(affected.current).toEqual({
      affectedSlots: [],
      affectedAccounts: [],
      affectedListIds: [],
    })
  })

  test("empty replacement still advances the cursor and fires the callback", async () => {
    const client = await setup()
    let calls = 0
    const summary = await replaceEfpIndexerRange({
      client,
      ...rangeInput({
        listOps: [],
        primaryListEvents: [],
        storageLocationEvents: [],
        onRangeReplaced: async () => {
          calls += 1
        },
      }),
    })

    expect(summary).toEqual({
      listOps: { existing: 0, inserted: 0, deleted: 0, changed: 0 },
      primaryListEvents: { existing: 0, inserted: 0, deleted: 0, changed: 0 },
      storageLocationEvents: { existing: 0, inserted: 0, deleted: 0, changed: 0 },
      affectedSlotCount: 0,
      affectedAccountCount: 0,
      affectedListIdCount: 0,
    })
    expect(calls).toBe(1)
    const cursors = await client.execute(
      "SELECT indexed_through_block, safe_head_block FROM efp_indexer_cursors",
    )
    expect(cursors.rows).toHaveLength(1)
    expect(cursors.rows[0]).toEqual({ indexed_through_block: 120, safe_head_block: 120 })
  })

  test("removed rows are deleted by primary key and drive the affected identities", async () => {
    const client = await setup()
    await replaceEfpIndexerRange({ client, ...rangeInput() })
    const affected = { current: null as CapturedAffected | null }
    const summary = await replaceEfpIndexerRange({
      client,
      ...rangeInput({
        listOps: [],
        primaryListEvents: [],
        storageLocationEvents: [],
        scanCompletedAt: T1,
        onRangeReplaced: captureAffected(affected),
      }),
    })

    expect(summary).toEqual({
      listOps: { existing: 1, inserted: 0, deleted: 1, changed: 0 },
      primaryListEvents: { existing: 1, inserted: 0, deleted: 1, changed: 0 },
      storageLocationEvents: { existing: 1, inserted: 0, deleted: 1, changed: 0 },
      affectedSlotCount: 1,
      affectedAccountCount: 1,
      affectedListIdCount: 1,
    })
    expect((await client.execute("SELECT * FROM efp_list_ops")).rows).toHaveLength(0)
    expect((await client.execute("SELECT * FROM efp_primary_list_events")).rows).toHaveLength(0)
    expect(
      (await client.execute("SELECT * FROM efp_list_storage_location_events")).rows,
    ).toHaveLength(0)
    expect(affected.current).toEqual({
      affectedSlots: [{ chainId: CHAIN_ID, contractAddress: CONTRACT, slot: 77n }],
      affectedAccounts: [ACCOUNT],
      affectedListIds: [7n],
    })
  })

  test("changed rows are re-inserted with the new payload and report both identities", async () => {
    const client = await setup()
    await replaceEfpIndexerRange({ client, ...rangeInput() })
    const affected = { current: null as CapturedAffected | null }
    const summary = await replaceEfpIndexerRange({
      client,
      ...rangeInput({
        listOps: [listOp({ slot: 78n })],
        scanCompletedAt: T1,
        onRangeReplaced: captureAffected(affected),
      }),
    })

    expect(summary).toEqual({
      listOps: { existing: 1, inserted: 1, deleted: 1, changed: 1 },
      primaryListEvents: { existing: 1, inserted: 0, deleted: 0, changed: 0 },
      storageLocationEvents: { existing: 1, inserted: 0, deleted: 0, changed: 0 },
      affectedSlotCount: 2,
      affectedAccountCount: 0,
      affectedListIdCount: 0,
    })
    const rows = await client.execute("SELECT slot, created_at FROM efp_list_ops")
    expect(rows.rows).toEqual([{ slot: "78", created_at: T1 }])
    expect(affected.current).toEqual({
      affectedSlots: [
        { chainId: CHAIN_ID, contractAddress: CONTRACT, slot: 77n },
        { chainId: CHAIN_ID, contractAddress: CONTRACT, slot: 78n },
      ],
      affectedAccounts: [],
      affectedListIds: [],
    })
  })

  test("callback failure rolls back raw rows, cursor, edges, and counts atomically", async () => {
    const client = await setup({ withProjection: true })
    await replaceEfpIndexerRange({
      client,
      ...rangeInput({
        onRangeReplaced: async (affected) => {
          await rebuildEfpProjectionAfterRangeReplacement({
            ...affected,
            chainId: CHAIN_ID,
            appliedThroughBlock: 120n,
            appliedThroughBlockHash: HASH,
            projectionRevision: 1n,
            now: T0,
          })
        },
      }),
    })
    expect((await client.execute("SELECT * FROM efp_effective_follows")).rows).toHaveLength(1)

    const snapshot = async () => ({
      cursors: (await client.execute("SELECT * FROM efp_indexer_cursors")).rows,
      listOps: (await client.execute("SELECT * FROM efp_list_ops ORDER BY log_index")).rows,
      primaryListEvents: (await client.execute("SELECT * FROM efp_primary_list_events")).rows,
      storageLocationEvents:
        (await client.execute("SELECT * FROM efp_list_storage_location_events")).rows,
      edges: (await client.execute("SELECT * FROM efp_effective_follows")).rows,
      counts: (await client.execute(
        "SELECT * FROM efp_follow_counts ORDER BY wallet_address",
      )).rows,
    })
    const before = await snapshot()

    await expect(replaceEfpIndexerRange({
      client,
      ...rangeInput({
        throughBlock: 130n,
        listOps: [
          listOp(),
          listOp({ slot: 88n, blockNumber: 125n, transactionHash: TX_REORG, logIndex: 1 }),
        ],
        scanCompletedAt: T1,
        onRangeReplaced: async () => {
          throw new Error("projection exploded")
        },
      }),
    })).rejects.toThrow("projection exploded")

    expect(await snapshot()).toEqual(before)
  })
})
