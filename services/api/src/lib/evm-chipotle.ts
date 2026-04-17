import { Interface, JsonRpcProvider, Transaction, computeAddress, getAddress } from "ethers"
import type { TransactionReceipt } from "ethers"
import type { ConfigResult } from "./config-result"
import { toCanonicalIpfsUri } from "./storage"
import { resolveDirectTxFeeOverrides, type DirectTxGasPolicy } from "./evm-direct-tx"

const DEFAULT_CHIPOTLE_BASE_URL = "https://api.dev.litprotocol.com"
const DEFAULT_IPFS_GATEWAY_URL = "https://psc.myfilebase.com/ipfs"
const DEFAULT_IPFS_FALLBACK_GATEWAY_URLS = [
  "https://ipfs.io/ipfs",
  "https://gateway.pinata.cloud/ipfs",
  "https://cloudflare-ipfs.com/ipfs",
] as const
const DEFAULT_TX_WAIT_TIMEOUT_MS = 45_000
const DEFAULT_MAX_UNSIGNED_TXS = 20
const TX_RECEIPT_POLL_MS = 1_200

type LitActionResponse = {
  has_error?: boolean
  logs?: string
  response?: unknown
}

export type ChipotleExecutionConfig = {
  baseUrl: string
  apiKey: string
  actionCid: `ipfs://${string}`
  ipfsGatewayUrl: string
}

export type PkpExecutionConfig = ChipotleExecutionConfig & {
  pkpAddress: `0x${string}`
  pkpPublicKey: `0x${string}` | null
}

export type UnsignedPkpTx = {
  type: number
  chainId: number
  nonce: number
  to: `0x${string}`
  value: bigint
  data: `0x${string}`
  gasLimit: bigint
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
}

export type PkpSendContractTxParams = {
  provider: JsonRpcProvider
  chainId: number
  contractAddress: string
  abi: readonly string[]
  functionName: string
  args: readonly unknown[]
  gasPolicy: DirectTxGasPolicy
  pkp: PkpExecutionConfig
  value?: bigint
  txWaitTimeoutMs?: number
  waitForReceipt?: boolean
  label: string
}

export type PkpSendUnsignedTxsParams = {
  provider: JsonRpcProvider
  pkp: PkpExecutionConfig
  unsignedTxs: readonly UnsignedPkpTx[]
  jsParams?: Record<string, unknown>
  maxTxCount?: number
  txWaitTimeoutMs?: number
  waitForReceipt?: boolean
  label: string
}

const HEX_RE = /^0x([0-9a-f]{2})+$/i

const litActionCodeCache = new Map<string, string>()

export function parseChipotleBaseUrl(raw: string | null | undefined, fieldName = "LIT_CHIPOTLE_API_BASE_URL"): ConfigResult<string> {
  const normalized = String(raw || DEFAULT_CHIPOTLE_BASE_URL).trim()
  if (!/^https?:\/\//i.test(normalized)) {
    return { ok: false, error: `Invalid ${fieldName}: ${normalized}` }
  }
  return { ok: true, value: normalized.replace(/\/+$/, "") }
}

export function parseIpfsGatewayUrl(raw: string | null | undefined, fieldName = "IPFS_GATEWAY_URL"): ConfigResult<string> {
  const normalized = String(raw || DEFAULT_IPFS_GATEWAY_URL).trim()
  if (!/^https?:\/\//i.test(normalized)) {
    return { ok: false, error: `Invalid ${fieldName}: ${normalized}` }
  }
  return { ok: true, value: normalized.replace(/\/+$/, "") }
}

export function parseLitActionCid(value: string | null | undefined, fieldName: string): ConfigResult<`ipfs://${string}`> {
  const canonical = toCanonicalIpfsUri(value)
  if (!canonical) {
    return { ok: false, error: `Invalid ${fieldName}: ${String(value || "").trim() || "<empty>"}` }
  }
  return { ok: true, value: canonical as `ipfs://${string}` }
}

export function parseOptionalPkpPublicKey(value: string | null | undefined, fieldName: string): ConfigResult<`0x${string}` | null> {
  const normalized = String(value || "").trim()
  if (!normalized) return { ok: true, value: null }
  if (!/^0x[0-9a-fA-F]{66}$|^0x[0-9a-fA-F]{130}$/i.test(normalized)) {
    return { ok: false, error: `Invalid ${fieldName}` }
  }
  return { ok: true, value: normalized as `0x${string}` }
}

