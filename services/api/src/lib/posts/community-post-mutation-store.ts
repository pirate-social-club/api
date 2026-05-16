import type { DbExecutor } from "../db-helpers"
import { internalError } from "../errors"
import type { Post } from "../../types"
import { getPostById } from "./community-post-query-store"

export async function markPostDeleted(input: {
  executor: DbExecutor
  postId: string
  now: string
}): Promise<Post> {
  await input.executor.execute({
    sql: `
      UPDATE posts
      SET status = 'deleted',
          updated_at = ?2
      WHERE post_id = ?1
    `,
    args: [input.postId, input.now],
  })

  const updated = await getPostById(input.executor, input.postId)
  if (!updated) {
    throw internalError("Post row is missing after delete")
  }
  return updated
}

export async function setPostStatus(input: {
  executor: DbExecutor
  postId: string
  status: "published" | "hidden" | "removed"
  now: string
}): Promise<Post> {
  await input.executor.execute({
    sql: `
      UPDATE posts
      SET status = ?2,
          updated_at = ?3
      WHERE post_id = ?1
    `,
    args: [input.postId, input.status, input.now],
  })

  const updated = await getPostById(input.executor, input.postId)
  if (!updated) {
    throw internalError("Post row is missing after status update")
  }
  return updated
}

export async function setPostCommentsLocked(input: {
  executor: DbExecutor
  postId: string
  locked: boolean
  actorUserId: string
  reason: string | null
  now: string
}): Promise<Post> {
  await input.executor.execute({
    sql: `
      UPDATE posts
      SET comments_locked = ?2,
          comments_locked_at = CASE WHEN ?2 = 1 THEN ?3 ELSE NULL END,
          comments_locked_by_user_id = CASE WHEN ?2 = 1 THEN ?4 ELSE NULL END,
          comments_lock_reason = CASE WHEN ?2 = 1 THEN ?5 ELSE NULL END,
          updated_at = ?3
      WHERE post_id = ?1
    `,
    args: [input.postId, input.locked ? 1 : 0, input.now, input.actorUserId, input.reason],
  })

  const updated = await getPostById(input.executor, input.postId)
  if (!updated) {
    throw internalError("Post row is missing after lock update")
  }
  return {
    ...updated,
    comments_locked: input.locked,
    comments_locked_at: input.locked ? input.now : null,
    comments_locked_by_user_id: input.locked ? input.actorUserId : null,
    comments_lock_reason: input.locked ? input.reason : null,
  }
}
