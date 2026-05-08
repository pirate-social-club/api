import { isMissingRelationError, type DbExecutor } from "../db-helpers"
import { openCommunityDb } from "../communities/community-db-factory"
import type { Client } from "../sql-client"
import type {
  CommunityDatabaseBindingRepository,
  CommunityMembershipProjectionRepository,
  CommunityReadRepository,
} from "../communities/db-community-repository"
import { buildLocalizedPostResponse } from "../localization/post-localization-service"
import { enqueueEmbedHydrateOnReadIfNeeded, enqueuePostTranslationOnReadIfNeeded } from "../posts/post-jobs"
import { getControlPlaneClient, withRequestControlPlaneClients } from "../runtime-deps"
import { numberOrNull, requiredNumber, requiredString, rowValue } from "../sql-row"
import { serializeLocalizedPostResponse } from "../../serializers/post"
import { ensureCommunityHealthCountsTable, fetchTinybirdCommunityViewCounts, upsertCommunityHealthCounts } from "../analytics/community-analytics-sync"
import type { CommunityFollowProjectionRow, CommunityMembershipProjectionRow, CommunityRow } from "../auth/auth-db-rows"
import { resolveCommunityAvatarRef } from "../communities/community-identity-media"
import { resolveAgeGateViewerState } from "../posts/age-gate-viewer-state"
import {
  POST_SELECT_COLUMNS,
  serializePost,
  toPostRow,
} from "../posts/community-post-serialization"
import {
  serializeThreadSnapshot,
  toThreadSnapshotRow,
} from "../comments/community-comment-serialization"
import type { UserRepository } from "../auth/repositories"
import type {
  CommentThreadSnapshot,
  Env,
  HomeFeedCommunitySummary,
  HomeFeedItem,
  HomeFeedResponse,
  HomeFeedSort,
  Post,
} from "../../types"

export type HomeFeedProjectionRow = {
  community_id: string
  source_post_id: string
  source_created_at: string
  visibility: "public" | "members_only"
  upvote_count: number
  downvote_count: number
  comment_count: number
  like_count: number
}

type HomeFeedWaitUntil = (promise: Promise<void>) => void

type HomeFeedPostReadJob = {
  post: Post
  response: Parameters<typeof enqueuePostTranslationOnReadIfNeeded>[0]["response"]
}

export type HomeFeedCommunityIdentity = {
  displayName: string
  avatarRef: string | null
}

export type InternalHomeFeedCommunitySummary = HomeFeedCommunitySummary & {
  community_id: string
  updated_at: string
}

export type HomeFeedTimeRange = "hour" | "day" | "week" | "month" | "year" | "all"

type HomeFeedCommunityRepository =
  & CommunityReadRepository
  & CommunityDatabaseBindingRepository
  & Pick<
    CommunityMembershipProjectionRepository,
    "listCommunityMembershipProjectionsByUserId" | "listCommunityFollowProjectionsByUserId"
  >

const HOME_FEED_COMMUNITY_READ_CONCURRENCY = 4
const HOME_FEED_TIMING_LOG_THRESHOLD_MS = 1_000

type HomeFeedCommunityTiming = {
  community_id: string
  rows: number
  returned_items: number
  total_ms: number
  open_ms: number
  identity_ms: number
  posts_ms: number
  snapshots_ms: number
  votes_ms: number
  localize_ms: number
  enqueue_ms: number
}

function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt)
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

function placeholders(count: number): string {
  return Array.from({ length: count }, (_, index) => `?${index + 1}`).join(", ")
}

async function listPostsById(client: Client, postIds: string[]): Promise<Map<string, Post>> {
  if (postIds.length === 0) {
    return new Map()
  }

  const result = await client.execute({
    sql: `
      SELECT ${POST_SELECT_COLUMNS}
      FROM posts
      WHERE post_id IN (${placeholders(postIds.length)})
    `,
    args: postIds,
  })

  const postsById = new Map<string, Post>()
  for (const row of result.rows) {
    const post = serializePost(toPostRow(row))
    postsById.set(post.post_id, post)
  }
  return postsById
}

async function listLatestThreadSnapshotsForRead(
  client: Client,
  threadRootPostIds: string[],
): Promise<Map<string, CommentThreadSnapshot | null>> {
  if (threadRootPostIds.length === 0) {
    return new Map()
  }

  const result = await client.execute({
    sql: `
      SELECT thread_snapshot_id, community_id, thread_root_post_id, snapshot_seq,
             published_through_comment_created_at, comment_count, swarm_manifest_ref,
             swarm_feed_ref, created_at
      FROM thread_snapshots
      WHERE thread_root_post_id IN (${placeholders(threadRootPostIds.length)})
      ORDER BY thread_root_post_id ASC, snapshot_seq DESC, created_at DESC
    `,
    args: threadRootPostIds,
  })

  const snapshotsByPostId = new Map<string, CommentThreadSnapshot | null>()
  for (const row of result.rows) {
    const snapshot = toThreadSnapshotRow(row)
    if (!snapshotsByPostId.has(snapshot.thread_root_post_id)) {
      snapshotsByPostId.set(snapshot.thread_root_post_id, serializeThreadSnapshot(snapshot))
    }
  }
  return snapshotsByPostId
}

