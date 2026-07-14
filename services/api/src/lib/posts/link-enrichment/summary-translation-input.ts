export type StoredLinkSummaryTranslationInput = {
  summary_paragraph: string | null
  short_summary: string | null
  key_points: string[]
}

function emptyStoredLinkSummaryTranslationInput(): StoredLinkSummaryTranslationInput {
  return {
    summary_paragraph: null,
    short_summary: null,
    key_points: [],
  }
}

export function parseStoredLinkSummaryTranslationInput(summaryJson: string | null): StoredLinkSummaryTranslationInput {
  if (!summaryJson) {
    return emptyStoredLinkSummaryTranslationInput()
  }
  try {
    const parsed = JSON.parse(summaryJson) as Record<string, unknown>
    return {
      summary_paragraph: typeof parsed.summary_paragraph === "string" ? parsed.summary_paragraph : null,
      short_summary: typeof parsed.short_summary === "string" ? parsed.short_summary : null,
      key_points: Array.isArray(parsed.key_points)
        ? parsed.key_points.filter((item): item is string => typeof item === "string").slice(0, 3)
        : [],
    }
  } catch {
    return emptyStoredLinkSummaryTranslationInput()
  }
}

export function hasStoredLinkSummaryTranslationInput(input: {
  title?: string | null
  description?: string | null
  summary: StoredLinkSummaryTranslationInput
}): boolean {
  return Boolean(
    input.title
      || input.description
      || input.summary.summary_paragraph
      || input.summary.key_points.length > 0,
  )
}

export function keyPointsForLinkSummaryTranslation(summary: StoredLinkSummaryTranslationInput): [string, string, string] {
  return summary.key_points.length === 3
    ? [summary.key_points[0] ?? "", summary.key_points[1] ?? "", summary.key_points[2] ?? ""]
    : ["", "", ""]
}
