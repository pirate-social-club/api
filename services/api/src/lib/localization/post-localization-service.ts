import type { DbExecutor } from "../db-helpers"
import { getCommunityLabelById, serializeCommunityPostLabel } from "../communities/community-label-store"
import { computePostSourceHash, computeTextSourceHash } from "./content-source-hash"
import { DEFAULT_CONTENT_LOCALE, normalizeContentLocale, sameLanguageLocale } from "./content-locale"
import { getContentTranslation } from "./content-translation-store"
import type { CommentThreadSnapshot, LocalizedPostResponse, Post } from "../../types"

export type PostReadMetrics = {
  upvote_count: number
  downvote_count: number
  comment_count: number
  like_count: number
  viewer_vote: -1 | 1 | null
}

async function getAuthorCommunityRole(input: {
  executor: DbExecutor
  post: Pick<Post, "author_user_id" | "community_id" | "identity_mode">
}): Promise<LocalizedPostResponse["author_community_role"]> {
  if (input.post.identity_mode !== "public" || !input.post.author_user_id) {
    return null
  }

  const result = await input.executor.execute({
    sql: `
      SELECT role
      FROM community_roles
      WHERE community_id = ?1
        AND user_id = ?2
        AND status = 'active'
        AND role IN ('owner', 'admin', 'moderator')
      ORDER BY CASE role
        WHEN 'owner' THEN 0
        WHEN 'admin' THEN 1
        ELSE 2
      END
      LIMIT 1
    `,
    args: [input.post.community_id, input.post.author_user_id],
  })
  const role = result.rows[0]?.role
  if (role === "owner") return "owner"
  if (role === "admin" || role === "moderator") return "moderator"
  return null
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

function hasTranslatablePostContent(post: Post): boolean {
  return Boolean(
    String(post.title ?? "").trim()
    || String(post.body ?? "").trim()
    || String(post.caption ?? "").trim(),
  )
}

async function getLocalizedMarketEmbedTranslations(input: {
  executor: DbExecutor
  post: Post
  locale: string
}): Promise<{
  missingCount: number
  translations: LocalizedPostResponse["translated_embeds"]
}> {
  const marketEmbeds = getTranslatableMarketEmbeds(input.post)
  const translations: NonNullable<LocalizedPostResponse["translated_embeds"]> = []
  let missingCount = 0

  for (const embed of marketEmbeds) {
    const sourceHash = await computeTextSourceHash(embed.question)
    const cached = await getContentTranslation({
      executor: input.executor,
      contentType: "post",
      contentId: input.post.post_id,
      fieldKey: `embed:${embed.embedKey}:question`,
      locale: input.locale,
      sourceHash,
    })
    if (!cached) {
      missingCount += 1
      continue
    }
    if (cached.outcome === "translated") {
      const translatedOutcomes: NonNullable<NonNullable<LocalizedPostResponse["translated_embeds"]>[number]["translated_outcomes"]> = []
      for (const outcome of embed.outcomes) {
        const outcomeSourceHash = await computeTextSourceHash(outcome.label)
        const outcomeTranslation = await getContentTranslation({
          executor: input.executor,
          contentType: "post",
          contentId: input.post.post_id,
          fieldKey: `embed:${embed.embedKey}:outcome:${outcome.index}`,
          locale: input.locale,
          sourceHash: outcomeSourceHash,
        })
        if (!outcomeTranslation) {
          missingCount += 1
          continue
        }
        if (outcomeTranslation.outcome === "translated") {
          translatedOutcomes.push({
            label: outcome.label,
            translated_label: outcomeTranslation.translated_body,
            source_hash: outcomeSourceHash,
          })
        }
      }
      translations.push({
        embed_key: embed.embedKey,
        translated_question: cached.translated_body,
        translated_title: cached.translated_title,
        ...(translatedOutcomes.length ? { translated_outcomes: translatedOutcomes } : {}),
        source_hash: sourceHash,
      })
    }
  }

  return {
    missingCount,
    translations: translations.length ? translations : null,
  }
}

export async function buildLocalizedPostResponse(input: {
  executor: DbExecutor
  post: Post
  locale?: string | null
  metrics?: Partial<PostReadMetrics>
  threadSnapshot?: CommentThreadSnapshot | null
  ageGateViewerState?: "proof_required" | "verified_allowed" | null
}): Promise<LocalizedPostResponse> {
  const resolvedLocale = normalizeContentLocale(input.locale) ?? DEFAULT_CONTENT_LOCALE
  const sourceHash = await computePostSourceHash(input.post)
  const label = input.post.label_id
    ? await getCommunityLabelById({
        executor: input.executor,
        communityId: input.post.community_id,
        labelId: input.post.label_id,
      })
    : null

  const response: LocalizedPostResponse = {
    post: input.post,
    author_community_role: await getAuthorCommunityRole({
      executor: input.executor,
      post: input.post,
    }),
    thread_snapshot: input.threadSnapshot ?? null,
    comment_count: input.metrics?.comment_count ?? input.threadSnapshot?.comment_count ?? 0,
    label: label ? serializeCommunityPostLabel(label) : null,
    upvote_count: input.metrics?.upvote_count ?? 0,
    downvote_count: input.metrics?.downvote_count ?? 0,
    like_count: input.metrics?.like_count ?? 0,
    viewer_vote: input.metrics?.viewer_vote ?? null,
    viewer_reaction_kinds: [],
    age_gate_viewer_state: input.ageGateViewerState ?? null,
    resolved_locale: resolvedLocale,
    translation_state: "same_language",
    machine_translated: false,
    translated_title: null,
    translated_body: null,
    translated_caption: null,
    translated_embeds: null,
    source_hash: sourceHash,
  }

  const hasPostContent = hasTranslatablePostContent(input.post)
  const marketEmbedTranslations = await getLocalizedMarketEmbedTranslations({
    executor: input.executor,
    post: input.post,
    locale: resolvedLocale,
  })

  if (!hasPostContent && !input.post.embeds?.some((embed) => getPredictionMarketEmbedQuestion(embed))) {
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

  if ((hasPostContent && !cached) || marketEmbedTranslations.missingCount > 0) {
    return {
      ...response,
      translation_state: "pending",
      translated_embeds: marketEmbedTranslations.translations,
    }
  }

  if (!hasPostContent || cached?.outcome === "same_language") {
    return {
      ...response,
      translation_state: marketEmbedTranslations.translations?.length ? "ready" : response.translation_state,
      machine_translated: Boolean(marketEmbedTranslations.translations?.length),
      translated_embeds: marketEmbedTranslations.translations,
    }
  }

  return {
    ...response,
    translation_state: "ready",
    machine_translated: true,
    translated_title: cached?.translated_title,
    translated_body: cached?.translated_body,
    translated_caption: cached?.translated_caption,
    translated_embeds: marketEmbedTranslations.translations,
  }
}
