import { executeFirst } from "../db-helpers"
import { openCommunityDb } from "../communities/community-db-factory"
import type { Client } from "../sql-client"
import type { CommunityRepository } from "../communities/db-community-repository"
import { getLatestThreadSnapshotForRead } from "../comments/community-comment-store"
import { buildLocalizedPostResponse } from "../localization/post-localization-service"
import { getPostById } from "../posts/community-post-store"
import { getControlPlaneClient } from "../runtime-deps"
import { requiredNumber, requiredString, rowValue, numberOrNull } from "../sql-row"
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
  upvote_count: number
  downvote_count: number
  comment_count: number
  like_count: number
}

function parseHomeFeedSort(sort: string | null | undefined): HomeFeedSort {
  return sort === "new" || sort === "top" ? sort : "best"
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
    upvote_count: requiredNumber(row, "upvote_count"),
    downvote_count: requiredNumber(row, "downvote_count"),
    comment_count: requiredNumber(row, "comment_count"),
    like_count: requiredNumber(row, "like_count"),
  }
}

async function getViewerVote(input: {
  client: Client
  postId: string
  userId: string
}): Promise<-1 | 1 | null> {
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

function buildCommunitySummary(community: Awaited<ReturnType<CommunityRepository["getCommunityById"]>>): HomeFeedCommunitySummary | null {
  if (!community) {
    return null
  }
  return {
    community_id: community.community_id,
    display_name: community.display_name,
    route_slug: community.route_slug,
    avatar_ref: null,
    member_count: null,
    updated_at: community.updated_at,
  }
}

export async function listHomeFeed(input: {
  env: Env
  userId: string
  locale?: string | null
  sort?: string | null
  cursor?: string | null
  communityRepository: CommunityRepository
}): Promise<HomeFeedResponse> {
  const membershipRows = await input.communityRepository.listCommunityMembershipProjectionsByUserId(input.userId)
  const activeCommunities = await input.communityRepository.listActiveCommunities()
  const memberCommunityIds = new Set(
    membershipRows
      .filter((row) => row.membership_state === "member")
      .map((row) => row.community_id),
  )
  for (const community of activeCommunities) {
    if (community.creator_user_id === input.userId) {
      memberCommunityIds.add(community.community_id)
    }
  }

  if (memberCommunityIds.size === 0) {
    return {
      items: [],
      top_communities: [],
      next_cursor: null,
    }
  }

  const communityIds = [...memberCommunityIds]
  const communitySummaries = (
    await Promise.all(communityIds.map(async (communityId) => buildCommunitySummary(
      await input.communityRepository.getCommunityById(communityId),
    )))
  )
    .filter((summary): summary is HomeFeedCommunitySummary => Boolean(summary))
    .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at))

  const controlPlaneClient = getControlPlaneClient(input.env)
  const placeholders = communityIds.map((_, index) => `?${index + 1}`).join(", ")
  const projectionResult = await controlPlaneClient.execute({
    sql: `
      SELECT community_id, source_post_id, source_created_at, upvote_count, downvote_count, comment_count, like_count
      FROM community_post_projections
      WHERE projection_version = 1
        AND status = 'published'
        AND community_id IN (${placeholders})
    `,
    args: communityIds,
  })

  const sort = parseHomeFeedSort(input.sort)
  const now = Date.now()
  const sortedRows = projectionResult.rows
    .map((row) => toHomeFeedProjectionRow(row))
    .sort((left, right) => {
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
  const communitySummaryById = Object.fromEntries(
    communitySummaries.map((summary) => [summary.community_id, summary] as const),
  )

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
      for (const row of rows) {
        const post = await getPostById(db.client, row.source_post_id)
        if (!post || post.status !== "published") {
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
            like_count: row.like_count,
            viewer_vote: viewerVote,
          },
        })
        const community = communitySummaryById[communityId]
        if (!community) {
          continue
        }
        items.push({
          community,
          post: localized,
        })
      }
    } finally {
      db.close()
    }
  }

  const itemByPostId = Object.fromEntries(items.map((item) => [item.post.post.post_id, item] as const))
  const orderedItems = pageRows
    .map((row) => itemByPostId[row.source_post_id])
    .filter((item): item is HomeFeedItem => Boolean(item))

  return {
    items: orderedItems,
    top_communities: communitySummaries.slice(0, 6),
    next_cursor: nextCursor,
  }
}
