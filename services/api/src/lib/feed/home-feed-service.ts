import { isMissingRelationError } from "../db-helpers"
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
import {
  decorateHomeFeedItemsWithBookings,
  listFeedBookingDiscoveryByHostUserIds,
  type FeedBookingLookup,
} from "./home-feed-booking"
import { refreshBookingFeedDiscoverySnapshotsInBackground } from "../bookings/booking-feed-discovery"
import {
  compareProjectedVideoFeedRows,
  shouldShadowAuthenticatedVideoFeed,
} from "./home-feed-control-plane-shadow"
import {
  AUTHOR_CAP_PER_PAGE,
  COMMUNITY_CAP_PER_PAGE,
  takeVideoFeedPage,
} from "./video-feed-selection"
import {
  scoreVideoCandidates,
  type ScoredVideoCandidate,
  type VideoCandidateInput,
} from "./video-scorer"

export { withHomeFeedCommunityIdentity } from "./home-feed-community-reader"
export type { HomeFeedWaitUntil } from "./home-feed-community-reader"
export type {
  HomeFeedCommunityRepository,
  HomeFeedProjectionRow,
  InternalHomeFeedCommunitySummary,
} from "./home-feed-types"

const HOME_FEED_COMMUNITY_READ_CONCURRENCY = 4

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
  return (getProjectionEngagementScore(row) + 1) / Math.pow(ageHours + 2, 1.5)
}

function toHomeFeedProjectionRow(row: unknown): HomeFeedProjectionRow {
  const record = row as Record<string, unknown>
  return {
    community_id: requiredString(row, "community_id"),
    source_post_id: requiredString(row, "source_post_id"),
    author_user_id: typeof record.author_user_id === "string" ? record.author_user_id : null,
    identity_mode: record.identity_mode === "public" || record.identity_mode === "anonymous"
      ? record.identity_mode
      : undefined,
    source_created_at: requiredString(row, "source_created_at"),
    visibility: requiredString(row, "visibility") as HomeFeedProjectionRow["visibility"],
    projected_payload_json: record.projected_payload_json,
    upvote_count: requiredNumber(row, "upvote_count"),
    downvote_count: requiredNumber(row, "downvote_count"),
    comment_count: requiredNumber(row, "comment_count"),
    like_count: requiredNumber(row, "like_count"),
    post_type: typeof record.post_type === "string"
      ? record.post_type as HomeFeedProjectionRow["post_type"]
      : undefined,
  }
}

type VideoFeedCursor = { offset: number; rankedAt: number }
const VIDEO_FEED_PAGE_SIZE = 25
const VIDEO_FEED_MAX_CANDIDATES_SCANNED = 250
const VIDEO_FEED_CANDIDATES_PER_LEG = 250

type VideoFeedProjectionPage = {
  allowHydrationBackfill: boolean
  bestOrderedRows?: readonly HomeFeedProjectionRow[]
  nextCursor: string | null
  rows: HomeFeedProjectionRow[]
}

export function nextVideoFeedBackfillBatchSize(input: {
  candidatesScanned: number
  returnedItems: number
}): number {
  const remainingSlots = Math.max(0, VIDEO_FEED_PAGE_SIZE - input.returnedItems)
  const remainingScanBudget = Math.max(0, VIDEO_FEED_MAX_CANDIDATES_SCANNED - input.candidatesScanned)
  return Math.min(remainingSlots, remainingScanBudget)
}

export function parseVideoFeedCursor(cursor: string | null | undefined, now: number): VideoFeedCursor {
  const match = /^v[12]:(\d+):(\d+)$/u.exec(cursor ?? "")
  if (!match) return { offset: 0, rankedAt: now }
  const rankedAt = Number(match[1])
  const offset = Number(match[2])
  if (!Number.isSafeInteger(rankedAt) || rankedAt <= 0 || !Number.isSafeInteger(offset) || offset < 0) {
    return { offset: 0, rankedAt: now }
  }
  return { offset, rankedAt }
}

export function resolveVideoFeedBestRankingMode(
  mode: string | null | undefined,
): "legacy" | "scorer" {
  return mode?.trim().toLowerCase() === "legacy" ? "legacy" : "scorer"
}

function videoFeedProjectionKey(row: HomeFeedProjectionRow): string {
  return `${row.community_id}\u0000${row.source_post_id}`
}

