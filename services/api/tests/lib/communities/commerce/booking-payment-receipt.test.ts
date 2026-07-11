import { afterEach, describe, expect, test } from "bun:test"
import { getAddress, toBeHex, zeroPadValue } from "ethers"

import {
  classifyBookingPaymentReceipt,
  evaluateBookingPaymentReceipt,
  setBookingPaymentFinalityProviderFactoryForTests,
  type BookingPaymentExpectation,
} from "../../../../src/lib/communities/commerce/funding-proof-service"

// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
const TOKEN = getAddress("0x036cbd53842c5426634e7929541ec2318f3dcf7e")
const SENDER = getAddress("0x7000000000000000000000000000000000000007")
const RECIPIENT = getAddress("0x1111111111111111111111111111111111111111")
const EXPECTED: BookingPaymentExpectation = {
  chainId: 84532, tokenAddress: TOKEN, recipientAddress: RECIPIENT, amountAtomic: 50_000_000n, senderAddress: SENDER,
}
const TX_HASH = `0x${"a".repeat(64)}`
const BLOCK_HASH = `0x${"b".repeat(64)}`

afterEach(() => {
  setBookingPaymentFinalityProviderFactoryForTests(null)
})

function receipt(amount: bigint, over: Partial<{ token: string; from: string; to: string; status: number }> = {}) {
  return {
    status: over.status ?? 1,
    logs: [{
      address: over.token ?? TOKEN,
      topics: [TRANSFER_TOPIC, zeroPadValue(over.from ?? SENDER, 32), zeroPadValue(over.to ?? RECIPIENT, 32)],
      data: zeroPadValue(toBeHex(amount), 32),
    }],
  }
}

describe("evaluateBookingPaymentReceipt — exact-amount matching", () => {
  test("exact amount → verified (sender echoed)", () => {
    const r = evaluateBookingPaymentReceipt(receipt(50_000_000n), EXPECTED, "0xtx")
    expect(r.kind).toBe("verified")
    if (r.kind === "verified") expect(getAddress(r.senderAddress)).toBe(SENDER)
  })
  test("underpayment → rejected (no matching transfer)", () => {
    expect(evaluateBookingPaymentReceipt(receipt(49_999_999n), EXPECTED, "0xtx").kind).toBe("rejected")
  })
  test("overpayment → rejected (a larger payment for something else must not satisfy the intent)", () => {
    expect(evaluateBookingPaymentReceipt(receipt(50_000_001n), EXPECTED, "0xtx").kind).toBe("rejected")
  })
  test("wrong recipient → rejected", () => {
    expect(evaluateBookingPaymentReceipt(receipt(50_000_000n, { to: getAddress("0x2222222222222222222222222222222222222222") }), EXPECTED, "0xtx").kind).toBe("rejected")
  })
  test("wrong sender → rejected", () => {
    expect(evaluateBookingPaymentReceipt(receipt(50_000_000n, { from: getAddress("0x3333333333333333333333333333333333333333") }), EXPECTED, "0xtx").kind).toBe("rejected")
  })
  test("wrong token → rejected", () => {
    expect(evaluateBookingPaymentReceipt(receipt(50_000_000n, { token: getAddress("0x4444444444444444444444444444444444444444") }), EXPECTED, "0xtx").kind).toBe("rejected")
  })
  test("reverted receipt → rejected (terminal)", () => {
    expect(evaluateBookingPaymentReceipt(receipt(50_000_000n, { status: 0 }), EXPECTED, "0xtx").kind).toBe("rejected")
  })
  test("missing receipt → pending (resumable)", () => {
    expect(evaluateBookingPaymentReceipt(null, EXPECTED, "0xtx").kind).toBe("pending")
  })
})

function installFinalityProvider(over: Partial<{
  chainId: unknown
  receipt: ReturnType<typeof receipt> & { blockNumber: number; blockHash: string } | null
  canonicalHash: string | null
  safeBlock: { number: number; hash: string } | null
  safeError: boolean
  head: number
}> = {}): void {
  const mined = over.receipt === undefined
    ? { ...receipt(50_000_000n), blockNumber: 100, blockHash: BLOCK_HASH }
    : over.receipt
  setBookingPaymentFinalityProviderFactoryForTests(() => ({
    send: async () => over.chainId ?? "0x14a34",
    getTransactionReceipt: async () => mined,
    getBlock: async (tag) => {
      if (tag === "safe") {
        if (over.safeError) throw new Error("safe tag unsupported")
        return over.safeBlock ?? { number: 100, hash: BLOCK_HASH }
      }
      return { number: tag, hash: over.canonicalHash === undefined ? BLOCK_HASH : over.canonicalHash }
    },
    getBlockNumber: async () => over.head ?? 129,
  }))
}

async function classifyFinality() {
  return classifyBookingPaymentReceipt({
    env: {} as never,
    fundingTxRef: TX_HASH,
    expected: EXPECTED,
    rpcUrl: "https://base-sepolia.example.test",
    finality: { expectedChainId: 84532, fallbackConfirmations: 30, preferSafeBlock: true },
  })
}

describe("reward funding finality", () => {
  test("fails closed when eth_chainId does not match", async () => {
    installFinalityProvider({ chainId: "0x1" })
    expect(await classifyFinality()).toEqual({ kind: "pending", reason: "rpc_chain_id_mismatch" })
  })

  test("waits below the safe block and accepts at the safe boundary", async () => {
    installFinalityProvider({ safeBlock: { number: 99, hash: `0x${"c".repeat(64)}` } })
    expect(await classifyFinality()).toEqual({ kind: "pending", reason: "safe_block_pending" })
    installFinalityProvider({ safeBlock: { number: 100, hash: `0x${"c".repeat(64)}` } })
    expect((await classifyFinality()).kind).toBe("verified")
  })

  test("uses the documented 30-block fallback at threshold minus one and threshold", async () => {
    installFinalityProvider({ safeError: true, head: 128 })
    expect(await classifyFinality()).toEqual({ kind: "pending", reason: "confirmation_depth_pending" })
    installFinalityProvider({ safeError: true, head: 129 })
    expect((await classifyFinality()).kind).toBe("verified")
    installFinalityProvider({ safeError: true, head: 130 })
    expect((await classifyFinality()).kind).toBe("verified")
  })

  test("treats a missing or non-canonical receipt as recoverable", async () => {
    installFinalityProvider({ receipt: null })
    expect(await classifyFinality()).toEqual({ kind: "pending", reason: "receipt_pending" })
    installFinalityProvider({ canonicalHash: `0x${"d".repeat(64)}` })
    expect(await classifyFinality()).toEqual({ kind: "pending", reason: "receipt_not_canonical" })
  })

  test("keeps transient RPC failures retryable", async () => {
    setBookingPaymentFinalityProviderFactoryForTests(() => ({
      send: async () => { throw new Error("timeout") },
      getTransactionReceipt: async () => null,
      getBlock: async () => null,
      getBlockNumber: async () => 0,
    }))
    expect(await classifyFinality()).toEqual({ kind: "pending", reason: "rpc_unavailable" })
  })
})
