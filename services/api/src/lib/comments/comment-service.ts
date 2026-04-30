import type { Client } from "../sql-client"
import type { DbExecutor } from "../db-helpers"
import { sha256Hex } from "../crypto"
import { openCommunityDb } from "../communities/community-db-factory"
import { enqueueCommunityJob } from "../communities/jobs/store"
import { loadCommunityProjection } from "../communities/create/repository"
import { detectSourceLanguageFromText } from "../localization/content-locale"
import { emitCommentReply, emitPostCommented } from "../notifications/notification-emitters"
import {
  canAccessCommunity,
  getCommunityMembershipState,
  type CommunityMembershipRow,
} from "../communities/membership/membership-state-store"
import type {
  CommunityCommentProjectionRepository,
  CommunityDatabaseBindingRepository,
  CommunityPostProjectionRepository,
  CommunityReadRepository,
} from "../communities/db-community-repository"
import { badRequestError, eligibilityFailed, notFoundError } from "../errors"
import { nowIso } from "../helpers"
import type { ProfileRepository, UserRepository } from "../auth/repositories"
import { authorizeAgentWrite } from "../agents/agent-write-authorization"
import { getPostById, getPostProjectionMetrics } from "../posts/community-post-store"
import {
  assertCreateCommentRequest,
  findCommentByIdempotencyKey,
  getCommentById,
  getCommunityCommentPolicy,
  insertComment,
  markCommentDeleted,
  upsertCommentVote,
} from "./community-comment-store"
import { incrementAncestorCommentCounters, incrementThreadPostCommentCounters, insertCommentClosureRows } from "./comment-closure-store"
import { enqueueCommentTranslationPrewarmJobs } from "./comment-translation-jobs"
import type { Comment, CommentAnonymousScope, CreateCommentRequest } from "./comment-types"
import type { Env } from "../../env"

export {
  getCommentContext,
  listCommentReplies,
  listPostComments,
  listPublicCommentReplies,
  listPublicPostComments,
} from "./comment-read-service"

type CommentServiceCommunityRepository =
  & CommunityReadRepository
  & CommunityDatabaseBindingRepository
  & Pick<CommunityPostProjectionRepository, "updateCommunityPostProjectionMetrics">
  & CommunityCommentProjectionRepository

async function requireMemberAccess(client: Client, communityId: string, userId: string): Promise<CommunityMembershipRow> {
  const membership = await getCommunityMembershipState(client, communityId, userId)
  if (!canAccessCommunity(membership)) {
    throw notFoundError("Community not found")
  }
  return membership
}

async function syncThreadRootPostProjectionMetrics(input: {
  client: Client
  communityRepository: Pick<CommunityPostProjectionRepository, "updateCommunityPostProjectionMetrics">
  threadRootPostId: string
  updatedAt: string
}): Promise<void> {
  if (typeof input.communityRepository.updateCommunityPostProjectionMetrics !== "function") {
    return
  }
  const metrics = await getPostProjectionMetrics(input.client, input.threadRootPostId)
  await input.communityRepository.updateCommunityPostProjectionMetrics({
    postId: input.threadRootPostId,
    upvoteCount: metrics.upvoteCount,
    downvoteCount: metrics.downvoteCount,
    commentCount: metrics.commentCount,
    likeCount: metrics.likeCount,
    updatedAt: input.updatedAt,
  })
}

function resolveAnonymousScope(input: {
  policyScope: CommentAnonymousScope
  requestedScope: Exclude<CommentAnonymousScope, null> | undefined
}): Exclude<CommentAnonymousScope, null> {
  const allowedScope = input.policyScope === "community_stable" ? "community_stable" : "thread_stable"
  const requestedScope = input.requestedScope ?? allowedScope
  if (requestedScope !== allowedScope) {
    throw badRequestError("anonymous_scope does not match the community policy")
  }
  return requestedScope
}

