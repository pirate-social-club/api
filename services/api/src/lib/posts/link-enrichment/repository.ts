import { executeFirst } from "../../db-helpers"
import { makeId } from "../../helpers"
import { rowValue, stringOrNull, requiredString } from "../../sql-row"
import type { Client } from "../../sql-client"
import type {
  LinkEnrichmentProvider,
  LinkEnrichmentRecord,
  LinkEnrichmentSnapshot,
  LinkEnrichmentStatus,
  LinkEnrichmentUsageRecord,
  LinkSummaryStatus,
} from "./types"

function toRecord(row: unknown): LinkEnrichmentRecord {
  return {
    link_enrichment_id: requiredString(row, "link_enrichment_id"),
    normalized_url: requiredString(row, "normalized_url"),
    canonical_url: stringOrNull(rowValue(row, "canonical_url")),
    provider: requiredString(row, "provider") as LinkEnrichmentProvider,
    status: requiredString(row, "status") as LinkEnrichmentStatus,
    title: stringOrNull(rowValue(row, "title")),
    description: stringOrNull(rowValue(row, "description")),
    publisher: stringOrNull(rowValue(row, "publisher")),
    published_at: stringOrNull(rowValue(row, "published_at")),
    image_url: stringOrNull(rowValue(row, "image_url")),
    markdown: stringOrNull(rowValue(row, "markdown")),
    summary_json: stringOrNull(rowValue(row, "summary_json")),
    summary_status: stringOrNull(rowValue(row, "summary_status")) as LinkSummaryStatus | null,
    summary_model: stringOrNull(rowValue(row, "summary_model")),
    error: stringOrNull(rowValue(row, "error")),
    fetched_at: stringOrNull(rowValue(row, "fetched_at")),
    summarized_at: stringOrNull(rowValue(row, "summarized_at")),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

function toUsageRecord(row: unknown): LinkEnrichmentUsageRecord {
  return {
    normalized_url: requiredString(row, "normalized_url"),
    community_id: requiredString(row, "community_id"),
    post_id: requiredString(row, "post_id"),
    link_enrichment_id: stringOrNull(rowValue(row, "link_enrichment_id")),
    snapshot_synced_at: stringOrNull(rowValue(row, "snapshot_synced_at")),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

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
  return row ? toRecord(row) : null
}

export async function upsertLinkEnrichment(input: {
  client: Client
  normalizedUrl: string
  canonicalUrl: string | null
  provider: LinkEnrichmentProvider
  status: LinkEnrichmentStatus
  title: string | null
  description: string | null
  publisher: string | null
  publishedAt: string | null
  imageUrl: string | null
  markdown: string | null
  summaryJson?: string | null
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
        title, description, publisher, published_at, image_url,
        markdown, summary_json, summary_status, summary_model, error,
        fetched_at, summarized_at, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5,
        ?6, ?7, ?8, ?9, ?10,
        ?11, ?12, ?13, ?14, ?15,
        ?16, NULL, ?17, ?17
      )
      ON CONFLICT(normalized_url) DO UPDATE SET
        canonical_url = excluded.canonical_url,
        provider = excluded.provider,
        status = excluded.status,
        title = excluded.title,
        description = excluded.description,
        publisher = excluded.publisher,
        published_at = excluded.published_at,
        image_url = excluded.image_url,
        markdown = excluded.markdown,
        summary_json = COALESCE(excluded.summary_json, link_enrichments.summary_json),
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
      input.publisher,
      input.publishedAt,
      input.imageUrl,
      input.markdown,
      input.summaryJson ?? null,
      input.summaryStatus ?? null,
      input.summaryModel ?? null,
      input.error,
      input.fetchedAt,
      input.now,
    ],
  })

  const row = await getLinkEnrichmentByNormalizedUrl(input.client, input.normalizedUrl)
  if (!row) {
    throw new Error("Link enrichment is missing after upsert")
  }
  return row
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

  const row = await getLinkEnrichmentByNormalizedUrl(input.client, input.normalizedUrl)
  if (!row) {
    throw new Error("Link enrichment is missing after summary update")
  }
  return row
}

