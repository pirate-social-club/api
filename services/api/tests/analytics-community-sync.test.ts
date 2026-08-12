import { afterEach, describe, expect, test } from "bun:test"
import { syncCommunityHealthCounts } from "../src/lib/analytics"
import { buildTestEnv, createControlPlaneTestClient, withMockedFetch } from "./helpers"

let cleanup: (() => Promise<void>) | null = null

afterEach(async () => {
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

function analyticsEnv() {
  return buildTestEnv({
    ANALYTICS_ENABLED: "true",
    ENVIRONMENT: "staging",
    TINYBIRD_HOST: "https://tinybird.test",
    TINYBIRD_READ_TOKEN: "tb_read_test",
  })
}

async function setNextDate(
  client: Awaited<ReturnType<typeof createControlPlaneTestClient>>["client"],
  nextDate: string,
): Promise<void> {
  await client.execute({
    sql: `
      UPDATE community_health_sync_state
      SET next_date = ?1,
          reset_required = 0,
          updated_at = ?2
      WHERE projection_key = 'tinybird_community_health_daily'
    `,
    args: [nextDate, "2026-05-01T00:00:00.000Z"],
  })
}

function tinybirdResponse(data: unknown[]): Response {
  return new Response(JSON.stringify({ data }), { status: 200 })
}

describe("community analytics sync", () => {
  test("takes ownership by resetting the old absolute projection at runtime cutover", async () => {
    const setup = await createControlPlaneTestClient({ includeAllMigrations: true })
    cleanup = setup.cleanup
    await setup.client.execute({
      sql: `
        INSERT INTO community_health_counts (community_id, total_views, updated_at)
        VALUES ('cmt_old_projection', 123, '2026-05-01T00:00:00.000Z')
      `,
    })

    let fetched = false
    await withMockedFetch(() => (async () => {
      fetched = true
      return tinybirdResponse([])
    }), async () => {
      expect(await syncCommunityHealthCounts(analyticsEnv(), setup.client, {
        now: new Date("2026-05-02T12:00:00.000Z"),
      })).toEqual({
        fetched_rows: 0,
        synced_communities: 0,
        processed_days: 0,
        next_date: "2026-05-02",
        projection_reset: true,
      })
    })
    expect(fetched).toBe(false)
    expect((await setup.client.execute("SELECT * FROM community_health_counts")).rows).toEqual([])
    expect((await setup.client.execute(
      "SELECT next_date, reset_required FROM community_health_sync_state",
    )).rows).toEqual([{ next_date: "2026-05-02", reset_required: 0 }])
  })

  test("syncs exactly one complete UTC day and advances its watermark", async () => {
    const setup = await createControlPlaneTestClient({ includeAllMigrations: true })
    cleanup = setup.cleanup
    await setNextDate(setup.client, "2026-05-01")

    await withMockedFetch(() => (async (url: RequestInfo | URL, init?: RequestInit) => {
      const parsed = new URL(String(url))
      expect(parsed.origin).toBe("https://tinybird.test")
      expect(parsed.pathname).toBe("/v0/pipes/community_health.json")
      expect(parsed.searchParams.get("environment")).toBe("staging")
      expect(parsed.searchParams.get("start_date")).toBe("2026-05-01")
      expect(parsed.searchParams.get("end_date")).toBe("2026-05-01")
      expect(parsed.searchParams.get("limit")).toBe("100000")
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer tb_read_test")
      return tinybirdResponse([
        { day: "2026-05-01", community_id: "cmt_alpha", views: 2 },
        { day: "2026-05-01", community_id: "cmt_alpha", views: "3" },
        { day: "2026-05-01", community_id: "cmt_beta", views: 4 },
      ])
    }), async () => {
      const result = await syncCommunityHealthCounts(analyticsEnv(), setup.client, {
        now: new Date("2026-05-02T12:00:00.000Z"),
      })
      expect(result).toEqual({
        fetched_rows: 3,
        synced_communities: 2,
        processed_days: 1,
        next_date: "2026-05-02",
        projection_reset: false,
      })
    })

    const counts = await setup.client.execute(
      "SELECT community_id, total_views FROM community_health_counts ORDER BY community_id",
    )
    expect(counts.rows).toEqual([
      { community_id: "cmt_alpha", total_views: 5 },
      { community_id: "cmt_beta", total_views: 4 },
    ])
    const state = await setup.client.execute(
      "SELECT next_date FROM community_health_sync_state WHERE projection_key = 'tinybird_community_health_daily'",
    )
    expect(state.rows).toEqual([{ next_date: "2026-05-02" }])
  })

  test("adds daily deltas once instead of replacing or replaying totals", async () => {
    const setup = await createControlPlaneTestClient({ includeAllMigrations: true })
    cleanup = setup.cleanup
    await setNextDate(setup.client, "2026-05-01")
    await setup.client.execute({
      sql: `
        INSERT INTO community_health_counts (community_id, total_views, updated_at)
        VALUES ('cmt_alpha', 10, '2026-04-30T00:00:00.000Z')
      `,
    })

    await withMockedFetch(() => (async () => tinybirdResponse([
      { day: "2026-05-01", community_id: "cmt_alpha", views: 3 },
    ])), async () => {
      expect(await syncCommunityHealthCounts(analyticsEnv(), setup.client, {
        now: new Date("2026-05-02T00:00:00.000Z"),
      })).toMatchObject({ processed_days: 1, next_date: "2026-05-02" })
    })

    let unexpectedFetch = false
    await withMockedFetch(() => (async () => {
      unexpectedFetch = true
      return tinybirdResponse([])
    }), async () => {
      expect(await syncCommunityHealthCounts(analyticsEnv(), setup.client, {
        now: new Date("2026-05-02T23:59:59.000Z"),
      })).toEqual({
        fetched_rows: 0,
        synced_communities: 0,
        processed_days: 0,
        next_date: "2026-05-02",
        projection_reset: false,
      })
    })
    expect(unexpectedFetch).toBe(false)

    const counts = await setup.client.execute(
      "SELECT total_views FROM community_health_counts WHERE community_id = 'cmt_alpha'",
    )
    expect(counts.rows).toEqual([{ total_views: 13 }])
  })

  test("rolls back deltas when watermark advancement fails, then retries once", async () => {
    const setup = await createControlPlaneTestClient({ includeAllMigrations: true })
    cleanup = setup.cleanup
    await setNextDate(setup.client, "2026-05-01")
    await setup.client.execute(`
      CREATE TRIGGER fail_community_health_watermark
      BEFORE UPDATE ON community_health_sync_state
      BEGIN
        SELECT RAISE(ABORT, 'forced watermark failure');
      END
    `)

    const run = () => withMockedFetch(() => (async () => tinybirdResponse([
      { day: "2026-05-01", community_id: "cmt_alpha", views: 5 },
    ])), async () => syncCommunityHealthCounts(analyticsEnv(), setup.client, {
      now: new Date("2026-05-02T00:00:00.000Z"),
    }))

    await expect(run()).rejects.toThrow(/forced watermark failure/i)
    expect((await setup.client.execute("SELECT * FROM community_health_counts")).rows).toEqual([])
    expect((await setup.client.execute("SELECT next_date FROM community_health_sync_state")).rows)
      .toEqual([{ next_date: "2026-05-01" }])

    await setup.client.execute("DROP TRIGGER fail_community_health_watermark")
    await run()
    expect((await setup.client.execute("SELECT community_id, total_views FROM community_health_counts")).rows)
      .toEqual([{ community_id: "cmt_alpha", total_views: 5 }])
  })

  test("refuses a saturated Tinybird day without advancing the watermark", async () => {
    const setup = await createControlPlaneTestClient({ includeAllMigrations: true })
    cleanup = setup.cleanup
    await setNextDate(setup.client, "2026-05-01")
    const saturatedRows = Array.from({ length: 100_000 }, () => ({
      day: "2026-05-01",
      community_id: "cmt_saturated",
      views: 1,
    }))

    await expect(withMockedFetch(() => (async () => tinybirdResponse(saturatedRows)), async () => {
      return syncCommunityHealthCounts(analyticsEnv(), setup.client, {
        now: new Date("2026-05-02T00:00:00.000Z"),
      })
    })).rejects.toThrow(/100000-row limit.*refusing to advance the watermark/i)

    expect((await setup.client.execute("SELECT * FROM community_health_counts")).rows).toEqual([])
    expect((await setup.client.execute("SELECT next_date FROM community_health_sync_state")).rows)
      .toEqual([{ next_date: "2026-05-01" }])
  })

  test("bounds catch-up work to seven days per scheduled invocation", async () => {
    const setup = await createControlPlaneTestClient({ includeAllMigrations: true })
    cleanup = setup.cleanup
    await setNextDate(setup.client, "2026-05-01")
    const requestedDates: string[] = []
    let mappingQueries = 0
    const observedClient = new Proxy(setup.client, {
      get(target, property, receiver) {
        if (property === "execute") {
          return async (statement: string | { sql: string; args?: unknown[] }) => {
            const sql = typeof statement === "string" ? statement : statement.sql
            if (/SELECT\s+community_id,\s*route_slug\s+FROM\s+communities/iu.test(sql)) {
              mappingQueries += 1
            }
            return target.execute(statement as never)
          }
        }
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === "function" ? value.bind(target) : value
      },
    })

    await withMockedFetch(() => (async (url: RequestInfo | URL) => {
      const date = new URL(String(url)).searchParams.get("start_date") ?? ""
      requestedDates.push(date)
      return tinybirdResponse([{ day: date, community_id: "cmt_catchup", views: 1 }])
    }), async () => {
      expect(await syncCommunityHealthCounts(analyticsEnv(), observedClient, {
        now: new Date("2026-05-10T00:00:00.000Z"),
      })).toEqual({
        fetched_rows: 7,
        synced_communities: 7,
        processed_days: 7,
        next_date: "2026-05-08",
        projection_reset: false,
      })
    })
    expect(requestedDates).toEqual([
      "2026-05-01",
      "2026-05-02",
      "2026-05-03",
      "2026-05-04",
      "2026-05-05",
      "2026-05-06",
      "2026-05-07",
    ])
    expect(mappingQueries).toBe(1)
    expect((await setup.client.execute(
      "SELECT total_views FROM community_health_counts WHERE community_id = 'cmt_catchup'",
    )).rows).toEqual([{ total_views: 7 }])
  })

  test("canonicalizes route slugs with one community mapping query", async () => {
    const setup = await createControlPlaneTestClient({ includeAllMigrations: true })
    cleanup = setup.cleanup
    await setNextDate(setup.client, "2026-05-01")
    const now = "2026-05-01T00:00:00.000Z"
    await setup.client.execute({
      sql: `
        INSERT INTO users (
          user_id, verification_state, verification_capabilities_json, created_at, updated_at
        ) VALUES (?1, 'verified', '{}', ?2, ?2)
      `,
      args: ["usr_sync_creator", now],
    })
    await setup.client.execute({
      sql: `
        INSERT INTO communities (
          community_id, creator_user_id, display_name, membership_mode, status,
          provisioning_state, transfer_state, route_slug, created_at, updated_at
        ) VALUES (?1, ?2, ?3, 'request', 'active', 'active', 'none', ?4, ?5, ?5)
      `,
      args: ["cmt_sync_canonical", "usr_sync_creator", "Sync Canonical", "sync-canonical", now],
    })

    await withMockedFetch(() => (async () => tinybirdResponse([
      { day: "2026-05-01", community_id: "sync-canonical", views: 7 },
      { day: "2026-05-01", community_id: "cmt_sync_canonical", views: 5 },
    ])), async () => {
      expect(await syncCommunityHealthCounts(analyticsEnv(), setup.client, {
        now: new Date("2026-05-02T00:00:00.000Z"),
      })).toMatchObject({ fetched_rows: 2, synced_communities: 1 })
    })

    const rows = await setup.client.execute(
      "SELECT community_id, total_views FROM community_health_counts WHERE community_id = 'cmt_sync_canonical'",
    )
    expect(rows.rows).toEqual([{ community_id: "cmt_sync_canonical", total_views: 12 }])
  })

  test("fails when the sync-state migration is missing without widening the schema", async () => {
    const setup = await createControlPlaneTestClient()
    cleanup = setup.cleanup
    let fetched = false

    await expect(withMockedFetch(() => (async () => {
      fetched = true
      return tinybirdResponse([])
    }), async () => syncCommunityHealthCounts(analyticsEnv(), setup.client, {
      now: new Date("2026-05-02T00:00:00.000Z"),
    }))).rejects.toThrow(/community_health_sync_state/i)
    expect(fetched).toBe(false)

    const tables = await setup.client.execute({
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1",
      args: ["community_health_sync_state"],
    })
    expect(tables.rows).toEqual([])
  })
})
