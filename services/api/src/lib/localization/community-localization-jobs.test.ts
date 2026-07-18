import { describe, expect, test } from "bun:test"
import type { CommunityTextLocalization } from "../../types"
import { enqueueCommunityTextTranslationOnReadIfNeeded } from "./community-localization-service"

describe("community text translation jobs", () => {
  test("surfaces a hash-scoped exhausted failure without inserting another job", async () => {
    const statements: Array<{ sql: string; args?: unknown[] }> = []
    const localization: CommunityTextLocalization = {
      resolved_locale: "es",
      items: [{
        field_key: "community.description",
        translation_state: "pending",
        machine_translated: false,
        translated_value: null,
        source_hash: "0xfield",
      }],
    }
    const executor = {
      async execute(statement: { sql: string; args?: unknown[] } | string) {
        const normalized = typeof statement === "string" ? { sql: statement, args: [] } : statement
        statements.push(normalized)
        const subjectId = String(normalized.args?.[2] ?? "")
        return {
          rows: [{
            job_id: "cjb_failed",
            community_id: "cmt_1",
            job_type: "community_text_translation_materialize",
            subject_type: "community_text_translation",
            subject_id: subjectId,
            status: "failed",
            payload_json: null,
            result_ref: null,
            error_code: "provider_failed",
            attempt_count: 8,
            available_at: null,
            created_at: "2026-07-18T00:00:00.000Z",
            updated_at: "2026-07-18T01:00:00.000Z",
          }],
          rowsAffected: 0,
        }
      },
    }

    await enqueueCommunityTextTranslationOnReadIfNeeded({
      executor,
      communityId: "cmt_1",
      localization,
    })

    expect(localization.items[0]?.translation_state).toBe("failed")
    expect(statements).toHaveLength(1)
    expect(statements[0]?.args?.[2]).toMatch(/^cmt_1:es:0x/u)
  })
})
