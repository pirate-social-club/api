import { Interface, JsonRpcProvider, getAddress, zeroPadValue } from "ethers"
import { badRequestError, fundingConfirmationTimeout } from "../../errors"
import type { Env } from "../../../env"
import type { Client } from "../../sql-client"
import { parseJsonValue, type PurchaseQuoteRow } from "./row-types"
import { toChainRefString } from "./row-types"
import {
  resolvePirateCheckoutOperatorAddress,
  resolvePirateCheckoutRpcUrl,
  resolvePirateCheckoutSourceChainId,
  resolvePirateCheckoutTxWaitTimeoutMs,
  resolvePirateCheckoutUsdcTokenAddress,
} from "./checkout-config"
import {
  beginPurchaseSettlementEffectAttempt,
  confirmPurchaseSettlementEffect,
  failPurchaseSettlementEffect,
} from "./settlement-effects"

const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
const ERC20_TRANSFER_INTERFACE = new Interface([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
])

function isTransactionWaitTimeout(error: unknown): boolean {
  const candidate = error as { code?: unknown; shortMessage?: unknown; message?: unknown } | null
  const code = typeof candidate?.code === "string" ? candidate.code : ""
  const message = [
    typeof candidate?.shortMessage === "string" ? candidate.shortMessage : "",
    typeof candidate?.message === "string" ? candidate.message : "",
  ].join(" ").toLowerCase()
  return code === "TIMEOUT" || message.includes("timeout") || message.includes("timed out")
}

export type BuyerFundingReceipt = {
  txRef: string
  fromAddress: string | null
  toAddress: string
  tokenAddress: string
  amountAtomic: string
  chainRef: string
}

let testBuyerFundingVerifier:
  | ((input: {
    env: Env
    quote: PurchaseQuoteRow
    buyerAddress: string
    fundingTxRef: string
  }) => Promise<BuyerFundingReceipt>)
  | null = null

export function setCommunityCommerceBuyerFundingVerifierForTests(
  verifier: typeof testBuyerFundingVerifier,
): void {
  testBuyerFundingVerifier = verifier
}

function requireCheckoutFundingAmountAtomic(quote: PurchaseQuoteRow): bigint {
  if (!Number.isFinite(quote.final_price_usd) || quote.final_price_usd <= 0) {
    throw badRequestError("Quote funding amount is invalid")
  }
  const micros = Math.round(quote.final_price_usd * 1_000_000)
  if (micros <= 0) {
    throw badRequestError("Quote funding amount is below USDC precision")
  }
  return BigInt(micros)
}

function topicAddress(topic: string): string | null {
  if (!/^0x[a-fA-F0-9]{64}$/.test(topic)) {
    return null
  }
  return getAddress(`0x${topic.slice(26)}`)
}

async function verifyPirateCheckoutUsdcFundingReceipt(input: {
  env: Env
  quote: PurchaseQuoteRow
  buyerAddress: string
  fundingTxRef: string
}): Promise<BuyerFundingReceipt> {
  if (testBuyerFundingVerifier) {
    return await testBuyerFundingVerifier(input)
  }
  if (input.quote.route_provider !== "pirate_checkout") {
    throw badRequestError("Only Pirate checkout funding receipts are supported")
  }
  if (input.quote.funding_mode !== "routed") {
    throw badRequestError("Story royalty commerce requires routed checkout funding")
  }

  const expectedAmount = requireCheckoutFundingAmountAtomic(input.quote)
  const sourceChain = parseJsonValue(input.quote.source_chain_json, {
    chain_namespace: "eip155",
    chain_id: resolvePirateCheckoutSourceChainId(input.env),
    display_name: "Base",
  })
  const expectedSourceChainId = resolvePirateCheckoutSourceChainId(input.env)
  if (sourceChain.chain_namespace !== "eip155" || Number(sourceChain.chain_id) !== expectedSourceChainId) {
    throw badRequestError("Funding receipt chain does not match quote source chain")
  }
  const expectedRecipient = getAddress(input.quote.funding_destination_address || resolvePirateCheckoutOperatorAddress(input.env))
  const expectedSender = getAddress(input.buyerAddress)
  const expectedToken = getAddress(resolvePirateCheckoutUsdcTokenAddress(input.env))

  const provider = new JsonRpcProvider(resolvePirateCheckoutRpcUrl(input.env), expectedSourceChainId)
  const txWaitTimeoutMs = resolvePirateCheckoutTxWaitTimeoutMs(input.env)
  let receipt: Awaited<ReturnType<typeof provider.waitForTransaction>>
  try {
    receipt = await provider.waitForTransaction(
      input.fundingTxRef,
      1,
      txWaitTimeoutMs,
    )
  } catch (error) {
    if (isTransactionWaitTimeout(error)) {
      console.warn("[pirate-checkout] funding confirmation timed out", {
        quoteId: input.quote.quote_id,
        fundingTxRef: input.fundingTxRef,
        sourceChainId: expectedSourceChainId,
        timeoutMs: txWaitTimeoutMs,
      })
      throw fundingConfirmationTimeout(
        "Funding transaction confirmation timed out",
        {
          quote_id: input.quote.quote_id,
          funding_tx_ref: input.fundingTxRef,
          source_chain_id: expectedSourceChainId,
          timeout_ms: txWaitTimeoutMs,
        },
      )
    }
    throw error
  }
  if (!receipt || receipt.status !== 1) {
    throw badRequestError("Funding transaction is not confirmed")
  }

  const expectedRecipientTopic = zeroPadValue(expectedRecipient, 32).toLowerCase()
  const expectedSenderTopic = zeroPadValue(expectedSender, 32).toLowerCase()
  let matched: BuyerFundingReceipt | null = null
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== expectedToken) {
      continue
    }
    const [topic0, fromTopic, toTopic] = log.topics
    if (String(topic0).toLowerCase() !== ERC20_TRANSFER_TOPIC) {
      continue
    }
    if (String(toTopic).toLowerCase() !== expectedRecipientTopic) {
      continue
    }
    if (String(fromTopic).toLowerCase() !== expectedSenderTopic) {
      continue
    }
    const parsed = ERC20_TRANSFER_INTERFACE.parseLog({
      topics: [...log.topics],
      data: log.data,
    })
    const amount = parsed?.args.value as bigint | undefined
    if (amount == null || amount < expectedAmount) {
      continue
    }
    matched = {
      txRef: input.fundingTxRef,
      fromAddress: topicAddress(String(fromTopic)),
      toAddress: expectedRecipient,
      tokenAddress: expectedToken,
      amountAtomic: amount.toString(),
      chainRef: toChainRefString(sourceChain),
    }
    break
  }
  if (!matched) {
    throw badRequestError("Funding transaction did not deliver enough USDC to the checkout operator")
  }
  return matched
}

