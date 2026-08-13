import { Interface, JsonRpcProvider, getAddress, zeroPadValue } from "ethers"
import { badRequestError, fundingConfirmationTimeout, retryableConflictError } from "../../errors"
import type { Env } from "../../../env"
import type { Client, Transaction } from "../../sql-client"
import { getControlPlaneClient } from "../../runtime-deps"
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
  confirmBuyerFundingEffectAndLockQuote,
  failPurchaseSettlementEffect,
  findConfirmedBuyerFundingEffectByTx,
} from "./settlement-effects"
import {
  claimCanonicalFundingReceipt,
  claimCanonicalFundingReceiptForReview,
} from "./observed-funding-receipts"

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
  observation?: {
    chainId: number
    logIndex: number
    blockNumber: number
    blockHash: string
    blockTimestamp?: number
  }
}

type CheckoutFundingQuote = Pick<
  PurchaseQuoteRow,
  | "quote_id"
  | "route_provider"
  | "funding_mode"
  | "final_price_cents"
  | "source_chain_json"
  | "funding_destination_address"
>

let testBuyerFundingVerifier:
  | ((input: {
    env: Env
    quote: CheckoutFundingQuote
    buyerAddress: string
    fundingTxRef: string
  }) => Promise<BuyerFundingReceipt>)
  | null = null

type BuyerFundingProvider = Pick<JsonRpcProvider, "waitForTransaction" | "getBlock">
let testBuyerFundingProviderFactory: ((rpcUrl: string, chainId: number) => BuyerFundingProvider) | null = null

export function setCommunityCommerceBuyerFundingVerifierForTests(
  verifier: typeof testBuyerFundingVerifier,
): void {
  testBuyerFundingVerifier = verifier
}

export function setBuyerFundingProviderFactoryForTests(
  factory: typeof testBuyerFundingProviderFactory,
): void {
  testBuyerFundingProviderFactory = factory
}

function requireCheckoutFundingAmountAtomic(quote: CheckoutFundingQuote): bigint {
  if (!Number.isSafeInteger(quote.final_price_cents) || quote.final_price_cents <= 0) {
    throw badRequestError("Quote funding amount is invalid")
  }
  return BigInt(quote.final_price_cents) * 10_000n
}

function topicAddress(topic: string): string | null {
  if (!/^0x[a-fA-F0-9]{64}$/.test(topic)) {
    return null
  }
  return getAddress(`0x${topic.slice(26)}`)
}

type CheckoutFundingExpectation = {
  expectedAmount: bigint
  expectedSourceChainId: number
  expectedRecipient: string
  expectedSender: string
  expectedToken: string
  chainRef: string
}

function resolveCheckoutFundingExpectation(input: {
  env: Env
  quote: CheckoutFundingQuote
  buyerAddress: string
  expectedTokenAddress?: string | null
}): CheckoutFundingExpectation {
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
  const expectedToken = getAddress(input.expectedTokenAddress || resolvePirateCheckoutUsdcTokenAddress(input.env))
  return {
    expectedAmount,
    expectedSourceChainId,
    expectedRecipient,
    expectedSender,
    expectedToken,
    chainRef: toChainRefString(sourceChain),
  }
}

