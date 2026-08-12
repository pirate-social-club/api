import { executeFirst } from "../db-helpers"
import { badRequestError, codedConflictError, notFoundError } from "../errors"
import { makeId } from "../helpers"
import type { Client, ReadClient } from "../sql-client"
import type { AttemptOutcome } from "./post-study-recall-grading"
import type { ExerciseType, StudyExerciseRow } from "./post-study-attempt-store"
import type { StudyTransitionSessionState } from "./post-study-transition-planner"
import type { StudyGradedTransitionPlan, StudyUngradableTransitionPlan } from "./post-study-transition-planner"

export const STUDY_SESSION_DISTINCT_EXERCISE_LIMIT = 10
export const STUDY_SESSION_MAX_CARD_PRESENTATIONS = 3
export const STUDY_SESSION_PRESENTATION_LIMIT = 20
const STUDY_SESSION_TTL_MS = 24 * 60 * 60 * 1000

export type StudySessionStatus = "active" | "completed" | "caught_up" | "expired"

export type StudySessionSummary = {
  completion_reason: "all_resolved" | "presentation_budget" | null
  completed_exercise_count: number
  due_count: number
  first_pass_correct_count: number
  id: string | null
  mastered_exercise_count: number
  max_presentations: number
  presentation_count: number
  qualified: boolean
  required_correct_count: number
  resolved_exercise_count: number
  session_revision: number
  served_count: number
  status: StudySessionStatus
  total_units: number
  next_due_at?: number
}

export type StudySessionExerciseProgress = {
  appearanceAttemptCount: number
  appearanceOrdinal: number
  firstOutcome: AttemptOutcome | null
  lastServedIndex: number | null
  lessonResolved: boolean
  mastered: boolean
  presentationCount: number
}

export type StudySessionForAttempt = {
  currentExerciseId: string | null
  exercise: StudySessionExerciseProgress
  maxPresentations: number
  requiredCorrectCount: number
  sessionPresentationCount: number
  sessionRevision: number
  sessionId: string
  targetLanguage: string
}

