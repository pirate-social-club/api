import type { DbExecutor } from "../db-helpers"
import { enqueueCommunityJob } from "../communities/jobs/store"
import { CONTENT_TRANSLATION_PREWARM_LOCALES, sameLanguageLocale } from "../localization/content-locale"
import { nowIso } from "../helpers"
import type { Community, LocalizedPostResponse, Post } from "../../types"
import { isRetryableLinkSummaryErrorMessage } from "./link-enrichment/retryable-errors"
import { normalizeLinkUrl } from "./link-enrichment/url-normalization"

const DEFAULT_EMBED_RECHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const ACTIVE_MARKET_EMBED_RECHECK_INTERVAL_MS = 5 * 60 * 1000

async function enqueuePostTranslationJob(input: {
  client: DbExecutor
  communityId: string
  postId: string
  locale: string
  createdAt: string
}): Promise<void> {
  await enqueueCommunityJob({
    client: input.client,
    communityId: input.communityId,
    jobType: "post_translation_materialize",
    subjectType: "post_translation",
    subjectId: `${input.postId}:${input.locale}`,
    payloadJson: JSON.stringify({
      post_id: input.postId,
      locale: input.locale,
    }),
    createdAt: input.createdAt,
  })
}

export async function enqueuePostTranslationPrewarmJobs(input: {
  client: DbExecutor
  communityId: string
  post: Post
  createdAt: string
}): Promise<void> {
  const translationPolicy = input.post.translation_policy ?? "none"
  if (translationPolicy !== "machine_allowed" && translationPolicy !== "hybrid") {
    return
  }

  for (const locale of CONTENT_TRANSLATION_PREWARM_LOCALES) {
    if (sameLanguageLocale(input.post.source_language, locale)) {
      continue
    }
    await enqueuePostTranslationJob({
      client: input.client,
      communityId: input.communityId,
      postId: input.post.post_id,
      locale,
      createdAt: input.createdAt,
    })
  }
}

export async function enqueuePostTranslationOnReadIfNeeded(input: {
  client: DbExecutor
  communityId: string
  response: LocalizedPostResponse
}): Promise<void> {
  const response = input.response
  const needsTranslationJob = response.translation_state === "pending"
    || (
      response.translation_state === "ready"
      && (
        (String(response.post.title ?? "").trim() && !String(response.translated_title ?? "").trim())
        || (String(response.post.body ?? "").trim() && !String(response.translated_body ?? "").trim())
        || (String(response.post.caption ?? "").trim() && !String(response.translated_caption ?? "").trim())
      )
    )
  if (!needsTranslationJob) {
    return
  }
  await enqueuePostTranslationJob({
    client: input.client,
    communityId: input.communityId,
    postId: response.post.post_id,
    locale: response.resolved_locale,
    createdAt: nowIso(),
  })
}

async function enqueuePostLabelJob(input: {
  client: DbExecutor
  communityId: string
  postId: string
  createdAt: string
  reason?: "publish" | "edit"
}): Promise<void> {
  await enqueueCommunityJob({
    client: input.client,
    communityId: input.communityId,
    jobType: "post_label_materialize",
    subjectType: "post_label",
    subjectId: input.postId,
    payloadJson: JSON.stringify({
      post_id: input.postId,
      reason: input.reason ?? "publish",
    }),
    createdAt: input.createdAt,
  })
}

export async function enqueueEmbedHydrateIfNeeded(input: {
  client: DbExecutor
  communityId: string
  post: Post
  createdAt: string
}): Promise<void> {
  if (input.post.post_type !== "link" || !input.post.link_url?.trim()) {
    return
  }

  await enqueueCommunityJob({
    client: input.client,
    communityId: input.communityId,
    jobType: "embed_hydrate",
    subjectType: "post_embed",
    subjectId: input.post.post_id,
    payloadJson: JSON.stringify({
      post_id: input.post.post_id,
      link_url: input.post.link_url,
    }),
    createdAt: input.createdAt,
  })
}

type PostEmbed = NonNullable<Post["embeds"]>[number]

function isClosedMarketStatus(value: string | null | undefined): boolean {
  const normalized = String(value ?? "").trim().toLowerCase()
  return normalized === "closed"
    || normalized === "settled"
    || normalized === "resolved"
    || normalized === "determined"
}

