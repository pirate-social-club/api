import { numberOrNull, requiredString, rowValue, stringOrNull } from "../sql-row"
import type { Post } from "../../types"

type LabelAssignmentResultJson = Post["label_assignment_result_json"]

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
  visibility: Post["visibility"]
  title: string | null
  body: string | null
  caption: string | null
  lyrics: string | null
  link_url: string | null
  link_og_image_url: string | null
  link_og_title: string | null
  media_refs_json: string | null
  song_artifact_bundle_id: string | null
  source_language: string | null
  translation_policy: Post["translation_policy"]
  access_mode: Post["access_mode"]
  asset_id: string | null
  parent_post_id: string | null
  upstream_asset_refs_json: string | null
  song_mode: Post["song_mode"]
  rights_basis: Post["rights_basis"]
  analysis_state: Post["analysis_state"]
  analysis_result_ref: string | null
  content_safety_state: Post["content_safety_state"]
  age_gate_policy: Post["age_gate_policy"]
  idempotency_key: string
  created_at: string
  updated_at: string
}

function parseJsonArray<T>(value: string | null): T[] | null {
  if (!value) {
    return null
  }
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? (parsed as T[]) : null
  } catch {
    return null
  }
}

function parseDisclosedQualifiers(value: string | null): Post["disclosed_qualifiers_json"] {
  const parsed = parseJsonArray<
    Post["disclosed_qualifiers_json"] extends Array<infer T> | null | undefined ? T : never
  >(value)
  return parsed ? (parsed as Post["disclosed_qualifiers_json"]) : null
}

function parseLabelAssignmentResult(value: string | null): LabelAssignmentResultJson {
  if (!value) {
    return null
  }

  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as LabelAssignmentResultJson
      : null
  } catch {
    return null
  }
}

function parseMediaRefs(value: string | null): Post["media_refs"] {
  const parsed = parseJsonArray<Post["media_refs"] extends Array<infer T> | undefined ? T : never>(value)
  return parsed ? (parsed as Post["media_refs"]) : undefined
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
    visibility: requiredString(row, "visibility") as Post["visibility"],
    title: stringOrNull(rowValue(row, "title")),
    body: stringOrNull(rowValue(row, "body")),
    caption: stringOrNull(rowValue(row, "caption")),
    lyrics: stringOrNull(rowValue(row, "lyrics")),
    link_url: stringOrNull(rowValue(row, "link_url")),
    link_og_image_url: stringOrNull(rowValue(row, "link_og_image_url")),
    link_og_title: stringOrNull(rowValue(row, "link_og_title")),
    media_refs_json: stringOrNull(rowValue(row, "media_refs_json")),
    song_artifact_bundle_id: stringOrNull(rowValue(row, "song_artifact_bundle_id")),
    source_language: stringOrNull(rowValue(row, "source_language")),
    translation_policy: stringOrNull(rowValue(row, "translation_policy")) as Post["translation_policy"],
    access_mode: stringOrNull(rowValue(row, "access_mode")) as Post["access_mode"],
    asset_id: stringOrNull(rowValue(row, "asset_id")),
    parent_post_id: stringOrNull(rowValue(row, "parent_post_id")),
    upstream_asset_refs_json: stringOrNull(rowValue(row, "upstream_asset_refs_json")),
    song_mode: stringOrNull(rowValue(row, "song_mode")) as Post["song_mode"],
    rights_basis: stringOrNull(rowValue(row, "rights_basis")) as Post["rights_basis"],
    analysis_state: requiredString(row, "analysis_state") as Post["analysis_state"],
    analysis_result_ref: stringOrNull(rowValue(row, "analysis_result_ref")),
    content_safety_state: requiredString(row, "content_safety_state") as Post["content_safety_state"],
    age_gate_policy: requiredString(row, "age_gate_policy") as Post["age_gate_policy"],
    idempotency_key: stringOrNull(rowValue(row, "idempotency_key")) ?? "",
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

export function serializePost(row: PostRow): Post {
  return {
    post_id: row.post_id,
    community_id: row.community_id,
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
    visibility: row.visibility,
    title: row.title,
    body: row.body,
    caption: row.caption,
    link_url: row.link_url,
    link_og_image_url: row.link_og_image_url,
    link_og_title: row.link_og_title,
    media_refs: parseMediaRefs(row.media_refs_json),
    song_artifact_bundle_id: row.song_artifact_bundle_id,
    source_language: row.source_language,
    translation_policy: row.translation_policy,
    access_mode: row.access_mode,
    asset_id: row.asset_id,
    parent_post_id: row.parent_post_id,
    upstream_asset_refs: parseJsonArray<string>(row.upstream_asset_refs_json) ?? undefined,
    song_mode: row.song_mode,
    rights_basis: row.rights_basis,
    analysis_state: row.analysis_state,
    analysis_result_ref: row.analysis_result_ref,
    content_safety_state: row.content_safety_state,
    age_gate_policy: row.age_gate_policy,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}
