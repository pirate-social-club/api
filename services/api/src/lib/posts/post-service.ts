import { createDecipheriv, createHash } from "node:crypto"
import { Buffer } from "node:buffer"
import type { Client } from "@libsql/client"
import { encodeAbiParameters } from "viem"
import { openCommunityDb } from "../communities/community-db-factory"
import type { UserRepository } from "../auth/repositories"
import type { CommunityRepository } from "../communities/control-plane-community-repository"
import type { SongArtifactBundleRepository } from "./control-plane-song-artifact-repository"
import type { SongArtifactUploadRepository } from "./control-plane-song-artifact-upload-repository"
import { createSignedSongArtifactDownloadUrl, persistSongArtifactUpload } from "./local-song-artifact-upload-storage"
import {
  createDerivativeLink,
  createSongAssetDraft,
  deleteAssetsBySourcePostId,
  getAssetLockedDeliveryPayloadById,
  getCommunityAssetById,
  updateAssetRightsBasis,
} from "./community-asset-store"
import {
  addUpstreamAssetRefsToPost,
  assertPostCreateRequest,
  deletePostById,
  findPostByIdempotencyKey,
  getPostById,
  hasUserCreatedPostType,
  insertPost,
  listPublishedLocalizedPosts,
  toLocalizedPostResponse,
  transitionPostToPublished,
  updatePostAssetId,
  upsertPostVote,
} from "./community-post-store"
import { deleteMediaAnalysisResultsBySourcePostId, markMediaAnalysisReferencesSatisfied } from "./post-analysis"
import {
  canAccessCommunity,
  getCommunityMembershipState,
  getCommunityRoleAccessState,
  listActiveCommunityGateRules,
  satisfiesCommunityGateRules,
  type GateEvaluationContext,
  type CommunityMembershipRow,
} from "../communities/community-membership-store"
import { evaluateTokenHoldingGate } from "../communities/community-token-gate-runtime"
import { hasActiveAssetAccessEntitlement } from "../communities/community-purchase-store"
import { badRequestError, eligibilityFailed, gateFailed, internalError, notFoundError, verificationRequired } from "../errors"
import { nowIso } from "../helpers"
import { verifyPirateAccessToken } from "../auth/pirate-session-token"
import { readStoredSongArtifactBytes } from "./song-artifact-storage"
import { issueStoryAssetAccessProofViaDirectKey, issueStoryAssetAccessProofViaLit } from "./story-access-controller-runtime"
import { hasStoryCdrApiConfigured, readLockedDeliveryFromStoryCdr } from "./story-cdr-runtime"
import { getDefaultGatewayBaseUrl } from "./story-cdr-sdk-runtime"
import { getStoryAeneidDeliveryDefaults } from "./story-delivery-config"
import type {
  Asset,
  AssetAccessResponse,
  AssetCdrManifestResponse,
  AssetAccessProofResponse,
  CreatePostRequest,
  CreateSongArtifactBundleRequest,
  CreateSongArtifactUploadRequest,
  Env,
  LocalizedPostResponse,
  MediaDescriptor,
  Post,
  SongArtifactBundle,
  SongArtifactUpload,
  SongPreviewWindow,
  User,
} from "../../types"

type CommunityFeedResponse = {
  items: LocalizedPostResponse[]
  next_cursor: string | null
}

type ResolvedSongPostBody = CreatePostRequest & {
  song_artifact_bundle_id?: string | null
  lyrics?: string | null
  media_refs?: CreatePostRequest["media_refs"]
}

type OwnedSongArtifactBundle = SongArtifactBundle
type OwnedSongArtifactUpload = SongArtifactUpload

type AttachUpstreamRefsRequest = {
  upstream_asset_refs: string[]
}

function parseFeedLimit(limit: string | null | undefined): number {
  const normalized = String(limit ?? "").trim()
  if (!normalized) {
    return 25
  }
  const parsed = Number(normalized)
  if (!Number.isFinite(parsed)) {
    return 25
  }
  return Math.min(100, Math.max(1, Math.trunc(parsed)))
}

function parseFeedCursor(cursor: string | null | undefined): { createdAt: string; postId: string } | null {
  if (!cursor) {
    return null
  }
  const [createdAt, postId] = cursor.split("|")
  if (!createdAt || !postId) {
    return null
  }
  return { createdAt, postId }
}

function formatFeedCursor(cursor: { createdAt: string; postId: string } | null): string | null {
  return cursor ? `${cursor.createdAt}|${cursor.postId}` : null
}

async function resolveCommunityByReference(
  repo: CommunityRepository,
  communityRef: string,
): Promise<Awaited<ReturnType<CommunityRepository["getCommunityById"]>>> {
  const normalized = communityRef.trim()
  if (!normalized) {
    return null
  }

  const direct = await repo.getCommunityById(normalized)
  if (direct) {
    return direct
  }

  if (normalized.startsWith("@")) {
    const namespaceLabel = normalized.replace(/^@+/, "").toLowerCase()
    if (!namespaceLabel) {
      return null
    }

    return repo.getCommunityByNamespaceLabel({
      normalizedLabel: namespaceLabel,
      family: "spaces",
    })
  }

  const routeKey = normalized.replace(/^@+/, "").toLowerCase()
  if (!routeKey) {
    return null
  }

  return repo.getCommunityByRouteKey(routeKey)
}

async function requireMemberAccess(client: Client, communityId: string, userId: string): Promise<CommunityMembershipRow> {
  const membership = await getCommunityMembershipState(client, communityId, userId)
  if (!canAccessCommunity(membership)) {
    throw notFoundError("Community not found")
  }
  return membership
}

function getNonPublishedReadRole(input: {
  post: Post
  userId: string
  roleAccess: Awaited<ReturnType<typeof getCommunityRoleAccessState>> | null
}): "creator" | "moderator" | null {
  if (input.post.author_user_id === input.userId) {
    return "creator"
  }
  if (input.roleAccess?.owner_active || input.roleAccess?.admin_active || input.roleAccess?.moderator_active) {
    return "moderator"
  }
  return null
}

function requireNonEmptyStorageRef(value: string | null | undefined, label: string): string {
  const normalized = String(value || "").trim()
  if (!normalized) {
    throw notFoundError(`${label} is unavailable`)
  }
  return normalized
}

function startsWithMimePrefix(value: string | null | undefined, prefix: string): boolean {
  const normalized = String(value || "").trim().toLowerCase()
  return normalized.startsWith(`${prefix}/`)
}

function isPositiveInteger(value: number | null | undefined): value is number {
  return Number.isInteger(value) && Number(value) > 0
}

function assertSquareImage(descriptor: MediaDescriptor, fieldName: string): void {
  if (!isPositiveInteger(descriptor.width) || !isPositiveInteger(descriptor.height)) {
    throw badRequestError(`${fieldName}.width and ${fieldName}.height are required`)
  }
  if (descriptor.width !== descriptor.height) {
    throw badRequestError(`${fieldName} must be 1:1`)
  }
}

function assertNineBySixteenVideo(descriptor: MediaDescriptor, fieldName: string): void {
  if (!isPositiveInteger(descriptor.width) || !isPositiveInteger(descriptor.height)) {
    throw badRequestError(`${fieldName}.width and ${fieldName}.height are required`)
  }
  if ((descriptor.width * 16) !== (descriptor.height * 9)) {
    throw badRequestError(`${fieldName} must be 9:16`)
  }
}

function assertPreviewDuration(descriptor: MediaDescriptor, fieldName: string): void {
  if (!isPositiveInteger(descriptor.duration_ms)) {
    throw badRequestError(`${fieldName}.duration_ms is required`)
  }
  if (descriptor.duration_ms > 30_000) {
    throw badRequestError(`${fieldName}.duration_ms must be <= 30000`)
  }
}

function assertPreviewWindow(window: SongPreviewWindow, primaryAudio: MediaDescriptor): void {
  if (!Number.isInteger(window.start_ms) || window.start_ms < 0) {
    throw badRequestError("preview_window.start_ms must be >= 0")
  }
  if (!Number.isInteger(window.duration_ms) || window.duration_ms <= 0) {
    throw badRequestError("preview_window.duration_ms must be > 0")
  }
  if (window.duration_ms > 30_000) {
    throw badRequestError("preview_window.duration_ms must be <= 30000")
  }
  if (!isPositiveInteger(primaryAudio.duration_ms)) {
    throw badRequestError("primary_audio.duration_ms is required when preview_window is provided")
  }
  if ((window.start_ms + window.duration_ms) > primaryAudio.duration_ms) {
    throw badRequestError("preview_window must fit within primary_audio.duration_ms")
  }
}

