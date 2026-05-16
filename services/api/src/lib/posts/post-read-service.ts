import {
  listPublishedLocalizedPosts,
} from "./community-post-feed"
import { getPostById } from "./community-post-query-store"
import { getLatestThreadSnapshotForRead } from "../comments/community-comment-store"
import { notFoundError } from "../errors"
import {
  canReadNonPublishedPost,
  isPubliclyReadablePost,
  requireMemberAccess,
} from "./post-access"
import { resolveAgeGateViewerState } from "./age-gate-viewer-state"
import {
  buildDeletedPostStubResponse,
  buildLocalizedPostFeedResponses,
  buildLocalizedPostReadResponse,
  hydrateAndEnqueuePostReadResponses,
} from "./post-read-response"
import {
  openLiveCommunityDbForPostRead,
  openProjectedPostCommunityDb,
  type PostReadCommunityRepository,
} from "./post-read-context"
import type { ProfileRepository, UserRepository } from "../auth/repositories"
import type { Client } from "../sql-client"
import type { Env } from "../../env"
import type { LocalizedPostResponse } from "../../types"

type CommunityFeedResponse = {
  items: LocalizedPostResponse[]
  next_cursor: string | null
}

type PostFeedSort = "best" | "new" | "top"

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
  userRepository: UserRepository
  profileRepository?: ProfileRepository | null
}): Promise<LocalizedPostResponse> {
  const db = await openProjectedPostCommunityDb({
    env: input.env,
    communityRepository: input.communityRepository,
    postId: input.postId,
  })
  try {
    const membership = await requireMemberAccess(db.client, db.communityId, input.userId)
    const post = await getPostById(db.client, input.postId)
    if (!post) {
      throw notFoundError("Post not found")
    }
    const threadSnapshot = await getLatestThreadSnapshotForRead(db.client, post.post_id)
    if (post.status === "deleted") {
      return buildDeletedPostStubResponse({ post, threadSnapshot, viewerUserId: input.userId })
    }
    if (post.status !== "published" && !canReadNonPublishedPost(post, membership, input.userId)) {
      throw notFoundError("Post not found")
    }
    const ageGateViewerState = await resolveAgeGateViewerState({
      userId: input.userId,
      userRepository: input.userRepository,
      postAgeGatePolicy: post.age_gate_policy,
    })
    const response = await buildLocalizedPostReadResponse({
      client: db.client,
      post,
      locale: input.locale ?? undefined,
      ageGateViewerState,
      viewerUserId: input.userId,
    })
    await hydrateAndEnqueuePostReadResponses({
      client: db.client,
      communityId: db.communityId,
      responses: [response],
      communityRepository: input.communityRepository,
      profileRepository: input.profileRepository,
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
  profileRepository?: ProfileRepository | null
}): Promise<LocalizedPostResponse> {
  const db = await openProjectedPostCommunityDb({
    env: input.env,
    communityRepository: input.communityRepository,
    postId: input.postId,
    requireLiveCommunity: true,
  })
  try {
    return await getPublicPostFromCommunityDb({
      client: db.client,
      communityId: db.communityId,
      communityRepository: input.communityRepository,
      profileRepository: input.profileRepository,
      locale: input.locale,
      postId: input.postId,
    })
  } finally {
    db.close()
  }
}

export async function getPublicPostFromCommunityDb(input: {
  client: Client
  communityId: string
  communityRepository?: PostReadCommunityRepository
  profileRepository?: ProfileRepository | null
  postId: string
  locale?: string | null
}): Promise<LocalizedPostResponse> {
  const post = await getPostById(input.client, input.postId)
  if (!post || post.community_id !== input.communityId || !isPubliclyReadablePost(post)) {
    throw notFoundError("Post not found")
  }
  const ageGateViewerState = post.age_gate_policy === "18_plus" ? "proof_required" as const : null
  const response = await buildLocalizedPostReadResponse({
    client: input.client,
    post,
    locale: input.locale ?? undefined,
    ageGateViewerState,
    viewerUserId: null,
  })
  await hydrateAndEnqueuePostReadResponses({
    client: input.client,
    communityId: input.communityId,
    responses: [response],
    communityRepository: input.communityRepository,
    profileRepository: input.profileRepository,
  })
  return response
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
  userRepository: UserRepository
  profileRepository?: ProfileRepository | null
}): Promise<CommunityFeedResponse> {
  const db = await openLiveCommunityDbForPostRead({
    env: input.env,
    communityRepository: input.communityRepository,
    communityId: input.communityId,
  })
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

    const ageGateState = await resolveAgeGateViewerState({
      userId: input.userId,
      userRepository: input.userRepository,
      postAgeGatePolicy: "18_plus",
    })
    const items = await buildLocalizedPostFeedResponses({
      client: db.client,
      feedItems: feed.items,
      locale: input.locale,
      viewerUserId: input.userId,
      ageGateState,
    })
    await hydrateAndEnqueuePostReadResponses({
      client: db.client,
      communityId: input.communityId,
      responses: items,
      communityRepository: input.communityRepository,
      profileRepository: input.profileRepository,
    })

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
  profileRepository?: ProfileRepository | null
}): Promise<CommunityFeedResponse> {
  const db = await openLiveCommunityDbForPostRead({
    env: input.env,
    communityRepository: input.communityRepository,
    communityId: input.communityId,
  })
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

    const items = await buildLocalizedPostFeedResponses({
      client: db.client,
      feedItems: feed.items,
      locale: input.locale,
      viewerUserId: null,
      ageGateState: "proof_required",
    })
    await hydrateAndEnqueuePostReadResponses({
      client: db.client,
      communityId: input.communityId,
      responses: items,
      communityRepository: input.communityRepository,
      profileRepository: input.profileRepository,
    })

    return {
      items,
      next_cursor: formatFeedCursor(feed.nextCursor),
    }
  } finally {
    db.close()
  }
}