export type StudyLessonTransitionState = {
  completionReason: "all_resolved" | "presentation_budget" | null
  next: null | {
    appearanceAttemptCount: number
    exerciseId: string
    isReappearance: boolean
    presentationNumber: number
    retryInPlace: boolean
  }
  resolvedCount: number
  servingIndex: number
  sessionRevision: number
  totalCount: number
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

/**
 * The exercise query deliberately decides which cards enter the lesson. Once
 * that ten-card snapshot is fixed, spread multiple exercise types for the same
 * lyric across the lesson instead of serving them back-to-back.
 */
export function interleaveStudySessionCandidates(candidates: StudyExerciseRow[]): StudyExerciseRow[] {
  const byLine = new Map<string, StudyExerciseRow[]>()
  for (const candidate of candidates) {
    const entries = byLine.get(candidate.line_id)
    if (entries) entries.push(candidate)
    else byLine.set(candidate.line_id, [candidate])
  }
  const ordered: StudyExerciseRow[] = []
  let depth = 0
  while (ordered.length < candidates.length) {
    let added = false
    for (const entries of byLine.values()) {
      const candidate = entries[depth]
      if (!candidate) continue
      ordered.push(candidate)
      added = true
    }
    if (!added) break
    depth += 1
  }
  return ordered
}

export function selectStudySessionCandidates(candidates: StudyExerciseRow[]): StudyExerciseRow[] {
  const enrichment = candidates.filter((candidate) => candidate.qualifies_for_reward === false)
  // Preserve the shipped line-first selection exactly when no enrichment type
  // is present. The fill-blank flag is the only path that supplies non-reward
  // candidates, so flag-off lessons retain their prior composition and order.
  if (enrichment.length === 0) {
    return interleaveStudySessionCandidates(
      candidates.slice(0, STUDY_SESSION_DISTINCT_EXERCISE_LIMIT),
    )
  }
  const qualifying = candidates
    .filter((candidate) => candidate.qualifies_for_reward !== false)
    .slice(0, STUDY_SESSION_DISTINCT_EXERCISE_LIMIT)
  const remaining = STUDY_SESSION_DISTINCT_EXERCISE_LIMIT - qualifying.length
  if (remaining <= 0) return interleaveStudySessionCandidates(qualifying)
  return interleaveStudySessionCandidates([...qualifying, ...enrichment.slice(0, remaining)])
}

function mapSummary(row: SessionRow, dueCount: number, totalUnits: number): StudySessionSummary {
  return {
    completion_reason: readString(row.completion_reason) as StudySessionSummary["completion_reason"],
    completed_exercise_count: Number(row.completed_exercise_count ?? 0),
    due_count: dueCount,
    first_pass_correct_count: Number(row.first_pass_correct_count ?? 0),
    id: readString(row.id),
    mastered_exercise_count: Number(row.mastered_exercise_count ?? 0),
    max_presentations: Number(row.max_presentations ?? 0),
    presentation_count: Number(row.presentation_count ?? 0),
    qualified: Number(row.qualified ?? 0) === 1,
    required_correct_count: Number(row.required_correct_count ?? 0),
    resolved_exercise_count: Number(row.resolved_exercise_count ?? row.completed_exercise_count ?? 0),
    session_revision: Number(row.session_revision ?? 0),
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
             mastered_exercise_count, qualified, session_revision, completion_reason,
             (SELECT COUNT(*) FROM song_study_session_exercise e
               WHERE e.session_id = song_study_session.id AND e.lesson_resolved = 1) AS resolved_exercise_count
      FROM song_study_session WHERE id = ?1
    `,
    args: [sessionId],
  }) as SessionRow | null
  if (!row) return undefined
  const exerciseCount = Number(row.exercise_count ?? 0)
  return mapSummary(row, exerciseCount, exerciseCount)
}

export async function getStudyLessonTransitionState(
  client: ReadClient,
  sessionId: string,
): Promise<StudyLessonTransitionState | undefined> {
  const session = await executeFirst(client, {
    sql: `
      SELECT id, status, exercise_count, presentation_count, session_revision,
             completion_reason, current_exercise_id
      FROM song_study_session WHERE id = ?1
    `,
    args: [sessionId],
  }) as SessionRow | null
  if (!session) return undefined
  const presentationCount = Number(session.presentation_count ?? 0)
  const currentExerciseId = readString(session.current_exercise_id)
  const nextRow = currentExerciseId
    ? await executeFirst(client, {
        sql: `
          SELECT exercise_id, presentation_count, appearance_attempt_count
          FROM song_study_session_exercise
          WHERE session_id = ?1 AND exercise_id = ?2 AND lesson_resolved = 0
        `,
        args: [sessionId, currentExerciseId],
      }) as SessionRow | null
    : null
  const resolved = await executeFirst(client, {
    sql: "SELECT COUNT(*) AS count FROM song_study_session_exercise WHERE session_id = ?1 AND lesson_resolved = 1",
    args: [sessionId],
  }) as SessionRow | null
  const cardPresentationCount = Number(nextRow?.presentation_count ?? 0)
  const appearanceAttemptCount = Number(nextRow?.appearance_attempt_count ?? 0)
  return {
    completionReason: readString(session.completion_reason) as StudyLessonTransitionState["completionReason"],
    next: nextRow ? {
      appearanceAttemptCount,
      exerciseId: readString(nextRow.exercise_id) ?? currentExerciseId ?? "",
      isReappearance: cardPresentationCount > appearanceAttemptCount,
      presentationNumber: cardPresentationCount + 1,
      retryInPlace: appearanceAttemptCount > 0,
    } : null,
    resolvedCount: Number(resolved?.count ?? 0),
    servingIndex: nextRow ? presentationCount + 1 : presentationCount,
    sessionRevision: Number(session.session_revision ?? 0),
    totalCount: Number(session.exercise_count ?? 0),
  }
}

export async function loadStudyTransitionSessionState(input: {
  client: ReadClient
  now: string
  postId: string
  sessionId: string
  userId: string
}): Promise<StudyTransitionSessionState> {
  const session = await executeFirst(input.client, {
    sql: `
      SELECT id, user_id, post_id, community_id, target_language, status,
             exercise_count, required_correct_count, max_presentations,
             presentation_count, first_pass_correct_count, mastered_exercise_count,
             qualified, session_revision, current_exercise_id, completion_reason,
             expires_at
      FROM song_study_session
      WHERE id = ?1 AND user_id = ?2 AND post_id = ?3 AND expires_at > ?4
    `,
    args: [input.sessionId, input.userId, input.postId, input.now],
  }) as SessionRow | null
  if (!session) throw notFoundError("Study session exercise not found")
  const rows = await input.client.execute({
    sql: `
      SELECT exercise_id, ordinal, presentation_count, first_outcome, last_outcome,
             mastered, appearance_ordinal, appearance_attempt_count,
             lesson_resolved, last_served_index, qualifies_for_reward
      FROM song_study_session_exercise
      WHERE session_id = ?1
      ORDER BY ordinal
    `,
    args: [input.sessionId],
  })
  return {
    communityId: readString(session.community_id) ?? "",
    completionReason: readString(session.completion_reason) as StudyTransitionSessionState["completionReason"],
    currentExerciseId: readString(session.current_exercise_id),
    exerciseCount: Number(session.exercise_count ?? rows.rows.length),
    exercises: rows.rows.map((row) => ({
      appearanceAttemptCount: Number(row.appearance_attempt_count ?? 0),
      appearanceOrdinal: Number(row.appearance_ordinal ?? 0),
      exerciseId: readString(row.exercise_id) ?? "",
      firstOutcome: asOutcome(row.first_outcome),
      lastOutcome: asOutcome(row.last_outcome),
      lastServedIndex: Number(row.last_served_index ?? 0),
      lessonResolved: Number(row.lesson_resolved ?? 0) === 1,
      mastered: Number(row.mastered ?? 0) === 1,
      ordinal: Number(row.ordinal ?? 0),
      presentationCount: Number(row.presentation_count ?? 0),
      qualifiesForReward: Number(row.qualifies_for_reward ?? 1) === 1,
    })),
    expiresAt: readString(session.expires_at) ?? "",
    firstPassCorrectCount: Number(session.first_pass_correct_count ?? 0),
    id: readString(session.id) ?? input.sessionId,
    masteredExerciseCount: Number(session.mastered_exercise_count ?? 0),
    maxPresentations: Number(session.max_presentations ?? 0),
    postId: readString(session.post_id) ?? input.postId,
    presentationCount: Number(session.presentation_count ?? 0),
    qualified: Number(session.qualified ?? 0) === 1,
    requiredCorrectCount: Number(session.required_correct_count ?? 0),
    sessionRevision: Number(session.session_revision ?? 0),
    status: (readString(session.status) ?? "active") as StudyTransitionSessionState["status"],
    targetLanguage: readString(session.target_language) ?? "",
    userId: readString(session.user_id) ?? input.userId,
  }
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
             mastered_exercise_count, qualified, session_revision, completion_reason,
             current_exercise_id,
             (SELECT COUNT(*) FROM song_study_session_exercise e
               WHERE e.session_id = song_study_session.id AND e.lesson_resolved = 1) AS resolved_exercise_count
      FROM song_study_session
      WHERE user_id = ?1 AND post_id = ?2 AND target_language = ?3 AND status = 'active'
      LIMIT 1
    `,
    args: [input.userId, input.postId, input.targetLanguage],
  }) as SessionRow | null
}

