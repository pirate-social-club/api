import { openCommunityWriteClient } from "../communities/community-read-access"
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
import { resolvePostAnalysisProvider } from "./post-analysis"
import {
  findPostByIdempotencyKey,
  insertPost,
  type PostWriteDraft,
} from "./community-post-create-store"
import {
  insertPostPublishRequest,
  markPostPublishRequestStatus,
} from "./community-post-publish-request-store"
import { getPostById } from "./community-post-query-store"
import {
  markPostDeleted,
  markPostPublished,
  markPostPublishFailed,
} from "./community-post-mutation-store"
import { resolvePostProjectionSchema } from "./community-post-projection"
import { consumeSongPostBundle } from "../song-artifacts/song-artifact-post-resolution-service"
import {
  createAssetForPost,
  createSongAssetForPost,
} from "../communities/commerce/service"
import { createCommunityListingInTransaction } from "../communities/commerce/listing-service"
import { getListingRowByAssetId } from "../communities/commerce/shared"
import {
  requireMemberAccess,
} from "./post-access"
import { enforceCommunityActionGate } from "../communities/membership/eligibility-service"
import { canAccessCommunity, getCommunityMembershipState } from "../communities/membership/membership-state-store"
import {
  allowsNonMemberPowParticipation,
  followCommunityAfterParticipation,
  type ParticipationFollowRepository,
} from "../communities/membership/open-participation"
import {
  enqueueEmbedHydrateIfNeeded,
  enqueuePostLabelIfNeeded,
  enqueuePostLyricsLanguageDetectionJob,
  enqueuePostTranslationPrewarmJobs,
} from "./post-jobs"
import {
  enqueueCommunityJob,
  findLatestCommunityJobBySubjectAndType,
} from "../communities/jobs/store"
import { enqueueVideoMediaAnalysisIfEnabled } from "../communities/jobs/video-media-analysis-handler"
import { processCommunityJobById } from "../communities/jobs/runner"
import { getBackgroundCommunityJobRepository } from "../communities/jobs/background-job-repository"
import { SONG_CONTENT_HASH_VERIFICATION_PENDING_ERROR } from "../communities/jobs/post-publish-finalize-handler"
import { conflictError, eligibilityFailed, internalError, notFoundError, providerUnavailable } from "../errors"
import { genericDigitalGoodsEnabled, learningDecksEnabled, nowIso } from "../helpers"
import { withBackgroundControlPlaneClients } from "../runtime-deps"
import type { DbExecutor } from "../db-helpers"
import type { Env } from "../../env"
import type { Asset, CreatePostRequest, Post } from "../../types"
import type { AltchaProofInput } from "../verification/altcha-provider"
import { schedulePublicPostCachePurge } from "../public-read-cache-invalidation"
import { preparePostCreate } from "./post-create-preparation"
import { recordReviewRequiredPostModeration } from "./post-moderation-recording"
import { assertPostCreateRequest } from "./post-create-validation"
import { hashPostCreateRequestBody, isPostCreateIdempotencyConflict } from "./post-create-idempotency"
import { assertDerivativeParentRevenueShare } from "../communities/commerce/derivative-parent-revenue-share"

type PostWaitUntil = (promise: Promise<void>) => void
type PostAssetCreator = typeof createAssetForPost
type SongPostAssetCreator = typeof createSongAssetForPost
type PostCommunityWriteOpener = typeof openCommunityWriteClient
let postAssetCreatorForRuntime: PostAssetCreator = createAssetForPost
let songPostAssetCreatorForRuntime: SongPostAssetCreator = createSongAssetForPost
let postCommunityWriteOpenerForRuntime: PostCommunityWriteOpener = openCommunityWriteClient

/**
 * A second request may observe a post while its original listing work is still
 * running. Only resume processing posts after this window so retries can
 * recover an interrupted request without racing an in-flight one.
 */
export const POST_LISTING_RECOVERY_MIN_AGE_MS = 60_000

