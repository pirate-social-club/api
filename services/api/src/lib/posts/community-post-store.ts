import type { Client, InValue, Transaction } from "@libsql/client"
import { analysisBlockedError, badRequestError, internalError } from "../errors"
import { makeId } from "../helpers"
import { resolvePrePublishAnalysis, persistMediaAnalysisResult, type PrePublishAnalysisResult } from "./post-analysis"
import { numberOrNull, requiredNumber, requiredString, rowValue, stringOrNull } from "../sql-row"
import type { CreatePostRequest, LocalizedPostResponse, Post, Env } from "../../types"

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
  lyrics: string | null
  link_url: string | null
  media_refs_json: string | null
  song_artifact_bundle_id: string | null
  source_language: string | null
  translation_policy: Post["translation_policy"]
  asset_id: string | null
  parent_post_id: string | null
  song_mode: Post["song_mode"]
  rights_basis: Post["rights_basis"]
  upstream_asset_refs_json: string | null
  analysis_state: Post["analysis_state"]
  analysis_result_ref: string | null
  content_safety_state: Post["content_safety_state"]
  age_gate_policy: Post["age_gate_policy"]
  idempotency_key: string
  created_at: string
  updated_at: string
}

type PostExecutor = Pick<Client, "execute"> | Pick<Transaction, "execute">

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
    lyrics: stringOrNull(rowValue(row, "lyrics")),
    link_url: stringOrNull(rowValue(row, "link_url")),
    media_refs_json: stringOrNull(rowValue(row, "media_refs_json")),
    song_artifact_bundle_id: stringOrNull(rowValue(row, "song_artifact_bundle_id")),
    source_language: stringOrNull(rowValue(row, "source_language")),
    translation_policy: stringOrNull(rowValue(row, "translation_policy")) as Post["translation_policy"],
    asset_id: stringOrNull(rowValue(row, "asset_id")),
    parent_post_id: stringOrNull(rowValue(row, "parent_post_id")),
    song_mode: stringOrNull(rowValue(row, "song_mode")) as Post["song_mode"],
    rights_basis: stringOrNull(rowValue(row, "rights_basis")) as Post["rights_basis"],
    upstream_asset_refs_json: stringOrNull(rowValue(row, "upstream_asset_refs_json")),
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
  const post: Post = {
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
    lyrics: row.lyrics,
    link_url: row.link_url,
    media_refs: parseMediaRefs(row.media_refs_json),
    song_artifact_bundle_id: row.song_artifact_bundle_id,
    source_language: row.source_language,
    translation_policy: row.translation_policy,
    asset_id: row.asset_id,
    parent_post_id: row.parent_post_id,
    song_mode: row.song_mode,
    rights_basis: row.rights_basis,
    upstream_asset_refs: parseJsonArray<string>(row.upstream_asset_refs_json),
    analysis_state: row.analysis_state,
    analysis_result_ref: row.analysis_result_ref,
    content_safety_state: row.content_safety_state,
    age_gate_policy: row.age_gate_policy,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }

  return row.post_type === "song" ? { ...post, lyrics: row.lyrics } : post
}

async function firstRow(client: PostExecutor, sql: string, args: InValue[]): Promise<unknown | null> {
  const result = await client.execute({ sql, args })
  return result.rows[0] ?? null
}

function shouldCreatePrePublishModerationCase(result: PrePublishAnalysisResult): boolean {
  if (result.outcome !== "review_required") {
    return false
  }
  if (!result.policyReasonCode) {
    return true
  }
  if (result.policyReasonCode === "derivative_without_upstream_refs" || result.policyReasonCode === "duplicate_audio_hash") {
    return false
  }
  // ACRCloud-derived review holds are publish gates, not moderator queue work in v0.
  if (result.policyReasonCode.startsWith("acrcloud_")) {
    return false
  }
  return true
}

