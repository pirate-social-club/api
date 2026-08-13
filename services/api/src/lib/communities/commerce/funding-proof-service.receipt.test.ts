import { afterEach, describe, expect, test } from "bun:test"
import { Interface } from "ethers"

import type { Env } from "../../../env"
import {
  classifyPirateCheckoutUsdcFunding,
  evaluateBookingPaymentReceipt,
  setBookingPaymentFinalityProviderFactoryForTests,
  setBuyerFundingProviderFactoryForTests,
  verifyPirateCheckoutUsdcFunding,
} from "./funding-proof-service"

const transfer = new Interface(["event Transfer(address indexed from, address indexed to, uint256 value)"])
const TOKEN = "0x036cbd53842c5426634e7929541ec2318f3dcf7e"
const BUYER = "0x1111111111111111111111111111111111111111"
const OPERATOR = "0x2222222222222222222222222222222222222222"
const OTHER = "0x3333333333333333333333333333333333333333"
const TX = `0x${"11".repeat(32)}`
const BLOCK = `0x${"22".repeat(32)}`

const env = {
  PIRATE_CHECKOUT_SOURCE_CHAIN_ID: "84532",
  PIRATE_CHECKOUT_USDC_TOKEN_ADDRESS: TOKEN,
  PIRATE_CHECKOUT_OPERATOR_ADDRESS: OPERATOR,
  PIRATE_CHECKOUT_RPC_URL: "https://rpc.invalid",
} as Env

function log(input: { from?: string; to?: string; amount?: bigint; index: number }) {
  const encoded = transfer.encodeEventLog(transfer.getEvent("Transfer")!, [
    input.from ?? BUYER,
    input.to ?? OPERATOR,
    input.amount ?? 5_000_000n,
  ])
  return { address: TOKEN, topics: encoded.topics, data: encoded.data, index: input.index }
}

function provide(logs: ReturnType<typeof log>[]) {
  setBuyerFundingProviderFactoryForTests(() => ({
    waitForTransaction: async () => ({ status: 1, blockNumber: 123, blockHash: BLOCK, logs }),
    getBlock: async () => ({ hash: BLOCK, timestamp: 1_786_622_400 }),
  } as never))
}

function verify() {
  return verifyPirateCheckoutUsdcFunding({
    env,
    quoteId: "quote_1",
    amountCents: 500,
    buyerAddress: BUYER,
    fundingTxRef: TX,
  })
}

afterEach(() => {
  setBuyerFundingProviderFactoryForTests(null)
  setBookingPaymentFinalityProviderFactoryForTests(null)
})

