import type { Client } from "../sql-client"
import { openCommunityDb } from "../communities/community-db-factory"
import type { UserRepository } from "../auth/repositories"
import type { CommunityRepository } from "../communities/db-community-repository"
import { resolveStubAnalysisOutcome } from "./post-analysis"
import {
  assertPostCreateRequest,
  findPostByIdempotencyKey,
  getPostById,
  insertPost,
  listPublishedLocalizedPosts,
  toLocalizedPostResponse,
  upsertPostVote,
} from "./community-post-store"
import {
  consumeSongPostBundle,
  resolveSongPostBundle,
} from "../song-artifacts/song-artifact-service"
import { createSongAssetForPost } from "../communities/community-commerce-service"
import {
  canAccessCommunity,
  getCommunityMembershipState,
  type CommunityMembershipRow,
} from "../communities/community-membership-store"
import { analysisBlocked, eligibilityFailed, notFoundError, verificationRequired } from "../errors"
import { makeId, nowIso } from "../helpers"
import type { CreatePostRequest, Env, LocalizedPostResponse, Post } from "../../types"

type CommunityFeedResponse = {
  items: LocalizedPostResponse[]
  next_cursor: string | null
}

function parseFeedLimit(limit: string | null | undefined): number {
  const parsed = Number(limit ?? "")
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

async function requireMemberAccess(client: Client, communityId: string, userId: string): Promise<CommunityMembershipRow> {
  const membership = await getCommunityMembershipState(client, communityId, userId)
  if (!canAccessCommunity(membership)) {
    throw notFoundError("Community not found")
  }
  return membership
}

function canReadNonPublishedPost(post: Post, membership: CommunityMembershipRow, userId: string): boolean {
  return membership.role_status === "active" || post.author_user_id === userId
}

function mergeAnalysisState(
  left: Post["analysis_state"],
  right: Post["analysis_state"],
): Post["analysis_state"] {
  const precedence: Record<Post["analysis_state"], number> = {
    blocked: 4,
    review_required: 3,
    allow_with_required_reference: 2,
    allow: 1,
    pending: 0,
  }
  return precedence[left] >= precedence[right] ? left : right
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

export async function createPost(input: {
  env: Env
  userId: string
  communityId: string
  body: CreatePostRequest
  userRepository: UserRepository
  communityRepository: CommunityRepository
}): Promise<Post> {
  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!community || community.provisioning_state !== "active" || community.status !== "active") {
    throw eligibilityFailed("Community is not available for posting")
  }

  assertPostCreateRequest(input.body, input.communityId)

  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireMemberAccess(db.client, input.communityId, input.userId)
    await requireVerifiedHuman(input.userRepository, input.userId)
    const stubAnalysis = resolveStubAnalysisOutcome(input.body)
    if (stubAnalysis.analysis_state === "blocked") {
      throw analysisBlocked("Content analysis blocked publication")
    }

    const idempotencyKey = input.body.idempotency_key?.trim() ?? ""
    const existing = idempotencyKey
      ? await findPostByIdempotencyKey({
          client: db.client,
          communityId: input.communityId,
          authorUserId: input.userId,
          idempotencyKey,
        })
      : null
    if (existing) {
      return existing
    }

  let writeBody = input.body
  let analysisOverride: Pick<Post, "analysis_state" | "content_safety_state" | "age_gate_policy" | "status"> | undefined
  let resolvedSongBundleForAsset: Awaited<ReturnType<typeof resolveSongPostBundle>> | null = null

    if (input.body.post_type === "song") {
      const resolvedBundle = await resolveSongPostBundle({
        env: input.env,
        userId: input.userId,
        communityId: input.communityId,
        songArtifactBundleId: input.body.song_artifact_bundle_id || "",
        rightsBasis: input.body.rights_basis,
        upstreamAssetRefs: input.body.upstream_asset_refs ?? null,
      })
      resolvedSongBundleForAsset = resolvedBundle

      const accessMode = input.body.access_mode ?? "public"
      const mediaRefs = accessMode === "locked"
        ? resolvedBundle.bundle.preview_audio?.storage_ref && resolvedBundle.bundle.preview_audio?.mime_type
          ? [{
              storage_ref: resolvedBundle.bundle.preview_audio.storage_ref,
              mime_type: resolvedBundle.bundle.preview_audio.mime_type,
              size_bytes: resolvedBundle.bundle.preview_audio.size_bytes ?? null,
              content_hash: resolvedBundle.bundle.preview_audio.content_hash ?? null,
              duration_ms: resolvedBundle.bundle.preview_audio.duration_ms ?? null,
            }]
          : []
        : resolvedBundle.mediaRefs

      writeBody = {
        ...input.body,
        identity_mode: "public",
        media_refs: mediaRefs,
        lyrics: resolvedBundle.lyrics,
        access_mode: accessMode,
        asset_id: input.body.asset_id ?? makeId("ast"),
        song_artifact_bundle_id: resolvedBundle.bundle.song_artifact_bundle_id,
      }

      const stubAnalysis = resolveStubAnalysisOutcome(writeBody)
      if (stubAnalysis.analysis_state === "blocked") {
        throw analysisBlocked("Content analysis blocked publication")
      }

      const mergedAnalysisState = mergeAnalysisState(
        resolvedBundle.analysisState,
        stubAnalysis.analysis_state,
      )
      analysisOverride = {
        analysis_state: mergedAnalysisState,
        content_safety_state:
          mergedAnalysisState === "review_required"
            ? "pending"
            : resolvedBundle.contentSafetyState,
        age_gate_policy: resolvedBundle.ageGatePolicy,
        status: mergedAnalysisState === "review_required" ? "draft" : "published",
      }
    } else {
      const stubAnalysis = resolveStubAnalysisOutcome(writeBody)
      if (stubAnalysis.analysis_state === "blocked") {
        throw analysisBlocked("Content analysis blocked publication")
      }
    }
    const createdAt = nowIso()
    const post = await insertPost({
      client: db.client,
      communityId: input.communityId,
      authorUserId: input.userId,
      body: writeBody,
      createdAt,
      analysisOverride,
    })

    await input.communityRepository.recordCommunityPostProjection({
      communityId: input.communityId,
      sourcePostId: post.post_id,
      authorUserId: post.author_user_id ?? null,
      identityMode: post.identity_mode,
      postType: post.post_type,
      status: post.status,
      sourceCreatedAt: post.created_at,
      projectedPayloadJson: JSON.stringify(post),
      actorUserId: input.userId,
      createdAt,
    })

    if (post.post_type === "song" && post.song_artifact_bundle_id) {
      if (resolvedSongBundleForAsset) {
        await createSongAssetForPost({
          env: input.env,
          client: db.client,
          communityId: input.communityId,
          post,
          bundle: resolvedSongBundleForAsset.bundle,
          userRepository: input.userRepository,
        })
      }
      await consumeSongPostBundle({
        env: input.env,
        communityId: input.communityId,
        songArtifactBundleId: post.song_artifact_bundle_id,
      })
    }

    return post
  } finally {
    db.close()
  }
}

