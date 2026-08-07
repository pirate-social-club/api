import { describe, expect, test } from "bun:test"
import * as BunRuntime from "bun"

import type { Env } from "../src/env"
import { resolveNewBookingIntentChainId } from "../src/lib/bookings/booking-settlement-config"
import { resolveRewardsSettlementRpcUrl } from "../src/lib/communities/bookings/booking-chain-config"
import { resolvePirateCheckoutSourceChainId } from "../src/lib/communities/commerce/checkout-config"
import { resolveRewardCampaignAssetConfig } from "../src/lib/rewards/reward-campaign-config"

// Production money paths have gone wrong three separate ways:
//
//   07-30  rewards were armed while pointed at Base Sepolia with Sepolia USDC;
//          only an empty allowlist kept real value from moving (api#949).
//   08-03  checkout's fail-closed guard shipped without the config it made
//          mandatory, and sat on a read path — every authenticated community
//          read 400'd in production (api#999, fixed by api#1031).
//   08-03  bookings had the same testnet config and NO guard at all, so paid
//          bookings quoted faucet-mintable USDC (api#1042).
//
// The tempting invariant, "no testnet chain id in the production block", is
// WRONG here: checkout and bookings are deliberately on Base Sepolia, set by
// api#426 on 07-14, and both are intentionally disabled by their guards. A
// blanket ban would contradict a live decision and fail on green main.
//
// The invariant that actually encodes the intent is:
//
//   every production money path is EITHER on its mandatory mainnet chain,
//   OR on a testnet AND covered by a guard that provably fails closed.
//
// "Provably" is load-bearing: each exception below executes the real resolver
// against the real production config and requires it to throw. A guard that is
// deleted, weakened, or bypassed fails this test even though the config is
// unchanged — which is the failure mode a comment or an allowlist cannot catch.

const BASE_MAINNET_CHAIN_ID = 8453
const KNOWN_TESTNET_CHAIN_IDS = new Set([84532])
const WRANGLER_CONFIG_PATH = new URL("../wrangler.jsonc", import.meta.url)

type MoneyPath =
  | {
    chainIdVar: string
    label: string
    posture: "mainnet_required"
  }
  | {
    chainIdVar: string
    label: string
    posture: "guarded_testnet_exception"
    reason: string
    // Must THROW when handed the production environment. This is the proof that
    // the testnet posture is inert rather than merely intended to be.
    assertFailsClosed: (env: Env) => unknown
  }

const MONEY_PATHS: MoneyPath[] = [
  {
    chainIdVar: "REWARDS_CAMPAIGN_CHAIN_ID",
    label: "reward campaigns",
    posture: "mainnet_required",
  },
  {
    chainIdVar: "PIRATE_REWARDS_SETTLEMENT_CHAIN_ID",
    label: "reward settlement",
    posture: "mainnet_required",
  },
  {
    chainIdVar: "PIRATE_CHECKOUT_SOURCE_CHAIN_ID",
    label: "Pirate checkout",
    posture: "guarded_testnet_exception",
    reason: "Commerce is deliberately not selling (api#426). resolvePirateCheckoutSourceChainId "
      + "refuses to quote, so community money policies advertise no funding routes.",
    assertFailsClosed: (env) => resolvePirateCheckoutSourceChainId(env),
  },
  {
    chainIdVar: "PIRATE_BOOKING_SETTLEMENT_CHAIN_ID",
    label: "paid booking settlement",
    posture: "guarded_testnet_exception",
    reason: "Paid bookings are not selling. resolveNewBookingIntentChainId refuses to mint new "
      + "payment intents (api#1042); existing bookings still settle from persisted snapshots.",
    assertFailsClosed: (env) => resolveNewBookingIntentChainId(env),
  },
]

const productionVars = await (async (): Promise<Record<string, string>> => {
  const config = BunRuntime.JSONC.parse(await BunRuntime.file(WRANGLER_CONFIG_PATH).text()) as {
    env?: { production?: { vars?: Record<string, string> } }
  }
  const vars = config.env?.production?.vars
  if (!vars) throw new Error("wrangler.jsonc has no env.production.vars block")
  return vars
})()