export async function upsertLinkEnrichmentUsage(input: {
  client: Client
  normalizedUrl: string
  communityId: string
  postId: string
  linkEnrichmentId: string | null
  snapshotSyncedAt: string | null
  now: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      INSERT INTO link_enrichment_usages (
        normalized_url, community_id, post_id, link_enrichment_id,
        snapshot_synced_at, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4,
        ?5, ?6, ?6
      )
      ON CONFLICT(normalized_url, community_id, post_id) DO UPDATE SET
        link_enrichment_id = excluded.link_enrichment_id,
        snapshot_synced_at = excluded.snapshot_synced_at,
        updated_at = excluded.updated_at
    `,
    args: [
      input.normalizedUrl,
      input.communityId,
      input.postId,
      input.linkEnrichmentId,
      input.snapshotSyncedAt,
      input.now,
    ],
  })
}

export async function listLinkEnrichmentUsages(input: {
  client: Client
  normalizedUrl: string
}): Promise<LinkEnrichmentUsageRecord[]> {
  const result = await input.client.execute({
    sql: `
      SELECT normalized_url, community_id, post_id, link_enrichment_id,
             snapshot_synced_at, created_at, updated_at
      FROM link_enrichment_usages
      WHERE normalized_url = ?1
      ORDER BY updated_at ASC, community_id ASC, post_id ASC
    `,
    args: [input.normalizedUrl],
  })
  return result.rows.map(toUsageRecord)
}

export async function updateLinkEnrichmentUsageSnapshotSyncedAt(input: {
  client: Client
  normalizedUrl: string
  communityId: string
  postId: string
  snapshotSyncedAt: string
  updatedAt: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      UPDATE link_enrichment_usages
      SET snapshot_synced_at = ?4,
          updated_at = ?5
      WHERE normalized_url = ?1
        AND community_id = ?2
        AND post_id = ?3
    `,
    args: [
      input.normalizedUrl,
      input.communityId,
      input.postId,
      input.snapshotSyncedAt,
      input.updatedAt,
    ],
  })
}

function parseSummary(value: string | null): LinkEnrichmentSnapshot["summary"] {
  if (!value) {
    return {
      status: null,
      summary_paragraph: null,
      short_summary: null,
      key_points: [],
      generated_at: null,
      model: null,
    }
  }

  try {
    const parsed = JSON.parse(value) as {
      summary_paragraph?: unknown
      short_summary?: unknown
      key_points?: unknown
      generated_at?: unknown
      model?: unknown
    }
    return {
      status: "ready",
      summary_paragraph: typeof parsed.summary_paragraph === "string" ? parsed.summary_paragraph : null,
      short_summary: typeof parsed.short_summary === "string" ? parsed.short_summary : null,
      key_points: Array.isArray(parsed.key_points)
        ? parsed.key_points.filter((item): item is string => typeof item === "string")
        : [],
      generated_at: typeof parsed.generated_at === "string" ? parsed.generated_at : null,
      model: typeof parsed.model === "string" ? parsed.model : null,
    }
  } catch {
    return {
      status: null,
      summary_paragraph: null,
      short_summary: null,
      key_points: [],
      generated_at: null,
      model: null,
    }
  }
}

export function buildLinkEnrichmentSnapshot(record: LinkEnrichmentRecord): LinkEnrichmentSnapshot {
  return {
    version: 1,
    provider: record.provider,
    status: record.status,
    normalized_url: record.normalized_url,
    canonical_url: record.canonical_url,
    title: record.title,
    description: record.description,
    publisher: record.publisher,
    published_at: record.published_at,
    image_url: record.image_url,
    summary: {
      ...parseSummary(record.summary_json),
      status: record.summary_status,
      model: record.summary_model,
    },
    error: record.error,
    fetched_at: record.fetched_at,
  }
}
