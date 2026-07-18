import { describe, expect, test } from "bun:test"
import type { Community, CommunityTextLocalization } from "../../types"
import {
  buildLocalizedCommunity,
  enqueueCommunityTextTranslationOnReadIfNeeded,
} from "./community-localization-service"

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

  test("refreshes edited field metadata and dedupes the second read of the edit", async () => {
    const metadata = new Map<string, Record<string, unknown>>()
    const jobs = new Map<string, Record<string, unknown>>()
    const executor = {
      async execute(statement: { sql: string; args?: unknown[] } | string) {
        const normalized = typeof statement === "string" ? { sql: statement, args: [] } : statement
        const args = normalized.args ?? []
        if (normalized.sql.includes("FROM community_localization_meta")) {
          return { rows: [...metadata.values()], rowsAffected: 0 }
        }
        if (normalized.sql.includes("INSERT INTO community_localization_meta")) {
          const existing = metadata.get(String(args[2]))
          metadata.set(String(args[2]), {
            community_localization_meta_id: existing?.community_localization_meta_id ?? args[0],
            community_id: args[1],
            field_key: args[2],
            source_hash: args[3],
            source_language: args[4],
            translation_policy: args[5],
            created_at: existing?.created_at ?? args[6],
            updated_at: args[6],
          })
          return { rows: [], rowsAffected: 1 }
        }
        if (normalized.sql.includes("FROM content_translations")) {
          return { rows: [], rowsAffected: 0 }
        }
        if (normalized.sql.includes("FROM community_jobs")) {
          const existing = jobs.get(String(args[2]))
          return { rows: existing ? [existing] : [], rowsAffected: 0 }
        }
        if (normalized.sql.includes("INSERT OR IGNORE INTO community_jobs")) {
          const subjectId = String(args[4])
          jobs.set(subjectId, {
            job_id: args[0],
            community_id: args[1],
            job_type: "community_text_translation_materialize",
            subject_type: args[3],
            subject_id: subjectId,
            status: "queued",
            payload_json: args[5],
            result_ref: null,
            error_code: null,
            attempt_count: 0,
            available_at: args[6],
            created_at: args[7],
            updated_at: args[7],
          })
          return { rows: [], rowsAffected: 1 }
        }
        throw new Error(`Unexpected SQL in test: ${normalized.sql}`)
      },
    }
    const community: Community = {
      community_id: "cmt_1",
      display_name: "Community",
      description: "Original description",
      status: "active",
      provisioning_state: "active",
      membership_mode: "open",
      karaoke_enabled: false,
      allow_anonymous_identity: false,
      human_verification_lane: "self",
      human_verification_lane_origin: "derived",
      agent_posting_policy: "disallow",
      guest_comment_policy: "disallow",
      agent_posting_scope: "replies_only",
      accepted_agent_ownership_providers: [],
      accepted_agent_ownership_providers_origin: "derived",
      donation_policy_mode: "none",
      donation_partner_status: "unconfigured",
      money_policy: {} as Community["money_policy"],
      content_authenticity_policy: {} as Community["content_authenticity_policy"],
      content_authenticity_detection_policy: {} as Community["content_authenticity_detection_policy"],
      market_context_policy: {} as Community["market_context_policy"],
      source_policy: {} as Community["source_policy"],
      capture_edit_policy: {} as Community["capture_edit_policy"],
      adult_content_policy: {} as Community["adult_content_policy"],
      graphic_content_policy: {} as Community["graphic_content_policy"],
      visual_policy_settings: {} as Community["visual_policy_settings"],
      motion_media_policy: {} as Community["motion_media_policy"],
      language_policy: {} as Community["language_policy"],
      civility_policy: {} as Community["civility_policy"],
      provenance_policy: {} as Community["provenance_policy"],
      promotion_policy: {} as Community["promotion_policy"],
      community_profile: { rules: [], resource_links: [] },
      reference_links: [],
      governance_mode: "centralized",
      created_by_user_id: "usr_1",
      created_at: "2026-07-18T00:00:00.000Z",
      updated_at: "2026-07-18T00:00:00.000Z",
    }

    const first = await buildLocalizedCommunity({ executor, community, locale: "es" })
    await enqueueCommunityTextTranslationOnReadIfNeeded({
      executor,
      communityId: community.community_id,
      localization: first.localized_text,
    })

    const editedCommunity = { ...community, description: "Edited description" }
    const edited = await buildLocalizedCommunity({ executor, community: editedCommunity, locale: "es" })
    await enqueueCommunityTextTranslationOnReadIfNeeded({
      executor,
      communityId: community.community_id,
      localization: edited.localized_text,
    })
    const editedAgain = await buildLocalizedCommunity({ executor, community: editedCommunity, locale: "es" })
    await enqueueCommunityTextTranslationOnReadIfNeeded({
      executor,
      communityId: community.community_id,
      localization: editedAgain.localized_text,
    })

    expect(jobs).toHaveLength(2)
    expect(new Set([...jobs.keys()].map((subjectId) => subjectId.split(":").at(-1)))).toHaveLength(2)
  })
})
