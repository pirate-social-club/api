import { getUserRepository } from "../../auth/repositories"
import { openCommunityWriteClient } from "../community-read-access"
import { nowIso } from "../../helpers"
import { HttpError, conflictError, internalError, notFoundError, providerUnavailable } from "../../errors"
import type { DbExecutor } from "../../db-helpers"
import { createCommunityListingInTransaction } from "../commerce/listing-service"
import { getListingRowByAssetId } from "../commerce/shared"
import { createSongAssetForPost } from "../commerce/service"
import { assertDerivativeParentRevenueShare } from "../commerce/derivative-parent-revenue-share"
import { updateStoryRegisteredAssetPostStatus } from "../commerce/derivative-source-projection"
import { mergeAnalysisState } from "../../posts/post-analysis"
import { songRightsInvariantFailure } from "../../posts/song-rights-invariant"
import { getPostById } from "../../posts/community-post-query-store"
import {
  assignPostAssetIdIfMissing,
  markPostPublished,
  markPostPublishFailed,
} from "../../posts/community-post-mutation-store"
import {
  getPostPublishRequest,
  mergePostPublishRequestOptions,
  markPostPublishRequestStatus,
} from "../../posts/community-post-publish-request-store"
import { logPipelineError, logPipelineInfo } from "../../observability/pipeline-log"
import { getControlPlaneClient } from "../../runtime-deps"
import { requiredString } from "../../sql-row"
import { analyzeSongBundle } from "../../song-artifacts/song-artifact-analysis"
import { shouldSkipSongAcr } from "../../song-artifacts/song-acr-bypass"
import { consumeSongPostBundle } from "../../song-artifacts/song-artifact-post-resolution-service"
import { schedulePublicPostCachePurge } from "../../public-read-cache-invalidation"
import {
  finalizeSongArtifactBundle,
  findUploadedSongArtifactByStorageRef,
  getSongArtifactBundle,
} from "../../song-artifacts/song-artifact-repository"
import type { CreatePostRequest, Post, RoyaltyAllocationRequest, SongArtifactBundle } from "../../../types"
import type { CommunityJobHandlerInput } from "./handler-types"
import { rotateCommunityJobTickIds } from "./tick-rotation"
import { COMMUNITY_JOB_MAX_ATTEMPTS, type CommunityJobRepository } from "./runner-types"
import { enqueueCommunityJob } from "./store"
import { parseJobPayload } from "./payload"
import { publishGenericAssetClaim } from "../commerce/generic-asset-publication"
import { getAssetRow } from "../commerce/queries"
import { getActivePrimaryAssetPayload } from "../commerce/generic-asset-repository"
import { assertAssetDeliveryAllowed } from "../commerce/asset-read-policy"
import { genericDigitalGoodsEnabled, learningDecksEnabled } from "../../helpers"
import { requireOwnedContentBlob } from "../../content-blobs/content-blob-repository"
import { materializeGeneratedContentBlob } from "../../content-blobs/content-blob-service"
import { findCurrentContentPolicyDecision } from "../../content-security/content-security-repository"
import { canonicalLearningDeckPackage } from "../../learning/deck-package"
import { getLearningDeckDraft } from "../../learning/deck-authoring-service"
import { withTransaction } from "../../transactions"
import type { Client } from "../../sql-client"

type PostPublishFinalizeDependencies = {
  getControlPlaneClient: typeof getControlPlaneClient
  openCommunityWriteClient: typeof openCommunityWriteClient
}

const postPublishFinalizeDependencies: PostPublishFinalizeDependencies = {
  getControlPlaneClient,
  openCommunityWriteClient,
}

