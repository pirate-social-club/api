import { describe, expect, test } from "bun:test"
import { computeLinkSummaryTranslationSourceHash } from "./translation-source-hash"

describe("computeLinkSummaryTranslationSourceHash", () => {
  test("is stable for the same summary and changes when translatable content changes", async () => {
    const source = {
      title: "Title",
      description: "Description",
      summary_json: JSON.stringify({ short_summary: "Summary" }),
      source_language: "en",
    }

    const first = await computeLinkSummaryTranslationSourceHash(source)
    const second = await computeLinkSummaryTranslationSourceHash({ ...source })
    const edited = await computeLinkSummaryTranslationSourceHash({
      ...source,
      summary_json: JSON.stringify({ short_summary: "Edited summary" }),
    })

    expect(second).toBe(first)
    expect(edited).not.toBe(first)
  })
})