// Closes a session outside the attempt path. recordStudySessionPresentation only ever
// completes a session as a side effect of a presentation, so a session with nothing
// left to present cannot close itself: it stays 'active' until its 24h TTL while every
// read hands the learner a lesson they cannot advance.
async function completeUnattemptableSession(input: {
  client: Client
  now: string
  sessionId: string
}): Promise<void> {
  await input.client.execute({
    sql: "UPDATE song_study_session_exercise SET lesson_resolved = 1, updated_at = ?2 WHERE session_id = ?1",
    args: [input.sessionId, input.now],
  })
  await input.client.execute({
    sql: `
      UPDATE song_study_session
      SET status = 'completed',
          completion_reason = 'all_resolved',
          current_exercise_id = NULL,
          qualified = CASE
            WHEN first_pass_correct_count >= required_correct_count
             AND NOT EXISTS (
               SELECT 1
               FROM song_study_session_exercise AS exercise
               WHERE exercise.session_id = song_study_session.id
                 AND exercise.qualifies_for_reward = 1
                 AND exercise.first_outcome IS NULL
             ) THEN 1
            ELSE 0
          END,
          completed_at = ?2,
          session_revision = session_revision + 1,
          updated_at = ?2
      WHERE id = ?1 AND status = 'active'
    `,
    args: [input.sessionId, input.now],
  })
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
  // Set on the single internal retry after retiring an unattemptable session, so a
  // pathological session can never drive an unbounded recursion.
  retriedAfterRetire?: boolean
}): Promise<{ exercises: Array<{ progress: StudySessionExerciseProgress; row: StudyExerciseRow }>; summary: StudySessionSummary }> {
  await expireStaleSession(input)
  let session = await activeSession(input)
  if (!session) {
    const candidates = selectStudySessionCandidates(input.candidates)
    if (candidates.length === 0) {
      return {
        exercises: [],
        summary: {
          completion_reason: null,
          completed_exercise_count: 0,
          due_count: input.dueCount,
          first_pass_correct_count: 0,
          id: null,
          mastered_exercise_count: 0,
          max_presentations: 0,
          presentation_count: 0,
          qualified: false,
          required_correct_count: 0,
          resolved_exercise_count: 0,
          session_revision: 0,
          served_count: 0,
          status: "caught_up",
          total_units: input.totalUnits,
        },
      }
    }
    const sessionId = makeId("sts")
    const exerciseCount = candidates.length
    const qualifyingExerciseCount = candidates.filter((exercise) => exercise.qualifies_for_reward !== false).length
    await input.client.batch([{
      sql: `
        INSERT INTO song_study_session (
          id, user_id, post_id, community_id, target_language, status,
          exercise_count, required_correct_count, max_presentations,
          current_exercise_id, created_at, expires_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?7, ?8, ?9, ?10, ?11, ?10)
        ON CONFLICT DO NOTHING
      `,
      args: [
        sessionId,
        input.userId,
        input.postId,
        input.communityId,
        input.targetLanguage,
        exerciseCount,
        requiredCorrectCount(qualifyingExerciseCount),
        maxPresentationCount(exerciseCount),
        candidates[0]?.id ?? null,
        input.now,
        expiresAt(input.now),
      ],
    }, ...candidates.map((exercise, ordinal) => ({
        sql: `
          INSERT INTO song_study_session_exercise (
            session_id, exercise_id, ordinal, qualifies_for_reward, created_at, updated_at
          )
          SELECT ?1, ?2, ?3, ?4, ?5, ?5
          WHERE EXISTS (SELECT 1 FROM song_study_session WHERE id = ?1)
          ON CONFLICT DO NOTHING
        `,
        args: [sessionId, exercise.id, ordinal, exercise.qualifies_for_reward === false ? 0 : 1, input.now],
      }))], "write")
    session = await activeSession(input)
  }
  if (!session) throw new Error("Could not create study session")
  const sessionId = readString(session.id) ?? ""
  const exerciseRows = await input.client.execute({
    sql: `
      SELECT exercise_id, ordinal, presentation_count, first_outcome, mastered,
             appearance_ordinal, appearance_attempt_count, lesson_resolved,
             last_served_index
      FROM song_study_session_exercise
      WHERE session_id = ?1
      ORDER BY ordinal ASC
    `,
    args: [sessionId],
  })
  const candidatesById = new Map(input.available.map((row) => [row.id, row]))
  const currentExerciseId = readString(session.current_exercise_id)
  const sessionPresentationCount = Number(session.presentation_count ?? 0)
  const exercises = exerciseRows.rows.flatMap((state) => {
    const row = candidatesById.get(readString(state.exercise_id) ?? "")
    if (!row) return []
    return [{
      ordinal: Number(state.ordinal ?? 0),
      progress: {
        appearanceAttemptCount: Number(state.appearance_attempt_count ?? 0),
        appearanceOrdinal: Number(state.appearance_ordinal ?? 0),
        firstOutcome: asOutcome(state.first_outcome),
        lastServedIndex: Number(state.last_served_index ?? 0) > 0 ? Number(state.last_served_index) : null,
        lessonResolved: Number(state.lesson_resolved ?? 0) === 1,
        mastered: Number(state.mastered ?? 0) === 1,
        presentationCount: Number(state.presentation_count ?? 0),
      },
      row,
    }]
  }).sort((left, right) => {
    const leftCurrent = left.row.id === currentExerciseId ? 0 : 1
    const rightCurrent = right.row.id === currentExerciseId ? 0 : 1
    const leftEligible = left.progress.lastServedIndex == null
      || sessionPresentationCount - left.progress.lastServedIndex >= 3 ? 0 : 1
    const rightEligible = right.progress.lastServedIndex == null
      || sessionPresentationCount - right.progress.lastServedIndex >= 3 ? 0 : 1
    return leftCurrent - rightCurrent
      || Number(left.progress.lessonResolved) - Number(right.progress.lessonResolved)
      || leftEligible - rightEligible
      || left.progress.presentationCount - right.progress.presentationCount
      || left.ordinal - right.ordinal
  }).map(({ ordinal: _ordinal, ...entry }) => entry)
  // Two ways an active session ends up with nothing attemptable: every card was spent
  // without being mastered, or the exercises it points at were regenerated and no
  // longer resolve against `available` (the flatMap above drops those). Both leave the
  // learner staring at a complete-looking lesson with no way forward, so retire the
  // session and hand back a fresh one instead.
  const attemptable = exercises.some((entry) => !entry.progress.lessonResolved
    && entry.progress.presentationCount < STUDY_SESSION_MAX_CARD_PRESENTATIONS)
  if (!attemptable && !input.retriedAfterRetire) {
    await completeUnattemptableSession({ client: input.client, now: input.now, sessionId })
    return await ensureStudySession({ ...input, retriedAfterRetire: true })
  }
  return { exercises, summary: mapSummary(session, input.dueCount, input.totalUnits) }
}

