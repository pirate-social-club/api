import { badRequestError, notFoundError } from "../errors"
import type { ExerciseType } from "./post-study-attempt-store"
import type { AttemptOutcome } from "./post-study-recall-grading"
import {
  STUDY_SESSION_MAX_CARD_PRESENTATIONS,
  type StudyLessonTransitionState,
  type StudySessionSummary,
} from "./post-study-session-service"

export type StudyTransitionExerciseState = {
  appearanceAttemptCount: number
  appearanceOrdinal: number
  exerciseId: string
  firstOutcome: AttemptOutcome | null
  lastOutcome: AttemptOutcome | null
  lastServedIndex: number
  lessonResolved: boolean
  mastered: boolean
  ordinal: number
  presentationCount: number
  qualifiesForReward: boolean
}

export type StudyTransitionSessionState = {
  communityId: string
  completionReason: "all_resolved" | "presentation_budget" | null
  currentExerciseId: string | null
  exerciseCount: number
  exercises: StudyTransitionExerciseState[]
  expiresAt: string
  firstPassCorrectCount: number
  id: string
  masteredExerciseCount: number
  maxPresentations: number
  postId: string
  presentationCount: number
  qualified: boolean
  requiredCorrectCount: number
  sessionRevision: number
  status: "active" | "completed" | "expired"
  targetLanguage: string
  userId: string
}

export type StudyGradedTransitionPlan = {
  changedExercises: StudyTransitionExerciseState[]
  lesson: StudyLessonTransitionState
  nextExerciseId: string | null
  session: StudySessionSummary
}

export type StudyUngradableTransitionPlan = {
  changedExercises: StudyTransitionExerciseState[]
  lesson: StudyLessonTransitionState
  session: StudySessionSummary
}

function cloneExercise(exercise: StudyTransitionExerciseState): StudyTransitionExerciseState {
  return { ...exercise }
}

export function hasStudyRevisionConflict(input: {
  exerciseId: string
  expectedRevision: number
  session: Pick<StudyTransitionSessionState, "currentExerciseId" | "sessionRevision">
}): boolean {
  return input.session.sessionRevision !== input.expectedRevision
    || (input.session.currentExerciseId != null && input.session.currentExerciseId !== input.exerciseId)
}

function selectNextExercise(
  exercises: StudyTransitionExerciseState[],
  sessionPresentationCount: number,
): StudyTransitionExerciseState | null {
  return exercises
    .filter((exercise) => !exercise.lessonResolved)
    .sort((left, right) => {
      const leftEligible = left.lastServedIndex <= 0
        || sessionPresentationCount - left.lastServedIndex >= 3 ? 0 : 1
      const rightEligible = right.lastServedIndex <= 0
        || sessionPresentationCount - right.lastServedIndex >= 3 ? 0 : 1
      return leftEligible - rightEligible
        || left.presentationCount - right.presentationCount
        || left.ordinal - right.ordinal
    })[0] ?? null
}

function lessonState(input: {
  completionReason: StudyTransitionSessionState["completionReason"]
  current: StudyTransitionExerciseState | null
  exerciseCount: number
  presentationCount: number
  resolvedCount: number
  retryInPlace?: boolean
  sessionRevision: number
}): StudyLessonTransitionState {
  const current = input.current
  return {
    completionReason: input.completionReason,
    next: current ? {
      appearanceAttemptCount: current.appearanceAttemptCount,
      exerciseId: current.exerciseId,
      isReappearance: current.presentationCount > current.appearanceAttemptCount,
      presentationNumber: current.presentationCount + 1,
      retryInPlace: input.retryInPlace ?? current.appearanceAttemptCount > 0,
    } : null,
    resolvedCount: input.resolvedCount,
    servingIndex: current ? input.presentationCount + 1 : input.presentationCount,
    sessionRevision: input.sessionRevision,
    totalCount: input.exerciseCount,
  }
}