// Attempts spent waiting for the preview job to hash-verify the primary audio before we
// give up and register without the canonical media block. Deliberately below
// COMMUNITY_JOB_MAX_ATTEMPTS (8) so a stalled preview still leaves attempts for the
// registration itself rather than exhausting the job's budget on waiting.
const STORY_HASH_VERIFICATION_WAIT_ATTEMPTS = 5
export const SONG_CONTENT_HASH_VERIFICATION_PENDING_ERROR = "Song primary audio hash verification is still pending"

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
  post_id?: string | null
  commercial_rev_share_pct?: number | null
  license_preset?: CreatePostRequest["license_preset"] | null
  royalty_allocations?: RoyaltyAllocationRequest[] | null
  file_upload?: string | null
  learning_deck?: string | null
  access_mode?: CreatePostRequest["access_mode"] | null
  rights_basis?: CreatePostRequest["rights_basis"] | null
  allocated_ids?: {
    post_id?: string | null
    asset_id?: string | null
    content_blob_id?: string | null
    listing_id?: string | null
    reservation_id?: string | null
    reservation_key?: string | null
    generated_content_blob_id?: string | null
  } | null
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

async function convergePublishedPostProjection(input: {
  client: Parameters<typeof markPostPublishRequestStatus>[0]["client"]
  communityRepository: CommunityJobHandlerInput["communityRepository"]
  env: CommunityJobHandlerInput["env"]
  post: Post
  now: string
}): Promise<void> {
  if (input.post.status !== "published") {
    throw internalError("Published post convergence requires a published post")
  }

  const existing = await input.communityRepository.getCommunityPostProjectionByPostId(input.post.post_id)
  const projectedPayloadJson = JSON.stringify(input.post)
  if (existing) {
    await input.communityRepository.updateCommunityPostProjectionStatus({
      postId: input.post.post_id,
      status: "published",
      updatedAt: input.now,
    })
    await input.communityRepository.updateCommunityPostProjectionPayload({
      postId: input.post.post_id,
      projectedPayloadJson,
      updatedAt: input.now,
    })
  } else {
    const community = await input.communityRepository.getCommunityById(input.post.community_id)
    if (!community) throw internalError("Community is missing for published post convergence")
    await input.communityRepository.recordCommunityPostProjection({
      communityId: input.post.community_id,
      sourcePostId: input.post.post_id,
      authorUserId: input.post.author_user_id ?? null,
      identityMode: input.post.identity_mode,
      postType: input.post.post_type,
      status: "published",
      visibility: input.post.visibility,
      sourceCreatedAt: input.post.created_at,
      projectedPayloadJson,
      actorUserId: input.post.author_user_id ?? community.creator_user_id,
      createdAt: input.now,
    })
  }

  try {
    await enqueueCommunityJob({
      client: input.client,
      communityId: input.post.community_id,
      jobType: "telegram_post_publish",
      subjectType: "post",
      subjectId: input.post.post_id,
      createdAt: input.now,
    })
  } catch (error) {
    logPipelineError("[community-job] Telegram publication enqueue failed", {
      community_id: input.post.community_id,
      post_id: input.post.post_id,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  await updateStoryRegisteredAssetPostStatus({
    env: input.env,
    communityId: input.post.community_id,
    sourcePostId: input.post.post_id,
    sourcePostStatus: "published",
    updatedAt: input.now,
  })

  // The saga row becomes terminal only after every derived projection is durable.
  // A retry can therefore always repair a crash between post publication and projection writes.
  await markPostPublishRequestStatus({
    client: input.client,
    communityId: input.post.community_id,
    postId: input.post.post_id,
    status: "succeeded",
    updatedAt: input.now,
  })
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
  /** Selected communities left unscanned because the prelude deadline passed. */
  deferred_communities: number
  failed_posts: number
  /** Wall time spent scanning communities. */
  reconcile_ms: number
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
  deadlineAtMs?: number | null
  nowMs?: () => number
}, dependencies: PostPublishFinalizeDependencies = postPublishFinalizeDependencies): Promise<PostPublishFinalizeReconcileSummary> {
  const nowMs = input.nowMs ?? (() => Date.now())
  const startedAtMs = nowMs()
  const maxCommunities = Math.max(1, Math.trunc(input.maxCommunities ?? 100))
  const communityIds = input.communityIds?.length
    ? input.communityIds.slice(0, maxCommunities)
    // Rotate the fixed listActiveCommunities order so a deadline-truncated tick
    // resumes where the last one stopped instead of starving the same tail.
    : rotateCommunityJobTickIds(
      (await input.communityRepository.listActiveCommunities({ requireReadyRouting: true }))
        .map((community) => community.community_id)
        .slice(0, maxCommunities),
      startedAtMs,
    )
  const maxPostsPerCommunity = Math.max(1, Math.trunc(input.maxPostsPerCommunity ?? 25))
  const now = input.now ?? nowIso()
  const cutoffUpdatedAt = new Date(Date.parse(now) - POST_PUBLISH_FINALIZE_STUCK_AGE_MS).toISOString()
  const communities: PostPublishFinalizeReconcileCommunitySummary[] = []
  const failedCommunities: PostPublishFinalizeReconcileCommunityFailureSummary[] = []

  let checkedCommunities = 0
  for (const communityId of communityIds) {
    // The prelude deadline stops this tick from scanning more communities; it
    // never interrupts one already open.
    if (input.deadlineAtMs != null && nowMs() >= input.deadlineAtMs) {
      console.warn("[community-job] post publish finalize reconcile deadline reached", JSON.stringify({
        checked_communities: checkedCommunities,
        deferred_communities: communityIds.length - checkedCommunities,
      }))
      break
    }
    checkedCommunities += 1
    let db: Awaited<ReturnType<typeof openCommunityWriteClient>> | null = null
    try {
      db = await dependencies.openCommunityWriteClient(input.env, input.communityRepository, communityId)
      const stuck = await findStuckPostPublishFinalizePostIds({
        client: db.client,
        cutoffUpdatedAt,
        limit: maxPostsPerCommunity,
      })
      let failedPosts = 0
      for (const postId of stuck.postIds) {
        const current = await getPostById(db.client, postId)
        if (current?.status === "published") {
          await convergePublishedPostProjection({
            client: db.client,
            communityRepository: input.communityRepository,
            env: input.env,
            post: current,
            now,
          })
          continue
        }
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
    checked_communities: checkedCommunities,
    deferred_communities: communityIds.length - checkedCommunities,
    failed_posts: communities.reduce((sum, community) => sum + community.failed_posts, 0),
    reconcile_ms: Math.max(0, nowMs() - startedAtMs),
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

// Story registration is one-shot, and it only publishes mediaUrl/mediaHash/mediaType when
// the primary audio has been hash-verified — the ONLY thing that verifies it is the preview
// job. Registering while that job is still pending permanently drops the canonical media
// block from the on-chain metadata, and nothing looks broken afterwards, because
// animation_url does not depend on the hash. So wait for the preview to land.
//
// The wait is bounded: a preview that never completes must not strand the asset forever, and
// registering without the media block is always safe — an unverified hash is never published,
// we only lose the fields. A bundle with no preview window is created "completed", so this
// cannot block a song that will never have a preview.
export function shouldWaitForSongContentHashVerification(input: {
  bundle: Pick<SongArtifactBundle, "preview_status"> | null
  attemptCount: number
}): boolean {
  if (input.bundle?.preview_status !== "pending") return false
  return input.attemptCount < STORY_HASH_VERIFICATION_WAIT_ATTEMPTS
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

const GENERIC_LOCKED_PAYLOAD_MAX_BYTES = 50 * 1024 * 1024
const DOWNLOAD_FILE_EXTENSIONS_BY_MIME: Readonly<Record<string, string>> = {
  "text/csv": "csv",
  "text/tab-separated-values": "tsv",
  "text/plain": "txt",
  "application/json": "json",
}

function genericFilenameMatchesMime(filename: string, mimeType: string): boolean {
  const expectedExtension = DOWNLOAD_FILE_EXTENSIONS_BY_MIME[mimeType]
  if (!expectedExtension) return false
  const lastDot = filename.lastIndexOf(".")
  return lastDot > 0 && filename.slice(lastDot + 1).toLowerCase() === expectedExtension
}

async function finalizeGenericDigitalGoodsPost(input: {
  jobInput: CommunityJobHandlerInput
  dependencies: PostPublishFinalizeDependencies
  client: Parameters<typeof markPostPublishRequestStatus>[0]["client"]
  post: Post
  publishOptions: PublishOptions
  listingDraft: CreatePostRequest["listing_draft"] | null
}): Promise<string> {
  const { jobInput, dependencies, client, post, publishOptions, listingDraft } = input
  const communityId = jobInput.job.community_id
  const now = nowIso()
  if (!genericDigitalGoodsEnabled(jobInput.env)) {
    return await markPostPublishFinalizeFailed({
      client,
      communityRepository: jobInput.communityRepository,
      communityId,
      postId: post.post_id,
      failureCode: "payload_claim_failed",
      failureMessage: "Generic digital goods are not enabled",
      retryable: false,
      now,
    })
  }
  const postModerationFailure = postModerationPublishFailure({
    analysisState: post.analysis_state,
  })
  if (postModerationFailure) {
    return await markPostPublishFinalizeFailed({
      client,
      communityRepository: jobInput.communityRepository,
      communityId,
      postId: post.post_id,
      failureCode: postModerationFailure.code,
      failureMessage: postModerationFailure.message,
      retryable: postModerationFailure.retryable,
      now,
    })
  }

  const controlPlaneClient = dependencies.getControlPlaneClient(jobInput.env)
  let contentBlobId = post.post_type === "file"
    ? publishOptions.file_upload?.trim()
    : publishOptions.learning_deck?.trim()
  let deckPackage: Awaited<ReturnType<typeof canonicalLearningDeckPackage>> | null = null
  let deckId: string | null = null
  if (post.post_type === "deck") {
    if (!learningDecksEnabled(jobInput.env)) {
      return await markPostPublishFinalizeFailed({
        client,
        communityRepository: jobInput.communityRepository,
        communityId,
        postId: post.post_id,
        failureCode: "deck_package_generation_failed",
        failureMessage: "Learning decks are not enabled",
        retryable: false,
        now,
      })
    }
    deckId = publishOptions.learning_deck?.trim() ?? null
    if (!deckId) {
      return await markPostPublishFinalizeFailed({
        client,
        communityRepository: jobInput.communityRepository,
        communityId,
        postId: post.post_id,
        failureCode: "deck_package_generation_failed",
        failureMessage: "Learning deck draft is missing",
        retryable: false,
        now,
      })
    }
    const draft = await getLearningDeckDraft({ client, communityId, deckId, userId: post.author_user_id ?? "" })
    deckPackage = await canonicalLearningDeckPackage({
      title: draft.deck.title,
      description: draft.deck.description,
      cards: draft.cards.filter((card) => card.retiredAt == null).map((card) => ({
        cardId: card.cardId,
        cardType: card.cardType,
        prompt: card.prompt,
        answer: card.answer,
        tags: card.tags,
      })),
    })
    const generatedContentBlobId = publishOptions.allocated_ids?.generated_content_blob_id?.trim() || `cbl_${post.post_id}_deck`
    await mergePostPublishRequestOptions({
      client,
      communityId,
      postId: post.post_id,
      patch: { allocated_ids: { generated_content_blob_id: generatedContentBlobId } },
      updatedAt: nowIso(),
    })
    const generated = await materializeGeneratedContentBlob({
      env: jobInput.env,
      client: controlPlaneClient,
      communityId,
      uploaderUserId: post.author_user_id ?? "",
      contentBlobId: generatedContentBlobId,
      bytes: deckPackage.bytes,
      filename: `learning-deck-${post.post_id}.json`,
      mimeType: "application/json",
      now,
    })
    contentBlobId = generated.blob.content_blob_id
  }
  if (!contentBlobId) {
    return await markPostPublishFinalizeFailed({
      client,
      communityRepository: jobInput.communityRepository,
      communityId,
      postId: post.post_id,
      failureCode: "payload_claim_failed",
      failureMessage: "Generic post is missing its content blob",
      retryable: false,
      now,
    })
  }
  if (post.access_mode !== "locked") {
    return await markPostPublishFinalizeFailed({
      client,
      communityRepository: jobInput.communityRepository,
      communityId,
      postId: post.post_id,
      failureCode: "payload_claim_failed",
      failureMessage: "Public generic publication is not enabled",
      retryable: false,
      now,
    })
  }

  const assetKind = post.post_type === "file" ? "download_file" as const : "learning_deck" as const
  let postWithAsset = await assignPostAssetIdIfMissing({
    executor: client,
    postId: post.post_id,
    now,
  })
  const reservationId = publishOptions.allocated_ids?.reservation_id?.trim() || `gar_${post.post_id}`
  const reservationKey = publishOptions.allocated_ids?.reservation_key?.trim() || `post:${post.post_id}:generic_asset`
  await mergePostPublishRequestOptions({
    client,
    communityId,
    postId: post.post_id,
    patch: {
      allocated_ids: {
        post_id: post.post_id,
        asset_id: postWithAsset.asset_id,
        content_blob_id: contentBlobId,
        reservation_id: reservationId,
        reservation_key: reservationKey,
      },
    },
    updatedAt: now,
  })

  let asset = postWithAsset.asset_id
    ? await getAssetRow(client, communityId, postWithAsset.asset_id)
    : null
  if (!asset) {
    const owned = await requireOwnedContentBlob({
      client: controlPlaneClient,
      communityId,
      uploaderUserId: post.author_user_id ?? "",
      contentBlobId,
    })
    const blob = owned.blob
    if (blob.status === "rejected" || blob.security_scan_state === "malicious" || blob.security_scan_state === "suspicious") {
      return await markPostPublishFinalizeFailed({
        client,
        communityRepository: jobInput.communityRepository,
        communityId,
        postId: post.post_id,
        failureCode: "payload_safety_blocked",
        failureMessage: "Content safety checks blocked publication",
        retryable: false,
        now: nowIso(),
      })
    }
    if (
      blob.status !== "ready"
      || blob.security_scan_state !== "clean"
      || blob.verified_size_bytes == null
      || !blob.verified_content_hash
    ) {
      throw providerUnavailable("Content blob verification is still pending", {
        reason: "payload_verification_pending",
        content_blob_id: contentBlobId,
      })
    }
    const policyDecision = await findCurrentContentPolicyDecision({
      executor: controlPlaneClient,
      contentBlobId: blob.content_blob_id,
      contentHash: blob.verified_content_hash,
      sizeBytes: blob.verified_size_bytes,
      scanResultRef: blob.security_scan_result_ref,
      securityScanProfile: blob.security_scan_profile,
    })
    if (!policyDecision) {
      throw providerUnavailable("Content policy decision is unavailable", {
        reason: "content_policy_decision_pending",
        content_blob_id: blob.content_blob_id,
      })
    }
    if (blob.verified_size_bytes > GENERIC_LOCKED_PAYLOAD_MAX_BYTES) {
      return await markPostPublishFinalizeFailed({
        client,
        communityRepository: jobInput.communityRepository,
        communityId,
        postId: post.post_id,
        failureCode: "payload_verification_failed",
        failureMessage: "Locked generic payloads are limited to 50 MiB",
        retryable: false,
        now: nowIso(),
      })
    }
    const displayFilename = blob.declared_filename?.trim() ?? ""
    const mimeType = blob.detected_mime_type?.trim().toLowerCase() ?? ""
    if (
      blob.validation_profile !== "download_file_v1"
      || !displayFilename
      || !genericFilenameMatchesMime(displayFilename, mimeType)
    ) {
      return await markPostPublishFinalizeFailed({
        client,
        communityRepository: jobInput.communityRepository,
        communityId,
        postId: post.post_id,
        failureCode: "payload_verification_failed",
        failureMessage: "Content blob format verification failed",
        retryable: false,
        now: nowIso(),
      })
    }
    const estimatedCiphertextBytes = blob.verified_size_bytes + 32
    const reservedBytes = blob.verified_size_bytes + estimatedCiphertextBytes
    const publication = await publishGenericAssetClaim({
      env: jobInput.env,
      shardClient: client as unknown as Parameters<typeof publishGenericAssetClaim>[0]["shardClient"],
      controlPlaneClient,
      communityId,
      sourcePostId: post.post_id,
      assetId: postWithAsset.asset_id!,
      creatorUserId: post.author_user_id ?? "",
      contentBlobId,
      assetKind,
      accessMode: "locked",
      rightsBasis: post.rights_basis === "none" && publishOptions.license_preset
        ? "original"
        : post.rights_basis ?? (publishOptions.license_preset ? "original" : "none"),
      licensePreset: publishOptions.license_preset ?? null,
      commercialRevSharePct: publishOptions.commercial_rev_share_pct ?? null,
      displayTitle: post.title,
      displayFilename,
      mimeType,
      contentHash: blob.verified_content_hash,
      verifiedSizeBytes: blob.verified_size_bytes,
      reservationId,
      reservationKey,
      reservedBytes,
      quotaPolicyVersion: "generic_assets_v1",
      createdAt: now,
    })
    await mergePostPublishRequestOptions({
      client,
      communityId,
      postId: post.post_id,
      patch: {
        allocated_ids: {
          asset_id: publication.assetId,
          quota_reservation_id: publication.quotaReservation.reservation_id,
          asset_payload_id: `ap_${publication.assetId}`,
        },
      },
      updatedAt: nowIso(),
    })
    asset = await getAssetRow(client, communityId, publication.assetId)
  }
  if (!asset) {
    throw internalError("Generic asset is missing after finalize claim")
  }
  const activePayload = await getActivePrimaryAssetPayload(client, asset.asset_id)
  if (!activePayload) {
    throw providerUnavailable("Generic asset payload is unavailable", {
      reason: "payload_policy_projection_pending",
      asset_id: asset.asset_id,
    })
  }
  const ownedPayloadBlob = await requireOwnedContentBlob({
    client: controlPlaneClient,
    communityId,
    uploaderUserId: post.author_user_id ?? "",
    contentBlobId: activePayload.content_blob_ref,
  })
  const payloadBlob = ownedPayloadBlob.blob
  if (
    payloadBlob.status !== "ready"
    || payloadBlob.security_scan_state !== "clean"
    || payloadBlob.verified_size_bytes == null
    || !payloadBlob.verified_content_hash
    || payloadBlob.verified_content_hash !== activePayload.content_hash
    || payloadBlob.verified_size_bytes !== activePayload.size_bytes
  ) {
    throw providerUnavailable("Generic asset safety evidence is unavailable", {
      reason: "payload_safety_evidence_pending",
      asset_id: asset.asset_id,
    })
  }
  const currentPolicyDecision = await findCurrentContentPolicyDecision({
    executor: controlPlaneClient,
    contentBlobId: payloadBlob.content_blob_id,
    contentHash: payloadBlob.verified_content_hash,
    sizeBytes: payloadBlob.verified_size_bytes,
    scanResultRef: payloadBlob.security_scan_result_ref,
    securityScanProfile: payloadBlob.security_scan_profile,
  })
  if (!currentPolicyDecision) {
    throw providerUnavailable("Generic asset content policy evidence is unavailable", {
      reason: "content_policy_decision_pending",
      asset_id: asset.asset_id,
    })
  }

  if (post.post_type === "deck" && deckId && deckPackage) {
    await withTransaction(client as unknown as Client, "write", async (tx) => {
      const deckRow = await tx.execute({
        sql: `
          SELECT learning_deck_id, active_draft_version, status, published_version, asset_id
          FROM learning_decks
          WHERE community_id = ?1 AND learning_deck_id = ?2
          LIMIT 1
        `,
        args: [communityId, deckId],
      })
      const deck = deckRow.rows[0]
      if (!deck) throw notFoundError("Learning deck not found")
      const status = String(deck.status)
      const activeVersion = Number(deck.active_draft_version)
      if (status === "published") {
        if (String(deck.asset_id) !== asset.asset_id) throw internalError("Published learning deck asset does not match post asset")
        return
      }
      const versionUpdate = await tx.execute({
        sql: `
          UPDATE learning_deck_versions
          SET status = 'published', content_hash = ?1, card_count = ?2,
              canonical_blob_ref = ?3, validation_error_json = NULL,
              published_at = ?4, updated_at = ?4
          WHERE learning_deck_id = ?5 AND version = ?6 AND status IN ('draft', 'ready')
        `,
        args: [deckPackage.contentHash, deckPackage.deck.cards.length, contentBlobId, now, deckId, activeVersion],
      })
      if ((versionUpdate.rowsAffected ?? 0) !== 1) {
        const existingVersion = await tx.execute({
          sql: `SELECT status, content_hash, canonical_blob_ref FROM learning_deck_versions WHERE learning_deck_id = ?1 AND version = ?2 LIMIT 1`,
          args: [deckId, activeVersion],
        })
        const version = existingVersion.rows[0]
        if (!version || String(version.status) !== "published" || String(version.canonical_blob_ref) !== contentBlobId) {
          throw conflictError("Learning deck version is not publishable")
        }
      }
      const deckUpdate = await tx.execute({
        sql: `
          UPDATE learning_decks
          SET status = 'published', source_post_id = ?1, asset_id = ?2,
              published_version = ?3, updated_at = ?4
          WHERE learning_deck_id = ?5 AND community_id = ?6 AND status = 'draft'
        `,
        args: [post.post_id, asset.asset_id, activeVersion, now, deckId, communityId],
      })
      if ((deckUpdate.rowsAffected ?? 0) !== 1) throw conflictError("Learning deck publication changed; retry")
    })
  }

  await enqueueLockedAssetDeliveryIfRequested({
    env: jobInput.env,
    client,
    communityRepository: jobInput.communityRepository as unknown as CommunityJobRepository,
    communityId,
    postId: post.post_id,
    assetId: asset.asset_id,
    lockedDeliveryStatus: asset.locked_delivery_status,
    createdAt: nowIso(),
  })
  if (asset.locked_delivery_status === "requested") {
    throw providerUnavailable("Locked generic delivery is still being prepared", {
      reason: "locked_delivery_pending",
      asset_id: asset.asset_id,
    })
  }
  if (asset.locked_delivery_status !== "ready") {
    return await markPostPublishFinalizeFailed({
      client,
      communityRepository: jobInput.communityRepository,
      communityId,
      postId: post.post_id,
      failureCode: "story_locked_delivery_failed",
      failureMessage: "Locked generic delivery could not be prepared",
      retryable: true,
      now: nowIso(),
    })
  }
  await assertAssetDeliveryAllowed({
    client,
    asset,
    notFoundMessage: "Asset not found",
    allowProcessingPost: true,
  })

  if (listingDraft) {
    const existingListing = await getListingRowByAssetId(client, communityId, asset.asset_id)
    if (!existingListing) {
      try {
        await createCommunityListingInTransaction({
          env: jobInput.env,
          userId: post.author_user_id ?? "",
          communityId,
          body: {
            ...listingDraft,
            asset: `asset_${asset.asset_id}`,
            live_room: null,
            replay_asset: null,
          },
          communityRepository: jobInput.communityRepository as unknown as Parameters<typeof createCommunityListingInTransaction>[0]["communityRepository"],
          userRepository: getUserRepository(jobInput.env),
          client,
        })
      } catch (error) {
        const failure = publishFailureFromError(error, {
          code: "listing_creation_failed",
          message: "Listing creation failed",
          retryable: false,
        })
        return await markPostPublishFinalizeFailed({
          client,
          communityRepository: jobInput.communityRepository,
          communityId,
          postId: post.post_id,
          failureCode: failure.code,
          failureMessage: failure.message,
          retryable: failure.retryable,
          now: nowIso(),
        })
      }
    }
  }
  const persistedListing = await getListingRowByAssetId(client, communityId, asset.asset_id)
  if (persistedListing) {
    await mergePostPublishRequestOptions({
      client,
      communityId,
      postId: post.post_id,
      patch: { allocated_ids: { listing_id: persistedListing.listing_id } },
      updatedAt: nowIso(),
    })
  }
  const published = await markPostPublished({
    executor: client,
    postId: post.post_id,
    analysisState: post.analysis_state,
    contentSafetyState: post.content_safety_state,
    ageGatePolicy: post.age_gate_policy,
    now: nowIso(),
  })
  await convergePublishedPostProjection({
    client,
    communityRepository: jobInput.communityRepository,
    env: jobInput.env,
    post: published,
    now: nowIso(),
  })
  await schedulePublicPostCachePurge({
    env: jobInput.env,
    communityId,
    postId: post.post_id,
  })
  return post.post_id
}

export async function runPostPublishFinalize(
  input: CommunityJobHandlerInput,
  dependencies: PostPublishFinalizeDependencies = postPublishFinalizeDependencies,
): Promise<string | null> {
  const payload = parseJobPayload<PostPublishFinalizePayload>(input.job.payload_json)
  const postId = payload?.post_id ?? input.job.subject_id
  const db = await dependencies.openCommunityWriteClient(input.env, input.communityRepository, input.job.community_id)
  try {
    const post = await getPostById(db.client, postId)
    if (!post || post.community_id !== input.job.community_id) {
      throw notFoundError("Post not found")
    }
    if (post.status === "published") {
      const convergedAt = nowIso()
      await convergePublishedPostProjection({
        client: db.client,
        communityRepository: input.communityRepository,
        env: input.env,
        post,
        now: convergedAt,
      })
      await schedulePublicPostCachePurge({
        env: input.env,
        communityId: input.job.community_id,
        postId: post.post_id,
      })
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

    if (post.post_type === "file" || post.post_type === "deck") {
      return await finalizeGenericDigitalGoodsPost({
        jobInput: input,
        dependencies,
        client: db.client,
        post,
        publishOptions,
        listingDraft,
      })
    }

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

    const rightsInvariantFailure = songRightsInvariantFailure({
      songMode: post.song_mode,
      rightsBasis: post.rights_basis,
      upstreamAssetRefs: post.upstream_asset_refs,
    })
    if (rightsInvariantFailure) {
      return await markPostPublishFinalizeFailed({
        client: db.client,
        communityRepository: input.communityRepository,
        communityId: input.job.community_id,
        postId: post.post_id,
        failureCode: "song_rights_reference_required",
        failureMessage: rightsInvariantFailure,
        retryable: false,
        now: nowIso(),
      })
    }

    try {
      await assertDerivativeParentRevenueShare({
        env: input.env,
        client: db.client,
        communityId: input.job.community_id,
        upstreamAssetRefs: post.upstream_asset_refs,
      })
    } catch (error) {
      if (error instanceof HttpError && error.status === 400) {
        return await markPostPublishFinalizeFailed({
          client: db.client,
          communityRepository: input.communityRepository,
          communityId: input.job.community_id,
          postId: post.post_id,
          failureCode: "song_rights_reference_required",
          failureMessage: error.message,
          retryable: false,
          now: nowIso(),
        })
      }
      throw error
    }

    const controlClient = dependencies.getControlPlaneClient(input.env)
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
          communityId: input.job.community_id,
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
          alignmentReason: analysis.alignmentReason,
          instrumentalAudio: bundle.instrumental_audio,
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
        if (
          error instanceof HttpError
          && error.code === "provider_unavailable"
          && error.retryable
          && input.job.attempt_count < COMMUNITY_JOB_MAX_ATTEMPTS
        ) {
          // Transient analysis-provider failure: let the job runner retry with
          // backoff; only the terminal attempt marks the post failed (and even
          // then it stays user-retryable below).
          throw error
        }
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

    if (shouldWaitForSongContentHashVerification({ bundle, attemptCount: input.job.attempt_count })) {
      throw providerUnavailable(SONG_CONTENT_HASH_VERIFICATION_PENDING_ERROR, {
        attempt_count: input.job.attempt_count,
        reason: "song_content_hash_verification_pending",
        song_artifact_bundle: bundle?.id ?? null,
      })
    }

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
    const projectionUpdatedAt = nowIso()
    await convergePublishedPostProjection({
      client: db.client,
      communityRepository: input.communityRepository,
      env: input.env,
      post: published,
      now: projectionUpdatedAt,
    })
    await schedulePublicPostCachePurge({
      env: input.env,
      communityId: input.job.community_id,
      postId: post.post_id,
    })
    return post.post_id
  } finally {
    db.close()
  }
}
