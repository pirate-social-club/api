import {
  createPublicClient,
  fromHex,
  http,
  parseAbiItem,
  type Address,
  type Hex,
  type Log,
} from "viem"
import { base } from "viem/chains"

import type { Env } from "../../env"
import type { Client } from "../sql-client"
import { decodeEfpListOp } from "./list-op"
import {
  readEfpIndexerCursor,
  replaceEfpIndexerRange,
  type PersistedEfpListOp,
  type PersistedListStorageLocationEvent,
  type PersistedPrimaryListEvent,
} from "./repository"

export const EFP_BASE_CHAIN_ID = 8453
export const EFP_BASE_LIST_RECORDS = "0x41aa48ef3c0446b46a5b1cc6337ff3d3716e2a33" as Address
export const EFP_BASE_ACCOUNT_METADATA = "0x5289fe5dabc021d02fddf23d4a4df96f4e0f17ef" as Address
export const EFP_BASE_LIST_REGISTRY = "0x0e688f5dca4a0a4729946acbc44c792341714e08" as Address
export const EFP_BASE_START_BLOCK = 20_000_000n
export const EFP_CONFIRMATION_DEPTH = 64n
export const EFP_REPLAY_BLOCKS = 128n
export const EFP_SCAN_BLOCK_SPAN = 10_000n
const EFP_RPC_LOG_RANGE = 10_000n
const LIST_OP_EVENT = parseAbiItem("event ListOp(uint256 indexed slot, bytes op)")
const UPDATE_ACCOUNT_METADATA_EVENT = parseAbiItem(
  "event UpdateAccountMetadata(address indexed addr, string key, bytes value)",
)
const UPDATE_LIST_STORAGE_LOCATION_EVENT = parseAbiItem(
  "event UpdateListStorageLocation(uint256 indexed tokenId, bytes listStorageLocation)",
)

function buildEfpBaseReader(rpcUrl: string) {
  return createPublicClient({
    chain: base,
    transport: http(rpcUrl, { timeout: 12_000 }),
  })
}

type EfpChainReader = ReturnType<typeof buildEfpBaseReader>

function requiredIndex(log: Log, key: "transactionIndex" | "logIndex"): number {
  const value = log[key]
  if (typeof value !== "number") {
    throw new Error(`EFP log is missing ${key}`)
  }
  return value
}

function requiredHex(value: Hex | null | undefined, label: string): Hex {
  if (!value) throw new Error(`EFP log is missing ${label}`)
  return value.toLowerCase() as Hex
}

async function getLogsAdaptive<T>(
  fetchRange: (fromBlock: bigint, toBlock: bigint) => Promise<readonly T[]>,
  fromBlock: bigint,
  toBlock: bigint,
  rateLimitAttempt = 0,
): Promise<T[]> {
  try {
    return [...await fetchRange(fromBlock, toBlock)]
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
    const canSplit = message.includes("response too large")
      || message.includes("block range")
      || message.includes("limited to")
    if (message.includes("rate limit") && rateLimitAttempt < 6) {
      const retryAfterMs = Math.min(5_000, 250 * (2 ** rateLimitAttempt))
      await new Promise((resolve) => setTimeout(resolve, retryAfterMs))
      return getLogsAdaptive(fetchRange, fromBlock, toBlock, rateLimitAttempt + 1)
    }
    if (!canSplit || fromBlock === toBlock) throw error
    const midpoint = fromBlock + (toBlock - fromBlock) / 2n
    const [left, right] = await Promise.all([
      getLogsAdaptive(fetchRange, fromBlock, midpoint),
      getLogsAdaptive(fetchRange, midpoint + 1n, toBlock),
    ])
    return [...left, ...right]
  }
}

function decodePrimaryListId(value: Hex): bigint | null {
  if (value === "0x") return null
  try {
    const listId = fromHex(value, "bigint")
    return listId > 0n ? listId : null
  } catch {
    return null
  }
}

export function decodeStorageLocation(value: Hex): {
  chainId: number
  contractAddress: Address
  slot: bigint
} | null {
  // version (1) + type (1) + chain id (32) + contract (20) + slot (32)
  if (value.length !== 174 || value.slice(2, 6).toLowerCase() !== "0101") return null
  try {
    const chainId = Number(fromHex(`0x${value.slice(6, 70)}`, "bigint"))
    const contractAddress = `0x${value.slice(70, 110)}`.toLowerCase()
    const slot = fromHex(`0x${value.slice(110, 174)}`, "bigint")
    if (!Number.isSafeInteger(chainId) || chainId <= 0 || !/^0x[0-9a-f]{40}$/u.test(contractAddress)) {
      return null
    }
    return { chainId, contractAddress: contractAddress as Address, slot }
  } catch {
    return null
  }
}

