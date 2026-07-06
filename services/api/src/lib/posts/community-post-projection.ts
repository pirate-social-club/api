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
  hasAssetStoryColumns: boolean
  hasCommentLockColumns: boolean
  hasCrosspostSourceJson: boolean
  hasPostEvents: boolean
  hasSongAnnotationsUrl: boolean
  hasSongCoverArtRef: boolean
  hasSongDurationMs: boolean
  hasAsyncPublishColumns: boolean
}

export async function resolvePostProjectionSchema(executor: DbExecutor): Promise<PostProjectionSchema> {
  const result = await executor.execute("PRAGMA table_info(posts)")
  const columnNames = new Set(result.rows.map((row) => String(row.name ?? "")))
  const assetResult = await executor.execute("PRAGMA table_info(assets)")
  const assetColumnNames = new Set(assetResult.rows.map((row) => String(row.name ?? "")))
  const postEventsResult = await executor.execute("PRAGMA table_info(post_events)")
  return {
    hasAssetStoryColumns: assetColumnNames.has("asset_id")
      && assetColumnNames.has("community_id")
      && assetColumnNames.has("story_ip_id")
      && assetColumnNames.has("story_royalty_registration_status"),
    hasCommentLockColumns: columnNames.has("comments_locked")
      && columnNames.has("comments_locked_at")
      && columnNames.has("comments_locked_by_user_id")
      && columnNames.has("comments_lock_reason"),
    hasCrosspostSourceJson: columnNames.has("crosspost_source_json"),
    hasPostEvents: postEventsResult.rows.length > 0,
    hasSongAnnotationsUrl: columnNames.has("song_annotations_url"),
    hasSongCoverArtRef: columnNames.has("song_cover_art_ref"),
    hasSongDurationMs: columnNames.has("song_duration_ms"),
    hasAsyncPublishColumns: columnNames.has("idempotency_body_hash")
      && columnNames.has("publish_failure_code")
      && columnNames.has("publish_failure_message")
      && columnNames.has("publish_failure_retryable")
      && columnNames.has("publish_failed_at"),
  }
}

