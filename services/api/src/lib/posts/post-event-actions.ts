import { openCommunityWriteClient } from "../communities/community-read-access"
import type {
  CommunityDatabaseBindingRepository,
  CommunityPostProjectionRepository,
  CommunityReadRepository,
} from "../communities/db-community-repository"
import type { UserRepository } from "../auth/repositories"
import { safeRollback } from "../transactions"
import { badRequestError, eligibilityFailed, notFoundError } from "../errors"
import { nowIso } from "../helpers"
import { resolveAgeGateViewerState } from "./age-gate-viewer-state"
import {
  ANY_COMMUNITY_ROLE,
  hasCommunityRole,
} from "../communities/membership/membership-state-store"
import { getPostById } from "./community-post-query-store"
import { setPostEventStatus } from "./community-post-event-store"
import { buildLocalizedPostReadResponse } from "./post-read-response"
import { requireMemberAccess } from "./post-access"
import type { Env } from "../../env"
import type { LocalizedPostResponse } from "../../types"

type PostEventActionCommunityRepository =
  & CommunityReadRepository
  & CommunityDatabaseBindingRepository
  & Pick<CommunityPostProjectionRepository, "getCommunityPostProjectionByPostId" | "updateCommunityPostProjectionPayload">

export async function cancelPostEvent(input: {
  env: Env
  userId: string
  userRepository: UserRepository
  communityId: string
  postId: string
  communityRepository: PostEventActionCommunityRepository
}): Promise<LocalizedPostResponse> {
  const projection = await input.communityRepository.getCommunityPostProjectionByPostId(input.postId)
  if (!projection || projection.community_id !== input.communityId) {
    throw notFoundError("Post not found")
  }

  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    const membership = await requireMemberAccess(db.client, input.communityId, input.userId)
    const post = await getPostById(db.client, input.postId)
    if (!post || post.community_id !== input.communityId) {
      throw notFoundError("Post not found")
    }
    if (post.status !== "published") {
      throw badRequestError("Cannot update an event on a post that is not published")
    }
    if (post.author_user_id !== input.userId && !hasCommunityRole(membership, ANY_COMMUNITY_ROLE)) {
      throw eligibilityFailed("You do not have permission to update this event")
    }

    if (!post.event) {
      throw notFoundError("Event not found")
    }

    const updatedAt = nowIso()
    const tx = await db.client.transaction("write")
    try {
      await setPostEventStatus({
        executor: tx,
        communityId: input.communityId,
        postId: input.postId,
        status: "canceled",
        updatedAt,
      })
      await tx.commit()
    } catch (error) {
      await safeRollback(tx, "[posts] rollback failed while canceling event")
      throw error
    } finally {
      tx.close()
    }

    const updatedPost = await getPostById(db.client, input.postId)
    if (!updatedPost) {
      throw notFoundError("Post not found")
    }
    await input.communityRepository.updateCommunityPostProjectionPayload({
      postId: input.postId,
      projectedPayloadJson: JSON.stringify(updatedPost),
      updatedAt,
    })

    return await buildLocalizedPostReadResponse({
      client: db.client,
      post: updatedPost,
      viewerUserId: input.userId,
      ageGateViewerState: await resolveAgeGateViewerState({
        userId: input.userId,
        postAgeGatePolicy: updatedPost.age_gate_policy,
        userRepository: input.userRepository,
      }),
    })
  } finally {
    db.close()
  }
}
