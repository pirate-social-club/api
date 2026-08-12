import { describe, expect, test } from "bun:test"
import {
  hasStudyRevisionConflict,
  planGradedStudyTransition,
  planStaleStudyTransition,
  planUngradableStudyTransition,
  type StudyTransitionSessionState,
} from "./post-study-transition-planner"

function session(count = 4): StudyTransitionSessionState {
  return {
    communityId: "cmt_1",
    completionReason: null,
    currentExerciseId: "ex_0",
    exerciseCount: count,
    exercises: Array.from({ length: count }, (_, ordinal) => ({
      appearanceAttemptCount: 0,
      appearanceOrdinal: 0,
      exerciseId: `ex_${ordinal}`,
      firstOutcome: null,
      lastOutcome: null,
      lastServedIndex: 0,
      lessonResolved: false,
      mastered: false,
      ordinal,
      presentationCount: 0,
      qualifiesForReward: true,
    })),
    expiresAt: "2026-08-07T00:00:00.000Z",
    firstPassCorrectCount: 0,
    id: "sts_1",
    masteredExerciseCount: 0,
    maxPresentations: Math.min(20, count * 3),
    postId: "pst_1",
    presentationCount: 0,
    qualified: false,
    requiredCorrectCount: Math.ceil(count * 0.7),
    sessionRevision: 0,
    status: "active",
    targetLanguage: "ru",
    userId: "usr_1",
  }
}

