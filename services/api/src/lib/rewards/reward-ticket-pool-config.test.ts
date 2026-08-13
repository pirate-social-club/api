import { describe, expect, test } from "bun:test"

import type { Env } from "../../env"
import { HttpError } from "../errors"
import { resolveRewardTicketPoolConfig } from "./reward-ticket-pool-config"

const addressA = "0x1000000000000000000000000000000000000001"
const addressB = "0x2000000000000000000000000000000000000002"
const addressC = "0x3000000000000000000000000000000000000003"
const addressD = "0x4000000000000000000000000000000000000004"
const addressE = "0x5000000000000000000000000000000000000005"
const addressF = "0x6000000000000000000000000000000000000006"

function configuredEnv(overrides: Partial<Env> = {}): Env {
  return {
    REWARD_TICKET_POOLS_ENABLED: "true",
    MEGAPOT_CHAIN_ID: "84532",
    MEGAPOT_RPC_URL: "https://base-sepolia.example.test",
    MEGAPOT_JACKPOT_ADDRESS: addressA,
    MEGAPOT_RANDOM_TICKET_BUYER_ADDRESS: addressB,
    MEGAPOT_TICKET_NFT_ADDRESS: addressC,
    MEGAPOT_USDC_TOKEN_ADDRESS: addressD,
    MEGAPOT_CUSTODY_ADDRESS: addressE,
    MEGAPOT_REFERRER_ADDRESS: addressF,
    MEGAPOT_SOURCE_TAG: "pirate-song-pools",
    MEGAPOT_PRICE_QUOTE_TTL_SECONDS: "900",
    MEGAPOT_ENTRY_CUTOFF_SECONDS: "300",
    MEGAPOT_PURCHASE_REVIEW_TTL_SECONDS: "3600",
    MEGAPOT_SWEEP_STALE_SECONDS: "900",
    MEGAPOT_ALERT_OWNER: "reward-operations",
    MEGAPOT_ALERT_DESTINATION: "reward-alerts",
    ...overrides,
  } as Env
}

describe("reward ticket pool config", () => {
  test("is disabled without reading protocol configuration", () => {
    expect(resolveRewardTicketPoolConfig({} as Env)).toMatchObject({
      enabled: false,
      chainId: 0,
      rpcUrl: "",
      jackpotAddress: "",
    })
  })

  test("resolves a complete Base Sepolia public protocol config", () => {
    expect(resolveRewardTicketPoolConfig(configuredEnv())).toMatchObject({
      enabled: true,
      mainnetEnabled: false,
      chainId: 84532,
      rpcUrl: "https://base-sepolia.example.test",
      jackpotAddress: addressA,
      custodyAddress: addressE,
      sourceTag: "pirate-song-pools",
      priceQuoteTtlSeconds: 900,
      entryCutoffSeconds: 300,
    })
  })

  test("fails closed when an enabled rail is incomplete or unsafe", () => {
    for (const env of [
      configuredEnv({ MEGAPOT_JACKPOT_ADDRESS: undefined }),
      configuredEnv({ MEGAPOT_RPC_URL: "http://unsafe.example.test" }),
      configuredEnv({ MEGAPOT_SOURCE_TAG: "x".repeat(33) }),
      configuredEnv({ MEGAPOT_PRICE_QUOTE_TTL_SECONDS: "0" }),
    ]) {
      expect(() => resolveRewardTicketPoolConfig(env)).toThrow(HttpError)
    }
  })

  test("requires a separate promotion gate for Base mainnet", () => {
    expect(() => resolveRewardTicketPoolConfig(configuredEnv({ MEGAPOT_CHAIN_ID: "8453" }))).toThrow(HttpError)
    expect(resolveRewardTicketPoolConfig(configuredEnv({
      MEGAPOT_CHAIN_ID: "8453",
      REWARD_TICKET_POOLS_MAINNET_ENABLED: "true",
    })).chainId).toBe(8453)
  })
})
