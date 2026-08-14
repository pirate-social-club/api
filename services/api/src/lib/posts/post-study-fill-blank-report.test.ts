import { describe, expect, test } from "bun:test"
import { createClient } from "@libsql/client"
import { readFile } from "node:fs/promises"

import type { StudyExerciseRow } from "./post-study-attempt-store"
import {
  buildPublishedSongFillBlankReport,
  generatePublishedSongFillBlankShardReport,
  type StudyFillBlankReportPost,
} from "./post-study-fill-blank-report"
import type { StudyUnitRow } from "./post-study-unit-service"
import { sha256Hex } from "../crypto"

type CorpusSong = { id: string; language: string | null; lines: string[] }

async function corpusFixture(): Promise<CorpusSong[]> {
  return JSON.parse(await readFile(
    new URL("./test-fixtures/post-study-cloze-corpus.json", import.meta.url),
    "utf8",
  )) as CorpusSong[]
}

async function reviewedCorpusReport(): Promise<{ card_digest: string }> {
  return JSON.parse(await readFile(
    new URL("./test-fixtures/post-study-cloze-v3-report.json", import.meta.url),
    "utf8",
  )) as { card_digest: string }
}

function unitsForSong(song: CorpusSong): StudyUnitRow[] {
  return song.lines.map((promptText, index) => ({
    id: `stu_${song.id}_${index + 1}`,
    line_id: `${song.id}_${index + 1}`,
    line_index: index,
    max_attempts: 2,
    prompt_text: promptText,
    reference_text: promptText,
    say_it_back_status: "ready",
    source_language: song.language,
    unit_version: 2,
  }))
}

function sayItBackCandidate(unit: StudyUnitRow): StudyExerciseRow {
  return {
    correct_option_id: null,
    exercise_type: "say_it_back",
    id: `stu:${unit.id}:say_it_back:${unit.source_language ?? "source"}`,
    line_id: unit.line_id,
    line_index: unit.line_index,
    max_attempts: unit.max_attempts,
    options_json: null,
    prompt_text: unit.prompt_text,
    qualifies_for_reward: true,
    question: null,
    reference_text: unit.reference_text,
    review_language: unit.source_language ?? "source",
    study_pack_version: unit.unit_version,
    translation_text: null,
  }
}

function reportPost(song: CorpusSong): StudyFillBlankReportPost {
  return {
    community_id: "cmt_fixture",
    lyrics_language: song.language,
    lyrics_language_confidence: song.language ? 0.95 : null,
    lyrics_language_detector: song.language ? "fixture:detector" : null,
    lyrics_language_reliable: song.language !== null,
    lyrics_language_source_hash: song.language ? `hash:${song.id}` : null,
    post_id: `post_${song.id}`,
    song_title: song.id,
  }
}

