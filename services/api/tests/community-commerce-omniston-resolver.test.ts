import { describe, expect, test } from "bun:test"
import {
  createOmnistonAcquisitionResolver,
  isLiveOmnistonEnabled,
  mapOmnistonRouteStatusToAcquisition,
  resolveLiveOmnistonResolver,
  type OmnistonClient,
  type OmnistonRouteStatus,
} from "../src/lib/communities/commerce/funding-source/omniston-resolver"
import type { FundingSourceAcquireInput } from "../src/lib/communities/commerce/funding-source/types"

const INPUT: FundingSourceAcquireInput = {
  provider: "omniston_ton",
  sourceTxRef: "ton:msg:abc",
  routeRef: "omni-route-1",
}

// Recorded-mainnet-shaped Omniston route statuses (placeholders until the real API is wired).
const FIXTURES: Record<string, OmnistonRouteStatus> = {
  pending: { routeId: "omni-route-1", state: "pending" },
  filled: { routeId: "omni-route-1", state: "filled", destinationTxHash: "0xBASEfilled" },
  filledNoTx: { routeId: "omni-route-1", state: "filled", destinationTxHash: null },
  refunded: { routeId: "omni-route-1", state: "refunded", reason: "exact-out not met" },
  failed: { routeId: "omni-route-1", state: "failed" },
}

describe("omniston route status -> acquisition mapping", () => {
  test("filled with a destination tx -> confirmed (baseUsdcTxRef + correlation)", () => {
    const result = mapOmnistonRouteStatusToAcquisition(FIXTURES.filled, INPUT)
    expect(result.status).toBe("confirmed")
    if (result.status !== "confirmed") throw new Error("unreachable")
    expect(result.baseUsdcTxRef).toBe("0xBASEfilled")
    expect(result.sourceCorrelation).toEqual({
      kind: "omniston_ton",
      routeRef: "omni-route-1",
      sourceTxRef: "ton:msg:abc",
      baseUsdcTxRef: "0xBASEfilled",
    })
  })

  test("filled WITHOUT a destination tx -> pending (never bind a missing receipt)", () => {
    const result = mapOmnistonRouteStatusToAcquisition(FIXTURES.filledNoTx, INPUT)
    expect(result.status).toBe("pending")
  })

  test("pending -> pending, retaining route + source correlation", () => {
    const result = mapOmnistonRouteStatusToAcquisition(FIXTURES.pending, INPUT)
    expect(result.status).toBe("pending")
    expect(result.sourceCorrelation).toMatchObject({ routeRef: "omni-route-1", sourceTxRef: "ton:msg:abc" })
  })

  test("refunded -> failed + refundable (exact-out-or-refund guarantee)", () => {
    const result = mapOmnistonRouteStatusToAcquisition(FIXTURES.refunded, INPUT)
    expect(result.status).toBe("failed")
    if (result.status !== "failed") throw new Error("unreachable")
    expect(result.refundable).toBe(true)
    expect(result.reason).toBe("exact-out not met")
  })

  test("failed -> failed + refundable with a default reason", () => {
    const result = mapOmnistonRouteStatusToAcquisition(FIXTURES.failed, INPUT)
    expect(result.status).toBe("failed")
    if (result.status !== "failed") throw new Error("unreachable")
    expect(result.refundable).toBe(true)
    expect(result.reason).toMatch(/failed/i)
  })
})

describe("omniston acquisition resolver", () => {
  test("looks up the routeRef and maps the status", async () => {
    const seen: string[] = []
    const client: OmnistonClient = {
      getRouteStatus: async (routeId) => {
        seen.push(routeId)
        return FIXTURES.filled
      },
    }
    const resolver = createOmnistonAcquisitionResolver(client)
    const result = await resolver(INPUT)
    expect(seen).toEqual(["omni-route-1"])
    expect(result.status).toBe("confirmed")
  })

  test("rejects when no routeRef is provided", async () => {
    const client: OmnistonClient = { getRouteStatus: async () => FIXTURES.pending }
    const resolver = createOmnistonAcquisitionResolver(client)
    await expect(resolver({ provider: "omniston_ton" })).rejects.toThrow(/requires a routeRef/i)
  })
})

describe("live omniston config gate (real money, off by default)", () => {
  const fakeFactory = () => ({ getRouteStatus: async () => FIXTURES.pending })

  test("disabled by default — returns null, never builds a client", () => {
    let built = 0
    const resolver = resolveLiveOmnistonResolver({}, () => {
      built += 1
      return fakeFactory()
    })
    expect(resolver).toBeNull()
    expect(built).toBe(0)
    expect(isLiveOmnistonEnabled({})).toBe(false)
    expect(isLiveOmnistonEnabled({ PIRATE_OMNISTON_LIVE_ENABLED: "false" })).toBe(false)
  })

  test("enabled + configured -> returns a resolver built with the configured credentials", () => {
    const configs: Array<{ apiUrl: string; apiKey: string }> = []
    const resolver = resolveLiveOmnistonResolver(
      {
        PIRATE_OMNISTON_LIVE_ENABLED: "true",
        PIRATE_OMNISTON_API_URL: "https://omniston.example",
        PIRATE_OMNISTON_API_KEY: "secret",
      },
      (config) => {
        configs.push(config)
        return fakeFactory()
      },
    )
    expect(typeof resolver).toBe("function")
    expect(configs).toEqual([{ apiUrl: "https://omniston.example", apiKey: "secret" }])
  })

  test("enabled but unconfigured -> throws (fail closed)", () => {
    expect(() =>
      resolveLiveOmnistonResolver({ PIRATE_OMNISTON_LIVE_ENABLED: "true" }, fakeFactory),
    ).toThrow(/not configured/i)
  })
})
