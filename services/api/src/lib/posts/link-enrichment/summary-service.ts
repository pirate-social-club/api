import type { Env } from "../../../env"
import { detectSourceLanguageFromText, normalizeContentLocale, sameLanguageLocale } from "../../localization/content-locale"
import type { Client } from "../../sql-client"
import {
  getLinkEnrichmentByNormalizedUrl,
  updateLinkEnrichmentSummary,
  updateLinkEnrichmentTranslations,
} from "./repository"
import { buildLinkEnrichmentSnapshot, parseLinkEnrichmentTranslations } from "./snapshot"
import { requestLinkSummary } from "./summary-provider"
import {
  hasStoredLinkSummaryTranslationInput,
  keyPointsForLinkSummaryTranslation,
  parseStoredLinkSummaryTranslationInput,
} from "./summary-translation-input"
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
  const record = await getLinkEnrichmentByNormalizedUrl(input.controlPlaneClient, input.normalizedUrl)
  const sourceLanguage = record
    ? record.source_language ?? detectSourceLanguageFromText([record.title, record.description]) ?? "en"
    : "en"
  if (sameLanguageLocale("en", locale) && sameLanguageLocale(sourceLanguage, "en")) {
    return {
      resultRef: `skipped:canonical_locale:${sourceLanguage}`,
      snapshotJson: record ? JSON.stringify(buildLinkEnrichmentSnapshot(record)) : null,
    }
  }

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

  const parsedSummary = parseStoredLinkSummaryTranslationInput(record.summary_json)

  if (!hasStoredLinkSummaryTranslationInput({
    title: record.title,
    description: record.description,
    summary: parsedSummary,
  })) {
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
    keyPoints: keyPointsForLinkSummaryTranslation(parsedSummary),
    fetcher: input.fetcher,
  })
  const latestRecord = await getLinkEnrichmentByNormalizedUrl(input.controlPlaneClient, input.normalizedUrl)
  const latestTranslations = latestRecord
    ? parseLinkEnrichmentTranslations(latestRecord.translations_json)
    : existingTranslations
  const updatedTranslations = {
    ...latestTranslations,
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
