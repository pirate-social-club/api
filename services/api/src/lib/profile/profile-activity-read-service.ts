import { getPublicCommunityPreviewFromCommunityDb } from "../communities/community-preview-service"
import { openCommunityWriteClient } from "../communities/community-read-access"
import { isCommunityLive } from "../communities/community-status"
import type {
  CommunityDatabaseBindingRepository,
  CommunityReadRepository,
} from "../communities/db-community-repository"
import { executeFirst, type DbExecutor } from "../db-helpers"
import { badRequestError } from "../errors"
import { getCommentById } from "../comments/community-comment-store"
import { hydrateCommentAuthorPublicHandles } from "../comments/comment-author-hydration"
import { buildLocalizedCommentListItem } from "../localization/comment-localization-service"
import { buildLocalizedPostResponse } from "../localization/post-localization-service"
import { getPostReadMetrics } from "../posts/community-post-metrics-store"
import { getPostById } from "../posts/community-post-query-store"
import { isPubliclyReadablePost } from "../posts/post-access"
import { createStudyElevenLabsCredentialResolver, hydrateAuthorPublicHandlesForResponses, type StudyElevenLabsCredentialResolver } from "../posts/post-read-response"
import { getControlPlaneClient } from "../runtime-deps"
import { requiredString } from "../sql-row"
import type { ProfileRepository } from "../auth/repositories"
import type { Env } from "../../env"
import type {
  LocalizedPostResponse,
  CommentListItem,
  Post,
  ProfileActivityCommentPage,
  ProfileActivityItem,
  ProfileActivityPostPage,
  ProfileActivityResponse,
  ProfileActivityTab,
} from "../../types"

type ProfileActivityRepository = CommunityReadRepository & CommunityDatabaseBindingRepository

type ActivityCursor = {
  ts: string
  kind: "post" | "comment"
  id: string
}

type PostProjectionRow = {
  community_id: string
  source_post_id: string
  source_created_at: string
  projected_payload_json: string
  upvote_count: number
  downvote_count: number
  comment_count: number
  like_count: number
}

type CommentDiscoveryRow = {
  community_id: string
  source_comment_id: string
  thread_root_post_id: string
  created_at: string
}

function encodeCursor(cursor: ActivityCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")
}

function decodeCursor(cursor: string | null | undefined): ActivityCursor | null {
  if (!cursor?.trim()) {
    return null
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as ActivityCursor
    if (
      !parsed
      || typeof parsed !== "object"
      || typeof parsed.ts !== "string"
      || typeof parsed.id !== "string"
      || (parsed.kind !== "post" && parsed.kind !== "comment")
    ) {
      throw new Error("invalid cursor")
    }
    return parsed
  } catch {
    throw badRequestError("Invalid profile activity cursor")
  }
}

export function parseProfileActivityTab(value: string | null | undefined): ProfileActivityTab {
  switch (value) {
    case undefined:
    case null:
    case "":
    case "overview":
      return "overview"
    case "posts":
    case "comments":
      return value
    default:
      throw badRequestError("Invalid profile activity tab")
  }
}

export function parseProfileActivityLimit(value: string | null | undefined): number {
  const parsed = Number(value ?? "")
  if (!Number.isFinite(parsed)) {
    return 20
  }
  return Math.min(50, Math.max(1, Math.trunc(parsed)))
}

function cursorClause(
  cursor: ActivityCursor | null,
  timestampColumn: string,
  idColumn: string,
  nextArgIndex: number,
): { sql: string; args: unknown[] } {
  if (!cursor) {
    return { sql: "", args: [] }
  }
  return {
    sql: `
      AND (
        ${timestampColumn} < ?${nextArgIndex}
        OR (${timestampColumn} = ?${nextArgIndex} AND ${idColumn} < ?${nextArgIndex + 1})
      )
    `,
    args: [cursor.ts, cursor.id],
  }
}

function kindRank(kind: ActivityCursor["kind"]): number {
  return kind === "post" ? 0 : 1
}

function cursorClauseForKind(
  cursor: ActivityCursor | null,
  itemKind: ActivityCursor["kind"],
  timestampColumn: string,
  idColumn: string,
  nextArgIndex: number,
): { sql: string; args: unknown[] } {
  if (!cursor) {
    return { sql: "", args: [] }
  }
  const itemRank = kindRank(itemKind)
  const cursorRank = kindRank(cursor.kind)
  if (itemRank > cursorRank) {
    return {
      sql: `AND ${timestampColumn} <= ?${nextArgIndex}`,
      args: [cursor.ts],
    }
  }
  if (itemRank < cursorRank) {
    return {
      sql: `AND ${timestampColumn} < ?${nextArgIndex}`,
      args: [cursor.ts],
    }
  }
  return cursorClause(cursor, timestampColumn, idColumn, nextArgIndex)
}

