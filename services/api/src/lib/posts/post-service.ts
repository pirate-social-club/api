import type { Client } from "../sql-client"
import { openCommunityDb } from "../communities/community-db-factory"
import { isCommunityLive } from "../communities/community-status"
import { safeRollback } from "../transactions"
import type { ProfileRepository, UserRepository } from "../auth/repositories"
import type {
  CommunityDatabaseBindingRepository,
  CommunityPostProjectionRepository,
  CommunityReadRepository,
} from "../communities/db-community-repository"
import { loadCommunityProjection } from "../communities/create/repository"
import { authorizeAgentWrite } from "../agents/agent-write-authorization"
import {
  mergeAnalysisState,
  resolvePostAnalysisProvider,
} from "./post-analysis"
import {
  assertPostCreateRequest,
  findPostByIdempotencyKey,
  getCommunityPostPolicy,
  getPostById,
  getPostProjectionMetrics,
  insertPost,
  markPostDeleted,
  setPostCommentsLocked,
  setPostStatus,
  upsertPostVote,
} from "./community-post-store"
import {
  consumeSongPostBundle,
  resolveSongPostBundle,
  resolveVideoPostAsset,
} from "../song-artifacts/song-artifact-post-resolution-service"
import { buildPublicSongArtifactContentUrl } from "../song-artifacts/song-artifact-storage"
import {
  createAssetForPost,
  createSongAssetForPost,
} from "../communities/commerce/service"
import {
  requireMemberAccess,
} from "./post-access"
import {
  ANY_COMMUNITY_ROLE,
  hasCommunityRole,
} from "../communities/membership/membership-state-store"
import {
  enqueueEmbedHydrateIfNeeded,
  enqueuePostLabelIfNeeded,
  enqueuePostTranslationPrewarmJobs,
} from "./post-jobs"
import { analysisBlocked, badRequestError, eligibilityFailed, notFoundError } from "../errors"
import { makeId, nowIso } from "../helpers"
import type { Env } from "../../env"
import type { CreatePostRequest, Post } from "../../types"
import { decodePublicSongArtifactBundleId, publicPostId } from "../public-ids"
import {
  createModerationCase,
  createModerationSignal,
} from "../moderation/community-moderation-store"
import type { ModerationSignalSeverity } from "../moderation/moderation-types"

export {
  getPost,
  getPublicPost,
  listCommunityPosts,
  listPublicCommunityPosts,
} from "./post-read-service"

type PostServiceCommunityRepository =
  & CommunityReadRepository
  & CommunityDatabaseBindingRepository
  & CommunityPostProjectionRepository

async function syncPostProjectionMetrics(input: {
  client: Client
  communityRepository: Pick<CommunityPostProjectionRepository, "updateCommunityPostProjectionMetrics">
  postId: string
  updatedAt: string
}): Promise<void> {
  const metrics = await getPostProjectionMetrics(input.client, input.postId)
  await input.communityRepository.updateCommunityPostProjectionMetrics({
    postId: input.postId,
    upvoteCount: metrics.upvoteCount,
    downvoteCount: metrics.downvoteCount,
    commentCount: metrics.commentCount,
    likeCount: metrics.likeCount,
    updatedAt: input.updatedAt,
  })
}

function resolveAnonymousScope(input: {
  policyScope: Exclude<Post["anonymous_scope"], null> | undefined
  requestedScope: Exclude<Post["anonymous_scope"], null> | undefined
}): Exclude<Post["anonymous_scope"], null> {
  const allowedScope = input.policyScope ?? "community_stable"
  const requestedScope = input.requestedScope ?? allowedScope

  if (requestedScope !== allowedScope) {
    throw badRequestError("anonymous_scope does not match the community policy")
  }

  return requestedScope
}

const HIGH_SEVERITY_VISUAL_REASON_CODES = new Set([
  "possible_minor_with_adult_content",
  "explicit_sexual_activity",
  "visible_genitals",
  "voyeuristic_or_hidden_camera",
  "deepfake_or_face_swap_risk",
  "celebrity_adult_likeness",
  "gore_or_injury",
  "hate_symbols",
  "weapons",
])

