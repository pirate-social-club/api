import { afterEach, describe, expect, test } from "bun:test"
import { encodePacked, type Address, type Hex } from "viem"

import { createControlPlaneTestClient } from "../../../tests/helpers"
import {
  EFP_BASE_ACCOUNT_METADATA,
  EFP_BASE_LIST_REGISTRY,
  EFP_BASE_LIST_RECORDS,
  EFP_BASE_START_BLOCK,
  EFP_INDEXER_CHAINS,
  EFP_OPTIMISM_CHAIN_ID,
  EFP_OPTIMISM_LIST_RECORDS,
  EFP_OPTIMISM_START_BLOCK,
  scanEfpBaseOnce,
  scanEfpChainOnce,
} from "./scanner"

const TARGET = "0xd69e335d0b803f7dac27c130db90f5808a30b559" as Address
const ACCOUNT = "0xf8526fa519ba7dff36e50b1003b74fafc8dde8fc" as Address
const BLOCK_HASH = `0x${"11".repeat(32)}` as Hex
const TX_HASH = `0x${"22".repeat(32)}` as Hex

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

async function ensureProjectionSchema(client: Awaited<ReturnType<typeof createControlPlaneTestClient>>["client"]) {
  await client.batch([
    { sql: `CREATE TABLE IF NOT EXISTS efp_effective_follows (
      follower_address TEXT NOT NULL, followed_address TEXT NOT NULL,
      list_chain_id INTEGER NOT NULL, list_contract_address TEXT NOT NULL,
      list_slot TEXT NOT NULL, source_block_number INTEGER NOT NULL,
      source_transaction_hash TEXT NOT NULL, source_transaction_index INTEGER NOT NULL,
      source_log_index INTEGER NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (follower_address, followed_address))` },
    { sql: `CREATE TABLE IF NOT EXISTS efp_follow_counts (
      wallet_address TEXT PRIMARY KEY, follower_count INTEGER NOT NULL,
      following_count INTEGER NOT NULL, projection_revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL)` },
    { sql: `CREATE TABLE IF NOT EXISTS efp_follow_projection_state (
      projection_key TEXT PRIMARY KEY, status TEXT NOT NULL,
      projection_revision INTEGER NOT NULL, last_successful_at TEXT,
      status_changed_at TEXT NOT NULL, last_error TEXT, updated_at TEXT NOT NULL,
      last_reconciled_at TEXT, last_reconciliation_error TEXT)` },
    { sql: `INSERT OR IGNORE INTO efp_follow_projection_state VALUES (
      'effective-graph', 'initializing', 0, NULL, '2026-07-25T00:00:00.000Z',
      NULL, '2026-07-25T00:00:00.000Z', NULL, NULL)` },
    { sql: `CREATE TABLE IF NOT EXISTS efp_follow_projection_expected_chains (
      chain_id INTEGER PRIMARY KEY, confirmation_buffer_blocks INTEGER NOT NULL,
      enabled INTEGER NOT NULL, updated_at TEXT NOT NULL)` },
    { sql: `CREATE TABLE IF NOT EXISTS efp_follow_projection_chain_watermarks (
      chain_id INTEGER PRIMARY KEY, applied_through_block INTEGER NOT NULL,
      applied_through_block_hash TEXT NOT NULL, projection_revision INTEGER NOT NULL,
      last_successful_at TEXT NOT NULL, updated_at TEXT NOT NULL)` },
  ], "write")
}

