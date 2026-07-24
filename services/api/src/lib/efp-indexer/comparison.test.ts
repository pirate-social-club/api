import { afterEach, describe, expect, test } from "bun:test"
import { encodePacked, type Address } from "viem"

import { createControlPlaneTestClient } from "../../../tests/helpers"
import { deriveIndexedEfpGraph } from "./comparison"
import {
  EFP_BASE_ACCOUNT_METADATA,
  EFP_BASE_CHAIN_ID,
  EFP_BASE_LIST_RECORDS,
  EFP_BASE_LIST_REGISTRY,
} from "./scanner"

const ACCOUNT = "0xf8526fa519ba7dff36e50b1003b74fafc8dde8fc" as Address
const TARGET = "0xd69e335d0b803f7dac27c130db90f5808a30b559" as Address
const HASH = `0x${"11".repeat(32)}`
const TX = `0x${"22".repeat(32)}`

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

describe("deriveIndexedEfpGraph", () => {
  test("replays only the latest authoritative primary list", async () => {
    const database = await createControlPlaneTestClient({ includeAllMigrations: true })
    cleanups.push(database.cleanup)
    const now = "2026-07-25T00:00:00.000Z"
    await database.client.batch([
      {
        sql: `
          INSERT INTO efp_indexer_cursors (
            chain_id, indexed_through_block, indexed_through_block_hash,
            safe_head_block, last_scan_started_at, last_scan_completed_at, updated_at
          ) VALUES (?1, 100, ?2, 110, ?3, ?3, ?3)
        `,
        args: [EFP_BASE_CHAIN_ID, HASH, now],
      },
      {
        sql: `
          INSERT INTO efp_primary_list_events (
            chain_id, contract_address, account_address, metadata_key, raw_value,
            list_id, block_number, block_hash, transaction_hash,
            transaction_index, log_index, created_at
          ) VALUES (?1, ?2, ?3, 'primary-list', '0x01', '7', 10, ?4, ?5, 0, 0, ?6)
        `,
        args: [EFP_BASE_CHAIN_ID, EFP_BASE_ACCOUNT_METADATA, ACCOUNT, HASH, TX, now],
      },
      {
        sql: `
          INSERT INTO efp_list_storage_location_events (
            chain_id, registry_address, list_id, raw_storage_location,
            storage_chain_id, storage_contract_address, storage_slot,
            block_number, block_hash, transaction_hash, transaction_index,
            log_index, created_at
          ) VALUES (?1, ?2, '7', '0x01', ?1, ?3, '42', 11, ?4, ?5, 0, 1, ?6)
        `,
        args: [EFP_BASE_CHAIN_ID, EFP_BASE_LIST_REGISTRY, EFP_BASE_LIST_RECORDS, HASH, TX, now],
      },
      {
        sql: `
          INSERT INTO efp_list_ops (
            chain_id, contract_address, slot, block_number, block_hash,
            transaction_hash, transaction_index, log_index, raw_op, created_at
          ) VALUES (?1, ?2, '42', 12, ?3, ?4, 0, 2, ?5, ?6)
        `,
        args: [
          EFP_BASE_CHAIN_ID,
          EFP_BASE_LIST_RECORDS,
          HASH,
          TX,
          encodePacked(
            ["uint8", "uint8", "uint8", "uint8", "address"],
            [1, 1, 1, 1, TARGET],
          ),
          now,
        ],
      },
    ])

    const graph = await deriveIndexedEfpGraph(database.client)
    expect(graph.indexedThroughBlock).toBe("100")
    expect(graph.safeHeadBlock).toBe("110")
    expect([...graph.followingByAddress.get(ACCOUNT) ?? []]).toEqual([TARGET])
    expect(graph.followerCountByAddress.get(TARGET)).toBe(1)
  })
})
