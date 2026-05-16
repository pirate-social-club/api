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
import { numberOrNull, requiredNumber, rowValue, stringOrNull } from "../sql-row"
import {
  boundedPostJsonProjection,
  OVERSIZED_LINK_ENRICHMENT_SNAPSHOT_JSON,
  POST_SELECT_COLUMNS,
  serializePost,
  toPostRow,
} from "./community-post-serialization"
import type { CreatePostRequest, Post } from "../../types"
import { decodePublicSongArtifactBundleId } from "../public-ids"

type StoryLicensePreset = NonNullable<CreatePostRequest["license_preset"]>
type PostWriteRequest = CreatePostRequest & {
  song_cover_art_ref?: string | null
  song_duration_ms?: number | null
  song_title?: string | null
}

function isStoryLicensePreset(value: unknown): value is StoryLicensePreset {
  return value === "non-commercial" || value === "commercial-use" || value === "commercial-remix"
}

function validateOriginalAssetLicense(input: {
  body: PostWriteRequest
  contentLabel: string
  requireLicense: boolean
}): void {
  if (input.requireLicense && !isStoryLicensePreset(input.body.license_preset)) {
    throw badRequestError(`license_preset is required for original ${input.contentLabel} posts`)
  }

  if (input.body.license_preset != null && !isStoryLicensePreset(input.body.license_preset)) {
    throw badRequestError(`license_preset is required for original ${input.contentLabel} posts`)
  }

  if (input.body.license_preset === "commercial-remix") {
    const revSharePct = input.body.commercial_rev_share_pct
    if (
      typeof revSharePct !== "number"
      || !Number.isInteger(revSharePct)
      || revSharePct < 0
      || revSharePct > 100
    ) {
      throw badRequestError("commercial_rev_share_pct must be an integer from 0 to 100 for commercial-remix")
    }
  } else if (input.body.commercial_rev_share_pct != null) {
    throw badRequestError("commercial_rev_share_pct is only supported for commercial-remix")
  }
}

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
  const row = await executeFirst(input.client, {
    sql: `
      SELECT ${POST_SELECT_COLUMNS}
      FROM posts
      WHERE community_id = ?1
        AND author_user_id = ?2
        AND idempotency_key = ?3
      LIMIT 1
    `,
    args: [input.communityId, input.authorUserId, input.idempotencyKey],
  })

  return row ? serializePost(toPostRow(row)) : null
}