function productionEnv(): Env {
  return { ...productionVars, ENVIRONMENT: "production" } as unknown as Env
}

describe("production money-path invariant", () => {
  test("every production chain id belongs to a declared money path", () => {
    // The ratchet. A fourth money path cannot appear in production without
    // someone declaring its posture here and, if it is testnet, proving the
    // guard. Silence is the failure mode this exists to prevent.
    const declared = new Set(MONEY_PATHS.map((path) => path.chainIdVar))
    const undeclared = Object.keys(productionVars)
      .filter((name) => name.endsWith("_CHAIN_ID"))
      .filter((name) => !declared.has(name))

    expect(undeclared).toEqual([])
  })

  test("production declares every money path it is supposed to", () => {
    for (const path of MONEY_PATHS) {
      expect(productionVars[path.chainIdVar], `${path.label} is missing from production`).toBeDefined()
    }
  })

  for (const path of MONEY_PATHS.filter((entry) => entry.posture === "mainnet_required")) {
    test(`${path.label} settles on Base mainnet`, () => {
      expect(Number(productionVars[path.chainIdVar])).toBe(BASE_MAINNET_CHAIN_ID)
    })
  }

  for (const path of MONEY_PATHS) {
    if (path.posture !== "guarded_testnet_exception") continue

    test(`${path.label} is on a testnet only because its guard fails closed`, () => {
      const chainId = Number(productionVars[path.chainIdVar])

      // Once the exception is retired the guard stops throwing, and this test
      // should be deleted along with the entry — not "fixed" by loosening it.
      if (chainId === BASE_MAINNET_CHAIN_ID) {
        expect(path.assertFailsClosed(productionEnv())).toBe(BASE_MAINNET_CHAIN_ID)
        return
      }

      expect(KNOWN_TESTNET_CHAIN_IDS.has(chainId), `${path.chainIdVar}=${chainId} is neither mainnet nor a known testnet`).toBe(true)
      // The whole point: prove it is inert, do not take the reason on faith.
      expect(() => path.assertFailsClosed(productionEnv())).toThrow()
    })
  }

  test("mainnet money paths do not point at a testnet RPC or testnet USDC", () => {
    // A correct chain id with a Sepolia RPC or Sepolia USDC beside it is the
    // same defect wearing a different hat.
    const SEPOLIA_USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e"
    for (const path of MONEY_PATHS) {
      if (path.posture !== "mainnet_required") continue
      const prefix = path.chainIdVar.replace(/_CHAIN_ID$/, "")

      const rpcUrl = productionVars[`${prefix}_RPC_URL`]
      if (rpcUrl) expect(rpcUrl, `${path.label} RPC`).not.toMatch(/sepolia/i)

      const usdc = productionVars[`${prefix}_USDC_TOKEN_ADDRESS`]
      if (usdc) expect(usdc.toLowerCase(), `${path.label} USDC`).not.toBe(SEPOLIA_USDC)
    }
  })

  test("reward RPCs are resolved from the keyed mainnet fallback", () => {
    expect(productionVars.BASE_MAINNET_RPC_URL).toBeUndefined()
    expect(productionVars.REWARDS_CAMPAIGN_RPC_URL).toBeUndefined()
    expect(productionVars.PIRATE_REWARDS_SETTLEMENT_RPC_URL).toBeUndefined()

    expect(resolveRewardCampaignAssetConfig({
      ...productionVars,
      REWARDS_CAMPAIGN_RPC_URL: undefined,
      BASE_MAINNET_RPC_URL: "https://keyed-mainnet.example.test",
    } as Env).rpcUrl).toBe("https://keyed-mainnet.example.test")
    expect(resolveRewardsSettlementRpcUrl({
      ...productionVars,
      PIRATE_REWARDS_SETTLEMENT_RPC_URL: undefined,
      BASE_MAINNET_RPC_URL: "https://keyed-mainnet.example.test",
    } as Env)).toBe("https://keyed-mainnet.example.test")
  })
})
