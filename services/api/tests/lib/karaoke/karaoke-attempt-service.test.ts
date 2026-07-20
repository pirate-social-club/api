import { describe, expect, test } from "bun:test"
import { createClient } from "@libsql/client"
import { KARAOKE_SCORING_VERSION } from "@pirate-social-club/karaoke-runtime"

import { karaokeAttemptServiceTestHooks, recordKaraokeAttempt } from "../../../src/lib/karaoke/karaoke-attempt-service"
import type { InStatement, QueryResult, ReadClient } from "../../../src/lib/sql-client"

async function createKaraokeAttemptSchema(client: ReturnType<typeof createClient>): Promise<void> {
  await client.execute(`
    CREATE TABLE karaoke_attempt (
      id TEXT NOT NULL PRIMARY KEY,
      session_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      post_id TEXT NOT NULL,
      community_id TEXT NOT NULL,
      karaoke_revision_id TEXT NOT NULL,
      scoring_version INTEGER NOT NULL,
      scoring_provider TEXT NOT NULL,
      scoring_model TEXT NOT NULL,
      final_score INTEGER NOT NULL,
      lyrics_score INTEGER NOT NULL,
      timing_score INTEGER,
      timing_trend TEXT NOT NULL CHECK (
        timing_trend IN ('early', 'late', 'mixed', 'on_time')
      ),
      scored_line_count INTEGER NOT NULL,
      line_count INTEGER NOT NULL,
      uncertain_line_count INTEGER NOT NULL,
      no_recognition_line_count INTEGER NOT NULL,
      low_confidence_line_count INTEGER NOT NULL,
      completion_reason TEXT NOT NULL CHECK (
        completion_reason IN ('completed', 'session_error', 'provider_unavailable', 'abandoned')
      ),
      rank_eligible INTEGER NOT NULL CHECK (rank_eligible IN (0, 1)),
      activity_date TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(session_id, attempt_id)
    )
  `)
}

async function createSongStreakSchema(client: ReturnType<typeof createClient>): Promise<void> {
  await client.execute(`
    CREATE TABLE song_engagement_days (
      user_id TEXT NOT NULL,
      post_id TEXT NOT NULL,
      community_id TEXT NOT NULL,
      activity_date TEXT NOT NULL,
      study_attempt_count INTEGER NOT NULL DEFAULT 0,
      study_correct_count INTEGER NOT NULL DEFAULT 0,
      study_target_count INTEGER NOT NULL DEFAULT 10,
      karaoke_pass_count INTEGER NOT NULL DEFAULT 0,
      qualified INTEGER NOT NULL DEFAULT 0 CHECK (qualified IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, post_id, activity_date)
    )
  `)
  await client.execute(`
    CREATE TABLE song_streaks (
      user_id TEXT NOT NULL,
      post_id TEXT NOT NULL,
      community_id TEXT NOT NULL,
      current_streak INTEGER NOT NULL,
      best_streak INTEGER NOT NULL,
      last_qualified_date TEXT NOT NULL,
      streak_started_date TEXT NOT NULL,
      total_qualified_days INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, post_id)
    )
  `)
}

function passingSummary() {
  return {
    confidenceMean: 0.95,
    finalScore: 0.92,
    lineCount: 10,
    lowConfidenceLineCount: 0,
    lyricsScore: 0.9,
    missedWords: [],
    noRecognitionLineCount: 0,
    phoneticUnavailableLineCount: 0,
    scoredLineCount: 10,
    strongestLines: [],
    timingScore: 0.88,
    timingTrend: "on_time" as const,
    uncertainLineCount: 0,
    weakestLines: [],
  }
}

