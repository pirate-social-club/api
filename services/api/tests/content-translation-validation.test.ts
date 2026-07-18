import { describe, expect, test } from "bun:test"
import { isUsableContentTranslation, type ContentTranslationRecord } from "../src/lib/localization/content-translation-store"

function record(input: Partial<ContentTranslationRecord>): ContentTranslationRecord {
  return {
    content_translation_id: "ctr_test",
    content_type: "comment",
    content_id: "cmt_test",
    field_key: "",
    locale: "es",
    source_hash: "0xsource",
    source_language: "en",
    outcome: "translated",
    translated_title: null,
    translated_body: null,
    translated_caption: null,
    provider: "openrouter",
    provider_model: "test-model",
    provider_result_json: null,
    created_at: "2026-07-18T00:00:00.000Z",
    updated_at: "2026-07-18T00:00:00.000Z",
    ...input,
  }
}

describe("isUsableContentTranslation", () => {
  test("rejects a translated cache row missing a populated source field", () => {
    expect(isUsableContentTranslation(record({ translated_body: " " }), {
      body: "Source comment",
    })).toBe(false)
  })

  test("requires every populated post field", () => {
    expect(isUsableContentTranslation(record({
      content_type: "post",
      translated_title: "Translated title",
      translated_body: "Translated body",
    }), {
      title: "Title",
      body: "Body",
      caption: "Caption",
    })).toBe(false)
  })

  test("accepts a translated cache row with all required fields", () => {
    expect(isUsableContentTranslation(record({ translated_body: "Comentario traducido" }), {
      body: "Source comment",
    })).toBe(true)
  })

  test("accepts same-language sentinels without translated fields", () => {
    expect(isUsableContentTranslation(record({ outcome: "same_language" }), {
      body: "Source comment",
    })).toBe(true)
  })
})
