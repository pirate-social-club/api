import { describe, expect, test } from "bun:test"
import {
  FSRS_6_PARAMETERS,
  LEARNING_REVIEW_ALGORITHM,
  LEARNING_REVIEW_PARAMETERS_VERSION,
  reviewLearningCard,
  type ReviewState,
} from "./review-scheduler"

describe("fsrs_6_v1 review scheduler", () => {
  test("pins the 21 parameters and disables nondeterministic fuzzing", () => {
    expect(FSRS_6_PARAMETERS.w).toHaveLength(21)
    expect(FSRS_6_PARAMETERS.enable_fuzz).toBe(false)
    expect(FSRS_6_PARAMETERS.request_retention).toBe(0.9)
  })

  test("creates a deterministic first transition for every rating", () => {
    const nowMs = Date.UTC(2026, 0, 1)
    for (const rating of ["again", "hard", "good", "easy"] as const) {
      const first = reviewLearningCard({ nowMs, rating, state: null })
      const replay = reviewLearningCard({ nowMs, rating, state: null })
      expect(first).toEqual(replay)
      expect(first.algorithm).toBe(LEARNING_REVIEW_ALGORITHM)
      expect(first.parametersVersion).toBe(LEARNING_REVIEW_PARAMETERS_VERSION)
      expect(first.reviewedAtMs).toBe(nowMs)
      expect(first.state.lastReviewedAtMs).toBe(nowMs)
      expect(first.state.reps).toBe(1)
    }
  })

  test("round-trips a review state without reading the wall clock", () => {
    const first = reviewLearningCard({ nowMs: 1_700_000_000_000, rating: "good", state: null })
    const second = reviewLearningCard({
      nowMs: first.state.dueAtMs,
      rating: "easy",
      state: first.state,
    })
    expect(second.state.reps).toBe(2)
    expect(second.state.lastReviewedAtMs).toBe(first.state.dueAtMs)
    expect(second.state.dueAtMs).toBeGreaterThan(first.state.dueAtMs)
  })

  test("matches the pinned FSRS-6 reference interval vector", () => {
    // Reference: open-spaced-repetition/ts-fsrs FSRS-6 fixture, using the
    // default 21 weights, short-term learning steps, and fuzz disabled.
    const ratings = [
      "good", "good", "good", "good", "good", "good",
      "again", "again", "good", "good", "good", "good", "good",
    ] as const
    const expectedIntervals = [0, 2, 11, 46, 163, 498, 0, 0, 2, 4, 7, 12, 21]
    let state: ReviewState | null = null
    let nowMs = Date.UTC(2022, 11, 29, 12, 30)
    const intervals: number[] = []
    for (const rating of ratings) {
      const transition = reviewLearningCard({ nowMs, rating, state })
      intervals.push(transition.state.scheduledIntervalDays)
      state = transition.state
      nowMs = transition.state.dueAtMs
    }
    expect(intervals).toEqual(expectedIntervals)
  })

  test("matches the pinned FSRS-6 memory-state vector", () => {
    const ratings = ["again", "good", "good", "good", "good", "good"] as const
    const elapsedDays = [0, 0, 1, 3, 8, 21]
    let state: ReviewState | null = null
    let nowMs = Date.UTC(2022, 11, 29, 12, 30)
    for (const [index, rating] of ratings.entries()) {
      nowMs += elapsedDays[index]! * 24 * 60 * 60 * 1000
      state = reviewLearningCard({ nowMs, rating, state }).state
    }
    expect(state?.stability).toBeCloseTo(53.62691, 4)
    expect(state?.difficulty).toBeCloseTo(6.3574867, 4)
  })

  test("rejects invalid timestamps and non-finite persisted state", () => {
    expect(() => reviewLearningCard({ nowMs: Number.NaN, rating: "good", state: null })).toThrow()
    expect(() => reviewLearningCard({ nowMs: -1, rating: "good", state: null })).toThrow()
    expect(() => reviewLearningCard({
      nowMs: 1,
      rating: "good",
      state: {
        phase: "review",
        stability: Number.NaN,
        difficulty: 3,
        dueAtMs: 1,
        lastReviewedAtMs: 1,
        learningStepIndex: null,
        scheduledIntervalDays: 1,
        reps: 1,
        lapses: 0,
      },
    })).toThrow()
  })
})