export async function requireStudySessionForAttempt(input: {
  attemptNumber: number
  client: ReadClient
  exerciseId: string
  now: string
  postId: string
  sessionId: string
  sessionRevision?: number
  userId: string
}): Promise<StudySessionForAttempt> {
  const row = await executeFirst(input.client, {
    sql: `
      SELECT s.id, s.target_language, s.required_correct_count, s.max_presentations,
             s.presentation_count AS session_presentations,
             s.session_revision, s.current_exercise_id,
             e.presentation_count, e.first_outcome, e.mastered,
             e.appearance_ordinal, e.appearance_attempt_count,
             e.lesson_resolved, e.last_served_index
      FROM song_study_session s
      JOIN song_study_session_exercise e ON e.session_id = s.id
      WHERE s.id = ?1 AND s.user_id = ?2 AND s.post_id = ?3
        AND s.status = 'active' AND s.expires_at > ?4 AND e.exercise_id = ?5
      LIMIT 1
    `,
    args: [input.sessionId, input.userId, input.postId, input.now, input.exerciseId],
  }) as SessionRow | null
  if (!row) throw notFoundError("Study session exercise not found")
  const sessionRevision = Number(row.session_revision ?? 0)
  const currentExerciseId = readString(row.current_exercise_id)
  if (input.sessionRevision != null && (
    input.sessionRevision !== sessionRevision
    || (currentExerciseId != null && currentExerciseId !== input.exerciseId)
  )) {
    throw codedConflictError(
      "study_session_revision_conflict",
      "Study session orchestration has advanced",
      { current_exercise_id: currentExerciseId, session_revision: sessionRevision },
    )
  }
  const presentationCount = Number(row.presentation_count ?? 0)
  if (Number(row.lesson_resolved ?? 0) === 1) throw badRequestError("Study exercise is already resolved")
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
    currentExerciseId,
    exercise: {
      appearanceAttemptCount: Number(row.appearance_attempt_count ?? 0),
      appearanceOrdinal: Number(row.appearance_ordinal ?? 0),
      firstOutcome: asOutcome(row.first_outcome),
      lastServedIndex: Number(row.last_served_index ?? 0) > 0 ? Number(row.last_served_index) : null,
      lessonResolved: false,
      mastered: false,
      presentationCount,
    },
    maxPresentations: Number(row.max_presentations ?? 0),
    requiredCorrectCount: Number(row.required_correct_count ?? 0),
    sessionPresentationCount: Number(row.session_presentations ?? 0),
    sessionRevision,
    sessionId: readString(row.id) ?? input.sessionId,
    targetLanguage: readString(row.target_language) ?? "",
  }
}

