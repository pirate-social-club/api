import type { Client, InValue } from "@libsql/client"
import { badRequestError, internalError } from "../errors"
import { makeId } from "../helpers"
import { resolveStubAnalysisOutcome } from "./post-analysis"
import { numberOrNull, requiredNumber, requiredString, rowValue, stringOrNull } from "../sql-row"
import type { CreatePostRequest, LocalizedPostResponse, Post } from "../../types"

type PostRow = {
  post_id: string
  community_id: string
  author_user_id: string | null
  identity_mode: Post["identity_mode"]
  anonymous_scope: Post["anonymous_scope"]
  anonymous_label: string | null
  disclosed_qualifiers_json: string | null
  flair_id: string | null
  post_type: Post["post_type"]
  status: Post["status"]
  title: string | null
  body: string | null
  caption: string | null
  link_url: string | null
  media_refs_json: string | null
  source_language: string | null
  translation_policy: Post["translation_policy"]
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
    flair_id: stringOrNull(rowValue(row, "flair_id")),
    post_type: requiredString(row, "post_type") as Post["post_type"],
    status: requiredString(row, "status") as Post["status"],
    title: stringOrNull(rowValue(row, "title")),
    body: stringOrNull(rowValue(row, "body")),
    caption: stringOrNull(rowValue(row, "caption")),
    link_url: stringOrNull(rowValue(row, "link_url")),
    media_refs_json: stringOrNull(rowValue(row, "media_refs_json")),
    source_language: stringOrNull(rowValue(row, "source_language")),
    translation_policy: stringOrNull(rowValue(row, "translation_policy")) as Post["translation_policy"],
    asset_id: stringOrNull(rowValue(row, "asset_id")),
    parent_post_id: stringOrNull(rowValue(row, "parent_post_id")),
    song_mode: stringOrNull(rowValue(row, "song_mode")) as Post["song_mode"],
    rights_basis: stringOrNull(rowValue(row, "rights_basis")) as Post["rights_basis"],
    analysis_state: requiredString(row, "analysis_state") as Post["analysis_state"],
    analysis_result_ref: stringOrNull(rowValue(row, "analysis_result_ref")),
    content_safety_state: requiredString(row, "content_safety_state") as Post["content_safety_state"],
    age_gate_policy: requiredString(row, "age_gate_policy") as Post["age_gate_policy"],
    idempotency_key: requiredString(row, "idempotency_key"),
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
    flair_id: row.flair_id,
    post_type: row.post_type,
    status: row.status,
    title: row.title,
    body: row.body,
    caption: row.caption,
    link_url: row.link_url,
    media_refs: parseMediaRefs(row.media_refs_json),
    source_language: row.source_language,
    translation_policy: row.translation_policy,
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

async function firstRow(client: Client, sql: string, args: InValue[]): Promise<unknown | null> {
  const result = await client.execute({ sql, args })
  return result.rows[0] ?? null
}

export async function findPostByIdempotencyKey(input: {
  client: Client
  communityId: string
  authorUserId: string
  idempotencyKey: string
}): Promise<Post | null> {
  const row = await firstRow(
    input.client,
    `
      SELECT post_id, community_id, author_user_id, identity_mode, anonymous_scope, anonymous_label,
             disclosed_qualifiers_json, flair_id, post_type, status, title, body, caption, link_url,
             media_refs_json, source_language, translation_policy, asset_id, parent_post_id, song_mode,
             rights_basis, analysis_state, analysis_result_ref, content_safety_state, age_gate_policy,
             idempotency_key, created_at, updated_at
      FROM posts
      WHERE community_id = ?1
        AND author_user_id = ?2
        AND idempotency_key = ?3
      LIMIT 1
    `,
    [input.communityId, input.authorUserId, input.idempotencyKey],
  )

  return row ? serializePost(toPostRow(row)) : null
}

export async function insertPost(input: {
  client: Client
  communityId: string
  authorUserId: string
  body: CreatePostRequest
  createdAt: string
}): Promise<Post> {
  const postId = makeId("pst")
  const identityMode = input.body.identity_mode ?? "public"
  const postType = input.body.post_type ?? "text"
  const anonymousScope = identityMode === "anonymous" ? (input.body.anonymous_scope ?? "community_stable") : null
  const anonymousLabel = identityMode === "anonymous" ? "anonymous" : null
  const disclosedQualifiersJson = identityMode === "anonymous" && input.body.disclosed_qualifier_ids
    ? JSON.stringify(input.body.disclosed_qualifier_ids.map((qualifierId) => ({ qualifier_template_id: qualifierId })))
    : null
  const mediaRefsJson = input.body.media_refs ? JSON.stringify(input.body.media_refs) : null
  const translationPolicy = input.body.translation_policy ?? "none"
  const ageGatePolicy = input.body.age_gate_policy ?? "none"
  const idempotencyKey = input.body.idempotency_key?.trim() ?? ""
  const stubAnalysis = resolveStubAnalysisOutcome(input.body)
  const analysisState = stubAnalysis.analysis_state
  const contentSafetyState = stubAnalysis.content_safety_state
  const status = stubAnalysis.status
  const sourceLanguage = input.body.body || input.body.title || input.body.caption ? "en" : null

  await input.client.execute({
    sql: `
      INSERT INTO posts (
        post_id, community_id, author_user_id, identity_mode, anonymous_scope, anonymous_label,
        disclosed_qualifiers_json, flair_id, post_type, status, song_mode, title, body, caption,
        link_url, media_refs_json, source_language, translation_policy, rights_basis, asset_id,
        parent_post_id, analysis_state, analysis_result_ref, content_safety_state, age_gate_policy,
        created_at, updated_at, idempotency_key
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6,
        ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
        ?15, ?16, ?17, ?18, ?19, ?20,
        ?21, ?22, NULL, ?23, ?24,
        ?25, ?25, ?26
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
      input.body.flair_id ?? null,
      postType,
      status,
      input.body.song_mode ?? null,
      input.body.title ?? null,
      input.body.body ?? null,
      input.body.caption ?? null,
      input.body.link_url ?? null,
      mediaRefsJson,
      sourceLanguage,
      translationPolicy,
      input.body.rights_basis ?? "none",
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

export async function getPostById(client: Client, postId: string): Promise<Post | null> {
  const row = await firstRow(
    client,
    `
      SELECT post_id, community_id, author_user_id, identity_mode, anonymous_scope, anonymous_label,
             disclosed_qualifiers_json, flair_id, post_type, status, title, body, caption, link_url,
             media_refs_json, source_language, translation_policy, asset_id, parent_post_id, song_mode,
             rights_basis, analysis_state, analysis_result_ref, content_safety_state, age_gate_policy,
             idempotency_key, created_at, updated_at
      FROM posts
      WHERE post_id = ?1
      LIMIT 1
    `,
    [postId],
  )

  return row ? serializePost(toPostRow(row)) : null
}

export async function listPublishedLocalizedPosts(input: {
  client: Client
  communityId: string
  viewerUserId: string
  limit: number
  locale?: string
  flairId?: string | null
  cursor?: { createdAt: string; postId: string } | null
}): Promise<{ items: LocalizedPostResponse[]; nextCursor: { createdAt: string; postId: string } | null }> {
  const result = await input.client.execute({
    sql: `
      SELECT post_id, community_id, author_user_id, identity_mode, anonymous_scope, anonymous_label,
             disclosed_qualifiers_json, flair_id, post_type, status, title, body, caption, link_url,
             media_refs_json, source_language, translation_policy, asset_id, parent_post_id, song_mode,
             rights_basis, analysis_state, analysis_result_ref, content_safety_state, age_gate_policy,
             idempotency_key, created_at, updated_at,
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
        AND (?3 IS NULL OR flair_id = ?3)
        AND (
          ?4 IS NULL
          OR created_at < ?4
          OR (created_at = ?4 AND post_id < ?5)
        )
      ORDER BY created_at DESC, post_id DESC
      LIMIT ?6
    `,
    args: [
      input.communityId,
      input.viewerUserId,
      input.flairId ?? null,
      input.cursor?.createdAt ?? null,
      input.cursor?.postId ?? null,
      input.limit + 1,
    ],
  })

  const rows = result.rows
  const pageRows = rows.slice(0, input.limit)
  const items = pageRows.map((row) => {
    const post = serializePost(toPostRow(row))
    return {
      ...toLocalizedPostResponse(post, input.locale),
      upvote_count: requiredNumber(row, "upvote_count"),
      downvote_count: requiredNumber(row, "downvote_count"),
      like_count: requiredNumber(row, "like_count"),
      viewer_vote: numberOrNull(rowValue(row, "viewer_vote")) as -1 | 1 | null,
    }
  })

  const overflowRow = rows.length > input.limit ? rows[input.limit] : null
  const nextCursor = overflowRow
    ? {
        createdAt: requiredString(overflowRow, "created_at"),
        postId: requiredString(overflowRow, "post_id"),
      }
    : null

  return { items, nextCursor }
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

export function toLocalizedPostResponse(post: Post, locale?: string): LocalizedPostResponse {
  return {
    post,
    flair: null,
    upvote_count: 0,
    downvote_count: 0,
    like_count: 0,
    viewer_vote: null,
    viewer_reaction_kinds: [],
    resolved_locale: locale?.trim() || "en",
    translation_state: "same_language",
    machine_translated: false,
    source_hash: post.post_id,
    translated_body: null,
  }
}

export function assertPostCreateRequest(body: CreatePostRequest, communityId: string): void {
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
  if (body.identity_mode === "anonymous" && !body.anonymous_scope) {
    throw badRequestError("anonymous_scope is required for anonymous posts")
  }
}