function numberValue(value: unknown): number {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : 0
}

function groupByCommunity<T extends { community_id: string }>(rows: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>()
  for (const row of rows) {
    const existing = grouped.get(row.community_id) ?? []
    existing.push(row)
    grouped.set(row.community_id, existing)
  }
  return grouped
}

function parseProjectedPost(row: PostProjectionRow): Post | null {
  try {
    const parsed = JSON.parse(row.projected_payload_json) as Post
    return parsed && typeof parsed === "object" ? parsed : null
  } catch {
    return null
  }
}

async function queryPostRows(input: {
  env: Env
  targetUserId: string
  cursor: ActivityCursor | null
  limit: number
  overview: boolean
}): Promise<PostProjectionRow[]> {
  const control = getControlPlaneClient(input.env)
  const cursorFilter = input.overview
    ? cursorClauseForKind(input.cursor, "post", "source_created_at", "source_post_id", 2)
    : cursorClause(input.cursor, "source_created_at", "source_post_id", 2)
  const result = await control.execute({
    sql: `
      SELECT community_id, source_post_id, source_created_at, projected_payload_json,
             upvote_count, downvote_count, comment_count, like_count
      FROM community_post_projections
      WHERE author_user_id = ?1
        AND identity_mode = 'public'
        AND status = 'published'
        AND visibility = 'public'
        ${cursorFilter.sql}
      ORDER BY source_created_at DESC, source_post_id DESC
      LIMIT ?${2 + cursorFilter.args.length}
    `,
    args: [input.targetUserId, ...cursorFilter.args, input.limit],
  })
  return result.rows.map((row) => ({
    community_id: requiredString(row, "community_id"),
    source_post_id: requiredString(row, "source_post_id"),
    source_created_at: requiredString(row, "source_created_at"),
    projected_payload_json: requiredString(row, "projected_payload_json"),
    upvote_count: numberValue((row as Record<string, unknown>).upvote_count),
    downvote_count: numberValue((row as Record<string, unknown>).downvote_count),
    comment_count: numberValue((row as Record<string, unknown>).comment_count),
    like_count: numberValue((row as Record<string, unknown>).like_count),
  }))
}

async function queryCommentDiscoveryRows(input: {
  env: Env
  targetUserId: string
  cursor: ActivityCursor | null
  limit: number
  overview: boolean
}): Promise<CommentDiscoveryRow[]> {
  const control = getControlPlaneClient(input.env)
  const cursorFilter = input.overview
    ? cursorClauseForKind(input.cursor, "comment", "al.created_at", "al.target_id", 2)
    : cursorClause(input.cursor, "al.created_at", "al.target_id", 2)
  const result = await control.execute({
    sql: `
      SELECT DISTINCT al.target_id AS source_comment_id,
             cp.community_id,
             cp.thread_root_post_id,
             al.created_at
      FROM audit_log al
      JOIN comment_projections cp
        ON cp.source_comment_id = al.target_id
       AND cp.community_id = al.community_id
      WHERE al.actor_id = ?1
        AND al.actor_type = 'user'
        AND al.action = 'community.comment_created'
        AND al.target_type = 'comment'
        AND cp.status = 'published'
        ${cursorFilter.sql}
      ORDER BY al.created_at DESC, source_comment_id DESC
      LIMIT ?${2 + cursorFilter.args.length}
    `,
    args: [input.targetUserId, ...cursorFilter.args, input.limit],
  })
  return result.rows.map((row) => ({
    community_id: requiredString(row, "community_id"),
    source_comment_id: requiredString(row, "source_comment_id"),
    thread_root_post_id: requiredString(row, "thread_root_post_id"),
    created_at: requiredString(row, "created_at"),
  }))
}

async function getViewerCommentVote(input: {
  client: DbExecutor
  commentId: string
  viewerUserId: string | null
}): Promise<-1 | 1 | null> {
  if (!input.viewerUserId) {
    return null
  }
  const row = await executeFirst(input.client, {
    sql: `
      SELECT vote_value
      FROM comment_votes
      WHERE comment_id = ?1
        AND user_id = ?2
      LIMIT 1
    `,
    args: [input.commentId, input.viewerUserId],
  })
  const value = Number((row as Record<string, unknown> | null)?.vote_value)
  return value === 1 || value === -1 ? value : null
}