async function verifyPirateCheckoutUsdcFundingReceipt(input: {
  env: Env
  quote: CheckoutFundingQuote
  buyerAddress: string
  fundingTxRef: string
  expectedTokenAddress?: string | null
  finality?: BookingPaymentFinalityPolicy
}): Promise<BuyerFundingReceipt> {
  if (testBuyerFundingVerifier) {
    return await testBuyerFundingVerifier(input)
  }
  const expected = resolveCheckoutFundingExpectation(input)
  const {
    expectedAmount,
    expectedSourceChainId,
    expectedRecipient,
    expectedSender,
    expectedToken,
    chainRef,
  } = expected

  const rpcUrl = resolvePirateCheckoutRpcUrl(input.env)
  let receipt: MinimalReceipt & { blockNumber: number; blockHash: string; logs: ReadonlyArray<FundingTransferLog> }
  let canonicalBlock: { hash: string | null; timestamp?: number } | null
  if (input.finality) {
    const finalized = await resolveFinalizedPaymentReceipt({
      provider: createFinalityProvider(rpcUrl, expectedSourceChainId),
      fundingTxRef: input.fundingTxRef,
      expected: {
        chainId: expectedSourceChainId,
        tokenAddress: expectedToken,
        recipientAddress: expectedRecipient,
        amountAtomic: expectedAmount,
        senderAddress: expectedSender,
      },
      finality: input.finality,
    })
    if (finalized.kind === "pending") {
      throw retryableConflictError("Funding transaction is not final", {
        funding_tx_ref: input.fundingTxRef,
        reason: finalized.reason,
      })
    }
    receipt = finalized.receipt
    canonicalBlock = finalized.block
  } else {
    const provider = testBuyerFundingProviderFactory?.(rpcUrl, expectedSourceChainId)
      ?? new JsonRpcProvider(rpcUrl, expectedSourceChainId)
    const txWaitTimeoutMs = resolvePirateCheckoutTxWaitTimeoutMs(input.env)
    let waitedReceipt: Awaited<ReturnType<typeof provider.waitForTransaction>>
    try {
      waitedReceipt = await provider.waitForTransaction(
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
    if (!waitedReceipt || waitedReceipt.status !== 1) {
      throw badRequestError("Funding transaction is not confirmed")
    }
    receipt = waitedReceipt as MinimalReceipt & { blockNumber: number; blockHash: string; logs: ReadonlyArray<FundingTransferLog> }
    canonicalBlock = await provider.getBlock(receipt.blockNumber)
  }
  if (!canonicalBlock?.hash || canonicalBlock.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) {
    throw badRequestError("Funding transaction block is not canonical")
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
    if (log.index == null) {
      continue
    }
    const parsed = ERC20_TRANSFER_INTERFACE.parseLog({
      topics: [...log.topics],
      data: log.data,
    })
    const amount = parsed?.args.value as bigint | undefined
    // EXACT amount — a larger transfer (intended for something else) must not
    // confirm this quote, mirroring the booking rail. Single-use already removes
    // the multi-quote amplification; exact-match closes the wrong-amount edge.
    if (amount == null || amount !== expectedAmount) {
      continue
    }
    matched = {
      txRef: input.fundingTxRef,
      fromAddress: topicAddress(String(fromTopic)),
      toAddress: expectedRecipient,
      tokenAddress: expectedToken,
      amountAtomic: amount.toString(),
      chainRef,
      observation: {
        chainId: expectedSourceChainId,
        logIndex: log.index,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        blockTimestamp: canonicalBlock.timestamp,
      },
    }
    break
  }
  if (!matched) {
    throw badRequestError("Funding transaction did not deliver enough USDC to the checkout operator")
  }
  return matched
}

export type PirateCheckoutFundingVerification =
  | { kind: "verified"; receipt: BuyerFundingReceipt }
  | {
    kind: "custody_mismatch"
    reason: "wrong_transfer_amount" | "unexpected_sender"
    senderAddress: string
    observedAmountAtomic: string
    receipts: BuyerFundingReceipt[]
  }
  | { kind: "custody_incident"; reason: "multiple_senders"; receipts: BuyerFundingReceipt[] }
  | { kind: "pending"; reason: string }
  | { kind: "rejected"; reason: string }

function checkoutFundingTransfers(input: {
  receipt: FinalityReceipt
  expected: CheckoutFundingExpectation
  fundingTxRef: string
  blockTimestamp?: number
}): BuyerFundingReceipt[] {
  const transfers: BuyerFundingReceipt[] = []
  for (const log of input.receipt.logs) {
    if (log.index == null || getAddress(log.address) !== input.expected.expectedToken) continue
    const [topic0, fromTopic, toTopic] = log.topics
    if (String(topic0).toLowerCase() !== ERC20_TRANSFER_TOPIC) continue
    if (String(toTopic).toLowerCase() !== zeroPadValue(input.expected.expectedRecipient, 32).toLowerCase()) continue
    const senderAddress = topicAddress(String(fromTopic))
    if (!senderAddress) continue
    const parsed = ERC20_TRANSFER_INTERFACE.parseLog({ topics: [...log.topics], data: log.data })
    const amount = parsed?.args.value as bigint | undefined
    if (amount == null || amount <= 0n) continue
    transfers.push({
      txRef: input.fundingTxRef,
      fromAddress: senderAddress,
      toAddress: input.expected.expectedRecipient,
      tokenAddress: input.expected.expectedToken,
      amountAtomic: amount.toString(),
      chainRef: input.expected.chainRef,
      observation: {
        chainId: input.expected.expectedSourceChainId,
        logIndex: log.index,
        blockNumber: input.receipt.blockNumber,
        blockHash: input.receipt.blockHash,
        blockTimestamp: input.blockTimestamp,
      },
    })
  }
  return transfers
}

/**
 * Finality-aware buyer funding classification for handle intents. Unlike the
 * legacy verifier, every transfer into operator custody is returned with its
 * observation identity so mismatches can be durably recorded and refunded or
 * routed to operator review instead of disappearing during log scanning.
 */
export async function classifyPirateCheckoutUsdcFunding(input: {
  env: Env
  quoteId: string
  amountCents: number
  buyerAddress: string
  fundingTxRef: string
  fundingDestinationAddress?: string | null
  sourceChainJson?: string | null
  tokenAddress?: string | null
  finality: BookingPaymentFinalityPolicy
}): Promise<PirateCheckoutFundingVerification> {
  const txRef = input.fundingTxRef.trim()
  const quote: CheckoutFundingQuote = {
    quote_id: input.quoteId,
    route_provider: "pirate_checkout",
    funding_mode: "routed",
    final_price_cents: input.amountCents,
    source_chain_json: input.sourceChainJson ?? null,
    funding_destination_address: input.fundingDestinationAddress ?? null,
  }
  if (testBuyerFundingVerifier) {
    return { kind: "verified", receipt: await testBuyerFundingVerifier({ env: input.env, quote, buyerAddress: input.buyerAddress, fundingTxRef: txRef }) }
  }
  const expected = resolveCheckoutFundingExpectation({
    env: input.env,
    quote,
    buyerAddress: input.buyerAddress,
    expectedTokenAddress: input.tokenAddress,
  })
  const finalized = await resolveFinalizedPaymentReceipt({
    provider: createFinalityProvider(resolvePirateCheckoutRpcUrl(input.env), expected.expectedSourceChainId),
    fundingTxRef: txRef,
    expected: {
      chainId: expected.expectedSourceChainId,
      tokenAddress: expected.expectedToken,
      recipientAddress: expected.expectedRecipient,
      amountAtomic: expected.expectedAmount,
      senderAddress: expected.expectedSender,
    },
    finality: input.finality,
  })
  if (finalized.kind === "pending") return finalized
  if (finalized.receipt.status !== 1) return { kind: "rejected", reason: "transaction_reverted" }
  const transfers = checkoutFundingTransfers({
    receipt: finalized.receipt,
    expected,
    fundingTxRef: txRef,
    blockTimestamp: finalized.block.timestamp,
  })
  if (transfers.length === 0) return { kind: "rejected", reason: "no_matching_transfer" }
  const senders = new Set(transfers.map((receipt) => receipt.fromAddress?.toLowerCase()))
  if (senders.size > 1) return { kind: "custody_incident", reason: "multiple_senders", receipts: transfers }
  const senderAddress = transfers[0]?.fromAddress
  if (!senderAddress) return { kind: "rejected", reason: "sender_missing" }
  const observedAmountAtomic = transfers.reduce((sum, receipt) => sum + BigInt(receipt.amountAtomic), 0n).toString()
  if (
    transfers.length === 1
    && senderAddress.toLowerCase() === expected.expectedSender.toLowerCase()
    && observedAmountAtomic === expected.expectedAmount.toString()
  ) {
    return { kind: "verified", receipt: transfers[0] }
  }
  return {
    kind: "custody_mismatch",
    reason: senderAddress.toLowerCase() === expected.expectedSender.toLowerCase()
      ? "wrong_transfer_amount"
      : "unexpected_sender",
    senderAddress,
    observedAmountAtomic,
    receipts: transfers,
  }
}

// --- Booking payment-intent verification: validates a funding tx against EXPLICIT expected values
// (snapshotted on the persisted payment intent), never env/quote, and returns a CLASSIFIED outcome
// instead of throwing — so the confirmation state machine branches on kind, not on message text.
export interface BookingPaymentExpectation {
  chainId: number
  tokenAddress: string
  recipientAddress: string
  amountAtomic: bigint
  senderAddress: string
}
type FundingTransferLog = {
  address: string
  topics: ReadonlyArray<string>
  data: string
  index?: number
}
export type BookingCustodyTransfer = {
  senderAddress: string
  observedAmountAtomic: string
  transferCount: number
}
export type BookingPaymentVerification =
  // blockTimestamp lets a caller judge WHEN the transfer was mined, not merely that it was.
  // Reward funding uses it to honour a transfer broadcast before its quote expired even when
  // confirmation only arrives afterwards, without letting a genuinely late transfer revive
  // stale terms.
  | { kind: "verified"; senderAddress: string; txRef: string; blockNumber?: number; blockHash?: string; blockTimestamp?: number }
  | { kind: "custody_mismatch"; reason: "wrong_transfer_amount" | "unexpected_sender"; senderAddress: string; txRef: string; observedAmountAtomic: string; blockNumber?: number; blockHash?: string; blockTimestamp?: number }
  | { kind: "custody_incident"; reason: "multiple_senders"; txRef: string; transfers: BookingCustodyTransfer[]; blockNumber?: number; blockHash?: string; blockTimestamp?: number }
  | { kind: "pending"; reason?: string } // not yet final / transient RPC — resumable, never clears the claimed hash
  | { kind: "rejected"; reason: string } // mined-but-reverted or no matching transfer — terminal

export type BookingPaymentFinalityPolicy = {
  expectedChainId: number
  fallbackConfirmations: number
  preferSafeBlock: boolean
}

type FinalityReceipt = MinimalReceipt & { blockNumber: number; blockHash: string }
type FinalityProvider = {
  send(method: string, params: unknown[]): Promise<unknown>
  getTransactionReceipt(txHash: string): Promise<FinalityReceipt | null>
  getBlock(blockTag: number | "safe"): Promise<{ number: number; hash: string | null; timestamp?: number } | null>
  getBlockNumber(): Promise<number>
}

type FinalizedPaymentReceipt =
  | { kind: "pending"; reason: string }
  | {
    kind: "ready"
    receipt: FinalityReceipt
    block: { hash: string | null; timestamp?: number }
  }

let testFinalityProviderFactory: ((rpcUrl: string, chainId: number) => FinalityProvider) | null = null
export function setBookingPaymentFinalityProviderFactoryForTests(
  factory: typeof testFinalityProviderFactory,
): void {
  testFinalityProviderFactory = factory
}

function createFinalityProvider(rpcUrl: string, chainId: number): FinalityProvider {
  if (testFinalityProviderFactory) return testFinalityProviderFactory(rpcUrl, chainId)
  const provider = new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true })
  return {
    send: (method, params) => provider.send(method, params),
    getTransactionReceipt: async (txHash) => await provider.getTransactionReceipt(txHash) as FinalityReceipt | null,
    getBlock: async (blockTag) => await provider.getBlock(blockTag),
    getBlockNumber: async () => await provider.getBlockNumber(),
  }
}

