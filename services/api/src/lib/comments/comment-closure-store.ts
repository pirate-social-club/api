import type { DbExecutor } from "../db-helpers"

export async function insertCommentClosureRows(input: {
  executor: DbExecutor
  commentId: string
  parentCommentId: string | null
}): Promise<void> {
  await input.executor.execute({
    sql: `
      INSERT INTO comment_closure (
        ancestor_comment_id, descendant_comment_id, distance
      ) VALUES (
        ?1, ?1, 0
      )
    `,
    args: [input.commentId],
  })

  if (!input.parentCommentId) {
    return
  }

  await input.executor.execute({
    sql: `
      INSERT INTO comment_closure (
        ancestor_comment_id, descendant_comment_id, distance
      )
      SELECT ancestor_comment_id, ?1, distance + 1
      FROM comment_closure
      WHERE descendant_comment_id = ?2
    `,
    args: [input.commentId, input.parentCommentId],
  })
}

export async function incrementAncestorCommentCounters(input: {
  executor: DbExecutor
  parentCommentId: string | null
  repliedAt: string
}): Promise<void> {
  if (!input.parentCommentId) {
    return
  }

  await input.executor.execute({
    sql: `
      UPDATE comments
      SET direct_reply_count = direct_reply_count + 1,
          descendant_count = descendant_count + 1,
          last_reply_at = CASE
            WHEN last_reply_at IS NULL OR last_reply_at < ?2 THEN ?2
            ELSE last_reply_at
          END,
          updated_at = CASE
            WHEN updated_at < ?2 THEN ?2
            ELSE updated_at
          END
      WHERE comment_id = ?1
    `,
    args: [input.parentCommentId, input.repliedAt],
  })

  await input.executor.execute({
    sql: `
      UPDATE comments
      SET descendant_count = descendant_count + 1,
          last_reply_at = CASE
            WHEN last_reply_at IS NULL OR last_reply_at < ?2 THEN ?2
            ELSE last_reply_at
          END,
          updated_at = CASE
            WHEN updated_at < ?2 THEN ?2
            ELSE updated_at
          END
      WHERE comment_id IN (
        SELECT ancestor_comment_id
        FROM comment_closure
        WHERE descendant_comment_id = ?1
          AND distance > 0
      )
    `,
    args: [input.parentCommentId, input.repliedAt],
  })
}

export async function incrementThreadPostCommentCounters(input: {
  executor: DbExecutor
  threadRootPostId: string
  isTopLevel: boolean
  commentedAt: string
}): Promise<void> {
  await input.executor.execute({
    sql: `
      UPDATE posts
      SET comment_count = comment_count + 1,
          top_level_comment_count = top_level_comment_count + ?2,
          last_comment_at = CASE
            WHEN last_comment_at IS NULL OR last_comment_at < ?3 THEN ?3
            ELSE last_comment_at
          END,
          updated_at = CASE
            WHEN updated_at < ?3 THEN ?3
            ELSE updated_at
          END
      WHERE post_id = ?1
    `,
    args: [input.threadRootPostId, input.isTopLevel ? 1 : 0, input.commentedAt],
  })
}
