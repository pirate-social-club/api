import type { DbExecutor } from "../db-helpers"
import { computePostSourceHash } from "./content-source-hash"
import { DEFAULT_CONTENT_LOCALE, normalizeContentLocale, sameLanguageLocale } from "./content-locale"
import { getContentTranslation } from "./content-translation-store"
import type { CommentThreadSnapshot, LocalizedPostResponse, Post } from "../../types"

export type PostReadMetrics = {
  upvote_count: number
  downvote_count: number
  like_count: number
  viewer_vote: -1 | 1 | null
}

function hasTranslatablePostContent(post: Post): boolean {
  return Boolean(
    String(post.title ?? "").trim()
    || String(post.body ?? "").trim()
    || String(post.caption ?? "").trim(),
  )
}

export async function buildLocalizedPostResponse(input: {
  executor: DbExecutor
  post: Post
  locale?: string | null
  metrics?: Partial<PostReadMetrics>
  threadSnapshot?: CommentThreadSnapshot | null
}): Promise<LocalizedPostResponse> {
  const resolvedLocale = normalizeContentLocale(input.locale) ?? DEFAULT_CONTENT_LOCALE
  const sourceHash = await computePostSourceHash(input.post)

  const response: LocalizedPostResponse = {
    post: input.post,
    thread_snapshot: input.threadSnapshot ?? null,
    label: null,
    upvote_count: input.metrics?.upvote_count ?? 0,
    downvote_count: input.metrics?.downvote_count ?? 0,
    like_count: input.metrics?.like_count ?? 0,
    viewer_vote: input.metrics?.viewer_vote ?? null,
    viewer_reaction_kinds: [],
    resolved_locale: resolvedLocale,
    translation_state: "same_language",
    machine_translated: false,
    translated_title: null,
    translated_body: null,
    translated_caption: null,
    source_hash: sourceHash,
  }

  if (!hasTranslatablePostContent(input.post)) {
    return response
  }

  if (sameLanguageLocale(input.post.source_language, resolvedLocale)) {
    return response
  }

  const translationPolicy = input.post.translation_policy ?? "none"
  if (translationPolicy === "none" || translationPolicy === "human_only") {
    return {
      ...response,
      translation_state: "policy_blocked",
    }
  }

  const cached = await getContentTranslation({
    executor: input.executor,
    contentType: "post",
    contentId: input.post.post_id,
    locale: resolvedLocale,
    sourceHash,
  })

  if (!cached) {
    return {
      ...response,
      translation_state: "pending",
    }
  }

  if (cached.outcome === "same_language") {
    return response
  }

  return {
    ...response,
    translation_state: "ready",
    machine_translated: true,
    translated_title: cached.translated_title,
    translated_body: cached.translated_body,
    translated_caption: cached.translated_caption,
  }
}
