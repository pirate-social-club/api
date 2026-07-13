import { NativeRoyaltyPolicy, StoryClient, WIP_TOKEN_ADDRESS } from "@story-protocol/core-sdk"
import { JsonRpcProvider, Wallet, getAddress } from "ethers"
import { http, zeroAddress } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import type { Env } from "../../env"
import { resolveDirectTxGasPolicy, sendContractTxWithPolicy } from "../evm-direct-tx"
import { parseExpectedEvmAddress } from "../evm-signer"
import { resolveStorySettlementDirectSigner } from "./story-direct-signer"
import { ensureStoryEntitlementMinterAuthorized } from "./story-runtime-authorization"
import {
  resolveStoryChainId,
  resolveStoryDeliveryContracts,
  resolveStoryRpcUrl,
  resolveStoryTxWaitTimeoutMs,
} from "./story-runtime-config"

const PURCHASE_ENTITLEMENT_TOKEN_ABI = [
  "function mintEntitlement(address to, uint256 tokenId, bytes32 purchaseRef) returns (bool)",
] as const

export type StoryRoyaltyPurchaseSettlementInput = {
  env: Env
  purchaseRef: `0x${string}`
  buyerAddress: string
  receiverIpId: string
  payerIpId?: string | null
  entitlementTokenId?: bigint | null
  amount: bigint
}

export type StoryRoyaltyPurchaseSettlementResult = {
  royaltyTxHash: string
  entitlementTxHash: string | null
  settlementTxHash: string
}

export type StoryRoyaltyPaymentResult = StoryRoyaltyPurchaseSettlementResult & {
  entitlementHandled: boolean
}

let testRoyaltySettlementExecutor:
  | ((input: StoryRoyaltyPurchaseSettlementInput) => Promise<StoryRoyaltyPurchaseSettlementResult>)
  | null = null
let testParentRoyaltyVaultTransferExecutor:
  | ((input: StoryParentRoyaltyVaultTransferInput) => Promise<StoryParentRoyaltyVaultTransferResult>)
  | null = null

export function setStoryRoyaltyPurchaseSettlementExecutorForTests(
  executor: ((input: StoryRoyaltyPurchaseSettlementInput) => Promise<StoryRoyaltyPurchaseSettlementResult>) | null,
): void {
  testRoyaltySettlementExecutor = executor
}

export type StoryParentRoyaltyVaultTransferInput = {
  env: Env
  childIpId: string
  parentIpId: string
  royaltyPolicy?: string | null
}

export type StoryParentRoyaltyVaultTransferResult = {
  transferTxHash: string
}

export function setStoryParentRoyaltyVaultTransferExecutorForTests(
  executor: ((input: StoryParentRoyaltyVaultTransferInput) => Promise<StoryParentRoyaltyVaultTransferResult>) | null,
): void {
  testParentRoyaltyVaultTransferExecutor = executor
}

function resolveStoryChainName(env: Pick<Env, "STORY_CHAIN_ID">): "aeneid" | "mainnet" {
  return resolveStoryChainId(env) === 1514 ? "mainnet" : "aeneid"
}

function resolveRoyaltyPolicyInput(value: string | null | undefined): string | NativeRoyaltyPolicy {
  const policy = parseExpectedEvmAddress(value)
  return policy ?? NativeRoyaltyPolicy.LAP
}

export function isRetryableStoryRoyaltyPreflightError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const isPreflightCall = message.includes("eth_fillTransaction") || message.includes("eth_call")
  return isPreflightCall
    && message.toLowerCase().includes("execution reverted")
    && !message.toLowerCase().includes("transaction hash")
}

export async function withStoryRoyaltyPreflightRetry<T>(
  operation: () => Promise<T>,
  options: {
    maxAttempts?: number
    delayMs?: number
    sleep?: (ms: number) => Promise<void>
  } = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 8
  const delayMs = options.delayMs ?? 5_000
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      if (attempt === maxAttempts || !isRetryableStoryRoyaltyPreflightError(error)) {
        throw error
      }
      await sleep(delayMs)
    }
  }

  throw new Error("story_royalty_preflight_retry_exhausted")
}

