import { openCommunityDb } from "../communities/community-db-factory"
import { canAccessCommunity, getCommunityMembershipState } from "../communities/membership/membership-state-store"
import type {
  CommunityDatabaseBindingRepository,
  CommunityPostProjectionRepository,
} from "../communities/db-community-repository"
import type { ProfileRepository, UserRepository } from "../auth/repositories"
import { getProfilePublicHandleLabel } from "../auth/auth-serializers"
import type { DbExecutor } from "../db-helpers"
import { badRequestError, eligibilityFailed, internalError, notFoundError, verificationRequired } from "../errors"
import { nowIso } from "../helpers"
import { getPostById } from "../posts/community-post-store"
import { getCommentById } from "../comments/community-comment-store"
import type { Env } from "../../env"
import {
  createModerationAction,
  createModerationCase,
  createUserReport,
  findExistingUserReport,
  getModerationCaseById,
  getOpenModerationCaseForTarget,
  listModerationActionsForCase,
  listModerationCases,
  listModerationSignalsForCase,
  listUserReportsForCase,
  resolveModerationCase,
  setCommentModerationStatus,
  setPostAgeGatePolicy,
  setPostModerationStatus,
  approveReviewHeldPost,
  updateModerationCaseOpenedBy,
} from "./community-moderation-store"
import type {
  CreateModerationActionRequest,
  CreateUserReportRequest,
  ModerationCase,
  ModerationCaseDetail,
  ModerationCaseListResponse,
  ModerationSignalSeverity,
  UserReport,
} from "./moderation-types"

type ModerationCommunityRepository =
  & CommunityDatabaseBindingRepository
  & Pick<CommunityPostProjectionRepository, "updateCommunityPostProjectionStatus">

function reportPriority(reasonCode: CreateUserReportRequest["reason_code"]): ModerationSignalSeverity {
  switch (reasonCode) {
    case "harassment":
    case "hate":
    case "sexual_content":
    case "graphic_content":
      return "high"
    case "spam":
    case "misleading":
      return "medium"
    case "other":
    default:
      return "low"
  }
}

async function requireVerifiedHuman(userRepository: UserRepository, userId: string): Promise<void> {
  const user = await userRepository.getUserById(userId)
  if (!user) {
    throw notFoundError("User not found")
  }
  if (user.verification_capabilities.unique_human.state !== "verified") {
    throw verificationRequired("unique_human verification is required")
  }
}

async function requireCommunityAccess(input: {
  client: Parameters<typeof getCommunityMembershipState>[0]
  communityId: string
  userId: string
}): Promise<{ role_status: "active" | "revoked" | null }> {
  const membership = await getCommunityMembershipState(input.client, input.communityId, input.userId)
  if (!canAccessCommunity(membership)) {
    throw notFoundError("Community not found")
  }
  return membership
}

async function requireOwner(input: {
  client: Parameters<typeof getCommunityMembershipState>[0]
  communityId: string
  userId: string
}): Promise<void> {
  const membership = await requireCommunityAccess(input)
  if (membership.role_status !== "active") {
    throw eligibilityFailed("Moderator access is required")
  }
}

function assertCreateUserReportRequest(body: CreateUserReportRequest): void {
  if (!body.reason_code) {
    throw badRequestError("reason_code is required")
  }
}

function assertCreateModerationActionRequest(body: CreateModerationActionRequest): void {
  if (!body.action_type) {
    throw badRequestError("action_type is required")
  }
}

async function buildModerationCaseDetail(input: {
  caseRow: ModerationCase
  dbClient: DbExecutor
}): Promise<ModerationCaseDetail> {
  const post = input.caseRow.post_id ? await getPostById(input.dbClient, input.caseRow.post_id) : null
  const comment = input.caseRow.comment_id ? await getCommentById(input.dbClient, input.caseRow.comment_id) : null
  return {
    case: input.caseRow,
    post,
    comment,
    signals: await listModerationSignalsForCase({
      executor: input.dbClient,
      moderationCaseId: input.caseRow.moderation_case_id,
    }),
    reports: await listUserReportsForCase({
      executor: input.dbClient,
      moderationCaseId: input.caseRow.moderation_case_id,
    }),
    actions: await listModerationActionsForCase({
      executor: input.dbClient,
      moderationCaseId: input.caseRow.moderation_case_id,
    }),
  }
}

export async function reportPost(input: {
  env: Env
  userId: string
  communityId: string
  postId: string
  body: CreateUserReportRequest
  userRepository: UserRepository
  communityRepository: ModerationCommunityRepository
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
        console.error("[moderation] rollback failed while creating moderation case", rollbackError)
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
  communityRepository: ModerationCommunityRepository
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
        console.error("[moderation] rollback failed while updating moderation case", rollbackError)
      }
      throw error
    } finally {
      tx.close()
    }
  } finally {
    db.close()
  }
}

export async function listCommunityModerationCases(input: {
  env: Env
  userId: string
  communityId: string
  communityRepository: ModerationCommunityRepository
  profileRepository?: ProfileRepository
}): Promise<ModerationCaseListResponse> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireOwner({
      client: db.client,
      communityId: input.communityId,
      userId: input.userId,
    })
    const items = await listModerationCases({
        executor: db.client,
        communityId: input.communityId,
      })
    if (input.profileRepository) {
      const authorHandleByUserId = new Map<string, string | null>()
      for (const item of items) {
        const authorUserId = item.post?.identity_mode === "public" ? item.post.author_user_id : null
        if (!authorUserId || authorHandleByUserId.has(authorUserId)) {
          continue
        }
        const profile = await input.profileRepository.getProfileByUserId(authorUserId).catch(() => null)
        authorHandleByUserId.set(authorUserId, profile ? getProfilePublicHandleLabel(profile) : null)
      }
      for (const item of items) {
        const authorUserId = item.post?.identity_mode === "public" ? item.post.author_user_id : null
        if (item.post && authorUserId) {
          item.post.author_handle = authorHandleByUserId.get(authorUserId) ?? null
        }
      }
    }
    return {
      items,
      next_cursor: null,
    }
  } finally {
    db.close()
  }
}

export async function getModerationCaseDetail(input: {
  env: Env
  userId: string
  communityId: string
  moderationCaseId: string
  communityRepository: ModerationCommunityRepository
}): Promise<ModerationCaseDetail> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireOwner({
      client: db.client,
      communityId: input.communityId,
      userId: input.userId,
    })
    const caseRow = await getModerationCaseById({
      executor: db.client,
      moderationCaseId: input.moderationCaseId,
    })
    if (!caseRow || caseRow.community_id !== input.communityId) {
      throw notFoundError("Moderation case not found")
    }
    return await buildModerationCaseDetail({
      caseRow,
      dbClient: db.client,
    })
  } finally {
    db.close()
  }
}

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
        if (post.status === "draft") {
          throw badRequestError("Held draft posts must be approved, hidden, or removed")
        }
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
        if (post.status === "draft" && post.analysis_state === "review_required") {
          await approveReviewHeldPost({
            executor: input.dbClient,
            postId: post.post_id,
            now: input.now,
          })
        } else {
          await setPostModerationStatus({
            executor: input.dbClient,
            postId: post.post_id,
            status: "published",
            now: input.now,
          })
        }
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
  communityRepository: ModerationCommunityRepository
}): Promise<ModerationCaseDetail> {
  assertCreateModerationActionRequest(input.body)
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireOwner({
      client: db.client,
      communityId: input.communityId,
      userId: input.userId,
    })

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
        console.error("[moderation] rollback failed while applying moderation decision", rollbackError)
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
