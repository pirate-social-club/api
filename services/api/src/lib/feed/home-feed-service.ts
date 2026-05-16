import { isMissingRelationError } from "../db-helpers"
import type { CommunityReadRepository } from "../communities/db-community-repository"
import { getControlPlaneClient } from "../runtime-deps"
import { requiredNumber, requiredString } from "../sql-row"
import { ensureCommunityHealthCountsTable, fetchTinybirdCommunityViewCounts, upsertCommunityHealthCounts } from "../analytics/community-analytics-sync"
import type { CommunityFollowProjectionRow, CommunityMembershipProjectionRow, CommunityRow } from "../auth/auth-db-rows"
import { resolveAgeGateViewerState } from "../posts/age-gate-viewer-state"
import type { ProfileRepository, UserRepository } from "../auth/repositories"
import type {
  Env,
  HomeFeedItem,
  HomeFeedResponse,
  HomeFeedSort,
} from "../../types"
import {
  readHomeFeedCommunityItems,
  resolveTopCommunitiesIdentity,
  serializeHomeFeedCommunitySummary,
  type HomeFeedCommunityIdentity,
  type HomeFeedCommunityTiming,
  type HomeFeedWaitUntil,
} from "./home-feed-community-reader"
import type {
  HomeFeedCommunityRepository,
  HomeFeedProjectionRow,
  HomeFeedTimeRange,
  InternalHomeFeedCommunitySummary,
} from "./home-feed-types"

export { withHomeFeedCommunityIdentity } from "./home-feed-community-reader"
export type { HomeFeedCommunityIdentity, HomeFeedWaitUntil } from "./home-feed-community-reader"
export type {
  HomeFeedCommunityRepository,
  HomeFeedProjectionRow,
  HomeFeedTimeRange,
  InternalHomeFeedCommunitySummary,
} from "./home-feed-types"

const HOME_FEED_COMMUNITY_READ_CONCURRENCY = 4
const HOME_FEED_TIMING_LOG_THRESHOLD_MS = 1_000

export const HOME_FEED_SERVER_TIMING: unique symbol = Symbol("home-feed-server-timing")

export type HomeFeedResponseWithTiming = HomeFeedResponse & {
  [HOME_FEED_SERVER_TIMING]?: string
}

function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt)
}

function serverTimingMetricName(name: string): string {
  return name.replace(/_ms$/u, "").replace(/_/gu, "-")
}

function formatHomeFeedServerTiming(input: {
  phases: Record<string, number>
  totalMs: number
}): string {
  return [
    `home-feed;dur=${input.totalMs}`,
    ...Object.entries(input.phases)
      .filter((entry): entry is [string, number] => Number.isFinite(entry[1]))
      .map(([name, duration]) => `${serverTimingMetricName(name)};dur=${duration}`),
  ].join(", ")
}

function withHomeFeedServerTiming(
  response: HomeFeedResponse,
  input: {
    phases: Record<string, number>
    totalMs: number
  },
): HomeFeedResponseWithTiming {
  Object.defineProperty(response, HOME_FEED_SERVER_TIMING, {
    configurable: true,
    enumerable: false,
    value: formatHomeFeedServerTiming(input),
  })
  return response as HomeFeedResponseWithTiming
}

function summarizeCommunityTimings(timings: HomeFeedCommunityTiming[]): HomeFeedCommunityTiming[] {
  return [...timings]
    .sort((left, right) => right.total_ms - left.total_ms)
    .slice(0, 8)
}

function parseHomeFeedSort(sort: string | null | undefined): HomeFeedSort {
  return sort === "new" || sort === "top" ? sort : "best"
}

function parseHomeFeedTimeRange(timeRange: string | null | undefined): HomeFeedTimeRange {
  if (timeRange === "hour" || timeRange === "day" || timeRange === "week" || timeRange === "month" || timeRange === "year" || timeRange === "all") {
    return timeRange
  }
  return "all"
}

function getTimeRangeCutoffMs(timeRange: HomeFeedTimeRange, now: number): number | null {
  if (timeRange === "all") return null
  const hours: Record<Exclude<HomeFeedTimeRange, "all">, number> = {
    hour: 1,
    day: 24,
    week: 168,
    month: 720,
    year: 8760,
  }
  return now - hours[timeRange] * 3_600_000
}

function parseOffsetCursor(cursor: string | null | undefined): number {
  if (!cursor || !cursor.startsWith("o:")) {
    return 0
  }
  const parsed = Number(cursor.slice(2))
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0
}