function assertSongArtifactBundleRequest(body: CreateSongArtifactBundleRequest): void {
  if (!body.primary_audio?.storage_ref?.trim()) {
    throw badRequestError("primary_audio.storage_ref is required")
  }
  if (!startsWithMimePrefix(body.primary_audio.mime_type, "audio")) {
    throw badRequestError("primary_audio.mime_type must be audio/*")
  }
  if (!body.lyrics?.trim()) {
    throw badRequestError("lyrics are required")
  }
  if (body.cover_art && !startsWithMimePrefix(body.cover_art.mime_type, "image")) {
    throw badRequestError("cover_art.mime_type must be image/*")
  }
  if (body.cover_art) {
    assertSquareImage(body.cover_art, "cover_art")
  }
  if (body.preview_audio && !startsWithMimePrefix(body.preview_audio.mime_type, "audio")) {
    throw badRequestError("preview_audio.mime_type must be audio/*")
  }
  if (body.preview_audio) {
    assertPreviewDuration(body.preview_audio, "preview_audio")
  }
  if (body.preview_audio && body.preview_window) {
    throw badRequestError("preview_window cannot be combined with preview_audio")
  }
  if (body.preview_window) {
    assertPreviewWindow(body.preview_window, body.primary_audio)
  }
  if (body.canvas_video && !startsWithMimePrefix(body.canvas_video.mime_type, "video")) {
    throw badRequestError("canvas_video.mime_type must be video/*")
  }
  if (body.canvas_video) {
    assertNineBySixteenVideo(body.canvas_video, "canvas_video")
  }
  if (body.instrumental_audio && !startsWithMimePrefix(body.instrumental_audio.mime_type, "audio")) {
    throw badRequestError("instrumental_audio.mime_type must be audio/*")
  }
  if (body.vocal_audio && !startsWithMimePrefix(body.vocal_audio.mime_type, "audio")) {
    throw badRequestError("vocal_audio.mime_type must be audio/*")
  }
}

function selectLockedPreviewAudio(bundle: OwnedSongArtifactBundle): MediaDescriptor {
  if (bundle.preview_audio) {
    return bundle.preview_audio
  }
  throw badRequestError("locked song posts require preview_audio")
}

function assertSongArtifactUploadRequest(body: CreateSongArtifactUploadRequest): void {
  if (!body.mime_type?.trim()) {
    throw badRequestError("mime_type is required")
  }
  if (body.artifact_kind === "primary_audio" || body.artifact_kind === "preview_audio" || body.artifact_kind === "instrumental_audio" || body.artifact_kind === "vocal_audio") {
    if (!startsWithMimePrefix(body.mime_type, "audio")) {
      throw badRequestError(`${body.artifact_kind}.mime_type must be audio/*`)
    }
  }
  if (body.artifact_kind === "cover_art" && !startsWithMimePrefix(body.mime_type, "image")) {
    throw badRequestError("cover_art.mime_type must be image/*")
  }
  if (body.artifact_kind === "canvas_video" && !startsWithMimePrefix(body.mime_type, "video")) {
    throw badRequestError("canvas_video.mime_type must be video/*")
  }
}

async function requireVerifiedHuman(userRepository: UserRepository, userId: string): Promise<User> {
  const user = await userRepository.getUserById(userId)
  if (!user) {
    throw notFoundError("User not found")
  }
  if (user.verification_capabilities.unique_human.state !== "verified") {
    throw verificationRequired("unique_human verification is required")
  }
  return user
}

