import { openCommunityDb } from "../communities/community-db-factory"
import type { CommunityRepository } from "../communities/db-community-repository"
import type { UserRepository } from "../auth/repositories"
import type { DbExecutor } from "../db-helpers"
import { badRequestError, internalError, notFoundError } from "../errors"
import { nowIso } from "../helpers"
import { getPostById } from "../posts/community-post-store"
import { getCommentById } from "../comments/community-comment-store"
import type { Env } from "../../types"
import {
  createModerationAction,
  getModerationCaseById,
  resolveModerationCase,
  setCommentModerationStatus,
  setPostAgeGatePolicy,
  setPostModerationStatus,
} from "./community-moderation-store"
import type {
  CreateModerationActionRequest,
  ModerationCase,
  ModerationCaseDetail,
} from "./moderation-types"
import { requireOwner, requireVerifiedHuman } from "./moderation-access"
import { assertCreateModerationActionRequest } from "./moderation-validation"
import { buildModerationCaseDetail } from "./case-detail-service"

async function applyModerationAction(input: {
  caseRow: ModerationCase
  dbClient: DbExecutor
  body: CreateModerationActionRequest
  now: string
}): Promise<{
  previousStatus?: string | null
  nextStatus?: string | null
  previousAgeGatePolicy?: "none" | "18_plus" | null
  nextAgeGatePolicy?: "none" | "18_plus" | null
}> {
  if (input.caseRow.post_id) {
    const post = await getPostById(input.dbClient, input.caseRow.post_id)
    if (!post) {
      throw notFoundError("Post not found")
    }
    switch (input.body.action_type) {
      case "dismiss":
        return {}
      case "hide":
        await setPostModerationStatus({
          executor: input.dbClient,
          postId: post.post_id,
          status: "hidden",
          now: input.now,
        })
        return { previousStatus: post.status, nextStatus: "hidden" }
      case "remove":
        await setPostModerationStatus({
          executor: input.dbClient,
          postId: post.post_id,
          status: "removed",
          now: input.now,
        })
        return { previousStatus: post.status, nextStatus: "removed" }
      case "restore":
        await setPostModerationStatus({
          executor: input.dbClient,
          postId: post.post_id,
          status: "published",
          now: input.now,
        })
        return { previousStatus: post.status, nextStatus: "published" }
      case "age_gate":
        await setPostAgeGatePolicy({
          executor: input.dbClient,
          postId: post.post_id,
          ageGatePolicy: "18_plus",
          now: input.now,
        })
        return {
          previousAgeGatePolicy: post.age_gate_policy,
          nextAgeGatePolicy: "18_plus",
        }
      default:
        throw badRequestError("Unsupported moderation action")
    }
  }

  if (!input.caseRow.comment_id) {
    throw notFoundError("Moderation case target is missing")
  }

  const comment = await getCommentById(input.dbClient, input.caseRow.comment_id)
  if (!comment) {
    throw notFoundError("Comment not found")
  }

  switch (input.body.action_type) {
    case "dismiss":
      return {}
    case "hide":
      await setCommentModerationStatus({
        executor: input.dbClient,
        commentId: comment.comment_id,
        status: "hidden",
        now: input.now,
      })
      return { previousStatus: comment.status, nextStatus: "hidden" }
    case "remove":
      await setCommentModerationStatus({
        executor: input.dbClient,
        commentId: comment.comment_id,
        status: "removed",
        now: input.now,
      })
      return { previousStatus: comment.status, nextStatus: "removed" }
    case "restore":
      await setCommentModerationStatus({
        executor: input.dbClient,
        commentId: comment.comment_id,
        status: "published",
        now: input.now,
      })
      return { previousStatus: comment.status, nextStatus: "published" }
    case "age_gate":
      throw badRequestError("age_gate is only supported for posts")
    default:
      throw badRequestError("Unsupported moderation action")
  }
}

export async function resolveModerationCaseWithAction(input: {
  env: Env
  userId: string
  communityId: string
  moderationCaseId: string
  body: CreateModerationActionRequest
  userRepository: UserRepository
  communityRepository: CommunityRepository
}): Promise<ModerationCaseDetail> {
  assertCreateModerationActionRequest(input.body)
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireOwner({
      client: db.client,
      communityId: input.communityId,
      userId: input.userId,
    })
    await requireVerifiedHuman(input.userRepository, input.userId)

    const caseRow = await getModerationCaseById({
      executor: db.client,
      moderationCaseId: input.moderationCaseId,
    })
    if (!caseRow || caseRow.community_id !== input.communityId) {
      throw notFoundError("Moderation case not found")
    }
    if (caseRow.status !== "open") {
      throw badRequestError("Moderation case is already resolved")
    }

    const now = nowIso()
    const tx = await db.client.transaction("write")
    let mutation: Awaited<ReturnType<typeof applyModerationAction>> | null = null
    try {
      mutation = await applyModerationAction({
        caseRow,
        dbClient: tx,
        body: input.body,
        now,
      })
      await createModerationAction({
        executor: tx,
        moderationCase: caseRow,
        actorUserId: input.userId,
        body: input.body,
        now,
        previousStatus: mutation.previousStatus,
        nextStatus: mutation.nextStatus,
        previousAgeGatePolicy: mutation.previousAgeGatePolicy,
        nextAgeGatePolicy: mutation.nextAgeGatePolicy,
      })
      await resolveModerationCase({
        executor: tx,
        moderationCaseId: caseRow.moderation_case_id,
        now,
      })
      await tx.commit()
    } catch (error) {
      try {
        await tx.rollback()
      } catch (rollbackError) {
        console.error("[moderation-case-actions] rollback failed while recording case action", rollbackError)
      }
      throw error
    } finally {
      tx.close()
    }

    if (caseRow.post_id && mutation?.nextStatus) {
      await input.communityRepository.updateCommunityPostProjectionStatus({
        postId: caseRow.post_id,
        status: mutation.nextStatus as "draft" | "published" | "hidden" | "removed" | "deleted",
        updatedAt: now,
      })
    }

    const updatedCase = await getModerationCaseById({
      executor: db.client,
      moderationCaseId: input.moderationCaseId,
    })
    if (!updatedCase) {
      throw internalError("Moderation case is missing after action")
    }
    return await buildModerationCaseDetail({
      caseRow: updatedCase,
      dbClient: db.client,
    })
  } finally {
    db.close()
  }
}