export function deferPostPublicationForListing(
  analysisOverride: Pick<Post, "analysis_state" | "content_safety_state" | "age_gate_policy" | "status">,
  hasListingDraft: boolean,
): Pick<Post, "analysis_state" | "content_safety_state" | "age_gate_policy" | "status"> {
  return hasListingDraft && analysisOverride.status === "published"
    ? { ...analysisOverride, status: "processing" }
    : analysisOverride
}

export function shouldResumePostListingDraft(input: {
  post: Pick<Post, "status" | "publish_failure_code" | "asset_id" | "created_at">
  hasListingDraft: boolean
  publishMode?: CreatePostRequest["publish_mode"] | null
  nowMs?: number
}): boolean {
  const createdAtMs = Date.parse(input.post.created_at)
  const processingIsStale = Number.isFinite(createdAtMs)
    && (input.nowMs ?? Date.now()) - createdAtMs >= POST_LISTING_RECOVERY_MIN_AGE_MS

  return input.hasListingDraft
    && Boolean(input.post.asset_id?.trim())
    && (
      (
        input.post.status === "failed"
        && input.post.publish_failure_code === "listing_creation_failed"
      )
      || (
        input.post.status === "processing"
        && input.publishMode !== "async"
        && processingIsStale
      )
    )
}

async function ensurePostListingDraft(input: {
  env: Env
  userId: string
  communityId: string
  post: Post
  listingDraft: NonNullable<CreatePostRequest["listing_draft"]>
  communityRepository: CommunityDatabaseBindingRepository & CommunityReadRepository
  userRepository: UserRepository
  client: DbExecutor
}): Promise<void> {
  if (!input.post.asset_id?.trim()) {
    throw internalError("Post listing draft is missing its asset")
  }
  const existingListing = await getListingRowByAssetId(
    input.client,
    input.communityId,
    input.post.asset_id,
  )
  if (existingListing) return
  await createCommunityListingInTransaction({
    env: input.env,
    userId: input.userId,
    communityId: input.communityId,
    body: {
      ...input.listingDraft,
      asset: `asset_${input.post.asset_id}`,
      live_room: null,
      replay_asset: null,
    },
    communityRepository: input.communityRepository as unknown as Parameters<typeof createCommunityListingInTransaction>[0]["communityRepository"],
    userRepository: input.userRepository,
    client: input.client,
  })
}