function parseRpcChainId(value: unknown): number | null {
  try {
    const parsed = typeof value === "string" ? Number(BigInt(value)) : Number(value)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
  } catch {
    return null
  }
}

async function resolveFinalizedPaymentReceipt(input: {
  provider: FinalityProvider
  fundingTxRef: string
  expected: BookingPaymentExpectation
  finality: BookingPaymentFinalityPolicy
}): Promise<FinalizedPaymentReceipt> {
  const rpcChainId = parseRpcChainId(await input.provider.send("eth_chainId", []))
  if (rpcChainId !== input.finality.expectedChainId || rpcChainId !== input.expected.chainId) {
    return { kind: "pending", reason: "rpc_chain_id_mismatch" }
  }
  const receipt = await input.provider.getTransactionReceipt(input.fundingTxRef)
  if (!receipt) return { kind: "pending", reason: "receipt_pending" }
  const canonicalBlock = await input.provider.getBlock(receipt.blockNumber)
  if (!canonicalBlock?.hash || canonicalBlock.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) {
    return { kind: "pending", reason: "receipt_not_canonical" }
  }

  let final = false
  if (input.finality.preferSafeBlock) {
    try {
      const safeBlock = await input.provider.getBlock("safe")
      if (safeBlock) {
        if (safeBlock.number < receipt.blockNumber) {
          return { kind: "pending", reason: "safe_block_pending" }
        }
        final = true
      }
    } catch {
      // RPC does not support the safe block tag; use the documented depth fallback.
    }
  }
  if (!final) {
    const head = await input.provider.getBlockNumber()
    const confirmations = head >= receipt.blockNumber ? head - receipt.blockNumber + 1 : 0
    if (confirmations < input.finality.fallbackConfirmations) {
      return { kind: "pending", reason: "confirmation_depth_pending" }
    }
  }
  return { kind: "ready", receipt, block: canonicalBlock }
}

