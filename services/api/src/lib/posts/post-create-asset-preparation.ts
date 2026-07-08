import { badRequestError } from "../errors"
import { makeId } from "../helpers"
import { decodePublicSongArtifactBundleId } from "../public-ids"
import {
  resolveSongPostBundle,
  resolveVideoPostAsset,
} from "../song-artifacts/song-artifact-post-resolution-service"
import { buildPublicSongArtifactContentUrl } from "../song-artifacts/song-artifact-storage"
import type { Env } from "../../env"
import type { CreatePostRequest } from "../../types"
import type { PostWriteRequest } from "./post-create-validation"

export const LOCKED_VIDEO_MAX_BYTES = 50 * 1024 * 1024

function assertLockedVideoSize(sizeBytes: number | null | undefined): void {
  if (sizeBytes != null && sizeBytes > LOCKED_VIDEO_MAX_BYTES) {
    throw badRequestError("Locked videos are currently limited to 50MB while chunked encryption is being built")
  }
}

export type PreparedSongPostAsset = {
  writeBody: PostWriteRequest
  resolvedSongBundleForAsset: Awaited<ReturnType<typeof resolveSongPostBundle>>
}

export type PreparedVideoPostAsset = {
  writeBody: PostWriteRequest
  resolvedVideoAsset: Awaited<ReturnType<typeof resolveVideoPostAsset>>
}

export async function prepareSongPostAsset(input: {
  env: Env
  userId: string
  communityId: string
  body: CreatePostRequest
}): Promise<PreparedSongPostAsset> {
  const accessMode = input.body.access_mode ?? "public"
  const resolvedBundle = await resolveSongPostBundle({
    env: input.env,
    userId: input.userId,
    communityId: input.communityId,
    songArtifactBundleId: decodePublicSongArtifactBundleId(input.body.song_artifact_bundle || ""),
    rightsBasis: input.body.rights_basis,
    upstreamAssetRefs: input.body.upstream_asset_refs ?? null,
    accessMode,
  })

  const mediaRefs = accessMode === "locked"
    ? resolvedBundle.bundle.preview_audio?.storage_ref && resolvedBundle.bundle.preview_audio?.mime_type
      ? [{
          storage_ref: resolvedBundle.bundle.preview_audio.storage_ref,
          mime_type: resolvedBundle.bundle.preview_audio.mime_type,
          size_bytes: resolvedBundle.bundle.preview_audio.size_bytes ?? null,
          content_hash: resolvedBundle.bundle.preview_audio.content_hash ?? null,
          duration_ms: resolvedBundle.bundle.preview_audio.duration_ms ?? null,
          decentralized_storage: resolvedBundle.bundle.preview_audio.decentralized_storage ?? null,
        }]
      : []
    : resolvedBundle.mediaRefs

  return {
    writeBody: {
      ...input.body,
      media_refs: mediaRefs,
      lyrics: resolvedBundle.lyrics,
      access_mode: accessMode,
      asset_id: input.body.asset_id ?? makeId("ast"),
      song_artifact_bundle: resolvedBundle.bundle.id,
      song_annotations_url: resolvedBundle.bundle.genius_annotations_url ?? null,
      song_cover_art_ref: resolvedBundle.bundle.cover_art?.storage_ref ?? null,
      song_duration_ms: resolvedBundle.bundle.primary_audio.duration_ms ?? null,
      song_title: resolvedBundle.bundle.title,
    },
    resolvedSongBundleForAsset: resolvedBundle,
  }
}

export async function prepareVideoPostAsset(input: {
  env: Env
  requestUrl: string
  userId: string
  communityId: string
  body: CreatePostRequest
}): Promise<PreparedVideoPostAsset> {
  const accessMode = input.body.access_mode ?? "public"
  const resolvedVideo = await resolveVideoPostAsset({
    env: input.env,
    userId: input.userId,
    communityId: input.communityId,
    mediaRefs: input.body.media_refs,
  })
  if (accessMode === "locked") {
    assertLockedVideoSize(resolvedVideo.upload.size_bytes)
  }
  const publicVideoMediaRefs = resolvedVideo.mediaRefs.map((mediaRef) => ({
    ...mediaRef,
    storage_ref: buildPublicSongArtifactContentUrl(
      new URL(input.requestUrl).origin,
      input.communityId,
      resolvedVideo.upload.id,
    ),
    ...(mediaRef.preview_video && resolvedVideo.previewUpload ? {
      preview_video: {
        ...mediaRef.preview_video,
        storage_ref: buildPublicSongArtifactContentUrl(
          new URL(input.requestUrl).origin,
          input.communityId,
          resolvedVideo.previewUpload.id,
        ),
      },
    } : {}),
  }))
  const firstPublicVideoMediaRef = publicVideoMediaRefs[0]
  const hasPublicLockedVideoMedia =
    Boolean(firstPublicVideoMediaRef?.poster_ref) ||
    Boolean(firstPublicVideoMediaRef?.preview_video)
  const lockedPosterMediaRefs = hasPublicLockedVideoMedia
    ? [{
      ...firstPublicVideoMediaRef,
      storage_ref: "",
      content_hash: null,
    }]
    : []

  return {
    writeBody: {
      ...input.body,
      media_refs: accessMode === "locked" ? lockedPosterMediaRefs : publicVideoMediaRefs,
      access_mode: input.body.access_mode,
      asset_id: input.body.access_mode ? input.body.asset_id ?? makeId("ast") : input.body.asset_id,
      rights_basis: input.body.rights_basis ?? (input.body.license_preset || accessMode === "locked" ? "original" : "none"),
    },
    resolvedVideoAsset: resolvedVideo,
  }
}
