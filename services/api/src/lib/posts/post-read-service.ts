import {
  listPublishedLocalizedEventPosts,
  listAuthorPendingLocalizedPosts,
  listPublishedLocalizedPosts,
  type PublishedEventPostStatus,
} from "./community-post-feed"
import { getPostById } from "./community-post-query-store"
import { getLatestThreadSnapshotForRead } from "../comments/community-comment-store"
import { getCommunityPreview } from "../communities/community-preview-service"
import { badRequestError, notFoundError } from "../errors"
import {
  canReadNonPublishedPost,
  isAssetBackedPostMissingAsset,
  isPubliclyReadablePost,
  requireMemberAccess,
  shouldHidePostForMissingAsset,
} from "./post-access"
import { resolveAgeGateViewerState } from "./age-gate-viewer-state"
import {
  buildDeletedPostStubResponse,
  buildLocalizedPostFeedResponses,
  buildLocalizedPostReadResponse,
  enqueuePostReadSideEffects,
  hydrateAndEnqueuePostReadResponses,
} from "./post-read-response"
import {
  openLiveCommunityDbForPostRead,
  openProjectedPostCommunityDb,
  type PostReadCommunityRepository,
} from "./post-read-context"
import { getControlPlaneClient } from "../runtime-deps"
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

function parseHasEventFilter(value: string | null | undefined): boolean {
  return value === "true" || value === "1"
}

function parseEventLimit(limit: string | null | undefined): number {
  if (typeof limit !== "string" || limit.trim() === "") {
    return 20
  }

  const parsed = Number(limit)
  if (!Number.isFinite(parsed)) {
    return 20
  }
  return Math.min(50, Math.max(1, Math.trunc(parsed)))
}

function parseEventUnixSeconds(value: string | null | undefined, fieldName: string): number | null {
  if (typeof value !== "string" || value.trim() === "") {
    return null
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    throw badRequestError(`${fieldName} must be a Unix timestamp`)
  }
  return parsed
}

function parseEventStatus(status: string | null | undefined): PublishedEventPostStatus {
  if (status == null || status.trim() === "") {
    return "scheduled"
  }
  if (status === "scheduled" || status === "canceled" || status === "postponed" || status === "ended" || status === "all") {
    return status
  }
  throw badRequestError("status must be scheduled, canceled, postponed, ended, or all")
}

export async function getPost(input: {
  env: Env
  userId: string
  postId: string
  locale?: string | null
  studyTimezone?: string
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
    if (shouldHidePostForMissingAsset(post)) {
      throw notFoundError("Post not found")
    }
    const ageGateViewerState = await resolveAgeGateViewerState({
      userId: input.userId,
      userRepository: input.userRepository,
      postAgeGatePolicy: post.age_gate_policy,
    })
    const response = await buildLocalizedPostReadResponse({
      client: db.client,
      env: input.env,
      songArtifactExecutor: getControlPlaneClient(input.env),
      post,
      locale: input.locale ?? undefined,
      ageGateViewerState,
      studyTimezone: input.studyTimezone,
      viewerUserId: input.userId,
    })
    response.community = await getCommunityPreview({
      env: input.env,
      userId: input.userId,
      communityId: db.communityId,
      locale: input.locale ?? null,
      communityRepository: input.communityRepository,
    })
    await hydrateAndEnqueuePostReadResponses({
      client: db.client,
      communityId: db.communityId,
      env: input.env,
      responses: [response],
      communityRepository: input.communityRepository,
      profileRepository: input.profileRepository,
      studyTimezone: input.studyTimezone,
      viewerUserId: input.userId,
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
  waitUntil?: ((promise: Promise<void>) => void) | null
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
      songArtifactExecutor: getControlPlaneClient(input.env),
      communityId: db.communityId,
      communityRepository: input.communityRepository,
      profileRepository: input.profileRepository,
      locale: input.locale,
      postId: input.postId,
      env: input.env,
      waitUntil: input.waitUntil,
    })
  } finally {
    db.close()
  }
}

export async function getPublicPostFromCommunityDb(input: {
  client: Client
  songArtifactExecutor?: Client | null
  env?: Env
  communityId: string
  communityRepository?: PostReadCommunityRepository
  profileRepository?: ProfileRepository | null
  postId: string
  locale?: string | null
  waitUntil?: ((promise: Promise<void>) => void) | null
}): Promise<LocalizedPostResponse> {
  const post = await getPostById(input.client, input.postId)
  if (
    !post
    || post.community_id !== input.communityId
    || !isPubliclyReadablePost(post)
    || isAssetBackedPostMissingAsset(post)
  ) {
    throw notFoundError("Post not found")
  }
  const ageGateViewerState = post.age_gate_policy === "18_plus" ? "proof_required" as const : null
  const response = await buildLocalizedPostReadResponse({
    client: input.client,
    env: input.env,
    songArtifactExecutor: input.songArtifactExecutor,
    post,
    locale: input.locale ?? undefined,
    ageGateViewerState,
    viewerUserId: null,
  })
  const canEnqueueInBackground = Boolean(input.waitUntil && input.env && input.communityRepository)
  await hydrateAndEnqueuePostReadResponses({
    client: input.client,
    communityId: input.communityId,
    env: input.env,
    responses: [response],
    communityRepository: input.communityRepository,
    profileRepository: input.profileRepository,
    viewerUserId: null,
    enqueueOnRead: !canEnqueueInBackground,
  })
  if (input.waitUntil && input.env && input.communityRepository) {
    input.waitUntil(enqueuePublicPostReadSideEffects({
      env: input.env,
      communityId: input.communityId,
      communityRepository: input.communityRepository,
      response,
    }))
  }
  return response
}

