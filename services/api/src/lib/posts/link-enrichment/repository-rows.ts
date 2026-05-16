import { requiredString, rowValue, stringOrNull } from "../../sql-row"
import type {
  LinkEnrichmentProvider,
  LinkEnrichmentRecord,
  LinkEnrichmentStatus,
  LinkEnrichmentUsageRecord,
  LinkSummaryStatus,
} from "./types"

export function toLinkEnrichmentRecord(row: unknown): LinkEnrichmentRecord {
  return {
    link_enrichment_id: requiredString(row, "link_enrichment_id"),
    normalized_url: requiredString(row, "normalized_url"),
    canonical_url: stringOrNull(rowValue(row, "canonical_url")),
    provider: requiredString(row, "provider") as LinkEnrichmentProvider,
    status: requiredString(row, "status") as LinkEnrichmentStatus,
    title: stringOrNull(rowValue(row, "title")),
    description: stringOrNull(rowValue(row, "description")),
    source_language: stringOrNull(rowValue(row, "source_language")),
    publisher: stringOrNull(rowValue(row, "publisher")),
    published_at: stringOrNull(rowValue(row, "published_at")),
    image_url: stringOrNull(rowValue(row, "image_url")),
    markdown: stringOrNull(rowValue(row, "markdown")),
    summary_json: stringOrNull(rowValue(row, "summary_json")),
    translations_json: stringOrNull(rowValue(row, "translations_json")),
    summary_status: stringOrNull(rowValue(row, "summary_status")) as LinkSummaryStatus | null,
    summary_model: stringOrNull(rowValue(row, "summary_model")),
    error: stringOrNull(rowValue(row, "error")),
    fetched_at: stringOrNull(rowValue(row, "fetched_at")),
    summarized_at: stringOrNull(rowValue(row, "summarized_at")),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

export function toLinkEnrichmentUsageRecord(row: unknown): LinkEnrichmentUsageRecord {
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
