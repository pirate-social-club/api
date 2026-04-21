import type { Client } from "../sql-client"
import type { DbExecutor } from "../db-helpers"
import { sha256Hex } from "../crypto"
import { openCommunityDb } from "../communities/community-db-factory"
import { enqueueCommunityJob } from "../communities/community-job-store"
import { loadCommunityProjection } from "../communities/community-create-repository"
import { buildLocalizedCommentListItem } from "../localization/comment-localization-service"
import { CONTENT_TRANSLATION_PREWARM_LOCALES, detectSourceLanguageFromText, sameLanguageLocale } from "../localization/content-locale"
import { emitCommentReply, emitPostCommented } from "../notifications/notification-service"
import {
  canAccessCommunity,
  getCommunityMembershipState,
  type CommunityMembershipRow,
} from "../communities/community-membership-store"
import type { CommunityRepository } from "../communities/db-community-repository"
import { badRequestError, eligibilityFailed, notFoundError, verificationRequired } from "../errors"
import { nowIso } from "../helpers"
import type { ProfileRepository, UserRepository } from "../auth/repositories"
import { authorizeAgentWrite } from "../agents/agent-write-authorization"
import { getPostById, getPostProjectionMetrics } from "../posts/community-post-store"
import {
  assertCreateCommentRequest,
  getCommentById,
  getCommentContext as getCommentContextRow,
  getCommunityCommentPolicy,
  getLatestThreadSnapshotForRead,
  insertComment,
  listReplies,
  listTopLevelComments,
  markCommentDeleted,
  upsertCommentVote,
} from "./community-comment-store"
import { incrementAncestorCommentCounters, incrementThreadPostCommentCounters, insertCommentClosureRows } from "./comment-closure-store"
import type { Comment, CommentAnonymousScope, CommentContext, CommentListResponse, CommentSort, CreateCommentRequest } from "./comment-types"
import type { Env } from "../../types"

function isPubliclyReadableThreadRoot(input: {
  status: "draft" | "published" | "hidden" | "removed" | "deleted"
  visibility: "public" | "members_only"
}): boolean {
  return input.status === "published" && input.visibility === "public"
}

