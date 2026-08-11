import { describe, expect, test } from "bun:test"
import { app } from "../../src/index"

const SHARD_SOURCE_VERSION = "shard-tree.shared-tree"
const shardVersion = {
  build: {
    gitRef: "main",
    gitSha: "shard-commit",
    timestamp: "2026-07-23T10:00:00.000Z",
    sourceVersion: SHARD_SOURCE_VERSION,
  },
  workerVersion: {
    id: "worker-version-id",
    tag: "shard-commit",
    timestamp: "2026-07-23T10:00:01.000Z",
  },
}

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
      COMMUNITY_D1_SHARD_SOURCE_VERSION: SHARD_SOURCE_VERSION,
      SHARD_ADMIN_TOKEN: "admin-token",
      COMMUNITY_D1_SHARD: {
        communityD1Version: async () => shardVersion,
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
      shard_version: shardVersion,
      expected_shard_source_version: SHARD_SOURCE_VERSION,
      shard_attestation: { healthy: true, status: "verified" },
      pool_capacity: { free: 10, threshold: 8, healthy: true },
    })
    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  test("GET /health/provisioning reports every pool and gates on the selected allocation pool", async () => {
    const primary = {
      communityD1Version: async () => shardVersion,
      communityD1PoolStats: async () => ({
        ok: true as const,
        value: { total: 20, allocated: 12, free: 8, quarantined: 0 },
      }),
    }
    const secondary = {
      communityD1Version: async () => shardVersion,
      communityD1PoolStats: async () => ({
        ok: true as const,
        value: { total: 10, allocated: 3, free: 7, quarantined: 0 },
      }),
    }
    const response = await app.request("http://pirate.test/health/provisioning", {}, {
      ENVIRONMENT: "staging",
      COMMUNITY_D1_SHARD_REGION: "eeur",
      COMMUNITY_D1_POOL_FREE_ALERT_THRESHOLD: "2",
      COMMUNITY_D1_SHARD_SOURCE_VERSION: SHARD_SOURCE_VERSION,
      SHARD_ADMIN_TOKEN: "admin-token",
      COMMUNITY_D1_SHARD: primary,
      COMMUNITY_D1_SHARD_SECONDARY: secondary,
      COMMUNITY_D1_SHARD_ROUTES: JSON.stringify({
        "shard-primary": "COMMUNITY_D1_SHARD",
        "shard-secondary": "COMMUNITY_D1_SHARD_SECONDARY",
      }),
      COMMUNITY_D1_ALLOCATION_SHARD_WORKER_ID: "shard-secondary",
    } as never)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      ok: true,
      allocation_shard_worker_id: "shard-secondary",
      pool_capacity: { total: 30, allocated: 15, free: 15, quarantined: 0 },
      allocation_pool_capacity: { total: 10, allocated: 3, free: 7, quarantined: 0 },
      pool_capacities: [
        { shardWorkerId: "shard-primary", stats: { free: 8 } },
        { shardWorkerId: "shard-secondary", stats: { free: 7 } },
      ],
      shard_versions: [
        { shardWorkerId: "shard-primary", version: shardVersion },
        { shardWorkerId: "shard-secondary", version: shardVersion },
      ],
    })
  })

  // Low-but-nonzero capacity is a WARNING. It must NOT fail this probe: deploy
  // smokes gate on it, and a warning that blocks every deploy is what kept web
  // off production for a full day on 2026-07-13. `healthy` stays false so the
  // capacity watchdog (which alerts on !healthy) still fires.
  test("GET /health/provisioning is degraded but OK at the pool threshold", async () => {
    const response = await app.request("http://pirate.test/health/provisioning", {}, {
      ENVIRONMENT: "staging",
      COMMUNITY_D1_SHARD_REGION: "eeur",
      COMMUNITY_D1_POOL_FREE_ALERT_THRESHOLD: "8",
      COMMUNITY_D1_SHARD_SOURCE_VERSION: SHARD_SOURCE_VERSION,
      SHARD_ADMIN_TOKEN: "admin-token",
      COMMUNITY_D1_SHARD: {
        communityD1Version: async () => shardVersion,
        communityD1PoolStats: async () => ({
          ok: true as const,
          value: { total: 30, allocated: 22, free: 8, quarantined: 0 },
        }),
      } as never,
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      ok: true,
      degraded: true,
      degraded_reason: "d1_pool_low_capacity",
      degraded_reasons: ["d1_pool_low_capacity"],
      pool_capacity: { free: 8, threshold: 8, healthy: false },
    })
  })

  test("GET /health/provisioning fails closed when the pool is exhausted", async () => {
    const response = await app.request("http://pirate.test/health/provisioning", {}, {
      ENVIRONMENT: "staging",
      COMMUNITY_D1_SHARD_REGION: "eeur",
      COMMUNITY_D1_POOL_FREE_ALERT_THRESHOLD: "8",
      COMMUNITY_D1_SHARD_SOURCE_VERSION: SHARD_SOURCE_VERSION,
      SHARD_ADMIN_TOKEN: "admin-token",
      COMMUNITY_D1_SHARD: {
        communityD1Version: async () => shardVersion,
        communityD1PoolStats: async () => ({
          ok: true as const,
          value: { total: 30, allocated: 30, free: 0, quarantined: 0 },
        }),
      } as never,
    })

    expect(response.status).toBe(503)
    const body = await response.json()
    expect(body).toMatchObject({
      ok: false,
      error_code: "d1_pool_exhausted",
      pool_capacity: { free: 0, threshold: 8, healthy: false },
    })
    // Exhaustion is an outage, not a warning — it must not be reported as merely degraded.
    expect(body).not.toHaveProperty("degraded")
  })

  test("GET /health/provisioning fails closed when capacity cannot be read", async () => {
    const response = await app.request("http://pirate.test/health/provisioning", {}, {
      ENVIRONMENT: "staging",
      COMMUNITY_D1_SHARD_REGION: "eeur",
      COMMUNITY_D1_SHARD_SOURCE_VERSION: SHARD_SOURCE_VERSION,
      SHARD_ADMIN_TOKEN: "admin-token",
      COMMUNITY_D1_SHARD: {
        communityD1Version: async () => shardVersion,
        communityD1PoolStats: async () => ({ ok: false as const, code: "shard_unavailable" }),
      } as never,
    })

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      ok: false,
      error_code: "d1_pool_stats_unavailable",
    })
  })

  test("GET /health/provisioning degrades but stays available when shard RPC is unavailable", async () => {
    const response = await app.request("http://pirate.test/health/provisioning", {}, {
      ENVIRONMENT: "staging",
      COMMUNITY_D1_SHARD_REGION: "eeur",
      COMMUNITY_D1_SHARD_SOURCE_VERSION: SHARD_SOURCE_VERSION,
      SHARD_ADMIN_TOKEN: "admin-token",
      COMMUNITY_D1_SHARD: {
        communityD1Version: async () => {
          throw new Error("RPC method unavailable")
        },
        communityD1PoolStats: async () => ({
          ok: true as const,
          value: { total: 30, allocated: 20, free: 10, quarantined: 0 },
        }),
      } as never,
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      ok: true,
      expected_shard_source_version: SHARD_SOURCE_VERSION,
      shard_version: null,
      shard_attestation: { healthy: false, status: "rpc_unavailable" },
      degraded: true,
      degraded_reason: "d1_shard_attestation_rpc_unavailable",
      degraded_reasons: ["d1_shard_attestation_rpc_unavailable"],
    })
  })

  test("GET /health/provisioning degrades but stays available without an expected shard version", async () => {
    const response = await app.request("http://pirate.test/health/provisioning", {}, {
      ENVIRONMENT: "staging",
      COMMUNITY_D1_SHARD_REGION: "eeur",
      SHARD_ADMIN_TOKEN: "admin-token",
      COMMUNITY_D1_SHARD: {
        communityD1Version: async () => shardVersion,
        communityD1PoolStats: async () => ({
          ok: true as const,
          value: { total: 30, allocated: 20, free: 10, quarantined: 0 },
        }),
      } as never,
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      ok: true,
      expected_shard_source_version: null,
      shard_attestation: { healthy: false, status: "expected_missing" },
      degraded: true,
      degraded_reason: "d1_shard_attestation_expected_missing",
    })
  })

  test("GET /health/provisioning degrades but stays available without an actual shard version", async () => {
    const response = await app.request("http://pirate.test/health/provisioning", {}, {
      ENVIRONMENT: "staging",
      COMMUNITY_D1_SHARD_REGION: "eeur",
      COMMUNITY_D1_SHARD_SOURCE_VERSION: SHARD_SOURCE_VERSION,
      SHARD_ADMIN_TOKEN: "admin-token",
      COMMUNITY_D1_SHARD: {
        communityD1Version: async () => ({
          ...shardVersion,
          build: { ...shardVersion.build, sourceVersion: null },
        }),
        communityD1PoolStats: async () => ({
          ok: true as const,
          value: { total: 30, allocated: 20, free: 10, quarantined: 0 },
        }),
      } as never,
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      ok: true,
      expected_shard_source_version: SHARD_SOURCE_VERSION,
      shard_attestation: { healthy: false, status: "actual_missing" },
      degraded: true,
      degraded_reason: "d1_shard_attestation_actual_missing",
    })
  })

  test("GET /health/provisioning fails closed on shard source skew", async () => {
    const response = await app.request("http://pirate.test/health/provisioning", {}, {
      ENVIRONMENT: "staging",
      COMMUNITY_D1_SHARD_REGION: "eeur",
      COMMUNITY_D1_SHARD_SOURCE_VERSION: SHARD_SOURCE_VERSION,
      SHARD_ADMIN_TOKEN: "admin-token",
      COMMUNITY_D1_SHARD: {
        communityD1Version: async () => ({
          ...shardVersion,
          build: { ...shardVersion.build, sourceVersion: "stale-shard.stale-shared" },
        }),
      } as never,
    })

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      ok: false,
      error_code: "d1_shard_version_mismatch",
      expected_shard_source_version: SHARD_SOURCE_VERSION,
      shard_version: {
        build: { sourceVersion: "stale-shard.stale-shared" },
      },
    })
  })

  test("CORS denies cross-origin access when no origins are configured", async () => {
    const response = await app.request("http://pirate.test/health", {
      headers: { origin: "https://app.pirate.test" },
    })

    expect(response.headers.get("access-control-allow-origin")).toBeNull()
  })

  test("CORS allows canonical Pirate web origins without explicit configuration", async () => {
    const appHost = await app.request("http://pirate.test/health", {
      headers: { origin: "https://app.pirate" },
    })
    const profileHost = await app.request("http://pirate.test/health", {
      headers: { origin: "https://blackbeard.pirate" },
    })

    expect(appHost.headers.get("access-control-allow-origin")).toBe("https://app.pirate")
    expect(profileHost.headers.get("access-control-allow-origin")).toBe("https://blackbeard.pirate")
  })

  test("CORS denies unknown and non-activated imported apex origins", async () => {
    const apex = await app.request("http://pirate.test/health", {
      headers: { origin: "https://unactivated-root" },
    })
    const appOrigin = await app.request("http://pirate.test/health", {
      headers: { origin: "https://app.unactivated-root" },
    })

    expect(apex.headers.get("access-control-allow-origin")).toBeNull()
    expect(appOrigin.headers.get("access-control-allow-origin")).toBeNull()
  })

  test("CORS allows both imported surfaces when the root is activated", async () => {
    const now = new Date().toISOString()
    const binding = {
      getByName: () => ({
        readRoutingSnapshot: async (rootLabel: string) => ({
          authorityVersion: 1,
          effective: true,
          originHostname: `https://${rootLabel}`,
          reasonCode: "enabled" as const,
          updatedAt: now,
        }),
        applyRoutingSnapshot: async (snapshot: unknown) => snapshot,
      }),
    }
    const env = { HNS_WALLET_ORIGIN_AUTHORITY: binding } as never
    const apex = await app.request("http://pirate.test/health", {
      headers: { origin: "https://activated-root" },
    }, env)
    const appOrigin = await app.request("http://pirate.test/health", {
      headers: { origin: "https://app.activated-root" },
    }, env)

    expect(apex.headers.get("access-control-allow-origin")).toBe("https://activated-root")
    expect(appOrigin.headers.get("access-control-allow-origin")).toBe("https://app.activated-root")
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
