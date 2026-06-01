import type { DbExecutor } from "../db-helpers"
import { computeCommentSourceHash } from "./content-source-hash"
import { DEFAULT_CONTENT_LOCALE, normalizeContentLocale, sameLanguageLocale } from "./content-locale"
import { getContentTranslation } from "./content-translation-store"
import type { Comment as ApiComment, CommentListItem as ApiCommentListItem } from "../../types"

type Comment = ApiComment & {
  source_language?: string | null
  source_language_reliable?: boolean
}

type CommentListItem = Omit<ApiCommentListItem, "comment"> & {
  comment: Comment
}

function hasTranslatableCommentContent(comment: Comment): boolean {
  if (comment.status !== "published") {
    return false
  }
  return Boolean(String(comment.body ?? "").trim())
}

export async function buildLocalizedCommentListItem(input: {
  executor: DbExecutor
  item: Pick<CommentListItem, "comment" | "viewer_vote" | "viewer_can_delete">
  locale?: string | null
}): Promise<CommentListItem> {
  const resolvedLocale = normalizeContentLocale(input.locale) ?? DEFAULT_CONTENT_LOCALE
  const sourceHash = await computeCommentSourceHash(input.item.comment)

  const response: CommentListItem = {
    comment: input.item.comment,
    viewer_vote: input.item.viewer_vote,
    viewer_can_delete: input.item.viewer_can_delete,
    resolved_locale: resolvedLocale,
    translation_state: "same_language",
    machine_translated: false,
    translated_body: null,
    source_hash: sourceHash,
  }

  if (!hasTranslatableCommentContent(input.item.comment)) {
    return response
  }

  const reliableSourceLanguage = input.item.comment.source_language_reliable
    ? input.item.comment.source_language ?? null
    : null
  if (sameLanguageLocale(reliableSourceLanguage, resolvedLocale)) {
    return response
  }

  const cached = await getContentTranslation({
    executor: input.executor,
    contentType: "comment",
    contentId: input.item.comment.comment_id,
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
    translated_body: cached.translated_body,
  }
}
