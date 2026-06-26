import { describe, expect, test } from "bun:test"
import { getAddress, toBeHex, zeroPadValue } from "ethers"

import { evaluateBookingPaymentReceipt, type BookingPaymentExpectation } from "../../../../src/lib/communities/commerce/funding-proof-service"

// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
const TOKEN = getAddress("0x036cbd53842c5426634e7929541ec2318f3dcf7e")
const SENDER = getAddress("0x7000000000000000000000000000000000000007")
const RECIPIENT = getAddress("0x1111111111111111111111111111111111111111")
const EXPECTED: BookingPaymentExpectation = {
  chainId: 84532, tokenAddress: TOKEN, recipientAddress: RECIPIENT, amountAtomic: 50_000_000n, senderAddress: SENDER,
}

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
