import { executeFirst } from "../db-helpers"
import type { DbExecutor } from "../db-helpers"
import { numberOrNull, requiredNumber, rowValue } from "../sql-row"

export async function getPostProjectionMetrics(
  executor: DbExecutor,
  postId: string,
): Promise<{
  upvoteCount: number
  downvoteCount: number
  commentCount: number
  likeCount: number
}> {
  const row = await executeFirst(executor, {
    sql: `
      SELECT
        (
          SELECT COUNT(*)
          FROM post_votes
          WHERE post_id = ?1
            AND vote_value = 1
        ) AS upvote_count,
        (
          SELECT COUNT(*)
          FROM post_votes
          WHERE post_id = ?1
            AND vote_value = -1
        ) AS downvote_count,
        (
          SELECT COUNT(*)
          FROM comments
          WHERE thread_root_post_id = ?1
            AND status = 'published'
        ) AS comment_count,
        (
          SELECT COUNT(*)
          FROM post_reactions
          WHERE post_id = ?1
            AND reaction_key = 'like'
        ) AS like_count
    `,
    args: [postId],
  })

  return {
    upvoteCount: requiredNumber(row, "upvote_count"),
    downvoteCount: requiredNumber(row, "downvote_count"),
    commentCount: requiredNumber(row, "comment_count"),
    likeCount: requiredNumber(row, "like_count"),
  }
}

export async function getPostReadMetrics(input: {
  executor: DbExecutor
  postId: string
  viewerUserId?: string | null
}): Promise<{
  upvote_count: number
  downvote_count: number
  comment_count: number
  like_count: number
  viewer_vote: -1 | 1 | null
}> {
  const row = await executeFirst(input.executor, {
    sql: `
      SELECT
        (
          SELECT COUNT(*)
          FROM post_votes
          WHERE post_id = ?1
            AND vote_value = 1
        ) AS upvote_count,
        (
          SELECT COUNT(*)
          FROM post_votes
          WHERE post_id = ?1
            AND vote_value = -1
        ) AS downvote_count,
        (
          SELECT COUNT(*)
          FROM comments
          WHERE thread_root_post_id = ?1
            AND status = 'published'
        ) AS comment_count,
        (
          SELECT COUNT(*)
          FROM post_reactions
          WHERE post_id = ?1
            AND reaction_key = 'like'
        ) AS like_count,
        (
          SELECT vote_value
          FROM post_votes
          WHERE post_id = ?1
            AND user_id = ?2
          LIMIT 1
        ) AS viewer_vote
    `,
    args: [input.postId, input.viewerUserId ?? ""],
  })

  return {
    upvote_count: requiredNumber(row, "upvote_count"),
    downvote_count: requiredNumber(row, "downvote_count"),
    comment_count: requiredNumber(row, "comment_count"),
    like_count: requiredNumber(row, "like_count"),
    viewer_vote: numberOrNull(rowValue(row, "viewer_vote")) as -1 | 1 | null,
  }
}
