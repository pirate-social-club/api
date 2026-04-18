import { JsonRpcProvider, Wallet, getAddress } from "ethers"
import type { Env } from "../../types"
import { resolveDirectTxGasPolicy, sendContractTxWithPolicy } from "../evm-direct-tx"
import { parseExpectedEvmAddress } from "../evm-signer"
import { resolveStorySettlementDirectSigner } from "./story-direct-signer"
import { ensureStorySettlementOperatorAuthorized } from "./story-runtime-authorization"
import {
  STORY_DELIVERY_CONTRACTS,
  resolveStoryChainId,
  resolveStoryRpcUrl,
  resolveStoryTxWaitTimeoutMs,
} from "./story-runtime-config"

const MARKETPLACE_SETTLEMENT_ABI = [
  "function settlePurchase(bytes32 purchaseRef, address buyer, uint256 tokenId, address payoutRecipient)",
] as const

type StoryPurchaseSettlementInput = {
  env: Env
  purchaseRef: `0x${string}`
  buyerAddress: string
  entitlementTokenId: bigint
  payoutRecipient: string
  amountWei: bigint
}

let testSettlementExecutor: ((input: StoryPurchaseSettlementInput) => Promise<{ settlementTxHash: string }>) | null = null

export function setStoryPurchaseSettlementExecutorForTests(
  executor: ((input: StoryPurchaseSettlementInput) => Promise<{ settlementTxHash: string }>) | null,
): void {
  testSettlementExecutor = executor
}

export async function settlePurchaseOnStory(input: {
  env: Env
  purchaseRef: `0x${string}`
  buyerAddress: string
  entitlementTokenId: bigint
  payoutRecipient: string
  amountWei: bigint
}): Promise<{ settlementTxHash: string }> {
  if (testSettlementExecutor) {
    return await testSettlementExecutor(input)
  }
  const settlementConfig = resolveStorySettlementDirectSigner(input.env)
  if (!settlementConfig.ok) throw new Error(settlementConfig.error)
  if (!settlementConfig.value) {
    throw new Error("MUSIC_PURCHASE_STORY_SETTLEMENT_PRIVATE_KEY missing/invalid")
  }

  const buyerAddress = parseExpectedEvmAddress(input.buyerAddress)
  if (!buyerAddress) throw new Error("buyerAddress missing/invalid")
  const payoutRecipient = parseExpectedEvmAddress(input.payoutRecipient)
  if (!payoutRecipient) throw new Error("payoutRecipient missing/invalid")
  if (input.amountWei <= 0n) throw new Error("settlement amount must be positive")

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

  const provider = new JsonRpcProvider(resolveStoryRpcUrl(input.env), resolveStoryChainId(input.env))
  const settlementSigner = new Wallet(settlementConfig.value.privateKey, provider)
  await ensureStorySettlementOperatorAuthorized({
    env: input.env,
    provider,
    operatorAddress: settlementSigner.address,
  })
  const settlementTx = await sendContractTxWithPolicy({
    provider,
    signer: settlementSigner,
    contractAddress: STORY_DELIVERY_CONTRACTS.marketplaceSettlementV1,
    abi: MARKETPLACE_SETTLEMENT_ABI,
    functionName: "settlePurchase",
    args: [
      input.purchaseRef,
      getAddress(buyerAddress),
      input.entitlementTokenId,
      getAddress(payoutRecipient),
    ],
    gasPolicy: gasPolicy.value,
    value: input.amountWei,
  })
  const settlementReceipt = await provider.waitForTransaction(
    String(settlementTx.hash || ""),
    1,
    resolveStoryTxWaitTimeoutMs(input.env),
  )
  if (!settlementReceipt || settlementReceipt.status !== 1) {
    throw new Error("story_settle_purchase_failed")
  }
  return { settlementTxHash: String(settlementTx.hash || "") }
}
