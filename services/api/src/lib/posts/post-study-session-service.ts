import { executeFirst } from "../db-helpers"
import { badRequestError, notFoundError } from "../errors"
import { makeId } from "../helpers"
import type { Client, ReadClient } from "../sql-client"
import type { AttemptOutcome } from "./post-study-recall-grading"
import type { StudyExerciseRow } from "./post-study-attempt-store"

export const STUDY_SESSION_DISTINCT_EXERCISE_LIMIT = 10
export const STUDY_SESSION_MAX_CARD_PRESENTATIONS = 3
export const STUDY_SESSION_PRESENTATION_LIMIT = 20
const STUDY_SESSION_TTL_MS = 24 * 60 * 60 * 1000

export type StudySessionStatus = "active" | "completed" | "caught_up" | "expired"

export type StudySessionSummary = {
  completed_exercise_count: number
  due_count: number
  first_pass_correct_count: number
  id: string | null
  mastered_exercise_count: number
  max_presentations: number
  presentation_count: number
  qualified: boolean
  required_correct_count: number
  served_count: number
  status: StudySessionStatus
  total_units: number
  next_due_at?: number
}

export type StudySessionExerciseProgress = {
  firstOutcome: AttemptOutcome | null
  mastered: boolean
  presentationCount: number
}

export type StudySessionForAttempt = {
  exercise: StudySessionExerciseProgress
  maxPresentations: number
  requiredCorrectCount: number
  sessionId: string
  targetLanguage: string
}

type SessionRow = Record<string, unknown>

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed || null
}

function asOutcome(value: unknown): AttemptOutcome | null {
  const outcome = readString(value)
  return outcome === "correct" || outcome === "incorrect" || outcome === "revealed" ? outcome : null
}

function requiredCorrectCount(exerciseCount: number): number {
  return Math.max(1, Math.ceil(exerciseCount * 0.7))
}

function maxPresentationCount(exerciseCount: number): number {
  return Math.min(STUDY_SESSION_PRESENTATION_LIMIT, exerciseCount * STUDY_SESSION_MAX_CARD_PRESENTATIONS)
}

function expiresAt(now: string): string {
  const base = Date.parse(now)
  return new Date((Number.isFinite(base) ? base : Date.now()) + STUDY_SESSION_TTL_MS).toISOString()
}

function mapSummary(row: SessionRow, dueCount: number, totalUnits: number): StudySessionSummary {
  return {
    completed_exercise_count: Number(row.completed_exercise_count ?? 0),
    due_count: dueCount,
    first_pass_correct_count: Number(row.first_pass_correct_count ?? 0),
    id: readString(row.id),
    mastered_exercise_count: Number(row.mastered_exercise_count ?? 0),
    max_presentations: Number(row.max_presentations ?? 0),
    presentation_count: Number(row.presentation_count ?? 0),
    qualified: Number(row.qualified ?? 0) === 1,
    required_correct_count: Number(row.required_correct_count ?? 0),
    served_count: Number(row.exercise_count ?? 0),
    status: (readString(row.status) ?? "active") as StudySessionStatus,
    total_units: totalUnits,
  }
}

export async function getStudySessionSummary(
  client: ReadClient,
  sessionId: string,
): Promise<StudySessionSummary | undefined> {
  const row = await executeFirst(client, {
    sql: `
      SELECT id, status, exercise_count, required_correct_count, max_presentations,
             presentation_count, completed_exercise_count, first_pass_correct_count,
             mastered_exercise_count, qualified
      FROM song_study_session WHERE id = ?1
    `,
    args: [sessionId],
  }) as SessionRow | null
  if (!row) return undefined
  const exerciseCount = Number(row.exercise_count ?? 0)
  return mapSummary(row, exerciseCount, exerciseCount)
}