async function requireMemberAccess(client: Client, communityId: string, userId: string): Promise<CommunityMembershipRow> {
  const membership = await getCommunityMembershipState(client, communityId, userId)
  if (!canAccessCommunity(membership)) {
    throw notFoundError("Community not found")
  }
  return membership
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

async function syncThreadRootPostProjectionMetrics(input: {
  client: Client
  communityRepository: CommunityRepository
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
  } catch {}
}

async function enqueueCommentTranslationJob(input: {
  client: DbExecutor
  communityId: string
  commentId: string
  locale: string
  createdAt: string
}): Promise<void> {
  await enqueueCommunityJob({
    client: input.client,
    communityId: input.communityId,
    jobType: "comment_translation_materialize",
    subjectType: "comment_translation",
    subjectId: `${input.commentId}:${input.locale}`,
    payloadJson: JSON.stringify({
      comment_id: input.commentId,
      locale: input.locale,
    }),
    createdAt: input.createdAt,
  })
}

async function enqueueCommentTranslationPrewarmJobs(input: {
  client: DbExecutor
  communityId: string
  comment: Comment
  createdAt: string
}): Promise<void> {
  if (input.comment.status !== "published" || !String(input.comment.body ?? "").trim()) {
    return
  }

  for (const locale of CONTENT_TRANSLATION_PREWARM_LOCALES) {
    if (sameLanguageLocale(input.comment.source_language, locale)) {
      continue
    }
    await enqueueCommentTranslationJob({
      client: input.client,
      communityId: input.communityId,
      commentId: input.comment.comment_id,
      locale,
      createdAt: input.createdAt,
    })
  }
}

async function enqueueCommentTranslationOnReadIfNeeded(input: {
  client: Client
  communityId: string
  item: Pick<CommentListResponse["items"][number], "comment" | "resolved_locale" | "translation_state">
}): Promise<void> {
  if (input.item.translation_state !== "pending") {
    return
  }

  await enqueueCommentTranslationJob({
    client: input.client,
    communityId: input.communityId,
    commentId: input.item.comment.comment_id,
    locale: input.item.resolved_locale,
    createdAt: nowIso(),
  })
}

async function localizeCommentItems(input: {
  client: Client
  communityId: string
  locale?: string | null
  items: CommentListResponse["items"]
}): Promise<CommentListResponse["items"]> {
  const localized = await Promise.all(input.items.map((item) => buildLocalizedCommentListItem({
    executor: input.client,
    item,
    locale: input.locale ?? null,
  })))

  await Promise.all(localized.map((item) => enqueueCommentTranslationOnReadIfNeeded({
    client: input.client,
    communityId: input.communityId,
    item,
  })))

  return localized
}

export async function createComment(input: {
  env: Env
  requestUrl?: string
  userId: string
  communityId: string
  threadRootPostId: string
  parentCommentId?: string | null
  body: CreateCommentRequest
  userRepository: UserRepository
  profileRepository?: ProfileRepository
  communityRepository: CommunityRepository
}): Promise<Comment> {
  const communityRow = await input.communityRepository.getCommunityById(input.communityId)
  if (!communityRow || communityRow.provisioning_state !== "active" || communityRow.status !== "active") {
    throw eligibilityFailed("Community is not available for commenting")
  }
  const community = await loadCommunityProjection(input.env, input.communityRepository, communityRow)

  assertCreateCommentRequest(input.body)

  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireMemberAccess(db.client, input.communityId, input.userId)
    await requireVerifiedHuman(input.userRepository, input.userId)

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
        async updateProfile() { return null },
        async renameGlobalHandle() { return null },
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
      } catch {}

      return createdComment
    } catch (error) {
      try {
        await tx.rollback()
      } catch {}
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
  userRepository: UserRepository
  communityRepository: CommunityRepository
}): Promise<{ comment_id: string; value: -1 | 1 }> {
  const projection = await input.communityRepository.getCommunityCommentProjectionByCommentId(input.commentId)
  if (!projection) {
    throw notFoundError("Comment not found")
  }

  const db = await openCommunityDb(input.env, input.communityRepository, projection.community_id)
  try {
    await requireMemberAccess(db.client, projection.community_id, input.userId)
    await requireVerifiedHuman(input.userRepository, input.userId)
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
      } catch {}
      throw error
    } finally {
      tx.close()
    }
  } finally {
    db.close()
  }
}

function parseCommentLimit(limit: string | null | undefined): number {
  const parsed = Number(limit ?? "")
  if (!Number.isFinite(parsed)) {
    return 25
  }
  return Math.min(100, Math.max(1, Math.trunc(parsed)))
}

function parseCommentSort(sort: string | null | undefined): CommentSort {
  switch ((sort ?? "").trim()) {
    case "new":
    case "old":
    case "top":
    case "best":
      return (sort ?? "best") as CommentSort
    default:
      return "best"
  }
}

export async function listPostComments(input: {
  env: Env
  userId: string
  communityId: string
  threadRootPostId: string
  locale?: string | null
  sort?: string | null
  cursor?: string | null
  limit?: string | null
  communityRepository: CommunityRepository
}): Promise<CommentListResponse> {
  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!community || community.provisioning_state !== "active" || community.status !== "active") {
    throw notFoundError("Community not found")
  }

  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireMemberAccess(db.client, input.communityId, input.userId)
    const post = await getPostById(db.client, input.threadRootPostId)
    if (!post || post.community_id !== input.communityId) {
      throw notFoundError("Post not found")
    }

    const comments = await listTopLevelComments({
      executor: db.client,
      threadRootPostId: input.threadRootPostId,
      viewerUserId: input.userId,
      limit: parseCommentLimit(input.limit),
      sort: parseCommentSort(input.sort),
      cursor: input.cursor ?? null,
    })
    const localizedItems = await localizeCommentItems({
      client: db.client,
      communityId: input.communityId,
      locale: input.locale ?? null,
      items: comments.items,
    })
    const threadSnapshot = await getLatestThreadSnapshotForRead(db.client, input.threadRootPostId)
    return {
      items: localizedItems,
      next_cursor: comments.next_cursor,
      thread_snapshot: threadSnapshot,
    }
  } finally {
    db.close()
  }
}

