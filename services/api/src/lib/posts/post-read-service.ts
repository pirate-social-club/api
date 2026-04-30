import { openCommunityDb } from "../communities/community-db-factory"
import type {
  CommunityDatabaseBindingRepository,
  CommunityPostProjectionRepository,
  CommunityReadRepository,
} from "../communities/db-community-repository"
import {
  getPostById,
  getPostReadMetrics,
  listPublishedLocalizedPosts,
} from "./community-post-store"
import { getLatestThreadSnapshotForRead } from "../comments/community-comment-store"
import { buildLocalizedPostResponse } from "../localization/post-localization-service"
import { notFoundError } from "../errors"
import {
  canReadNonPublishedPost,
  isPubliclyReadablePost,
  requireMemberAccess,
} from "./post-access"
import { enqueueEmbedHydrateOnReadIfNeeded, enqueuePostTranslationOnReadIfNeeded } from "./post-jobs"
import type { Env } from "../../env"
import type { LocalizedPostResponse } from "../../types"

type CommunityFeedResponse = {
  items: LocalizedPostResponse[]
  next_cursor: string | null
}

type PostFeedSort = "best" | "new" | "top"

type PostReadCommunityRepository =
  & CommunityReadRepository
  & CommunityDatabaseBindingRepository
  & Pick<CommunityPostProjectionRepository, "getCommunityPostProjectionByPostId">

function parseFeedLimit(limit: string | null | undefined): number {
  if (typeof limit !== "string" || limit.trim() === "") {
    return 25
  }

  const parsed = Number(limit)
  if (!Number.isFinite(parsed)) {
    return 25
  }
  return Math.min(100, Math.max(1, Math.trunc(parsed)))
}

function parseFeedCursor(cursor: string | null | undefined): string | null {
  return typeof cursor === "string" && cursor.trim() ? cursor : null
}

function formatFeedCursor(cursor: string | null): string | null {
  return cursor ?? null
}

function parsePostFeedSort(sort: string | null | undefined): PostFeedSort {
  return sort === "new" || sort === "top" ? sort : "best"
}

export async function getPost(input: {
  env: Env
  userId: string
  postId: string
  locale?: string | null
  communityRepository: PostReadCommunityRepository
}): Promise<LocalizedPostResponse> {
  const projection = await input.communityRepository.getCommunityPostProjectionByPostId(input.postId)
  if (!projection) {
    throw notFoundError("Post not found")
  }

  const db = await openCommunityDb(input.env, input.communityRepository, projection.community_id)
  try {
    const membership = await requireMemberAccess(db.client, projection.community_id, input.userId)
    const post = await getPostById(db.client, input.postId)
    if (!post) {
      throw notFoundError("Post not found")
    }
    if (post.status !== "published" && !canReadNonPublishedPost(post, membership, input.userId)) {
      throw notFoundError("Post not found")
    }
    const threadSnapshot = await getLatestThreadSnapshotForRead(db.client, post.post_id)
    const metrics = await getPostReadMetrics({
      executor: db.client,
      postId: post.post_id,
      viewerUserId: input.userId,
    })
    const response = await buildLocalizedPostResponse({
      executor: db.client,
      post,
      locale: input.locale ?? undefined,
      metrics,
      threadSnapshot,
    })
    await enqueuePostTranslationOnReadIfNeeded({
      client: db.client,
      communityId: projection.community_id,
      response,
    })
    await enqueueEmbedHydrateOnReadIfNeeded({
      client: db.client,
      communityId: projection.community_id,
      post,
    })
    return response
  } finally {
    db.close()
  }
}

export async function getPublicPost(input: {
  env: Env
  postId: string
  locale?: string | null
  communityRepository: PostReadCommunityRepository
}): Promise<LocalizedPostResponse> {
  const projection = await input.communityRepository.getCommunityPostProjectionByPostId(input.postId)
  if (!projection) {
    throw notFoundError("Post not found")
  }

  const community = await input.communityRepository.getCommunityById(projection.community_id)
  if (!community || community.provisioning_state !== "active" || community.status !== "active") {
    throw notFoundError("Post not found")
  }

  const db = await openCommunityDb(input.env, input.communityRepository, projection.community_id)
  try {
    const post = await getPostById(db.client, input.postId)
    if (!post || !isPubliclyReadablePost(post)) {
      throw notFoundError("Post not found")
    }
    const threadSnapshot = await getLatestThreadSnapshotForRead(db.client, post.post_id)
    const metrics = await getPostReadMetrics({
      executor: db.client,
      postId: post.post_id,
      viewerUserId: null,
    })
    const response = await buildLocalizedPostResponse({
      executor: db.client,
      post,
      locale: input.locale ?? undefined,
      metrics,
      threadSnapshot,
    })
    await enqueuePostTranslationOnReadIfNeeded({
      client: db.client,
      communityId: projection.community_id,
      response,
    })
    await enqueueEmbedHydrateOnReadIfNeeded({
      client: db.client,
      communityId: projection.community_id,
      post,
    })
    return response
  } finally {
    db.close()
  }
}

