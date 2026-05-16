import type { DbExecutor } from "../db-helpers"
import { executeFirst } from "../db-helpers"
import { internalError } from "../errors"
import { makeId } from "../helpers"
import { buildAnonymousLabel } from "../identity/anonymous-identity"
import { numberOrNull, requiredNumber, requiredString, rowValue } from "../sql-row"
import type {
  Comment,
  CommentContext,
  CommentListResponse,
  CommentSort,
  CreateCommentRequest,
} from "./comment-types"
import {
  buildCursorClause,
  decodeCommentCursor,
  encodeCommentCursor,
  rowToCommentListItem,
  sortOrder,
} from "./community-comment-cursors"
import { serializeComment, toCommentRow } from "./community-comment-serialization"

export {
  getLatestThreadSnapshot,
  getLatestThreadSnapshotForRead,
  insertThreadSnapshot,
} from "./community-comment-snapshots"

export {
  assertCreateCommentRequest,
  getCommunityCommentPolicy,
  getCommunityVisibility,
} from "./community-comment-policy"

type CommentProjectionSchema = {
  hasReplyLockColumns: boolean
}

async function resolveCommentProjectionSchema(executor: DbExecutor): Promise<CommentProjectionSchema> {
  const result = await executor.execute("PRAGMA table_info(comments)")
  const columnNames = new Set(result.rows.map((row) => String(row.name ?? "")))
  return {
    hasReplyLockColumns: columnNames.has("replies_locked")
      && columnNames.has("replies_locked_at")
      && columnNames.has("replies_locked_by_user_id")
      && columnNames.has("replies_lock_reason"),
  }
}

function replyLockSelectColumnsForSchema(schema: CommentProjectionSchema): string {
  return schema.hasReplyLockColumns
    ? "replies_locked, replies_locked_at, replies_locked_by_user_id, replies_lock_reason"
    : "0 AS replies_locked, NULL AS replies_locked_at, NULL AS replies_locked_by_user_id, NULL AS replies_lock_reason"
}

export async function insertComment(input: {
  executor: DbExecutor
  communityId: string
  threadRootPostId: string
  parentCommentId: string | null
  authorUserId: string
  body: CreateCommentRequest
  sourceLanguage: string | null
  depth: number
  createdAt: string
  contentHash: string | null
  agentWriteAuthorization?: {
    agentId: string
    agentOwnershipRecordId: string
    agentHandleSnapshot: string
    agentDisplayNameSnapshot: string
    agentOwnerHandleSnapshot: string
    agentOwnershipProviderSnapshot: NonNullable<Comment["agent_ownership_provider_snapshot"]>
  }
}): Promise<Comment> {
  const commentId = makeId("cmt")
  const identityMode = input.body.identity_mode ?? "public"
  const anonymousScope = identityMode === "anonymous" ? (input.body.anonymous_scope ?? null) : null
  const anonymousLabel = identityMode === "anonymous" && anonymousScope
    ? buildAnonymousLabel({
        communityId: input.communityId,
        entityId: input.threadRootPostId,
        scope: anonymousScope,
        userId: input.authorUserId,
      })
    : null

  await input.executor.execute({
    sql: `
      INSERT INTO comments (
        comment_id, community_id, thread_root_post_id, parent_comment_id, author_user_id,
        authorship_mode, agent_id, agent_ownership_record_id, identity_mode, anonymous_scope,
        anonymous_label, agent_display_name_snapshot, agent_owner_handle_snapshot, agent_ownership_provider_snapshot,
        body, media_refs_json, source_language, status, depth, direct_reply_count, descendant_count, upvote_count, downvote_count, score,
        last_reply_at, content_hash, swarm_body_ref, idempotency_key, created_at, updated_at, agent_handle_snapshot
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5,
        ?6, ?7, ?8, ?9, ?10,
        ?11, ?12, ?13, ?14,
        ?15, ?16, ?17, 'published', ?18, 0, 0, 0, 0, 0,
        NULL, ?19, NULL, ?20, ?21, ?21, ?22
      )
    `,
    args: [
      commentId,
      input.communityId,
      input.threadRootPostId,
      input.parentCommentId,
      input.authorUserId,
      input.body.authorship_mode ?? "human_direct",
      input.agentWriteAuthorization?.agentId ?? null,
      input.agentWriteAuthorization?.agentOwnershipRecordId ?? null,
      identityMode,
      anonymousScope,
      anonymousLabel,
      input.agentWriteAuthorization?.agentDisplayNameSnapshot ?? null,
      input.agentWriteAuthorization?.agentOwnerHandleSnapshot ?? null,
      input.agentWriteAuthorization?.agentOwnershipProviderSnapshot ?? null,
      input.body.body?.trim() ?? "",
      JSON.stringify(input.body.media_refs ?? []),
      input.sourceLanguage,
      input.depth,
      input.contentHash,
      input.body.idempotency_key?.trim() ?? "",
      input.createdAt,
      input.agentWriteAuthorization?.agentHandleSnapshot ?? null,
    ],
  })

  const created = await getCommentById(input.executor, commentId)
  if (!created) {
    throw internalError("Comment row is missing after insert")
  }
  return created
}

