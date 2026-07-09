import { describe, expect, test } from "bun:test"
import { Wallet, getAddress } from "ethers"

import type { Env } from "../../../../src/env"
import {
  assertDistinctBookingAndRewardsSignerDomains,
  resolveBookingSettlementChainId,
  resolveBookingSettlementOperatorAddress,
  resolveBookingSettlementRpcUrl,
  resolveBookingSettlementUsdcTokenAddress,
} from "../../../../src/lib/communities/bookings/booking-chain-config"
import {
  resolvePirateCheckoutSourceChainId,
  resolvePirateCheckoutUsdcTokenAddress,
} from "../../../../src/lib/communities/commerce/checkout-config"

const KEY = "0x6000000000000000000000000000000000000000000000000000000000000006"

describe("booking settlement chain config", () => {
  test("fails closed when booking chain config is absent, even if global checkout is mainnet", () => {
    const env = {
      PIRATE_CHECKOUT_SOURCE_CHAIN_ID: "8453",
      PIRATE_CHECKOUT_RPC_URL: "https://mainnet.example",
      PIRATE_CHECKOUT_OPERATOR_PRIVATE_KEY: KEY,
    } as Env

    expect(resolvePirateCheckoutSourceChainId(env)).toBe(8453)
    expect(() => resolveBookingSettlementChainId(env)).toThrow(/PIRATE_BOOKING_SETTLEMENT_CHAIN_ID/)
    expect(() => resolveBookingSettlementRpcUrl(env)).toThrow(/PIRATE_BOOKING_SETTLEMENT_CHAIN_ID/)
    expect(() => resolveBookingSettlementUsdcTokenAddress(env)).toThrow(/PIRATE_BOOKING_SETTLEMENT_CHAIN_ID/)
  })

  test("uses booking-specific Base Sepolia config without mutating global checkout commerce", () => {
    const env = {
      PIRATE_CHECKOUT_SOURCE_CHAIN_ID: "8453",
      PIRATE_CHECKOUT_RPC_URL: "https://mainnet.example",
      PIRATE_BOOKING_SETTLEMENT_CHAIN_ID: "84532",
      PIRATE_BOOKING_SETTLEMENT_RPC_URL: "https://sepolia.example",
      PIRATE_BOOKING_SETTLEMENT_OPERATOR_PRIVATE_KEY: KEY,
    } as Env

    expect(resolvePirateCheckoutSourceChainId(env)).toBe(8453)
    expect(resolvePirateCheckoutUsdcTokenAddress(env)).toBe(getAddress("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"))
    expect(resolveBookingSettlementChainId(env)).toBe(84532)
    expect(resolveBookingSettlementRpcUrl(env)).toBe("https://sepolia.example")
    expect(resolveBookingSettlementUsdcTokenAddress(env)).toBe(getAddress("0x036cbd53842c5426634e7929541ec2318f3dcf7e"))
    expect(resolveBookingSettlementOperatorAddress(env)).toBe(new Wallet(KEY).address)
  })

  test("rejects a non-allowlisted booking settlement chain", () => {
    const env = {
      PIRATE_BOOKING_SETTLEMENT_CHAIN_ID: "999999",
      PIRATE_BOOKING_SETTLEMENT_RPC_URL: "https://custom.example",
      PIRATE_BOOKING_SETTLEMENT_OPERATOR_PRIVATE_KEY: KEY,
    } as Env

    expect(() => resolveBookingSettlementChainId(env)).toThrow(/not an allowlisted/)
    expect(() => resolveBookingSettlementUsdcTokenAddress(env)).toThrow(/not an allowlisted/)
  })

  test("pins the USDC token to the canonical address unless override is allowlisted", () => {
    const base = {
      PIRATE_BOOKING_SETTLEMENT_CHAIN_ID: "84532",
      PIRATE_BOOKING_SETTLEMENT_RPC_URL: "https://sepolia.example",
      PIRATE_BOOKING_SETTLEMENT_OPERATOR_PRIVATE_KEY: KEY,
    }
    const canonical = getAddress("0x036cbd53842c5426634e7929541ec2318f3dcf7e")
    const rogue = "0x000000000000000000000000000000000000dEaD"

    // A canonical override is fine.
    expect(resolveBookingSettlementUsdcTokenAddress({ ...base, PIRATE_BOOKING_SETTLEMENT_USDC_TOKEN_ADDRESS: canonical } as Env)).toBe(canonical)
    // A non-canonical override is refused by default...
    expect(() => resolveBookingSettlementUsdcTokenAddress({ ...base, PIRATE_BOOKING_SETTLEMENT_USDC_TOKEN_ADDRESS: rogue } as Env)).toThrow(/does not match the canonical/)
    // ...unless explicitly opted out.
    expect(resolveBookingSettlementUsdcTokenAddress({
      ...base,
      PIRATE_BOOKING_SETTLEMENT_USDC_TOKEN_ADDRESS: rogue,
      PIRATE_BOOKING_SETTLEMENT_ALLOW_TOKEN_OVERRIDE: "true",
    } as Env)).toBe(getAddress(rogue))
  })

  test("refuses when the configured operator address does not derive from the signing key", () => {
    const env = {
      PIRATE_BOOKING_SETTLEMENT_CHAIN_ID: "84532",
      PIRATE_BOOKING_SETTLEMENT_RPC_URL: "https://sepolia.example",
      PIRATE_BOOKING_SETTLEMENT_OPERATOR_PRIVATE_KEY: KEY,
      PIRATE_BOOKING_SETTLEMENT_OPERATOR_ADDRESS: "0x000000000000000000000000000000000000dEaD",
    } as Env
    expect(() => resolveBookingSettlementOperatorAddress(env)).toThrow(/mismatch/)
  })

  test("accepts a configured operator address that matches the signing key", () => {
    const env = {
      PIRATE_BOOKING_SETTLEMENT_CHAIN_ID: "84532",
      PIRATE_BOOKING_SETTLEMENT_RPC_URL: "https://sepolia.example",
      PIRATE_BOOKING_SETTLEMENT_OPERATOR_PRIVATE_KEY: KEY,
      PIRATE_BOOKING_SETTLEMENT_OPERATOR_ADDRESS: new Wallet(KEY).address,
    } as Env
    expect(resolveBookingSettlementOperatorAddress(env)).toBe(new Wallet(KEY).address)
  })

  test("rejects sharing one on-chain signer across independent booking and reward nonce coordinators", () => {
    const env = {
      PIRATE_BOOKING_SETTLEMENT_CHAIN_ID: "84532",
      PIRATE_BOOKING_SETTLEMENT_OPERATOR_PRIVATE_KEY: KEY,
      PIRATE_REWARDS_SETTLEMENT_CHAIN_ID: "84532",
      PIRATE_REWARDS_SETTLEMENT_OPERATOR_PRIVATE_KEY: KEY,
    } as Env

    expect(() => assertDistinctBookingAndRewardsSignerDomains(env)).toThrow(/distinct operator signers/)
  })

  test("allows distinct signers on the same settlement chain", () => {
    const env = {
      PIRATE_BOOKING_SETTLEMENT_CHAIN_ID: "84532",
      PIRATE_BOOKING_SETTLEMENT_OPERATOR_PRIVATE_KEY: KEY,
      PIRATE_REWARDS_SETTLEMENT_CHAIN_ID: "84532",
      PIRATE_REWARDS_SETTLEMENT_OPERATOR_PRIVATE_KEY: "0x7000000000000000000000000000000000000000000000000000000000000007",
    } as Env

    expect(() => assertDistinctBookingAndRewardsSignerDomains(env)).not.toThrow()
  })
})
