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

const EFP_EVENT_INSERT_BATCH_SIZE = 100
const EFP_LIST_OP_INSERT_COLUMN_COUNT = 16
const EFP_PRIMARY_LIST_INSERT_COLUMN_COUNT = 12
const EFP_STORAGE_LOCATION_INSERT_COLUMN_COUNT = 13

// Every persisted column except created_at, which is restamped on each insert
// and therefore excluded from replay comparison.
const EFP_LIST_OP_DIFF_COLUMNS = [
  "chain_id", "contract_address", "slot", "block_number", "block_hash",
  "transaction_hash", "transaction_index", "log_index", "raw_op",
  "op_version", "opcode", "record_version", "record_type", "target_address",
  "tag",
] as const
const EFP_PRIMARY_LIST_DIFF_COLUMNS = [
  "chain_id", "contract_address", "account_address", "metadata_key",
  "raw_value", "list_id", "block_number", "block_hash", "transaction_hash",
  "transaction_index", "log_index",
] as const
const EFP_STORAGE_LOCATION_DIFF_COLUMNS = [
  "chain_id", "registry_address", "list_id", "raw_storage_location",
  "storage_chain_id", "storage_contract_address", "storage_slot",
  "block_number", "block_hash", "transaction_hash", "transaction_index",
  "log_index",
] as const

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

export type EfpRangeTableDiff = {
  existing: number
  // Changed rows are deleted and re-inserted, so they count in both totals.
  inserted: number
  deleted: number
  changed: number
}

export type EfpRangeReplacementSummary = {
  listOps: EfpRangeTableDiff
  primaryListEvents: EfpRangeTableDiff
  storageLocationEvents: EfpRangeTableDiff
  affectedSlotCount: number
  affectedAccountCount: number
  affectedListIdCount: number
}

type EfpRowDiff<TItem> = {
  added: TItem[]
  changed: Array<{ oldRow: QueryResultRow; item: TItem }>
  removed: QueryResultRow[]
  summary: EfpRangeTableDiff
}

// Stored values come back driver-typed (Postgres BIGINT as string, SQLite as
// number) while fresh scans hold TS bigint/number values, so both sides are
// compared through String(...). null/NULL compare equal and hex values
// (addresses, hashes, raw bytes) compare lowercase, matching insert casing.
function canonical(value: unknown): string | null {
  if (value == null) return null
  if (typeof value === "string" && value.startsWith("0x")) return value.toLowerCase()
  return String(value)
}

function rowKey(chainId: unknown, transactionHash: unknown, logIndex: unknown): string {
  return `${canonical(chainId)}:${canonical(transactionHash)}:${canonical(logIndex)}`
}

function itemKey(item: { chainId: number; transactionHash: Hex; logIndex: number }): string {
  return rowKey(item.chainId, item.transactionHash, item.logIndex)
}

function diffEfpRows<TItem extends { chainId: number; transactionHash: Hex; logIndex: number }>(
  input: {
    oldRows: readonly QueryResultRow[]
    newItems: readonly TItem[]
    columns: readonly string[]
    valuesOf: (item: TItem) => readonly unknown[]
  },
): EfpRowDiff<TItem> {
  const oldByKey = new Map<string, QueryResultRow>()
  for (const row of input.oldRows) {
    oldByKey.set(rowKey(row.chain_id, row.transaction_hash, row.log_index), row)
  }
  const matchedKeys = new Set<string>()
  const added: TItem[] = []
  const changed: Array<{ oldRow: QueryResultRow; item: TItem }> = []
  for (const item of input.newItems) {
    const key = itemKey(item)
    const oldRow = oldByKey.get(key)
    if (!oldRow) {
      added.push(item)
      continue
    }
    matchedKeys.add(key)
    const oldPayload = input.columns.map((column) => canonical(oldRow[column]))
    const newPayload = input.valuesOf(item).map(canonical)
    const unchanged = oldPayload.length === newPayload.length
      && oldPayload.every((value, index) => value === newPayload[index])
    if (!unchanged) changed.push({ oldRow, item })
  }
  const removed = input.oldRows.filter(
    (row) => !matchedKeys.has(rowKey(row.chain_id, row.transaction_hash, row.log_index)),
  )
  return {
    added,
    changed,
    removed,
    summary: {
      existing: input.oldRows.length,
      inserted: added.length + changed.length,
      deleted: removed.length + changed.length,
      changed: changed.length,
    },
  }
}

