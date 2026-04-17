import type { Client } from "@libsql/client"
import type { UserRepository } from "../auth/repositories"
import type { CommunityRepository } from "../communities/control-plane-community-repository"
import { openCommunityDb } from "../communities/community-db-factory"
import { analysisBlocked, badRequestError, eligibilityFailed, notFoundError, verificationRequired } from "../errors"
import { makeId, nowIso } from "../helpers"
import { getControlPlaneClient } from "../runtime-deps"
import type {
  CreatePostRequest,
  CreateSongArtifactBundleRequest,
  CreateSongArtifactUploadRequest,
  Env,
  Post,
  SongArtifactBundle,
  SongArtifactUpload,
} from "../../types"
import {
  createSongArtifactBundleDraft,
  createSongArtifactUploadIntent,
  findUploadedSongArtifactByStorageRef,
  finalizeSongArtifactBundle,
  getSongArtifactBundle,
  markSongArtifactBundleConsumed,
  markSongArtifactUploadUploaded,
  requireSongArtifactUpload,
  updateSongArtifactBundleModerationResult,
} from "./song-artifact-repository"
import { analyzeSongBundle } from "./song-artifact-analysis"
import { syncSongBundleToAcrCloudCatalog } from "./song-artifact-catalog"
import {
  assertSongArtifactMimeType,
  assertSongArtifactSize,
  buildSongArtifactContentUrl,
  fetchSongArtifactBytes,
  sha256Hex,
  type SongArtifactKind,
  uploadSongArtifactBytes,
} from "./song-artifact-storage"
import {
  canAccessCommunity,
  getCommunityMembershipState,
} from "../communities/community-membership-store"

type CommunityMembershipRow = Awaited<ReturnType<typeof getCommunityMembershipState>>

export type ResolvedSongPostBundle = {
  bundle: SongArtifactBundle
  mediaRefs: NonNullable<Extract<CreatePostRequest, { post_type: "song" }>["media_refs"]>
  lyrics: string
  analysisState: Post["analysis_state"]
  contentSafetyState: Post["content_safety_state"]
  ageGatePolicy: Post["age_gate_policy"]
}

async function requireMemberAccess(client: Client, communityId: string, userId: string): Promise<CommunityMembershipRow> {
  const membership = await getCommunityMembershipState(client, communityId, userId)
  if (!canAccessCommunity(membership)) {
    throw notFoundError("Community not found")
  }
  return membership
}

async function requireVerifiedHuman(userRepository: UserRepository, userId: string): Promise<void> {
  const user = await userRepository.getUserById(userId)
  if (!user) {
    throw notFoundError("User not found")
  }
  if (user.verification_capabilities.unique_human.state !== "verified") {
    throw verificationRequired("unique_human verification is required")
  }
}

async function requireActiveCommunity(
  communityRepository: CommunityRepository,
  communityId: string,
): Promise<void> {
  const community = await communityRepository.getCommunityById(communityId)
  if (!community || community.provisioning_state !== "active" || community.status !== "active") {
    throw eligibilityFailed("Community is not available for posting")
  }
}