async function classifyFinalizedPaymentReceipt(input: {
  provider: FinalityProvider
  fundingTxRef: string
  expected: BookingPaymentExpectation
  finality: BookingPaymentFinalityPolicy
}): Promise<BookingPaymentVerification> {
  const finalized = await resolveFinalizedPaymentReceipt(input)
  if (finalized.kind === "pending") return finalized
  const { receipt, block: canonicalBlock } = finalized
  const evaluated = evaluateBookingPaymentReceipt(receipt, input.expected, input.fundingTxRef)
  return evaluated.kind === "verified" || evaluated.kind === "custody_mismatch" || evaluated.kind === "custody_incident"
    ? {
        ...evaluated,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash.toLowerCase(),
        // Already fetched above for the canonicality check, so this costs no extra RPC call.
        blockTimestamp: canonicalBlock.timestamp,
      }
    : evaluated
}

let testBookingPaymentVerifier: ((input: { env: Env; fundingTxRef: string; expected: BookingPaymentExpectation; rpcUrl?: string }) => Promise<BookingPaymentVerification>) | null = null
export function setBookingPaymentVerifierForTests(fn: typeof testBookingPaymentVerifier): void { testBookingPaymentVerifier = fn }

// Pure receipt evaluation (no RPC) so the matching/amount rules are directly unit-testable.
interface MinimalReceipt { status: number; logs: ReadonlyArray<FundingTransferLog> }
export function evaluateBookingPaymentReceipt(receipt: MinimalReceipt | null, expected: BookingPaymentExpectation, txRef: string): BookingPaymentVerification {
  if (!receipt) return { kind: "pending" } // not found yet
  if (receipt.status !== 1) return { kind: "rejected", reason: "transaction_reverted" }
  const expectedToken = getAddress(expected.tokenAddress)
  const expectedRecipientTopic = zeroPadValue(getAddress(expected.recipientAddress), 32).toLowerCase()
  const expectedSender = getAddress(expected.senderAddress)
  const transfersBySender = new Map<string, { senderAddress: string; amount: bigint; count: number }>()
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== expectedToken) continue
    const [topic0, fromTopic, toTopic] = log.topics
    if (String(topic0).toLowerCase() !== ERC20_TRANSFER_TOPIC) continue
    if (String(toTopic).toLowerCase() !== expectedRecipientTopic) continue
    const parsed = ERC20_TRANSFER_INTERFACE.parseLog({ topics: [...log.topics], data: log.data })
    const amount = parsed?.args.value as bigint | undefined
    if (amount == null || amount <= 0n) continue
    const sender = topicAddress(String(fromTopic))
    if (sender == null) continue
    const senderAddress = getAddress(sender)
    const key = senderAddress.toLowerCase()
    const current = transfersBySender.get(key)
    transfersBySender.set(key, {
      senderAddress,
      amount: (current?.amount ?? 0n) + amount,
      count: (current?.count ?? 0) + 1,
    })
  }
  const transfers = [...transfersBySender.values()]
    .sort((left, right) => left.senderAddress.toLowerCase().localeCompare(right.senderAddress.toLowerCase()))
    .map((transfer) => ({
      senderAddress: transfer.senderAddress,
      observedAmountAtomic: transfer.amount.toString(),
      transferCount: transfer.count,
    }))
  if (transfers.length > 1) {
    return { kind: "custody_incident", reason: "multiple_senders", txRef, transfers }
  }
  const [observed] = transfers
  if (!observed) return { kind: "rejected", reason: "no_matching_transfer" }
  // EXACTLY one exact transfer satisfies the intent. Multiple matching transfers are treated as
  // custody mismatch even when one is exact, so excess funds cannot disappear from refund work.
  if (
    observed.transferCount === 1
    && BigInt(observed.observedAmountAtomic) === expected.amountAtomic
    && observed.senderAddress.toLowerCase() === expectedSender.toLowerCase()
  ) {
    return { kind: "verified", senderAddress: observed.senderAddress, txRef }
  }
  return {
    kind: "custody_mismatch",
    reason: observed.senderAddress.toLowerCase() === expectedSender.toLowerCase()
      ? "wrong_transfer_amount"
      : "unexpected_sender",
    senderAddress: observed.senderAddress,
    txRef,
    observedAmountAtomic: observed.observedAmountAtomic,
  }
}

