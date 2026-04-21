import { Contract, JsonRpcProvider, Wallet, getAddress } from "ethers"
import type { Env } from "../../../types"
import { badRequestError } from "../../errors"
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

function requireEnvValue(env: Env, key: keyof Env): string {
  const value = String(env[key] || "").trim()
  if (!value) {
    throw badRequestError(`${String(key)} is not configured`)
  }
  return value
}

function resolveEndaomentPayoutConfig(env: Env): {
  privateKey: string
  rpcUrl: string
  chainId: number
  usdcTokenAddress: string
  registryAddress: string
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
  const registryAddress = parseExpectedEvmAddress(requireEnvValue(env, "ENDAOMENT_REGISTRY_ADDRESS"))
  if (!registryAddress) {
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

async function waitForConfirmedTx(input: {
  provider: JsonRpcProvider
  txHash: string
  timeoutMs: number
  failureCode: string
}): Promise<void> {
  const receipt = await input.provider.waitForTransaction(input.txHash, 1, input.timeoutMs)
  if (!receipt || receipt.status !== 1) {
    throw badRequestError(input.failureCode)
  }
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
  const registry = new Contract(config.registryAddress, ENDAOMENT_REGISTRY_ABI, provider)
  const usdc = new Contract(config.usdcTokenAddress, ERC20_ABI, signer)
  const amount = resolveUsdcAmountAtomic(input.amountUsd)

  const isActiveEntity = await registry.isActiveEntity(getAddress(entityAddress)) as boolean
  if (!isActiveEntity) {
    throw badRequestError("Endaoment entity is not active")
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
    await waitForConfirmedTx({
      provider,
      txHash: String(approveTx.hash || ""),
      timeoutMs: config.txWaitTimeoutMs,
      failureCode: "endaoment_usdc_approval_failed",
    })
  }

  const donationTx = await entity.donate(amount)
  const donationTxHash = String(donationTx.hash || "")
  if (!donationTxHash) {
    throw badRequestError("endaoment_donation_missing_tx_hash")
  }
  await waitForConfirmedTx({
    provider,
    txHash: donationTxHash,
    timeoutMs: config.txWaitTimeoutMs,
    failureCode: "endaoment_donation_failed",
  })

  return {
    settlementRef: donationTxHash,
    providerReceiptRef: `endaoment:${config.chainId}:${getAddress(entityAddress)}:${donationTxHash}`,
    taxReceiptRef: null,
  }
}
