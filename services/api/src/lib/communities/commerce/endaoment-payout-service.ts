import { Contract, JsonRpcProvider, Wallet, getAddress } from "ethers"
import type { Env } from "../../../env"
import { badRequestError, conflictError } from "../../errors"
import { parseExpectedEvmAddress } from "../../evm-signer"
import { normalizeDirectSignerPrivateKey } from "../../story/story-direct-signer"
import type { CharityPayoutExecutionInput, CharityPayoutExecutionResult } from "./charity-payout-service"
import {
  resolvePirateCheckoutRpcUrl,
  resolvePirateCheckoutSourceChainId,
  resolvePirateCheckoutUsdcTokenAddress,
} from "./checkout-config"

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
] as const

const ENDAOMENT_ENTITY_ABI = [
  "function donate(uint256 amount)",
] as const

const ENDAOMENT_REGISTRY_ABI = [
  "function isActiveEntity(address entity) view returns (bool)",
] as const

function resolveEndaomentPayoutConfig(env: Env): {
  privateKey: string
  rpcUrl: string
  chainId: number
  usdcTokenAddress: string
  registryAddress: string | null
  txWaitTimeoutMs: number
} {
  const privateKey = normalizeDirectSignerPrivateKey(
    String(env.ENDAOMENT_PAYOUT_PRIVATE_KEY || env.PIRATE_CHECKOUT_OPERATOR_PRIVATE_KEY || "").trim(),
  )
  if (!privateKey) {
    throw badRequestError("ENDAOMENT_PAYOUT_PRIVATE_KEY or PIRATE_CHECKOUT_OPERATOR_PRIVATE_KEY is invalid")
  }
  const checkoutChainId = resolvePirateCheckoutSourceChainId(env)
  const chainId = Number(String(env.ENDAOMENT_CHAIN_ID || resolvePirateCheckoutSourceChainId(env)).trim())
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw badRequestError("ENDAOMENT_CHAIN_ID is invalid")
  }
  if (chainId !== checkoutChainId) {
    throw badRequestError("ENDAOMENT_CHAIN_ID must match PIRATE_CHECKOUT_SOURCE_CHAIN_ID")
  }
  const usdcTokenAddress = parseExpectedEvmAddress(
    String(env.ENDAOMENT_USDC_TOKEN_ADDRESS || resolvePirateCheckoutUsdcTokenAddress(env)).trim(),
  )
  if (!usdcTokenAddress) {
    throw badRequestError("ENDAOMENT_USDC_TOKEN_ADDRESS is invalid")
  }
  const rawRegistryAddress = String(env.ENDAOMENT_REGISTRY_ADDRESS || "").trim()
  const registryAddress = rawRegistryAddress ? parseExpectedEvmAddress(rawRegistryAddress) : null
  if (rawRegistryAddress && !registryAddress) {
    throw badRequestError("ENDAOMENT_REGISTRY_ADDRESS is invalid")
  }
  const txWaitTimeoutMs = Number(String(env.ENDAOMENT_TX_WAIT_TIMEOUT_MS || "120000").trim())
  if (!Number.isFinite(txWaitTimeoutMs) || txWaitTimeoutMs < 1_000) {
    throw badRequestError("ENDAOMENT_TX_WAIT_TIMEOUT_MS is invalid")
  }
  return {
    privateKey,
    rpcUrl: String(env.ENDAOMENT_RPC_URL || resolvePirateCheckoutRpcUrl(env)).trim(),
    chainId,
    usdcTokenAddress,
    registryAddress,
    txWaitTimeoutMs: Math.trunc(txWaitTimeoutMs),
  }
}

export function assertEndaomentPayoutConfigured(env: Env): void {
  resolveEndaomentPayoutConfig(env)
}

export type EndaomentSubmittedDonationReconciliationResult =
  | {
    status: "pending"
  }
  | {
    status: "confirmed"
    settlementRef: string
    providerReceiptRef: string
  }
  | {
    status: "failed"
    reason: string
  }

let testEndaomentSubmittedDonationReconciler:
  | ((input: {
    env: Env
    txHash: string
    metadata: Record<string, unknown>
  }) => Promise<EndaomentSubmittedDonationReconciliationResult>)
  | null = null

export function setEndaomentSubmittedDonationReconcilerForTests(
  reconciler: typeof testEndaomentSubmittedDonationReconciler,
): void {
  testEndaomentSubmittedDonationReconciler = reconciler
}

function resolveUsdcAmountAtomic(amountUsd: number): bigint {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw badRequestError("Donation amount must be positive")
  }
  const amountAtomic = BigInt(Math.round(amountUsd * 1_000_000))
  if (amountAtomic <= 0n) {
    throw badRequestError("Donation amount is below USDC precision")
  }
  return amountAtomic
}

function isTransactionWaitTimeout(error: unknown): boolean {
  const candidate = error as { code?: unknown; shortMessage?: unknown; message?: unknown } | null
  const code = typeof candidate?.code === "string" ? candidate.code : ""
  const message = [
    typeof candidate?.shortMessage === "string" ? candidate.shortMessage : "",
    typeof candidate?.message === "string" ? candidate.message : "",
  ].join(" ").toLowerCase()
  return code === "TIMEOUT" || message.includes("timeout") || message.includes("timed out")
}

