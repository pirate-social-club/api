import type { CommunityPostProjectionRow } from "../auth/auth-db-rows"
import type { Client } from "../sql-client"
import { decodePublicSongArtifactUploadId } from "../public-ids"
import { rowValue } from "../sql-row"
import { withTransaction } from "../transactions"

const ARTIFACT_CONTENT_PATH = /\/song-artifact-uploads\/([^/?#]+)\/content(?:[?#]|$)/gu

export function projectedPublicSongArtifactUploadIds(projectedPayloadJson: string): string[] {
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
    for (const match of storageRef.matchAll(ARTIFACT_CONTENT_PATH)) {
      const encodedUploadId = match[1]
      if (!encodedUploadId) continue
      try {
        uploadIds.add(decodePublicSongArtifactUploadId(decodeURIComponent(encodedUploadId)))
      } catch {
        // A malformed reference cannot grant public byte access.
      }
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
    ? projectedPublicSongArtifactUploadIds(projection.projected_payload_json)
    : []
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
}

export async function hasPublicSongArtifactGrant(input: {
  client: Client
  communityId: string
  songArtifactUploadId: string
}): Promise<boolean> {
  const result = await input.client.execute({
    sql: `
      SELECT 1 AS granted
      FROM public_song_artifact_grants
      WHERE community_id = ?1
        AND song_artifact_upload_id = ?2
      LIMIT 1
    `,
    args: [input.communityId, input.songArtifactUploadId],
  })
  return rowValue(result.rows[0], "granted") === 1
}

export async function recordPublicSongArtifactGrant(input: {
  client: Client
  communityId: string
  songArtifactUploadId: string
  sourcePostId: string
  updatedAt: string
}): Promise<void> {
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
}
