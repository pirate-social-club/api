import { getUserRepository } from "../../auth/repositories"
import { openCommunityWriteClient } from "../community-read-access"
import { nowIso } from "../../helpers"
import { HttpError, internalError, notFoundError } from "../../errors"
import type { DbExecutor } from "../../db-helpers"
import { createCommunityListingInTransaction } from "../commerce/listing-service"
import { getListingRowByAssetId } from "../commerce/shared"
import { createSongAssetForPost } from "../commerce/service"
import { mergeAnalysisState } from "../../posts/post-analysis"
import { getPostById } from "../../posts/community-post-query-store"
import {
  assignPostAssetIdIfMissing,
  markPostPublished,
  markPostPublishFailed,
} from "../../posts/community-post-mutation-store"
import {
  getPostPublishRequest,
  markPostPublishRequestStatus,
} from "../../posts/community-post-publish-request-store"
import { logPipelineError, logPipelineInfo } from "../../observability/pipeline-log"
import { getControlPlaneClient } from "../../runtime-deps"
import { requiredString } from "../../sql-row"
import { analyzeSongBundle } from "../../song-artifacts/song-artifact-analysis"
import { shouldSkipSongAcr } from "../../song-artifacts/song-acr-bypass"
import { consumeSongPostBundle } from "../../song-artifacts/song-artifact-post-resolution-service"
import {
  finalizeSongArtifactBundle,
  findUploadedSongArtifactByStorageRef,
  getSongArtifactBundle,
} from "../../song-artifacts/song-artifact-repository"
import type { CreatePostRequest, Post, RoyaltyAllocationRequest, SongArtifactBundle } from "../../../types"
import type { CommunityJobHandlerInput } from "./handler-types"
import { COMMUNITY_JOB_MAX_ATTEMPTS, type CommunityJobRepository } from "./runner-types"
import { enqueueCommunityJob } from "./store"
import { parseJobPayload } from "./payload"

type PostPublishFinalizePayload = {
  post_id?: string | null
}

function failedResult(postId: string): string {
  return `failed:post_publish_finalize:${postId}`
}

function skippedResult(postId: string): string {
  return `skipped:post_publish_finalize:${postId}`
}

export const POST_PUBLISH_FINALIZE_STUCK_AGE_MS = 15 * 60 * 1000

type PublishOptions = {
  commercial_rev_share_pct?: number | null
  license_preset?: CreatePostRequest["license_preset"] | null
  royalty_allocations?: RoyaltyAllocationRequest[] | null
}

function parseJsonRecord(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null
  }
  const parsed = JSON.parse(value)
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null
}

function parsePublishOptions(value: string | null): PublishOptions {
  const parsed = parseJsonRecord(value)
  if (!parsed) {
    return {}
  }
  return parsed as PublishOptions
}

function parseListingDraft(value: string | null): CreatePostRequest["listing_draft"] | null {
  return parseJsonRecord(value) as CreatePostRequest["listing_draft"] | null
}

function publishFailureFromError(error: unknown, fallback: {
  code: NonNullable<Post["publish_failure_code"]>
  message: string
  retryable: boolean
}): {
  code: NonNullable<Post["publish_failure_code"]>
  message: string
  retryable: boolean
} {
  if (error instanceof HttpError) {
    const reason = typeof error.details?.reason === "string" ? error.details.reason : null
    if (reason === "story_royalty_registration_failed") {
      return {
        code: "story_royalty_registration_failed",
        message: error.message,
        retryable: error.retryable,
      }
    }
    if (error.code === "provider_unavailable") {
      return {
        code: "provider_unavailable",
        message: error.message,
        retryable: error.retryable,
      }
    }
    return {
      code: fallback.code,
      message: error.message || fallback.message,
      retryable: error.retryable || fallback.retryable,
    }
  }
  return fallback
}

