import { isMissingRelationError } from "../db-helpers"
import { getProfileRepository } from "../auth/repositories"
import { getCommunityRepository } from "../communities/db-community-repository"
import { getControlPlaneClient } from "../runtime-deps"
import type { Client } from "../sql-client"
import { HOME_FEED_SERVER_TIMING, listHomeFeed, type HomeFeedResponseWithTiming } from "./home-feed-service"
import type { Env, HomeFeedResponse } from "../../types"

const MATERIALIZED_PUBLIC_HOME_FEED_SCHEMA_VERSION = "public_home_feed_v1"
const MATERIALIZED_PUBLIC_HOME_FEED_FRESH_MS = 5 * 60 * 1000
const MATERIALIZED_PUBLIC_HOME_FEED_STALE_MS = 30 * 60 * 1000
// Keep the homepage available through a short scheduler/control-plane incident.
// Expired snapshots are public-only and trigger a background refresh; the bound
// prevents deleted or reordered content from remaining visible indefinitely.
const MATERIALIZED_PUBLIC_HOME_FEED_EXPIRED_GRACE_MS = 2 * 60 * 60 * 1000
const DEFAULT_MATERIALIZED_PUBLIC_HOME_FEED_LOCALES = ["en"]

type MaterializedPublicHomeFeedTarget = {
  cacheKey: string
  locale: string | null
  sort: "best"
  timeRange: "all"
  cursor: null
}

export type MaterializedPublicHomeFeedRead =
  | {
    result: HomeFeedResponseWithTiming
    state: "hit" | "stale"
  }
  | {
    result: null
    state: "miss" | "bypass" | "error"
  }

const materializedPublicHomeFeedRefreshes = new Map<string, Promise<void>>()

export function resetMaterializedPublicHomeFeedForTests(): void {
  materializedPublicHomeFeedRefreshes.clear()
}

function nowIso(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString()
}

function normalizeLocale(locale: string | null | undefined): string | null {
  const normalized = locale?.trim().toLowerCase()
  return normalized || null
}

function normalizeSort(sort: string | null | undefined): "best" | "other" {
  return !sort || sort === "best" ? "best" : "other"
}

function normalizeTimeRange(timeRange: string | null | undefined): "all" | "other" {
  return !timeRange || timeRange === "all" ? "all" : "other"
}

export function buildMaterializedPublicHomeFeedTarget(input: {
  cursor?: string | null
  locale?: string | null
  searchParams?: URLSearchParams
  sort?: string | null
  timeRange?: string | null
}): MaterializedPublicHomeFeedTarget | null {
  if (input.searchParams) {
    for (const key of input.searchParams.keys()) {
      if (key !== "cursor" && key !== "locale" && key !== "sort" && key !== "time_range") {
        return null
      }
    }
  }

  if (input.cursor?.trim()) {
    return null
  }
  if (normalizeSort(input.sort) !== "best") {
    return null
  }
  if (normalizeTimeRange(input.timeRange) !== "all") {
    return null
  }

  const locale = normalizeLocale(input.locale)
  const localeKey = locale ?? "default"
  return {
    cacheKey: [
      MATERIALIZED_PUBLIC_HOME_FEED_SCHEMA_VERSION,
      "sort=best",
      `locale=${localeKey}`,
      "time_range=all",
      "cursor=first",
    ].join(":"),
    locale,
    sort: "best",
    timeRange: "all",
    cursor: null,
  }
}

function attachMaterializedServerTiming(
  response: HomeFeedResponse,
  input: {
    durationMs: number
    state: "hit" | "stale"
  },
): HomeFeedResponseWithTiming {
  Object.defineProperty(response, HOME_FEED_SERVER_TIMING, {
    configurable: true,
    enumerable: false,
    value: `home-feed;dur=${input.durationMs}, materialized-public-feed-${input.state};dur=${input.durationMs}`,
  })
  return response as HomeFeedResponseWithTiming
}

export function parseMaterializedPublicHomeFeedBody(rawBody: unknown): HomeFeedResponse | null {
  const parsed = typeof rawBody === "string"
    ? (rawBody ? JSON.parse(rawBody) as Partial<HomeFeedResponse> : null)
    : rawBody as Partial<HomeFeedResponse> | null
  if (!parsed || typeof parsed !== "object") {
    return null
  }
  if (!Array.isArray(parsed.items) || !Array.isArray(parsed.top_communities)) {
    return null
  }
  return {
    items: parsed.items as HomeFeedResponse["items"],
    top_communities: parsed.top_communities as HomeFeedResponse["top_communities"],
    next_cursor: typeof parsed.next_cursor === "string" ? parsed.next_cursor : null,
  }
}

