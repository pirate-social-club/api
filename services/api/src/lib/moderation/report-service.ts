import { openCommunityDb } from "../communities/community-db-factory"
import type { CommunityRepository } from "../communities/db-community-repository"
import type { UserRepository } from "../auth/repositories"
import { notFoundError } from "../errors"
import { nowIso } from "../helpers"
import { getPostById } from "../posts/community-post-store"
import { getCommentById } from "../comments/community-comment-store"
import type { Env } from "../../types"
import {
  createModerationCase,
  createUserReport,
  findExistingUserReport,
  getOpenModerationCaseForTarget,
  updateModerationCaseOpenedBy,
} from "./community-moderation-store"
import type {
  CreateUserReportRequest,
  UserReport,
} from "./moderation-types"
import { requireCommunityAccess, requireVerifiedHuman } from "./moderation-access"
import { assertCreateUserReportRequest, reportPriority } from "./moderation-validation"

export async function reportPost(input: {
  env: Env
  userId: string
  communityId: string
  postId: string
  body: CreateUserReportRequest
  userRepository: UserRepository
  communityRepository: CommunityRepository
}): Promise<UserReport> {
  assertCreateUserReportRequest(input.body)
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireCommunityAccess({
      client: db.client,
      communityId: input.communityId,
      userId: input.userId,
    })
    await requireVerifiedHuman(input.userRepository, input.userId)
    const post = await getPostById(db.client, input.postId)
    if (!post || post.community_id !== input.communityId) {
      throw notFoundError("Post not found")
    }
    const existingReport = await findExistingUserReport({
      executor: db.client,
      communityId: input.communityId,
      reporterUserId: input.userId,
      target: { postId: input.postId },
    })
    if (existingReport) {
      return existingReport
    }
    const now = nowIso()
    const tx = await db.client.transaction("write")
    try {
      let moderationCase = await getOpenModerationCaseForTarget({
        executor: tx,
        communityId: input.communityId,
        target: { postId: input.postId },
      })
      if (!moderationCase) {
        moderationCase = await createModerationCase({
          executor: tx,
          communityId: input.communityId,
          target: { postId: input.postId },
          priority: reportPriority(input.body.reason_code),
          openedBy: "user_report",
          now,
        })
      } else if (moderationCase.opened_by === "platform_analysis") {
        await updateModerationCaseOpenedBy({
          executor: tx,
          moderationCaseId: moderationCase.moderation_case_id,
          openedBy: "mixed",
          now,
        })
      }
      const created = await createUserReport({
        executor: tx,
        communityId: input.communityId,
        moderationCaseId: moderationCase.moderation_case_id,
        reporterUserId: input.userId,
        target: { postId: input.postId },
        body: input.body,
        now,
      })
      await tx.commit()
      return created
    } catch (error) {
      try {
        await tx.rollback()
      } catch (rollbackError) {
        console.error("[moderation-reports] rollback failed while creating report", rollbackError)
      }
      throw error
    } finally {
      tx.close()
    }
  } finally {
    db.close()
  }
}

export async function reportComment(input: {
  env: Env
  userId: string
  communityId: string
  commentId: string
  body: CreateUserReportRequest
  userRepository: UserRepository
  communityRepository: CommunityRepository
}): Promise<UserReport> {
  assertCreateUserReportRequest(input.body)
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireCommunityAccess({
      client: db.client,
      communityId: input.communityId,
      userId: input.userId,
    })
    await requireVerifiedHuman(input.userRepository, input.userId)
    const comment = await getCommentById(db.client, input.commentId)
    if (!comment || comment.community_id !== input.communityId) {
      throw notFoundError("Comment not found")
    }
    const existingReport = await findExistingUserReport({
      executor: db.client,
      communityId: input.communityId,
      reporterUserId: input.userId,
      target: { commentId: input.commentId },
    })
    if (existingReport) {
      return existingReport
    }
    const now = nowIso()
    const tx = await db.client.transaction("write")
    try {
      let moderationCase = await getOpenModerationCaseForTarget({
        executor: tx,
        communityId: input.communityId,
        target: { commentId: input.commentId },
      })
      if (!moderationCase) {
        moderationCase = await createModerationCase({
          executor: tx,
          communityId: input.communityId,
          target: { commentId: input.commentId },
          priority: reportPriority(input.body.reason_code),
          openedBy: "user_report",
          now,
        })
      } else if (moderationCase.opened_by === "platform_analysis") {
        await updateModerationCaseOpenedBy({
          executor: tx,
          moderationCaseId: moderationCase.moderation_case_id,
          openedBy: "mixed",
          now,
        })
      }
      const created = await createUserReport({
        executor: tx,
        communityId: input.communityId,
        moderationCaseId: moderationCase.moderation_case_id,
        reporterUserId: input.userId,
        target: { commentId: input.commentId },
        body: input.body,
        now,
      })
      await tx.commit()
      return created
    } catch (error) {
      try {
        await tx.rollback()
      } catch (rollbackError) {
        console.error("[moderation-reports] rollback failed while resolving report", rollbackError)
      }
      throw error
    } finally {
      tx.close()
    }
  } finally {
    db.close()
  }
}
