import { describe, expect, test } from "bun:test"
import { createClient } from "@libsql/client"
import {
  computeLyricsLanguageSourceHash,
  materializePostLyricsLanguageDetection,
} from "./lyrics-language-detection-materializer"

const env = {} as never

describe("lyrics language materializer", () => {
  test("degrades when migration 1143 is absent", async () => {
    const client = createClient({ url: ":memory:" })
    try {
      await client.execute("CREATE TABLE posts (post_id TEXT PRIMARY KEY, lyrics TEXT, post_type TEXT)")
      await expect(materializePostLyricsLanguageDetection({
        client: client as never,
        env,
        post: { lyrics: "The morning comes", post_id: "post_1", post_type: "song" },
      })).resolves.toBe("skipped:missing_columns")
    } finally {
      client.close()
    }
  })

  test("does not call the provider for a current detector result", async () => {
    const client = createClient({ url: ":memory:" })
    try {
      await client.execute(`
        CREATE TABLE posts (
          post_id TEXT PRIMARY KEY, post_type TEXT, lyrics TEXT,
          lyrics_language TEXT, lyrics_language_confidence REAL,
          lyrics_language_reliable INTEGER NOT NULL DEFAULT 0,
          lyrics_language_detector TEXT, lyrics_language_detected_at TEXT,
          lyrics_language_source_hash TEXT, updated_at TEXT
        )
      `)
      const hash = await computeLyricsLanguageSourceHash("The morning comes and the sun rises")
      await expect(materializePostLyricsLanguageDetection({
        client: client as never,
        env,
        post: {
          lyrics: "The morning comes and the sun rises",
          lyrics_language_detector: "openrouter:test",
          lyrics_language_source_hash: hash,
          lyrics_language_reliable: true,
          post_id: "post_1",
          post_type: "song",
        },
      })).resolves.toBe("cached")
    } finally {
      client.close()
    }
  })

  test("rejects short lyrics before calling the provider and clears stale reliability", async () => {
    const client = createClient({ url: ":memory:" })
    try {
      await client.execute(`
        CREATE TABLE posts (
          post_id TEXT PRIMARY KEY, post_type TEXT, lyrics TEXT,
          lyrics_language TEXT, lyrics_language_confidence REAL,
          lyrics_language_reliable INTEGER NOT NULL DEFAULT 0,
          lyrics_language_detector TEXT, lyrics_language_detected_at TEXT,
          lyrics_language_source_hash TEXT, updated_at TEXT
        )
      `)
      await client.execute({
        sql: "INSERT INTO posts (post_id, post_type, lyrics, lyrics_language, lyrics_language_reliable, updated_at) VALUES (?1, ?2, ?3, ?4, 1, ?5)",
        args: ["post_1", "song", "Short lyric", "en", "original"],
      })
      await expect(materializePostLyricsLanguageDetection({
        client: client as never,
        env,
        post: {
          lyrics: "Short lyric",
          lyrics_language_detector: "openrouter:old",
          lyrics_language_reliable: true,
          post_id: "post_1",
          post_type: "song",
        },
      })).resolves.toBe("skipped:too_short")
      const row = await client.execute("SELECT lyrics_language, lyrics_language_reliable, updated_at FROM posts WHERE post_id = 'post_1'")
      expect(row.rows[0]).toMatchObject({ lyrics_language: null, lyrics_language_reliable: 0, updated_at: "original" })
    } finally {
      client.close()
    }
  })
})