function listOpValues(item: PersistedEfpListOp): readonly unknown[] {
  return [
    item.chainId,
    item.contractAddress,
    item.slot,
    item.blockNumber,
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
  ]
}

function primaryListEventValues(item: PersistedPrimaryListEvent): readonly unknown[] {
  return [
    item.chainId,
    item.contractAddress,
    item.accountAddress,
    "primary-list",
    item.rawValue,
    item.listId,
    item.blockNumber,
    item.blockHash,
    item.transactionHash,
    item.transactionIndex,
    item.logIndex,
  ]
}

function storageLocationEventValues(item: PersistedListStorageLocationEvent): readonly unknown[] {
  return [
    item.chainId,
    item.registryAddress,
    item.listId,
    item.rawStorageLocation,
    item.storageChainId,
    item.storageContractAddress,
    item.storageSlot,
    item.blockNumber,
    item.blockHash,
    item.transactionHash,
    item.transactionIndex,
    item.logIndex,
  ]
}

async function deleteEfpRowsByKey(
  tx: Transaction,
  table: "efp_list_ops" | "efp_primary_list_events" | "efp_list_storage_location_events",
  chainId: number,
  fromBlock: bigint,
  throughBlock: bigint,
  rows: readonly QueryResultRow[],
): Promise<void> {
  for (
    let batchStart = 0;
    batchStart < rows.length;
    batchStart += EFP_EVENT_INSERT_BATCH_SIZE
  ) {
    const batch = rows.slice(batchStart, batchStart + EFP_EVENT_INSERT_BATCH_SIZE)
    const args: Array<number | string> = [chainId, Number(fromBlock), Number(throughBlock)]
    const keys = batch.map((row) => {
      const firstPlaceholder = args.length + 1
      args.push(String(row.transaction_hash), Number(row.log_index))
      return `(?${firstPlaceholder}, ?${firstPlaceholder + 1})`
    })
    await tx.execute({
      sql: `
        DELETE FROM ${table}
        WHERE chain_id = ?1 AND block_number BETWEEN ?2 AND ?3
          AND (transaction_hash, log_index) IN (VALUES ${keys.join(", ")})
      `,
      args,
    })
  }
}

