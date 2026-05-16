import type { DbExecutor } from "../db-helpers"

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

export type PostProjectionSchema = {
  hasCommentLockColumns: boolean
  hasCrosspostSourceJson: boolean
}

export async function resolvePostProjectionSchema(executor: DbExecutor): Promise<PostProjectionSchema> {
  const result = await executor.execute("PRAGMA table_info(posts)")
  const columnNames = new Set(result.rows.map((row) => String(row.name ?? "")))
  return {
    hasCommentLockColumns: columnNames.has("comments_locked")
      && columnNames.has("comments_locked_at")
      && columnNames.has("comments_locked_by_user_id")
      && columnNames.has("comments_lock_reason"),
    hasCrosspostSourceJson: columnNames.has("crosspost_source_json"),
  }
}

export function postSelectColumnsForSchema(schema: PostProjectionSchema): string {
  const crosspostSourceProjection = schema.hasCrosspostSourceJson
    ? boundedJsonProjection("crosspost_source_json")
    : "NULL AS crosspost_source_json"
  const commentLockProjection = schema.hasCommentLockColumns
    ? "comments_locked, comments_locked_at, comments_locked_by_user_id, comments_lock_reason"
    : "0 AS comments_locked, NULL AS comments_locked_at, NULL AS comments_locked_by_user_id, NULL AS comments_lock_reason"

  return `
  post_id, community_id, author_user_id, authorship_mode, agent_id, agent_ownership_record_id,
  identity_mode, anonymous_scope, anonymous_label, agent_display_name_snapshot,
  agent_owner_handle_snapshot, agent_ownership_provider_snapshot, agent_handle_snapshot, disclosed_qualifiers_json,
  label_id, label_assignment_status, label_assigned_by, label_assigned_at, label_ai_confidence,
  label_assignment_error, label_assignment_model, ${boundedJsonProjection("label_assignment_result_json")},
  post_type, status, ${commentLockProjection},
  visibility, title, body, caption, lyrics,
  link_url, link_og_image_url, link_og_title, ${boundedJsonProjection("link_enrichment_snapshot_json", sqlStringLiteral(OVERSIZED_LINK_ENRICHMENT_SNAPSHOT_JSON))}, link_enrichment_synced_at,
  ${boundedJsonProjection("embeds_json")}, ${boundedJsonProjection("media_refs_json")}, song_artifact_bundle_id, song_title,
  song_cover_art_ref, song_duration_ms, source_language, translation_policy,
  access_mode, asset_id, (
    SELECT live_room_id
    FROM live_rooms
    WHERE live_rooms.anchor_post_id = posts.post_id
    LIMIT 1
  ) AS anchor_live_room_id, (
    SELECT status
    FROM live_rooms
    WHERE live_rooms.anchor_post_id = posts.post_id
      AND live_rooms.visibility = 'public'
    LIMIT 1
  ) AS anchor_live_room_status, parent_post_id, ${crosspostSourceProjection}, ${boundedJsonProjection("upstream_asset_refs_json")}, song_mode, rights_basis, analysis_state, analysis_result_ref,
  content_safety_state, age_gate_policy, idempotency_key, created_at, updated_at
`
}
