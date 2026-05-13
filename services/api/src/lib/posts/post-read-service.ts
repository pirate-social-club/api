import { openCommunityDb } from "../communities/community-db-factory"
import { isCommunityLive } from "../communities/community-status"
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
import { resolveAgeGateViewerState } from "./age-gate-viewer-state"
import type { UserRepository } from "../auth/repositories"
import type { Client } from "../sql-client"
import type { Env } from "../../env"
import type { CommentThreadSnapshot, LocalizedPostResponse, Post } from "../../types"

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

function buildDeletedPostStubResponse(input: {
  post: Post
  threadSnapshot: CommentThreadSnapshot | null
  viewerUserId?: string | null
}): LocalizedPostResponse {
  const redactedPost: Post = {
    ...input.post,
    author_user_id: null,
    agent_id: null,
    agent_ownership_record_id: null,
    identity_mode: "public",
    anonymous_scope: null,
    anonymous_label: null,
    agent_handle_snapshot: null,
    agent_display_name_snapshot: null,
    agent_owner_handle_snapshot: null,
    agent_ownership_provider_snapshot: null,
    disclosed_qualifiers_json: null,
    label_id: null,
    post_type: "text",
    title: null,
    body: null,
    caption: null,
    lyrics: null,
    link_url: null,
    link_og_image_url: null,
    link_og_title: null,
    link_enrichment_snapshot_json: null,
    link_enrichment_synced_at: null,
    embeds: null,
    media_refs: [],
    creator_relation: null,
    promotion_disclosure: null,
    source_language: null,
    translation_policy: "none",
    access_mode: null,
    asset_id: null,
    song_artifact_bundle_id: null,
    parent_post_id: null,
    song_mode: null,
    rights_basis: null,
    upstream_asset_refs: null,
    analysis_result_ref: null,
    content_safety_state: "safe",
    age_gate_policy: "none",
    label_assignment_status: null,
    label_assigned_by: null,
    label_assigned_at: null,
    label_ai_confidence: null,
    label_assignment_error: null,
    label_assignment_model: null,
    label_assignment_result_json: null,
  }

  return {
    post: redactedPost,
    author_community_role: null,
    thread_snapshot: input.threadSnapshot,
    market_context: null,
    label: null,
    upvote_count: 0,
    downvote_count: 0,
    like_count: 0,
    comment_count: input.threadSnapshot?.comment_count ?? 0,
    viewer_vote: null,
    viewer_is_author: Boolean(input.viewerUserId && input.post.author_user_id === input.viewerUserId),
    viewer_reaction_kinds: [],
    age_gate_viewer_state: null,
    resolved_locale: "en",
    translation_state: "same_language",
    machine_translated: false,
    translated_body: null,
    translated_title: null,
    translated_caption: null,
    translated_embeds: null,
    song_presentation: null,
    source_hash: "",
  }
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
      ageGateViewerState,
      viewerUserId: input.userId,
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
  if (!isCommunityLive(community)) {
    throw notFoundError("Post not found")
  }

  const db = await openCommunityDb(input.env, input.communityRepository, projection.community_id)
  try {
    return await getPublicPostFromCommunityDb({
      client: db.client,
      communityId: projection.community_id,
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
  postId: string
  locale?: string | null
}): Promise<LocalizedPostResponse> {
  const post = await getPostById(input.client, input.postId)
  if (!post || post.community_id !== input.communityId || !isPubliclyReadablePost(post)) {
    throw notFoundError("Post not found")
  }
  const ageGateViewerState = post.age_gate_policy === "18_plus" ? "proof_required" as const : null
  const threadSnapshot = await getLatestThreadSnapshotForRead(input.client, post.post_id)
  const metrics = await getPostReadMetrics({
    executor: input.client,
    postId: post.post_id,
    viewerUserId: null,
  })
  const response = await buildLocalizedPostResponse({
    executor: input.client,
    post,
    locale: input.locale ?? undefined,
    metrics,
    threadSnapshot,
    ageGateViewerState,
    viewerUserId: null,
  })
  await enqueuePostTranslationOnReadIfNeeded({
    client: input.client,
    communityId: input.communityId,
    response,
  })
  await enqueueEmbedHydrateOnReadIfNeeded({
    client: input.client,
    communityId: input.communityId,
    post,
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
}): Promise<CommunityFeedResponse> {
  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!isCommunityLive(community)) {
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

    const ageGateState = await resolveAgeGateViewerState({
      userId: input.userId,
      userRepository: input.userRepository,
      postAgeGatePolicy: "18_plus",
    })
    const items = await Promise.all(feed.items.map(async (item) => {
      const ageGateViewerState = item.post.age_gate_policy === "18_plus" ? ageGateState : null
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
        ageGateViewerState,
        viewerUserId: input.userId,
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
  if (!isCommunityLive(community)) {
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
      const ageGateViewerState = item.post.age_gate_policy === "18_plus" ? "proof_required" as const : null
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
        ageGateViewerState,
        viewerUserId: null,
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