export async function listCommunityPosts(input: {
  env: Env
  userId: string
  communityId: string
  locale?: string | null
  limit?: string | null
  cursor?: string | null
  flairId?: string | null
  sort?: string | null
  communityRepository: PostReadCommunityRepository
}): Promise<CommunityFeedResponse> {
  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!community || community.provisioning_state !== "active" || community.status !== "active") {
    throw notFoundError("Community not found")
  }

  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireMemberAccess(db.client, input.communityId, input.userId)
    const feed = await listPublishedLocalizedPosts({
      client: db.client,
      communityId: input.communityId,
      viewerUserId: input.userId,
      limit: parseFeedLimit(input.limit),
      flairId: input.flairId ?? null,
      sort: parsePostFeedSort(input.sort),
      cursor: parseFeedCursor(input.cursor),
      visibility: null,
    })

    const items = await Promise.all(feed.items.map(async (item) => {
      const threadSnapshot = await getLatestThreadSnapshotForRead(db.client, item.post.post_id)
      return buildLocalizedPostResponse({
        executor: db.client,
        post: item.post,
        locale: input.locale ?? undefined,
        metrics: {
          upvote_count: item.upvote_count,
          downvote_count: item.downvote_count,
          comment_count: item.comment_count,
          like_count: item.like_count,
          viewer_vote: item.viewer_vote,
        },
        threadSnapshot,
      })
    }))
    for (const item of items) {
      await enqueuePostTranslationOnReadIfNeeded({
        client: db.client,
        communityId: input.communityId,
        response: item,
      })
      await enqueueEmbedHydrateOnReadIfNeeded({
        client: db.client,
        communityId: input.communityId,
        post: item.post,
      })
    }

    return {
      items,
      next_cursor: formatFeedCursor(feed.nextCursor),
    }
  } finally {
    db.close()
  }
}

export async function listPublicCommunityPosts(input: {
  env: Env
  communityId: string
  locale?: string | null
  limit?: string | null
  cursor?: string | null
  flairId?: string | null
  sort?: string | null
  communityRepository: PostReadCommunityRepository
}): Promise<CommunityFeedResponse> {
  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!community || community.provisioning_state !== "active" || community.status !== "active") {
    throw notFoundError("Community not found")
  }

  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    const feed = await listPublishedLocalizedPosts({
      client: db.client,
      communityId: input.communityId,
      viewerUserId: "",
      limit: parseFeedLimit(input.limit),
      flairId: input.flairId ?? null,
      sort: parsePostFeedSort(input.sort),
      cursor: parseFeedCursor(input.cursor),
      visibility: "public",
    })

    const items = await Promise.all(feed.items.map(async (item) => {
      const threadSnapshot = await getLatestThreadSnapshotForRead(db.client, item.post.post_id)
      return buildLocalizedPostResponse({
        executor: db.client,
        post: item.post,
        locale: input.locale ?? undefined,
        metrics: {
          upvote_count: item.upvote_count,
          downvote_count: item.downvote_count,
          comment_count: item.comment_count,
          like_count: item.like_count,
          viewer_vote: item.viewer_vote,
        },
        threadSnapshot,
      })
    }))
    for (const item of items) {
      await enqueuePostTranslationOnReadIfNeeded({
        client: db.client,
        communityId: input.communityId,
        response: item,
      })
      await enqueueEmbedHydrateOnReadIfNeeded({
        client: db.client,
        communityId: input.communityId,
        post: item.post,
      })
    }

    return {
      items,
      next_cursor: formatFeedCursor(feed.nextCursor),
    }
  } finally {
    db.close()
  }
}
