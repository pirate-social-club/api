import type { DbExecutor } from "../db-helpers"
import type { Client } from "../sql-client"
import { badRequestError, internalError } from "../errors"
import { executeFirst } from "../db-helpers"
import { makeId } from "../helpers"
import {
  buildAnonymousLabel,
  buildDisclosedQualifierSnapshots,
} from "../identity/anonymous-identity"
import { detectSourceLanguageFromText } from "../localization/content-locale"
import { resolveStubAnalysisOutcome } from "./post-analysis"
import { numberOrNull, requiredNumber, requiredString, rowValue, stringOrNull } from "../sql-row"
import type { CreatePostRequest, Post } from "../../types"

type CommunityPostPolicy = {
  allow_anonymous_identity: boolean
  anonymous_identity_scope: Post["anonymous_scope"]
}

type PostRow = {
  post_id: string
  community_id: string
  author_user_id: string | null
  identity_mode: Post["identity_mode"]
  anonymous_scope: Post["anonymous_scope"]
  anonymous_label: string | null
  disclosed_qualifiers_json: string | null
  label_id: string | null
  post_type: Post["post_type"]
  status: Post["status"]
  title: string | null
  body: string | null
  caption: string | null
  lyrics: string | null
  link_url: string | null
  media_refs_json: string | null
  song_artifact_bundle_id: string | null
  source_language: string | null
  translation_policy: Post["translation_policy"]
  access_mode: Post["access_mode"]
  asset_id: string | null
  parent_post_id: string | null
  song_mode: Post["song_mode"]
  rights_basis: Post["rights_basis"]
  analysis_state: Post["analysis_state"]
  analysis_result_ref: string | null
  content_safety_state: Post["content_safety_state"]
  age_gate_policy: Post["age_gate_policy"]
  idempotency_key: string
  created_at: string
  updated_at: string
}

function parseJsonArray<T>(value: string | null): T[] | null {
  if (!value) {
    return null
  }
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? (parsed as T[]) : null
  } catch {
    return null
  }
}

function parseDisclosedQualifiers(value: string | null): Post["disclosed_qualifiers_json"] {
  const parsed = parseJsonArray<
    Post["disclosed_qualifiers_json"] extends Array<infer T> | null | undefined ? T : never
  >(value)
  return parsed ? (parsed as Post["disclosed_qualifiers_json"]) : null
}

function parseMediaRefs(value: string | null): Post["media_refs"] {
  const parsed = parseJsonArray<Post["media_refs"] extends Array<infer T> | undefined ? T : never>(value)
  return parsed ? (parsed as Post["media_refs"]) : undefined
}

