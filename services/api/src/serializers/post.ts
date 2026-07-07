import type {
  DeletedPostResponse as ContractDeletedPostResponse,
  LocalizedPostResponse as ContractLocalizedPostResponse,
  Post as ContractPost,
} from "@pirate/api-contracts"
import type { LocalizedPostResponse, Post } from "../types"
import { serializeCommentThreadSnapshot } from "./comment"
import { serializeCommunityPreview } from "./community"
import { unixSeconds } from "./time"
import { publicCommunityId, publicId, publicPostId } from "../lib/public-ids"

type CurrentPostResponse = ContractPost & Pick<
  Post,
  | "lyrics"
  | "event"
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
    author_public_handle: post.identity_mode === "public" ? post.author_public_handle ?? null : null,
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
    event: post.event ?? null,
    embeds: post.embeds,
    media_refs: post.media_refs,
    creator_relation: post.creator_relation,
    promotion_disclosure: post.promotion_disclosure,
    source_language: post.source_language,
    translation_policy: post.translation_policy,
    access_mode: post.access_mode,
    asset: post.asset_id ? publicId(post.asset_id, "asset") : null,
    anchor_live_room: post.anchor_live_room_id ?? null,
    anchor_live_room_status: post.anchor_live_room_status ?? null,
    song_artifact_bundle: post.song_artifact_bundle_id ? publicId(post.song_artifact_bundle_id, "sab") : null,
    song_title: post.song_title,
    song_annotations_url: post.song_annotations_url ?? null,
    parent_post: post.parent_post_id,
    crosspost_source: post.crosspost_source
      ? {
          status: post.crosspost_source.status,
          post: publicPostId(post.crosspost_source.post_id),
          community: publicCommunityId(post.crosspost_source.community_id),
          captured_at: post.crosspost_source.captured_at ?? null,
          post_type: post.crosspost_source.post_type ?? null,
          title: post.crosspost_source.title ?? null,
          community_label: post.crosspost_source.community_label ?? null,
          community_route_slug: post.crosspost_source.community_route_slug ?? null,
          author_user: post.crosspost_source.author_user_id ? `usr_${post.crosspost_source.author_user_id}` : null,
          author_label: post.crosspost_source.author_label ?? null,
          thumbnail_ref: post.crosspost_source.thumbnail_ref ?? null,
        }
      : null,
    song_mode: post.song_mode,
    rights_basis: post.rights_basis,
    upstream_asset_refs: post.upstream_asset_refs,
    analysis_state: post.analysis_state,
    analysis_result_ref: post.analysis_result_ref,
    content_safety_state: post.content_safety_state,
    age_gate_policy: post.age_gate_policy,
    publish_failure_code: post.publish_failure_code ?? null,
    publish_failure_message: post.publish_failure_message ?? null,
    publish_failure_retryable: post.publish_failure_retryable ?? null,
    publish_failed_at: post.publish_failed_at ? unixSeconds(post.publish_failed_at) : null,
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

function pruneLinkEnrichmentTranslations(
  enrichment: Record<string, unknown> | null | undefined,
  resolvedLocale: string | null | undefined,
  postSourceLanguage: string | null | undefined,
): Record<string, unknown> | null | undefined {
  if (!enrichment || typeof enrichment !== "object") return enrichment
  const translations = enrichment.translations
  if (!translations || typeof translations !== "object" || Array.isArray(translations)) return enrichment
  const keys = Object.keys(translations)
  if (keys.length <= 1) return enrichment

  const kept: Record<string, unknown> = {}
  const sourceLanguage = typeof enrichment.source_language === "string"
    ? enrichment.source_language.split("-")[0]
    : typeof postSourceLanguage === "string"
      ? postSourceLanguage.split("-")[0]
      : null
  const resolvedBase = resolvedLocale?.split("-")[0] ?? null

  for (const key of keys) {
    const keyBase = key.split("-")[0]
    if (key === resolvedLocale || keyBase === resolvedBase || key === sourceLanguage || keyBase === sourceLanguage) {
      kept[key] = (translations as Record<string, unknown>)[key]
    }
  }

  if (Object.keys(kept).length === 0) {
    const firstKey = keys[0]
    kept[firstKey] = (translations as Record<string, unknown>)[firstKey]
  }

  return { ...enrichment, translations: kept }
}

export function serializeLocalizedPostResponse(response: LocalizedPostResponse, options?: { surface: "home_feed" }): ContractLocalizedPostResponse {
  const serializedPost = serializePost(response.post)
  if (options?.surface === "home_feed") {
    serializedPost.link_enrichment = pruneLinkEnrichmentTranslations(
      serializedPost.link_enrichment as Record<string, unknown> | null | undefined,
      response.resolved_locale,
      response.post.source_language,
    )
  }
  return {
    post: serializedPost,
    community: response.community ? serializeCommunityPreview(response.community) : null,
    viewer_gate_state: response.viewer_gate_state ?? null,
    author_community_role: response.author_community_role,
    thread_snapshot: response.thread_snapshot ? serializeCommentThreadSnapshot(response.thread_snapshot) : null,
    market_context: response.market_context,
    label: serializePostLabel(response.label),
    song_presentation: response.song_presentation ?? null,
    study_capability: response.study_capability ?? null,
    karaoke_capability: response.karaoke_capability ?? null,
    streak_summary: response.streak_summary ?? null,
    asset_story: response.post.asset_story ?? response.asset_story ?? null,
    derivative_sources: response.derivative_sources ?? null,
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
