import { analysisBlocked, badRequestError, notFoundError } from "../errors"
import { nowIso } from "../helpers"
import { getControlPlaneClient } from "../runtime-deps"
import { syncSongBundleToAcrCloudCatalog } from "./song-artifact-catalog"
import {
  findUploadedSongArtifactByStorageRef,
  getSongArtifactBundle,
  markSongArtifactBundleConsumed,
  updateSongArtifactBundleModerationResult,
} from "./song-artifact-repository"
import {
  resolveBundlePostAnalysis,
  videoDescriptorFromUpload,
} from "./song-artifact-descriptors"
import type { Env } from "../../env"
import type { CreatePostRequest } from "../../types"
import type {
  ResolvedSongPostBundle,
  ResolvedVideoPostAsset,
} from "./song-artifact-types"

export async function resolveSongPostBundle(input: {
  env: Env
  userId: string
  communityId: string
  songArtifactBundleId: string
  rightsBasis: CreatePostRequest["rights_basis"] | null | undefined
  upstreamAssetRefs: string[] | null | undefined
  accessMode?: Extract<CreatePostRequest, { post_type: "song" }>["access_mode"] | null
}): Promise<ResolvedSongPostBundle> {
  const client = getControlPlaneClient(input.env)
  const bundle = await getSongArtifactBundle(client, input.communityId, input.songArtifactBundleId)
  if (!bundle || bundle.creator_user !== `usr_${input.userId}`) {
    throw notFoundError("Song artifact bundle not found")
  }
  if (bundle.status !== "ready" && bundle.status !== "consumed") {
    throw badRequestError("Song artifact bundle is not ready for publishing")
  }

  const bundleAnalysis = resolveBundlePostAnalysis(bundle)
  if (bundleAnalysis.analysisState === "blocked") {
    throw analysisBlocked("Song artifact analysis blocked publication")
  }
  if (bundleAnalysis.analysisState === "review_required") {
    throw analysisBlocked("Song artifact analysis requires review before publication")
  }
  if (
    bundleAnalysis.analysisState === "allow_with_required_reference"
    && (input.rightsBasis !== "derivative" || !input.upstreamAssetRefs?.length)
  ) {
    throw badRequestError("Matched audio requires derivative rights_basis and upstream_asset_refs")
  }
  if (
    input.accessMode === "locked"
    && (bundle.preview_status !== "completed" || !bundle.preview_audio?.storage_ref || !bundle.preview_audio.mime_type)
  ) {
    throw badRequestError("Song preview is not ready for locked publishing")
  }
  if (!bundle.media_refs?.length) {
    throw badRequestError("Song artifact bundle does not contain any media refs")
  }

  return {
    bundle,
    mediaRefs: bundle.media_refs as NonNullable<Extract<CreatePostRequest, { post_type: "song" }>["media_refs"]>,
    lyrics: bundle.lyrics,
    analysisState: bundleAnalysis.analysisState,
    contentSafetyState: bundleAnalysis.contentSafetyState,
    ageGatePolicy: bundleAnalysis.ageGatePolicy,
  }
}

export async function resolveVideoPostAsset(input: {
  env: Env
  userId: string
  communityId: string
  mediaRefs: Extract<CreatePostRequest, { post_type: "video" }>["media_refs"] | undefined
}): Promise<ResolvedVideoPostAsset> {
  const primaryVideo = input.mediaRefs?.[0]
  if (!primaryVideo?.storage_ref?.trim()) {
    throw badRequestError("media_refs is required for video commerce posts")
  }
  const client = getControlPlaneClient(input.env)
  const upload = await findUploadedSongArtifactByStorageRef({
    client,
    communityId: input.communityId,
    storageRef: primaryVideo.storage_ref,
    artifactKind: "primary_video",
  })
  if (!upload || upload.uploader_user !== `usr_${input.userId}`) {
    throw notFoundError("Video artifact upload not found")
  }
  const previewVideoRef = primaryVideo.preview_video
  const previewVideoUpload = previewVideoRef?.storage_ref?.trim()
    ? await findUploadedSongArtifactByStorageRef({
        client,
        communityId: input.communityId,
        storageRef: previewVideoRef.storage_ref,
        artifactKind: "preview_video",
      })
    : null
  if (previewVideoRef?.storage_ref?.trim() && (!previewVideoUpload || previewVideoUpload.uploader_user !== `usr_${input.userId}`)) {
    throw notFoundError("Video preview artifact upload not found")
  }
  const descriptor = videoDescriptorFromUpload(upload)
  return {
    upload,
    previewUpload: previewVideoUpload,
    mediaRefs: [{
      ...descriptor,
      poster_ref: primaryVideo.poster_ref ?? null,
      poster_mime_type: primaryVideo.poster_mime_type ?? null,
      poster_size_bytes: primaryVideo.poster_size_bytes ?? null,
      poster_width: primaryVideo.poster_width ?? null,
      poster_height: primaryVideo.poster_height ?? null,
      poster_frame_ms: primaryVideo.poster_frame_ms ?? null,
      ...(previewVideoUpload ? { preview_video: videoDescriptorFromUpload(previewVideoUpload) } : {}),
    }] as NonNullable<Extract<CreatePostRequest, { post_type: "video" }>["media_refs"]>,
  }
}

export async function consumeSongPostBundle(input: {
  env: Env
  communityId: string
  songArtifactBundleId: string
}): Promise<void> {
  const client = getControlPlaneClient(input.env)
  const bundle = await getSongArtifactBundle(client, input.communityId, input.songArtifactBundleId)
  if (!bundle) {
    throw notFoundError("Song artifact bundle not found")
  }

  const existingModerationResult = bundle.moderation_result && typeof bundle.moderation_result === "object"
    ? bundle.moderation_result as Record<string, unknown>
    : {}
  const existingCatalogSync = existingModerationResult.catalog_sync
  const alreadySynced = Boolean(
    existingCatalogSync
    && typeof existingCatalogSync === "object"
    && "synced" in existingCatalogSync
    && (existingCatalogSync as { synced?: unknown }).synced === true,
  )

  if (!alreadySynced) {
    const primaryAudioUpload = await findUploadedSongArtifactByStorageRef({
      client,
      communityId: input.communityId,
      storageRef: bundle.primary_audio.storage_ref,
      artifactKind: "primary_audio",
    })
    const catalogSync = await syncSongBundleToAcrCloudCatalog({
      env: input.env,
      communityId: input.communityId,
      songArtifactBundleId: input.songArtifactBundleId,
      bundle,
      primaryAudioUpload,
    })
    await updateSongArtifactBundleModerationResult({
      client,
      communityId: input.communityId,
      songArtifactBundleId: input.songArtifactBundleId,
      moderationResult: {
        ...existingModerationResult,
        catalog_sync: catalogSync,
      },
      updatedAt: nowIso(),
    })
  }

  if (bundle.status !== "consumed") {
    await markSongArtifactBundleConsumed({
      client,
      communityId: input.communityId,
      songArtifactBundleId: input.songArtifactBundleId,
      updatedAt: nowIso(),
    })
  }
}