export function mergeVideoFeedCandidateRows(
  engagementRows: readonly HomeFeedProjectionRow[],
  recentRows: readonly HomeFeedProjectionRow[],
): HomeFeedProjectionRow[] {
  const merged = new Map<string, HomeFeedProjectionRow>()
  for (const row of [...engagementRows, ...recentRows]) {
    const key = videoFeedProjectionKey(row)
    if (!merged.has(key)) merged.set(key, row)
  }
  return [...merged.values()]
}

function toVideoCandidateInput(row: HomeFeedProjectionRow): VideoCandidateInput {
  return {
    authorUserId: row.identity_mode === "anonymous" ? null : row.author_user_id ?? null,
    comments: row.comment_count,
    communityId: row.community_id,
    createdAtMs: getProjectionCreatedAtMs(row),
    downvotes: row.downvote_count,
    // Duration is not a first-class projection column. Phase 1 priors are
    // intentionally identical across duration buckets, so absence is neutral.
    durationSeconds: null,
    likes: row.like_count,
    postId: row.source_post_id,
    stats: null,
    upvotes: row.upvote_count,
  }
}

export function selectBestVideoFeedProjectionPage(input: {
  cursor: VideoFeedCursor
  priorRows?: readonly HomeFeedProjectionRow[]
  pageSize?: number
  rows: readonly HomeFeedProjectionRow[]
}): { hasMore: boolean; nextOffset: number; rows: HomeFeedProjectionRow[] } {
  return sliceBestVideoFeedProjectionDeck({
    cursor: input.cursor,
    orderedRows: orderBestVideoFeedProjectionRows(input.rows, input.cursor.rankedAt),
    priorRows: input.priorRows,
    pageSize: input.pageSize,
  })
}

function orderBestVideoFeedProjectionRows(
  rows: readonly HomeFeedProjectionRow[],
  rankedAt: number,
): HomeFeedProjectionRow[] {
  const rowByKey = new Map(rows.map((row) => [videoFeedProjectionKey(row), row] as const))
  const remaining = scoreVideoCandidates(rows.map(toVideoCandidateInput), rankedAt)
  const ordered: ScoredVideoCandidate[] = []
  while (remaining.length > 0) {
    const policyPage = takeVideoFeedPage(remaining, VIDEO_FEED_PAGE_SIZE)
    if (policyPage.length === 0) break
    ordered.push(...policyPage)
  }
  return ordered
    .map((item) => rowByKey.get(`${item.candidate.communityId}\u0000${item.candidate.postId}`))
    .filter((row): row is HomeFeedProjectionRow => Boolean(row))
}

function sliceBestVideoFeedProjectionDeck(input: {
  cursor: VideoFeedCursor
  orderedRows: readonly HomeFeedProjectionRow[]
  priorRows?: readonly HomeFeedProjectionRow[]
  pageSize?: number
}): { hasMore: boolean; nextOffset: number; rows: HomeFeedProjectionRow[] } {
  const pageSize = Math.max(1, Math.min(VIDEO_FEED_PAGE_SIZE, input.pageSize ?? VIDEO_FEED_PAGE_SIZE))
  // The deck is already partitioned by takeVideoFeedPage, which defers
  // cap-rejected candidates into later policy pages. Reapplying caps during
  // ordinary cursor pagination would advance past those deferred rows and make
  // them permanently unreachable. A second cap pass is needed only when
  // hydration backfill crosses a policy-page seam inside one delivered page.
  if (!input.priorRows?.length) {
    const rows = input.orderedRows.slice(input.cursor.offset, input.cursor.offset + pageSize)
    const nextOffset = input.cursor.offset + rows.length
    return {
      hasMore: nextOffset < input.orderedRows.length,
      nextOffset,
      rows,
    }
  }
  const authorCounts = new Map<string, number>()
  const communityCounts = new Map<string, number>()
  const countRow = (row: HomeFeedProjectionRow): void => {
    communityCounts.set(row.community_id, (communityCounts.get(row.community_id) ?? 0) + 1)
    if (row.identity_mode !== "anonymous" && row.author_user_id) {
      authorCounts.set(row.author_user_id, (authorCounts.get(row.author_user_id) ?? 0) + 1)
    }
  }
  for (const row of input.priorRows ?? []) countRow(row)

  const selected: HomeFeedProjectionRow[] = []
  let nextOffset = input.cursor.offset
  while (nextOffset < input.orderedRows.length && selected.length < pageSize) {
    const row = input.orderedRows[nextOffset]
    nextOffset += 1
    if (!row) continue
    if ((communityCounts.get(row.community_id) ?? 0) >= COMMUNITY_CAP_PER_PAGE) continue
    if (
      row.identity_mode !== "anonymous"
      && row.author_user_id
      && (authorCounts.get(row.author_user_id) ?? 0) >= AUTHOR_CAP_PER_PAGE
    ) continue
    selected.push(row)
    countRow(row)
  }
  return {
    hasMore: nextOffset < input.orderedRows.length,
    nextOffset,
    rows: selected,
  }
}

