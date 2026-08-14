import { afterEach, describe, expect, test } from "bun:test"
import { createClient, type Client as LibsqlClient } from "@libsql/client"
import type { Client } from "../sql-client"
import { getNextDueAt, listExercises } from "./post-study-exercise-query"

let rawClient: LibsqlClient | null = null

afterEach(() => {
  rawClient?.close()
  rawClient = null
})

async function clientWithoutClozeSchema(): Promise<Client> {
  rawClient = createClient({ url: ":memory:" })
  await rawClient.executeMultiple(`
    CREATE TABLE song_study_unit (
      id TEXT PRIMARY KEY, post_id TEXT NOT NULL, line_id TEXT NOT NULL,
      line_index INTEGER NOT NULL, source_language TEXT, prompt_text TEXT NOT NULL,
      reference_text TEXT NOT NULL, say_it_back_status TEXT NOT NULL,
      unit_version INTEGER NOT NULL, max_attempts INTEGER NOT NULL
    );
    CREATE TABLE song_study_unit_localization (
      unit_id TEXT NOT NULL, target_language TEXT NOT NULL, status TEXT NOT NULL,
      question TEXT, translation_text TEXT, options_json TEXT, correct_option_id TEXT,
      max_attempts INTEGER NOT NULL, localization_version INTEGER NOT NULL
    );
    CREATE TABLE song_study_review_state (
      user_id TEXT NOT NULL, post_id TEXT NOT NULL, line_id TEXT NOT NULL,
      exercise_type TEXT NOT NULL, target_language TEXT NOT NULL, due_at TEXT NOT NULL
    );
    CREATE TABLE posts (
      post_id TEXT PRIMARY KEY, lyrics_language TEXT, lyrics_language_confidence REAL,
      lyrics_language_reliable INTEGER NOT NULL DEFAULT 0, lyrics_language_detector TEXT,
      lyrics_language_detected_at TEXT, lyrics_language_source_hash TEXT
    );
  `)
  return rawClient as unknown as Client
}

describe("post-study exercise query schema tolerance", () => {
  test("omits the fill-blank exercise branch when migration 1156 is absent", async () => {
    const client = await clientWithoutClozeSchema()
    await client.execute({
      sql: "INSERT INTO posts (post_id, lyrics_language, lyrics_language_reliable) VALUES (?1, ?2, ?3)",
      args: ["post_1", "en", 1],
    })
    const result = await listExercises({
      client,
      dueReviewServing: true,
      includeFillBlank: true,
      includeSayItBack: true,
      includeTranslation: true,
      now: "2026-08-13T00:00:00.000Z",
      postId: "post_1",
      targetLanguage: "es",
      userId: "usr_1",
    })

    expect(result).toEqual({ rows: [], totalCount: 0 })
  })

  test("omits the fill-blank due branch when migration 1156 is absent", async () => {
    const client = await clientWithoutClozeSchema()
    const nextDueAt = await getNextDueAt({
      client,
      includeFillBlank: true,
      includeSayItBack: true,
      includeTranslation: true,
      now: "2026-08-13T00:00:00.000Z",
      postId: "post_1",
      targetLanguage: "es",
      userId: "usr_1",
    })

    expect(nextDueAt).toBeNull()
  })

  test("includes fill-blank exercise and due branches when migration 1156 is present", async () => {
    const client = await clientWithoutClozeSchema()
    await client.execute({
      sql: "INSERT INTO posts (post_id, lyrics_language, lyrics_language_reliable) VALUES (?1, ?2, ?3)",
      args: ["post_1", "en", 1],
    })
    await client.execute(`
      CREATE TABLE song_study_unit_cloze (
        unit_id TEXT PRIMARY KEY, cloze_version INTEGER NOT NULL, status TEXT NOT NULL,
        source_text TEXT NOT NULL, source_fingerprint TEXT NOT NULL,
        segments_json TEXT, tokens_json TEXT, correct_placements_json TEXT,
        max_attempts INTEGER NOT NULL
      )
    `)
    await client.execute({
      sql: `INSERT INTO song_study_unit VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      args: ["unit_1", "post_1", "line_1", 0, "en", "Silver rivers carry every memory home", "", "ready", 2, 2],
    })
    await client.execute({
      sql: `INSERT INTO song_study_unit_cloze VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      args: [
        "unit_1",
        3,
        "ready",
        "Silver rivers carry every memory home",
        "a".repeat(64),
        '[{"kind":"blank","id":"blank_1"}]',
        '[{"id":"token_1","text":"Silver"}]',
        '[{"blank_id":"blank_1","token_id":"token_1"}]',
        2,
      ],
    })
    await client.execute({
      sql: `INSERT INTO song_study_review_state VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      args: ["usr_1", "post_1", "line_1", "fill_blank", "en", "2026-08-14T00:00:00.000Z"],
    })

    const exercises = await listExercises({
      client,
      dueReviewServing: false,
      includeFillBlank: true,
      includeSayItBack: false,
      includeTranslation: false,
      now: "2026-08-13T00:00:00.000Z",
      postId: "post_1",
      targetLanguage: "es",
    })
    const nextDueAt = await getNextDueAt({
      client,
      includeFillBlank: true,
      includeSayItBack: false,
      includeTranslation: false,
      now: "2026-08-13T00:00:00.000Z",
      postId: "post_1",
      targetLanguage: "es",
      userId: "usr_1",
    })

    expect(exercises.totalCount).toBe(1)
    expect(exercises.rows[0]).toMatchObject({
      exercise_type: "fill_blank",
      id: `stu:unit_1:fill_blank:v3:${"a".repeat(64)}:en`,
    })
    expect(nextDueAt).toBe("2026-08-14T00:00:00.000Z")
  })
})
