import type { DbExecutor } from "../db-helpers"
import { nowIso } from "../helpers"
import type { Comment as ApiComment, Env } from "../../types"
import { computeCommentSourceHash } from "./content-source-hash"
import { DEFAULT_CONTENT_LOCALE, normalizeContentLocale, sameLanguageLocale } from "./content-locale"
import { requestContentTranslation } from "./content-translation-provider"
import { getContentTranslation, upsertContentTranslation } from "./content-translation-store"

type Comment = ApiComment & {
  source_language?: string | null
}

function hasTranslatableCommentContent(comment: Comment): boolean {
  return comment.status === "published" && Boolean(String(comment.body ?? "").trim())
}

export async function materializeCommentTranslation(input: {
  executor: DbExecutor
  env: Env
  comment: Comment
  locale: string | null | undefined
}): Promise<string> {
  const resolvedLocale = normalizeContentLocale(input.locale) ?? DEFAULT_CONTENT_LOCALE
  const sourceHash = await computeCommentSourceHash(input.comment)

  if (!hasTranslatableCommentContent(input.comment)) {
    return `skipped:no_content:${resolvedLocale}`
  }

  if (sameLanguageLocale(input.comment.source_language, resolvedLocale)) {
    await upsertContentTranslation({
      executor: input.executor,
      contentType: "comment",
      contentId: input.comment.comment_id,
      locale: resolvedLocale,
      sourceHash,
      sourceLanguage: input.comment.source_language ?? resolvedLocale,
      outcome: "same_language",
      now: nowIso(),
    })
    return `same_language:${resolvedLocale}`
  }

  const existing = await getContentTranslation({
    executor: input.executor,
    contentType: "comment",
    contentId: input.comment.comment_id,
    locale: resolvedLocale,
    sourceHash,
  })
  if (existing) {
    return `cached:${resolvedLocale}:${existing.outcome}`
  }

  const translation = await requestContentTranslation({
    env: input.env,
    sourceLanguage: input.comment.source_language ?? null,
    targetLocale: resolvedLocale,
    sourceText: {
      body: input.comment.body ?? null,
      caption: null,
    },
  })

  await upsertContentTranslation({
    executor: input.executor,
    contentType: "comment",
    contentId: input.comment.comment_id,
    locale: resolvedLocale,
    sourceHash,
    sourceLanguage: translation.sourceLanguage,
    outcome: translation.outcome,
    translatedBody: translation.translatedBody,
    translatedCaption: null,
    provider: translation.provider,
    providerModel: translation.model,
    providerResultJson: translation.providerResult ? JSON.stringify(translation.providerResult) : null,
    now: nowIso(),
  })

  return `${resolvedLocale}:${translation.outcome}`
}