async function createPrePublishModerationCase(input: {
  client: PostExecutor
  communityId: string
  postId: string
  analysisResultRef: string
  analysis: PrePublishAnalysisResult
  createdAt: string
}): Promise<void> {
  const insertedCaseId = makeId("mcs")
  await input.client.execute({
    sql: `
      INSERT OR IGNORE INTO moderation_cases (
        moderation_case_id, community_id, post_id, status, queue_scope, priority, opened_by, created_at, updated_at, resolved_at
      ) VALUES (
        ?1, ?2, ?3, 'open', 'community', 'medium', 'platform_analysis', ?4, ?4, NULL
      )
    `,
    args: [insertedCaseId, input.communityId, input.postId, input.createdAt],
  })
  const moderationCaseRow = await firstRow(
    input.client,
    `
      SELECT moderation_case_id
      FROM moderation_cases
      WHERE community_id = ?1
        AND post_id = ?2
        AND status = 'open'
      LIMIT 1
    `,
    [input.communityId, input.postId],
  )
  const moderationCaseId = moderationCaseRow
    ? requiredString(moderationCaseRow, "moderation_case_id")
    : insertedCaseId

  const signalType = input.analysis.policyReasonCode ?? "review_required"
  const existingSignal = await firstRow(
    input.client,
    `
      SELECT moderation_signal_id
      FROM moderation_signals
      WHERE post_id = ?1
        AND analysis_result_ref = ?2
        AND signal_type = ?3
      LIMIT 1
    `,
    [input.postId, input.analysisResultRef, signalType],
  )
  if (existingSignal) {
    return
  }
  await input.client.execute({
    sql: `
      INSERT INTO moderation_signals (
        moderation_signal_id, community_id, post_id, moderation_case_id, analysis_result_ref, source,
        signal_type, severity, provider, provider_label, evidence_ref, created_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, 'platform_analysis',
        ?6, 'medium', 'pirate_local', ?7, NULL, ?8
      )
    `,
    args: [
      makeId("msg"),
      input.communityId,
      input.postId,
      moderationCaseId,
      input.analysisResultRef,
      signalType,
      input.analysis.policyReason ?? "Local moderation review",
      input.createdAt,
    ],
  })
}