export function songAnalysisPublishFailure(input: {
  analysisState: Post["analysis_state"]
  rightsBasis: Post["rights_basis"]
  upstreamAssetRefs: Post["upstream_asset_refs"]
}): {
  code: NonNullable<Post["publish_failure_code"]>
  message: string
  retryable: boolean
} | null {
  if (input.analysisState === "blocked") {
    return {
      code: "song_analysis_blocked",
      message: "Song analysis blocked publication",
      retryable: false,
    }
  }
  if (input.analysisState === "review_required") {
    return {
      code: "song_analysis_review_required",
      message: "Song analysis requires review before publication",
      retryable: false,
    }
  }
  if (
    input.analysisState === "allow_with_required_reference"
    && (input.rightsBasis !== "derivative" || !input.upstreamAssetRefs?.length)
  ) {
    return {
      code: "song_rights_reference_required",
      message: "Matched audio requires derivative rights and a reference",
      retryable: false,
    }
  }
  return null
}

export function postModerationPublishFailure(input: {
  analysisState: Post["analysis_state"]
}): {
  code: NonNullable<Post["publish_failure_code"]>
  message: string
  retryable: boolean
} | null {
  if (input.analysisState === "blocked" || input.analysisState === "review_required") {
    return {
      code: "text_moderation_blocked",
      message: "Post moderation blocked publication",
      retryable: false,
    }
  }
  return null
}

function mergeContentSafetyState(
  left: Post["content_safety_state"],
  right: Post["content_safety_state"],
): Post["content_safety_state"] {
  const precedence: Record<Post["content_safety_state"], number> = {
    pending: 0,
    safe: 1,
    sensitive: 2,
    adult: 3,
  }
  return precedence[left] >= precedence[right] ? left : right
}

export function resolveFinalPostModeration(input: {
  postAnalysisState: Post["analysis_state"]
  postContentSafetyState: Post["content_safety_state"]
  postAgeGatePolicy: Post["age_gate_policy"]
  bundleAnalysisState?: Post["analysis_state"] | null
  bundleContentSafetyState?: Post["content_safety_state"] | null
  bundleAgeGatePolicy?: Post["age_gate_policy"] | null
}): Pick<Post, "analysis_state" | "content_safety_state" | "age_gate_policy"> {
  return {
    analysis_state: mergeAnalysisState(input.postAnalysisState, input.bundleAnalysisState ?? "allow"),
    content_safety_state: mergeContentSafetyState(
      input.postContentSafetyState,
      input.bundleContentSafetyState ?? "safe",
    ),
    age_gate_policy: input.postAgeGatePolicy === "18_plus" || input.bundleAgeGatePolicy === "18_plus"
      ? "18_plus"
      : "none",
  }
}

export function shouldRunPostPublishFinalize(postStatus: Post["status"]): boolean {
  return postStatus === "processing"
}

async function markPostPublishFinalizeFailed(input: {
  client: Parameters<typeof markPostPublishFailed>[0]["executor"]
  communityRepository: CommunityJobHandlerInput["communityRepository"]
  communityId: string
  postId: string
  failureCode: NonNullable<Post["publish_failure_code"]>
  failureMessage: string
  onlyIfProcessing?: boolean
  retryable: boolean
  now: string
}): Promise<string> {
  const post = await markPostPublishFailed({
    executor: input.client,
    postId: input.postId,
    failureCode: input.failureCode,
    failureMessage: input.failureMessage,
    onlyIfStatus: input.onlyIfProcessing ? "processing" : null,
    retryable: input.retryable,
    now: input.now,
  })
  if (input.onlyIfProcessing && post.status !== "failed") {
    logPipelineInfo("[community-job] skipped stale post publish finalize failure because post state changed", {
      community_id: input.communityId,
      post_id: input.postId,
      status: post.status,
    })
    return skippedResult(input.postId)
  }
  await markPostPublishRequestStatus({
    client: input.client,
    communityId: input.communityId,
    postId: input.postId,
    status: "failed",
    failureCode: input.failureCode,
    failureMessage: input.failureMessage,
    updatedAt: input.now,
  })
  await input.communityRepository.updateCommunityPostProjectionStatus({
    postId: input.postId,
    status: "failed",
    updatedAt: input.now,
  })
  await input.communityRepository.updateCommunityPostProjectionPayload({
    postId: input.postId,
    projectedPayloadJson: JSON.stringify(post),
    updatedAt: input.now,
  })
  return failedResult(input.postId)
}

