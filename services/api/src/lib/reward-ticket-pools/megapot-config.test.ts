import { describe, expect, test } from "bun:test"

import type { Env } from "../../env"
import {
  MEGAPOT_DEPLOYMENTS,
  resolveMegapotRuntimeConfig,
  resolveOptionalMegapotRuntimeConfig,
} from "./megapot-config"

const CONFIGURED_ENV: Env = {
  ENVIRONMENT: "staging",
  REWARD_TICKET_POOLS_ENABLED: "true",
  REWARD_TICKET_MEGAPOT_ENVIRONMENT: "testnet",
  REWARD_TICKET_MEGAPOT_RPC_URL: "https://rpc.example.test",
  REWARD_TICKET_PURCHASE_SAFETY_MARGIN_SECONDS: "120",
  REWARD_TICKET_FINALITY_CONFIRMATIONS: "30",
  REWARD_TICKET_CUSTODY_ADDRESS: "0x1000000000000000000000000000000000000001",
  REWARD_TICKET_PURCHASE_OPERATOR_ADDRESS: "0x2000000000000000000000000000000000000002",
  REWARD_TICKET_PLATFORM_REVENUE_ADDRESS: "0x3000000000000000000000000000000000000003",
  REWARD_TICKET_PURCHASE_ESCROW_ADDRESS: "0x4000000000000000000000000000000000000004",
  REWARD_TICKET_COMMITMENT_REGISTRY_ADDRESS: "0x5000000000000000000000000000000000000005",
  REWARD_TICKET_CLAIM_MODULE_ADDRESS: "0x6000000000000000000000000000000000000006",
  REWARD_TICKET_PURCHASE_ESCROW_CODE_HASH: `0x${"4".repeat(64)}`,
  REWARD_TICKET_COMMITMENT_REGISTRY_CODE_HASH: `0x${"5".repeat(64)}`,
  REWARD_TICKET_CLAIM_MODULE_CODE_HASH: `0x${"6".repeat(64)}`,
}

describe("Megapot runtime configuration", () => {
  test("pins the reviewed testnet deployment and requires explicit role separation", () => {
    const config = resolveMegapotRuntimeConfig(CONFIGURED_ENV)
    expect(config.deployment).toBe(MEGAPOT_DEPLOYMENTS.testnet)
    expect(config.deployment.chainId).toBe(84532)
    expect(config.purchaseSafetyMarginSeconds).toBe(120)
    expect(config.minimumConfirmations).toBe(30)
    expect(config.custodyAddress).not.toBe(config.purchaseOperatorAddress)
    expect(config.platformRevenueAddress).not.toBe(config.custodyAddress)
    expect(config.purchaseEscrowAddress).not.toBe(config.custodyAddress)
  })

  test("keeps the feature dark when it is not explicitly enabled", () => {
    expect(resolveOptionalMegapotRuntimeConfig({
      ...CONFIGURED_ENV,
      REWARD_TICKET_POOLS_ENABLED: "false",
    })).toBeNull()
  })

  test("fails closed on a non-mainnet production deployment", () => {
    expect(() => resolveMegapotRuntimeConfig({ ...CONFIGURED_ENV, ENVIRONMENT: "production" }))
      .toThrow("Production reward tickets require Megapot mainnet")
  })

  test("rejects shared custody, purchase, and platform revenue roles", () => {
    expect(() => resolveMegapotRuntimeConfig({
      ...CONFIGURED_ENV,
      REWARD_TICKET_PLATFORM_REVENUE_ADDRESS: CONFIGURED_ENV.REWARD_TICKET_CUSTODY_ADDRESS,
    })).toThrow("must be distinct")
  })
})
