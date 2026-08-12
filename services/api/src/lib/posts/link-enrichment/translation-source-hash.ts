import { computeTextSourceHash } from "../../localization/content-source-hash"
import type { LinkEnrichmentRecord } from "./types"

export async function computeLinkSummaryTranslationSourceHash(
  record: Pick<LinkEnrichmentRecord, "title" | "description" | "summary_json" | "source_language">,
): Promise<string> {
  return computeTextSourceHash(JSON.stringify({
    title: record.title,
    description: record.description,
    summary_json: record.summary_json,
    source_language: record.source_language,
  }))
}
