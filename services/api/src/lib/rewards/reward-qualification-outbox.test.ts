import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createClient, type Client as LibsqlClient } from "@libsql/client"
import {
  isWriteAllowedStatement,
  type ShardQueryResult,
  type ShardResult,
  type ShardRpc,
  type ShardSqlStatement,
} from "@pirate/api-shared"
import { makeCommunityD1Client } from "../communities/community-d1-client"
import type { ResolvedCommunityBinding } from "../communities/community-binding-resolver"
import type { InStatement, QueryResult } from "../sql-client"
import { emitKaraokeQualification, emitStudyQualificationIfComplete } from "./reward-qualification-outbox"
import { isRewardQualificationOutboxCandidateCommitted } from "./reward-qualification-wakeup"

function d1Binding(): ResolvedCommunityBinding {
  return {
    communityId: "cmt_1",
    backend: "d1",
    provisioningState: "ready",
    shardWorkerId: "shard-1",
    bindingName: "DB_CMTY_1",
    region: "enam",
    decommissionedAt: null,
  } as ResolvedCommunityBinding
}

function sqlBackedShard(client: LibsqlClient, failCommit = false): ShardRpc {
  return {
    async batchWrite(input: { statements: ShardSqlStatement[] }): Promise<ShardResult<ShardQueryResult[]>> {
      if (failCommit) {
        return { ok: false, code: "shard_pool_write_conflict", message: "commit failed" }
      }
      for (const statement of input.statements) {
        await client.execute({ sql: statement.sql, args: (statement.args ?? []) as never[] })
      }
      return { ok: true, value: input.statements.map(() => ({ rows: [] })) }
    },
  } as unknown as ShardRpc
}

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

  test("emits Study only for a completed server session meeting first-pass correctness", async () => {
    expect(await emitStudyQualificationIfComplete({
      client, communityId: "cmt_1", now: "2026-07-10T23:55:00.000Z",
      postId: "pst_reward", completedExerciseCount: 10, firstPassCorrectCount: 6,
      requiredCorrectCount: 7, sessionId: "sts_1", userId: "usr_1",
    })).toBeNull()
    const emitted = await emitStudyQualificationIfComplete({
      client, communityId: "cmt_1", now: "2026-07-10T23:59:00.000Z",
      postId: "pst_reward", completedExerciseCount: 10, firstPassCorrectCount: 7,
      requiredCorrectCount: 7, sessionId: "sts_1", userId: "usr_1",
    })
    expect(emitted).toMatchObject({
      activity: "study",
      communityId: "cmt_1",
      qualifiedAt: "2026-07-10T23:59:00.000Z",
    })
    expect(emitted?.eventId).toStartWith("rqo_")
    const replayCandidate = await emitStudyQualificationIfComplete({
      client, communityId: "cmt_1", now: "2026-07-10T23:59:30.000Z",
      postId: "pst_reward", completedExerciseCount: 10, firstPassCorrectCount: 7,
      requiredCorrectCount: 7, sessionId: "sts_1", userId: "usr_1",
    })
    expect(replayCandidate?.eventId).not.toBe(emitted?.eventId)
    const rows = await client.execute("SELECT event_id, activity, reward_period_key, qualification_policy_version, evidence_summary_json FROM reward_qualification_outbox")
    expect(rows.rows).toEqual([{
      event_id: emitted?.eventId,
      activity: "study",
      reward_period_key: "2026-07-10",
      qualification_policy_version: "study_session_first_pass_v2",
      evidence_summary_json: JSON.stringify({
        study_session_id: "sts_1", completed_exercises: 10,
        first_pass_correct: 7, required_correct: 7,
      }),
    }])
  })

  test("emits one Karaoke qualification per UTC period", async () => {
    const input = {
      attemptId: "att_1", client, communityId: "cmt_1", finalScoreBps: 8100,
      karaokeRevisionId: "kar_1", now: "2026-07-10T23:59:59.000Z", postId: "pst_reward",
      scoringVersion: 3, sessionId: "ses_1", userId: "usr_1",
    }
    const first = await emitKaraokeQualification(input)
    expect(first).toMatchObject({ activity: "karaoke", communityId: "cmt_1" })
    const replay = await emitKaraokeQualification({ ...input, attemptId: "att_2" })
    expect(replay?.eventId).not.toBe(first?.eventId)
    expect(await emitKaraokeQualification({ ...input, attemptId: "att_3", now: "2026-07-11T00:00:01.000Z" }))
      .toMatchObject({ activity: "karaoke", communityId: "cmt_1" })
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
    expect(await emitStudyQualificationIfComplete({
      client: guarded, communityId: "cmt_1", now: "2026-07-10T23:55:00.000Z",
      postId: "pst_reward", completedExerciseCount: 1, firstPassCorrectCount: 1,
      requiredCorrectCount: 1, sessionId: "sts_guard", userId: "usr_guard",
    })).not.toBeNull()
    expect(await emitKaraokeQualification({
      attemptId: "att_guard", client: guarded, communityId: "cmt_1", finalScoreBps: 8100,
      karaokeRevisionId: "kar_guard", now: "2026-07-10T23:59:59.000Z", postId: "pst_reward",
      scoringVersion: 3, sessionId: "ses_guard", userId: "usr_guard",
    })).not.toBeNull()
  })

  test("confirms only the candidate that won after a buffered D1 commit", async () => {
    const routed = makeCommunityD1Client(sqlBackedShard(client), d1Binding())
    const firstTx = await routed.transaction("write")
    const first = await emitStudyQualificationIfComplete({
      client: firstTx, communityId: "cmt_1", now: "2026-07-10T23:59:00.000Z",
      postId: "pst_reward", completedExerciseCount: 10, firstPassCorrectCount: 7,
      requiredCorrectCount: 7, sessionId: "sts_1", userId: "usr_1",
    })
    expect(first).not.toBeNull()
    expect((await client.execute("SELECT 1 FROM reward_qualification_outbox")).rows).toHaveLength(0)
    await firstTx.commit()
    expect(await isRewardQualificationOutboxCandidateCommitted({ client, event: first! })).toBe(true)

    const replayTx = await routed.transaction("write")
    const replay = await emitStudyQualificationIfComplete({
      client: replayTx, communityId: "cmt_1", now: "2026-07-10T23:59:30.000Z",
      postId: "pst_reward", completedExerciseCount: 10, firstPassCorrectCount: 7,
      requiredCorrectCount: 7, sessionId: "sts_1", userId: "usr_1",
    })
    await replayTx.commit()
    expect(replay?.eventId).not.toBe(first?.eventId)
    expect(await isRewardQualificationOutboxCandidateCommitted({ client, event: replay! })).toBe(false)
    expect(await isRewardQualificationOutboxCandidateCommitted({ client, event: first! })).toBe(true)
  })

  test("does not reach post-commit scheduling when a buffered D1 commit fails", async () => {
    const routed = makeCommunityD1Client(sqlBackedShard(client, true), d1Binding())
    const tx = await routed.transaction("write")
    const candidate = await emitStudyQualificationIfComplete({
      client: tx, communityId: "cmt_1", now: "2026-07-10T23:59:00.000Z",
      postId: "pst_reward", completedExerciseCount: 10, firstPassCorrectCount: 7,
      requiredCorrectCount: 7, sessionId: "sts_1", userId: "usr_1",
    })
    let scheduled = false
    await expect((async () => {
      await tx.commit()
      if (candidate) scheduled = true
    })()).rejects.toThrow("commit failed")
    expect(scheduled).toBe(false)
  })
})
