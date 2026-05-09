import type {
  DeletedPostResponse as ContractDeletedPostResponse,
  LocalizedPostResponse as ContractLocalizedPostResponse,
  Post as ContractPost,
} from "@pirate/api-contracts"
import type { LocalizedPostResponse, Post } from "../types"
import { serializeCommentThreadSnapshot } from "./comment"
import { unixSeconds } from "./time"
import { publicCommunityId, publicId, publicPostId } from "../lib/public-ids"

type CurrentPostResponse = ContractPost & Pick<
  Post,
  | "lyrics"
  | "label_assignment_status"
  | "label_assigned_by"
  | "label_assigned_at"
  | "label_ai_confidence"
  | "label_assignment_error"
  | "label_assignment_model"
  | "label_assignment_result_json"
>

type ContractPostLabel = NonNullable<ContractLocalizedPostResponse["label"]>

function serializePostLabel(label: LocalizedPostResponse["label"]): ContractPostLabel | null | undefined {
  if (label == null) return label
  return {
    id: `lbl_${label.label_id}`,
    object: "post_label",
    label: label.label,
    color_token: label.color_token,
    status: label.status,
  }
}

export function serializePost(post: Post): CurrentPostResponse {
  return {
    id: publicPostId(post.post_id),
    object: "post",
    community: publicCommunityId(post.community_id),
    author_user: post.identity_mode === "public" && post.author_user_id ? `usr_${post.author_user_id}` : null,
    authorship_mode: post.authorship_mode,
    agent: post.agent_id ? `agt_${post.agent_id}` : post.agent_id,
    agent_ownership_record: post.agent_ownership_record_id ? `aor_${post.agent_ownership_record_id}` : post.agent_ownership_record_id,
    identity_mode: post.identity_mode,
    anonymous_scope: post.anonymous_scope,
    anonymous_label: post.anonymous_label,
    agent_handle_snapshot: post.agent_handle_snapshot,
    agent_display_name_snapshot: post.agent_display_name_snapshot,
    agent_owner_handle_snapshot: post.agent_owner_handle_snapshot,
    agent_ownership_provider_snapshot: post.agent_ownership_provider_snapshot,
    disclosed_qualifiers_json: post.disclosed_qualifiers_json,
    label: post.label_id,
    post_type: post.post_type,
    status: post.status,
    comments_locked: post.comments_locked ?? false,
    comments_locked_at: post.comments_locked_at ? unixSeconds(post.comments_locked_at) : null,
    comments_locked_by_user: post.comments_locked_by_user_id ? `usr_${post.comments_locked_by_user_id}` : null,
    comments_lock_reason: post.comments_lock_reason ?? null,
    visibility: post.visibility,
    title: post.title,
    body: post.body,
    caption: post.caption,
    lyrics: post.lyrics,
    link_url: post.link_url,
    link_og_image_url: post.link_og_image_url,
    link_og_title: post.link_og_title,
    link_enrichment: post.link_enrichment_snapshot_json,
    embeds: post.embeds,
    media_refs: post.media_refs,
    creator_relation: post.creator_relation,
    promotion_disclosure: post.promotion_disclosure,
    source_language: post.source_language,
    translation_policy: post.translation_policy,
    access_mode: post.access_mode,
    asset: post.asset_id ? publicId(post.asset_id, "asset") : null,
    anchor_live_room: post.anchor_live_room_id ?? null,
    song_artifact_bundle: post.song_artifact_bundle_id ? publicId(post.song_artifact_bundle_id, "sab") : null,
    song_title: post.song_title,
    parent_post: post.parent_post_id,
    song_mode: post.song_mode,
    rights_basis: post.rights_basis,
    upstream_asset_refs: post.upstream_asset_refs,
    analysis_state: post.analysis_state,
    analysis_result_ref: post.analysis_result_ref,
    content_safety_state: post.content_safety_state,
    age_gate_policy: post.age_gate_policy,
    created: unixSeconds(post.created_at),
    label_assignment_status: post.label_assignment_status,
    label_assigned_by: post.label_assigned_by,
    label_assigned_at: post.label_assigned_at,
    label_ai_confidence: post.label_ai_confidence,
    label_assignment_error: post.label_assignment_error,
    label_assignment_model: post.label_assignment_model,
    label_assignment_result_json: post.label_assignment_result_json,
  }
}

export function serializeDeletedPostResponse(post: Pick<Post, "post_id">): ContractDeletedPostResponse {
  return {
    id: publicPostId(post.post_id),
    object: "post",
    deleted: true,
  }
}

export function serializeLocalizedPostResponse(response: LocalizedPostResponse): ContractLocalizedPostResponse {
  return {
    post: serializePost(response.post),
    author_community_role: response.author_community_role,
    thread_snapshot: response.thread_snapshot ? serializeCommentThreadSnapshot(response.thread_snapshot) : null,
    market_context: response.market_context,
    label: serializePostLabel(response.label),
    upvote_count: response.upvote_count,
    downvote_count: response.downvote_count,
    like_count: response.like_count,
    comment_count: response.comment_count,
    viewer_vote: response.viewer_vote,
    viewer_is_author: response.viewer_is_author,
    viewer_reaction_kinds: response.viewer_reaction_kinds,
    age_gate_viewer_state: response.age_gate_viewer_state,
    resolved_locale: response.resolved_locale,
    translation_state: response.translation_state,
    machine_translated: response.machine_translated,
    translated_body: response.translated_body,
    translated_title: response.translated_title,
    translated_caption: response.translated_caption,
    translated_embeds: response.translated_embeds,
    source_hash: response.source_hash,
  }
}
