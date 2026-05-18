import type { DbExecutor } from "../db-helpers"
import type { Client } from "../sql-client"
import { internalError, providerUnavailable } from "../errors"
import { executeFirst } from "../db-helpers"
import { makeId } from "../helpers"
import {
  buildAnonymousLabel,
  buildDisclosedQualifierSnapshots,
} from "../identity/anonymous-identity"
import { detectSourceLanguageFromText } from "../localization/content-locale"
import {
  boundedPostJsonProjection,
  postSelectColumnsForSchema,
  resolvePostProjectionSchema,
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
  const projectionSchema = await resolvePostProjectionSchema(input.client)
  const row = await executeFirst(input.client, {
    sql: `
      SELECT ${postSelectColumnsForSchema(projectionSchema)}
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
  const projectionSchema = await resolvePostProjectionSchema(input.client)
  if (crosspostSourceJson !== null && !projectionSchema.hasCrosspostSourceJson) {
    throw providerUnavailable("Community database migration is still rolling out", {
      missing_column: "posts.crosspost_source_json",
    })
  }
  const sourceLanguage = detectSourceLanguageFromText([
    title,
    input.body.body,
    input.body.caption,
    input.body.lyrics,
  ])

  const columns: string[] = []
  const values: string[] = []
  const args: unknown[] = []
  const addValue = (column: string, value: unknown) => {
    columns.push(column)
    args.push(value)
    values.push(`?${args.length}`)
  }
  const addSql = (column: string, sql: string) => {
    columns.push(column)
    values.push(sql)
  }
  const addOptionalMigratedValue = (column: string, value: unknown, hasColumn: boolean) => {
    if (hasColumn) {
      addValue(column, value)
      return
    }
    if (value !== null && value !== undefined) {
      throw providerUnavailable("Community database migration is still rolling out", {
        missing_column: `posts.${column}`,
      })
    }
  }

  addValue("post_id", postId)
  addValue("community_id", input.communityId)
  addValue("author_user_id", input.authorUserId)
  addValue("authorship_mode", input.body.authorship_mode ?? "human_direct")
  addValue("agent_id", input.agentWriteAuthorization?.agentId ?? null)
  addValue("agent_ownership_record_id", input.agentWriteAuthorization?.agentOwnershipRecordId ?? null)
  addValue("identity_mode", identityMode)
  addValue("anonymous_scope", anonymousScope)
  addValue("anonymous_label", anonymousLabel)
  addValue("agent_display_name_snapshot", input.agentWriteAuthorization?.agentDisplayNameSnapshot ?? null)
  addValue("agent_owner_handle_snapshot", input.agentWriteAuthorization?.agentOwnerHandleSnapshot ?? null)
  addValue("agent_ownership_provider_snapshot", input.agentWriteAuthorization?.agentOwnershipProviderSnapshot ?? null)
  addValue("disclosed_qualifiers_json", disclosedQualifiersJson)
  addValue("label_id", input.body.label_id ?? null)
  addValue("label_assignment_status", labelAssignmentStatus)
  addValue("label_assigned_by", null)
  addValue("label_assigned_at", labelAssignedAt)
  addValue("label_ai_confidence", null)
  addValue("label_assignment_error", null)
  addValue("label_assignment_model", null)
  addValue("label_assignment_result_json", null)
  addValue("post_type", postType)
  addValue("status", status)
  addValue("song_mode", input.body.song_mode ?? null)
  addValue("title", title)
  addValue("song_title", input.body.song_title ?? null)
  addOptionalMigratedValue("song_annotations_url", input.body.song_annotations_url ?? null, projectionSchema.hasSongAnnotationsUrl)
  addOptionalMigratedValue("song_cover_art_ref", input.body.song_cover_art_ref ?? null, projectionSchema.hasSongCoverArtRef)
  addOptionalMigratedValue("song_duration_ms", input.body.song_duration_ms ?? null, projectionSchema.hasSongDurationMs)
  addValue("body", input.body.body ?? null)
  addValue("caption", input.body.caption ?? null)
  addValue("visibility", visibility)
  addValue("lyrics", input.body.lyrics ?? null)
  addValue("link_url", input.body.link_url ?? null)
  addValue("media_refs_json", mediaRefsJson)
  addValue("song_artifact_bundle_id", input.body.song_artifact_bundle ? decodePublicSongArtifactBundleId(input.body.song_artifact_bundle) : null)
  addValue("source_language", sourceLanguage)
  addValue("translation_policy", translationPolicy)
  addValue("rights_basis", input.body.rights_basis ?? "none")
  addValue("access_mode", input.body.access_mode ?? (postType === "song" ? "public" : null))
  addValue("asset_id", input.body.asset_id ?? null)
  addValue("parent_post_id", input.body.parent_post_id ?? null)
  if (projectionSchema.hasCrosspostSourceJson) {
    addValue("crosspost_source_json", crosspostSourceJson)
  }
  addValue("upstream_asset_refs_json", upstreamAssetRefsJson)
  addValue("analysis_state", analysisState)
  addSql("analysis_result_ref", "NULL")
  addValue("content_safety_state", contentSafetyState)
  addValue("age_gate_policy", ageGatePolicy)
  addValue("created_at", input.createdAt)
  addValue("updated_at", input.createdAt)
  addValue("idempotency_key", idempotencyKey)
  addValue("agent_handle_snapshot", input.agentWriteAuthorization?.agentHandleSnapshot ?? null)

  await input.client.execute({
    sql: `
      INSERT INTO posts (${columns.join(", ")})
      VALUES (${values.join(", ")})
    `,
    args,
  })

  const created = await getPostById(input.client, postId)
  if (!created) {
    throw internalError("Post row is missing after insert")
  }
  return created
}