export async function getCommentById(executor: DbExecutor, commentId: string): Promise<Comment | null> {
  const projectionSchema = await resolveCommentProjectionSchema(executor)
  const row = await executeFirst(executor, {
    sql: `
      SELECT comment_id, community_id, thread_root_post_id, parent_comment_id, author_user_id,
             authorship_mode, agent_id, agent_ownership_record_id, identity_mode, anonymous_scope,
             anonymous_label, agent_display_name_snapshot, agent_owner_handle_snapshot, agent_ownership_provider_snapshot, agent_handle_snapshot,
             body, media_refs_json, source_language, status, depth,
             direct_reply_count, descendant_count, upvote_count, downvote_count, score,
             last_reply_at, content_hash, swarm_body_ref, idempotency_key,
             ${replyLockSelectColumnsForSchema(projectionSchema)},
             created_at, updated_at
      FROM comments
      WHERE comment_id = ?1
      LIMIT 1
    `,
    args: [commentId],
  })

  return row ? serializeComment(toCommentRow(row)) : null
}

export async function findCommentByIdempotencyKey(input: {
  executor: DbExecutor
  communityId: string
  authorUserId: string
  idempotencyKey: string
}): Promise<Comment | null> {
  const row = await executeFirst(input.executor, {
    sql: `
      SELECT comment_id, community_id, thread_root_post_id, parent_comment_id, author_user_id,
             authorship_mode, agent_id, agent_ownership_record_id, identity_mode, anonymous_scope,
             anonymous_label, agent_display_name_snapshot, agent_owner_handle_snapshot, agent_ownership_provider_snapshot, agent_handle_snapshot,
             body, media_refs_json, source_language, status, depth,
             direct_reply_count, descendant_count, upvote_count, downvote_count, score,
             last_reply_at, content_hash, swarm_body_ref, idempotency_key, created_at, updated_at
      FROM comments
      WHERE community_id = ?1
        AND author_user_id = ?2
        AND idempotency_key = ?3
      LIMIT 1
    `,
    args: [input.communityId, input.authorUserId, input.idempotencyKey],
  })

  return row ? serializeComment(toCommentRow(row)) : null
}

export async function listThreadCommentsForSnapshot(
  executor: DbExecutor,
  threadRootPostId: string,
): Promise<Comment[]> {
  const result = await executor.execute({
    sql: `
      SELECT comment_id, community_id, thread_root_post_id, parent_comment_id, author_user_id,
             authorship_mode, agent_id, agent_ownership_record_id, identity_mode, anonymous_scope,
             anonymous_label, agent_display_name_snapshot, agent_owner_handle_snapshot, agent_ownership_provider_snapshot, agent_handle_snapshot,
             body, media_refs_json, source_language, status, depth,
             direct_reply_count, descendant_count, upvote_count, downvote_count, score,
             last_reply_at, content_hash, swarm_body_ref, idempotency_key, created_at, updated_at
      FROM comments
      WHERE thread_root_post_id = ?1
        AND status != 'hidden'
      ORDER BY created_at ASC, comment_id ASC
    `,
    args: [threadRootPostId],
  })

  return result.rows.map((row) => serializeComment(toCommentRow(row)))
}