export async function findPostByIdempotencyKey(input: {
  client: PostExecutor
  communityId: string
  authorUserId: string
  idempotencyKey: string
}): Promise<Post | null> {
  const row = await firstRow(
    input.client,
    `
      SELECT post_id, community_id, author_user_id, identity_mode, anonymous_scope, anonymous_label,
             disclosed_qualifiers_json, flair_id, post_type, status, title, body, caption, link_url,
             lyrics, media_refs_json, song_artifact_bundle_id, source_language, translation_policy, asset_id, parent_post_id, song_mode,
             rights_basis, upstream_asset_refs_json, analysis_state, analysis_result_ref, content_safety_state, age_gate_policy,
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

export async function hasUserCreatedPostType(input: {
  client: PostExecutor
  communityId: string
  authorUserId: string
  postType: Post["post_type"]
}): Promise<boolean> {
  const row = await firstRow(
    input.client,
    `
      SELECT 1
      FROM posts
      WHERE community_id = ?1
        AND author_user_id = ?2
        AND post_type = ?3
        AND status <> 'deleted'
      LIMIT 1
    `,
    [input.communityId, input.authorUserId, input.postType],
  )

  return row != null
}

export async function insertPost(input: {
  client: PostExecutor
  env: Env
  communityId: string
  authorUserId: string
  body: CreatePostRequest
  createdAt: string
  audioBytes?: Uint8Array | null
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
  const ageGatePolicy: "none" | "18_plus" =
    "age_gate_policy" in input.body && input.body.age_gate_policy === "18_plus"
      ? "18_plus"
      : "none"
  const idempotencyKey = input.body.idempotency_key?.trim() ?? ""
  const upstreamAssetRefsJson = input.body.upstream_asset_refs && input.body.upstream_asset_refs.length > 0
    ? JSON.stringify(input.body.upstream_asset_refs)
    : null

  const analysis = await resolvePrePublishAnalysis({
    client: input.client,
    env: input.env,
    communityId: input.communityId,
    authorUserId: input.authorUserId,
    body: input.body,
    audioBytes: input.audioBytes,
  })
  const analysisState = analysis.outcome
  const contentSafetyState = analysis.contentSafetyState
  const status = analysis.status
  const sourceLanguage = input.body.body || input.body.title || input.body.caption || input.body.lyrics ? "en" : null

  if (analysis.outcome === "blocked") {
    throw analysisBlockedError(analysis.policyReason ?? "Post blocked by analysis")
  }

  await input.client.execute({
    sql: `
      INSERT INTO posts (
        post_id, community_id, author_user_id, identity_mode, anonymous_scope, anonymous_label,
        disclosed_qualifiers_json, flair_id, post_type, status, song_mode, title, body, caption,
        lyrics, link_url, media_refs_json, song_artifact_bundle_id, source_language, translation_policy, rights_basis, asset_id,
        parent_post_id, upstream_asset_refs_json, analysis_state, analysis_result_ref, content_safety_state, age_gate_policy,
        created_at, updated_at, idempotency_key
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6,
        ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
        ?15, ?16, ?17, ?18, ?19, ?20, ?21,
        ?22, ?23, ?24, ?25, ?26, ?27,
        ?28, ?29, ?30, ?31
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
      input.body.lyrics ?? null,
      input.body.link_url ?? null,
      mediaRefsJson,
      input.body.song_artifact_bundle_id ?? null,
      sourceLanguage,
      translationPolicy,
      input.body.rights_basis ?? "none",
      input.body.asset_id ?? null,
      input.body.parent_post_id ?? null,
      upstreamAssetRefsJson,
      analysisState,
      null,
      contentSafetyState,
      ageGatePolicy,
      input.createdAt,
      input.createdAt,
      idempotencyKey,
    ],
  })

  if (analysis.outcome !== "allow" || analysis.policyReasonCode) {
    const analysisResultRef = await persistMediaAnalysisResult({
      client: input.client,
      communityId: input.communityId,
      sourcePostId: postId,
      sourceAssetId: null,
      result: analysis,
      createdAt: input.createdAt,
    })
    await updatePostAnalysisResultRef({
      client: input.client,
      postId,
      analysisResultRef,
      updatedAt: input.createdAt,
    })
    if (shouldCreatePrePublishModerationCase(analysis)) {
      await createPrePublishModerationCase({
        client: input.client,
        communityId: input.communityId,
        postId,
        analysisResultRef,
        analysis,
        createdAt: input.createdAt,
      })
    }
  }

  const created = await getPostById(input.client, postId)
  if (!created) {
    throw internalError("Post row is missing after insert")
  }
  return created
}

export async function getPostById(client: PostExecutor, postId: string): Promise<Post | null> {
  const row = await firstRow(
    client,
    `
      SELECT post_id, community_id, author_user_id, identity_mode, anonymous_scope, anonymous_label,
             disclosed_qualifiers_json, flair_id, post_type, status, title, body, caption, link_url,
             lyrics, media_refs_json, song_artifact_bundle_id, source_language, translation_policy, asset_id, parent_post_id, song_mode,
             rights_basis, upstream_asset_refs_json, analysis_state, analysis_result_ref, content_safety_state, age_gate_policy,
             idempotency_key, created_at, updated_at
       FROM posts
       WHERE post_id = ?1
       LIMIT 1
    `,
    [postId],
  )

  return row ? serializePost(toPostRow(row)) : null
}

