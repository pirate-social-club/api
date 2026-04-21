import type { DbExecutor } from "../db-helpers"
import type { Client } from "../sql-client"
import { badRequestError, internalError } from "../errors"
import { executeFirst } from "../db-helpers"
import { makeId } from "../helpers"
import { isMissingColumnError } from "../auth/auth-db-query-helpers"
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
  authorship_mode: Post["authorship_mode"]
  agent_id: string | null
  agent_ownership_record_id: string | null
  identity_mode: Post["identity_mode"]
  anonymous_scope: Post["anonymous_scope"]
  anonymous_label: string | null
  agent_handle_snapshot: string | null
  agent_display_name_snapshot: string | null
  agent_owner_handle_snapshot: string | null
  agent_ownership_provider_snapshot: string | null
  disclosed_qualifiers_json: string | null
  label_id: string | null
  label_assignment_status: Post["label_assignment_status"]
  label_assigned_by: Post["label_assigned_by"]
  label_assigned_at: string | null
  label_ai_confidence: number | null
  label_assignment_error: string | null
  label_assignment_model: string | null
  label_assignment_result_json: string | null
  post_type: Post["post_type"]
  status: Post["status"]
  visibility: Post["visibility"]
  title: string | null
  body: string | null
  caption: string | null
  lyrics: string | null
  link_url: string | null
  link_og_image_url: string | null
  media_refs_json: string | null
  song_artifact_bundle_id: string | null
  source_language: string | null
  translation_policy: Post["translation_policy"]
  access_mode: Post["access_mode"]
  asset_id: string | null
  parent_post_id: string | null
  upstream_asset_refs_json: string | null
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

type LabelAssignmentResultJson = Post["label_assignment_result_json"]

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

