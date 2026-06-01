import { boolOrNull, numberOrNull, requiredNumber, requiredString, rowValue, stringOrNull } from "../sql-row"
import type { Post, PostEventPlace, PostEventStatus } from "../../types"
import {
  parseCrosspostSource,
  parseDisclosedQualifiers,
  parseEmbeds,
  parseLabelAssignmentResult,
  parseMediaRefs,
  parseObject,
  parseStringArray,
} from "./community-post-json-fields"

export type PostRow = {
  post_id: string
  community_id: string
  author_user_id: string | null
  authorship_mode: Post["authorship_mode"]
  agent_id: string | null
  agent_ownership_record_id: string | null
  identity_mode: Post["identity_mode"]
  anonymous_scope: Post["anonymous_scope"]
  anonymous_label: string | null
  agent_handle_snapshot: string | null
  agent_display_name_snapshot: string | null
  agent_owner_handle_snapshot: string | null
  agent_ownership_provider_snapshot: string | null
  disclosed_qualifiers_json: string | null
  label_id: string | null
  label_assignment_status: Post["label_assignment_status"]
  label_assigned_by: Post["label_assigned_by"]
  label_assigned_at: string | null
  label_ai_confidence: number | null
  label_assignment_error: string | null
  label_assignment_model: string | null
  label_assignment_result_json: string | null
  post_type: Post["post_type"]
  status: Post["status"]
  comments_locked: number
  comments_locked_at: string | null
  comments_locked_by_user_id: string | null
  comments_lock_reason: string | null
  visibility: Post["visibility"]
  title: string | null
  body: string | null
  caption: string | null
  lyrics: string | null
  link_url: string | null
  link_og_image_url: string | null
  link_og_title: string | null
  link_enrichment_snapshot_json: string | null
  link_enrichment_synced_at: string | null
  event_start_at: number | null
  event_end_at: number | null
  event_timezone: string | null
  event_location_name: string | null
  event_address: string | null
  event_is_online: number | null
  event_url: string | null
  event_status: PostEventStatus | null
  event_place_json: string | null
  embeds_json: string | null
  media_refs_json: string | null
  song_artifact_bundle_id: string | null
  song_title: string | null
  song_annotations_url: string | null
  song_cover_art_ref: string | null
  song_duration_ms: number | null
  source_language: string | null
  source_language_confidence: number | null
  source_language_reliable: number | null
  source_language_detector: string | null
  source_language_detected_at: string | null
  source_language_source_hash: string | null
  translation_policy: Post["translation_policy"]
  access_mode: Post["access_mode"]
  asset_id: string | null
  anchor_live_room_id: string | null
  anchor_live_room_status: Post["anchor_live_room_status"]
  parent_post_id: string | null
  crosspost_source_json: string | null
  upstream_asset_refs_json: string | null
  song_mode: Post["song_mode"]
  rights_basis: Post["rights_basis"]
  analysis_state: Post["analysis_state"]
  analysis_result_ref: string | null
  content_safety_state: Post["content_safety_state"]
  age_gate_policy: Post["age_gate_policy"]
  asset_story_ip_id: string | null
  asset_story_royalty_registration_status: "none" | "pending" | "registered" | "failed" | null
  idempotency_key: string
  created_at: string
  updated_at: string
}

