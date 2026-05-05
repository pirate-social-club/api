import { afterEach, describe, expect, test } from "bun:test"
import {
  fetchTinybirdCommunityViewCounts,
  syncCommunityHealthCounts,
} from "../src/lib/analytics"
import { buildTestEnv, createControlPlaneTestClient, withMockedFetch } from "./helpers"

let cleanup: (() => Promise<void>) | null = null

afterEach(async () => {
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

describe("community analytics sync", () => {
  test("aggregates Tinybird community health rows by community id", async () => {
    const env = buildTestEnv({
      ANALYTICS_ENABLED: "true",
      ENVIRONMENT: "staging",
      TINYBIRD_HOST: "https://tinybird.test",
      TINYBIRD_READ_TOKEN: "tb_read_test",
    })

    await withMockedFetch(() => (async (url, init) => {
      expect(String(url)).toContain("https://tinybird.test/v0/pipes/community_health.json")
      expect(String(url)).toContain("environment=staging")
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer tb_read_test")
      return new Response(JSON.stringify({
        data: [
          { day: "2026-05-01", community_id: "cmt_alpha", views: 2 },
          { day: "2026-05-02", community_id: "cmt_alpha", views: "3" },
          { day: "2026-05-01", community_id: "cmt_beta", views: 4 },
        ],
      }), { status: 200 })
    }) as typeof fetch, async () => {
      const counts = await fetchTinybirdCommunityViewCounts(env)
      expect(counts.get("cmt_alpha")).toBe(5)
      expect(counts.get("cmt_beta")).toBe(4)
    })
  })

  test("syncs aggregated view counts into the control-plane table", async () => {
    const setup = await createControlPlaneTestClient({ includeAllMigrations: true })
    cleanup = setup.cleanup
    const env = buildTestEnv({
      ANALYTICS_ENABLED: "true",
      ENVIRONMENT: "staging",
      TINYBIRD_READ_TOKEN: "tb_read_test",
    })

    await withMockedFetch(() => (async () => {
      return new Response(JSON.stringify({
        data: [
          { day: "2026-05-01", community_id: "cmt_alpha", views: 7 },
          { day: "2026-05-02", community_id: "cmt_alpha", views: 8 },
        ],
      }), { status: 200 })
    }) as typeof fetch, async () => {
      const result = await syncCommunityHealthCounts(env, setup.client)
      expect(result).toEqual({ fetched_rows: 2, synced_communities: 1 })
    })

    const rows = await setup.client.execute({
      sql: "SELECT community_id, total_views FROM community_health_counts WHERE community_id = ?1",
      args: ["cmt_alpha"],
    })
    expect(rows.rows[0]?.community_id).toBe("cmt_alpha")
    expect(Number(rows.rows[0]?.total_views)).toBe(15)
  })

  test("creates the control-plane table when syncing before migration rollout", async () => {
    const setup = await createControlPlaneTestClient()
    cleanup = setup.cleanup
    const env = buildTestEnv({
      ANALYTICS_ENABLED: "true",
      ENVIRONMENT: "staging",
      TINYBIRD_READ_TOKEN: "tb_read_test",
    })

    await withMockedFetch(() => (async () => {
      return new Response(JSON.stringify({
        data: [
          { day: "2026-05-01", community_id: "cmt_alpha", views: 11 },
        ],
      }), { status: 200 })
    }) as typeof fetch, async () => {
      const result = await syncCommunityHealthCounts(env, setup.client)
      expect(result).toEqual({ fetched_rows: 1, synced_communities: 1 })
    })

    const rows = await setup.client.execute({
      sql: "SELECT community_id, total_views FROM community_health_counts WHERE community_id = ?1",
      args: ["cmt_alpha"],
    })
    expect(rows.rows[0]?.community_id).toBe("cmt_alpha")
    expect(Number(rows.rows[0]?.total_views)).toBe(11)
  })

  test("canonicalizes Tinybird community route slugs before syncing counts", async () => {
    const setup = await createControlPlaneTestClient({ includeAllMigrations: true })
    cleanup = setup.cleanup
    const env = buildTestEnv({
      ANALYTICS_ENABLED: "true",
      ENVIRONMENT: "staging",
      TINYBIRD_READ_TOKEN: "tb_read_test",
    })

    await setup.client.execute({
      sql: `
        INSERT INTO users (
          user_id,
          primary_wallet_attachment_id,
          verification_state,
          capability_provider,
          verification_capabilities_json,
          verified_at,
          current_verification_session_id,
          created_at,
          updated_at
        ) VALUES (?1, NULL, 'verified', NULL, '{}', NULL, NULL, ?2, ?2)
      `,
      args: ["usr_sync_creator", "2026-05-04T00:00:00.000Z"],
    })
    await setup.client.execute({
      sql: `
        INSERT INTO communities (
          community_id,
          creator_user_id,
          display_name,
          membership_mode,
          status,
          provisioning_state,
          transfer_state,
          route_slug,
          namespace_verification_id,
          pending_namespace_verification_session_id,
          primary_database_binding_id,
          created_at,
          updated_at
        ) VALUES (?1, ?2, ?3, 'request', 'active', 'active', 'none', ?4, NULL, NULL, NULL, ?5, ?5)
      `,
      args: [
        "cmt_sync_canonical",
        "usr_sync_creator",
        "Sync Canonical",
        "sync-canonical",
        "2026-05-04T00:00:00.000Z",
      ],
    })

    await withMockedFetch(() => (async () => {
      return new Response(JSON.stringify({
        data: [
          { day: "2026-05-01", community_id: "sync-canonical", views: 7 },
          { day: "2026-05-02", community_id: "cmt_sync_canonical", views: 5 },
        ],
      }), { status: 200 })
    }) as typeof fetch, async () => {
      const result = await syncCommunityHealthCounts(env, setup.client)
      expect(result).toEqual({ fetched_rows: 2, synced_communities: 1 })
    })

    const rows = await setup.client.execute({
      sql: "SELECT community_id, total_views FROM community_health_counts WHERE community_id = ?1",
      args: ["cmt_sync_canonical"],
    })
    expect(rows.rows[0]?.community_id).toBe("cmt_sync_canonical")
    expect(Number(rows.rows[0]?.total_views)).toBe(12)
  })
})
