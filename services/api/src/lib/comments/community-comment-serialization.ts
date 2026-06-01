import { boolOrNull, numberOrNull, requiredNumber, requiredString, rowValue, stringOrNull } from "../sql-row"
import type {
  Comment,
  CommentAnonymousScope,
  CommentIdentityMode,
  CommentStatus,
  CommentThreadSnapshot,
} from "./comment-types"

export type CommentRow = {
  comment_id: string
  community_id: string
  thread_root_post_id: string
  parent_comment_id: string | null
  author_user_id: string | null
  authorship_mode: Comment["authorship_mode"]
  agent_id: string | null
  agent_ownership_record_id: string | null
  identity_mode: CommentIdentityMode
  anonymous_scope: CommentAnonymousScope
  anonymous_label: string | null
  agent_handle_snapshot: string | null
  agent_display_name_snapshot: string | null
  agent_owner_handle_snapshot: string | null
  agent_ownership_provider_snapshot: string | null
  body: string | null
  media_refs_json: string | null
  source_language: string | null
  source_language_confidence: number | null
  source_language_reliable: number | null
  source_language_detector: string | null
  source_language_detected_at: string | null
  source_language_source_hash: string | null
  status: CommentStatus
  replies_locked: number | null
  replies_locked_at: string | null
  replies_locked_by_user_id: string | null
  replies_lock_reason: string | null
  depth: number
  direct_reply_count: number
  descendant_count: number
  upvote_count: number
  downvote_count: number
  score: number
  last_reply_at: string | null
  content_hash: string | null
  swarm_body_ref: string | null
  idempotency_key: string | null
  created_at: string
  updated_at: string
}

export type ThreadSnapshotRow = {
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

export function toCommentRow(row: unknown): CommentRow {
  return {
    comment_id: requiredString(row, "comment_id"),
    community_id: requiredString(row, "community_id"),
    thread_root_post_id: requiredString(row, "thread_root_post_id"),
    parent_comment_id: stringOrNull(rowValue(row, "parent_comment_id")),
    author_user_id: stringOrNull(rowValue(row, "author_user_id")),
    authorship_mode: requiredString(row, "authorship_mode") as Comment["authorship_mode"],
    agent_id: stringOrNull(rowValue(row, "agent_id")),
    agent_ownership_record_id: stringOrNull(rowValue(row, "agent_ownership_record_id")),
    identity_mode: requiredString(row, "identity_mode") as CommentIdentityMode,
    anonymous_scope: stringOrNull(rowValue(row, "anonymous_scope")) as CommentAnonymousScope,
    anonymous_label: stringOrNull(rowValue(row, "anonymous_label")),
    agent_handle_snapshot: stringOrNull(rowValue(row, "agent_handle_snapshot")),
    agent_display_name_snapshot: stringOrNull(rowValue(row, "agent_display_name_snapshot")),
    agent_owner_handle_snapshot: stringOrNull(rowValue(row, "agent_owner_handle_snapshot")),
    agent_ownership_provider_snapshot: stringOrNull(rowValue(row, "agent_ownership_provider_snapshot")),
    body: stringOrNull(rowValue(row, "body")),
    media_refs_json: stringOrNull(rowValue(row, "media_refs_json")),
    source_language: stringOrNull(rowValue(row, "source_language")),
    source_language_confidence: numberOrNull(rowValue(row, "source_language_confidence")),
    source_language_reliable: numberOrNull(rowValue(row, "source_language_reliable")),
    source_language_detector: stringOrNull(rowValue(row, "source_language_detector")),
    source_language_detected_at: stringOrNull(rowValue(row, "source_language_detected_at")),
    source_language_source_hash: stringOrNull(rowValue(row, "source_language_source_hash")),
    status: requiredString(row, "status") as CommentStatus,
    replies_locked: numberOrNull(rowValue(row, "replies_locked")),
    replies_locked_at: stringOrNull(rowValue(row, "replies_locked_at")),
    replies_locked_by_user_id: stringOrNull(rowValue(row, "replies_locked_by_user_id")),
    replies_lock_reason: stringOrNull(rowValue(row, "replies_lock_reason")),
    depth: requiredNumber(row, "depth"),
    direct_reply_count: requiredNumber(row, "direct_reply_count"),
    descendant_count: requiredNumber(row, "descendant_count"),
    upvote_count: requiredNumber(row, "upvote_count"),
    downvote_count: requiredNumber(row, "downvote_count"),
    score: requiredNumber(row, "score"),
    last_reply_at: stringOrNull(rowValue(row, "last_reply_at")),
    content_hash: stringOrNull(rowValue(row, "content_hash")),
    swarm_body_ref: stringOrNull(rowValue(row, "swarm_body_ref")),
    idempotency_key: stringOrNull(rowValue(row, "idempotency_key")),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

function parseMediaRefs(value: string | null): Comment["media_refs"] {
  if (!value) {
    return []
  }
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed as Comment["media_refs"] : []
  } catch {
    return []
  }
}

export function serializeComment(row: CommentRow): Comment {
  return {
    comment_id: row.comment_id,
    community_id: row.community_id,
    thread_root_post_id: row.thread_root_post_id,
    parent_comment_id: row.parent_comment_id,
    author_user_id: row.identity_mode === "anonymous" ? null : row.author_user_id,
    authorship_mode: row.authorship_mode,
    agent_id: row.agent_id,
    agent_ownership_record_id: row.agent_ownership_record_id,
    identity_mode: row.identity_mode,
    anonymous_scope: row.anonymous_scope,
    anonymous_label: row.anonymous_label,
    agent_handle_snapshot: row.agent_handle_snapshot,
    agent_display_name_snapshot: row.agent_display_name_snapshot,
    agent_owner_handle_snapshot: row.agent_owner_handle_snapshot,
    agent_ownership_provider_snapshot: row.agent_ownership_provider_snapshot as Comment["agent_ownership_provider_snapshot"],
    body: row.body,
    media_refs: parseMediaRefs(row.media_refs_json),
    source_language: row.source_language,
    source_language_confidence: row.source_language_confidence,
    source_language_reliable: boolOrNull(row.source_language_reliable) ?? false,
    source_language_detector: row.source_language_detector,
    source_language_detected_at: row.source_language_detected_at,
    source_language_source_hash: row.source_language_source_hash,
    status: row.status,
    replies_locked: row.replies_locked === 1,
    replies_locked_at: row.replies_locked_at,
    replies_locked_by_user_id: row.replies_locked_by_user_id,
    replies_lock_reason: row.replies_lock_reason,
    depth: row.depth,
    direct_reply_count: row.direct_reply_count,
    descendant_count: row.descendant_count,
    upvote_count: row.upvote_count,
    downvote_count: row.downvote_count,
    score: row.score,
    last_reply_at: row.last_reply_at,
    content_hash: row.content_hash,
    swarm_body_ref: row.swarm_body_ref,
    idempotency_key: row.idempotency_key,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export function toThreadSnapshotRow(row: unknown): ThreadSnapshotRow {
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

export function serializeThreadSnapshot(row: ThreadSnapshotRow): CommentThreadSnapshot {
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
