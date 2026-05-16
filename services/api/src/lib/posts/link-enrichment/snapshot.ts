import type {
  LinkEnrichmentRecord,
  LinkEnrichmentSnapshot,
  LinkEnrichmentTranslation,
} from "./types"

const SNAPSHOT_TEXT_LIMIT = 2_000
const SNAPSHOT_SUMMARY_TEXT_LIMIT = 4_000
const SNAPSHOT_KEY_POINT_LIMIT = 1_000

function limitSnapshotText(value: string | null, maxLength = SNAPSHOT_TEXT_LIMIT): string | null {
  if (!value) {
    return value
  }
  return value.length > maxLength ? value.slice(0, maxLength) : value
}

function emptySummary(): LinkEnrichmentSnapshot["summary"] {
  return {
    status: null,
    summary_paragraph: null,
    short_summary: null,
    key_points: [],
    generated_at: null,
    model: null,
  }
}

function parseSummary(value: string | null): LinkEnrichmentSnapshot["summary"] {
  if (!value) {
    return emptySummary()
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
      summary_paragraph: typeof parsed.summary_paragraph === "string"
        ? limitSnapshotText(parsed.summary_paragraph, SNAPSHOT_SUMMARY_TEXT_LIMIT)
        : null,
      short_summary: typeof parsed.short_summary === "string" ? limitSnapshotText(parsed.short_summary) : null,
      key_points: Array.isArray(parsed.key_points)
        ? parsed.key_points
          .filter((item): item is string => typeof item === "string")
          .slice(0, 5)
          .map((item) => limitSnapshotText(item, SNAPSHOT_KEY_POINT_LIMIT) ?? "")
        : [],
      generated_at: typeof parsed.generated_at === "string" ? parsed.generated_at : null,
      model: typeof parsed.model === "string" ? parsed.model : null,
    }
  } catch {
    return emptySummary()
  }
}

export function parseLinkEnrichmentTranslations(value: string | null): Record<string, LinkEnrichmentTranslation> {
  if (!value) {
    return {}
  }

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {}
    }

    const translations: Record<string, LinkEnrichmentTranslation> = {}
    for (const [locale, entry] of Object.entries(parsed)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue
      }
      const record = entry as Record<string, unknown>
      const summary = record.summary && typeof record.summary === "object" && !Array.isArray(record.summary)
        ? record.summary as Record<string, unknown>
        : {}
      translations[locale] = {
        locale,
        title: typeof record.title === "string" ? limitSnapshotText(record.title) : null,
        description: typeof record.description === "string" ? limitSnapshotText(record.description) : null,
        summary: {
          summary_paragraph: typeof summary.summary_paragraph === "string"
            ? limitSnapshotText(summary.summary_paragraph, SNAPSHOT_SUMMARY_TEXT_LIMIT)
            : null,
          short_summary: typeof summary.short_summary === "string" ? limitSnapshotText(summary.short_summary) : null,
          key_points: Array.isArray(summary.key_points)
            ? summary.key_points
              .filter((item): item is string => typeof item === "string")
              .slice(0, 5)
              .map((item) => limitSnapshotText(item, SNAPSHOT_KEY_POINT_LIMIT) ?? "")
            : [],
        },
        generated_at: typeof record.generated_at === "string" ? record.generated_at : null,
        model: typeof record.model === "string" ? record.model : null,
        provider: record.provider === "openrouter" ? "openrouter" : null,
      }
    }
    return translations
  } catch {
    return {}
  }
}

export function buildLinkEnrichmentSnapshot(record: LinkEnrichmentRecord): LinkEnrichmentSnapshot {
  const translations = parseLinkEnrichmentTranslations(record.translations_json)
  return {
    version: 1,
    provider: record.provider,
    status: record.status,
    normalized_url: limitSnapshotText(record.normalized_url) ?? "",
    canonical_url: limitSnapshotText(record.canonical_url),
    title: limitSnapshotText(record.title),
    description: limitSnapshotText(record.description),
    source_language: record.source_language,
    publisher: limitSnapshotText(record.publisher),
    published_at: record.published_at,
    image_url: limitSnapshotText(record.image_url),
    summary: {
      ...parseSummary(record.summary_json),
      status: record.summary_status,
      model: record.summary_model,
    },
    ...(Object.keys(translations).length ? { translations } : {}),
    error: limitSnapshotText(record.error),
    fetched_at: record.fetched_at,
  }
}
