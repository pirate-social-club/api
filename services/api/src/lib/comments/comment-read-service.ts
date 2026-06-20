import { openCommunityWriteClient } from "../communities/community-read-access"
import { isCommunityLive } from "../communities/community-status"
import type { Client } from "../sql-client"
import type {
  CommunityCommentProjectionRepository,
  CommunityDatabaseBindingRepository,
  CommunityPostProjectionRepository,
  CommunityReadRepository,
} from "../communities/db-community-repository"
import { buildLocalizedCommentListItem } from "../localization/comment-localization-service"
import {
  canAccessCommunity,
  getCommunityMembershipState,
} from "../communities/membership/membership-state-store"
import { notFoundError } from "../errors"
import { getPostById } from "../posts/community-post-query-store"
import type { Env } from "../../env"
import type { CommentContext, CommentListResponse, CommentSort } from "./comment-types"
import {
  getCommentById,
  getCommentContext as getCommentContextRow,
  getLatestThreadSnapshotForRead,
  listReplies,
  listTopLevelComments,
} from "./community-comment-store"
import {
  enqueueCommentTranslationOnReadIfNeeded,
  localizeCommentItems,
} from "./comment-translation-jobs"

type CommentReadCommunityRepository =
  & CommunityReadRepository
  & CommunityDatabaseBindingRepository
  & Pick<CommunityPostProjectionRepository, "getCommunityPostProjectionByPostId">
  & Pick<CommunityCommentProjectionRepository, "getCommunityCommentProjectionByCommentId">

function isPubliclyReadableThreadRoot(input: {
  status: "draft" | "published" | "hidden" | "removed" | "deleted"
  visibility: "public" | "members_only"
}): boolean {
  return input.status === "published" && input.visibility === "public"
}

async function requireReadableMember(client: Parameters<typeof getCommunityMembershipState>[0], communityId: string, userId: string): Promise<void> {
  const membership = await getCommunityMembershipState(client, communityId, userId)
  if (!canAccessCommunity(membership)) {
    throw notFoundError("Community not found")
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
  communityRepository: CommentReadCommunityRepository
}): Promise<CommentListResponse> {
  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!isCommunityLive(community)) {
    throw notFoundError("Community not found")
  }

  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    await requireReadableMember(db.client, input.communityId, input.userId)
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
  communityRepository: CommentReadCommunityRepository
}): Promise<CommentListResponse> {
  const projection = await input.communityRepository.getCommunityPostProjectionByPostId(input.threadRootPostId)
  if (!projection) {
    throw notFoundError("Post not found")
  }

  const community = await input.communityRepository.getCommunityById(projection.community_id)
  if (!isCommunityLive(community)) {
    throw notFoundError("Community not found")
  }

  const db = await openCommunityWriteClient(input.env, input.communityRepository, projection.community_id)
  try {
    const post = await getPostById(db.client, input.threadRootPostId)
    if (!post || post.community_id !== projection.community_id || !isPubliclyReadableThreadRoot(post)) {
      throw notFoundError("Post not found")
    }
    return await listPublicPostCommentsFromCommunityDb({
      client: db.client,
      communityId: projection.community_id,
      cursor: input.cursor,
      limit: input.limit,
      locale: input.locale,
      sort: input.sort,
      threadRootPostId: input.threadRootPostId,
    })
  } finally {
    db.close()
  }
}

export async function listPublicPostCommentsFromCommunityDb(input: {
  client: Client
  communityId: string
  threadRootPostId: string
  locale?: string | null
  sort?: string | null
  cursor?: string | null
  limit?: string | null
}): Promise<CommentListResponse> {
  const comments = await listTopLevelComments({
    executor: input.client,
    threadRootPostId: input.threadRootPostId,
    viewerUserId: "",
    limit: parseCommentLimit(input.limit),
    sort: parseCommentSort(input.sort),
    cursor: input.cursor ?? null,
  })
  const localizedItems = await localizeCommentItems({
    client: input.client,
    communityId: input.communityId,
    locale: input.locale ?? null,
    items: comments.items,
  })
  const threadSnapshot = await getLatestThreadSnapshotForRead(input.client, input.threadRootPostId)
  return {
    items: localizedItems,
    next_cursor: comments.next_cursor,
    thread_snapshot: threadSnapshot,
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
  communityRepository: CommentReadCommunityRepository
}): Promise<CommentListResponse> {
  const projection = await input.communityRepository.getCommunityCommentProjectionByCommentId(input.commentId)
  if (!projection) {
    throw notFoundError("Comment not found")
  }

  const db = await openCommunityWriteClient(input.env, input.communityRepository, projection.community_id)
  try {
    await requireReadableMember(db.client, projection.community_id, input.userId)
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
  communityRepository: CommentReadCommunityRepository
}): Promise<CommentListResponse> {
  const projection = await input.communityRepository.getCommunityCommentProjectionByCommentId(input.commentId)
  if (!projection) {
    throw notFoundError("Comment not found")
  }

  const community = await input.communityRepository.getCommunityById(projection.community_id)
  if (!isCommunityLive(community)) {
    throw notFoundError("Community not found")
  }

  const db = await openCommunityWriteClient(input.env, input.communityRepository, projection.community_id)
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
  communityRepository: CommentReadCommunityRepository
}): Promise<CommentContext> {
  const projection = await input.communityRepository.getCommunityCommentProjectionByCommentId(input.commentId)
  if (!projection) {
    throw notFoundError("Comment not found")
  }

  const db = await openCommunityWriteClient(input.env, input.communityRepository, projection.community_id)
  try {
    await requireReadableMember(db.client, projection.community_id, input.userId)
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
