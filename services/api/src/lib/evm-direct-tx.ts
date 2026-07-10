import { Interface, JsonRpcProvider, Transaction, Wallet, getAddress } from "ethers"
import type { TransactionResponse } from "ethers"
import type { ConfigResult } from "./config-result"

const DEFAULT_MAX_FEE_PER_GAS_WEI = 5_000_000_000n
const DEFAULT_MAX_PRIORITY_FEE_PER_GAS_WEI = 2_000_000_000n
const DEFAULT_GAS_LIMIT_CAP = 1_500_000n
const DEFAULT_GAS_ESTIMATE_BUFFER_BPS = 12_000n
const GAS_LIMIT_PADDING = 15_000n

export type DirectTxGasPolicy = {
  maxFeePerGasCapWei: bigint
  maxPriorityFeePerGasCapWei: bigint
  gasLimitCap: bigint
  gasEstimateBufferBps: bigint
}

function parseUintEnv(raw: string | undefined, fieldName: string, fallback: bigint): ConfigResult<bigint> {
  const value = String(raw || "").trim()
  if (!value) return { ok: true, value: fallback }
  if (!/^\d+$/.test(value)) {
    return { ok: false, error: `Invalid ${fieldName}` }
  }
  try {
    const parsed = BigInt(value)
    if (parsed <= 0n) {
      return { ok: false, error: `Invalid ${fieldName}` }
    }
    return { ok: true, value: parsed }
  } catch {
    return { ok: false, error: `Invalid ${fieldName}` }
  }
}

export function resolveDirectTxGasPolicy(params: {
  maxFeePerGasCapWeiRaw?: string
  maxPriorityFeePerGasCapWeiRaw?: string
  gasLimitCapRaw?: string
  gasEstimateBufferBpsRaw?: string
  maxFeePerGasCapField: string
  maxPriorityFeePerGasCapField: string
  gasLimitCapField: string
  gasEstimateBufferBpsField: string
}): ConfigResult<DirectTxGasPolicy> {
  const maxFeePerGasCapWei = parseUintEnv(
    params.maxFeePerGasCapWeiRaw,
    params.maxFeePerGasCapField,
    DEFAULT_MAX_FEE_PER_GAS_WEI,
  )
  if (!maxFeePerGasCapWei.ok) return maxFeePerGasCapWei

  const maxPriorityFeePerGasCapWei = parseUintEnv(
    params.maxPriorityFeePerGasCapWeiRaw,
    params.maxPriorityFeePerGasCapField,
    DEFAULT_MAX_PRIORITY_FEE_PER_GAS_WEI,
  )
  if (!maxPriorityFeePerGasCapWei.ok) return maxPriorityFeePerGasCapWei

  if (maxPriorityFeePerGasCapWei.value > maxFeePerGasCapWei.value) {
    return {
      ok: false,
      error: `Invalid direct tx fee caps: ${params.maxPriorityFeePerGasCapField} > ${params.maxFeePerGasCapField}`,
    }
  }

  const gasLimitCap = parseUintEnv(
    params.gasLimitCapRaw,
    params.gasLimitCapField,
    DEFAULT_GAS_LIMIT_CAP,
  )
  if (!gasLimitCap.ok) return gasLimitCap
  if (gasLimitCap.value < 21_000n || gasLimitCap.value > 30_000_000n) {
    return { ok: false, error: `Invalid ${params.gasLimitCapField}` }
  }

  const gasEstimateBufferBps = parseUintEnv(
    params.gasEstimateBufferBpsRaw,
    params.gasEstimateBufferBpsField,
    DEFAULT_GAS_ESTIMATE_BUFFER_BPS,
  )
  if (!gasEstimateBufferBps.ok) return gasEstimateBufferBps
  if (gasEstimateBufferBps.value < 10_000n || gasEstimateBufferBps.value > 50_000n) {
    return { ok: false, error: `Invalid ${params.gasEstimateBufferBpsField}` }
  }

  return {
    ok: true,
    value: {
      maxFeePerGasCapWei: maxFeePerGasCapWei.value,
      maxPriorityFeePerGasCapWei: maxPriorityFeePerGasCapWei.value,
      gasLimitCap: gasLimitCap.value,
      gasEstimateBufferBps: gasEstimateBufferBps.value,
    },
  }
}