describe("published song fill-blank report", () => {
  test("preserves the reviewed corpus card digest and reports real lesson exposure", async () => {
    const corpus = await corpusFixture()
    const reports = await Promise.all(corpus.map(async (song) => {
      const units = unitsForSong(song)
      return await buildPublishedSongFillBlankReport({
        canonicalCandidates: units.map(sayItBackCandidate),
        post: reportPost(song),
        units,
      })
    }))
    const cards = reports.flatMap((report) => report.eligible_lines.map((line) => ({
      answers: line.selected_blanks.map((blank) => blank.text),
      blank_count: line.selected_blanks.length,
      id: line.line_id,
      language: report.detected_language.language,
      source: line.prompt_text,
    })))
    const reviewed = await reviewedCorpusReport()

    expect(cards).toHaveLength(38)
    expect(await sha256Hex(JSON.stringify(cards))).toBe(reviewed.card_digest)
    expect(reports.reduce(
      (total, report) => total + report.session_inclusion.included_fill_blank_candidates,
      0,
    )).toBe(26)
    expect(reports.find((report) => report.post.post_id === "post_english")?.eligible_lines.slice(0, 3))
      .toMatchObject([
        { session_included: true, session_ordinal: 8 },
        { session_included: true, session_ordinal: 9 },
        { session_exclusion_reason: "session_capacity", session_included: false },
      ])
    expect(reports.find((report) => report.post.post_id === "post_missing-language")?.rejection_counts)
      .toMatchObject({ lyrics_language_missing: 2 })
    expect(reports.find((report) => report.post.post_id === "post_unsupported-japanese")?.rejection_counts)
      .toMatchObject({ unsupported_language: 2 })
  })

  test("matches the route's thirty-candidate window and makes enrichment invisible at capacity", async () => {
    const corpus = await corpusFixture()
    const sourceLines = corpus.flatMap((song) => song.lines).slice(0, 20)
    const song: CorpusSong = { id: "long-fixture", language: "en", lines: sourceLines }
    const units = unitsForSong(song)
    const report = await buildPublishedSongFillBlankReport({
      canonicalCandidates: units.map(sayItBackCandidate),
      post: reportPost(song),
      units,
    })

    expect(report.eligible_line_count).toBeGreaterThan(0)
    expect(report.session_inclusion.qualifying_candidates).toBe(20)
    expect(report.session_inclusion.candidate_window_count).toBe(30)
    expect(report.session_inclusion.included_fill_blank_candidates).toBe(0)
    expect(report.eligible_lines.some((line) => line.session_exclusion_reason === "outside_candidate_window"))
      .toBe(true)
    expect(report.eligible_lines.every((line) =>
      line.session_exclusion_reason === "qualifying_capacity"
        || line.session_exclusion_reason === "outside_candidate_window")).toBe(true)
  })

  test("reads only published songs and freezes language provenance in the shard report", async () => {
    const corpus = await corpusFixture()
    const english = corpus.find((song) => song.id === "english")!
    const client = createClient({ url: ":memory:" })
    try {
      await client.executeMultiple(`
        CREATE TABLE posts (
          post_id TEXT PRIMARY KEY, community_id TEXT NOT NULL, post_type TEXT NOT NULL,
          status TEXT NOT NULL, title TEXT, song_title TEXT, lyrics_language TEXT,
          lyrics_language_confidence REAL, lyrics_language_reliable INTEGER NOT NULL DEFAULT 0,
          lyrics_language_detector TEXT, lyrics_language_source_hash TEXT
        );
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
      `)
      await client.batch([
        {
          sql: `INSERT INTO posts VALUES
            (?1, 'cmt_fixture', 'song', 'published', NULL, 'Published fixture', 'en', 0.96, 1, 'fixture:detector', 'fixture-hash')`,
          args: ["post_published"],
        },
        {
          sql: `INSERT INTO posts VALUES
            (?1, 'cmt_fixture', 'song', 'draft', NULL, 'Draft fixture', 'en', 0.99, 1, 'fixture:detector', 'draft-hash')`,
          args: ["post_draft"],
        },
        ...english.lines.map((line, index) => ({
          sql: `INSERT INTO song_study_unit VALUES
            (?1, 'post_published', ?2, ?3, 'en', ?4, ?4, 'ready', 2, 2)`,
          args: [`stu_${index + 1}`, `line_${index + 1}`, index, line],
        })),
      ], "write")

      const report = await generatePublishedSongFillBlankShardReport({
        client,
        observedAt: "2026-08-14T00:00:00.000Z",
        servingContext: {
          include_say_it_back: true,
          include_translation: false,
          target_language: "en",
        },
      })

      expect(report).toMatchObject({
        format_version: 1,
        observed_at: "2026-08-14T00:00:00.000Z",
        read_only: true,
        song_count: 1,
        serving_context: {
          include_say_it_back: true,
          include_translation: false,
          mode: "first_learn_without_review_state",
          target_language: "en",
        },
      })
      expect(report.report_digest).toMatch(/^[0-9a-f]{64}$/u)
      expect(report.songs[0]).toMatchObject({
        detected_language: {
          confidence: 0.96,
          detector: "fixture:detector",
          language: "en",
          reliable: true,
          source_hash: "fixture-hash",
        },
        eligible_line_count: 8,
        post: { post_id: "post_published", song_title: "Published fixture" },
        session_inclusion: { included_fill_blank_candidates: 2 },
      })
      expect((await client.execute("SELECT COUNT(*) AS count FROM posts")).rows[0]?.count).toBe(2)
    } finally {
      client.close()
    }
  })
})
