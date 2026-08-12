import { describe, expect, it } from "bun:test"
import type { Env } from "../../env"
import {
  checkHnsEdgeHeartbeatFreshness,
  HNS_EDGE_HEARTBEAT_MAX_AGE_MS,
  isExpectedHnsEdgeRole,
  recordHnsEdgeHeartbeat,
} from "./hns-edge-heartbeats"

function testKv() {
  const values = new Map<string, string>()
  return {
    values,
    binding: {
      get: async (key: string) => values.get(key) ?? null,
      put: async (key: string, value: string) => { values.set(key, value) },
      delete: async (key: string) => { values.delete(key) },
    } as unknown as KVNamespace,
  }
}

describe("HNS edge heartbeat dead-man", () => {
  it("reports only stale roles and suppresses repeat alerts", async () => {
    const now = new Date("2026-07-18T12:00:00.000Z")
    const kv = testKv()
    const env = {
      ENVIRONMENT: "test",
      OPS_ALERT_DEDUPE: kv.binding,
      OPS_ALERT_WEBHOOK_URL: "https://ops.example/hook",
    } as Env
    await recordHnsEdgeHeartbeat({
      env,
      host: "ns1-pirate-fluence",
      role: "hns-chain-observer",
      coreCommit: "a".repeat(40),
      verifiedAt: now.toISOString(),
    })
    const observerKey = "hns-edge-heartbeat:v1:ns1-pirate-fluence:hns-chain-observer"
    const observer = JSON.parse(kv.values.get(observerKey) ?? "{}")
    observer.received_at = now.toISOString()
    kv.values.set(observerKey, JSON.stringify(observer))

    const originalFetch = globalThis.fetch
    let deliveries = 0
    globalThis.fetch = (async () => {
      deliveries += 1
      return new Response(null, { status: 204 })
    }) as typeof fetch
    try {
      const first = await checkHnsEdgeHeartbeatFreshness(env, now)
      const second = await checkHnsEdgeHeartbeatFreshness(env, now)
      expect(first.stale).toEqual([
        "ns1-pirate-fluence:hns-authoritative-dns",
        "ns1-pirate-fluence:hns-doh-resolver",
        "ns1-pirate-fluence:spaces-verifier",
        "ns1-pirate-fluence:hns-state-backup",
        "ns2-pirate-fluence:hns-secondary-dns",
      ])
      expect(second.stale).toEqual(first.stale)
      expect(deliveries).toBe(5)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("marks a heartbeat stale after the 36 hour threshold", async () => {
    const now = new Date("2026-07-18T12:00:00.000Z")
    const kv = testKv()
    const env = { OPS_ALERT_DEDUPE: kv.binding } as Env
    kv.values.set(
      "hns-edge-heartbeat:v1:ns1-pirate-fluence:hns-chain-observer",
      JSON.stringify({ received_at: new Date(now.getTime() - HNS_EDGE_HEARTBEAT_MAX_AGE_MS - 1).toISOString() }),
    )
    const result = await checkHnsEdgeHeartbeatFreshness(env, now)
    expect(result.stale).toContain("ns1-pirate-fluence:hns-chain-observer")
  })

  it("defers missing-heartbeat alerts for newly monitored roles", async () => {
    const kv = testKv()
    const env = {
      ENVIRONMENT: "test",
      OPS_ALERT_DEDUPE: kv.binding,
      OPS_ALERT_WEBHOOK_URL: "https://ops.example/hook",
    } as Env
    const originalFetch = globalThis.fetch
    const deliveredRoles: string[] = []
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { text?: string }
      if (body.text?.includes("hns-verifier")) deliveredRoles.push("hns-verifier")
      if (body.text?.includes("hns-public-gateway")) deliveredRoles.push("hns-public-gateway")
      return new Response(null, { status: 204 })
    }) as typeof fetch
    try {
      const duringGrace = await checkHnsEdgeHeartbeatFreshness(
        env,
        new Date("2026-08-13T23:59:59.999Z"),
      )
      expect(duringGrace.stale).not.toContain("ns1-pirate-fluence:hns-verifier")
      expect(duringGrace.stale).not.toContain("ns1-pirate-fluence:hns-public-gateway")
      expect(deliveredRoles).toEqual([])

      const afterGrace = await checkHnsEdgeHeartbeatFreshness(
        env,
        new Date("2026-08-14T00:00:00.000Z"),
      )
      expect(afterGrace.stale).toContain("ns1-pirate-fluence:hns-verifier")
      expect(afterGrace.stale).toContain("ns1-pirate-fluence:hns-public-gateway")
      expect(deliveredRoles).toEqual(["hns-verifier", "hns-public-gateway"])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("accepts the verification-only Spaces role on ns1", () => {
    expect(isExpectedHnsEdgeRole({
      host: "ns1-pirate-fluence",
      role: "spaces-verifier",
    })).toBe(true)
  })

  it("accepts the successful state-backup role on ns1", () => {
    expect(isExpectedHnsEdgeRole({
      host: "ns1-pirate-fluence",
      role: "hns-state-backup",
    })).toBe(true)
  })

  it("accepts the verifier and public gateway roles on ns1", () => {
    expect(isExpectedHnsEdgeRole({
      host: "ns1-pirate-fluence",
      role: "hns-verifier",
    })).toBe(true)
    expect(isExpectedHnsEdgeRole({
      host: "ns1-pirate-fluence",
      role: "hns-public-gateway",
    })).toBe(true)
  })

  it("accepts the DoH resolver role on ns1", () => {
    expect(isExpectedHnsEdgeRole({
      host: "ns1-pirate-fluence",
      role: "hns-doh-resolver",
    })).toBe(true)
  })
})