function readProviderCategories(providerResult: unknown): string[] {
  if (!providerResult || typeof providerResult !== "object" || !("categories" in providerResult)) {
    return []
  }
  const categories = (providerResult as { categories?: unknown }).categories
  if (!categories || typeof categories !== "object") {
    return []
  }
  return Object.keys(categories).filter((key) => (categories as Record<string, unknown>)[key] === true)
}

function readVisualPolicyReasonCodes(providerResult: unknown): string[] {
  if (!providerResult || typeof providerResult !== "object") {
    return []
  }
  const visualPolicy = (providerResult as { visual_policy?: unknown }).visual_policy
  if (!visualPolicy || typeof visualPolicy !== "object") {
    return []
  }
  const decision = (visualPolicy as { decision?: unknown }).decision
  if (!decision || typeof decision !== "object") {
    return []
  }
  const reasonCodes = (decision as { reasonCodes?: unknown }).reasonCodes
  return Array.isArray(reasonCodes) ? reasonCodes.filter((code): code is string => typeof code === "string") : []
}

export function moderationSeverityFromProviderResult(providerResult: unknown): ModerationSignalSeverity {
  const categories = readProviderCategories(providerResult)
  if (categories.some((category) => category === "sexual/minors" || category === "violence/graphic" || category === "self-harm/intent")) {
    return "high"
  }
  const visualReasonCodes = readVisualPolicyReasonCodes(providerResult)
  if (visualReasonCodes.some((code) => HIGH_SEVERITY_VISUAL_REASON_CODES.has(code))) {
    return "high"
  }
  if (categories.length > 0 || visualReasonCodes.length > 0) {
    return "medium"
  }
  return "low"
}

