import { Contract, Interface, JsonRpcProvider, Wallet, getBytes, hexlify } from "ethers"
import type { Env } from "../../env"
import { resolveDirectTxGasPolicy, sendContractTxWithPolicy } from "../evm-direct-tx"
import { resolveStoryCdrWriterDirectSigner } from "./story-direct-signer"
import {
  DEFAULT_STORY_CHAIN_ID,
  DEFAULT_STORY_RPC_URL,
  DEFAULT_STORY_TX_WAIT_TIMEOUT_MS,
  resolveStoryRpcUrl,
  resolveStoryRpcUrls,
} from "./story-runtime-config"

const STORY_MAINNET_CHAIN_ID = 1514
const DKG_LOG_SCAN_WINDOW = 50_000n
const DKG_LOG_SCAN_WINDOW_MIN = 256n
const CDR_TESTNET_ADDRESS = "0xcccccc0000000000000000000000000000000005"
const DKG_TESTNET_ADDRESS = "0xcccccc0000000000000000000000000000000004"
const CDR_MAINNET_ADDRESS = "0xcccccc0000000000000000000000000000000005"
const DKG_MAINNET_ADDRESS = "0xcccccc0000000000000000000000000000000004"

const CDR_ABI = [
  "function allocate(bool updatable,address writeConditionAddr,address readConditionAddr,bytes writeConditionData,bytes readConditionData) payable returns (uint32)",
  "function allocateFee() view returns (uint256)",
  "function write(uint32 uuid,bytes accessAuxData,bytes encryptedData)",
  "function writeFee() view returns (uint256)",
  "event VaultAllocated(uint32 uuid,bool updatable,address writeConditionAddr,address readConditionAddr,bytes writeConditionData,bytes readConditionData)",
] as const

const CDR_LOCKED_PUBLISH_GAS_BUFFER_WEI = 10_000_000_000_000_000n

const DKG_ABI = [
  "event Finalized(uint32 round,address indexed validatorAddr,bytes32 enclaveType,bytes32 codeCommitment,bytes32 participantsRoot,bytes globalPubKey,bytes[] publicCoeffs,bytes pubKeyShare,bytes signature)",
] as const

type Tdh2Ciphertext = { raw: Uint8Array }
type CdrCryptoModule = {
  CURVE_ED25519: number
  initWasm: () => Promise<void>
  tdh2Encrypt: (params: {
    plaintext: Uint8Array
    globalPubKey: Uint8Array
    label: Uint8Array
  }) => Promise<Tdh2Ciphertext>
}

export type StoryCdrUploadResult = {
  cdrVaultUuid: number
  writerAddress: string
  txHashes: { allocate: string; write: string }
}

let cdrCryptoReadyPromise: Promise<CdrCryptoModule> | null = null
let cdrCryptoLoaderForTests: (() => Promise<CdrCryptoModule>) | null = null
let storyJsonRpcProviderFactoryForTests: ((rpcUrl: string, chainId: number) => JsonRpcProvider) | null = null
let testUploader: ((params: {
  env: Env
  dataKey: Uint8Array
  writeConditionAddr: string
  readConditionAddr: string
  writeConditionData: `0x${string}`
  readConditionData: `0x${string}`
  accessAuxData?: `0x${string}`
  buildAccessAuxData?: (vaultUuid: number) => Promise<`0x${string}`>
}) => Promise<StoryCdrUploadResult>) | null = null

export function setStoryCdrUploaderForTests(
  uploader: ((params: {
    env: Env
    dataKey: Uint8Array
    writeConditionAddr: string
    readConditionAddr: string
    writeConditionData: `0x${string}`
    readConditionData: `0x${string}`
    accessAuxData?: `0x${string}`
    buildAccessAuxData?: (vaultUuid: number) => Promise<`0x${string}`>
  }) => Promise<StoryCdrUploadResult>) | null,
): void {
  testUploader = uploader
}

export function resolveStoryCdrContracts(chainId: number): { cdrAddress: string; dkgAddress: string } | null {
  if (chainId === DEFAULT_STORY_CHAIN_ID) {
    return {
      cdrAddress: CDR_TESTNET_ADDRESS,
      dkgAddress: DKG_TESTNET_ADDRESS,
    }
  }
  if (chainId === STORY_MAINNET_CHAIN_ID) {
    return {
      cdrAddress: CDR_MAINNET_ADDRESS,
      dkgAddress: DKG_MAINNET_ADDRESS,
    }
  }
  return null
}

function uuidToLabel(uuid: number): Uint8Array {
  const label = new Uint8Array(32)
  const view = new DataView(label.buffer)
  view.setUint32(28, uuid, false)
  return label
}

