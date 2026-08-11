import type { Env } from "../../env"
import type { DbExecutor } from "../db-helpers"
import type { Client } from "../sql-client"
import { withTransaction } from "../transactions"
import { analyticsEnvironment } from "./events"

const COMMUNITY_HEALTH_PROJECTION_KEY = "tinybird_community_health_daily"
const TINYBIRD_DAILY_ROW_LIMIT = 100_000
const MAX_DAYS_PER_SYNC = 7
const HEALTH_COUNT_UPSERT_CHUNK_SIZE = 500
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u

export class CommunityHealthSyncSaturationError extends Error {
  readonly date: string
  readonly rowLimit: number

  constructor(date: string, rowLimit: number) {
    super(`Tinybird community health query reached the ${rowLimit}-row limit for ${date}; refusing to advance the watermark`)
    this.name = "CommunityHealthSyncSaturationError"
    this.date = date
    this.rowLimit = rowLimit
  }
}

export function isCommunityHealthSyncSaturationError(
  error: unknown,
): error is CommunityHealthSyncSaturationError {
  return error instanceof CommunityHealthSyncSaturationError
}

type CommunityHealthSyncResult = {
  fetched_rows: number
  synced_communities: number
  processed_days: number
  next_date: string
  projection_reset: boolean
}

type TinybirdCommunityHealthRow = {
  day?: unknown
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

function communityHealthEndpointUrl(env: Env, date: string): string {
  const url = new URL(`${tinybirdHost(env)}/v0/pipes/community_health.json`)
  url.searchParams.set("environment", analyticsEnvironment(env))
  url.searchParams.set("start_date", date)
  url.searchParams.set("end_date", date)
  url.searchParams.set("limit", String(TINYBIRD_DAILY_ROW_LIMIT))
  return url.href
}

function parseIsoDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !ISO_DATE_PATTERN.test(value)) {
    throw new Error(`${field} must be an ISO date`)
  }
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${field} must be a valid ISO date`)
  }
  return value
}

function parseDatabaseDate(value: unknown, field: string): string {
  if (value instanceof Date) return parseIsoDate(value.toISOString().slice(0, 10), field)
  if (typeof value === "string" && value.length > 10 && value[10] === "T") {
    return parseIsoDate(value.slice(0, 10), field)
  }
  return parseIsoDate(value, field)
}

function addUtcDays(date: string, days: number): string {
  const parsed = new Date(`${parseIsoDate(date, "date")}T00:00:00.000Z`)
  parsed.setUTCDate(parsed.getUTCDate() + days)
  return parsed.toISOString().slice(0, 10)
}

function utcDate(now: Date): string {
  if (!Number.isFinite(now.getTime())) {
    throw new Error("community health sync time is invalid")
  }
  return now.toISOString().slice(0, 10)
}

function parseViewCount(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Tinybird community health views must be a non-negative safe integer")
  }
  return parsed
}

function parseCommunityHealthRows(body: unknown): TinybirdCommunityHealthRow[] {
  if (!body || typeof body !== "object" || !Array.isArray((body as { data?: unknown }).data)) {
    throw new Error("Tinybird community health response is missing its data array")
  }
  return (body as { data: TinybirdCommunityHealthRow[] }).data
}

function addCount(counts: Map<string, number>, communityId: string, views: number): void {
  const total = (counts.get(communityId) ?? 0) + views
  if (!Number.isSafeInteger(total)) {
    throw new Error(`Tinybird community health total exceeds safe integer range for ${communityId}`)
  }
  counts.set(communityId, total)
}

async function fetchTinybirdCommunityViewCountsForDate(
  env: Env,
  date: string,
): Promise<TinybirdCommunityViewCountFetch> {
  const token = tinybirdReadToken(env)
  if (!token) {
    throw new Error("TINYBIRD_READ_TOKEN is required to sync community health counts")
  }

  const response = await fetch(communityHealthEndpointUrl(env, date), {
    headers: {
      authorization: `Bearer ${token}`,
    },
  })
  if (!response.ok) {
    throw new Error(`Tinybird community health query failed with ${response.status}`)
  }

  const rows = parseCommunityHealthRows(await response.json())
  if (rows.length >= TINYBIRD_DAILY_ROW_LIMIT) {
    throw new CommunityHealthSyncSaturationError(date, TINYBIRD_DAILY_ROW_LIMIT)
  }

  const counts = new Map<string, number>()
  for (const row of rows) {
    if (parseIsoDate(row.day, "Tinybird community health day") !== date) {
      throw new Error(`Tinybird community health response returned a row outside ${date}`)
    }
    if (typeof row.community_id !== "string" || !row.community_id.trim()) {
      throw new Error("Tinybird community health row is missing community_id")
    }
    addCount(counts, row.community_id, parseViewCount(row.views))
  }
  return { counts, rowCount: rows.length }
}

async function loadCanonicalCommunityIdentifiers(
  db: DbExecutor,
): Promise<Map<string, string>> {
  const communities = await db.execute(`
    SELECT community_id, route_slug
    FROM communities
  `)
  const canonicalByIdentifier = new Map<string, string>()
  for (const row of communities.rows) {
    const communityId = typeof row.community_id === "string" ? row.community_id : ""
    if (!communityId) continue
    canonicalByIdentifier.set(communityId, communityId)
    if (typeof row.route_slug === "string" && row.route_slug) {
      canonicalByIdentifier.set(row.route_slug, communityId)
    }
  }
  return canonicalByIdentifier
}

function canonicalizeCommunityHealthCounts(
  counts: Map<string, number>,
  canonicalByIdentifier: Map<string, string>,
): Map<string, number> {
  const canonicalCounts = new Map<string, number>()
  for (const [identifier, views] of counts) {
    addCount(canonicalCounts, canonicalByIdentifier.get(identifier) ?? identifier, views)
  }
  return canonicalCounts
}

async function readNextCommunityHealthDate(db: DbExecutor): Promise<string> {
  const result = await db.execute({
    sql: `
      SELECT next_date
      FROM community_health_sync_state
      WHERE projection_key = ?1
    `,
    args: [COMMUNITY_HEALTH_PROJECTION_KEY],
  })
  const row = result.rows[0]
  if (!row) {
    throw new Error("community_health_sync_state is missing the Tinybird projection watermark")
  }
  return parseDatabaseDate(row.next_date, "community health next_date")
}

async function initializeCommunityHealthProjection(
  client: Client,
  today: string,
  updatedAt: string,
): Promise<boolean> {
  return withTransaction(client, "write", async (tx) => {
    const initialized = await tx.execute({
      sql: `
        UPDATE community_health_sync_state
        SET next_date = ?2,
            reset_required = 0,
            updated_at = ?3
        WHERE projection_key = ?1
          AND reset_required = 1
      `,
      args: [COMMUNITY_HEALTH_PROJECTION_KEY, today, updatedAt],
    })
    if ((initialized.rowsAffected ?? 0) === 0) return false
    if (initialized.rowsAffected !== 1) {
      throw new Error(`community health projection initialization affected ${String(initialized.rowsAffected)} rows`)
    }

    // The previous projection was an absolute full-history snapshot that
    // already included a partial cutover day. Reset this derived table only
    // after the new runtime owns the state row, then rebuild from today's
    // complete Tinybird slice on the next UTC day.
    await tx.execute("DELETE FROM community_health_counts")
    return true
  })
}

function chunksOf<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }
  return chunks
}

async function applyCommunityHealthDay(
  client: Client,
  input: {
    date: string
    nextDate: string
    counts: Map<string, number>
    updatedAt: string
  },
): Promise<boolean> {
  return withTransaction(client, "write", async (tx) => {
    const claimed = await tx.execute({
      sql: `
        UPDATE community_health_sync_state
        SET updated_at = updated_at
        WHERE projection_key = ?1
          AND next_date = ?2
      `,
      args: [COMMUNITY_HEALTH_PROJECTION_KEY, input.date],
    })
    if ((claimed.rowsAffected ?? 0) === 0) {
      return false
    }
    if (claimed.rowsAffected !== 1) {
      throw new Error(`community health watermark claim affected ${String(claimed.rowsAffected)} rows`)
    }

    for (const entries of chunksOf([...input.counts], HEALTH_COUNT_UPSERT_CHUNK_SIZE)) {
      const args: unknown[] = []
      const values = entries.map(([communityId, viewDelta]) => {
        const offset = args.length
        args.push(communityId, viewDelta, input.updatedAt)
        return `(?${offset + 1}, ?${offset + 2}, ?${offset + 3})`
      })
      await tx.execute({
        sql: `
          INSERT INTO community_health_counts (
            community_id,
            total_views,
            updated_at
          ) VALUES ${values.join(", ")}
          ON CONFLICT (community_id) DO UPDATE SET
            total_views = community_health_counts.total_views + excluded.total_views,
            updated_at = excluded.updated_at
        `,
        args,
      })
    }

    const advanced = await tx.execute({
      sql: `
        UPDATE community_health_sync_state
        SET next_date = ?2,
            updated_at = ?3
        WHERE projection_key = ?1
          AND next_date = ?4
      `,
      args: [COMMUNITY_HEALTH_PROJECTION_KEY, input.nextDate, input.updatedAt, input.date],
    })
    if ((advanced.rowsAffected ?? 0) !== 1) {
      throw new Error(`community health watermark no longer owns ${input.date}`)
    }
    return true
  })
}

export async function syncCommunityHealthCounts(
  env: Env,
  client: Client,
  options: { now?: Date; maxDays?: number } = {},
): Promise<CommunityHealthSyncResult> {
  if (!tinybirdReadToken(env)) {
    throw new Error("TINYBIRD_READ_TOKEN is required to sync community health counts")
  }
  const today = utcDate(options.now ?? new Date())
  const maxDays = options.maxDays ?? MAX_DAYS_PER_SYNC
  if (!Number.isInteger(maxDays) || maxDays < 1 || maxDays > MAX_DAYS_PER_SYNC) {
    throw new Error(`community health maxDays must be between 1 and ${MAX_DAYS_PER_SYNC}`)
  }

  const projectionReset = await initializeCommunityHealthProjection(client, today, new Date().toISOString())
  let nextDate = await readNextCommunityHealthDate(client)
  let fetchedRows = 0
  let syncedCommunities = 0
  let processedDays = 0
  let canonicalByIdentifier: Map<string, string> | null = null

  while (nextDate < today && processedDays < maxDays) {
    const fetched = await fetchTinybirdCommunityViewCountsForDate(env, nextDate)
    if (fetched.counts.size > 0 && !canonicalByIdentifier) {
      canonicalByIdentifier = await loadCanonicalCommunityIdentifiers(client)
    }
    const canonicalCounts = canonicalizeCommunityHealthCounts(
      fetched.counts,
      canonicalByIdentifier ?? new Map(),
    )
    const followingDate = addUtcDays(nextDate, 1)
    const applied = await applyCommunityHealthDay(client, {
      date: nextDate,
      nextDate: followingDate,
      counts: canonicalCounts,
      updatedAt: new Date().toISOString(),
    })
    if (!applied) {
      const refreshedDate = await readNextCommunityHealthDate(client)
      if (refreshedDate <= nextDate) {
        throw new Error(`community health watermark failed to advance beyond ${nextDate}`)
      }
      nextDate = refreshedDate
      continue
    }
    fetchedRows += fetched.rowCount
    syncedCommunities += canonicalCounts.size
    processedDays += 1
    nextDate = followingDate
  }

  return {
    fetched_rows: fetchedRows,
    synced_communities: syncedCommunities,
    processed_days: processedDays,
    next_date: nextDate,
    projection_reset: projectionReset,
  }
}
