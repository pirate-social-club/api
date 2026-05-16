import type { DbExecutor } from "../db-helpers"
import type { Client } from "../sql-client"
import { internalError } from "../errors"
import { executeFirst } from "../db-helpers"
import { makeId } from "../helpers"
import {
  buildAnonymousLabel,
  buildDisclosedQualifierSnapshots,
} from "../identity/anonymous-identity"
import { detectSourceLanguageFromText } from "../localization/content-locale"
import {
  boundedPostJsonProjection,
  POST_SELECT_COLUMNS,
} from "./community-post-projection"
import {
  serializePost,
  toPostRow,
} from "./community-post-serialization"
import type { Post } from "../../types"
import { decodePublicSongArtifactBundleId } from "../public-ids"
import { getPostById } from "./community-post-query-store"
import type { PostWriteRequest } from "./post-create-validation"

export { assertPostCreateRequest, type PostWriteRequest } from "./post-create-validation"

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
