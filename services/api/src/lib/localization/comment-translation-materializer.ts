import type { DbExecutor } from "../db-helpers"
import { nowIso } from "../helpers"
import type { Env } from "../../env"
import type { Comment as ApiComment } from "../../types"
import { computeCommentSourceHash } from "./content-source-hash"
import { DEFAULT_CONTENT_LOCALE, normalizeContentLocale, sameLanguageLocale } from "./content-locale"
import { requestContentTranslation } from "./content-translation-provider"
import { getContentTranslation, upsertContentTranslation } from "./content-translation-store"
import { updateCommentSourceLanguageFromProvider } from "./source-language-canonical"

type Comment = ApiComment & {
  source_language?: string | null
  source_language_reliable?: boolean
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

  const reliableSourceLanguage = input.comment.source_language_reliable
    ? input.comment.source_language ?? null
    : null
  if (sameLanguageLocale(reliableSourceLanguage, resolvedLocale)) {
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
    await updateCommentSourceLanguageFromProvider({
      executor: input.executor,
      commentId: input.comment.comment_id,
      detection: {
        sourceLanguage: existing.source_language,
        sourceLanguageConfidence: null,
        sourceLanguageReliable: false,
        detector: existing.provider ? `${existing.provider}:${existing.provider_model ?? "unknown"}` : "content_translation_cache",
        detectedAt: nowIso(),
        sourceHash,
      },
    })
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
  await updateCommentSourceLanguageFromProvider({
    executor: input.executor,
    commentId: input.comment.comment_id,
    detection: {
      sourceLanguage: translation.sourceLanguage,
      sourceLanguageConfidence: translation.sourceLanguageConfidence,
      sourceLanguageReliable: translation.sourceLanguageReliable,
      detector: `${translation.provider}:${translation.model}`,
      detectedAt: nowIso(),
      sourceHash,
    },
  })

  return `${resolvedLocale}:${translation.outcome}`
}
