import { openCommunityWriteClient } from "../communities/community-read-access"
import type {
  CommunityDatabaseBindingRepository,
  CommunityPostProjectionRepository,
  CommunityReadRepository,
} from "../communities/db-community-repository"
import { safeRollback } from "../transactions"
import { badRequestError, eligibilityFailed, notFoundError } from "../errors"
import type { DbExecutor } from "../db-helpers"
import { nowIso } from "../helpers"
import { logPipelineInfo } from "../observability/pipeline-log"
import type { Env } from "../../env"
import type { Post } from "../../types"
import { updateStoryRegisteredAssetPostStatus } from "../communities/commerce/derivative-source-projection"
import { schedulePublicPostCachePurge } from "../public-read-cache-invalidation"
import { enqueueVideoAudioCatalogUnenrollIfEnabled } from "../communities/jobs/video-media-analysis-handler"
import {
  markPostDeleted,
  setPostCommentsLocked,
  setPostStatus,
} from "./community-post-mutation-store"
import { getPostById } from "./community-post-query-store"
import { requireMemberAccess } from "./post-access"
import {
  ANY_COMMUNITY_ROLE,
  hasCommunityRole,
} from "../communities/membership/membership-state-store"

type PostModerationActionCommunityRepository =
  & CommunityReadRepository
  & CommunityDatabaseBindingRepository
  & Pick<CommunityPostProjectionRepository, "getCommunityPostProjectionByPostId" | "updateCommunityPostProjectionStatus">

type WaitUntil = (promise: Promise<void>) => void

async function updateDerivativeSourceProjectionStatus(input: {
  env: Env
  communityId: string
  postId: string
  status: Post["status"]
  updatedAt: string
}): Promise<void> {
  try {
    await updateStoryRegisteredAssetPostStatus({
      env: input.env,
      communityId: input.communityId,
      sourcePostId: input.postId,
      sourcePostStatus: input.status,
      updatedAt: input.updatedAt,
    })
  } catch (error) {
    logPipelineInfo("[posts] Story registered asset projection status update failed", {
      level: "warn",
      community_id: input.communityId,
      post_id: input.postId,
      status: input.status,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

type DeletePostResult = {
  post: Pick<Post, "post_id" | "status" | "updated_at">
  deletedAt: string
  alreadyDeleted: boolean
}

// Post-commit scheduling of the ACR catalog unenroll job. The job runner
// tolerates duplicates, and an enqueue failure must never fail the deletion
// that already committed, so this is always best-effort.
async function scheduleVideoAudioCatalogUnenroll(input: {
  env: Env
  client: DbExecutor
  communityId: string
  postId: string
  redactUploader: boolean
}): Promise<void> {
  try {
    await enqueueVideoAudioCatalogUnenrollIfEnabled(input)
  } catch (error) {
    logPipelineInfo("[posts] Video audio catalog unenroll enqueue failed", {
      level: "warn",
      community_id: input.communityId,
      post_id: input.postId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export async function deletePost(input: {
  env: Env
  userId: string
  communityId: string
  postId: string
  communityRepository: PostModerationActionCommunityRepository
  waitUntil?: WaitUntil
}): Promise<DeletePostResult> {
  const projection = await input.communityRepository.getCommunityPostProjectionByPostId(input.postId)
  if (!projection || projection.community_id !== input.communityId) {
    throw notFoundError("Post not found")
  }

  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
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
      await markPostDeleted({
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
      await updateDerivativeSourceProjectionStatus({
        env: input.env,
        communityId: input.communityId,
        postId: input.postId,
        status: "deleted",
        updatedAt: deletedAt,
      })
      await scheduleVideoAudioCatalogUnenroll({
        env: input.env,
        client: db.client,
        communityId: input.communityId,
        postId: input.postId,
        redactUploader: true,
      })
      schedulePublicPostCachePurge({
        env: input.env,
        communityId: input.communityId,
        postId: input.postId,
        waitUntil: input.waitUntil,
      })

      // Response is deterministic from the write (status/updated_at are exactly
      // what markPostDeleted set) — no in-tx readback needed.
      return {
        post: {
          post_id: input.postId,
          status: "deleted",
          updated_at: deletedAt,
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
  communityRepository: PostModerationActionCommunityRepository
  waitUntil?: WaitUntil
}): Promise<Post> {
  const projection = await input.communityRepository.getCommunityPostProjectionByPostId(input.postId)
  if (!projection || projection.community_id !== input.communityId) {
    throw notFoundError("Post not found")
  }

  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
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
    await updateDerivativeSourceProjectionStatus({
      env: input.env,
      communityId: input.communityId,
      postId: input.postId,
      status: "removed",
      updatedAt,
    })
    await scheduleVideoAudioCatalogUnenroll({
      env: input.env,
      client: db.client,
      communityId: input.communityId,
      postId: input.postId,
      redactUploader: false,
    })
    schedulePublicPostCachePurge({
      env: input.env,
      communityId: input.communityId,
      postId: input.postId,
      waitUntil: input.waitUntil,
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
  communityRepository: PostModerationActionCommunityRepository
  waitUntil?: WaitUntil
}): Promise<Post> {
  const projection = await input.communityRepository.getCommunityPostProjectionByPostId(input.postId)
  if (!projection || projection.community_id !== input.communityId) {
    throw notFoundError("Post not found")
  }

  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
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

    const updated = await setPostCommentsLocked({
      executor: db.client,
      postId: input.postId,
      locked: input.locked,
      actorUserId: input.userId,
      reason: input.reason?.trim() || null,
      now: nowIso(),
    })
    schedulePublicPostCachePurge({
      env: input.env,
      communityId: input.communityId,
      postId: input.postId,
      waitUntil: input.waitUntil,
    })
    return updated
  } finally {
    db.close()
  }
}
