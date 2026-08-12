import type { DbExecutor } from "../db-helpers"
import { createCoalescingReadClient } from "../coalescing-read-client"
import {
  bulkCommunityRead,
  openCommunityReadClient,
  openCommunityWriteClient,
} from "../communities/community-read-access"
import type { ReadClient } from "../sql-client"
import {
  buildMembershipGateExpressionFromPolicy,
  buildMembershipGateSummariesFromPolicy,
  getGatePolicyMatchMode,
} from "../communities/membership/gates"
import {
  canAccessCommunity,
  getCommunityMembershipState,
} from "../communities/membership/membership-state-store"
import { getMembershipGatePolicy } from "../communities/membership/gate-policy-store"
import { listCommunityLabels } from "../communities/community-label-store"
import {
  buildLocalizedPostResponse,
  listPublicSongArtifactPresentations,
} from "../localization/post-localization-service"
import { DEFAULT_CONTENT_LOCALE, normalizeContentLocale } from "../localization/content-locale"
import { contentTranslationLookupKey, listContentTranslationsForContentIds } from "../localization/content-translation-store"
import { hydrateCrosspostSourcesForResponses } from "../posts/crosspost-source-hydration"
import {
  hydrateDerivativeSourcesForResponses,
  type DerivativeSourceHydrationTiming,
} from "../posts/upstream-source-hydration"
import { enqueueEmbedHydrateOnReadIfNeeded, enqueuePostTranslationOnReadIfNeeded } from "../posts/post-jobs"
import { createStudyElevenLabsCredentialResolver, hydrateAuthorPublicHandlesForResponses, hydrateSongStreakSummariesForResponses } from "../posts/post-read-response"
import { getControlPlaneClient, withBackgroundControlPlaneClients } from "../runtime-deps"
import { numberOrNull, requiredString, rowValue } from "../sql-row"
import { serializeLocalizedPostResponse } from "../../serializers/post"
import { publicCommunityId } from "../public-ids"
import {
  postAssetStoryJoinForSchema,
  postProjectionSchemaFromResults,
  postProjectionSchemaReadStatements,
  postSelectColumnsForSchema,
  type PostProjectionSchema,
} from "../posts/community-post-projection"
import { resolveCommunityAvatarRef } from "../communities/community-identity-media"
import {
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
  LocalizedPostResponse,
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

type PostViewerGateState = NonNullable<LocalizedPostResponse["viewer_gate_state"]>

export type HomeFeedCommunityTiming = {
  community_id: string
  rows: number
  returned_items: number
  total_ms: number
  open_ms: number
  identity_ms: number
  batched_reads_ms: number
  localize_ms: number
  crosspost_ms: number
  author_handles_ms: number
  streaks_ms: number
  derivatives_ms: number
  derivative_local_rows_ms: number
  derivative_global_rows_ms: number
  derivative_profiles_ms: number
  derivative_profiles_degraded: boolean
  serialize_ms: number
  enqueue_ms: number
  unaccounted_ms: number
}

export type HomeFeedCommunityReadResult = {
  items: HomeFeedItem[]
  identity: HomeFeedCommunityIdentity | null
  timing: HomeFeedCommunityTiming
}

export type HomeFeedCommunityPrefetch = {
  identity: HomeFeedCommunityIdentity | null
  karaokeEnabled: boolean
  postProjectionSchema: PostProjectionSchema
  studyEnabled: boolean
}

export type HomeFeedCommunityPrefetchResult = {
  communities: Map<string, HomeFeedCommunityPrefetch>
  operationCount: number
  shardGroupCount: number
}

function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt)
}

export function homeFeedVideoDerivativeResponses(
  responses: LocalizedPostResponse[],
): LocalizedPostResponse[] {
  return responses.filter((response) =>
    response.post.post_type === "video"
    && (response.post.upstream_asset_refs?.length ?? 0) > 0
  )
}

