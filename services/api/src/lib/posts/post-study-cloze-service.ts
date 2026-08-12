import type { Client, InStatement } from "../sql-client"
import { selectStudyUnits, type StudyUnitRow } from "./post-study-unit-service"

// v2 removes answer-bearing token identifiers from the render-safe payload.
export const STUDY_CLOZE_GENERATION_VERSION = 2
export const STUDY_CLOZE_MAX_ATTEMPTS = 2

export type StudyClozeSegment =
  | { kind: "text"; text: string }
  | { id: string; kind: "blank" }

export type StudyClozeToken = { id: string; text: string }
export type StudyClozePlacement = { blank_id: string; token_id: string }

type WordPart = { end: number; index: number; start: number; text: string }

function stableHash(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function wordParts(text: string, language: string | null): WordPart[] {
  try {
    const segmenter = new Intl.Segmenter(language ?? undefined, { granularity: "word" })
    return [...segmenter.segment(text)].flatMap((segment, index) =>
      segment.isWordLike
        ? [{ end: segment.index + segment.segment.length, index, start: segment.index, text: segment.segment }]
        : [])
  } catch {
    return [...text.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)].map((match, index) => ({
      end: (match.index ?? 0) + match[0].length,
      index,
      start: match.index ?? 0,
      text: match[0],
    }))
  }
}

function scriptBucket(value: string): string {
  const character = [...value].find((entry) => /[\p{L}\p{N}]/u.test(entry)) ?? ""
  if (/\p{Script=Cyrillic}/u.test(character)) return "cyrillic"
  if (/\p{Script=Han}/u.test(character)) return "han"
  if (/\p{Script=Hiragana}|\p{Script=Katakana}/u.test(character)) return "kana"
  if (/\p{Script=Arabic}/u.test(character)) return "arabic"
  if (/\p{Script=Devanagari}/u.test(character)) return "devanagari"
  if (/\p{Script=Latin}/u.test(character)) return "latin"
  return "other"
}

function normalizedWord(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")
}

function selectGapParts(unit: StudyUnitRow, parts: WordPart[]): WordPart[] {
  const distinct = parts.filter((part, index) => {
    const normalized = normalizedWord(part.text)
    return normalized.length > 1 && parts.findIndex((candidate) => normalizedWord(candidate.text) === normalized) === index
  })
  if (distinct.length === 0) return []
  const count = distinct.length >= 6 ? 2 : 1
  return [...distinct]
    .sort((left, right) => {
      const leftRank = stableHash(`${unit.line_id}:${left.index}:${left.text}`)
      const rightRank = stableHash(`${unit.line_id}:${right.index}:${right.text}`)
      return leftRank - rightRank || left.start - right.start
    })
    .slice(0, count)
    .sort((left, right) => left.start - right.start)
}

export function buildStudyCloze(
  unit: StudyUnitRow,
  units: StudyUnitRow[],
): { correctPlacements: StudyClozePlacement[]; segments: StudyClozeSegment[]; tokens: StudyClozeToken[] } | null {
  const partsByUnit = new Map(units.map((candidate) => [
    candidate.id,
    wordParts(candidate.prompt_text, candidate.source_language),
  ]))
  return buildStudyClozeFromParts(unit, units, partsByUnit)
}

