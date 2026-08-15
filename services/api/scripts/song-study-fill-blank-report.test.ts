import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

import {
  assertReadOnlyReportSql,
  parseFillBlankRolloutConfig,
  parseStagingD1Bindings,
  resolveReportRunnerOptions,
  runStagingFillBlankReport,
} from "./song-study-fill-blank-report"

const ENV = {
  CLOUDFLARE_ACCOUNT_ID: "account_fixture",
  CLOUDFLARE_D1_API_TOKEN: "token_fixture",
  ENVIRONMENT: "staging",
  SONG_STUDY_FILL_BLANK_ENABLED: "true",
  SONG_STUDY_FILL_BLANK_RESERVED_SLOTS: "2",
}

const ARGS = [
  "--confirmation", "AUDIT FILL BLANK TO STAGING",
  "--output", "artifact.json",
  "--include-say-it-back", "true",
  "--include-translation", "false",
  "--target-language", "en",
]

const STAGING_ROLLOUT = { enabled: true, reservedSlots: 2 }

describe("fill-blank report runner guard", () => {
  test("requires an explicit staging target and serving context", () => {
    expect(resolveReportRunnerOptions(ARGS, ENV, STAGING_ROLLOUT)).toMatchObject({
      concurrency: 2,
      servingContext: {
        fill_blank_enabled: true,
        fill_blank_reserved_slots: 2,
        include_say_it_back: true,
        include_translation: false,
        target_language: "en",
      },
    })
    expect(() => resolveReportRunnerOptions(ARGS, { ...ENV, ENVIRONMENT: "production" }, STAGING_ROLLOUT))
      .toThrow("refusing_fill_blank_report_outside_staging")
    const wrongConfirmation = [...ARGS]
    wrongConfirmation[1] = "AUDIT FILL BLANK TO PROD"
    expect(() => resolveReportRunnerOptions(wrongConfirmation, ENV, STAGING_ROLLOUT))
      .toThrow("fill_blank_report_confirmation_mismatch")
    const wrongBoolean = [...ARGS]
    wrongBoolean[wrongBoolean.indexOf("false")] = "sometimes"
    expect(() => resolveReportRunnerOptions(wrongBoolean, ENV, STAGING_ROLLOUT))
      .toThrow("--include-translation must be true or false")
    expect(resolveReportRunnerOptions(ARGS, {
      ...ENV,
      SONG_STUDY_FILL_BLANK_RESERVED_SLOTS: undefined,
    }, STAGING_ROLLOUT).servingContext.fill_blank_reserved_slots).toBe(2)
    expect(() => resolveReportRunnerOptions(ARGS, {
      ...ENV,
      SONG_STUDY_FILL_BLANK_RESERVED_SLOTS: "0",
    }, STAGING_ROLLOUT)).toThrow("fill_blank_report_reservation_config_mismatch")
    expect(() => resolveReportRunnerOptions(ARGS, {
      ...ENV,
      SONG_STUDY_FILL_BLANK_ENABLED: "false",
    }, STAGING_ROLLOUT)).toThrow("fill_blank_report_existence_config_mismatch")
    expect(() => resolveReportRunnerOptions(ARGS, {
      ...ENV,
      SONG_STUDY_FILL_BLANK_ENABLED: undefined,
    }, { enabled: false, reservedSlots: 0 })).toThrow("fill_blank_report_feature_disabled")
  })

  test("freezes the independent staging and production rollout controls from wrangler config", async () => {
    const config = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8")
    expect(parseFillBlankRolloutConfig(config, "staging")).toEqual({
      enabled: true,
      reservedSlots: 2,
    })
    expect(parseFillBlankRolloutConfig(config, "production")).toEqual({
      enabled: false,
      reservedSlots: 0,
    })
    expect(() => parseFillBlankRolloutConfig("{ \"vars\": {} }", "staging"))
      .toThrow("fill-blank existence flag is missing for staging")
  })

  test("accepts only read statements", () => {
    expect(() => assertReadOnlyReportSql("SELECT post_id FROM posts")).not.toThrow()
    expect(() => assertReadOnlyReportSql({ sql: "PRAGMA table_info(posts)", args: [] })).not.toThrow()
    expect(() => assertReadOnlyReportSql("UPDATE posts SET lyrics_language_reliable = 1"))
      .toThrow("fill_blank_report_rejected_non_read_query")
    expect(() => assertReadOnlyReportSql("WITH changed AS (DELETE FROM posts RETURNING *) SELECT * FROM changed"))
      .toThrow("fill_blank_report_rejected_non_read_query")
    expect(() => assertReadOnlyReportSql("SELECT 1; DROP TABLE posts"))
      .toThrow("fill_blank_report_rejected_multiple_statements")
  })

  test("reads only the top-level staging binding set from JSONC", () => {
    const bindings = parseStagingD1Bindings(`{
      // Staging bindings are top-level; production lives under env.production.
      "d1_databases": [
        { "binding": "D1_POOL", "database_name": "pool-staging", "database_id": "pool-id" },
        { "binding": "DB_CMTY_0001", "database_name": "community-staging", "database_id": "community-id" }
      ],
      "env": {
        "production": {
          "d1_databases": [
            { "binding": "D1_POOL", "database_name": "pool-prod", "database_id": "prod-pool-id" }
          ]
        }
      }
    }`)

    expect(bindings).toEqual([
      { binding: "D1_POOL", database_id: "pool-id", database_name: "pool-staging" },
      { binding: "DB_CMTY_0001", database_id: "community-id", database_name: "community-staging" },
    ])
  })

  test("does not call an empty allocation inventory complete", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(JSON.stringify({
      result: [{ results: [], success: true }],
      success: true,
    }), { headers: { "content-type": "application/json" }, status: 200 })
    try {
      const artifact = await runStagingFillBlankReport({
        bindings: [{ binding: "D1_POOL", database_id: "pool-id", database_name: "pool" }],
        observedAt: "2026-08-14T00:00:00.000Z",
        options: resolveReportRunnerOptions(ARGS, ENV, STAGING_ROLLOUT),
      })
      expect(artifact).toMatchObject({
        allocated_database_count: 0,
        complete: false,
        generator_version: 3,
        scanned_database_count: 0,
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