export function embedRecheckIntervalMs(embed: PostEmbed): number {
  if (embed.provider === "kalshi" || embed.provider === "polymarket") {
    const status = (embed.preview as { status?: string | null } | null | undefined)?.status
    return isClosedMarketStatus(status)
      ? DEFAULT_EMBED_RECHECK_INTERVAL_MS
      : ACTIVE_MARKET_EMBED_RECHECK_INTERVAL_MS
  }

  return DEFAULT_EMBED_RECHECK_INTERVAL_MS
}

export function linkPostNeedsHydrationOnRead(post: Post, now?: string): boolean {
  if (post.post_type !== "link" || !post.link_url?.trim()) {
    return false
  }

  if (!post.embeds?.length) {
    return !post.link_enrichment_snapshot_json
  }

  const checkedAt = now ?? nowIso()
  const checkedAtMs = Date.parse(checkedAt)
  return post.embeds.some((embed) => {
    const lastCheckedAtMs = typeof embed.last_checked_at === "number"
      ? embed.last_checked_at * 1000
      : Date.parse(embed.last_checked_at ?? "")
    return !Number.isFinite(lastCheckedAtMs)
      || !Number.isFinite(checkedAtMs)
      || checkedAtMs - lastCheckedAtMs >= embedRecheckIntervalMs(embed)
  })
}

function failedLinkSummaryNormalizedUrl(post: Post): string | null {
  const snapshot = post.link_enrichment_snapshot_json
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return null
  }
  const summary = (snapshot as { summary?: { status?: unknown } | null }).summary
  if (summary?.status !== "failed") {
    return null
  }
  const error = (snapshot as { error?: unknown }).error
  const errorMessage = typeof error === "string" ? error : ""
  if (!isRetryableLinkSummaryErrorMessage(errorMessage)) {
    return null
  }
  const snapshotUrl = (snapshot as { normalized_url?: unknown }).normalized_url
  if (typeof snapshotUrl === "string" && snapshotUrl.trim()) {
    return snapshotUrl.trim()
  }
  return post.link_url ? normalizeLinkUrl(post.link_url) : null
}

export function linkPostNeedsSummaryRepairOnRead(post: Post): boolean {
  return Boolean(
    post.post_type === "link"
    && post.link_url?.trim()
    && failedLinkSummaryNormalizedUrl(post),
  )
}

export async function enqueueLinkSummaryRepairOnReadIfNeeded(input: {
  client: DbExecutor
  communityId: string
  post: Post
  now?: string
}): Promise<void> {
  const normalizedUrl = failedLinkSummaryNormalizedUrl(input.post)
  if (!normalizedUrl) {
    return
  }

  await enqueueCommunityJob({
    client: input.client,
    communityId: input.communityId,
    jobType: "link_summary_materialize",
    subjectType: "link_enrichment",
    subjectId: normalizedUrl,
    payloadJson: JSON.stringify({
      normalized_url: normalizedUrl,
      post_id: input.post.post_id,
      reason: "read_repair",
    }),
    createdAt: input.now ?? nowIso(),
  })
}

export async function enqueueEmbedHydrateOnReadIfNeeded(input: {
  client: DbExecutor
  communityId: string
  post: Post
  now?: string
}): Promise<void> {
  const now = input.now ?? nowIso()
  if (!linkPostNeedsHydrationOnRead(input.post, now)) {
    return
  }

  await enqueueCommunityJob({
    client: input.client,
    communityId: input.communityId,
    jobType: "embed_hydrate",
    subjectType: "post_embed",
    subjectId: input.post.post_id,
    payloadJson: JSON.stringify({
      post_id: input.post.post_id,
      link_url: input.post.link_url,
      reason: "read_recheck",
    }),
    createdAt: now,
  })
}

export async function enqueuePostLabelIfNeeded(input: {
  client: DbExecutor
  community: Pick<Community, "label_policy">
  communityId: string
  post: Post
  createdAt: string
}): Promise<void> {
  if (input.post.status !== "published") {
    return
  }

  const labelPolicy = input.community.label_policy
  const hasActiveDefinitions = Boolean(labelPolicy?.definitions.some((definition) => definition.status === "active"))
  if (!labelPolicy?.label_enabled || !hasActiveDefinitions) {
    return
  }

  await enqueuePostLabelJob({
    client: input.client,
    communityId: input.communityId,
    postId: input.post.post_id,
    createdAt: input.createdAt,
    reason: "publish",
  })
}