export function postSelectColumnsForSchema(schema: PostProjectionSchema): string {
  const assetStoryProjection = schema.hasAssetStoryColumns
    ? "post_asset_story.asset_story_ip_id, post_asset_story.asset_story_royalty_registration_status"
    : "NULL AS asset_story_ip_id, NULL AS asset_story_royalty_registration_status"
  const crosspostSourceProjection = schema.hasCrosspostSourceJson
    ? boundedJsonProjection("crosspost_source_json")
    : "NULL AS crosspost_source_json"
  const commentLockProjection = schema.hasCommentLockColumns
    ? "comments_locked, comments_locked_at, comments_locked_by_user_id, comments_lock_reason"
    : "0 AS comments_locked, NULL AS comments_locked_at, NULL AS comments_locked_by_user_id, NULL AS comments_lock_reason"
  const songAnnotationsUrlProjection = schema.hasSongAnnotationsUrl
    ? "song_annotations_url"
    : "NULL AS song_annotations_url"
  const songCoverArtRefProjection = schema.hasSongCoverArtRef
    ? "song_cover_art_ref"
    : "NULL AS song_cover_art_ref"
  const songDurationMsProjection = schema.hasSongDurationMs
    ? "song_duration_ms"
    : "NULL AS song_duration_ms"
  const asyncPublishProjection = schema.hasAsyncPublishColumns
    ? "idempotency_body_hash, publish_failure_code, publish_failure_message, publish_failure_retryable, publish_failed_at"
    : "NULL AS idempotency_body_hash, NULL AS publish_failure_code, NULL AS publish_failure_message, NULL AS publish_failure_retryable, NULL AS publish_failed_at"
  const eventProjection = schema.hasPostEvents
    ? `
  (
    SELECT event_start_at
    FROM post_events
    WHERE post_events.post_id = posts.post_id
    LIMIT 1
  ) AS event_start_at, (
    SELECT event_end_at
    FROM post_events
    WHERE post_events.post_id = posts.post_id
    LIMIT 1
  ) AS event_end_at, (
    SELECT event_timezone
    FROM post_events
    WHERE post_events.post_id = posts.post_id
    LIMIT 1
  ) AS event_timezone, (
    SELECT location_name
    FROM post_events
    WHERE post_events.post_id = posts.post_id
    LIMIT 1
  ) AS event_location_name, (
    SELECT address
    FROM post_events
    WHERE post_events.post_id = posts.post_id
    LIMIT 1
  ) AS event_address, (
    SELECT is_online
    FROM post_events
    WHERE post_events.post_id = posts.post_id
    LIMIT 1
  ) AS event_is_online, (
    SELECT event_url
    FROM post_events
    WHERE post_events.post_id = posts.post_id
    LIMIT 1
  ) AS event_url, (
    SELECT status
    FROM post_events
    WHERE post_events.post_id = posts.post_id
    LIMIT 1
  ) AS event_status, (
    SELECT CASE
      WHEN place_json IS NOT NULL AND length(place_json) > ${MAX_POST_JSON_PROJECTION_LENGTH} THEN NULL
      ELSE place_json
    END
    FROM post_events
    WHERE post_events.post_id = posts.post_id
    LIMIT 1
  ) AS event_place_json`
    : `
  NULL AS event_start_at, NULL AS event_end_at, NULL AS event_timezone,
  NULL AS event_location_name, NULL AS event_address, NULL AS event_is_online,
  NULL AS event_url, NULL AS event_status, NULL AS event_place_json`

  return `
  post_id, community_id, author_user_id, authorship_mode, agent_id, agent_ownership_record_id,
  identity_mode, anonymous_scope, anonymous_label, agent_display_name_snapshot,
  agent_owner_handle_snapshot, agent_ownership_provider_snapshot, agent_handle_snapshot, disclosed_qualifiers_json,
  label_id, label_assignment_status, label_assigned_by, label_assigned_at, label_ai_confidence,
  label_assignment_error, label_assignment_model, ${boundedJsonProjection("label_assignment_result_json")},
  post_type, status, ${commentLockProjection},
  visibility, title, body, caption, lyrics,
  link_url, link_og_image_url, link_og_title, ${boundedJsonProjection("link_enrichment_snapshot_json", sqlStringLiteral(OVERSIZED_LINK_ENRICHMENT_SNAPSHOT_JSON))}, link_enrichment_synced_at,
  ${eventProjection},
  ${boundedJsonProjection("embeds_json")}, ${boundedJsonProjection("media_refs_json")}, song_artifact_bundle_id, song_title,
  ${songAnnotationsUrlProjection}, ${songCoverArtRefProjection}, ${songDurationMsProjection}, source_language, translation_policy,
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
  content_safety_state, age_gate_policy, ${assetStoryProjection}, idempotency_key, ${asyncPublishProjection}, created_at, updated_at
`
}

export function postAssetStoryJoinForSchema(schema: PostProjectionSchema): string {
  if (!schema.hasAssetStoryColumns) {
    return ""
  }

  return `
      LEFT JOIN (
        SELECT community_id AS asset_story_community_id,
               asset_id AS asset_story_asset_id,
               story_ip_id AS asset_story_ip_id,
               story_royalty_registration_status AS asset_story_royalty_registration_status
        FROM assets
      ) AS post_asset_story
        ON post_asset_story.asset_story_community_id = posts.community_id
       AND post_asset_story.asset_story_asset_id = posts.asset_id
  `
}

export function requiredAssetRowFilterForSchema(schema: PostProjectionSchema): string {
  if (!schema.hasAssetStoryColumns) {
    return ""
  }

  return `
        AND (
          posts.asset_id IS NULL
          OR posts.post_type NOT IN ('song', 'video')
          OR post_asset_story.asset_story_asset_id IS NOT NULL
        )
  `
}
