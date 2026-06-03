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
import { resolvePostAnalysisProvider } from "./post-analysis"
import {
  findPostByIdempotencyKey,
  insertPost,
} from "./community-post-create-store"
import { consumeSongPostBundle } from "../song-artifacts/song-artifact-post-resolution-service"
import {
  createAssetForPost,
  createSongAssetForPost,
} from "../communities/commerce/service"
import {
  requireMemberAccess,
} from "./post-access"
import { enforceCommunityActionGate } from "../communities/membership/eligibility-service"
import {
  enqueueEmbedHydrateIfNeeded,
  enqueuePostLabelIfNeeded,
  enqueuePostTranslationPrewarmJobs,
} from "./post-jobs"
import { eligibilityFailed } from "../errors"
import { nowIso } from "../helpers"
import type { Env } from "../../env"
import type { CreatePostRequest, Post } from "../../types"
import type { AltchaProofInput } from "../verification/altcha-provider"
import { preparePostCreate } from "./post-create-preparation"
import { recordReviewRequiredPostModeration } from "./post-moderation-recording"
import { assertPostCreateRequest } from "./post-create-validation"

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
  listCommunityEvents,
  listCommunityPosts,
  listPublicCommunityPosts,
} from "./post-read-service"
export { castPostVote } from "./post-votes"

type PostServiceCommunityRepository =
  & CommunityReadRepository
  & CommunityDatabaseBindingRepository
  & CommunityPostProjectionRepository

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
    const tx = await db.client.transaction("write")
    let post: Post
    const requireStoryRoyaltyRegistration = true
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
        await recordReviewRequiredPostModeration({
          executor: tx,
          communityId: input.communityId,
          postId: post.post_id,
          providerResult: analysisProviderResult,
          now: createdAt,
        })
      }

      if (post.post_type === "song" && post.song_artifact_bundle_id && resolvedSongBundleForAsset) {
        await createSongAssetForPost({
          env: input.env,
          client: tx,
          communityId: input.communityId,
          post,
          bundle: resolvedSongBundleForAsset.bundle,
          licensePreset: input.body.license_preset ?? null,
          commercialRevSharePct: input.body.commercial_rev_share_pct ?? null,
          requireStoryRoyaltyRegistration,
          userRepository: input.userRepository,
        })
      }
      if (post.post_type === "video" && shouldCreateVideoAssetForPost(post) && resolvedVideoAsset) {
        await createAssetForPost({
          env: input.env,
          client: tx,
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
          requireStoryRoyaltyRegistration,
          userRepository: input.userRepository,
        })
      }

      await tx.commit()
    } catch (error) {
      await safeRollback(tx, "[posts] rollback failed while creating post")
      throw error
    } finally {
      tx.close()
    }

    try {
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
    } catch (error) {
      throw new Error(`post_projection_record_failed:${error instanceof Error ? error.message : String(error)}`)
    }

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

function shouldCreateVideoAssetForPost(post: Post): boolean {
  return Boolean(
    post.asset_id?.trim()
    && (
      post.access_mode != null
      || post.rights_basis === "derivative"
      || (post.upstream_asset_refs?.length ?? 0) > 0
    ),
  )
}