async function enqueuePublicPostReadSideEffects(input: {
  env: Env
  communityId: string
  communityRepository: PostReadCommunityRepository
  response: LocalizedPostResponse
}): Promise<void> {
  const db = await openLiveCommunityDbForPostRead({
    env: input.env,
    communityRepository: input.communityRepository,
    communityId: input.communityId,
  })
  try {
    await enqueuePostReadSideEffects({
      client: db.client,
      communityId: input.communityId,
      responses: [input.response],
    })
  } finally {
    db.close()
  }
}

export async function listCommunityPosts(input: {
  env: Env
  userId: string
  communityId: string
  locale?: string | null
  studyTimezone?: string
  limit?: string | null
  cursor?: string | null
  flairId?: string | null
  hasEvent?: string | null
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
      hasEvent: parseHasEventFilter(input.hasEvent),
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
      env: input.env,
      songArtifactExecutor: getControlPlaneClient(input.env),
      feedItems: feed.items,
      locale: input.locale,
      studyTimezone: input.studyTimezone,
      viewerUserId: input.userId,
      ageGateState,
    })
    const communityPreview = await getCommunityPreview({
      env: input.env,
      userId: input.userId,
      communityId: input.communityId,
      locale: input.locale ?? null,
      communityRepository: input.communityRepository,
    })
    for (const item of items) {
      item.community = communityPreview
    }
    await hydrateAndEnqueuePostReadResponses({
      client: db.client,
      communityId: input.communityId,
      env: input.env,
      responses: items,
      communityRepository: input.communityRepository,
      profileRepository: input.profileRepository,
      studyTimezone: input.studyTimezone,
      viewerUserId: input.userId,
    })

    return {
      items,
      next_cursor: formatFeedCursor(feed.nextCursor),
    }
  } finally {
    db.close()
  }
}

export async function listPendingCommunityPosts(input: {
  env: Env
  userId: string
  communityId: string
  locale?: string | null
  studyTimezone?: string
  limit?: string | null
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
    const feedItems = await listAuthorPendingLocalizedPosts({
      client: db.client,
      communityId: input.communityId,
      authorUserId: input.userId,
      limit: parseFeedLimit(input.limit),
    })
    const ageGateState = await resolveAgeGateViewerState({
      userId: input.userId,
      userRepository: input.userRepository,
      postAgeGatePolicy: "18_plus",
    })
    const items = await buildLocalizedPostFeedResponses({
      client: db.client,
      env: input.env,
      songArtifactExecutor: getControlPlaneClient(input.env),
      feedItems,
      locale: input.locale,
      studyTimezone: input.studyTimezone,
      viewerUserId: input.userId,
      ageGateState,
    })
    const communityPreview = await getCommunityPreview({
      env: input.env,
      userId: input.userId,
      communityId: input.communityId,
      locale: input.locale ?? null,
      communityRepository: input.communityRepository,
    })
    for (const item of items) {
      item.community = communityPreview
    }
    await hydrateAndEnqueuePostReadResponses({
      client: db.client,
      communityId: input.communityId,
      env: input.env,
      responses: items,
      communityRepository: input.communityRepository,
      profileRepository: input.profileRepository,
    })

    return {
      items,
      next_cursor: null,
    }
  } finally {
    db.close()
  }
}

export async function listCommunityEvents(input: {
  env: Env
  userId: string
  communityId: string
  locale?: string | null
  studyTimezone?: string
  from?: string | null
  to?: string | null
  limit?: string | null
  status?: string | null
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
    const from = parseEventUnixSeconds(input.from, "from") ?? Math.floor(Date.now() / 1000)
    const to = parseEventUnixSeconds(input.to, "to")
    if (to != null && to < from) {
      throw badRequestError("to must be greater than or equal to from")
    }

    const feedItems = await listPublishedLocalizedEventPosts({
      client: db.client,
      communityId: input.communityId,
      viewerUserId: input.userId,
      from,
      to,
      limit: parseEventLimit(input.limit),
      status: parseEventStatus(input.status),
    })

    const ageGateState = await resolveAgeGateViewerState({
      userId: input.userId,
      userRepository: input.userRepository,
      postAgeGatePolicy: "18_plus",
    })
    const items = await buildLocalizedPostFeedResponses({
      client: db.client,
      env: input.env,
      songArtifactExecutor: getControlPlaneClient(input.env),
      feedItems,
      locale: input.locale,
      studyTimezone: input.studyTimezone,
      viewerUserId: input.userId,
      ageGateState,
    })
    await hydrateAndEnqueuePostReadResponses({
      client: db.client,
      communityId: input.communityId,
      env: input.env,
      responses: items,
      communityRepository: input.communityRepository,
      profileRepository: input.profileRepository,
      studyTimezone: input.studyTimezone,
      viewerUserId: input.userId,
    })

    return {
      items,
      next_cursor: null,
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
  hasEvent?: string | null
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
      hasEvent: parseHasEventFilter(input.hasEvent),
      sort: parsePostFeedSort(input.sort),
      cursor: parseFeedCursor(input.cursor),
      visibility: "public",
    })

    const items = await buildLocalizedPostFeedResponses({
      client: db.client,
      env: input.env,
      songArtifactExecutor: getControlPlaneClient(input.env),
      feedItems: feed.items,
      locale: input.locale,
      viewerUserId: null,
      ageGateState: "proof_required",
    })
    await hydrateAndEnqueuePostReadResponses({
      client: db.client,
      communityId: input.communityId,
      env: input.env,
      responses: items,
      communityRepository: input.communityRepository,
      profileRepository: input.profileRepository,
      viewerUserId: null,
    })

    return {
      items,
      next_cursor: formatFeedCursor(feed.nextCursor),
    }
  } finally {
    db.close()
  }
}
