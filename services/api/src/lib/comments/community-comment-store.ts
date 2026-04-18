import type { DbExecutor } from "../db-helpers"
import { executeFirst } from "../db-helpers"
import { badRequestError, internalError } from "../errors"
import { makeId } from "../helpers"
import { numberOrNull, requiredNumber, requiredString, rowValue, stringOrNull } from "../sql-row"
import type {
  Comment,
  CommentAnonymousScope,
  CommentContext,
  CommentIdentityMode,
  CommentListItem,
  CommentListResponse,
  CommentSort,
  CommentStatus,
  CommentThreadSnapshot,
  CreateCommentRequest,
} from "./comment-types"

type CommentCursorPayload = {
  sort: CommentSort
  created_at: string
  comment_id: string
  score?: number
}

type CommentRow = {
  comment_id: string
  community_id: string
  thread_root_post_id: string
  parent_comment_id: string | null
  author_user_id: string | null
  identity_mode: CommentIdentityMode
  anonymous_scope: CommentAnonymousScope
  anonymous_label: string | null
  body: string | null
  source_language: string | null
  status: CommentStatus
  depth: number
  direct_reply_count: number
  descendant_count: number
  upvote_count: number
  downvote_count: number
  score: number
  last_reply_at: string | null
  content_hash: string | null
  swarm_body_ref: string | null
  created_at: string
  updated_at: string
}

type CommunityCommentPolicy = {
  allow_anonymous_identity: boolean
  anonymous_identity_scope: CommentAnonymousScope
}

type ThreadSnapshotRow = {
  thread_snapshot_id: string
  community_id: string
  thread_root_post_id: string
  snapshot_seq: number
  published_through_comment_created_at: string
  comment_count: number
  swarm_manifest_ref: string
  swarm_feed_ref: string | null
  created_at: string
}

type CommunityVisibilityRow = {
  community_id: string
  status: string
  membership_mode: "open" | "request" | "gated"
}