export async function insertPost(input: {
  client: DbExecutor
  communityId: string
  authorUserId: string
  body: PostWriteRequest
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
  const mediaRefsJson = boundedPostJsonProjection(input.body.media_refs ? JSON.stringify(input.body.media_refs) : null)
  const crosspostSourceJson = boundedPostJsonProjection(input.body.crosspost_source
    ? JSON.stringify({
        version: 1,
        source_post_id: input.body.crosspost_source.post_id,
        source_community_id: input.body.crosspost_source.community_id,
        captured_at: input.body.crosspost_source.captured_at ?? input.createdAt,
      })
    : null)
  const upstreamAssetRefsJson = boundedPostJsonProjection(
    input.body.upstream_asset_refs ? JSON.stringify(input.body.upstream_asset_refs) : null,
  )
  const translationPolicy = input.body.translation_policy ?? "none"
  const visibility = input.body.visibility ?? "public"
  const idempotencyKey = input.body.idempotency_key?.trim() ?? ""
  const title = input.body.title ?? null
  const labelAssignmentStatus: NonNullable<Post["label_assignment_status"]> = input.body.label_id ? "assigned" : "pending"
  const labelAssignedAt = input.body.label_id ? input.createdAt : null
  const analysisState = input.analysisOverride?.analysis_state ?? "allow"
  const contentSafetyState = input.analysisOverride?.content_safety_state ?? "safe"
  const status = input.analysisOverride?.status ?? "published"
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
        label_assignment_result_json, post_type, status, song_mode, title, song_title, song_cover_art_ref, song_duration_ms,
        body, caption, visibility, lyrics, link_url, media_refs_json, song_artifact_bundle_id, source_language, translation_policy, rights_basis,
        access_mode, asset_id, parent_post_id, crosspost_source_json, upstream_asset_refs_json, analysis_state, analysis_result_ref, content_safety_state,
        age_gate_policy, created_at, updated_at, idempotency_key, agent_handle_snapshot
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6,
        ?7, ?8, ?9, ?10, ?11, ?12,
        ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22,
        ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32,
        ?33, ?34, ?35, ?36, ?37, ?38, ?39, ?40, ?41, ?42,
        ?43, ?44, NULL, ?45, ?46, ?47, ?47, ?48, ?49
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
      input.body.song_title ?? null,
      input.body.song_cover_art_ref ?? null,
      input.body.song_duration_ms ?? null,
      input.body.body ?? null,
      input.body.caption ?? null,
      visibility,
      input.body.lyrics ?? null,
      input.body.link_url ?? null,
      mediaRefsJson,
      input.body.song_artifact_bundle ? decodePublicSongArtifactBundleId(input.body.song_artifact_bundle) : null,
      sourceLanguage,
      translationPolicy,
      input.body.rights_basis ?? "none",
      input.body.access_mode ?? (postType === "song" ? "public" : null),
      input.body.asset_id ?? null,
      input.body.parent_post_id ?? null,
      crosspostSourceJson,
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
  const row = await executeFirst(client, {
    sql: `
      SELECT ${POST_SELECT_COLUMNS}
      FROM posts
      WHERE post_id = ?1
      LIMIT 1
    `,
    args: [postId],
  })

  return row ? serializePost(toPostRow(row)) : null
}

export async function updatePostLinkPreviewMetadata(input: {
  client: DbExecutor
  postId: string
  linkOgImageUrl: string | null
  linkOgTitle: string | null
  linkEnrichmentSnapshotJson?: string | null
  linkEnrichmentSyncedAt?: string | null
  updatedAt: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      UPDATE posts
      SET link_og_image_url = ?2,
          link_og_title = ?3,
          link_enrichment_snapshot_json = COALESCE(?4, link_enrichment_snapshot_json),
          link_enrichment_synced_at = COALESCE(?5, link_enrichment_synced_at),
          updated_at = ?6
      WHERE post_id = ?1
        AND post_type = 'link'
    `,
    args: [
      input.postId,
      input.linkOgImageUrl,
      input.linkOgTitle,
      boundedPostJsonProjection(
        input.linkEnrichmentSnapshotJson,
        OVERSIZED_LINK_ENRICHMENT_SNAPSHOT_JSON,
      ),
      input.linkEnrichmentSyncedAt ?? null,
      input.updatedAt,
    ],
  })
}

export async function markPostDeleted(input: {
  executor: DbExecutor
  postId: string
  now: string
}): Promise<Post> {
  await input.executor.execute({
    sql: `
      UPDATE posts
      SET status = 'deleted',
          updated_at = ?2
      WHERE post_id = ?1
    `,
    args: [input.postId, input.now],
  })

  const updated = await getPostById(input.executor, input.postId)
  if (!updated) {
    throw internalError("Post row is missing after delete")
  }
  return updated
}

export async function setPostStatus(input: {
  executor: DbExecutor
  postId: string
  status: "published" | "hidden" | "removed"
  now: string
}): Promise<Post> {
  await input.executor.execute({
    sql: `
      UPDATE posts
      SET status = ?2,
          updated_at = ?3
      WHERE post_id = ?1
    `,
    args: [input.postId, input.status, input.now],
  })

  const updated = await getPostById(input.executor, input.postId)
  if (!updated) {
    throw internalError("Post row is missing after status update")
  }
  return updated
}

export async function setPostCommentsLocked(input: {
  executor: DbExecutor
  postId: string
  locked: boolean
  actorUserId: string
  reason: string | null
  now: string
}): Promise<Post> {
  await input.executor.execute({
    sql: `
      UPDATE posts
      SET comments_locked = ?2,
          comments_locked_at = CASE WHEN ?2 = 1 THEN ?3 ELSE NULL END,
          comments_locked_by_user_id = CASE WHEN ?2 = 1 THEN ?4 ELSE NULL END,
          comments_lock_reason = CASE WHEN ?2 = 1 THEN ?5 ELSE NULL END,
          updated_at = ?3
      WHERE post_id = ?1
    `,
    args: [input.postId, input.locked ? 1 : 0, input.now, input.actorUserId, input.reason],
  })

  const updated = await getPostById(input.executor, input.postId)
  if (!updated) {
    throw internalError("Post row is missing after lock update")
  }
  return {
    ...updated,
    comments_locked: input.locked,
    comments_locked_at: input.locked ? input.now : null,
    comments_locked_by_user_id: input.locked ? input.actorUserId : null,
    comments_lock_reason: input.locked ? input.reason : null,
  }
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

export async function getPostReadMetrics(input: {
  executor: DbExecutor
  postId: string
  viewerUserId?: string | null
}): Promise<{
  upvote_count: number
  downvote_count: number
  like_count: number
  viewer_vote: -1 | 1 | null
}> {
  const row = await executeFirst(input.executor, {
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
          FROM post_reactions
          WHERE post_id = ?1
            AND reaction_key = 'like'
        ) AS like_count,
        (
          SELECT vote_value
          FROM post_votes
          WHERE post_id = ?1
            AND user_id = ?2
          LIMIT 1
        ) AS viewer_vote
    `,
    args: [input.postId, input.viewerUserId ?? ""],
  })

  return {
    upvote_count: requiredNumber(row, "upvote_count"),
    downvote_count: requiredNumber(row, "downvote_count"),
    like_count: requiredNumber(row, "like_count"),
    viewer_vote: numberOrNull(rowValue(row, "viewer_vote")) as -1 | 1 | null,
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
      boundedPostJsonProjection(input.assignmentResultJson),
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
  if (body.crosspost_source) {
    throw badRequestError("crosspost_source must not be provided in the post body")
  }
  if (body.post_type === "crosspost") {
    if (!body.title?.trim()) {
      throw badRequestError("title is required for crossposts")
    }
    if (!body.source_post?.trim()) {
      throw badRequestError("source_post is required for crossposts")
    }
    if (!body.source_community?.trim()) {
      throw badRequestError("source_community is required for crossposts")
    }
    if (body.parent_post_id || (body as { parent_post?: string | null }).parent_post) {
      throw badRequestError("crossposts cannot be replies")
    }
    if (body.body?.trim()) {
      throw badRequestError("body is not supported for crossposts")
    }
    if (body.caption?.trim()) {
      throw badRequestError("caption is not supported for crossposts")
    }
    if (body.link_url?.trim()) {
      throw badRequestError("link_url is only allowed for link posts")
    }
    if (body.media_refs?.length) {
      throw badRequestError("media_refs are not supported for crossposts")
    }
    if (body.song_artifact_bundle?.trim() || body.asset_id?.trim() || body.access_mode) {
      throw badRequestError("asset fields are not supported for crossposts")
    }
    if (body.license_preset || body.commercial_rev_share_pct != null || body.lyrics?.trim()) {
      throw badRequestError("song fields are not supported for crossposts")
    }
  } else if (body.source_post || body.source_community) {
    throw badRequestError("source_post and source_community are only allowed for crossposts")
  }
  if (body.post_type === "image") {
    const primaryImage = body.media_refs?.[0]
    if (!primaryImage?.storage_ref?.trim()) {
      throw badRequestError("media_refs is required for image posts")
    }
    if (!primaryImage.mime_type?.trim()) {
      throw badRequestError("image media_refs must include mime_type")
    }
    const mimeType = primaryImage.mime_type.trim().toLowerCase()
    if (
      mimeType !== "image/jpeg"
      && mimeType !== "image/png"
      && mimeType !== "image/webp"
      && mimeType !== "image/gif"
      && mimeType !== "image/avif"
    ) {
      throw badRequestError("image posts require JPEG, PNG, WebP, GIF, or AVIF media")
    }
  }
  if (body.post_type === "video") {
    const primaryVideo = body.media_refs?.[0]
    if (!primaryVideo?.storage_ref?.trim()) {
      throw badRequestError("media_refs is required for video posts")
    }
    if (!primaryVideo.mime_type?.trim()) {
      throw badRequestError("video media_refs must include mime_type")
    }
    const mimeType = primaryVideo.mime_type.trim().toLowerCase()
    if (mimeType !== "video/mp4" && mimeType !== "video/quicktime" && mimeType !== "video/webm") {
      throw badRequestError("video posts require MP4, MOV, or WebM media")
    }
    if (primaryVideo.poster_ref) {
      const posterMimeType = primaryVideo.poster_mime_type?.trim().toLowerCase()
      if (
        posterMimeType !== "image/jpeg"
        && posterMimeType !== "image/png"
        && posterMimeType !== "image/webp"
      ) {
        throw badRequestError("video poster frames require JPEG, PNG, or WebP media")
      }
    }
    if (primaryVideo.preview_video) {
      const previewMimeType = primaryVideo.preview_video.mime_type?.trim().toLowerCase()
      if (previewMimeType !== "video/mp4" && previewMimeType !== "video/quicktime" && previewMimeType !== "video/webm") {
        throw badRequestError("video preview_video requires MP4, MOV, or WebM media")
      }
    }
    if (body.access_mode && body.access_mode !== "public" && body.access_mode !== "locked") {
      throw badRequestError("video access_mode must be public or locked")
    }
    if (body.access_mode && (body.identity_mode ?? "public") !== "public") {
      throw badRequestError("video commerce posts must use public identity")
    }
    if (body.access_mode !== "locked" && (body.license_preset || body.commercial_rev_share_pct != null)) {
      throw badRequestError("license_preset is only supported for locked video asset posts")
    }
    if (body.rights_basis === "derivative") {
      throw badRequestError("derivative video posts are not supported yet")
    }
    validateOriginalAssetLicense({
      body,
      contentLabel: "video",
      requireLicense: body.access_mode === "locked",
    })
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
  if (body.post_type !== "song" && body.post_type !== "video" && body.access_mode) {
    throw badRequestError("access_mode is only supported for song and video posts")
  }
  if (body.post_type !== "song" && body.post_type !== "video") {
    if (body.license_preset) {
      throw badRequestError("license_preset is only supported for original asset posts")
    }
    if (body.commercial_rev_share_pct != null) {
      throw badRequestError("commercial_rev_share_pct is only supported for original asset posts")
    }
  }
  if (body.post_type === "song") {
    if ((body.identity_mode ?? "public") !== "public") {
      throw badRequestError("song posts must use public identity")
    }
    if (!body.song_artifact_bundle?.trim()) {
      throw badRequestError("song_artifact_bundle is required for song posts")
    }
    if (body.access_mode && body.access_mode !== "public" && body.access_mode !== "locked") {
      throw badRequestError("song access_mode must be public or locked")
    }
    const isDerivative = body.song_mode === "remix" || body.rights_basis === "derivative"
    if (isDerivative) {
      if (body.license_preset) {
        throw badRequestError("license_preset is not supported for remix song posts")
      }
      if (body.commercial_rev_share_pct != null) {
        throw badRequestError("commercial_rev_share_pct is not supported for remix song posts")
      }
    } else {
      validateOriginalAssetLicense({
        body,
        contentLabel: "song",
        requireLicense: true,
      })
    }
  }
}
