import { analysisBlocked, badRequestError, notFoundError } from "../errors"
import { nowIso } from "../helpers"
import { getControlPlaneClient } from "../runtime-deps"
import { syncSongBundleToAcrCloudCatalog } from "./song-artifact-catalog"
import {
  getSongArtifactBundle,
  markSongArtifactBundleConsumed,
  updateSongArtifactBundleModerationResult,
} from "./song-artifact-bundle-repository"
import { findUploadedSongArtifactByStorageRef } from "./song-artifact-upload-repository"
import {
  resolveBundlePostAnalysis,
} from "./song-artifact-descriptors"
import type { CreatePostRequest, Env, Post } from "../../types"
import type { ResolvedSongPostBundle } from "./song-artifact-types"

export async function resolveSongPostBundle(input: {
  env: Env
  userId: string
  communityId: string
  songArtifactBundleId: string
  rightsBasis: Post["rights_basis"] | null | undefined
  upstreamAssetRefs: string[] | null | undefined
  accessMode?: Extract<CreatePostRequest, { post_type: "song" }>["access_mode"] | null
}): Promise<ResolvedSongPostBundle> {
  const client = getControlPlaneClient(input.env)
  const bundle = await getSongArtifactBundle(client, input.communityId, input.songArtifactBundleId)
  if (!bundle || bundle.creator_user_id !== input.userId) {
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