export async function findStuckPostPublishFinalizePostIds(input: {
  client: DbExecutor
  cutoffUpdatedAt: string
  limit: number
}): Promise<{ postIds: string[]; hasMore: boolean }> {
  const limit = Math.max(1, Math.trunc(input.limit))
  const result = await input.client.execute({
    sql: `
      SELECT post_id
      FROM posts
      WHERE status = 'processing'
        AND updated_at <= ?1
        AND NOT EXISTS (
          SELECT 1
          FROM community_jobs
          WHERE community_jobs.job_type = 'post_publish_finalize'
            AND community_jobs.subject_type = 'post'
            AND community_jobs.subject_id = posts.post_id
            AND (
              community_jobs.status IN ('queued', 'running')
              OR (
                community_jobs.status = 'failed'
                AND community_jobs.attempt_count < ?2
              )
            )
        )
      ORDER BY updated_at ASC, post_id ASC
      LIMIT ?3
    `,
    args: [input.cutoffUpdatedAt, COMMUNITY_JOB_MAX_ATTEMPTS, limit + 1],
  })
  const rows = result.rows.slice(0, limit)
  return {
    postIds: rows.map((row) => requiredString(row, "post_id")),
    hasMore: result.rows.length > limit,
  }
}

type PostPublishFinalizeReconcileCommunitySummary = {
  community_id: string
  failed_posts: number
  has_more: boolean
}

type PostPublishFinalizeReconcileCommunityFailureSummary = {
  community_id: string
  error: string
}

type PostPublishFinalizeReconcileSummary = {
  checked_communities: number
  failed_posts: number
  communities: PostPublishFinalizeReconcileCommunitySummary[]
  failed_communities: PostPublishFinalizeReconcileCommunityFailureSummary[]
}