export async function createPost(input: {
  env: Env
  requestUrl: string
  userId: string
  communityId: string
  body: CreatePostRequest
  bypassAuthorAccessChecks?: boolean
  userRepository: UserRepository
  profileRepository: ProfileRepository
  communityRepository: PostServiceCommunityRepository
}): Promise<Post> {
  const communityRow = await input.communityRepository.getCommunityById(input.communityId)
  if (!isCommunityLive(communityRow)) {
    throw eligibilityFailed("Community is not available for posting")
  }
  const community = await loadCommunityProjection(input.env, input.communityRepository, communityRow)

  assertPostCreateRequest(input.body, input.communityId)

  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    const postAnalysisProvider = resolvePostAnalysisProvider(input.env)
    if (!input.bypassAuthorAccessChecks) {
      await requireMemberAccess(db.client, input.communityId, input.userId)
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
    const agentWriteAuthorization = await authorizeAgentWrite({
      env: input.env,
      requestUrl: input.requestUrl,
      userId: input.userId,
      body: input.body,
      community,
      communityDbClient: db.client,
      profileRepository: input.profileRepository,
      writeTarget: "top_level_post",
    })
    let analysisOverride: Pick<Post, "analysis_state" | "content_safety_state" | "age_gate_policy" | "status"> | undefined
    let analysisProviderResult: Record<string, unknown> | null | undefined
    let resolvedSongBundleForAsset: Awaited<ReturnType<typeof resolveSongPostBundle>> | null = null
    let resolvedVideoAsset: Awaited<ReturnType<typeof resolveVideoPostAsset>> | null = null

    if ((input.body.identity_mode ?? "public") === "anonymous") {
      const policy = await getCommunityPostPolicy(db.client, input.communityId)
      if (!policy) {
        throw notFoundError("Community not found")
      }
      if (!policy.allow_anonymous_identity) {
        throw eligibilityFailed("Anonymous posts are not enabled in this community")
      }

      writeBody = {
        ...input.body,
        anonymous_scope: resolveAnonymousScope({
          policyScope: policy.anonymous_identity_scope ?? undefined,
          requestedScope: input.body.anonymous_scope ?? undefined,
        }),
      }
    }

    if (input.body.post_type === "song") {
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
      resolvedSongBundleForAsset = resolvedBundle

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
        song_artifact_bundle: resolvedBundle.bundle.id,
      }

      const postAnalysis = await postAnalysisProvider.analyze({
        env: input.env,
        community,
        body: writeBody,
      })
      analysisProviderResult = postAnalysis.providerResult

      const mergedAnalysisState = mergeAnalysisState(
        resolvedBundle.analysisState,
        postAnalysis.analysis_state,
      )
      if (mergedAnalysisState === "blocked") {
        throw analysisBlocked("Content analysis blocked publication")
      }
      analysisOverride = {
        analysis_state: mergedAnalysisState,
        content_safety_state:
          mergedAnalysisState === "review_required" && postAnalysis.content_safety_state !== "adult"
            ? "pending"
            : postAnalysis.content_safety_state === "safe"
              ? resolvedBundle.contentSafetyState
              : postAnalysis.content_safety_state,
        age_gate_policy: community.default_age_gate_policy === "18_plus" || resolvedBundle.ageGatePolicy === "18_plus" || postAnalysis.age_gate_policy === "18_plus" ? "18_plus" : "none",
        status: mergedAnalysisState === "review_required" ? "draft" : "published",
      }
    } else if (input.body.post_type === "video") {
      const accessMode = input.body.access_mode ?? "public"
      const resolvedVideo = await resolveVideoPostAsset({
        env: input.env,
        userId: input.userId,
        communityId: input.communityId,
        mediaRefs: input.body.media_refs,
      })
      resolvedVideoAsset = resolvedVideo
      const publicVideoMediaRefs = resolvedVideo.mediaRefs.map((mediaRef) => ({
        ...mediaRef,
        storage_ref: buildPublicSongArtifactContentUrl(
          new URL(input.requestUrl).origin,
          input.communityId,
          resolvedVideo.upload.id,
        ),
      }))
      const lockedPosterMediaRefs = resolvedVideo.mediaRefs[0]?.poster_ref
        ? [{
          ...resolvedVideo.mediaRefs[0],
          storage_ref: "",
          content_hash: null,
        }]
        : []

      writeBody = {
        ...input.body,
        identity_mode: "public",
        media_refs: accessMode === "locked" ? lockedPosterMediaRefs : publicVideoMediaRefs,
        access_mode: input.body.access_mode,
        asset_id: input.body.access_mode ? input.body.asset_id ?? makeId("ast") : input.body.asset_id,
        rights_basis: input.body.rights_basis ?? (input.body.license_preset || accessMode === "locked" ? "original" : "none"),
      }

      const postAnalysis = await postAnalysisProvider.analyze({
        env: input.env,
        community,
        body: writeBody,
      })
      analysisProviderResult = postAnalysis.providerResult
      const mergedAnalysisState = postAnalysis.analysis_state
      if (mergedAnalysisState === "blocked") {
        throw analysisBlocked("Content analysis blocked publication")
      }
      analysisOverride = {
        analysis_state: mergedAnalysisState,
        content_safety_state: mergedAnalysisState === "review_required" && postAnalysis.content_safety_state !== "adult" ? "pending" : postAnalysis.content_safety_state,
        age_gate_policy: community.default_age_gate_policy === "18_plus" || postAnalysis.age_gate_policy === "18_plus" ? "18_plus" : "none",
        status: mergedAnalysisState === "review_required" ? "draft" : "published",
      }
    } else {
      const postAnalysis = await postAnalysisProvider.analyze({
        env: input.env,
        community,
        body: writeBody,
      })
      analysisProviderResult = postAnalysis.providerResult
      const mergedAnalysisState = postAnalysis.analysis_state
      if (mergedAnalysisState === "blocked") {
        throw analysisBlocked("Content analysis blocked publication")
      }
      analysisOverride = {
        analysis_state: mergedAnalysisState,
        content_safety_state: mergedAnalysisState === "review_required" && postAnalysis.content_safety_state !== "adult" ? "pending" : postAnalysis.content_safety_state,
        age_gate_policy: community.default_age_gate_policy === "18_plus" || postAnalysis.age_gate_policy === "18_plus" ? "18_plus" : "none",
        status: mergedAnalysisState === "review_required" ? "draft" : "published",
      }
    }
    const createdAt = nowIso()
    const tx = await db.client.transaction("write")
    let post: Post
    try {
      post = await insertPost({
        client: tx,
        communityId: input.communityId,
        authorUserId: input.userId,
        body: writeBody,
        createdAt,
        analysisOverride,
        agentWriteAuthorization: agentWriteAuthorization ?? undefined,
      })

      await enqueuePostTranslationPrewarmJobs({
        client: tx,
        communityId: input.communityId,
        post,
        createdAt,
      })

      await enqueuePostLabelIfNeeded({
        client: tx,
        community,
        communityId: input.communityId,
        post,
        createdAt,
      })

      await enqueueEmbedHydrateIfNeeded({
        client: tx,
        communityId: input.communityId,
        post,
        createdAt,
      })

      if (analysisOverride?.analysis_state === "review_required") {
        const providerResult = analysisProviderResult
        const severity = moderationSeverityFromProviderResult(providerResult)
        const moderationCase = await createModerationCase({
          executor: tx,
          communityId: input.communityId,
          target: { postId: post.post_id },
          priority: severity,
          openedBy: "platform_analysis",
          now: createdAt,
        })
        const categories = readProviderCategories(providerResult)
        const visualReasonCodes = readVisualPolicyReasonCodes(providerResult)
        const signalTypes = categories.length > 0 ? categories : visualReasonCodes
        await createModerationSignal({
          executor: tx,
          communityId: input.communityId,
          postId: post.post_id,
          moderationCaseId: moderationCase.moderation_case_id,
          signalType: signalTypes.length > 0 ? signalTypes.join(",") : "review_required",
          severity,
          provider: (providerResult && typeof providerResult === "object" && "provider" in providerResult
            ? String((providerResult as { provider: string }).provider)
            : "openai"),
          providerLabel: signalTypes.length > 0 ? signalTypes[0] as string : "review_required",
          analysisResultRef: null,
          evidenceRef: providerResult ? JSON.stringify(providerResult) : null,
          now: createdAt,
        })
      }

      await tx.commit()
    } catch (error) {
      await safeRollback(tx, "[posts] rollback failed while creating post")
      throw error
    } finally {
      tx.close()
    }

    await input.communityRepository.recordCommunityPostProjection({
      communityId: input.communityId,
      sourcePostId: post.post_id,
      authorUserId: post.author_user_id ?? null,
      identityMode: post.identity_mode,
      postType: post.post_type,
      status: post.status,
      visibility: post.visibility,
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
          licensePreset: input.body.license_preset ?? null,
          commercialRevSharePct: input.body.commercial_rev_share_pct ?? null,
          userRepository: input.userRepository,
        })
      }
      await consumeSongPostBundle({
        env: input.env,
        communityId: input.communityId,
        songArtifactBundleId: post.song_artifact_bundle_id,
      })
    }
    if (post.post_type === "video" && post.access_mode && resolvedVideoAsset) {
      await createAssetForPost({
        env: input.env,
        client: db.client,
        communityId: input.communityId,
        post,
        assetKind: "video_file",
        storageRef: resolvedVideoAsset.upload.gateway_url || resolvedVideoAsset.upload.storage_ref,
        mimeType: resolvedVideoAsset.upload.mime_type,
        contentHash: resolvedVideoAsset.upload.content_hash ?? null,
        artifactKind: "primary_video",
        bundleId: null,
        licensePreset: input.body.license_preset ?? null,
        commercialRevSharePct: input.body.commercial_rev_share_pct ?? null,
        userRepository: input.userRepository,
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
  bypassVoterAccessChecks?: boolean
  userRepository: UserRepository
  communityRepository: PostServiceCommunityRepository
}): Promise<{ post: string; value: -1 | 1 }> {
  const projection = await input.communityRepository.getCommunityPostProjectionByPostId(input.postId)
  if (!projection) {
    throw notFoundError("Post not found")
  }

  const db = await openCommunityDb(input.env, input.communityRepository, projection.community_id)
  try {
    if (!input.bypassVoterAccessChecks) {
      await requireMemberAccess(db.client, projection.community_id, input.userId)
    }
    const post = await getPostById(db.client, input.postId)
    if (!post) {
      throw notFoundError("Post not found")
    }
    if (post.status !== "published") {
      throw badRequestError("Cannot vote on a post that is not published")
    }

    const now = nowIso()
    const vote = await upsertPostVote({
      client: db.client,
      postId: input.postId,
      communityId: projection.community_id,
      userId: input.userId,
      value: input.value,
      now,
    })
    await syncPostProjectionMetrics({
      client: db.client,
      communityRepository: input.communityRepository,
      postId: input.postId,
      updatedAt: now,
    })
    return {
      post: publicPostId(vote.post_id),
      value: vote.value,
    }
  } finally {
    db.close()
  }
}

export type DeletePostResult = {
  post: Pick<Post, "post_id" | "status" | "updated_at">
  deletedAt: string
  alreadyDeleted: boolean
}

export async function deletePost(input: {
  env: Env
  userId: string
  communityId: string
  postId: string
  communityRepository: PostServiceCommunityRepository
}): Promise<DeletePostResult> {
  const projection = await input.communityRepository.getCommunityPostProjectionByPostId(input.postId)
  if (!projection || projection.community_id !== input.communityId) {
    throw notFoundError("Post not found")
  }

  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireMemberAccess(db.client, input.communityId, input.userId)
    const post = await getPostById(db.client, input.postId)
    if (!post || post.community_id !== input.communityId) {
      throw notFoundError("Post not found")
    }
    if (post.author_user_id !== input.userId) {
      throw eligibilityFailed("You do not have permission to delete this post")
    }
    if (post.status === "deleted") {
      return {
        post: {
          post_id: post.post_id,
          status: post.status,
          updated_at: post.updated_at,
        },
        deletedAt: post.updated_at,
        alreadyDeleted: true,
      }
    }
    if (post.status !== "published") {
      throw badRequestError("Cannot delete a post that is not published")
    }

    const deletedAt = nowIso()
    const tx = await db.client.transaction("write")
    try {
      const deleted = await markPostDeleted({
        executor: tx,
        postId: input.postId,
        now: deletedAt,
      })
      await tx.commit()

      await input.communityRepository.updateCommunityPostProjectionStatus({
        postId: input.postId,
        status: "deleted",
        updatedAt: deletedAt,
      })

      return {
        post: {
          post_id: deleted.post_id,
          status: deleted.status,
          updated_at: deleted.updated_at,
        },
        deletedAt,
        alreadyDeleted: false,
      }
    } catch (error) {
      await safeRollback(tx, "[posts] rollback failed while deleting post")
      throw error
    } finally {
      tx.close()
    }
  } finally {
    db.close()
  }
}

