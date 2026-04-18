import type { Client } from "../sql-client"
import { openCommunityDb } from "../communities/community-db-factory"
import type { UserRepository } from "../auth/repositories"
import type { CommunityRepository } from "../communities/db-community-repository"
import { resolveStubAnalysisOutcome } from "./post-analysis"
import {
  assertPostCreateRequest,
  findPostByIdempotencyKey,
  getCommunityPostPolicy,
  getPostById,
  getPostProjectionMetrics,
  insertPost,
  listPublishedLocalizedPosts,
  upsertPostVote,
} from "./community-post-store"
import { getLatestThreadSnapshotForRead } from "../comments/community-comment-store"
import { buildLocalizedPostResponse } from "../localization/post-localization-service"
import { CONTENT_TRANSLATION_PREWARM_LOCALES, sameLanguageLocale } from "../localization/content-locale"
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
import { enqueueCommunityJob } from "../communities/community-job-store"
import { analysisBlocked, badRequestError, eligibilityFailed, notFoundError, verificationRequired } from "../errors"
import { makeId, nowIso } from "../helpers"
import type { CreatePostRequest, Env, LocalizedPostResponse, Post } from "../../types"

type CommunityFeedResponse = {
  items: LocalizedPostResponse[]
  next_cursor: string | null
}

type PostFeedSort = "best" | "new" | "top"

async function enqueuePostTranslationJob(input: {
  client: Client
  communityId: string
  postId: string
  locale: string
  createdAt: string
}): Promise<void> {
  await enqueueCommunityJob({
    client: input.client,
    communityId: input.communityId,
    jobType: "post_translation_materialize",
    subjectType: "post_translation",
    subjectId: `${input.postId}:${input.locale}`,
    payloadJson: JSON.stringify({
      post_id: input.postId,
      locale: input.locale,
    }),
    createdAt: input.createdAt,
  })
}

async function enqueuePostTranslationPrewarmJobs(input: {
  client: Client
  communityId: string
  post: Post
  createdAt: string
}): Promise<void> {
  const translationPolicy = input.post.translation_policy ?? "none"
  if (translationPolicy !== "machine_allowed" && translationPolicy !== "hybrid") {
    return
  }

  for (const locale of CONTENT_TRANSLATION_PREWARM_LOCALES) {
    if (sameLanguageLocale(input.post.source_language, locale)) {
      continue
    }
    await enqueuePostTranslationJob({
      client: input.client,
      communityId: input.communityId,
      postId: input.post.post_id,
      locale,
      createdAt: input.createdAt,
    })
  }
}

async function enqueuePostTranslationOnReadIfNeeded(input: {
  client: Client
  communityId: string
  response: LocalizedPostResponse
}): Promise<void> {
  const response = input.response
  const needsTranslationJob = response.translation_state === "pending"
    || (
      response.translation_state === "ready"
      && (
        (String(response.post.title ?? "").trim() && !String(response.translated_title ?? "").trim())
        || (String(response.post.body ?? "").trim() && !String(response.translated_body ?? "").trim())
        || (String(response.post.caption ?? "").trim() && !String(response.translated_caption ?? "").trim())
      )
    )
  if (!needsTranslationJob) {
    return
  }
  await enqueuePostTranslationJob({
    client: input.client,
    communityId: input.communityId,
    postId: response.post.post_id,
    locale: response.resolved_locale,
    createdAt: nowIso(),
  })
}

function parseFeedLimit(limit: string | null | undefined): number {
  if (typeof limit !== "string" || limit.trim() === "") {
    return 25
  }

  const parsed = Number(limit)
  if (!Number.isFinite(parsed)) {
    return 25
  }
  return Math.min(100, Math.max(1, Math.trunc(parsed)))
}

function parseFeedCursor(cursor: string | null | undefined): string | null {
  return typeof cursor === "string" && cursor.trim() ? cursor : null
}

function formatFeedCursor(cursor: string | null): string | null {
  return cursor ?? null
}

function parsePostFeedSort(sort: string | null | undefined): PostFeedSort {
  return sort === "new" || sort === "top" ? sort : "best"
}

