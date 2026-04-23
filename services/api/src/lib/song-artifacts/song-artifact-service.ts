import type { Client } from "../sql-client"
import type { UserRepository } from "../auth/repositories"
import type { CommunityRepository } from "../communities/db-community-repository"
import { openCommunityDb } from "../communities/community-db-factory"
import { analysisBlocked, badRequestError, eligibilityFailed, notFoundError, verificationRequired } from "../errors"
import { makeId, nowIso } from "../helpers"
import { getControlPlaneClient } from "../runtime-deps"
import { sha256Hex } from "../crypto"
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
  updateSongArtifactBundlePreview,
} from "./song-artifact-repository"
import { analyzeSongBundle } from "./song-artifact-analysis"
import { syncSongBundleToAcrCloudCatalog } from "./song-artifact-catalog"
import {
  assertSongArtifactMimeType,
  assertSongArtifactSize,
  buildSongArtifactContentUrl,
  fetchSongArtifactBytes,
  type SongArtifactKind,
  uploadSongArtifactBytes,
} from "./song-artifact-storage"
import {
  canAccessCommunity,
  getCommunityMembershipState,
} from "../communities/membership/store"
import { enqueueCommunityJob } from "../communities/jobs/store"

type CommunityMembershipRow = Awaited<ReturnType<typeof getCommunityMembershipState>>
type SongPreviewWindow = NonNullable<CreateSongArtifactBundleRequest["preview_window"]>

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

