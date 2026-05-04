import type { Env } from "../../env"
import type { DbExecutor } from "../db-helpers"
import { analyticsEnvironment } from "./events"

export type CommunityHealthSyncResult = {
  fetched_rows: number
  synced_communities: number
}

type TinybirdCommunityHealthRow = {
  community_id?: unknown
  views?: unknown
}

type TinybirdCommunityViewCountFetch = {
  counts: Map<string, number>
  rowCount: number
}

function tinybirdHost(env: Env): string {
  return String(env.TINYBIRD_HOST || "https://api.tinybird.co").replace(/\/+$/, "")
}

function tinybirdReadToken(env: Env): string {
  return String(env.TINYBIRD_READ_TOKEN || "").trim()
}

function communityHealthEndpointUrl(env: Env): string {
  const url = new URL(`${tinybirdHost(env)}/v0/pipes/community_health.json`)
  url.searchParams.set("environment", analyticsEnvironment(env))
  url.searchParams.set("start_date", "1970-01-01")
  url.searchParams.set("end_date", "2100-01-01")
  url.searchParams.set("limit", "100000")
  return url.href
}

function parseViewCount(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0
  }
  return Math.trunc(parsed)
}

function parseCommunityHealthRows(body: unknown): TinybirdCommunityHealthRow[] {
  if (!body || typeof body !== "object" || !Array.isArray((body as { data?: unknown }).data)) {
    return []
  }
  return (body as { data: TinybirdCommunityHealthRow[] }).data
}

async function fetchTinybirdCommunityViewCountRows(env: Env): Promise<TinybirdCommunityViewCountFetch> {
  const token = tinybirdReadToken(env)
  if (!token) {
    throw new Error("TINYBIRD_READ_TOKEN is required to sync community health counts")
  }

  const response = await fetch(communityHealthEndpointUrl(env), {
    headers: {
      authorization: `Bearer ${token}`,
    },
  })
  if (!response.ok) {
    throw new Error(`Tinybird community health query failed with ${response.status}`)
  }

  const counts = new Map<string, number>()
  const rows = parseCommunityHealthRows(await response.json())
  for (const row of rows) {
    const communityId = typeof row.community_id === "string" ? row.community_id : ""
    if (!communityId) {
      continue
    }
    counts.set(communityId, (counts.get(communityId) ?? 0) + parseViewCount(row.views))
  }
  return { counts, rowCount: rows.length }
}

export async function fetchTinybirdCommunityViewCounts(env: Env): Promise<Map<string, number>> {
  return (await fetchTinybirdCommunityViewCountRows(env)).counts
}

export async function upsertCommunityHealthCounts(
  db: DbExecutor,
  counts: Map<string, number>,
): Promise<number> {
  const now = new Date().toISOString()
  for (const [communityId, totalViews] of counts) {
    await db.execute({
      sql: `
        INSERT INTO community_health_counts (
          community_id,
          total_views,
          updated_at
        ) VALUES (
          ?1, ?2, ?3
        )
        ON CONFLICT (community_id) DO UPDATE SET
          total_views = excluded.total_views,
          updated_at = excluded.updated_at
      `,
      args: [communityId, totalViews, now],
    })
  }
  return counts.size
}

export async function syncCommunityHealthCounts(
  env: Env,
  db: DbExecutor,
): Promise<CommunityHealthSyncResult> {
  const fetched = await fetchTinybirdCommunityViewCountRows(env)
  const synced = await upsertCommunityHealthCounts(db, fetched.counts)
  return {
    fetched_rows: fetched.rowCount,
    synced_communities: synced,
  }
}
