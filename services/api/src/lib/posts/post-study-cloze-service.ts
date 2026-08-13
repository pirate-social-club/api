import type { Client, InStatement, ReadClient } from "../sql-client"
import { sha256Hex } from "../crypto"
import { selectStudyUnits, type StudyUnitRow } from "./post-study-unit-service"

// v3 rejects low-context/function-word gaps and binds served cards to their
// collision-resistant source materialization identity.
export const STUDY_CLOZE_GENERATION_VERSION = 3
export const STUDY_CLOZE_MAX_ATTEMPTS = 2
const STUDY_CLOZE_MIN_WORD_LENGTH = 3

export async function hasStudyClozeSchema(client: Pick<ReadClient, "execute">): Promise<boolean> {
  const result = await client.execute({
    sql: "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'song_study_unit_cloze' LIMIT 1",
  })
  return result.rows.length > 0
}

export type StudyClozeSegment =
  | { kind: "text"; text: string }
  | { id: string; kind: "blank" }

export type StudyClozeToken = { id: string; text: string }
export type StudyClozePlacement = { blank_id: string; token_id: string }

type ScriptBucket = "arabic" | "cyrillic" | "devanagari" | "greek" | "hangul" | "hebrew" | "latin"
type WordPart = { end: number; index: number; ordinal: number; start: number; text: string }

export type StudyClozeUnavailableReason =
  | "insufficient_distractors"
  | "no_gap_candidate"
  | "too_few_words"
  | "unsupported_language"
  | "unsupported_script"

type StudyCloze = {
  correctPlacements: StudyClozePlacement[]
  segments: StudyClozeSegment[]
  tokens: StudyClozeToken[]
}

type StudyClozeAnalysis =
  | { cloze: StudyCloze; unavailableReason: null }
  | { cloze: null; unavailableReason: StudyClozeUnavailableReason }

type LanguagePolicy = { bucket: ScriptBucket; stopwords: ReadonlySet<string> }

function words(values: string): ReadonlySet<string> {
  return new Set(values.split(/\s+/u))
}

// Intentionally conservative, high-confidence function words. A language is
// enabled only when it has an explicit script and stopword policy.
const LANGUAGE_POLICIES: Readonly<Record<string, LanguagePolicy>> = {
  de: {
    bucket: "latin",
    stopwords: words("aber als am an auch auf aus bei bin bis bist da das dass dem den der des die doch du ein eine einem einen einer eines er es für hat haben ich im in ist mit nicht oder sie sind so und vom von vor war waren was wir zu zum zur"),
  },
  en: {
    bucket: "latin",
    stopwords: words("a about across after all am an and are as at be been before but by could down for from had has have he her hers him his i if in into is it its me my near no not of on or our ours out over past she should so that the their theirs them they this those through to under until up us was we were what when where which who will with would you your yours"),
  },
  es: {
    bucket: "latin",
    stopwords: words("a al algo antes como con de del el ella ellas ellos en era eran es esa esas ese esos esta estas este estos fue fueron ha han hasta la las lo los más me mi mis no nos o para pero por que se sin su sus te tu tus un una uno unos unas y yo"),
  },
  fr: {
    bucket: "latin",
    stopwords: words("à au aux avec avant ce ces cette comme dans de des du elle elles en est et eux il ils je la le les leur leurs lui mais me mes moi mon ne nos notre nous on ou par pas pour que qui sa sans se ses son sur ta te tes toi ton tu un une vos votre vous"),
  },
  it: {
    bucket: "latin",
    stopwords: words("a ad al alla alle allo anche che chi ci con da dal dalla delle di e è era erano gli ha hai hanno i il in io la le lei lo lui ma mi mio nei nel nella no non o per prima più se si sono su sul tra tu un una uno voi"),
  },
  pt: {
    bucket: "latin",
    stopwords: words("a antes ao aos as com como da das de do dos e ela elas ele eles em era eram essa essas esse esses esta estas este estes eu foi foram há isso isto lhe mais mas me meu minha na nas não no nos o os ou para pela pelas pelo pelos por que se sem seu sua suas seus só também te tu um uma você vocês"),
  },
  ru: {
    bucket: "cyrillic",
    stopwords: words("а без был была были было быть в вам вас весь во вот все всего всех вы где да для до его ее если есть ещё же за и из или им их к как ко когда кто ли либо мне может мы на над надо нас наш не него нее нет ни но ну о об один он она они оно от по под пока при про с со так такой там те тем то того тоже той только том ты у уже через что чтобы эта эти это этот я"),
  },
}

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
        ? [{ end: segment.index + segment.segment.length, index, ordinal: 0, start: segment.index, text: segment.segment }]
        : [])
      .map((part, ordinal) => ({ ...part, ordinal }))
  } catch {
    return [...text.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)].map((match, index) => ({
      end: (match.index ?? 0) + match[0].length,
      index,
      ordinal: index,
      start: match.index ?? 0,
      text: match[0],
    }))
  }
}

function scriptBucket(value: string): ScriptBucket | null {
  const character = [...value].find((entry) => /[\p{L}\p{N}]/u.test(entry)) ?? ""
  if (/\p{Script=Cyrillic}/u.test(character)) return "cyrillic"
  if (/\p{Script=Arabic}/u.test(character)) return "arabic"
  if (/\p{Script=Devanagari}/u.test(character)) return "devanagari"
  if (/\p{Script=Greek}/u.test(character)) return "greek"
  if (/\p{Script=Hangul}/u.test(character)) return "hangul"
  if (/\p{Script=Hebrew}/u.test(character)) return "hebrew"
  if (/\p{Script=Latin}/u.test(character)) return "latin"
  // Han/Kana, Thai, Khmer, Lao, Myanmar, and every residual script fail closed.
  return null
}

