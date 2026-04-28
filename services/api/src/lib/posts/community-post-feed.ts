import type { Client } from "../sql-client"
import { numberOrNull, requiredNumber, rowValue } from "../sql-row"
import type { Post } from "../../types"
import {
  POST_SELECT_COLUMNS,
  serializePost,
  toPostRow,
} from "./community-post-serialization"

export type PublishedLocalizedPostFeedItem = {
  post: Post
  upvote_count: number
  downvote_count: number
  comment_count: number
  like_count: number
  viewer_vote: -1 | 1 | null
}

function getFeedItemScore(item: {
  upvote_count: number
  downvote_count: number
}): number {
  return item.upvote_count - item.downvote_count
}

function getFeedItemCreatedAtMs(item: {
  post: Post
}): number {
  const timestamp = Date.parse(item.post.created_at)
  return Number.isNaN(timestamp) ? 0 : timestamp
}

function getFeedItemEngagementScore(item: Pick<PublishedLocalizedPostFeedItem, "comment_count" | "downvote_count" | "like_count" | "upvote_count">): number {
  return getFeedItemScore(item) * 3 + item.comment_count * 2 + item.like_count
}

function getFeedItemRichnessScore(item: Pick<PublishedLocalizedPostFeedItem, "post">): number {
  return (item.post.title ?? "").trim().length * 2
    + (item.post.body ?? "").trim().length
    + (item.post.caption ?? "").trim().length
    + (item.post.media_refs?.length ?? 0) * 120
}

function getBestFeedRank(item: PublishedLocalizedPostFeedItem, now: number): number {
  const ageHours = Math.max(0, (now - getFeedItemCreatedAtMs(item)) / 3_600_000)
  return (getFeedItemEngagementScore(item) + getFeedItemRichnessScore(item) * 0.05) / Math.pow(ageHours + 2, 1.5)
}

function parseOffsetCursor(cursor: string | null | undefined): number {
  if (!cursor || !cursor.startsWith("o:")) {
    return 0
  }
  const parsed = Number(cursor.slice(2))
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0
}

export async function listPublishedLocalizedPosts(input: {
  client: Client
  communityId: string
  viewerUserId: string
  limit: number
  flairId?: string | null
  sort: "best" | "new" | "top"
  cursor?: string | null
  visibility?: Post["visibility"] | null
}): Promise<{
  items: PublishedLocalizedPostFeedItem[]
  nextCursor: string | null
}> {
  const newCursorParts = input.sort === "new" && input.cursor ? input.cursor.split("|") : null
  const createdAtCursor = newCursorParts?.[0] ?? null
  const postIdCursor = newCursorParts?.[1] ?? null
  const buildFeedQuery = (postColumns: string) => ({
    sql: `
      SELECT ${postColumns},
             (
               SELECT COUNT(*)
               FROM post_votes
               WHERE post_id = posts.post_id
                 AND vote_value = 1
             ) AS upvote_count,
             (
               SELECT COUNT(*)
               FROM post_votes
               WHERE post_id = posts.post_id
                 AND vote_value = -1
             ) AS downvote_count,
             (
               SELECT COUNT(*)
               FROM post_reactions
               WHERE post_id = posts.post_id
                 AND reaction_key = 'like'
             ) AS like_count,
             (
               SELECT COUNT(*)
               FROM comments
               WHERE thread_root_post_id = posts.post_id
                 AND status = 'published'
             ) AS comment_count,
             (
               SELECT vote_value
               FROM post_votes
               WHERE post_id = posts.post_id
                 AND user_id = ?2
               LIMIT 1
             ) AS viewer_vote
      FROM posts
      WHERE community_id = ?1
        AND status = 'published'
        AND (?3 IS NULL OR label_id = ?3)
        AND (?4 IS NULL OR visibility = ?4)
        AND (
          ?5 = 0
          OR ?6 IS NULL
          OR created_at < ?6
          OR (created_at = ?6 AND post_id < ?7)
        )
      ORDER BY created_at DESC, post_id DESC
      LIMIT ?8
    `,
    args: [
      input.communityId,
      input.viewerUserId,
      input.flairId ?? null,
      input.visibility ?? null,
      input.sort === "new" ? 1 : 0,
      createdAtCursor,
      postIdCursor,
      input.sort === "new" ? input.limit + 1 : 10_000,
    ],
  })
  const result = await input.client.execute(buildFeedQuery(POST_SELECT_COLUMNS))

  const items = result.rows.map((row) => {
    return {
      post: serializePost(toPostRow(row)),
      upvote_count: requiredNumber(row, "upvote_count"),
      downvote_count: requiredNumber(row, "downvote_count"),
      comment_count: requiredNumber(row, "comment_count"),
      like_count: requiredNumber(row, "like_count"),
      viewer_vote: numberOrNull(rowValue(row, "viewer_vote")) as -1 | 1 | null,
    }
  })

  if (input.sort === "new") {
    const pageItems = items.slice(0, input.limit)
    const overflowItem = items.length > input.limit ? items[input.limit] : null
    return {
      items: pageItems,
      nextCursor: overflowItem ? `${overflowItem.post.created_at}|${overflowItem.post.post_id}` : null,
    }
  }

  const sortedItems = sortPublishedLocalizedPostFeedItems(items, input.sort)

  const offset = parseOffsetCursor(input.cursor)
  const pageItems = sortedItems.slice(offset, offset + input.limit)
  const nextCursor = offset + input.limit < sortedItems.length ? `o:${offset + input.limit}` : null

  return { items: pageItems, nextCursor }
}

export function sortPublishedLocalizedPostFeedItems(
  items: readonly PublishedLocalizedPostFeedItem[],
  sort: "best" | "new" | "top",
  now = Date.now(),
): PublishedLocalizedPostFeedItem[] {
  return [...items].sort((left, right) => {
    if (sort === "new") {
      const createdAtDiff = getFeedItemCreatedAtMs(right) - getFeedItemCreatedAtMs(left)
      if (createdAtDiff !== 0) {
        return createdAtDiff
      }
      return right.post.post_id.localeCompare(left.post.post_id)
    }

    if (sort === "top") {
      const engagementDiff = getFeedItemEngagementScore(right) - getFeedItemEngagementScore(left)
      if (engagementDiff !== 0) {
        return engagementDiff
      }

      const richnessDiff = getFeedItemRichnessScore(right) - getFeedItemRichnessScore(left)
      if (richnessDiff !== 0) {
        return richnessDiff
      }
    } else {
      const rankDiff = getBestFeedRank(right, now) - getBestFeedRank(left, now)
      if (rankDiff !== 0) {
        return rankDiff
      }

      const richnessDiff = getFeedItemRichnessScore(right) - getFeedItemRichnessScore(left)
      if (richnessDiff !== 0) {
        return richnessDiff
      }
    }

    const createdAtDiff = getFeedItemCreatedAtMs(right) - getFeedItemCreatedAtMs(left)
    if (createdAtDiff !== 0) {
      return createdAtDiff
    }
    return right.post.post_id.localeCompare(left.post.post_id)
  })
}