export async function removePostAsModerator(input: {
  env: Env
  userId: string
  communityId: string
  postId: string
  communityRepository: PostServiceCommunityRepository
}): Promise<Post> {
  const projection = await input.communityRepository.getCommunityPostProjectionByPostId(input.postId)
  if (!projection || projection.community_id !== input.communityId) {
    throw notFoundError("Post not found")
  }

  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    const membership = await requireMemberAccess(db.client, input.communityId, input.userId)
    if (!hasCommunityRole(membership, ANY_COMMUNITY_ROLE)) {
      throw eligibilityFailed("Moderator access is required")
    }
    const post = await getPostById(db.client, input.postId)
    if (!post || post.community_id !== input.communityId) {
      throw notFoundError("Post not found")
    }
    if (post.status === "deleted") {
      throw badRequestError("Cannot remove a deleted post")
    }
    if (post.status === "removed") {
      return post
    }

    const updatedAt = nowIso()
    const updated = await setPostStatus({
      executor: db.client,
      postId: input.postId,
      status: "removed",
      now: updatedAt,
    })
    await input.communityRepository.updateCommunityPostProjectionStatus({
      postId: input.postId,
      status: "removed",
      updatedAt,
    })
    return updated
  } finally {
    db.close()
  }
}

export async function setPostCommentLock(input: {
  env: Env
  userId: string
  communityId: string
  postId: string
  locked: boolean
  reason?: string | null
  communityRepository: PostServiceCommunityRepository
}): Promise<Post> {
  const projection = await input.communityRepository.getCommunityPostProjectionByPostId(input.postId)
  if (!projection || projection.community_id !== input.communityId) {
    throw notFoundError("Post not found")
  }

  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    const membership = await requireMemberAccess(db.client, input.communityId, input.userId)
    if (!hasCommunityRole(membership, ANY_COMMUNITY_ROLE)) {
      throw eligibilityFailed("Moderator access is required")
    }
    const post = await getPostById(db.client, input.postId)
    if (!post || post.community_id !== input.communityId) {
      throw notFoundError("Post not found")
    }
    if (post.status !== "published") {
      throw badRequestError("Cannot lock comments on a post that is not published")
    }

    return await setPostCommentsLocked({
      executor: db.client,
      postId: input.postId,
      locked: input.locked,
      actorUserId: input.userId,
      reason: input.reason?.trim() || null,
      now: nowIso(),
    })
  } finally {
    db.close()
  }
}
