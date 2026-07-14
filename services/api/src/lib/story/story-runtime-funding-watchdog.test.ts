import { parseEther } from "ethers"
import { beforeEach, describe, expect, test } from "bun:test"

import type { Env } from "../../env"
import {
  listStoryRuntimeSignerAddresses,
  type StoryRuntimeSignerBalance,
} from "./story-runtime-funding"
import {
  resetStoryRuntimeFundingWatchdogStateForTests,
  resolveStorySignerExplorerUrl,
  runStoryRuntimeFundingWatchdog,
} from "./story-runtime-funding-watchdog"

// A valid throwaway private key so listStoryRuntimeSignerAddresses (the
// "configured?" guard) resolves every signer. Never used to sign anything.
const DUMMY_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"

// Defaults with no gas env: worst-case tx = 1.5M gas * 5 gwei = 0.0075 IP.
// Margin N=3 → 0.0225 IP above the enforced floor.
// operator enforced floor = target (0.5 IP); others = min (0.25 IP).
const OPERATOR_THRESHOLD_IP = "0.5225" // 0.5 + 3*0.0075
const CDR_THRESHOLD_IP = "0.2725" // 0.25 + 3*0.0075

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    STORY_RUNTIME_PRIVATE_KEY: DUMMY_KEY,
    STORY_CHAIN_ID: "1315",
    ...overrides,
  } as unknown as Env
}

const ADDR: Record<string, `0x${string}`> = {
  "story-operator": "0xc77Ad4de7d179FFFBa417cA24c055d86Af69F4BB",
  "story-entitlement-class-configurer": "0xbE03F72356A82F830811c1f487Bc18400CB85734",
  "story-cdr-writer": "0x9d5Dc963A948a77091c905854fB9036CbFA9e9FB",
  "story-settlement": "0x526331ddA08972173C485b874956818E8a0b7D2F",
}

function balances(byName: Partial<Record<string, string>>): StoryRuntimeSignerBalance[] {
  return (Object.keys(ADDR) as Array<keyof typeof ADDR>).map((name) => ({
    name: name as StoryRuntimeSignerBalance["name"],
    address: ADDR[name],
    balanceWei: parseEther(byName[name] ?? "1.0"),
  }))
}

const fetchStub = (byName: Partial<Record<string, string>>) => async () => balances(byName)

beforeEach(() => {
  resetStoryRuntimeFundingWatchdogStateForTests()
})