function parsePostingGateConfig(raw: string | null): Record<string, unknown> | null {
  if (!raw) {
    return null
  }

  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function isFirstPostOnlyGate(gateConfig: Record<string, unknown> | null): boolean {
  return gateConfig?.first_post_only === true
}

async function requirePostingGateAccess(
  client: Client,
  env: Env,
  communityId: string,
  context: GateEvaluationContext,
  options?: {
    postType?: CreatePostRequest["post_type"] | Post["post_type"] | null
    action?: "create_post" | "vote"
  },
): Promise<void> {
  const postType = options?.postType ?? null
  const action = options?.action ?? "create_post"
  const rules = await listActiveCommunityGateRules(client, communityId, "posting")
  if (rules.length === 0) {
    return
  }

  const applicableRules = []
  for (const rule of rules) {
    const gateConfig = parsePostingGateConfig(rule.gate_config_json)
    if (!isFirstPostOnlyGate(gateConfig)) {
      applicableRules.push(rule)
      continue
    }

    if (action !== "create_post" || !postType) {
      continue
    }

    const hasPriorPostOfType = await hasUserCreatedPostType({
      client,
      communityId,
      authorUserId: context.user.user_id,
      postType,
    })

    if (!hasPriorPostOfType) {
      applicableRules.push(rule)
    }
  }

  if (applicableRules.length === 0) {
    return
  }

  if (!(await satisfiesCommunityGateRules(applicableRules, {
    ...context,
    tokenGateEvaluator: context.tokenGateEvaluator ?? ((tokenInput) => evaluateTokenHoldingGate({
      env,
      ...tokenInput,
    })),
  }, { postType }))) {
    throw gateFailed("Posting requirements are not satisfied")
  }
}

async function getOwnedSongArtifactBundle(input: {
  communityId: string
  userId: string
  bundleId: string
  songArtifactRepository: SongArtifactBundleRepository
}): Promise<OwnedSongArtifactBundle> {
  const bundle = await input.songArtifactRepository.getSongArtifactBundleById(input.bundleId.trim())
  if (!bundle || bundle.community_id !== input.communityId || bundle.creator_user_id !== input.userId) {
    throw notFoundError("Song artifact bundle not found")
  }
  return bundle
}

async function getOwnedSongArtifactUpload(input: {
  communityId: string
  userId: string
  uploadId: string
  uploadRepository: SongArtifactUploadRepository
}): Promise<OwnedSongArtifactUpload> {
  const upload = await input.uploadRepository.getSongArtifactUploadById(input.uploadId.trim())
  if (!upload || upload.community_id !== input.communityId || upload.uploader_user_id !== input.userId) {
    throw notFoundError("Song artifact upload not found")
  }
  return upload
}

async function requireUploadedSongArtifactRef(input: {
  communityId: string
  userId: string
  artifactKind: SongArtifactUpload["artifact_kind"]
  descriptor: { storage_ref: string; mime_type: string; size_bytes?: number | null; content_hash?: string | null }
  uploadRepository: SongArtifactUploadRepository
}): Promise<void> {
  const upload = await input.uploadRepository.getSongArtifactUploadByStorageRef(input.descriptor.storage_ref.trim())
  if (!upload || upload.community_id !== input.communityId || upload.uploader_user_id !== input.userId) {
    throw badRequestError(`${input.artifactKind}.storage_ref must reference an uploaded song artifact`)
  }
  if (upload.status !== "uploaded") {
    throw badRequestError(`${input.artifactKind}.storage_ref is not uploaded`)
  }
  if (upload.artifact_kind !== input.artifactKind) {
    throw badRequestError(`${input.artifactKind}.storage_ref has the wrong artifact_kind`)
  }
  if (upload.mime_type !== input.descriptor.mime_type) {
    throw badRequestError(`${input.artifactKind}.mime_type must match the uploaded artifact`)
  }
  if (input.descriptor.size_bytes != null && upload.size_bytes != null && input.descriptor.size_bytes !== upload.size_bytes) {
    throw badRequestError(`${input.artifactKind}.size_bytes must match the uploaded artifact`)
  }
  if (input.descriptor.content_hash && upload.content_hash && input.descriptor.content_hash !== upload.content_hash) {
    throw badRequestError(`${input.artifactKind}.content_hash must match the uploaded artifact`)
  }
}

async function validateSongArtifactBundleUploads(input: {
  communityId: string
  userId: string
  body: CreateSongArtifactBundleRequest
  uploadRepository: SongArtifactUploadRepository
}): Promise<void> {
  await requireUploadedSongArtifactRef({
    communityId: input.communityId,
    userId: input.userId,
    artifactKind: "primary_audio",
    descriptor: input.body.primary_audio,
    uploadRepository: input.uploadRepository,
  })
  if (input.body.cover_art) {
    await requireUploadedSongArtifactRef({
      communityId: input.communityId,
      userId: input.userId,
      artifactKind: "cover_art",
      descriptor: input.body.cover_art,
      uploadRepository: input.uploadRepository,
    })
  }
  if (input.body.preview_audio) {
    await requireUploadedSongArtifactRef({
      communityId: input.communityId,
      userId: input.userId,
      artifactKind: "preview_audio",
      descriptor: input.body.preview_audio,
      uploadRepository: input.uploadRepository,
    })
  }
  if (input.body.canvas_video) {
    await requireUploadedSongArtifactRef({
      communityId: input.communityId,
      userId: input.userId,
      artifactKind: "canvas_video",
      descriptor: input.body.canvas_video,
      uploadRepository: input.uploadRepository,
    })
  }
  if (input.body.instrumental_audio) {
    await requireUploadedSongArtifactRef({
      communityId: input.communityId,
      userId: input.userId,
      artifactKind: "instrumental_audio",
      descriptor: input.body.instrumental_audio,
      uploadRepository: input.uploadRepository,
    })
  }
  if (input.body.vocal_audio) {
    await requireUploadedSongArtifactRef({
      communityId: input.communityId,
      userId: input.userId,
      artifactKind: "vocal_audio",
      descriptor: input.body.vocal_audio,
      uploadRepository: input.uploadRepository,
    })
  }
}

function toResolvedSongPostBody(body: CreatePostRequest, bundle: OwnedSongArtifactBundle): ResolvedSongPostBody {
  const accessMode = body.access_mode === "locked" ? "locked" : "public"
  const mediaRefs = accessMode === "locked"
    ? [selectLockedPreviewAudio(bundle)]
    : bundle.media_refs
  return {
    ...body,
    song_artifact_bundle_id: bundle.song_artifact_bundle_id,
    lyrics: bundle.lyrics,
    media_refs: mediaRefs,
  }
}

function assertSongArtifactBundlePublishable(bundle: OwnedSongArtifactBundle): void {
  if (bundle.status !== "ready") {
    if (bundle.status === "consuming" || bundle.status === "consumed") {
      throw badRequestError("Song artifact bundle has already been used")
    }
    throw badRequestError("Song artifact bundle is not ready")
  }
}

function assertLockedSongPreviewReady(bundle: OwnedSongArtifactBundle): void {
  if (bundle.preview_audio) {
    return
  }
  const totalDuration = bundle.primary_audio.duration_ms
  if (!isPositiveInteger(totalDuration)) {
    throw badRequestError("locked song posts require preview_audio or primary_audio.duration_ms")
  }
  if (totalDuration > 30_000 && !bundle.preview_window) {
    throw badRequestError("locked song posts require preview_window or preview_audio when primary_audio.duration_ms > 30000")
  }
  if (bundle.preview_status === "failed") {
    throw badRequestError(`locked song preview generation failed${bundle.preview_error ? `: ${bundle.preview_error}` : ""}`)
  }
  if (bundle.preview_status === "pending" || bundle.preview_status === "processing") {
    throw badRequestError("locked song preview is not ready")
  }
  throw badRequestError("locked song posts require preview_audio")
}

async function claimSongArtifactBundleForPublish(input: {
  bundle: OwnedSongArtifactBundle
  updatedAt: string
  songArtifactRepository: SongArtifactBundleRepository
}): Promise<OwnedSongArtifactBundle> {
  const claimed = await input.songArtifactRepository.transitionSongArtifactBundleStatus({
    bundleId: input.bundle.song_artifact_bundle_id,
    fromStatuses: ["ready"],
    toStatus: "consuming",
    updatedAt: input.updatedAt,
  })
  if (claimed) {
    return claimed
  }

  const current = await input.songArtifactRepository.getSongArtifactBundleById(input.bundle.song_artifact_bundle_id)
  if (!current) {
    throw notFoundError("Song artifact bundle not found")
  }
  assertSongArtifactBundlePublishable(current)
  throw badRequestError("Song artifact bundle is not ready")
}

function parseAttachUpstreamRefsRequest(value: unknown): AttachUpstreamRefsRequest {
  if (!value || typeof value !== "object" || !Array.isArray((value as { upstream_asset_refs?: unknown }).upstream_asset_refs)) {
    throw badRequestError("Invalid upstream refs payload")
  }
  const upstreamAssetRefs = Array.from(new Set(
    (value as { upstream_asset_refs: unknown[] }).upstream_asset_refs
      .map((entry) => typeof entry === "string" ? entry.trim() : "")
      .filter((entry) => entry.length > 0),
  ))
  if (upstreamAssetRefs.length === 0) {
    throw badRequestError("upstream_asset_refs must contain at least one asset id")
  }
  return { upstream_asset_refs: upstreamAssetRefs }
}

export async function createPost(input: {
  env: Env
  bearerToken: string
  communityId: string
  body: CreatePostRequest
  userRepository: UserRepository
  communityRepository: CommunityRepository
  songArtifactRepository: SongArtifactBundleRepository
}): Promise<Post> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!community || community.provisioning_state !== "active" || community.status !== "active") {
    throw eligibilityFailed("Community is not available for posting")
  }

  assertPostCreateRequest(input.body, input.communityId)

  const db = await openCommunityDb(input.communityRepository, input.communityId)
  try {
    await requireMemberAccess(db.client, input.communityId, session.userId)
    const user = await requireVerifiedHuman(input.userRepository, session.userId)
    const walletAttachments = await input.userRepository.getWalletAttachmentsByUserId(session.userId)
    await requirePostingGateAccess(db.client, input.env, input.communityId, {
      user,
      wallets: walletAttachments,
    }, {
      postType: input.body.post_type,
      action: "create_post",
    })
    const idempotencyKey = input.body.idempotency_key?.trim() ?? ""
    const existing = idempotencyKey
      ? await findPostByIdempotencyKey({
          client: db.client,
          communityId: input.communityId,
          authorUserId: session.userId,
          idempotencyKey,
        })
      : null
    if (existing) {
      return existing
    }

    const createdAt = nowIso()
    const bundleId = input.body.post_type === "song" ? input.body.song_artifact_bundle_id?.trim() ?? "" : ""
    const accessMode = input.body.post_type === "song" && input.body.access_mode === "locked"
      ? "locked"
      : "public"
    const initialBundle = bundleId
      ? await getOwnedSongArtifactBundle({
          communityId: input.communityId,
          userId: session.userId,
          bundleId,
          songArtifactRepository: input.songArtifactRepository,
        })
      : null
    if (initialBundle) {
      assertSongArtifactBundlePublishable(initialBundle)
      if (accessMode === "locked") {
        assertLockedSongPreviewReady(initialBundle)
      }
    }

    const claimedBundle = initialBundle
      ? await claimSongArtifactBundleForPublish({
          bundle: initialBundle,
          updatedAt: createdAt,
          songArtifactRepository: input.songArtifactRepository,
        })
      : null
    const claimedResolvedBody = claimedBundle ? toResolvedSongPostBody(input.body, claimedBundle) : input.body
    const shouldLoadAudioBytesForAnalysis = Boolean(
      claimedBundle
      && claimedResolvedBody.post_type === "song"
      && (!claimedResolvedBody.song_mode || claimedResolvedBody.song_mode === "original"),
    )
    const audioBytesForAnalysis = shouldLoadAudioBytesForAnalysis
      ? await readStoredSongArtifactBytes(input.env, claimedBundle!.primary_audio.storage_ref)
      : null

    let createdPostId: string | null = null
    let post: Post | null = null
    const tx = await db.client.transaction("write")
    try {
      try {
        const insertedPost = await insertPost({
          client: tx,
          env: input.env,
          communityId: input.communityId,
          authorUserId: session.userId,
          body: claimedResolvedBody,
          createdAt,
          audioBytes: audioBytesForAnalysis,
        })

        post = insertedPost
        const assetPrimaryMediaRef = claimedBundle?.primary_audio ?? post.media_refs?.[0]
        const assetPreviewMediaRef = claimedBundle
          ? (accessMode === "locked" ? selectLockedPreviewAudio(claimedBundle) : (claimedBundle.preview_audio ?? null))
          : null
        if (post.post_type === "song" && assetPrimaryMediaRef) {
          const asset = await createSongAssetDraft({
            client: tx,
            communityId: input.communityId,
            sourcePostId: post.post_id,
            songArtifactBundleId: claimedBundle?.song_artifact_bundle_id ?? null,
            creatorUserId: session.userId,
            rightsBasis: post.rights_basis,
            accessMode,
            primaryMediaRef: assetPrimaryMediaRef,
            previewAudio: assetPreviewMediaRef,
            coverArt: claimedBundle?.cover_art ?? null,
            canvasVideo: claimedBundle?.canvas_video ?? null,
            createdAt,
          })
          const updatedPost = await updatePostAssetId({
            client: tx,
            postId: post.post_id,
            assetId: asset.asset_id,
            updatedAt: createdAt,
          })
          if (updatedPost) {
            post = updatedPost
          }
        }

        await tx.commit()
      } catch (error) {
        try {
          await tx.rollback()
        } catch {}
        throw error
      } finally {
        tx.close()
      }

      if (!post) {
        throw internalError("Post row is missing after local transaction")
      }
      createdPostId = post.post_id

      if (claimedBundle && post.status === "published") {
        const consumedBundle = await input.songArtifactRepository.transitionSongArtifactBundleStatus({
          bundleId: claimedBundle.song_artifact_bundle_id,
          fromStatuses: ["consuming"],
          toStatus: "consumed",
          updatedAt: createdAt,
        })
        if (!consumedBundle) {
          throw notFoundError("Song artifact bundle not found")
        }
      }

      await input.communityRepository.recordCommunityPostProjection({
        communityId: input.communityId,
        sourcePostId: post.post_id,
        authorUserId: post.author_user_id ?? null,
        identityMode: post.identity_mode,
        postType: post.post_type,
        status: post.status,
        sourceCreatedAt: post.created_at,
        projectedPayloadJson: JSON.stringify(post),
        actorUserId: session.userId,
        createdAt,
      })

      return post
    } catch (error) {
      if (createdPostId) {
        const cleanupTx = await db.client.transaction("write").catch(() => null)
        if (cleanupTx) {
          try {
            await deleteMediaAnalysisResultsBySourcePostId({
              client: cleanupTx,
              sourcePostId: createdPostId,
            })
            await deleteAssetsBySourcePostId({
              client: cleanupTx,
              sourcePostId: createdPostId,
            })
            await deletePostById({
              client: cleanupTx,
              postId: createdPostId,
            })
            await cleanupTx.commit()
          } catch {
            try {
              await cleanupTx.rollback()
            } catch {}
          } finally {
            cleanupTx.close()
          }
        }
      }
      if (claimedBundle) {
        await input.songArtifactRepository.transitionSongArtifactBundleStatus({
          bundleId: claimedBundle.song_artifact_bundle_id,
          fromStatuses: ["consuming", "consumed"],
          toStatus: "ready",
          updatedAt: nowIso(),
        }).catch(() => null)
      }
      throw error
    }
  } finally {
    db.close()
  }
}

