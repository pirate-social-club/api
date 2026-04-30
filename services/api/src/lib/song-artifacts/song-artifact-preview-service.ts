import { badRequestError, notFoundError } from "../errors"
import { makeId, nowIso } from "../helpers"
import { getControlPlaneClient } from "../runtime-deps"
import { sha256Hex } from "../crypto"
import {
  createSongArtifactUploadIntent,
  findUploadedSongArtifactByStorageRef,
  getSongArtifactBundle,
  markSongArtifactUploadUploaded,
  updateSongArtifactBundlePreview,
} from "./song-artifact-repository"
import { cropAudioPreviewWithFfmpeg } from "./song-artifact-preview"
import {
  buildSongArtifactContentUrl,
  fetchSongArtifactBytes,
  uploadSongArtifactBytes,
} from "./song-artifact-storage"
import type { Env } from "../../env"

function resolveWorkerPublicOrigin(env: Env): string {
  return String(env.PIRATE_API_PUBLIC_ORIGIN || "http://pirate.test").trim()
}

export async function generateSongPreviewForBundle(input: {
  env: Env
  communityId: string
  songArtifactBundleId: string
  expectedPrimaryAudioContentHash?: string | null
}): Promise<string> {
  const client = getControlPlaneClient(input.env)
  const bundle = await getSongArtifactBundle(client, input.communityId, input.songArtifactBundleId)
  if (!bundle) {
    throw notFoundError("Song artifact bundle not found")
  }
  if (bundle.preview_audio?.storage_ref && bundle.preview_status === "completed") {
    return bundle.preview_audio.storage_ref
  }
  if (!bundle.preview_window) {
    throw badRequestError("Song artifact bundle does not have a preview window")
  }
  if (
    input.expectedPrimaryAudioContentHash
    && bundle.primary_audio.content_hash
    && input.expectedPrimaryAudioContentHash !== bundle.primary_audio.content_hash
  ) {
    throw badRequestError("Song artifact bundle primary audio changed before preview generation")
  }

  const primaryAudioUpload = await findUploadedSongArtifactByStorageRef({
    client,
    communityId: input.communityId,
    storageRef: bundle.primary_audio.storage_ref,
    artifactKind: "primary_audio",
  })
  if (!primaryAudioUpload?.storage_object_key) {
    throw badRequestError("Primary audio upload is missing storage metadata")
  }

  try {
    const primaryResponse = await fetchSongArtifactBytes({
      env: input.env,
      objectKey: primaryAudioUpload.storage_object_key,
    })
    const preview = await cropAudioPreviewWithFfmpeg({
      env: input.env,
      sourceBytes: new Uint8Array(await primaryResponse.arrayBuffer()),
      sourceMimeType: primaryAudioUpload.mime_type,
      previewWindow: bundle.preview_window,
    })

    const now = nowIso()
    const previewUploadId = makeId("sau")
    const origin = resolveWorkerPublicOrigin(input.env)
    await createSongArtifactUploadIntent({
      client,
      communityId: input.communityId,
      userId: bundle.creator_user.replace(/^usr_/, ""),
      songArtifactUploadId: previewUploadId,
      storageRef: buildSongArtifactContentUrl(origin, input.communityId, previewUploadId),
      body: {
        artifact_kind: "preview_audio",
        mime_type: "audio/mpeg",
        filename: `${bundle.id.replace(/^sab_/, "")}-preview.mp3`,
        size_bytes: preview.bytes.byteLength,
        content_hash: `0x${await sha256Hex(preview.bytes)}`,
      },
      createdAt: now,
    })
    const storage = await uploadSongArtifactBytes({
      env: input.env,
      communityId: input.communityId,
      songArtifactUploadId: previewUploadId,
      artifactKind: "preview_audio",
      mimeType: "audio/mpeg",
      bytes: preview.bytes,
      origin,
    })
    const uploaded = await markSongArtifactUploadUploaded({
      client,
      communityId: input.communityId,
      songArtifactUploadId: previewUploadId,
      mimeType: "audio/mpeg",
      sizeBytes: preview.bytes.byteLength,
      contentHash: storage.contentHash,
      storageProvider: storage.storageProvider,
      storageBucket: storage.storageBucket,
      storageObjectKey: storage.storageObjectKey,
      storageEndpoint: storage.storageEndpoint,
      gatewayUrl: storage.gatewayUrl,
      updatedAt: nowIso(),
    })
    const updated = await updateSongArtifactBundlePreview({
      client,
      communityId: input.communityId,
      songArtifactBundleId: input.songArtifactBundleId,
      previewAudio: {
        storage_ref: uploaded.gateway_url || uploaded.storage_ref,
        mime_type: uploaded.mime_type,
        size_bytes: uploaded.size_bytes,
        content_hash: uploaded.content_hash,
        duration_ms: preview.durationMs,
      },
      previewStatus: "completed",
      previewError: null,
      updatedAt: nowIso(),
    })
    return updated.preview_audio?.storage_ref ?? uploaded.storage_ref
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await updateSongArtifactBundlePreview({
      client,
      communityId: input.communityId,
      songArtifactBundleId: input.songArtifactBundleId,
      previewAudio: null,
      previewStatus: "failed",
      previewError: message || "preview_generation_failed",
      updatedAt: nowIso(),
    })
    throw error
  }
}
