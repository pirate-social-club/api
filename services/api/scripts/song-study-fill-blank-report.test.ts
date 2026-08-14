import { describe, expect, test } from "bun:test"

import {
  assertReadOnlyReportSql,
  parseStagingD1Bindings,
  resolveReportRunnerOptions,
} from "./song-study-fill-blank-report"

const ENV = {
  CLOUDFLARE_ACCOUNT_ID: "account_fixture",
  CLOUDFLARE_D1_API_TOKEN: "token_fixture",
  ENVIRONMENT: "staging",
}

const ARGS = [
  "--confirmation", "AUDIT FILL BLANK TO STAGING",
  "--output", "artifact.json",
  "--include-say-it-back", "true",
  "--include-translation", "false",
  "--target-language", "en",
]

describe("fill-blank report runner guard", () => {
  test("requires an explicit staging target and serving context", () => {
    expect(resolveReportRunnerOptions(ARGS, ENV)).toMatchObject({
      concurrency: 2,
      servingContext: {
        include_say_it_back: true,
        include_translation: false,
        target_language: "en",
      },
    })
    expect(() => resolveReportRunnerOptions(ARGS, { ...ENV, ENVIRONMENT: "production" }))
      .toThrow("refusing_fill_blank_report_outside_staging")
    const wrongConfirmation = [...ARGS]
    wrongConfirmation[1] = "AUDIT FILL BLANK TO PROD"
    expect(() => resolveReportRunnerOptions(wrongConfirmation, ENV))
      .toThrow("fill_blank_report_confirmation_mismatch")
    const wrongBoolean = [...ARGS]
    wrongBoolean[wrongBoolean.indexOf("false")] = "sometimes"
    expect(() => resolveReportRunnerOptions(wrongBoolean, ENV))
      .toThrow("--include-translation must be true or false")
  })

  test("accepts only read statements", () => {
    expect(() => assertReadOnlyReportSql("SELECT post_id FROM posts")).not.toThrow()
    expect(() => assertReadOnlyReportSql({ sql: "PRAGMA table_info(posts)", args: [] })).not.toThrow()
    expect(() => assertReadOnlyReportSql("UPDATE posts SET lyrics_language_reliable = 1"))
      .toThrow("fill_blank_report_rejected_non_read_query")
    expect(() => assertReadOnlyReportSql("WITH changed AS (DELETE FROM posts RETURNING *) SELECT * FROM changed"))
      .toThrow("fill_blank_report_rejected_non_read_query")
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
})