export async function attachUpstreamRefsAndPublish(input: {
  env: Env
  bearerToken: string
  communityId: string
  postId: string
  body: unknown
  userRepository: UserRepository
  communityRepository: CommunityRepository
  songArtifactRepository: SongArtifactBundleRepository
}): Promise<Post> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!community || community.provisioning_state !== "active" || community.status !== "active") {
    throw notFoundError("Community not found")
  }
  const body = parseAttachUpstreamRefsRequest(input.body)
  const db = await openCommunityDb(input.communityRepository, input.communityId)
  try {
    await requireMemberAccess(db.client, input.communityId, session.userId)
    await requireVerifiedHuman(input.userRepository, session.userId)
    const currentPost = await getPostById(db.client, input.postId)
    if (!currentPost || currentPost.community_id !== input.communityId) {
      throw notFoundError("Post not found")
    }
    if (currentPost.author_user_id !== session.userId) {
      throw notFoundError("Post not found")
    }
    if (currentPost.post_type !== "song") {
      throw badRequestError("Only song posts may attach upstream refs")
    }
    if (currentPost.status === "published" && currentPost.analysis_state === "allow" && (currentPost.upstream_asset_refs?.length || 0) > 0) {
      return currentPost
    }
    if (currentPost.analysis_state !== "allow_with_required_reference" || currentPost.status !== "draft") {
      throw badRequestError("Post does not require upstream refs before publication")
    }

    for (const upstreamAssetId of body.upstream_asset_refs) {
      if (currentPost.asset_id && upstreamAssetId === currentPost.asset_id) {
        throw badRequestError("upstream_asset_refs cannot include the post's own asset")
      }
      const upstreamAsset = await getCommunityAssetById({
        client: db.client,
        assetId: upstreamAssetId,
      })
      if (!upstreamAsset || upstreamAsset.community_id !== input.communityId) {
        throw badRequestError("upstream_asset_refs must reference existing assets in this community")
      }
    }

    const updatedAt = nowIso()
    const tx = await db.client.transaction("write")
    let publishedPost: Post | null = null
    const bundleIdToConsume = currentPost.song_artifact_bundle_id
    try {
      await addUpstreamAssetRefsToPost({
        client: tx,
        postId: currentPost.post_id,
        upstreamAssetRefs: body.upstream_asset_refs,
        updatedAt,
      })
      if (currentPost.asset_id) {
        await updateAssetRightsBasis({
          client: tx,
          assetId: currentPost.asset_id,
          rightsBasis: "derivative",
          updatedAt,
        })
        for (const upstreamAssetId of body.upstream_asset_refs) {
          await createDerivativeLink({
            client: tx,
            assetId: currentPost.asset_id,
            upstreamAssetId,
            relationshipType: currentPost.song_mode === "remix" ? "remix_of" : "references_song",
            createdAt: updatedAt,
          })
        }
      }
      if (currentPost.analysis_result_ref) {
        await markMediaAnalysisReferencesSatisfied({
          client: tx,
          analysisResultId: currentPost.analysis_result_ref,
          updatedAt,
        })
      }
      publishedPost = await transitionPostToPublished({
        client: tx,
        postId: currentPost.post_id,
        updatedAt,
      })
      if (!publishedPost || publishedPost.status !== "published") {
        throw internalError("Post did not transition to published")
      }
      await tx.commit()
    } catch (error) {
      try {
        await tx.rollback()
      } catch {}
      throw error
    } finally {
      tx.close()
    }

    if (!publishedPost) {
      throw internalError("Published post is missing after upstream ref attach")
    }
    if (bundleIdToConsume) {
      const consumedBundle = await input.songArtifactRepository.transitionSongArtifactBundleStatus({
        bundleId: bundleIdToConsume,
        fromStatuses: ["consuming", "ready"],
        toStatus: "consumed",
        updatedAt,
      })
      if (!consumedBundle) {
        throw notFoundError("Song artifact bundle not found")
      }
    }

    const projectedPayloadJson = JSON.stringify(publishedPost)
    const projectionUpdatedAt = nowIso()
    let updateError: unknown = null
    try {
      const updatedProjection = await input.communityRepository.updateCommunityPostProjection({
        sourcePostId: publishedPost.post_id,
        status: publishedPost.status,
        projectedPayloadJson,
        updatedAt: projectionUpdatedAt,
      })
      if (updatedProjection) {
        return publishedPost
      }
    } catch (error) {
      updateError = error
    }
    try {
      await input.communityRepository.reconcileCommunityPostProjection({
        communityId: publishedPost.community_id,
        sourcePostId: publishedPost.post_id,
        authorUserId: publishedPost.author_user_id ?? null,
        identityMode: publishedPost.identity_mode,
        postType: publishedPost.post_type,
        status: publishedPost.status,
        sourceCreatedAt: publishedPost.created_at,
        projectedPayloadJson,
        updatedAt: projectionUpdatedAt,
      })
    } catch (reconcileError) {
      throw updateError ?? reconcileError
    }
    return publishedPost
  } finally {
    db.close()
  }
}