async function enqueueProjectionRetry(input: {
  client: DbExecutor
  communityId: string
  comment: Comment
  createdAt: string
}): Promise<void> {
  try {
    await enqueueCommunityJob({
      client: input.client,
      communityId: input.communityId,
      jobType: "comment_projection_sync",
      subjectType: "comment",
      subjectId: input.comment.comment_id,
      payloadJson: JSON.stringify({
        comment_id: input.comment.comment_id,
        thread_root_post_id: input.comment.thread_root_post_id,
        parent_comment_id: input.comment.parent_comment_id,
        depth: input.comment.depth,
        status: input.comment.status,
        source_created_at: input.comment.created_at,
      }),
      createdAt: input.createdAt,
    })
  } catch (error) {
    console.error("[comments] failed to enqueue comment projection retry", {
      communityId: input.communityId,
      commentId: input.comment.comment_id,
      error,
    })
  }
}

export async function createComment(input: {
  env: Env
  requestUrl?: string
  userId: string
  communityId: string
  threadRootPostId: string
  parentCommentId?: string | null
  body: CreateCommentRequest
  bypassAuthorAccessChecks?: boolean
  userRepository: UserRepository
  profileRepository?: ProfileRepository
  communityRepository: CommentServiceCommunityRepository
}): Promise<Comment> {
  const communityRow = await input.communityRepository.getCommunityById(input.communityId)
  if (!communityRow || communityRow.provisioning_state !== "active" || communityRow.status !== "active") {
    throw eligibilityFailed("Community is not available for commenting")
  }
  const community = await loadCommunityProjection(input.env, input.communityRepository, communityRow)

  assertCreateCommentRequest(input.body)

  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    if (!input.bypassAuthorAccessChecks) {
      await requireMemberAccess(db.client, input.communityId, input.userId)
    }

    const idempotencyKey = input.body.idempotency_key?.trim() ?? ""
    const existing = idempotencyKey
      ? await findCommentByIdempotencyKey({
          executor: db.client,
          communityId: input.communityId,
          authorUserId: input.userId,
          idempotencyKey,
        })
      : null
    if (existing) {
      return existing
    }

    const threadRootPost = await getPostById(db.client, input.threadRootPostId)
    if (!threadRootPost || threadRootPost.community_id !== input.communityId || threadRootPost.status !== "published") {
      throw notFoundError("Post not found")
    }

    const policy = await getCommunityCommentPolicy(db.client, input.communityId)
    if (!policy) {
      throw notFoundError("Community not found")
    }

    let writeBody = input.body
    if ((input.body.identity_mode ?? "public") === "anonymous") {
      if (!policy.allow_anonymous_identity) {
        throw eligibilityFailed("Anonymous comments are not enabled in this community")
      }
      writeBody = {
        ...input.body,
        anonymous_scope: resolveAnonymousScope({
          policyScope: policy.anonymous_identity_scope,
          requestedScope: input.body.anonymous_scope ?? undefined,
        }),
      }
    }

    const parentComment = input.parentCommentId ? await getCommentById(db.client, input.parentCommentId) : null
    if (input.parentCommentId && !parentComment) {
      throw notFoundError("Parent comment not found")
    }
    if (parentComment && parentComment.thread_root_post_id !== input.threadRootPostId) {
      throw badRequestError("Parent comment does not belong to this thread")
    }
    if (parentComment && parentComment.status !== "published") {
      throw eligibilityFailed("Replies are not allowed on removed or deleted comments")
    }

    const agentWriteAuthorization = await authorizeAgentWrite({
      env: input.env,
      requestUrl: input.requestUrl ?? "http://localhost/",
      userId: input.userId,
      body: input.body,
      community,
      communityDbClient: db.client,
      profileRepository: input.profileRepository ?? {
        async getProfileByUserId() { return null },
        async resolvePublicProfileByHandle() { return null },
        async resolvePublicProfileByWalletAddress() { return null },
        async updateXmtpInboxId() { return null },
        async updateProfile() { return null },
        async renameGlobalHandle() { return null },
        async claimRedditGlobalHandle() { return null },
        async quoteGlobalHandleUpgrade() { return null },
        async syncLinkedHandles() { return null },
        async setPrimaryPublicHandle() { return null },
      },
      writeTarget: "comment",
    })

    const createdAt = nowIso()
    const depth = parentComment ? parentComment.depth + 1 : 0
    const tx = await db.client.transaction("write")
    let createdComment: Comment

    try {
      createdComment = await insertComment({
        executor: tx,
        communityId: input.communityId,
        threadRootPostId: input.threadRootPostId,
        parentCommentId: input.parentCommentId ?? null,
        authorUserId: input.userId,
        body: writeBody,
        sourceLanguage: detectSourceLanguageFromText([writeBody.body]),
        depth,
        createdAt,
        contentHash: `0x${await sha256Hex(writeBody.body.trim())}`,
        agentWriteAuthorization: agentWriteAuthorization ?? undefined,
      })

      await insertCommentClosureRows({
        executor: tx,
        commentId: createdComment.comment_id,
        parentCommentId: input.parentCommentId ?? null,
      })

      await incrementAncestorCommentCounters({
        executor: tx,
        parentCommentId: input.parentCommentId ?? null,
        repliedAt: createdComment.created_at,
      })

      await incrementThreadPostCommentCounters({
        executor: tx,
        threadRootPostId: input.threadRootPostId,
        isTopLevel: !input.parentCommentId,
        commentedAt: createdComment.created_at,
      })

      await enqueueCommunityJob({
        client: tx,
        communityId: input.communityId,
        jobType: "comment_body_mirror",
        subjectType: "comment",
        subjectId: createdComment.comment_id,
        payloadJson: JSON.stringify({
          comment_id: createdComment.comment_id,
          thread_root_post_id: createdComment.thread_root_post_id,
        }),
        createdAt,
      })

      await enqueueCommunityJob({
        client: tx,
        communityId: input.communityId,
        jobType: "thread_snapshot_publish",
        subjectType: "thread",
        subjectId: input.threadRootPostId,
        payloadJson: JSON.stringify({
          thread_root_post_id: input.threadRootPostId,
        }),
        createdAt,
      })

      await enqueueCommentTranslationPrewarmJobs({
        client: tx,
        communityId: input.communityId,
        comment: createdComment,
        createdAt,
      })

      await tx.commit()

      try {
        await input.communityRepository.recordCommunityCommentProjection({
          communityId: input.communityId,
          threadRootPostId: createdComment.thread_root_post_id,
          sourceCommentId: createdComment.comment_id,
          parentCommentId: createdComment.parent_comment_id,
          depth: createdComment.depth,
          status: createdComment.status,
          sourceCreatedAt: createdComment.created_at,
          actorUserId: input.userId,
          createdAt,
        })
      } catch {
        await enqueueProjectionRetry({
          client: db.client,
          communityId: input.communityId,
          comment: createdComment,
          createdAt,
        })
      }

      await syncThreadRootPostProjectionMetrics({
        client: db.client,
        communityRepository: input.communityRepository,
        threadRootPostId: createdComment.thread_root_post_id,
        updatedAt: createdAt,
      })

      try {
        const notifiedUserIds = new Set<string>()
        const threadRootPost = await getPostById(db.client, input.threadRootPostId)

        if (parentComment && parentComment.author_user_id) {
          await emitCommentReply({
            env: input.env,
            actorUserId: input.userId,
            commentExcerpt: createdComment.body,
            postTitle: threadRootPost?.title ?? null,
            recipientUserId: parentComment.author_user_id,
            communityId: input.communityId,
            threadRootPostId: input.threadRootPostId,
            parentCommentId: parentComment.comment_id,
            replyCommentId: createdComment.comment_id,
          })
          notifiedUserIds.add(parentComment.author_user_id)
        }

        if (threadRootPost?.author_user_id && threadRootPost.author_user_id !== input.userId && !notifiedUserIds.has(threadRootPost.author_user_id)) {
          await emitPostCommented({
            env: input.env,
            actorUserId: input.userId,
            commentExcerpt: createdComment.body,
            postAuthorUserId: threadRootPost.author_user_id,
            communityId: input.communityId,
            postId: input.threadRootPostId,
            postTitle: threadRootPost.title ?? null,
            commentId: createdComment.comment_id,
          })
        }
      } catch (error) {
        console.error("[comments] failed to emit comment notifications", {
          communityId: input.communityId,
          postId: input.threadRootPostId,
          commentId: createdComment.comment_id,
          error,
        })
      }

      return createdComment
    } catch (error) {
      try {
        await tx.rollback()
      } catch (rollbackError) {
        console.error("[comments] rollback failed while creating comment", rollbackError)
      }
      throw error
    } finally {
      tx.close()
    }
  } finally {
    db.close()
  }
}