describe("scanEfpBaseOnce", () => {
  test("persists confirmed raw ops, primary-list pointers, and cursor atomically", async () => {
    const database = await createControlPlaneTestClient({ includeAllMigrations: true })
    cleanups.push(database.cleanup)
    await ensureProjectionSchema(database.client)
    const blockNumber = EFP_BASE_START_BLOCK + 10n
    const rawOp = encodePacked(
      ["uint8", "uint8", "uint8", "uint8", "address"],
      [1, 1, 1, 1, TARGET],
    )
    const storageLocation = encodePacked(
      ["uint8", "uint8", "uint256", "address", "uint256"],
      [1, 1, 8453n, EFP_BASE_LIST_RECORDS, 42n],
    )
    const reader = {
      getBlockNumber: async () => EFP_BASE_START_BLOCK + 1_000n,
      getBlock: async () => ({ hash: BLOCK_HASH }),
      getLogs: async ({ address }: { address: Address }) => {
        if (address === EFP_BASE_LIST_RECORDS) {
          return [{
            args: { op: rawOp, slot: 42n },
            blockHash: BLOCK_HASH,
            blockNumber,
            logIndex: 3,
            transactionHash: TX_HASH,
            transactionIndex: 2,
          }]
        }
        if (address === EFP_BASE_ACCOUNT_METADATA) {
          return [{
            args: {
              addr: ACCOUNT,
              key: "primary-list",
              value: `0x${"0".repeat(63)}7`,
            },
            blockHash: BLOCK_HASH,
            blockNumber,
            logIndex: 4,
            transactionHash: TX_HASH,
            transactionIndex: 2,
          }]
        }
        if (address === EFP_BASE_LIST_REGISTRY) {
          return [{
            args: { tokenId: 7n, listStorageLocation: storageLocation },
            blockHash: BLOCK_HASH,
            blockNumber,
            logIndex: 5,
            transactionHash: TX_HASH,
            transactionIndex: 2,
          }]
        }
        return []
      },
    }

    const summary = await scanEfpBaseOnce({
      client: database.client,
      rpcUrl: "https://base.example.test",
      reader: reader as never,
      now: () => new Date("2026-07-25T00:00:00.000Z"),
    })

    expect(summary).toMatchObject({
      status: "indexed",
      listOpCount: 1,
      malformedListOpCount: 0,
      unsupportedListOpCount: 0,
      primaryListEventCount: 1,
      storageLocationEventCount: 1,
    })
    const ops = await database.client.execute(
      "SELECT slot, raw_op, target_address FROM efp_list_ops",
    )
    expect(ops.rows).toEqual([expect.objectContaining({
      slot: "42",
      raw_op: rawOp,
      target_address: TARGET,
    })])
    const pointers = await database.client.execute(
      "SELECT account_address, list_id FROM efp_primary_list_events",
    )
    expect(pointers.rows).toEqual([expect.objectContaining({
      account_address: ACCOUNT,
      list_id: "7",
    })])
    const storage = await database.client.execute(
      "SELECT list_id, storage_chain_id, storage_contract_address, storage_slot FROM efp_list_storage_location_events",
    )
    expect(storage.rows).toEqual([expect.objectContaining({
      list_id: "7",
      storage_chain_id: 8453,
      storage_contract_address: EFP_BASE_LIST_RECORDS,
      storage_slot: "42",
    })])
    const cursors = await database.client.execute(
      "SELECT indexed_through_block, safe_head_block FROM efp_indexer_cursors",
    )
    expect(cursors.rows).toHaveLength(1)
    expect(Number(cursors.rows[0]?.indexed_through_block)).toBe(
      Number(EFP_BASE_START_BLOCK + 936n),
    )
    expect(Number(cursors.rows[0]?.safe_head_block)).toBe(
      Number(EFP_BASE_START_BLOCK + 936n),
    )
  })

  test("indexes list records on a storage-only chain without Base control events", async () => {
    expect(EFP_INDEXER_CHAINS.optimism.rpcLogRange).toBe(100_000n)
    expect(EFP_INDEXER_CHAINS.base.rpcLogRange).toBeUndefined()
    expect(EFP_INDEXER_CHAINS.ethereum.rpcLogRange).toBeUndefined()
    const database = await createControlPlaneTestClient({ includeAllMigrations: true })
    cleanups.push(database.cleanup)
    await ensureProjectionSchema(database.client)
    const rawOp = encodePacked(
      ["uint8", "uint8", "uint8", "uint8", "address"],
      [1, 1, 1, 1, TARGET],
    )
    const reader = {
      getBlockNumber: async () => EFP_OPTIMISM_START_BLOCK + 100n,
      getBlock: async () => ({ hash: BLOCK_HASH }),
      getLogs: async ({ address }: { address: Address }) => {
        expect(address).toBe(EFP_OPTIMISM_LIST_RECORDS)
        return [{
          args: { op: rawOp, slot: 77n },
          blockHash: BLOCK_HASH,
          blockNumber: EFP_OPTIMISM_START_BLOCK + 10n,
          logIndex: 3,
          transactionHash: TX_HASH,
          transactionIndex: 2,
        }]
      },
    }

    const summary = await scanEfpChainOnce({
      client: database.client,
      rpcUrl: "https://optimism.example.test",
      config: EFP_INDEXER_CHAINS.optimism,
      reader: reader as never,
      now: () => new Date("2026-07-25T00:00:00.000Z"),
      deferProjection: true,
    })

    expect(summary).toMatchObject({
      chainId: EFP_OPTIMISM_CHAIN_ID,
      listOpCount: 1,
      primaryListEventCount: 0,
      storageLocationEventCount: 0,
    })
    const ops = await database.client.execute(
      "SELECT chain_id, contract_address, slot FROM efp_list_ops",
    )
    expect(ops.rows).toEqual([expect.objectContaining({
      chain_id: EFP_OPTIMISM_CHAIN_ID,
      contract_address: EFP_OPTIMISM_LIST_RECORDS,
      slot: "77",
    })])
    const watermarks = await database.client.execute(
      "SELECT chain_id FROM efp_follow_projection_chain_watermarks WHERE chain_id = 10",
    )
    expect(watermarks.rows).toHaveLength(0)
  })
})