export async function abandonHeldSongDraft(input: {
  env: Env
  bearerToken: string
  communityId: string
  postId: string
  userRepository: UserRepository
  communityRepository: CommunityRepository
  songArtifactRepository: SongArtifactBundleRepository
}): Promise<void> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!community || community.provisioning_state !== "active" || community.status !== "active") {
    throw notFoundError("Community not found")
  }

  const db = await openCommunityDb(input.communityRepository, input.communityId)
  try {
    await requireMemberAccess(db.client, input.communityId, session.userId)
    await requireVerifiedHuman(input.userRepository, session.userId)

    const currentPost = await getPostById(db.client, input.postId)
    if (!currentPost || currentPost.community_id !== input.communityId) {
      throw notFoundError("Post not found")
    }
    if (currentPost.author_user_id !== session.userId) {
      throw notFoundError("Post not found")
    }
    if (currentPost.post_type !== "song") {
      throw badRequestError("Only song posts may abandon held publish state")
    }
    if (currentPost.analysis_state !== "allow_with_required_reference" || currentPost.status !== "draft") {
      throw badRequestError("Post is not in a held publish state")
    }

    const updatedAt = nowIso()
    const tx = await db.client.transaction("write")
    try {
      await deleteMediaAnalysisResultsBySourcePostId({
        client: tx,
        sourcePostId: currentPost.post_id,
      })
      await deleteAssetsBySourcePostId({
        client: tx,
        sourcePostId: currentPost.post_id,
      })
      await deletePostById({
        client: tx,
        postId: currentPost.post_id,
      })
      await tx.commit()
    } catch (error) {
      try {
        await tx.rollback()
      } catch {}
      throw error
    } finally {
      tx.close()
    }

    if (currentPost.song_artifact_bundle_id) {
      const releasedBundle = await input.songArtifactRepository.transitionSongArtifactBundleStatus({
        bundleId: currentPost.song_artifact_bundle_id,
        fromStatuses: ["consuming", "ready"],
        toStatus: "ready",
        updatedAt,
      })
      if (!releasedBundle) {
        throw notFoundError("Song artifact bundle not found")
      }
    }

    await input.communityRepository.deleteCommunityPostProjection({
      sourcePostId: currentPost.post_id,
    })
  } finally {
    db.close()
  }
}

export async function createSongArtifactBundle(input: {
  env: Env
  bearerToken: string
  communityId: string
  body: CreateSongArtifactBundleRequest
  userRepository: UserRepository
  communityRepository: CommunityRepository
  songArtifactRepository: SongArtifactBundleRepository
  songArtifactUploadRepository: SongArtifactUploadRepository
}): Promise<SongArtifactBundle> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!community || community.provisioning_state !== "active" || community.status !== "active") {
    throw eligibilityFailed("Community is not available for posting")
  }

  assertSongArtifactBundleRequest(input.body)

  const db = await openCommunityDb(input.communityRepository, input.communityId)
  try {
    await requireMemberAccess(db.client, input.communityId, session.userId)
    await requireVerifiedHuman(input.userRepository, session.userId)
    await validateSongArtifactBundleUploads({
      communityId: input.communityId,
      userId: session.userId,
      body: input.body,
      uploadRepository: input.songArtifactUploadRepository,
    })

    const createdAt = nowIso()
    const bundle = await input.songArtifactRepository.createSongArtifactBundle({
      communityId: input.communityId,
      creatorUserId: session.userId,
      body: {
        ...input.body,
        lyrics: input.body.lyrics.trim(),
      },
      lyricsSha256: `0x${createHash("sha256").update(input.body.lyrics.trim()).digest("hex")}`,
      createdAt,
    })
    const validatingBundle = await input.songArtifactRepository.transitionSongArtifactBundleStatus({
      bundleId: bundle.song_artifact_bundle_id,
      fromStatuses: ["draft"],
      toStatus: "validating",
      updatedAt: createdAt,
    })
    if (!validatingBundle) {
      throw notFoundError("Song artifact bundle not found")
    }
    const readyBundle = await input.songArtifactRepository.transitionSongArtifactBundleStatus({
      bundleId: bundle.song_artifact_bundle_id,
      fromStatuses: ["validating"],
      toStatus: "ready",
      updatedAt: createdAt,
    })
    if (!readyBundle) {
      throw notFoundError("Song artifact bundle not found")
    }
    return readyBundle
  } finally {
    db.close()
  }
}

export async function createSongArtifactUpload(input: {
  env: Env
  bearerToken: string
  communityId: string
  body: CreateSongArtifactUploadRequest
  userRepository: UserRepository
  communityRepository: CommunityRepository
  uploadRepository: SongArtifactUploadRepository
}): Promise<SongArtifactUpload> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!community || community.provisioning_state !== "active" || community.status !== "active") {
    throw eligibilityFailed("Community is not available for posting")
  }

  assertSongArtifactUploadRequest(input.body)

  const db = await openCommunityDb(input.communityRepository, input.communityId)
  try {
    await requireMemberAccess(db.client, input.communityId, session.userId)
    await requireVerifiedHuman(input.userRepository, session.userId)
    return await input.uploadRepository.createSongArtifactUpload({
      communityId: input.communityId,
      uploaderUserId: session.userId,
      body: input.body,
      createdAt: nowIso(),
    })
  } finally {
    db.close()
  }
}

export async function uploadSongArtifactContent(input: {
  env: Env
  bearerToken: string
  communityId: string
  uploadId: string
  bytes: Uint8Array
  userRepository: UserRepository
  communityRepository: CommunityRepository
  uploadRepository: SongArtifactUploadRepository
}): Promise<SongArtifactUpload> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!community || community.provisioning_state !== "active" || community.status !== "active") {
    throw eligibilityFailed("Community is not available for posting")
  }

  const db = await openCommunityDb(input.communityRepository, input.communityId)
  try {
    await requireMemberAccess(db.client, input.communityId, session.userId)
    await requireVerifiedHuman(input.userRepository, session.userId)
    const upload = await getOwnedSongArtifactUpload({
      communityId: input.communityId,
      userId: session.userId,
      uploadId: input.uploadId,
      uploadRepository: input.uploadRepository,
    })
    if (upload.status !== "pending_upload") {
      throw badRequestError("Song artifact upload is not pending")
    }

    const persisted = await persistSongArtifactUpload({
      env: input.env,
      uploadId: upload.song_artifact_upload_id,
      bytes: input.bytes,
      artifactKind: upload.artifact_kind,
      mimeType: upload.mime_type,
    })

    if (upload.size_bytes != null && upload.size_bytes !== persisted.sizeBytes) {
      await input.uploadRepository.completeSongArtifactUpload({
        uploadId: upload.song_artifact_upload_id,
        status: "failed",
        storageRef: persisted.storageRef,
        storageProvider: persisted.storageProvider,
        storageBucket: persisted.storageBucket,
        storageObjectKey: persisted.storageObjectKey,
        storageEndpoint: persisted.storageEndpoint,
        gatewayUrl: persisted.gatewayUrl,
        sizeBytes: persisted.sizeBytes,
        contentHash: persisted.contentHash,
        blobPath: persisted.blobPath,
        updatedAt: nowIso(),
      })
      throw badRequestError("Uploaded bytes do not match the declared size_bytes")
    }
    if (upload.content_hash && upload.content_hash !== persisted.contentHash) {
      await input.uploadRepository.completeSongArtifactUpload({
        uploadId: upload.song_artifact_upload_id,
        status: "failed",
        storageRef: persisted.storageRef,
        storageProvider: persisted.storageProvider,
        storageBucket: persisted.storageBucket,
        storageObjectKey: persisted.storageObjectKey,
        storageEndpoint: persisted.storageEndpoint,
        gatewayUrl: persisted.gatewayUrl,
        sizeBytes: persisted.sizeBytes,
        contentHash: persisted.contentHash,
        blobPath: persisted.blobPath,
        updatedAt: nowIso(),
      })
      throw badRequestError("Uploaded bytes do not match the declared content_hash")
    }

    const completed = await input.uploadRepository.completeSongArtifactUpload({
      uploadId: upload.song_artifact_upload_id,
      status: "uploaded",
      storageRef: persisted.storageRef,
      storageProvider: persisted.storageProvider,
      storageBucket: persisted.storageBucket,
      storageObjectKey: persisted.storageObjectKey,
      storageEndpoint: persisted.storageEndpoint,
      gatewayUrl: persisted.gatewayUrl,
      sizeBytes: persisted.sizeBytes,
      contentHash: persisted.contentHash,
      blobPath: persisted.blobPath,
      updatedAt: nowIso(),
    })
    if (!completed) {
      throw notFoundError("Song artifact upload not found")
    }
    return completed
  } finally {
    db.close()
  }
}

