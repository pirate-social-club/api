import type { DbExecutor } from "../db-helpers"
import { executeFirst } from "../db-helpers"
import { badRequestError } from "../errors"
import { requiredNumber, requiredString, rowValue, stringOrNull } from "../sql-row"
import type { CommentAnonymousScope, CreateCommentRequest } from "./comment-types"

type CommunityCommentPolicy = {
  allow_anonymous_identity: boolean
  anonymous_identity_scope: CommentAnonymousScope
}

type CommunityVisibilityRow = {
  community_id: string
  status: string
  membership_mode: "request" | "gated"
}

const COMMENT_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
])

export function assertCreateCommentRequest(body: CreateCommentRequest): void {
  const authorshipMode = body.authorship_mode ?? "human_direct"
  if (Object.prototype.hasOwnProperty.call(body, "community_id")) {
    throw badRequestError("community_id must not be provided in the comment body")
  }
  if (Object.prototype.hasOwnProperty.call(body, "thread_root_post_id")) {
    throw badRequestError("thread_root_post_id must not be provided in the comment body")
  }
  if (Object.prototype.hasOwnProperty.call(body, "parent_comment_id")) {
    throw badRequestError("parent_comment_id must not be provided in the comment body")
  }
  if (body.media_refs != null && !Array.isArray(body.media_refs)) {
    throw badRequestError("media_refs must be an array")
  }
  const mediaRefs = body.media_refs ?? []
  if (!body.body?.trim() && mediaRefs.length === 0) {
    throw badRequestError("body or media_refs is required")
  }
  if (mediaRefs.length > 1) {
    throw badRequestError("comments support at most one media_ref")
  }
  for (const ref of mediaRefs) {
    if (!ref?.storage_ref?.trim()) {
      throw badRequestError("comment media_refs must include storage_ref")
    }
    if (!ref.mime_type?.trim()) {
      throw badRequestError("comment media_refs must include mime_type")
    }
    const mimeType = ref.mime_type.trim().toLowerCase()
    if (!COMMENT_IMAGE_MIME_TYPES.has(mimeType)) {
      throw badRequestError("comment media_refs require JPEG, PNG, WebP, GIF, or AVIF media")
    }
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
    throw badRequestError("user_agent comments must use public identity")
  }
  if (authorshipMode === "guest" && (body.identity_mode ?? "public") !== "anonymous") {
    throw badRequestError("guest comments must use anonymous identity")
  }
  if ((body.identity_mode ?? "public") !== "anonymous" && body.anonymous_scope) {
    throw badRequestError("anonymous_scope is only allowed for anonymous comments")
  }
  if (body.identity_mode === "anonymous" && !body.anonymous_scope) {
    throw badRequestError("anonymous_scope is required for anonymous comments")
  }
}

export async function getCommunityCommentPolicy(
  executor: DbExecutor,
  communityId: string,
): Promise<CommunityCommentPolicy | null> {
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
    anonymous_identity_scope: stringOrNull(rowValue(row, "anonymous_identity_scope")) as CommentAnonymousScope,
  }
}

export async function getCommunityVisibility(executor: DbExecutor, communityId: string): Promise<CommunityVisibilityRow | null> {
  const row = await executeFirst(executor, {
    sql: `
      SELECT community_id, status, membership_mode
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
    community_id: requiredString(row, "community_id"),
    status: requiredString(row, "status"),
    membership_mode: requiredString(row, "membership_mode") as "request" | "gated",
  }
}
