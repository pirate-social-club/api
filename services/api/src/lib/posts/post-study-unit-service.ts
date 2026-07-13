import type { DbExecutor } from "../db-helpers"
import { makeId, nowIso } from "../helpers"
import type { Client, InStatement } from "../sql-client"
import {
  containsSpacelessScript,
  normalizeForStudy,
  segmentSpacelessRecallTokens,
} from "./post-study-recall-grading"

// v2: strip trailing line punctuation at unit creation (see stripTrailingLinePunctuation)
// — bumping this forces existing units to be re-split so stored text is canonicalized.
export const STUDY_UNIT_GENERATION_VERSION = 2

export type StudyUnitRow = {
  id: string
  line_id: string
  line_index: number
  max_attempts: number
  prompt_text: string
  reference_text: string
  say_it_back_status: "ready" | "unavailable"
  source_language: string | null
  unit_version: number
}

type StudyUnitPost = {
  lyrics: string | null
  post_id: string
  source_language: string | null
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed || null
}

function studyLineId(index: number): string {
  return `line_${String(index + 1).padStart(3, "0")}`
}

function isPureAdLib(line: string): boolean {
  return /^\s*\([^)]+\)\s*$/u.test(line)
}

function stripTrailingAdLibs(line: string): string {
  return line.replace(/\s*\([^)]*\)\s*$/u, "").trim()
}

// Lyrics are one sentence split across lines, so lines routinely end in a comma
// (or period / semicolon / colon / dash) that reads as a wart when shown as a
// say-it-back reference or fed to the translation model. Drop that trailing
// punctuation for clean display + clean LLM input, but keep a trailing ? or !
// (they change how the line reads) and never touch internal punctuation or
// apostrophes — grading relies on contractions.
function stripTrailingLinePunctuation(line: string): string {
  return line.replace(/[\s,.;:—–-]+$/u, "").trim()
}

export function studyWordCount(line: string): number {
  const normalized = normalizeForStudy(line)
  if (!normalized) return 0
  if (!/\s/u.test(normalized) && containsSpacelessScript(normalized)) {
    return segmentSpacelessRecallTokens(normalized).length
  }
  return normalized.split(/\s+/u).filter(Boolean).length
}

export function splitLyricsForStudy(lyrics: string | null): Array<{ lineId: string; lineIndex: number; text: string }> {
  const seen = new Set<string>()
  const units: Array<{ lineId: string; lineIndex: number; text: string }> = []
  String(lyrics ?? "")
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter(Boolean)
    .filter((line) => !/^\[[^\]]+\]$/u.test(line))
    .forEach((line, index) => {
      if (isPureAdLib(line)) return
      const text = stripTrailingLinePunctuation(stripTrailingAdLibs(line))
      if (studyWordCount(text) < 2) return
      const normalized = normalizeForStudy(text)
      if (seen.has(normalized)) return
      seen.add(normalized)
      units.push({ lineId: studyLineId(index), lineIndex: index, text })
    })
  return units
}

function mapStudyUnitRow(row: Record<string, unknown>): StudyUnitRow {
  return {
    id: readString(row.id) ?? "",
    line_id: readString(row.line_id) ?? "",
    line_index: Number(row.line_index ?? 0),
    max_attempts: Number(row.max_attempts ?? 2),
    prompt_text: readString(row.prompt_text) ?? "",
    reference_text: readString(row.reference_text) ?? readString(row.prompt_text) ?? "",
    say_it_back_status: (readString(row.say_it_back_status) ?? "ready") as StudyUnitRow["say_it_back_status"],
    source_language: readString(row.source_language),
    unit_version: Number(row.unit_version ?? 1),
  }
}

export async function selectStudyUnits(client: DbExecutor, postId: string): Promise<StudyUnitRow[]> {
  const result = await client.execute({
    sql: `
      SELECT id, line_id, line_index, source_language, prompt_text, reference_text,
             say_it_back_status, unit_version, max_attempts
      FROM song_study_unit
      WHERE post_id = ?1
      ORDER BY line_index ASC
    `,
    args: [postId],
  })
  return result.rows.map((row) => mapStudyUnitRow(row as Record<string, unknown>))
}

function studyUnitUpsertStatement(post: StudyUnitPost, line: { lineId: string; lineIndex: number; text: string }, now: string): InStatement {
  return {
    sql: `
      INSERT INTO song_study_unit (
        id, post_id, line_id, line_index, source_language, prompt_text,
        reference_text, say_it_back_status, unit_version, max_attempts,
        created_at, updated_at
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, 'ready', ?7, 2, ?8, ?8)
      ON CONFLICT(post_id, line_id) DO UPDATE SET
        line_index = excluded.line_index,
        source_language = excluded.source_language,
        prompt_text = excluded.prompt_text,
        reference_text = excluded.reference_text,
        say_it_back_status = excluded.say_it_back_status,
        unit_version = excluded.unit_version,
        max_attempts = excluded.max_attempts,
        updated_at = excluded.updated_at
    `,
    args: [
      makeId("stu"),
      post.post_id,
      line.lineId,
      line.lineIndex,
      post.source_language,
      line.text,
      STUDY_UNIT_GENERATION_VERSION,
      now,
    ],
  }
}

// Explicit cascade: D1/SQLite (and the libsql test client) do not enforce
// FOREIGN KEY ... ON DELETE CASCADE unless PRAGMA foreign_keys=ON, so delete the
// unit's localizations before the unit itself. Per-user attempts/review_state are
// keyed by (post_id, line_id) rather than unit_id and are left as an audit trail.
async function deleteStudyUnits(client: Client, unitIds: string[]): Promise<void> {
  if (unitIds.length === 0) return
  const placeholders = unitIds.map(() => "?").join(", ")
  await client.execute({
    sql: `DELETE FROM song_study_unit_localization WHERE unit_id IN (${placeholders})`,
    args: unitIds,
  })
  await client.execute({
    sql: `DELETE FROM song_study_unit WHERE id IN (${placeholders})`,
    args: unitIds,
  })
}

export async function ensureStudyUnits(client: Client, post: StudyUnitPost): Promise<StudyUnitRow[]> {
  const existing = await selectStudyUnits(client, post.post_id)
  // Fresh units are returned as-is. A version bump (e.g. changed line heuristics or
  // punctuation canonicalization) makes existing units stale and forces a re-split so
  // their stored text is regenerated — ensureStudyUnits only ran once historically.
  if (existing.length > 0 && existing.every((unit) => unit.unit_version >= STUDY_UNIT_GENERATION_VERSION)) {
    return existing
  }

  const lines = splitLyricsForStudy(post.lyrics)
  const now = nowIso()
  // Upsert keeps the stable primary key + line_id for surviving lines (line_id is
  // index-derived and unaffected by punctuation changes), so their FK localizations
  // and per-user review_state (keyed by line_id) are preserved across the re-split.
  if (lines.length > 0) {
    await client.batch(lines.map((line) => studyUnitUpsertStatement(post, line, now)), "write")
  }

  // Remove units the current split no longer produces (edited lyrics or heuristic
  // changes) so their localizations don't linger as orphans. Punctuation
  // canonicalization alone never drops a line — dedup already normalizes punctuation
  // away — but a version-gated re-split must still be correct if the set does change.
  if (existing.length > 0) {
    const keep = new Set(lines.map((line) => line.lineId))
    const staleIds = existing.filter((unit) => !keep.has(unit.line_id)).map((unit) => unit.id)
    await deleteStudyUnits(client, staleIds)
  }

  return selectStudyUnits(client, post.post_id)
}