function parseLabelAssignmentResult(value: string | null): LabelAssignmentResultJson {
  if (!value) {
    return null
  }

  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as LabelAssignmentResultJson
      : null
  } catch {
    return null
  }
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
    authorship_mode: requiredString(row, "authorship_mode") as Post["authorship_mode"],
    agent_id: stringOrNull(rowValue(row, "agent_id")),
    agent_ownership_record_id: stringOrNull(rowValue(row, "agent_ownership_record_id")),
    identity_mode: requiredString(row, "identity_mode") as Post["identity_mode"],
    anonymous_scope: stringOrNull(rowValue(row, "anonymous_scope")) as Post["anonymous_scope"],
    anonymous_label: stringOrNull(rowValue(row, "anonymous_label")),
    agent_handle_snapshot: stringOrNull(rowValue(row, "agent_handle_snapshot")),
    agent_display_name_snapshot: stringOrNull(rowValue(row, "agent_display_name_snapshot")),
    agent_owner_handle_snapshot: stringOrNull(rowValue(row, "agent_owner_handle_snapshot")),
    agent_ownership_provider_snapshot: stringOrNull(rowValue(row, "agent_ownership_provider_snapshot")),
    disclosed_qualifiers_json: stringOrNull(rowValue(row, "disclosed_qualifiers_json")),
    label_id: stringOrNull(rowValue(row, "label_id")),
    label_assignment_status: stringOrNull(rowValue(row, "label_assignment_status")) as Post["label_assignment_status"],
    label_assigned_by: stringOrNull(rowValue(row, "label_assigned_by")) as Post["label_assigned_by"],
    label_assigned_at: stringOrNull(rowValue(row, "label_assigned_at")),
    label_ai_confidence: numberOrNull(rowValue(row, "label_ai_confidence")),
    label_assignment_error: stringOrNull(rowValue(row, "label_assignment_error")),
    label_assignment_model: stringOrNull(rowValue(row, "label_assignment_model")),
    label_assignment_result_json: stringOrNull(rowValue(row, "label_assignment_result_json")),
    post_type: requiredString(row, "post_type") as Post["post_type"],
    status: requiredString(row, "status") as Post["status"],
    visibility: requiredString(row, "visibility") as Post["visibility"],
    title: stringOrNull(rowValue(row, "title")),
    body: stringOrNull(rowValue(row, "body")),
    caption: stringOrNull(rowValue(row, "caption")),
    lyrics: stringOrNull(rowValue(row, "lyrics")),
    link_url: stringOrNull(rowValue(row, "link_url")),
    link_og_image_url: stringOrNull(rowValue(row, "link_og_image_url")),
    media_refs_json: stringOrNull(rowValue(row, "media_refs_json")),
    song_artifact_bundle_id: stringOrNull(rowValue(row, "song_artifact_bundle_id")),
    source_language: stringOrNull(rowValue(row, "source_language")),
    translation_policy: stringOrNull(rowValue(row, "translation_policy")) as Post["translation_policy"],
    access_mode: stringOrNull(rowValue(row, "access_mode")) as Post["access_mode"],
    asset_id: stringOrNull(rowValue(row, "asset_id")),
    parent_post_id: stringOrNull(rowValue(row, "parent_post_id")),
    upstream_asset_refs_json: stringOrNull(rowValue(row, "upstream_asset_refs_json")),
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
    authorship_mode: row.authorship_mode,
    agent_id: row.agent_id,
    agent_ownership_record_id: row.agent_ownership_record_id,
    identity_mode: row.identity_mode,
    anonymous_scope: row.anonymous_scope,
    anonymous_label: row.anonymous_label,
    agent_handle_snapshot: row.agent_handle_snapshot,
    agent_display_name_snapshot: row.agent_display_name_snapshot,
    agent_owner_handle_snapshot: row.agent_owner_handle_snapshot,
    agent_ownership_provider_snapshot: row.agent_ownership_provider_snapshot,
    disclosed_qualifiers_json: parseDisclosedQualifiers(row.disclosed_qualifiers_json),
    label_id: row.label_id,
    label_assignment_status: row.label_assignment_status,
    label_assigned_by: row.label_assigned_by,
    label_assigned_at: row.label_assigned_at,
    label_ai_confidence: row.label_ai_confidence,
    label_assignment_error: row.label_assignment_error,
    label_assignment_model: row.label_assignment_model,
    label_assignment_result_json: parseLabelAssignmentResult(row.label_assignment_result_json),
    post_type: row.post_type,
    status: row.status,
    visibility: row.visibility,
    title: row.title,
    body: row.body,
    caption: row.caption,
    link_url: row.link_url,
    link_og_image_url: row.link_og_image_url,
    media_refs: parseMediaRefs(row.media_refs_json),
    song_artifact_bundle_id: row.song_artifact_bundle_id,
    source_language: row.source_language,
    translation_policy: row.translation_policy,
    access_mode: row.access_mode,
    asset_id: row.asset_id,
    parent_post_id: row.parent_post_id,
    upstream_asset_refs: parseJsonArray<string>(row.upstream_asset_refs_json) ?? undefined,
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
        SELECT post_id, community_id, author_user_id, authorship_mode, agent_id, agent_ownership_record_id,
               identity_mode, anonymous_scope, anonymous_label, agent_display_name_snapshot,
               agent_owner_handle_snapshot, agent_ownership_provider_snapshot, agent_handle_snapshot, disclosed_qualifiers_json,
               label_id, label_assignment_status, label_assigned_by, label_assigned_at, label_ai_confidence,
               label_assignment_error, label_assignment_model, label_assignment_result_json,
               post_type, status, visibility, title, body, caption, lyrics,
               link_url, link_og_image_url, media_refs_json, song_artifact_bundle_id, source_language, translation_policy,
               access_mode, asset_id, parent_post_id, upstream_asset_refs_json, song_mode, rights_basis, analysis_state, analysis_result_ref,
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
  agentWriteAuthorization?: {
    agentId: string
    agentOwnershipRecordId: string
    agentHandleSnapshot: string
    agentDisplayNameSnapshot: string
    agentOwnerHandleSnapshot: string
    agentOwnershipProviderSnapshot: NonNullable<Post["agent_ownership_provider_snapshot"]>
  }
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
  const upstreamAssetRefsJson = input.body.upstream_asset_refs ? JSON.stringify(input.body.upstream_asset_refs) : null
  const translationPolicy = input.body.translation_policy ?? "none"
  const visibility = input.body.visibility ?? "public"
  const idempotencyKey = input.body.idempotency_key?.trim() ?? ""
  const title = postType === "link" ? null : input.body.title ?? null
  const labelAssignmentStatus: NonNullable<Post["label_assignment_status"]> = input.body.label_id ? "assigned" : "pending"
  const labelAssignedAt = input.body.label_id ? input.createdAt : null
  const stubAnalysis = resolveStubAnalysisOutcome(input.body)
  const analysisState = input.analysisOverride?.analysis_state ?? stubAnalysis.analysis_state
  const contentSafetyState = input.analysisOverride?.content_safety_state ?? stubAnalysis.content_safety_state
  const status = input.analysisOverride?.status ?? stubAnalysis.status
  const ageGatePolicy = input.analysisOverride?.age_gate_policy ?? "none"
  const sourceLanguage = detectSourceLanguageFromText([
    title,
    input.body.body,
    input.body.caption,
    input.body.lyrics,
  ])

  await input.client.execute({
    sql: `
      INSERT INTO posts (
        post_id, community_id, author_user_id, authorship_mode, agent_id, agent_ownership_record_id,
        identity_mode, anonymous_scope, anonymous_label, agent_display_name_snapshot, agent_owner_handle_snapshot,
        agent_ownership_provider_snapshot, disclosed_qualifiers_json, label_id, label_assignment_status,
        label_assigned_by, label_assigned_at, label_ai_confidence, label_assignment_error, label_assignment_model,
        label_assignment_result_json, post_type, status, song_mode, title, body, caption, visibility, lyrics,
        link_url, media_refs_json, song_artifact_bundle_id, source_language, translation_policy, rights_basis,
        access_mode, asset_id, parent_post_id, upstream_asset_refs_json, analysis_state, analysis_result_ref, content_safety_state,
        age_gate_policy, created_at, updated_at, idempotency_key, agent_handle_snapshot
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6,
        ?7, ?8, ?9, ?10, ?11, ?12,
        ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22,
        ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32,
        ?33, ?34, ?35, ?36, ?37, ?38, ?39, ?40, NULL, ?41,
        ?42, ?43, ?43, ?44, ?45
      )
    `,
    args: [
      postId,
      input.communityId,
      input.authorUserId,
      input.body.authorship_mode ?? "human_direct",
      input.agentWriteAuthorization?.agentId ?? null,
      input.agentWriteAuthorization?.agentOwnershipRecordId ?? null,
      identityMode,
      anonymousScope,
      anonymousLabel,
      input.agentWriteAuthorization?.agentDisplayNameSnapshot ?? null,
      input.agentWriteAuthorization?.agentOwnerHandleSnapshot ?? null,
      input.agentWriteAuthorization?.agentOwnershipProviderSnapshot ?? null,
      disclosedQualifiersJson,
      input.body.label_id ?? null,
      labelAssignmentStatus,
      null,
      labelAssignedAt,
      null,
      null,
      null,
      null,
      postType,
      status,
      input.body.song_mode ?? null,
      title,
      input.body.body ?? null,
      input.body.caption ?? null,
      visibility,
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
      upstreamAssetRefsJson,
      analysisState,
      contentSafetyState,
      ageGatePolicy,
      input.createdAt,
      idempotencyKey,
      input.agentWriteAuthorization?.agentHandleSnapshot ?? null,
    ],
  })

  const created = await getPostById(input.client, postId)
  if (!created) {
    throw internalError("Post row is missing after insert")
  }
  return created
}