describe("Pirate checkout raw funding receipt parser", () => {
  test.each([
    ["wrong amount", log({ amount: 4_999_999n, index: 1 })],
    ["wrong recipient", log({ to: OTHER, index: 1 })],
    ["wrong sender", log({ from: OTHER, index: 1 })],
  ])("rejects %s", async (_label, candidate) => {
    provide([candidate])
    await expect(verify()).rejects.toThrow("did not deliver enough USDC")
  })

  test("selects the first exact matching Transfer and preserves its log index", async () => {
    provide([
      log({ to: OTHER, index: 2 }),
      log({ amount: 5_000_000n, index: 7 }),
      log({ amount: 5_000_000n, index: 9 }),
    ])

    await expect(verify()).resolves.toMatchObject({
      txRef: TX,
      amountAtomic: "5000000",
      observation: {
        chainId: 84532,
        logIndex: 7,
        blockNumber: 123,
        blockHash: BLOCK,
        blockTimestamp: 1_786_622_400,
      },
    })
  })

  test("does not bind a receipt before the safe block", async () => {
    setBookingPaymentFinalityProviderFactoryForTests(() => ({
      send: async () => "0x14a34",
      getTransactionReceipt: async () => ({ status: 1, blockNumber: 123, blockHash: BLOCK, logs: [log({ index: 7 })] }),
      getBlock: async (tag: number | "safe") => tag === "safe"
        ? { number: 122, hash: BLOCK, timestamp: 1_786_622_400 }
        : { number: 123, hash: BLOCK, timestamp: 1_786_622_400 },
      getBlockNumber: async () => 123,
    }) as never)

    const pending = await verifyPirateCheckoutUsdcFunding({
      env,
      quoteId: "quote_finality_pending",
      amountCents: 500,
      buyerAddress: BUYER,
      fundingTxRef: TX,
      finality: { expectedChainId: 84532, fallbackConfirmations: 30, preferSafeBlock: true },
    }).catch((error) => error)
    expect(pending).toMatchObject({
      code: "conflict",
      retryable: true,
      details: { reason: "safe_block_pending" },
    })
  })

  test("uses the safe block before binding an exact receipt", async () => {
    setBookingPaymentFinalityProviderFactoryForTests(() => ({
      send: async () => "0x14a34",
      getTransactionReceipt: async () => ({ status: 1, blockNumber: 123, blockHash: BLOCK, logs: [log({ index: 7 })] }),
      getBlock: async (tag: number | "safe") => tag === "safe"
        ? { number: 123, hash: BLOCK, timestamp: 1_786_622_400 }
        : { number: 123, hash: BLOCK, timestamp: 1_786_622_400 },
      getBlockNumber: async () => 123,
    }) as never)

    await expect(verifyPirateCheckoutUsdcFunding({
      env,
      quoteId: "quote_finality_safe",
      amountCents: 500,
      buyerAddress: BUYER,
      fundingTxRef: TX,
      finality: { expectedChainId: 84532, fallbackConfirmations: 30, preferSafeBlock: true },
    })).resolves.toMatchObject({
      txRef: TX,
      amountAtomic: "5000000",
      observation: { blockNumber: 123, blockHash: BLOCK, logIndex: 7 },
    })
  })

  test("treats a shallow reorg as retryable before custody binding", async () => {
    setBookingPaymentFinalityProviderFactoryForTests(() => ({
      send: async () => "0x14a34",
      getTransactionReceipt: async () => ({ status: 1, blockNumber: 123, blockHash: BLOCK, logs: [log({ index: 7 })] }),
      getBlock: async () => ({ hash: `0x${"99".repeat(32)}`, timestamp: 1_786_622_400 }),
      getBlockNumber: async () => 200,
    }) as never)

    const reorged = await verifyPirateCheckoutUsdcFunding({
      env,
      quoteId: "quote_finality_reorg",
      amountCents: 500,
      buyerAddress: BUYER,
      fundingTxRef: TX,
      finality: { expectedChainId: 84532, fallbackConfirmations: 30, preferSafeBlock: true },
    }).catch((error) => error)
    expect(reorged).toMatchObject({
      code: "conflict",
      retryable: true,
      details: { reason: "receipt_not_canonical" },
    })
  })

  test("durably classifies an underpayment from the expected sender", async () => {
    setBookingPaymentFinalityProviderFactoryForTests(() => ({
      send: async () => "0x14a34",
      getTransactionReceipt: async () => ({ status: 1, blockNumber: 123, blockHash: BLOCK, logs: [log({ amount: 4_000_000n, index: 7 })] }),
      getBlock: async (tag: number | "safe") => tag === "safe"
        ? { number: 123, hash: BLOCK, timestamp: 1_786_622_400 }
        : { number: 123, hash: BLOCK, timestamp: 1_786_622_400 },
      getBlockNumber: async () => 123,
    }) as never)

    await expect(classifyPirateCheckoutUsdcFunding({
      env,
      quoteId: "quote_underpay",
      amountCents: 500,
      buyerAddress: BUYER,
      fundingTxRef: TX,
      finality: { expectedChainId: 84532, fallbackConfirmations: 30, preferSafeBlock: true },
    })).resolves.toMatchObject({
      kind: "custody_mismatch",
      reason: "wrong_transfer_amount",
      observedAmountAtomic: "4000000",
      receipts: [{ amountAtomic: "4000000", observation: { logIndex: 7 } }],
    })
  })

  test("routes duplicate transfers to operator review with every event preserved", async () => {
    setBookingPaymentFinalityProviderFactoryForTests(() => ({
      send: async () => "0x14a34",
      getTransactionReceipt: async () => ({
        status: 1,
        blockNumber: 123,
        blockHash: BLOCK,
        logs: [log({ amount: 5_000_000n, index: 7 }), log({ amount: 5_000_000n, index: 9 })],
      }),
      getBlock: async (tag: number | "safe") => tag === "safe"
        ? { number: 123, hash: BLOCK, timestamp: 1_786_622_400 }
        : { number: 123, hash: BLOCK, timestamp: 1_786_622_400 },
      getBlockNumber: async () => 123,
    }) as never)

    await expect(classifyPirateCheckoutUsdcFunding({
      env,
      quoteId: "quote_duplicate",
      amountCents: 500,
      buyerAddress: BUYER,
      fundingTxRef: TX,
      finality: { expectedChainId: 84532, fallbackConfirmations: 30, preferSafeBlock: true },
    })).resolves.toMatchObject({
      kind: "custody_mismatch",
      reason: "wrong_transfer_amount",
      observedAmountAtomic: "10000000",
      receipts: [
        { amountAtomic: "5000000", observation: { logIndex: 7 } },
        { amountAtomic: "5000000", observation: { logIndex: 9 } },
      ],
    })
  })

  test("retains every sender for a custody incident", async () => {
    setBookingPaymentFinalityProviderFactoryForTests(() => ({
      send: async () => "0x14a34",
      getTransactionReceipt: async () => ({
        status: 1,
        blockNumber: 123,
        blockHash: BLOCK,
        logs: [log({ index: 7 }), log({ from: OTHER, amount: 1_000_000n, index: 9 })],
      }),
      getBlock: async (tag: number | "safe") => tag === "safe"
        ? { number: 123, hash: BLOCK, timestamp: 1_786_622_400 }
        : { number: 123, hash: BLOCK, timestamp: 1_786_622_400 },
      getBlockNumber: async () => 123,
    }) as never)

    await expect(classifyPirateCheckoutUsdcFunding({
      env,
      quoteId: "quote_multiple_senders",
      amountCents: 500,
      buyerAddress: BUYER,
      fundingTxRef: TX,
      finality: { expectedChainId: 84532, fallbackConfirmations: 30, preferSafeBlock: true },
    })).resolves.toMatchObject({
      kind: "custody_incident",
      reason: "multiple_senders",
      receipts: [
        { amountAtomic: "5000000", fromAddress: BUYER, observation: { logIndex: 7 } },
        { amountAtomic: "1000000", fromAddress: OTHER, observation: { logIndex: 9 } },
      ],
    })
  })
})

