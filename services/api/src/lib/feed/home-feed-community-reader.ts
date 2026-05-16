import type { DbExecutor } from "../db-helpers"
import { openCommunityDb } from "../communities/community-db-factory"
import type { Client } from "../sql-client"
import { buildLocalizedPostResponse } from "../localization/post-localization-service"
import { hydrateCrosspostSourcesForResponses } from "../posts/crosspost-source-hydration"
import { enqueueEmbedHydrateOnReadIfNeeded, enqueuePostTranslationOnReadIfNeeded } from "../posts/post-jobs"
import { withRequestControlPlaneClients } from "../runtime-deps"
import { numberOrNull, requiredString, rowValue } from "../sql-row"
import { serializeLocalizedPostResponse } from "../../serializers/post"
import { resolveCommunityAvatarRef } from "../communities/community-identity-media"
import {
  POST_SELECT_COLUMNS,
  serializePost,
  toPostRow,
} from "../posts/community-post-serialization"
import {
  serializeThreadSnapshot,
  toThreadSnapshotRow,
} from "../comments/community-comment-serialization"
import type { ProfileRepository } from "../auth/repositories"
import type { AgeGateViewerState } from "../posts/age-gate-viewer-state"
import type {
  HomeFeedCommunityRepository,
  HomeFeedProjectionRow,
  InternalHomeFeedCommunitySummary,
} from "./home-feed-types"
import type {
  CommentThreadSnapshot,
  Env,
  HomeFeedCommunitySummary,
  HomeFeedItem,
  Post,
} from "../../types"

export type HomeFeedWaitUntil = (promise: Promise<void>) => void

type HomeFeedPostReadJob = {
  post: Post
  response: Parameters<typeof enqueuePostTranslationOnReadIfNeeded>[0]["response"]
}

export type HomeFeedCommunityIdentity = {
  displayName: string
  avatarRef: string | null
}

export type HomeFeedCommunityTiming = {
  community_id: string
  rows: number
  returned_items: number
  total_ms: number
  open_ms: number
  identity_ms: number
  posts_ms: number
  snapshots_ms: number
  votes_ms: number
  localize_ms: number
  enqueue_ms: number
}

export type HomeFeedCommunityReadResult = {
  items: HomeFeedItem[]
  identity: HomeFeedCommunityIdentity | null
  timing: HomeFeedCommunityTiming
}

function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt)
}

function placeholders(count: number): string {
  return Array.from({ length: count }, (_, index) => `?${index + 1}`).join(", ")
}

async function listPostsById(client: Client, postIds: string[]): Promise<Map<string, Post>> {
  if (postIds.length === 0) {
    return new Map()
  }

  const result = await client.execute({
    sql: `
      SELECT ${POST_SELECT_COLUMNS}
      FROM posts
      WHERE post_id IN (${placeholders(postIds.length)})
    `,
    args: postIds,
  })

  const postsById = new Map<string, Post>()
  for (const row of result.rows) {
    const post = serializePost(toPostRow(row))
    postsById.set(post.post_id, post)
  }
  return postsById
}

async function listLatestThreadSnapshotsForRead(
  client: Client,
  threadRootPostIds: string[],
): Promise<Map<string, CommentThreadSnapshot | null>> {
  if (threadRootPostIds.length === 0) {
    return new Map()
  }

  const result = await client.execute({
    sql: `
      SELECT thread_snapshot_id, community_id, thread_root_post_id, snapshot_seq,
             published_through_comment_created_at, comment_count, swarm_manifest_ref,
             swarm_feed_ref, created_at
      FROM thread_snapshots
      WHERE thread_root_post_id IN (${placeholders(threadRootPostIds.length)})
      ORDER BY thread_root_post_id ASC, snapshot_seq DESC, created_at DESC
    `,
    args: threadRootPostIds,
  })

  const snapshotsByPostId = new Map<string, CommentThreadSnapshot | null>()
  for (const row of result.rows) {
    const snapshot = toThreadSnapshotRow(row)
    if (!snapshotsByPostId.has(snapshot.thread_root_post_id)) {
      snapshotsByPostId.set(snapshot.thread_root_post_id, serializeThreadSnapshot(snapshot))
    }
  }
  return snapshotsByPostId
}