describe("karaoke attempt leaderboard ranking", () => {
  test("excludes banned community members before ranking", async () => {
    const client = createClient({ url: ":memory:" })
    try {
      await client.execute(`
        CREATE TABLE karaoke_attempt (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          post_id TEXT NOT NULL,
          community_id TEXT NOT NULL,
          karaoke_revision_id TEXT NOT NULL,
          scoring_version INTEGER NOT NULL,
          scoring_provider TEXT NOT NULL,
          scoring_model TEXT NOT NULL,
          final_score INTEGER NOT NULL,
          completed_at TEXT NOT NULL,
          rank_eligible INTEGER NOT NULL
        )
      `)
      await client.execute(`
        CREATE TABLE community_memberships (
          membership_id TEXT PRIMARY KEY,
          community_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          status TEXT NOT NULL
        )
      `)
      await client.batch([
        {
          sql: `
            INSERT INTO community_memberships (membership_id, community_id, user_id, status)
            VALUES
              ('mbr_banned', 'cmt_karaoke', 'usr_banned', 'banned'),
              ('mbr_viewer', 'cmt_karaoke', 'usr_viewer', 'member'),
              ('mbr_peer', 'cmt_karaoke', 'usr_peer', 'member')
          `,
          args: [],
        },
        {
          sql: `
            INSERT INTO karaoke_attempt (
              id, user_id, post_id, community_id, karaoke_revision_id,
              scoring_version, scoring_provider, scoring_model,
              final_score, completed_at, rank_eligible
            )
            VALUES
              ('kat_banned', 'usr_banned', 'pst_song', 'cmt_karaoke', 'krv_current',
                ?1, 'pirate-karaoke-runtime', 'text-timing-v1', 9900, '2026-07-08T08:00:00.000Z', 1),
              ('kat_viewer', 'usr_viewer', 'pst_song', 'cmt_karaoke', 'krv_current',
                ?1, 'pirate-karaoke-runtime', 'text-timing-v1', 9100, '2026-07-08T08:05:00.000Z', 1),
              ('kat_viewer_old', 'usr_viewer', 'pst_song', 'cmt_karaoke', 'krv_current',
                ?1, 'pirate-karaoke-runtime', 'text-timing-v1', 8500, '2026-07-08T08:01:00.000Z', 1),
              ('kat_peer', 'usr_peer', 'pst_song', 'cmt_karaoke', 'krv_current',
                ?1, 'pirate-karaoke-runtime', 'text-timing-v1', 8800, '2026-07-08T08:10:00.000Z', 1)
          `,
          args: [KARAOKE_SCORING_VERSION],
        },
      ])

      const result = await client.execute({
        sql: `
          ${karaokeAttemptServiceTestHooks.karaokeLeaderboardRankedCte()}
          SELECT user_id, final_score, rank, total_ranked
          FROM ranked
          ORDER BY rank ASC, completed_at ASC, user_id ASC
        `,
        args: [
          "pst_song",
          "krv_current",
          KARAOKE_SCORING_VERSION,
          "pirate-karaoke-runtime",
          "text-timing-v1",
        ],
      })

      expect(result.rows).toEqual([
        { user_id: "usr_viewer", final_score: 9100, rank: 1, total_ranked: 2 },
        { user_id: "usr_peer", final_score: 8800, rank: 2, total_ranked: 2 },
      ])
    } finally {
      client.close()
    }
  })
})