function assertUploadRequest(input: CreateSongArtifactUploadRequest): void {
  const kind = input.artifact_kind as SongArtifactKind
  if (kind === "preview_audio") {
    throw badRequestError("preview_audio upload intents are not supported; use preview_window")
  }
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

function resolveWorkerPublicOrigin(env: Env): string {
  return String(env.PIRATE_API_PUBLIC_ORIGIN || "http://pirate.test").trim()
}

function parseSongPreviewWindow(input: CreateSongArtifactBundleRequest["preview_window"]): SongPreviewWindow | null {
  if (!input) {
    return null
  }
  const startMs = Math.max(0, Math.trunc(Number(input.start_ms)))
  const durationMs = Math.max(1, Math.trunc(Number(input.duration_ms)))
  if (!Number.isFinite(startMs) || !Number.isFinite(durationMs)) {
    throw badRequestError("preview_window must include numeric start_ms and duration_ms")
  }
  return {
    start_ms: startMs,
    duration_ms: Math.min(durationMs, 30_000),
  }
}

function estimateWavDurationMs(bytes: Uint8Array): number | null {
  if (
    bytes.byteLength < 44
    || bytes[0] !== 0x52
    || bytes[1] !== 0x49
    || bytes[2] !== 0x46
    || bytes[3] !== 0x46
    || bytes[8] !== 0x57
    || bytes[9] !== 0x41
    || bytes[10] !== 0x56
    || bytes[11] !== 0x45
  ) {
    return null
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const byteRate = view.getUint32(28, true)
  const dataSize = view.getUint32(40, true)
  if (!byteRate || !dataSize) {
    return null
  }
  return Math.max(1, Math.round((dataSize / byteRate) * 1000))
}

async function cropAudioPreviewWithFfmpeg(input: {
  env: Env
  sourceBytes: Uint8Array
  sourceMimeType: string
  previewWindow: SongPreviewWindow
}): Promise<{ bytes: Uint8Array; durationMs: number | null }> {
  if (String(input.env.SONG_PREVIEW_FFMPEG_BIN || "").trim() === "__test_passthrough__") {
    const durationMs = estimateWavDurationMs(input.sourceBytes)
    return {
      bytes: input.sourceBytes,
      durationMs: durationMs == null
        ? input.previewWindow.duration_ms
        : Math.min(durationMs, input.previewWindow.duration_ms),
    }
  }

  const [
    childProcess,
    fs,
    os,
    path,
  ] = await Promise.all([
    import("node:child_process"),
    import("node:fs/promises"),
    import("node:os"),
    import("node:path"),
  ])
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pirate-song-preview-"))
  const inputPath = path.join(tempDir, `input.${input.sourceMimeType.includes("wav") ? "wav" : "audio"}`)
  const outputPath = path.join(tempDir, "preview.mp3")
  const ffmpegBin = String(input.env.SONG_PREVIEW_FFMPEG_BIN || "ffmpeg").trim() || "ffmpeg"
  const ffprobeBin = String(input.env.SONG_PREVIEW_FFPROBE_BIN || "ffprobe").trim() || "ffprobe"
  const startSeconds = String(input.previewWindow.start_ms / 1000)
  const durationSeconds = String(input.previewWindow.duration_ms / 1000)

  try {
    await fs.writeFile(inputPath, input.sourceBytes)
    await new Promise<void>((resolve, reject) => {
      const child = childProcess.spawn(ffmpegBin, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        startSeconds,
        "-t",
        durationSeconds,
        "-i",
        inputPath,
        "-vn",
        "-codec:a",
        "libmp3lame",
        "-b:a",
        "192k",
        "-f",
        "mp3",
        outputPath,
      ], { stdio: ["ignore", "ignore", "pipe"] })
      let stderr = ""
      child.stderr?.setEncoding("utf8")
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk)
      })
      child.on("error", reject)
      child.on("close", (code) => {
        if (code === 0) {
          resolve()
          return
        }
        reject(new Error(`ffmpeg exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`))
      })
    })
    const probeOutput = await new Promise<string>((resolve, reject) => {
      const child = childProcess.spawn(ffprobeBin, [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        outputPath,
      ], { stdio: ["ignore", "pipe", "pipe"] })
      let stdout = ""
      let stderr = ""
      child.stdout?.setEncoding("utf8")
      child.stderr?.setEncoding("utf8")
      child.stdout?.on("data", (chunk) => {
        stdout += String(chunk)
      })
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk)
      })
      child.on("error", reject)
      child.on("close", (code) => {
        if (code === 0) {
          resolve(stdout)
          return
        }
        reject(new Error(`ffprobe exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`))
      })
    })
    const durationSecondsParsed = Number.parseFloat(probeOutput.trim())
    const durationMs = Number.isFinite(durationSecondsParsed)
      ? Math.max(1, Math.round(durationSecondsParsed * 1000))
      : null
    return {
      bytes: new Uint8Array(await fs.readFile(outputPath)),
      durationMs,
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
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
  if (input.body.preview_audio) {
    throw badRequestError("preview_audio uploads are not supported; use preview_window")
  }
  const previewWindow = parseSongPreviewWindow(input.body.preview_window)

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
        preview_window: previewWindow,
      },
      primaryAudio: descriptorFromUpload(primaryAudioUpload),
      coverArt: coverArtUpload ? imageDescriptorFromUpload(coverArtUpload) : null,
      previewAudio: null,
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
      previewStatus: previewWindow ? "pending" : "completed",
      previewError: null,
      updatedAt: nowIso(),
    })

    if (finalized.preview_status === "pending") {
      await enqueueCommunityJob({
        client: db.client,
        communityId: input.communityId,
        jobType: "song_preview_generate",
        subjectType: "song_artifact_bundle",
        subjectId: finalized.song_artifact_bundle_id,
        payloadJson: JSON.stringify({
          song_artifact_bundle_id: finalized.song_artifact_bundle_id,
          primary_audio_content_hash: finalized.primary_audio.content_hash ?? null,
          preview_window: finalized.preview_window,
        }),
        createdAt: nowIso(),
      })
    }

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
      userId: bundle.creator_user_id,
      songArtifactUploadId: previewUploadId,
      storageRef: buildSongArtifactContentUrl(origin, input.communityId, previewUploadId),
      body: {
        artifact_kind: "preview_audio",
        mime_type: "audio/mpeg",
        filename: `${bundle.song_artifact_bundle_id}-preview.mp3`,
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
