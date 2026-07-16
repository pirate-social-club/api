import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createClient, type Client as LibsqlClient } from "@libsql/client"
import { isWriteAllowedStatement } from "@pirate/api-shared"
import type { InStatement, QueryResult } from "../sql-client"
import { emitKaraokeQualification, emitStudyQualificationIfComplete } from "./reward-qualification-outbox"

describe("reward qualification outbox", () => {
  let client: LibsqlClient

  beforeEach(async () => {
    client = createClient({ url: ":memory:" })
    await client.executeMultiple(`
      CREATE TABLE posts (post_id TEXT PRIMARY KEY, song_artifact_bundle_id TEXT);
      CREATE TABLE song_study_attempt (
        id TEXT PRIMARY KEY, user_id TEXT, post_id TEXT, exercise_id TEXT, created_at TEXT
      );
      CREATE TABLE reward_qualification_outbox (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL,
        community_id TEXT NOT NULL,
        post_id TEXT NOT NULL,
        song_artifact_bundle_id TEXT NOT NULL,
        activity TEXT NOT NULL,
        qualified_at TEXT NOT NULL,
        reward_period_key TEXT NOT NULL,
        qualification_policy_version TEXT NOT NULL,
        evidence_summary_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (user_id, post_id, activity, reward_period_key)
      );
      INSERT INTO posts VALUES ('pst_reward', 'sab_reward');
    `)
  })

  afterEach(() => client.close())

  test("emits Study only after the server target has distinct exercises", async () => {
    await client.execute("INSERT INTO song_study_attempt VALUES ('a1', 'usr_1', 'pst_reward', 'ex_1', '2026-07-10T23:55:00.000Z')")
    expect(await emitStudyQualificationIfComplete({
      client, communityId: "cmt_1", now: "2026-07-10T23:55:00.000Z",
      postId: "pst_reward", targetCount: 2, userId: "usr_1",
    })).toBe(false)
    await client.execute("INSERT INTO song_study_attempt VALUES ('a2', 'usr_1', 'pst_reward', 'ex_2', '2026-07-10T23:59:00.000Z')")
    expect(await emitStudyQualificationIfComplete({
      client, communityId: "cmt_1", now: "2026-07-10T23:59:00.000Z",
      postId: "pst_reward", targetCount: 2, userId: "usr_1",
    })).toBe(true)
    expect(await emitStudyQualificationIfComplete({
      client, communityId: "cmt_1", now: "2026-07-10T23:59:30.000Z",
      postId: "pst_reward", targetCount: 2, userId: "usr_1",
    })).toBe(false)
    const rows = await client.execute("SELECT activity, reward_period_key, qualification_policy_version, evidence_summary_json FROM reward_qualification_outbox")
    expect(rows.rows).toEqual([{
      activity: "study",
      reward_period_key: "2026-07-10",
      qualification_policy_version: "study_completed_distinct_set_v1",
      evidence_summary_json: JSON.stringify({ completed_exercises: 2, target_exercises: 2 }),
    }])
  })

  test("emits one Karaoke qualification per UTC period", async () => {
    const input = {
      attemptId: "att_1", client, communityId: "cmt_1", finalScoreBps: 8100,
      karaokeRevisionId: "kar_1", now: "2026-07-10T23:59:59.000Z", postId: "pst_reward",
      scoringVersion: 3, sessionId: "ses_1", userId: "usr_1",
    }
    expect(await emitKaraokeQualification(input)).toBe(true)
    expect(await emitKaraokeQualification({ ...input, attemptId: "att_2" })).toBe(false)
    expect(await emitKaraokeQualification({ ...input, attemptId: "att_3", now: "2026-07-11T00:00:01.000Z" })).toBe(true)
    const rows = await client.execute("SELECT sequence, reward_period_key FROM reward_qualification_outbox ORDER BY sequence")
    expect(rows.rows).toEqual([
      { sequence: 1, reward_period_key: "2026-07-10" },
      { sequence: 3, reward_period_key: "2026-07-11" },
    ])
  })

  test("emits Study and Karaoke using statements accepted by the shard write guard", async () => {
    const guarded = {
      async execute(statement: InStatement | string): Promise<QueryResult> {
        const sql = typeof statement === "string" ? statement : statement.sql
        if (!isWriteAllowedStatement(sql)) throw new Error(`Statement rejected by shard write guard: ${sql}`)
        return await client.execute(statement as Parameters<LibsqlClient["execute"]>[0]) as unknown as QueryResult
      },
    }
    await client.execute("INSERT INTO song_study_attempt VALUES ('guard_a1', 'usr_guard', 'pst_reward', 'ex_1', '2026-07-10T23:55:00.000Z')")
    expect(await emitStudyQualificationIfComplete({
      client: guarded, communityId: "cmt_1", now: "2026-07-10T23:55:00.000Z",
      postId: "pst_reward", targetCount: 1, userId: "usr_guard",
    })).toBe(true)
    expect(await emitKaraokeQualification({
      attemptId: "att_guard", client: guarded, communityId: "cmt_1", finalScoreBps: 8100,
      karaokeRevisionId: "kar_guard", now: "2026-07-10T23:59:59.000Z", postId: "pst_reward",
      scoringVersion: 3, sessionId: "ses_guard", userId: "usr_guard",
    })).toBe(true)
  })
})
