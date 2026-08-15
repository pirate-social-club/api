import {
  fsrs,
  Rating,
  State,
  type Card,
  type Grade,
  type FSRSParameters,
} from "ts-fsrs"

export const LEARNING_REVIEW_ALGORITHM = "fsrs_6_v1" as const
export const LEARNING_REVIEW_PARAMETERS_VERSION = 1 as const

export type ReviewRating = "again" | "hard" | "good" | "easy"
export type ReviewPhase = "new" | "learning" | "review" | "relearning"

export type ReviewState = {
  phase: ReviewPhase
  stability: number
  difficulty: number
  dueAtMs: number
  lastReviewedAtMs: number | null
  learningStepIndex: number | null
  scheduledIntervalDays: number
  reps: number
  lapses: number
}

export type ReviewTransition = {
  algorithm: typeof LEARNING_REVIEW_ALGORITHM
  parametersVersion: typeof LEARNING_REVIEW_PARAMETERS_VERSION
  reviewedAtMs: number
  scheduledIntervalDays: number
  state: ReviewState
}

/**
 * This is an application-owned serialization boundary around the pinned
 * ts-fsrs FSRS-6 implementation. Keep every scheduler input explicit: the
 * scheduler must never read the wall clock or add random fuzz.
 */
export const FSRS_6_PARAMETERS: Readonly<FSRSParameters> = Object.freeze({
  request_retention: 0.9,
  maximum_interval: 36500,
  w: Object.freeze([
    0.212,
    1.2931,
    2.3065,
    8.2956,
    6.4133,
    0.8334,
    3.0194,
    0.001,
    1.8722,
    0.1666,
    0.796,
    1.4835,
    0.0614,
    0.2629,
    1.6483,
    0.6014,
    1.8729,
    0.5425,
    0.0912,
    0.0658,
    0.1542,
  ]),
  enable_fuzz: false,
  enable_short_term: true,
  learning_steps: Object.freeze(["1m", "10m"] as const),
  relearning_steps: Object.freeze(["10m"] as const),
})

const SCHEDULER = fsrs(FSRS_6_PARAMETERS)

function assertFiniteTimestamp(nowMs: number): void {
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new RangeError("review timestamp must be a finite non-negative millisecond value")
  }
}

function assertFiniteState(state: ReviewState): void {
  const values = [
    state.dueAtMs,
    state.stability,
    state.difficulty,
    state.scheduledIntervalDays,
    state.reps,
    state.lapses,
  ]
  if (state.lastReviewedAtMs != null) values.push(state.lastReviewedAtMs)
  if (values.some((value) => !Number.isFinite(value))) {
    throw new RangeError("review state must contain only finite numeric values")
  }
  if (state.reps < 0 || state.lapses < 0 || state.stability < 0 || state.difficulty < 0) {
    throw new RangeError("review state contains an invalid negative value")
  }
}

function toRating(rating: ReviewRating): Grade {
  switch (rating) {
    case "again": return Rating.Again
    case "hard": return Rating.Hard
    case "good": return Rating.Good
    case "easy": return Rating.Easy
  }
}

function toState(phase: ReviewPhase): State {
  switch (phase) {
    case "new": return State.New
    case "learning": return State.Learning
    case "review": return State.Review
    case "relearning": return State.Relearning
  }
}

function fromState(state: State): ReviewPhase {
  switch (state) {
    case State.New: return "new"
    case State.Learning: return "learning"
    case State.Review: return "review"
    case State.Relearning: return "relearning"
    default: throw new RangeError("scheduler returned an unknown card state")
  }
}

function cardFromReviewState(state: ReviewState): Card {
  assertFiniteState(state)
  return {
    due: new Date(state.dueAtMs),
    stability: state.stability,
    difficulty: state.difficulty,
    scheduled_days: state.scheduledIntervalDays,
    reps: state.reps,
    lapses: state.lapses,
    learning_steps: state.learningStepIndex ?? 0,
    state: toState(state.phase),
    ...(state.lastReviewedAtMs == null ? {} : { last_review: new Date(state.lastReviewedAtMs) }),
  }
}

function reviewStateFromCard(card: Card): ReviewState {
  const dueAtMs = card.due.getTime()
  if (!Number.isFinite(dueAtMs)) throw new RangeError("scheduler returned an invalid due timestamp")
  return {
    phase: fromState(card.state),
    stability: card.stability,
    difficulty: card.difficulty,
    dueAtMs,
    lastReviewedAtMs: card.last_review?.getTime() ?? null,
    learningStepIndex: card.learning_steps > 0 ? card.learning_steps : null,
    scheduledIntervalDays: card.scheduled_days,
    reps: card.reps,
    lapses: card.lapses,
  }
}

function newCard(nowMs: number): Card {
  return {
    due: new Date(nowMs),
    stability: 0,
    difficulty: 0,
    scheduled_days: 0,
    reps: 0,
    lapses: 0,
    learning_steps: 0,
    state: State.New,
  }
}

export function reviewLearningCard(input: {
  nowMs: number
  rating: ReviewRating
  state: ReviewState | null
}): ReviewTransition {
  assertFiniteTimestamp(input.nowMs)
  const current = input.state == null ? newCard(input.nowMs) : cardFromReviewState(input.state)
  const result = SCHEDULER.next(current, new Date(input.nowMs), toRating(input.rating))
  const state = reviewStateFromCard(result.card)
  return {
    algorithm: LEARNING_REVIEW_ALGORITHM,
    parametersVersion: LEARNING_REVIEW_PARAMETERS_VERSION,
    reviewedAtMs: input.nowMs,
    scheduledIntervalDays: state.scheduledIntervalDays,
    state,
  }
}

export function reviewSchedulerParameters(): Readonly<FSRSParameters> {
  return FSRS_6_PARAMETERS
}
