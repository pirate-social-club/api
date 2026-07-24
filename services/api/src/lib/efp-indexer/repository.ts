import type { Address, Hex } from "viem"

import type { Client, QueryResultRow } from "../sql-client"
import { withTransaction } from "../transactions"
import type { DecodedEfpListOp } from "./list-op"

export type EfpIndexerCursor = {
  chainId: number
  indexedThroughBlock: bigint
  indexedThroughBlockHash: Hex
  safeHeadBlock: bigint
}

export type PersistedEfpListOp = {
  chainId: number
  contractAddress: Address
  slot: bigint
  blockNumber: bigint
  blockHash: Hex
  transactionHash: Hex
  transactionIndex: number
  logIndex: number
  rawOp: Hex
  decoded: DecodedEfpListOp
}

export type PersistedPrimaryListEvent = {
  chainId: number
  contractAddress: Address
  accountAddress: Address
  rawValue: Hex
  listId: bigint | null
  blockNumber: bigint
  blockHash: Hex
  transactionHash: Hex
  transactionIndex: number
  logIndex: number
}

export type PersistedListStorageLocationEvent = {
  chainId: number
  registryAddress: Address
  listId: bigint
  rawStorageLocation: Hex
  storageChainId: number | null
  storageContractAddress: Address | null
  storageSlot: bigint | null
  blockNumber: bigint
  blockHash: Hex
  transactionHash: Hex
  transactionIndex: number
  logIndex: number
}

function integer(row: QueryResultRow | undefined, key: string): bigint | null {
  const value = row?.[key]
  if (typeof value === "bigint") return value
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value)
  if (typeof value === "string" && /^\d+$/u.test(value)) return BigInt(value)
  return null
}

export async function readEfpIndexerCursor(
  client: Client,
  chainId: number,
): Promise<EfpIndexerCursor | null> {
  const result = await client.execute({
    sql: `
      SELECT chain_id, indexed_through_block, indexed_through_block_hash, safe_head_block
      FROM efp_indexer_cursors
      WHERE chain_id = ?1
    `,
    args: [chainId],
  })
  const row = result.rows[0]
  const indexedThroughBlock = integer(row, "indexed_through_block")
  const safeHeadBlock = integer(row, "safe_head_block")
  const hash = row?.indexed_through_block_hash
  if (
    indexedThroughBlock == null
    || safeHeadBlock == null
    || typeof hash !== "string"
    || !/^0x[0-9a-f]{64}$/iu.test(hash)
  ) {
    return null
  }
  return {
    chainId,
    indexedThroughBlock,
    indexedThroughBlockHash: hash.toLowerCase() as Hex,
    safeHeadBlock,
  }
}

export async function replaceEfpIndexerRange(input: {
  client: Client
  chainId: number
  fromBlock: bigint
  throughBlock: bigint
  throughBlockHash: Hex
  safeHeadBlock: bigint
  listOps: readonly PersistedEfpListOp[]
  primaryListEvents: readonly PersistedPrimaryListEvent[]
  storageLocationEvents: readonly PersistedListStorageLocationEvent[]
  scanStartedAt: string
  scanCompletedAt: string
}): Promise<void> {
  await withTransaction(input.client, "write", async (tx) => {
    await tx.execute({
      sql: "DELETE FROM efp_list_ops WHERE chain_id = ?1 AND block_number BETWEEN ?2 AND ?3",
      args: [input.chainId, Number(input.fromBlock), Number(input.throughBlock)],
    })
    await tx.execute({
      sql: "DELETE FROM efp_primary_list_events WHERE chain_id = ?1 AND block_number BETWEEN ?2 AND ?3",
      args: [input.chainId, Number(input.fromBlock), Number(input.throughBlock)],
    })
    await tx.execute({
      sql: "DELETE FROM efp_list_storage_location_events WHERE chain_id = ?1 AND block_number BETWEEN ?2 AND ?3",
      args: [input.chainId, Number(input.fromBlock), Number(input.throughBlock)],
    })

    for (const item of input.listOps) {
      await tx.execute({
        sql: `
          INSERT INTO efp_list_ops (
            chain_id, contract_address, slot, block_number, block_hash,
            transaction_hash, transaction_index, log_index, raw_op,
            op_version, opcode, record_version, record_type, target_address,
            tag, created_at
          ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16
          )
        `,
        args: [
          item.chainId,
          item.contractAddress,
          item.slot.toString(),
          Number(item.blockNumber),
          item.blockHash,
          item.transactionHash,
          item.transactionIndex,
          item.logIndex,
          item.rawOp,
          item.decoded.opVersion,
          item.decoded.opcode,
          item.decoded.recordVersion,
          item.decoded.recordType,
          item.decoded.targetAddress,
          item.decoded.tag,
          input.scanCompletedAt,
        ],
      })
    }

    for (const item of input.primaryListEvents) {
      await tx.execute({
        sql: `
          INSERT INTO efp_primary_list_events (
            chain_id, contract_address, account_address, metadata_key,
            raw_value, list_id, block_number, block_hash, transaction_hash,
            transaction_index, log_index, created_at
          ) VALUES (
            ?1, ?2, ?3, 'primary-list', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11
          )
        `,
        args: [
          item.chainId,
          item.contractAddress,
          item.accountAddress,
          item.rawValue,
          item.listId?.toString() ?? null,
          Number(item.blockNumber),
          item.blockHash,
          item.transactionHash,
          item.transactionIndex,
          item.logIndex,
          input.scanCompletedAt,
        ],
      })
    }

    for (const item of input.storageLocationEvents) {
      await tx.execute({
        sql: `
          INSERT INTO efp_list_storage_location_events (
            chain_id, registry_address, list_id, raw_storage_location,
            storage_chain_id, storage_contract_address, storage_slot,
            block_number, block_hash, transaction_hash, transaction_index,
            log_index, created_at
          ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13
          )
        `,
        args: [
          item.chainId,
          item.registryAddress,
          item.listId.toString(),
          item.rawStorageLocation,
          item.storageChainId,
          item.storageContractAddress,
          item.storageSlot?.toString() ?? null,
          Number(item.blockNumber),
          item.blockHash,
          item.transactionHash,
          item.transactionIndex,
          item.logIndex,
          input.scanCompletedAt,
        ],
      })
    }

    await tx.execute({
      sql: `
        INSERT INTO efp_indexer_cursors (
          chain_id, indexed_through_block, indexed_through_block_hash,
          safe_head_block, last_scan_started_at, last_scan_completed_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
        ON CONFLICT(chain_id) DO UPDATE SET
          indexed_through_block = excluded.indexed_through_block,
          indexed_through_block_hash = excluded.indexed_through_block_hash,
          safe_head_block = excluded.safe_head_block,
          last_scan_started_at = excluded.last_scan_started_at,
          last_scan_completed_at = excluded.last_scan_completed_at,
          updated_at = excluded.updated_at
      `,
      args: [
        input.chainId,
        Number(input.throughBlock),
        input.throughBlockHash,
        Number(input.safeHeadBlock),
        input.scanStartedAt,
        input.scanCompletedAt,
      ],
    })
  })
}