function prefixCurveCode(rawPoint: Uint8Array, curveCode: number): Uint8Array {
  if (rawPoint.length !== 32) return rawPoint
  const prefixed = new Uint8Array(34)
  prefixed[0] = (curveCode >> 8) & 0xff
  prefixed[1] = curveCode & 0xff
  prefixed.set(rawPoint, 2)
  return prefixed
}

async function loadCdrCrypto(): Promise<CdrCryptoModule> {
  if (cdrCryptoLoaderForTests) {
    return await cdrCryptoLoaderForTests()
  }
  if (!cdrCryptoReadyPromise) {
    cdrCryptoReadyPromise = (async () => {
      const mod = await import("../../vendor/piplabs/cdr-crypto/index.js") as unknown as CdrCryptoModule
      await mod.initWasm()
      return mod
    })()
  }
  return cdrCryptoReadyPromise
}

function setCdrCryptoLoaderForTests(loader: (() => Promise<CdrCryptoModule>) | null): void {
  cdrCryptoLoaderForTests = loader
}

function setStoryJsonRpcProviderFactoryForTests(
  factory: ((rpcUrl: string, chainId: number) => JsonRpcProvider) | null,
): void {
  storyJsonRpcProviderFactoryForTests = factory
}

function createStoryJsonRpcProvider(rpcUrl: string, chainId: number): JsonRpcProvider {
  return storyJsonRpcProviderFactoryForTests?.(rpcUrl, chainId) ?? new JsonRpcProvider(rpcUrl, chainId)
}

function shouldShrinkDkgLogWindow(message: string): boolean {
  return message.includes("block range is too large")
    || message.includes("too many results")
    || message.includes("query returned more than")
    || message.includes("response size")
    || message.includes("limit exceeded")
    || message.includes("exceeds maximum")
}

async function readLatestDkgGlobalPubKey(params: {
  provider: JsonRpcProvider
  dkgAddress: string
}): Promise<Uint8Array> {
  const { CURVE_ED25519 } = await loadCdrCrypto()
  return await scanLatestDkgGlobalPubKey({
    ...params,
    curveCode: CURVE_ED25519,
  })
}