export async function classifyBookingPaymentReceipt(input: {
  env: Env
  fundingTxRef: string // normalized by the caller
  expected: BookingPaymentExpectation
  rpcUrl?: string
  finality?: BookingPaymentFinalityPolicy
}): Promise<BookingPaymentVerification> {
  if (testBookingPaymentVerifier) return testBookingPaymentVerifier(input)
  if (input.finality) {
    try {
      return await classifyFinalizedPaymentReceipt({
        provider: createFinalityProvider(
          input.rpcUrl ?? resolvePirateCheckoutRpcUrl(input.env),
          input.expected.chainId,
        ),
        fundingTxRef: input.fundingTxRef,
        expected: input.expected,
        finality: input.finality,
      })
    } catch {
      return { kind: "pending", reason: "rpc_unavailable" }
    }
  }
  const provider = new JsonRpcProvider(input.rpcUrl ?? resolvePirateCheckoutRpcUrl(input.env), input.expected.chainId)
  let receipt: Awaited<ReturnType<typeof provider.waitForTransaction>>
  try {
    receipt = await provider.waitForTransaction(input.fundingTxRef, 1, resolvePirateCheckoutTxWaitTimeoutMs(input.env))
  } catch (error) {
    if (isTransactionWaitTimeout(error)) return { kind: "pending" }
    return { kind: "pending" } // transient RPC error — resumable
  }
  return evaluateBookingPaymentReceipt(receipt as MinimalReceipt | null, input.expected, input.fundingTxRef)
}

