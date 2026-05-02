import type { Env } from "../../../env"
import type { DbExecutor } from "../../db-helpers"
import { normalizeContentLocale, sameLanguageLocale } from "../../localization/content-locale"
import type { Client } from "../../sql-client"
import { updatePostLinkPreviewMetadata } from "../community-post-store"
import {
  buildLinkEnrichmentSnapshot,
  getLinkEnrichmentByNormalizedUrl,
  listLinkEnrichmentUsages,
  parseLinkEnrichmentTranslations,
  updateLinkEnrichmentSummary,
  updateLinkEnrichmentTranslations,
  updateLinkEnrichmentUsageSnapshotSyncedAt,
} from "./repository"
import { requestLinkSummary } from "./summary-provider"
import { requestLinkSummaryTranslation } from "./translation-provider"

export async function generateAndStoreLinkSummary(input: {
  env: Env
  controlPlaneClient: Client
  normalizedUrl: string
  now: string
  fetcher?: typeof fetch
}): Promise<{
  resultRef: string
  snapshotJson: string | null
}> {
  const record = await getLinkEnrichmentByNormalizedUrl(input.controlPlaneClient, input.normalizedUrl)
  if (!record) {
    return { resultRef: "skipped:missing_enrichment", snapshotJson: null }
  }
  if (record.status !== "ready") {
    return { resultRef: `skipped:${record.status}`, snapshotJson: null }
  }
  if (record.summary_status === "ready" && record.summary_json) {
    return {
      resultRef: "skipped:summary_ready",
      snapshotJson: JSON.stringify(buildLinkEnrichmentSnapshot(record)),
    }
  }
  if (!record.markdown?.trim()) {
    const unavailable = await updateLinkEnrichmentSummary({
      client: input.controlPlaneClient,
      normalizedUrl: input.normalizedUrl,
      summaryJson: null,
      summaryStatus: "unavailable",
      summaryModel: null,
      summarizedAt: input.now,
      error: "no_markdown",
      updatedAt: input.now,
    })
    return {
      resultRef: "unavailable:no_markdown",
      snapshotJson: JSON.stringify(buildLinkEnrichmentSnapshot(unavailable)),
    }
  }

  await updateLinkEnrichmentSummary({
    client: input.controlPlaneClient,
    normalizedUrl: input.normalizedUrl,
    summaryJson: null,
    summaryStatus: "pending",
    summaryModel: null,
    summarizedAt: input.now,
    error: null,
    updatedAt: input.now,
  })

  try {
    const summary = await requestLinkSummary({
      env: input.env,
      title: record.title,
      publisher: record.publisher,
      publishedAt: record.published_at,
      markdown: record.markdown,
      fetcher: input.fetcher,
    })
    const summaryJson = JSON.stringify({
      summary_paragraph: summary.summaryParagraph,
      short_summary: summary.shortSummary,
      key_points: summary.keyPoints,
      generated_at: input.now,
      model: summary.model,
    })
    const updated = await updateLinkEnrichmentSummary({
      client: input.controlPlaneClient,
      normalizedUrl: input.normalizedUrl,
      summaryJson,
      summaryStatus: "ready",
      summaryModel: summary.model,
      summarizedAt: input.now,
      error: null,
      updatedAt: input.now,
    })
    return {
      resultRef: `ready:${updated.normalized_url}`,
      snapshotJson: JSON.stringify(buildLinkEnrichmentSnapshot(updated)),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const failed = await updateLinkEnrichmentSummary({
      client: input.controlPlaneClient,
      normalizedUrl: input.normalizedUrl,
      summaryJson: null,
      summaryStatus: "failed",
      summaryModel: null,
      summarizedAt: input.now,
      error: message.slice(0, 240),
      updatedAt: input.now,
    })
    return {
      resultRef: `failed:${message.slice(0, 120)}`,
      snapshotJson: JSON.stringify(buildLinkEnrichmentSnapshot(failed)),
    }
  }
}

export async function translateAndStoreLinkSummary(input: {
  env: Env
  controlPlaneClient: Client
  normalizedUrl: string
  locale: string
  now: string
  fetcher?: typeof fetch
}): Promise<{
  resultRef: string
  snapshotJson: string | null
}> {
  const locale = normalizeContentLocale(input.locale)
  if (!locale) {
    return { resultRef: "skipped:invalid_locale", snapshotJson: null }
  }
  if (sameLanguageLocale("en", locale)) {
    const record = await getLinkEnrichmentByNormalizedUrl(input.controlPlaneClient, input.normalizedUrl)
    return {
      resultRef: "skipped:canonical_locale",
      snapshotJson: record ? JSON.stringify(buildLinkEnrichmentSnapshot(record)) : null,
    }
  }

  const record = await getLinkEnrichmentByNormalizedUrl(input.controlPlaneClient, input.normalizedUrl)
  if (!record) {
    return { resultRef: "skipped:missing_enrichment", snapshotJson: null }
  }
  if (record.status !== "ready") {
    return { resultRef: `skipped:${record.status}`, snapshotJson: null }
  }

  const existingTranslations = parseLinkEnrichmentTranslations(record.translations_json)
  const existing = existingTranslations[locale]
  const hasSummary = record.summary_status === "ready" && record.summary_json
  if (existing && (!hasSummary || existing.summary.key_points.length === 3 || existing.summary.summary_paragraph)) {
    return {
      resultRef: `skipped:translation_ready:${locale}`,
      snapshotJson: JSON.stringify(buildLinkEnrichmentSnapshot(record)),
    }
  }

  let parsedSummary: {
    summary_paragraph: string | null
    short_summary: string | null
    key_points: string[]
  } = {
    summary_paragraph: null,
    short_summary: null,
    key_points: [],
  }
  if (record.summary_json) {
    try {
      const parsed = JSON.parse(record.summary_json) as Record<string, unknown>
      parsedSummary = {
        summary_paragraph: typeof parsed.summary_paragraph === "string" ? parsed.summary_paragraph : null,
        short_summary: typeof parsed.short_summary === "string" ? parsed.short_summary : null,
        key_points: Array.isArray(parsed.key_points)
          ? parsed.key_points.filter((item): item is string => typeof item === "string").slice(0, 3)
          : [],
      }
    } catch {
      parsedSummary = {
        summary_paragraph: null,
        short_summary: null,
        key_points: [],
      }
    }
  }

  if (!record.title && !record.description && !parsedSummary.summary_paragraph && parsedSummary.key_points.length === 0) {
    return {
      resultRef: "skipped:no_translatable_fields",
      snapshotJson: JSON.stringify(buildLinkEnrichmentSnapshot(record)),
    }
  }

  const translation = await requestLinkSummaryTranslation({
    env: input.env,
    targetLocale: locale,
    title: record.title,
    description: record.description,
    summaryParagraph: parsedSummary.summary_paragraph,
    shortSummary: parsedSummary.short_summary,
    keyPoints: parsedSummary.key_points.length === 3
      ? parsedSummary.key_points
      : ["", "", ""],
    fetcher: input.fetcher,
  })
  const updatedTranslations = {
    ...existingTranslations,
    [locale]: {
      locale,
      title: translation.title,
      description: translation.description,
      summary: {
        summary_paragraph: translation.summaryParagraph,
        short_summary: translation.shortSummary,
        key_points: translation.keyPoints,
      },
      generated_at: input.now,
      model: translation.model,
      provider: translation.provider,
    },
  }
  const updated = await updateLinkEnrichmentTranslations({
    client: input.controlPlaneClient,
    normalizedUrl: input.normalizedUrl,
    translationsJson: JSON.stringify(updatedTranslations),
    updatedAt: input.now,
  })
  return {
    resultRef: `ready:${updated.normalized_url}:${locale}`,
    snapshotJson: JSON.stringify(buildLinkEnrichmentSnapshot(updated)),
  }
}

export async function writeLinkEnrichmentSnapshotToPost(input: {
  client: DbExecutor
  postId: string
  snapshotJson: string
  syncedAt: string
}): Promise<void> {
  const snapshot = JSON.parse(input.snapshotJson) as {
    title?: unknown
    image_url?: unknown
  }
  await updatePostLinkPreviewMetadata({
    client: input.client,
    postId: input.postId,
    linkOgImageUrl: typeof snapshot.image_url === "string" ? snapshot.image_url : null,
    linkOgTitle: typeof snapshot.title === "string" ? snapshot.title : null,
    linkEnrichmentSnapshotJson: input.snapshotJson,
    linkEnrichmentSyncedAt: input.syncedAt,
    updatedAt: input.syncedAt,
  })
}

export async function listLinkSummaryFanoutUsages(input: {
  controlPlaneClient: Client
  normalizedUrl: string
}) {
  return listLinkEnrichmentUsages({
    client: input.controlPlaneClient,
    normalizedUrl: input.normalizedUrl,
  })
}

export async function markLinkSummaryFanoutSynced(input: {
  controlPlaneClient: Client
  normalizedUrl: string
  communityId: string
  postId: string
  syncedAt: string
}) {
  await updateLinkEnrichmentUsageSnapshotSyncedAt({
    client: input.controlPlaneClient,
    normalizedUrl: input.normalizedUrl,
    communityId: input.communityId,
    postId: input.postId,
    snapshotSyncedAt: input.syncedAt,
    updatedAt: input.syncedAt,
  })
}
