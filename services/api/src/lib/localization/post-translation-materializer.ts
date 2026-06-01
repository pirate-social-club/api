import type { DbExecutor } from "../db-helpers"
import { nowIso } from "../helpers"
import type { Env } from "../../env"
import type { Post } from "../../types"
import { computePostSourceHash, computeTextSourceHash } from "./content-source-hash"
import { DEFAULT_CONTENT_LOCALE, normalizeContentLocale, sameLanguageLocale } from "./content-locale"
import { requestContentTranslation } from "./content-translation-provider"
import { getContentTranslation, upsertContentTranslation, type ContentTranslationRecord } from "./content-translation-store"
import { updatePostSourceLanguageFromProvider } from "./source-language-canonical"

function hasTranslatablePostContent(post: Post): boolean {
  return Boolean(String(post.title ?? "").trim() || String(post.body ?? "").trim() || String(post.caption ?? "").trim())
}

function reliableSourceLanguage(post: Post): string | null {
  return post.source_language_reliable ? post.source_language ?? null : null
}

type PredictionMarketEmbed = NonNullable<Post["embeds"]>[number] & {
  preview?: {
    question?: string | null
    title?: string | null
    outcomes?: Array<{
      label?: string | null
    }> | null
  } | null
}

function getPredictionMarketEmbedQuestion(embed: NonNullable<Post["embeds"]>[number]): string | null {
  if (embed.provider !== "kalshi" && embed.provider !== "polymarket") {
    return null
  }
  const preview = (embed as PredictionMarketEmbed).preview
  const question = String(preview?.question ?? preview?.title ?? "").trim()
  return question || null
}

function getTranslatableMarketEmbeds(post: Post): Array<{
  embedKey: string
  question: string
  outcomes: Array<{ index: number; label: string }>
}> {
  return (post.embeds ?? [])
    .map((embed) => {
      const preview = (embed as PredictionMarketEmbed).preview
      return {
        embedKey: embed.embed_key,
        question: getPredictionMarketEmbedQuestion(embed),
        outcomes: (preview?.outcomes ?? [])
          .map((outcome, index) => ({ index, label: String(outcome?.label ?? "").trim() }))
          .filter((outcome) => Boolean(outcome.label)),
      }
    })
    .filter((item): item is { embedKey: string; question: string; outcomes: Array<{ index: number; label: string }> } => Boolean(item.question))
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

async function materializeMarketEmbedTranslations(input: {
  executor: DbExecutor
  env: Env
  post: Post
  locale: string
  sourceLanguage: string | null
}): Promise<number> {
  let translatedCount = 0
  for (const embed of getTranslatableMarketEmbeds(input.post)) {
    const fields = [
      { fieldKey: `embed:${embed.embedKey}:question`, text: embed.question },
      ...embed.outcomes.map((outcome) => ({
        fieldKey: `embed:${embed.embedKey}:outcome:${outcome.index}`,
        text: outcome.label,
      })),
    ]
    for (const field of fields) {
      const sourceHash = await computeTextSourceHash(field.text)
      const existing = await getContentTranslation({
        executor: input.executor,
        contentType: "post",
        contentId: input.post.post_id,
        fieldKey: field.fieldKey,
        locale: input.locale,
        sourceHash,
      })
      if (existing && String(existing.translated_body ?? "").trim()) {
        translatedCount += 1
        continue
      }

      const translation = await requestContentTranslation({
        env: input.env,
        sourceLanguage: input.sourceLanguage,
        targetLocale: input.locale,
        sourceText: {
          body: field.text,
        },
      })

      await upsertContentTranslation({
        executor: input.executor,
        contentType: "post",
        contentId: input.post.post_id,
        fieldKey: field.fieldKey,
        locale: input.locale,
        sourceHash,
        sourceLanguage: translation.sourceLanguage,
        outcome: translation.outcome,
        translatedBody: translation.translatedBody,
        provider: translation.provider,
        providerModel: translation.model,
        providerResultJson: translation.providerResult ? JSON.stringify(translation.providerResult) : null,
        now: nowIso(),
      })

      if (translation.outcome === "translated" && String(translation.translatedBody ?? "").trim()) {
        translatedCount += 1
      }
    }
  }
  return translatedCount
}

export async function materializePostTranslation(input: {
  executor: DbExecutor
  env: Env
  post: Post
  locale: string | null | undefined
}): Promise<string> {
  const resolvedLocale = normalizeContentLocale(input.locale) ?? DEFAULT_CONTENT_LOCALE
  const sourceHash = await computePostSourceHash(input.post)

  const hasPostContent = hasTranslatablePostContent(input.post)
  const marketEmbeds = getTranslatableMarketEmbeds(input.post)
  if (!hasPostContent && marketEmbeds.length === 0) {
    return `skipped:no_content:${resolvedLocale}`
  }

  if (sameLanguageLocale(reliableSourceLanguage(input.post), resolvedLocale)) {
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

  const existing = hasPostContent
    ? await getContentTranslation({
      executor: input.executor,
      contentType: "post",
      contentId: input.post.post_id,
      locale: resolvedLocale,
      sourceHash,
    })
    : null
  if (hasPostContent && existing && !translationNeedsRefresh(input.post, existing) && marketEmbeds.length === 0) {
    await updatePostSourceLanguageFromProvider({
      executor: input.executor,
      postId: input.post.post_id,
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

  let outcome = existing?.outcome ?? "same_language"
  if (hasPostContent && (!existing || translationNeedsRefresh(input.post, existing))) {
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
    await updatePostSourceLanguageFromProvider({
      executor: input.executor,
      postId: input.post.post_id,
      detection: {
        sourceLanguage: translation.sourceLanguage,
        sourceLanguageConfidence: translation.sourceLanguageConfidence,
        sourceLanguageReliable: translation.sourceLanguageReliable,
        detector: `${translation.provider}:${translation.model}`,
        detectedAt: nowIso(),
        sourceHash,
      },
    })
    outcome = translation.outcome
  }

  const translatedEmbedCount = await materializeMarketEmbedTranslations({
    executor: input.executor,
    env: input.env,
    post: input.post,
    locale: resolvedLocale,
    sourceLanguage: input.post.source_language ?? null,
  })

  return marketEmbeds.length > 0
    ? `${resolvedLocale}:${outcome}:embeds_${translatedEmbedCount}`
    : `${resolvedLocale}:${outcome}`
}
