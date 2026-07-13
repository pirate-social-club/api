import { executeFirst } from "../db-helpers"
import type { ReadClient } from "../sql-client"
import type { StudyPack } from "./post-study-localization-service"
import type { AttemptOutcome, FsrsRating } from "./post-study-recall-grading"

export type ExerciseType = "say_it_back" | "translation_choice"

export type StudyExerciseRow = {
  correct_option_id: string | null
  exercise_type: ExerciseType
  id: string
  line_id: string
  line_index: number
  max_attempts: number
  options_json: string | null
  prompt_text: string
  question: string | null
  reference_text: string | null
  review_language: string
  study_pack_version: number
  translation_text: string | null
}

export type StudyExerciseForAttempt = StudyExerciseRow & {
  post_id: string
  source_language: string | null
  status: StudyPack["status"]
  target_language: string
}

export type StudyAttemptRow = {
  attempt_number: number
  exercise_id: string
  feedback_json: string | null
  fsrs_rating: FsrsRating | null
  outcome: AttemptOutcome
  selected_option_id: string | null
  transcript: string | null
  type: ExerciseType
}

type StudyReviewStateRow = {
  difficulty: number
  due_at: string
  lapses: number
  reps: number
  stability: number
  state: "new" | "learning" | "review" | "relearning"
}

type StudyReviewSchedule = {
  difficulty: number
  dueAt: string
  lapseIncrement: 0 | 1
  stability: number
  state: StudyReviewStateRow["state"]
}

const FSRS_PARAMS_VERSION = 1

export function readString(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed || null
}

export async function getExerciseForAttempt(
  client: ReadClient,
  exerciseId: string,
): Promise<StudyExerciseForAttempt | null> {
  const sayItBackMatch = /^stu:([^:]+):say_it_back:([^:]+)$/u.exec(exerciseId)
  if (sayItBackMatch) {
    const unitId = sayItBackMatch[1]!
    const row = await executeFirst(client, {
      sql: `
        SELECT id, post_id, line_id, line_index, source_language, prompt_text,
               reference_text, say_it_back_status, unit_version, max_attempts
        FROM song_study_unit
        WHERE id = ?1
        LIMIT 1
      `,
      args: [unitId],
    }) as Record<string, unknown> | null
    if (!row) return null
    const sourceLanguage = readString(row.source_language) ?? "source"
    return {
      correct_option_id: null,
      exercise_type: "say_it_back",
      id: exerciseId,
      line_id: readString(row.line_id) ?? "",
      line_index: Number(row.line_index ?? 0),
      max_attempts: Number(row.max_attempts ?? 2),
      options_json: null,
      post_id: readString(row.post_id) ?? "",
      prompt_text: readString(row.prompt_text) ?? "",
      question: null,
      reference_text: readString(row.reference_text),
      review_language: sourceLanguage,
      source_language: sourceLanguage,
      status: readString(row.say_it_back_status) === "ready" ? "ready" : "unavailable",
      study_pack_version: Number(row.unit_version ?? 1),
      target_language: sourceLanguage,
      translation_text: null,
    }
  }

  const translationMatch = /^stu:([^:]+):translation_choice:(.+)$/u.exec(exerciseId)
  if (translationMatch) {
    const unitId = translationMatch[1]!
    const targetLanguage = translationMatch[2]!
    const row = await executeFirst(client, {
      sql: `
        SELECT u.id, u.post_id, u.line_id, u.line_index, u.source_language,
               u.prompt_text, l.question, l.translation_text, l.options_json,
               l.correct_option_id, l.max_attempts, l.status, l.localization_version,
               l.target_language
        FROM song_study_unit u
        JOIN song_study_unit_localization l ON l.unit_id = u.id
        WHERE u.id = ?1
          AND l.target_language = ?2
        LIMIT 1
      `,
      args: [unitId, targetLanguage],
    }) as Record<string, unknown> | null
    if (!row) return null
    return {
      correct_option_id: readString(row.correct_option_id),
      exercise_type: "translation_choice",
      id: exerciseId,
      line_id: readString(row.line_id) ?? "",
      line_index: Number(row.line_index ?? 0),
      max_attempts: Number(row.max_attempts ?? 1),
      options_json: readString(row.options_json),
      post_id: readString(row.post_id) ?? "",
      prompt_text: readString(row.prompt_text) ?? "",
      question: readString(row.question),
      reference_text: null,
      review_language: readString(row.target_language) ?? targetLanguage,
      source_language: readString(row.source_language),
      status: (readString(row.status) ?? "processing") as StudyPack["status"],
      study_pack_version: Number(row.localization_version ?? 1),
      target_language: readString(row.target_language) ?? targetLanguage,
      translation_text: readString(row.translation_text),
    }
  }

  return null
}

export async function getAttemptByIdempotencyKey(
  client: ReadClient,
  userId: string,
  idempotencyKey: string,
): Promise<StudyAttemptRow | null> {
  const row = await executeFirst(client, {
    sql: `
      SELECT exercise_id, exercise_type, attempt_number,
             selected_option_id, transcript, outcome, feedback_json, fsrs_rating
      FROM song_study_attempt
      WHERE user_id = ?1
        AND idempotency_key = ?2
      LIMIT 1
    `,
    args: [userId, idempotencyKey],
  }) as Record<string, unknown> | null
  return row
    ? {
        attempt_number: Number(row.attempt_number ?? 1),
        exercise_id: readString(row.exercise_id) ?? "",
        feedback_json: readString(row.feedback_json),
        fsrs_rating: readString(row.fsrs_rating) as FsrsRating | null,
        outcome: (readString(row.outcome) ?? "incorrect") as AttemptOutcome,
        selected_option_id: readString(row.selected_option_id),
        transcript: readString(row.transcript),
        type: (readString(row.exercise_type) ?? "say_it_back") as ExerciseType,
      }
    : null
}