describe("booking and reward custody receipt classification", () => {
  const expected = {
    chainId: 84532,
    tokenAddress: TOKEN,
    recipientAddress: OPERATOR,
    amountAtomic: 5_000_000n,
    senderAddress: BUYER,
  }
  const receipt = (...logs: ReturnType<typeof log>[]) => ({ status: 1, logs })

  test("verifies exactly one exact transfer from the expected sender", () => {
    expect(evaluateBookingPaymentReceipt(receipt(log({ index: 1 })), expected, TX)).toEqual({
      kind: "verified",
      senderAddress: BUYER,
      txRef: TX,
    })
  })

  test("records a wrong amount from the expected sender as refundable custody", () => {
    expect(evaluateBookingPaymentReceipt(
      receipt(log({ amount: 4_000_000n, index: 1 })),
      expected,
      TX,
    )).toMatchObject({
      kind: "custody_mismatch",
      reason: "wrong_transfer_amount",
      senderAddress: BUYER,
      observedAmountAtomic: "4000000",
    })
  })

  test("records a single unexpected sender as refundable custody", () => {
    expect(evaluateBookingPaymentReceipt(
      receipt(log({ from: OTHER, index: 1 })),
      expected,
      TX,
    )).toMatchObject({
      kind: "custody_mismatch",
      reason: "unexpected_sender",
      senderAddress: OTHER,
      observedAmountAtomic: "5000000",
    })
  })

  test("retains every sender when operator custody is ambiguous", () => {
    expect(evaluateBookingPaymentReceipt(
      receipt(
        log({ index: 1 }),
        log({ from: OTHER, amount: 1n, index: 2 }),
      ),
      expected,
      TX,
    )).toEqual({
      kind: "custody_incident",
      reason: "multiple_senders",
      txRef: TX,
      transfers: [
        { senderAddress: BUYER, observedAmountAtomic: "5000000", transferCount: 1 },
        { senderAddress: OTHER, observedAmountAtomic: "1", transferCount: 1 },
      ],
    })
  })

  test("ignores unrelated token or recipient transfers and zero-value grief logs", () => {
    expect(evaluateBookingPaymentReceipt(
      receipt(
        log({ to: OTHER, index: 1 }),
        log({ amount: 0n, index: 2 }),
      ),
      expected,
      TX,
    )).toEqual({ kind: "rejected", reason: "no_matching_transfer" })
  })
})
