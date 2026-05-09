import { numberOrNull, requiredNumber, requiredString, rowValue, stringOrNull } from "../sql-row"
import type { Post } from "../../types"

type LabelAssignmentResultJson = Post["label_assignment_result_json"]

export const MAX_POST_JSON_PROJECTION_LENGTH = 128 * 1024

export const OVERSIZED_LINK_ENRICHMENT_SNAPSHOT_JSON = JSON.stringify({
  version: 1,
  provider: "manual",
  status: "unavailable",
  normalized_url: "",
  canonical_url: null,
  title: null,
  description: null,
  source_language: null,
  publisher: null,
  published_at: null,
  image_url: null,
  summary: {
    status: "unavailable",
    summary_paragraph: null,
    short_summary: null,
    key_points: [],
    generated_at: null,
    model: null,
  },
  error: "link_enrichment_snapshot_too_large",
  fetched_at: null,
})

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function boundedJsonProjection(columnName: string, replacementSql: string = "NULL"): string {
  return `CASE WHEN ${columnName} IS NOT NULL AND length(${columnName}) > ${MAX_POST_JSON_PROJECTION_LENGTH} THEN ${replacementSql} ELSE ${columnName} END AS ${columnName}`
}

export function boundedPostJsonProjection(value: string | null | undefined, replacement: string | null = null): string | null {
  if (value == null) {
    return null
  }
  return value.length > MAX_POST_JSON_PROJECTION_LENGTH ? replacement : value
}

export const POST_SELECT_COLUMNS = `
  post_id, community_id, author_user_id, authorship_mode, agent_id, agent_ownership_record_id,
  identity_mode, anonymous_scope, anonymous_label, agent_display_name_snapshot,
  agent_owner_handle_snapshot, agent_ownership_provider_snapshot, agent_handle_snapshot, disclosed_qualifiers_json,
  label_id, label_assignment_status, label_assigned_by, label_assigned_at, label_ai_confidence,
  label_assignment_error, label_assignment_model, ${boundedJsonProjection("label_assignment_result_json")},
  post_type, status, 0 AS comments_locked, NULL AS comments_locked_at, NULL AS comments_locked_by_user_id, NULL AS comments_lock_reason,
  visibility, title, body, caption, lyrics,
  link_url, link_og_image_url, link_og_title, ${boundedJsonProjection("link_enrichment_snapshot_json", sqlStringLiteral(OVERSIZED_LINK_ENRICHMENT_SNAPSHOT_JSON))}, link_enrichment_synced_at,
  ${boundedJsonProjection("embeds_json")}, ${boundedJsonProjection("media_refs_json")}, song_artifact_bundle_id, song_title, source_language, translation_policy,
  access_mode, asset_id, (
    SELECT live_room_id
    FROM live_rooms
    WHERE live_rooms.anchor_post_id = posts.post_id
    LIMIT 1
  ) AS anchor_live_room_id, parent_post_id, ${boundedJsonProjection("upstream_asset_refs_json")}, song_mode, rights_basis, analysis_state, analysis_result_ref,
  content_safety_state, age_gate_policy, idempotency_key, created_at, updated_at
`

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
  embeds_json: string | null
  media_refs_json: string | null
  song_artifact_bundle_id: string | null
  song_title: string | null
  source_language: string | null
  translation_policy: Post["translation_policy"]
  access_mode: Post["access_mode"]
  asset_id: string | null
  anchor_live_room_id: string | null
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

function parseObject(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null
  }

  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function parseMediaRefs(value: string | null): Post["media_refs"] {
  const parsed = parseJsonArray<Post["media_refs"] extends Array<infer T> | undefined ? T : never>(value)
  return parsed ? (parsed as Post["media_refs"]) : undefined
}

function parseEmbeds(value: string | null): Post["embeds"] {
  const parsed = parseJsonArray<Post["embeds"] extends Array<infer T> | null | undefined ? T : never>(value)
  return parsed ? (parsed as Post["embeds"]) : undefined
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
    embeds_json: stringOrNull(rowValue(row, "embeds_json")),
    media_refs_json: stringOrNull(rowValue(row, "media_refs_json")),
    song_artifact_bundle_id: stringOrNull(rowValue(row, "song_artifact_bundle_id")),
    song_title: stringOrNull(rowValue(row, "song_title")),
    source_language: stringOrNull(rowValue(row, "source_language")),
    translation_policy: stringOrNull(rowValue(row, "translation_policy")) as Post["translation_policy"],
    access_mode: stringOrNull(rowValue(row, "access_mode")) as Post["access_mode"],
    asset_id: stringOrNull(rowValue(row, "asset_id")),
    anchor_live_room_id: stringOrNull(rowValue(row, "anchor_live_room_id")),
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
    embeds: parseEmbeds(row.embeds_json),
    media_refs: parseMediaRefs(row.media_refs_json),
    song_artifact_bundle_id: row.song_artifact_bundle_id,
    song_title: row.song_title,
    source_language: row.source_language,
    translation_policy: row.translation_policy,
    access_mode: row.access_mode,
    asset_id: row.asset_id,
    anchor_live_room_id: row.anchor_live_room_id,
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
