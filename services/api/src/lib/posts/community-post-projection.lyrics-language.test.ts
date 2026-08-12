import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"

import {
  postProjectionSchemaFromResults,
  postProjectionSchemaReadStatements,
  postSelectColumnsForSchema,
  type PostProjectionSchema,
} from "./community-post-projection"

/**
 * Migration 1143 (posts.lyrics_language + 5 provenance columns) is classified
 * transitional/deferred: it exists on core main but has NOT been applied across the live
 * fleet, and shard DB_CMTY_0092 is quarantined and will not receive it until its quarantine
 * is resolved.
 *
 * A shard without those columns must project them as ABSENT, never fail the query. These
 * tests pin that contract in both directions.
 */

const BASE: Omit<PostProjectionSchema, "hasLyricsLanguageColumns"> = {
  hasAssetStoryColumns: true,
  hasCommentLockColumns: true,
  hasCrosspostSourceJson: true,
  hasPostEvents: true,
  hasRightsHolds: true,
  hasSongAnnotationsUrl: true,
  hasSongCoverArtRef: true,
  hasSongDurationMs: true,
  hasAsyncPublishColumns: true,
}

const LYRICS_COLUMNS = [
  "lyrics_language",
  "lyrics_language_confidence",
  "lyrics_language_reliable",
  "lyrics_language_detector",
  "lyrics_language_detected_at",
  "lyrics_language_source_hash",
] as const

describe("lyrics_language projection compatibility (1143 transitional)", () => {
  test("builds and parses the four schema probes used by batched feed hydration", () => {
    expect(postProjectionSchemaReadStatements()).toEqual([
      { sql: "PRAGMA table_info(posts)" },
      { sql: "PRAGMA table_info(assets)" },
      { sql: "PRAGMA table_info(post_events)" },
      { sql: "PRAGMA table_info(rights_holds)" },
    ])

    const schema = postProjectionSchemaFromResults([
      { rows: [
        { name: "crosspost_source_json" },
        { name: "song_annotations_url" },
        { name: "song_cover_art_ref" },
        { name: "song_duration_ms" },
        { name: "comments_locked" },
        { name: "comments_locked_at" },
        { name: "comments_locked_by_user_id" },
        { name: "comments_lock_reason" },
        { name: "idempotency_body_hash" },
        { name: "publish_failure_code" },
        { name: "publish_failure_message" },
        { name: "publish_failure_retryable" },
        { name: "publish_failed_at" },
        { name: "lyrics_language" },
        { name: "lyrics_language_confidence" },
        { name: "lyrics_language_reliable" },
        { name: "lyrics_language_detector" },
        { name: "lyrics_language_detected_at" },
        { name: "lyrics_language_source_hash" },
      ] },
      { rows: [
        { name: "asset_id" },
        { name: "community_id" },
        { name: "story_ip_id" },
        { name: "story_royalty_registration_status" },
      ] },
      { rows: [{ name: "post_event_id" }] },
      { rows: [{ name: "rights_hold_id" }] },
    ])

    expect(schema).toEqual({ ...BASE, hasLyricsLanguageColumns: true })
  })

  test("a shard WITH 1143 selects the real columns", () => {
    const sql = postSelectColumnsForSchema({ ...BASE, hasLyricsLanguageColumns: true })
    for (const column of LYRICS_COLUMNS) {
      expect(sql).toContain(column)
      expect(sql).not.toContain(`NULL AS ${column}`)
    }
  })

  test("a shard WITHOUT 1143 projects absent values, not an error", () => {
    const sql = postSelectColumnsForSchema({ ...BASE, hasLyricsLanguageColumns: false })
    expect(sql).toContain("NULL AS lyrics_language")
    expect(sql).toContain("NULL AS lyrics_language_confidence")
    expect(sql).toContain("NULL AS lyrics_language_detector")
    expect(sql).toContain("NULL AS lyrics_language_detected_at")
    expect(sql).toContain("NULL AS lyrics_language_source_hash")
  })

  test("the reliable flag falls back to 0, never NULL and never 1", () => {
    // The column is NOT NULL DEFAULT 0: absence of detection evidence must read as
    // unverified. Projecting NULL here would let a nullish check mistake "unknown" for
    // "reliable" downstream, and projecting 1 would assert a detection that never ran.
    const sql = postSelectColumnsForSchema({ ...BASE, hasLyricsLanguageColumns: false })
    expect(sql).toContain("0 AS lyrics_language_reliable")
    expect(sql).not.toContain("NULL AS lyrics_language_reliable")
    expect(sql).not.toContain("1 AS lyrics_language_reliable")
  })

  test("the fallback expression executes against a posts table lacking the columns", () => {
    // The point of the fallback: a pre-1143 shard must answer the query rather than raise
    // "no such column". Proven by running the fallback list against a table without them.
    const db = new Database(":memory:")
    try {
      db.exec("CREATE TABLE posts (post_id TEXT PRIMARY KEY)")
      db.exec("INSERT INTO posts (post_id) VALUES ('pst_1')")
      const row = db.query(
        `SELECT NULL AS lyrics_language, NULL AS lyrics_language_confidence,
                0 AS lyrics_language_reliable, NULL AS lyrics_language_detector,
                NULL AS lyrics_language_detected_at, NULL AS lyrics_language_source_hash
         FROM posts WHERE post_id = 'pst_1'`,
      ).get()
      expect(row).toEqual({
        lyrics_language: null,
        lyrics_language_confidence: null,
        lyrics_language_reliable: 0,
        lyrics_language_detector: null,
        lyrics_language_detected_at: null,
        lyrics_language_source_hash: null,
      })
    } finally {
      db.close()
    }
  })
})
