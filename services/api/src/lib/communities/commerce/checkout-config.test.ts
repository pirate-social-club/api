import { describe, expect, test } from "bun:test"
import { Wallet } from "ethers"

import type { Env } from "../../../env"
import {
  assertPirateCheckoutRefundReadiness,
  resolvePirateCheckoutOperatorAddress,
} from "./checkout-config"

const checkoutKey = `0x${"11".repeat(32)}`
const checkoutAddress = new Wallet(checkoutKey).address

function readyEnv(overrides: Partial<Env> = {}): Env {
  return {
    PIRATE_CHECKOUT_CUSTODY_KEY_EPOCH: "epoch_test",
    PIRATE_CHECKOUT_OPERATOR_ADDRESS: checkoutAddress,
    PIRATE_CHECKOUT_OPERATOR_PRIVATE_KEY: checkoutKey,
    PIRATE_CHECKOUT_RPC_URL: "https://rpc.invalid",
    PIRATE_CHECKOUT_SOURCE_CHAIN_ID: "84532",
    PIRATE_CHECKOUT_USDC_TOKEN_ADDRESS: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
    ...overrides,
  } as Env
}

describe("checkout refund readiness", () => {
  test("derives a complete custody snapshot from a matching key and address", () => {
    expect(assertPirateCheckoutRefundReadiness(readyEnv())).toMatchObject({
      chainId: 84532,
      custodyAccountId: `pirate_checkout:${checkoutAddress.toLowerCase()}`,
      custodyKeyEpoch: "epoch_test",
      operatorAddress: checkoutAddress,
    })
  })

  test("rejects address and key drift before a quote can snapshot custody", () => {
    const otherAddress = new Wallet(`0x${"22".repeat(32)}`).address
    expect(() => resolvePirateCheckoutOperatorAddress(readyEnv({
      PIRATE_CHECKOUT_OPERATOR_ADDRESS: otherAddress,
    }))).toThrow("mismatch")
  })

  test("rejects a shared same-chain nonce domain", () => {
    expect(() => assertPirateCheckoutRefundReadiness(readyEnv({
      PIRATE_BOOKING_SETTLEMENT_CHAIN_ID: "84532",
      PIRATE_BOOKING_SETTLEMENT_OPERATOR_ADDRESS: checkoutAddress,
      PIRATE_BOOKING_SETTLEMENT_OPERATOR_PRIVATE_KEY: checkoutKey,
    }))).toThrow("must use distinct operator signers")
  })
})