export function toPostRow(row: unknown): PostRow {
  return {
    post_id: requiredString(row, "post_id"),
    community_id: requiredString(row, "community_id"),
    author_user_id: stringOrNull(rowValue(row, "author_user_id")),
    authorship_mode: requiredString(row, "authorship_mode") as Post["authorship_mode"],
    agent_id: stringOrNull(rowValue(row, "agent_id")),
    agent_ownership_record_id: stringOrNull(rowValue(row, "agent_ownership_record_id")),
    identity_mode: requiredString(row, "identity_mode") as Post["identity_mode"],
    anonymous_scope: stringOrNull(rowValue(row, "anonymous_scope")) as Post["anonymous_scope"],
    anonymous_label: stringOrNull(rowValue(row, "anonymous_label")),
    agent_handle_snapshot: stringOrNull(rowValue(row, "agent_handle_snapshot")),
    agent_display_name_snapshot: stringOrNull(rowValue(row, "agent_display_name_snapshot")),
    agent_owner_handle_snapshot: stringOrNull(rowValue(row, "agent_owner_handle_snapshot")),
    agent_ownership_provider_snapshot: stringOrNull(rowValue(row, "agent_ownership_provider_snapshot")),
    disclosed_qualifiers_json: stringOrNull(rowValue(row, "disclosed_qualifiers_json")),
    label_id: stringOrNull(rowValue(row, "label_id")),
    label_assignment_status: stringOrNull(rowValue(row, "label_assignment_status")) as Post["label_assignment_status"],
    label_assigned_by: stringOrNull(rowValue(row, "label_assigned_by")) as Post["label_assigned_by"],
    label_assigned_at: stringOrNull(rowValue(row, "label_assigned_at")),
    label_ai_confidence: numberOrNull(rowValue(row, "label_ai_confidence")),
    label_assignment_error: stringOrNull(rowValue(row, "label_assignment_error")),
    label_assignment_model: stringOrNull(rowValue(row, "label_assignment_model")),
    label_assignment_result_json: stringOrNull(rowValue(row, "label_assignment_result_json")),
    post_type: requiredString(row, "post_type") as Post["post_type"],
    status: requiredString(row, "status") as Post["status"],
    comments_locked: requiredNumber(row, "comments_locked"),
    comments_locked_at: stringOrNull(rowValue(row, "comments_locked_at")),
    comments_locked_by_user_id: stringOrNull(rowValue(row, "comments_locked_by_user_id")),
    comments_lock_reason: stringOrNull(rowValue(row, "comments_lock_reason")),
    visibility: requiredString(row, "visibility") as Post["visibility"],
    title: stringOrNull(rowValue(row, "title")),
    body: stringOrNull(rowValue(row, "body")),
    caption: stringOrNull(rowValue(row, "caption")),
    lyrics: stringOrNull(rowValue(row, "lyrics")),
    link_url: stringOrNull(rowValue(row, "link_url")),
    link_og_image_url: stringOrNull(rowValue(row, "link_og_image_url")),
    link_og_title: stringOrNull(rowValue(row, "link_og_title")),
    link_enrichment_snapshot_json: stringOrNull(rowValue(row, "link_enrichment_snapshot_json")),
    link_enrichment_synced_at: stringOrNull(rowValue(row, "link_enrichment_synced_at")),
    event_start_at: numberOrNull(rowValue(row, "event_start_at")),
    event_end_at: numberOrNull(rowValue(row, "event_end_at")),
    event_timezone: stringOrNull(rowValue(row, "event_timezone")),
    event_location_name: stringOrNull(rowValue(row, "event_location_name")),
    event_address: stringOrNull(rowValue(row, "event_address")),
    event_is_online: numberOrNull(rowValue(row, "event_is_online")),
    event_url: stringOrNull(rowValue(row, "event_url")),
    event_status: stringOrNull(rowValue(row, "event_status")) as PostRow["event_status"],
    event_place_json: stringOrNull(rowValue(row, "event_place_json")),
    embeds_json: stringOrNull(rowValue(row, "embeds_json")),
    media_refs_json: stringOrNull(rowValue(row, "media_refs_json")),
    song_artifact_bundle_id: stringOrNull(rowValue(row, "song_artifact_bundle_id")),
    song_title: stringOrNull(rowValue(row, "song_title")),
    song_annotations_url: stringOrNull(rowValue(row, "song_annotations_url")),
    song_cover_art_ref: stringOrNull(rowValue(row, "song_cover_art_ref")),
    song_duration_ms: numberOrNull(rowValue(row, "song_duration_ms")),
    source_language: stringOrNull(rowValue(row, "source_language")),
    source_language_confidence: numberOrNull(rowValue(row, "source_language_confidence")),
    source_language_reliable: numberOrNull(rowValue(row, "source_language_reliable")),
    source_language_detector: stringOrNull(rowValue(row, "source_language_detector")),
    source_language_detected_at: stringOrNull(rowValue(row, "source_language_detected_at")),
    source_language_source_hash: stringOrNull(rowValue(row, "source_language_source_hash")),
    translation_policy: stringOrNull(rowValue(row, "translation_policy")) as Post["translation_policy"],
    access_mode: stringOrNull(rowValue(row, "access_mode")) as Post["access_mode"],
    asset_id: stringOrNull(rowValue(row, "asset_id")),
    anchor_live_room_id: stringOrNull(rowValue(row, "anchor_live_room_id")),
    anchor_live_room_status: stringOrNull(rowValue(row, "anchor_live_room_status")) as Post["anchor_live_room_status"],
    parent_post_id: stringOrNull(rowValue(row, "parent_post_id")),
    crosspost_source_json: stringOrNull(rowValue(row, "crosspost_source_json")),
    upstream_asset_refs_json: stringOrNull(rowValue(row, "upstream_asset_refs_json")),
    song_mode: stringOrNull(rowValue(row, "song_mode")) as Post["song_mode"],
    rights_basis: stringOrNull(rowValue(row, "rights_basis")) as Post["rights_basis"],
    analysis_state: requiredString(row, "analysis_state") as Post["analysis_state"],
    analysis_result_ref: stringOrNull(rowValue(row, "analysis_result_ref")),
    content_safety_state: requiredString(row, "content_safety_state") as Post["content_safety_state"],
    age_gate_policy: requiredString(row, "age_gate_policy") as Post["age_gate_policy"],
    asset_story_ip_id: stringOrNull(rowValue(row, "asset_story_ip_id")),
    asset_story_royalty_registration_status: stringOrNull(rowValue(row, "asset_story_royalty_registration_status")) as PostRow["asset_story_royalty_registration_status"],
    idempotency_key: stringOrNull(rowValue(row, "idempotency_key")) ?? "",
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

export function serializePost(row: PostRow): Post {
  return {
    post_id: row.post_id,
    community_id: row.community_id,
    author_user_id: row.author_user_id,
    authorship_mode: row.authorship_mode,
    agent_id: row.agent_id,
    agent_ownership_record_id: row.agent_ownership_record_id,
    identity_mode: row.identity_mode,
    anonymous_scope: row.anonymous_scope,
    anonymous_label: row.anonymous_label,
    agent_handle_snapshot: row.agent_handle_snapshot,
    agent_display_name_snapshot: row.agent_display_name_snapshot,
    agent_owner_handle_snapshot: row.agent_owner_handle_snapshot,
    agent_ownership_provider_snapshot: row.agent_ownership_provider_snapshot,
    disclosed_qualifiers_json: parseDisclosedQualifiers(row.disclosed_qualifiers_json),
    label_id: row.label_id,
    label_assignment_status: row.label_assignment_status,
    label_assigned_by: row.label_assigned_by,
    label_assigned_at: row.label_assigned_at,
    label_ai_confidence: row.label_ai_confidence,
    label_assignment_error: row.label_assignment_error,
    label_assignment_model: row.label_assignment_model,
    label_assignment_result_json: parseLabelAssignmentResult(row.label_assignment_result_json),
    post_type: row.post_type,
    status: row.status,
    comments_locked: row.comments_locked === 1,
    comments_locked_at: row.comments_locked_at,
    comments_locked_by_user_id: row.comments_locked_by_user_id,
    comments_lock_reason: row.comments_lock_reason,
    visibility: row.visibility,
    title: row.title,
    body: row.body,
    caption: row.caption,
    lyrics: row.lyrics,
    link_url: row.link_url,
    link_og_image_url: row.link_og_image_url,
    link_og_title: row.link_og_title,
    link_enrichment_snapshot_json: parseObject(row.link_enrichment_snapshot_json),
    link_enrichment_synced_at: row.link_enrichment_synced_at,
    event: row.event_start_at != null && row.event_timezone
      ? {
          starts_at: row.event_start_at,
          ends_at: row.event_end_at,
          timezone: row.event_timezone,
          location_name: row.event_location_name,
          address: row.event_address,
          is_online: row.event_is_online === 1,
          event_url: row.event_url,
          status: row.event_status ?? "scheduled",
          place: parseObject(row.event_place_json) as PostEventPlace | null,
        }
      : null,
    embeds: parseEmbeds(row.embeds_json),
    media_refs: parseMediaRefs(row.media_refs_json),
    song_artifact_bundle_id: row.song_artifact_bundle_id,
    song_title: row.song_title,
    song_annotations_url: row.song_annotations_url,
    song_cover_art_ref: row.song_cover_art_ref,
    song_duration_ms: row.song_duration_ms,
    source_language: row.source_language,
    source_language_confidence: row.source_language_confidence,
    source_language_reliable: boolOrNull(row.source_language_reliable) ?? false,
    source_language_detector: row.source_language_detector,
    source_language_detected_at: row.source_language_detected_at,
    source_language_source_hash: row.source_language_source_hash,
    translation_policy: row.translation_policy,
    access_mode: row.access_mode,
    asset_id: row.asset_id,
    anchor_live_room_id: row.anchor_live_room_id,
    anchor_live_room_status: row.anchor_live_room_status,
    parent_post_id: row.parent_post_id,
    crosspost_source: parseCrosspostSource(row.crosspost_source_json),
    upstream_asset_refs: parseStringArray(row.upstream_asset_refs_json),
    song_mode: row.song_mode,
    rights_basis: row.rights_basis,
    analysis_state: row.analysis_state,
    analysis_result_ref: row.analysis_result_ref,
    content_safety_state: row.content_safety_state,
    age_gate_policy: row.age_gate_policy,
    asset_story: row.asset_story_royalty_registration_status
      ? {
          story_ip: row.asset_story_ip_id,
          story_royalty_registration_status: row.asset_story_royalty_registration_status,
        }
      : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}