export async function updateCommentSwarmBodyRef(input: {
  executor: DbExecutor
  commentId: string
  swarmBodyRef: string
  now: string
}): Promise<Comment> {
  await input.executor.execute({
    sql: `
      UPDATE comments
      SET swarm_body_ref = ?2,
          updated_at = ?3
      WHERE comment_id = ?1
    `,
    args: [input.commentId, input.swarmBodyRef, input.now],
  })

  const updated = await getCommentById(input.executor, input.commentId)
  if (!updated) {
    throw internalError("Comment row is missing after swarm ref update")
  }
  return updated
}

async function listCommentsForQuery(input: {
  executor: DbExecutor
  sql: string
  args: unknown[]
  limit: number
  sort: CommentSort
}): Promise<CommentListResponse> {
  const result = await input.executor.execute({
    sql: input.sql,
    args: input.args,
  })

  const rows = result.rows.slice(0, input.limit)
  const items = rows.map((row) => rowToCommentListItem(row))
  const hasMore = result.rows.length > input.limit
  const nextRow = hasMore ? rows.at(-1) : null
  const nextCursor = nextRow
    ? encodeCommentCursor({
        sort: input.sort,
        created_at: requiredString(nextRow, "created_at"),
        comment_id: requiredString(nextRow, "comment_id"),
        score: input.sort === "best" || input.sort === "top" ? requiredNumber(nextRow, "score") : undefined,
      })
    : null

  return {
    items,
    next_cursor: nextCursor,
    thread_snapshot: null,
  }
}

export async function listTopLevelComments(input: {
  executor: DbExecutor
  threadRootPostId: string
  viewerUserId: string
  limit: number
  sort?: CommentSort
  cursor?: string | null
}): Promise<CommentListResponse> {
  const sort = input.sort ?? "best"
  const cursor = input.cursor ? decodeCommentCursor(input.cursor, sort) : null
  const cursorClause = cursor ? buildCursorClause(sort, cursor) : { sql: "", args: [] }
  return listCommentsForQuery({
    executor: input.executor,
    sql: `
      SELECT comment_id, community_id, thread_root_post_id, parent_comment_id, author_user_id,
             authorship_mode, agent_id, agent_ownership_record_id, identity_mode, anonymous_scope,
             anonymous_label, agent_display_name_snapshot, agent_owner_handle_snapshot, agent_ownership_provider_snapshot, agent_handle_snapshot,
             body, media_refs_json, source_language, status, depth,
             direct_reply_count, descendant_count, upvote_count, downvote_count, score,
             last_reply_at, content_hash, swarm_body_ref, idempotency_key, created_at, updated_at,
             (
               SELECT vote_value
               FROM comment_votes
               WHERE comment_id = comments.comment_id
                 AND user_id = ?1
               LIMIT 1
             ) AS viewer_vote,
             CASE WHEN status != 'deleted' AND author_user_id = ?1 THEN 1 ELSE 0 END AS viewer_can_delete
      FROM comments
      WHERE thread_root_post_id = ?2
        AND parent_comment_id IS NULL
        AND status != 'hidden'
        ${cursorClause.sql}
      ORDER BY ${sortOrder(sort)}
      LIMIT ?3
    `,
    args: [input.viewerUserId, input.threadRootPostId, input.limit + 1, ...cursorClause.args],
    limit: input.limit,
    sort,
  })
}

export async function listReplies(input: {
  executor: DbExecutor
  parentCommentId: string
  viewerUserId: string
  limit: number
  sort?: CommentSort
  cursor?: string | null
}): Promise<CommentListResponse> {
  const sort = input.sort ?? "best"
  const cursor = input.cursor ? decodeCommentCursor(input.cursor, sort) : null
  const cursorClause = cursor ? buildCursorClause(sort, cursor) : { sql: "", args: [] }
  return listCommentsForQuery({
    executor: input.executor,
    sql: `
      SELECT comment_id, community_id, thread_root_post_id, parent_comment_id, author_user_id,
             authorship_mode, agent_id, agent_ownership_record_id, identity_mode, anonymous_scope,
             anonymous_label, agent_display_name_snapshot, agent_owner_handle_snapshot, agent_ownership_provider_snapshot, agent_handle_snapshot,
             body, media_refs_json, source_language, status, depth,
             direct_reply_count, descendant_count, upvote_count, downvote_count, score,
             last_reply_at, content_hash, swarm_body_ref, idempotency_key, created_at, updated_at,
             (
               SELECT vote_value
               FROM comment_votes
               WHERE comment_id = comments.comment_id
                 AND user_id = ?1
               LIMIT 1
             ) AS viewer_vote,
             CASE WHEN status != 'deleted' AND author_user_id = ?1 THEN 1 ELSE 0 END AS viewer_can_delete
      FROM comments
      WHERE parent_comment_id = ?2
        AND status != 'hidden'
        ${cursorClause.sql}
      ORDER BY ${sortOrder(sort)}
      LIMIT ?3
    `,
    args: [input.viewerUserId, input.parentCommentId, input.limit + 1, ...cursorClause.args],
    limit: input.limit,
    sort,
  })
}