export function decodeSongArtifactUploadBody(input: {
  contentType: string | null | undefined
  jsonBody: { content_base64?: unknown } | null
  rawBytes: Uint8Array
}): Uint8Array {
  const contentType = String(input.contentType || "").toLowerCase()
  if (contentType.includes("application/json")) {
    const encoded = typeof input.jsonBody?.content_base64 === "string" ? input.jsonBody.content_base64.trim() : ""
    if (!encoded) {
      throw badRequestError("content_base64 is required")
    }
    return new Uint8Array(Buffer.from(encoded, "base64"))
  }
  if (input.rawBytes.byteLength === 0) {
    throw badRequestError("Upload body is required")
  }
  return input.rawBytes
}

export async function getSongArtifactBundle(input: {
  env: Env
  bearerToken: string
  communityId: string
  bundleId: string
  songArtifactRepository: SongArtifactBundleRepository
}): Promise<SongArtifactBundle> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  const bundle = await input.songArtifactRepository.getSongArtifactBundleById(input.bundleId)
  if (!bundle || bundle.community_id !== input.communityId || bundle.creator_user_id !== session.userId) {
    throw notFoundError("Song artifact bundle not found")
  }
  return bundle
}

export async function castPostVote(input: {
  env: Env
  bearerToken: string
  postId: string
  value: -1 | 1
  userRepository: UserRepository
  communityRepository: CommunityRepository
}): Promise<{ post_id: string; value: -1 | 1 }> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  const projection = await input.communityRepository.getCommunityPostProjectionByPostId(input.postId)
  if (!projection) {
    throw notFoundError("Post not found")
  }

  const db = await openCommunityDb(input.communityRepository, projection.community_id)
  try {
    await requireMemberAccess(db.client, projection.community_id, session.userId)
    const user = await requireVerifiedHuman(input.userRepository, session.userId)
    const post = await getPostById(db.client, input.postId)
    if (!post) {
      throw notFoundError("Post not found")
    }

    return await upsertPostVote({
      client: db.client,
      postId: input.postId,
      communityId: projection.community_id,
      userId: session.userId,
      value: input.value,
      now: nowIso(),
    })
  } finally {
    db.close()
  }
}

export async function getPost(input: {
  env: Env
  bearerToken: string
  postId: string
  locale?: string | null
  communityRepository: CommunityRepository
}): Promise<LocalizedPostResponse> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  const projection = await input.communityRepository.getCommunityPostProjectionByPostId(input.postId)
  if (!projection) {
    throw notFoundError("Post not found")
  }

  const db = await openCommunityDb(input.communityRepository, projection.community_id)
  try {
    const membership = await requireMemberAccess(db.client, projection.community_id, session.userId)
    const post = await getPostById(db.client, input.postId)
    if (!post) {
      throw notFoundError("Post not found")
    }
    const roleAccess = post.status !== "published"
      ? await getCommunityRoleAccessState(db.client, projection.community_id, session.userId)
      : null
    if (post.status !== "published" && getNonPublishedReadRole({
      post,
      userId: session.userId,
      roleAccess,
    }) == null) {
      throw notFoundError("Post not found")
    }
    return toLocalizedPostResponse(post, input.locale ?? undefined)
  } finally {
    db.close()
  }
}

function redactLockedAsset(asset: Asset): Asset {
  if (asset.access_mode !== "locked") {
    return asset
  }
  return {
    ...asset,
    primary_content_ref: null,
    primary_content_hash: null,
  }
}

export async function getCommunityAsset(input: {
  env: Env
  bearerToken: string
  communityId: string
  assetId: string
  communityRepository: CommunityRepository
}): Promise<Asset> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!community || community.provisioning_state !== "active" || community.status !== "active") {
    throw notFoundError("Community not found")
  }

  const db = await openCommunityDb(input.communityRepository, input.communityId)
  try {
    await requireMemberAccess(db.client, input.communityId, session.userId)
    const asset = await getCommunityAssetById({
      client: db.client,
      assetId: input.assetId,
    })
    if (!asset || asset.community_id !== input.communityId) {
      throw notFoundError("Asset not found")
    }
    const sourcePost = await getPostById(db.client, asset.source_post_id)
    if (!sourcePost) {
      throw notFoundError("Asset not found")
    }
    if (sourcePost.status !== "published") {
      const roleAccess = await getCommunityRoleAccessState(db.client, input.communityId, session.userId)
      if (getNonPublishedReadRole({
        post: sourcePost,
        userId: session.userId,
        roleAccess,
      }) == null) {
        throw notFoundError("Asset not found")
      }
    }
    return redactLockedAsset(asset)
  } finally {
    db.close()
  }
}

export async function getCommunityAssetAccess(input: {
  env: Env
  bearerToken: string
  communityId: string
  assetId: string
  communityRepository: CommunityRepository
}): Promise<AssetAccessResponse> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!community || community.provisioning_state !== "active" || community.status !== "active") {
    throw notFoundError("Community not found")
  }

  const db = await openCommunityDb(input.communityRepository, input.communityId)
  try {
    const asset = await getCommunityAssetById({
      client: db.client,
      assetId: input.assetId,
    })
    if (!asset || asset.community_id !== input.communityId) {
      throw notFoundError("Asset not found")
    }

    const sourcePost = await getPostById(db.client, asset.source_post_id)
    if (!sourcePost) {
      throw notFoundError("Asset not found")
    }

    const membership = await getCommunityMembershipState(db.client, input.communityId, session.userId)
    const roleAccess = await getCommunityRoleAccessState(db.client, input.communityId, session.userId)
    const privilegedReason = getNonPublishedReadRole({
      post: sourcePost,
      userId: session.userId,
      roleAccess,
    })
    const hasCommunityVisibility = canAccessCommunity(membership)
    const hasPurchaseEntitlement = await hasActiveAssetAccessEntitlement({
      client: db.client,
      communityId: input.communityId,
      buyerUserId: session.userId,
      assetId: asset.asset_id,
    })

    if (sourcePost.status !== "published" && privilegedReason == null) {
      throw notFoundError("Asset not found")
    }

    if (asset.access_mode === "public") {
      if (!hasCommunityVisibility && privilegedReason == null && !hasPurchaseEntitlement) {
        throw notFoundError("Asset not found")
      }
      return {
        asset_id: asset.asset_id,
        community_id: asset.community_id,
        source_post_id: asset.source_post_id,
        access_mode: asset.access_mode,
        source_post_status: sourcePost.status,
        story_status: asset.story_status,
        locked_delivery_status: asset.locked_delivery_status,
        access_granted: true,
        decision_reason: "public",
        delivery_kind: "primary_content_ref",
        delivery_ref: asset.primary_content_ref,
      }
    }

    if (privilegedReason == null && !hasPurchaseEntitlement) {
      if (!hasCommunityVisibility) {
        throw notFoundError("Asset not found")
      }
      return {
        asset_id: asset.asset_id,
        community_id: asset.community_id,
        source_post_id: asset.source_post_id,
        access_mode: asset.access_mode,
        source_post_status: sourcePost.status,
        story_status: asset.story_status,
        locked_delivery_status: asset.locked_delivery_status,
        access_granted: false,
        decision_reason: "purchase_required",
        delivery_kind: null,
        delivery_ref: null,
      }
    }

    if (asset.locked_delivery_status !== "ready" || !asset.locked_delivery_ref) {
      return {
        asset_id: asset.asset_id,
        community_id: asset.community_id,
        source_post_id: asset.source_post_id,
        access_mode: asset.access_mode,
        source_post_status: sourcePost.status,
        story_status: asset.story_status,
        locked_delivery_status: asset.locked_delivery_status,
        access_granted: false,
        decision_reason: "delivery_pending",
        delivery_kind: null,
        delivery_ref: null,
      }
    }

    return {
      asset_id: asset.asset_id,
      community_id: asset.community_id,
      source_post_id: asset.source_post_id,
      access_mode: asset.access_mode,
      source_post_status: sourcePost.status,
      story_status: asset.story_status,
      locked_delivery_status: asset.locked_delivery_status,
      access_granted: true,
      decision_reason: privilegedReason ?? "purchase_entitlement",
      delivery_kind: "locked_delivery_ref",
      delivery_ref: asset.locked_delivery_ref,
    }
  } finally {
    db.close()
  }
}