async function scanLatestDkgGlobalPubKey(params: {
  provider: JsonRpcProvider
  dkgAddress: string
  curveCode: number
}): Promise<Uint8Array> {
  const iface = new Interface(DKG_ABI)
  const finalizedEvent = iface.getEvent("Finalized")
  if (!finalizedEvent) {
    throw new Error("Finalized event ABI missing")
  }
  const finalizedTopic = finalizedEvent.topicHash
  const latestBlock = BigInt(await params.provider.getBlockNumber())
  let windowSize = DKG_LOG_SCAN_WINDOW
  let fromBlock = latestBlock > windowSize ? latestBlock - windowSize : 0n
  let toBlock = latestBlock

  while (true) {
    let logs
    try {
      logs = await params.provider.getLogs({
        address: params.dkgAddress,
        topics: [finalizedTopic],
        fromBlock: Number(fromBlock),
        toBlock: Number(toBlock),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : String(error || "").toLowerCase()
      if (shouldShrinkDkgLogWindow(message) && windowSize > DKG_LOG_SCAN_WINDOW_MIN) {
        windowSize = windowSize / 2n
        if (windowSize < DKG_LOG_SCAN_WINDOW_MIN) windowSize = DKG_LOG_SCAN_WINDOW_MIN
        fromBlock = toBlock > windowSize ? toBlock - windowSize : 0n
        continue
      }
      throw error
    }
    for (let index = logs.length - 1; index >= 0; index -= 1) {
      const log = logs[index]!
      let parsed
      try {
        parsed = iface.parseLog({
          topics: [...log.topics],
          data: log.data,
        })
      } catch {
        // Ignore unrelated logs.
        continue
      }
      if (parsed?.name !== "Finalized") continue
      return prefixCurveCode(getBytes(String(parsed.args.globalPubKey)), params.curveCode)
    }
    if (fromBlock === 0n) break
    toBlock = fromBlock - 1n
    fromBlock = toBlock > windowSize ? toBlock - windowSize : 0n
  }
  throw new Error("No Finalized event found - DKG may not have completed yet")
}

async function readLatestDkgGlobalPubKeyWithFallback(params: {
  env: Pick<Env, "STORY_RPC_URL" | "STORY_RPC_FALLBACK_URLS">
  chainId: number
  dkgAddress: string
  primaryProvider: JsonRpcProvider
}): Promise<Uint8Array> {
  const { CURVE_ED25519 } = await loadCdrCrypto()
  const rpcUrls = resolveStoryRpcUrls(params.env)
  let lastError: unknown = null
  for (let index = 0; index < rpcUrls.length; index += 1) {
    const provider = index === 0
      ? params.primaryProvider
      : createStoryJsonRpcProvider(rpcUrls[index]!, params.chainId)
    try {
      return await scanLatestDkgGlobalPubKey({
        provider,
        dkgAddress: params.dkgAddress,
        curveCode: CURVE_ED25519,
      })
    } catch (error) {
      lastError = error
      if (index + 1 < rpcUrls.length) {
        console.warn("[story] DKG global public key lookup failed; retrying fallback RPC", {
          rpc_index: index,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    } finally {
      if (provider !== params.primaryProvider) {
        void provider.destroy()
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || "DKG global public key lookup failed"))
}

export const __storyCdrTestHooks = {
  readLatestDkgGlobalPubKey,
  readLatestDkgGlobalPubKeyWithFallback,
  setCdrCryptoLoaderForTests,
  setStoryJsonRpcProviderFactoryForTests,
}

function parseVaultAllocatedUuid(logs: Array<{ topics: readonly string[]; data: string }>): number {
  const iface = new Interface(CDR_ABI)
  for (const log of logs) {
    try {
      const parsed = iface.parseLog({
        topics: [...log.topics],
        data: log.data,
      })
      if (parsed?.name !== "VaultAllocated") continue
      const uuid = Number(parsed.args.uuid)
      if (!Number.isInteger(uuid) || uuid <= 0) {
        throw new Error("VaultAllocated event uuid invalid")
      }
      return uuid
    } catch {
      // Ignore unrelated logs.
    }
  }
  throw new Error("VaultAllocated event not found in transaction logs")
}

export async function uploadCdrEncryptedDataKey(params: {
  env: Env
  dataKey: Uint8Array
  writeConditionAddr: string
  readConditionAddr: string
  writeConditionData: `0x${string}`
  readConditionData: `0x${string}`
  accessAuxData?: `0x${string}`
  buildAccessAuxData?: (vaultUuid: number) => Promise<`0x${string}`>
}): Promise<StoryCdrUploadResult> {
  if (testUploader) {
    return await testUploader(params)
  }
  const writerConfig = resolveStoryCdrWriterDirectSigner(params.env)
  if (!writerConfig.ok) throw new Error(writerConfig.error)
  if (!writerConfig.value) {
    throw new Error("STORY_CDR_WRITER_PRIVATE_KEY missing/invalid")
  }

  const chainIdRaw = String(params.env.STORY_CHAIN_ID || "").trim()
  const chainId = chainIdRaw ? Number(chainIdRaw) : DEFAULT_STORY_CHAIN_ID
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(`Invalid STORY_CHAIN_ID: ${chainIdRaw || "<empty>"}`)
  }
  const contracts = resolveStoryCdrContracts(chainId)
  if (!contracts) {
    throw new Error(`CDR backend upload is not configured for Story chain ${chainId}`)
  }

  const txWaitTimeoutRaw = String(params.env.STORY_TX_WAIT_TIMEOUT_MS || "").trim()
  const txWaitTimeoutMs = txWaitTimeoutRaw ? Number(txWaitTimeoutRaw) : DEFAULT_STORY_TX_WAIT_TIMEOUT_MS
  if (!Number.isInteger(txWaitTimeoutMs) || txWaitTimeoutMs < 1_000 || txWaitTimeoutMs > 300_000) {
    throw new Error(`Invalid STORY_TX_WAIT_TIMEOUT_MS: ${txWaitTimeoutRaw || "<empty>"}`)
  }

  const gasPolicy = resolveDirectTxGasPolicy({
    maxFeePerGasCapWeiRaw: params.env.STORY_DIRECT_TX_MAX_FEE_PER_GAS_WEI,
    maxPriorityFeePerGasCapWeiRaw: params.env.STORY_DIRECT_TX_MAX_PRIORITY_FEE_PER_GAS_WEI,
    gasLimitCapRaw: params.env.STORY_DIRECT_TX_GAS_LIMIT_MAX,
    gasEstimateBufferBpsRaw: params.env.STORY_DIRECT_TX_GAS_ESTIMATE_BUFFER_BPS,
    maxFeePerGasCapField: "STORY_DIRECT_TX_MAX_FEE_PER_GAS_WEI",
    maxPriorityFeePerGasCapField: "STORY_DIRECT_TX_MAX_PRIORITY_FEE_PER_GAS_WEI",
    gasLimitCapField: "STORY_DIRECT_TX_GAS_LIMIT_MAX",
    gasEstimateBufferBpsField: "STORY_DIRECT_TX_GAS_ESTIMATE_BUFFER_BPS",
  })
  if (!gasPolicy.ok) throw new Error(gasPolicy.error)

  const provider = createStoryJsonRpcProvider(resolveStoryRpcUrl(params.env) || DEFAULT_STORY_RPC_URL, chainId)
  const writerSigner = new Wallet(writerConfig.value.privateKey, provider)
  const cdrContract = new Contract(contracts.cdrAddress, CDR_ABI, provider)

  const allocateFee = BigInt(await cdrContract.allocateFee())
  const allocateTx = await sendContractTxWithPolicy({
    provider,
    signer: writerSigner,
    contractAddress: contracts.cdrAddress,
    abi: CDR_ABI,
    functionName: "allocate",
    args: [
      false,
      params.writeConditionAddr,
      params.readConditionAddr,
      params.writeConditionData,
      params.readConditionData,
    ],
    gasPolicy: gasPolicy.value,
    value: allocateFee,
    defaultWaitTimeoutMs: txWaitTimeoutMs,
  })
  const allocateReceipt = await provider.waitForTransaction(String(allocateTx.hash || ""), 1, txWaitTimeoutMs)
  if (!allocateReceipt || allocateReceipt.status !== 1) {
    throw new Error("cdr_allocate_failed")
  }
  const allocateLogs = ((allocateReceipt.logs as readonly { topics: readonly string[]; data: string }[] | undefined) || []).filter((log): log is { topics: readonly string[]; data: string } => (
    Array.isArray(log.topics)
    && log.topics.every((topic) => typeof topic === "string")
    && typeof log.data === "string"
  ))
  const cdrVaultUuid = parseVaultAllocatedUuid(allocateLogs)

  const globalPubKey = await readLatestDkgGlobalPubKeyWithFallback({
    env: params.env,
    chainId,
    primaryProvider: provider,
    dkgAddress: contracts.dkgAddress,
  })
  const { tdh2Encrypt } = await loadCdrCrypto()
  const ciphertext = await tdh2Encrypt({
    plaintext: params.dataKey,
    globalPubKey,
    label: uuidToLabel(cdrVaultUuid),
  })
  const accessAuxData = params.buildAccessAuxData
    ? await params.buildAccessAuxData(cdrVaultUuid)
    : (params.accessAuxData ?? "0x")

  const writeFee = BigInt(await cdrContract.writeFee())
  const writeTx = await sendContractTxWithPolicy({
    provider,
    signer: writerSigner,
    contractAddress: contracts.cdrAddress,
    abi: CDR_ABI,
    functionName: "write",
    args: [
      cdrVaultUuid,
      accessAuxData,
      hexlify(ciphertext.raw) as `0x${string}`,
    ],
    gasPolicy: gasPolicy.value,
    value: writeFee,
    defaultWaitTimeoutMs: txWaitTimeoutMs,
  })
  const writeReceipt = await provider.waitForTransaction(String(writeTx.hash || ""), 1, txWaitTimeoutMs)
  if (!writeReceipt || writeReceipt.status !== 1) {
    throw new Error("cdr_write_failed")
  }

  return {
    cdrVaultUuid,
    writerAddress: writerSigner.address,
    txHashes: {
      allocate: String(allocateTx.hash || ""),
      write: String(writeTx.hash || ""),
    },
  }
}

export async function estimateStoryCdrLockedPublishMinimumBalanceWei(env: Env): Promise<bigint> {
  const chainIdRaw = String(env.STORY_CHAIN_ID || "").trim()
  const chainId = chainIdRaw ? Number(chainIdRaw) : DEFAULT_STORY_CHAIN_ID
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(`Invalid STORY_CHAIN_ID: ${chainIdRaw || "<empty>"}`)
  }
  const contracts = resolveStoryCdrContracts(chainId)
  if (!contracts) {
    throw new Error(`CDR backend upload is not configured for Story chain ${chainId}`)
  }

  const provider = createStoryJsonRpcProvider(resolveStoryRpcUrl(env) || DEFAULT_STORY_RPC_URL, chainId)
  try {
    const cdrContract = new Contract(contracts.cdrAddress, CDR_ABI, provider)
    const [allocateFeeRaw, writeFeeRaw] = await Promise.all([
      cdrContract.allocateFee(),
      cdrContract.writeFee(),
    ])
    return BigInt(allocateFeeRaw) + BigInt(writeFeeRaw) + CDR_LOCKED_PUBLISH_GAS_BUFFER_WEI
  } finally {
    void provider.destroy()
  }
}
