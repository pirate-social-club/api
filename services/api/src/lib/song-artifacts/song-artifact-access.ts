import type { DbExecutor } from "../db-helpers"
import {
  requireActiveCommunity,
  requireMemberAccess,
} from "../communities/community-content-access"
import { badRequestError, notFoundError } from "../errors"
import { requireSongArtifactUpload } from "./song-artifact-repository"
import type { SongArtifactUpload } from "../../types"

export { requireActiveCommunity, requireMemberAccess }

export async function requireResolvedUpload(input: {
  client: DbExecutor
  communityId: string
  userId: string
  ref: { song_artifact_upload: string }
  expectedKind: SongArtifactUpload["artifact_kind"]
}): Promise<SongArtifactUpload> {
  const upload = await requireSongArtifactUpload(
    input.client,
    input.communityId,
    input.ref.song_artifact_upload.replace(/^sau_/, ""),
  )
  if (upload.uploader_user !== `usr_${input.userId}`) {
    throw notFoundError("Song artifact upload not found")
  }
  if (upload.status !== "uploaded") {
    throw badRequestError(`Song artifact upload ${upload.id} is not uploaded yet`)
  }
  if (upload.artifact_kind !== input.expectedKind) {
    throw badRequestError(`Song artifact upload ${upload.id} is not a ${input.expectedKind} upload`)
  }
  return upload
}
