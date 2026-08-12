import { describe, expect, test } from "bun:test"
import { createClient } from "@libsql/client"
import { buildStudyCloze, ensureStudyClozeRows } from "./post-study-cloze-service"
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

describe("buildStudyCloze", () => {
  test("builds stable render segments while withholding placement meaning", () => {
    const target = unit("line_001", "I walked beside the river under moonlight")
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

  test("returns unavailable when a safe word bank cannot be built", () => {
    const target = unit("line_001", "go now")
    expect(buildStudyCloze(target, [target])).toBeNull()
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
      await ensureStudyClozeRows(client, "post_1")
      const before = await client.execute("SELECT unit_id, source_fingerprint FROM song_study_unit_cloze ORDER BY unit_id")
      await client.execute("UPDATE song_study_unit SET prompt_text = 'The evening carries another vivid memory' WHERE id = 'stu_2'")
      await ensureStudyClozeRows(client, "post_1")
      const after = await client.execute("SELECT unit_id, source_fingerprint FROM song_study_unit_cloze ORDER BY unit_id")

      expect(before.rows).toHaveLength(2)
      expect(after.rows).toHaveLength(2)
      expect(after.rows[0]?.source_fingerprint).not.toBe(before.rows[0]?.source_fingerprint)
      expect(after.rows[0]?.source_fingerprint).toBe(after.rows[1]?.source_fingerprint)
    } finally {
      client.close()
    }
  })
})