export async function castPostVote(input: {
  env: Env
  userId: string
  postId: string
  value: -1 | 1
  userRepository: UserRepository
  communityRepository: CommunityRepository
}): Promise<{ post_id: string; value: -1 | 1 }> {
  const projection = await input.communityRepository.getCommunityPostProjectionByPostId(input.postId)
  if (!projection) {
    throw notFoundError("Post not found")
  }

  const db = await openCommunityDb(input.env, input.communityRepository, projection.community_id)
  try {
    await requireMemberAccess(db.client, projection.community_id, input.userId)
    await requireVerifiedHuman(input.userRepository, input.userId)
    const post = await getPostById(db.client, input.postId)
    if (!post) {
      throw notFoundError("Post not found")
    }

    return await upsertPostVote({
      client: db.client,
      postId: input.postId,
      communityId: projection.community_id,
      userId: input.userId,
      value: input.value,
      now: nowIso(),
    })
  } finally {
    db.close()
  }
}

export async function getPost(input: {
  env: Env
  userId: string
  postId: string
  locale?: string | null
  communityRepository: CommunityRepository
}): Promise<LocalizedPostResponse> {
  const projection = await input.communityRepository.getCommunityPostProjectionByPostId(input.postId)
  if (!projection) {
    throw notFoundError("Post not found")
  }

  const db = await openCommunityDb(input.env, input.communityRepository, projection.community_id)
  try {
    const membership = await requireMemberAccess(db.client, projection.community_id, input.userId)
    const post = await getPostById(db.client, input.postId)
    if (!post) {
      throw notFoundError("Post not found")
    }
    if (post.status !== "published" && !canReadNonPublishedPost(post, membership, input.userId)) {
      throw notFoundError("Post not found")
    }
    return toLocalizedPostResponse(post, input.locale ?? undefined)
  } finally {
    db.close()
  }
}

export async function listCommunityPosts(input: {
  env: Env
  userId: string
  communityId: string
  locale?: string | null
  limit?: string | null
  cursor?: string | null
  flairId?: string | null
  communityRepository: CommunityRepository
}): Promise<CommunityFeedResponse> {
  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!community || community.provisioning_state !== "active" || community.status !== "active") {
    throw notFoundError("Community not found")
  }

  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireMemberAccess(db.client, input.communityId, input.userId)
    const feed = await listPublishedLocalizedPosts({
      client: db.client,
      communityId: input.communityId,
      viewerUserId: input.userId,
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