/**
 * Replaces one scanned block range differentially: rows whose primary key and
 * persisted payload already match the fresh scan produce no DML, removed rows
 * are deleted by primary key, changed rows are deleted and re-inserted, and
 * added rows are inserted. Only removed/added/changed rows contribute affected
 * identities, so an identical replay triggers no projection rebuild work. The
 * cursor always advances and the callback always fires, even when the diff is
 * empty.
 */
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
}): Promise<EfpRangeReplacementSummary> {
  return await withTransaction(input.client, "write", async (tx) => {
    const rangeArgs = [input.chainId, Number(input.fromBlock), Number(input.throughBlock)]
    const oldListOps = await tx.execute({
      sql: `
        SELECT ${EFP_LIST_OP_DIFF_COLUMNS.join(", ")}
        FROM efp_list_ops
        WHERE chain_id = ?1 AND block_number BETWEEN ?2 AND ?3
      `,
      args: rangeArgs,
    })
    const oldPrimaryListEvents = await tx.execute({
      sql: `
        SELECT ${EFP_PRIMARY_LIST_DIFF_COLUMNS.join(", ")}
        FROM efp_primary_list_events
        WHERE chain_id = ?1 AND block_number BETWEEN ?2 AND ?3
      `,
      args: rangeArgs,
    })
    const oldStorageLocationEvents = await tx.execute({
      sql: `
        SELECT ${EFP_STORAGE_LOCATION_DIFF_COLUMNS.join(", ")}
        FROM efp_list_storage_location_events
        WHERE chain_id = ?1 AND block_number BETWEEN ?2 AND ?3
      `,
      args: rangeArgs,
    })

    const listOps = diffEfpRows({
      oldRows: oldListOps.rows,
      newItems: input.listOps,
      columns: EFP_LIST_OP_DIFF_COLUMNS,
      valuesOf: listOpValues,
    })
    const primaryListEvents = diffEfpRows({
      oldRows: oldPrimaryListEvents.rows,
      newItems: input.primaryListEvents,
      columns: EFP_PRIMARY_LIST_DIFF_COLUMNS,
      valuesOf: primaryListEventValues,
    })
    const storageLocationEvents = diffEfpRows({
      oldRows: oldStorageLocationEvents.rows,
      newItems: input.storageLocationEvents,
      columns: EFP_STORAGE_LOCATION_DIFF_COLUMNS,
      valuesOf: storageLocationEventValues,
    })

    const affectedSlots = new Map<string, EfpAffectedListSlot>()
    for (const row of [...listOps.removed, ...listOps.changed.map((entry) => entry.oldRow)]) {
      if (typeof row.contract_address !== "string" || typeof row.slot !== "string") continue
      const contractAddress = row.contract_address.toLowerCase() as Address
      const slot = BigInt(row.slot)
      affectedSlots.set(`${input.chainId}:${contractAddress}:${slot}`, {
        chainId: input.chainId,
        contractAddress,
        slot,
      })
    }
    for (const item of [...listOps.added, ...listOps.changed.map((entry) => entry.item)]) {
      affectedSlots.set(`${item.chainId}:${item.contractAddress}:${item.slot}`, {
        chainId: item.chainId,
        contractAddress: item.contractAddress.toLowerCase() as Address,
        slot: item.slot,
      })
    }
    const affectedAccounts = new Set<Address>()
    for (
      const row of [
        ...primaryListEvents.removed,
        ...primaryListEvents.changed.map((entry) => entry.oldRow),
      ]
    ) {
      if (typeof row.account_address === "string") {
        affectedAccounts.add(row.account_address.toLowerCase() as Address)
      }
    }
    for (
      const item of [
        ...primaryListEvents.added,
        ...primaryListEvents.changed.map((entry) => entry.item),
      ]
    ) {
      affectedAccounts.add(item.accountAddress.toLowerCase() as Address)
    }
    const affectedListIds = new Set<bigint>()
    for (
      const row of [
        ...storageLocationEvents.removed,
        ...storageLocationEvents.changed.map((entry) => entry.oldRow),
      ]
    ) {
      if (typeof row.list_id === "string") affectedListIds.add(BigInt(row.list_id))
    }
    for (
      const item of [
        ...storageLocationEvents.added,
        ...storageLocationEvents.changed.map((entry) => entry.item),
      ]
    ) {
      affectedListIds.add(item.listId)
    }

    await deleteEfpRowsByKey(tx, "efp_list_ops", input.chainId, input.fromBlock, input.throughBlock, [
      ...listOps.removed,
      ...listOps.changed.map((entry) => entry.oldRow),
    ])
    await deleteEfpRowsByKey(
      tx,
      "efp_primary_list_events",
      input.chainId,
      input.fromBlock,
      input.throughBlock,
      [
        ...primaryListEvents.removed,
        ...primaryListEvents.changed.map((entry) => entry.oldRow),
      ],
    )
    await deleteEfpRowsByKey(
      tx,
      "efp_list_storage_location_events",
      input.chainId,
      input.fromBlock,
      input.throughBlock,
      [
        ...storageLocationEvents.removed,
        ...storageLocationEvents.changed.map((entry) => entry.oldRow),
      ],
    )

    const listOpsToInsert = [...listOps.added, ...listOps.changed.map((entry) => entry.item)]
    for (
      let batchStart = 0;
      batchStart < listOpsToInsert.length;
      batchStart += EFP_EVENT_INSERT_BATCH_SIZE
    ) {
      const batch = listOpsToInsert.slice(batchStart, batchStart + EFP_EVENT_INSERT_BATCH_SIZE)
      const args: Array<bigint | number | string | null> = []
      const values = batch.map((item) => {
        const firstPlaceholder = args.length + 1
        args.push(
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
        )
        return `(${Array.from(
          { length: EFP_LIST_OP_INSERT_COLUMN_COUNT },
          (_, index) => `?${firstPlaceholder + index}`,
        ).join(", ")})`
      })
      await tx.execute({
        sql: `
          INSERT INTO efp_list_ops (
            chain_id, contract_address, slot, block_number, block_hash,
            transaction_hash, transaction_index, log_index, raw_op,
            op_version, opcode, record_version, record_type, target_address,
            tag, created_at
          ) VALUES ${values.join(", ")}
        `,
        args,
      })
    }

    const primaryListEventsToInsert = [
      ...primaryListEvents.added,
      ...primaryListEvents.changed.map((entry) => entry.item),
    ]
    for (
      let batchStart = 0;
      batchStart < primaryListEventsToInsert.length;
      batchStart += EFP_EVENT_INSERT_BATCH_SIZE
    ) {
      const batch = primaryListEventsToInsert.slice(
        batchStart,
        batchStart + EFP_EVENT_INSERT_BATCH_SIZE,
      )
      const args: Array<bigint | number | string | null> = []
      const values = batch.map((item) => {
        const firstPlaceholder = args.length + 1
        args.push(
          item.chainId,
          item.contractAddress,
          item.accountAddress,
          "primary-list",
          item.rawValue,
          item.listId?.toString() ?? null,
          Number(item.blockNumber),
          item.blockHash,
          item.transactionHash,
          item.transactionIndex,
          item.logIndex,
          input.scanCompletedAt,
        )
        return `(${Array.from(
          { length: EFP_PRIMARY_LIST_INSERT_COLUMN_COUNT },
          (_, index) => `?${firstPlaceholder + index}`,
        ).join(", ")})`
      })
      await tx.execute({
        sql: `
          INSERT INTO efp_primary_list_events (
            chain_id, contract_address, account_address, metadata_key,
            raw_value, list_id, block_number, block_hash, transaction_hash,
            transaction_index, log_index, created_at
          ) VALUES ${values.join(", ")}
        `,
        args,
      })
    }

    const storageLocationEventsToInsert = [
      ...storageLocationEvents.added,
      ...storageLocationEvents.changed.map((entry) => entry.item),
    ]
    for (
      let batchStart = 0;
      batchStart < storageLocationEventsToInsert.length;
      batchStart += EFP_EVENT_INSERT_BATCH_SIZE
    ) {
      const batch = storageLocationEventsToInsert.slice(
        batchStart,
        batchStart + EFP_EVENT_INSERT_BATCH_SIZE,
      )
      const args: Array<bigint | number | string | null> = []
      const values = batch.map((item) => {
        const firstPlaceholder = args.length + 1
        args.push(
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
        )
        return `(${Array.from(
          { length: EFP_STORAGE_LOCATION_INSERT_COLUMN_COUNT },
          (_, index) => `?${firstPlaceholder + index}`,
        ).join(", ")})`
      })
      await tx.execute({
        sql: `
          INSERT INTO efp_list_storage_location_events (
            chain_id, registry_address, list_id, raw_storage_location,
            storage_chain_id, storage_contract_address, storage_slot,
            block_number, block_hash, transaction_hash, transaction_index,
            log_index, created_at
          ) VALUES ${values.join(", ")}
        `,
        args,
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

    return {
      listOps: listOps.summary,
      primaryListEvents: primaryListEvents.summary,
      storageLocationEvents: storageLocationEvents.summary,
      affectedSlotCount: affectedSlots.size,
      affectedAccountCount: affectedAccounts.size,
      affectedListIdCount: affectedListIds.size,
    }
  })
}