export async function verifyPirateCheckoutUsdcFunding(input: {
  env: Env
  quoteId: string
  amountCents: number
  buyerAddress: string
  fundingTxRef: string
  fundingDestinationAddress?: string | null
  sourceChainJson?: string | null
  tokenAddress?: string | null
  finality?: BookingPaymentFinalityPolicy
}): Promise<BuyerFundingReceipt> {
  const txRef = input.fundingTxRef.trim()
  if (!txRef) {
    throw badRequestError("funding_tx_ref is required")
  }
  return await verifyPirateCheckoutUsdcFundingReceipt({
    env: input.env,
    buyerAddress: input.buyerAddress,
    fundingTxRef: txRef,
    finality: input.finality,
    expectedTokenAddress: input.tokenAddress,
    quote: {
      quote_id: input.quoteId,
      route_provider: "pirate_checkout",
      funding_mode: "routed",
      final_price_cents: input.amountCents,
      source_chain_json: input.sourceChainJson ?? null,
      funding_destination_address: input.fundingDestinationAddress ?? null,
    },
  })
}

/**
 * Claims the exact verified Transfer log in the global control-plane registry.
 * Production verification always returns an observation identity. Test verifiers
 * may omit it for legacy fixtures; focused registry tests provide it explicitly.
 */
