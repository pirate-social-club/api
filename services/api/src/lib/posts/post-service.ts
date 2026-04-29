import type { Client } from "../sql-client"
import { openCommunityDb } from "../communities/community-db-factory"
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
  upsertPostVote,
} from "./community-post-store"
import {
  consumeSongPostBundle,
  resolveSongPostBundle,
  resolveVideoPostAsset,
} from "../song-artifacts/song-artifact-post-resolution-service"
import {
  createAssetForPost,
  createSongAssetForPost,
} from "../communities/commerce/service"
import {
  requireMemberAccess,
} from "./post-access"
import {
  enqueueEmbedHydrateIfNeeded,
  enqueuePostLabelIfNeeded,
  enqueuePostTranslationPrewarmJobs,
} from "./post-jobs"
import { analysisBlocked, badRequestError, eligibilityFailed, notFoundError } from "../errors"
import { makeId, nowIso } from "../helpers"
import type { CreatePostRequest, Env, Post } from "../../types"

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
  if (!communityRow || communityRow.provisioning_state !== "active" || communityRow.status !== "active") {
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
        songArtifactBundleId: input.body.song_artifact_bundle_id || "",
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
        song_artifact_bundle_id: resolvedBundle.bundle.song_artifact_bundle_id,
      }

      const postAnalysis = await postAnalysisProvider.analyze({
        env: input.env,
        community,
        body: writeBody,
      })

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
          mergedAnalysisState === "review_required"
            ? "pending"
            : postAnalysis.content_safety_state === "safe"
              ? resolvedBundle.contentSafetyState
              : postAnalysis.content_safety_state,
        age_gate_policy: resolvedBundle.ageGatePolicy === "18_plus" || postAnalysis.age_gate_policy === "18_plus" ? "18_plus" : "none",
        status: mergedAnalysisState === "review_required" ? "draft" : "published",
      }
    } else if (input.body.post_type === "video" && input.body.access_mode) {
      const accessMode = input.body.access_mode
      const resolvedVideo = await resolveVideoPostAsset({
        env: input.env,
        userId: input.userId,
        communityId: input.communityId,
        mediaRefs: input.body.media_refs,
      })
      resolvedVideoAsset = resolvedVideo
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
        media_refs: accessMode === "locked" ? lockedPosterMediaRefs : resolvedVideo.mediaRefs,
        access_mode: accessMode,
        asset_id: input.body.asset_id ?? makeId("ast"),
        rights_basis: input.body.rights_basis ?? (input.body.license_preset || accessMode === "locked" ? "original" : "none"),
      }

      const postAnalysis = await postAnalysisProvider.analyze({
        env: input.env,
        community,
        body: writeBody,
      })
      const mergedAnalysisState = postAnalysis.analysis_state
      if (mergedAnalysisState === "blocked") {
        throw analysisBlocked("Content analysis blocked publication")
      }
      analysisOverride = {
        analysis_state: mergedAnalysisState,
        content_safety_state: mergedAnalysisState === "review_required" ? "pending" : postAnalysis.content_safety_state,
        age_gate_policy: postAnalysis.age_gate_policy,
        status: mergedAnalysisState === "review_required" ? "draft" : "published",
      }
    } else {
      const postAnalysis = await postAnalysisProvider.analyze({
        env: input.env,
        community,
        body: writeBody,
      })
      const mergedAnalysisState = postAnalysis.analysis_state
      if (mergedAnalysisState === "blocked") {
        throw analysisBlocked("Content analysis blocked publication")
      }
      analysisOverride = {
        analysis_state: mergedAnalysisState,
        content_safety_state: mergedAnalysisState === "review_required" ? "pending" : postAnalysis.content_safety_state,
        age_gate_policy: postAnalysis.age_gate_policy,
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

      await tx.commit()
    } catch (error) {
      try {
        await tx.rollback()
      } catch (rollbackError) {
        console.error("[posts] rollback failed while creating post", rollbackError)
      }
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
}): Promise<{ post_id: string; value: -1 | 1 }> {
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
    return vote
  } finally {
    db.close()
  }
}
