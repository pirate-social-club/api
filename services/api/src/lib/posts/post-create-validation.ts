import { badRequestError } from "../errors"
import type { CreatePostRequest } from "../../types"

type StoryLicensePreset = NonNullable<CreatePostRequest["license_preset"]>

export type PostWriteRequest = CreatePostRequest & {
  song_annotations_url?: string | null
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

function validateNullableIntegerField(value: unknown, fieldName: string): void {
  if (value == null) return
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw badRequestError(`${fieldName} must be an integer`)
  }
}

function validateNonNegativeIntegerField(value: unknown, fieldName: string): void {
  validateNullableIntegerField(value, fieldName)
  if (typeof value === "number" && value < 0) {
    throw badRequestError(`${fieldName} must be greater than or equal to 0`)
  }
}

function validatePositiveIntegerField(value: unknown, fieldName: string): void {
  validateNullableIntegerField(value, fieldName)
  if (typeof value === "number" && value <= 0) {
    throw badRequestError(`${fieldName} must be greater than 0`)
  }
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
    if (body.rights_basis === "licensed_performance") {
      if (!body.upstream_asset_refs?.length) {
        throw badRequestError("licensed performance video posts require upstream_asset_refs")
      }
      if (body.access_mode === "locked") {
        throw badRequestError("licensed performance video posts do not support locked access yet")
      }
      if (body.license_preset || body.commercial_rev_share_pct != null) {
        throw badRequestError("license_preset is only supported for original video asset posts")
      }
      if (body.source_start_ms == null) {
        throw badRequestError("licensed performance video posts require source_start_ms")
      }
      if (body.source_duration_ms == null) {
        throw badRequestError("licensed performance video posts require source_duration_ms")
      }
      validateNonNegativeIntegerField(body.source_start_ms, "source_start_ms")
      validatePositiveIntegerField(body.source_duration_ms, "source_duration_ms")
      validateNullableIntegerField(body.sync_offset_ms, "sync_offset_ms")
    } else {
      if (body.source_start_ms != null || body.source_duration_ms != null || body.sync_offset_ms != null) {
        throw badRequestError("source timing fields are only supported for licensed performance video posts")
      }
      validateOriginalAssetLicense({
        body,
        contentLabel: "video",
        requireLicense: body.access_mode === "locked",
      })
    }
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