export function assertPkpPublicKeyMatchesAddress(params: {
  pkpAddress: string
  pkpPublicKey: `0x${string}` | null
  addressField: string
  publicKeyField: string
}): ConfigResult<null> {
  if (!params.pkpPublicKey) return { ok: true, value: null }
  let derivedAddress: string
  try {
    derivedAddress = getAddress(computeAddress(params.pkpPublicKey))
  } catch {
    return { ok: false, error: `Invalid ${params.publicKeyField}` }
  }
  if (derivedAddress.toLowerCase() !== getAddress(params.pkpAddress).toLowerCase()) {
    return {
      ok: false,
      error: `${params.publicKeyField} does not match ${params.addressField} (${derivedAddress} != ${getAddress(params.pkpAddress)})`,
    }
  }
  return { ok: true, value: null }
}

export async function executeChipotleLitAction(params: ChipotleExecutionConfig & {
  jsParams: Record<string, unknown>
}): Promise<LitActionResponse> {
  const compatJsParams = {
    ...(params.jsParams || {}),
    jsParams: params.jsParams,
  }
  const actionCode = await resolveLitActionCode({
    actionCid: params.actionCid,
    ipfsGatewayUrl: params.ipfsGatewayUrl,
  })
  const response = await fetch(`${params.baseUrl}/core/v1/lit_action`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": params.apiKey,
    },
    body: JSON.stringify({
      code: actionCode,
      js_params: compatJsParams,
      jsParams: compatJsParams,
    }),
  })
  const rawText = await response.text()
  if (!response.ok) {
    throw new Error(`chipotle_http_error:${response.status}:${rawText.slice(0, 400)}`)
  }
  try {
    return JSON.parse(rawText) as LitActionResponse
  } catch {
    throw new Error("chipotle_invalid_json")
  }
}

export function previewLitActionFailure(payload: LitActionResponse, errorPrefix: string): Error {
  const responsePreview = typeof payload.response === "string"
    ? payload.response
    : JSON.stringify(payload.response || "")
  const logsPreview = typeof payload.logs === "string"
    ? payload.logs
    : JSON.stringify(payload.logs || "")
  return new Error(`${errorPrefix}:${(responsePreview || logsPreview).slice(0, 500)}`)
}

export function extractLitSerializedTx(payload: LitActionResponse): `0x${string}` {
  return extractLitSerializedTxs(payload)[0]!
}

export function extractLitSerializedTxs(payload: LitActionResponse): `0x${string}`[] {
  let parsed: Record<string, unknown> | null = null
  if (typeof payload.response === "string" && payload.response.trim()) {
    try {
      parsed = JSON.parse(payload.response) as Record<string, unknown>
    } catch {
      parsed = null
    }
  } else if (payload.response && typeof payload.response === "object" && !Array.isArray(payload.response)) {
    parsed = payload.response as Record<string, unknown>
  }

  if (Array.isArray(parsed?.serializedTxs) && parsed.serializedTxs.length > 0) {
    return parsed.serializedTxs.map((value, index) => parseHex(value, `lit.response.serializedTxs[${index}]`))
  }
  if (typeof parsed?.serializedTx === "string") {
    return [parseHex(parsed.serializedTx, "lit.response.serializedTx")]
  }
  throw new Error("chipotle_missing_serialized_txs")
}

export async function resolveUnsignedContractTx(params: {
  provider: JsonRpcProvider
  chainId: number
  from: string
  contractAddress: string
  abi: readonly string[]
  functionName: string
  args: readonly unknown[]
  gasPolicy: DirectTxGasPolicy
  value?: bigint
  nonce?: number
}): Promise<UnsignedPkpTx> {
  const to = getAddress(params.contractAddress)
  const iface = new Interface(params.abi)
  const data = iface.encodeFunctionData(params.functionName, [...params.args] as never[])
  const nonce = params.nonce ?? await params.provider.getTransactionCount(params.from, "pending")
  const overrides = await resolveDirectTxFeeOverrides({
    provider: params.provider,
    from: params.from,
    to,
    data,
    value: params.value ?? 0n,
    gasPolicy: params.gasPolicy,
  })
  return {
    type: 2,
    chainId: params.chainId,
    nonce,
    to: to as `0x${string}`,
    value: params.value ?? 0n,
    data: data as `0x${string}`,
    gasLimit: overrides.gasLimit,
    maxFeePerGas: overrides.maxFeePerGas,
    maxPriorityFeePerGas: overrides.maxPriorityFeePerGas,
  }
}

