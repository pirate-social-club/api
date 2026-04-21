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
import { requiredNumber, rowValue, stringOrNull } from "../sql-row"
import { serializePost, toPostRow } from "./community-post-serialization"
import type { CreatePostRequest, Post } from "../../types"

export {
  listPublishedLocalizedPosts,
  sortPublishedLocalizedPostFeedItems,
  type PublishedLocalizedPostFeedItem,
} from "./community-post-feed"

type CommunityPostPolicy = {
  allow_anonymous_identity: boolean
  anonymous_identity_scope: Post["anonymous_scope"]
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
               link_url, link_og_image_url, link_og_title, media_refs_json, song_artifact_bundle_id, source_language, translation_policy,
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
             link_url, link_og_image_url, link_og_title, media_refs_json, song_artifact_bundle_id, source_language, translation_policy,
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
               link_url, NULL AS link_og_image_url, NULL AS link_og_title, media_refs_json, song_artifact_bundle_id, source_language, translation_policy,
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

export async function updatePostLinkPreviewMetadata(input: {
  client: DbExecutor
  postId: string
  linkOgImageUrl: string | null
  linkOgTitle: string | null
  updatedAt: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      UPDATE posts
      SET link_og_image_url = ?2,
          link_og_title = ?3,
          updated_at = ?4
      WHERE post_id = ?1
        AND post_type = 'link'
    `,
    args: [
      input.postId,
      input.linkOgImageUrl,
      input.linkOgTitle,
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
