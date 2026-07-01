import { describe, expect, test } from "bun:test";
import { Wallet } from "ethers";

import type { Env } from "../../env";
import {
  resolveBookingSettlementOperatorAddress,
  resolveBookingSettlementChainId,
  resolveBookingSettlementUsdcTokenAddress,
} from "./booking-settlement-config";

const SEPOLIA_USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";

describe("global booking settlement config guards", () => {
  test("allowlists only Base chains", () => {
    expect(resolveBookingSettlementChainId({ PIRATE_BOOKING_SETTLEMENT_CHAIN_ID: "84532" } as Env)).toBe(84532);
    expect(resolveBookingSettlementChainId({ PIRATE_BOOKING_SETTLEMENT_CHAIN_ID: "8453" } as Env)).toBe(8453);
    expect(() => resolveBookingSettlementChainId({ PIRATE_BOOKING_SETTLEMENT_CHAIN_ID: "1" } as Env)).toThrow(/not an allowlisted/);
    expect(() => resolveBookingSettlementChainId({ PIRATE_BOOKING_SETTLEMENT_CHAIN_ID: "999999" } as Env)).toThrow(/not an allowlisted/);
    expect(() => resolveBookingSettlementChainId({} as Env)).toThrow(/is required/);
  });

  test("defaults to canonical USDC and pins overrides", () => {
    const base = { PIRATE_BOOKING_SETTLEMENT_CHAIN_ID: "84532" } as Env;
    // Default (no override) -> canonical, lowercased as the global module stores it.
    expect(resolveBookingSettlementUsdcTokenAddress(base)).toBe(SEPOLIA_USDC);
    // Canonical override accepted.
    expect(resolveBookingSettlementUsdcTokenAddress({ ...base, PIRATE_BOOKING_SETTLEMENT_USDC_TOKEN_ADDRESS: SEPOLIA_USDC } as Env)).toBe(SEPOLIA_USDC);
    // Non-canonical override refused by default, allowed with the explicit opt-out.
    const rogue = "0x000000000000000000000000000000000000dead";
    expect(() => resolveBookingSettlementUsdcTokenAddress({ ...base, PIRATE_BOOKING_SETTLEMENT_USDC_TOKEN_ADDRESS: rogue } as Env)).toThrow(/does not match the canonical/);
    expect(resolveBookingSettlementUsdcTokenAddress({
      ...base,
      PIRATE_BOOKING_SETTLEMENT_USDC_TOKEN_ADDRESS: rogue,
      PIRATE_BOOKING_SETTLEMENT_ALLOW_TOKEN_OVERRIDE: "true",
    } as Env)).toBe(rogue);
  });

  test("requires configured operator address to match the signing key when both are present", () => {
    const privateKey = "0x59c6995e998f97a5a0044966f094538d9dae6e082cfe7b59f20e0e8a1f8f5f6b";
    const address = new Wallet(privateKey).address.toLowerCase();
    expect(resolveBookingSettlementOperatorAddress({
      PIRATE_BOOKING_SETTLEMENT_OPERATOR_PRIVATE_KEY: privateKey,
      PIRATE_BOOKING_SETTLEMENT_OPERATOR_ADDRESS: address,
    } as Env)).toBe(address);
    expect(() => resolveBookingSettlementOperatorAddress({
      PIRATE_BOOKING_SETTLEMENT_OPERATOR_PRIVATE_KEY: privateKey,
      PIRATE_BOOKING_SETTLEMENT_OPERATOR_ADDRESS: "0x0000000000000000000000000000000000000001",
    } as Env)).toThrow(/mismatch/);
  });
});