export async function castCommentVote(input: {
  env: Env
  userId: string
  commentId: string
  value: -1 | 1
  bypassVoterAccessChecks?: boolean
  userRepository: UserRepository
  communityRepository: CommentServiceCommunityRepository
}): Promise<{ comment_id: string; value: -1 | 1 }> {
  const projection = await input.communityRepository.getCommunityCommentProjectionByCommentId(input.commentId)
  if (!projection) {
    throw notFoundError("Comment not found")
  }

  const db = await openCommunityDb(input.env, input.communityRepository, projection.community_id)
  try {
    if (!input.bypassVoterAccessChecks) {
      await requireMemberAccess(db.client, projection.community_id, input.userId)
    }
    const comment = await getCommentById(db.client, input.commentId)
    if (!comment || comment.status !== "published") {
      throw notFoundError("Comment not found")
    }

    const tx = await db.client.transaction("write")
    try {
      const result = await upsertCommentVote({
        executor: tx,
        commentId: input.commentId,
        userId: input.userId,
        value: input.value,
        now: nowIso(),
      })
      await tx.commit()
      return result
    } catch (error) {
      try {
        await tx.rollback()
      } catch (rollbackError) {
        console.error("[comments] rollback failed while casting comment vote", rollbackError)
      }
      throw error
    } finally {
      tx.close()
    }
  } finally {
    db.close()
  }
}

