import type { DbExecutor } from "../db-helpers"
import { nowIso } from "../helpers"
import type { Env } from "../../env"
import type { Post } from "../../types"
import { computePostSourceHash } from "./content-source-hash"
import { DEFAULT_CONTENT_LOCALE, normalizeContentLocale, sameLanguageLocale } from "./content-locale"
import { requestContentTranslation } from "./content-translation-provider"
import { getContentTranslation, upsertContentTranslation, type ContentTranslationRecord } from "./content-translation-store"

function hasTranslatablePostContent(post: Post): boolean {
  return Boolean(String(post.title ?? "").trim() || String(post.body ?? "").trim() || String(post.caption ?? "").trim())
}

function translationNeedsRefresh(post: Post, translation: ContentTranslationRecord): boolean {
  if (translation.outcome !== "translated") {
    return false
  }

  if (String(post.title ?? "").trim() && !String(translation.translated_title ?? "").trim()) {
    return true
  }
  if (String(post.body ?? "").trim() && !String(translation.translated_body ?? "").trim()) {
    return true
  }
  if (String(post.caption ?? "").trim() && !String(translation.translated_caption ?? "").trim()) {
    return true
  }

  return false
}

export async function materializePostTranslation(input: {
  executor: DbExecutor
  env: Env
  post: Post
  locale: string | null | undefined
}): Promise<string> {
  const resolvedLocale = normalizeContentLocale(input.locale) ?? DEFAULT_CONTENT_LOCALE
  const sourceHash = await computePostSourceHash(input.post)

  if (!hasTranslatablePostContent(input.post)) {
    return `skipped:no_content:${resolvedLocale}`
  }

  if (sameLanguageLocale(input.post.source_language, resolvedLocale)) {
    await upsertContentTranslation({
      executor: input.executor,
      contentType: "post",
      contentId: input.post.post_id,
      locale: resolvedLocale,
      sourceHash,
      sourceLanguage: input.post.source_language ?? resolvedLocale,
      outcome: "same_language",
      now: nowIso(),
    })
    return `same_language:${resolvedLocale}`
  }

  const translationPolicy = input.post.translation_policy ?? "none"
  if (translationPolicy === "none" || translationPolicy === "human_only") {
    return `skipped:policy_blocked:${resolvedLocale}`
  }

  const existing = await getContentTranslation({
    executor: input.executor,
    contentType: "post",
    contentId: input.post.post_id,
    locale: resolvedLocale,
    sourceHash,
  })
  if (existing && !translationNeedsRefresh(input.post, existing)) {
    return `cached:${resolvedLocale}:${existing.outcome}`
  }

  const translation = await requestContentTranslation({
    env: input.env,
    sourceLanguage: input.post.source_language ?? null,
    targetLocale: resolvedLocale,
    sourceText: {
      title: input.post.title ?? null,
      body: input.post.body ?? null,
      caption: input.post.caption ?? null,
    },
  })

  await upsertContentTranslation({
    executor: input.executor,
    contentType: "post",
    contentId: input.post.post_id,
    locale: resolvedLocale,
    sourceHash,
    sourceLanguage: translation.sourceLanguage,
    outcome: translation.outcome,
    translatedTitle: translation.translatedTitle,
    translatedBody: translation.translatedBody,
    translatedCaption: translation.translatedCaption,
    provider: translation.provider,
    providerModel: translation.model,
    providerResultJson: translation.providerResult ? JSON.stringify(translation.providerResult) : null,
    now: nowIso(),
  })

  return `${resolvedLocale}:${translation.outcome}`
}