async function listViewerVotes(input: {
  client: Client
  postIds: string[]
  userId: string | null
}): Promise<Map<string, -1 | 1 | null>> {
  if (!input.userId || input.postIds.length === 0) {
    return new Map()
  }

  const result = await input.client.execute({
    sql: `
      SELECT post_id, vote_value
      FROM post_votes
      WHERE user_id = ?1
        AND post_id IN (${input.postIds.map((_, index) => `?${index + 2}`).join(", ")})
    `,
    args: [input.userId, ...input.postIds],
  })

  const votesByPostId = new Map<string, -1 | 1 | null>()
  for (const row of result.rows) {
    votesByPostId.set(requiredString(row, "post_id"), numberOrNull(rowValue(row, "vote_value")) as -1 | 1 | null)
  }
  return votesByPostId
}

async function enqueuePostReadJobsForCommunity(input: {
  client: DbExecutor
  communityId: string
  jobs: HomeFeedPostReadJob[]
}): Promise<void> {
  for (const job of input.jobs) {
    await enqueuePostTranslationOnReadIfNeeded({
      client: input.client,
      communityId: input.communityId,
      response: job.response,
    })
    await enqueueEmbedHydrateOnReadIfNeeded({
      client: input.client,
      communityId: input.communityId,
      post: job.post,
    })
  }
}

function enqueuePostReadJobs(input: {
  env: Env
  communityId: string
  communityRepository: HomeFeedCommunityRepository
  jobs: HomeFeedPostReadJob[]
  waitUntil?: HomeFeedWaitUntil
  fallbackClient: DbExecutor
}): Promise<void> {
  if (input.jobs.length === 0) {
    return Promise.resolve()
  }

  if (!input.waitUntil) {
    return enqueuePostReadJobsForCommunity({
      client: input.fallbackClient,
      communityId: input.communityId,
      jobs: input.jobs,
    })
  }

  input.waitUntil(withRequestControlPlaneClients(async () => {
    const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
    try {
      await enqueuePostReadJobsForCommunity({
        client: db.client,
        communityId: input.communityId,
        jobs: input.jobs,
      })
    } finally {
      db.close()
    }
  }).catch((error: unknown) => {
    console.error("[home-feed] deferred post read job enqueue failed", {
      communityId: input.communityId,
      error,
    })
  }))

  return Promise.resolve()
}

export function serializeHomeFeedCommunitySummary(summary: InternalHomeFeedCommunitySummary): HomeFeedCommunitySummary {
  return {
    id: summary.id,
    object: summary.object,
    display_name: summary.display_name,
    route_slug: summary.route_slug,
    avatar_ref: summary.avatar_ref,
    member_count: summary.member_count,
    follower_count: summary.follower_count,
    view_count: summary.view_count,
  }
}

export async function getHomeFeedCommunityIdentity(
  client: Client,
  communityId: string,
): Promise<HomeFeedCommunityIdentity | null> {
  const result = await client.execute({
    sql: `
      SELECT display_name, avatar_ref
      FROM communities
      WHERE community_id = ?1
      LIMIT 1
    `,
    args: [communityId],
  })
  const row = result.rows[0]
  if (!row) {
    return null
  }
  return {
    displayName: String(row.display_name),
    avatarRef: row.avatar_ref == null ? null : String(row.avatar_ref),
  }
}

export function withHomeFeedCommunityIdentity(
  summary: InternalHomeFeedCommunitySummary,
  identity: HomeFeedCommunityIdentity | null,
): InternalHomeFeedCommunitySummary {
  const displayName = identity?.displayName ?? summary.display_name
  return {
    ...summary,
    display_name: displayName,
    avatar_ref: resolveCommunityAvatarRef({
      communityId: summary.community_id,
      displayName,
      avatarRef: identity?.avatarRef,
    }),
  }
}

export async function resolveTopCommunitiesIdentity(input: {
  env: Env
  communityRepository: HomeFeedCommunityRepository
  summaries: InternalHomeFeedCommunitySummary[]
  cachedIdentityByCommunityId?: Map<string, HomeFeedCommunityIdentity | null>
}): Promise<InternalHomeFeedCommunitySummary[]> {
  return Promise.all(input.summaries.map(async (summary) => {
    if (input.cachedIdentityByCommunityId?.has(summary.community_id)) {
      return withHomeFeedCommunityIdentity(
        summary,
        input.cachedIdentityByCommunityId.get(summary.community_id) ?? null,
      )
    }
    const db = await openCommunityDb(input.env, input.communityRepository, summary.community_id).catch(() => null)
    if (!db) {
      return withHomeFeedCommunityIdentity(summary, null)
    }
    try {
      const identity = await getHomeFeedCommunityIdentity(db.client, summary.community_id)
      return withHomeFeedCommunityIdentity(summary, identity)
    } finally {
      db.close()
    }
  }))
}