export async function deleteComment(input: {
  env: Env
  userId: string
  commentId: string
  userRepository: UserRepository
  communityRepository: CommentServiceCommunityRepository
}): Promise<Comment> {
  const projection = await input.communityRepository.getCommunityCommentProjectionByCommentId(input.commentId)
  if (!projection) {
    throw notFoundError("Comment not found")
  }

  const db = await openCommunityDb(input.env, input.communityRepository, projection.community_id)
  try {
    const membership = await requireMemberAccess(db.client, projection.community_id, input.userId)

    const comment = await getCommentById(db.client, input.commentId)
    if (!comment) {
      throw notFoundError("Comment not found")
    }
    if (comment.status === "deleted") {
      return comment
    }
    if (comment.author_user_id !== input.userId && membership.role_status !== "active") {
      throw eligibilityFailed("You do not have permission to delete this comment")
    }

    const updatedAt = nowIso()
    const tx = await db.client.transaction("write")
    try {
      const deleted = await markCommentDeleted({
        executor: tx,
        commentId: input.commentId,
        now: updatedAt,
      })
      await tx.commit()

      try {
        await input.communityRepository.recordCommunityCommentProjection({
          communityId: deleted.community_id,
          threadRootPostId: deleted.thread_root_post_id,
          sourceCommentId: deleted.comment_id,
          parentCommentId: deleted.parent_comment_id,
          depth: deleted.depth,
          status: deleted.status,
          sourceCreatedAt: deleted.created_at,
          actorUserId: input.userId,
          createdAt: updatedAt,
        })
      } catch {
        await enqueueProjectionRetry({
          client: db.client,
          communityId: deleted.community_id,
          comment: deleted,
          createdAt: updatedAt,
        })
      }

      await syncThreadRootPostProjectionMetrics({
        client: db.client,
        communityRepository: input.communityRepository,
        threadRootPostId: deleted.thread_root_post_id,
        updatedAt,
      })

      return deleted
    } catch (error) {
      try {
        await tx.rollback()
      } catch (rollbackError) {
        console.error("[comments] rollback failed while deleting comment", rollbackError)
      }
      throw error
    } finally {
      tx.close()
    }
  } finally {
    db.close()
  }
}
