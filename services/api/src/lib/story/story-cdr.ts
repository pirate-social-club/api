import { Contract, Interface, JsonRpcProvider, getBytes, hexlify } from "ethers"
import type { Env } from "../../types"
import { resolveDirectTxGasPolicy } from "../evm-direct-tx"
import { sendContractTxWithPkp } from "../evm-chipotle"
import { resolveStoryCdrWriterPkpExecutionConfig } from "./cdr-writer-pkp"
import {
  DEFAULT_STORY_CHAIN_ID,
  DEFAULT_STORY_RPC_URL,
  DEFAULT_STORY_TX_WAIT_TIMEOUT_MS,
} from "./story-runtime-config"

const STORY_MAINNET_CHAIN_ID = 1514
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
let testUploader: ((params: {
  env: Env
  dataKey: Uint8Array
  writeConditionAddr: string
  readConditionAddr: string
  writeConditionData: `0x${string}`
  readConditionData: `0x${string}`
  accessAuxData?: `0x${string}`
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
  if (!cdrCryptoReadyPromise) {
    cdrCryptoReadyPromise = (async () => {
      const mod = await import("../../vendor/piplabs/cdr-crypto/index.js") as unknown as CdrCryptoModule
      await mod.initWasm()
      return mod
    })()
  }
  return cdrCryptoReadyPromise
}

async function readLatestDkgGlobalPubKey(params: {
  provider: JsonRpcProvider
  dkgAddress: string
}): Promise<Uint8Array> {
  const iface = new Interface(DKG_ABI)
  const logs = await params.provider.getLogs({
    address: params.dkgAddress,
    fromBlock: 0,
    toBlock: "latest",
  })
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const log = logs[index]!
    try {
      const parsed = iface.parseLog({
        topics: [...log.topics],
        data: log.data,
      })
      if (parsed?.name !== "Finalized") continue
      const { CURVE_ED25519 } = await loadCdrCrypto()
      return prefixCurveCode(getBytes(String(parsed.args.globalPubKey)), CURVE_ED25519)
    } catch {
      // Ignore unrelated logs.
    }
  }
  throw new Error("No Finalized event found - DKG may not have completed yet")
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
}): Promise<StoryCdrUploadResult> {
  if (testUploader) {
    return await testUploader(params)
  }
  const writerPkpConfig = resolveStoryCdrWriterPkpExecutionConfig(params.env)
  if (!writerPkpConfig.ok) throw new Error(writerPkpConfig.error)
  if (!writerPkpConfig.value) {
    throw new Error("STORY_CDR_WRITER_PKP_ADDRESS missing/invalid")
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

  const provider = new JsonRpcProvider(
    String(params.env.STORY_RPC_URL || DEFAULT_STORY_RPC_URL).trim() || DEFAULT_STORY_RPC_URL,
    chainId,
  )
  const cdrContract = new Contract(contracts.cdrAddress, CDR_ABI, provider)

  const allocateFee = BigInt(await cdrContract.allocateFee())
  const allocateTx = await sendContractTxWithPkp({
    provider,
    chainId,
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
    pkp: writerPkpConfig.value.pkp,
    txWaitTimeoutMs,
    label: "cdr_allocate",
    value: allocateFee,
  })
  const allocateLogs = ((allocateTx.receipt?.logs as Array<{ topics: readonly string[]; data: string }> | undefined) || []).filter((log): log is { topics: readonly string[]; data: string } => (
    Array.isArray(log.topics)
    && log.topics.every((topic) => typeof topic === "string")
    && typeof log.data === "string"
  ))
  const cdrVaultUuid = parseVaultAllocatedUuid(allocateLogs)

  const globalPubKey = await readLatestDkgGlobalPubKey({
    provider,
    dkgAddress: contracts.dkgAddress,
  })
  const { tdh2Encrypt } = await loadCdrCrypto()
  const ciphertext = await tdh2Encrypt({
    plaintext: params.dataKey,
    globalPubKey,
    label: uuidToLabel(cdrVaultUuid),
  })

  const writeFee = BigInt(await cdrContract.writeFee())
  const writeTx = await sendContractTxWithPkp({
    provider,
    chainId,
    contractAddress: contracts.cdrAddress,
    abi: CDR_ABI,
    functionName: "write",
    args: [
      cdrVaultUuid,
      params.accessAuxData ?? "0x",
      hexlify(ciphertext.raw) as `0x${string}`,
    ],
    gasPolicy: gasPolicy.value,
    pkp: writerPkpConfig.value.pkp,
    txWaitTimeoutMs,
    label: "cdr_write",
    value: writeFee,
  })

  return {
    cdrVaultUuid,
    writerAddress: writerPkpConfig.value.pkp.pkpAddress,
    txHashes: {
      allocate: allocateTx.txHash,
      write: writeTx.txHash,
    },
  }
}