async function waitForConfirmedTx(input: {
  provider: JsonRpcProvider
  txHash: string
  timeoutMs: number
  failureCode: string
}): Promise<"confirmed" | "pending"> {
  const receipt = await input.provider.waitForTransaction(input.txHash, 1, input.timeoutMs).catch((error: unknown) => {
    if (isTransactionWaitTimeout(error)) {
      return null
    }
    throw error
  })
  if (!receipt) {
    return "pending"
  }
  if (receipt.status !== 1) {
    throw badRequestError(input.failureCode)
  }
  return "confirmed"
}

export async function executeEndaomentUsdcDonation(
  input: CharityPayoutExecutionInput,
): Promise<CharityPayoutExecutionResult> {
  if (input.provider !== "endaoment") {
    throw badRequestError("Donation partner provider is not supported")
  }
  const entityAddress = parseExpectedEvmAddress(input.payoutDestinationRef)
  if (!entityAddress) {
    throw badRequestError("Endaoment payout destination must be an entity contract address")
  }

  const config = resolveEndaomentPayoutConfig(input.env)
  const provider = new JsonRpcProvider(config.rpcUrl, config.chainId)
  const signer = new Wallet(config.privateKey, provider)
  const entity = new Contract(getAddress(entityAddress), ENDAOMENT_ENTITY_ABI, signer)
  const usdc = new Contract(config.usdcTokenAddress, ERC20_ABI, signer)
  const amount = resolveUsdcAmountAtomic(input.amountUsd)

  if (config.registryAddress) {
    const registry = new Contract(config.registryAddress, ENDAOMENT_REGISTRY_ABI, provider)
    const isActiveEntity = await registry.isActiveEntity(getAddress(entityAddress)) as boolean
    if (!isActiveEntity) {
      throw badRequestError("Endaoment entity is not active")
    }
  }
  const decimals = Number(await usdc.decimals())
  if (decimals !== 6) {
    throw badRequestError("Endaoment base token must be USDC with 6 decimals")
  }
  const balance = await usdc.balanceOf(signer.address) as bigint
  if (balance < amount) {
    throw badRequestError("Endaoment payout signer has insufficient USDC")
  }
  const allowance = await usdc.allowance(signer.address, getAddress(entityAddress)) as bigint
  if (allowance < amount) {
    const approveTx = await usdc.approve(getAddress(entityAddress), amount)
    const approvalStatus = await waitForConfirmedTx({
      provider,
      txHash: String(approveTx.hash || ""),
      timeoutMs: config.txWaitTimeoutMs,
      failureCode: "endaoment_usdc_approval_failed",
    })
    if (approvalStatus === "pending") {
      throw badRequestError("endaoment_usdc_approval_pending")
    }
  }

  const donationTx = await entity.donate(amount)
  const donationTxHash = String(donationTx.hash || "")
  if (!donationTxHash) {
    throw badRequestError("endaoment_donation_missing_tx_hash")
  }
  const providerReceiptRef = `endaoment:${config.chainId}:${getAddress(entityAddress)}:${donationTxHash}`
  await input.recordSubmittedTxHash?.({
    txHash: donationTxHash,
    providerReceiptRef,
    metadata: {
      provider: "endaoment",
      chain_id: config.chainId,
      entity_address: getAddress(entityAddress),
      usdc_token_address: getAddress(config.usdcTokenAddress),
      amount_usdc_atomic: amount.toString(),
    },
  })
  const donationStatus = await waitForConfirmedTx({
    provider,
    txHash: donationTxHash,
    timeoutMs: config.txWaitTimeoutMs,
    failureCode: "endaoment_donation_failed",
  })
  if (donationStatus === "pending") {
    throw conflictError("Endaoment donation confirmation is pending")
  }

  return {
    settlementRef: donationTxHash,
    providerReceiptRef,
    taxReceiptRef: null,
  }
}

export async function reconcileEndaomentSubmittedDonation(input: {
  env: Env
  txHash: string
  metadata: Record<string, unknown>
}): Promise<EndaomentSubmittedDonationReconciliationResult> {
  if (testEndaomentSubmittedDonationReconciler) {
    return await testEndaomentSubmittedDonationReconciler(input)
  }
  const txHash = input.txHash.trim()
  if (!txHash) {
    return { status: "failed", reason: "endaoment_submitted_tx_hash_missing" }
  }
  const config = resolveEndaomentPayoutConfig(input.env)
  const provider = new JsonRpcProvider(config.rpcUrl, config.chainId)
  const receipt = await provider.getTransactionReceipt(txHash)
  if (!receipt) {
    return { status: "pending" }
  }
  if (receipt.status !== 1) {
    return { status: "failed", reason: "endaoment_donation_failed" }
  }

  const expectedEntity = parseExpectedEvmAddress(String(input.metadata.entity_address ?? ""))
  const receiptTo = parseExpectedEvmAddress(String((receipt as { to?: unknown }).to ?? ""))
  if (expectedEntity && receiptTo && getAddress(receiptTo) !== getAddress(expectedEntity)) {
    return { status: "failed", reason: "endaoment_donation_recipient_mismatch" }
  }
  const entityAddress = expectedEntity ? getAddress(expectedEntity) : "unknown"
  return {
    status: "confirmed",
    settlementRef: txHash,
    providerReceiptRef: `endaoment:${config.chainId}:${entityAddress}:${txHash}`,
  }
}