function parseStoredCommunitySettings(value: string | null): Record<string, unknown> {
  if (!value?.trim()) {
    return {}
  }
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function assertUploadRequest(input: CreateSongArtifactUploadRequest): void {
  const kind = input.artifact_kind as SongArtifactKind
  const mimeType = input.mime_type.trim().toLowerCase()
  if (!mimeType) {
    throw badRequestError("mime_type is required")
  }
  assertSongArtifactMimeType(kind, mimeType)
  if (input.size_bytes != null) {
    assertSongArtifactSize(kind, input.size_bytes)
  }
}

function normalizeUploadBytes(bytes: ArrayBuffer | Uint8Array): Uint8Array {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
}

function validateUploadMatch(upload: SongArtifactUpload, bytes: Uint8Array): void {
  assertSongArtifactMimeType(upload.artifact_kind as SongArtifactKind, upload.mime_type)
  assertSongArtifactSize(upload.artifact_kind as SongArtifactKind, bytes.byteLength)
  if (upload.size_bytes != null && upload.size_bytes !== bytes.byteLength) {
    throw badRequestError(`Uploaded byte count does not match the declared size for ${upload.song_artifact_upload_id}`)
  }
}

function descriptorFromUpload(upload: SongArtifactUpload): {
  storage_ref: string
  mime_type: string
  size_bytes?: number | null
  content_hash?: string | null
  duration_ms?: number | null
} {
  return {
    storage_ref: upload.gateway_url || upload.storage_ref,
    mime_type: upload.mime_type,
    size_bytes: upload.size_bytes ?? null,
    content_hash: upload.content_hash ?? null,
    duration_ms: null,
  }
}

function imageDescriptorFromUpload(upload: SongArtifactUpload): {
  storage_ref: string
  mime_type: string
  size_bytes?: number | null
  content_hash?: string | null
  width?: number | null
  height?: number | null
} {
  return {
    storage_ref: upload.gateway_url || upload.storage_ref,
    mime_type: upload.mime_type,
    size_bytes: upload.size_bytes ?? null,
    content_hash: upload.content_hash ?? null,
    width: null,
    height: null,
  }
}

function videoDescriptorFromUpload(upload: SongArtifactUpload): {
  storage_ref: string
  mime_type: string
  size_bytes?: number | null
  content_hash?: string | null
  duration_ms?: number | null
  clip_start_ms?: number | null
  clip_duration_ms?: number | null
  width?: number | null
  height?: number | null
} {
  return {
    storage_ref: upload.gateway_url || upload.storage_ref,
    mime_type: upload.mime_type,
    size_bytes: upload.size_bytes ?? null,
    content_hash: upload.content_hash ?? null,
    duration_ms: null,
    clip_start_ms: null,
    clip_duration_ms: null,
    width: null,
    height: null,
  }
}

async function requireResolvedUpload(input: {
  client: Client
  communityId: string
  userId: string
  ref: { song_artifact_upload_id: string }
  expectedKind: SongArtifactUpload["artifact_kind"]
}): Promise<SongArtifactUpload> {
  const upload = await requireSongArtifactUpload(input.client, input.communityId, input.ref.song_artifact_upload_id)
  if (upload.uploader_user_id !== input.userId) {
    throw notFoundError("Song artifact upload not found")
  }
  if (upload.status !== "uploaded") {
    throw badRequestError(`Song artifact upload ${upload.song_artifact_upload_id} is not uploaded yet`)
  }
  if (upload.artifact_kind !== input.expectedKind) {
    throw badRequestError(`Song artifact upload ${upload.song_artifact_upload_id} is not a ${input.expectedKind} upload`)
  }
  return upload
}

function resolveBundlePostAnalysis(bundle: SongArtifactBundle): {
  analysisState: Post["analysis_state"]
  contentSafetyState: Post["content_safety_state"]
  ageGatePolicy: Post["age_gate_policy"]
} {
  const moderation = bundle.moderation_result && typeof bundle.moderation_result === "object"
    ? bundle.moderation_result as {
        analysis_state?: Post["analysis_state"]
        content_safety_state?: Post["content_safety_state"]
        age_gate_policy?: Post["age_gate_policy"]
      }
    : {}
  return {
    analysisState: moderation.analysis_state ?? "allow",
    contentSafetyState: moderation.content_safety_state ?? "safe",
    ageGatePolicy: moderation.age_gate_policy ?? "none",
  }
}

export async function createSongArtifactUpload(input: {
  env: Env
  userId: string
  communityId: string
  body: CreateSongArtifactUploadRequest
  userRepository: UserRepository
  communityRepository: CommunityRepository
  origin: string
}): Promise<SongArtifactUpload> {
  assertUploadRequest(input.body)
  await requireActiveCommunity(input.communityRepository, input.communityId)

  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireMemberAccess(db.client, input.communityId, input.userId)
    await requireVerifiedHuman(input.userRepository, input.userId)

    const client = getControlPlaneClient(input.env)
    const songArtifactUploadId = makeId("sau")
    return await createSongArtifactUploadIntent({
      client,
      communityId: input.communityId,
      userId: input.userId,
      songArtifactUploadId,
      storageRef: buildSongArtifactContentUrl(input.origin, input.communityId, songArtifactUploadId),
      body: input.body,
      createdAt: nowIso(),
    })
  } finally {
    db.close()
  }
}