export async function verifyPirateCheckoutUsdcFunding(input: {
  env: Env
  quoteId: string
  amountUsd: number
  buyerAddress: string
  fundingTxRef: string
}): Promise<BuyerFundingReceipt> {
  const now = new Date().toISOString()
  return await verifyPirateCheckoutUsdcFundingReceipt({
    env: input.env,
    buyerAddress: input.buyerAddress,
    fundingTxRef: input.fundingTxRef,
    quote: {
      quote_id: input.quoteId,
      community_id: "global_handles",
      listing_id: "global_handle_paid_quote",
      buyer_user_id: "",
      asset_id: null,
      live_room_id: null,
      base_price_usd: input.amountUsd,
      pricing_tier: "global_handle_paid",
      final_price_usd: input.amountUsd,
      allocation_snapshot_json: null,
      funding_mode: "routed",
      funding_asset_json: null,
      source_chain_json: JSON.stringify({
        chain_namespace: "eip155",
        chain_id: resolvePirateCheckoutSourceChainId(input.env),
        display_name: "Base",
      }),
      route_provider: "pirate_checkout",
      funding_destination_address: resolvePirateCheckoutOperatorAddress(input.env),
      route_policy_compliant: true,
      route_live_available: true,
      policy_origin: "default",
      destination_settlement_chain_json: "{}",
      destination_settlement_token: "USDC",
      destination_settlement_amount_atomic: null,
      destination_settlement_decimals: null,
      treasury_denomination: "USD",
      quote_ttl_seconds: 0,
      route_required: true,
      route_status_policy: "fail",
      route_hop_tolerance: 0,
      settlement_mode: "delivery_only_story_settlement",
      verification_snapshot_ref: null,
      pricing_policy_version: null,
      status: "active",
      quoted_at: now,
      expires_at: now,
      consumed_at: null,
      failed_at: null,
      created_at: now,
      updated_at: now,
    },
  })
}

export async function confirmBuyerFundingForSettlement(input: {
  env: Env
  client: Client
  communityId: string
  quote: PurchaseQuoteRow
  purchaseId: string
  buyerAddress: string
  fundingTxRef: string
  now: string
}): Promise<BuyerFundingReceipt> {
  const txRef = input.fundingTxRef.trim()
  if (!txRef) {
    throw badRequestError("funding_tx_ref is required")
  }
  const idempotencyKey = `${input.quote.quote_id}:buyer_funding:${txRef}`
  const effect = await beginPurchaseSettlementEffectAttempt({
    client: input.client,
    communityId: input.communityId,
    quoteId: input.quote.quote_id,
    purchaseId: input.purchaseId,
    effectKind: "buyer_funding_receipt",
    effectKey: txRef,
    idempotencyKey,
    now: input.now,
  })
  if (effect.status === "confirmed") {
    const metadata = effect.metadata_json ? JSON.parse(effect.metadata_json) as BuyerFundingReceipt : null
    if (!metadata) {
      throw badRequestError("Funding receipt metadata is missing")
    }
    return metadata
  }
  try {
    const receipt = await verifyPirateCheckoutUsdcFundingReceipt({
      env: input.env,
      quote: input.quote,
      buyerAddress: input.buyerAddress,
      fundingTxRef: txRef,
    })
    await confirmPurchaseSettlementEffect({
      client: input.client,
      idempotencyKey,
      settlementRef: receipt.txRef,
      metadataJson: JSON.stringify(receipt),
      now: input.now,
    })
    return receipt
  } catch (error) {
    await failPurchaseSettlementEffect({
      client: input.client,
      idempotencyKey,
      failureReason: error instanceof Error ? error.message : String(error),
      now: input.now,
    })
    throw error
  }
}
