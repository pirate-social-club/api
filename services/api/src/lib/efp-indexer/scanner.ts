import {
  createPublicClient,
  fromHex,
  http,
  parseAbiItem,
  type Address,
  type Hex,
  type Log,
} from "viem"
import { base, mainnet, optimism, type Chain } from "viem/chains"

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
export const EFP_OPTIMISM_CHAIN_ID = 10
export const EFP_OPTIMISM_LIST_RECORDS = "0x4ca00413d850dcfa3516e14d21dae2772f2acb85" as Address
export const EFP_OPTIMISM_START_BLOCK = 125_792_000n
export const EFP_ETHEREUM_CHAIN_ID = 1
export const EFP_ETHEREUM_LIST_RECORDS = "0x5289fe5dabc021d02fddf23d4a4df96f4e0f17ef" as Address
export const EFP_ETHEREUM_START_BLOCK = 20_820_000n
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

function buildEfpReader(rpcUrl: string, chain: Chain) {
  return createPublicClient({
    chain,
    transport: http(rpcUrl, { timeout: 12_000 }),
  })
}

type EfpChainReader = ReturnType<typeof buildEfpReader>

export type EfpIndexerChainConfig = {
  chainId: number
  chain: Chain
  name: "base" | "optimism" | "ethereum"
  listRecordsAddress: Address
  startBlock: bigint
  accountMetadataAddress?: Address
  listRegistryAddress?: Address
}

export const EFP_INDEXER_CHAINS: Record<EfpIndexerChainConfig["name"], EfpIndexerChainConfig> = {
  base: {
    chainId: EFP_BASE_CHAIN_ID,
    chain: base,
    name: "base",
    listRecordsAddress: EFP_BASE_LIST_RECORDS,
    startBlock: EFP_BASE_START_BLOCK,
    accountMetadataAddress: EFP_BASE_ACCOUNT_METADATA,
    listRegistryAddress: EFP_BASE_LIST_REGISTRY,
  },
  optimism: {
    chainId: EFP_OPTIMISM_CHAIN_ID,
    chain: optimism,
    name: "optimism",
    listRecordsAddress: EFP_OPTIMISM_LIST_RECORDS,
    startBlock: EFP_OPTIMISM_START_BLOCK,
  },
  ethereum: {
    chainId: EFP_ETHEREUM_CHAIN_ID,
    chain: mainnet,
    name: "ethereum",
    listRecordsAddress: EFP_ETHEREUM_LIST_RECORDS,
    startBlock: EFP_ETHEREUM_START_BLOCK,
  },
}

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
  return buildEfpReader(rpcUrl, base)
}

export function createEfpChainReader(
  rpcUrl: string,
  config: EfpIndexerChainConfig,
): EfpChainReader {
  return buildEfpReader(rpcUrl, config.chain)
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

export async function scanEfpChainOnce(input: {
  client: Client
  rpcUrl: string
  config: EfpIndexerChainConfig
  reader?: EfpChainReader
  now?: () => Date
  blockSpan?: bigint
}): Promise<EfpScanSummary> {
  const { config } = input
  const reader = input.reader ?? createEfpChainReader(input.rpcUrl, config)
  const now = input.now ?? (() => new Date())
  const scanStartedAt = now().toISOString()
  const head = await reader.getBlockNumber()
  const safeHead = head > EFP_CONFIRMATION_DEPTH ? head - EFP_CONFIRMATION_DEPTH : 0n
  const cursor = await readEfpIndexerCursor(input.client, config.chainId)
  if (safeHead < config.startBlock) {
    return {
      status: "caught_up",
      chainId: config.chainId,
      fromBlock: null,
      throughBlock: cursor?.indexedThroughBlock.toString() ?? (config.startBlock - 1n).toString(),
      safeHeadBlock: safeHead.toString(),
      listOpCount: 0,
      malformedListOpCount: 0,
      unsupportedListOpCount: 0,
      primaryListEventCount: 0,
      storageLocationEventCount: 0,
    }
  }

  const indexedThrough = cursor?.indexedThroughBlock ?? (config.startBlock - 1n)
  if (indexedThrough >= safeHead) {
    return {
      status: "caught_up",
      chainId: config.chainId,
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

  const replayFrom = indexedThrough >= config.startBlock
    ? indexedThrough - EFP_REPLAY_BLOCKS + 1n
    : config.startBlock
  const fromBlock = replayFrom < config.startBlock ? config.startBlock : replayFrom
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
          address: config.listRecordsAddress,
          event: LIST_OP_EVENT,
          fromBlock,
          toBlock,
          strict: true,
        }),
        range.fromBlock,
        range.toBlock,
      ),
      config.accountMetadataAddress ? getLogsAdaptive(
        (fromBlock, toBlock) => reader.getLogs({
          address: config.accountMetadataAddress,
          event: UPDATE_ACCOUNT_METADATA_EVENT,
          fromBlock,
          toBlock,
          strict: true,
        }),
        range.fromBlock,
        range.toBlock,
      ) : Promise.resolve([]),
      config.listRegistryAddress ? getLogsAdaptive(
        (fromBlock, toBlock) => reader.getLogs({
          address: config.listRegistryAddress,
          event: UPDATE_LIST_STORAGE_LOCATION_EVENT,
          fromBlock,
          toBlock,
          strict: true,
        }),
        range.fromBlock,
        range.toBlock,
      ) : Promise.resolve([]),
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
      chainId: config.chainId,
      contractAddress: config.listRecordsAddress,
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
      chainId: config.chainId,
      contractAddress: config.accountMetadataAddress ?? EFP_BASE_ACCOUNT_METADATA,
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
      chainId: config.chainId,
      registryAddress: config.listRegistryAddress ?? EFP_BASE_LIST_REGISTRY,
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
    chainId: config.chainId,
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
    chainId: config.chainId,
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

export async function scanEfpBaseOnce(
  input: Omit<Parameters<typeof scanEfpChainOnce>[0], "config">,
): Promise<EfpScanSummary> {
  return await scanEfpChainOnce({ ...input, config: EFP_INDEXER_CHAINS.base })
}