export function videoFeedOrderSql(sort: HomeFeedSort): string {
  const score = "((upvote_count - downvote_count) * 3 + comment_count * 2 + like_count)"
  if (sort === "new") return "source_created_at DESC, source_post_id DESC"
  if (sort === "top" || sort === "best") {
    // The control-plane D1 runtime rejects the date-arithmetic ranking
    // expression used here previously. The engagement ordering is already
    // proven on that runtime and remains deterministic until best ranking is
    // moved to a tested projection/runtime implementation.
    return `CASE WHEN ${score} > 0 THEN 1 ELSE 0 END DESC, ${score} DESC, source_created_at DESC, source_post_id DESC`
  }
  return "source_created_at DESC, source_post_id DESC"
}

/**
 * Cursors are logged by shape, never by value. These records are emitted for every
 * request, and cursors are opaque tokens that will carry generation/seed/policy
 * state once ranking lands — the version prefix is all latency analysis needs.
 */
function cursorVersionLabel(cursor: string | null | undefined): string | null {
  if (!cursor) return null
  const prefix = cursor.split(":", 1)[0] ?? ""
  return /^[a-z0-9]{1,8}$/u.test(prefix) ? prefix : "unknown"
}

async function listVideoHomeFeedProjectionRows(input: {
  communityIds: string[]
  cursor?: string | null
  env: Env
  includeProjectedPayload?: boolean
  now: number
  pageSize?: number
  sort: HomeFeedSort
  timeRange: HomeFeedTimeRange
}): Promise<VideoFeedProjectionPage> {
  const cursor = parseVideoFeedCursor(input.cursor, input.now)
  const pageSize = Math.max(1, Math.min(VIDEO_FEED_PAGE_SIZE, input.pageSize ?? VIDEO_FEED_PAGE_SIZE))
  const args: Array<string | number> = [...input.communityIds]
  const communityPlaceholders = input.communityIds.map((_, index) => `?${index + 1}`).join(", ")
  const cutoffMs = getTimeRangeCutoffMs(input.timeRange, cursor.rankedAt)
  const filters = [
    "projection_version = 1",
    "status = 'published'",
    "post_type = 'video'",
    `community_id IN (${communityPlaceholders})`,
  ]
  if (cutoffMs != null) {
    args.push(new Date(cutoffMs).toISOString())
    filters.push(`source_created_at >= ?${args.length}`)
  }
  args.push(pageSize + 1, cursor.offset)
  const limitPlaceholder = `?${args.length - 1}`
  const offsetPlaceholder = `?${args.length}`
  const projectedPayloadColumns = input.includeProjectedPayload
    ? ", author_user_id, identity_mode, projected_payload_json"
    : ""
  const result = await getControlPlaneClient(input.env).execute({
    sql: `
      SELECT community_id, source_post_id, source_created_at, visibility, post_type${projectedPayloadColumns},
             upvote_count, downvote_count, comment_count, like_count
      FROM community_post_projections
      WHERE ${filters.join("\n        AND ")}
      ORDER BY ${videoFeedOrderSql(input.sort)}
      LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}
    `,
    args,
  })
  const rows = result.rows.map((row) => toHomeFeedProjectionRow(row))
  const hasMore = rows.length > pageSize
  return {
    allowHydrationBackfill: true,
    rows: rows.slice(0, pageSize),
    nextCursor: hasMore ? `v1:${cursor.rankedAt}:${cursor.offset + pageSize}` : null,
  }
}

