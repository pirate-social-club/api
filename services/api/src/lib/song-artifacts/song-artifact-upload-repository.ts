import { executeFirst } from "../db-helpers"
import type { Client } from "../sql-client"
import type { SongArtifactUpload } from "../../types"
import {
  serializeSongArtifactUpload,
  toSongArtifactUploadRow,
} from "./song-artifact-serialization"

export async function findUploadedSongArtifactByStorageRef(input: {
  client: Client
  communityId: string
  storageRef: string
  artifactKind?: SongArtifactUpload["artifact_kind"]
}): Promise<SongArtifactUpload | null> {
  const hasArtifactKind = typeof input.artifactKind === "string" && input.artifactKind.length > 0
  const row = await executeFirst(input.client, {
    sql: `
      SELECT song_artifact_upload_id, community_id, uploader_user_id, artifact_kind, status, storage_ref,
             mime_type, filename, size_bytes, content_hash, storage_provider, storage_bucket,
             storage_object_key, storage_endpoint, gateway_url, ipfs_cid, created_at, updated_at
      FROM song_artifact_uploads
      WHERE community_id = ?1
        AND status = 'uploaded'
        ${hasArtifactKind ? "AND artifact_kind = ?2" : ""}
        AND (${hasArtifactKind ? "storage_ref = ?3 OR gateway_url = ?3" : "storage_ref = ?2 OR gateway_url = ?2"})
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    args: hasArtifactKind
      ? [input.communityId, input.artifactKind, input.storageRef]
      : [input.communityId, input.storageRef],
  })

  return row ? serializeSongArtifactUpload(toSongArtifactUploadRow(row)) : null
}
