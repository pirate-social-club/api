import type { HomeFeedItem, Post } from "../../types"
import type { HomeFeedProjectionRow } from "./home-feed-types"

type ProjectionFailureReason =
  | "invalid_json"
  | "invalid_payload"
  | "missing_payload"
  | "row_payload_author_mismatch"
  | "row_payload_community_mismatch"
  | "row_payload_identity_mismatch"
  | "row_payload_post_mismatch"
  | "row_payload_type_mismatch"
  | "row_payload_visibility_mismatch"

export type ProjectedVideoFeedShadowResult = {
  candidate_projection_complete: boolean
  compared_items: number
  hydrated_items: number
  mismatch_reasons: Partial<Record<ProjectionFailureReason | "media_mismatch" | "missing_projection_row", number>>
  projection_complete: boolean
  projection_rows: number
  valid_projection_rows: number
}

function increment(
  reasons: ProjectedVideoFeedShadowResult["mismatch_reasons"],
  reason: keyof ProjectedVideoFeedShadowResult["mismatch_reasons"],
): void {
  reasons[reason] = (reasons[reason] ?? 0) + 1
}

function parsePayload(value: unknown): { post: Post | null; reason?: ProjectionFailureReason } {
  if (value == null || value === "") return { post: null, reason: "missing_payload" }

  let parsed: unknown = value
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value)
    } catch {
      return { post: null, reason: "invalid_json" }
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { post: null, reason: "invalid_payload" }
  }

  const record = parsed as Record<string, unknown>
  if (
    typeof record.post_id !== "string"
    || typeof record.community_id !== "string"
    || typeof record.post_type !== "string"
    || typeof record.visibility !== "string"
    || typeof record.identity_mode !== "string"
  ) {
    return { post: null, reason: "invalid_payload" }
  }
  return { post: record as Post }
}

function validateProjectionRow(row: HomeFeedProjectionRow): { post: Post | null; reason?: ProjectionFailureReason } {
  const parsed = parsePayload(row.projected_payload_json)
  if (!parsed.post) return parsed

  const post = parsed.post
  if (post.post_id !== row.source_post_id) return { post: null, reason: "row_payload_post_mismatch" }
  if (post.community_id !== row.community_id) return { post: null, reason: "row_payload_community_mismatch" }
  if (row.post_type && post.post_type !== row.post_type) return { post: null, reason: "row_payload_type_mismatch" }
  if (post.visibility !== row.visibility) return { post: null, reason: "row_payload_visibility_mismatch" }
  if (row.identity_mode && post.identity_mode !== row.identity_mode) {
    return { post: null, reason: "row_payload_identity_mismatch" }
  }
  if ((post.author_user_id ?? null) !== (row.author_user_id ?? null)) {
    return { post: null, reason: "row_payload_author_mismatch" }
  }
  return { post }
}

function storageRefs(post: { media_refs?: Array<{ storage_ref?: string | null }> }): string[] {
  return (post.media_refs ?? [])
    .map((media) => media.storage_ref?.trim() ?? "")
    .filter(Boolean)
    .sort()
}

export function shouldShadowAuthenticatedVideoFeed(input: {
  contentKind?: "video" | null
  mode?: string
  userId: string | null
}): boolean {
  return Boolean(input.userId) && input.contentKind === "video" && input.mode?.trim().toLowerCase() === "shadow"
}

export function compareProjectedVideoFeedRows(input: {
  hydratedItems: HomeFeedItem[]
  rows: HomeFeedProjectionRow[]
}): ProjectedVideoFeedShadowResult {
  const mismatchReasons: ProjectedVideoFeedShadowResult["mismatch_reasons"] = {}
  const hydratedByPostId = new Map(
    input.hydratedItems.map((item) => [item.post.post.id.replace(/^post_/, ""), item] as const),
  )
  const projectedPostById = new Map<string, Post>()
  let comparedItems = 0
  let validProjectionRows = 0
  let returnedItemMismatch = false

  for (const row of input.rows) {
    const validated = validateProjectionRow(row)
    if (!validated.post) {
      increment(mismatchReasons, validated.reason ?? "invalid_payload")
      continue
    }
    validProjectionRows += 1
    projectedPostById.set(row.source_post_id, validated.post)
  }

  for (const [postId, hydrated] of hydratedByPostId) {
    const projectedPost = projectedPostById.get(postId)
    if (!projectedPost) {
      returnedItemMismatch = true
      increment(mismatchReasons, "missing_projection_row")
      continue
    }
    comparedItems += 1
    if (JSON.stringify(storageRefs(projectedPost)) !== JSON.stringify(storageRefs(hydrated.post.post))) {
      returnedItemMismatch = true
      increment(mismatchReasons, "media_mismatch")
    }
  }

  return {
    candidate_projection_complete: validProjectionRows === input.rows.length,
    compared_items: comparedItems,
    hydrated_items: input.hydratedItems.length,
    mismatch_reasons: mismatchReasons,
    projection_complete: comparedItems === input.hydratedItems.length && !returnedItemMismatch,
    projection_rows: input.rows.length,
    valid_projection_rows: validProjectionRows,
  }
}