function getProjectionVoteScore(row: HomeFeedProjectionRow): number {
  return row.upvote_count - row.downvote_count
}

function getProjectionEngagementScore(row: HomeFeedProjectionRow): number {
  return getProjectionVoteScore(row) * 3 + row.comment_count * 2 + row.like_count
}

function getProjectionCreatedAtMs(row: HomeFeedProjectionRow): number {
  const timestamp = Date.parse(row.source_created_at)
  return Number.isNaN(timestamp) ? 0 : timestamp
}

function getBestProjectionRank(row: HomeFeedProjectionRow, now: number): number {
  const ageHours = Math.max(0, (now - getProjectionCreatedAtMs(row)) / 3_600_000)
  return getProjectionEngagementScore(row) / Math.pow(ageHours + 2, 1.5)
}

function toHomeFeedProjectionRow(row: unknown): HomeFeedProjectionRow {
  return {
    community_id: requiredString(row, "community_id"),
    source_post_id: requiredString(row, "source_post_id"),
    source_created_at: requiredString(row, "source_created_at"),
    visibility: requiredString(row, "visibility") as HomeFeedProjectionRow["visibility"],
    upvote_count: requiredNumber(row, "upvote_count"),
    downvote_count: requiredNumber(row, "downvote_count"),
    comment_count: requiredNumber(row, "comment_count"),
    like_count: requiredNumber(row, "like_count"),
  }
}

async function mapWithConcurrency<T, TResult>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  const results = new Array<TResult>(items.length)
  let nextIndex = 0

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = nextIndex
      nextIndex += 1

      if (index >= items.length) {
        return
      }

      results[index] = await mapper(items[index] as T, index)
    }
  }))

  return results
}

function buildCommunitySummary(
  community: Awaited<ReturnType<CommunityReadRepository["getCommunityById"]>>,
  communityViewCounts: Map<string, number> = new Map(),
): InternalHomeFeedCommunitySummary | null {
  if (!community) {
    return null
  }
  return {
    id: `com_${community.community_id}`,
    object: "home_feed_community_summary",
    community_id: community.community_id,
    display_name: community.display_name,
    route_slug: community.route_slug,
    avatar_ref: null,
    member_count: null,
    follower_count: community.follower_count,
    view_count: communityViewCounts.get(community.community_id) ?? 0,
    updated_at: community.updated_at,
  }
}

export function resolveJoinedHomeFeedCommunityIds(input: {
  activeCommunities: CommunityRow[]
  membershipRows: CommunityMembershipProjectionRow[]
  userId: string | null
}): string[] {
  if (!input.userId) {
    return []
  }

  const memberCommunityIds = new Set<string>()

  for (const row of input.membershipRows) {
    if (row.membership_state === "member") {
      memberCommunityIds.add(row.community_id)
    }
  }

  for (const community of input.activeCommunities) {
    if (community.creator_user_id === input.userId) {
      memberCommunityIds.add(community.community_id)
    }
  }

  return [...memberCommunityIds]
}

export function resolveHomeFeedCommunityIds(input: {
  activeCommunities: CommunityRow[]
  followRows: CommunityFollowProjectionRow[]
  membershipRows: CommunityMembershipProjectionRow[]
  userId: string | null
}): string[] {
  return input.activeCommunities.map((community) => community.community_id)
}

export function filterVisibleHomeFeedProjections(
  rows: HomeFeedProjectionRow[],
  memberCommunityIds: Set<string>,
): HomeFeedProjectionRow[] {
  return rows.filter((row) => row.visibility === "public" || memberCommunityIds.has(row.community_id))
}

export type CommunityAggregate = {
  totalScore: number
  bestRank: number
  latestPostMs: number
}

export function filterCommunitiesWithPosts(
  summaries: InternalHomeFeedCommunitySummary[],
  aggregates: Map<string, CommunityAggregate>,
  hasTimeRange: boolean,
): InternalHomeFeedCommunitySummary[] {
  if (!hasTimeRange) return summaries
  return summaries.filter((summary) => aggregates.has(summary.community_id))
}