async function listViewerVotes(input: {
  client: Client
  postIds: string[]
  userId: string | null
}): Promise<Map<string, -1 | 1 | null>> {
  if (!input.userId || input.postIds.length === 0) {
    return new Map()
  }

  const result = await input.client.execute({
    sql: `
      SELECT post_id, vote_value
      FROM post_votes
      WHERE user_id = ?1
        AND post_id IN (${input.postIds.map((_, index) => `?${index + 2}`).join(", ")})
    `,
    args: [input.userId, ...input.postIds],
  })

  const votesByPostId = new Map<string, -1 | 1 | null>()
  for (const row of result.rows) {
    votesByPostId.set(requiredString(row, "post_id"), numberOrNull(rowValue(row, "vote_value")) as -1 | 1 | null)
  }
  return votesByPostId
}

async function enqueuePostReadJobsForCommunity(input: {
  client: DbExecutor
  communityId: string
  jobs: HomeFeedPostReadJob[]
}): Promise<void> {
  for (const job of input.jobs) {
    await enqueuePostTranslationOnReadIfNeeded({
      client: input.client,
      communityId: input.communityId,
      response: job.response,
    })
    await enqueueEmbedHydrateOnReadIfNeeded({
      client: input.client,
      communityId: input.communityId,
      post: job.post,
    })
  }
}