describe("runStoryRuntimeFundingWatchdog", () => {
  test("links known Story networks to their address explorers", () => {
    expect(resolveStorySignerExplorerUrl(1315, ADDR["story-settlement"])).toBe(
      `https://aeneid.storyscan.io/address/${ADDR["story-settlement"]}`,
    )
    expect(resolveStorySignerExplorerUrl(1514, ADDR["story-settlement"])).toBe(
      `https://www.storyscan.io/address/${ADDR["story-settlement"]}`,
    )
    expect(resolveStorySignerExplorerUrl(1, ADDR["story-settlement"])).toBeNull()
  })

  test("includes the entitlement configurer in the runtime funding inventory", () => {
    expect(listStoryRuntimeSignerAddresses(baseEnv()).map((signer) => signer.name)).toEqual([
      "story-operator",
      "story-entitlement-class-configurer",
      "story-cdr-writer",
      "story-settlement",
    ])
  })

  test("no alerts when every signer is above its warn threshold", async () => {
    const result = await runStoryRuntimeFundingWatchdog(baseEnv(), {
      fetchBalances: fetchStub({ "story-operator": "0.6", "story-cdr-writer": "0.4", "story-settlement": "0.4" }),
    })
    expect(result.ran).toBe(true)
    expect(result.alerts).toEqual([])
  })

  test("critical alert when the operator is below its enforced floor (the incident: 0.4877 < 0.5)", async () => {
    const result = await runStoryRuntimeFundingWatchdog(baseEnv(), {
      fetchBalances: fetchStub({ "story-operator": "0.487710929991988255", "story-cdr-writer": "0.4", "story-settlement": "0.4" }),
    })
    expect(result.alerts).toHaveLength(1)
    const alert = result.alerts[0]
    expect(alert.name).toBe("story-operator")
    expect(alert.severity).toBe("critical")
    // below floor → negative headroom
    expect(alert.txHeadroom).toBeLessThan(0)
    expect(alert.warnThresholdWei).toBe(parseEther(OPERATOR_THRESHOLD_IP))
  })

  test("warning (not critical) when the operator has low runway but is still above the floor", async () => {
    // 0.51 is above the 0.5 floor but below the 0.5225 warn threshold.
    const result = await runStoryRuntimeFundingWatchdog(baseEnv(), {
      fetchBalances: fetchStub({ "story-operator": "0.51", "story-cdr-writer": "0.4", "story-settlement": "0.4" }),
    })
    expect(result.alerts).toHaveLength(1)
    expect(result.alerts[0].severity).toBe("warning")
    expect(result.alerts[0].txHeadroom).toBeGreaterThanOrEqual(0)
  })

  test("catches the low staging settlement wallet (0.11 < 0.25)", async () => {
    const result = await runStoryRuntimeFundingWatchdog(baseEnv(), {
      fetchBalances: fetchStub({ "story-operator": "0.6", "story-cdr-writer": "0.4", "story-settlement": "0.1116" }),
    })
    expect(result.alerts).toHaveLength(1)
    expect(result.alerts[0].name).toBe("story-settlement")
    expect(result.alerts[0].severity).toBe("critical")
    expect(result.alerts[0].explorerUrl).toBe(
      `https://aeneid.storyscan.io/address/${ADDR["story-settlement"]}`,
    )
    expect(result.alerts[0].warnThresholdWei).toBe(parseEther(CDR_THRESHOLD_IP))
  })

  test("catches an entitlement configurer below its funding floor", async () => {
    const result = await runStoryRuntimeFundingWatchdog(baseEnv(), {
      fetchBalances: fetchStub({ "story-entitlement-class-configurer": "0.1826" }),
    })
    expect(result.alerts).toHaveLength(1)
    expect(result.alerts[0].name).toBe("story-entitlement-class-configurer")
    expect(result.alerts[0].severity).toBe("critical")
    expect(result.alerts[0].warnThresholdWei).toBe(parseEther(CDR_THRESHOLD_IP))
  })

  test("uses TARGET for the operator floor but MIN for other signers", async () => {
    // 0.4 is below the operator's 0.5 target-floor but above the others' 0.25 min-floor.
    const result = await runStoryRuntimeFundingWatchdog(baseEnv(), {
      fetchBalances: fetchStub({ "story-operator": "0.4", "story-cdr-writer": "0.4", "story-settlement": "0.4" }),
    })
    expect(result.alerts.map((a) => a.name)).toEqual(["story-operator"])
  })

  test("rate-limits repeated runs within the interval", async () => {
    const first = await runStoryRuntimeFundingWatchdog(baseEnv(), { now: 1_000, fetchBalances: fetchStub({}) })
    expect(first.ran).toBe(true)
    const second = await runStoryRuntimeFundingWatchdog(baseEnv(), { now: 2_000, fetchBalances: fetchStub({}) })
    expect(second.ran).toBe(false)
    expect(second.reason).toBe("rate_limited")
    // past the default 5-minute interval it runs again
    const third = await runStoryRuntimeFundingWatchdog(baseEnv(), { now: 1_000 + 300_001, fetchBalances: fetchStub({}) })
    expect(third.ran).toBe(true)
  })

  test("skips quietly when signer keys are unconfigured (no RPC, no error)", async () => {
    let fetched = false
    const result = await runStoryRuntimeFundingWatchdog(baseEnv({ STORY_RUNTIME_PRIVATE_KEY: undefined }), {
      fetchBalances: async () => {
        fetched = true
        return []
      },
    })
    expect(result.ran).toBe(false)
    expect(result.reason).toBe("signers_unconfigured")
    expect(fetched).toBe(false)
  })

  test("fails soft on an RPC error (no throw, marked rpc_error)", async () => {
    const result = await runStoryRuntimeFundingWatchdog(baseEnv(), {
      fetchBalances: async () => {
        throw new Error("aeneid RPC 502")
      },
    })
    expect(result.ran).toBe(true)
    expect(result.reason).toBe("rpc_error")
    expect(result.alerts).toEqual([])
  })
})