export async function payStoryRoyaltyOnBehalfForPurchase(input: StoryRoyaltyPurchaseSettlementInput): Promise<StoryRoyaltyPaymentResult> {
  if (testRoyaltySettlementExecutor) {
    return {
      ...await testRoyaltySettlementExecutor(input),
      entitlementHandled: true,
    }
  }

  const settlementConfig = resolveStorySettlementDirectSigner(input.env)
  if (!settlementConfig.ok) throw new Error(settlementConfig.error)
  if (!settlementConfig.value) {
    throw new Error("MUSIC_PURCHASE_STORY_SETTLEMENT_PRIVATE_KEY missing/invalid")
  }

  const buyerAddress = parseExpectedEvmAddress(input.buyerAddress)
  if (!buyerAddress) throw new Error("buyerAddress missing/invalid")
  const receiverIpId = parseExpectedEvmAddress(input.receiverIpId)
  if (!receiverIpId) throw new Error("receiverIpId missing/invalid")
  const payerIpId = parseExpectedEvmAddress(input.payerIpId) ?? zeroAddress
  if (input.amount <= 0n) throw new Error("royalty settlement amount must be positive")

  const storyClient = StoryClient.newClient({
    account: privateKeyToAccount(settlementConfig.value.privateKey as `0x${string}`),
    transport: http(resolveStoryRpcUrl(input.env)),
    chainId: resolveStoryChainName(input.env),
  })
  // A newly registered IP can be visible through the registry before the
  // royalty module accepts payment. Retry only simulation reverts, which are
  // known to occur before a transaction is broadcast and are therefore safe.
  const royalty = await withStoryRoyaltyPreflightRetry(() =>
    storyClient.royalty.payRoyaltyOnBehalf({
      receiverIpId: receiverIpId as `0x${string}`,
      payerIpId: payerIpId as `0x${string}`,
      token: WIP_TOKEN_ADDRESS,
      amount: input.amount,
      options: {
        wipOptions: {
          enableAutoWrapIp: true,
          enableAutoApprove: true,
        },
      },
    }),
    { maxAttempts: 24 },
  )
  const royaltyTxHash = String(royalty.txHash || "")
  if (!royaltyTxHash) {
    throw new Error("story_royalty_payment_missing_tx_hash")
  }

  return {
    royaltyTxHash,
    entitlementTxHash: null,
    settlementTxHash: royaltyTxHash,
    entitlementHandled: false,
  }
}

export async function transferStoryRoyaltyToParentVault(input: StoryParentRoyaltyVaultTransferInput): Promise<StoryParentRoyaltyVaultTransferResult> {
  if (testParentRoyaltyVaultTransferExecutor) {
    return await testParentRoyaltyVaultTransferExecutor(input)
  }

  const settlementConfig = resolveStorySettlementDirectSigner(input.env)
  if (!settlementConfig.ok) throw new Error(settlementConfig.error)
  if (!settlementConfig.value) {
    throw new Error("MUSIC_PURCHASE_STORY_SETTLEMENT_PRIVATE_KEY missing/invalid")
  }

  const childIpId = parseExpectedEvmAddress(input.childIpId)
  if (!childIpId) throw new Error("childIpId missing/invalid")
  const parentIpId = parseExpectedEvmAddress(input.parentIpId)
  if (!parentIpId) throw new Error("parentIpId missing/invalid")

  const storyClient = StoryClient.newClient({
    account: privateKeyToAccount(settlementConfig.value.privateKey as `0x${string}`),
    transport: http(resolveStoryRpcUrl(input.env)),
    chainId: resolveStoryChainName(input.env),
  })
  // Story can confirm the royalty payment before the policy exposes the
  // descendant revenue as claimable. Retry only the preflight simulation
  // revert; ambiguous post-broadcast failures must remain non-retryable.
  const transfer = await withStoryRoyaltyPreflightRetry(() =>
    storyClient.royalty.transferToVault({
      ipId: childIpId as `0x${string}`,
      ancestorIpId: parentIpId as `0x${string}`,
      royaltyPolicy: resolveRoyaltyPolicyInput(input.royaltyPolicy) as `0x${string}` | NativeRoyaltyPolicy,
      token: WIP_TOKEN_ADDRESS,
    }),
  )
  const transferTxHash = String(transfer.txHash || "")
  if (!transferTxHash) {
    throw new Error("story_parent_royalty_vault_transfer_missing_tx_hash")
  }
  return { transferTxHash }
}

