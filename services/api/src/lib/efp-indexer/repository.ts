import type { Address, Hex } from "viem"

import type { Client, QueryResultRow, Transaction } from "../sql-client"
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

export type EfpAffectedListSlot = {
  chainId: number
  contractAddress: Address
  slot: bigint
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
  onRangeReplaced?: (input: {
    tx: Transaction
    affectedSlots: readonly EfpAffectedListSlot[]
    affectedAccounts: readonly Address[]
    affectedListIds: readonly bigint[]
  }) => Promise<void>
}): Promise<void> {
  await withTransaction(input.client, "write", async (tx) => {
    const oldSlots = await tx.execute({
      sql: `
        SELECT DISTINCT contract_address, slot
        FROM efp_list_ops
        WHERE chain_id = ?1 AND block_number BETWEEN ?2 AND ?3
      `,
      args: [input.chainId, Number(input.fromBlock), Number(input.throughBlock)],
    })
    const oldAccounts = await tx.execute({
      sql: `
        SELECT DISTINCT account_address
        FROM efp_primary_list_events
        WHERE chain_id = ?1 AND block_number BETWEEN ?2 AND ?3
      `,
      args: [input.chainId, Number(input.fromBlock), Number(input.throughBlock)],
    })
    const oldListIds = await tx.execute({
      sql: `
        SELECT DISTINCT list_id
        FROM efp_list_storage_location_events
        WHERE chain_id = ?1 AND block_number BETWEEN ?2 AND ?3
      `,
      args: [input.chainId, Number(input.fromBlock), Number(input.throughBlock)],
    })
    const affectedSlots = new Map<string, EfpAffectedListSlot>()
    for (const row of oldSlots.rows) {
      if (typeof row.contract_address !== "string" || typeof row.slot !== "string") continue
      const item = {
        chainId: input.chainId,
        contractAddress: row.contract_address.toLowerCase() as Address,
        listSlot: BigInt(row.slot),
      }
      affectedSlots.set(`${item.chainId}:${item.contractAddress}:${item.listSlot}`, {
        chainId: item.chainId,
        contractAddress: item.contractAddress,
        slot: item.listSlot,
      })
    }
    for (const item of input.listOps) {
      affectedSlots.set(`${item.chainId}:${item.contractAddress}:${item.slot}`, {
        chainId: item.chainId,
        contractAddress: item.contractAddress.toLowerCase() as Address,
        slot: item.slot,
      })
    }
    const affectedAccounts = new Set<Address>()
    for (const row of oldAccounts.rows) {
      if (typeof row.account_address === "string") {
        affectedAccounts.add(row.account_address.toLowerCase() as Address)
      }
    }
    for (const item of input.primaryListEvents) {
      affectedAccounts.add(item.accountAddress.toLowerCase() as Address)
    }
    const affectedListIds = new Set<bigint>()
    for (const row of oldListIds.rows) {
      if (typeof row.list_id === "string") affectedListIds.add(BigInt(row.list_id))
    }
    for (const item of input.storageLocationEvents) affectedListIds.add(item.listId)

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

    await input.onRangeReplaced?.({
      tx,
      affectedSlots: [...affectedSlots.values()],
      affectedAccounts: [...affectedAccounts],
      affectedListIds: [...affectedListIds],
    })
  })
}