describe("recordKaraokeAttempt streak persistence", () => {
  test("buffers the full D1 write unit after an authoritative absence check", async () => {
    const client = createClient({ url: ":memory:" })
    try {
      await createKaraokeAttemptSchema(client)
      await createSongStreakSchema(client)
      await client.execute(`
        CREATE TABLE posts (
          post_id TEXT PRIMARY KEY,
          song_artifact_bundle_id TEXT
        )
      `)
      await client.execute(`
        INSERT INTO posts (post_id, song_artifact_bundle_id)
        VALUES ('pst_song', 'sab_song')
      `)
      await client.execute(`
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
        )
      `)
      const statements: InStatement[] = []
      const bufferedD1Transaction: ReadClient = {
        async execute(statement: InStatement | string): Promise<QueryResult> {
          statements.push(typeof statement === "string" ? { sql: statement } : statement)
          return { rows: [] }
        },
        async batch(batchStatements): Promise<QueryResult[]> {
          statements.push(...batchStatements)
          return batchStatements.map(() => ({ rows: [] }))
        },
      }

      const result = await recordKaraokeAttempt({
        activityDate: "2026-07-17",
        attemptKnownAbsent: true,
        client: bufferedD1Transaction,
        communityId: "cmt_karaoke",
        completedAt: "2026-07-17T05:10:05.055Z",
        completionReason: "completed",
        karaokeRevisionId: "krv_current",
        postId: "pst_song",
        scoringModel: "scribe_v2_realtime",
        scoringProvider: "elevenlabs",
        scoringVersion: KARAOKE_SCORING_VERSION,
        sessionId: "session_buffered_d1",
        attemptId: "attempt_buffered_d1",
        emitRewardQualification: true,
        summary: passingSummary(),
        userId: "usr_karaoke",
      })

      expect(result).toEqual({ inserted: true, rankEligible: true, streakCredited: true })
      expect(statements[0]?.sql).toContain("INSERT INTO karaoke_attempt")
      expect(statements[0]?.sql).not.toContain("INSERT OR IGNORE")
      await client.batch(statements, "write")

      const day = await client.execute("SELECT karaoke_pass_count, qualified FROM song_engagement_days")
      expect(day.rows[0]).toEqual({ karaoke_pass_count: 1, qualified: 1 })
      const streak = await client.execute("SELECT current_streak, best_streak, total_qualified_days FROM song_streaks")
      expect(streak.rows[0]).toEqual({ current_streak: 1, best_streak: 1, total_qualified_days: 1 })
      const outbox = await client.execute("SELECT activity, qualification_policy_version FROM reward_qualification_outbox")
      expect(outbox.rows[0]).toEqual({
        activity: "karaoke",
        qualification_policy_version: "karaoke_rank_eligible_v1",
      })

      await expect(client.batch(statements, "write")).rejects.toThrow()
      const unchangedDay = await client.execute("SELECT karaoke_pass_count FROM song_engagement_days")
      expect(unchangedDay.rows[0]).toEqual({ karaoke_pass_count: 1 })
    } finally {
      client.close()
    }
  })

  test("uses returned rows when a D1 transaction omits rowsAffected", async () => {
    const client = createClient({ url: ":memory:" })
    try {
      await createKaraokeAttemptSchema(client)
      await createSongStreakSchema(client)
      const d1TransactionLikeClient: ReadClient = {
        async execute(statement: InStatement | string): Promise<QueryResult> {
          const result = await client.execute(statement)
          const sql = typeof statement === "string" ? statement : statement.sql
          return sql.includes("INSERT OR IGNORE INTO karaoke_attempt")
            ? { ...result, rowsAffected: undefined }
            : result
        },
        batch: (statements, mode) => client.batch(statements, mode),
      }

      const result = await recordKaraokeAttempt({
        activityDate: "2026-07-17",
        client: d1TransactionLikeClient,
        communityId: "cmt_karaoke",
        completedAt: "2026-07-17T05:10:05.055Z",
        completionReason: "completed",
        karaokeRevisionId: "krv_current",
        postId: "pst_song",
        scoringModel: "scribe_v2_realtime",
        scoringProvider: "elevenlabs",
        scoringVersion: KARAOKE_SCORING_VERSION,
        sessionId: "session_d1",
        attemptId: "attempt_d1",
        summary: passingSummary(),
        userId: "usr_karaoke",
      })

      expect(result).toEqual({ inserted: true, rankEligible: true, streakCredited: true })
      const day = await client.execute("SELECT karaoke_pass_count, qualified FROM song_engagement_days")
      expect(day.rows[0]).toEqual({ karaoke_pass_count: 1, qualified: 1 })
    } finally {
      client.close()
    }
  })

  test("recomputes a bridged streak when a delayed passing karaoke attempt lands", async () => {
    const client = createClient({ url: ":memory:" })
    try {
      await createKaraokeAttemptSchema(client)
      await createSongStreakSchema(client)
      await client.batch([
        {
          sql: `
            INSERT INTO song_engagement_days (
              user_id, post_id, community_id, activity_date,
              study_attempt_count, study_correct_count, study_target_count,
              karaoke_pass_count, qualified, created_at, updated_at
            )
            VALUES
              ('usr_karaoke', 'pst_song', 'cmt_karaoke', '2026-07-09', 10, 10, 10, 0, 1, '2026-07-09T10:00:00.000Z', '2026-07-09T10:00:00.000Z'),
              ('usr_karaoke', 'pst_song', 'cmt_karaoke', '2026-07-11', 10, 10, 10, 0, 1, '2026-07-11T10:00:00.000Z', '2026-07-11T10:00:00.000Z')
          `,
          args: [],
        },
        {
          sql: `
            INSERT INTO song_streaks (
              user_id, post_id, community_id, current_streak, best_streak,
              last_qualified_date, streak_started_date, total_qualified_days, created_at, updated_at
            )
            VALUES ('usr_karaoke', 'pst_song', 'cmt_karaoke', 1, 1, '2026-07-11', '2026-07-11', 2, '2026-07-11T10:00:00.000Z', '2026-07-11T10:00:00.000Z')
          `,
          args: [],
        },
      ])

      const result = await recordKaraokeAttempt({
        activityDate: "2026-07-10",
        client,
        communityId: "cmt_karaoke",
        completedAt: "2026-07-10T23:58:00.000Z",
        completionReason: "completed",
        karaokeRevisionId: "krv_current",
        postId: "pst_song",
        scoringModel: "text-timing-v1",
        scoringProvider: "pirate-karaoke-runtime",
        scoringVersion: KARAOKE_SCORING_VERSION,
        sessionId: "session_bridge",
        attemptId: "attempt_bridge",
        summary: passingSummary(),
        userId: "usr_karaoke",
      })

      expect(result).toEqual({
        inserted: true,
        rankEligible: true,
        streakCredited: true,
      })
      const streak = await client.execute("SELECT current_streak, best_streak, last_qualified_date, streak_started_date, total_qualified_days FROM song_streaks")
      expect(streak.rows[0]).toEqual({
        current_streak: 3,
        best_streak: 3,
        last_qualified_date: "2026-07-11",
        streak_started_date: "2026-07-09",
        total_qualified_days: 3,
      })
      const day = await client.execute("SELECT karaoke_pass_count, qualified FROM song_engagement_days WHERE activity_date = '2026-07-10'")
      expect(day.rows[0]).toEqual({ karaoke_pass_count: 1, qualified: 1 })

      const replay = await recordKaraokeAttempt({
        activityDate: "2026-07-10",
        client,
        communityId: "cmt_karaoke",
        completedAt: "2026-07-10T23:58:00.000Z",
        completionReason: "completed",
        karaokeRevisionId: "krv_current",
        postId: "pst_song",
        scoringModel: "text-timing-v1",
        scoringProvider: "pirate-karaoke-runtime",
        scoringVersion: KARAOKE_SCORING_VERSION,
        sessionId: "session_bridge",
        attemptId: "attempt_bridge",
        summary: passingSummary(),
        userId: "usr_karaoke",
      })
      expect(replay.inserted).toBe(false)
      const replayDay = await client.execute("SELECT karaoke_pass_count FROM song_engagement_days WHERE activity_date = '2026-07-10'")
      expect(replayDay.rows[0]).toEqual({ karaoke_pass_count: 1 })
    } finally {
      client.close()
    }
  })
})
