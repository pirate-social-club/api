import { executeFirst } from "../db-helpers"
import { openCommunityDb } from "../communities/community-db-factory"
import type { Client } from "../sql-client"
import type {
  CommunityDatabaseBindingRepository,
  CommunityMembershipProjectionRepository,
  CommunityReadRepository,
} from "../communities/db-community-repository"
import { getLatestThreadSnapshotForRead } from "../comments/community-comment-store"
import { buildLocalizedPostResponse } from "../localization/post-localization-service"
import { enqueueEmbedHydrateOnReadIfNeeded, enqueuePostTranslationOnReadIfNeeded } from "../posts/post-jobs"
import { getPostById } from "../posts/community-post-store"
import { getControlPlaneClient } from "../runtime-deps"
import { numberOrNull, requiredNumber, requiredString, rowValue } from "../sql-row"
import { serializeLocalizedPostResponse } from "../../serializers/post"
import type { CommunityFollowProjectionRow, CommunityMembershipProjectionRow, CommunityRow } from "../auth/auth-db-rows"
import { resolveCommunityAvatarRef } from "../communities/community-identity-media"
import { resolveAgeGateViewerState } from "../posts/age-gate-viewer-state"
import type { UserRepository } from "../auth/repositories"
import type {
  Env,
  HomeFeedCommunitySummary,
  HomeFeedItem,
  HomeFeedResponse,
  HomeFeedSort,
} from "../../types"

type HomeFeedProjectionRow = {
  community_id: string
  source_post_id: string
  source_created_at: string
  visibility: "public" | "members_only"
  upvote_count: number
  downvote_count: number
  comment_count: number
  like_count: number
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

function getProjectionScore(row: HomeFeedProjectionRow): number {
  return row.upvote_count - row.downvote_count
}

function getProjectionCreatedAtMs(row: HomeFeedProjectionRow): number {
  const timestamp = Date.parse(row.source_created_at)
  return Number.isNaN(timestamp) ? 0 : timestamp
}

function getBestProjectionRank(row: HomeFeedProjectionRow, now: number): number {
  const ageHours = Math.max(0, (now - getProjectionCreatedAtMs(row)) / 3_600_000)
  return getProjectionScore(row) / Math.pow(ageHours + 2, 1.5)
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

async function getViewerVote(input: {
  client: Client
  postId: string
  userId: string | null
}): Promise<-1 | 1 | null> {
  if (!input.userId) {
    return null
  }

  const row = await executeFirst(input.client, {
    sql: `
      SELECT vote_value
      FROM post_votes
      WHERE post_id = ?1
        AND user_id = ?2
      LIMIT 1
    `,
    args: [input.postId, input.userId],
  })
  return numberOrNull(rowValue(row, "vote_value")) as -1 | 1 | null
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
): Promise<InternalHomeFeedCommunitySummary[]> {
  const resolved = await Promise.all(
    summaries.map(async (summary) => {
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
  const result = await controlPlaneClient.execute({
    sql: `
      SELECT community_id, total_views
      FROM community_health_counts
      WHERE community_id IN (${placeholders})
    `,
    args: input.communityIds,
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
}): Promise<HomeFeedResponse> {
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
    return {
      items: [],
      top_communities: [],
      next_cursor: null,
    }
  }

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
    const rowScore = getProjectionScore(row)
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

  const sortedCommunities = sortCommunitySummaries(communitiesWithPosts, communityAggregateById, sort)

  const sortedRows = [...timeFilteredRows].sort((left, right) => {
    if (sort === "new") {
      return getProjectionCreatedAtMs(right) - getProjectionCreatedAtMs(left)
    }
    if (sort === "top") {
      const scoreDiff = getProjectionScore(right) - getProjectionScore(left)
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

  const offset = parseOffsetCursor(input.cursor)
  const pageRows = sortedRows.slice(offset, offset + 25)
  const nextCursor = offset + 25 < sortedRows.length ? `o:${offset + 25}` : null

  const items: HomeFeedItem[] = []
  const rowsByCommunityId = new Map<string, HomeFeedProjectionRow[]>()
  for (const row of pageRows) {
    const rows = rowsByCommunityId.get(row.community_id) ?? []
    rows.push(row)
    rowsByCommunityId.set(row.community_id, rows)
  }

  for (const [communityId, rows] of rowsByCommunityId) {
    const db = await openCommunityDb(input.env, input.communityRepository, communityId)
    try {
      const baseCommunity = communitySummaryById[communityId]
      const community = baseCommunity
        ? withHomeFeedCommunityIdentity(
          baseCommunity,
          await getHomeFeedCommunityIdentity(db.client, communityId),
        )
        : null
      for (const row of rows) {
        const post = await getPostById(db.client, row.source_post_id)
        if (!post || post.status !== "published") {
          continue
        }
        if (post.visibility === "members_only" && !memberCommunityIdSet.has(communityId)) {
          continue
        }
        const threadSnapshot = await getLatestThreadSnapshotForRead(db.client, post.post_id)
        const viewerVote = await getViewerVote({
          client: db.client,
          postId: post.post_id,
          userId: input.userId,
        })
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
        await enqueuePostTranslationOnReadIfNeeded({
          client: db.client,
          communityId,
          response: localized,
        })
        await enqueueEmbedHydrateOnReadIfNeeded({
          client: db.client,
          communityId,
          post,
        })
        if (!community) {
          continue
        }
        items.push({
          community: serializeHomeFeedCommunitySummary(community),
          post: serializeLocalizedPostResponse(localized),
        })
      }
    } finally {
      db.close()
    }
  }

  const itemByPostId = Object.fromEntries(items.map((item) => [item.post.post.id.replace(/^post_/, ""), item] as const))
  const orderedItems = pageRows
    .map((row) => itemByPostId[row.source_post_id])
    .filter((item): item is HomeFeedItem => Boolean(item))

  const topCommunities = await resolveTopCommunitiesIdentity(
    input.env,
    input.communityRepository,
    sortedCommunities.slice(0, 6),
  )

  return {
    items: orderedItems,
    top_communities: topCommunities.map(serializeHomeFeedCommunitySummary),
    next_cursor: nextCursor,
  }
}