export async function getPostBySongArtifactBundleId(client: PostExecutor, bundleId: string): Promise<Post | null> {
  const row = await firstRow(
    client,
    `
      SELECT post_id, community_id, author_user_id, identity_mode, anonymous_scope, anonymous_label,
             disclosed_qualifiers_json, flair_id, post_type, status, title, body, caption, link_url,
             lyrics, media_refs_json, song_artifact_bundle_id, source_language, translation_policy, asset_id, parent_post_id, song_mode,
             rights_basis, upstream_asset_refs_json, analysis_state, analysis_result_ref, content_safety_state, age_gate_policy,
             idempotency_key, created_at, updated_at
       FROM posts
       WHERE song_artifact_bundle_id = ?1
        AND post_type = 'song'
      ORDER BY created_at DESC, post_id DESC
      LIMIT 1
    `,
    [bundleId],
  )

  return row ? serializePost(toPostRow(row)) : null
}

export async function updateSongPostModerationByBundleId(input: {
  client: PostExecutor
  bundleId: string
  status: Post["status"]
  analysisState: Post["analysis_state"]
  contentSafetyState: Post["content_safety_state"]
  ageGatePolicy: Post["age_gate_policy"]
  updatedAt: string
  forceOverwrite?: boolean
}): Promise<{ post: Post | null; updated: boolean }> {
  const current = await getPostBySongArtifactBundleId(input.client, input.bundleId)
  if (!current) {
    return { post: null, updated: false }
  }
  const alreadyModerated = current.analysis_state === "review_required" || current.analysis_state === "blocked"
  if (!input.forceOverwrite && alreadyModerated) {
    // Song posts can carry a pre-publish analysis result before async enrichment runs.
    // Allow the first async moderation write to replace that provisional state, but do
    // not overwrite a post once it already reflects a moderation outcome.
    return { post: current, updated: false }
  }

  await input.client.execute({
    sql: `
      UPDATE posts
      SET status = ?2,
          analysis_state = ?3,
          content_safety_state = ?4,
          age_gate_policy = ?5,
          updated_at = ?6
      WHERE song_artifact_bundle_id = ?1
        AND post_type = 'song'
    `,
    args: [
      input.bundleId,
      input.status,
      input.analysisState,
      input.contentSafetyState,
      input.ageGatePolicy,
      input.updatedAt,
    ],
  })

  return {
    post: await getPostBySongArtifactBundleId(input.client, input.bundleId),
    updated: true,
  }
}

export async function updatePostAssetId(input: {
  client: PostExecutor
  postId: string
  assetId: string
  updatedAt: string
}): Promise<Post | null> {
  await input.client.execute({
    sql: `
      UPDATE posts
      SET asset_id = ?2,
          updated_at = ?3
      WHERE post_id = ?1
    `,
    args: [input.postId, input.assetId, input.updatedAt],
  })

  return await getPostById(input.client, input.postId)
}