function toPostRow(row: unknown): PostRow {
  return {
    post_id: requiredString(row, "post_id"),
    community_id: requiredString(row, "community_id"),
    author_user_id: stringOrNull(rowValue(row, "author_user_id")),
    identity_mode: requiredString(row, "identity_mode") as Post["identity_mode"],
    anonymous_scope: stringOrNull(rowValue(row, "anonymous_scope")) as Post["anonymous_scope"],
    anonymous_label: stringOrNull(rowValue(row, "anonymous_label")),
    disclosed_qualifiers_json: stringOrNull(rowValue(row, "disclosed_qualifiers_json")),
    label_id: stringOrNull(rowValue(row, "label_id")),
    post_type: requiredString(row, "post_type") as Post["post_type"],
    status: requiredString(row, "status") as Post["status"],
    title: stringOrNull(rowValue(row, "title")),
    body: stringOrNull(rowValue(row, "body")),
    caption: stringOrNull(rowValue(row, "caption")),
    lyrics: stringOrNull(rowValue(row, "lyrics")),
    link_url: stringOrNull(rowValue(row, "link_url")),
    media_refs_json: stringOrNull(rowValue(row, "media_refs_json")),
    song_artifact_bundle_id: stringOrNull(rowValue(row, "song_artifact_bundle_id")),
    source_language: stringOrNull(rowValue(row, "source_language")),
    translation_policy: stringOrNull(rowValue(row, "translation_policy")) as Post["translation_policy"],
    access_mode: stringOrNull(rowValue(row, "access_mode")) as Post["access_mode"],
    asset_id: stringOrNull(rowValue(row, "asset_id")),
    parent_post_id: stringOrNull(rowValue(row, "parent_post_id")),
    song_mode: stringOrNull(rowValue(row, "song_mode")) as Post["song_mode"],
    rights_basis: stringOrNull(rowValue(row, "rights_basis")) as Post["rights_basis"],
    analysis_state: requiredString(row, "analysis_state") as Post["analysis_state"],
    analysis_result_ref: stringOrNull(rowValue(row, "analysis_result_ref")),
    content_safety_state: requiredString(row, "content_safety_state") as Post["content_safety_state"],
    age_gate_policy: requiredString(row, "age_gate_policy") as Post["age_gate_policy"],
    idempotency_key: stringOrNull(rowValue(row, "idempotency_key")) ?? "",
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

function serializePost(row: PostRow): Post {
  return {
    post_id: row.post_id,
    community_id: row.community_id,
    author_user_id: row.identity_mode === "anonymous" ? null : row.author_user_id,
    authorship_mode: "human_direct",
    identity_mode: row.identity_mode,
    anonymous_scope: row.anonymous_scope,
    anonymous_label: row.anonymous_label,
    disclosed_qualifiers_json: parseDisclosedQualifiers(row.disclosed_qualifiers_json),
    label_id: row.label_id,
    post_type: row.post_type,
    status: row.status,
    title: row.title,
    body: row.body,
    caption: row.caption,
    link_url: row.link_url,
    media_refs: parseMediaRefs(row.media_refs_json),
    song_artifact_bundle_id: row.song_artifact_bundle_id,
    source_language: row.source_language,
    translation_policy: row.translation_policy,
    access_mode: row.access_mode,
    asset_id: row.asset_id,
    parent_post_id: row.parent_post_id,
    song_mode: row.song_mode,
    rights_basis: row.rights_basis,
    analysis_state: row.analysis_state,
    analysis_result_ref: row.analysis_result_ref,
    content_safety_state: row.content_safety_state,
    age_gate_policy: row.age_gate_policy,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export async function findPostByIdempotencyKey(input: {
  client: Client
  communityId: string
  authorUserId: string
  idempotencyKey: string
}): Promise<Post | null> {
  const row = await executeFirst(
    input.client,
    {
      sql: `
        SELECT post_id, community_id, author_user_id, identity_mode, anonymous_scope, anonymous_label,
               disclosed_qualifiers_json, label_id, post_type, status, title, body, caption, lyrics,
               link_url, media_refs_json, song_artifact_bundle_id, source_language, translation_policy,
               access_mode, asset_id, parent_post_id, song_mode, rights_basis, analysis_state, analysis_result_ref,
               content_safety_state, age_gate_policy, idempotency_key, created_at, updated_at
        FROM posts
        WHERE community_id = ?1
          AND author_user_id = ?2
          AND idempotency_key = ?3
        LIMIT 1
      `,
      args: [input.communityId, input.authorUserId, input.idempotencyKey],
    },
  )

  return row ? serializePost(toPostRow(row)) : null
}

export async function insertPost(input: {
  client: Client
  communityId: string
  authorUserId: string
  body: CreatePostRequest
  createdAt: string
  analysisOverride?: Pick<Post, "analysis_state" | "content_safety_state" | "age_gate_policy" | "status">
}): Promise<Post> {
  const postId = makeId("pst")
  const identityMode = input.body.identity_mode ?? "public"
  const postType = input.body.post_type ?? "text"
  const anonymousScope = identityMode === "anonymous" ? (input.body.anonymous_scope ?? "community_stable") : null
  const anonymousLabel = identityMode === "anonymous" && anonymousScope
    ? buildAnonymousLabel({
        communityId: input.communityId,
        entityId: postId,
        scope: anonymousScope,
        userId: input.authorUserId,
      })
    : null
  const disclosedQualifierSnapshots = identityMode === "anonymous"
    ? buildDisclosedQualifierSnapshots(input.body.disclosed_qualifier_ids)
    : null
  const disclosedQualifiersJson = disclosedQualifierSnapshots
    ? JSON.stringify(disclosedQualifierSnapshots)
    : null
  const mediaRefsJson = input.body.media_refs ? JSON.stringify(input.body.media_refs) : null
  const translationPolicy = input.body.translation_policy ?? "none"
  const idempotencyKey = input.body.idempotency_key?.trim() ?? ""
  const stubAnalysis = resolveStubAnalysisOutcome(input.body)
  const analysisState = input.analysisOverride?.analysis_state ?? stubAnalysis.analysis_state
  const contentSafetyState = input.analysisOverride?.content_safety_state ?? stubAnalysis.content_safety_state
  const status = input.analysisOverride?.status ?? stubAnalysis.status
  const ageGatePolicy = input.analysisOverride?.age_gate_policy ?? "none"
  const sourceLanguage = detectSourceLanguageFromText([
    input.body.title,
    input.body.body,
    input.body.caption,
    input.body.lyrics,
  ])

  await input.client.execute({
    sql: `
      INSERT INTO posts (
        post_id, community_id, author_user_id, identity_mode, anonymous_scope, anonymous_label,
        disclosed_qualifiers_json, label_id, post_type, status, song_mode, title, body, caption,
        lyrics, link_url, media_refs_json, song_artifact_bundle_id, source_language, translation_policy,
        rights_basis, access_mode, asset_id, parent_post_id, analysis_state, analysis_result_ref, content_safety_state,
        age_gate_policy, created_at, updated_at, idempotency_key
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6,
        ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
        ?15, ?16, ?17, ?18, ?19, ?20,
        ?21, ?22, ?23, ?24, ?25, NULL, ?26,
        ?27, ?28, ?28, ?29
      )
    `,
    args: [
      postId,
      input.communityId,
      input.authorUserId,
      identityMode,
      anonymousScope,
      anonymousLabel,
      disclosedQualifiersJson,
      input.body.label_id ?? null,
      postType,
      status,
      input.body.song_mode ?? null,
      input.body.title ?? null,
      input.body.body ?? null,
      input.body.caption ?? null,
      input.body.lyrics ?? null,
      input.body.link_url ?? null,
      mediaRefsJson,
      input.body.song_artifact_bundle_id ?? null,
      sourceLanguage,
      translationPolicy,
      input.body.rights_basis ?? "none",
      input.body.access_mode ?? (postType === "song" ? "public" : null),
      input.body.asset_id ?? null,
      input.body.parent_post_id ?? null,
      analysisState,
      contentSafetyState,
      ageGatePolicy,
      input.createdAt,
      idempotencyKey,
    ],
  })

  const created = await getPostById(input.client, postId)
  if (!created) {
    throw internalError("Post row is missing after insert")
  }
  return created
}

export async function getPostById(client: DbExecutor, postId: string): Promise<Post | null> {
  const row = await executeFirst(
    client,
    {
      sql: `
        SELECT post_id, community_id, author_user_id, identity_mode, anonymous_scope, anonymous_label,
               disclosed_qualifiers_json, label_id, post_type, status, title, body, caption, lyrics,
               link_url, media_refs_json, song_artifact_bundle_id, source_language, translation_policy,
               access_mode, asset_id, parent_post_id, song_mode, rights_basis, analysis_state, analysis_result_ref,
               content_safety_state, age_gate_policy, idempotency_key, created_at, updated_at
        FROM posts
        WHERE post_id = ?1
        LIMIT 1
      `,
      args: [postId],
    },
  )

  return row ? serializePost(toPostRow(row)) : null
}

export async function getCommunityPostPolicy(
  executor: DbExecutor,
  communityId: string,
): Promise<CommunityPostPolicy | null> {
  const row = await executeFirst(executor, {
    sql: `
      SELECT allow_anonymous_identity, anonymous_identity_scope
      FROM communities
      WHERE community_id = ?1
      LIMIT 1
    `,
    args: [communityId],
  })

  if (!row) {
    return null
  }

  return {
    allow_anonymous_identity: requiredNumber(row, "allow_anonymous_identity") === 1,
    anonymous_identity_scope: stringOrNull(rowValue(row, "anonymous_identity_scope")) as Post["anonymous_scope"],
  }
}

function getFeedItemScore(item: {
  upvote_count: number
  downvote_count: number
}): number {
  return item.upvote_count - item.downvote_count
}

function getFeedItemCreatedAtMs(item: {
  post: Post
}): number {
  const timestamp = Date.parse(item.post.created_at)
  return Number.isNaN(timestamp) ? 0 : timestamp
}

function getBestFeedRank(item: {
  post: Post
  upvote_count: number
  downvote_count: number
}, now: number): number {
  const ageHours = Math.max(0, (now - getFeedItemCreatedAtMs(item)) / 3_600_000)
  return getFeedItemScore(item) / Math.pow(ageHours + 2, 1.5)
}

function parseOffsetCursor(cursor: string | null | undefined): number {
  if (!cursor || !cursor.startsWith("o:")) {
    return 0
  }
  const parsed = Number(cursor.slice(2))
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0
}

export async function listPublishedLocalizedPosts(input: {
  client: Client
  communityId: string
  viewerUserId: string
  limit: number
  flairId?: string | null
  sort: "best" | "new" | "top"
  cursor?: string | null
}): Promise<{
  items: Array<{
    post: Post
    upvote_count: number
    downvote_count: number
    like_count: number
    viewer_vote: -1 | 1 | null
  }>
  nextCursor: string | null
}> {
  const newCursorParts = input.sort === "new" && input.cursor ? input.cursor.split("|") : null
  const createdAtCursor = newCursorParts?.[0] ?? null
  const postIdCursor = newCursorParts?.[1] ?? null
  const result = await input.client.execute({
    sql: `
      SELECT post_id, community_id, author_user_id, identity_mode, anonymous_scope, anonymous_label,
             disclosed_qualifiers_json, label_id, post_type, status, title, body, caption, lyrics,
             link_url, media_refs_json, song_artifact_bundle_id, source_language, translation_policy,
             access_mode, asset_id, parent_post_id, song_mode, rights_basis, analysis_state, analysis_result_ref,
             content_safety_state, age_gate_policy, idempotency_key, created_at, updated_at,
             (
               SELECT COUNT(*)
               FROM post_votes
               WHERE post_id = posts.post_id
                 AND vote_value = 1
             ) AS upvote_count,
             (
               SELECT COUNT(*)
               FROM post_votes
               WHERE post_id = posts.post_id
                 AND vote_value = -1
             ) AS downvote_count,
             (
               SELECT COUNT(*)
               FROM post_reactions
               WHERE post_id = posts.post_id
                 AND reaction_key = 'like'
             ) AS like_count,
             (
               SELECT vote_value
               FROM post_votes
               WHERE post_id = posts.post_id
                 AND user_id = ?2
               LIMIT 1
             ) AS viewer_vote
      FROM posts
      WHERE community_id = ?1
        AND status = 'published'
        AND (?3 IS NULL OR label_id = ?3)
        AND (
          ?4 = 0
          OR ?5 IS NULL
          OR created_at < ?5
          OR (created_at = ?5 AND post_id < ?6)
        )
      ORDER BY created_at DESC, post_id DESC
      LIMIT ?7
    `,
    args: [
      input.communityId,
      input.viewerUserId,
      input.flairId ?? null,
      input.sort === "new" ? 1 : 0,
      createdAtCursor,
      postIdCursor,
      input.sort === "new" ? input.limit + 1 : 10_000,
    ],
  })

  const items = result.rows.map((row) => {
    return {
      post: serializePost(toPostRow(row)),
      upvote_count: requiredNumber(row, "upvote_count"),
      downvote_count: requiredNumber(row, "downvote_count"),
      like_count: requiredNumber(row, "like_count"),
      viewer_vote: numberOrNull(rowValue(row, "viewer_vote")) as -1 | 1 | null,
    }
  })

  if (input.sort === "new") {
    const pageItems = items.slice(0, input.limit)
    const overflowItem = items.length > input.limit ? items[input.limit] : null
    return {
      items: pageItems,
      nextCursor: overflowItem ? `${overflowItem.post.created_at}|${overflowItem.post.post_id}` : null,
    }
  }

  const now = Date.now()
  const sortedItems = [...items].sort((left, right) => {
    if (input.sort === "top") {
      const scoreDiff = getFeedItemScore(right) - getFeedItemScore(left)
      if (scoreDiff !== 0) {
        return scoreDiff
      }
    } else {
      const rankDiff = getBestFeedRank(right, now) - getBestFeedRank(left, now)
      if (rankDiff !== 0) {
        return rankDiff
      }
    }

    const createdAtDiff = getFeedItemCreatedAtMs(right) - getFeedItemCreatedAtMs(left)
    if (createdAtDiff !== 0) {
      return createdAtDiff
    }
    return right.post.post_id.localeCompare(left.post.post_id)
  })

  const offset = parseOffsetCursor(input.cursor)
  const pageItems = sortedItems.slice(offset, offset + input.limit)
  const nextCursor = offset + input.limit < sortedItems.length ? `o:${offset + input.limit}` : null

  return { items: pageItems, nextCursor }
}

export async function getPostProjectionMetrics(
  executor: DbExecutor,
  postId: string,
): Promise<{
  upvoteCount: number
  downvoteCount: number
  commentCount: number
  likeCount: number
}> {
  const row = await executeFirst(executor, {
    sql: `
      SELECT
        (
          SELECT COUNT(*)
          FROM post_votes
          WHERE post_id = ?1
            AND vote_value = 1
        ) AS upvote_count,
        (
          SELECT COUNT(*)
          FROM post_votes
          WHERE post_id = ?1
            AND vote_value = -1
        ) AS downvote_count,
        (
          SELECT COUNT(*)
          FROM comments
          WHERE thread_root_post_id = ?1
            AND status = 'published'
        ) AS comment_count,
        (
          SELECT COUNT(*)
          FROM post_reactions
          WHERE post_id = ?1
            AND reaction_key = 'like'
        ) AS like_count
    `,
    args: [postId],
  })

  return {
    upvoteCount: requiredNumber(row, "upvote_count"),
    downvoteCount: requiredNumber(row, "downvote_count"),
    commentCount: requiredNumber(row, "comment_count"),
    likeCount: requiredNumber(row, "like_count"),
  }
}

export async function upsertPostVote(input: {
  client: Client
  postId: string
  communityId: string
  userId: string
  value: -1 | 1
  now: string
}): Promise<{ post_id: string; value: -1 | 1 }> {
  await input.client.execute({
    sql: `
      INSERT INTO post_votes (
        post_vote_id, post_id, community_id, user_id, vote_value, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?6
      )
      ON CONFLICT(post_id, user_id) DO UPDATE SET
        vote_value = excluded.vote_value,
        updated_at = excluded.updated_at
    `,
    args: [makeId("pvt"), input.postId, input.communityId, input.userId, input.value, input.now],
  })

  return {
    post_id: input.postId,
    value: input.value,
  }
}

export function assertPostCreateRequest(body: CreatePostRequest, _communityId: string): void {
  if (Object.prototype.hasOwnProperty.call(body, "community_id")) {
    throw badRequestError("community_id must not be provided in the post body")
  }
  if (!body.post_type) {
    throw badRequestError("post_type is required")
  }
  if (body.post_type === "link" && !body.link_url?.trim()) {
    throw badRequestError("link_url is required for link posts")
  }
  if (body.post_type !== "link" && body.link_url) {
    throw badRequestError("link_url is only allowed for link posts")
  }
  if ((body.identity_mode ?? "public") !== "anonymous" && body.anonymous_scope) {
    throw badRequestError("anonymous_scope is only allowed for anonymous posts")
  }
  if (body.identity_mode === "anonymous" && !body.anonymous_scope) {
    throw badRequestError("anonymous_scope is required for anonymous posts")
  }
  if ((body.identity_mode ?? "public") !== "anonymous" && body.disclosed_qualifier_ids?.length) {
    throw badRequestError("disclosed_qualifier_ids are only allowed for anonymous posts")
  }
  if (body.post_type !== "song" && body.access_mode) {
    throw badRequestError("access_mode is only supported for song posts")
  }
  if (body.post_type === "song") {
    if ((body.identity_mode ?? "public") !== "public") {
      throw badRequestError("song posts must use public identity")
    }
    if (!body.song_artifact_bundle_id?.trim()) {
      throw badRequestError("song_artifact_bundle_id is required for song posts")
    }
    if (body.access_mode && body.access_mode !== "public" && body.access_mode !== "locked") {
      throw badRequestError("song access_mode must be public or locked")
    }
  }
}
