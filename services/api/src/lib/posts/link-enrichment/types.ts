export type LinkEnrichmentProvider = "firecrawl" | "native" | "manual"
export type LinkEnrichmentStatus = "pending" | "ready" | "failed" | "unavailable"
export type LinkSummaryStatus = "pending" | "ready" | "failed" | "unavailable"

export type LinkEnrichmentTranslation = {
  locale: string
  title: string | null
  description: string | null
  summary: {
    summary_paragraph: string | null
    short_summary: string | null
    key_points: string[]
  }
  generated_at: string | null
  model: string | null
  provider: "openrouter" | null
}

export type LinkEnrichmentSnapshot = {
  version: 1
  provider: LinkEnrichmentProvider
  status: LinkEnrichmentStatus
  normalized_url: string
  canonical_url: string | null
  title: string | null
  description: string | null
  publisher: string | null
  published_at: string | null
  image_url: string | null
  summary: {
    status: LinkSummaryStatus | null
    summary_paragraph: string | null
    short_summary: string | null
    key_points: string[]
    generated_at: string | null
    model: string | null
  }
  translations?: Record<string, LinkEnrichmentTranslation>
  error: string | null
  fetched_at: string | null
}

export type LinkEnrichmentRecord = {
  link_enrichment_id: string
  normalized_url: string
  canonical_url: string | null
  provider: LinkEnrichmentProvider
  status: LinkEnrichmentStatus
  title: string | null
  description: string | null
  publisher: string | null
  published_at: string | null
  image_url: string | null
  markdown: string | null
  summary_json: string | null
  translations_json: string | null
  summary_status: LinkSummaryStatus | null
  summary_model: string | null
  error: string | null
  fetched_at: string | null
  summarized_at: string | null
  created_at: string
  updated_at: string
}

export type LinkEnrichmentUsageRecord = {
  normalized_url: string
  community_id: string
  post_id: string
  link_enrichment_id: string | null
  snapshot_synced_at: string | null
  created_at: string
  updated_at: string
}

export type LinkSummaryProviderResult = {
  provider: "openrouter"
  model: string
  summaryParagraph: string
  shortSummary: string
  keyPoints: string[]
  providerResult: Record<string, unknown> | null
}

export type LinkSummaryTranslationProviderResult = {
  provider: "openrouter"
  model: string
  locale: string
  title: string | null
  description: string | null
  summaryParagraph: string | null
  shortSummary: string | null
  keyPoints: string[]
  providerResult: Record<string, unknown> | null
}