export async function getPostById(client: DbExecutor, postId: string): Promise<Post | null> {
  const stmtWithVisibility = {
    sql: `
      SELECT post_id, community_id, author_user_id, authorship_mode, agent_id, agent_ownership_record_id,
             identity_mode, anonymous_scope, anonymous_label, agent_display_name_snapshot,
             agent_owner_handle_snapshot, agent_ownership_provider_snapshot, agent_handle_snapshot, disclosed_qualifiers_json,
             label_id, label_assignment_status, label_assigned_by, label_assigned_at, label_ai_confidence,
             label_assignment_error, label_assignment_model, label_assignment_result_json,
             post_type, status, visibility, title, body, caption, lyrics,
             link_url, link_og_image_url, media_refs_json, song_artifact_bundle_id, source_language, translation_policy,
             access_mode, asset_id, parent_post_id, upstream_asset_refs_json, song_mode, rights_basis, analysis_state, analysis_result_ref,
             content_safety_state, age_gate_policy, idempotency_key, created_at, updated_at
      FROM posts
      WHERE post_id = ?1
      LIMIT 1
    `,
    args: [postId],
  }

  const row = await executeFirst(client, stmtWithVisibility).catch(async (error) => {
    if (!isMissingColumnError(error, "visibility")) {
      throw error
    }

    return executeFirst(client, {
      sql: `
        SELECT post_id, community_id, author_user_id, authorship_mode, agent_id, agent_ownership_record_id,
               identity_mode, anonymous_scope, anonymous_label, agent_display_name_snapshot,
               agent_owner_handle_snapshot, agent_ownership_provider_snapshot, agent_handle_snapshot, disclosed_qualifiers_json,
               label_id, label_assignment_status, label_assigned_by, label_assigned_at, label_ai_confidence,
               label_assignment_error, label_assignment_model, label_assignment_result_json,
               post_type, status, 'public' AS visibility, title, body, caption, lyrics,
               link_url, NULL AS link_og_image_url, media_refs_json, song_artifact_bundle_id, source_language, translation_policy,
               access_mode, asset_id, parent_post_id, upstream_asset_refs_json, song_mode, rights_basis, analysis_state, analysis_result_ref,
               content_safety_state, age_gate_policy, idempotency_key, created_at, updated_at
        FROM posts
        WHERE post_id = ?1
        LIMIT 1
      `,
      args: [postId],
    })
  })

  return row ? serializePost(toPostRow(row)) : null
}