async function expireStaleSession(input: {
  client: ReadClient
  now: string
  postId: string
  targetLanguage: string
  userId: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      UPDATE song_study_session
      SET status = 'expired', updated_at = ?4
      WHERE user_id = ?1 AND post_id = ?2 AND target_language = ?3
        AND status = 'active' AND expires_at <= ?4
    `,
    args: [input.userId, input.postId, input.targetLanguage, input.now],
  })
}

async function activeSession(input: {
  client: ReadClient
  postId: string
  targetLanguage: string
  userId: string
}): Promise<SessionRow | null> {
  return await executeFirst(input.client, {
    sql: `
      SELECT id, status, exercise_count, required_correct_count, max_presentations,
             presentation_count, completed_exercise_count, first_pass_correct_count,
             mastered_exercise_count, qualified
      FROM song_study_session
      WHERE user_id = ?1 AND post_id = ?2 AND target_language = ?3 AND status = 'active'
      LIMIT 1
    `,
    args: [input.userId, input.postId, input.targetLanguage],
  }) as SessionRow | null
}

export async function ensureStudySession(input: {
  available: StudyExerciseRow[]
  candidates: StudyExerciseRow[]
  client: Client
  communityId: string
  dueCount: number
  now: string
  postId: string
  targetLanguage: string
  totalUnits: number
  userId: string
}): Promise<{ exercises: Array<{ progress: StudySessionExerciseProgress; row: StudyExerciseRow }>; summary: StudySessionSummary }> {
  await expireStaleSession(input)
  let session = await activeSession(input)
  if (!session) {
    const candidates = input.candidates.slice(0, STUDY_SESSION_DISTINCT_EXERCISE_LIMIT)
    if (candidates.length === 0) {
      return {
        exercises: [],
        summary: {
          completed_exercise_count: 0,
          due_count: input.dueCount,
          first_pass_correct_count: 0,
          id: null,
          mastered_exercise_count: 0,
          max_presentations: 0,
          presentation_count: 0,
          qualified: false,
          required_correct_count: 0,
          served_count: 0,
          status: "caught_up",
          total_units: input.totalUnits,
        },
      }
    }
    const sessionId = makeId("sts")
    const exerciseCount = candidates.length
    await input.client.batch([{
      sql: `
        INSERT INTO song_study_session (
          id, user_id, post_id, community_id, target_language, status,
          exercise_count, required_correct_count, max_presentations,
          created_at, expires_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?7, ?8, ?9, ?10, ?9)
        ON CONFLICT DO NOTHING
      `,
      args: [
        sessionId,
        input.userId,
        input.postId,
        input.communityId,
        input.targetLanguage,
        exerciseCount,
        requiredCorrectCount(exerciseCount),
        maxPresentationCount(exerciseCount),
        input.now,
        expiresAt(input.now),
      ],
    }, ...candidates.map((exercise, ordinal) => ({
        sql: `
          INSERT INTO song_study_session_exercise (
            session_id, exercise_id, ordinal, created_at, updated_at
          )
          SELECT ?1, ?2, ?3, ?4, ?4
          WHERE EXISTS (SELECT 1 FROM song_study_session WHERE id = ?1)
          ON CONFLICT DO NOTHING
        `,
        args: [sessionId, exercise.id, ordinal, input.now],
      }))], "write")
    session = await activeSession(input)
  }
  if (!session) throw new Error("Could not create study session")
  const sessionId = readString(session.id) ?? ""
  const exerciseRows = await input.client.execute({
    sql: `
      SELECT exercise_id, presentation_count, first_outcome, mastered
      FROM song_study_session_exercise
      WHERE session_id = ?1
      ORDER BY ordinal ASC
    `,
    args: [sessionId],
  })
  const candidatesById = new Map(input.available.map((row) => [row.id, row]))
  const exercises = exerciseRows.rows.flatMap((state) => {
    const row = candidatesById.get(readString(state.exercise_id) ?? "")
    if (!row) return []
    return [{
      progress: {
        firstOutcome: asOutcome(state.first_outcome),
        mastered: Number(state.mastered ?? 0) === 1,
        presentationCount: Number(state.presentation_count ?? 0),
      },
      row,
    }]
  })
  return { exercises, summary: mapSummary(session, input.dueCount, input.totalUnits) }
}

export async function requireStudySessionForAttempt(input: {
  attemptNumber: number
  client: ReadClient
  exerciseId: string
  now: string
  postId: string
  sessionId: string
  userId: string
}): Promise<StudySessionForAttempt> {
  const row = await executeFirst(input.client, {
    sql: `
      SELECT s.id, s.target_language, s.required_correct_count, s.max_presentations,
             s.presentation_count AS session_presentations,
             e.presentation_count, e.first_outcome, e.mastered
      FROM song_study_session s
      JOIN song_study_session_exercise e ON e.session_id = s.id
      WHERE s.id = ?1 AND s.user_id = ?2 AND s.post_id = ?3
        AND s.status = 'active' AND s.expires_at > ?4 AND e.exercise_id = ?5
      LIMIT 1
    `,
    args: [input.sessionId, input.userId, input.postId, input.now, input.exerciseId],
  }) as SessionRow | null
  if (!row) throw notFoundError("Study session exercise not found")
  const presentationCount = Number(row.presentation_count ?? 0)
  if (Number(row.mastered ?? 0) === 1) throw badRequestError("Study exercise is already mastered")
  if (presentationCount >= STUDY_SESSION_MAX_CARD_PRESENTATIONS) {
    throw badRequestError("Study exercise presentation limit reached")
  }
  if (Number(row.session_presentations ?? 0) >= Number(row.max_presentations ?? 0)) {
    throw badRequestError("Study session presentation limit reached")
  }
  if (input.attemptNumber !== presentationCount + 1) {
    throw badRequestError("attempt_number does not match the next session presentation")
  }
  return {
    exercise: {
      firstOutcome: asOutcome(row.first_outcome),
      mastered: false,
      presentationCount,
    },
    maxPresentations: Number(row.max_presentations ?? 0),
    requiredCorrectCount: Number(row.required_correct_count ?? 0),
    sessionId: readString(row.id) ?? input.sessionId,
    targetLanguage: readString(row.target_language) ?? "",
  }
}

export async function recordStudySessionPresentation(input: {
  attemptId: string
  client: ReadClient
  exerciseId: string
  now: string
  outcome: AttemptOutcome
  sessionId: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      UPDATE song_study_session_exercise
      SET presentation_count = presentation_count + 1,
          first_outcome = COALESCE(first_outcome, ?3),
          last_outcome = ?3,
          mastered = CASE WHEN ?3 = 'correct' THEN 1 ELSE mastered END,
          updated_at = ?4
      WHERE session_id = ?1 AND exercise_id = ?2
        AND EXISTS (SELECT 1 FROM song_study_attempt WHERE id = ?5)
    `,
    args: [input.sessionId, input.exerciseId, input.outcome, input.now, input.attemptId],
  })
  await input.client.execute({
    sql: `
      UPDATE song_study_session
      SET presentation_count = (
            SELECT SUM(presentation_count) FROM song_study_session_exercise WHERE session_id = ?1
          ),
          completed_exercise_count = (
            SELECT COUNT(*) FROM song_study_session_exercise WHERE session_id = ?1 AND first_outcome IS NOT NULL
          ),
          first_pass_correct_count = (
            SELECT COUNT(*) FROM song_study_session_exercise WHERE session_id = ?1 AND first_outcome = 'correct'
          ),
          mastered_exercise_count = (
            SELECT COUNT(*) FROM song_study_session_exercise WHERE session_id = ?1 AND mastered = 1
          ),
          updated_at = ?2
      WHERE id = ?1
    `,
    args: [input.sessionId, input.now],
  })
  await input.client.execute({
    sql: `
      UPDATE song_study_session
      SET status = 'completed',
          qualified = CASE
            WHEN completed_exercise_count >= exercise_count
             AND first_pass_correct_count >= required_correct_count THEN 1
            ELSE 0
          END,
          completed_at = ?2,
          updated_at = ?2
      WHERE id = ?1 AND status = 'active' AND (
        mastered_exercise_count >= exercise_count
        OR presentation_count >= max_presentations
        OR NOT EXISTS (
          SELECT 1 FROM song_study_session_exercise e
          WHERE e.session_id = ?1 AND e.mastered = 0 AND e.presentation_count < ?3
        )
      )
    `,
    args: [input.sessionId, input.now, STUDY_SESSION_MAX_CARD_PRESENTATIONS],
  })
}