async function hydratePostRows(input: {
  env: Env
  profileRepository?: ProfileRepository | null
  repository: ProfileActivityRepository
  rows: PostProjectionRow[]
  viewerUserId: string | null
  locale?: string | null
}): Promise<ProfileActivityPostPage[]> {
  const items: ProfileActivityPostPage[] = []
  for (const [communityId, rows] of groupByCommunity(input.rows)) {
    const community = await input.repository.getCommunityById(communityId)
    if (!isCommunityLive(community)) {
      continue
    }

    const db = await openCommunityWriteClient(input.env, input.repository, communityId)
    try {
      const preview = await getPublicCommunityPreviewFromCommunityDb({
        env: input.env,
        client: db.client,
        communityId,
        locale: input.locale,
        communityRepository: input.repository,
      })
      const studyEnabledCache = new Map<string, Promise<boolean>>()
      const studyElevenLabsCredentialResolver = createStudyElevenLabsCredentialResolver({ env: input.env })
      const communityPostResponses: LocalizedPostResponse[] = []
      for (const row of rows) {
        const post = parseProjectedPost(row)
        if (!post || post.identity_mode !== "public" || !isPubliclyReadablePost(post)) {
          continue
        }
        const metrics = await getPostReadMetrics({
          executor: db.client,
          postId: post.post_id,
          viewerUserId: input.viewerUserId,
        })
        const response = await buildLocalizedPostResponse({
          executor: db.client,
          env: input.env,
          post,
          locale: input.locale,
          metrics,
          threadSnapshot: null,
          ageGateViewerState: post.age_gate_policy === "18_plus" ? "proof_required" : null,
          studyElevenLabsCredentialResolver,
          studyEnabledCache,
          viewerUserId: input.viewerUserId,
        })
        response.community = preview
        communityPostResponses.push(response)
        items.push({
          kind: "post",
          post: response,
          community: preview,
          created_at: row.source_created_at,
        })
      }
      await hydrateAuthorPublicHandlesForResponses({
        responses: communityPostResponses,
        profileRepository: input.profileRepository,
      })
    } finally {
      db.close()
    }
  }
  return items
}

async function buildThreadRootPost(input: {
  client: DbExecutor
  env: Env
  profileRepository?: ProfileRepository | null
  postId: string
  studyElevenLabsCredentialResolver?: StudyElevenLabsCredentialResolver
  studyEnabledCache?: Map<string, Promise<boolean>>
  viewerUserId: string | null
  locale?: string | null
}): Promise<LocalizedPostResponse | null> {
  const post = await getPostById(input.client, input.postId)
  if (!post || !isPubliclyReadablePost(post)) {
    return null
  }
  const metrics = await getPostReadMetrics({
    executor: input.client,
    postId: post.post_id,
    viewerUserId: input.viewerUserId,
  })
  const response = await buildLocalizedPostResponse({
    executor: input.client,
    env: input.env,
    post,
    locale: input.locale,
    metrics,
    threadSnapshot: null,
    ageGateViewerState: post.age_gate_policy === "18_plus" ? "proof_required" : null,
    studyElevenLabsCredentialResolver: input.studyElevenLabsCredentialResolver,
    studyEnabledCache: input.studyEnabledCache,
    viewerUserId: input.viewerUserId,
  })
  await hydrateAuthorPublicHandlesForResponses({
    responses: [response],
    profileRepository: input.profileRepository,
  })
  return response
}

async function hydrateCommentRows(input: {
  env: Env
  profileRepository?: ProfileRepository | null
  repository: ProfileActivityRepository
  rows: CommentDiscoveryRow[]
  viewerUserId: string | null
  locale?: string | null
}): Promise<ProfileActivityCommentPage[]> {
  const items: ProfileActivityCommentPage[] = []
  const seenCommentIds = new Set<string>()
  for (const [communityId, rows] of groupByCommunity(input.rows)) {
    const community = await input.repository.getCommunityById(communityId)
    if (!isCommunityLive(community)) {
      continue
    }

    const db = await openCommunityWriteClient(input.env, input.repository, communityId)
    try {
      const preview = await getPublicCommunityPreviewFromCommunityDb({
        env: input.env,
        client: db.client,
        communityId,
        locale: input.locale,
        communityRepository: input.repository,
      })
      const studyEnabledCache = new Map<string, Promise<boolean>>()
      const studyElevenLabsCredentialResolver = createStudyElevenLabsCredentialResolver({ env: input.env })
      const threadRoots = new Map<string, LocalizedPostResponse | null>()
      const communityCommentItems: CommentListItem[] = []
      for (const row of rows) {
        if (seenCommentIds.has(row.source_comment_id)) {
          continue
        }
        seenCommentIds.add(row.source_comment_id)
        const comment = await getCommentById(db.client, row.source_comment_id)
        if (!comment || comment.status !== "published" || comment.identity_mode !== "public") {
          continue
        }
        const rootPost = threadRoots.has(row.thread_root_post_id)
          ? threadRoots.get(row.thread_root_post_id) ?? null
          : await buildThreadRootPost({
              client: db.client,
              env: input.env,
              profileRepository: input.profileRepository,
              postId: row.thread_root_post_id,
              studyElevenLabsCredentialResolver,
              studyEnabledCache,
              viewerUserId: input.viewerUserId,
              locale: input.locale,
            })
        threadRoots.set(row.thread_root_post_id, rootPost)
        if (!rootPost) {
          continue
        }
        rootPost.community = preview
        const viewerVote = await getViewerCommentVote({
          client: db.client,
          commentId: comment.comment_id,
          viewerUserId: input.viewerUserId,
        })
        const localizedComment = await buildLocalizedCommentListItem({
          executor: db.client,
          item: {
            comment,
            viewer_vote: viewerVote,
            viewer_can_delete: Boolean(input.viewerUserId && comment.author_user_id === input.viewerUserId),
          },
          locale: input.locale,
        })
        communityCommentItems.push(localizedComment)
        items.push({
          kind: "comment",
          comment: localizedComment,
          thread_root_post: rootPost,
          community: preview,
          created_at: row.created_at,
        })
      }
      await hydrateCommentAuthorPublicHandles(communityCommentItems, input.profileRepository)
    } finally {
      db.close()
    }
  }
  return items
}