function inferDownloadFilename(assetId: string, mimeType: string | null): string {
  const normalized = String(mimeType || "").trim().toLowerCase()
  if (normalized === "audio/mpeg") return `${assetId}.mp3`
  if (normalized === "audio/wav" || normalized === "audio/x-wav") return `${assetId}.wav`
  if (normalized === "audio/mp4") return `${assetId}.m4a`
  if (normalized === "audio/ogg") return `${assetId}.ogg`
  if (normalized === "audio/flac") return `${assetId}.flac`
  return `${assetId}.bin`
}

export async function downloadCommunityAsset(input: {
  env: Env
  bearerToken: string
  communityId: string
  assetId: string
  communityRepository: CommunityRepository
  songArtifactRepository: SongArtifactBundleRepository
  userRepository: UserRepository
}): Promise<{
  bytes: Uint8Array
  mimeType: string
  filename: string
}> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!community || community.provisioning_state !== "active" || community.status !== "active") {
    throw notFoundError("Community not found")
  }

  const db = await openCommunityDb(input.communityRepository, input.communityId)
  try {
    const asset = await getCommunityAssetById({
      client: db.client,
      assetId: input.assetId,
    })
    if (!asset || asset.community_id !== input.communityId) {
      throw notFoundError("Asset not found")
    }

    const sourcePost = await getPostById(db.client, asset.source_post_id)
    if (!sourcePost) {
      throw notFoundError("Asset not found")
    }

    const membership = await getCommunityMembershipState(db.client, input.communityId, session.userId)
    const roleAccess = await getCommunityRoleAccessState(db.client, input.communityId, session.userId)
    const privilegedReason = getNonPublishedReadRole({
      post: sourcePost,
      userId: session.userId,
      roleAccess,
    })
    const hasCommunityVisibility = canAccessCommunity(membership)
    const hasPurchaseEntitlement = await hasActiveAssetAccessEntitlement({
      client: db.client,
      communityId: input.communityId,
      buyerUserId: session.userId,
      assetId: asset.asset_id,
    })

    if (sourcePost.status !== "published" && privilegedReason == null) {
      throw notFoundError("Asset not found")
    }

    if (asset.access_mode === "public") {
      if (!hasCommunityVisibility && privilegedReason == null && !hasPurchaseEntitlement) {
        throw notFoundError("Asset not found")
      }
      const bundle = asset.song_artifact_bundle_id
        ? await input.songArtifactRepository.getSongArtifactBundleById(asset.song_artifact_bundle_id)
        : null
      const mimeType = bundle?.primary_audio.mime_type || "application/octet-stream"
      const primaryContentRef = requireNonEmptyStorageRef(asset.primary_content_ref, "Asset content")
      return {
        bytes: await readStoredSongArtifactBytes(input.env, primaryContentRef),
        mimeType,
        filename: inferDownloadFilename(asset.asset_id, mimeType),
      }
    }

    if (privilegedReason == null && !hasPurchaseEntitlement) {
      if (!hasCommunityVisibility) {
        throw notFoundError("Asset not found")
      }
      throw eligibilityFailed("Locked asset purchase is required")
    }

    if (asset.locked_delivery_status !== "ready" || !asset.locked_delivery_ref) {
      throw eligibilityFailed("Locked delivery is not ready")
    }

    const payload = await getAssetLockedDeliveryPayloadById({
      client: db.client,
      assetId: asset.asset_id,
    })
    if (!payload) {
      if (asset.story_cdr_vault_uuid && String(asset.story_cdr_encrypted_cid || "").trim()) {
        throw badRequestError("Backend download is unavailable for CDR-backed locked assets; use the CDR manifest flow")
      }
      throw notFoundError("Locked delivery payload not found")
    }

    const encryptedBytes = await readStoredSongArtifactBytes(input.env, payload.encrypted_blob_ref)
    let contentKeyBase64 = payload.content_key_base64
    // The external CDR read path only makes sense when the API can issue a Lit access proof.
    // If either half is missing, downloads intentionally fall back to the local recovery payload.
    const shouldUseCdrReadAdapter = hasStoryCdrApiConfigured(input.env)
      && Boolean(String(input.env.LIT_CHIPOTLE_ACCESS_CONTROLLER_API_KEY || "").trim())
    if (shouldUseCdrReadAdapter) {
      const walletAttachments = await input.userRepository.getWalletAttachmentsByUserId(session.userId)
      const callerWallet = walletAttachments.find((attachment) => attachment.is_primary && attachment.chain_namespace.startsWith("eip155:"))
        ?? walletAttachments.find((attachment) => attachment.chain_namespace.startsWith("eip155:"))
      if (!callerWallet) {
        throw eligibilityFailed("A wallet attachment is required for locked asset download")
      }
      const accessProof = await issueStoryAssetAccessProofViaLit({
        env: input.env,
        asset,
        userId: session.userId,
        walletAttachmentId: callerWallet.wallet_attachment_id,
        callerAddress: callerWallet.wallet_address,
        decisionReason: privilegedReason ?? "purchase_entitlement",
        deliveryRef: asset.locked_delivery_ref,
      })
      const cdrRecovery = await readLockedDeliveryFromStoryCdr({
        env: input.env,
        deliveryRef: asset.locked_delivery_ref,
        accessProof,
      })
      contentKeyBase64 = cdrRecovery.contentKeyBase64
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(contentKeyBase64, "base64"),
      Buffer.from(payload.iv_base64, "base64"),
    )
    decipher.setAuthTag(Buffer.from(payload.auth_tag_base64, "base64"))
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encryptedBytes)),
      decipher.final(),
    ])

    return {
      bytes: new Uint8Array(decrypted),
      mimeType: payload.source_mime_type || "application/octet-stream",
      filename: inferDownloadFilename(asset.asset_id, payload.source_mime_type),
    }
  } finally {
    db.close()
  }
}

export async function issueCommunityAssetAccessProof(input: {
  env: Env
  bearerToken: string
  communityId: string
  assetId: string
  walletAttachmentId?: string | null
  communityRepository: CommunityRepository
  userRepository: UserRepository
}): Promise<AssetAccessProofResponse> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  const access = await getCommunityAssetAccess({
    env: input.env,
    bearerToken: input.bearerToken,
    communityId: input.communityId,
    assetId: input.assetId,
    communityRepository: input.communityRepository,
  })

  if (access.access_mode !== "locked") {
    throw badRequestError("asset access proof only applies to locked assets")
  }
  if (!access.access_granted || access.delivery_kind !== "locked_delivery_ref" || !access.delivery_ref) {
    if (access.decision_reason === "delivery_pending") {
      throw eligibilityFailed("Locked delivery is not ready")
    }
    throw eligibilityFailed("Locked asset access is not granted")
  }

  const walletAttachments = await input.userRepository.getWalletAttachmentsByUserId(session.userId)
  const requestedWalletAttachmentId = String(input.walletAttachmentId || "").trim() || null
  const walletAttachment = requestedWalletAttachmentId
    ? walletAttachments.find((attachment) => attachment.wallet_attachment_id === requestedWalletAttachmentId)
    : walletAttachments.find((attachment) => attachment.is_primary) ?? walletAttachments[0]
  if (!walletAttachment) {
    throw eligibilityFailed("A wallet attachment is required for locked asset access proof")
  }
  if (!String(walletAttachment.chain_namespace || "").startsWith("eip155:")) {
    throw eligibilityFailed("Locked asset access proof requires an EVM wallet attachment")
  }

  const db = await openCommunityDb(input.communityRepository, input.communityId)
  try {
    const asset = await getCommunityAssetById({
      client: db.client,
      assetId: input.assetId,
    })
    if (!asset || asset.community_id !== input.communityId) {
      throw notFoundError("Asset not found")
    }

    const decisionReason = access.decision_reason === "creator" || access.decision_reason === "moderator"
      ? access.decision_reason
      : "purchase_entitlement"

    const useDirectAccessSigner = Boolean(String(input.env.STORY_ACCESS_CONTROLLER_PRIVATE_KEY || "").trim())
    return await (useDirectAccessSigner
      ? issueStoryAssetAccessProofViaDirectKey({
        env: input.env,
        asset,
        userId: session.userId,
        walletAttachmentId: walletAttachment.wallet_attachment_id,
        callerAddress: walletAttachment.wallet_address,
        decisionReason,
        deliveryRef: access.delivery_ref,
      })
      : issueStoryAssetAccessProofViaLit({
        env: input.env,
        asset,
        userId: session.userId,
        walletAttachmentId: walletAttachment.wallet_attachment_id,
        callerAddress: walletAttachment.wallet_address,
        decisionReason,
        deliveryRef: access.delivery_ref,
      }))
  } finally {
    db.close()
  }
}