export async function getCommentContext(input: {
  executor: DbExecutor
  commentId: string
  viewerUserId: string
  replyLimit: number
  replyCursor?: string | null
}): Promise<CommentContext | null> {
  const comment = await getCommentById(input.executor, input.commentId)
  if (!comment || comment.status === "hidden") {
    return null
  }

  const ancestorResult = await input.executor.execute({
    sql: `
      SELECT c.comment_id, c.community_id, c.thread_root_post_id, c.parent_comment_id, c.author_user_id,
             c.authorship_mode, c.agent_id, c.agent_ownership_record_id, c.identity_mode, c.anonymous_scope,
             c.anonymous_label, c.agent_display_name_snapshot, c.agent_owner_handle_snapshot,
             c.agent_ownership_provider_snapshot, c.agent_handle_snapshot, c.body, c.media_refs_json, c.source_language, c.status, c.depth,
             c.direct_reply_count, c.descendant_count, c.upvote_count, c.downvote_count, c.score,
             c.last_reply_at, c.content_hash, c.swarm_body_ref, c.created_at, c.updated_at,
             (
               SELECT vote_value
               FROM comment_votes
               WHERE comment_id = c.comment_id
                 AND user_id = ?1
               LIMIT 1
             ) AS viewer_vote,
             CASE WHEN c.status != 'deleted' AND c.author_user_id = ?1 THEN 1 ELSE 0 END AS viewer_can_delete
      FROM comment_closure cc
      JOIN comments c
        ON c.comment_id = cc.ancestor_comment_id
      WHERE cc.descendant_comment_id = ?2
        AND cc.distance > 0
        AND c.status != 'hidden'
      ORDER BY cc.distance DESC
    `,
    args: [input.viewerUserId, input.commentId],
  })

  const current = await listCommentsForQuery({
    executor: input.executor,
    sql: `
      SELECT comment_id, community_id, thread_root_post_id, parent_comment_id, author_user_id,
             authorship_mode, agent_id, agent_ownership_record_id, identity_mode, anonymous_scope,
             anonymous_label, agent_display_name_snapshot, agent_owner_handle_snapshot, agent_ownership_provider_snapshot, agent_handle_snapshot,
             body, media_refs_json, source_language, status, depth,
             direct_reply_count, descendant_count, upvote_count, downvote_count, score,
             last_reply_at, content_hash, swarm_body_ref, idempotency_key, created_at, updated_at,
             (
               SELECT vote_value
               FROM comment_votes
               WHERE comment_id = comments.comment_id
                 AND user_id = ?1
               LIMIT 1
             ) AS viewer_vote,
             CASE WHEN status != 'deleted' AND author_user_id = ?1 THEN 1 ELSE 0 END AS viewer_can_delete
      FROM comments
      WHERE comment_id = ?2
      LIMIT 1
    `,
    args: [input.viewerUserId, input.commentId],
    limit: 1,
    sort: "best",
  })

  if (!current.items[0]) {
    return null
  }

  const replies = await listReplies({
    executor: input.executor,
    parentCommentId: input.commentId,
    viewerUserId: input.viewerUserId,
    limit: input.replyLimit,
    sort: "best",
    cursor: input.replyCursor ?? null,
  })

  return {
    ancestors: ancestorResult.rows.map((row) => rowToCommentListItem(row)),
    comment: current.items[0],
    replies: replies.items,
    next_replies_cursor: replies.next_cursor,
    thread_snapshot: null,
  }
}

