import { describe, expect, test } from "bun:test"
import { createClient } from "@libsql/client"
import { readFile } from "node:fs/promises"
import { sha256Hex } from "../crypto"
import {
  analyzeStudyCloze,
  buildStudyCloze,
  ensureStudyClozeRows,
  STUDY_CLOZE_GENERATION_VERSION,
} from "./post-study-cloze-service"
import type { StudyUnitRow } from "./post-study-unit-service"

function unit(line_id: string, prompt_text: string): StudyUnitRow {
  return {
    id: `stu_${line_id}`,
    line_id,
    line_index: Number(line_id.replace(/\D/gu, "")),
    max_attempts: 2,
    prompt_text,
    reference_text: prompt_text,
    say_it_back_status: "ready",
    source_language: "en",
    unit_version: 2,
  }
}

type CorpusSong = { id: string; language: string | null; lines: string[] }

async function readFixture<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(new URL(`./test-fixtures/${name}`, import.meta.url), "utf8")) as T
}

describe("buildStudyCloze", () => {
  test("builds stable render segments while withholding placement meaning", () => {
    const target = unit("line_001", "I wandered slowly beside silver rivers carrying distant moonlight")
    const units = [
      target,
      unit("line_002", "The morning carries every quiet memory"),
    ]
    const first = buildStudyCloze(target, units)
    const second = buildStudyCloze(target, units)

    expect(first).toEqual(second)
    const tokenIds = new Set(first?.tokens.map((token) => token.id) ?? [])
    expect(first?.correctPlacements).toHaveLength(2)
    expect(first?.tokens).toHaveLength(4)
    expect(first?.tokens.every((token) => /^token_\d+$/u.test(token.id))).toBe(true)
    expect(first?.correctPlacements.every((placement) => tokenIds.has(placement.token_id))).toBe(true)
    expect(first?.segments.filter((segment) => segment.kind === "blank")).toHaveLength(2)
    const answerIds = new Set(first?.correctPlacements.map((placement) => placement.token_id) ?? [])
    const visible = new Set(target.prompt_text.toLowerCase().split(/\s+/u))
    expect(first?.tokens.filter((token) => !answerIds.has(token.id)).every((token) => !visible.has(token.text.toLowerCase()))).toBe(true)
  })

  test("rejects initial and function-word gaps and separates two selected gaps", () => {
    const target = unit(
      "line_001",
      "Take me back to where bright harbour lanterns guide weary travellers homeward",
    )
    const cloze = buildStudyCloze(target, [
      target,
      unit("line_002", "Quiet morning carries vivid memories beyond silver mountains"),
    ])
    expect(cloze).not.toBeNull()
    const answers = new Map(cloze?.tokens.map((token) => [token.id, token.text]))
    const answerWords = cloze?.correctPlacements.map((placement) => answers.get(placement.token_id)) ?? []
    expect(answerWords).not.toContain("Take")
    expect(answerWords.every((word) => !["me", "to", "where"].includes(String(word).toLowerCase()))).toBe(true)
    const blanks = cloze?.segments.flatMap((segment, index) => segment.kind === "blank" ? [index] : []) ?? []
    expect(blanks).toHaveLength(2)
    const between = cloze?.segments.slice(blanks[0]! + 1, blanks[1]).map((segment) =>
      segment.kind === "text" ? segment.text : "").join("") ?? ""
    expect(between).toMatch(/[\p{L}\p{N}]+/u)
  })

  test("fails closed for missing policies, unsupported scripts, and low-context lines", () => {
    const distractors = unit("line_009", "Quiet morning carries vivid memories beyond silver mountains")
    const cases = [
      {
        expected: "unsupported_language",
        target: { ...unit("line_001", "Moonlight carries every distant memory home"), source_language: null },
      },
      {
        expected: "unsupported_language",
        target: { ...unit("line_002", "朝はすべての静かな記憶を運んでくる"), source_language: "ja" },
      },
      {
        expected: "unsupported_language",
        target: { ...unit("line_003", "아침은 조용한 기억을 집으로 데려온다"), source_language: "ko" },
      },
      {
        expected: "unsupported_script",
        target: unit("line_004", "朝はすべての静かな記憶を運んでくる"),
      },
      { expected: "too_few_words", target: unit("line_005", "Oh oh oh") },
    ] as const
    for (const fixture of cases) {
      expect(analyzeStudyCloze(fixture.target, [fixture.target, distractors]).unavailableReason).toBe(fixture.expected)
    }
  })

  test("normalizes locale variants through the reviewed language policy", () => {
    const target = {
      ...unit("line_001", "Moonlight carries every distant memory homeward"),
      source_language: "en-US",
    }
    const companion = {
      ...unit("line_002", "Silver rivers guide quiet travellers beyond mountains"),
      source_language: "en-US",
    }
    expect(buildStudyCloze(target, [target, companion])).not.toBeNull()
  })

  test("returns unavailable when a safe word bank cannot be built", () => {
    const target = unit("line_001", "go now")
    expect(buildStudyCloze(target, [target])).toBeNull()
  })

  test("degrades safely when migration 1156 is absent", async () => {
    const client = createClient({ url: ":memory:" })
    try {
      await client.executeMultiple(`
        CREATE TABLE song_study_unit (
          id TEXT PRIMARY KEY, post_id TEXT NOT NULL, line_id TEXT NOT NULL,
          line_index INTEGER NOT NULL, source_language TEXT, prompt_text TEXT NOT NULL,
          reference_text TEXT NOT NULL, say_it_back_status TEXT NOT NULL,
          unit_version INTEGER NOT NULL, max_attempts INTEGER NOT NULL
        );
        INSERT INTO song_study_unit VALUES
          ('stu_1', 'post_1', 'line_001', 0, 'en', 'I walked beside the river under moonlight', 'I walked beside the river under moonlight', 'ready', 2, 2);
      `)

      await expect(ensureStudyClozeRows({ client, postId: "post_1", lyricsLanguage: "en", lyricsLanguageReliable: true })).resolves.toBeUndefined()
      const schema = await client.execute("SELECT name FROM sqlite_master WHERE name = 'song_study_unit_cloze'")
      expect(schema.rows).toEqual([])
    } finally {
      client.close()
    }
  })

  test("regenerates every row when another source line changes", async () => {
    const client = createClient({ url: ":memory:" })
    try {
      await client.executeMultiple(`
        CREATE TABLE song_study_unit (
          id TEXT PRIMARY KEY, post_id TEXT NOT NULL, line_id TEXT NOT NULL,
          line_index INTEGER NOT NULL, source_language TEXT, prompt_text TEXT NOT NULL,
          reference_text TEXT NOT NULL, say_it_back_status TEXT NOT NULL,
          unit_version INTEGER NOT NULL, max_attempts INTEGER NOT NULL
        );
        CREATE TABLE song_study_unit_cloze (
          unit_id TEXT PRIMARY KEY, cloze_version INTEGER NOT NULL, status TEXT NOT NULL,
          source_text TEXT NOT NULL, source_fingerprint TEXT NOT NULL,
          segments_json TEXT, tokens_json TEXT, correct_placements_json TEXT,
          max_attempts INTEGER NOT NULL, generated_at TEXT, created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO song_study_unit VALUES
          ('stu_1', 'post_1', 'line_001', 0, 'en', 'I walked beside the river under moonlight', 'I walked beside the river under moonlight', 'ready', 2, 2),
          ('stu_2', 'post_1', 'line_002', 1, 'en', 'The morning carries every quiet memory', 'The morning carries every quiet memory', 'ready', 2, 2);
      `)
      await ensureStudyClozeRows({ client, postId: "post_1", lyricsLanguage: "en", lyricsLanguageReliable: false })
      expect((await client.execute("SELECT COUNT(*) AS count FROM song_study_unit_cloze")).rows[0]?.count).toBe(0)
      await ensureStudyClozeRows({ client, postId: "post_1", lyricsLanguage: "en", lyricsLanguageReliable: true, lyricsLanguageDetector: "test:en", lyricsLanguageSourceHash: "lyrics-v1" })
      const before = await client.execute("SELECT unit_id, cloze_version, source_fingerprint FROM song_study_unit_cloze ORDER BY unit_id")
      await client.execute("UPDATE song_study_unit SET prompt_text = 'The evening carries another vivid memory' WHERE id = 'stu_2'")
      await ensureStudyClozeRows({ client, postId: "post_1", lyricsLanguage: "en", lyricsLanguageReliable: true, lyricsLanguageDetector: "test:en", lyricsLanguageSourceHash: "lyrics-v1" })
      const after = await client.execute("SELECT unit_id, source_fingerprint FROM song_study_unit_cloze ORDER BY unit_id")

      expect(before.rows).toHaveLength(2)
      expect(after.rows).toHaveLength(2)
      expect(Number(before.rows[0]?.cloze_version)).toBe(STUDY_CLOZE_GENERATION_VERSION)
      expect(String(before.rows[0]?.source_fingerprint)).toMatch(/^[0-9a-f]{64}$/u)
      expect(after.rows[0]?.source_fingerprint).not.toBe(before.rows[0]?.source_fingerprint)
      expect(after.rows[0]?.source_fingerprint).toBe(after.rows[1]?.source_fingerprint)
    } finally {
      client.close()
    }
  })

  test("regenerates when lyrics detector metadata changes even if lines do not", async () => {
    const client = createClient({ url: ":memory:" })
    try {
      await client.executeMultiple(`
        CREATE TABLE song_study_unit (
          id TEXT PRIMARY KEY, post_id TEXT NOT NULL, line_id TEXT NOT NULL,
          line_index INTEGER NOT NULL, source_language TEXT, prompt_text TEXT NOT NULL,
          reference_text TEXT NOT NULL, say_it_back_status TEXT NOT NULL,
          unit_version INTEGER NOT NULL, max_attempts INTEGER NOT NULL
        );
        CREATE TABLE song_study_unit_cloze (
          unit_id TEXT PRIMARY KEY, cloze_version INTEGER NOT NULL, status TEXT NOT NULL,
          source_text TEXT NOT NULL, source_fingerprint TEXT NOT NULL,
          segments_json TEXT, tokens_json TEXT, correct_placements_json TEXT,
          max_attempts INTEGER NOT NULL, generated_at TEXT, created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO song_study_unit VALUES
          ('stu_1', 'post_1', 'line_001', 0, 'en', 'I walked beside the river under moonlight', 'I walked beside the river under moonlight', 'ready', 2, 2),
          ('stu_2', 'post_1', 'line_002', 1, 'en', 'The morning carries every quiet memory', 'The morning carries every quiet memory', 'ready', 2, 2);
      `)
      const base = {
        client,
        lyricsLanguage: "en",
        lyricsLanguageReliable: true,
        lyricsLanguageDetector: "openrouter:model-a",
        postId: "post_1",
      } as const
      await ensureStudyClozeRows({ ...base, lyricsLanguageSourceHash: "lyrics-v1" })
      const first = await client.execute("SELECT source_fingerprint FROM song_study_unit_cloze WHERE unit_id = 'stu_1'")
      await ensureStudyClozeRows({ ...base, lyricsLanguageDetector: "openrouter:model-b", lyricsLanguageSourceHash: "lyrics-v2" })
      const second = await client.execute("SELECT source_fingerprint FROM song_study_unit_cloze WHERE unit_id = 'stu_1'")
      expect(first.rows[0]?.source_fingerprint).not.toBe(second.rows[0]?.source_fingerprint)
    } finally {
      client.close()
    }
  })

  test("matches the reviewed multilingual corpus quality report", async () => {
    const corpus = await readFixture<CorpusSong[]>("post-study-cloze-corpus.json")
    const supportedLanguages = new Set(["de", "en", "es", "fr", "it", "pt", "ru"])
    const auditedFunctionWords = new Set([
      "across", "and", "be", "de", "del", "du", "el", "la", "le", "les", "of", "prima", "que", "the", "to",
      "were", "would", "нас", "через", "этом",
    ])
    const cards: Array<{
      answers: string[]
      blank_count: number
      id: string
      language: string | null
      source: string
    }> = []
    const unavailable: Record<string, number> = {}
    const violations = {
      adjacent_blanks: 0,
      audited_function_words: 0,
      initial_blanks: 0,
      missing_language_cards: 0,
      short_line_cards: 0,
      unsupported_language_cards: 0,
    }
    for (const song of corpus) {
      const units = song.lines.map((line, index) => ({
        ...unit(`${song.id}_${index + 1}`, line),
        id: `stu_${song.id}_${index + 1}`,
        line_index: index,
        source_language: song.language,
      }))
      for (const candidate of units) {
        const analysis = analyzeStudyCloze(candidate, units)
        if (!analysis.cloze) {
          unavailable[analysis.unavailableReason] = (unavailable[analysis.unavailableReason] ?? 0) + 1
          continue
        }
        const tokens = new Map(analysis.cloze.tokens.map((token) => [token.id, token.text]))
        const answers = analysis.cloze.correctPlacements.map((placement) => tokens.get(placement.token_id) ?? "")
        cards.push({
          answers,
          blank_count: analysis.cloze.correctPlacements.length,
          id: candidate.line_id,
          language: song.language,
          source: candidate.prompt_text,
        })
        if (analysis.cloze.segments[0]?.kind === "blank") violations.initial_blanks += 1
        const blankIndexes = analysis.cloze.segments.flatMap((segment, index) => segment.kind === "blank" ? [index] : [])
        if (blankIndexes.length > 1) {
          const between = analysis.cloze.segments
            .slice(blankIndexes[0]! + 1, blankIndexes[1])
            .map((segment) => segment.kind === "text" ? segment.text : "")
            .join("")
          if (!/[\p{L}\p{N}]+/u.test(between)) violations.adjacent_blanks += 1
        }
        violations.audited_function_words += answers.filter((answer) =>
          auditedFunctionWords.has(answer.normalize("NFKC").toLocaleLowerCase())).length
        if (candidate.prompt_text.trim().split(/\s+/u).length < 4) violations.short_line_cards += 1
        if (song.language == null) violations.missing_language_cards += 1
        if (song.language != null && !supportedLanguages.has(song.language)) {
          violations.unsupported_language_cards += 1
        }
      }
    }
    const generatedCards = cards.length
    const report = {
      blank_distribution: {
        one: cards.filter((card) => card.blank_count === 1).length,
        two: cards.filter((card) => card.blank_count === 2).length,
      },
      card_digest: await sha256Hex(JSON.stringify(cards)),
      generated_cards: generatedCards,
      samples: [...supportedLanguages].flatMap((language) => {
        const sample = cards.find((card) => card.language === language)
        return sample ? [sample] : []
      }),
      total_lines: corpus.reduce((total, song) => total + song.lines.length, 0),
      unavailable,
      violations,
      yield_percent: Number((generatedCards * 100 / corpus.reduce(
        (total, song) => total + song.lines.length,
        0,
      )).toFixed(1)),
      yield_warning_below_50_percent: generatedCards * 2 < corpus.reduce(
        (total, song) => total + song.lines.length,
        0,
      ),
    }
    expect(report).toEqual(await readFixture("post-study-cloze-v3-report.json"))
  })
})