function sortActivityItems<T extends ProfileActivityItem>(items: T[]): T[] {
  return [...items].sort((left, right) => {
    const byTime = right.created_at.localeCompare(left.created_at)
    if (byTime !== 0) {
      return byTime
    }
    const byKind = kindRank(left.kind) - kindRank(right.kind)
    if (byKind !== 0) {
      return byKind
    }
    const leftId = left.kind === "post" ? left.post.post.post_id : left.comment.comment.comment_id
    const rightId = right.kind === "post" ? right.post.post.post_id : right.comment.comment.comment_id
    return rightId.localeCompare(leftId)
  })
}

function cursorForItem(item: ProfileActivityItem): string {
  return encodeCursor({
    ts: item.created_at,
    kind: item.kind,
    id: item.kind === "post" ? item.post.post.post_id : item.comment.comment.comment_id,
  })
}

export async function getProfileActivity(input: {
  env: Env
  profileRepository?: ProfileRepository | null
  repository: ProfileActivityRepository
  targetUserId: string
  viewerUserId: string | null
  tab: ProfileActivityTab
  cursor?: string | null
  limit: number
  locale?: string | null
}): Promise<ProfileActivityResponse> {
  const cursor = decodeCursor(input.cursor)
  const postLimit = input.tab === "overview" ? input.limit + 1 : input.limit + 1
  const commentDiscoveryLimit = (input.tab === "overview" ? input.limit : input.limit + 1) * 3

  const [postRows, commentRows] = await Promise.all([
    input.tab === "comments"
      ? Promise.resolve([])
      : queryPostRows({
          env: input.env,
          targetUserId: input.targetUserId,
          cursor,
          limit: postLimit,
          overview: input.tab === "overview",
        }),
    input.tab === "posts"
      ? Promise.resolve([])
      : queryCommentDiscoveryRows({
          env: input.env,
          targetUserId: input.targetUserId,
          cursor,
          limit: Math.max(input.limit + 1, commentDiscoveryLimit),
          overview: input.tab === "overview",
        }),
  ])

  const [posts, comments] = await Promise.all([
    hydratePostRows({
      env: input.env,
      profileRepository: input.profileRepository,
      repository: input.repository,
      rows: postRows,
      viewerUserId: input.viewerUserId,
      locale: input.locale,
    }),
    hydrateCommentRows({
      env: input.env,
      profileRepository: input.profileRepository,
      repository: input.repository,
      rows: commentRows,
      viewerUserId: input.viewerUserId,
      locale: input.locale,
    }),
  ])

  if (input.tab === "posts") {
    const sorted = sortActivityItems(posts)
    const page = sorted.slice(0, input.limit)
    return {
      tab: input.tab,
      posts: page,
      comments: [],
      overview_items: [],
      next_cursor: sorted.length > input.limit && page.at(-1) ? cursorForItem(page.at(-1)!) : null,
    }
  }

  if (input.tab === "comments") {
    const sorted = sortActivityItems(comments)
    const page = sorted.slice(0, input.limit)
    return {
      tab: input.tab,
      posts: [],
      comments: page,
      overview_items: [],
      next_cursor: sorted.length > input.limit && page.at(-1) ? cursorForItem(page.at(-1)!) : null,
    }
  }

  const sorted = sortActivityItems<ProfileActivityItem>([...posts, ...comments])
  const overviewItems = sorted.slice(0, input.limit)
  return {
    tab: input.tab,
    posts: [],
    comments: [],
    overview_items: overviewItems,
    next_cursor: sorted.length > input.limit && overviewItems.at(-1) ? cursorForItem(overviewItems.at(-1)!) : null,
  }
}