export async function readHomeFeedCommunityItems(input: {
  env: Env
  communityId: string
  rows: HomeFeedProjectionRow[]
  baseCommunity: InternalHomeFeedCommunitySummary | undefined
  memberCommunityIdSet: Set<string>
  communityRepository: HomeFeedCommunityRepository
  profileRepository?: ProfileRepository | null
  userId: string | null
  locale?: string | null
  ageGateState: AgeGateViewerState | null
  waitUntil?: HomeFeedWaitUntil
}): Promise<HomeFeedCommunityReadResult> {
  const communityStartedAt = performance.now()
  const openStartedAt = performance.now()
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  const openMs = elapsedMs(openStartedAt)
  try {
    const identityStartedAt = performance.now()
    const identity = await getHomeFeedCommunityIdentity(db.client, input.communityId)
    const identityMs = elapsedMs(identityStartedAt)
    const community = input.baseCommunity
      ? withHomeFeedCommunityIdentity(input.baseCommunity, identity)
      : null
    const communityItems: HomeFeedItem[] = []
    const postsStartedAt = performance.now()
    const postsById = await listPostsById(db.client, input.rows.map((row) => row.source_post_id))
    const postsMs = elapsedMs(postsStartedAt)
    const publishedRows = input.rows.filter((row) => {
      const post = postsById.get(row.source_post_id)
      return post
        && post.status === "published"
        && (post.visibility !== "members_only" || input.memberCommunityIdSet.has(input.communityId))
    })
    const publishedPostIds = publishedRows.map((row) => row.source_post_id)
    const snapshotsStartedAt = performance.now()
    const threadSnapshotsByPostId = await listLatestThreadSnapshotsForRead(db.client, publishedPostIds)
    const snapshotsMs = elapsedMs(snapshotsStartedAt)
    const votesStartedAt = performance.now()
    const viewerVotesByPostId = await listViewerVotes({
      client: db.client,
      postIds: publishedPostIds,
      userId: input.userId,
    })
    const votesMs = elapsedMs(votesStartedAt)
    const postReadJobs: HomeFeedPostReadJob[] = []
    let localizeMs = 0
    for (const row of input.rows) {
      const post = postsById.get(row.source_post_id) ?? null
      if (!post || post.status !== "published") {
        continue
      }
      if (post.visibility === "members_only" && !input.memberCommunityIdSet.has(input.communityId)) {
        continue
      }
      const threadSnapshot = threadSnapshotsByPostId.get(post.post_id) ?? null
      const viewerVote = viewerVotesByPostId.get(post.post_id) ?? null
      const localizeStartedAt = performance.now()
      const response = await buildLocalizedPostResponse({
        executor: db.client,
        post,
        locale: input.locale ?? undefined,
        threadSnapshot,
        metrics: {
          upvote_count: row.upvote_count,
          downvote_count: row.downvote_count,
          comment_count: row.comment_count,
          like_count: row.like_count,
          viewer_vote: viewerVote,
        },
        ageGateViewerState: post.age_gate_policy === "18_plus" ? input.ageGateState ?? "proof_required" : null,
        viewerUserId: input.userId,
      })
      localizeMs += elapsedMs(localizeStartedAt)
      postReadJobs.push({ post, response })
    }
    await hydrateCrosspostSourcesForResponses({
      responses: postReadJobs.map((job) => job.response),
      communityRepository: input.communityRepository,
      profileRepository: input.profileRepository,
    })
    if (community) {
      const communitySummary = serializeHomeFeedCommunitySummary(community)
      for (const job of postReadJobs) {
        communityItems.push({
          community: communitySummary,
          post: serializeLocalizedPostResponse(job.response, { surface: "home_feed" }),
        })
      }
    }
    const enqueueStartedAt = performance.now()
    await enqueuePostReadJobs({
      env: input.env,
      communityId: input.communityId,
      communityRepository: input.communityRepository,
      jobs: postReadJobs,
      waitUntil: input.waitUntil,
      fallbackClient: db.client,
    })
    const enqueueMs = elapsedMs(enqueueStartedAt)
    return {
      items: communityItems,
      identity,
      timing: {
        community_id: input.communityId,
        rows: input.rows.length,
        returned_items: communityItems.length,
        total_ms: elapsedMs(communityStartedAt),
        open_ms: openMs,
        identity_ms: identityMs,
        posts_ms: postsMs,
        snapshots_ms: snapshotsMs,
        votes_ms: votesMs,
        localize_ms: localizeMs,
        enqueue_ms: enqueueMs,
      },
    }
  } finally {
    db.close()
  }
}