export async function recordStudySessionPresentation(input: {
  attemptId: string
  client: ReadClient
  exerciseId: string
  exerciseType?: ExerciseType
  now: string
  outcome: AttemptOutcome
  sessionId: string
}): Promise<void> {
  const before = await executeFirst(input.client, {
    sql: `
      SELECT s.current_exercise_id, s.presentation_count AS session_presentations,
             s.max_presentations, e.appearance_attempt_count
      FROM song_study_session s
      JOIN song_study_session_exercise e ON e.session_id = s.id
      WHERE s.id = ?1 AND e.exercise_id = ?2
    `,
    args: [input.sessionId, input.exerciseId],
  }) as SessionRow | null
  if (!before) throw notFoundError("Study session exercise not found")

  const priorCurrentExerciseId = readString(before.current_exercise_id)
  if (priorCurrentExerciseId && priorCurrentExerciseId !== input.exerciseId) {
    // Legacy revision-absent clients may still follow their private queue. The
    // submitted unresolved card becomes the transition source; the prior card's
    // appearance ends without consuming an attempt.
    await input.client.execute({
      sql: `
        UPDATE song_study_session_exercise
        SET appearance_ordinal = appearance_ordinal + 1,
            appearance_attempt_count = 0,
            updated_at = ?3
        WHERE session_id = ?1 AND exercise_id = ?2
      `,
      args: [input.sessionId, priorCurrentExerciseId, input.now],
    })
  }
  await input.client.execute({
    sql: "UPDATE song_study_session SET current_exercise_id = ?2 WHERE id = ?1",
    args: [input.sessionId, input.exerciseId],
  })

  const nextServingIndex = Number(before.session_presentations ?? 0) + 1
  const nextCardPresentation = Number((await executeFirst(input.client, {
    sql: "SELECT presentation_count FROM song_study_session_exercise WHERE session_id = ?1 AND exercise_id = ?2",
    args: [input.sessionId, input.exerciseId],
  }) as SessionRow | null)?.presentation_count ?? 0) + 1
  const resolvedByAttempt = input.outcome === "correct"
    || input.outcome === "revealed"
    || nextCardPresentation >= STUDY_SESSION_MAX_CARD_PRESENTATIONS
  const staysCurrent = input.exerciseType === "say_it_back"
    && input.outcome === "incorrect"
    && Number(before.appearance_attempt_count ?? 0) === 0
    && !resolvedByAttempt
    && nextServingIndex < Number(before.max_presentations ?? 0)

  await input.client.execute({
    sql: `
      UPDATE song_study_session_exercise
      SET presentation_count = presentation_count + 1,
          first_outcome = COALESCE(first_outcome, ?3),
          last_outcome = ?3,
          mastered = CASE WHEN ?3 = 'correct' THEN 1 ELSE mastered END,
          lesson_resolved = CASE WHEN ?6 = 1 THEN 1 ELSE lesson_resolved END,
          last_served_index = ?7,
          appearance_attempt_count = appearance_attempt_count + 1,
          updated_at = ?4
      WHERE session_id = ?1 AND exercise_id = ?2
        AND EXISTS (SELECT 1 FROM song_study_attempt WHERE id = ?5)
    `,
    args: [
      input.sessionId,
      input.exerciseId,
      input.outcome,
      input.now,
      input.attemptId,
      resolvedByAttempt ? 1 : 0,
      nextServingIndex,
    ],
  })
  await input.client.execute({
    sql: `
      UPDATE song_study_session
      SET presentation_count = ?3,
          completed_exercise_count = (
            SELECT COUNT(*) FROM song_study_session_exercise WHERE session_id = ?1 AND first_outcome IS NOT NULL
          ),
          first_pass_correct_count = (
            SELECT COUNT(*) FROM song_study_session_exercise
            WHERE session_id = ?1 AND qualifies_for_reward = 1 AND first_outcome = 'correct'
          ),
          mastered_exercise_count = (
            SELECT COUNT(*) FROM song_study_session_exercise WHERE session_id = ?1 AND mastered = 1
          ),
          updated_at = ?2
      WHERE id = ?1
    `,
    args: [input.sessionId, input.now, nextServingIndex],
  })

  const afterAttempt = await executeFirst(input.client, {
    sql: `
      SELECT presentation_count, max_presentations,
             (SELECT COUNT(*) FROM song_study_session_exercise e
               WHERE e.session_id = s.id AND e.lesson_resolved = 0) AS unresolved_count
      FROM song_study_session s WHERE id = ?1
    `,
    args: [input.sessionId],
  }) as SessionRow | null
  const budgetClosed = Number(afterAttempt?.presentation_count ?? 0) >= Number(afterAttempt?.max_presentations ?? 0)
    && Number(afterAttempt?.unresolved_count ?? 0) > 0
  if (budgetClosed) {
    await input.client.execute({
      sql: `UPDATE song_study_session_exercise SET lesson_resolved = 1, updated_at = ?2 WHERE session_id = ?1`,
      args: [input.sessionId, input.now],
    })
  }

  if (!staysCurrent) {
    await input.client.execute({
      sql: `
        UPDATE song_study_session_exercise
        SET appearance_ordinal = appearance_ordinal + 1,
            appearance_attempt_count = 0,
            updated_at = ?3
        WHERE session_id = ?1 AND exercise_id = ?2
      `,
      args: [input.sessionId, input.exerciseId, input.now],
    })
  }

  const next = staysCurrent || budgetClosed
    ? (staysCurrent ? input.exerciseId : null)
    : readString((await executeFirst(input.client, {
        sql: `
          SELECT e.exercise_id
          FROM song_study_session_exercise e
          JOIN song_study_session s ON s.id = e.session_id
          WHERE e.session_id = ?1 AND e.lesson_resolved = 0
          ORDER BY
            CASE
              WHEN e.last_served_index <= 0 OR s.presentation_count - e.last_served_index >= 3 THEN 0
              ELSE 1
            END,
            e.presentation_count ASC,
            e.ordinal ASC
          LIMIT 1
        `,
        args: [input.sessionId],
      }) as SessionRow | null)?.exercise_id)

  await input.client.execute({
    sql: `
      UPDATE song_study_session
      SET completed_exercise_count = (
            SELECT COUNT(*) FROM song_study_session_exercise WHERE session_id = ?1 AND first_outcome IS NOT NULL
          ),
          status = CASE WHEN ?3 IS NULL THEN 'completed' ELSE status END,
          completion_reason = CASE
            WHEN ?3 IS NOT NULL THEN NULL
            WHEN ?4 = 1 THEN 'presentation_budget'
            ELSE 'all_resolved'
          END,
          current_exercise_id = ?3,
          qualified = CASE
            WHEN ?3 IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM song_study_session_exercise e
               WHERE e.session_id = ?1 AND e.qualifies_for_reward = 1 AND e.first_outcome IS NULL
             )
             AND first_pass_correct_count >= required_correct_count THEN 1
            ELSE 0
          END,
          completed_at = CASE WHEN ?3 IS NULL THEN ?2 ELSE completed_at END,
          session_revision = session_revision + 1,
          updated_at = ?2
      WHERE id = ?1 AND status = 'active'
    `,
    args: [input.sessionId, input.now, next, budgetClosed ? 1 : 0],
  })
}