export async function uploadSongArtifactContent(input: {
  env: Env
  userId: string
  communityId: string
  songArtifactUploadId: string
  content: ArrayBuffer | Uint8Array
  userRepository: UserRepository
  communityRepository: CommunityRepository
  origin: string
}): Promise<SongArtifactUpload> {
  await requireActiveCommunity(input.communityRepository, input.communityId)

  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireMemberAccess(db.client, input.communityId, input.userId)
    await requireVerifiedHuman(input.userRepository, input.userId)

    const client = getControlPlaneClient(input.env)
    const upload = await requireSongArtifactUpload(client, input.communityId, input.songArtifactUploadId)
    if (upload.uploader_user_id !== input.userId) {
      throw notFoundError("Song artifact upload not found")
    }
    if (upload.status === "uploaded") {
      return upload
    }
    if (upload.status !== "pending_upload") {
      throw badRequestError(`Song artifact upload ${upload.song_artifact_upload_id} is not ready for content upload`)
    }

    const bytes = normalizeUploadBytes(input.content)
    validateUploadMatch(upload, bytes)
    const expectedHash = upload.content_hash?.trim() || null
    const actualHash = `0x${await sha256Hex(bytes)}`
    if (expectedHash && expectedHash !== actualHash) {
      throw badRequestError(`content_hash does not match uploaded bytes for ${upload.song_artifact_upload_id}`)
    }

    const storage = await uploadSongArtifactBytes({
      env: input.env,
      communityId: input.communityId,
      songArtifactUploadId: input.songArtifactUploadId,
      artifactKind: upload.artifact_kind as SongArtifactKind,
      mimeType: upload.mime_type,
      bytes,
      origin: input.origin,
    })
    return await markSongArtifactUploadUploaded({
      client,
      communityId: input.communityId,
      songArtifactUploadId: input.songArtifactUploadId,
      mimeType: upload.mime_type,
      sizeBytes: bytes.byteLength,
      contentHash: storage.contentHash,
      storageProvider: storage.storageProvider,
      storageBucket: storage.storageBucket,
      storageObjectKey: storage.storageObjectKey,
      storageEndpoint: storage.storageEndpoint,
      gatewayUrl: storage.gatewayUrl,
      updatedAt: nowIso(),
    })
  } finally {
    db.close()
  }
}

export async function fetchSongArtifactContent(input: {
  env: Env
  communityId: string
  songArtifactUploadId: string
}): Promise<Response> {
  const client = getControlPlaneClient(input.env)
  const upload = await requireSongArtifactUpload(client, input.communityId, input.songArtifactUploadId)
  if (!upload.storage_object_key) {
    throw notFoundError("Song artifact content not found")
  }
  return await fetchSongArtifactBytes({
    env: input.env,
    objectKey: upload.storage_object_key,
  })
}

