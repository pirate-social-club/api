import type {
  Comment as ContractComment,
  CommentContext as ContractCommentContext,
  CommentListItem as ContractCommentListItem,
  CommentListResponse as ContractCommentListResponse,
  CommentThreadSnapshot as ContractCommentThreadSnapshot,
} from "@pirate/api-contracts"
import type {
  Comment,
  CommentContext,
  CommentListItem,
  CommentListResponse,
  CommentThreadSnapshot,
} from "../lib/comments/comment-types"
import { nullableUnixSeconds, unixSeconds } from "./time"
import { publicCommentId, publicCommunityId, publicPostId } from "../lib/public-ids"

type CurrentCommentResponse = ContractComment & Pick<Comment, "source_language">

export function serializeComment(comment: Comment): CurrentCommentResponse {
  return {
    id: publicCommentId(comment.comment_id),
    object: "comment",
    community: publicCommunityId(comment.community_id),
    thread_root_post: publicPostId(comment.thread_root_post_id),
    parent_comment: comment.parent_comment_id ? publicCommentId(comment.parent_comment_id) : null,
    author_user: comment.author_user_id ? `usr_${comment.author_user_id}` : null,
    authorship_mode: comment.authorship_mode,
    agent: comment.agent_id ? `agt_${comment.agent_id}` : comment.agent_id,
    agent_ownership_record: comment.agent_ownership_record_id ? `aor_${comment.agent_ownership_record_id}` : comment.agent_ownership_record_id,
    identity_mode: comment.identity_mode,
    anonymous_scope: comment.anonymous_scope,
    anonymous_label: comment.anonymous_label,
    agent_handle_snapshot: comment.agent_handle_snapshot,
    agent_display_name_snapshot: comment.agent_display_name_snapshot,
    agent_owner_handle_snapshot: comment.agent_owner_handle_snapshot,
    agent_ownership_provider_snapshot: comment.agent_ownership_provider_snapshot,
    body: comment.body,
    source_language: comment.source_language,
    status: comment.status,
    depth: comment.depth,
    direct_reply_count: comment.direct_reply_count,
    descendant_count: comment.descendant_count,
    upvote_count: comment.upvote_count,
    downvote_count: comment.downvote_count,
    score: comment.score,
    last_reply_at: nullableUnixSeconds(comment.last_reply_at),
    content_hash: comment.content_hash,
    swarm_body_ref: comment.swarm_body_ref,
    idempotency_key: comment.idempotency_key,
    created: unixSeconds(comment.created_at),
  }
}

export function serializeCommentThreadSnapshot(snapshot: CommentThreadSnapshot): ContractCommentThreadSnapshot {
  return {
    thread_root_post: publicPostId(snapshot.thread_root_post_id),
    snapshot_seq: snapshot.snapshot_seq,
    published_through_comment_created: unixSeconds(snapshot.published_through_comment_created_at),
    comment_count: snapshot.comment_count,
    swarm_manifest_ref: snapshot.swarm_manifest_ref,
    swarm_feed_ref: snapshot.swarm_feed_ref,
    created: unixSeconds(snapshot.created_at),
  }
}

export function serializeCommentListItem(item: CommentListItem): ContractCommentListItem {
  return {
    id: `cli_${item.comment.comment_id}`,
    object: "comment_list_item",
    comment: serializeComment(item.comment),
    viewer_vote: item.viewer_vote,
    resolved_locale: item.resolved_locale,
    translation_state: item.translation_state,
    machine_translated: item.machine_translated,
    translated_body: item.translated_body,
    source_hash: item.source_hash,
  }
}

export function serializeCommentListResponse(response: CommentListResponse): ContractCommentListResponse {
  return {
    items: response.items.map(serializeCommentListItem),
    next_cursor: response.next_cursor,
    thread_snapshot: response.thread_snapshot ? serializeCommentThreadSnapshot(response.thread_snapshot) : null,
  }
}

export function serializeCommentContext(context: CommentContext): ContractCommentContext {
  return {
    ancestors: context.ancestors.map(serializeCommentListItem),
    comment: serializeCommentListItem(context.comment),
    replies: context.replies.map(serializeCommentListItem),
    next_replies_cursor: context.next_replies_cursor,
    thread_snapshot: context.thread_snapshot ? serializeCommentThreadSnapshot(context.thread_snapshot) : null,
  }
}
