import { describe, expect, test } from "bun:test"
import { app } from "../../src/index"

describe("health route", () => {
  test("GET /health returns ok", async () => {
    const response = await app.request("http://pirate.test/health")

    expect(response.status).toBe(200)
    const body = await response.json() as { ok: boolean }
    expect(body).toEqual({ ok: true })
  })

  test("GET /health/provisioning reports live healthy pool capacity", async () => {
    const response = await app.request("http://pirate.test/health/provisioning", {}, {
      ENVIRONMENT: "staging",
      COMMUNITY_D1_SHARD_REGION: "eeur",
      COMMUNITY_D1_POOL_FREE_ALERT_THRESHOLD: "8",
      SHARD_ADMIN_TOKEN: "admin-token",
      COMMUNITY_D1_SHARD: {
        communityD1PoolStats: async () => ({
          ok: true as const,
          value: { total: 30, allocated: 20, free: 10, quarantined: 0 },
        }),
      } as never,
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      ok: true,
      backend: "d1_native",
      pool_capacity: { free: 10, threshold: 8, healthy: true },
    })
    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  test("GET /health/provisioning is degraded at the pool threshold", async () => {
    const response = await app.request("http://pirate.test/health/provisioning", {}, {
      ENVIRONMENT: "staging",
      COMMUNITY_D1_SHARD_REGION: "eeur",
      COMMUNITY_D1_POOL_FREE_ALERT_THRESHOLD: "8",
      SHARD_ADMIN_TOKEN: "admin-token",
      COMMUNITY_D1_SHARD: {
        communityD1PoolStats: async () => ({
          ok: true as const,
          value: { total: 30, allocated: 22, free: 8, quarantined: 0 },
        }),
      } as never,
    })

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      ok: false,
      error_code: "d1_pool_low_capacity",
      pool_capacity: { free: 8, threshold: 8, healthy: false },
    })
  })

  test("GET /health/provisioning fails closed when capacity cannot be read", async () => {
    const response = await app.request("http://pirate.test/health/provisioning", {}, {
      ENVIRONMENT: "staging",
      COMMUNITY_D1_SHARD_REGION: "eeur",
      SHARD_ADMIN_TOKEN: "admin-token",
      COMMUNITY_D1_SHARD: {
        communityD1PoolStats: async () => ({ ok: false as const, code: "shard_unavailable" }),
      } as never,
    })

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      ok: false,
      error_code: "d1_pool_stats_unavailable",
    })
  })

  test("CORS denies cross-origin access when no origins are configured", async () => {
    const response = await app.request("http://pirate.test/health", {
      headers: { origin: "https://app.pirate.test" },
    })

    expect(response.headers.get("access-control-allow-origin")).toBeNull()
  })

  test("CORS allows HNS web origins without explicit configuration", async () => {
    const appHost = await app.request("http://pirate.test/health", {
      headers: { origin: "https://app.pirate" },
    })
    const importedRoot = await app.request("http://pirate.test/health", {
      headers: { origin: "https://xn--pokmon-dva" },
    })
    const profileHost = await app.request("http://pirate.test/health", {
      headers: { origin: "https://blackbeard.pirate" },
    })

    expect(appHost.headers.get("access-control-allow-origin")).toBe("https://app.pirate")
    expect(importedRoot.headers.get("access-control-allow-origin")).toBe("https://xn--pokmon-dva")
    expect(profileHost.headers.get("access-control-allow-origin")).toBe("https://blackbeard.pirate")
  })

  test("CORS does not treat ordinary web origins as HNS origins", async () => {
    const response = await app.request("http://pirate.test/health", {
      headers: { origin: "https://evil.com" },
    })

    expect(response.headers.get("access-control-allow-origin")).toBeNull()
  })

  test("CORS allows public API access when explicitly configured", async () => {
    const response = await app.request("http://pirate.test/health", {
      headers: { origin: "https://app.pirate.test" },
    }, {
      CORS_ALLOWED_ORIGINS: "*",
    })

    expect(response.headers.get("access-control-allow-origin")).toBe("*")
  })

  test("CORS can be scoped to configured origins", async () => {
    const allowed = await app.request("http://pirate.test/health", {
      headers: { origin: "https://app.pirate.test" },
    }, {
      CORS_ALLOWED_ORIGINS: "https://app.pirate.test, https://admin.pirate.test",
    })
    const denied = await app.request("http://pirate.test/health", {
      headers: { origin: "https://evil.test" },
    }, {
      CORS_ALLOWED_ORIGINS: "https://app.pirate.test, https://admin.pirate.test",
    })

    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://app.pirate.test")
    expect(denied.headers.get("access-control-allow-origin")).toBeNull()
  })

  test("CORS preflight allows binary artifact PUT uploads", async () => {
    const response = await app.request("http://pirate.test/communities/com_test/song-artifact-uploads/sau_test/content", {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "PUT",
        "access-control-request-headers": "content-type,authorization,x-pirate-submit-trace-id",
      },
    }, {
      CORS_ALLOWED_ORIGINS: "http://localhost:5173",
    })

    expect(response.status).toBe(204)
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5173")
    expect(response.headers.get("access-control-allow-methods")).toContain("PUT")
    expect(response.headers.get("access-control-allow-headers")).toContain("X-Pirate-Submit-Trace-Id")
  })
})