function buildStudyClozeFromParts(
  unit: StudyUnitRow,
  units: StudyUnitRow[],
  partsByUnit: Map<string, WordPart[]>,
): { correctPlacements: StudyClozePlacement[]; segments: StudyClozeSegment[]; tokens: StudyClozeToken[] } | null {
  const parts = partsByUnit.get(unit.id) ?? []
  const gaps = selectGapParts(unit, parts)
  if (gaps.length === 0) return null

  const visibleWords = new Set(parts.map((part) => normalizedWord(part.text)))
  const bucket = scriptBucket(gaps[0]!.text)
  const distractorTarget = Math.max(2, 4 - gaps.length)
  const seenDistractors = new Set<string>()
  const distractors = units
    .flatMap((candidate) => partsByUnit.get(candidate.id) ?? [])
    .filter((part) => scriptBucket(part.text) === bucket)
    .filter((part) => {
      const normalized = normalizedWord(part.text)
      if (normalized.length <= 1 || visibleWords.has(normalized) || seenDistractors.has(normalized)) {
        return false
      }
      // Unit/word traversal is stable; retain the first surface form for a
      // normalized word, then hash-rank those deterministic representatives.
      seenDistractors.add(normalized)
      return true
    })
    .sort((left, right) => {
      const leftRank = stableHash(`${unit.line_id}:distractor:${left.text}`)
      const rightRank = stableHash(`${unit.line_id}:distractor:${right.text}`)
      return leftRank - rightRank || left.text.localeCompare(right.text)
    })
    .slice(0, distractorTarget)
  if (distractors.length < distractorTarget) return null

  const segments: StudyClozeSegment[] = []
  const correctPlacements: StudyClozePlacement[] = []
  const tokenWords = [...gaps.map((gap) => gap.text), ...distractors.map((part) => part.text)]
    .sort((left, right) => {
      const leftRank = stableHash(`${unit.line_id}:token:${left}`)
      const rightRank = stableHash(`${unit.line_id}:token:${right}`)
      return leftRank - rightRank || left.localeCompare(right)
    })
  const tokens = tokenWords.map((text, index) => ({ id: `token_${index + 1}`, text }))
  const tokenIdsByWord = new Map(tokens.map((token) => [normalizedWord(token.text), token.id]))
  let cursor = 0
  gaps.forEach((gap, index) => {
    if (gap.start > cursor) segments.push({ kind: "text", text: unit.prompt_text.slice(cursor, gap.start) })
    const blankId = `blank_${index + 1}`
    const tokenId = tokenIdsByWord.get(normalizedWord(gap.text))
    if (!tokenId) throw new Error("Generated cloze answer is missing from its token bank")
    segments.push({ id: blankId, kind: "blank" })
    correctPlacements.push({ blank_id: blankId, token_id: tokenId })
    cursor = gap.end
  })
  if (cursor < unit.prompt_text.length) segments.push({ kind: "text", text: unit.prompt_text.slice(cursor) })

  return { correctPlacements, segments, tokens }
}

function clozeSourceFingerprint(units: StudyUnitRow[]): string {
  return stableHash(JSON.stringify(units.map((unit) => [
    unit.id,
    unit.line_id,
    unit.source_language,
    unit.prompt_text,
  ]))).toString(16).padStart(8, "0")
}

function clozeUpsertStatement(input: {
  fingerprint: string
  now: string
  partsByUnit: Map<string, WordPart[]>
  unit: StudyUnitRow
  units: StudyUnitRow[]
}): InStatement {
  const cloze = buildStudyClozeFromParts(input.unit, input.units, input.partsByUnit)
  return {
    sql: `
      INSERT INTO song_study_unit_cloze (
        unit_id, cloze_version, status, source_text, source_fingerprint, segments_json, tokens_json,
        correct_placements_json, max_attempts, generated_at, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?10)
      ON CONFLICT(unit_id) DO UPDATE SET
        cloze_version = excluded.cloze_version,
        status = excluded.status,
        source_text = excluded.source_text,
        source_fingerprint = excluded.source_fingerprint,
        segments_json = excluded.segments_json,
        tokens_json = excluded.tokens_json,
        correct_placements_json = excluded.correct_placements_json,
        max_attempts = excluded.max_attempts,
        generated_at = excluded.generated_at,
        updated_at = excluded.updated_at
    `,
    args: [
      input.unit.id,
      STUDY_CLOZE_GENERATION_VERSION,
      cloze ? "ready" : "unavailable",
      input.unit.prompt_text,
      input.fingerprint,
      cloze ? JSON.stringify(cloze.segments) : null,
      cloze ? JSON.stringify(cloze.tokens) : null,
      cloze ? JSON.stringify(cloze.correctPlacements) : null,
      STUDY_CLOZE_MAX_ATTEMPTS,
      cloze ? input.now : null,
    ],
  }
}

export async function ensureStudyClozeRows(client: Client, postId: string): Promise<void> {
  // Always load the complete persisted song. Distractors must never depend on
  // which caller happened to provide the first in-memory slice.
  const units = await selectStudyUnits(client, postId)
  if (units.length === 0) return
  const fingerprint = clozeSourceFingerprint(units)
  const existing = await client.execute({
    sql: `SELECT unit_id, source_text, source_fingerprint FROM song_study_unit_cloze WHERE cloze_version >= ?1 AND unit_id IN (${units.map((_, index) => `?${index + 2}`).join(", ")})`,
    args: [STUDY_CLOZE_GENERATION_VERSION, ...units.map((unit) => unit.id)],
  })
  const current = new Map(existing.rows.map((row) => [String(row.unit_id), {
    fingerprint: String(row.source_fingerprint),
    sourceText: String(row.source_text),
  }]))
  const stale = units.filter((unit) => {
    const row = current.get(unit.id)
    return row?.sourceText !== unit.prompt_text || row.fingerprint !== fingerprint
  })
  if (stale.length === 0) return
  const now = new Date().toISOString()
  const partsByUnit = new Map(units.map((unit) => [unit.id, wordParts(unit.prompt_text, unit.source_language)]))
  await client.batch(stale.map((unit) => clozeUpsertStatement({ fingerprint, now, partsByUnit, unit, units })), "write")
}