export function sortCommunitySummaries(
  summaries: InternalHomeFeedCommunitySummary[],
  aggregates: Map<string, CommunityAggregate>,
  sort: HomeFeedSort,
): InternalHomeFeedCommunitySummary[] {
  return [...summaries].sort((left, right) => {
    const leftAgg = aggregates.get(left.community_id)
    const rightAgg = aggregates.get(right.community_id)

    if (sort === "top") {
      const leftScore = leftAgg?.totalScore ?? 0
      const rightScore = rightAgg?.totalScore ?? 0
      if (rightScore !== leftScore) return rightScore - leftScore
    } else if (sort === "best") {
      const leftRank = leftAgg?.bestRank ?? 0
      const rightRank = rightAgg?.bestRank ?? 0
      if (rightRank !== leftRank) return rightRank - leftRank
    }

    const leftLatest = leftAgg?.latestPostMs ?? Date.parse(left.updated_at)
    const rightLatest = rightAgg?.latestPostMs ?? Date.parse(right.updated_at)
    if (rightLatest !== leftLatest) return rightLatest - leftLatest

    return left.community_id.localeCompare(right.community_id)
  })
}

export function sortCommunitySummariesByViews(
  summaries: InternalHomeFeedCommunitySummary[],
): InternalHomeFeedCommunitySummary[] {
  return [...summaries].sort((left, right) => {
    const leftViews = left.view_count ?? 0
    const rightViews = right.view_count ?? 0
    if (rightViews !== leftViews) return rightViews - leftViews

    const leftUpdated = Date.parse(left.updated_at)
    const rightUpdated = Date.parse(right.updated_at)
    if (rightUpdated !== leftUpdated) return rightUpdated - leftUpdated

    return left.community_id.localeCompare(right.community_id)
  })
}

export function sortHomeFeedProjectionRows(
  rows: readonly HomeFeedProjectionRow[],
  sort: HomeFeedSort,
  now: number,
): HomeFeedProjectionRow[] {
  return [...rows].sort((left, right) => {
    if (sort === "new") {
      return getProjectionCreatedAtMs(right) - getProjectionCreatedAtMs(left)
    }

    const leftHasEngagement = getProjectionEngagementScore(left) > 0
    const rightHasEngagement = getProjectionEngagementScore(right) > 0
    if (leftHasEngagement !== rightHasEngagement) {
      return rightHasEngagement ? 1 : -1
    }

    if (sort === "top") {
      const scoreDiff = getProjectionEngagementScore(right) - getProjectionEngagementScore(left)
      if (scoreDiff !== 0) {
        return scoreDiff
      }
    } else {
      const rankDiff = getBestProjectionRank(right, now) - getBestProjectionRank(left, now)
      if (rankDiff !== 0) {
        return rankDiff
      }
    }

    const createdAtDiff = getProjectionCreatedAtMs(right) - getProjectionCreatedAtMs(left)
    if (createdAtDiff !== 0) {
      return createdAtDiff
    }
    return right.source_post_id.localeCompare(left.source_post_id)
  })
}

async function listHomeFeedProjectionRows(input: {
  env: Env
  communityIds: string[]
}): Promise<HomeFeedProjectionRow[]> {
  const controlPlaneClient = getControlPlaneClient(input.env)
  const placeholders = input.communityIds.map((_, index) => `?${index + 1}`).join(", ")

  const result = await controlPlaneClient.execute({
    sql: `
      SELECT community_id, source_post_id, source_created_at, visibility, upvote_count, downvote_count, comment_count, like_count
      FROM community_post_projections
      WHERE projection_version = 1
        AND status = 'published'
        AND community_id IN (${placeholders})
    `,
    args: input.communityIds,
  })
  return result.rows.map((row) => toHomeFeedProjectionRow(row))
}

export async function listHomeFeedCommunityViewCounts(input: {
  env: Env
  communityIds: string[]
}): Promise<Map<string, number>> {
  if (input.communityIds.length === 0) {
    return new Map()
  }

  const controlPlaneClient = getControlPlaneClient(input.env)
  const placeholders = input.communityIds.map((_, index) => `?${index + 1}`).join(", ")
  const statement = {
    sql: `
      SELECT community_id, total_views
      FROM community_health_counts
      WHERE community_id IN (${placeholders})
    `,
    args: input.communityIds,
  }
  const result = await controlPlaneClient.execute({
    ...statement,
  }).catch(async (error: unknown) => {
    if (isMissingRelationError(error, "community_health_counts")) {
      try {
        await ensureCommunityHealthCountsTable(controlPlaneClient)
      } catch (bootstrapError) {
        console.error("[home-feed] failed to create community health counts table", bootstrapError)
        return { rows: [] }
      }

      if (String(input.env.TINYBIRD_READ_TOKEN || "").trim()) {
        try {
          await upsertCommunityHealthCounts(controlPlaneClient, await fetchTinybirdCommunityViewCounts(input.env))
        } catch (syncError) {
          console.error("[home-feed] failed to bootstrap community health counts", syncError)
        }
      }

      return controlPlaneClient.execute(statement).catch((retryError: unknown) => {
        if (isMissingRelationError(retryError, "community_health_counts")) {
          return { rows: [] }
        }
        throw retryError
      })
    }
    throw error
  })

  const counts = new Map<string, number>()
  for (const row of result.rows) {
    const communityId = requiredString(row, "community_id")
    const totalViews = requiredNumber(row, "total_views")
    counts.set(communityId, totalViews)
  }
  return counts
}