function normalizedWord(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")
}

function primaryLanguage(value: string | null): string | null {
  if (!value?.trim()) return null
  try {
    return new Intl.Locale(value).language.toLowerCase()
  } catch {
    return value.trim().toLowerCase().split(/[-_]/u)[0] || null
  }
}

function languagePolicy(value: string | null): LanguagePolicy | null {
  const language = primaryLanguage(value)
  return language ? LANGUAGE_POLICIES[language] ?? null : null
}

function selectGapParts(unit: StudyUnitRow, parts: WordPart[], policy: LanguagePolicy): WordPart[] {
  const distinct = parts.filter((part, index) => {
    const normalized = normalizedWord(part.text)
    return part.ordinal > 0
      && scriptBucket(part.text) === policy.bucket
      && normalized.length >= STUDY_CLOZE_MIN_WORD_LENGTH
      && !policy.stopwords.has(normalized)
      && parts.findIndex((candidate) => normalizedWord(candidate.text) === normalized) === index
  })
  if (distinct.length === 0) return []
  const ranked = [...distinct]
    .sort((left, right) => {
      const leftRank = stableHash(`${unit.line_id}:${left.index}:${left.text}`)
      const rightRank = stableHash(`${unit.line_id}:${right.index}:${right.text}`)
      return leftRank - rightRank || left.start - right.start
    })
  const selected = [ranked[0]!]
  if (distinct.length >= 6) {
    const second = ranked.find((candidate) => Math.abs(candidate.ordinal - selected[0]!.ordinal) >= 2)
    if (second) selected.push(second)
  }
  return selected.sort((left, right) => left.start - right.start)
}

export function buildStudyCloze(
  unit: StudyUnitRow,
  units: StudyUnitRow[],
): StudyCloze | null {
  return analyzeStudyCloze(unit, units).cloze
}

export function analyzeStudyCloze(unit: StudyUnitRow, units: StudyUnitRow[]): StudyClozeAnalysis {
  const partsByUnit = new Map(units.map((candidate) => [
    candidate.id,
    wordParts(candidate.prompt_text, candidate.source_language),
  ]))
  return analyzeStudyClozeFromParts(unit, units, partsByUnit)
}

function analyzeStudyClozeFromParts(
  unit: StudyUnitRow,
  units: StudyUnitRow[],
  partsByUnit: Map<string, WordPart[]>,
): StudyClozeAnalysis {
  const parts = partsByUnit.get(unit.id) ?? []
  const policy = languagePolicy(unit.source_language)
  if (!policy) return { cloze: null, unavailableReason: "unsupported_language" }
  if (parts.length < 4) return { cloze: null, unavailableReason: "too_few_words" }
  if (!parts.some((part) => scriptBucket(part.text) === policy.bucket)) {
    return { cloze: null, unavailableReason: "unsupported_script" }
  }
  const gaps = selectGapParts(unit, parts, policy)
  if (gaps.length === 0) return { cloze: null, unavailableReason: "no_gap_candidate" }

  const visibleWords = new Set(parts.map((part) => normalizedWord(part.text)))
  const distractorTarget = Math.max(2, 4 - gaps.length)
  const seenDistractors = new Set<string>()
  const distractors = units
    .filter((candidate) => primaryLanguage(candidate.source_language) === primaryLanguage(unit.source_language))
    .flatMap((candidate) => partsByUnit.get(candidate.id) ?? [])
    .filter((part) => scriptBucket(part.text) === policy.bucket)
    .filter((part) => {
      const normalized = normalizedWord(part.text)
      if (normalized.length < STUDY_CLOZE_MIN_WORD_LENGTH || policy.stopwords.has(normalized)
        || visibleWords.has(normalized) || seenDistractors.has(normalized)) {
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
  if (distractors.length < distractorTarget) {
    return { cloze: null, unavailableReason: "insufficient_distractors" }
  }

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

  return { cloze: { correctPlacements, segments, tokens }, unavailableReason: null }
}

async function clozeSourceFingerprint(units: StudyUnitRow[]): Promise<string> {
  return await sha256Hex(JSON.stringify(units.map((unit) => [
    unit.id,
    unit.line_id,
    unit.source_language,
    unit.prompt_text,
  ])))
}

function clozeUpsertStatement(input: {
  fingerprint: string
  now: string
  partsByUnit: Map<string, WordPart[]>
  unit: StudyUnitRow
  units: StudyUnitRow[]
}): InStatement {
  const cloze = analyzeStudyClozeFromParts(input.unit, input.units, input.partsByUnit).cloze
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

export async function ensureStudyClozeRows(input: {
  client: Client
  postId: string
  sourceLanguageReliable: boolean
}): Promise<void> {
  // Cloze selection applies language-specific rules. Do not convert an
  // unverified language label into an apparently-valid exercise.
  if (!input.sourceLanguageReliable) return
  // Fleet quarantines and pre-allocation pools can legitimately lag the
  // community template. Fill-blank is enrichment, so a missing 1156 table
  // degrades to the established exercise types instead of breaking Study.
  if (!await hasStudyClozeSchema(input.client)) return
  // Always load the complete persisted song. Distractors must never depend on
  // which caller happened to provide the first in-memory slice.
  const units = await selectStudyUnits(input.client, input.postId)
  if (units.length === 0) return
  const fingerprint = await clozeSourceFingerprint(units)
  const existing = await input.client.execute({
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
  await input.client.batch(stale.map((unit) => clozeUpsertStatement({ fingerprint, now, partsByUnit, unit, units })), "write")
}