async function enqueueTelegramPublicationIfPublished(input: {
  client: DbExecutor
  communityId: string
  post: Post
  createdAt: string
}): Promise<void> {
  if (input.post.status !== "published" || input.post.visibility !== "public") return
  try {
    await enqueueCommunityJob({
      client: input.client,
      communityId: input.communityId,
      jobType: "telegram_post_publish",
      subjectType: "post",
      subjectId: input.post.post_id,
      createdAt: input.createdAt,
    })
  } catch (error) {
    console.error("[posts] Telegram publication enqueue failed", {
      community_id: input.communityId,
      post_id: input.post.post_id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

async function processImmediatePostPublishFinalize(input: {
  env: Env
  communityId: string
  jobId: string
  songArtifactBundleId: string | null
}): Promise<void> {
  // Constructed here — inside the background control-plane scope — never
  // passed in from the request: a request-scoped repository's control-plane
  // client is closed once the response is produced, while this task is still
  // running (the "Client was closed and is not queryable" finalize failure).
  const communityRepository = getBackgroundCommunityJobRepository(input.env)
  const finalizeResult = await communityJobProcessorForRuntime({
    env: input.env,
    communityId: input.communityId,
    jobId: input.jobId,
    communityRepository,
  })
  if (
    finalizeResult?.status !== "failed"
    || finalizeResult.error_code !== SONG_CONTENT_HASH_VERIFICATION_PENDING_ERROR
    || !input.songArtifactBundleId
  ) {
    return
  }

  // Async locked-song submission can race the preview job that verifies the
  // primary audio hash. Run that exact prerequisite, then immediately retry
  // finalize instead of waiting for the global community rotation.
  const db = await postCommunityWriteOpenerForRuntime(
    input.env,
    communityRepository,
    input.communityId,
  )
  let previewJob
  try {
    previewJob = await findLatestCommunityJobBySubjectAndType({
      client: db.client,
      jobType: "song_preview_generate",
      subjectType: "song_artifact_bundle",
      subjectId: input.songArtifactBundleId,
    })
  } finally {
    db.close()
  }
  if (!previewJob || (previewJob.status !== "queued" && previewJob.status !== "failed")) {
    return
  }

  const previewResult = await communityJobProcessorForRuntime({
    env: input.env,
    communityId: input.communityId,
    jobId: previewJob.job_id,
    communityRepository,
  })
  if (previewResult?.status !== "succeeded") {
    return
  }
  await communityJobProcessorForRuntime({
    env: input.env,
    communityId: input.communityId,
    jobId: input.jobId,
    communityRepository,
  })
}

export function scheduleImmediatePostPublishFinalize(input: {
  env: Env
  communityId: string
  postId: string
  jobId: string
  songArtifactBundleId: string | null
  waitUntil?: PostWaitUntil
}): void {
  input.waitUntil?.(withBackgroundControlPlaneClients(async () => {
    try {
      await processImmediatePostPublishFinalize({
        env: input.env,
        communityId: input.communityId,
        jobId: input.jobId,
        songArtifactBundleId: input.songArtifactBundleId,
      })
    } catch (error) {
      console.error("[posts] immediate publish finalize job processing failed", {
        community_id: input.communityId,
        post_id: input.postId,
        job_id: input.jobId,
        error,
      })
    }
  }))
}

export function setPostAssetCreatorsForTests(input: {
  createAssetForPost?: PostAssetCreator | null
  createSongAssetForPost?: SongPostAssetCreator | null
} | null): void {
  postAssetCreatorForRuntime = input?.createAssetForPost ?? createAssetForPost
  songPostAssetCreatorForRuntime = input?.createSongAssetForPost ?? createSongAssetForPost
}

export function setPostCommunityWriteOpenerForTests(input: PostCommunityWriteOpener | null): void {
  postCommunityWriteOpenerForRuntime = input ?? openCommunityWriteClient
}

type CommunityJobProcessor = typeof processCommunityJobById
let communityJobProcessorForRuntime: CommunityJobProcessor = processCommunityJobById

export function setCommunityJobProcessorForTests(processor: CommunityJobProcessor | null): void {
  communityJobProcessorForRuntime = processor ?? processCommunityJobById
}

export { moderationSeverityFromProviderResult } from "./post-moderation-recording"
export {
  deletePost,
  removePostAsModerator,
  setPostCommentLock,
} from "./post-moderation-actions"

export {
  cancelPostEvent,
} from "./post-event-actions"

export {
  getPost,
  getPublicPost,
  listPendingCommunityPosts,
  listCommunityEvents,
  listCommunityPosts,
  listPublicCommunityPosts,
} from "./post-read-service"
export { castPostVote, clearPostVote } from "./post-votes"

export async function syncRetriedPostProjection(input: {
  communityRepository: Pick<PostServiceCommunityRepository, "updateCommunityPostProjectionPayload" | "updateCommunityPostProjectionStatus">
  post: Post
  updatedAt: string
}): Promise<void> {
  await input.communityRepository.updateCommunityPostProjectionStatus({
    postId: input.post.post_id,
    status: "processing",
    updatedAt: input.updatedAt,
  })
  await input.communityRepository.updateCommunityPostProjectionPayload({
    postId: input.post.post_id,
    projectedPayloadJson: JSON.stringify(input.post),
    updatedAt: input.updatedAt,
  })
}

export async function retryPostPublish(input: {
  env: Env
  userId: string
  communityId: string
  postId: string
  communityRepository: PostServiceCommunityRepository
  waitUntil?: PostWaitUntil
}): Promise<Post> {
  const db = await postCommunityWriteOpenerForRuntime(input.env, input.communityRepository, input.communityId)
  try {
    await requireMemberAccess(db.client, input.communityId, input.userId)
    const post = await getPostById(db.client, input.postId)
    if (!post || post.community_id !== input.communityId || post.author_user_id !== input.userId) {
      throw eligibilityFailed("Post is not available for retry")
    }
    if (post.status !== "failed") {
      throw conflictError("Only failed posts can be retried")
    }
    if (post.publish_failure_retryable !== true) {
      throw conflictError("This publish failure is not retryable")
    }
    const retryAt = nowIso()
    await db.client.execute({
      sql: `
        UPDATE posts
        SET status = 'processing',
            publish_failure_code = NULL,
            publish_failure_message = NULL,
            publish_failure_retryable = NULL,
            publish_failed_at = NULL,
            updated_at = ?2
        WHERE post_id = ?1
      `,
      args: [post.post_id, retryAt],
    })
    await markPostPublishRequestStatus({
      client: db.client,
      communityId: input.communityId,
      postId: post.post_id,
      status: "pending",
      updatedAt: retryAt,
    })
    const job = await enqueueCommunityJob({
      client: db.client,
      communityId: input.communityId,
      jobType: "post_publish_finalize",
      subjectType: "post",
      subjectId: input.postId,
      payloadJson: JSON.stringify({ post_id: input.postId }),
      createdAt: retryAt,
    })
    const updated = await getPostById(db.client, post.post_id)
    if (!updated) {
      throw internalError("Post row is missing after retry enqueue")
    }
    await syncRetriedPostProjection({
      communityRepository: input.communityRepository,
      post: updated,
      updatedAt: retryAt,
    })
    input.waitUntil?.(withBackgroundControlPlaneClients(async () => {
      await communityJobProcessorForRuntime({
        env: input.env,
        communityId: input.communityId,
        jobId: job.job_id,
        communityRepository: getBackgroundCommunityJobRepository(input.env),
      })
    }))
    return updated
  } finally {
    db.close()
  }
}

type PostServiceCommunityRepository =
  & CommunityReadRepository
  & CommunityDatabaseBindingRepository
  & CommunityPostProjectionRepository
  & ParticipationFollowRepository

async function enqueueLockedAssetDeliveryJobIfRequested(input: {
  env: Env
  client: DbExecutor
  communityId: string
  post: Post
  asset: Asset
  createdAt: string
  communityRepository: PostServiceCommunityRepository
  waitUntil?: PostWaitUntil
}): Promise<void> {
  if (input.asset.locked_delivery_status !== "requested") {
    return
  }

  const job = await enqueueCommunityJob({
    client: input.client,
    communityId: input.communityId,
    jobType: "locked_asset_delivery_prepare",
    subjectType: "asset",
    subjectId: input.asset.id.replace(/^asset_/, ""),
    payloadJson: JSON.stringify({ post_id: input.post.post_id }),
    createdAt: input.createdAt,
  })

  input.waitUntil?.(withBackgroundControlPlaneClients(async () => {
    try {
      await communityJobProcessorForRuntime({
        env: input.env,
        communityId: input.communityId,
        jobId: job.job_id,
        communityRepository: getBackgroundCommunityJobRepository(input.env),
      })
    } catch (error) {
      console.error("[posts] immediate locked delivery job processing failed", {
        community_id: input.communityId,
        post_id: input.post.post_id,
        asset_id: input.asset.id,
        job_id: job.job_id,
        error,
      })
    }
  }))
}

export async function createPost(input: {
  env: Env
  requestUrl: string
  userId: string
  communityId: string
  body: CreatePostRequest
  bypassAuthorAccessChecks?: boolean
  altchaProof?: AltchaProofInput
  userRepository: UserRepository
  profileRepository: ProfileRepository
  communityRepository: PostServiceCommunityRepository
  waitUntil?: PostWaitUntil
}): Promise<Post> {
  const communityRow = await input.communityRepository.getCommunityById(input.communityId)
  if (!isCommunityLive(communityRow)) {
    throw eligibilityFailed("Community is not available for posting")
  }
  const community = await loadCommunityProjection(input.env, input.communityRepository, communityRow)

  assertPostCreateRequest(input.body, input.communityId)
  if (input.body.post_type === "file" || input.body.post_type === "deck") {
    if (!genericDigitalGoodsEnabled(input.env)) {
      throw notFoundError("Post type not found")
    }
    if (input.body.post_type === "deck" && !learningDecksEnabled(input.env)) {
      throw notFoundError("Post type not found")
    }
  }

  const db = await postCommunityWriteOpenerForRuntime(input.env, input.communityRepository, input.communityId)
  try {
    const postAnalysisProvider = resolvePostAnalysisProvider(input.env)
    let nonMemberPowAuthor = false
    if (!input.bypassAuthorAccessChecks) {
      const membership = await getCommunityMembershipState(db.client, input.communityId, input.userId)
      if (!canAccessCommunity(membership)) {
        // PoW-only communities admit non-member posts: the action gate below
        // demands a post-scoped ALTCHA proof, which is all joining would prove.
        // Everything else keeps the 404 membership mask.
        nonMemberPowAuthor = await allowsNonMemberPowParticipation({
          client: db.client,
          communityId: input.communityId,
          membership,
        })
        if (!nonMemberPowAuthor) {
          throw notFoundError("Community not found")
        }
      }
      await enforceCommunityActionGate({
        env: input.env,
        client: db.client,
        userId: input.userId,
        userRepository: input.userRepository,
        communityId: input.communityId,
        altchaScope: "post_create",
        altchaProof: input.altchaProof,
      })
    }

    const idempotencyKey = input.body.idempotency_key?.trim() ?? ""
    const idempotencyBodyHash = idempotencyKey ? await hashPostCreateRequestBody(input.body) : null
    const existing = idempotencyKey
      ? await findPostByIdempotencyKey({
          client: db.client,
          communityId: input.communityId,
          authorUserId: input.userId,
          idempotencyKey,
        })
      : null
    if (existing) {
      if (isPostCreateIdempotencyConflict({
        existingBodyHash: existing.idempotency_body_hash ?? null,
        incomingBodyHash: idempotencyBodyHash,
        incomingPublishMode: input.body.publish_mode,
      })) {
        throw conflictError("idempotency_key was already used with a different post create payload")
      }
      if (input.body.listing_draft && shouldResumePostListingDraft({
        post: existing,
        hasListingDraft: true,
        publishMode: input.body.publish_mode,
      })) {
        await ensurePostListingDraft({
          env: input.env,
          userId: input.userId,
          communityId: input.communityId,
          post: existing,
          listingDraft: input.body.listing_draft,
          communityRepository: input.communityRepository,
          userRepository: input.userRepository,
          client: db.client,
        })
        const restored = await markPostPublished({
          executor: db.client,
          postId: existing.post_id,
          analysisState: existing.analysis_state,
          contentSafetyState: existing.content_safety_state,
          ageGatePolicy: existing.age_gate_policy,
          now: nowIso(),
        })
        await input.communityRepository.recordCommunityPostProjection({
          communityId: input.communityId,
          sourcePostId: restored.post_id,
          authorUserId: restored.author_user_id ?? null,
          identityMode: restored.identity_mode,
          postType: restored.post_type,
          status: restored.status,
          visibility: restored.visibility,
          sourceCreatedAt: restored.created_at,
          projectedPayloadJson: JSON.stringify(restored),
          actorUserId: input.userId,
          createdAt: restored.updated_at,
        })
        await enqueueTelegramPublicationIfPublished({
          client: db.client,
          communityId: input.communityId,
          post: restored,
          createdAt: restored.updated_at,
        })
        schedulePublicPostCachePurge({
          env: input.env,
          communityId: input.communityId,
          postId: restored.post_id,
          waitUntil: input.waitUntil,
        })
        return restored
      }
      return existing
    }

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
    await assertDerivativeParentRevenueShare({
      env: input.env,
      client: db.client,
      communityId: input.communityId,
      upstreamAssetRefs: input.body.upstream_asset_refs,
    })
    const {
      writeBody,
      analysisOverride,
      analysisProviderResult,
      resolvedSongBundleForAsset,
      resolvedVideoAsset,
    } = await preparePostCreate({
      env: input.env,
      requestUrl: input.requestUrl,
      userId: input.userId,
      communityId: input.communityId,
      body: input.body,
      community,
      communityDbClient: db.client,
      communityRepository: input.communityRepository,
      postAnalysisProvider,
    })
    const initialAnalysisOverride = deferPostPublicationForListing(
      analysisOverride,
      Boolean(input.body.listing_draft),
    )
    const createdAt = nowIso()
    // Resolve the projection schema BEFORE the write tx — a buffered D1 write tx
    // can't see schema reads (or any read) until commit; threaded into insertPost.
    const projectionSchema = await resolvePostProjectionSchema(db.client)
    if (!projectionSchema.hasAsyncPublishColumns && (input.body.publish_mode === "async" || input.body.listing_draft)) {
      throw providerUnavailable("Community database migration is still rolling out", {
        missing_column: "posts.idempotency_body_hash",
      })
    }
    const tx = await db.client.transaction("write")
    let draft: PostWriteDraft
    let postPublishFinalizeJobId: string | null = null
    const requireStoryRoyaltyRegistration = true
    try {
      draft = await insertPost({
        client: tx,
        communityId: input.communityId,
        authorUserId: input.userId,
        body: writeBody,
        createdAt,
        projectionSchema,
        idempotencyBodyHash: projectionSchema.hasAsyncPublishColumns ? idempotencyBodyHash : null,
        analysisOverride: initialAnalysisOverride,
        agentWriteAuthorization: agentWriteAuthorization ?? undefined,
      })

      await enqueuePostTranslationPrewarmJobs({
        client: tx,
        communityId: input.communityId,
        post: draft,
        createdAt,
      })

      await enqueuePostLyricsLanguageDetectionJob({
        client: tx,
        communityId: input.communityId,
        post: draft,
        createdAt,
      })

      await enqueuePostLabelIfNeeded({
        client: tx,
        community,
        communityId: input.communityId,
        post: draft,
        createdAt,
      })

      await enqueueEmbedHydrateIfNeeded({
        client: tx,
        communityId: input.communityId,
        post: draft,
        createdAt,
      })

      if (analysisOverride?.analysis_state === "review_required") {
        await recordReviewRequiredPostModeration({
          executor: tx,
          communityId: input.communityId,
          postId: draft.post_id,
          providerResult: analysisProviderResult,
          now: createdAt,
        })
      }

      if (input.body.publish_mode === "async") {
        if (!idempotencyBodyHash) {
          throw internalError("Async publishing requires an idempotency body hash")
        }
        await insertPostPublishRequest({
          client: tx,
          communityId: input.communityId,
          postId: draft.post_id,
          publishMode: "async",
          requestBodyHash: idempotencyBodyHash,
          listingDraft: input.body.listing_draft ?? null,
          publishOptions: {
            post_id: draft.post_id,
            access_mode: input.body.access_mode ?? null,
            commercial_rev_share_pct: input.body.commercial_rev_share_pct ?? null,
            license_preset: input.body.license_preset ?? null,
            royalty_allocations: input.body.royalty_allocations ?? null,
            rights_basis: input.body.rights_basis ?? null,
            song_mode: input.body.song_mode ?? null,
            upstream_asset_refs: input.body.upstream_asset_refs ?? null,
            file_upload: input.body.file_upload ?? null,
            learning_deck: input.body.learning_deck ?? null,
            allocated_ids: {
              post_id: draft.post_id,
              asset_id: input.body.asset_id ?? null,
              content_blob_id: input.body.file_upload ?? input.body.learning_deck ?? null,
              reservation_id: `gar_${draft.post_id}`,
              reservation_key: `post:${draft.post_id}:generic_asset`,
            },
          },
          status: "pending",
          createdAt,
        })
        const job = await enqueueCommunityJob({
          client: tx,
          communityId: input.communityId,
          jobType: "post_publish_finalize",
          subjectType: "post",
          subjectId: draft.post_id,
          payloadJson: JSON.stringify({ post_id: draft.post_id }),
          createdAt,
          dedupe: false,
        })
        postPublishFinalizeJobId = job.job_id
      }

      await tx.commit()
    } catch (error) {
      await safeRollback(tx, "[posts] rollback failed while creating post")
      throw error
    } finally {
      tx.close()
    }

    // Canonical hydrated row, read AFTER commit (buffer-safe). Hard failure: a
    // committed insert whose row can't be read back is an internal consistency error.
    const post = await getPostById(db.client, draft.post_id)
    if (!post) {
      throw internalError("Post row is missing after insert")
    }

    if (nonMemberPowAuthor) {
      await followCommunityAfterParticipation({
        client: db.client,
        communityRepository: input.communityRepository,
        communityId: input.communityId,
        userId: input.userId,
      })
    }

    if (input.body.publish_mode === "async") {
      if (postPublishFinalizeJobId) {
        scheduleImmediatePostPublishFinalize({
          env: input.env,
          communityId: input.communityId,
          postId: post.post_id,
          jobId: postPublishFinalizeJobId,
          songArtifactBundleId: post.song_artifact_bundle_id ?? null,
          waitUntil: input.waitUntil,
        })
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
      await enqueueTelegramPublicationIfPublished({
        client: db.client,
        communityId: input.communityId,
        post,
        createdAt,
      })
      schedulePublicPostCachePurge({
        env: input.env,
        communityId: input.communityId,
        postId: post.post_id,
        waitUntil: input.waitUntil,
      })
      return post
    }

    // Asset-creation side effects run post-commit and capture the CANONICAL post.
    const postCommitAssetTasks: Array<() => Promise<void>> = []
    if (post.post_type === "song" && post.song_artifact_bundle_id && resolvedSongBundleForAsset) {
      postCommitAssetTasks.push(async () => {
        const asset = await songPostAssetCreatorForRuntime({
          env: input.env,
          client: db.client,
          communityId: input.communityId,
          post,
          bundle: resolvedSongBundleForAsset.bundle,
          licensePreset: input.body.license_preset ?? null,
          commercialRevSharePct: input.body.commercial_rev_share_pct ?? null,
          royaltyAllocations: input.body.royalty_allocations ?? null,
          requireStoryRoyaltyRegistration,
          userRepository: input.userRepository,
        })
        await enqueueLockedAssetDeliveryJobIfRequested({
          env: input.env,
          client: db.client,
          communityId: input.communityId,
          post,
          asset,
          createdAt,
          communityRepository: input.communityRepository,
          waitUntil: input.waitUntil,
        })
      })
    }
    if (post.post_type === "video" && post.access_mode && resolvedVideoAsset) {
      postCommitAssetTasks.push(async () => {
        const asset = await postAssetCreatorForRuntime({
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
          royaltyAllocations: input.body.royalty_allocations ?? null,
          requireStoryRoyaltyRegistration,
          userRepository: input.userRepository,
        })
        await enqueueLockedAssetDeliveryJobIfRequested({
          env: input.env,
          client: db.client,
          communityId: input.communityId,
          post,
          asset,
          createdAt,
          communityRepository: input.communityRepository,
          waitUntil: input.waitUntil,
        })
      })
    }
    let postCommitAssetTasksCompleted = false
    let completedPost = post
    try {
      for (const runPostCommitAssetTask of postCommitAssetTasks) {
        await runPostCommitAssetTask()
      }
      postCommitAssetTasksCompleted = true

      if (post.post_type === "video" && resolvedVideoAsset) {
        // Soundtrack rights analysis is advisory (never blocks publication),
        // but enqueue it before listing creation so a listing retry cannot skip it.
        try {
          await enqueueVideoMediaAnalysisIfEnabled({
            env: input.env,
            client: db.client,
            communityId: input.communityId,
            postId: post.post_id,
            storageObjectKey: resolvedVideoAsset.upload.storage_object_key,
            mimeType: resolvedVideoAsset.upload.mime_type,
            durationMs: (input.body as Extract<CreatePostRequest, { post_type: "video" }>)
              .media_refs?.[0]?.duration_ms ?? null,
            createdAt,
          })
        } catch (error) {
          console.error("[posts] video media analysis enqueue failed", {
            community_id: input.communityId,
            post_id: post.post_id,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }

      if (input.body.listing_draft && post.asset_id?.trim()) {
        await ensurePostListingDraft({
          env: input.env,
          userId: input.userId,
          communityId: input.communityId,
          post,
          listingDraft: input.body.listing_draft,
          communityRepository: input.communityRepository,
          userRepository: input.userRepository,
          client: db.client,
        })
        if (post.status === "processing") {
          completedPost = await markPostPublished({
            executor: db.client,
            postId: post.post_id,
            analysisState: post.analysis_state,
            contentSafetyState: post.content_safety_state,
            ageGatePolicy: post.age_gate_policy,
            now: nowIso(),
          })
        }
      }
    } catch (error) {
      try {
        if (postCommitAssetTasksCompleted && input.body.listing_draft && post.asset_id?.trim()) {
          await markPostPublishFailed({
            executor: db.client,
            postId: post.post_id,
            failureCode: "listing_creation_failed",
            failureMessage: "The paid post was prepared, but its listing could not be created. Try publishing again.",
            retryable: true,
            now: nowIso(),
          })
        } else {
          await markPostDeleted({
            executor: db.client,
            postId: post.post_id,
            now: nowIso(),
          })
        }
      } catch (cleanupError) {
        console.error("[posts] failed to persist post recovery state after a post-commit failure", {
          community_id: input.communityId,
          post_id: post.post_id,
          asset_id: post.asset_id ?? null,
          error: cleanupError,
        })
      }
      throw error
    }

    await input.communityRepository.recordCommunityPostProjection({
      communityId: input.communityId,
      sourcePostId: completedPost.post_id,
      authorUserId: completedPost.author_user_id ?? null,
      identityMode: completedPost.identity_mode,
      postType: completedPost.post_type,
      status: completedPost.status,
      visibility: completedPost.visibility,
      sourceCreatedAt: completedPost.created_at,
      projectedPayloadJson: JSON.stringify(completedPost),
      actorUserId: input.userId,
      createdAt,
    })
    await enqueueTelegramPublicationIfPublished({
      client: db.client,
      communityId: input.communityId,
      post: completedPost,
      createdAt,
    })
    schedulePublicPostCachePurge({
      env: input.env,
      communityId: input.communityId,
      postId: completedPost.post_id,
      waitUntil: input.waitUntil,
    })

    if (completedPost.post_type === "song" && completedPost.song_artifact_bundle_id) {
      await consumeSongPostBundle({
        env: input.env,
        communityId: input.communityId,
        songArtifactBundleId: completedPost.song_artifact_bundle_id,
      })
    }

    return completedPost
  } finally {
    db.close()
  }
}