export async function getCommunityAssetCdrManifest(input: {
  env: Env
  bearerToken: string
  communityId: string
  assetId: string
  walletAttachmentId?: string | null
  communityRepository: CommunityRepository
  userRepository: UserRepository
}): Promise<AssetCdrManifestResponse> {
  const defaults = getStoryAeneidDeliveryDefaults()
  const rpcUrl = String(input.env.STORY_AENEID_RPC_URL || defaults.rpcUrl || "").trim()
  const cometRpcUrl = String(input.env.STORY_CDR_COMET_RPC_URL || "").trim() || null
  const dkgSource = cometRpcUrl ? "cosmos-abci" : "evm-events"
  if (!rpcUrl) {
    throw internalError("Story Aeneid RPC URL is unavailable")
  }
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })

  const db = await openCommunityDb(input.communityRepository, input.communityId)
  try {
    const asset = await getCommunityAssetById({
      client: db.client,
      assetId: input.assetId,
    })
    if (!asset || asset.community_id !== input.communityId) {
      throw notFoundError("Asset not found")
    }
    if (asset.access_mode !== "locked") {
      throw badRequestError("asset CDR manifest only applies to locked assets")
    }
    const encryptedCid = String(asset.story_cdr_encrypted_cid || "").trim()
    const encryptedFetchUrl = createSignedSongArtifactDownloadUrl({
      env: input.env,
      uploadId: `cdr_${asset.asset_id}`,
      artifactKind: "locked_payload",
      mimeType: "application/octet-stream",
      expiresInSeconds: 900,
    })
    if (!encryptedCid) {
      throw eligibilityFailed("Locked delivery is not ready")
    }
    if (!asset.story_cdr_vault_uuid || asset.story_cdr_vault_uuid <= 0) {
      throw eligibilityFailed("Locked delivery is not ready")
    }

    const walletAttachments = await input.userRepository.getWalletAttachmentsByUserId(session.userId)
    const requestedWalletAttachmentId = String(input.walletAttachmentId || "").trim() || null
    const walletAttachment = requestedWalletAttachmentId
      ? walletAttachments.find((attachment) => attachment.wallet_attachment_id === requestedWalletAttachmentId)
      : walletAttachments.find((attachment) => attachment.is_primary) ?? walletAttachments[0]
    if (!walletAttachment) {
      throw eligibilityFailed("A wallet attachment is required for locked asset CDR manifest")
    }

    const tokenGateCondition = String(
      input.env.STORY_TOKEN_GATE_CONDITION_ADDRESS
      || defaults.tokenGateCondition
      || "",
    ).trim().toLowerCase()
    const isTokenGateRead = Boolean(tokenGateCondition)
      && String(asset.story_read_condition || "").trim().toLowerCase() === tokenGateCondition

    if (isTokenGateRead) {
      const access = await getCommunityAssetAccess({
        env: input.env,
        bearerToken: input.bearerToken,
        communityId: input.communityId,
        assetId: input.assetId,
        communityRepository: input.communityRepository,
      })
      if (
        !access.access_granted
        || access.decision_reason !== "purchase_entitlement"
        || access.delivery_kind !== "locked_delivery_ref"
        || !access.delivery_ref
      ) {
        throw eligibilityFailed("Token-gated CDR manifest requires a settled purchase entitlement")
      }

      const entitlementTokenAddress = String(
        input.env.STORY_ENTITLEMENT_TOKEN_ADDRESS
        || defaults.purchaseEntitlementToken
        || "",
      ).trim()
      if (!/^0x[a-fA-F0-9]{40}$/.test(entitlementTokenAddress)) {
        throw internalError("Story entitlement token address is unavailable")
      }
      const tokenId = BigInt(String(asset.story_entitlement_token_id || "0"))
      if (tokenId <= 0n) {
        throw eligibilityFailed("Locked delivery is not ready")
      }
      const conditionData = encodeAbiParameters(
        [
          { name: "entitlementToken", type: "address" },
          { name: "tokenId", type: "uint256" },
          { name: "minBalance", type: "uint256" },
        ],
        [entitlementTokenAddress as `0x${string}`, tokenId, 1n],
      )

      return {
        asset_id: asset.asset_id,
        community_id: asset.community_id,
        access_mode: "locked",
        decision_reason: "purchase_entitlement",
        delivery_ref: access.delivery_ref,
        network: "testnet",
        rpc_url: rpcUrl,
        dkg_source: dkgSource,
        comet_rpc_url: cometRpcUrl,
        gateway_base_url: getDefaultGatewayBaseUrl(input.env),
        encrypted_cid: encryptedCid,
        encrypted_fetch_url: encryptedFetchUrl,
        vault_uuid: asset.story_cdr_vault_uuid,
        wallet_attachment_id: walletAttachment.wallet_attachment_id,
        caller_address: walletAttachment.wallet_address,
        signer_family: null,
        signer_address: null,
        verifier_contract: null,
        namespace: null,
        access_ref: null,
        scope: null,
        expiry: null,
        digest: null,
        condition_data: conditionData,
        access_aux_data: "0x",
        signature: null,
        proof: null,
      }
    }

    const accessProof = await issueCommunityAssetAccessProof({
      env: input.env,
      bearerToken: input.bearerToken,
      communityId: input.communityId,
      assetId: input.assetId,
      walletAttachmentId: walletAttachment.wallet_attachment_id,
      communityRepository: input.communityRepository,
      userRepository: input.userRepository,
    })

    return {
      asset_id: asset.asset_id,
      community_id: asset.community_id,
      access_mode: "locked",
      decision_reason: accessProof.decision_reason,
      delivery_ref: accessProof.delivery_ref,
      network: "testnet",
      rpc_url: rpcUrl,
      dkg_source: dkgSource,
      comet_rpc_url: cometRpcUrl,
      gateway_base_url: getDefaultGatewayBaseUrl(input.env),
      encrypted_cid: encryptedCid,
      encrypted_fetch_url: encryptedFetchUrl,
      vault_uuid: asset.story_cdr_vault_uuid,
      wallet_attachment_id: accessProof.wallet_attachment_id,
      caller_address: accessProof.caller_address,
      signer_family: accessProof.signer_family,
      signer_address: accessProof.signer_address,
      verifier_contract: accessProof.verifier_contract,
      namespace: accessProof.namespace,
      access_ref: accessProof.access_ref,
      scope: accessProof.scope,
      expiry: accessProof.expiry,
      digest: accessProof.digest,
      condition_data: accessProof.condition_data,
      access_aux_data: accessProof.access_aux_data,
      signature: accessProof.signature,
      proof: accessProof.proof,
    }
  } finally {
    db.close()
  }
}

export async function listCommunityPosts(input: {
  env: Env
  bearerToken?: string | null
  communityId: string
  locale?: string | null
  limit?: string | null
  cursor?: string | null
  flairId?: string | null
  communityRepository: CommunityRepository
}): Promise<CommunityFeedResponse> {
  const community = await resolveCommunityByReference(input.communityRepository, input.communityId)
  if (!community || community.provisioning_state !== "active" || community.status !== "active") {
    throw notFoundError("Community not found")
  }

  const session = input.bearerToken
    ? await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
    : null

  const db = await openCommunityDb(input.communityRepository, community.community_id)
  try {
    const feed = await listPublishedLocalizedPosts({
      client: db.client,
      communityId: community.community_id,
      viewerUserId: session?.userId ?? null,
      limit: parseFeedLimit(input.limit),
      locale: input.locale ?? undefined,
      flairId: input.flairId ?? null,
      cursor: parseFeedCursor(input.cursor),
    })

    return {
      items: feed.items,
      next_cursor: formatFeedCursor(feed.nextCursor),
    }
  } finally {
    db.close()
  }
}
