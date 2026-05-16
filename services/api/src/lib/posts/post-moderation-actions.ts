import { openCommunityDb } from "../communities/community-db-factory"
import type {
  CommunityDatabaseBindingRepository,
  CommunityPostProjectionRepository,
  CommunityReadRepository,
} from "../communities/db-community-repository"
import { safeRollback } from "../transactions"
import { badRequestError, eligibilityFailed, notFoundError } from "../errors"
import { nowIso } from "../helpers"
import type { Env } from "../../env"
import type { Post } from "../../types"
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
  communityRepository: PostModerationActionCommunityRepository
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
  communityRepository: PostModerationActionCommunityRepository
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
  communityRepository: PostModerationActionCommunityRepository
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
