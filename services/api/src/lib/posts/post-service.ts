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
import { markPostDeleted } from "./community-post-mutation-store"
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
import {
  enqueueEmbedHydrateIfNeeded,
  enqueuePostLabelIfNeeded,
  enqueuePostTranslationPrewarmJobs,
} from "./post-jobs"
import {
  enqueueCommunityJob,
  findLatestCommunityJobBySubjectAndType,
} from "../communities/jobs/store"
import { enqueueVideoMediaAnalysisIfEnabled } from "../communities/jobs/video-media-analysis-handler"
import { processCommunityJobById } from "../communities/jobs/runner"
import type { CommunityJobRepository } from "../communities/jobs/runner-types"
import { conflictError, eligibilityFailed, internalError, providerUnavailable } from "../errors"
import { nowIso } from "../helpers"
import { withRequestControlPlaneClients } from "../runtime-deps"
import type { DbExecutor } from "../db-helpers"
import type { Env } from "../../env"
import type { Asset, CreatePostRequest, Post } from "../../types"
import type { AltchaProofInput } from "../verification/altcha-provider"
import { schedulePublicPostCachePurge } from "../public-read-cache-invalidation"
import { preparePostCreate } from "./post-create-preparation"
import { recordReviewRequiredPostModeration } from "./post-moderation-recording"
import { assertPostCreateRequest } from "./post-create-validation"
import { hashPostCreateRequestBody, isPostCreateIdempotencyConflict } from "./post-create-idempotency"

type PostWaitUntil = (promise: Promise<void>) => void
type PostAssetCreator = typeof createAssetForPost
type SongPostAssetCreator = typeof createSongAssetForPost
type PostCommunityWriteOpener = typeof openCommunityWriteClient
let postAssetCreatorForRuntime: PostAssetCreator = createAssetForPost
let songPostAssetCreatorForRuntime: SongPostAssetCreator = createSongAssetForPost
let postCommunityWriteOpenerForRuntime: PostCommunityWriteOpener = openCommunityWriteClient

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

export { moderationSeverityFromProviderResult } from "./post-moderation-recording"
export {
  deletePost,
  removePostAsModerator,
  setPostCommentLock,
  type DeletePostResult,
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
export { castPostVote } from "./post-votes"

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
    input.waitUntil?.(withRequestControlPlaneClients(async () => {
      await processCommunityJobById({
        env: input.env,
        communityId: input.communityId,
        jobId: job.job_id,
        communityRepository: input.communityRepository as unknown as CommunityJobRepository,
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

  input.waitUntil?.(withRequestControlPlaneClients(async () => {
    try {
      await processCommunityJobById({
        env: input.env,
        communityId: input.communityId,
        jobId: job.job_id,
        communityRepository: input.communityRepository as unknown as CommunityJobRepository,
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

  const db = await postCommunityWriteOpenerForRuntime(input.env, input.communityRepository, input.communityId)
  try {
    const postAnalysisProvider = resolvePostAnalysisProvider(input.env)
    if (!input.bypassAuthorAccessChecks) {
      await requireMemberAccess(db.client, input.communityId, input.userId)
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
    let shouldKickPublishFinalize = false
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
        analysisOverride,
        agentWriteAuthorization: agentWriteAuthorization ?? undefined,
      })

      await enqueuePostTranslationPrewarmJobs({
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
            access_mode: input.body.access_mode ?? null,
            commercial_rev_share_pct: input.body.commercial_rev_share_pct ?? null,
            license_preset: input.body.license_preset ?? null,
            royalty_allocations: input.body.royalty_allocations ?? null,
            rights_basis: input.body.rights_basis ?? null,
            song_mode: input.body.song_mode ?? null,
            upstream_asset_refs: input.body.upstream_asset_refs ?? null,
          },
          status: "pending",
          createdAt,
        })
        await enqueueCommunityJob({
          client: tx,
          communityId: input.communityId,
          jobType: "post_publish_finalize",
          subjectType: "post",
          subjectId: draft.post_id,
          payloadJson: JSON.stringify({ post_id: draft.post_id }),
          createdAt,
          dedupe: false,
        })
        shouldKickPublishFinalize = true
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

    if (input.body.publish_mode === "async") {
      if (shouldKickPublishFinalize) {
        input.waitUntil?.(withRequestControlPlaneClients(async () => {
          const job = await findLatestCommunityJobBySubjectAndType({
            client: db.client,
            jobType: "post_publish_finalize",
            subjectType: "post",
            subjectId: post.post_id,
          })
          if (!job || (job.status !== "queued" && job.status !== "running")) {
            return
          }
          await processCommunityJobById({
            env: input.env,
            communityId: input.communityId,
            jobId: job.job_id,
            communityRepository: input.communityRepository as unknown as CommunityJobRepository,
          })
        }))
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
    try {
      for (const runPostCommitAssetTask of postCommitAssetTasks) {
        await runPostCommitAssetTask()
      }
      if (input.body.listing_draft && post.asset_id?.trim()) {
        const existingListing = await getListingRowByAssetId(db.client, input.communityId, post.asset_id)
        if (!existingListing) {
          await createCommunityListingInTransaction({
            env: input.env,
            userId: input.userId,
            communityId: input.communityId,
            body: {
              ...input.body.listing_draft,
              asset: `asset_${post.asset_id}`,
              live_room: null,
              replay_asset: null,
            },
            communityRepository: input.communityRepository as unknown as Parameters<typeof createCommunityListingInTransaction>[0]["communityRepository"],
            userRepository: input.userRepository,
            client: db.client,
          })
        }
      }
    } catch (error) {
      try {
        await markPostDeleted({
          executor: db.client,
          postId: post.post_id,
          now: nowIso(),
        })
      } catch (cleanupError) {
        console.error("[posts] failed to delete post after asset creation failure", {
          community_id: input.communityId,
          post_id: post.post_id,
          asset_id: post.asset_id ?? null,
          error: cleanupError,
        })
      }
      throw error
    }

    if (post.post_type === "video" && resolvedVideoAsset) {
      // Soundtrack rights analysis is advisory (never blocks or deletes the
      // post), so an enqueue failure must not fail the publish.
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
    schedulePublicPostCachePurge({
      env: input.env,
      communityId: input.communityId,
      postId: post.post_id,
      waitUntil: input.waitUntil,
    })

    if (post.post_type === "song" && post.song_artifact_bundle_id) {
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