function toCommentRow(row: unknown): CommentRow {
  return {
    comment_id: requiredString(row, "comment_id"),
    community_id: requiredString(row, "community_id"),
    thread_root_post_id: requiredString(row, "thread_root_post_id"),
    parent_comment_id: stringOrNull(rowValue(row, "parent_comment_id")),
    author_user_id: stringOrNull(rowValue(row, "author_user_id")),
    identity_mode: requiredString(row, "identity_mode") as CommentIdentityMode,
    anonymous_scope: stringOrNull(rowValue(row, "anonymous_scope")) as CommentAnonymousScope,
    anonymous_label: stringOrNull(rowValue(row, "anonymous_label")),
    body: stringOrNull(rowValue(row, "body")),
    source_language: stringOrNull(rowValue(row, "source_language")),
    status: requiredString(row, "status") as CommentStatus,
    depth: requiredNumber(row, "depth"),
    direct_reply_count: requiredNumber(row, "direct_reply_count"),
    descendant_count: requiredNumber(row, "descendant_count"),
    upvote_count: requiredNumber(row, "upvote_count"),
    downvote_count: requiredNumber(row, "downvote_count"),
    score: requiredNumber(row, "score"),
    last_reply_at: stringOrNull(rowValue(row, "last_reply_at")),
    content_hash: stringOrNull(rowValue(row, "content_hash")),
    swarm_body_ref: stringOrNull(rowValue(row, "swarm_body_ref")),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

function serializeComment(row: CommentRow): Comment {
  return {
    comment_id: row.comment_id,
    community_id: row.community_id,
    thread_root_post_id: row.thread_root_post_id,
    parent_comment_id: row.parent_comment_id,
    author_user_id: row.identity_mode === "anonymous" ? null : row.author_user_id,
    authorship_mode: "human_direct",
    identity_mode: row.identity_mode,
    anonymous_scope: row.anonymous_scope,
    anonymous_label: row.anonymous_label,
    body: row.body,
    source_language: row.source_language,
    status: row.status,
    depth: row.depth,
    direct_reply_count: row.direct_reply_count,
    descendant_count: row.descendant_count,
    upvote_count: row.upvote_count,
    downvote_count: row.downvote_count,
    score: row.score,
    last_reply_at: row.last_reply_at,
    content_hash: row.content_hash,
    swarm_body_ref: row.swarm_body_ref,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function toThreadSnapshotRow(row: unknown): ThreadSnapshotRow {
  return {
    thread_snapshot_id: requiredString(row, "thread_snapshot_id"),
    community_id: requiredString(row, "community_id"),
    thread_root_post_id: requiredString(row, "thread_root_post_id"),
    snapshot_seq: requiredNumber(row, "snapshot_seq"),
    published_through_comment_created_at: requiredString(row, "published_through_comment_created_at"),
    comment_count: requiredNumber(row, "comment_count"),
    swarm_manifest_ref: requiredString(row, "swarm_manifest_ref"),
    swarm_feed_ref: stringOrNull(rowValue(row, "swarm_feed_ref")),
    created_at: requiredString(row, "created_at"),
  }
}

function serializeThreadSnapshot(row: ThreadSnapshotRow): CommentThreadSnapshot {
  return {
    thread_root_post_id: row.thread_root_post_id,
    snapshot_seq: row.snapshot_seq,
    published_through_comment_created_at: row.published_through_comment_created_at,
    comment_count: row.comment_count,
    swarm_manifest_ref: row.swarm_manifest_ref,
    swarm_feed_ref: row.swarm_feed_ref,
    created_at: row.created_at,
  }
}

function sortOrder(sort: CommentSort): string {
  switch (sort) {
    case "old":
      return "created_at ASC, comment_id ASC"
    case "top":
    case "best":
      return "score DESC, created_at DESC, comment_id DESC"
    case "new":
    default:
      return "created_at DESC, comment_id DESC"
  }
}

function rowToCommentListItem(row: unknown): CommentListItem {
  return {
    comment: serializeComment(toCommentRow(row)),
    viewer_vote: numberOrNull(rowValue(row, "viewer_vote")) as -1 | 1 | null,
    resolved_locale: "en",
    translation_state: "same_language",
    machine_translated: false,
    translated_body: null,
    source_hash: "",
  }
}

function encodeCommentCursor(cursor: CommentCursorPayload): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")
}

function decodeCommentCursor(cursor: string, sort: CommentSort): CommentCursorPayload {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as CommentCursorPayload
    if (!parsed || typeof parsed !== "object") {
      throw new Error("invalid cursor")
    }
    if (parsed.sort !== sort) {
      throw badRequestError("cursor does not match the requested sort")
    }
    if (typeof parsed.created_at !== "string" || typeof parsed.comment_id !== "string") {
      throw new Error("invalid cursor")
    }
    if ((sort === "best" || sort === "top") && typeof parsed.score !== "number") {
      throw new Error("invalid cursor")
    }
    return parsed
  } catch (error) {
    if (error instanceof Error && "status" in error) {
      throw error
    }
    throw badRequestError("Invalid comment cursor")
  }
}

function buildCursorClause(sort: CommentSort, cursor: CommentCursorPayload): { sql: string; args: unknown[] } {
  switch (sort) {
    case "old":
      return {
        sql: `
          AND (
            comments.created_at > ?4
            OR (comments.created_at = ?4 AND comments.comment_id > ?5)
          )
        `,
        args: [cursor.created_at, cursor.comment_id],
      }
    case "top":
    case "best":
      return {
        sql: `
          AND (
            comments.score < ?4
            OR (comments.score = ?4 AND comments.created_at < ?5)
            OR (comments.score = ?4 AND comments.created_at = ?5 AND comments.comment_id < ?6)
          )
        `,
        args: [cursor.score ?? 0, cursor.created_at, cursor.comment_id],
      }
    case "new":
    default:
      return {
        sql: `
          AND (
            comments.created_at < ?4
            OR (comments.created_at = ?4 AND comments.comment_id < ?5)
          )
        `,
        args: [cursor.created_at, cursor.comment_id],
      }
  }
}

export function assertCreateCommentRequest(body: CreateCommentRequest): void {
  if (Object.prototype.hasOwnProperty.call(body, "community_id")) {
    throw badRequestError("community_id must not be provided in the comment body")
  }
  if (Object.prototype.hasOwnProperty.call(body, "thread_root_post_id")) {
    throw badRequestError("thread_root_post_id must not be provided in the comment body")
  }
  if (Object.prototype.hasOwnProperty.call(body, "parent_comment_id")) {
    throw badRequestError("parent_comment_id must not be provided in the comment body")
  }
  if (!body.body?.trim()) {
    throw badRequestError("body is required")
  }
  if ((body.identity_mode ?? "public") !== "anonymous" && body.anonymous_scope) {
    throw badRequestError("anonymous_scope is only allowed for anonymous comments")
  }
  if (body.identity_mode === "anonymous" && !body.anonymous_scope) {
    throw badRequestError("anonymous_scope is required for anonymous comments")
  }
}

export async function getCommunityCommentPolicy(
  executor: DbExecutor,
  communityId: string,
): Promise<CommunityCommentPolicy | null> {
  const row = await executeFirst(executor, {
    sql: `
      SELECT allow_anonymous_identity, anonymous_identity_scope
      FROM communities
      WHERE community_id = ?1
      LIMIT 1
    `,
    args: [communityId],
  })

  if (!row) {
    return null
  }

  return {
    allow_anonymous_identity: requiredNumber(row, "allow_anonymous_identity") === 1,
    anonymous_identity_scope: stringOrNull(rowValue(row, "anonymous_identity_scope")) as CommentAnonymousScope,
  }
}

export async function getCommunityVisibility(executor: DbExecutor, communityId: string): Promise<CommunityVisibilityRow | null> {
  const row = await executeFirst(executor, {
    sql: `
      SELECT community_id, status, membership_mode
      FROM communities
      WHERE community_id = ?1
      LIMIT 1
    `,
    args: [communityId],
  })

  if (!row) {
    return null
  }

  return {
    community_id: requiredString(row, "community_id"),
    status: requiredString(row, "status"),
    membership_mode: requiredString(row, "membership_mode") as "open" | "request" | "gated",
  }
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
}): Promise<Comment> {
  const commentId = makeId("cmt")
  const identityMode = input.body.identity_mode ?? "public"
  const anonymousScope = identityMode === "anonymous" ? (input.body.anonymous_scope ?? null) : null
  const anonymousLabel = identityMode === "anonymous" ? "anonymous" : null

  await input.executor.execute({
    sql: `
      INSERT INTO comments (
        comment_id, community_id, thread_root_post_id, parent_comment_id, author_user_id,
        identity_mode, anonymous_scope, anonymous_label, body, source_language, status, depth,
        direct_reply_count, descendant_count, upvote_count, downvote_count, score,
        last_reply_at, content_hash, swarm_body_ref, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5,
        ?6, ?7, ?8, ?9, ?10, 'published', ?11,
        0, 0, 0, 0, 0,
        NULL, ?12, NULL, ?13, ?13
      )
    `,
    args: [
      commentId,
      input.communityId,
      input.threadRootPostId,
      input.parentCommentId,
      input.authorUserId,
      identityMode,
      anonymousScope,
      anonymousLabel,
      input.body.body.trim(),
      input.sourceLanguage,
      input.depth,
      input.contentHash,
      input.createdAt,
    ],
  })

  const created = await getCommentById(input.executor, commentId)
  if (!created) {
    throw internalError("Comment row is missing after insert")
  }
  return created
}

export async function getCommentById(executor: DbExecutor, commentId: string): Promise<Comment | null> {
  const row = await executeFirst(executor, {
    sql: `
      SELECT comment_id, community_id, thread_root_post_id, parent_comment_id, author_user_id,
             identity_mode, anonymous_scope, anonymous_label, body, source_language, status, depth,
             direct_reply_count, descendant_count, upvote_count, downvote_count, score,
             last_reply_at, content_hash, swarm_body_ref, created_at, updated_at
      FROM comments
      WHERE comment_id = ?1
      LIMIT 1
    `,
    args: [commentId],
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
             identity_mode, anonymous_scope, anonymous_label, body, source_language, status, depth,
             direct_reply_count, descendant_count, upvote_count, downvote_count, score,
             last_reply_at, content_hash, swarm_body_ref, created_at, updated_at
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

export async function getLatestThreadSnapshot(
  executor: DbExecutor,
  threadRootPostId: string,
): Promise<ThreadSnapshotRow | null> {
  const row = await executeFirst(executor, {
    sql: `
      SELECT thread_snapshot_id, community_id, thread_root_post_id, snapshot_seq,
             published_through_comment_created_at, comment_count, swarm_manifest_ref,
             swarm_feed_ref, created_at
      FROM thread_snapshots
      WHERE thread_root_post_id = ?1
      ORDER BY snapshot_seq DESC, created_at DESC
      LIMIT 1
    `,
    args: [threadRootPostId],
  })

  return row ? toThreadSnapshotRow(row) : null
}

export async function getLatestThreadSnapshotForRead(
  executor: DbExecutor,
  threadRootPostId: string,
): Promise<CommentThreadSnapshot | null> {
  const snapshot = await getLatestThreadSnapshot(executor, threadRootPostId)
  return snapshot ? serializeThreadSnapshot(snapshot) : null
}

export async function insertThreadSnapshot(input: {
  executor: DbExecutor
  communityId: string
  threadRootPostId: string
  snapshotSeq: number
  publishedThroughCommentCreatedAt: string
  commentCount: number
  swarmManifestRef: string
  swarmFeedRef?: string | null
  createdAt: string
}): Promise<ThreadSnapshotRow> {
  const threadSnapshotId = makeId("tsn")
  await input.executor.execute({
    sql: `
      INSERT INTO thread_snapshots (
        thread_snapshot_id, community_id, thread_root_post_id, snapshot_seq,
        published_through_comment_created_at, comment_count, swarm_manifest_ref,
        swarm_feed_ref, created_at
      ) VALUES (
        ?1, ?2, ?3, ?4,
        ?5, ?6, ?7,
        ?8, ?9
      )
    `,
    args: [
      threadSnapshotId,
      input.communityId,
      input.threadRootPostId,
      input.snapshotSeq,
      input.publishedThroughCommentCreatedAt,
      input.commentCount,
      input.swarmManifestRef,
      input.swarmFeedRef ?? null,
      input.createdAt,
    ],
  })

  const created = await executeFirst(input.executor, {
    sql: `
      SELECT thread_snapshot_id, community_id, thread_root_post_id, snapshot_seq,
             published_through_comment_created_at, comment_count, swarm_manifest_ref,
             swarm_feed_ref, created_at
      FROM thread_snapshots
      WHERE thread_snapshot_id = ?1
      LIMIT 1
    `,
    args: [threadSnapshotId],
  })

  if (!created) {
    throw internalError("Thread snapshot row is missing after insert")
  }

  return toThreadSnapshotRow(created)
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
             identity_mode, anonymous_scope, anonymous_label, body, source_language, status, depth,
             direct_reply_count, descendant_count, upvote_count, downvote_count, score,
             last_reply_at, content_hash, swarm_body_ref, created_at, updated_at,
             (
               SELECT vote_value
               FROM comment_votes
               WHERE comment_id = comments.comment_id
                 AND user_id = ?1
               LIMIT 1
             ) AS viewer_vote
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
             identity_mode, anonymous_scope, anonymous_label, body, source_language, status, depth,
             direct_reply_count, descendant_count, upvote_count, downvote_count, score,
             last_reply_at, content_hash, swarm_body_ref, created_at, updated_at,
             (
               SELECT vote_value
               FROM comment_votes
               WHERE comment_id = comments.comment_id
                 AND user_id = ?1
               LIMIT 1
             ) AS viewer_vote
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
             c.identity_mode, c.anonymous_scope, c.anonymous_label, c.body, c.source_language, c.status, c.depth,
             c.direct_reply_count, c.descendant_count, c.upvote_count, c.downvote_count, c.score,
             c.last_reply_at, c.content_hash, c.swarm_body_ref, c.created_at, c.updated_at,
             (
               SELECT vote_value
               FROM comment_votes
               WHERE comment_id = c.comment_id
                 AND user_id = ?1
               LIMIT 1
             ) AS viewer_vote
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
             identity_mode, anonymous_scope, anonymous_label, body, source_language, status, depth,
             direct_reply_count, descendant_count, upvote_count, downvote_count, score,
             last_reply_at, content_hash, swarm_body_ref, created_at, updated_at,
             (
               SELECT vote_value
               FROM comment_votes
               WHERE comment_id = comments.comment_id
                 AND user_id = ?1
               LIMIT 1
             ) AS viewer_vote
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