export async function reconcileStuckPostPublishFinalizeJobs(input: {
  env: CommunityJobHandlerInput["env"]
  communityRepository: CommunityJobRepository
  communityIds?: string[] | null
  maxCommunities?: number
  maxPostsPerCommunity?: number
  now?: string
}): Promise<PostPublishFinalizeReconcileSummary> {
  const communityIds = (input.communityIds?.length
    ? input.communityIds
    : (await input.communityRepository.listActiveCommunities()).map((community) => community.community_id))
    .slice(0, Math.max(1, Math.trunc(input.maxCommunities ?? 100)))
  const maxPostsPerCommunity = Math.max(1, Math.trunc(input.maxPostsPerCommunity ?? 25))
  const now = input.now ?? nowIso()
  const cutoffUpdatedAt = new Date(Date.parse(now) - POST_PUBLISH_FINALIZE_STUCK_AGE_MS).toISOString()
  const communities: PostPublishFinalizeReconcileCommunitySummary[] = []
  const failedCommunities: PostPublishFinalizeReconcileCommunityFailureSummary[] = []

  for (const communityId of communityIds) {
    let db: Awaited<ReturnType<typeof openCommunityWriteClient>> | null = null
    try {
      db = await openCommunityWriteClient(input.env, input.communityRepository, communityId)
      const stuck = await findStuckPostPublishFinalizePostIds({
        client: db.client,
        cutoffUpdatedAt,
        limit: maxPostsPerCommunity,
      })
      let failedPosts = 0
      for (const postId of stuck.postIds) {
        const result = await markPostPublishFinalizeFailed({
          client: db.client,
          communityRepository: input.communityRepository,
          communityId,
          postId,
          failureCode: "internal_error",
          failureMessage: "Publishing did not finish. Try again.",
          onlyIfProcessing: true,
          retryable: true,
          now,
        })
        if (result.startsWith("failed:")) {
          failedPosts += 1
        }
      }
      if (failedPosts > 0 || stuck.hasMore) {
        communities.push({
          community_id: communityId,
          failed_posts: failedPosts,
          has_more: stuck.hasMore,
        })
      }
      if (stuck.hasMore) {
        logPipelineInfo("[community-job] post publish finalize reconciler left posts for next pass", {
          community_id: communityId,
          processed_posts: failedPosts,
          max_posts_per_community: maxPostsPerCommunity,
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failedCommunities.push({ community_id: communityId, error: message })
      logPipelineError("[community-job] failed to reconcile stuck post publish finalize jobs for community", {
        community_id: communityId,
        error: message,
      })
      continue
    } finally {
      await db?.close()
    }
  }

  return {
    checked_communities: communityIds.length,
    failed_posts: communities.reduce((sum, community) => sum + community.failed_posts, 0),
    communities,
    failed_communities: failedCommunities,
  }
}

async function enqueueLockedAssetDeliveryIfRequested(input: {
  env: CommunityJobHandlerInput["env"]
  client: Parameters<typeof enqueueCommunityJob>[0]["client"]
  communityRepository: CommunityJobRepository
  communityId: string
  postId: string
  assetId: string
  lockedDeliveryStatus: string | null | undefined
  createdAt: string
}): Promise<void> {
  if (input.lockedDeliveryStatus !== "requested") {
    return
  }
  await enqueueCommunityJob({
    client: input.client,
    communityId: input.communityId,
    jobType: "locked_asset_delivery_prepare",
    subjectType: "asset",
    subjectId: input.assetId,
    payloadJson: JSON.stringify({ post_id: input.postId }),
    createdAt: input.createdAt,
  })
}

export function buildSongPreviewJobRequest(bundle: Pick<SongArtifactBundle, "id" | "preview_status" | "preview_window" | "primary_audio"> | null): {
  payloadJson: string
  subjectId: string
} | null {
  if (!bundle || bundle.preview_status !== "pending" || !bundle.preview_window) {
    return null
  }
  const songArtifactBundleId = bundle.id.replace(/^sab_/, "")
  return {
    subjectId: songArtifactBundleId,
    payloadJson: JSON.stringify({
      song_artifact_bundle: songArtifactBundleId,
      primary_audio_content_hash: bundle.primary_audio.content_hash ?? null,
      preview_window: bundle.preview_window,
    }),
  }
}

async function enqueueSongPreviewIfPending(input: {
  client: Parameters<typeof enqueueCommunityJob>[0]["client"]
  communityId: string
  bundle: Awaited<ReturnType<typeof getSongArtifactBundle>>
  createdAt: string
}): Promise<void> {
  const jobRequest = buildSongPreviewJobRequest(input.bundle)
  if (!jobRequest) {
    return
  }
  await enqueueCommunityJob({
    client: input.client,
    communityId: input.communityId,
    jobType: "song_preview_generate",
    subjectType: "song_artifact_bundle",
    subjectId: jobRequest.subjectId,
    payloadJson: jobRequest.payloadJson,
    createdAt: input.createdAt,
  })
}

export async function runPostPublishFinalize(input: CommunityJobHandlerInput): Promise<string | null> {
  const payload = parseJobPayload<PostPublishFinalizePayload>(input.job.payload_json)
  const postId = payload?.post_id ?? input.job.subject_id
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.job.community_id)
  try {
    const post = await getPostById(db.client, postId)
    if (!post || post.community_id !== input.job.community_id) {
      throw notFoundError("Post not found")
    }
    if (post.status === "published") {
      return post.post_id
    }
    if (!shouldRunPostPublishFinalize(post.status)) {
      return post.post_id
    }

    const now = nowIso()
    await markPostPublishRequestStatus({
      client: db.client,
      communityId: input.job.community_id,
      postId: post.post_id,
      status: "running",
      updatedAt: now,
    })
    const publishRequest = await getPostPublishRequest({
      client: db.client,
      communityId: input.job.community_id,
      postId: post.post_id,
    })
    const publishOptions = parsePublishOptions(publishRequest?.publish_options_json ?? null)
    const listingDraft = parseListingDraft(publishRequest?.listing_draft_json ?? null)

    if (post.post_type !== "song" || !post.song_artifact_bundle_id) {
      return await markPostPublishFinalizeFailed({
        client: db.client,
        communityRepository: input.communityRepository,
        communityId: input.job.community_id,
        postId: post.post_id,
        failureCode: "internal_error",
        failureMessage: "Async finalize is only enabled for bundle-backed song posts",
        retryable: false,
        now: nowIso(),
      })
    }

    const controlClient = getControlPlaneClient(input.env)
    let bundle = await getSongArtifactBundle(controlClient, input.job.community_id, post.song_artifact_bundle_id)
    if (!bundle) {
      throw internalError("Song artifact bundle is missing for async finalize")
    }

    if (bundle.status === "validating") {
      try {
        const primaryAudioUpload = await findUploadedSongArtifactByStorageRef({
          client: controlClient,
          communityId: input.job.community_id,
          storageRef: bundle.primary_audio.storage_ref,
          artifactKind: "primary_audio",
        })
        if (!primaryAudioUpload) {
          return await markPostPublishFinalizeFailed({
            client: db.client,
            communityRepository: input.communityRepository,
            communityId: input.job.community_id,
            postId: post.post_id,
            failureCode: "provider_unavailable",
            failureMessage: "Primary audio upload is not available for analysis",
            retryable: true,
            now: nowIso(),
          })
        }
        const analysis = await analyzeSongBundle({
          env: input.env,
          lyrics: bundle.lyrics,
          primaryAudioUpload,
          skipAcrIdentification: shouldSkipSongAcr({
            env: input.env,
            communityId: input.job.community_id,
          }),
        })
        bundle = await finalizeSongArtifactBundle({
          client: controlClient,
          communityId: input.job.community_id,
          songArtifactBundleId: post.song_artifact_bundle_id,
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
          previewStatus: bundle.preview_window ? "pending" : "completed",
          previewError: null,
          updatedAt: nowIso(),
        })
      } catch (error) {
        const failure = publishFailureFromError(error, {
          code: "provider_unavailable",
          message: "Song analysis failed",
          retryable: true,
        })
        return await markPostPublishFinalizeFailed({
          client: db.client,
          communityRepository: input.communityRepository,
          communityId: input.job.community_id,
          postId: post.post_id,
          failureCode: failure.code,
          failureMessage: failure.message,
          retryable: failure.retryable,
          now: nowIso(),
        })
      }
    }

    const moderation = bundle.moderation_result && typeof bundle.moderation_result === "object"
      ? bundle.moderation_result as {
        analysis_state?: Post["analysis_state"]
        content_safety_state?: Post["content_safety_state"]
        age_gate_policy?: Post["age_gate_policy"]
      }
      : {}
    const postModerationFailure = postModerationPublishFailure({
      analysisState: post.analysis_state,
    })
    if (postModerationFailure) {
      return await markPostPublishFinalizeFailed({
        client: db.client,
        communityRepository: input.communityRepository,
        communityId: input.job.community_id,
        postId: post.post_id,
        failureCode: postModerationFailure.code,
        failureMessage: postModerationFailure.message,
        retryable: postModerationFailure.retryable,
        now: nowIso(),
      })
    }
    const bundleAnalysisState = moderation.analysis_state ?? "allow"
    const analysisFailure = songAnalysisPublishFailure({
      analysisState: bundleAnalysisState,
      rightsBasis: post.rights_basis,
      upstreamAssetRefs: post.upstream_asset_refs,
    })
    if (analysisFailure) {
      return await markPostPublishFinalizeFailed({
        client: db.client,
        communityRepository: input.communityRepository,
        communityId: input.job.community_id,
        postId: post.post_id,
        failureCode: analysisFailure.code,
        failureMessage: analysisFailure.message,
        retryable: analysisFailure.retryable,
        now: nowIso(),
      })
    }
    const finalModeration = resolveFinalPostModeration({
      postAnalysisState: post.analysis_state,
      postContentSafetyState: post.content_safety_state,
      postAgeGatePolicy: post.age_gate_policy,
      bundleAnalysisState,
      bundleContentSafetyState: moderation.content_safety_state ?? null,
      bundleAgeGatePolicy: moderation.age_gate_policy ?? null,
    })

    await enqueueSongPreviewIfPending({
      client: db.client,
      communityId: input.job.community_id,
      bundle,
      createdAt: nowIso(),
    })

    let postWithAsset = post
    try {
      postWithAsset = await assignPostAssetIdIfMissing({
        executor: db.client,
        postId: post.post_id,
        now: nowIso(),
      })
      const asset = await createSongAssetForPost({
        env: input.env,
        client: db.client,
        communityId: input.job.community_id,
        post: postWithAsset,
        bundle,
        licensePreset: publishOptions.license_preset ?? null,
        commercialRevSharePct: publishOptions.commercial_rev_share_pct ?? null,
        royaltyAllocations: publishOptions.royalty_allocations ?? null,
        requireStoryRoyaltyRegistration: true,
        userRepository: getUserRepository(input.env),
      })
      await enqueueLockedAssetDeliveryIfRequested({
        env: input.env,
        client: db.client,
        communityRepository: input.communityRepository as unknown as CommunityJobRepository,
        communityId: input.job.community_id,
        postId: post.post_id,
        assetId: postWithAsset.asset_id!,
        lockedDeliveryStatus: asset.locked_delivery_status,
        createdAt: nowIso(),
      })
    } catch (error) {
      const failure = publishFailureFromError(error, {
        code: "story_royalty_registration_failed",
        message: "Story royalty registration failed",
        retryable: true,
      })
      return await markPostPublishFinalizeFailed({
        client: db.client,
        communityRepository: input.communityRepository,
        communityId: input.job.community_id,
        postId: post.post_id,
        failureCode: failure.code,
        failureMessage: failure.message,
        retryable: failure.retryable,
        now: nowIso(),
      })
    }

    if (listingDraft && postWithAsset.asset_id?.trim()) {
      const existingListing = await getListingRowByAssetId(db.client, input.job.community_id, postWithAsset.asset_id)
      if (!existingListing) {
        try {
          await createCommunityListingInTransaction({
            env: input.env,
            userId: post.author_user_id ?? "",
            communityId: input.job.community_id,
            body: {
              ...listingDraft,
              asset: `asset_${postWithAsset.asset_id}`,
              live_room: null,
              replay_asset: null,
            },
            communityRepository: input.communityRepository as unknown as Parameters<typeof createCommunityListingInTransaction>[0]["communityRepository"],
            userRepository: getUserRepository(input.env),
            client: db.client,
          })
        } catch (error) {
          const failure = publishFailureFromError(error, {
            code: "listing_creation_failed",
            message: "Listing creation failed",
            retryable: false,
          })
          return await markPostPublishFinalizeFailed({
            client: db.client,
            communityRepository: input.communityRepository,
            communityId: input.job.community_id,
            postId: post.post_id,
            failureCode: failure.code,
            failureMessage: failure.message,
            retryable: failure.retryable,
            now: nowIso(),
          })
        }
      }
    }

    try {
      await consumeSongPostBundle({
        env: input.env,
        communityId: input.job.community_id,
        songArtifactBundleId: post.song_artifact_bundle_id,
      })
    } catch (error) {
      const failure = publishFailureFromError(error, {
        code: "catalog_sync_failed",
        message: "Catalog sync failed",
        retryable: true,
      })
      return await markPostPublishFinalizeFailed({
        client: db.client,
        communityRepository: input.communityRepository,
        communityId: input.job.community_id,
        postId: post.post_id,
        failureCode: failure.code,
        failureMessage: failure.message,
        retryable: failure.retryable,
        now: nowIso(),
      })
    }

    const published = await markPostPublished({
      executor: db.client,
      postId: post.post_id,
      analysisState: finalModeration.analysis_state,
      contentSafetyState: finalModeration.content_safety_state,
      ageGatePolicy: finalModeration.age_gate_policy,
      now: nowIso(),
    })
    await markPostPublishRequestStatus({
      client: db.client,
      communityId: input.job.community_id,
      postId: post.post_id,
      status: "succeeded",
      updatedAt: nowIso(),
    })
    const projectionUpdatedAt = nowIso()
    await input.communityRepository.updateCommunityPostProjectionStatus({
      postId: post.post_id,
      status: "published",
      updatedAt: projectionUpdatedAt,
    })
    await input.communityRepository.updateCommunityPostProjectionPayload({
      postId: post.post_id,
      projectedPayloadJson: JSON.stringify(published),
      updatedAt: projectionUpdatedAt,
    })
    return post.post_id
  } finally {
    db.close()
  }
}
