import { executeFirst } from "../../db-helpers"
import { makeId } from "../../helpers"
import type { Client } from "../../sql-client"
import { toLinkEnrichmentRecord } from "./repository-rows"
import type {
  LinkEnrichmentProvider,
  LinkEnrichmentRecord,
  LinkEnrichmentStatus,
  LinkSummaryStatus,
} from "./types"

export {
  listLinkEnrichmentUsages,
  updateLinkEnrichmentUsageSnapshotSyncedAt,
  upsertLinkEnrichmentUsage,
} from "./repository-usages"

export async function getLinkEnrichmentByNormalizedUrl(
  client: Client,
  normalizedUrl: string,
): Promise<LinkEnrichmentRecord | null> {
  const row = await executeFirst(client, {
    sql: `
      SELECT *
      FROM link_enrichments
      WHERE normalized_url = ?1
      LIMIT 1
    `,
    args: [normalizedUrl],
  })
  return row ? toLinkEnrichmentRecord(row) : null
}

async function getRequiredLinkEnrichmentByNormalizedUrl(input: {
  client: Client
  normalizedUrl: string
  errorMessage: string
}): Promise<LinkEnrichmentRecord> {
  const row = await getLinkEnrichmentByNormalizedUrl(input.client, input.normalizedUrl)
  if (!row) {
    throw new Error(input.errorMessage)
  }
  return row
}

export async function upsertLinkEnrichment(input: {
  client: Client
  normalizedUrl: string
  canonicalUrl: string | null
  provider: LinkEnrichmentProvider
  status: LinkEnrichmentStatus
  title: string | null
  description: string | null
  sourceLanguage?: string | null
  publisher: string | null
  publishedAt: string | null
  imageUrl: string | null
  markdown: string | null
  summaryJson?: string | null
  translationsJson?: string | null
  summaryStatus?: LinkSummaryStatus | null
  summaryModel?: string | null
  error: string | null
  fetchedAt: string | null
  now: string
}): Promise<LinkEnrichmentRecord> {
  const enrichmentId = makeId("len")
  await input.client.execute({
    sql: `
      INSERT INTO link_enrichments (
        link_enrichment_id, normalized_url, canonical_url, provider, status,
        title, description, source_language, publisher, published_at, image_url,
        markdown, summary_json, translations_json, summary_status, summary_model,
        error, fetched_at, summarized_at, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5,
        ?6, ?7, ?8, ?9, ?10, ?11,
        ?12, ?13, ?14, ?15, ?16,
        ?17, ?18, NULL, ?19, ?19
      )
      ON CONFLICT(normalized_url) DO UPDATE SET
        canonical_url = excluded.canonical_url,
        provider = excluded.provider,
        status = excluded.status,
        title = excluded.title,
        description = excluded.description,
        source_language = excluded.source_language,
        publisher = excluded.publisher,
        published_at = excluded.published_at,
        image_url = excluded.image_url,
        markdown = excluded.markdown,
        summary_json = COALESCE(excluded.summary_json, link_enrichments.summary_json),
        translations_json = COALESCE(excluded.translations_json, link_enrichments.translations_json),
        summary_status = COALESCE(excluded.summary_status, link_enrichments.summary_status),
        summary_model = COALESCE(excluded.summary_model, link_enrichments.summary_model),
        error = excluded.error,
        fetched_at = excluded.fetched_at,
        updated_at = excluded.updated_at
    `,
    args: [
      enrichmentId,
      input.normalizedUrl,
      input.canonicalUrl,
      input.provider,
      input.status,
      input.title,
      input.description,
      input.sourceLanguage ?? null,
      input.publisher,
      input.publishedAt,
      input.imageUrl,
      input.markdown,
      input.summaryJson ?? null,
      input.translationsJson ?? null,
      input.summaryStatus ?? null,
      input.summaryModel ?? null,
      input.error,
      input.fetchedAt,
      input.now,
    ],
  })

  return getRequiredLinkEnrichmentByNormalizedUrl({
    client: input.client,
    normalizedUrl: input.normalizedUrl,
    errorMessage: "Link enrichment is missing after upsert",
  })
}

export async function updateLinkEnrichmentTranslations(input: {
  client: Client
  normalizedUrl: string
  translationsJson: string | null
  updatedAt: string
}): Promise<LinkEnrichmentRecord> {
  await input.client.execute({
    sql: `
      UPDATE link_enrichments
      SET translations_json = ?2,
          updated_at = ?3
      WHERE normalized_url = ?1
    `,
    args: [
      input.normalizedUrl,
      input.translationsJson,
      input.updatedAt,
    ],
  })

  return getRequiredLinkEnrichmentByNormalizedUrl({
    client: input.client,
    normalizedUrl: input.normalizedUrl,
    errorMessage: "Link enrichment is missing after translation update",
  })
}

export async function updateLinkEnrichmentSummary(input: {
  client: Client
  normalizedUrl: string
  summaryJson: string | null
  summaryStatus: LinkSummaryStatus
  summaryModel: string | null
  summarizedAt: string | null
  error: string | null
  updatedAt: string
}): Promise<LinkEnrichmentRecord> {
  await input.client.execute({
    sql: `
      UPDATE link_enrichments
      SET summary_json = ?2,
          summary_status = ?3,
          summary_model = ?4,
          summarized_at = ?5,
          error = ?6,
          updated_at = ?7
      WHERE normalized_url = ?1
    `,
    args: [
      input.normalizedUrl,
      input.summaryJson,
      input.summaryStatus,
      input.summaryModel,
      input.summarizedAt,
      input.error,
      input.updatedAt,
    ],
  })

  return getRequiredLinkEnrichmentByNormalizedUrl({
    client: input.client,
    normalizedUrl: input.normalizedUrl,
    errorMessage: "Link enrichment is missing after summary update",
  })
}
