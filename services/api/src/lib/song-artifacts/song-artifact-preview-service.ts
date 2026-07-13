import { badRequestError, notFoundError } from "../errors"
import { makeId, nowIso } from "../helpers"
import { getControlPlaneClient } from "../runtime-deps"
import { sha256Hex } from "../crypto"
import {
  createSongArtifactUploadIntent,
  findUploadedSongArtifactByStorageRef,
  getSongArtifactBundle,
  markSongArtifactUploadContentHashServerVerified,
  markSongArtifactUploadUploaded,
  updateSongArtifactBundlePreview,
} from "./song-artifact-repository"
import { cropAudioPreviewWithFfmpeg } from "./song-artifact-preview"
import {
  buildIpfsGatewayUrl,
  buildSongArtifactContentUrl,
  fetchSongArtifactBytes,
  uploadSongArtifactBytes,
} from "./song-artifact-storage"
import type { Env } from "../../env"
import type { Client } from "../sql-client"

function resolveWorkerPublicOrigin(env: Env): string {
  return String(env.PIRATE_API_PUBLIC_ORIGIN || "http://pirate.test").trim()
}

export async function verifySongArtifactSourceContentHash(input: {
  sourceBytes: Uint8Array
  uploadContentHash: string | null
  bundleContentHash: string | null
}): Promise<string> {
  const sourceContentHash = `0x${await sha256Hex(input.sourceBytes)}`
  if (
    input.uploadContentHash !== sourceContentHash
    || input.bundleContentHash !== sourceContentHash
  ) {
    throw badRequestError("Primary audio content hash does not match downloaded bytes")
  }
  return sourceContentHash
}

export async function generateSongPreviewForBundle(input: {
  env: Env
  communityId: string
  songArtifactBundleId: string
  expectedPrimaryAudioContentHash?: string | null
  client?: Client
}): Promise<string> {
  const client = input.client ?? getControlPlaneClient(input.env)
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
    const sourceBytes = new Uint8Array(await primaryResponse.arrayBuffer())
    const sourceContentHash = await verifySongArtifactSourceContentHash({
      sourceBytes,
      uploadContentHash: primaryAudioUpload.content_hash ?? null,
      bundleContentHash: bundle.primary_audio.content_hash ?? null,
    })
    const verified = await markSongArtifactUploadContentHashServerVerified({
      client,
      communityId: input.communityId,
      songArtifactUploadId: primaryAudioUpload.id,
      contentHash: sourceContentHash,
      verifiedAt: nowIso(),
    })
    if (!verified) {
      throw badRequestError("Primary audio upload changed before content hash verification")
    }

    const preview = await cropAudioPreviewWithFfmpeg({
      env: input.env,
      sourceBytes,
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
    const uploadedAt = nowIso()
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
      ipfsCid: storage.ipfsCid,
      contentHashVerifiedAt: uploadedAt,
      updatedAt: uploadedAt,
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
        decentralized_storage: uploaded.ipfs_cid
          ? {
              provider: "filebase_ipfs",
              cid: uploaded.ipfs_cid,
              gateway_url: buildIpfsGatewayUrl(input.env, uploaded.ipfs_cid),
            }
          : null,
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
