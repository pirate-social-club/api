import { describe, expect, test } from "bun:test"
import { Wallet } from "ethers"

import {
  isProbablyAddress,
  resolveHostPayoutWallet,
  validateFundingReadiness,
  validateQuotePaymentFields,
} from "../scripts/smoke-paid-booking"

const VALID_ADDRESS = "0x1111111111111111111111111111111111111111"
const OTHER_VALID_ADDRESS = "0x2222222222222222222222222222222222222222"
const BUYER_PRIVATE_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

describe("smoke-paid-booking script guards", () => {
  test("validates EVM address-shaped values", () => {
    expect(isProbablyAddress(VALID_ADDRESS)).toBe(true)
    expect(isProbablyAddress("0x123")).toBe(false)
    expect(isProbablyAddress("not-an-address")).toBe(false)
  })

  test("defaults host payout to buyer wallet when a buyer key is present", () => {
    expect(resolveHostPayoutWallet({
      explicitHostPayoutWallet: null,
      buyerPrivateKey: BUYER_PRIVATE_KEY,
      fallbackAddress: OTHER_VALID_ADDRESS,
    })).toBe(new Wallet(BUYER_PRIVATE_KEY).address)
  })

  test("honors explicit host payout wallet and rejects invalid targets", () => {
    expect(resolveHostPayoutWallet({
      explicitHostPayoutWallet: OTHER_VALID_ADDRESS,
      buyerPrivateKey: BUYER_PRIVATE_KEY,
      fallbackAddress: VALID_ADDRESS,
    })).toBe(OTHER_VALID_ADDRESS)

    expect(() => resolveHostPayoutWallet({
      explicitHostPayoutWallet: "0x123",
      buyerPrivateKey: BUYER_PRIVATE_KEY,
      fallbackAddress: VALID_ADDRESS,
    })).toThrow("Invalid --host-payout-wallet")
  })

  test("accepts complete quote payment fields", () => {
    expect(validateQuotePaymentFields({
      chain_id: 8453,
      token_address: VALID_ADDRESS,
      recipient_address: OTHER_VALID_ADDRESS,
      amount_atomic: "1000000",
    })).toEqual({
      chainId: 8453,
      tokenAddress: VALID_ADDRESS,
      recipientAddress: OTHER_VALID_ADDRESS,
      amountAtomic: "1000000",
    })
  })

  test("rejects malformed quote payment fields before broadcasting", () => {
    const base = {
      chain_id: 8453,
      token_address: VALID_ADDRESS,
      recipient_address: OTHER_VALID_ADDRESS,
      amount_atomic: "1000000",
    }
    expect(() => validateQuotePaymentFields({ ...base, chain_id: 0 })).toThrow("invalid chain_id")
    expect(() => validateQuotePaymentFields({ ...base, token_address: "0x123" })).toThrow("invalid token_address")
    expect(() => validateQuotePaymentFields({ ...base, recipient_address: "0x123" })).toThrow("invalid recipient_address")
    expect(() => validateQuotePaymentFields({ ...base, amount_atomic: "0" })).toThrow("invalid amount_atomic")
  })

  test("accepts funded buyer and settlement wallets", () => {
    expect(() => validateFundingReadiness({
      buyerAddress: VALID_ADDRESS,
      settlementAddress: OTHER_VALID_ADDRESS,
      buyerNativeWei: 1n,
      buyerTokenAtomic: 1_000_000n,
      settlementNativeWei: 1n,
      requiredTokenAtomic: 1_000_000n,
    })).not.toThrow()
  })

  test("rejects unfunded canary wallets before broadcasting", () => {
    expect(() => validateFundingReadiness({
      buyerAddress: VALID_ADDRESS,
      settlementAddress: OTHER_VALID_ADDRESS,
      buyerNativeWei: 0n,
      buyerTokenAtomic: 0n,
      settlementNativeWei: 0n,
      requiredTokenAtomic: 1_000_000n,
    })).toThrow("paid booking canary funding preflight failed")
  })
})
