import { afterEach, expect, test } from "bun:test"
import { encodePacked, type Address, type Hex } from "viem"

import { createControlPlaneTestClient } from "../tests/helpers"
import { EFP_INDEXER_CHAINS } from "../src/lib/efp-indexer/scanner"
import { finalizeDeferredProjection } from "./backfill-efp-index"

const CONTRACT = "0x41aa48ef3c0446b46a5b1cc6337ff3d3716e2a33" as Address
const FOLLOWER_A = "0x1111111111111111111111111111111111111111" as Address
const FOLLOWER_B = "0x2222222222222222222222222222222222222222" as Address
const TARGET_A = "0x3333333333333333333333333333333333333333" as Address
const TARGET_B = "0x4444444444444444444444444444444444444444" as Address
const FOLLOWER_C = "0x5555555555555555555555555555555555555555" as Address
const TARGET_C = "0x6666666666666666666666666666666666666666" as Address
const HASH = `0x${"55".repeat(32)}` as Hex
const NOW = "2026-07-27T00:00:00.000Z"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())))

test("deferred projection finalization commits resumable follower batches before watermarking", async () => {
  const database = await createControlPlaneTestClient()
  cleanups.push(database.cleanup)
  const client = database.client
  await client.batch([
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
      'effective-graph', 'stale', 0, NULL, ?1, NULL, ?1, NULL, NULL)`, args: [NOW] },
    { sql: `CREATE TABLE efp_follow_projection_expected_chains (
      chain_id INTEGER PRIMARY KEY, confirmation_buffer_blocks INTEGER NOT NULL,
      enabled INTEGER NOT NULL, updated_at TEXT NOT NULL)` },
    { sql: `INSERT INTO efp_follow_projection_expected_chains VALUES (8453, 64, 1, ?1)`, args: [NOW] },
    { sql: `CREATE TABLE efp_follow_projection_chain_watermarks (
      chain_id INTEGER PRIMARY KEY, applied_through_block INTEGER NOT NULL,
      applied_through_block_hash TEXT NOT NULL, projection_revision INTEGER NOT NULL,
      last_successful_at TEXT NOT NULL, updated_at TEXT NOT NULL)` },
    { sql: `CREATE TABLE efp_indexer_cursors (
      chain_id INTEGER PRIMARY KEY, indexed_through_block INTEGER NOT NULL,
      indexed_through_block_hash TEXT NOT NULL, safe_head_block INTEGER NOT NULL,
      last_scan_started_at TEXT, last_scan_completed_at TEXT, updated_at TEXT NOT NULL)` },
    { sql: `INSERT INTO efp_indexer_cursors VALUES (
      8453, 100, ?1, 100, ?2, ?2, ?2)`, args: [HASH, new Date().toISOString()] },
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
    { sql: `CREATE TABLE efp_follow_projection_backfills (
      chain_id INTEGER PRIMARY KEY, target_block INTEGER NOT NULL,
      target_block_hash TEXT NOT NULL, projection_revision INTEGER NOT NULL,
      status TEXT NOT NULL, total_followers INTEGER NOT NULL,
      processed_followers INTEGER NOT NULL, last_error TEXT,
      started_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT)` },
    { sql: `CREATE TABLE efp_follow_projection_backfill_followers (
      chain_id INTEGER NOT NULL, target_block INTEGER NOT NULL,
      follower_address TEXT NOT NULL, processed_at TEXT,
      PRIMARY KEY (chain_id, target_block, follower_address))` },
  ], "write")

  for (const [index, follower, target] of [
    [1, FOLLOWER_A, TARGET_A],
    [2, FOLLOWER_B, TARGET_B],
    [3, FOLLOWER_C, TARGET_C],
  ] as const) {
    const rawOp = encodePacked(
      ["uint8", "uint8", "uint8", "uint8", "address"],
      [1, 1, 1, 1, target],
    )
    await client.batch([
      {
        sql: `INSERT INTO efp_primary_list_events VALUES (
          8453, ?1, ?2, 'primary-list', '0x', ?3, 10, ?4, ?4, 0, ?5, ?6)`,
        args: [CONTRACT, follower, String(index), HASH, index, NOW],
      },
      {
        sql: `INSERT INTO efp_list_storage_location_events VALUES (
          8453, ?1, ?2, '0x', 8453, ?1, ?3, 10, ?4, ?4, 0, ?5, ?6)`,
        args: [CONTRACT, String(index), String(index), HASH, index, NOW],
      },
      {
        sql: `INSERT INTO efp_list_ops VALUES (
          8453, ?1, ?2, 20, ?3, ?3, 0, ?4, ?5, 1, 1, 1, 1, ?6, NULL, ?7)`,
        args: [CONTRACT, String(index), HASH, index, rawOp, target, NOW],
      },
    ], "write")
  }

  const firstRunComplete = await finalizeDeferredProjection({
    client: client as never,
    config: EFP_INDEXER_CHAINS.base,
    followerBatchSize: 2,
    maxFollowerBatches: 1,
  })
  expect(firstRunComplete).toBeFalse()
  expect(Number((await client.execute(
    "SELECT processed_followers FROM efp_follow_projection_backfills WHERE chain_id = 8453",
  )).rows[0]?.processed_followers)).toBe(2)
  expect((await client.execute(
    "SELECT chain_id FROM efp_follow_projection_chain_watermarks WHERE chain_id = 8453",
  )).rows).toHaveLength(0)
  expect((await client.execute("SELECT * FROM efp_effective_follows")).rows).toHaveLength(2)

  const resumedComplete = await finalizeDeferredProjection({
    client: client as never,
    config: EFP_INDEXER_CHAINS.base,
    followerBatchSize: 1,
  })
  expect(resumedComplete).toBeTrue()
  expect(Number((await client.execute(
    "SELECT processed_followers FROM efp_follow_projection_backfills WHERE chain_id = 8453",
  )).rows[0]?.processed_followers)).toBe(3)
  expect((await client.execute(
    "SELECT applied_through_block FROM efp_follow_projection_chain_watermarks WHERE chain_id = 8453",
  )).rows[0]?.applied_through_block).toBe(100)
  expect((await client.execute("SELECT * FROM efp_effective_follows")).rows).toHaveLength(3)
})