async function resolveDirectTxFeeOverrides(params: {
  provider: JsonRpcProvider
  from: string
  to: string
  data: string
  value?: bigint
  gasPolicy: DirectTxGasPolicy
}): Promise<{ gasLimit: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const feeData = await params.provider.getFeeData()
  let maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? feeData.gasPrice ?? params.gasPolicy.maxPriorityFeePerGasCapWei
  let maxFeePerGas = feeData.maxFeePerGas ?? (feeData.gasPrice ? feeData.gasPrice * 2n : params.gasPolicy.maxFeePerGasCapWei)

  if (maxFeePerGas < maxPriorityFeePerGas) {
    maxFeePerGas = maxPriorityFeePerGas
  }
  if (maxPriorityFeePerGas > params.gasPolicy.maxPriorityFeePerGasCapWei) {
    maxPriorityFeePerGas = params.gasPolicy.maxPriorityFeePerGasCapWei
  }
  if (maxFeePerGas > params.gasPolicy.maxFeePerGasCapWei) {
    maxFeePerGas = params.gasPolicy.maxFeePerGasCapWei
  }
  if (maxFeePerGas < maxPriorityFeePerGas) {
    maxPriorityFeePerGas = maxFeePerGas
  }
  if (maxFeePerGas <= 0n || maxPriorityFeePerGas <= 0n) {
    throw new Error("direct_tx_fee_policy_invalid")
  }

  const estimatedGas = await params.provider.estimateGas({
    from: params.from,
    to: params.to,
    data: params.data,
    value: params.value ?? 0n,
    maxFeePerGas,
    maxPriorityFeePerGas,
  })
  const gasLimit = ((estimatedGas * params.gasPolicy.gasEstimateBufferBps) / 10_000n) + GAS_LIMIT_PADDING
  if (gasLimit > params.gasPolicy.gasLimitCap) {
    throw new Error(`direct_tx_gas_limit_exceeds_policy:${gasLimit.toString()}:${params.gasPolicy.gasLimitCap.toString()}`)
  }

  return {
    gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas,
  }
}

export async function sendContractTxWithPolicy(params: {
  provider: JsonRpcProvider
  signer: Wallet
  contractAddress: string
  abi: readonly string[]
  functionName: string
  args: readonly unknown[]
  gasPolicy: DirectTxGasPolicy
  value?: bigint
}): Promise<TransactionResponse> {
  const to = getAddress(params.contractAddress)
  const iface = new Interface(params.abi)
  const data = iface.encodeFunctionData(params.functionName, [...params.args] as never[])
  const overrides = await resolveDirectTxFeeOverrides({
    provider: params.provider,
    from: params.signer.address,
    to,
    data,
    value: params.value ?? 0n,
    gasPolicy: params.gasPolicy,
  })
  try {
    return await params.signer.sendTransaction({
      to,
      data,
      value: params.value ?? 0n,
      gasLimit: overrides.gasLimit,
      maxFeePerGas: overrides.maxFeePerGas,
      maxPriorityFeePerGas: overrides.maxPriorityFeePerGas,
    })
  } catch (error) {
    const alreadyKnownTxHash = extractAlreadyKnownRawTransactionHash(error)
    if (!alreadyKnownTxHash) {
      throw error
    }
    return {
      hash: alreadyKnownTxHash,
      wait: async (confirms?: number, timeout?: number) => {
        return await params.provider.waitForTransaction(alreadyKnownTxHash, confirms, timeout)
      },
    } as TransactionResponse
  }
}

export function extractAlreadyKnownRawTransactionHash(error: unknown): string | null {
  if (!isAlreadyKnownTransactionError(error)) {
    return null
  }
  const rawTransaction = extractRawTransactionFromError(error)
  if (!rawTransaction) {
    return null
  }
  try {
    return Transaction.from(rawTransaction).hash
  } catch {
    return null
  }
}

function isAlreadyKnownTransactionError(error: unknown): boolean {
  const directMessage = typeof error === "object" && error != null && "message" in error
    ? String((error as { message?: unknown }).message ?? "")
    : String(error ?? "")
  const nestedMessage = typeof error === "object" && error != null && "error" in error
    ? String((error as { error?: { message?: unknown } }).error?.message ?? "")
    : ""
  return /\balready known\b/i.test(directMessage) || /\balready known\b/i.test(nestedMessage)
}

function extractRawTransactionFromError(error: unknown): string | null {
  if (typeof error !== "object" || error == null) {
    return null
  }
  const payloadParams = (error as { payload?: { params?: unknown } }).payload?.params
  if (Array.isArray(payloadParams) && typeof payloadParams[0] === "string" && payloadParams[0].startsWith("0x")) {
    return payloadParams[0]
  }
  return null
}
