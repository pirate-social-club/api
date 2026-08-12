import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createClient, type Client } from "@libsql/client"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

async function migration(name: string): Promise<string> {
  return await readFile(fileURLToPath(new URL(
    `../../../test-fixtures/db/community-template/migrations/${name}`,
    import.meta.url,
  )), "utf8")
}

describe("1151 song study orchestration v2 migration", () => {
  let client: Client

  beforeEach(async () => {
    client = createClient({ url: ":memory:" })
    await client.executeMultiple(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE communities (community_id TEXT PRIMARY KEY);
      CREATE TABLE posts (post_id TEXT PRIMARY KEY);
      CREATE TABLE song_study_attempt (
        id TEXT PRIMARY KEY, user_id TEXT, exercise_id TEXT
      );
      INSERT INTO communities VALUES ('cmt_1');
      INSERT INTO posts VALUES ('pst_1');
    `)
    await client.executeMultiple(await migration("1142_song_study_sessions.sql"))
  })

  afterEach(() => client.close())

  test("preserves and safely backfills an active mid-lesson session", async () => {
    await client.executeMultiple(`
      INSERT INTO song_study_session (
        id, user_id, post_id, community_id, target_language, status,
        exercise_count, required_correct_count, max_presentations,
        presentation_count, completed_exercise_count, first_pass_correct_count,
        mastered_exercise_count, qualified, created_at, expires_at, updated_at
      ) VALUES (
        'sts_active', 'usr_1', 'pst_1', 'cmt_1', 'ru', 'active',
        3, 3, 9, 2, 2, 1, 1, 0,
        '2026-08-06T00:00:00Z', '2026-08-07T00:00:00Z', '2026-08-06T00:02:00Z'
      );
      INSERT INTO song_study_session_exercise VALUES
        ('sts_active', 'ex_mastered', 0, 1, 'correct', 'correct', 1, '2026-08-06T00:00:00Z', '2026-08-06T00:01:00Z'),
        ('sts_active', 'ex_missed', 1, 1, 'incorrect', 'incorrect', 0, '2026-08-06T00:00:00Z', '2026-08-06T00:02:00Z'),
        ('sts_active', 'ex_unseen', 2, 0, NULL, NULL, 0, '2026-08-06T00:00:00Z', '2026-08-06T00:00:00Z');
    `)

    await client.executeMultiple(await migration("1151_song_study_orchestration_v2.sql"))

    const session = (await client.execute("SELECT * FROM song_study_session WHERE id = 'sts_active'")).rows[0]!
    expect(session.session_revision).toBe(0)
    expect(session.current_exercise_id).toBeNull()
    expect(session.completion_reason).toBeNull()

    const exercises = (await client.execute(`
      SELECT exercise_id, lesson_resolved, last_served_index,
             appearance_ordinal, appearance_attempt_count, qualifies_for_reward
      FROM song_study_session_exercise
      WHERE session_id = 'sts_active' ORDER BY ordinal
    `)).rows
    expect(exercises).toEqual([
      {
        appearance_attempt_count: 0, appearance_ordinal: 0, exercise_id: "ex_mastered",
        last_served_index: 2, lesson_resolved: 1, qualifies_for_reward: 1,
      },
      {
        appearance_attempt_count: 0, appearance_ordinal: 0, exercise_id: "ex_missed",
        last_served_index: 2, lesson_resolved: 0, qualifies_for_reward: 1,
      },
      {
        appearance_attempt_count: 0, appearance_ordinal: 0, exercise_id: "ex_unseen",
        last_served_index: 0, lesson_resolved: 0, qualifies_for_reward: 1,
      },
    ])
    // Conservative last_served_index=2 means the missed card cannot become
    // eligible before three additional graded presentations.
    expect(2 - Number(exercises[1]?.last_served_index)).toBe(0)
  })

  test("requires commit ownership and enforces one ungradable receipt per appearance", async () => {
    await client.executeMultiple(`
      INSERT INTO song_study_session (
        id, user_id, post_id, community_id, target_language, status,
        exercise_count, required_correct_count, max_presentations,
        created_at, expires_at, updated_at
      ) VALUES ('sts_1', 'usr_1', 'pst_1', 'cmt_1', 'ru', 'active', 1, 1, 3,
        '2026-08-06T00:00:00Z', '2026-08-07T00:00:00Z', '2026-08-06T00:00:00Z');
      INSERT INTO song_study_session_exercise (
        session_id, exercise_id, ordinal, created_at, updated_at
      ) VALUES ('sts_1', 'ex_1', 0, '2026-08-06T00:00:00Z', '2026-08-06T00:00:00Z');
    `)
    await client.executeMultiple(await migration("1151_song_study_orchestration_v2.sql"))

    await expect(client.execute({
      sql: `INSERT INTO song_study_attempt_response (
        user_id,idempotency_key,session_id,exercise_id,request_fingerprint,
        response_json,http_status,result_kind,created_at
      ) VALUES ('usr_1','key_1','sts_1','ex_1','fp','{}',200,'graded','now')`,
    })).rejects.toThrow(/commit_token/)

    await client.execute(`
      INSERT INTO song_study_ungradable_receipt
      VALUES ('sts_1','ex_1',0,'usr_1','voice_1','now')
    `)
    await expect(client.execute(`
      INSERT INTO song_study_ungradable_receipt
      VALUES ('sts_1','ex_1',0,'usr_1','voice_2','later')
    `)).rejects.toThrow(/UNIQUE constraint failed/)
  })
})
