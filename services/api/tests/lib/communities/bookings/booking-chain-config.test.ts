import { describe, expect, test } from "bun:test"
import { Wallet, getAddress } from "ethers"

import type { Env } from "../../../../src/env"
import {
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

  test("requires an explicit booking USDC token for unknown booking chains", () => {
    const env = {
      PIRATE_BOOKING_SETTLEMENT_CHAIN_ID: "999999",
      PIRATE_BOOKING_SETTLEMENT_RPC_URL: "https://custom.example",
      PIRATE_BOOKING_SETTLEMENT_OPERATOR_PRIVATE_KEY: KEY,
    } as Env

    expect(() => resolveBookingSettlementUsdcTokenAddress(env)).toThrow(/PIRATE_BOOKING_SETTLEMENT_USDC_TOKEN_ADDRESS/)
  })
})
