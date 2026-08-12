import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createClient, type Client } from "@libsql/client"
import type { StudyExerciseRow } from "./post-study-attempt-store"
import {
  ensureStudySession,
  getStudySessionSummary,
  interleaveStudySessionCandidates,
  selectStudySessionCandidates,
  recordStudySessionPresentation as recordStudySessionPresentationRaw,
  requireStudySessionForAttempt,
} from "./post-study-session-service"

function exercise(index: number): StudyExerciseRow {
  return {
    correct_option_id: `opt_${index}`,
    exercise_type: "translation_choice",
    id: `ex_${index}`,
    line_id: `line_${index}`,
    line_index: index,
    max_attempts: 3,
    options_json: "[]",
    prompt_text: `line ${index}`,
    question: "Choose the translation",
    reference_text: null,
    review_language: "en",
    study_pack_version: 5,
    translation_text: null,
  }
}

describe("server-owned study sessions", () => {
  let client: Client
  let attemptSequence = 0

  beforeEach(async () => {
    client = createClient({ url: ":memory:" })
    await client.executeMultiple(`
      CREATE TABLE song_study_session (
        id TEXT PRIMARY KEY, user_id TEXT, post_id TEXT, community_id TEXT,
        target_language TEXT, status TEXT, exercise_count INTEGER,
        required_correct_count INTEGER, max_presentations INTEGER,
        presentation_count INTEGER DEFAULT 0, completed_exercise_count INTEGER DEFAULT 0,
        first_pass_correct_count INTEGER DEFAULT 0, mastered_exercise_count INTEGER DEFAULT 0,
        qualified INTEGER DEFAULT 0, created_at TEXT, expires_at TEXT,
        completed_at TEXT, updated_at TEXT, session_revision INTEGER DEFAULT 0,
        current_exercise_id TEXT, completion_reason TEXT
      );
      CREATE UNIQUE INDEX active_session ON song_study_session(user_id, post_id, target_language) WHERE status = 'active';
      CREATE TABLE song_study_session_exercise (
        session_id TEXT, exercise_id TEXT, ordinal INTEGER,
        presentation_count INTEGER DEFAULT 0, first_outcome TEXT, last_outcome TEXT,
        mastered INTEGER DEFAULT 0, appearance_ordinal INTEGER DEFAULT 0,
        appearance_attempt_count INTEGER DEFAULT 0, qualifies_for_reward INTEGER DEFAULT 1,
        lesson_resolved INTEGER DEFAULT 0, last_served_index INTEGER,
        created_at TEXT, updated_at TEXT,
        PRIMARY KEY (session_id, exercise_id)
      );
      CREATE TABLE song_study_attempt (id TEXT PRIMARY KEY);
    `)
    attemptSequence = 0
  })

  afterEach(() => client.close())

  async function createSession(count: number, now = "2026-07-20T10:00:00.000Z") {
    const available = Array.from({ length: count }, (_, index) => exercise(index))
    return await ensureStudySession({
      available,
      candidates: available,
      client,
      communityId: "cmt_1",
      dueCount: 0,
      now,
      postId: "pst_1",
      targetLanguage: "en",
      totalUnits: count,
      userId: "usr_1",
    })
  }

  async function recordStudySessionPresentation(
    input: Omit<Parameters<typeof recordStudySessionPresentationRaw>[0], "attemptId">,
  ) {
    const attemptId = `sta_test_${attemptSequence += 1}`
    await client.execute({ sql: "INSERT INTO song_study_attempt (id) VALUES (?1)", args: [attemptId] })
    await recordStudySessionPresentationRaw({ ...input, attemptId })
    const summary = await getStudySessionSummary(client, input.sessionId)
    if (!summary) throw new Error("missing test session summary")
    return { justQualified: summary.qualified, summary }
  }

  test("caps the lesson at ten cards and qualifies from first presentations only", async () => {
    const created = await createSession(12)
    expect(created.exercises).toHaveLength(10)
    expect(created.summary.required_correct_count).toBe(7)
    expect(created.summary.max_presentations).toBe(20)

    const sessionId = created.summary.id!
    for (let index = 0; index < 10; index += 1) {
      await requireStudySessionForAttempt({
        attemptNumber: 1, client, exerciseId: `ex_${index}`,
        now: "2026-07-20T10:01:00.000Z", postId: "pst_1", sessionId, userId: "usr_1",
      })
      const update = await recordStudySessionPresentation({
        client, exerciseId: `ex_${index}`, now: "2026-07-20T10:01:00.000Z",
        outcome: index < 7 ? "correct" : "incorrect", sessionId,
      })
      if (index === 9) expect(update.summary.status).toBe("active")
    }

    // Correcting misses masters the cards, but does not change the first-pass 7/10 score.
    let final
    for (let index = 7; index < 10; index += 1) {
      final = await recordStudySessionPresentation({
        client, exerciseId: `ex_${index}`, now: "2026-07-20T10:02:00.000Z",
        outcome: "correct", sessionId,
      })
    }
    expect(final?.summary.status).toBe("completed")
    expect(final?.summary.first_pass_correct_count).toBe(7)
    expect(final?.summary.qualified).toBe(true)
    expect(final?.summary.presentation_count).toBe(13)
  })

  test("separates exercise types for the same lyric inside the fixed session snapshot", () => {
    const candidates = [
      { ...exercise(0), id: "line_0_say", line_id: "line_0", exercise_type: "say_it_back" as const },
      { ...exercise(0), id: "line_0_translation", line_id: "line_0" },
      { ...exercise(1), id: "line_1_say", line_id: "line_1", exercise_type: "say_it_back" as const },
      { ...exercise(1), id: "line_1_translation", line_id: "line_1" },
      { ...exercise(2), id: "line_2_say", line_id: "line_2", exercise_type: "say_it_back" as const },
      { ...exercise(2), id: "line_2_translation", line_id: "line_2" },
    ]

    expect(interleaveStudySessionCandidates(candidates).map((candidate) => candidate.id)).toEqual([
      "line_0_say", "line_1_say", "line_2_say",
      "line_0_translation", "line_1_translation", "line_2_translation",
    ])
  })

  test("does not let non-reward enrichment displace ten qualifying cards", () => {
    const qualifying = Array.from({ length: 12 }, (_, index) => exercise(index))
    const enrichment = Array.from({ length: 4 }, (_, index) => ({
      ...exercise(index),
      exercise_type: "fill_blank" as const,
      id: `fill_${index}`,
      qualifies_for_reward: false,
    }))
    const selected = selectStudySessionCandidates([...qualifying, ...enrichment])
    expect(selected).toHaveLength(10)
    expect(selected.every((candidate) => candidate.qualifies_for_reward !== false)).toBe(true)
  })

  test("serves every unseen card before returning an incorrect card", async () => {
    const created = await createSession(3)
    const sessionId = created.summary.id!
    expect(created.exercises.map((entry) => entry.row.id)).toEqual(["ex_0", "ex_1", "ex_2"])

    await recordStudySessionPresentation({
      client,
      exerciseId: "ex_0",
      now: "2026-07-20T10:01:00.000Z",
      outcome: "incorrect",
      sessionId,
    })
    const resumed = await createSession(3, "2026-07-20T10:02:00.000Z")

    expect(resumed.exercises.map((entry) => entry.row.id)).toEqual(["ex_1", "ex_2", "ex_0"])
  })

  test("stops a ten-card struggling lesson at twenty presentations without qualifying", async () => {
    const created = await createSession(10)
    const sessionId = created.summary.id!
    let final
    for (let presentation = 1; presentation <= 2; presentation += 1) {
      for (let index = 0; index < 10; index += 1) {
        await requireStudySessionForAttempt({
          attemptNumber: presentation,
          client,
          exerciseId: `ex_${index}`,
          now: "2026-07-20T10:05:00.000Z",
          postId: "pst_1",
          sessionId,
          userId: "usr_1",
        })
        final = await recordStudySessionPresentation({
          client,
          exerciseId: `ex_${index}`,
          now: "2026-07-20T10:05:00.000Z",
          outcome: "incorrect",
          sessionId,
        })
      }
    }
    expect(final?.summary).toMatchObject({
      completed_exercise_count: 10,
      first_pass_correct_count: 0,
      presentation_count: 20,
      qualified: false,
      status: "completed",
    })
  })

  test("completes a one-card lesson at the per-card cap and rejects further presentations", async () => {
    const created = await createSession(1)
    const sessionId = created.summary.id!
    let final
    for (let attemptNumber = 1; attemptNumber <= 3; attemptNumber += 1) {
      await requireStudySessionForAttempt({
        attemptNumber,
        client,
        exerciseId: "ex_0",
        now: "2026-07-20T10:05:00.000Z",
        postId: "pst_1",
        sessionId,
        userId: "usr_1",
      })
      final = await recordStudySessionPresentation({
        client,
        exerciseId: "ex_0",
        now: "2026-07-20T10:05:00.000Z",
        outcome: attemptNumber === 3 ? "revealed" : "incorrect",
        sessionId,
      })
    }
    expect(final?.summary).toMatchObject({ presentation_count: 3, qualified: false, status: "completed" })
    await expect(requireStudySessionForAttempt({
      attemptNumber: 4,
      client,
      exerciseId: "ex_0",
      now: "2026-07-20T10:06:00.000Z",
      postId: "pst_1",
      sessionId,
      userId: "usr_1",
    })).rejects.toMatchObject({ status: 404 })
  })

  test("rejects skipped presentation numbers and attempts against mastered cards", async () => {
    const created = await createSession(2)
    const sessionId = created.summary.id!
    await expect(requireStudySessionForAttempt({
      attemptNumber: 2,
      client,
      exerciseId: "ex_0",
      now: "2026-07-20T10:01:00.000Z",
      postId: "pst_1",
      sessionId,
      userId: "usr_1",
    })).rejects.toMatchObject({ status: 400 })
    await recordStudySessionPresentation({
      client,
      exerciseId: "ex_0",
      now: "2026-07-20T10:01:00.000Z",
      outcome: "correct",
      sessionId,
    })
    await expect(requireStudySessionForAttempt({
      attemptNumber: 2,
      client,
      exerciseId: "ex_0",
      now: "2026-07-20T10:02:00.000Z",
      postId: "pst_1",
      sessionId,
      userId: "usr_1",
    })).rejects.toMatchObject({ status: 400 })
  })

  // A session can only be completed as a side effect of a presentation, so any session
  // that runs out of attemptable cards without one is stranded 'active' until its 24h
  // TTL, and every read hands the learner a lesson they cannot advance.
  test("retires an active session whose exercises were regenerated away", async () => {
    const stranded = await createSession(1)
    const strandedId = stranded.summary.id!

    // ex_0 no longer resolves (regenerated under a new id), so nothing in the session
    // is presentable even though every card is unspent.
    const replacement = [exercise(1)]
    const recovered = await ensureStudySession({
      available: replacement,
      candidates: replacement,
      client,
      communityId: "cmt_1",
      dueCount: 0,
      now: "2026-07-20T10:05:00.000Z",
      postId: "pst_1",
      targetLanguage: "en",
      totalUnits: 1,
      userId: "usr_1",
    })

    expect(recovered.summary.id).not.toBe(strandedId)
    expect(recovered.summary.status).toBe("active")
    expect(recovered.exercises.map((entry) => entry.row.id)).toEqual(["ex_1"])
    const strandedSummary = await getStudySessionSummary(client, strandedId)
    expect(strandedSummary?.status).toBe("completed")
  })

  test("retires an active session whose only card is spent and serves it fresh", async () => {
    const stranded = await createSession(1)
    const strandedId = stranded.summary.id!
    await client.execute({
      sql: "UPDATE song_study_session_exercise SET presentation_count = 3, mastered = 0 WHERE session_id = ?1",
      args: [strandedId],
    })

    const recovered = await createSession(1, "2026-07-20T10:05:00.000Z")

    expect(recovered.summary.id).not.toBe(strandedId)
    expect(recovered.exercises).toHaveLength(1)
    expect(recovered.exercises[0]?.progress.presentationCount).toBe(0)
    expect((await getStudySessionSummary(client, strandedId))?.status).toBe("completed")
  })

  test("reports caught up rather than looping when a retired session has no replacement", async () => {
    const stranded = await createSession(1)
    const strandedId = stranded.summary.id!
    await client.execute({
      sql: "UPDATE song_study_session_exercise SET presentation_count = 3 WHERE session_id = ?1",
      args: [strandedId],
    })

    const recovered = await ensureStudySession({
      available: [],
      candidates: [],
      client,
      communityId: "cmt_1",
      dueCount: 0,
      now: "2026-07-20T10:05:00.000Z",
      postId: "pst_1",
      targetLanguage: "en",
      totalUnits: 1,
      userId: "usr_1",
    })

    expect(recovered.summary.status).toBe("caught_up")
    expect(recovered.exercises).toEqual([])
    expect((await getStudySessionSummary(client, strandedId))?.status).toBe("completed")
  })

  test("expires stale sessions and creates a fresh server-owned set", async () => {
    const first = await createSession(2, "2026-07-20T10:00:00.000Z")
    const second = await createSession(2, "2026-07-21T10:00:01.000Z")
    expect(second.summary.id).not.toBe(first.summary.id)
    await expect(requireStudySessionForAttempt({
      attemptNumber: 1,
      client,
      exerciseId: "ex_0",
      now: "2026-07-21T10:00:01.000Z",
      postId: "pst_1",
      sessionId: first.summary.id!,
      userId: "usr_1",
    })).rejects.toMatchObject({ status: 404 })
  })
})
