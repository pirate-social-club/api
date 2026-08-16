import { describe, expect, test } from "bun:test"

import {
  assertCommunityJobInsertSql,
  assertReadOnlyBackfillSql,
  parseBackfillRunnerOptions,
  runStagingLanguageBackfill,
  type FrozenFillBlankReport,
} from "./study-fill-blank-language-backfill"

const ENV = {
  CLOUDFLARE_ACCOUNT_ID: "account_fixture",
  CLOUDFLARE_D1_API_TOKEN: "token_fixture",
  ENVIRONMENT: "staging",
}

const ARGS = [
  "--confirmation", "AUDIT FILL BLANK LANGUAGE BACKFILL TO STAGING",
  "--report", "report.json",
  "--output", "artifact.json",
]

const REPORT: FrozenFillBlankReport = {
  allocated_database_count: 1,
  complete: true,
  format_version: 1,
  generator_version: 3,
  observed_at: "2026-08-15T00:00:00.000Z",
  read_only: true,
  report_digest: "fixture-digest",
  scanned_database_count: 1,
  serving_context: {
    fill_blank_enabled: true,
    fill_blank_reserved_slots: 2,
  },
  songs: [{
    database_binding: "DB_CMTY_0001",
    detected_language: { source_hash: null },
    post: {
      community_id: "cmt_fixture",
      post_id: "pst_fixture",
      song_title: "Fixture song",
    },
    source_fingerprint: "fixture-source-fingerprint",
    total_lines: 1,
  }],
  target: "staging",
}

describe("staging fill-blank language backfill guard", () => {
  test("requires staging, explicit confirmation, and a report/output pair", () => {
    expect(parseBackfillRunnerOptions(ARGS, ENV)).toMatchObject({
      concurrency: 2,
      execute: false,
      reportPath: expect.stringContaining("report.json"),
    })
    expect(parseBackfillRunnerOptions([...ARGS, "--execute"], ENV).execute).toBe(true)
    expect(() => parseBackfillRunnerOptions(ARGS, { ...ENV, ENVIRONMENT: "production" }))
      .toThrow("refusing_fill_blank_backfill_outside_staging")
    const wrongConfirmation = [...ARGS]
    wrongConfirmation[1] = "AUDIT FILL BLANK LANGUAGE BACKFILL TO PRODUCTION"
    expect(() => parseBackfillRunnerOptions(wrongConfirmation, ENV))
      .toThrow("fill_blank_backfill_confirmation_mismatch")
  })

  test("allows only one read statement or one parameterized community-job insert", () => {
    expect(() => assertReadOnlyBackfillSql("SELECT post_id FROM posts WHERE post_id = ?1")).not.toThrow()
    expect(() => assertReadOnlyBackfillSql("SELECT 1; DROP TABLE posts"))
      .toThrow("fill_blank_backfill_rejected_multiple_statements")
    expect(() => assertReadOnlyBackfillSql("UPDATE posts SET lyrics_language = 'en'"))
      .toThrow("fill_blank_backfill_rejected_non_read_query")

    expect(() => assertCommunityJobInsertSql(`
      INSERT OR IGNORE INTO community_jobs (job_id, community_id)
      VALUES (?1, ?2)
    `)).not.toThrow()
    expect(() => assertCommunityJobInsertSql("INSERT INTO posts (post_id) VALUES (?1)"))
      .toThrow("fill_blank_backfill_rejected_non_community_job_insert")
    expect(() => assertCommunityJobInsertSql("INSERT OR IGNORE INTO community_jobs (job_id) SELECT ?1"))
      .toThrow("fill_blank_backfill_rejected_non_insert_write")
    expect(() => assertCommunityJobInsertSql("INSERT OR IGNORE INTO community_jobs (job_id) VALUES (?1); DROP TABLE posts"))
      .toThrow("fill_blank_backfill_rejected_multiple_statements")
  })

  test("dry-run plans from the frozen song allowlist without issuing writes", async () => {
    const originalFetch = globalThis.fetch
    const requests: Array<{ sql: string; params: unknown[] }> = []
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { sql: string; params: unknown[] }
      requests.push(body)
      return new Response(JSON.stringify({
        result: [{
          results: [{
            community_id: "cmt_fixture",
            lyrics: "Morning light is on the water and the street",
            lyrics_language_detector: null,
            lyrics_language_source_hash: null,
            post_id: "pst_fixture",
            post_type: "song",
            status: "published",
          }],
          success: true,
        }],
        success: true,
      }), { headers: { "content-type": "application/json" }, status: 200 })
    }
    try {
      const artifact = await runStagingLanguageBackfill({
        bindings: [{ binding: "DB_CMTY_0001", database_id: "db_fixture", database_name: "fixture" }],
        env: ENV,
        options: {
          accountId: ENV.CLOUDFLARE_ACCOUNT_ID,
          concurrency: 1,
          execute: false,
          outputPath: "artifact.json",
          reportPath: "report.json",
          token: ENV.CLOUDFLARE_D1_API_TOKEN,
        },
        report: REPORT,
      })
      expect(artifact).toMatchObject({
        complete: true,
        inserted_job_count: 0,
        mode: "dry-run",
        planned_job_count: 1,
        read_only: true,
      })
      expect(requests).toHaveLength(1)
      expect(requests[0]?.sql).toMatch(/^SELECT/u)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