function enqueuePostReadJobs(input: {
  env: Env
  communityId: string
  communityRepository: HomeFeedCommunityRepository
  jobs: HomeFeedPostReadJob[]
  waitUntil?: HomeFeedWaitUntil
  fallbackClient: DbExecutor
}): Promise<void> {
  if (input.jobs.length === 0) {
    return Promise.resolve()
  }

  if (!input.waitUntil) {
    return enqueuePostReadJobsForCommunity({
      client: input.fallbackClient,
      communityId: input.communityId,
      jobs: input.jobs,
    })
  }

  input.waitUntil(withRequestControlPlaneClients(async () => {
    const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
    try {
      await enqueuePostReadJobsForCommunity({
        client: db.client,
        communityId: input.communityId,
        jobs: input.jobs,
      })
    } finally {
      db.close()
    }
  }).catch((error: unknown) => {
    console.error("[home-feed] deferred post read job enqueue failed", {
      communityId: input.communityId,
      error,
    })
  }))

  return Promise.resolve()
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

function serializeHomeFeedCommunitySummary(summary: InternalHomeFeedCommunitySummary): HomeFeedCommunitySummary {
  return {
    id: summary.id,
    object: summary.object,
    display_name: summary.display_name,
    route_slug: summary.route_slug,
    avatar_ref: summary.avatar_ref,
    member_count: summary.member_count,
    follower_count: summary.follower_count,
    view_count: summary.view_count,
  }
}

async function getHomeFeedCommunityIdentity(
  client: Client,
  communityId: string,
): Promise<HomeFeedCommunityIdentity | null> {
  const result = await client.execute({
    sql: `
      SELECT display_name, avatar_ref
      FROM communities
      WHERE community_id = ?1
      LIMIT 1
    `,
    args: [communityId],
  })
  const row = result.rows[0]
  if (!row) {
    return null
  }
  return {
    displayName: String(row.display_name),
    avatarRef: row.avatar_ref == null ? null : String(row.avatar_ref),
  }
}

export function withHomeFeedCommunityIdentity(
  summary: InternalHomeFeedCommunitySummary,
  identity: HomeFeedCommunityIdentity | null,
): InternalHomeFeedCommunitySummary {
  const displayName = identity?.displayName ?? summary.display_name
  return {
    ...summary,
    display_name: displayName,
    avatar_ref: resolveCommunityAvatarRef({
      communityId: summary.community_id,
      displayName,
      avatarRef: identity?.avatarRef,
    }),
  }
}

async function resolveTopCommunitiesIdentity(
  env: Env,
  communityRepository: HomeFeedCommunityRepository,
  summaries: InternalHomeFeedCommunitySummary[],
  cachedIdentityByCommunityId: Map<string, HomeFeedCommunityIdentity | null> = new Map(),
): Promise<InternalHomeFeedCommunitySummary[]> {
  const resolved = await Promise.all(
    summaries.map(async (summary) => {
      if (cachedIdentityByCommunityId.has(summary.community_id)) {
        return withHomeFeedCommunityIdentity(summary, cachedIdentityByCommunityId.get(summary.community_id) ?? null)
      }
      const db = await openCommunityDb(env, communityRepository, summary.community_id).catch(() => null)
      if (!db) {
        return withHomeFeedCommunityIdentity(summary, null)
      }
      try {
        const identity = await getHomeFeedCommunityIdentity(db.client, summary.community_id)
        return withHomeFeedCommunityIdentity(summary, identity)
      } finally {
        db.close()
      }
    }),
  )
  return resolved
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
  waitUntil?: HomeFeedWaitUntil
}): Promise<HomeFeedResponse> {
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
    return {
      items: [],
      top_communities: [],
      next_cursor: null,
    }
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

  const items: HomeFeedItem[] = []
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
    const communityStartedAt = performance.now()
    const openStartedAt = performance.now()
    const db = await openCommunityDb(input.env, input.communityRepository, communityId)
    const openMs = elapsedMs(openStartedAt)
    try {
      const baseCommunity = communitySummaryById[communityId]
      const identityStartedAt = performance.now()
      const identity = await getHomeFeedCommunityIdentity(db.client, communityId)
      const identityMs = elapsedMs(identityStartedAt)
      communityIdentityById.set(communityId, identity)
      const community = baseCommunity
        ? withHomeFeedCommunityIdentity(
          baseCommunity,
          identity,
        )
        : null
      const communityItems: HomeFeedItem[] = []
      const postsStartedAt = performance.now()
      const postsById = await listPostsById(db.client, rows.map((row) => row.source_post_id))
      const postsMs = elapsedMs(postsStartedAt)
      const publishedRows = rows.filter((row) => {
        const post = postsById.get(row.source_post_id)
        return post
          && post.status === "published"
          && (post.visibility !== "members_only" || memberCommunityIdSet.has(communityId))
      })
      const publishedPostIds = publishedRows.map((row) => row.source_post_id)
      const snapshotsStartedAt = performance.now()
      const threadSnapshotsByPostId = await listLatestThreadSnapshotsForRead(db.client, publishedPostIds)
      const snapshotsMs = elapsedMs(snapshotsStartedAt)
      const votesStartedAt = performance.now()
      const viewerVotesByPostId = await listViewerVotes({
        client: db.client,
        postIds: publishedPostIds,
        userId: input.userId,
      })
      const votesMs = elapsedMs(votesStartedAt)
      const postReadJobs: HomeFeedPostReadJob[] = []
      let localizeMs = 0
      for (const row of rows) {
        const post = postsById.get(row.source_post_id) ?? null
        if (!post || post.status !== "published") {
          continue
        }
        if (post.visibility === "members_only" && !memberCommunityIdSet.has(communityId)) {
          continue
        }
        const threadSnapshot = threadSnapshotsByPostId.get(post.post_id) ?? null
        const viewerVote = viewerVotesByPostId.get(post.post_id) ?? null
        const localizeStartedAt = performance.now()
        const localized = await buildLocalizedPostResponse({
          executor: db.client,
          post,
          locale: input.locale ?? undefined,
          threadSnapshot,
          metrics: {
            upvote_count: row.upvote_count,
            downvote_count: row.downvote_count,
            comment_count: row.comment_count,
            like_count: row.like_count,
            viewer_vote: viewerVote,
          },
          ageGateViewerState: post.age_gate_policy === "18_plus" ? ageGateState ?? "proof_required" : null,
          viewerUserId: input.userId,
        })
        localizeMs += elapsedMs(localizeStartedAt)
        postReadJobs.push({ post, response: localized })
        if (!community) {
          continue
        }
        communityItems.push({
          community: serializeHomeFeedCommunitySummary(community),
          post: serializeLocalizedPostResponse(localized),
        })
      }
      const enqueueStartedAt = performance.now()
      await enqueuePostReadJobs({
        env: input.env,
        communityId,
        communityRepository: input.communityRepository,
        jobs: postReadJobs,
        waitUntil: input.waitUntil,
        fallbackClient: db.client,
      })
      const enqueueMs = elapsedMs(enqueueStartedAt)
      communityTimings.push({
        community_id: communityId,
        rows: rows.length,
        returned_items: communityItems.length,
        total_ms: elapsedMs(communityStartedAt),
        open_ms: openMs,
        identity_ms: identityMs,
        posts_ms: postsMs,
        snapshots_ms: snapshotsMs,
        votes_ms: votesMs,
        localize_ms: localizeMs,
        enqueue_ms: enqueueMs,
      })
      return communityItems
    } finally {
      db.close()
    }
  })
  phaseTimings.community_fanout_ms = elapsedMs(phaseStartedAt)
  items.push(...communityItemGroups.flat())

  phaseStartedAt = performance.now()
  const itemByPostId = Object.fromEntries(items.map((item) => [item.post.post.id.replace(/^post_/, ""), item] as const))
  const orderedItems = pageRows
    .map((row) => itemByPostId[row.source_post_id])
    .filter((item): item is HomeFeedItem => Boolean(item))
  phaseTimings.order_items_ms = elapsedMs(phaseStartedAt)

  phaseStartedAt = performance.now()
  const topCommunities = await resolveTopCommunitiesIdentity(
    input.env,
    input.communityRepository,
    sortCommunitySummariesByViews(communitiesWithPosts).slice(0, 6),
    communityIdentityById,
  )
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

  return {
    items: orderedItems,
    top_communities: topCommunities.map(serializeHomeFeedCommunitySummary),
    next_cursor: nextCursor,
  }
}