export async function claimVerifiedBuyerFundingReceipt(input: {
  client: Client | Transaction
  receipt: BuyerFundingReceipt
  fallbackSenderAddress: string
  consumerRail: string
  consumerId: string
  quoteId: string
  now: string
}) {
  const observation = input.receipt.observation
  if (!observation) {
    if (testBuyerFundingVerifier) return
    throw badRequestError("Funding receipt observation identity is missing")
  }
  return await claimCanonicalFundingReceipt({
    client: input.client,
    chainId: observation.chainId,
    tokenAddress: input.receipt.tokenAddress,
    txHash: input.receipt.txRef,
    logIndex: observation.logIndex,
    blockNumber: observation.blockNumber,
    blockHash: observation.blockHash,
    blockTimestamp: observation.blockTimestamp,
    senderAddress: input.receipt.fromAddress ?? input.fallbackSenderAddress,
    recipientAddress: input.receipt.toAddress,
    amountAtomic: input.receipt.amountAtomic,
    consumerRail: input.consumerRail,
    consumerId: input.consumerId,
    quoteId: input.quoteId,
    now: input.now,
  })
}

export async function claimBuyerFundingReceiptForReview(input: {
  client: Client | Transaction
  receipt: BuyerFundingReceipt
  fallbackSenderAddress: string
  consumerRail: string
  consumerId: string
  quoteId: string
  now: string
}) {
  const observation = input.receipt.observation
  if (!observation) {
    if (testBuyerFundingVerifier) return
    throw badRequestError("Funding receipt observation identity is missing")
  }
  return await claimCanonicalFundingReceiptForReview({
    client: input.client,
    chainId: observation.chainId,
    tokenAddress: input.receipt.tokenAddress,
    txHash: input.receipt.txRef,
    logIndex: observation.logIndex,
    blockNumber: observation.blockNumber,
    blockHash: observation.blockHash,
    blockTimestamp: observation.blockTimestamp,
    senderAddress: input.receipt.fromAddress ?? input.fallbackSenderAddress,
    recipientAddress: input.receipt.toAddress,
    amountAtomic: input.receipt.amountAtomic,
    consumerRail: input.consumerRail,
    consumerId: input.consumerId,
    quoteId: input.quoteId,
    now: input.now,
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
  // Global single-use: a funding tx already consumed by a DIFFERENT quote in this
  // community must not be replayed to settle another quote (free content / operator
  // drain). Migration 1116's partial-unique index is the race-safe backstop; this
  // gives a clean error and avoids a wasted on-chain read. Same-quote retries are
  // allowed (idempotency below returns the existing receipt).
  const priorUse = await findConfirmedBuyerFundingEffectByTx({
    client: input.client,
    communityId: input.communityId,
    txRef,
  })
  if (priorUse && priorUse.quote_id !== input.quote.quote_id) {
    throw badRequestError("Funding transaction has already been used for another purchase")
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
    await input.client.execute({
      sql: `
        UPDATE purchase_quotes
        SET funding_locked_at = COALESCE(funding_locked_at, ?3),
            updated_at = ?3
        WHERE community_id = ?1
          AND quote_id = ?2
          AND status = 'active'
      `,
      args: [input.communityId, input.quote.quote_id, input.now],
    })
    return metadata
  }
  try {
    const receipt = await verifyPirateCheckoutUsdcFundingReceipt({
      env: input.env,
      quote: input.quote,
      buyerAddress: input.buyerAddress,
      fundingTxRef: txRef,
    })
    await claimVerifiedBuyerFundingReceipt({
      client: getControlPlaneClient(input.env),
      receipt,
      fallbackSenderAddress: input.buyerAddress,
      consumerRail: "community_purchase",
      consumerId: `${input.communityId}:${input.purchaseId}`,
      quoteId: input.quote.quote_id,
      now: input.now,
    })
    await confirmBuyerFundingEffectAndLockQuote({
      client: input.client,
      communityId: input.communityId,
      quoteId: input.quote.quote_id,
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
      disposition: "failed_prebroadcast",
      now: input.now,
    })
    throw error
  }
}
