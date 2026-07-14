import { beforeEach, describe, expect, test } from "bun:test"
import type { Env } from "../../env"
import {
  listRuntimeWalletFundingSpecs,
  resetRuntimeWalletFundingWatchdogStateForTests,
  runRuntimeWalletFundingWatchdog,
  type RuntimeWalletFundingSpec,
} from "./runtime-wallet-funding-watchdog"

const STORY_FUNDER: RuntimeWalletFundingSpec = {
  name: "story-runtime-funder",
  address: "0xfBC505c0E2659400618b6cE0215b1ba4A2c5d79B",
  chainId: 1315,
  rpcUrl: "https://aeneid.storyrpc.io",
  nativeSymbol: "IP",
  nativeMinWei: 500_000_000_000_000_000n,
}

const BASE_OPERATOR: RuntimeWalletFundingSpec = {
  name: "base-booking-operator",
  address: "0xbBA024600cba5F375AfdCeC401f7dcCB3D515829",
  chainId: 84532,
  rpcUrl: "https://sepolia.base.org",
  nativeSymbol: "ETH",
  nativeMinWei: 1_000_000_000_000_000n,
  token: {
    address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    symbol: "USDC",
    decimals: 6,
    minAtomic: 1_000_000n,
  },
}

beforeEach(() => resetRuntimeWalletFundingWatchdogStateForTests())

describe("runRuntimeWalletFundingWatchdog", () => {
  test("keeps valid wallets when another wallet has incomplete configuration", () => {
    const specs = listRuntimeWalletFundingSpecs({
      STORY_RUNTIME_FUNDER_PRIVATE_KEY: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
      STORY_RPC_URL: "https://aeneid.storyrpc.io",
      PIRATE_BOOKING_SETTLEMENT_OPERATOR_ADDRESS: BASE_OPERATOR.address,
    } as Env)

    expect(specs.map((spec) => spec.name)).toEqual(["story-runtime-funder"])
  })

  test("alerts on a dry Story funder and Base native/USDC balances", async () => {
    const result = await runRuntimeWalletFundingWatchdog({} as Env, {
      specs: [STORY_FUNDER, BASE_OPERATOR],
      readNativeBalance: async () => 0n,
      readTokenBalance: async () => 0n,
    })

    expect(result.ran).toBe(true)
    expect(result.alerts.map((alert) => `${alert.wallet}:${alert.asset}`)).toEqual([
      "story-runtime-funder:native",
      "base-booking-operator:native",
      "base-booking-operator:USDC",
    ])
  })

  test("stays quiet when every configured floor is satisfied", async () => {
    const result = await runRuntimeWalletFundingWatchdog({} as Env, {
      specs: [STORY_FUNDER, BASE_OPERATOR],
      readNativeBalance: async (spec) => spec.nativeMinWei,
      readTokenBalance: async (spec) => spec.token?.minAtomic ?? 0n,
    })
    expect(result.alerts).toEqual([])
  })

  test("rate limits repeated checks", async () => {
    const first = await runRuntimeWalletFundingWatchdog({} as Env, {
      now: 1_000,
      specs: [],
    })
    const second = await runRuntimeWalletFundingWatchdog({} as Env, {
      now: 2_000,
      specs: [],
    })
    expect(first.ran).toBe(true)
    expect(second.ran).toBe(false)
  })
})