export async function sendUnsignedTxsWithPkp(params: PkpSendUnsignedTxsParams): Promise<{
  txHashes: string[]
  receipts: Array<TransactionReceipt | null>
}> {
  if (!Array.isArray(params.unsignedTxs) || params.unsignedTxs.length === 0) {
    throw new Error(`${params.label}_missing_unsigned_txs`)
  }
  const maxTxCount = Number.isInteger(params.maxTxCount) && Number(params.maxTxCount) > 0
    ? Number(params.maxTxCount)
    : DEFAULT_MAX_UNSIGNED_TXS
  if (params.unsignedTxs.length > maxTxCount) {
    throw new Error(`${params.label}_too_many_unsigned_txs:${params.unsignedTxs.length}:${maxTxCount}`)
  }
  const litResponse = await executeChipotleLitAction({
    ...params.pkp,
    jsParams: {
      ...(params.jsParams || {}),
      unsignedTx: serializeUnsignedTx(params.unsignedTxs[0]!),
      unsignedTxs: params.unsignedTxs.map((tx) => serializeUnsignedTx(tx)),
      expectedSignerAddress: params.pkp.pkpAddress,
    },
  })
  if (litResponse.has_error) {
    throw previewLitActionFailure(litResponse, `${params.label}_lit_action_failed`)
  }
  const serializedTxs = extractLitSerializedTxs(litResponse)
  if (serializedTxs.length !== params.unsignedTxs.length) {
    throw new Error(`${params.label}_lit_serialized_tx_count_mismatch`)
  }

  const signedTxs = serializedTxs.map((serializedTx, index) => {
    const signedTx = Transaction.from(serializedTx)
    const expectedUnsignedHash = Transaction.from(params.unsignedTxs[index]!).unsignedHash.toLowerCase()
    if (signedTx.unsignedHash.toLowerCase() !== expectedUnsignedHash) {
      throw new Error(`${params.label}_lit_serialized_tx_mismatch:${index}`)
    }
    if (!signedTx.from || signedTx.from.toLowerCase() !== params.pkp.pkpAddress.toLowerCase()) {
      throw new Error(`${params.label}_lit_signature_signer_mismatch:${index}:${String(signedTx.from || "null")}:${params.pkp.pkpAddress}`)
    }
    return signedTx
  })

  const txHashes: string[] = []
  const receipts: Array<TransactionReceipt | null> = []
  for (let index = 0; index < signedTxs.length; index += 1) {
    const signedTx = signedTxs[index]!
    const txHash = String(signedTx.hash || "").trim()
    if (!txHash) {
      throw new Error(`${params.label}_missing_tx_hash:${index}`)
    }
    txHashes.push(txHash)
    const receipt = await broadcastSignedTransaction({
      provider: params.provider,
      signedTxSerialized: signedTx.serialized,
      txHash,
      timeoutMs: params.txWaitTimeoutMs ?? DEFAULT_TX_WAIT_TIMEOUT_MS,
      waitForReceipt: params.waitForReceipt !== false,
      label: `${params.label}_${index}`,
    })
    receipts.push(receipt)
    if (receipt && receipt.status !== 1) {
      throw new Error(`${params.label}_tx_failed:${index}`)
    }
  }
  return { txHashes, receipts }
}

export async function sendContractTxWithPkp(params: PkpSendContractTxParams): Promise<{
  txHash: string
  receipt: TransactionReceipt | null
}> {
  const unsignedTx = await resolveUnsignedContractTx({
    provider: params.provider,
    chainId: params.chainId,
    from: params.pkp.pkpAddress,
    contractAddress: params.contractAddress,
    abi: params.abi,
    functionName: params.functionName,
    args: params.args,
    gasPolicy: params.gasPolicy,
    value: params.value ?? 0n,
  })
  const sent = await sendUnsignedTxsWithPkp({
    provider: params.provider,
    pkp: params.pkp,
    unsignedTxs: [unsignedTx],
    txWaitTimeoutMs: params.txWaitTimeoutMs,
    waitForReceipt: params.waitForReceipt,
    label: params.label,
  })
  return {
    txHash: sent.txHashes[0]!,
    receipt: sent.receipts[0] ?? null,
  }
}