export async function deletePostById(input: {
  client: PostExecutor
  postId: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      DELETE FROM posts
      WHERE post_id = ?1
    `,
    args: [input.postId],
  })
}

export async function listRecentPostsForProjectionReconcile(input: {
  client: Client
  limit: number
}): Promise<Post[]> {
  const result = await input.client.execute({
    sql: `
      SELECT post_id, community_id, author_user_id, identity_mode, anonymous_scope, anonymous_label,
             disclosed_qualifiers_json, flair_id, post_type, status, title, body, caption, link_url,
             lyrics, media_refs_json, song_artifact_bundle_id, source_language, translation_policy, asset_id, parent_post_id, song_mode,
             rights_basis, upstream_asset_refs_json, analysis_state, analysis_result_ref, content_safety_state, age_gate_policy,
             idempotency_key, created_at, updated_at
      FROM posts
      ORDER BY updated_at DESC, post_id DESC
      LIMIT ?1
    `,
    args: [Math.max(1, Math.trunc(input.limit))],
  })

  return result.rows.map((row) => serializePost(toPostRow(row)))
}

export async function getLocalizedFeedItemByPostId(input: {
  client: Client
  postId: string
  viewerUserId?: string | null
  locale?: string
}): Promise<LocalizedPostResponse | null> {
  const row = await firstRow(
    input.client,
    `
      SELECT post_id, community_id, author_user_id, identity_mode, anonymous_scope, anonymous_label,
             disclosed_qualifiers_json, flair_id, post_type, status, title, body, caption, link_url,
             lyrics, media_refs_json, song_artifact_bundle_id, source_language, translation_policy, asset_id, parent_post_id, song_mode,
             rights_basis, upstream_asset_refs_json, analysis_state, analysis_result_ref, content_safety_state, age_gate_policy,
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
      WHERE post_id = ?1
        AND status = 'published'
      LIMIT 1
    `,
    [input.postId, input.viewerUserId ?? null],
  )

  if (!row) {
    return null
  }

  const post = serializePost(toPostRow(row))
  return {
    ...toLocalizedPostResponse(post, input.locale),
    upvote_count: requiredNumber(row, "upvote_count"),
    downvote_count: requiredNumber(row, "downvote_count"),
    like_count: requiredNumber(row, "like_count"),
    viewer_vote: numberOrNull(rowValue(row, "viewer_vote")) as -1 | 1 | null,
  }
}

export async function listPublishedLocalizedPosts(input: {
  client: Client
  communityId: string
  viewerUserId?: string | null
  limit: number
  locale?: string
  flairId?: string | null
  cursor?: { createdAt: string; postId: string } | null
}): Promise<{ items: LocalizedPostResponse[]; nextCursor: { createdAt: string; postId: string } | null }> {
  const result = await input.client.execute({
    sql: `
      SELECT post_id, community_id, author_user_id, identity_mode, anonymous_scope, anonymous_label,
             disclosed_qualifiers_json, flair_id, post_type, status, title, body, caption, link_url,
             lyrics, media_refs_json, song_artifact_bundle_id, source_language, translation_policy, asset_id, parent_post_id, song_mode,
             rights_basis, upstream_asset_refs_json, analysis_state, analysis_result_ref, content_safety_state, age_gate_policy,
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
      input.viewerUserId ?? null,
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
  if (body.post_type !== "song" && body.song_artifact_bundle_id) {
    throw badRequestError("song_artifact_bundle_id is only allowed for song posts")
  }
  if (body.post_type !== "song" && "access_mode" in body && body.access_mode !== undefined) {
    throw badRequestError("access_mode is only allowed for song posts")
  }
  if (body.identity_mode === "anonymous" && !body.anonymous_scope) {
    throw badRequestError("anonymous_scope is required for anonymous posts")
  }
  if (
    body.post_type === "song"
    && "access_mode" in body
    && body.access_mode !== undefined
    && body.access_mode !== "public"
    && body.access_mode !== "locked"
  ) {
    throw badRequestError("song access_mode must be public or locked")
  }
  if (body.post_type === "song" && body.identity_mode !== undefined && body.identity_mode !== "public") {
    throw badRequestError("song posts must use public identity")
  }
  if (body.post_type === "song" && body.access_mode === "locked" && !body.song_artifact_bundle_id) {
    throw badRequestError("locked song posts require song_artifact_bundle_id")
  }
  if (body.post_type === "song" && body.song_artifact_bundle_id && body.lyrics?.trim()) {
    throw badRequestError("lyrics must not be provided when song_artifact_bundle_id is used")
  }
  if (body.post_type === "song" && body.song_artifact_bundle_id && body.media_refs && body.media_refs.length > 0) {
    throw badRequestError("media_refs must not be provided when song_artifact_bundle_id is used")
  }
  if (body.post_type === "song" && !body.song_artifact_bundle_id && !body.lyrics?.trim()) {
    throw badRequestError("lyrics are required for song posts")
  }
  if (body.post_type === "song" && !body.song_artifact_bundle_id && (!body.media_refs || body.media_refs.length === 0)) {
    throw badRequestError("song posts require at least one audio media_ref")
  }
  if (
    body.post_type === "song"
    && body.song_mode === "remix"
    && body.rights_basis !== "derivative"
  ) {
    throw badRequestError("song remix posts must use rights_basis = derivative")
  }
  if (
    body.post_type === "song"
    && (body.rights_basis === "derivative" || body.song_mode === "remix")
    && (!body.upstream_asset_refs || body.upstream_asset_refs.length === 0)
  ) {
    throw badRequestError("Derivative/remix song posts must provide at least one upstream_asset_ref")
  }
}

export async function addUpstreamAssetRefsToPost(input: {
  client: PostExecutor
  postId: string
  upstreamAssetRefs: string[]
  updatedAt: string
}): Promise<Post | null> {
  if (input.upstreamAssetRefs.length === 0) return null
  await input.client.execute({
    sql: `
      UPDATE posts
      SET upstream_asset_refs_json = ?2,
          rights_basis = CASE
            WHEN rights_basis IN ('none', 'original') THEN 'derivative'
            ELSE rights_basis
          END,
          updated_at = ?3
      WHERE post_id = ?1
    `,
    args: [input.postId, JSON.stringify(input.upstreamAssetRefs), input.updatedAt],
  })
  return await getPostById(input.client, input.postId)
}

export async function transitionPostToPublished(input: {
  client: PostExecutor
  postId: string
  updatedAt: string
}): Promise<Post | null> {
  await input.client.execute({
    sql: `
      UPDATE posts
      SET status = 'published',
          analysis_state = 'allow',
          updated_at = ?2
      WHERE post_id = ?1
        AND analysis_state = 'allow_with_required_reference'
        AND upstream_asset_refs_json IS NOT NULL
    `,
    args: [input.postId, input.updatedAt],
  })
  return await getPostById(input.client, input.postId)
}

export async function updatePostAnalysisResultRef(input: {
  client: PostExecutor
  postId: string
  analysisResultRef: string
  updatedAt: string
}): Promise<Post | null> {
  await input.client.execute({
    sql: `
      UPDATE posts
      SET analysis_result_ref = ?2,
          updated_at = ?3
      WHERE post_id = ?1
    `,
    args: [input.postId, input.analysisResultRef, input.updatedAt],
  })
  return await getPostById(input.client, input.postId)
}

export async function createRightsReviewCase(input: {
  client: PostExecutor
  communityId: string
  subjectType: "asset" | "live_room" | "replay_asset"
  subjectId: string
  triggerSource: "acrcloud_match" | "manual_report" | "operator_escalation"
  analysisResultRef: string | null
  createdAt: string
}): Promise<string> {
  const caseId = makeId("rrc")
  await input.client.execute({
    sql: `
      INSERT OR IGNORE INTO rights_review_cases (
        rights_review_case_id, subject_type, subject_id, community_id,
        status, trigger_source, analysis_result_ref,
        submitted_evidence_refs_json, resolution, resolver_user_id,
        created_at, updated_at, resolved_at
      ) VALUES (
        ?1, ?2, ?3, ?4,
        'open', ?5, ?6,
        NULL, NULL, NULL,
        ?7, ?7, NULL
      )
    `,
    args: [
      caseId,
      input.subjectType,
      input.subjectId,
      input.communityId,
      input.triggerSource,
      input.analysisResultRef,
      input.createdAt,
      ],
    })
  const existing = await firstRow(
    input.client,
    `
      SELECT rights_review_case_id
      FROM rights_review_cases
      WHERE subject_type = ?1
        AND subject_id = ?2
        AND trigger_source = ?3
        AND status IN ('open', 'under_review')
      ORDER BY created_at DESC, rights_review_case_id DESC
      LIMIT 1
    `,
    [input.subjectType, input.subjectId, input.triggerSource],
  )
  return existing ? requiredString(existing, "rights_review_case_id") : caseId
}