/** Write-only persistence for D1's atomic buffering transaction. */
export async function applyPlannedStudyTransition(input: {
  client: ReadClient
  commitToken: string
  expectedRevision: number
  idempotencyKey: string
  now: string
  plan: StudyGradedTransitionPlan | StudyUngradableTransitionPlan
  sessionId: string
  userId: string
}): Promise<void> {
  for (const exercise of input.plan.changedExercises) {
    await input.client.execute({
      sql: `
        UPDATE song_study_session_exercise
        SET presentation_count = ?4,
            first_outcome = ?5,
            last_outcome = ?6,
            mastered = ?7,
            appearance_ordinal = ?8,
            appearance_attempt_count = ?9,
            lesson_resolved = ?10,
            last_served_index = ?11,
            updated_at = ?12
        WHERE session_id = ?1 AND exercise_id = ?2
          AND EXISTS (
            SELECT 1 FROM song_study_attempt_response r
            WHERE r.user_id = ?3 AND r.idempotency_key = ?13 AND r.commit_token = ?14
          )
      `,
      args: [
        input.sessionId,
        exercise.exerciseId,
        input.userId,
        exercise.presentationCount,
        exercise.firstOutcome,
        exercise.lastOutcome,
        exercise.mastered ? 1 : 0,
        exercise.appearanceOrdinal,
        exercise.appearanceAttemptCount,
        exercise.lessonResolved ? 1 : 0,
        exercise.lastServedIndex,
        input.now,
        input.idempotencyKey,
        input.commitToken,
      ],
    })
  }
  const session = input.plan.session
  await input.client.execute({
    sql: `
      UPDATE song_study_session
      SET status = ?4,
          presentation_count = ?5,
          completed_exercise_count = ?6,
          first_pass_correct_count = ?7,
          mastered_exercise_count = ?8,
          qualified = ?9,
          session_revision = ?10,
          current_exercise_id = ?11,
          completion_reason = ?12,
          completed_at = CASE WHEN ?4 = 'completed' THEN ?13 ELSE completed_at END,
          updated_at = ?13
      WHERE id = ?1 AND session_revision = ?2
        AND EXISTS (
          SELECT 1 FROM song_study_attempt_response r
          WHERE r.user_id = ?3 AND r.idempotency_key = ?14 AND r.commit_token = ?15
        )
    `,
    args: [
      input.sessionId,
      input.expectedRevision,
      input.userId,
      session.status,
      session.presentation_count,
      session.completed_exercise_count,
      session.first_pass_correct_count,
      session.mastered_exercise_count,
      session.qualified ? 1 : 0,
      session.session_revision,
      input.plan.lesson.next?.exerciseId ?? null,
      session.completion_reason,
      input.now,
      input.idempotencyKey,
      input.commitToken,
    ],
  })
}