export async function upsertCommentVote(input: {
  executor: DbExecutor
  commentId: string
  userId: string
  value: -1 | 1
  now: string
}): Promise<{ comment_id: string; value: -1 | 1 }> {
  const existing = await executeFirst(input.executor, {
    sql: `
      SELECT vote_value
      FROM comment_votes
      WHERE comment_id = ?1
        AND user_id = ?2
      LIMIT 1
    `,
    args: [input.commentId, input.userId],
  })
  const previousValue = numberOrNull(rowValue(existing, "vote_value")) as -1 | 1 | null

  await input.executor.execute({
    sql: `
      INSERT INTO comment_votes (
        comment_vote_id, comment_id, user_id, vote_value, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?5
      )
      ON CONFLICT(comment_id, user_id) DO UPDATE SET
        vote_value = excluded.vote_value,
        updated_at = excluded.updated_at
    `,
    args: [makeId("cvt"), input.commentId, input.userId, input.value, input.now],
  })

  const upvoteDelta = (input.value === 1 ? 1 : 0) - (previousValue === 1 ? 1 : 0)
  const downvoteDelta = (input.value === -1 ? 1 : 0) - (previousValue === -1 ? 1 : 0)
  const scoreDelta = input.value - (previousValue ?? 0)

  if (upvoteDelta !== 0 || downvoteDelta !== 0 || scoreDelta !== 0) {
    await input.executor.execute({
      sql: `
        UPDATE comments
        SET upvote_count = upvote_count + ?2,
            downvote_count = downvote_count + ?3,
            score = score + ?4,
            updated_at = ?5
        WHERE comment_id = ?1
      `,
      args: [input.commentId, upvoteDelta, downvoteDelta, scoreDelta, input.now],
    })
  }

  return {
    comment_id: input.commentId,
    value: input.value,
  }
}

export async function markCommentDeleted(input: {
  executor: DbExecutor
  commentId: string
  now: string
}): Promise<Comment> {
  await input.executor.execute({
    sql: `
      UPDATE comments
      SET status = 'deleted',
          body = '[deleted]',
          media_refs_json = '[]',
          updated_at = ?2
      WHERE comment_id = ?1
    `,
    args: [input.commentId, input.now],
  })

  const updated = await getCommentById(input.executor, input.commentId)
  if (!updated) {
    throw internalError("Comment row is missing after delete")
  }
  return updated
}

export async function setCommentStatus(input: {
  executor: DbExecutor
  commentId: string
  status: "published" | "hidden" | "removed"
  now: string
}): Promise<Comment> {
  await input.executor.execute({
    sql: `
      UPDATE comments
      SET status = ?2,
          updated_at = ?3
      WHERE comment_id = ?1
    `,
    args: [input.commentId, input.status, input.now],
  })

  const updated = await getCommentById(input.executor, input.commentId)
  if (!updated) {
    throw internalError("Comment row is missing after status update")
  }
  return updated
}

export async function setCommentRepliesLocked(input: {
  executor: DbExecutor
  commentId: string
  locked: boolean
  actorUserId: string
  reason: string | null
  now: string
}): Promise<Comment> {
  await input.executor.execute({
    sql: `
      UPDATE comments
      SET replies_locked = ?2,
          replies_locked_at = CASE WHEN ?2 = 1 THEN ?3 ELSE NULL END,
          replies_locked_by_user_id = CASE WHEN ?2 = 1 THEN ?4 ELSE NULL END,
          replies_lock_reason = CASE WHEN ?2 = 1 THEN ?5 ELSE NULL END,
          updated_at = ?3
      WHERE comment_id = ?1
    `,
    args: [input.commentId, input.locked ? 1 : 0, input.now, input.actorUserId, input.reason],
  })

  const updated = await getCommentById(input.executor, input.commentId)
  if (!updated) {
    throw internalError("Comment row is missing after lock update")
  }
  return {
    ...updated,
    replies_locked: input.locked,
    replies_locked_at: input.locked ? input.now : null,
    replies_locked_by_user_id: input.locked ? input.actorUserId : null,
    replies_lock_reason: input.locked ? input.reason : null,
  }
}