export async function listHomeFeed(input: {
  env: Env
  userId: string | null
  locale?: string | null
  sort?: string | null
  timeRange?: string | null
  cursor?: string | null
  communityRepository: HomeFeedCommunityRepository
  userRepository?: UserRepository | null
  profileRepository?: ProfileRepository | null
  waitUntil?: HomeFeedWaitUntil
}): Promise<HomeFeedResponseWithTiming> {
  const requestStartedAt = performance.now()
  const phaseTimings: Record<string, number> = {}
  let phaseStartedAt = performance.now()
  const ageGateState = input.userId && input.userRepository
    ? await resolveAgeGateViewerState({
        userId: input.userId,
        userRepository: input.userRepository,
        postAgeGatePolicy: "18_plus",
      })
    : null
  const activeCommunities = await input.communityRepository.listActiveCommunities()
  const membershipRows = input.userId
    ? await input.communityRepository.listCommunityMembershipProjectionsByUserId(input.userId)
    : []
  const followRows = input.userId
    ? await input.communityRepository.listCommunityFollowProjectionsByUserId(input.userId)
    : []
  phaseTimings.viewer_ms = elapsedMs(phaseStartedAt)
  phaseStartedAt = performance.now()
  const memberCommunityIdSet = new Set(resolveJoinedHomeFeedCommunityIds({
    activeCommunities,
    membershipRows,
    userId: input.userId,
  }))
  const communityIds = resolveHomeFeedCommunityIds({
    activeCommunities,
    followRows,
    membershipRows,
    userId: input.userId,
  })

  if (communityIds.length === 0) {
    phaseTimings.resolve_communities_ms = elapsedMs(phaseStartedAt)
    const totalMs = elapsedMs(requestStartedAt)
    if (totalMs >= HOME_FEED_TIMING_LOG_THRESHOLD_MS) {
      console.info("[home-feed] timing", JSON.stringify({
        total_ms: totalMs,
        authenticated: Boolean(input.userId),
        locale: input.locale ?? null,
        sort: input.sort ?? null,
        time_range: input.timeRange ?? null,
        cursor: input.cursor ?? null,
        active_communities: activeCommunities.length,
        candidate_communities: 0,
        projection_rows: 0,
        page_rows: 0,
        returned_items: 0,
        top_communities: 0,
        phases: phaseTimings,
        slow_communities: [],
      }))
    }
    return withHomeFeedServerTiming({
      items: [],
      top_communities: [],
      next_cursor: null,
    }, {
      phases: phaseTimings,
      totalMs,
    })
  }
  phaseTimings.resolve_communities_ms = elapsedMs(phaseStartedAt)

  phaseStartedAt = performance.now()
  const communityViewCounts = await listHomeFeedCommunityViewCounts({
    env: input.env,
    communityIds,
  })
  const communitySummaries = (
    await Promise.all(communityIds.map(async (communityId) => buildCommunitySummary(
      await input.communityRepository.getCommunityById(communityId),
      communityViewCounts,
    )))
  )
    .filter((summary): summary is InternalHomeFeedCommunitySummary => Boolean(summary))
  phaseTimings.community_summaries_ms = elapsedMs(phaseStartedAt)

  phaseStartedAt = performance.now()
  const sort = parseHomeFeedSort(input.sort)
  const now = Date.now()
  const allRows = filterVisibleHomeFeedProjections(
    await listHomeFeedProjectionRows({
      env: input.env,
      communityIds,
    }),
    memberCommunityIdSet,
  )

  const timeRange = parseHomeFeedTimeRange(input.timeRange)
  const cutoffMs = getTimeRangeCutoffMs(timeRange, now)
  const timeFilteredRows = cutoffMs != null
    ? allRows.filter((row) => getProjectionCreatedAtMs(row) >= cutoffMs)
    : allRows

  const communityAggregateById = new Map<string, CommunityAggregate>()
  for (const row of timeFilteredRows) {
    const existing = communityAggregateById.get(row.community_id)
    const rowScore = getProjectionEngagementScore(row)
    const rowBestRank = getBestProjectionRank(row, now)
    const rowCreatedAtMs = getProjectionCreatedAtMs(row)
    if (!existing) {
      communityAggregateById.set(row.community_id, {
        totalScore: rowScore,
        bestRank: rowBestRank,
        latestPostMs: rowCreatedAtMs,
      })
    } else {
      existing.totalScore += rowScore
      existing.bestRank += rowBestRank
      if (rowCreatedAtMs > existing.latestPostMs) {
        existing.latestPostMs = rowCreatedAtMs
      }
    }
  }

  const communitySummaryById = Object.fromEntries(
    communitySummaries.map((summary) => [summary.community_id, summary] as const),
  )

  const communitiesWithPosts = filterCommunitiesWithPosts(communitySummaries, communityAggregateById, cutoffMs != null)

  const sortedRows = sortHomeFeedProjectionRows(timeFilteredRows, sort, now)

  const offset = parseOffsetCursor(input.cursor)
  const pageRows = sortedRows.slice(offset, offset + 25)
  const nextCursor = offset + 25 < sortedRows.length ? `o:${offset + 25}` : null
  phaseTimings.projections_and_rank_ms = elapsedMs(phaseStartedAt)

  const rowsByCommunityId = new Map<string, HomeFeedProjectionRow[]>()
  for (const row of pageRows) {
    const rows = rowsByCommunityId.get(row.community_id) ?? []
    rows.push(row)
    rowsByCommunityId.set(row.community_id, rows)
  }
  const communityIdentityById = new Map<string, HomeFeedCommunityIdentity | null>()
  const communityTimings: HomeFeedCommunityTiming[] = []

  phaseStartedAt = performance.now()
  const communityItemGroups = await mapWithConcurrency([...rowsByCommunityId.entries()], HOME_FEED_COMMUNITY_READ_CONCURRENCY, async ([communityId, rows]) => {
    const result = await readHomeFeedCommunityItems({
      env: input.env,
      communityId,
      rows,
      baseCommunity: communitySummaryById[communityId],
      memberCommunityIdSet,
      communityRepository: input.communityRepository,
      profileRepository: input.profileRepository,
      userId: input.userId,
      locale: input.locale,
      ageGateState,
      waitUntil: input.waitUntil,
    })
    communityIdentityById.set(communityId, result.identity)
    communityTimings.push(result.timing)
    return result.items
  })
  phaseTimings.community_fanout_ms = elapsedMs(phaseStartedAt)
  const items = communityItemGroups.flat()

  phaseStartedAt = performance.now()
  const itemByPostId = Object.fromEntries(items.map((item) => [item.post.post.id.replace(/^post_/, ""), item] as const))
  const orderedItems = pageRows
    .map((row) => itemByPostId[row.source_post_id])
    .filter((item): item is HomeFeedItem => Boolean(item))
  phaseTimings.order_items_ms = elapsedMs(phaseStartedAt)

  phaseStartedAt = performance.now()
  const topCommunities = await resolveTopCommunitiesIdentity({
    env: input.env,
    communityRepository: input.communityRepository,
    summaries: sortCommunitySummariesByViews(communitiesWithPosts).slice(0, 6),
    cachedIdentityByCommunityId: communityIdentityById,
  })
  phaseTimings.top_communities_ms = elapsedMs(phaseStartedAt)
  const totalMs = elapsedMs(requestStartedAt)
  if (totalMs >= HOME_FEED_TIMING_LOG_THRESHOLD_MS) {
    console.info("[home-feed] timing", JSON.stringify({
      total_ms: totalMs,
      authenticated: Boolean(input.userId),
      locale: input.locale ?? null,
      sort: input.sort ?? null,
      parsed_sort: sort,
      time_range: input.timeRange ?? null,
      cursor: input.cursor ?? null,
      active_communities: activeCommunities.length,
      candidate_communities: communityIds.length,
      projection_rows: allRows.length,
      time_filtered_rows: timeFilteredRows.length,
      page_rows: pageRows.length,
      page_communities: rowsByCommunityId.size,
      returned_items: orderedItems.length,
      top_communities: topCommunities.length,
      phases: phaseTimings,
      slow_communities: summarizeCommunityTimings(communityTimings),
    }))
  }

  return withHomeFeedServerTiming({
    items: orderedItems,
    top_communities: topCommunities.map(serializeHomeFeedCommunitySummary),
    next_cursor: nextCursor,
  }, {
    phases: phaseTimings,
    totalMs,
  })
}