function serializeUnsignedTx(unsignedTx: UnsignedPkpTx): Record<string, string | number> {
  return {
    type: unsignedTx.type,
    chainId: unsignedTx.chainId,
    nonce: unsignedTx.nonce,
    to: unsignedTx.to,
    value: unsignedTx.value.toString(),
    data: unsignedTx.data,
    gasLimit: unsignedTx.gasLimit.toString(),
    maxFeePerGas: unsignedTx.maxFeePerGas.toString(),
    maxPriorityFeePerGas: unsignedTx.maxPriorityFeePerGas.toString(),
  }
}

async function broadcastSignedTransaction(params: {
  provider: JsonRpcProvider
  signedTxSerialized: string
  txHash: string
  timeoutMs: number
  waitForReceipt: boolean
  label: string
}): Promise<TransactionReceipt | null> {
  try {
    const broadcast = await params.provider.broadcastTransaction(params.signedTxSerialized)
    if (!params.waitForReceipt) return null
    return await waitForTransactionReceipt({
      provider: params.provider,
      txHash: params.txHash,
      waitPromise: typeof broadcast.wait === "function" ? broadcast.wait() : null,
      timeoutMs: params.timeoutMs,
      label: params.label,
    })
  } catch (error) {
    const message = normalizeErrorMessage(error).toLowerCase()
    if (!isAlreadyKnownError(message)) throw error
    if (!params.waitForReceipt) return null
    return waitForTransactionReceipt({
      provider: params.provider,
      txHash: params.txHash,
      waitPromise: null,
      timeoutMs: params.timeoutMs,
      label: params.label,
    })
  }
}

async function resolveLitActionCode(params: {
  actionCid: `ipfs://${string}`
  ipfsGatewayUrl: string
}): Promise<string> {
  const cached = litActionCodeCache.get(params.actionCid)
  if (cached) return cached
  const cid = params.actionCid.slice("ipfs://".length).trim()
  if (!cid) throw new Error(`invalid_action_cid:${params.actionCid}`)
  const fetchUrls = resolveLitActionFetchUrls(params.ipfsGatewayUrl, cid)
  let lastError = `action_code_fetch_failed:no_gateway:${cid}`
  for (const url of fetchUrls) {
    try {
      const response = await fetch(url)
      if (!response.ok) {
        lastError = `action_code_fetch_failed:${response.status}:${cid}`
        continue
      }
      const source = (await response.text()).replace(/\r\n/g, "\n")
      if (!source.trim()) {
        lastError = `action_code_empty:${cid}`
        continue
      }
      litActionCodeCache.set(params.actionCid, source)
      return source
    } catch (error) {
      lastError = `action_code_fetch_request_failed:${cid}:${normalizeErrorMessage(error)}`
    }
  }
  throw new Error(lastError)
}

export function resolveLitActionFetchUrls(ipfsGatewayUrl: string, cid: string): string[] {
  const normalizedCid = cid.trim()
  if (!normalizedCid) return []
  const out = new Set<string>()
  for (const gatewayUrl of [ipfsGatewayUrl, ...DEFAULT_IPFS_FALLBACK_GATEWAY_URLS]) {
    const normalizedGateway = String(gatewayUrl || "").trim().replace(/\/+$/, "")
    if (!normalizedGateway) continue
    out.add(`${normalizedGateway}/${normalizedCid}`)
  }
  return [...out]
}

async function waitForTransactionReceipt(params: {
  provider: JsonRpcProvider
  txHash: string
  waitPromise: Promise<TransactionReceipt | null> | null
  timeoutMs: number
  label: string
}): Promise<TransactionReceipt | null> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${params.label}_tx_wait_timeout`)), params.timeoutMs)
  })

  try {
    if (params.waitPromise) {
      return await Promise.race([params.waitPromise, timeout])
    }

    const pollReceipt = (async () => {
      while (true) {
        const receipt = await params.provider.getTransactionReceipt(params.txHash)
        if (receipt) return receipt
        await delay(TX_RECEIPT_POLL_MS)
      }
    })()

    return await Promise.race([pollReceipt, timeout])
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId)
  }
}

function parseHex(value: unknown, fieldName: string): `0x${string}` {
  if (typeof value !== "string") throw new Error(`Missing ${fieldName}`)
  const withPrefix = value.trim().startsWith("0x") ? value.trim() : `0x${value.trim()}`
  if (!HEX_RE.test(withPrefix)) throw new Error(`Invalid ${fieldName}`)
  return withPrefix.toLowerCase() as `0x${string}`
}

function isAlreadyKnownError(message: string): boolean {
  return message.includes("already known") || message.includes("already imported")
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error || "")
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
