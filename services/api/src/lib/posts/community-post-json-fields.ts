import type { Post } from "../../types"

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

export function parseDisclosedQualifiers(value: string | null): Post["disclosed_qualifiers_json"] {
  const parsed = parseJsonArray<
    Post["disclosed_qualifiers_json"] extends Array<infer T> | null | undefined ? T : never
  >(value)
  return parsed ? (parsed as Post["disclosed_qualifiers_json"]) : null
}

export function parseLabelAssignmentResult(value: string | null): LabelAssignmentResultJson {
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

export function parseObject(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null
  }

  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

export function parseMediaRefs(value: string | null): Post["media_refs"] {
  const parsed = parseJsonArray<Post["media_refs"] extends Array<infer T> | undefined ? T : never>(value)
  return parsed ? (parsed as Post["media_refs"]) : undefined
}

export function parseEmbeds(value: string | null): Post["embeds"] {
  const parsed = parseJsonArray<Post["embeds"] extends Array<infer T> | null | undefined ? T : never>(value)
  return parsed ? (parsed as Post["embeds"]) : undefined
}

export function parseCrosspostSource(value: string | null): Post["crosspost_source"] {
  const parsed = parseObject(value)
  if (!parsed) {
    return null
  }
  const sourcePostId = typeof parsed.source_post_id === "string"
    ? parsed.source_post_id
    : typeof parsed.post_id === "string"
      ? parsed.post_id
      : ""
  const sourceCommunityId = typeof parsed.source_community_id === "string"
    ? parsed.source_community_id
    : typeof parsed.community_id === "string"
      ? parsed.community_id
      : ""
  if (!sourcePostId || !sourceCommunityId) {
    return null
  }
  return {
    status: "unavailable",
    post_id: sourcePostId,
    community_id: sourceCommunityId,
    captured_at: typeof parsed.captured_at === "string" ? parsed.captured_at : null,
  }
}

export function parseStringArray(value: string | null): string[] | undefined {
  return parseJsonArray<string>(value) ?? undefined
}
