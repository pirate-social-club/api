import { beforeEach, describe, expect, test } from "bun:test"
import type { Env } from "../../env"
import {
  getRuntimeWalletFundingStatuses,
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

  test("monitors a distinct contract owner alongside a dedicated funder", () => {
    // Two different throwaway keys → funder and owner are distinct wallets.
    const specs = listRuntimeWalletFundingSpecs({
      STORY_RUNTIME_FUNDER_PRIVATE_KEY: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
      STORY_CONTRACT_OWNER_PRIVATE_KEY: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
      STORY_RPC_URL: "https://aeneid.storyrpc.io",
    } as Env)

    expect(specs.map((spec) => spec.name)).toEqual(["story-runtime-funder", "story-contract-owner"])
  })

  test("skips the contract owner when it is the funding fallback", () => {
    // No dedicated funder key: the owner IS story-runtime-funder; a second
    // spec would double-alert the same address.
    const specs = listRuntimeWalletFundingSpecs({
      STORY_CONTRACT_OWNER_PRIVATE_KEY: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
      STORY_RPC_URL: "https://aeneid.storyrpc.io",
    } as Env)

    expect(specs.map((spec) => spec.name)).toEqual(["story-runtime-funder"])
  })

  test("monitors a dedicated Endaoment payout wallet", () => {
    const specs = listRuntimeWalletFundingSpecs({
      ENDAOMENT_PAYOUT_PRIVATE_KEY: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
      PIRATE_CHECKOUT_OPERATOR_PRIVATE_KEY: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
      PIRATE_CHECKOUT_OPERATOR_ADDRESS: "0xFABB0ac9d68B0B445fB7357272Ff202C5651694a",
      PIRATE_CHECKOUT_SOURCE_CHAIN_ID: "84532",
      PIRATE_CHECKOUT_RPC_URL: "https://sepolia.base.org",
      PIRATE_CHECKOUT_USDC_TOKEN_ADDRESS: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    } as Env)

    const endaoment = specs.find((spec) => spec.name === "endaoment-payout")
    expect(endaoment).toBeDefined()
    expect(endaoment?.token?.symbol).toBe("USDC")
    expect(endaoment?.chainId).toBe(84532)
  })

  test("skips the Endaoment payout wallet when it falls back to the checkout operator", () => {
    const sharedKey = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
    const specs = listRuntimeWalletFundingSpecs({
      ENDAOMENT_PAYOUT_PRIVATE_KEY: sharedKey,
      PIRATE_CHECKOUT_OPERATOR_PRIVATE_KEY: sharedKey,
      PIRATE_CHECKOUT_SOURCE_CHAIN_ID: "84532",
      PIRATE_CHECKOUT_RPC_URL: "https://sepolia.base.org",
      PIRATE_CHECKOUT_USDC_TOKEN_ADDRESS: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    } as Env)

    expect(specs.filter((spec) => spec.name === "endaoment-payout")).toEqual([])
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

describe("getRuntimeWalletFundingStatuses", () => {
  test("reports balances, floors, and ok flags without alerting", async () => {
    const statuses = await getRuntimeWalletFundingStatuses({} as Env, {
      specs: [STORY_FUNDER, BASE_OPERATOR],
      readNativeBalance: async (spec) => (spec.name === "story-runtime-funder" ? 0n : spec.nativeMinWei),
      readTokenBalance: async (spec) => spec.token?.minAtomic ?? 0n,
    })

    expect(statuses.map((status) => `${status.wallet}:${status.native?.ok}`)).toEqual([
      "story-runtime-funder:false",
      "base-booking-operator:true",
    ])
    expect(statuses[1]?.token?.ok).toBe(true)
    expect(statuses[0]?.token).toBeNull()
  })

  test("captures per-wallet read failures as errors", async () => {
    const statuses = await getRuntimeWalletFundingStatuses({} as Env, {
      specs: [STORY_FUNDER],
      readNativeBalance: async () => {
        throw new Error("rpc down")
      },
    })
    expect(statuses[0]?.error).toBe("rpc down")
    expect(statuses[0]?.native).toBeNull()
  })
})