export async function listPublicPostComments(input: {
  env: Env
  threadRootPostId: string
  locale?: string | null
  sort?: string | null
  cursor?: string | null
  limit?: string | null
  communityRepository: CommunityRepository
}): Promise<CommentListResponse> {
  const projection = await input.communityRepository.getCommunityPostProjectionByPostId(input.threadRootPostId)
  if (!projection) {
    throw notFoundError("Post not found")
  }

  const community = await input.communityRepository.getCommunityById(projection.community_id)
  if (!community || community.provisioning_state !== "active" || community.status !== "active") {
    throw notFoundError("Community not found")
  }

  const db = await openCommunityDb(input.env, input.communityRepository, projection.community_id)
  try {
    const post = await getPostById(db.client, input.threadRootPostId)
    if (!post || post.community_id !== projection.community_id || !isPubliclyReadableThreadRoot(post)) {
      throw notFoundError("Post not found")
    }

    const comments = await listTopLevelComments({
      executor: db.client,
      threadRootPostId: input.threadRootPostId,
      viewerUserId: "",
      limit: parseCommentLimit(input.limit),
      sort: parseCommentSort(input.sort),
      cursor: input.cursor ?? null,
    })
    const localizedItems = await localizeCommentItems({
      client: db.client,
      communityId: projection.community_id,
      locale: input.locale ?? null,
      items: comments.items,
    })
    const threadSnapshot = await getLatestThreadSnapshotForRead(db.client, input.threadRootPostId)
    return {
      items: localizedItems,
      next_cursor: comments.next_cursor,
      thread_snapshot: threadSnapshot,
    }
  } finally {
    db.close()
  }
}

export async function listCommentReplies(input: {
  env: Env
  userId: string
  commentId: string
  locale?: string | null
  sort?: string | null
  cursor?: string | null
  limit?: string | null
  communityRepository: CommunityRepository
}): Promise<CommentListResponse> {
  const projection = await input.communityRepository.getCommunityCommentProjectionByCommentId(input.commentId)
  if (!projection) {
    throw notFoundError("Comment not found")
  }

  const db = await openCommunityDb(input.env, input.communityRepository, projection.community_id)
  try {
    await requireMemberAccess(db.client, projection.community_id, input.userId)
    const comment = await getCommentById(db.client, input.commentId)
    if (!comment) {
      throw notFoundError("Comment not found")
    }

    const replies = await listReplies({
      executor: db.client,
      parentCommentId: input.commentId,
      viewerUserId: input.userId,
      limit: parseCommentLimit(input.limit),
      sort: parseCommentSort(input.sort),
      cursor: input.cursor ?? null,
    })
    const localizedItems = await localizeCommentItems({
      client: db.client,
      communityId: projection.community_id,
      locale: input.locale ?? null,
      items: replies.items,
    })
    const threadSnapshot = await getLatestThreadSnapshotForRead(db.client, projection.thread_root_post_id)
    return {
      items: localizedItems,
      next_cursor: replies.next_cursor,
      thread_snapshot: threadSnapshot,
    }
  } finally {
    db.close()
  }
}