export async function updatePostLinkOgImageUrl(input: {
  client: DbExecutor
  postId: string
  linkOgImageUrl: string | null
  updatedAt: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      UPDATE posts
      SET link_og_image_url = ?2,
          updated_at = ?3
      WHERE post_id = ?1
        AND post_type = 'link'
    `,
    args: [
      input.postId,
      input.linkOgImageUrl,
      input.updatedAt,
    ],
  })
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

type PublishedLocalizedPostFeedItem = {
  post: Post
  upvote_count: number
  downvote_count: number
  comment_count: number
  like_count: number
  viewer_vote: -1 | 1 | null
}

function getFeedItemCreatedAtMs(item: {
  post: Post
}): number {
  const timestamp = Date.parse(item.post.created_at)
  return Number.isNaN(timestamp) ? 0 : timestamp
}

function getFeedItemEngagementScore(item: Pick<PublishedLocalizedPostFeedItem, "comment_count" | "downvote_count" | "like_count" | "upvote_count">): number {
  return getFeedItemScore(item) * 3 + item.comment_count * 2 + item.like_count
}

function getFeedItemRichnessScore(item: Pick<PublishedLocalizedPostFeedItem, "post">): number {
  return (item.post.title ?? "").trim().length * 2
    + (item.post.body ?? "").trim().length
    + (item.post.caption ?? "").trim().length
    + (item.post.media_refs?.length ?? 0) * 120
}

function getBestFeedRank(item: PublishedLocalizedPostFeedItem, now: number): number {
  const ageHours = Math.max(0, (now - getFeedItemCreatedAtMs(item)) / 3_600_000)
  return (getFeedItemEngagementScore(item) + getFeedItemRichnessScore(item) * 0.05) / Math.pow(ageHours + 2, 1.5)
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
  visibility?: Post["visibility"] | null
}): Promise<{
  items: PublishedLocalizedPostFeedItem[]
  nextCursor: string | null
}> {
  const newCursorParts = input.sort === "new" && input.cursor ? input.cursor.split("|") : null
  const createdAtCursor = newCursorParts?.[0] ?? null
  const postIdCursor = newCursorParts?.[1] ?? null
  const result = await input.client.execute({
    sql: `
      SELECT post_id, community_id, author_user_id, authorship_mode, agent_id, agent_ownership_record_id,
             identity_mode, anonymous_scope, anonymous_label, agent_display_name_snapshot,
             agent_owner_handle_snapshot, agent_ownership_provider_snapshot, agent_handle_snapshot, disclosed_qualifiers_json,
             label_id, label_assignment_status, label_assigned_by, label_assigned_at, label_ai_confidence,
             label_assignment_error, label_assignment_model, label_assignment_result_json,
             post_type, status, visibility, title, body, caption, lyrics,
             link_url, link_og_image_url, media_refs_json, song_artifact_bundle_id, source_language, translation_policy,
             access_mode, asset_id, parent_post_id, upstream_asset_refs_json, song_mode, rights_basis, analysis_state, analysis_result_ref,
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
               SELECT COUNT(*)
               FROM comments
               WHERE thread_root_post_id = posts.post_id
                 AND status = 'published'
             ) AS comment_count,
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
        AND (?4 IS NULL OR visibility = ?4)
        AND (
          ?5 = 0
          OR ?6 IS NULL
          OR created_at < ?6
          OR (created_at = ?6 AND post_id < ?7)
        )
      ORDER BY created_at DESC, post_id DESC
      LIMIT ?8
    `,
    args: [
      input.communityId,
      input.viewerUserId,
      input.flairId ?? null,
      input.visibility ?? null,
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
      comment_count: requiredNumber(row, "comment_count"),
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

  const sortedItems = sortPublishedLocalizedPostFeedItems(items, input.sort)

  const offset = parseOffsetCursor(input.cursor)
  const pageItems = sortedItems.slice(offset, offset + input.limit)
  const nextCursor = offset + input.limit < sortedItems.length ? `o:${offset + input.limit}` : null

  return { items: pageItems, nextCursor }
}

export function sortPublishedLocalizedPostFeedItems(
  items: readonly PublishedLocalizedPostFeedItem[],
  sort: "best" | "new" | "top",
  now = Date.now(),
): PublishedLocalizedPostFeedItem[] {
  return [...items].sort((left, right) => {
    if (sort === "new") {
      const createdAtDiff = getFeedItemCreatedAtMs(right) - getFeedItemCreatedAtMs(left)
      if (createdAtDiff !== 0) {
        return createdAtDiff
      }
      return right.post.post_id.localeCompare(left.post.post_id)
    }

    if (sort === "top") {
      const engagementDiff = getFeedItemEngagementScore(right) - getFeedItemEngagementScore(left)
      if (engagementDiff !== 0) {
        return engagementDiff
      }

      const richnessDiff = getFeedItemRichnessScore(right) - getFeedItemRichnessScore(left)
      if (richnessDiff !== 0) {
        return richnessDiff
      }
    } else {
      const rankDiff = getBestFeedRank(right, now) - getBestFeedRank(left, now)
      if (rankDiff !== 0) {
        return rankDiff
      }

      const richnessDiff = getFeedItemRichnessScore(right) - getFeedItemRichnessScore(left)
      if (richnessDiff !== 0) {
        return richnessDiff
      }
    }

    const createdAtDiff = getFeedItemCreatedAtMs(right) - getFeedItemCreatedAtMs(left)
    if (createdAtDiff !== 0) {
      return createdAtDiff
    }
    return right.post.post_id.localeCompare(left.post.post_id)
  })
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

export async function updatePostLabelAssignment(input: {
  executor: DbExecutor
  postId: string
  labelId: string | null
  assignmentStatus: NonNullable<Post["label_assignment_status"]>
  assignedBy?: Post["label_assigned_by"]
  assignedAt?: string | null
  aiConfidence?: number | null
  assignmentError?: string | null
  assignmentModel?: string | null
  assignmentResultJson?: string | null
  now: string
}): Promise<void> {
  await input.executor.execute({
    sql: `
      UPDATE posts
      SET label_id = ?2,
          label_assignment_status = ?3,
          label_assigned_by = ?4,
          label_assigned_at = ?5,
          label_ai_confidence = ?6,
          label_assignment_error = ?7,
          label_assignment_model = ?8,
          label_assignment_result_json = ?9,
          updated_at = ?10
      WHERE post_id = ?1
    `,
    args: [
      input.postId,
      input.labelId,
      input.assignmentStatus,
      input.assignedBy ?? null,
      input.assignedAt ?? null,
      input.aiConfidence ?? null,
      input.assignmentError ?? null,
      input.assignmentModel ?? null,
      input.assignmentResultJson ?? null,
      input.now,
    ],
  })
}

export function assertPostCreateRequest(body: CreatePostRequest, _communityId: string): void {
  const authorshipMode = body.authorship_mode ?? "human_direct"
  if (Object.prototype.hasOwnProperty.call(body, "community_id")) {
    throw badRequestError("community_id must not be provided in the post body")
  }
  if (!body.post_type) {
    throw badRequestError("post_type is required")
  }
  if (body.post_type === "link" && !body.link_url?.trim()) {
    throw badRequestError("link_url is required for link posts")
  }
  if (body.post_type === "link" && body.title != null) {
    throw badRequestError("title is not allowed for link posts")
  }
  if (body.visibility && body.visibility !== "public" && body.visibility !== "members_only") {
    throw badRequestError("visibility must be public or members_only")
  }
  if (body.post_type !== "link" && body.link_url) {
    throw badRequestError("link_url is only allowed for link posts")
  }
  if (authorshipMode !== "user_agent" && body.agent_id) {
    throw badRequestError("agent_id is only allowed when authorship_mode = user_agent")
  }
  if (authorshipMode !== "user_agent" && body.agent_action_proof) {
    throw badRequestError("agent_action_proof is only allowed when authorship_mode = user_agent")
  }
  if (authorshipMode === "user_agent" && !body.agent_id?.trim()) {
    throw badRequestError("agent_id is required when authorship_mode = user_agent")
  }
  if (authorshipMode === "user_agent" && !body.agent_action_proof) {
    throw badRequestError("agent_action_proof is required when authorship_mode = user_agent")
  }
  if (authorshipMode === "user_agent" && (body.identity_mode ?? "public") !== "public") {
    throw badRequestError("user_agent posts must use public identity")
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