async function listBestVideoHomeFeedProjectionRows(input: {
  communityIds: string[]
  cursor?: string | null
  env: Env
  includeProjectedPayload?: boolean
  memberCommunityIdSet: Set<string>
  now: number
  orderedRows?: readonly HomeFeedProjectionRow[]
  priorRows?: readonly HomeFeedProjectionRow[]
  pageSize?: number
  timeRange: HomeFeedTimeRange
}): Promise<VideoFeedProjectionPage> {
  const cursor = parseVideoFeedCursor(input.cursor, input.now)
  if (input.orderedRows) {
    const selected = sliceBestVideoFeedProjectionDeck({
      cursor,
      orderedRows: input.orderedRows,
      priorRows: input.priorRows,
      pageSize: input.pageSize,
    })
    return {
      allowHydrationBackfill: true,
      bestOrderedRows: input.orderedRows,
      rows: selected.rows,
      nextCursor: selected.hasMore
        ? `v2:${cursor.rankedAt}:${selected.nextOffset}`
        : null,
    }
  }
  const args: Array<string | number> = [...input.communityIds]
  const communityPlaceholders = input.communityIds.map((_, index) => `?${index + 1}`).join(", ")
  const cutoffMs = getTimeRangeCutoffMs(input.timeRange, cursor.rankedAt)
  const filters = [
    "projection_version = 1",
    "status = 'published'",
    "post_type = 'video'",
    `community_id IN (${communityPlaceholders})`,
  ]
  const memberCommunityIds = input.communityIds.filter((communityId) => input.memberCommunityIdSet.has(communityId))
  if (memberCommunityIds.length === 0) {
    filters.push("visibility = 'public'")
  } else {
    const memberPlaceholders: string[] = []
    for (const communityId of memberCommunityIds) {
      args.push(communityId)
      memberPlaceholders.push(`?${args.length}`)
    }
    filters.push(`(visibility = 'public' OR community_id IN (${memberPlaceholders.join(", ")}))`)
  }
  if (cutoffMs != null) {
    args.push(new Date(cutoffMs).toISOString())
    filters.push(`source_created_at >= ?${args.length}`)
  }
  args.push(VIDEO_FEED_CANDIDATES_PER_LEG)
  const limitPlaceholder = `?${args.length}`
  const projectedPayloadColumn = input.includeProjectedPayload ? ", projected_payload_json" : ""
  const columns = `community_id, source_post_id, author_user_id, identity_mode, source_created_at, visibility, post_type${projectedPayloadColumn},
             upvote_count, downvote_count, comment_count, like_count`
  const client = getControlPlaneClient(input.env)
  const executeLeg = (orderBy: string) => client.execute({
    sql: `
      SELECT ${columns}
      FROM community_post_projections
      WHERE ${filters.join("\n        AND ")}
      ORDER BY ${orderBy}
      LIMIT ${limitPlaceholder}
    `,
    args,
  })
  // Keep the queries portable and independently indexable. A UNION would put
  // this hot path back inside the Postgres/D1 dialect intersection that caused
  // the old freshness expression to be removed.
  const engagementResult = await executeLeg(videoFeedOrderSql("top"))
  const recentResult = await executeLeg(videoFeedOrderSql("new"))
  const candidates = filterVisibleHomeFeedProjections(
    mergeVideoFeedCandidateRows(
      engagementResult.rows.map(toHomeFeedProjectionRow),
      recentResult.rows.map(toHomeFeedProjectionRow),
    ),
    input.memberCommunityIdSet,
  )
  const orderedRows = orderBestVideoFeedProjectionRows(candidates, cursor.rankedAt)
  const selected = sliceBestVideoFeedProjectionDeck({
    cursor,
    orderedRows,
    priorRows: input.priorRows,
    pageSize: input.pageSize,
  })
  return {
    allowHydrationBackfill: true,
    bestOrderedRows: orderedRows,
    rows: selected.rows,
    nextCursor: selected.hasMore
      ? `v2:${cursor.rankedAt}:${selected.nextOffset}`
      : null,
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
  community: CommunityRow | null,
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

export function resolveHomeFeedCandidateCommunityIds(input: {
  activeCommunities: CommunityRow[]
  followRows: CommunityFollowProjectionRow[]
  membershipRows: CommunityMembershipProjectionRow[]
  userId: string | null
  override?: readonly string[]
}): string[] {
  return input.override
    ? [...new Set(input.override)]
    : resolveHomeFeedCommunityIds(input)
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

    if (sort === "top") {
      const leftHasEngagement = getProjectionEngagementScore(left) > 0
      const rightHasEngagement = getProjectionEngagementScore(right) > 0
      if (leftHasEngagement !== rightHasEngagement) {
        return rightHasEngagement ? 1 : -1
      }

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
      SELECT community_id, source_post_id, source_created_at, visibility,
             upvote_count, downvote_count, comment_count, like_count
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

async function decorateItemsWithBookingDiscovery(input: {
  env: Env
  items: HomeFeedItem[]
  waitUntil?: HomeFeedWaitUntil
}): Promise<HomeFeedItem[]> {
  return decorateHomeFeedItemsWithBookings({
    items: input.items,
    lookup: async (hostUserIds) => {
      const discovery = await listFeedBookingDiscoveryByHostUserIds(
        getControlPlaneClient(input.env),
        hostUserIds,
      )
      const bookingByHost = discovery.bookingByHostUserId
      const missingSnapshotHostIds = hostUserIds.filter((hostUserId) => !bookingByHost.has(hostUserId))
      const refreshHostUserIds = [...new Set([
        ...missingSnapshotHostIds,
        ...discovery.staleHostUserIds,
      ])]
      if (input.waitUntil && refreshHostUserIds.length > 0) {
        input.waitUntil(
          refreshBookingFeedDiscoverySnapshotsInBackground(input.env, refreshHostUserIds)
            .catch((error: unknown) => {
              console.error("[home-feed] booking discovery snapshot refresh failed", error)
            }),
        )
      }
      return bookingByHost
    },
  })
}

/**
 * Booking discovery is a volatile host projection and must not be frozen inside the longer-lived
 * materialized public feed body. Strip cached booking blocks first so an unpublished/unavailable
 * host fails closed, then reapply the current discovery snapshot at read time.
 */
export async function refreshMaterializedHomeFeedBookings(input: {
  env: Env
  lookup?: FeedBookingLookup
  result: HomeFeedResponseWithTiming
  waitUntil?: HomeFeedWaitUntil
}): Promise<HomeFeedResponseWithTiming> {
  const undecoratedItems = input.result.items.map((item) => {
    const { booking: _cachedBooking, ...undecoratedItem } = item
    return undecoratedItem
  })
  input.result.items = input.lookup
    ? await decorateHomeFeedItemsWithBookings({
        items: undecoratedItems,
        lookup: input.lookup,
      })
    : await decorateItemsWithBookingDiscovery({
        env: input.env,
        items: undecoratedItems,
        waitUntil: input.waitUntil,
      })
  return input.result
}

export async function listHomeFeed(input: {
  env: Env
  userId: string | null
  /**
   * Operator-only candidate scope used by the staging benchmark route.
   * Never populate this from the public feed query string.
   */
  communityIdsOverride?: readonly string[]
  locale?: string | null
  studyTimezone?: string
  sort?: string | null
  timeRange?: string | null
  cursor?: string | null
  communityRepository: HomeFeedCommunityRepository
  userRepository?: UserRepository | null
  profileRepository?: ProfileRepository | null
  waitUntil?: HomeFeedWaitUntil
  contentKind?: "video" | null
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
  const communityIds = resolveHomeFeedCandidateCommunityIds({
    activeCommunities,
    followRows,
    membershipRows,
    userId: input.userId,
    override: input.communityIdsOverride,
  })

  if (communityIds.length === 0) {
    phaseTimings.resolve_communities_ms = elapsedMs(phaseStartedAt)
    const totalMs = elapsedMs(requestStartedAt)
    console.info("[home-feed] timing", JSON.stringify({
      build_sha: input.env.BUILD_GIT_SHA ?? null,
      total_ms: totalMs,
      authenticated: Boolean(input.userId),
      locale: input.locale ?? null,
      sort: input.sort ?? null,
      time_range: input.timeRange ?? null,
      has_cursor: Boolean(input.cursor),
      cursor_version: cursorVersionLabel(input.cursor),
      active_communities: activeCommunities.length,
      candidate_communities: 0,
      projection_rows: 0,
      page_rows: 0,
      returned_items: 0,
      top_communities: 0,
      degraded_profile_slices: 0,
      phases: phaseTimings,
      slow_communities: [],
    }))
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
  const activeCommunityById = new Map(activeCommunities.map((community) => [community.community_id, community] as const))
  const communitySummaries = communityIds
    .map((communityId) => buildCommunitySummary(activeCommunityById.get(communityId) ?? null, communityViewCounts))
    .filter((summary): summary is InternalHomeFeedCommunitySummary => Boolean(summary))
  phaseTimings.community_summaries_ms = elapsedMs(phaseStartedAt)

  phaseStartedAt = performance.now()
  const sort = parseHomeFeedSort(input.sort)
  const now = Date.now()
  const timeRange = parseHomeFeedTimeRange(input.timeRange)
  const shadowControlPlane = shouldShadowAuthenticatedVideoFeed({
    contentKind: input.contentKind,
    mode: input.env.AUTHENTICATED_VIDEO_FEED_CONTROL_PLANE_MODE,
    userId: input.userId,
  })
  const useBestVideoScorer = sort === "best"
    && resolveVideoFeedBestRankingMode(input.env.VIDEO_FEED_BEST_RANKING_MODE) === "scorer"
  let videoPage = input.contentKind === "video"
    ? useBestVideoScorer
      ? await listBestVideoHomeFeedProjectionRows({
          communityIds,
          cursor: input.cursor,
          env: input.env,
          includeProjectedPayload: shadowControlPlane,
          memberCommunityIdSet,
          now,
          timeRange,
        })
      : await listVideoHomeFeedProjectionRows({
          communityIds,
          cursor: input.cursor,
          env: input.env,
          includeProjectedPayload: shadowControlPlane,
          now,
          sort,
          timeRange,
        })
    : null
  let allRows = filterVisibleHomeFeedProjections(
    videoPage?.rows ?? await listHomeFeedProjectionRows({
      env: input.env,
      communityIds,
    }),
    memberCommunityIdSet,
  )

  const cutoffMs = getTimeRangeCutoffMs(timeRange, now)
  const timeFilteredRows = videoPage
    ? allRows
    : cutoffMs != null
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

  const offset = videoPage ? 0 : parseOffsetCursor(input.cursor)
  let pageRows = videoPage ? allRows : sortedRows.slice(offset, offset + VIDEO_FEED_PAGE_SIZE)
  let nextCursor = videoPage?.nextCursor ?? (offset + VIDEO_FEED_PAGE_SIZE < sortedRows.length ? `o:${offset + VIDEO_FEED_PAGE_SIZE}` : null)
  phaseTimings.projections_and_rank_ms = elapsedMs(phaseStartedAt)

  const communityIdentityById = new Map<string, HomeFeedCommunityIdentity | null>()
  const communityTimings: HomeFeedCommunityTiming[] = []

  phaseStartedAt = performance.now()
  const hydrateRows = async (
    rowsToHydrate: HomeFeedProjectionRow[],
  ): Promise<{ items: HomeFeedItem[]; rows: HomeFeedProjectionRow[] }> => {
    const rowsByCommunityId = new Map<string, HomeFeedProjectionRow[]>()
    for (const row of rowsToHydrate) {
      const rows = rowsByCommunityId.get(row.community_id) ?? []
      rows.push(row)
      rowsByCommunityId.set(row.community_id, rows)
    }
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
        studyTimezone: input.studyTimezone,
        locale: input.locale,
        ageGateState,
        waitUntil: input.waitUntil,
      })
      communityIdentityById.set(communityId, result.identity)
      communityTimings.push(result.timing)
      return { communityId, items: result.items }
    })
    const itemByProjectionKey = new Map<string, HomeFeedItem>()
    for (const group of communityItemGroups) {
      for (const item of group.items) {
        const postId = item.post.post.id.replace(/^post_/, "")
        itemByProjectionKey.set(`${group.communityId}\u0000${postId}`, item)
      }
    }
    const hydrated = rowsToHydrate
      .map((row) => ({ item: itemByProjectionKey.get(videoFeedProjectionKey(row)), row }))
      .filter((entry): entry is { item: HomeFeedItem; row: HomeFeedProjectionRow } => Boolean(entry.item))
      .filter(({ item }) => input.contentKind !== "video" || item.post.post.media_refs?.some((media) => Boolean(media.storage_ref?.trim())))
    return {
      items: hydrated.map(({ item }) => item),
      rows: hydrated.map(({ row }) => row),
    }
  }
  const initiallyHydrated = await hydrateRows(pageRows)
  let orderedItems = initiallyHydrated.items
  let deliveredVideoRows = initiallyHydrated.rows

  if (videoPage?.allowHydrationBackfill) {
    let candidatesScanned = videoPage.rows.length
    while (
      orderedItems.length < VIDEO_FEED_PAGE_SIZE
      && videoPage.nextCursor
      && candidatesScanned < VIDEO_FEED_MAX_CANDIDATES_SCANNED
    ) {
      const nextPageSize = nextVideoFeedBackfillBatchSize({
        candidatesScanned,
        returnedItems: orderedItems.length,
      })
      videoPage = useBestVideoScorer
        ? await listBestVideoHomeFeedProjectionRows({
            communityIds,
            cursor: videoPage.nextCursor,
            env: input.env,
            includeProjectedPayload: shadowControlPlane,
            memberCommunityIdSet,
            now,
            orderedRows: videoPage.bestOrderedRows,
            priorRows: deliveredVideoRows,
            pageSize: nextPageSize,
            timeRange,
          })
        : await listVideoHomeFeedProjectionRows({
            communityIds,
            cursor: videoPage.nextCursor,
            env: input.env,
            includeProjectedPayload: shadowControlPlane,
            now,
            pageSize: nextPageSize,
            sort,
            timeRange,
          })
      const nextRows = filterVisibleHomeFeedProjections(videoPage.rows, memberCommunityIdSet)
      candidatesScanned += videoPage.rows.length
      allRows = [...allRows, ...nextRows]
      pageRows = [...pageRows, ...nextRows]
      const backfillHydrated = await hydrateRows(nextRows)
      orderedItems = [...orderedItems, ...backfillHydrated.items].slice(0, VIDEO_FEED_PAGE_SIZE)
      deliveredVideoRows = [...deliveredVideoRows, ...backfillHydrated.rows].slice(0, VIDEO_FEED_PAGE_SIZE)
    }
    nextCursor = videoPage.nextCursor
  }
  phaseTimings.community_fanout_ms = elapsedMs(phaseStartedAt)
  phaseTimings.order_items_ms = 0

  if (shadowControlPlane) {
    phaseStartedAt = performance.now()
    const shadowResult = compareProjectedVideoFeedRows({
      hydratedItems: orderedItems,
      rows: pageRows,
    })
    phaseTimings.control_plane_shadow_ms = elapsedMs(phaseStartedAt)
    console.info("[home-feed] control-plane shadow", JSON.stringify(shadowResult))
  }

  phaseStartedAt = performance.now()
  const bookingDecoratedItems = await decorateItemsWithBookingDiscovery({
    env: input.env,
    items: orderedItems,
    waitUntil: input.waitUntil,
  })
  phaseTimings.booking_discovery_ms = elapsedMs(phaseStartedAt)

  phaseStartedAt = performance.now()
  const topCommunities = input.contentKind === "video"
    ? []
    : await resolveTopCommunitiesIdentity({
        env: input.env,
        communityRepository: input.communityRepository,
        summaries: sortCommunitySummariesByViews(communitiesWithPosts).slice(0, 6),
        cachedIdentityByCommunityId: communityIdentityById,
      })
  phaseTimings.top_communities_ms = elapsedMs(phaseStartedAt)
  const totalMs = elapsedMs(requestStartedAt)
  console.info("[home-feed] timing", JSON.stringify({
    build_sha: input.env.BUILD_GIT_SHA ?? null,
    total_ms: totalMs,
    authenticated: Boolean(input.userId),
    locale: input.locale ?? null,
    sort: input.sort ?? null,
    parsed_sort: sort,
    time_range: input.timeRange ?? null,
    has_cursor: Boolean(input.cursor),
    cursor_version: cursorVersionLabel(input.cursor),
    active_communities: activeCommunities.length,
    candidate_communities: communityIds.length,
    projection_rows: allRows.length,
    time_filtered_rows: timeFilteredRows.length,
    page_rows: pageRows.length,
    page_communities: new Set(pageRows.map((row) => row.community_id)).size,
    returned_items: bookingDecoratedItems.length,
    top_communities: topCommunities.length,
    degraded_profile_slices: communityTimings.filter((timing) => timing.derivative_profiles_degraded).length,
    phases: phaseTimings,
    slow_communities: summarizeCommunityTimings(communityTimings),
  }))

  return withHomeFeedServerTiming({
    items: bookingDecoratedItems,
    top_communities: topCommunities.map(serializeHomeFeedCommunitySummary),
    next_cursor: nextCursor,
  }, {
    phases: phaseTimings,
    totalMs,
  })
}