export async function createSongArtifactBundle(input: {
  env: Env
  userId: string
  communityId: string
  body: CreateSongArtifactBundleRequest
  userRepository: UserRepository
  communityRepository: CommunityRepository
}): Promise<SongArtifactBundle> {
  const lyrics = input.body.lyrics?.trim() || ""
  if (!lyrics) {
    throw badRequestError("lyrics is required")
  }

  await requireActiveCommunity(input.communityRepository, input.communityId)

  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireMemberAccess(db.client, input.communityId, input.userId)
    await requireVerifiedHuman(input.userRepository, input.userId)
    const client = getControlPlaneClient(input.env)
    const primaryAudioUpload = await requireResolvedUpload({
      client,
      communityId: input.communityId,
      userId: input.userId,
      ref: input.body.primary_audio,
      expectedKind: "primary_audio",
    })
    const coverArtUpload = input.body.cover_art
      ? await requireResolvedUpload({
          client,
          communityId: input.communityId,
          userId: input.userId,
          ref: input.body.cover_art,
          expectedKind: "cover_art",
        })
      : null
    const previewAudioUpload = input.body.preview_audio
      ? await requireResolvedUpload({
          client,
          communityId: input.communityId,
          userId: input.userId,
          ref: input.body.preview_audio,
          expectedKind: "preview_audio",
        })
      : null
    const canvasVideoUpload = input.body.canvas_video
      ? await requireResolvedUpload({
          client,
          communityId: input.communityId,
          userId: input.userId,
          ref: input.body.canvas_video,
          expectedKind: "canvas_video",
        })
      : null
    const instrumentalAudioUpload = input.body.instrumental_audio
      ? await requireResolvedUpload({
          client,
          communityId: input.communityId,
          userId: input.userId,
          ref: input.body.instrumental_audio,
          expectedKind: "instrumental_audio",
        })
      : null
    const vocalAudioUpload = input.body.vocal_audio
      ? await requireResolvedUpload({
          client,
          communityId: input.communityId,
          userId: input.userId,
          ref: input.body.vocal_audio,
          expectedKind: "vocal_audio",
        })
      : null

    const createdAt = nowIso()
    const songArtifactBundleId = makeId("sab")
    await createSongArtifactBundleDraft({
      client,
      communityId: input.communityId,
      userId: input.userId,
      songArtifactBundleId,
      body: {
        ...input.body,
        lyrics,
      },
      primaryAudio: descriptorFromUpload(primaryAudioUpload),
      coverArt: coverArtUpload ? imageDescriptorFromUpload(coverArtUpload) : null,
      previewAudio: previewAudioUpload ? descriptorFromUpload(previewAudioUpload) : null,
      canvasVideo: canvasVideoUpload ? videoDescriptorFromUpload(canvasVideoUpload) : null,
      instrumentalAudio: instrumentalAudioUpload ? descriptorFromUpload(instrumentalAudioUpload) : null,
      vocalAudio: vocalAudioUpload ? descriptorFromUpload(vocalAudioUpload) : null,
      lyricsSha256: `0x${await sha256Hex(lyrics)}`,
      createdAt,
    })

    const analysis = await analyzeSongBundle({
      env: input.env,
      lyrics,
      primaryAudioUpload,
    })
    const finalized = await finalizeSongArtifactBundle({
      client,
      communityId: input.communityId,
      songArtifactBundleId,
      status:
        analysis.analysisState === "blocked" || analysis.analysisState === "review_required"
          ? "failed"
          : "ready",
      translationStatus: "pending",
      translationError: null,
      translatedLyricsRef: null,
      translatedLyrics: null,
      alignmentStatus: analysis.alignmentStatus,
      alignmentError: analysis.alignmentError,
      timedLyricsRef: null,
      timedLyrics: analysis.timedLyrics,
      moderationStatus: analysis.moderationStatus,
      moderationError: analysis.moderationError,
      moderationResultRef: null,
      moderationResult: analysis.moderationResult,
      previewStatus: "completed",
      previewError: null,
      updatedAt: nowIso(),
    })

    if (analysis.analysisState === "blocked") {
      throw analysisBlocked("Song artifact analysis blocked publication")
    }
    if (analysis.analysisState === "review_required") {
      throw analysisBlocked("Song artifact analysis requires review before publication")
    }

    return finalized
  } finally {
    db.close()
  }
}

export async function getSongArtifactBundleForCreator(input: {
  env: Env
  userId: string
  communityId: string
  songArtifactBundleId: string
}): Promise<SongArtifactBundle> {
  const client = getControlPlaneClient(input.env)
  const bundle = await getSongArtifactBundle(client, input.communityId, input.songArtifactBundleId)
  if (!bundle || bundle.creator_user_id !== input.userId) {
    throw notFoundError("Song artifact bundle not found")
  }
  return bundle
}

export async function resolveSongPostBundle(input: {
  env: Env
  userId: string
  communityId: string
  songArtifactBundleId: string
  rightsBasis: Post["rights_basis"] | null | undefined
  upstreamAssetRefs: string[] | null | undefined
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