function placeholders(count: number): string {
  return Array.from({ length: count }, (_, index) => `?${index + 1}`).join(", ")
}

async function listPostsById(
  client: ReadClient,
  postIds: string[],
  projectionSchema: PostProjectionSchema,
): Promise<Map<string, Post>> {
  if (postIds.length === 0) {
    return new Map()
  }

  const result = await client.execute({
    sql: `
      SELECT ${postSelectColumnsForSchema(projectionSchema)}
      FROM posts
      ${postAssetStoryJoinForSchema(projectionSchema)}
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

/**
 * Inspect transitional post schemas and load stable community settings before
 * hydration. Grouping these operations uses one shard RPC instead of the old
 * sequence of schema and policy reads for every community slice.
 */
export async function prefetchHomeFeedCommunities(input: {
  communityIds: string[]
  communityRepository: HomeFeedCommunityRepository
  env: Env
}): Promise<HomeFeedCommunityPrefetchResult> {
  const uniqueCommunityIds = [...new Set(input.communityIds)]
  const schemaStatements = postProjectionSchemaReadStatements()
  let operationCount = 0
  let shardGroupCount = 0
  const resultsByCommunityId = await bulkCommunityRead(
    input.env,
    input.communityRepository,
    uniqueCommunityIds.map((communityId) => ({
      communityId,
      statements: [
        ...schemaStatements,
        {
          sql: `
            SELECT display_name, avatar_ref, karaoke_enabled, study_enabled
            FROM communities
            WHERE community_id = ?1
            LIMIT 1
          `,
          args: [communityId],
        },
      ],
    })),
    (observedOperationCount, observedShardGroupCount) => {
      operationCount = observedOperationCount
      shardGroupCount = observedShardGroupCount
    },
  )

  const prefetched = new Map<string, HomeFeedCommunityPrefetch>()
  for (const communityId of uniqueCommunityIds) {
    const results = resultsByCommunityId.get(communityId)
    if (!results || results.length !== schemaStatements.length + 1) {
      throw new Error(`Home feed prefetch results are incomplete for ${communityId}`)
    }
    const identityRow = results[schemaStatements.length]?.rows[0]
    prefetched.set(communityId, {
      identity: identityRow
        ? {
            displayName: String(identityRow.display_name),
            avatarRef: identityRow.avatar_ref == null ? null : String(identityRow.avatar_ref),
          }
        : null,
      karaokeEnabled: Number(identityRow?.karaoke_enabled ?? 0) === 1,
      postProjectionSchema: postProjectionSchemaFromResults(results.slice(0, schemaStatements.length)),
      studyEnabled: Number(identityRow?.study_enabled ?? 0) === 1,
    })
  }
  return {
    communities: prefetched,
    operationCount,
    shardGroupCount,
  }
}

const HOME_FEED_COMMUNITY_PHASES = [
  "total",
  "open",
  "batched_reads",
  "localize",
  "streaks",
  "derivatives",
  "unaccounted",
] as const

export function summarizeHomeFeedCommunityPhaseTimings(
  timings: HomeFeedCommunityTiming[],
): Record<string, number> {
  const summary: Record<string, number> = {}
  for (const phase of HOME_FEED_COMMUNITY_PHASES) {
    const values = timings.map((timing) => timing[`${phase}_ms`])
    summary[`community_${phase}_sum_ms`] = values.reduce((total, value) => total + value, 0)
    summary[`community_${phase}_max_ms`] = values.length > 0 ? Math.max(...values) : 0
  }
  return summary
}

async function listLatestThreadSnapshotsForRead(
  client: ReadClient,
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
  client: ReadClient
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

  input.waitUntil(withBackgroundControlPlaneClients(async () => {
    const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
    try {
      await enqueuePostReadJobsForCommunity({
        client: db.client,
        communityId: input.communityId,
        jobs: input.jobs,
      })
    } finally {
      await db.close()
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
    branding: summary.branding,
    default_surface: summary.default_surface,
    video_feed_enabled: summary.video_feed_enabled,
    member_count: summary.member_count,
    follower_count: summary.follower_count,
    view_count: summary.view_count,
  }
}

async function getHomeFeedCommunityIdentity(
  client: DbExecutor,
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

async function getHomeFeedViewerGateState(input: {
  client: ReadClient
  communityId: string
  displayName: string
  userId: string | null
}): Promise<PostViewerGateState | null> {
  if (!input.userId) {
    return null
  }

  const [gatePolicy, membership] = await Promise.all([
    getMembershipGatePolicy(input.client, input.communityId),
    getCommunityMembershipState(input.client, input.communityId, input.userId),
  ])

  return {
    community_id: publicCommunityId(input.communityId),
    community_display_name: input.displayName,
    viewer_community_role: membership.role_status === "active" ? membership.role : null,
    viewer_membership_status:
      membership.membership_status === "banned"
        ? "banned"
        : canAccessCommunity(membership)
          ? "member"
          : "not_member",
    membership_gate_summaries: buildMembershipGateSummariesFromPolicy(gatePolicy),
    membership_gate_expression: buildMembershipGateExpressionFromPolicy(gatePolicy),
    gate_match_mode: gatePolicy ? getGatePolicyMatchMode(gatePolicy) : null,
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
    const db = await openCommunityReadClient(
      input.env,
      input.communityRepository,
      summary.community_id,
    ).catch((error: unknown) => {
      console.warn(JSON.stringify({
        message: "home feed community identity read degraded",
        event: "home_feed_community_identity_open_failed",
        community_id: summary.community_id,
        error: error instanceof Error ? error.message : String(error),
      }))
      return null
    })
    if (!db) {
      return withHomeFeedCommunityIdentity(summary, null)
    }
    try {
      const identity = await getHomeFeedCommunityIdentity(db.client, summary.community_id)
      return withHomeFeedCommunityIdentity(summary, identity)
    } finally {
      await db.close()
    }
  }))
}

async function listHomeFeedAuthorCommunityRoles(input: {
  executor: DbExecutor
  communityId: string
  userIds: string[]
}): Promise<Map<string, LocalizedPostResponse["author_community_role"]>> {
  const uniqueUserIds = [...new Set(input.userIds)]
  const roles = new Map<string, LocalizedPostResponse["author_community_role"]>()
  if (uniqueUserIds.length === 0) return roles
  const placeholders = uniqueUserIds.map((_, index) => `?${index + 2}`).join(", ")
  const result = await input.executor.execute({
    sql: `
      SELECT user_id, role
      FROM community_roles
      WHERE community_id = ?1
        AND user_id IN (${placeholders})
        AND status = 'active'
        AND role IN ('owner', 'admin', 'moderator')
      ORDER BY user_id, CASE role
        WHEN 'owner' THEN 0
        WHEN 'admin' THEN 1
        ELSE 2
      END
    `,
    args: [input.communityId, ...uniqueUserIds],
  })
  for (const row of result.rows) {
    const userId = requiredString(row, "user_id")
    if (roles.has(userId)) continue
    roles.set(userId, requiredString(row, "role") === "owner" ? "owner" : "moderator")
  }
  return roles
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
  prefetch: HomeFeedCommunityPrefetch
  waitUntil?: HomeFeedWaitUntil
}): Promise<HomeFeedCommunityReadResult> {
  const communityStartedAt = performance.now()
  const openStartedAt = performance.now()
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "community_not_found") {
      return null
    }
    throw error
  })
  const openMs = elapsedMs(openStartedAt)
  if (!db) {
    return {
      items: [],
      identity: null,
      timing: {
        community_id: input.communityId,
        rows: input.rows.length,
        returned_items: 0,
        total_ms: elapsedMs(communityStartedAt),
        open_ms: openMs,
        identity_ms: 0,
        batched_reads_ms: 0,
        localize_ms: 0,
        crosspost_ms: 0,
        author_handles_ms: 0,
        streaks_ms: 0,
        derivatives_ms: 0,
        derivative_local_rows_ms: 0,
        derivative_global_rows_ms: 0,
        derivative_profiles_ms: 0,
        derivative_profiles_degraded: false,
        serialize_ms: 0,
        enqueue_ms: 0,
        unaccounted_ms: 0,
      },
    }
  }
  try {
    const identity = input.prefetch.identity
    const identityMs = 0
    const communitySummary = input.baseCommunity
      ? withHomeFeedCommunityIdentity(input.baseCommunity, identity)
      : null
    const communityItems: HomeFeedItem[] = []
    const projectedPostIds = input.rows.map((row) => row.source_post_id)
    const coalescedReads = createCoalescingReadClient(db.client)
    const batchedReadsStartedAt = performance.now()
    const [
      viewerGateState,
      postsById,
      threadSnapshotsByPostId,
      viewerVotesByPostId,
      communityLabels,
      authorCommunityRoleByUserId,
      contentTranslations,
    ] = await Promise.all([
      getHomeFeedViewerGateState({
        client: coalescedReads,
        communityId: input.communityId,
        displayName: communitySummary?.display_name ?? identity?.displayName ?? input.communityId,
        userId: input.userId,
      }),
      listPostsById(
        coalescedReads,
        projectedPostIds,
        input.prefetch.postProjectionSchema,
      ),
      listLatestThreadSnapshotsForRead(coalescedReads, projectedPostIds),
      listViewerVotes({
        client: coalescedReads,
        postIds: projectedPostIds,
        userId: input.userId,
      }),
      listCommunityLabels({
        executor: coalescedReads,
        communityId: input.communityId,
        includeArchived: true,
      }),
      listHomeFeedAuthorCommunityRoles({
        executor: coalescedReads,
        communityId: input.communityId,
        userIds: input.rows
          .filter((row) => row.identity_mode !== "anonymous")
          .map((row) => row.author_user_id)
          .filter((userId): userId is string => Boolean(userId)),
      }),
      listContentTranslationsForContentIds({
        executor: coalescedReads,
        contentType: "post",
        contentIds: projectedPostIds,
        locale: normalizeContentLocale(input.locale) ?? DEFAULT_CONTENT_LOCALE,
      }),
    ])
    const batchedReadsMs = elapsedMs(batchedReadsStartedAt)
    const communityLabelById = new Map(communityLabels.map((label) => [label.label_id, label] as const))
    const contentTranslationByKey = new Map(
      contentTranslations.map((translation) => [contentTranslationLookupKey(translation), translation] as const),
    )
    const postReadJobs: HomeFeedPostReadJob[] = []
    const studyEnabledCache = new Map<string, Promise<boolean>>([
      [input.communityId, Promise.resolve(input.prefetch.studyEnabled)],
    ])
    const karaokeEnabledCache = new Map<string, Promise<boolean>>([
      [input.communityId, Promise.resolve(input.prefetch.karaokeEnabled)],
    ])
    const studyElevenLabsCredentialResolver = createStudyElevenLabsCredentialResolver({ env: input.env })
    const songArtifactExecutor = getControlPlaneClient(input.env)
    const songArtifactPrefetchStartedAt = performance.now()
    const songArtifactPresentationByPostId = await listPublicSongArtifactPresentations({
      communityId: input.communityId,
      executor: songArtifactExecutor,
      posts: [...postsById.values()],
    })
    let localizeMs = elapsedMs(songArtifactPrefetchStartedAt)
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
        env: input.env,
        songArtifactExecutor,
        songArtifactPresentationByPostId,
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
        studyElevenLabsCredentialResolver,
        studyArtifactWriteClient: db.client,
        studyEnabledCache,
        karaokeEnabledCache,
        communityLabelById,
        authorCommunityRoleByUserId,
        contentTranslationByKey,
        viewerUserId: input.userId,
      })
      localizeMs += elapsedMs(localizeStartedAt)
      postReadJobs.push({ post, response })
    }
    const crosspostStartedAt = performance.now()
    await hydrateCrosspostSourcesForResponses({
      responses: postReadJobs.map((job) => job.response),
      communityRepository: input.communityRepository,
      profileRepository: input.profileRepository,
    })
    const crosspostMs = elapsedMs(crosspostStartedAt)
    // Stamp public-identity author handles onto the post payload so home-feed
    // cards render the byline on first paint instead of falling back to a
    // per-author profile fetch (the truncated-id -> handle flicker). One batched
    // profile lookup per community slice; anonymous/agent posts stay null.
    // The live feed hits this directly; the cached materialized public feed
    // reuses it via listHomeFeed -> readHomeFeedCommunityItems before it stores
    // the serialized payload, so both paths get the handle.
    const authorHandlesStartedAt = performance.now()
    await hydrateAuthorPublicHandlesForResponses({
      responses: postReadJobs.map((job) => job.response),
      profileRepository: input.profileRepository,
    })
    const authorHandlesMs = elapsedMs(authorHandlesStartedAt)
    const streaksStartedAt = performance.now()
    await hydrateSongStreakSummariesForResponses({
      client: db.client,
      responses: postReadJobs.map((job) => job.response),
      profileRepository: input.profileRepository,
      viewerUserId: input.userId,
    })
    const streaksMs = elapsedMs(streaksStartedAt)
    const derivativeResponses = homeFeedVideoDerivativeResponses(postReadJobs.map((job) => job.response))
    const derivativesStartedAt = performance.now()
    let derivativeTiming: DerivativeSourceHydrationTiming = {
      local_rows_ms: 0,
      global_rows_ms: 0,
      profiles_ms: 0,
      profiles_degraded: false,
    }
    if (derivativeResponses.length > 0) {
      derivativeTiming = await hydrateDerivativeSourcesForResponses({
        client: db.client,
        communityId: input.communityId,
        env: input.env,
        responses: derivativeResponses,
        profileRepository: input.profileRepository,
      })
    }
    const derivativesMs = elapsedMs(derivativesStartedAt)
    const serializeStartedAt = performance.now()
    if (communitySummary) {
      const serializedCommunitySummary = serializeHomeFeedCommunitySummary(communitySummary)
      for (const job of postReadJobs) {
        communityItems.push({
          community: serializedCommunitySummary,
          post: serializeLocalizedPostResponse({
            ...job.response,
            viewer_gate_state: viewerGateState,
          }, { surface: "home_feed" }),
        })
      }
    }
    const serializeMs = elapsedMs(serializeStartedAt)
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
    const totalMs = elapsedMs(communityStartedAt)
    const accountedMs = openMs
      + identityMs
      + batchedReadsMs
      + localizeMs
      + crosspostMs
      + authorHandlesMs
      + streaksMs
      + derivativesMs
      + serializeMs
      + enqueueMs
    return {
      items: communityItems,
      identity,
      timing: {
        community_id: input.communityId,
        rows: input.rows.length,
        returned_items: communityItems.length,
        total_ms: totalMs,
        open_ms: openMs,
        identity_ms: identityMs,
        batched_reads_ms: batchedReadsMs,
        localize_ms: localizeMs,
        crosspost_ms: crosspostMs,
        author_handles_ms: authorHandlesMs,
        streaks_ms: streaksMs,
        derivatives_ms: derivativesMs,
        derivative_local_rows_ms: derivativeTiming.local_rows_ms,
        derivative_global_rows_ms: derivativeTiming.global_rows_ms,
        derivative_profiles_ms: derivativeTiming.profiles_ms,
        derivative_profiles_degraded: derivativeTiming.profiles_degraded,
        serialize_ms: serializeMs,
        enqueue_ms: enqueueMs,
        unaccounted_ms: Math.max(0, totalMs - accountedMs),
      },
    }
  } finally {
    await db.close()
  }
}
