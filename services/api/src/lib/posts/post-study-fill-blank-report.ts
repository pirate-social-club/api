import type { DbExecutor } from "../db-helpers"
import { sha256Hex } from "../crypto"
import {
  analyzeStudyCloze,
  STUDY_CLOZE_GENERATION_VERSION,
  type StudyClozeUnavailableReason,
} from "./post-study-cloze-service"
import {
  FILL_BLANK_PROMPT_TEXT,
  type StudyExerciseRow,
} from "./post-study-attempt-store"
import { listExercises } from "./post-study-exercise-query"
import {
  selectStudySessionCandidates,
  STUDY_SESSION_DISTINCT_EXERCISE_LIMIT,
} from "./post-study-session-service"
import { selectStudyUnits, type StudyUnitRow } from "./post-study-unit-service"

const STUDY_FILL_BLANK_CANDIDATE_WINDOW = STUDY_SESSION_DISTINCT_EXERCISE_LIMIT * 3

export type StudyFillBlankReportRejectionReason =
  | "lyrics_language_missing"
  | "lyrics_language_unreliable"
  | StudyClozeUnavailableReason

export type StudyFillBlankReportPost = {
  community_id: string
  lyrics_language: string | null
  lyrics_language_confidence: number | null
  lyrics_language_detector: string | null
  lyrics_language_reliable: boolean
  lyrics_language_source_hash: string | null
  post_id: string
  song_title: string | null
}

export type StudyFillBlankReportServingContext = {
  include_say_it_back: boolean
  include_translation: boolean
  target_language: string
}

type ReportBlank = {
  blank_id: string
  text: string
  token_id: string
}

type ReportWordBankToken = {
  is_answer: boolean
  text: string
  token_id: string
}

export type StudyFillBlankEligibleLineReport = {
  candidate_id: string
  line_id: string
  line_index: number
  prompt_text: string
  selected_blanks: ReportBlank[]
  session_exclusion_reason: "outside_candidate_window" | "qualifying_capacity" | "session_capacity" | null
  session_included: boolean
  session_ordinal: number | null
  word_bank: ReportWordBankToken[]
}

export type StudyFillBlankRejectedLineReport = {
  line_id: string
  line_index: number
  prompt_text: string
  reason: StudyFillBlankReportRejectionReason
}

export type PublishedSongFillBlankReport = {
  card_digest: string
  detected_language: {
    confidence: number | null
    detector: string | null
    language: string | null
    reliable: boolean
    source_hash: string | null
  }
  eligible_line_count: number
  eligible_lines: StudyFillBlankEligibleLineReport[]
  post: {
    community_id: string
    post_id: string
    song_title: string | null
  }
  rejection_counts: Record<StudyFillBlankReportRejectionReason, number>
  rejected_line_count: number
  rejected_lines: StudyFillBlankRejectedLineReport[]
  session_inclusion: {
    candidate_window_count: number
    generated_fill_blank_candidates: number
    included_fill_blank_candidates: number
    qualifying_candidates: number
    selected_exercises: number
  }
  total_lines: number
}

export type PublishedSongFillBlankFleetReport = {
  format_version: 1
  observed_at: string
  read_only: true
  report_digest: string
  serving_context: StudyFillBlankReportServingContext & {
    mode: "first_learn_without_review_state"
  }
  song_count: number
  songs: PublishedSongFillBlankReport[]
}

const REJECTION_REASONS: readonly StudyFillBlankReportRejectionReason[] = [
  "lyrics_language_missing",
  "lyrics_language_unreliable",
  "unsupported_language",
  "too_few_words",
  "unsupported_script",
  "no_gap_candidate",
  "insufficient_distractors",
]

function emptyRejectionCounts(): Record<StudyFillBlankReportRejectionReason, number> {
  return Object.fromEntries(REJECTION_REASONS.map((reason) => [reason, 0])) as Record<
    StudyFillBlankReportRejectionReason,
    number
  >
}

function fillBlankCandidateId(postId: string, unitId: string): string {
  return `report:${postId}:${unitId}:fill_blank:v${STUDY_CLOZE_GENERATION_VERSION}`
}

function fillBlankCandidate(input: {
  candidateId: string
  language: string
  unit: StudyUnitRow
}): StudyExerciseRow {
  return {
    correct_option_id: null,
    exercise_type: "fill_blank",
    id: input.candidateId,
    line_id: input.unit.line_id,
    line_index: input.unit.line_index,
    max_attempts: 2,
    options_json: null,
    prompt_text: FILL_BLANK_PROMPT_TEXT,
    qualifies_for_reward: false,
    question: null,
    reference_text: null,
    review_language: input.language,
    study_pack_version: STUDY_CLOZE_GENERATION_VERSION,
    translation_text: null,
  }
}