/** Pure deterministic plan. Persistence applies this plan only after winning the revision CAS. */
export function planGradedStudyTransition(input: {
  attemptNumber: number
  exerciseId: string
  exerciseType: ExerciseType
  outcome: AttemptOutcome
  session: StudyTransitionSessionState
}): StudyGradedTransitionPlan {
  if (input.session.status !== "active") throw notFoundError("Study session exercise not found")
  const exercises = input.session.exercises.map(cloneExercise)
  const exercise = exercises.find((candidate) => candidate.exerciseId === input.exerciseId)
  if (!exercise) throw notFoundError("Study session exercise not found")
  if (exercise.lessonResolved) throw badRequestError("Study exercise is already resolved")
  if (input.attemptNumber !== exercise.presentationCount + 1) {
    throw badRequestError("attempt_number does not match the next session presentation")
  }

  const changed = new Set<string>()
  if (input.session.currentExerciseId && input.session.currentExerciseId !== exercise.exerciseId) {
    const prior = exercises.find((candidate) => candidate.exerciseId === input.session.currentExerciseId)
    if (prior) {
      prior.appearanceOrdinal += 1
      prior.appearanceAttemptCount = 0
      changed.add(prior.exerciseId)
    }
  }

  const servingIndex = input.session.presentationCount + 1
  exercise.presentationCount += 1
  exercise.appearanceAttemptCount += 1
  exercise.lastServedIndex = servingIndex
  exercise.firstOutcome ??= input.outcome
  exercise.lastOutcome = input.outcome
  exercise.mastered ||= input.outcome === "correct"
  exercise.lessonResolved ||= exercise.mastered
    || input.outcome === "revealed"
    || exercise.presentationCount >= STUDY_SESSION_MAX_CARD_PRESENTATIONS
  changed.add(exercise.exerciseId)

  const staysCurrent = input.exerciseType === "say_it_back"
    && input.outcome === "incorrect"
    && exercise.appearanceAttemptCount === 1
    && !exercise.lessonResolved
    && servingIndex < input.session.maxPresentations
  if (!staysCurrent) {
    exercise.appearanceOrdinal += 1
    exercise.appearanceAttemptCount = 0
  }

  let completionReason: StudyTransitionSessionState["completionReason"] = null
  let next = staysCurrent ? exercise : null
  const unresolvedBeforeBudget = exercises.filter((candidate) => !candidate.lessonResolved)
  if (unresolvedBeforeBudget.length === 0) {
    completionReason = "all_resolved"
  } else if (servingIndex >= input.session.maxPresentations) {
    completionReason = "presentation_budget"
    for (const candidate of unresolvedBeforeBudget) {
      candidate.lessonResolved = true
      changed.add(candidate.exerciseId)
    }
  } else if (!next) {
    next = selectNextExercise(exercises, servingIndex)
  }

  const resolvedCount = exercises.filter((candidate) => candidate.lessonResolved).length
  const presentedCount = exercises.filter((candidate) => candidate.firstOutcome != null).length
  const firstPassCorrectCount = exercises.filter((candidate) =>
    candidate.qualifiesForReward && candidate.firstOutcome === "correct").length
  const qualifyingPresented = exercises.every((candidate) =>
    !candidate.qualifiesForReward || candidate.firstOutcome != null)
  const masteredExerciseCount = exercises.filter((candidate) => candidate.mastered).length
  const completed = completionReason != null
  const qualified = completed
    && qualifyingPresented
    && firstPassCorrectCount >= input.session.requiredCorrectCount
  const revision = input.session.sessionRevision + 1

  return {
    changedExercises: exercises.filter((candidate) => changed.has(candidate.exerciseId)),
    lesson: lessonState({
      completionReason,
      current: completed ? null : next,
      exerciseCount: input.session.exerciseCount,
      presentationCount: servingIndex,
      resolvedCount,
      sessionRevision: revision,
    }),
    nextExerciseId: completed ? null : next?.exerciseId ?? null,
    session: {
      completion_reason: completionReason,
      completed_exercise_count: presentedCount,
      due_count: 0,
      first_pass_correct_count: firstPassCorrectCount,
      id: input.session.id,
      mastered_exercise_count: masteredExerciseCount,
      max_presentations: input.session.maxPresentations,
      presentation_count: servingIndex,
      qualified,
      required_correct_count: input.session.requiredCorrectCount,
      resolved_exercise_count: resolvedCount,
      served_count: input.session.exerciseCount,
      session_revision: revision,
      status: completed ? "completed" : "active",
      total_units: input.session.exerciseCount,
    },
  }
}

export function planUngradableStudyTransition(input: {
  exerciseId: string
  session: StudyTransitionSessionState
}): StudyUngradableTransitionPlan {
  if (input.session.status !== "active") throw notFoundError("Study session exercise not found")
  const exercises = input.session.exercises.map(cloneExercise)
  const exercise = exercises.find((candidate) => candidate.exerciseId === input.exerciseId)
  if (!exercise || exercise.lessonResolved) throw notFoundError("Study session exercise not found")
  const changed: StudyTransitionExerciseState[] = []
  if (input.session.currentExerciseId && input.session.currentExerciseId !== input.exerciseId) {
    const prior = exercises.find((candidate) => candidate.exerciseId === input.session.currentExerciseId)
    if (prior) {
      prior.appearanceOrdinal += 1
      prior.appearanceAttemptCount = 0
      changed.push(prior)
    }
  }
  const revision = input.session.sessionRevision + 1
  return {
    changedExercises: changed,
    lesson: lessonState({
      completionReason: null,
      current: exercise,
      exerciseCount: input.session.exerciseCount,
      presentationCount: input.session.presentationCount,
      resolvedCount: exercises.filter((candidate) => candidate.lessonResolved).length,
      retryInPlace: true,
      sessionRevision: revision,
    }),
    session: {
      completion_reason: null,
      completed_exercise_count: exercises.filter((candidate) => candidate.firstOutcome != null).length,
      due_count: 0,
      first_pass_correct_count: input.session.firstPassCorrectCount,
      id: input.session.id,
      mastered_exercise_count: input.session.masteredExerciseCount,
      max_presentations: input.session.maxPresentations,
      presentation_count: input.session.presentationCount,
      qualified: input.session.qualified,
      required_correct_count: input.session.requiredCorrectCount,
      resolved_exercise_count: exercises.filter((candidate) => candidate.lessonResolved).length,
      served_count: input.session.exerciseCount,
      session_revision: revision,
      status: "active",
      total_units: input.session.exerciseCount,
    },
  }
}
