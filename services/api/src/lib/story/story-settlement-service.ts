import { JsonRpcProvider, getAddress } from "ethers"
import type { Env } from "../../types"
import { resolveDirectTxGasPolicy } from "../evm-direct-tx"
import { sendContractTxWithPkp } from "../evm-chipotle"
import { parseExpectedEvmAddress } from "../evm-signer"
import {
  STORY_SETTLEMENT_ACTION,
  resolveStorySettlementPkpAction,
  resolveStorySettlementPkpExecutionConfig,
} from "./story-settlement-pkp"
import {
  STORY_DELIVERY_CONTRACTS,
  resolveStoryChainId,
  resolveStoryRpcUrl,
  resolveStoryTxWaitTimeoutMs,
} from "./story-runtime-config"

const MARKETPLACE_SETTLEMENT_ABI = [
  "function settlePurchase(bytes32 purchaseRef, address buyer, uint256 tokenId, address payoutRecipient)",
] as const

export async function settlePurchaseOnStory(input: {
  env: Env
  purchaseRef: `0x${string}`
  buyerAddress: string
  entitlementTokenId: bigint
  payoutRecipient: string
  amountWei: bigint
}): Promise<{ settlementTxHash: string }> {
  const settlementConfig = resolveStorySettlementPkpExecutionConfig(input.env)
  if (!settlementConfig.ok) throw new Error(settlementConfig.error)
  const settlePkp = resolveStorySettlementPkpAction(settlementConfig.value, STORY_SETTLEMENT_ACTION.SETTLE)
  if (!settlePkp) {
    throw new Error("STORY_SETTLEMENT_ACTION_CID_SETTLE missing/invalid")
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
  const settlementTx = await sendContractTxWithPkp({
    provider,
    chainId: resolveStoryChainId(input.env),
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
    pkp: settlePkp,
    txWaitTimeoutMs: resolveStoryTxWaitTimeoutMs(input.env),
    label: "story_settle_purchase",
    value: input.amountWei,
  })
  if (!settlementTx.receipt || settlementTx.receipt.status !== 1) {
    throw new Error("story_settle_purchase_failed")
  }
  return { settlementTxHash: settlementTx.txHash }
}
