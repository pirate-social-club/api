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

describe("scanEfpBaseOnce", () => {
  test("persists confirmed raw ops, primary-list pointers, and cursor atomically", async () => {
    const database = await createControlPlaneTestClient({ includeAllMigrations: true })
    cleanups.push(database.cleanup)
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
    const database = await createControlPlaneTestClient({ includeAllMigrations: true })
    cleanups.push(database.cleanup)
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
  })
})