export function createEfpBaseReader(rpcUrl: string): EfpChainReader {
  return buildEfpBaseReader(rpcUrl)
}

export function isEfpIndexerEnabled(
  env: Pick<Env, "BASE_MAINNET_RPC_URL" | "CONTROL_PLANE_DATABASE_URL">,
): boolean {
  return Boolean(
    String(env.BASE_MAINNET_RPC_URL ?? "").trim()
    && String(env.CONTROL_PLANE_DATABASE_URL ?? "").trim(),
  )
}

export type EfpScanSummary = {
  status: "caught_up" | "indexed"
  chainId: number
  fromBlock: string | null
  throughBlock: string
  safeHeadBlock: string
  listOpCount: number
  malformedListOpCount: number
  unsupportedListOpCount: number
  primaryListEventCount: number
  storageLocationEventCount: number
}

export async function scanEfpBaseOnce(input: {
  client: Client
  rpcUrl: string
  reader?: EfpChainReader
  now?: () => Date
  blockSpan?: bigint
}): Promise<EfpScanSummary> {
  const reader = input.reader ?? createEfpBaseReader(input.rpcUrl)
  const now = input.now ?? (() => new Date())
  const scanStartedAt = now().toISOString()
  const head = await reader.getBlockNumber()
  const safeHead = head > EFP_CONFIRMATION_DEPTH ? head - EFP_CONFIRMATION_DEPTH : 0n
  const cursor = await readEfpIndexerCursor(input.client, EFP_BASE_CHAIN_ID)
  if (safeHead < EFP_BASE_START_BLOCK) {
    return {
      status: "caught_up",
      chainId: EFP_BASE_CHAIN_ID,
      fromBlock: null,
      throughBlock: cursor?.indexedThroughBlock.toString() ?? (EFP_BASE_START_BLOCK - 1n).toString(),
      safeHeadBlock: safeHead.toString(),
      listOpCount: 0,
      malformedListOpCount: 0,
      unsupportedListOpCount: 0,
      primaryListEventCount: 0,
      storageLocationEventCount: 0,
    }
  }

  const indexedThrough = cursor?.indexedThroughBlock ?? (EFP_BASE_START_BLOCK - 1n)
  if (indexedThrough >= safeHead) {
    return {
      status: "caught_up",
      chainId: EFP_BASE_CHAIN_ID,
      fromBlock: null,
      throughBlock: indexedThrough.toString(),
      safeHeadBlock: safeHead.toString(),
      listOpCount: 0,
      malformedListOpCount: 0,
      unsupportedListOpCount: 0,
      primaryListEventCount: 0,
      storageLocationEventCount: 0,
    }
  }

  const replayFrom = indexedThrough >= EFP_BASE_START_BLOCK
    ? indexedThrough - EFP_REPLAY_BLOCKS + 1n
    : EFP_BASE_START_BLOCK
  const fromBlock = replayFrom < EFP_BASE_START_BLOCK ? EFP_BASE_START_BLOCK : replayFrom
  const blockSpan = input.blockSpan && input.blockSpan > 0n
    ? input.blockSpan
    : EFP_SCAN_BLOCK_SPAN
  const throughBlock = fromBlock + blockSpan - 1n < safeHead
    ? fromBlock + blockSpan - 1n
    : safeHead

  const ranges: Array<{ fromBlock: bigint; toBlock: bigint }> = []
  for (let rangeStart = fromBlock; rangeStart <= throughBlock; rangeStart += EFP_RPC_LOG_RANGE) {
    const rangeEnd = rangeStart + EFP_RPC_LOG_RANGE - 1n
    ranges.push({
      fromBlock: rangeStart,
      toBlock: rangeEnd < throughBlock ? rangeEnd : throughBlock,
    })
  }
  // Initial backfills may request a wider logical batch, but every provider
  // call remains within Base's documented/public 10k getLogs ceiling.
  const rangeResults = []
  // Keep provider pressure bounded during operator backfills: the three
  // contracts are queried together, while adjacent 10k ranges run in order.
  // This avoids public/provider burst limits without shrinking the atomic
  // logical batch persisted below.
  for (const range of ranges) {
    const [listLogs, metadataLogs, storageLogs] = await Promise.all([
      getLogsAdaptive(
        (fromBlock, toBlock) => reader.getLogs({
          address: EFP_BASE_LIST_RECORDS,
          event: LIST_OP_EVENT,
          fromBlock,
          toBlock,
          strict: true,
        }),
        range.fromBlock,
        range.toBlock,
      ),
      getLogsAdaptive(
        (fromBlock, toBlock) => reader.getLogs({
          address: EFP_BASE_ACCOUNT_METADATA,
          event: UPDATE_ACCOUNT_METADATA_EVENT,
          fromBlock,
          toBlock,
          strict: true,
        }),
        range.fromBlock,
        range.toBlock,
      ),
      getLogsAdaptive(
        (fromBlock, toBlock) => reader.getLogs({
          address: EFP_BASE_LIST_REGISTRY,
          event: UPDATE_LIST_STORAGE_LOCATION_EVENT,
          fromBlock,
          toBlock,
          strict: true,
        }),
        range.fromBlock,
        range.toBlock,
      ),
    ])
    rangeResults.push({ listLogs, metadataLogs, storageLogs })
  }
  const through = await reader.getBlock({ blockNumber: throughBlock })
  const listLogs = rangeResults.flatMap((result) => result.listLogs)
  const metadataLogs = rangeResults.flatMap((result) => result.metadataLogs)
  const storageLogs = rangeResults.flatMap((result) => result.storageLogs)

  const listOps: PersistedEfpListOp[] = listLogs.map((log) => {
    const rawOp = log.args.op
    if (typeof rawOp !== "string") throw new Error("EFP ListOp log is missing op bytes")
    return {
      chainId: EFP_BASE_CHAIN_ID,
      contractAddress: EFP_BASE_LIST_RECORDS,
      slot: log.args.slot,
      blockNumber: log.blockNumber,
      blockHash: requiredHex(log.blockHash, "blockHash"),
      transactionHash: requiredHex(log.transactionHash, "transactionHash"),
      transactionIndex: requiredIndex(log, "transactionIndex"),
      logIndex: requiredIndex(log, "logIndex"),
      rawOp,
      decoded: decodeEfpListOp(rawOp),
    }
  })
  const primaryListEvents: PersistedPrimaryListEvent[] = metadataLogs
    .filter((log) => log.args.key === "primary-list")
    .map((log) => ({
      chainId: EFP_BASE_CHAIN_ID,
      contractAddress: EFP_BASE_ACCOUNT_METADATA,
      accountAddress: log.args.addr.toLowerCase() as Address,
      rawValue: log.args.value,
      listId: decodePrimaryListId(log.args.value),
      blockNumber: log.blockNumber,
      blockHash: requiredHex(log.blockHash, "blockHash"),
      transactionHash: requiredHex(log.transactionHash, "transactionHash"),
      transactionIndex: requiredIndex(log, "transactionIndex"),
      logIndex: requiredIndex(log, "logIndex"),
    }))
  const storageLocationEvents: PersistedListStorageLocationEvent[] = storageLogs.map((log) => {
    const decoded = decodeStorageLocation(log.args.listStorageLocation)
    return {
      chainId: EFP_BASE_CHAIN_ID,
      registryAddress: EFP_BASE_LIST_REGISTRY,
      listId: log.args.tokenId,
      rawStorageLocation: log.args.listStorageLocation,
      storageChainId: decoded?.chainId ?? null,
      storageContractAddress: decoded?.contractAddress ?? null,
      storageSlot: decoded?.slot ?? null,
      blockNumber: log.blockNumber,
      blockHash: requiredHex(log.blockHash, "blockHash"),
      transactionHash: requiredHex(log.transactionHash, "transactionHash"),
      transactionIndex: requiredIndex(log, "transactionIndex"),
      logIndex: requiredIndex(log, "logIndex"),
    }
  })
  const scanCompletedAt = now().toISOString()
  await replaceEfpIndexerRange({
    client: input.client,
    chainId: EFP_BASE_CHAIN_ID,
    fromBlock,
    throughBlock,
    throughBlockHash: requiredHex(through.hash, "through block hash"),
    safeHeadBlock: safeHead,
    listOps,
    primaryListEvents,
    storageLocationEvents,
    scanStartedAt,
    scanCompletedAt,
  })

  return {
    status: "indexed",
    chainId: EFP_BASE_CHAIN_ID,
    fromBlock: fromBlock.toString(),
    throughBlock: throughBlock.toString(),
    safeHeadBlock: safeHead.toString(),
    listOpCount: listOps.length,
    malformedListOpCount: listOps.filter((item) => item.decoded.classification === "malformed").length,
    unsupportedListOpCount: listOps.filter((item) => item.decoded.classification === "unsupported").length,
    primaryListEventCount: primaryListEvents.length,
    storageLocationEventCount: storageLocationEvents.length,
  }
}