const EXERCISE_ORDER: Readonly<Record<StudyExerciseRow["exercise_type"], number>> = {
  say_it_back: 0,
  translation_choice: 1,
  fill_blank: 2,
}

function canonicalCandidateOrder(left: StudyExerciseRow, right: StudyExerciseRow): number {
  return left.line_index - right.line_index
    || EXERCISE_ORDER[left.exercise_type] - EXERCISE_ORDER[right.exercise_type]
    || left.id.localeCompare(right.id)
}

function lineRejectionReason(post: StudyFillBlankReportPost): StudyFillBlankReportRejectionReason | null {
  if (!post.lyrics_language?.trim()) return "lyrics_language_missing"
  if (!post.lyrics_language_reliable) return "lyrics_language_unreliable"
  return null
}

/**
 * Produces one deterministic, reviewable song diagnostic without writing cloze
 * rows or sessions. `canonicalCandidates` must be the same first-learn,
 * no-review-state qualifying rows that `/study` would make available for the
 * report's serving context.
 */
export async function buildPublishedSongFillBlankReport(input: {
  canonicalCandidates: StudyExerciseRow[]
  post: StudyFillBlankReportPost
  units: StudyUnitRow[]
}): Promise<PublishedSongFillBlankReport> {
  const rejectedLines: StudyFillBlankRejectedLineReport[] = []
  const eligibleLines: Array<Omit<StudyFillBlankEligibleLineReport,
    "session_exclusion_reason" | "session_included" | "session_ordinal">> = []
  const postRejection = lineRejectionReason(input.post)

  for (const unit of input.units) {
    const analysis = postRejection
      ? null
      : analyzeStudyCloze(unit, input.units, input.post.lyrics_language)
    const reason = postRejection ?? analysis?.unavailableReason ?? null
    if (reason) {
      rejectedLines.push({
        line_id: unit.line_id,
        line_index: unit.line_index,
        prompt_text: unit.prompt_text,
        reason,
      })
      continue
    }
    const cloze = analysis?.cloze
    if (!cloze || !input.post.lyrics_language) continue
    const answerTokenIds = new Set(cloze.correctPlacements.map((placement) => placement.token_id))
    const tokensById = new Map(cloze.tokens.map((token) => [token.id, token]))
    eligibleLines.push({
      candidate_id: fillBlankCandidateId(input.post.post_id, unit.id),
      line_id: unit.line_id,
      line_index: unit.line_index,
      prompt_text: unit.prompt_text,
      selected_blanks: cloze.correctPlacements.map((placement) => ({
        blank_id: placement.blank_id,
        text: tokensById.get(placement.token_id)?.text ?? "",
        token_id: placement.token_id,
      })),
      word_bank: cloze.tokens.map((token) => ({
        is_answer: answerTokenIds.has(token.id),
        text: token.text,
        token_id: token.id,
      })),
    })
  }

  const unitByLineId = new Map(input.units.map((unit) => [unit.line_id, unit]))
  const diagnosticCandidates = eligibleLines.flatMap((line) => {
    const unit = unitByLineId.get(line.line_id)
    return unit && input.post.lyrics_language
      ? [fillBlankCandidate({ candidateId: line.candidate_id, language: input.post.lyrics_language, unit })]
      : []
  })
  const qualifyingCandidates = input.canonicalCandidates.filter((candidate) =>
    candidate.exercise_type !== "fill_blank" && candidate.qualifies_for_reward !== false)
  const candidateWindow = [...qualifyingCandidates, ...diagnosticCandidates]
    .sort(canonicalCandidateOrder)
    .slice(0, STUDY_FILL_BLANK_CANDIDATE_WINDOW)
  const selected = selectStudySessionCandidates(candidateWindow)
  const selectedOrdinalById = new Map(selected.map((candidate, index) => [candidate.id, index]))
  const candidateWindowIds = new Set(candidateWindow.map((candidate) => candidate.id))
  const selectedQualifyingCount = selected.filter((candidate) => candidate.qualifies_for_reward !== false).length
  const reportEligibleLines = eligibleLines.map((line): StudyFillBlankEligibleLineReport => {
    const sessionOrdinal = selectedOrdinalById.get(line.candidate_id)
    const included = sessionOrdinal !== undefined
    let exclusionReason: StudyFillBlankEligibleLineReport["session_exclusion_reason"] = null
    if (!included) {
      exclusionReason = !candidateWindowIds.has(line.candidate_id)
        ? "outside_candidate_window"
        : selectedQualifyingCount >= STUDY_SESSION_DISTINCT_EXERCISE_LIMIT
          ? "qualifying_capacity"
          : "session_capacity"
    }
    return {
      ...line,
      session_exclusion_reason: exclusionReason,
      session_included: included,
      session_ordinal: sessionOrdinal ?? null,
    }
  })
  const rejectionCounts = emptyRejectionCounts()
  for (const line of rejectedLines) rejectionCounts[line.reason] += 1
  const cardDigest = await sha256Hex(JSON.stringify(reportEligibleLines.map((line) => ({
    candidate_id: line.candidate_id,
    line_id: line.line_id,
    prompt_text: line.prompt_text,
    selected_blanks: line.selected_blanks,
    word_bank: line.word_bank,
  }))))

  return {
    card_digest: cardDigest,
    detected_language: {
      confidence: input.post.lyrics_language_confidence,
      detector: input.post.lyrics_language_detector,
      language: input.post.lyrics_language,
      reliable: input.post.lyrics_language_reliable,
      source_hash: input.post.lyrics_language_source_hash,
    },
    eligible_line_count: reportEligibleLines.length,
    eligible_lines: reportEligibleLines,
    post: {
      community_id: input.post.community_id,
      post_id: input.post.post_id,
      song_title: input.post.song_title,
    },
    rejection_counts: rejectionCounts,
    rejected_line_count: rejectedLines.length,
    rejected_lines: rejectedLines,
    session_inclusion: {
      candidate_window_count: candidateWindow.length,
      generated_fill_blank_candidates: diagnosticCandidates.length,
      included_fill_blank_candidates: selected.filter((candidate) => candidate.exercise_type === "fill_blank").length,
      qualifying_candidates: qualifyingCandidates.length,
      selected_exercises: selected.length,
    },
    total_lines: input.units.length,
  }
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed || null
}

function readNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Read-only shard report for every published song. The serving context is
 * explicit because speech credentials and the learner's translation target
 * determine which reward-bearing candidates can displace enrichment.
 */
export async function generatePublishedSongFillBlankFleetReport(input: {
  client: DbExecutor
  observedAt: string
  servingContext: StudyFillBlankReportServingContext
}): Promise<PublishedSongFillBlankFleetReport> {
  const result = await input.client.execute({
    sql: `
      SELECT community_id, post_id, COALESCE(song_title, title) AS song_title,
             lyrics_language, lyrics_language_confidence, lyrics_language_reliable,
             lyrics_language_detector, lyrics_language_source_hash
      FROM posts
      WHERE post_type = 'song' AND status = 'published'
      ORDER BY post_id ASC
    `,
    args: [],
  })
  const songs: PublishedSongFillBlankReport[] = []
  for (const row of result.rows) {
    const post: StudyFillBlankReportPost = {
      community_id: readString(row.community_id) ?? "",
      lyrics_language: readString(row.lyrics_language),
      lyrics_language_confidence: readNumber(row.lyrics_language_confidence),
      lyrics_language_detector: readString(row.lyrics_language_detector),
      lyrics_language_reliable: Number(row.lyrics_language_reliable ?? 0) === 1,
      lyrics_language_source_hash: readString(row.lyrics_language_source_hash),
      post_id: readString(row.post_id) ?? "",
      song_title: readString(row.song_title),
    }
    const units = await selectStudyUnits(input.client, post.post_id)
    const canonicalCandidates = await listExercises({
      client: input.client,
      dueReviewServing: false,
      includeFillBlank: false,
      includeSayItBack: input.servingContext.include_say_it_back,
      includeTranslation: input.servingContext.include_translation,
      now: input.observedAt,
      postId: post.post_id,
      targetLanguage: input.servingContext.target_language,
      userId: null,
    })
    songs.push(await buildPublishedSongFillBlankReport({
      canonicalCandidates: canonicalCandidates.rows,
      post,
      units,
    }))
  }
  const reportDigest = await sha256Hex(JSON.stringify(songs))
  return {
    format_version: 1,
    observed_at: input.observedAt,
    read_only: true,
    report_digest: reportDigest,
    serving_context: {
      ...input.servingContext,
      mode: "first_learn_without_review_state",
    },
    song_count: songs.length,
    songs,
  }
}