export async function listPublicCommentReplies(input: {
  env: Env
  commentId: string
  locale?: string | null
  sort?: string | null
  cursor?: string | null
  limit?: string | null
  communityRepository: CommunityRepository
}): Promise<CommentListResponse> {
  const projection = await input.communityRepository.getCommunityCommentProjectionByCommentId(input.commentId)
  if (!projection) {
    throw notFoundError("Comment not found")
  }

  const community = await input.communityRepository.getCommunityById(projection.community_id)
  if (!community || community.provisioning_state !== "active" || community.status !== "active") {
    throw notFoundError("Community not found")
  }

  const db = await openCommunityDb(input.env, input.communityRepository, projection.community_id)
  try {
    const comment = await getCommentById(db.client, input.commentId)
    if (!comment) {
      throw notFoundError("Comment not found")
    }
    const threadRootPost = await getPostById(db.client, projection.thread_root_post_id)
    if (!threadRootPost || threadRootPost.community_id !== projection.community_id || !isPubliclyReadableThreadRoot(threadRootPost)) {
      throw notFoundError("Comment not found")
    }

    const replies = await listReplies({
      executor: db.client,
      parentCommentId: input.commentId,
      viewerUserId: "",
      limit: parseCommentLimit(input.limit),
      sort: parseCommentSort(input.sort),
      cursor: input.cursor ?? null,
    })
    const localizedItems = await localizeCommentItems({
      client: db.client,
      communityId: projection.community_id,
      locale: input.locale ?? null,
      items: replies.items,
    })
    const threadSnapshot = await getLatestThreadSnapshotForRead(db.client, projection.thread_root_post_id)
    return {
      items: localizedItems,
      next_cursor: replies.next_cursor,
      thread_snapshot: threadSnapshot,
    }
  } finally {
    db.close()
  }
}

export async function getCommentContext(input: {
  env: Env
  userId: string
  commentId: string
  locale?: string | null
  cursor?: string | null
  limit?: string | null
  communityRepository: CommunityRepository
}): Promise<CommentContext> {
  const projection = await input.communityRepository.getCommunityCommentProjectionByCommentId(input.commentId)
  if (!projection) {
    throw notFoundError("Comment not found")
  }

  const db = await openCommunityDb(input.env, input.communityRepository, projection.community_id)
  try {
    await requireMemberAccess(db.client, projection.community_id, input.userId)
    const context = await getCommentContextRow({
      executor: db.client,
      commentId: input.commentId,
      viewerUserId: input.userId,
      replyLimit: parseCommentLimit(input.limit),
      replyCursor: input.cursor ?? null,
    })
    if (!context) {
      throw notFoundError("Comment not found")
    }
    const [ancestors, comment, replies] = await Promise.all([
      localizeCommentItems({
        client: db.client,
        communityId: projection.community_id,
        locale: input.locale ?? null,
        items: context.ancestors,
      }),
      buildLocalizedCommentListItem({
        executor: db.client,
        item: context.comment,
        locale: input.locale ?? null,
      }),
      localizeCommentItems({
        client: db.client,
        communityId: projection.community_id,
        locale: input.locale ?? null,
        items: context.replies,
      }),
    ])
    await enqueueCommentTranslationOnReadIfNeeded({
      client: db.client,
      communityId: projection.community_id,
      item: comment,
    })
    const threadSnapshot = await getLatestThreadSnapshotForRead(db.client, projection.thread_root_post_id)
    return {
      ancestors,
      comment,
      replies,
      next_replies_cursor: context.next_replies_cursor,
      thread_snapshot: threadSnapshot,
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
  communityRepository: CommunityRepository
}): Promise<Comment> {
  const projection = await input.communityRepository.getCommunityCommentProjectionByCommentId(input.commentId)
  if (!projection) {
    throw notFoundError("Comment not found")
  }

  const db = await openCommunityDb(input.env, input.communityRepository, projection.community_id)
  try {
    const membership = await requireMemberAccess(db.client, projection.community_id, input.userId)
    await requireVerifiedHuman(input.userRepository, input.userId)

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
      } catch {}
      throw error
    } finally {
      tx.close()
    }
  } finally {
    db.close()
  }
}