export async function mintStoryRoyaltyPurchaseEntitlement(input: {
  env: Env
  purchaseRef: `0x${string}`
  buyerAddress: string
  entitlementTokenId: bigint
}): Promise<string> {
  const settlementConfig = resolveStorySettlementDirectSigner(input.env)
  if (!settlementConfig.ok) throw new Error(settlementConfig.error)
  if (!settlementConfig.value) {
    throw new Error("MUSIC_PURCHASE_STORY_SETTLEMENT_PRIVATE_KEY missing/invalid")
  }

  const buyerAddress = parseExpectedEvmAddress(input.buyerAddress)
  if (!buyerAddress) throw new Error("buyerAddress missing/invalid")
  if (input.entitlementTokenId == null) {
    throw new Error("entitlementTokenId missing/invalid")
  }

  const provider = new JsonRpcProvider(resolveStoryRpcUrl(input.env), resolveStoryChainId(input.env))
  const deliveryContracts = resolveStoryDeliveryContracts(input.env)
  const settlementSigner = new Wallet(settlementConfig.value.privateKey, provider)
  await ensureStoryEntitlementMinterAuthorized({
    env: input.env,
    provider,
    minterAddress: settlementSigner.address,
  })
  const gasPolicy = resolveDirectTxGasPolicy({
    maxFeePerGasCapWeiRaw: input.env.STORY_DIRECT_TX_MAX_FEE_PER_GAS_WEI,
    maxPriorityFeePerGasCapWeiRaw: input.env.STORY_DIRECT_TX_MAX_PRIORITY_FEE_PER_GAS_WEI,
    gasLimitCapRaw: input.env.STORY_DIRECT_TX_GAS_LIMIT_MAX,
    gasEstimateBufferBpsRaw: input.env.STORY_DIRECT_TX_GAS_ESTIMATE_BUFFER_BPS,
    maxFeePerGasCapField: "STORY_DIRECT_TX_MAX_FEE_PER_GAS_WEI",
    maxPriorityFeePerGasCapField: "STORY_DIRECT_TX_MAX_PRIORITY_FEE_PER_GAS_WEI",
    gasLimitCapField: "STORY_DIRECT_TX_GAS_LIMIT_MAX",
    gasEstimateBufferBpsField: "STORY_DIRECT_TX_GAS_ESTIMATE_BUFFER_BPS",
  })
  if (!gasPolicy.ok) throw new Error(gasPolicy.error)

  const entitlementTx = await sendContractTxWithPolicy({
    provider,
    signer: settlementSigner,
    contractAddress: deliveryContracts.purchaseEntitlementToken,
    abi: PURCHASE_ENTITLEMENT_TOKEN_ABI,
    functionName: "mintEntitlement",
    args: [
      getAddress(buyerAddress),
      input.entitlementTokenId,
      input.purchaseRef,
    ],
    gasPolicy: gasPolicy.value,
    defaultWaitTimeoutMs: resolveStoryTxWaitTimeoutMs(input.env),
  })
  const entitlementReceipt = await provider.waitForTransaction(
    String(entitlementTx.hash || ""),
    1,
    resolveStoryTxWaitTimeoutMs(input.env),
  )
  if (!entitlementReceipt || entitlementReceipt.status !== 1) {
    throw new Error("story_royalty_entitlement_mint_failed")
  }
  const entitlementTxHash = String(entitlementTx.hash || "")
  if (!entitlementTxHash) {
    throw new Error("story_royalty_entitlement_missing_tx_hash")
  }
  return entitlementTxHash
}

export async function settlePurchaseViaStoryRoyalty(input: StoryRoyaltyPurchaseSettlementInput): Promise<StoryRoyaltyPurchaseSettlementResult> {
  const royalty = await payStoryRoyaltyOnBehalfForPurchase(input)
  if (input.entitlementTokenId == null || royalty.entitlementHandled) {
    return {
      royaltyTxHash: royalty.royaltyTxHash,
      entitlementTxHash: royalty.entitlementTxHash,
      settlementTxHash: royalty.settlementTxHash,
    }
  }

  const entitlementTxHash = await mintStoryRoyaltyPurchaseEntitlement({
    env: input.env,
    purchaseRef: input.purchaseRef,
    buyerAddress: input.buyerAddress,
    entitlementTokenId: input.entitlementTokenId,
  })
  return {
    royaltyTxHash: royalty.royaltyTxHash,
    entitlementTxHash,
    settlementTxHash: royalty.settlementTxHash,
  }
}
