import type { CommunityPostProjectionRow } from "../auth/auth-db-rows"
import type { Client } from "../sql-client"
import { decodePublicCommunityId, decodePublicSongArtifactUploadId } from "../public-ids"
import { rowValue } from "../sql-row"
import { withTransaction } from "../transactions"

const TRUSTED_ARTIFACT_HOST = /(?:^|\.)pirate(?:\.sc)?$/u

function missingGrantTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /(?:no such table|relation .* does not exist).*public_song_artifact_grants/iu.test(message)
}

export function projectedPublicSongArtifactUploadIds(projectedPayloadJson: string, communityId: string): string[] {
  let payload: { media_refs?: unknown };
  try {
    payload = JSON.parse(projectedPayloadJson) as { media_refs?: unknown }
  } catch {
    return []
  }
  if (!Array.isArray(payload.media_refs)) return []

  const uploadIds = new Set<string>()
  for (const mediaRef of payload.media_refs) {
    if (!mediaRef || typeof mediaRef !== "object") continue
    const storageRef = (mediaRef as { storage_ref?: unknown }).storage_ref
    if (typeof storageRef !== "string") continue
    try {
      const url = new URL(storageRef)
      if (!/^https?:$/u.test(url.protocol) || !TRUSTED_ARTIFACT_HOST.test(url.hostname)) continue
      const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent)
      if (
        segments.length !== 5
        || !["communities", "public-communities"].includes(segments[0] ?? "")
        || decodePublicCommunityId(segments[1] ?? "") !== communityId
        || segments[2] !== "song-artifact-uploads"
        || segments[4] !== "content"
      ) continue
      uploadIds.add(decodePublicSongArtifactUploadId(segments[3] ?? ""))
    } catch {
      // A malformed or non-Pirate reference cannot grant public byte access.
    }
  }
  return [...uploadIds]
}

function projectionCanGrantPublicArtifactAccess(projection: CommunityPostProjectionRow): boolean {
  if (projection.status !== "published") return false
  let accessMode: unknown = null
  try {
    accessMode = (JSON.parse(projection.projected_payload_json) as { access_mode?: unknown }).access_mode
  } catch {
    return false
  }
  return accessMode === "locked"
    || (projection.visibility === "public" && (accessMode == null || accessMode === "public"))
}

export async function syncPublicSongArtifactGrantsForProjection(
  client: Client,
  projection: CommunityPostProjectionRow,
): Promise<void> {
  const uploadIds = projectionCanGrantPublicArtifactAccess(projection)
    ? projectedPublicSongArtifactUploadIds(projection.projected_payload_json, projection.community_id)
    : []
  try {
    await withTransaction(client, "write", async (tx) => {
    await tx.execute({
      sql: "DELETE FROM public_song_artifact_grants WHERE community_id = ?1 AND source_post_id = ?2",
      args: [projection.community_id, projection.source_post_id],
    })
    if (uploadIds.length === 0) return
    await tx.batch(uploadIds.map((uploadId) => ({
      sql: `
        INSERT INTO public_song_artifact_grants (
          community_id, song_artifact_upload_id, source_post_id, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?4)
        ON CONFLICT (community_id, song_artifact_upload_id, source_post_id)
        DO UPDATE SET updated_at = excluded.updated_at
      `,
      args: [projection.community_id, uploadId, projection.source_post_id, projection.updated_at],
    })))
    })
  } catch (error) {
    if (!missingGrantTable(error)) throw error
  }
}

export async function hasPublicSongArtifactGrant(input: {
  client: Client
  communityId: string
  songArtifactUploadId: string
}): Promise<boolean> {
  try {
    const result = await input.client.execute({
      sql: `
        SELECT 1 AS granted
        FROM public_song_artifact_grants AS grant_row
        INNER JOIN community_post_projections AS projection
          ON projection.community_id = grant_row.community_id
          AND projection.source_post_id = grant_row.source_post_id
        INNER JOIN communities AS community ON community.community_id = grant_row.community_id
        WHERE grant_row.community_id = ?1
          AND grant_row.song_artifact_upload_id = ?2
          AND community.status = 'active'
          AND projection.status = 'published'
          AND json_valid(projection.projected_payload_json)
          AND (
            (projection.visibility = 'public' AND (
              json_extract(projection.projected_payload_json, '$.access_mode') IS NULL
              OR json_extract(projection.projected_payload_json, '$.access_mode') = 'public'
            ))
            OR json_extract(projection.projected_payload_json, '$.access_mode') = 'locked'
          )
        LIMIT 1
      `,
      args: [input.communityId, input.songArtifactUploadId],
    })
    return rowValue(result.rows[0], "granted") === 1
  } catch (error) {
    if (missingGrantTable(error)) return false
    throw error
  }
}

export async function recordPublicSongArtifactGrant(input: {
  client: Client
  communityId: string
  songArtifactUploadId: string
  sourcePostId: string
  updatedAt: string
}): Promise<void> {
  try {
    await input.client.execute({
    sql: `
      INSERT INTO public_song_artifact_grants (
        community_id, song_artifact_upload_id, source_post_id, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?4)
      ON CONFLICT (community_id, song_artifact_upload_id, source_post_id)
      DO UPDATE SET updated_at = excluded.updated_at
    `,
    args: [
      input.communityId,
      input.songArtifactUploadId,
      input.sourcePostId,
      input.updatedAt,
    ],
    })
  } catch (error) {
    if (!missingGrantTable(error)) throw error
  }
}