export async function getReviewState(input: {
  client: ReadClient
  exercise: StudyExerciseForAttempt
  userId: string
}): Promise<StudyReviewStateRow | null> {
  const row = await executeFirst(input.client, {
    sql: `
      SELECT state, stability, difficulty, due_at, reps, lapses
      FROM song_study_review_state
      WHERE user_id = ?1
        AND post_id = ?2
        AND line_id = ?3
        AND exercise_type = ?4
        AND target_language = ?5
      LIMIT 1
    `,
    args: [
      input.userId,
      input.exercise.post_id,
      input.exercise.line_id,
      input.exercise.exercise_type,
      input.exercise.review_language,
    ],
  }) as Record<string, unknown> | null
  return row
    ? {
        difficulty: Number(row.difficulty ?? 5),
        due_at: readString(row.due_at) ?? "",
        lapses: Number(row.lapses ?? 0),
        reps: Number(row.reps ?? 0),
        stability: Number(row.stability ?? 1),
        state: (readString(row.state) ?? "new") as StudyReviewStateRow["state"],
      }
    : null
}

function addReviewInterval(now: string, intervalMs: number): string {
  const nowMs = Date.parse(now)
  const baseMs = Number.isFinite(nowMs) ? nowMs : Date.now()
  return new Date(baseMs + intervalMs).toISOString()
}

function clampReviewNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number(value.toFixed(3))))
}

function buildReviewSchedule(input: {
  existing: StudyReviewStateRow | null
  now: string
  rating: FsrsRating
}): StudyReviewSchedule {
  const priorReps = input.existing?.reps ?? 0
  const priorStability = Math.max(0.25, input.existing?.stability ?? 1)
  const priorDifficulty = Math.max(1, Math.min(10, input.existing?.difficulty ?? 5))
  const hourMs = 60 * 60 * 1000
  const dayMs = 24 * hourMs

  if (input.rating === "again") {
    return {
      difficulty: clampReviewNumber(priorDifficulty + 1.2, 1, 10),
      dueAt: addReviewInterval(input.now, 10 * 60 * 1000),
      lapseIncrement: 1,
      stability: clampReviewNumber(Math.max(0.25, priorStability * 0.5), 0.25, 365),
      state: priorReps > 0 ? "relearning" : "learning",
    }
  }
  if (input.rating === "hard") {
    const stability = clampReviewNumber(Math.max(1, priorStability * (priorReps > 0 ? 1.2 : 1)), 0.25, 365)
    return {
      difficulty: clampReviewNumber(priorDifficulty + 0.35, 1, 10),
      dueAt: addReviewInterval(input.now, Math.max(12 * hourMs, stability * dayMs)),
      lapseIncrement: 0,
      stability,
      state: "review",
    }
  }
  if (input.rating === "easy") {
    const stability = clampReviewNumber(priorReps > 0 ? priorStability * 3.5 : 4, 0.25, 365)
    return {
      difficulty: clampReviewNumber(priorDifficulty - 0.8, 1, 10),
      dueAt: addReviewInterval(input.now, stability * dayMs),
      lapseIncrement: 0,
      stability,
      state: "review",
    }
  }
  const stability = clampReviewNumber(priorReps > 0 ? priorStability * 2.5 : 2, 0.25, 365)
  return {
    difficulty: clampReviewNumber(priorDifficulty - 0.25, 1, 10),
    dueAt: addReviewInterval(input.now, stability * dayMs),
    lapseIncrement: 0,
    stability,
    state: "review",
  }
}

export async function upsertReviewState(input: {
  client: ReadClient
  existing: StudyReviewStateRow | null
  exercise: StudyExerciseForAttempt
  now: string
  rating: FsrsRating
  userId: string
}): Promise<FsrsRating> {
  const schedule = buildReviewSchedule({ existing: input.existing, now: input.now, rating: input.rating })
  await input.client.execute({
    sql: `
      INSERT INTO song_study_review_state (
        user_id, post_id, line_id, exercise_type, target_language,
        state, stability, difficulty, due_at, last_reviewed_at,
        reps, lapses, fsrs_params_version, updated_at
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1, ?11, ?12, ?13)
      ON CONFLICT(user_id, post_id, line_id, exercise_type, target_language)
      DO UPDATE SET
        state = excluded.state,
        stability = excluded.stability,
        difficulty = excluded.difficulty,
        due_at = excluded.due_at,
        last_reviewed_at = excluded.last_reviewed_at,
        reps = song_study_review_state.reps + 1,
        lapses = song_study_review_state.lapses + excluded.lapses,
        fsrs_params_version = excluded.fsrs_params_version,
        updated_at = excluded.updated_at
    `,
    args: [
      input.userId,
      input.exercise.post_id,
      input.exercise.line_id,
      input.exercise.exercise_type,
      input.exercise.review_language,
      schedule.state,
      schedule.stability,
      schedule.difficulty,
      schedule.dueAt,
      input.now,
      schedule.lapseIncrement,
      FSRS_PARAMS_VERSION,
      input.now,
    ],
  })
  return input.rating
}