describe("song study orchestration transition fixture", () => {
  test("every normative transition row is deterministic on replay and conflicts after advancement", () => {
    const cases: Array<{
      exerciseId: string
      name: string
      plan: (state: StudyTransitionSessionState) => ReturnType<typeof planGradedStudyTransition | typeof planUngradableStudyTransition>
      state: () => StudyTransitionSessionState
    }> = [
      { name: "correct", exerciseId: "ex_0", state: () => session(), plan: (state) => planGradedStudyTransition({ attemptNumber: 1, exerciseId: "ex_0", exerciseType: "translation_choice", outcome: "correct", session: state }) },
      { name: "correct reappearance", exerciseId: "ex_0", state: () => { const state = session(); Object.assign(state.exercises[0]!, { appearanceOrdinal: 1, lastServedIndex: 1, presentationCount: 1 }); state.presentationCount = 4; return state }, plan: (state) => planGradedStudyTransition({ attemptNumber: 2, exerciseId: "ex_0", exerciseType: "say_it_back", outcome: "correct", session: state }) },
      { name: "first spoken miss", exerciseId: "ex_0", state: () => session(), plan: (state) => planGradedStudyTransition({ attemptNumber: 1, exerciseId: "ex_0", exerciseType: "say_it_back", outcome: "incorrect", session: state }) },
      { name: "second spoken miss", exerciseId: "ex_0", state: () => { const state = session(); Object.assign(state.exercises[0]!, { appearanceAttemptCount: 1, firstOutcome: "incorrect", lastOutcome: "incorrect", lastServedIndex: 1, presentationCount: 1 }); state.presentationCount = 1; return state }, plan: (state) => planGradedStudyTransition({ attemptNumber: 2, exerciseId: "ex_0", exerciseType: "say_it_back", outcome: "incorrect", session: state }) },
      { name: "translation miss", exerciseId: "ex_0", state: () => session(), plan: (state) => planGradedStudyTransition({ attemptNumber: 1, exerciseId: "ex_0", exerciseType: "translation_choice", outcome: "incorrect", session: state }) },
      { name: "free ungradable", exerciseId: "ex_0", state: () => session(), plan: (state) => planUngradableStudyTransition({ exerciseId: "ex_0", session: state }) },
      { name: "ungradable allowance spent", exerciseId: "ex_0", state: () => session(), plan: (state) => planGradedStudyTransition({ attemptNumber: 1, exerciseId: "ex_0", exerciseType: "say_it_back", outcome: "incorrect", session: state }) },
      { name: "incorrect final presentation", exerciseId: "ex_0", state: () => { const state = session(); Object.assign(state.exercises[0]!, { appearanceOrdinal: 1, firstOutcome: "incorrect", lastOutcome: "incorrect", lastServedIndex: 2, presentationCount: 2 }); state.presentationCount = 5; return state }, plan: (state) => planGradedStudyTransition({ attemptNumber: 3, exerciseId: "ex_0", exerciseType: "translation_choice", outcome: "revealed", session: state }) },
      { name: "presentation budget", exerciseId: "ex_0", state: () => { const state = session(10); state.presentationCount = 19; state.maxPresentations = 20; return state }, plan: (state) => planGradedStudyTransition({ attemptNumber: 1, exerciseId: "ex_0", exerciseType: "translation_choice", outcome: "incorrect", session: state }) },
    ]
    for (const fixture of cases) {
      const original = fixture.state()
      const fresh = fixture.plan(original)
      expect(fixture.plan(fixture.state()), `${fixture.name}: equivalent replay`).toEqual(fresh)
      expect(hasStudyRevisionConflict({
        exerciseId: fixture.exerciseId,
        expectedRevision: original.sessionRevision,
        session: {
          currentExerciseId: fresh.lesson.next?.exerciseId ?? null,
          sessionRevision: fresh.lesson.sessionRevision,
        },
      }), `${fixture.name}: stale revision`).toBe(true)
    }
  })

  test("correct resolves and masters the card, advances progress, and increments revision", () => {
    const plan = planGradedStudyTransition({
      attemptNumber: 1, exerciseId: "ex_0", exerciseType: "translation_choice", outcome: "correct", session: session(),
    })
    expect(plan.lesson).toMatchObject({ resolvedCount: 1, sessionRevision: 1 })
    expect(plan.changedExercises.find((row) => row.exerciseId === "ex_0")).toMatchObject({
      lessonResolved: true, mastered: true, presentationCount: 1,
    })
  })

  test("correct on reappearance follows the ordinary correct transition", () => {
    const state = session()
    Object.assign(state.exercises[0]!, {
      appearanceOrdinal: 1, lastServedIndex: 1, presentationCount: 1,
    })
    state.presentationCount = 4
    const plan = planGradedStudyTransition({
      attemptNumber: 2, exerciseId: "ex_0", exerciseType: "say_it_back", outcome: "correct", session: state,
    })
    expect(plan.lesson.resolvedCount).toBe(1)
    expect(plan.changedExercises.find((row) => row.exerciseId === "ex_0")?.mastered).toBe(true)
  })

  test("first spoken miss retries in place without resolving", () => {
    const plan = planGradedStudyTransition({
      attemptNumber: 1, exerciseId: "ex_0", exerciseType: "say_it_back", outcome: "incorrect", session: session(),
    })
    expect(plan.lesson.next).toMatchObject({
      appearanceAttemptCount: 1, exerciseId: "ex_0", retryInPlace: true,
    })
    expect(plan.lesson.resolvedCount).toBe(0)
  })

  test("second spoken miss ends the appearance and requeues with three-attempt spacing", () => {
    const state = session()
    Object.assign(state.exercises[0]!, {
      appearanceAttemptCount: 1, firstOutcome: "incorrect", lastOutcome: "incorrect",
      lastServedIndex: 1, presentationCount: 1,
    })
    state.presentationCount = 1
    const plan = planGradedStudyTransition({
      attemptNumber: 2, exerciseId: "ex_0", exerciseType: "say_it_back", outcome: "incorrect", session: state,
    })
    expect(plan.lesson.next?.exerciseId).toBe("ex_1")
    expect(plan.changedExercises.find((row) => row.exerciseId === "ex_0")).toMatchObject({
      appearanceAttemptCount: 0, appearanceOrdinal: 1, lessonResolved: false,
    })
  })

  test("translation miss advances immediately", () => {
    const plan = planGradedStudyTransition({
      attemptNumber: 1, exerciseId: "ex_0", exerciseType: "translation_choice", outcome: "incorrect", session: session(),
    })
    expect(plan.lesson.next?.exerciseId).toBe("ex_1")
    expect(plan.lesson.resolvedCount).toBe(0)
  })

  test("free ungradable explicitly retries in place without consuming presentation or progress", () => {
    const state = session()
    const plan = planUngradableStudyTransition({ exerciseId: "ex_0", session: state })
    expect(plan.lesson).toMatchObject({ resolvedCount: 0, servingIndex: 1, sessionRevision: 1 })
    expect(plan.lesson.next).toMatchObject({
      appearanceAttemptCount: 0,
      exerciseId: "ex_0",
      presentationNumber: 1,
      retryInPlace: true,
    })
    expect(plan.session.presentation_count).toBe(0)
  })

  test("ungradable cannot resurrect a completed session", () => {
    const state = session()
    state.status = "completed"
    state.completionReason = "all_resolved"
    expect(() => planUngradableStudyTransition({ exerciseId: "ex_0", session: state })).toThrow(
      /Study session exercise not found/,
    )
  })

  test("incorrect third presentation resolves unmastered", () => {
    const state = session()
    Object.assign(state.exercises[0]!, {
      appearanceOrdinal: 1, firstOutcome: "incorrect", lastOutcome: "incorrect",
      lastServedIndex: 2, presentationCount: 2,
    })
    state.presentationCount = 5
    const plan = planGradedStudyTransition({
      attemptNumber: 3, exerciseId: "ex_0", exerciseType: "translation_choice", outcome: "revealed", session: state,
    })
    expect(plan.changedExercises.find((row) => row.exerciseId === "ex_0")).toMatchObject({
      lessonResolved: true, mastered: false, presentationCount: 3,
    })
    expect(plan.lesson.resolvedCount).toBe(1)
  })

  test("presentation budget resolves all remaining cards without mastering them", () => {
    const state = session(10)
    for (const exercise of state.exercises.slice(1, 7)) {
      exercise.firstOutcome = "incorrect"
      exercise.lastOutcome = "incorrect"
      exercise.presentationCount = 1
    }
    state.presentationCount = 19
    state.maxPresentations = 20
    const plan = planGradedStudyTransition({
      attemptNumber: 1, exerciseId: "ex_0", exerciseType: "translation_choice", outcome: "incorrect", session: state,
    })
    expect(plan.lesson).toMatchObject({ completionReason: "presentation_budget", resolvedCount: 10 })
    expect(plan.session).toMatchObject({
      completed_exercise_count: 7,
      qualified: false,
      resolved_exercise_count: 10,
      status: "completed",
    })
    expect(plan.changedExercises.every((row) => row.lessonResolved)).toBe(true)
    expect(plan.changedExercises.every((row) => !row.mastered)).toBe(true)
  })

  test("qualification counts only immutable qualifying cards", () => {
    const state = session(2)
    state.exercises[1]!.qualifiesForReward = false
    state.requiredCorrectCount = 1
    state.exercises[1]!.lessonResolved = true
    const plan = planGradedStudyTransition({
      attemptNumber: 1, exerciseId: "ex_0", exerciseType: "translation_choice", outcome: "correct", session: state,
    })
    expect(plan.session).toMatchObject({ first_pass_correct_count: 1, qualified: true, status: "completed" })
  })

  test("stale enrichment resolves without consuming a presentation or reward progress", () => {
    const state = session(3)
    state.exercises[0]!.qualifiesForReward = false
    state.exercises[1]!.qualifiesForReward = false
    const plan = planStaleStudyTransition({
      exerciseIds: new Set(["ex_0", "ex_1"]),
      session: state,
    })

    expect(plan.changedExercises.map((exercise) => exercise.exerciseId)).toEqual(["ex_0", "ex_1"])
    expect(plan.changedExercises.every((exercise) => exercise.lessonResolved)).toBe(true)
    expect(plan.lesson).toMatchObject({
      next: { exerciseId: "ex_2", presentationNumber: 1 },
      resolvedCount: 2,
      sessionRevision: 1,
    })
    expect(plan.session).toMatchObject({
      completed_exercise_count: 0,
      first_pass_correct_count: 0,
      presentation_count: 0,
      qualified: false,
      resolved_exercise_count: 2,
      status: "active",
    })
  })

  test("stale-only enrichment completes without creating reward qualification", () => {
    const state = session(2)
    state.exercises.forEach((exercise) => { exercise.qualifiesForReward = false })
    state.requiredCorrectCount = 1
    const plan = planStaleStudyTransition({
      exerciseIds: new Set(["ex_0", "ex_1"]),
      session: state,
    })

    expect(plan.lesson).toMatchObject({ completionReason: "all_resolved", next: null, resolvedCount: 2 })
    expect(plan.session).toMatchObject({ qualified: false, status: "completed" })
  })
})
