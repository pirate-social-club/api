import { describe, expect, test } from "bun:test"
import { Wallet } from "ethers"

import {
  isProbablyAddress,
  PAID_BOOKING_SMOKE_USAGE,
  parseAddress,
  parsePositiveAtomic,
  parsePositiveInt,
  resolveFundingPreflightBuyerAddress,
  resolveHostPayoutWallet,
  runDelayedCompletion,
  validateCompletedCanaryBooking,
  validateFundingReadiness,
  validateQuotePaymentFields,
} from "../scripts/smoke-paid-booking"

const VALID_ADDRESS = "0x1111111111111111111111111111111111111111"
const OTHER_VALID_ADDRESS = "0x2222222222222222222222222222222222222222"
const BUYER_PRIVATE_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

describe("smoke-paid-booking script guards", () => {
  test("documents prod preflight and canary commands", () => {
    expect(PAID_BOOKING_SMOKE_USAGE).toContain("--funding-preflight-only")
    expect(PAID_BOOKING_SMOKE_USAGE).toContain("--claim")
    expect(PAID_BOOKING_SMOKE_USAGE).toContain("--agora-evidence-file")
    expect(PAID_BOOKING_SMOKE_USAGE).toContain("--base-price-cents")
    expect(PAID_BOOKING_SMOKE_USAGE).toContain("https://api.pirate.sc")
    expect(PAID_BOOKING_SMOKE_USAGE).toContain("--wait-for-completion")
    // Canary is testnet-only: Base Sepolia chain + USDC, never mainnet.
    expect(PAID_BOOKING_SMOKE_USAGE).toContain("84532")
    expect(PAID_BOOKING_SMOKE_USAGE).toContain("0x036CbD53842c5426634e7929541eC2318f3dCF7e")
    expect(PAID_BOOKING_SMOKE_USAGE).not.toContain("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")
    expect(PAID_BOOKING_SMOKE_USAGE).toContain("0xbBA024600cba5F375AfdCeC401f7dcCB3D515829")
  })

  test("validates EVM address-shaped values", () => {
    expect(isProbablyAddress(VALID_ADDRESS)).toBe(true)
    expect(isProbablyAddress("0x123")).toBe(false)
    expect(isProbablyAddress("not-an-address")).toBe(false)
  })

  test("parses manual funding preflight arguments", () => {
    expect(parsePositiveInt("8453", "--chain-id")).toBe(8453)
    expect(parsePositiveAtomic("1000000", "--amount-atomic")).toBe("1000000")
    expect(parseAddress(VALID_ADDRESS, "--settlement-address")).toBe(VALID_ADDRESS)
  })

  test("resolves preflight buyer address without loading a private key", () => {
    expect(resolveFundingPreflightBuyerAddress({
      explicitBuyerAddress: VALID_ADDRESS,
      buyerPrivateKey: "",
      privateKeyEnv: "PIRATE_BOOKING_SMOKE_BUYER_PRIVATE_KEY",
    })).toBe(VALID_ADDRESS)
  })

  test("derives preflight buyer address from private key and rejects mismatches", () => {
    const derived = new Wallet(BUYER_PRIVATE_KEY).address
    expect(resolveFundingPreflightBuyerAddress({
      explicitBuyerAddress: null,
      buyerPrivateKey: BUYER_PRIVATE_KEY,
      privateKeyEnv: "PIRATE_BOOKING_SMOKE_BUYER_PRIVATE_KEY",
    })).toBe(derived)
    expect(resolveFundingPreflightBuyerAddress({
      explicitBuyerAddress: derived.toLowerCase(),
      buyerPrivateKey: BUYER_PRIVATE_KEY,
      privateKeyEnv: "PIRATE_BOOKING_SMOKE_BUYER_PRIVATE_KEY",
    })).toBe(derived.toLowerCase())
    expect(() => resolveFundingPreflightBuyerAddress({
      explicitBuyerAddress: VALID_ADDRESS,
      buyerPrivateKey: BUYER_PRIVATE_KEY,
      privateKeyEnv: "PIRATE_BOOKING_SMOKE_BUYER_PRIVATE_KEY",
    })).toThrow("--buyer-address does not match")
  })

  test("requires a buyer address or private key for funding preflight", () => {
    expect(() => resolveFundingPreflightBuyerAddress({
      explicitBuyerAddress: null,
      buyerPrivateKey: "",
      privateKeyEnv: "PIRATE_BOOKING_SMOKE_BUYER_PRIVATE_KEY",
    })).toThrow("PIRATE_BOOKING_SMOKE_BUYER_PRIVATE_KEY or --buyer-address")
  })

  test("rejects malformed manual funding preflight arguments", () => {
    expect(() => parsePositiveInt("0", "--chain-id")).toThrow("--chain-id")
    expect(() => parsePositiveInt("8453.5", "--chain-id")).toThrow("--chain-id")
    expect(() => parsePositiveAtomic("0", "--amount-atomic")).toThrow("--amount-atomic")
    expect(() => parsePositiveAtomic("1.0", "--amount-atomic")).toThrow("--amount-atomic")
    expect(() => parseAddress("0x123", "--settlement-address")).toThrow("--settlement-address")
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

  test("accepts a settled final canary booking with matching tx refs", () => {
    expect(() => validateCompletedCanaryBooking({
      booking: {
        booking_id: "bkg_final",
        status: "settled",
        funding_tx_ref: `0x${"1".repeat(64)}`,
        payout_tx_ref: `0x${"2".repeat(64)}`,
        live_room_id: "pirate-booking-bkg_final",
      },
      bookingId: "bkg_final",
      fundingTxRef: `0x${"1".repeat(64)}`,
    })).not.toThrow()
  })

  test("rejects incomplete final canary booking state", () => {
    expect(() => validateCompletedCanaryBooking({
      booking: {
        booking_id: "bkg_final",
        status: "confirmed",
        funding_tx_ref: `0x${"3".repeat(64)}`,
        payout_tx_ref: null,
        live_room_id: null,
      },
      bookingId: "bkg_final",
      fundingTxRef: `0x${"1".repeat(64)}`,
    })).toThrow("paid booking canary final verification failed")
  })

  test("delayed completion refreshes auth, starts before completing, tolerates already-live, sends no payment", async () => {
    const exchanges: string[] = []
    const calls: string[] = []
    const fakeExchange = async (_origin: string, subject: string) => {
      exchanges.push(subject)
      return { accessToken: `tok-${subject}`, userId: `usr_${subject}`, walletAttachment: "wa_1" }
    }
    const fakeRequest = async (url: string, init?: RequestInit) => {
      const path = url.replace(/^https?:\/\/[^/]+/, "")
      calls.push(`${(init?.method ?? "GET")} ${path}`)
      if (path.endsWith("/start")) return { status: 409, body: {} } // already live → must be tolerated
      if (path.endsWith("/complete")) return { status: 200, body: { booking: { status: "settled" } } }
      return { status: 200, body: {} }
    }

    const res = await runDelayedCompletion({
      origin: "https://api.example",
      bookingId: "bkg_1",
      hostSubject: "host-1",
      bookerSubject: "booker-1",
      buyerWallet: VALID_ADDRESS,
      exchangeSession: fakeExchange as never,
      requestJson: fakeRequest as never,
    })

    // Both sessions re-exchanged (auth refreshed) before any lifecycle call.
    expect(exchanges).toEqual(["host-1", "booker-1"])
    const startIdx = calls.findIndex((c) => c.endsWith("/bookings/bkg_1/start"))
    const completeIdx = calls.findIndex((c) => c.endsWith("/bookings/bkg_1/complete"))
    expect(startIdx).toBeGreaterThanOrEqual(0)
    expect(completeIdx).toBeGreaterThan(startIdx) // start strictly before complete
    // No payment path can run during recovery.
    expect(calls.some((c) => /confirm|holds|payment|transfer/i.test(c))).toBe(false)
    expect(res.completion).toMatchObject({ booking: { status: "settled" } })
    expect(res.booker.accessToken).toBe("tok-booker-1") // refreshed token surfaced for the caller
  })

  test("delayed completion surfaces a failed complete", async () => {
    const fakeExchange = async (_o: string, subject: string) => ({ accessToken: `tok-${subject}`, userId: "u", walletAttachment: null })
    const fakeRequest = async (url: string) => (url.endsWith("/complete") ? { status: 500, body: { error: "boom" } } : { status: 200, body: {} })
    await expect(runDelayedCompletion({
      origin: "https://api.example",
      bookingId: "bkg_2",
      hostSubject: "h",
      bookerSubject: "b",
      buyerWallet: VALID_ADDRESS,
      exchangeSession: fakeExchange as never,
      requestJson: fakeRequest as never,
    })).rejects.toThrow("complete failed")
  })
})