async function syncPostProjectionMetrics(input: {
  client: Client
  communityRepository: CommunityRepository
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

    await enqueuePostTranslationPrewarmJobs({
      client: db.client,
      communityId: input.communityId,
      post,
      createdAt,
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
    const threadSnapshot = await getLatestThreadSnapshotForRead(db.client, post.post_id)
    const response = await buildLocalizedPostResponse({
      executor: db.client,
      post,
      locale: input.locale ?? undefined,
      threadSnapshot,
    })
    await enqueuePostTranslationOnReadIfNeeded({
      client: db.client,
      communityId: projection.community_id,
      response,
    })
    return response
  } finally {
    db.close()
  }
}

export async function getPublicPost(input: {
  env: Env
  postId: string
  locale?: string | null
  communityRepository: CommunityRepository
}): Promise<LocalizedPostResponse> {
  const projection = await input.communityRepository.getCommunityPostProjectionByPostId(input.postId)
  if (!projection) {
    throw notFoundError("Post not found")
  }

  const community = await input.communityRepository.getCommunityById(projection.community_id)
  if (!community || community.provisioning_state !== "active" || community.status !== "active") {
    throw notFoundError("Post not found")
  }

  const db = await openCommunityDb(input.env, input.communityRepository, projection.community_id)
  try {
    const post = await getPostById(db.client, input.postId)
    if (!post || post.status !== "published") {
      throw notFoundError("Post not found")
    }
    const threadSnapshot = await getLatestThreadSnapshotForRead(db.client, post.post_id)
    const response = await buildLocalizedPostResponse({
      executor: db.client,
      post,
      locale: input.locale ?? undefined,
      threadSnapshot,
    })
    await enqueuePostTranslationOnReadIfNeeded({
      client: db.client,
      communityId: projection.community_id,
      response,
    })
    return response
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
  sort?: string | null
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
      flairId: input.flairId ?? null,
      sort: parsePostFeedSort(input.sort),
      cursor: parseFeedCursor(input.cursor),
    })

    const items = await Promise.all(feed.items.map((item) => buildLocalizedPostResponse({
      executor: db.client,
      post: item.post,
      locale: input.locale ?? undefined,
      metrics: {
        upvote_count: item.upvote_count,
        downvote_count: item.downvote_count,
        like_count: item.like_count,
        viewer_vote: item.viewer_vote,
      },
    })))
    for (const item of items) {
      await enqueuePostTranslationOnReadIfNeeded({
        client: db.client,
        communityId: input.communityId,
        response: item,
      })
    }

    return {
      items,
      next_cursor: formatFeedCursor(feed.nextCursor),
    }
  } finally {
    db.close()
  }
}

export async function listPublicCommunityPosts(input: {
  env: Env
  communityId: string
  locale?: string | null
  limit?: string | null
  cursor?: string | null
  flairId?: string | null
  sort?: string | null
  communityRepository: CommunityRepository
}): Promise<CommunityFeedResponse> {
  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!community || community.provisioning_state !== "active" || community.status !== "active") {
    throw notFoundError("Community not found")
  }

  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    const feed = await listPublishedLocalizedPosts({
      client: db.client,
      communityId: input.communityId,
      viewerUserId: "",
      limit: parseFeedLimit(input.limit),
      flairId: input.flairId ?? null,
      sort: parsePostFeedSort(input.sort),
      cursor: parseFeedCursor(input.cursor),
    })

    const items = await Promise.all(feed.items.map((item) => buildLocalizedPostResponse({
      executor: db.client,
      post: item.post,
      locale: input.locale ?? undefined,
      metrics: {
        upvote_count: item.upvote_count,
        downvote_count: item.downvote_count,
        like_count: item.like_count,
        viewer_vote: item.viewer_vote,
      },
    })))
    for (const item of items) {
      await enqueuePostTranslationOnReadIfNeeded({
        client: db.client,
        communityId: input.communityId,
        response: item,
      })
    }

    return {
      items,
      next_cursor: formatFeedCursor(feed.nextCursor),
    }
  } finally {
    db.close()
  }
}