export async function readMaterializedPublicHomeFeed(input: {
  client: Client
  nowMs?: number
  target: MaterializedPublicHomeFeedTarget | null
}): Promise<MaterializedPublicHomeFeedRead> {
  if (!input.target) {
    return { result: null, state: "bypass" }
  }

  const startedAt = performance.now()
  const nowMs = input.nowMs ?? Date.now()
  const now = nowIso(nowMs)
  try {
    const result = await input.client.execute({
      sql: `
        SELECT json_body, expires_at, stale_at
        FROM materialized_public_feeds
        WHERE cache_key = ?1
        LIMIT 1
      `,
      args: [input.target.cacheKey],
    })
    const row = result.rows[0]
    if (!row) {
      return { result: null, state: "miss" }
    }

    const body = parseMaterializedPublicHomeFeedBody(row.json_body)
    if (!body) {
      return { result: null, state: "miss" }
    }

    const expiresAt = typeof row.expires_at === "string" ? row.expires_at : String(row.expires_at ?? "")
    const staleAt = typeof row.stale_at === "string" ? row.stale_at : String(row.stale_at ?? "")
    if (expiresAt > now) {
      return {
        result: attachMaterializedServerTiming(body, {
          durationMs: Math.round(performance.now() - startedAt),
          state: "hit",
        }),
        state: "hit",
      }
    }
    if (staleAt > now) {
      return {
        result: attachMaterializedServerTiming(body, {
          durationMs: Math.round(performance.now() - startedAt),
          state: "stale",
        }),
        state: "stale",
      }
    }
    const staleAtMs = Date.parse(staleAt)
    if (Number.isFinite(staleAtMs) && nowMs <= staleAtMs + MATERIALIZED_PUBLIC_HOME_FEED_EXPIRED_GRACE_MS) {
      return {
        result: attachMaterializedServerTiming(body, {
          durationMs: Math.round(performance.now() - startedAt),
          state: "stale",
        }),
        state: "stale",
      }
    }
    return { result: null, state: "miss" }
  } catch (error) {
    if (!isMissingRelationError(error, "materialized_public_feeds")) {
      console.error("[materialized-public-feed] read failed", error)
    }
    return { result: null, state: "error" }
  }
}

export async function storeMaterializedPublicHomeFeed(input: {
  client: Client
  env: Env
  nowMs?: number
  result: HomeFeedResponse
  target: MaterializedPublicHomeFeedTarget | null
}): Promise<void> {
  if (!input.target) {
    return
  }

  const nowMs = input.nowMs ?? Date.now()
  const refreshedAt = nowIso(nowMs)
  const expiresAt = nowIso(nowMs + MATERIALIZED_PUBLIC_HOME_FEED_FRESH_MS)
  const staleAt = nowIso(nowMs + MATERIALIZED_PUBLIC_HOME_FEED_STALE_MS)
  const jsonBody = JSON.stringify(input.result)
  try {
    await input.client.execute({
      sql: `
        INSERT INTO materialized_public_feeds (
          cache_key,
          json_body,
          created_at,
          refreshed_at,
          expires_at,
          stale_at,
          source_version
        ) VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6)
        ON CONFLICT(cache_key) DO UPDATE SET
          json_body = excluded.json_body,
          refreshed_at = excluded.refreshed_at,
          expires_at = excluded.expires_at,
          stale_at = excluded.stale_at,
          source_version = excluded.source_version
      `,
      args: [
        input.target.cacheKey,
        jsonBody,
        refreshedAt,
        expiresAt,
        staleAt,
        input.env.BUILD_GIT_SHA ?? MATERIALIZED_PUBLIC_HOME_FEED_SCHEMA_VERSION,
      ],
    })
  } catch (error) {
    if (!isMissingRelationError(error, "materialized_public_feeds")) {
      console.error("[materialized-public-feed] store failed", error)
    }
  }
}

export function refreshMaterializedPublicHomeFeed(input: {
  env: Env
  target: MaterializedPublicHomeFeedTarget | null
}): Promise<void> {
  const target = input.target
  if (!target) {
    return Promise.resolve()
  }

  const existingRefresh = materializedPublicHomeFeedRefreshes.get(target.cacheKey)
  if (existingRefresh) {
    return existingRefresh
  }

  const refresh = refreshMaterializedPublicHomeFeedOnce({
    env: input.env,
    target,
  })
    .finally(() => {
      materializedPublicHomeFeedRefreshes.delete(target.cacheKey)
    })
  materializedPublicHomeFeedRefreshes.set(target.cacheKey, refresh)
  return refresh
}

async function refreshMaterializedPublicHomeFeedOnce(input: {
  env: Env
  target: MaterializedPublicHomeFeedTarget
}): Promise<void> {
  const communityRepository = getCommunityRepository(input.env)
  const client = getControlPlaneClient(input.env)
  try {
    const result = await listHomeFeed({
      env: input.env,
      userId: null,
      locale: input.target.locale,
      sort: input.target.sort,
      timeRange: input.target.timeRange,
      cursor: input.target.cursor,
      communityRepository,
      userRepository: null,
      profileRepository: getProfileRepository(input.env),
    })
    await storeMaterializedPublicHomeFeed({
      client,
      env: input.env,
      result,
      target: input.target,
    })
  } catch (error) {
    console.error("[materialized-public-feed] refresh failed", error)
  } finally {
    await communityRepository.close?.()
  }
}

function scheduledLocales(env: Env): string[] {
  const configured = env.MATERIALIZED_PUBLIC_HOME_FEED_LOCALES
    ?.split(",")
    .map((locale) => normalizeLocale(locale))
    .filter((locale): locale is string => Boolean(locale))
  return configured?.length ? [...new Set(configured)] : DEFAULT_MATERIALIZED_PUBLIC_HOME_FEED_LOCALES
}

export async function refreshScheduledMaterializedPublicHomeFeeds(env: Env): Promise<void> {
  const client = getControlPlaneClient(env)
  await Promise.all(scheduledLocales(env).map(async (locale) => {
    const target = buildMaterializedPublicHomeFeedTarget({
      locale,
      sort: "best",
      timeRange: "all",
      cursor: null,
    })
    const materialized = await readMaterializedPublicHomeFeed({ client, target })
    if (materialized.state === "hit" || materialized.state === "error") {
      return
    }
    await refreshMaterializedPublicHomeFeed({ env, target })
  }))
}
