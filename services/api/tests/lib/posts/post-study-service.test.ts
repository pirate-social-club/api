import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createClient, type Client } from "@libsql/client"
import {
  isWriteAllowedStatement,
  type ShardQueryResult,
  type ShardResult,
  type ShardRpc,
  type ShardSqlStatement,
} from "@pirate/api-shared"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { ActorContext } from "../../../src/lib/auth-middleware"
import { buildLocalCommunityDbUrl, ensureCommunityDbSchema } from "../../../src/lib/communities/community-local-db"
import type { CommunityDatabaseBindingRepository } from "../../../src/lib/communities/community-repository-types"
import {
  clearActiveCommunityElevenLabsCredentialPresenceCacheForTests,
  getCommunityElevenLabsStudyCapability,
} from "../../../src/lib/communities/assistant-policy/credential-service"
import { runCommunityJob } from "../../../src/lib/communities/jobs/handlers"
import { hydrateSongStreakSummariesForResponses } from "../../../src/lib/posts/post-read-response"
import {
  getPostStreakLeaderboard,
  getPostStreakSummary,
  getPostStudyPayload,
  resolvePostStudyCapability,
  submitPostStudyAttempt as submitPostStudyAttemptRaw,
  transcribePostStudyAudio,
} from "../../../src/lib/posts/post-study-service"
import {
  addUtcDays,
  endOfGraceUtcInstant,
  studyActivityDate,
} from "../../../src/lib/posts/post-study-streak-time"
import {
  claimStreakTimezonePin,
  prepareStreakWrite,
  recordCompletedSessionStreak,
} from "../../../src/lib/posts/post-study-streak-write-service"
import { recordKaraokeAttempt } from "../../../src/lib/karaoke/karaoke-attempt-service"
import type { Env, LocalizedPostResponse } from "../../../src/types"
import { splitSqlStatements, toSqliteCompatibleStatements } from "../../../shared/sql-migration"
import { withMockedFetch } from "../../helpers"

const COMMUNITY_ID = "cmt_study"
const POST_ID = "pst_song"
const SECOND_POST_ID = "pst_song_two"
const AUTHOR_ID = "usr_author"
const LEARNER_ID = "usr_learner"
const NOW = "2026-06-29T08:00:00.000Z"

const repo: CommunityDatabaseBindingRepository = {
  async getPrimaryCommunityDatabaseBinding() {
    return null
  },
}

const learnerActor: ActorContext = { authType: "user", userId: LEARNER_ID }
const authorActor: ActorContext = { authType: "user", userId: AUTHOR_ID }
const profileRepository = {
  async getProfileByUserId(userId: string) {
    return (await this.listProfilesByUserIds([userId])).get(userId) ?? null
  },
  async listProfilesByUserIds(userIds: string[]) {
    return new Map(userIds.map((userId) => [userId, {
      avatar_ref: userId === LEARNER_ID ? "ipfs://learner-avatar" : null,
      display_name: userId === LEARNER_ID ? "Learner" : "Peer",
      global_handle: { label: userId === LEARNER_ID ? "learner" : "peer" },
      primary_public_handle: null,
    } as never]))
  },
  async resolvePublicProfileByHandle() {
    return null
  },
  async resolvePublicProfileByWalletAddress() {
    return null
  },
  async updateXmtpInboxId() {
    return null
  },
  async updateProfile() {
    return null
  },
  async renameGlobalHandle() {
    return null
  },
  async claimRedditGlobalHandle() {
    return null
  },
  async quoteGlobalHandleUpgrade() {
    return null
  },
  async claimPaidGlobalHandle() {
    return null
  },
  async syncLinkedHandles() {
    return null
  },
  async setPrimaryPublicHandle() {
    return null
  },
}

let rootDir: string | null = null
let client: Client | null = null
let controlClient: Client | null = null
let observedBatchWriteSql: string[] = []
let beforeNextStudyResponseBatch: (() => Promise<void>) | null = null

function env(overrides: Partial<Env> = {}): Env {
  if (!rootDir) throw new Error("test root not initialized")
  return {
    COMMUNITY_D1_SHARD: makeLocalCommunityShard() as never,
    COMMUNITY_D1_SHARD_ROUTES: '{"test-shard":"COMMUNITY_D1_SHARD"}',
    CONTROL_PLANE_DATABASE_URL: `file:${join(rootDir, "control-plane.db")}`,
    ENVIRONMENT: "test",
    LOCAL_COMMUNITY_DB_ROOT: rootDir,
    ...overrides,
  } as Env
}

// Env without the D1 shard stub: openCommunityWriteClient then takes the local
// community-db path, whose write transactions are interactive libsql
// transactions (mid-transaction reads see prior writes). The D1 shard path
// buffers write txs and returns empty results for in-tx reads.
function localEnv(overrides: Partial<Env> = {}): Env {
  const {
    COMMUNITY_D1_SHARD: _shard,
    COMMUNITY_D1_SHARD_ROUTES: _routes,
    ...rest
  } = env(overrides)
  return rest as Env
}

async function submitPostStudyAttempt(
  input: Omit<Parameters<typeof submitPostStudyAttemptRaw>[0], "body"> & {
    body: Parameters<typeof submitPostStudyAttemptRaw>[0]["body"] & { test_target_language?: unknown }
  },
): ReturnType<typeof submitPostStudyAttemptRaw> {
  const requestedTarget = typeof input.body.test_target_language === "string"
    ? input.body.test_target_language
    : /:translation_choice:([^:]+)$/u.exec(String(input.body.exercise_id ?? ""))?.[1] ?? "en"
  const payload = await getPostStudyPayload({
    actor: input.actor,
    communityId: input.communityId,
    communityRepository: input.communityRepository,
    env: input.env,
    postId: input.postId,
    targetLanguage: requestedTarget,
  })
  const sessionId = payload.session?.id
  if (!sessionId) throw new Error("test setup did not produce an active study session")
  const { test_target_language: _testTarget, ...body } = input.body
  return submitPostStudyAttemptRaw({
    ...input,
    body: { ...body, session_id: sessionId },
  })
}

// Runs the full seeded ready-pack session with every first pass correct, so
// the completing attempt qualifies the day and materializes the streak inline.
async function completeQualifyingStudySession(input: {
  env: Env
  idempotencyPrefix: string
  timezone?: string
}): Promise<void> {
  const attempts = [
    {
      exercise_id: "stu:stu_1:say_it_back:en",
      transcript: "I was lost in the midnight waves",
      type: "say_it_back" as const,
    },
    {
      exercise_id: "stu:stu_2:translation_choice:es",
      selected_option_id: "opt_a",
      type: "translation_choice" as const,
    },
    {
      exercise_id: "stu:stu_2:say_it_back:en",
      transcript: "Hold me close until the morning",
      type: "say_it_back" as const,
    },
  ]
  for (const [index, attempt] of attempts.entries()) {
    await submitPostStudyAttempt({
      actor: learnerActor,
      body: {
        attempt_number: 1,
        idempotency_key: `${input.idempotencyPrefix}-${index}`,
        test_target_language: "es",
        timezone: input.timezone,
        ...attempt,
      },
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: input.env,
      postId: POST_ID,
    })
  }
}

// Runs the full seeded ready-pack session without a single correct answer.
// The session only completes once every card is exhausted (3 presentations
// each), which is what an unqualified completion looks like. Returns the
// final (completing) attempt result.
async function completeUnqualifiedStudySession(input: {
  env: Env
  idempotencyPrefix: string
}): Promise<Awaited<ReturnType<typeof submitPostStudyAttempt>>> {
  const cards = [
    { exercise_id: "stu:stu_1:say_it_back:en", transcript: "totally different words", type: "say_it_back" as const },
    { exercise_id: "stu:stu_2:translation_choice:es", selected_option_id: "opt_b", type: "translation_choice" as const },
    { exercise_id: "stu:stu_2:say_it_back:en", transcript: "still entirely wrong", type: "say_it_back" as const },
  ]
  let lastResult: Awaited<ReturnType<typeof submitPostStudyAttempt>> | undefined
  for (const [cardIndex, card] of cards.entries()) {
    for (let attemptNumber = 1; attemptNumber <= 3; attemptNumber += 1) {
      lastResult = await submitPostStudyAttempt({
        actor: learnerActor,
        body: {
          attempt_number: attemptNumber,
          idempotency_key: `${input.idempotencyPrefix}-${cardIndex}-${attemptNumber}`,
          test_target_language: "es",
          ...card,
        },
        communityId: COMMUNITY_ID,
        communityRepository: repo,
        env: input.env,
        postId: POST_ID,
      })
    }
  }
  if (!lastResult) throw new Error("unqualified session helper ran no attempts")
  return lastResult
}

// Rank-eligible karaoke summary (mirrors the karaoke-attempt-service tests):
// high scores, fully calibrated timing, no problem lines.
function passingKaraokeSummary() {
  return {
    confidenceMean: 0.95,
    finalScore: 0.92,
    lineCount: 10,
    lineDiagnostics: [{
      confidenceScore: 0.95,
      finalizedReason: "line_end" as const,
      lineId: "line-1",
      medianSignedDeltaMs: 120,
      recognizedWordCount: 5,
      score: 0.92,
      textScore: 0.9,
      timingScore: 0.88,
    }],
    lowConfidenceLineCount: 0,
    lyricsScore: 0.9,
    missedWords: [],
    noRecognitionLineCount: 0,
    phoneticUnavailableLineCount: 0,
    scoredLineCount: 10,
    strongestLines: [],
    timingCalibration: {
      matchedWordCount: 30,
      measuredLineCount: 10,
      offsetMs: 120,
      rawOffsetMs: 120,
      reason: null,
      residualSpreadMs: 40,
      state: "calibrated" as const,
    },
    timingScore: 0.88,
    timingTrend: "on_time" as const,
    uncertainLineCount: 0,
    weakestLines: [],
  }
}

async function exec(sql: string, args: unknown[] = []): Promise<void> {
  if (!client) throw new Error("test db not initialized")
  await client.execute({ sql, args: args as never[] })
}

async function execControl(sql: string, args: unknown[] = []): Promise<void> {
  if (!controlClient) throw new Error("test control plane not initialized")
  await controlClient.execute({ sql, args: args as never[] })
}

function normalizeShardStatement(statement: ShardSqlStatement | string): { sql: string; args?: unknown[] } {
  return typeof statement === "string" ? { sql: statement } : { sql: statement.sql, args: statement.args }
}

function makeLocalCommunityShard(): ShardRpc {
  return {
    async execute(input: {
      statement: ShardSqlStatement | string
    }): Promise<ShardResult<ShardQueryResult>> {
      if (!client) throw new Error("test db not initialized")
      const statement = normalizeShardStatement(input.statement)
      return { ok: true, value: await client.execute({ sql: statement.sql, args: (statement.args ?? []) as never[] }) }
    },
    async batch(input: {
      statements: Array<ShardSqlStatement | string>
    }): Promise<ShardResult<ShardQueryResult[]>> {
      if (!client) throw new Error("test db not initialized")
      const results: ShardQueryResult[] = []
      for (const raw of input.statements) {
        const statement = normalizeShardStatement(raw)
        results.push(await client.execute({ sql: statement.sql, args: (statement.args ?? []) as never[] }))
      }
      return { ok: true, value: results }
    },
    async batchWrite(input: {
      statements: ShardSqlStatement[]
    }): Promise<ShardResult<ShardQueryResult[]>> {
      if (!client) throw new Error("test db not initialized")
      for (const statement of input.statements) {
        if (!isWriteAllowedStatement(statement.sql)) {
          return {
            ok: false,
            code: "shard_write_not_allowed",
            message: `Statement rejected by shard write guard: ${statement.sql}`,
          }
        }
      }
      if (beforeNextStudyResponseBatch
        && input.statements.some((statement) => /INSERT INTO song_study_attempt_response/iu.test(statement.sql))) {
        const hook = beforeNextStudyResponseBatch
        beforeNextStudyResponseBatch = null
        await hook()
      }
      const statements = input.statements.map((statement) => ({
        sql: statement.sql,
        args: (statement.args ?? []) as never[],
      }))
      observedBatchWriteSql.push(...statements.map((statement) => statement.sql.trim()))
      return { ok: true, value: await client.batch(statements, "write") }
    },
  } as ShardRpc
}

async function runStudyGenerationJob(input: {
  env: Env
  postId?: string
  targetLanguage?: string
}): Promise<string | null> {
  const postId = input.postId ?? POST_ID
  const targetLanguage = input.targetLanguage ?? "es"
  const storedJob = await client!.execute({
    sql: `
      SELECT job_id, attempt_count
      FROM community_jobs
      WHERE job_type = 'song_study_generate'
        AND subject_id = ?1
      ORDER BY created_at DESC, job_id DESC
      LIMIT 1
    `,
    args: [`${postId}:${targetLanguage}`],
  })
  const jobId = typeof storedJob.rows[0]?.job_id === "string" ? storedJob.rows[0].job_id : "cjb_study_test"
  const attemptCount = Number(storedJob.rows[0]?.attempt_count ?? 0)
  const result = await runCommunityJob({
    env: input.env,
    communityRepository: repo as never,
    job: {
      job_id: jobId,
      community_id: COMMUNITY_ID,
      job_type: "song_study_generate",
      subject_type: "post_study",
      subject_id: `${postId}:${targetLanguage}`,
      status: "queued",
      payload_json: JSON.stringify({
        post_id: postId,
        target_language: targetLanguage,
      }),
      result_ref: null,
      error_code: null,
      attempt_count: attemptCount,
      available_at: null,
      last_checkpoint: null,
      last_checkpoint_at: null,
      attempt_started_at: null,
      attempt_deadline_at: null,
      attempt_id: null,
      lease_expires_at: null,
      created_at: NOW,
      updated_at: NOW,
    },
  })
  // Generation tests inspect a newly generated pack. The first lazy GET may
  // already have fixed a say-it-back-only session, so end that setup session
  // before opening the post-generation lesson.
  await client!.execute({
    sql: `UPDATE song_study_session SET status = 'expired' WHERE post_id = ?1 AND target_language = ?2 AND status = 'active'`,
    args: [postId, targetLanguage],
  })
  return result
}

async function applyStudyMigration(): Promise<void> {
  if (!client) throw new Error("test db not initialized")
  const existing = await client.execute("PRAGMA table_info(song_study_unit)")
  if (existing.rows.length <= 0) {
    const path = fileURLToPath(new URL("../../../test-fixtures/db/community-template/migrations/1109_song_study.sql", import.meta.url))
    const raw = await readFile(path, "utf8")
    for (const statement of splitSqlStatements(raw)) {
      for (const sqliteStatement of toSqliteCompatibleStatements(statement)) {
        await client.execute(sqliteStatement)
      }
    }
  }

  const communityColumns = await client.execute("PRAGMA table_info(communities)")
  if (!communityColumns.rows.some((row) => String(row.name) === "study_enabled")) {
    const path = fileURLToPath(new URL("../../../test-fixtures/db/community-template/migrations/1115_community_study_enabled.sql", import.meta.url))
    const raw = await readFile(path, "utf8")
    for (const statement of splitSqlStatements(raw)) {
      for (const sqliteStatement of toSqliteCompatibleStatements(statement)) {
        await client.execute(sqliteStatement)
      }
    }
  }

  const attemptColumns = await client.execute("PRAGMA table_info(song_study_attempt)")
  const hasLegacyReviewSessionId = attemptColumns.rows.some((row) => String(row.name) === "review_session_id")
  const hasStudySessionId = attemptColumns.rows.some((row) => String(row.name) === "study_session_id")
  if (!hasLegacyReviewSessionId && !hasStudySessionId) {
    const path = fileURLToPath(new URL("../../../test-fixtures/db/community-template/migrations/1118_song_study_review_sessions.sql", import.meta.url))
    const raw = await readFile(path, "utf8")
    for (const statement of splitSqlStatements(raw)) {
      for (const sqliteStatement of toSqliteCompatibleStatements(statement)) {
        await client.execute(sqliteStatement)
      }
    }
  }

  const streakTables = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'song_engagement_days'")
  if (streakTables.rows.length <= 0) {
    const path = fileURLToPath(new URL("../../../test-fixtures/db/community-template/migrations/1119_song_streaks.sql", import.meta.url))
    const raw = await readFile(path, "utf8")
    for (const statement of splitSqlStatements(raw)) {
      for (const sqliteStatement of toSqliteCompatibleStatements(statement)) {
        await client.execute(sqliteStatement)
      }
    }
  }

  const engagementColumns = await client.execute("PRAGMA table_info(song_engagement_days)")
  if (!engagementColumns.rows.some((row) => String(row.name) === "activity_timezone")) {
    const path = fileURLToPath(new URL("../../../test-fixtures/db/community-template/migrations/1123_song_engagement_activity_timezone.sql", import.meta.url))
    const raw = await readFile(path, "utf8")
    for (const statement of splitSqlStatements(raw)) {
      for (const sqliteStatement of toSqliteCompatibleStatements(statement)) {
        await client.execute(sqliteStatement)
      }
    }
  }

  const finalAttemptColumns = await client.execute("PRAGMA table_info(song_study_attempt)")
  if (finalAttemptColumns.rows.some((row) => String(row.name) === "review_session_id")) {
    const path = fileURLToPath(new URL("../../../test-fixtures/db/community-template/migrations/1121_song_study_attempt_identity.sql", import.meta.url))
    const raw = await readFile(path, "utf8")
    for (const statement of splitSqlStatements(raw)) {
      for (const sqliteStatement of toSqliteCompatibleStatements(statement)) {
        await client.execute(sqliteStatement)
      }
    }
  }

  const communityJobColumns = await client.execute("PRAGMA table_info(community_jobs)")
  if (!communityJobColumns.rows.some((row) => String(row.name) === "attempt_id")) {
    const path = fileURLToPath(new URL("../../../test-fixtures/db/community-template/migrations/1128_community_job_attempt_leases.sql", import.meta.url))
    const raw = await readFile(path, "utf8")
    for (const statement of splitSqlStatements(raw)) {
      for (const sqliteStatement of toSqliteCompatibleStatements(statement)) {
        await client.execute(sqliteStatement)
      }
    }
  }

  const generationRunTables = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'song_study_generation_run'",
  )
  if (generationRunTables.rows.length <= 0) {
    const path = fileURLToPath(
      new URL("../../../test-fixtures/db/community-template/migrations/1131_song_study_generation_runs.sql", import.meta.url),
    )
    const raw = await readFile(path, "utf8")
    for (const statement of splitSqlStatements(raw)) {
      for (const sqliteStatement of toSqliteCompatibleStatements(statement)) {
        await client.execute(sqliteStatement)
      }
    }
  }

  const sessionTables = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'song_study_session'",
  )
  if (sessionTables.rows.length <= 0) {
    const path = fileURLToPath(
      new URL("../../../test-fixtures/db/community-template/migrations/1142_song_study_sessions.sql", import.meta.url),
    )
    const raw = await readFile(path, "utf8")
    for (const statement of splitSqlStatements(raw)) {
      for (const sqliteStatement of toSqliteCompatibleStatements(statement)) {
        await client.execute(sqliteStatement)
      }
    }
  }
  const sessionColumns = await client.execute("PRAGMA table_info(song_study_session)")
  if (!sessionColumns.rows.some((row) => String(row.name) === "session_revision")) {
    const path = fileURLToPath(
      new URL("../../../test-fixtures/db/community-template/migrations/1151_song_study_orchestration_v2.sql", import.meta.url),
    )
    const raw = await readFile(path, "utf8")
    for (const statement of splitSqlStatements(raw)) {
      for (const sqliteStatement of toSqliteCompatibleStatements(statement)) {
        await client.execute(sqliteStatement)
      }
    }
  }
}

async function seedCommunity(input: { studyEnabled?: boolean } = {}): Promise<void> {
  await exec(`
    INSERT INTO communities (
      community_id, display_name, status, artist_governance_state,
      membership_mode, default_age_gate_policy, donation_policy_mode,
      donation_partner_status, governance_mode, created_by_user_id,
      created_at, updated_at, study_enabled
    )
    VALUES (?1, 'Study Club', 'active', 'fan_run', 'open', 'none',
            'none', 'unconfigured', 'centralized', ?2, ?3, ?3, ?4)
  `, [COMMUNITY_ID, AUTHOR_ID, NOW, (input.studyEnabled ?? true) ? 1 : 0])
  await exec(`
    INSERT INTO community_memberships (
      membership_id, community_id, user_id, status, joined_at, created_at, updated_at
    )
    VALUES ('mbr_author', ?1, ?2, 'member', ?3, ?3, ?3),
           ('mbr_learner', ?1, ?4, 'member', ?3, ?3, ?3)
  `, [COMMUNITY_ID, AUTHOR_ID, NOW, LEARNER_ID])
}

async function seedSongPost(accessMode: "public" | "locked" = "public"): Promise<void> {
  await exec(`
    INSERT INTO posts (
      post_id, community_id, author_user_id, identity_mode, post_type,
      status, song_mode, title, lyrics, source_language, rights_basis,
      analysis_state, content_safety_state, age_gate_policy, created_at,
      updated_at, access_mode, asset_id, visibility, song_title, song_cover_art_ref
    )
    VALUES (?1, ?2, ?3, 'public', 'song', 'published', 'original',
            'Midnight Waves', 'I was lost in the midnight waves', 'en',
            'original', 'allow', 'safe', 'none', ?4, ?4, ?5, 'ast_song',
            'public', 'Midnight Waves', 'ipfs://cover')
  `, [POST_ID, COMMUNITY_ID, AUTHOR_ID, NOW, accessMode])
}

async function seedSecondSongPost(): Promise<void> {
  await exec(`
    INSERT INTO posts (
      post_id, community_id, author_user_id, identity_mode, post_type,
      status, song_mode, title, lyrics, source_language, rights_basis,
      analysis_state, content_safety_state, age_gate_policy, created_at,
      updated_at, access_mode, asset_id, visibility, song_title, song_cover_art_ref
    )
    VALUES (?1, ?2, ?3, 'public', 'song', 'published', 'original',
            'Morning Static', 'Static on the morning radio', 'en',
            'original', 'allow', 'safe', 'none', ?4, ?4, 'public', 'ast_song_two',
            'public', 'Morning Static', 'ipfs://cover-two')
  `, [SECOND_POST_ID, COMMUNITY_ID, AUTHOR_ID, NOW])
}

async function setStudyEnabled(enabled: boolean): Promise<void> {
  await exec("UPDATE communities SET study_enabled = ?1 WHERE community_id = ?2", [enabled ? 1 : 0, COMMUNITY_ID])
}

async function seedNonEnglishSongPost(): Promise<void> {
  await exec(`
    INSERT INTO posts (
      post_id, community_id, author_user_id, identity_mode, post_type,
      status, song_mode, title, lyrics, source_language, rights_basis,
      analysis_state, content_safety_state, age_gate_policy, created_at,
      updated_at, access_mode, asset_id, visibility, song_title, song_cover_art_ref
    )
    VALUES (?1, ?2, ?3, 'public', 'song', 'published', 'original',
            'Olas', 'perdido en olas', 'es',
            'original', 'allow', 'safe', 'none', ?4, ?4, 'public', 'ast_song',
            'public', 'Olas', 'ipfs://cover')
  `, [POST_ID, COMMUNITY_ID, AUTHOR_ID, NOW])
}

async function seedJapaneseSongPost(): Promise<void> {
  await exec(`
    INSERT INTO posts (
      post_id, community_id, author_user_id, identity_mode, post_type,
      status, song_mode, title, lyrics, source_language, rights_basis,
      analysis_state, content_safety_state, age_gate_policy, created_at,
      updated_at, access_mode, asset_id, visibility, song_title, song_cover_art_ref
    )
    VALUES (?1, ?2, ?3, 'public', 'song', 'published', 'original',
            '夜の波', '夜の波に迷った', 'ja',
            'original', 'allow', 'safe', 'none', ?4, ?4, 'public', 'ast_song',
            'public', '夜の波', 'ipfs://cover')
  `, [POST_ID, COMMUNITY_ID, AUTHOR_ID, NOW])
}

async function seedMultilineSongPost(): Promise<void> {
  await exec(`
    INSERT INTO posts (
      post_id, community_id, author_user_id, identity_mode, post_type,
      status, song_mode, title, lyrics, source_language, rights_basis,
      analysis_state, content_safety_state, age_gate_policy, created_at,
      updated_at, access_mode, asset_id, visibility, song_title, song_cover_art_ref
    )
    VALUES (?1, ?2, ?3, 'public', 'song', 'published', 'original',
            'Midnight Waves', 'I was lost in the midnight waves
Hold me close until the morning', 'en',
            'original', 'allow', 'safe', 'none', ?4, ?4, 'public', 'ast_song',
            'public', 'Midnight Waves', 'ipfs://cover')
  `, [POST_ID, COMMUNITY_ID, AUTHOR_ID, NOW])
}

async function seedReadyPack(): Promise<void> {
  await exec(`
    INSERT INTO song_study_unit (
      id, post_id, line_id, line_index, source_language, prompt_text,
      reference_text, say_it_back_status, unit_version, max_attempts,
      created_at, updated_at
    )
    VALUES
      ('stu_1', ?1, 'line_001', 0, 'en',
       'I was lost in the midnight waves',
       'I was lost in the midnight waves',
       'ready', 2, 2, ?2, ?2),
      ('stu_2', ?1, 'line_002', 1, 'en',
       'Hold me close until the morning',
       'Hold me close until the morning',
       'ready', 2, 2, ?2, ?2)
  `, [POST_ID, NOW])
  await exec(`
    INSERT INTO song_study_unit_localization (
      id, unit_id, target_language, localization_version, status,
      question, translation_text, options_json, correct_option_id,
      explanation_text, max_attempts, generated_at, created_at, updated_at
    )
    VALUES (
      'sul_2_es', 'stu_2', 'es', 1, 'ready',
      'Choose the best translation.',
      'Abrázame fuerte hasta la mañana',
      ?1,
      'opt_a',
      'La traducción mantiene el sentido de cercanía hasta la mañana.',
      2, ?2, ?2, ?2
    )
  `, [
    JSON.stringify([
      { id: "opt_a", text: "Abrázame fuerte hasta la mañana" },
      { id: "opt_b", text: "Déjame ir antes del amanecer" },
      { id: "opt_c", text: "Canta conmigo toda la noche" },
    ]),
    NOW,
  ])
}

async function seedLongReadyPack(lineCount = 20): Promise<void> {
  for (let index = 0; index < lineCount; index += 1) {
    const lineNumber = index + 1
    const lineId = `line_${String(lineNumber).padStart(3, "0")}`
    const unitId = `stu_long_${lineNumber}`
    const prompt = `Study line ${lineNumber}`
    const translation = `Linea de estudio ${lineNumber}`
    const correctOptionId = `long_opt_${lineNumber}_a`
    await exec(`
      INSERT INTO song_study_unit (
        id, post_id, line_id, line_index, source_language, prompt_text,
        reference_text, say_it_back_status, unit_version, max_attempts,
        created_at, updated_at
      )
      VALUES (?1, ?2, ?3, ?4, 'en', ?5, ?5, 'ready', 2, 2, ?6, ?6)
    `, [unitId, POST_ID, lineId, index, prompt, NOW])
    await exec(`
      INSERT INTO song_study_unit_localization (
        id, unit_id, target_language, localization_version, status,
        question, translation_text, options_json, correct_option_id,
        explanation_text, max_attempts, generated_at, created_at, updated_at
      )
      VALUES (?1, ?2, 'es', 1, 'ready', 'Choose the best translation.', ?3, ?4, ?5, NULL, 1, ?6, ?6, ?6)
    `, [
      `sul_long_${lineNumber}_es`,
      unitId,
      translation,
      JSON.stringify([
        { id: correctOptionId, text: translation },
        { id: `long_opt_${lineNumber}_b`, text: `Distractor ${lineNumber} B` },
        { id: `long_opt_${lineNumber}_c`, text: `Distractor ${lineNumber} C` },
      ]),
      correctOptionId,
      NOW,
    ])
  }
}

async function seedActiveAssetEntitlement(userId: string, assetId = "ast_song"): Promise<void> {
  await exec(`
    INSERT INTO purchases (
      purchase_id, community_id, listing_id, asset_id, buyer_user_id,
      settlement_wallet_attachment_id, purchase_price_usd, settlement_chain,
      settlement_token, settlement_tx_ref, created_at
    )
    VALUES (
      'pur_study_entitlement', ?1, 'lst_study_entitlement', ?2, ?3,
      'wla_study', 3.99, 'base', 'usdc', '0xstudy', ?4
    )
  `, [COMMUNITY_ID, assetId, userId, NOW])
  await exec(`
    INSERT INTO purchase_entitlements (
      purchase_entitlement_id, purchase_id, community_id, buyer_user_id,
      entitlement_kind, target_ref, status, granted_at, created_at, updated_at
    )
    VALUES (
      'pet_study_entitlement', 'pur_study_entitlement', ?1, ?2,
      'asset_access', ?3, 'active', ?4, ?4, ?4
    )
  `, [COMMUNITY_ID, userId, assetId, NOW])
}

async function setupControlPlaneCredentials(): Promise<void> {
  await execControl(`
    CREATE TABLE community_database_routing (
      community_id TEXT PRIMARY KEY,
      backend TEXT NOT NULL,
      provisioning_state TEXT NOT NULL,
      shard_worker_id TEXT,
      binding_name TEXT,
      region TEXT,
      migrated_at TEXT,
      decommissioned_at TEXT,
      last_error_at TEXT,
      last_error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  await execControl(`
    INSERT INTO community_database_routing (
      community_id, backend, provisioning_state, shard_worker_id, binding_name,
      region, migrated_at, decommissioned_at,
      last_error_at, last_error_message, created_at, updated_at
    )
    VALUES (?1, 'd1', 'ready', 'test-shard', 'DB_CMTY_STUDY', 'test',
              ?2, NULL, NULL, NULL, ?2, ?2)
  `, [COMMUNITY_ID, NOW])
  await execControl(`
    CREATE TABLE community_assistant_credentials (
      community_assistant_credential_id TEXT PRIMARY KEY,
      community_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      encrypted_secret TEXT NOT NULL,
      key_last4 TEXT NOT NULL,
      encryption_key_version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT,
      rotated_from TEXT,
      actor_user_id TEXT NOT NULL
    )
  `)
}

async function seedActiveElevenLabsCredential(): Promise<void> {
  await execControl(`
    INSERT INTO community_assistant_credentials (
      community_assistant_credential_id, community_id, provider, encrypted_secret,
      key_last4, encryption_key_version, status, created_at, revoked_at, rotated_from, actor_user_id
    )
    VALUES (
      'cac_elevenlabs', ?1, 'elevenlabs', 'test-encrypted-key',
      'labs', 1, 'active', ?2, NULL, NULL, ?3
    )
  `, [COMMUNITY_ID, NOW, AUTHOR_ID])
  clearActiveCommunityElevenLabsCredentialPresenceCacheForTests({
    env: env(),
    communityId: COMMUNITY_ID,
  })
}

async function clearElevenLabsCredential(): Promise<void> {
  const testEnv = env()
  const controlPlaneUrl = testEnv.CONTROL_PLANE_DATABASE_URL
  if (!controlPlaneUrl) throw new Error("test control plane URL is not configured")
  const credentialClient = createClient({ url: controlPlaneUrl })
  try {
    await credentialClient.execute("DELETE FROM community_assistant_credentials WHERE provider = 'elevenlabs'")
  } finally {
    credentialClient.close()
  }
  clearActiveCommunityElevenLabsCredentialPresenceCacheForTests({
    env: testEnv,
    communityId: COMMUNITY_ID,
  })
}

async function createEmptyCredentialEnv(): Promise<Env> {
  if (!rootDir) throw new Error("test root not initialized")
  const credentialDbUrl = `file:${join(rootDir, "empty-credentials.db")}`
  const credentialClient = createClient({ url: credentialDbUrl })
  try {
    await credentialClient.execute(`
      CREATE TABLE community_database_routing (
        community_id TEXT PRIMARY KEY,
        backend TEXT NOT NULL,
        provisioning_state TEXT NOT NULL,
        shard_worker_id TEXT,
        binding_name TEXT,
        region TEXT,
        migrated_at TEXT,
        decommissioned_at TEXT,
        last_error_at TEXT,
        last_error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
    await credentialClient.execute({
      sql: `
        INSERT INTO community_database_routing (
          community_id, backend, provisioning_state, shard_worker_id, binding_name,
          region, migrated_at, decommissioned_at,
          last_error_at, last_error_message, created_at, updated_at
        )
        VALUES (?1, 'd1', 'ready', 'test-shard', 'DB_CMTY_STUDY', 'test',
                  ?2, NULL, NULL, NULL, ?2, ?2)
      `,
      args: [COMMUNITY_ID, NOW],
    })
    await credentialClient.execute(`
      CREATE TABLE community_assistant_credentials (
        community_assistant_credential_id TEXT PRIMARY KEY,
        community_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        encrypted_secret TEXT NOT NULL,
        key_last4 TEXT NOT NULL,
        encryption_key_version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT,
        rotated_from TEXT,
        actor_user_id TEXT NOT NULL
      )
    `)
  } finally {
    credentialClient.close()
  }
  const testEnv = env({ CONTROL_PLANE_DATABASE_URL: credentialDbUrl })
  clearActiveCommunityElevenLabsCredentialPresenceCacheForTests({
    env: testEnv,
    communityId: COMMUNITY_ID,
  })
  return testEnv
}

beforeEach(async () => {
  beforeNextStudyResponseBatch = null
  observedBatchWriteSql = []
  rootDir = await mkdtemp(join(tmpdir(), "pirate-study-"))
  await mkdir(rootDir, { recursive: true })
  controlClient = createClient({ url: `file:${join(rootDir, "control-plane.db")}` })
  await setupControlPlaneCredentials()
  await seedActiveElevenLabsCredential()
  client = createClient({ url: buildLocalCommunityDbUrl(rootDir, COMMUNITY_ID) })
  await ensureCommunityDbSchema(client)
  await applyStudyMigration()
  await seedCommunity()
}, 120_000)

afterEach(async () => {
  controlClient?.close()
  controlClient = null
  client?.close()
  client = null
  if (rootDir) {
    await rm(rootDir, { recursive: true, force: true })
    rootDir = null
  }
}, 120_000)

describe("post study service", () => {
  test("age-gated streak reads require verified age after post access", async () => {
    await seedSongPost()
    await exec("UPDATE posts SET age_gate_policy = '18_plus' WHERE post_id = ?1", [POST_ID])
    const ageGateRow = await client!.execute({
      args: [POST_ID],
      sql: "SELECT age_gate_policy FROM posts WHERE post_id = ?1",
    })
    expect(ageGateRow.rows[0]?.age_gate_policy).toBe("18_plus")
    const unverifiedUsers = {
      getUserById: async () => null,
    }

    await expect(getPostStreakSummary({
      client: client!,
      postId: POST_ID,
      profileRepository: profileRepository as never,
      userId: LEARNER_ID,
      userRepository: unverifiedUsers as never,
    })).rejects.toMatchObject({
      code: "verification_required",
      status: 403,
    })
  })

  test("allows a learner to read their own streak for a public song without membership", async () => {
    await seedSongPost()
    await exec("DELETE FROM community_memberships WHERE user_id = ?1", [LEARNER_ID])

    const summary = await getPostStreakSummary({
      client: client!,
      postId: POST_ID,
      profileRepository: profileRepository as never,
      userId: LEARNER_ID,
      userRepository: {} as never,
    })
    expect(summary).not.toBeNull()

    await exec("UPDATE posts SET access_mode = 'locked' WHERE post_id = ?1", [POST_ID])
    expect(await getPostStreakSummary({
      client: client!,
      postId: POST_ID,
      profileRepository: profileRepository as never,
      userId: LEARNER_ID,
      userRepository: {} as never,
    })).toBeNull()
  })

  test("revalidates stale local ElevenLabs study capability from the control plane", async () => {
    await exec(`
      UPDATE communities
      SET settings_json = ?2
      WHERE community_id = ?1
    `, [COMMUNITY_ID, JSON.stringify({
      assistant_credential_capabilities: {
        elevenlabs_active: false,
        updated_at: "2026-06-27T08:00:00.000Z",
      },
    })])

    const capability = await getCommunityElevenLabsStudyCapability({
      client: client!,
      communityId: COMMUNITY_ID,
      env: env(),
    })

    expect(capability).toEqual({
      active: true,
      source: "control_plane_miss",
    })

    const row = await client!.execute("SELECT settings_json FROM communities WHERE community_id = ?1", [COMMUNITY_ID])
    const settings = JSON.parse(String(row.rows[0]?.settings_json ?? "{}")) as Record<string, unknown>
    const capabilities = settings.assistant_credential_capabilities as Record<string, unknown>
    expect(capabilities.elevenlabs_active).toBe(true)
  })

  test("concurrent ElevenLabs study capability read-throughs backfill idempotently", async () => {
    const [first, second] = await Promise.all([
      getCommunityElevenLabsStudyCapability({
        client: client!,
        communityId: COMMUNITY_ID,
        env: env(),
      }),
      getCommunityElevenLabsStudyCapability({
        client: client!,
        communityId: COMMUNITY_ID,
        env: env(),
      }),
    ])

    expect(first.active).toBe(true)
    expect(second.active).toBe(true)

    const row = await client!.execute("SELECT settings_json FROM communities WHERE community_id = ?1", [COMMUNITY_ID])
    const settings = JSON.parse(String(row.rows[0]?.settings_json ?? "{}")) as Record<string, unknown>
    const capabilities = settings.assistant_credential_capabilities as Record<string, unknown>
    expect(capabilities.elevenlabs_active).toBe(true)
  })

  test("returns ready exercises without exposing the multiple-choice answer", async () => {
    await seedSongPost()
    await seedReadyPack()

    const payload = await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
      targetLanguage: "es",
    })

    expect(payload.access).toBe("ready")
    expect(payload.exercise_count).toBe(3)
    expect(payload.study_pack_version).toBe(2)
    const serialized = JSON.stringify(payload)
    expect(serialized).toContain("opt_a")
    expect(serialized).not.toContain("correct_option_id")
  })

  test("caps long first-learn study sessions while reporting total eligible exercises", async () => {
    await seedSongPost()
    await seedLongReadyPack()

    const payload = await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
      targetLanguage: "es",
    })

    expect(payload.access).toBe("ready")
    expect(payload.exercise_count).toBe(10)
    expect(payload.exercises).toHaveLength(10)
    expect(payload.session).toMatchObject({
      due_count: 40,
      served_count: 10,
      total_units: 40,
    })
    expect(payload.exercises.map((exercise) => `${exercise.line_id}:${exercise.type}`)).toEqual([
      "line_001:say_it_back",
      "line_002:say_it_back",
      "line_003:say_it_back",
      "line_004:say_it_back",
      "line_005:say_it_back",
      "line_001:translation_choice",
      "line_002:translation_choice",
      "line_003:translation_choice",
      "line_004:translation_choice",
      "line_005:translation_choice",
    ])
  })

  test("caps due-review study sessions while keeping the due count uncapped", async () => {
    await seedSongPost()
    await seedLongReadyPack()
    await exec(`
      INSERT INTO song_study_review_state (
        user_id, post_id, line_id, exercise_type, target_language,
        state, stability, difficulty, due_at, last_reviewed_at,
        reps, lapses, fsrs_params_version, updated_at
      )
      SELECT ?1, u.post_id, u.line_id, 'say_it_back', COALESCE(u.source_language, 'source'),
             'review', 1, 5, '2026-06-28T08:00:00.000Z', '2026-06-27T08:00:00.000Z',
             1, 0, 1, ?2
      FROM song_study_unit u
      WHERE u.post_id = ?3
    `, [LEARNER_ID, NOW, POST_ID])
    await exec(`
      INSERT INTO song_study_review_state (
        user_id, post_id, line_id, exercise_type, target_language,
        state, stability, difficulty, due_at, last_reviewed_at,
        reps, lapses, fsrs_params_version, updated_at
      )
      SELECT ?1, u.post_id, u.line_id, 'translation_choice', l.target_language,
             'review', 1, 5, '2026-06-28T08:00:00.000Z', '2026-06-27T08:00:00.000Z',
             1, 0, 1, ?2
      FROM song_study_unit u
      JOIN song_study_unit_localization l ON l.unit_id = u.id
      WHERE u.post_id = ?3
        AND l.target_language = 'es'
    `, [LEARNER_ID, NOW, POST_ID])

    const payload = await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env({ SONG_STUDY_DUE_REVIEW_SERVING_ENABLED: "true" }),
      postId: POST_ID,
      targetLanguage: "es",
    })

    expect(payload.access).toBe("ready")
    expect(payload.exercise_count).toBe(10)
    expect(payload.exercises).toHaveLength(10)
    expect(payload.session).toMatchObject({
      due_count: 40,
      served_count: 10,
      total_units: 40,
    })
  })

  test("omits say-it-back exercises without an active ElevenLabs credential", async () => {
    await clearElevenLabsCredential()
    await seedSongPost()
    await seedReadyPack()

    const payload = await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
      targetLanguage: "es",
    })

    expect(payload.access).toBe("ready")
    expect(payload.exercise_count).toBe(1)
    expect(payload.exercises.map((exercise) => exercise.type)).toEqual(["translation_choice"])
    expect(payload.exercises[0]?.line_id).toBe("line_002")
  })

  test("reports a missing transcription provider when only say-it-back is available without an ElevenLabs credential", async () => {
    await clearElevenLabsCredential()
    await seedSongPost()
    await seedReadyPack()
    await exec("DELETE FROM song_study_unit_localization")

    const payload = await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
      targetLanguage: "es",
    })

    expect(payload.access).toBe("unavailable")
    expect(payload.exercise_count).toBe(0)
    expect(payload.exercises).toEqual([])
    expect(payload.unavailable_reason).toBe("missing_transcription_provider")
  })

  test("reports a missing transcription provider for same-language study without ElevenLabs", async () => {
    await clearElevenLabsCredential()
    await seedSongPost()

    const payload = await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
      targetLanguage: "en",
    })

    expect(payload.access).toBe("unavailable")
    expect(payload.exercise_count).toBe(0)
    expect(payload.exercises).toEqual([])
    expect(payload.unavailable_reason).toBe("missing_transcription_provider")
  })

  test("reports processing when translations can generate but say-it-back is gated by missing ElevenLabs", async () => {
    await clearElevenLabsCredential()
    await seedSongPost()
    await seedReadyPack()
    await exec("DELETE FROM song_study_unit_localization")

    const generationEnv = env({
      OPENROUTER_API_KEY: "test-openrouter-key",
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_TRANSLATION_MODEL: "test/study-generator",
    })
    const payload = await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: generationEnv,
      postId: POST_ID,
      targetLanguage: "es",
    })

    expect(payload.access).toBe("processing")
    expect(payload.translation_status).toBe("processing")
    expect(payload.exercise_count).toBe(0)
    expect(payload.exercises).toEqual([])
    expect(payload.unavailable_reason).toBeUndefined()
    const processingRows = await client!.execute("SELECT COUNT(*) AS count FROM song_study_unit_localization WHERE status = 'processing'")
    expect(Number(processingRows.rows[0]?.count ?? 0)).toBe(2)
    const queuedRun = await client!.execute(`
      SELECT status, job_id, attempt_count
      FROM song_study_generation_run
      WHERE post_id = ?1 AND target_language = 'es'
    `, [POST_ID])
    expect(queuedRun.rows).toEqual([{
      attempt_count: 0,
      job_id: expect.stringMatching(/^cjb_/),
      status: "queued",
    }])
  })

  test("keeps voice ready while cross-language translations are being prepared", async () => {
    await seedSongPost()
    const payload = await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env({
        OPENROUTER_API_KEY: "test-openrouter-key",
        OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
        OPENROUTER_TRANSLATION_MODEL: "test/study-generator",
      }),
      postId: POST_ID,
      targetLanguage: "zh",
    })

    expect(payload.access).toBe("ready")
    expect(payload.translation_status).toBe("processing")
    expect(payload.exercises.length).toBeGreaterThan(0)
    expect(payload.exercises.every((exercise) => exercise.type === "say_it_back")).toBe(true)
  })

  test("returns unavailable without lazy generation when study is disabled", async () => {
    await setStudyEnabled(false)
    await seedSongPost()

    let fetchCalled = false
    const payload = await withMockedFetch(() => (async () => {
      fetchCalled = true
      return new Response("unexpected", { status: 500 })
    }) as typeof fetch, async () => getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env({
        OPENROUTER_API_KEY: "test-openrouter-key",
        OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      }),
      postId: POST_ID,
      targetLanguage: "es",
    }))

    expect(payload.access).toBe("unavailable")
    expect(payload.exercise_count).toBe(0)
    expect(fetchCalled).toBe(false)
    const units = await client!.execute("SELECT COUNT(*) AS count FROM song_study_unit")
    expect(Number(units.rows[0]?.count ?? 0)).toBe(0)
  })

  test("treats a missing study_enabled column as disabled without throwing", async () => {
    await seedSongPost()
    await client!.execute("ALTER TABLE communities DROP COLUMN study_enabled")

    const payload = await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
      targetLanguage: "es",
    })

    expect(payload.access).toBe("unavailable")
    expect(payload.exercise_count).toBe(0)
  })

  test("orders multiple-choice options deterministically per learner without storing per-user rows", async () => {
    await seedSongPost()
    await seedReadyPack()

    const learnerPayload = await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
      targetLanguage: "es",
    })
    const learnerRetryPayload = await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
      targetLanguage: "es",
    })
    const authorPayload = await getPostStudyPayload({
      actor: authorActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
      targetLanguage: "es",
    })

    const optionIds = (payload: Awaited<ReturnType<typeof getPostStudyPayload>>) =>
      payload.exercises
        .find((exercise) => exercise.type === "translation_choice")
        ?.options.map((option) => option.id)

    expect(optionIds(learnerPayload)).toEqual(optionIds(learnerRetryPayload))
    expect(optionIds(learnerPayload)).not.toEqual(optionIds(authorPayload))

    const attempts = await client!.execute("SELECT COUNT(*) AS count FROM song_study_attempt")
    expect(Number(attempts.rows[0]?.count ?? 0)).toBe(0)
  })

  test("returns locked without exercise content for a non-entitled locked song", async () => {
    await seedSongPost("locked")
    await seedReadyPack()

    const payload = await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
      targetLanguage: "es",
    })

    expect(payload.access).toBe("locked")
    expect(payload.locked_reason).toBe("purchase_required")
    expect(payload.exercise_count).toBe(0)
    expect(payload.exercises).toEqual([])
    expect(JSON.stringify(payload)).not.toContain("Abrázame")
  })

  test("returns ready for an active purchaser who is not the author of a locked song", async () => {
    await seedSongPost("locked")
    await seedReadyPack()
    await seedActiveAssetEntitlement(LEARNER_ID)

    const payload = await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
      targetLanguage: "es",
    })

    expect(payload.access).toBe("ready")
    expect(payload.exercise_count).toBe(3)
    expect(payload.exercises.some((exercise) => exercise.type === "translation_choice")).toBe(true)
  })

  test("commits the attempt write plan through BufferingD1WriteTransaction without buffered reads", async () => {
    await seedSongPost()
    await seedReadyPack()

    const input = {
      actor: learnerActor,
      body: {
        attempt_number: 1,
        exercise_id: "stu:stu_2:translation_choice:es",
        idempotency_key: "study-attempt-1",
        selected_option_id: "opt_a",
        type: "translation_choice",
      },
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
    } as const
    const [first, retry] = await Promise.all([
      submitPostStudyAttempt(input),
      submitPostStudyAttempt(input),
    ])

    expect(first).toMatchObject({
      attempts_remaining: 2,
      correct_option_id: "opt_a",
      exercise_id: "stu:stu_2:translation_choice:es",
      next_review_hint: "good",
      object: "song_study_attempt_result",
      outcome: "correct",
      session: {
        completed_exercise_count: 1,
        first_pass_correct_count: 1,
        qualified: false,
        required_correct_count: 3,
        status: "active",
      },
    })
    expect(retry).toEqual(first)

    const count = await client!.execute("SELECT COUNT(*) AS count FROM song_study_attempt")
    expect(Number(count.rows[0]?.count ?? 0)).toBe(1)
    expect(observedBatchWriteSql.length).toBeGreaterThan(0)
    expect(observedBatchWriteSql.every((sql) => isWriteAllowedStatement(sql))).toBe(true)
  })

  test("revision-absent clients replay one logical presentation under a different key", async () => {
    await seedSongPost()
    await seedReadyPack()
    const payload = await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
      targetLanguage: "es",
    })
    const current = payload.exercises[0]!
    const body = {
      attempt_number: 1,
      exercise_id: current.id,
      session_id: payload.session!.id!,
      ...(current.type === "say_it_back"
        ? { transcript: current.reference_text, type: "say_it_back" as const }
        : { selected_option_id: "opt_a", type: "translation_choice" as const }),
    }
    const submit = (idempotencyKey: string) => submitPostStudyAttempt({
      actor: learnerActor,
      body: { ...body, idempotency_key: idempotencyKey },
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
    })
    const first = await submit("legacy-logical-a")
    const replay = await submit("legacy-logical-b")
    expect(replay).toMatchObject({
      attempts_remaining: first.attempts_remaining,
      exercise_id: first.exercise_id,
      lesson: first.lesson,
      outcome: first.outcome,
      session: {
        completed_exercise_count: first.session!.completed_exercise_count,
        presentation_count: first.session!.presentation_count,
        session_revision: first.session!.session_revision,
      },
    })
    expect(Number((await client!.execute("SELECT COUNT(*) AS count FROM song_study_attempt")).rows[0]?.count)).toBe(1)
    expect(Number((await client!.execute("SELECT COUNT(*) AS count FROM song_study_review_state")).rows[0]?.count)).toBe(1)
  })

  test("concurrent revision-absent logical duplicates commit one attempt", async () => {
    await seedSongPost()
    await seedReadyPack()
    const payload = await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
      targetLanguage: "es",
    })
    const current = payload.exercises[0]!
    const body = {
      attempt_number: 1,
      exercise_id: current.id,
      session_id: payload.session!.id!,
      ...(current.type === "say_it_back"
        ? { transcript: current.reference_text, type: "say_it_back" as const }
        : { selected_option_id: "opt_a", type: "translation_choice" as const }),
    }
    const submit = (idempotencyKey: string) => submitPostStudyAttempt({
      actor: learnerActor,
      body: { ...body, idempotency_key: idempotencyKey },
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
    })
    const [left, right] = await Promise.all([submit("legacy-race-a"), submit("legacy-race-b")])
    expect(right).toMatchObject({
      attempts_remaining: left.attempts_remaining,
      exercise_id: left.exercise_id,
      lesson: left.lesson,
      outcome: left.outcome,
      session: {
        completed_exercise_count: left.session!.completed_exercise_count,
        presentation_count: left.session!.presentation_count,
        session_revision: left.session!.session_revision,
      },
    })
    expect(Number((await client!.execute("SELECT COUNT(*) AS count FROM song_study_attempt")).rows[0]?.count)).toBe(1)
    expect(Number((await client!.execute("SELECT COUNT(*) AS count FROM song_study_review_state")).rows[0]?.count)).toBe(1)
  })

  test("feature-gated ungradable voice grants one durable free re-record per appearance", async () => {
    await seedSongPost()
    await seedReadyPack()
    const payload = await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
      targetLanguage: "es",
    })
    const exercise = payload.exercises.find((candidate) => candidate.type === "say_it_back")!
    const base = {
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env({ SONG_STUDY_UNGRADABLE_RERECORD_ENABLED: "true" }),
      postId: POST_ID,
    }
    const firstInput = {
      ...base,
      body: {
        attempt_number: 1,
        exercise_id: exercise.id,
        idempotency_key: "rerecord-first",
        session_id: payload.session!.id!,
        session_revision: payload.session!.session_revision,
        transcript: "testing one two three",
        type: "say_it_back",
      },
    }
    const first = await submitPostStudyAttempt(firstInput)
    const replay = await submitPostStudyAttempt(firstInput)
    expect(first).toMatchObject({
      attempts_remaining: 3,
      outcome: "ungradable",
      lesson: {
        resolved_count: 0,
        session_revision: 1,
        next: { exercise_id: exercise.id, presentation_number: 1, retry_in_place: true },
      },
      session: { presentation_count: 0 },
    })
    expect(replay).toEqual(first)
    expect(Number((await client!.execute("SELECT COUNT(*) AS count FROM song_study_attempt")).rows[0]?.count)).toBe(0)
    expect(Number((await client!.execute("SELECT COUNT(*) AS count FROM song_study_ungradable_receipt")).rows[0]?.count)).toBe(1)

    const spent = await submitPostStudyAttempt({
      ...base,
      body: {
        ...firstInput.body,
        idempotency_key: "rerecord-second",
        session_revision: first.lesson!.session_revision,
      },
    })
    expect(spent).toMatchObject({ outcome: "incorrect", lesson: { session_revision: 2 } })
    expect(Number((await client!.execute("SELECT COUNT(*) AS count FROM song_study_attempt")).rows[0]?.count)).toBe(1)
    expect(observedBatchWriteSql.every((sql) => /^(?:INSERT|UPDATE|DELETE)\b/iu.test(sql))).toBe(true)
  })

  test("different keys at one revision commit once and stale replay stays idempotent", async () => {
    await seedSongPost()
    await seedReadyPack()
    const payload = await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
      targetLanguage: "es",
    })
    const current = payload.exercises[0]!
    const baseBody = {
      attempt_number: 1,
      exercise_id: current.id,
      session_id: payload.session!.id!,
      session_revision: payload.session!.session_revision,
      ...(current.type === "say_it_back"
        ? { transcript: current.reference_text, type: "say_it_back" as const }
        : { selected_option_id: "opt_a", type: "translation_choice" as const }),
    } as const
    const submit = (key: string) => submitPostStudyAttempt({
      actor: learnerActor,
      body: { ...baseBody, idempotency_key: key },
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
    })
    const raced = await Promise.allSettled([submit("revision-race-a"), submit("revision-race-b")])
    const successes = raced.filter((result) => result.status === "fulfilled")
    const failures = raced.filter((result) => result.status === "rejected") as PromiseRejectedResult[]
    expect(successes).toHaveLength(1)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.reason).toMatchObject({
      code: "study_session_revision_conflict",
      details: { lesson: { session_revision: 1 } },
      status: 409,
    })
    expect(Number((await client!.execute("SELECT COUNT(*) AS count FROM song_study_attempt")).rows[0]?.count)).toBe(1)

    const winner = (successes[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof submit>>>).value
    const winnerKey = raced[0]?.status === "fulfilled" ? "revision-race-a" : "revision-race-b"
    const loserKey = winnerKey === "revision-race-a" ? "revision-race-b" : "revision-race-a"
    const replay = await submit(winnerKey)
    expect(replay).toEqual(winner)
    await expect(submit(loserKey)).rejects.toMatchObject({
      code: "study_session_revision_conflict",
      details: { lesson: { session_revision: 1 } },
      status: 409,
    })
  })

  test("stale revision returns the authoritative lesson before presentation validation", async () => {
    await seedSongPost()
    await seedReadyPack()
    const payload = await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
      targetLanguage: "es",
    })
    const current = payload.exercises[0]!
    const baseBody = {
      attempt_number: 1,
      exercise_id: current.id,
      session_id: payload.session!.id!,
      session_revision: payload.session!.session_revision,
      ...(current.type === "say_it_back"
        ? { transcript: current.reference_text, type: "say_it_back" as const }
        : { selected_option_id: "opt_a", type: "translation_choice" as const }),
    }
    await submitPostStudyAttempt({
      actor: learnerActor,
      body: { ...baseBody, idempotency_key: "stale-advance" },
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
    })
    await expect(submitPostStudyAttempt({
      actor: learnerActor,
      body: { ...baseBody, idempotency_key: "stale-after-advance" },
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
    })).rejects.toMatchObject({
      code: "study_session_revision_conflict",
      details: { lesson: { session_revision: 1 } },
      status: 409,
    })
  })

  test("session deletion during stale-conflict persistence returns the typed conflict instead of an FK failure", async () => {
    await seedSongPost()
    await seedReadyPack()
    const payload = await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
      targetLanguage: "es",
    })
    const current = payload.exercises[0]!
    const baseBody = {
      attempt_number: 1,
      exercise_id: current.id,
      session_id: payload.session!.id!,
      session_revision: payload.session!.session_revision,
      ...(current.type === "say_it_back"
        ? { transcript: current.reference_text, type: "say_it_back" as const }
        : { selected_option_id: "opt_a", type: "translation_choice" as const }),
    }
    await submitPostStudyAttempt({
      actor: learnerActor,
      body: { ...baseBody, idempotency_key: "delete-race-advance" },
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
    })
    beforeNextStudyResponseBatch = async () => {
      await client!.execute({ sql: "DELETE FROM song_study_session WHERE id = ?1", args: [payload.session!.id!] })
    }
    await expect(submitPostStudyAttempt({
      actor: learnerActor,
      body: { ...baseBody, idempotency_key: "delete-race-stale" },
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
    })).rejects.toMatchObject({ code: "study_session_revision_conflict", status: 409 })
    expect(Number((await client!.execute({
      sql: "SELECT COUNT(*) AS count FROM song_study_session WHERE id = ?1",
      args: [payload.session!.id!],
    })).rows[0]?.count)).toBe(0)
  })

  test("concurrent replay finalizes a pending completed response once and returns the immutable winner", async () => {
    await seedSongPost()
    await seedReadyPack()
    const attemptEnv = env({ SONG_STUDY_STREAK_WRITES_ENABLED: "true" })
    await completeQualifyingStudySession({ env: attemptEnv, idempotencyPrefix: "pending-finalize" })
    const row = (await client!.execute({
      sql: `SELECT session_id FROM song_study_attempt_response WHERE user_id = ?1 AND idempotency_key = ?2`,
      args: [LEARNER_ID, "pending-finalize-2"],
    })).rows[0]!
    await client!.execute({
      sql: `
        UPDATE song_study_attempt_response
        SET response_status = 'pending',
            response_json = json_remove(response_json, '$.study_progress'),
            materialization_context_json = ?3
        WHERE user_id = ?1 AND idempotency_key = ?2
      `,
      args: [
        LEARNER_ID,
        "pending-finalize-2",
        JSON.stringify({ completed_at: "2026-01-02T23:59:59.000Z", study_timezone: "UTC" }),
      ],
    })
    await client!.execute({
      sql: "DELETE FROM song_engagement_days WHERE user_id = ?1 AND post_id = ?2",
      args: [LEARNER_ID, POST_ID],
    })
    await client!.execute({
      sql: "DELETE FROM song_streaks WHERE user_id = ?1 AND post_id = ?2",
      args: [LEARNER_ID, POST_ID],
    })
    const replayInput = {
      actor: learnerActor,
      body: {
        attempt_number: 1,
        exercise_id: "stu:stu_2:say_it_back:en",
        idempotency_key: "pending-finalize-2",
        session_id: String(row.session_id),
        transcript: "Hold me close until the morning",
        type: "say_it_back" as const,
      },
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: attemptEnv,
      postId: POST_ID,
    }
    const [left, right] = await Promise.all([
      submitPostStudyAttemptRaw(replayInput),
      submitPostStudyAttemptRaw(replayInput),
    ])
    expect(left).toEqual(right)
    expect(left.study_progress).toMatchObject({ qualified_today: true, study_correct_count: 3 })
    const finalized = (await client!.execute({
      sql: `SELECT response_status, response_json FROM song_study_attempt_response WHERE user_id = ?1 AND idempotency_key = ?2`,
      args: [LEARNER_ID, "pending-finalize-2"],
    })).rows[0]!
    expect(finalized.response_status).toBe("final")
    expect(JSON.parse(String(finalized.response_json))).toEqual(left)
    expect((await client!.execute({
      sql: `SELECT activity_date FROM song_engagement_days WHERE user_id = ?1 AND post_id = ?2`,
      args: [LEARNER_ID, POST_ID],
    })).rows[0]?.activity_date).toBe("2026-01-02")
  })

  test("allows public study attempts without probing community membership", async () => {
    await seedSongPost()
    await seedReadyPack()
    await exec("DELETE FROM community_memberships WHERE user_id = ?1", [LEARNER_ID])

    const payload = await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
      targetLanguage: "es",
    })
    expect(payload.access).toBe("ready")

    const result = await submitPostStudyAttempt({
      actor: learnerActor,
      body: {
        attempt_number: 1,
        exercise_id: "stu:stu_2:translation_choice:es",
        idempotency_key: "study-public-no-membership",
        selected_option_id: "opt_a",
        type: "translation_choice",
      },
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
    })
    expect(result.outcome).toBe("correct")

    const attempts = await client!.execute("SELECT COUNT(*) AS count FROM song_study_attempt")
    expect(Number(attempts.rows[0]?.count ?? 0)).toBe(1)
  })

  test("does not write study streak rows while the streak write gate is off", async () => {
    await seedSongPost()
    await seedReadyPack()

    await submitPostStudyAttempt({
      actor: learnerActor,
      body: {
        attempt_number: 1,
        exercise_id: "stu:stu_2:translation_choice:es",
        idempotency_key: "study-streak-gate-off",
        selected_option_id: "opt_a",
        type: "translation_choice",
      },
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
    })

    const ledger = await client!.execute("SELECT COUNT(*) AS count FROM song_engagement_days")
    const streaks = await client!.execute("SELECT COUNT(*) AS count FROM song_streaks")
    expect(Number(ledger.rows[0]?.count ?? 0)).toBe(0)
    expect(Number(streaks.rows[0]?.count ?? 0)).toBe(0)
  })

  test("a first-pass wrong MCQ does not write the session streak ledger early", async () => {
    await seedSongPost()
    await seedReadyPack()

    const result = await submitPostStudyAttempt({
      actor: learnerActor,
      body: {
        attempt_number: 1,
        exercise_id: "stu:stu_2:translation_choice:es",
        idempotency_key: "study-streak-wrong-mcq",
        selected_option_id: "opt_b",
        type: "translation_choice",
      },
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env({ SONG_STUDY_STREAK_WRITES_ENABLED: "true" }),
      postId: POST_ID,
    })

    expect(result.outcome).toBe("incorrect")
    const ledger = await client!.execute({
      sql: `
        SELECT study_attempt_count, study_correct_count, study_target_count, qualified
        FROM song_engagement_days
        WHERE user_id = ?1 AND post_id = ?2
      `,
      args: [LEARNER_ID, POST_ID],
    })
    expect(ledger.rows).toEqual([])
  })

  test("near-miss corrections master the card without inflating first-pass streak qualification", async () => {
    await seedSongPost()
    await seedReadyPack()
    const attemptEnv = env({
      SONG_STUDY_DUE_REVIEW_SERVING_ENABLED: "true",
      SONG_STUDY_STREAK_WRITES_ENABLED: "true",
    })

    await submitPostStudyAttempt({
      actor: learnerActor,
      body: {
        attempt_number: 1,
        exercise_id: "stu:stu_1:say_it_back:en",
        idempotency_key: "study-nearmiss-recovery-correct-say",
        test_target_language: "es",
        transcript: "I was lost in the midnight waves",
        type: "say_it_back",
      },
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: attemptEnv,
      postId: POST_ID,
    })
    await submitPostStudyAttempt({
      actor: learnerActor,
      body: {
        attempt_number: 1,
        exercise_id: "stu:stu_2:translation_choice:es",
        idempotency_key: "study-nearmiss-recovery-correct-choice",
        selected_option_id: "opt_a",
        type: "translation_choice",
      },
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: attemptEnv,
      postId: POST_ID,
    })

    const nearMiss = await submitPostStudyAttempt({
      actor: learnerActor,
      body: {
        attempt_number: 1,
        exercise_id: "stu:stu_2:say_it_back:en",
        idempotency_key: "study-nearmiss-recovery-near-miss",
        test_target_language: "es",
        transcript: "Hold me close until the dawn",
        type: "say_it_back",
      },
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: attemptEnv,
      postId: POST_ID,
    })

    expect(nearMiss.outcome).toBe("incorrect")
    expect(nearMiss.next_review_hint).toBe("again")
    let ledger = await client!.execute("SELECT study_attempt_count, study_correct_count, study_target_count, qualified FROM song_engagement_days")
    expect(ledger.rows).toEqual([])

    const review = await client!.execute({
      sql: `
        SELECT due_at, last_reviewed_at, state
        FROM song_study_review_state
        WHERE user_id = ?1
          AND post_id = ?2
          AND line_id = 'line_002'
          AND exercise_type = 'say_it_back'
          AND target_language = 'en'
      `,
      args: [LEARNER_ID, POST_ID],
    })
    const dueAt = String(review.rows[0]?.due_at ?? "")
    const lastReviewedAt = String(review.rows[0]?.last_reviewed_at ?? "")
    expect(review.rows[0]?.state).toBe("learning")
    expect(Date.parse(dueAt) - Date.parse(lastReviewedAt)).toBe(10 * 60 * 1000)

    await exec(`
      UPDATE song_study_review_state
      SET due_at = '2026-06-29T07:59:00.000Z'
      WHERE user_id = ?1
        AND post_id = ?2
        AND line_id = 'line_002'
        AND exercise_type = 'say_it_back'
        AND target_language = 'en'
    `, [LEARNER_ID, POST_ID])

    const recovered = await submitPostStudyAttempt({
      actor: learnerActor,
      body: {
        attempt_number: 2,
        exercise_id: "stu:stu_2:say_it_back:en",
        idempotency_key: "study-nearmiss-recovery-corrected",
        test_target_language: "es",
        transcript: "Hold me close until the morning",
        type: "say_it_back",
      },
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: attemptEnv,
      postId: POST_ID,
    })

    expect(recovered.outcome).toBe("correct")
    expect(recovered.study_progress).toMatchObject({
      qualified_today: false,
      study_attempt_count: 3,
      study_correct_count: 2,
      study_target_count: 3,
    })
    ledger = await client!.execute("SELECT study_attempt_count, study_correct_count, study_target_count, qualified FROM song_engagement_days")
    expect(ledger.rows.map((row) => ({
      qualified: Number(row.qualified),
      study_attempt_count: Number(row.study_attempt_count),
      study_correct_count: Number(row.study_correct_count),
      study_target_count: Number(row.study_target_count),
    }))).toEqual([{
      qualified: 0,
      study_attempt_count: 3,
      study_correct_count: 2,
      study_target_count: 3,
    }])
  })

  test("records the unqualified day inline but no streak when a wrong-answer session completes", async () => {
    await seedSongPost()
    await seedReadyPack()

    await completeUnqualifiedStudySession({
      env: env({ SONG_STUDY_STREAK_WRITES_ENABLED: "true" }),
      idempotencyPrefix: "study-streak-wrong",
    })

    // Streak writes are inline now: the completed unqualified session's day row
    // is visible immediately, and the streak materialization is an idempotent
    // no-op for unqualified days.
    const ledger = await client!.execute("SELECT study_attempt_count, study_correct_count, study_target_count, qualified FROM song_engagement_days")
    expect(ledger.rows.map((row) => ({
      qualified: Number(row.qualified),
      study_attempt_count: Number(row.study_attempt_count),
      study_correct_count: Number(row.study_correct_count),
      study_target_count: Number(row.study_target_count),
    }))).toEqual([{
      qualified: 0,
      study_attempt_count: 3,
      study_correct_count: 0,
      study_target_count: 3,
    }])
    const streaks = await client!.execute("SELECT COUNT(*) AS count FROM song_streaks")
    expect(Number(streaks.rows[0]?.count ?? 0)).toBe(0)
  })

  test("attempt retries are idempotent before session-level streak qualification", async () => {
    await seedSongPost()
    await seedReadyPack()

    const body = {
      attempt_number: 1,
      exercise_id: "stu:stu_2:translation_choice:es",
      idempotency_key: "study-streak-idempotent",
      selected_option_id: "opt_a",
      type: "translation_choice" as const,
    }
    await submitPostStudyAttempt({
      actor: learnerActor,
      body,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env({ SONG_STUDY_STREAK_WRITES_ENABLED: "true" }),
      postId: POST_ID,
    })
    await submitPostStudyAttempt({
      actor: learnerActor,
      body,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env({ SONG_STUDY_STREAK_WRITES_ENABLED: "true" }),
      postId: POST_ID,
    })

    const ledger = await client!.execute("SELECT study_attempt_count, study_correct_count FROM song_engagement_days")
    expect(ledger.rows).toEqual([])
    const attempts = await client!.execute("SELECT COUNT(*) AS count FROM song_study_attempt")
    expect(Number(attempts.rows[0]?.count ?? 0)).toBe(1)
  })

  test("writes no streak rows before the study session completes", async () => {
    await seedSongPost()
    await seedReadyPack()

    const result = await submitPostStudyAttempt({
      actor: learnerActor,
      body: {
        attempt_number: 1,
        exercise_id: "stu:stu_2:translation_choice:es",
        idempotency_key: "study-streak-before-completion",
        selected_option_id: "opt_a",
        type: "translation_choice",
      },
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env({ SONG_STUDY_STREAK_WRITES_ENABLED: "true" }),
      postId: POST_ID,
    })

    expect(result.outcome).toBe("correct")
    expect(result.session?.status).toBe("active")

    const ledger = await client!.execute("SELECT study_attempt_count, study_correct_count FROM song_engagement_days")
    expect(ledger.rows).toEqual([])
    const streaks = await client!.execute("SELECT COUNT(*) AS count FROM song_streaks")
    expect(Number(streaks.rows[0]?.count ?? 0)).toBe(0)
  })

  test("records the engagement day and streak inline when the session completes", async () => {
    await seedSongPost()
    await seedReadyPack()
    // Local path: timezone pin resolution and the active_until_at refresh read
    // inside the write transaction, which requires interactive transactions.
    const attemptEnv = localEnv({ SONG_STUDY_STREAK_WRITES_ENABLED: "true" })

    await submitPostStudyAttempt({
      actor: learnerActor,
      body: {
        attempt_number: 1,
        exercise_id: "stu:stu_1:say_it_back:en",
        idempotency_key: "study-streak-inline-engagement-say",
        test_target_language: "es",
        transcript: "I was lost in the midnight waves",
        type: "say_it_back",
      },
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: attemptEnv,
      postId: POST_ID,
    })
    await submitPostStudyAttempt({
      actor: learnerActor,
      body: {
        attempt_number: 1,
        exercise_id: "stu:stu_2:translation_choice:es",
        idempotency_key: "study-streak-inline-engagement-choice",
        selected_option_id: "opt_a",
        type: "translation_choice",
      },
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: attemptEnv,
      postId: POST_ID,
    })
    const finalAttempt = await submitPostStudyAttempt({
      actor: learnerActor,
      body: {
        attempt_number: 1,
        exercise_id: "stu:stu_2:say_it_back:en",
        idempotency_key: "study-streak-inline-engagement-say-second",
        test_target_language: "es",
        transcript: "Hold me close until the morning",
        type: "say_it_back",
      },
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: attemptEnv,
      postId: POST_ID,
    })
    expect(finalAttempt.study_progress).toMatchObject({
      current_streak: 1,
      qualified_today: true,
      study_attempt_count: 3,
      study_correct_count: 3,
      study_target_count: 3,
    })
    expect(typeof finalAttempt.study_progress?.next_due_at).toBe("number")

    // No deferred flush: both the day row and the materialized streak are
    // committed before the completing attempt responds.
    const ledger = await client!.execute("SELECT study_attempt_count, study_correct_count, study_target_count, qualified, activity_timezone FROM song_engagement_days")
    expect(ledger.rows.map((row) => ({
      activity_timezone: row.activity_timezone,
      qualified: Number(row.qualified),
      study_attempt_count: Number(row.study_attempt_count),
      study_correct_count: Number(row.study_correct_count),
      study_target_count: Number(row.study_target_count),
    }))).toEqual([{
      activity_timezone: "UTC",
      qualified: 1,
      study_attempt_count: 3,
      study_correct_count: 3,
      study_target_count: 3,
    }])

    const utcToday = studyActivityDate(new Date().toISOString(), "UTC")
    const streak = await client!.execute("SELECT current_streak, best_streak, total_qualified_days, timezone, active_until_at FROM song_streaks")
    expect(streak.rows.map((row) => ({
      active_until_at: row.active_until_at,
      best_streak: Number(row.best_streak),
      current_streak: Number(row.current_streak),
      timezone: row.timezone,
      total_qualified_days: Number(row.total_qualified_days),
    }))).toEqual([{
      active_until_at: endOfGraceUtcInstant(utcToday, "UTC"),
      best_streak: 1,
      current_streak: 1,
      timezone: "UTC",
      total_qualified_days: 1,
    }])
  })

  test("streak leaderboard excludes dead streaks and returns the viewer standing", async () => {
    await seedSongPost()
    await seedSecondSongPost()
    const today = new Date().toISOString().slice(0, 10)
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    const stale = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10)
    // Reads never consult the viewer clock: eligibility comes from the stored
    // active_until_at, so seeds must carry the grace expiry explicitly.
    const lapsedActiveUntil = new Date(Date.now() - 86_400_000).toISOString()
    const activeUntil = new Date(Date.now() + 86_400_000).toISOString()
    await exec(`
      INSERT INTO song_streaks (
        user_id, post_id, community_id, current_streak, best_streak,
        last_qualified_date, streak_started_date, total_qualified_days,
        timezone, timezone_updated_at, active_until_at,
        created_at, updated_at
      )
      VALUES
        (?1, ?2, ?3, 2, 4, ?4, ?5, 5, 'UTC', ?6, ?8, ?6, ?6),
        ('usr_peer', ?2, ?3, 7, 7, ?5, ?5, 7, 'UTC', ?6, ?9, ?6, ?6),
        (?1, ?7, ?3, 3, 3, ?5, ?5, 3, 'UTC', ?6, ?9, ?6, ?6)
    `, [LEARNER_ID, POST_ID, COMMUNITY_ID, stale, yesterday, NOW, SECOND_POST_ID, lapsedActiveUntil, activeUntil])
    await exec(`
      INSERT INTO song_engagement_days (
        user_id, post_id, community_id, activity_date,
        study_attempt_count, study_correct_count, study_target_count,
        karaoke_pass_count, qualified, created_at, updated_at
      )
      VALUES (?1, ?2, ?3, ?4, 3, 2, 5, 0, 0, ?5, ?5)
    `, [LEARNER_ID, POST_ID, COMMUNITY_ID, today, NOW])
    await exec(`
      INSERT INTO song_engagement_days (
        user_id, post_id, community_id, activity_date,
        study_attempt_count, study_correct_count, study_target_count,
        karaoke_pass_count, qualified, created_at, updated_at
      )
      VALUES (?1, ?2, ?3, ?4, 5, 4, 5, 0, 1, ?5, ?5)
    `, [LEARNER_ID, SECOND_POST_ID, COMMUNITY_ID, today, NOW])

    const leaderboard = await getPostStreakLeaderboard({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      limit: 10,
      postId: POST_ID,
      profileRepository: profileRepository as never,
    })

    expect(leaderboard.object).toBe("song_streak_leaderboard")
    expect(leaderboard.date).toBe(today)
    expect(leaderboard.total_active_streaks).toBe(1)
    expect(leaderboard.entries.map((entry) => ({
      active_until_at: entry.active_until_at,
      current_streak: entry.current_streak,
      handle: entry.identity.handle,
      is_viewer: entry.is_viewer,
      rank: entry.rank,
    }))).toEqual([{
      active_until_at: activeUntil,
      current_streak: 7,
      handle: "peer",
      is_viewer: false,
      rank: 1,
    }])
    // Lapsed standing: current_streak projects to 0 and rank drops, while
    // best_streak/total_qualified_days keep the historical record.
    expect(leaderboard.viewer).toEqual({
      active_until_at: lapsedActiveUntil,
      alive: false,
      best_streak: 4,
      current_streak: 0,
      karaoke_passed_today: false,
      qualified_today: false,
      rank: null,
      study_attempts_today: 3,
      study_target_today: 5,
      total_qualified_days: 5,
    })

    const summary = await getPostStreakSummary({
      client: client!,
      postId: POST_ID,
      profileRepository: profileRepository as never,
      userRepository: {} as never,
      userId: LEARNER_ID,
    })
    expect(summary).toEqual({
      entries: leaderboard.entries,
      total_active_streaks: 1,
      viewer: leaderboard.viewer,
    })
    const secondSummary = await getPostStreakSummary({
      client: client!,
      postId: SECOND_POST_ID,
      profileRepository: profileRepository as never,
      userRepository: {} as never,
      userId: LEARNER_ID,
    })

    const response = {
      post: {
        community_id: COMMUNITY_ID,
        post_id: POST_ID,
        post_type: "song",
        status: "published",
      },
    } as LocalizedPostResponse
    const secondResponse = {
      post: {
        community_id: COMMUNITY_ID,
        post_id: SECOND_POST_ID,
        post_type: "song",
        status: "published",
      },
    } as LocalizedPostResponse
    await hydrateSongStreakSummariesForResponses({
      client: client!,
      responses: [response, secondResponse],
      profileRepository: profileRepository as never,
      viewerUserId: LEARNER_ID,
    })
    expect(response.streak_summary).toEqual(summary)
    // Batch summaries skip the per-viewer rank query (rank: null); the
    // single-post read computes it.
    expect(secondSummary?.viewer?.rank).toBe(1)
    expect(secondResponse.streak_summary).toEqual(secondSummary ? {
      ...secondSummary,
      viewer: secondSummary.viewer ? { ...secondSummary.viewer, rank: null } : secondSummary.viewer,
    } : secondSummary)
  })

  test("streak leaderboard gives equal streaks equal rank and anonymizes missing profiles", async () => {
    await seedSongPost()
    const today = new Date().toISOString().slice(0, 10)
    const activeUntil = new Date(Date.now() + 86_400_000).toISOString()
    await exec(`
      INSERT INTO song_streaks (
        user_id, post_id, community_id, current_streak, best_streak,
        last_qualified_date, streak_started_date, total_qualified_days,
        timezone, timezone_updated_at, active_until_at,
        created_at, updated_at
      )
      VALUES
        ('usr_alpha', ?1, ?2, 4, 6, ?3, ?3, 6, 'UTC', ?4, ?5, ?4, ?4),
        ('usr_missing', ?1, ?2, 4, 6, ?3, ?3, 6, 'UTC', ?4, ?5, ?4, ?4),
        ('usr_third', ?1, ?2, 3, 6, ?3, ?3, 6, 'UTC', ?4, ?5, ?4, ?4)
    `, [POST_ID, COMMUNITY_ID, today, NOW, activeUntil])
    const missingProfileRepository = {
      ...profileRepository,
      async listProfilesByUserIds(userIds: string[]) {
        return new Map(userIds
          .filter((userId) => userId !== "usr_missing")
          .map((userId) => [userId, {
            avatar_ref: null,
            display_name: userId,
            global_handle: { label: userId },
            primary_public_handle: null,
          } as never]))
      },
    }

    const leaderboard = await getPostStreakLeaderboard({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      limit: 10,
      postId: POST_ID,
      profileRepository: missingProfileRepository as never,
    })

    expect(leaderboard.entries.map((entry) => ({
      display_name: entry.identity.display_name ?? null,
      rank: entry.rank,
      user_id: entry.identity.user_id,
    }))).toEqual([
      { display_name: "usr_alpha", rank: 1, user_id: "usr_alpha" },
      { display_name: null, rank: 1, user_id: "usr_missing" },
      { display_name: "usr_third", rank: 3, user_id: "usr_third" },
    ])
  })

  test("streak summary hydration reads the viewer pinned-timezone day", async () => {
    await seedSongPost()
    const now = new Date().toISOString()
    // Pick a zone whose calendar date differs from the UTC date right now, so
    // the pinned zone — not any request context — decides which day row counts.
    const currentUtcHour = new Date().getUTCHours()
    const pinnedTimezone = currentUtcHour < 10 ? "Pacific/Honolulu" : "Pacific/Kiritimati"
    const pinnedToday = studyActivityDate(now, pinnedTimezone)
    const utcToday = studyActivityDate(now, "UTC")
    expect(pinnedToday).not.toBe(utcToday)
    const activeUntil = new Date(Date.now() + 86_400_000).toISOString()

    await exec(`
      INSERT INTO song_streaks (
        user_id, post_id, community_id, current_streak, best_streak,
        last_qualified_date, streak_started_date, total_qualified_days,
        timezone, timezone_updated_at, active_until_at,
        created_at, updated_at
      )
      VALUES (?1, ?2, ?3, 1, 1, ?4, ?4, 1, ?5, ?6, ?7, ?6, ?6)
    `, [LEARNER_ID, POST_ID, COMMUNITY_ID, pinnedToday, pinnedTimezone, NOW, activeUntil])
    await exec(`
      INSERT INTO song_engagement_days (
        user_id, post_id, community_id, activity_date, activity_timezone,
        study_attempt_count, study_correct_count, study_target_count,
        karaoke_pass_count, qualified, created_at, updated_at
      )
      VALUES (?1, ?2, ?3, ?4, ?5, 1, 1, 1, 0, 1, ?6, ?6)
    `, [LEARNER_ID, POST_ID, COMMUNITY_ID, pinnedToday, pinnedTimezone, NOW])

    const summary = await getPostStreakSummary({
      client: client!,
      postId: POST_ID,
      profileRepository: profileRepository as never,
      userRepository: {} as never,
      userId: LEARNER_ID,
    })
    expect(summary?.viewer?.qualified_today).toBe(true)
    expect(summary?.viewer?.study_attempts_today).toBe(1)
    expect(summary?.viewer?.study_target_today).toBe(1)

    const response = {
      post: {
        community_id: COMMUNITY_ID,
        post_id: POST_ID,
        post_type: "song",
        status: "published",
      },
    } as LocalizedPostResponse
    await hydrateSongStreakSummariesForResponses({
      client: client!,
      responses: [response],
      profileRepository: profileRepository as never,
      viewerUserId: LEARNER_ID,
    })
    expect(response.streak_summary?.viewer?.qualified_today).toBe(true)
    expect(response.streak_summary?.viewer?.study_attempts_today).toBe(1)
    expect(response.streak_summary?.viewer?.study_target_today).toBe(1)
  })

  // Drives the write path the way the service does: claimStreakTimezonePin
  // (atomic compare-and-swap, commits on its own) THEN prepareStreakWrite
  // (reads the definitive pin) THEN recordCompletedSessionStreak (pure writes).
  async function recordQualifiedDay(input: {
    now: string
    timezoneCandidate?: string
  }): Promise<void> {
    await claimStreakTimezonePin({
      client: client!,
      communityId: COMMUNITY_ID,
      now: input.now,
      postId: POST_ID,
      timezoneCandidate: input.timezoneCandidate,
      userId: LEARNER_ID,
    })
    const preparation = await prepareStreakWrite({
      activityInstant: input.now,
      client: client!,
      now: input.now,
      postId: POST_ID,
      qualified: true,
      timezoneCandidate: input.timezoneCandidate,
      userId: LEARNER_ID,
    })
    await recordCompletedSessionStreak({
      client: client!,
      communityId: COMMUNITY_ID,
      completedExerciseCount: 1,
      firstPassCorrectCount: 1,
      now: input.now,
      postId: POST_ID,
      preparation,
      qualified: true,
      requiredCorrectCount: 1,
      userId: LEARNER_ID,
    })
  }

  test("streak materialization extends consecutive days, resets gaps, and ignores stale qualified dates", async () => {
    await seedSongPost()

    await recordQualifiedDay({ now: "2026-07-01T12:00:00.000Z" })
    await recordQualifiedDay({ now: "2026-07-02T12:00:00.000Z" })

    let streak = await client!.execute("SELECT current_streak, best_streak, streak_started_date, last_qualified_date, total_qualified_days, timezone, active_until_at FROM song_streaks")
    expect(streak.rows.map((row) => ({
      active_until_at: row.active_until_at,
      best_streak: Number(row.best_streak),
      current_streak: Number(row.current_streak),
      last_qualified_date: row.last_qualified_date,
      streak_started_date: row.streak_started_date,
      timezone: row.timezone,
      total_qualified_days: Number(row.total_qualified_days),
    }))).toEqual([{
      active_until_at: "2026-07-04T00:00:00.000Z",
      best_streak: 2,
      current_streak: 2,
      last_qualified_date: "2026-07-02",
      streak_started_date: "2026-07-01",
      timezone: "UTC",
      total_qualified_days: 2,
    }])

    await recordQualifiedDay({ now: "2026-07-01T18:00:00.000Z" })

    streak = await client!.execute("SELECT current_streak, best_streak, streak_started_date, last_qualified_date, total_qualified_days FROM song_streaks")
    expect(streak.rows.map((row) => ({
      best_streak: Number(row.best_streak),
      current_streak: Number(row.current_streak),
      last_qualified_date: row.last_qualified_date,
      streak_started_date: row.streak_started_date,
      total_qualified_days: Number(row.total_qualified_days),
    }))).toEqual([{
      best_streak: 2,
      current_streak: 2,
      last_qualified_date: "2026-07-02",
      streak_started_date: "2026-07-01",
      total_qualified_days: 2,
    }])

    await recordQualifiedDay({ now: "2026-07-04T12:00:00.000Z" })

    streak = await client!.execute("SELECT current_streak, best_streak, streak_started_date, last_qualified_date, total_qualified_days FROM song_streaks")
    expect(streak.rows.map((row) => ({
      best_streak: Number(row.best_streak),
      current_streak: Number(row.current_streak),
      last_qualified_date: row.last_qualified_date,
      streak_started_date: row.streak_started_date,
      total_qualified_days: Number(row.total_qualified_days),
    }))).toEqual([{
      best_streak: 2,
      current_streak: 1,
      last_qualified_date: "2026-07-04",
      streak_started_date: "2026-07-04",
      total_qualified_days: 3,
    }])
  })

  test("study streak days use the learner pinned timezone instead of the UTC calendar", async () => {
    await seedSongPost()

    await recordQualifiedDay({
      now: "2026-07-02T06:30:00.000Z",
      timezoneCandidate: "America/Los_Angeles",
    })
    await recordQualifiedDay({
      now: "2026-07-03T06:30:00.000Z",
      timezoneCandidate: "America/Los_Angeles",
    })

    const days = await client!.execute("SELECT activity_date, activity_timezone, qualified FROM song_engagement_days ORDER BY activity_date")
    expect(days.rows.map((row) => ({
      activity_date: row.activity_date,
      activity_timezone: row.activity_timezone,
      qualified: Number(row.qualified),
    }))).toEqual([
      { activity_date: "2026-07-01", activity_timezone: "America/Los_Angeles", qualified: 1 },
      { activity_date: "2026-07-02", activity_timezone: "America/Los_Angeles", qualified: 1 },
    ])

    const streak = await client!.execute("SELECT current_streak, last_qualified_date, streak_started_date, timezone, active_until_at FROM song_streaks")
    expect(streak.rows.map((row) => ({
      active_until_at: row.active_until_at,
      current_streak: Number(row.current_streak),
      last_qualified_date: row.last_qualified_date,
      streak_started_date: row.streak_started_date,
      timezone: row.timezone,
    }))).toEqual([{
      active_until_at: "2026-07-04T07:00:00.000Z",
      current_streak: 2,
      last_qualified_date: "2026-07-02",
      streak_started_date: "2026-07-01",
      timezone: "America/Los_Angeles",
    }])
  })

  test("first qualifying session pins the device timezone and the leaderboard reflects it immediately", async () => {
    await seedSongPost()
    await seedReadyPack()
    // Local path: the pin is resolved and refreshed inside the write
    // transaction, which requires interactive transactions (see localEnv).
    const attemptEnv = localEnv({ SONG_STUDY_STREAK_WRITES_ENABLED: "true" })
    await completeQualifyingStudySession({
      env: attemptEnv,
      idempotencyPrefix: "study-streak-pin-first",
      timezone: "America/New_York",
    })

    const nyToday = studyActivityDate(new Date().toISOString(), "America/New_York")
    const expectedActiveUntil = endOfGraceUtcInstant(nyToday, "America/New_York")
    const streak = await client!.execute("SELECT current_streak, last_qualified_date, timezone, timezone_updated_at, active_until_at FROM song_streaks")
    expect(streak.rows.map((row) => ({
      active_until_at: row.active_until_at,
      current_streak: Number(row.current_streak),
      last_qualified_date: row.last_qualified_date,
      timezone: row.timezone,
    }))).toEqual([{
      active_until_at: expectedActiveUntil,
      current_streak: 1,
      last_qualified_date: nyToday,
      timezone: "America/New_York",
    }])
    expect(typeof streak.rows[0]?.timezone_updated_at).toBe("string")

    const days = await client!.execute("SELECT activity_date, activity_timezone, qualified FROM song_engagement_days")
    expect(days.rows.map((row) => ({
      activity_date: row.activity_date,
      activity_timezone: row.activity_timezone,
      qualified: Number(row.qualified),
    }))).toEqual([{
      activity_date: nyToday,
      activity_timezone: "America/New_York",
      qualified: 1,
    }])

    // Materialization is inline: the very next read already shows the viewer.
    const leaderboard = await getPostStreakLeaderboard({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: attemptEnv,
      limit: 10,
      postId: POST_ID,
      profileRepository: profileRepository as never,
    })
    expect(leaderboard.total_active_streaks).toBe(1)
    expect(leaderboard.entries.map((entry) => ({
      active_until_at: entry.active_until_at,
      current_streak: entry.current_streak,
      is_viewer: entry.is_viewer,
      rank: entry.rank,
    }))).toEqual([{
      active_until_at: expectedActiveUntil,
      current_streak: 1,
      is_viewer: true,
      rank: 1,
    }])
    expect(leaderboard.viewer).toMatchObject({
      active_until_at: expectedActiveUntil,
      alive: true,
      current_streak: 1,
      qualified_today: true,
      rank: 1,
    })
  })

  test("qualifying session writes a leaderboard-visible streak through the buffered D1 write path", async () => {
    await seedSongPost()
    await seedReadyPack()
    // Default env: COMMUNITY_D1_SHARD routes writes through the D1 client,
    // whose write transactions buffer statements and commit them as one batch
    // (in-tx reads return empty results). Pin resolution and the grace-expiry
    // apply must therefore be read-before-tx + pure-write — this guards the
    // regression where a buffered tx silently dropped both.
    const attemptEnv = env({ SONG_STUDY_STREAK_WRITES_ENABLED: "true" })
    await completeQualifyingStudySession({
      env: attemptEnv,
      idempotencyPrefix: "study-streak-buffered-d1",
      timezone: "America/New_York",
    })

    const nyToday = studyActivityDate(new Date().toISOString(), "America/New_York")
    const expectedActiveUntil = endOfGraceUtcInstant(nyToday, "America/New_York")
    const streak = await client!.execute("SELECT current_streak, last_qualified_date, timezone, active_until_at FROM song_streaks")
    expect(streak.rows.map((row) => ({
      active_until_at: row.active_until_at,
      current_streak: Number(row.current_streak),
      last_qualified_date: row.last_qualified_date,
      timezone: row.timezone,
    }))).toEqual([{
      active_until_at: expectedActiveUntil,
      current_streak: 1,
      last_qualified_date: nyToday,
      timezone: "America/New_York",
    }])

    const leaderboard = await getPostStreakLeaderboard({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: attemptEnv,
      limit: 10,
      postId: POST_ID,
      profileRepository: profileRepository as never,
    })
    expect(leaderboard.total_active_streaks).toBe(1)
    expect(leaderboard.entries.map((entry) => ({
      active_until_at: entry.active_until_at,
      current_streak: entry.current_streak,
      is_viewer: entry.is_viewer,
      rank: entry.rank,
    }))).toEqual([{
      active_until_at: expectedActiveUntil,
      current_streak: 1,
      is_viewer: true,
      rank: 1,
    }])
    expect(leaderboard.viewer).toMatchObject({
      active_until_at: expectedActiveUntil,
      alive: true,
      current_streak: 1,
      rank: 1,
    })
  })

  // Shared assertions for the first-qualification race scenarios: exactly one
  // pin (the first committed claim's zone), both writes merged into ONE
  // engagement day keyed by the winner-tz date, and the grace expiry computed
  // under the winning zone.
  async function expectRaceOutcome(input: {
    loserTimezone: string
    winnerTimezone: string
  }): Promise<void> {
    const instant = new Date().toISOString()
    const winnerDate = studyActivityDate(instant, input.winnerTimezone)
    // The scenario picked zones whose dates differ at this instant — otherwise
    // the merge below would happen regardless of which pin won.
    expect(studyActivityDate(instant, input.loserTimezone)).not.toBe(winnerDate)

    const streak = await client!.execute("SELECT current_streak, best_streak, last_qualified_date, streak_started_date, total_qualified_days, timezone, active_until_at FROM song_streaks")
    expect(streak.rows.map((row) => ({
      active_until_at: row.active_until_at,
      best_streak: Number(row.best_streak),
      current_streak: Number(row.current_streak),
      last_qualified_date: row.last_qualified_date,
      streak_started_date: row.streak_started_date,
      timezone: row.timezone,
      total_qualified_days: Number(row.total_qualified_days),
    }))).toEqual([{
      active_until_at: endOfGraceUtcInstant(winnerDate, input.winnerTimezone),
      best_streak: 1,
      current_streak: 1,
      last_qualified_date: winnerDate,
      streak_started_date: winnerDate,
      timezone: input.winnerTimezone,
      total_qualified_days: 1,
    }])

    const days = await client!.execute("SELECT activity_date, activity_timezone, study_attempt_count, study_correct_count, study_target_count, karaoke_pass_count, qualified FROM song_engagement_days")
    expect(days.rows.map((row) => ({
      activity_date: row.activity_date,
      activity_timezone: row.activity_timezone,
      karaoke_pass_count: Number(row.karaoke_pass_count),
      qualified: Number(row.qualified),
      study_attempt_count: Number(row.study_attempt_count),
      study_correct_count: Number(row.study_correct_count),
      study_target_count: Number(row.study_target_count),
    }))).toEqual([{
      activity_date: winnerDate,
      activity_timezone: input.winnerTimezone,
      karaoke_pass_count: 1,
      qualified: 1,
      study_attempt_count: 3,
      study_correct_count: 3,
      study_target_count: 3,
    }])
  }

  // New York vs a Pacific zone, chosen so the two candidates disagree on the
  // calendar date of "now" (a same-date pair could not prove the loser's zone
  // was overridden). Exactly one of Kiritimati (+14:00) / Honolulu (-10:00)
  // always differs from New York.
  function raceTimezones(): { karaoke: string; study: string } {
    const now = new Date().toISOString()
    const study = "America/New_York"
    const karaoke = studyActivityDate(now, "Pacific/Kiritimati") !== studyActivityDate(now, study)
      ? "Pacific/Kiritimati"
      : "Pacific/Honolulu"
    return { karaoke, study }
  }

  test("first-qualification race: the first committed pin claim wins over a later karaoke claim", async () => {
    await seedSongPost()
    await seedReadyPack()
    const attemptEnv = env({ SONG_STUDY_STREAK_WRITES_ENABLED: "true" })
    const timezones = raceTimezones()
    const now = new Date().toISOString()

    // Claims race: study's commits first, karaoke's identical-moment claim loses.
    await claimStreakTimezonePin({
      client: client!,
      communityId: COMMUNITY_ID,
      now,
      postId: POST_ID,
      timezoneCandidate: timezones.study,
      userId: LEARNER_ID,
    })
    await claimStreakTimezonePin({
      client: client!,
      communityId: COMMUNITY_ID,
      now,
      postId: POST_ID,
      timezoneCandidate: timezones.karaoke,
      userId: LEARNER_ID,
    })

    // Karaoke's write lands first (record order reversed vs claim order); its
    // preparation re-reads the committed winner pin.
    const karaokePreparation = await prepareStreakWrite({
      activityInstant: now,
      client: client!,
      now,
      postId: POST_ID,
      qualified: true,
      timezoneCandidate: timezones.karaoke,
      userId: LEARNER_ID,
    })
    await recordKaraokeAttempt({
      activityDate: studyActivityDate(now, "UTC"),
      client: client!,
      communityId: COMMUNITY_ID,
      completedAt: now,
      completionReason: "completed",
      karaokeRevisionId: "krv_race",
      postId: POST_ID,
      scoringModel: "text-timing-v1",
      scoringProvider: "pirate-karaoke-runtime",
      sessionId: "session_race_study_first",
      attemptId: "attempt_race_study_first",
      streakPreparation: karaokePreparation,
      summary: passingKaraokeSummary(),
      userId: LEARNER_ID,
    })

    // Study's write lands second, through the public path: its own claim loses
    // to the committed pin and its preparation follows the winning zone.
    await completeQualifyingStudySession({
      env: attemptEnv,
      idempotencyPrefix: "study-streak-race-study-first",
      timezone: timezones.study,
    })

    await expectRaceOutcome({
      loserTimezone: timezones.karaoke,
      winnerTimezone: timezones.study,
    })
  })

  test("first-qualification race: a karaoke first claim wins over study even when study writes first", async () => {
    await seedSongPost()
    await seedReadyPack()
    const attemptEnv = env({ SONG_STUDY_STREAK_WRITES_ENABLED: "true" })
    const timezones = raceTimezones()
    const now = new Date().toISOString()

    // Reverse claim order: karaoke's claim commits first and wins.
    await claimStreakTimezonePin({
      client: client!,
      communityId: COMMUNITY_ID,
      now,
      postId: POST_ID,
      timezoneCandidate: timezones.karaoke,
      userId: LEARNER_ID,
    })
    await claimStreakTimezonePin({
      client: client!,
      communityId: COMMUNITY_ID,
      now,
      postId: POST_ID,
      timezoneCandidate: timezones.study,
      userId: LEARNER_ID,
    })

    // Reverse record order too: study writes first this time. The outcome must
    // depend only on claim order, never on prepare/record order.
    await completeQualifyingStudySession({
      env: attemptEnv,
      idempotencyPrefix: "study-streak-race-karaoke-first",
      timezone: timezones.study,
    })
    const karaokePreparation = await prepareStreakWrite({
      activityInstant: now,
      client: client!,
      now,
      postId: POST_ID,
      qualified: true,
      timezoneCandidate: timezones.karaoke,
      userId: LEARNER_ID,
    })
    await recordKaraokeAttempt({
      activityDate: studyActivityDate(now, "UTC"),
      client: client!,
      communityId: COMMUNITY_ID,
      completedAt: now,
      completionReason: "completed",
      karaokeRevisionId: "krv_race",
      postId: POST_ID,
      scoringModel: "text-timing-v1",
      scoringProvider: "pirate-karaoke-runtime",
      sessionId: "session_race_karaoke_first",
      attemptId: "attempt_race_karaoke_first",
      streakPreparation: karaokePreparation,
      summary: passingKaraokeSummary(),
      userId: LEARNER_ID,
    })

    await expectRaceOutcome({
      loserTimezone: timezones.study,
      winnerTimezone: timezones.karaoke,
    })
  })

  test("a committed pin claim with no qualification write is recovered cleanly by the retry", async () => {
    await seedSongPost()
    await seedReadyPack()
    const attemptEnv = env({ SONG_STUDY_STREAK_WRITES_ENABLED: "true" })
    const claimNow = new Date().toISOString()

    // Crashed state: the pin claim committed its placeholder row, then the
    // qualification write failed and landed nothing.
    await claimStreakTimezonePin({
      client: client!,
      communityId: COMMUNITY_ID,
      now: claimNow,
      postId: POST_ID,
      timezoneCandidate: "America/New_York",
      userId: LEARNER_ID,
    })
    const placeholder = await client!.execute("SELECT current_streak, last_qualified_date, timezone, active_until_at FROM song_streaks")
    expect(placeholder.rows.map((row) => ({
      active_until_at: row.active_until_at,
      current_streak: Number(row.current_streak),
      last_qualified_date: row.last_qualified_date,
      timezone: row.timezone,
    }))).toEqual([{
      active_until_at: null,
      current_streak: 0,
      last_qualified_date: "",
      timezone: "America/New_York",
    }])

    // The learner retries; the qualifying session completes this time.
    await completeQualifyingStudySession({
      env: attemptEnv,
      idempotencyPrefix: "study-streak-claim-retry",
      timezone: "America/New_York",
    })

    const nyToday = studyActivityDate(new Date().toISOString(), "America/New_York")
    const expectedActiveUntil = endOfGraceUtcInstant(nyToday, "America/New_York")
    const streak = await client!.execute("SELECT current_streak, best_streak, last_qualified_date, streak_started_date, total_qualified_days, timezone, timezone_updated_at, active_until_at FROM song_streaks")
    expect(streak.rows.map((row) => ({
      active_until_at: row.active_until_at,
      best_streak: Number(row.best_streak),
      current_streak: Number(row.current_streak),
      last_qualified_date: row.last_qualified_date,
      streak_started_date: row.streak_started_date,
      timezone: row.timezone,
      timezone_updated_at: row.timezone_updated_at,
      total_qualified_days: Number(row.total_qualified_days),
    }))).toEqual([{
      // Pin reused, still stamped with the FIRST claim's timestamp: the retry's
      // claim neither adopted nor refreshed it. The placeholder was upgraded
      // in place, not left behind or duplicated.
      active_until_at: expectedActiveUntil,
      best_streak: 1,
      current_streak: 1,
      last_qualified_date: nyToday,
      streak_started_date: nyToday,
      timezone: "America/New_York",
      timezone_updated_at: claimNow,
      total_qualified_days: 1,
    }])

    // Exactly one qualification landed despite the retry.
    const days = await client!.execute("SELECT activity_date, activity_timezone, qualified FROM song_engagement_days")
    expect(days.rows.map((row) => ({
      activity_date: row.activity_date,
      activity_timezone: row.activity_timezone,
      qualified: Number(row.qualified),
    }))).toEqual([{
      activity_date: nyToday,
      activity_timezone: "America/New_York",
      qualified: 1,
    }])

    const leaderboard = await getPostStreakLeaderboard({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: attemptEnv,
      limit: 10,
      postId: POST_ID,
      profileRepository: profileRepository as never,
    })
    expect(leaderboard.total_active_streaks).toBe(1)
    expect(leaderboard.entries.map((entry) => ({
      current_streak: entry.current_streak,
      is_viewer: entry.is_viewer,
      rank: entry.rank,
    }))).toEqual([{
      current_streak: 1,
      is_viewer: true,
      rank: 1,
    }])
    expect(leaderboard.viewer).toMatchObject({
      active_until_at: expectedActiveUntil,
      alive: true,
      current_streak: 1,
      rank: 1,
    })
  })

  test("a second qualification inside the 7-day window keeps the original pin", async () => {
    await seedSongPost()
    await seedReadyPack()
    const now = new Date().toISOString()
    const nyToday = studyActivityDate(now, "America/New_York")
    const nyYesterday = addUtcDays(nyToday, -1)
    // Existing pin from a recent first qualification; still alive in the grace day.
    await exec(`
      INSERT INTO song_streaks (
        user_id, post_id, community_id, current_streak, best_streak,
        last_qualified_date, streak_started_date, total_qualified_days,
        timezone, timezone_updated_at, active_until_at,
        created_at, updated_at
      )
      VALUES (?1, ?2, ?3, 1, 1, ?4, ?4, 1, 'America/New_York', ?5, ?6, ?5, ?5)
    `, [
      LEARNER_ID,
      POST_ID,
      COMMUNITY_ID,
      nyYesterday,
      now,
      endOfGraceUtcInstant(nyYesterday, "America/New_York"),
    ])

    await completeQualifyingStudySession({
      env: localEnv({ SONG_STUDY_STREAK_WRITES_ENABLED: "true" }),
      idempotencyPrefix: "study-streak-pin-kept",
      timezone: "Pacific/Kiritimati",
    })

    // The pinned zone wins: day key, streak extension, and grace expiry all
    // follow America/New_York, and the pin timestamp is untouched.
    const streak = await client!.execute("SELECT current_streak, last_qualified_date, timezone, timezone_updated_at, active_until_at FROM song_streaks")
    expect(streak.rows.map((row) => ({
      active_until_at: row.active_until_at,
      current_streak: Number(row.current_streak),
      last_qualified_date: row.last_qualified_date,
      timezone: row.timezone,
      timezone_updated_at: row.timezone_updated_at,
    }))).toEqual([{
      active_until_at: endOfGraceUtcInstant(nyToday, "America/New_York"),
      current_streak: 2,
      last_qualified_date: nyToday,
      timezone: "America/New_York",
      timezone_updated_at: now,
    }])

    const days = await client!.execute("SELECT activity_date, activity_timezone, qualified FROM song_engagement_days")
    expect(days.rows.map((row) => ({
      activity_date: row.activity_date,
      activity_timezone: row.activity_timezone,
      qualified: Number(row.qualified),
    }))).toEqual([{
      activity_date: nyToday,
      activity_timezone: "America/New_York",
      qualified: 1,
    }])
  })

  test("viewer rank shares a tied rank and counts the streaks ahead", async () => {
    await seedSongPost()
    const today = new Date().toISOString().slice(0, 10)
    const yesterday = addUtcDays(today, -1)
    const activeUntil = new Date(Date.now() + 86_400_000).toISOString()
    await exec(`
      INSERT INTO song_streaks (
        user_id, post_id, community_id, current_streak, best_streak,
        last_qualified_date, streak_started_date, total_qualified_days,
        timezone, timezone_updated_at, active_until_at,
        created_at, updated_at
      )
      VALUES
        ('usr_leader', ?1, ?2, 5, 5, ?3, ?4, 5, 'UTC', ?5, ?6, ?5, ?5),
        ('usr_peer', ?1, ?2, 3, 4, ?3, ?4, 4, 'UTC', ?5, ?6, ?5, ?5),
        (?7, ?1, ?2, 3, 4, ?3, ?3, 4, 'UTC', ?5, ?6, ?5, ?5)
    `, [POST_ID, COMMUNITY_ID, today, yesterday, NOW, activeUntil, LEARNER_ID])

    const leaderboard = await getPostStreakLeaderboard({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      limit: 10,
      postId: POST_ID,
      profileRepository: profileRepository as never,
    })

    expect(leaderboard.entries.map((entry) => ({
      rank: entry.rank,
      user_id: entry.identity.user_id,
    }))).toEqual([
      { rank: 1, user_id: "usr_leader" },
      { rank: 2, user_id: "usr_peer" },
      { rank: 2, user_id: LEARNER_ID },
    ])
    expect(leaderboard.viewer).toMatchObject({
      alive: true,
      current_streak: 3,
      rank: 2,
    })
  })

  test("lapsed streak projects zero in the viewer standing and the attempt snapshot", async () => {
    await seedSongPost()
    await seedReadyPack()
    const stale = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10)
    const lapsedActiveUntil = new Date(Date.now() - 86_400_000).toISOString()
    await exec(`
      INSERT INTO song_streaks (
        user_id, post_id, community_id, current_streak, best_streak,
        last_qualified_date, streak_started_date, total_qualified_days,
        timezone, timezone_updated_at, active_until_at,
        created_at, updated_at
      )
      VALUES (?1, ?2, ?3, 5, 8, ?4, ?4, 9, 'UTC', ?5, ?6, ?5, ?5)
    `, [LEARNER_ID, POST_ID, COMMUNITY_ID, stale, NOW, lapsedActiveUntil])

    const leaderboard = await getPostStreakLeaderboard({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      limit: 10,
      postId: POST_ID,
      profileRepository: profileRepository as never,
    })
    expect(leaderboard.total_active_streaks).toBe(0)
    expect(leaderboard.entries).toEqual([])
    expect(leaderboard.viewer).toMatchObject({
      active_until_at: lapsedActiveUntil,
      alive: false,
      best_streak: 8,
      current_streak: 0,
      qualified_today: false,
      rank: null,
      total_qualified_days: 9,
    })

    // A completed but unqualified session keeps the lapsed projection at 0 in
    // the attempt snapshot too (the stored count is historical only).
    const attemptEnv = env({ SONG_STUDY_STREAK_WRITES_ENABLED: "true" })
    const finalAttempt = await completeUnqualifiedStudySession({
      env: attemptEnv,
      idempotencyPrefix: "study-streak-lapsed",
    })
    expect(finalAttempt.study_progress).toMatchObject({
      current_streak: 0,
      qualified_today: false,
      study_attempt_count: 3,
      study_correct_count: 0,
      study_target_count: 3,
    })
  })

  test("resumes the fixed session with mastered-card progress", async () => {
    await seedSongPost()
    await seedReadyPack()

    await submitPostStudyAttempt({
      actor: learnerActor,
      body: {
        attempt_number: 1,
        exercise_id: "stu:stu_2:translation_choice:es",
        idempotency_key: "study-attempt-filter-choice",
        selected_option_id: "opt_a",
        type: "translation_choice",
      },
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
    })

    const payload = await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
      targetLanguage: "es",
    })

    expect(payload.access).toBe("ready")
    expect(payload.exercise_count).toBe(3)
    expect(payload.exercises.map((exercise) => exercise.id)).toEqual([
      "stu:stu_1:say_it_back:en",
      "stu:stu_2:say_it_back:en",
      "stu:stu_2:translation_choice:es",
    ])
    expect(payload.exercises.find((exercise) => exercise.id === "stu:stu_2:translation_choice:es"))
      .toMatchObject({ first_outcome: "correct", mastered: true, presentation_count: 1 })
  })

  test("returns a ready empty pack after the learner has attempted every exercise", async () => {
    await seedSongPost()
    await seedReadyPack()

    await submitPostStudyAttempt({
      actor: learnerActor,
      body: {
        attempt_number: 1,
        exercise_id: "stu:stu_1:say_it_back:en",
        idempotency_key: "study-attempt-complete-say-1",
        transcript: "I was lost in the midnight waves",
        type: "say_it_back",
      },
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
    })
    await submitPostStudyAttempt({
      actor: learnerActor,
      body: {
        attempt_number: 1,
        exercise_id: "stu:stu_2:say_it_back:en",
        idempotency_key: "study-attempt-complete-say-2",
        transcript: "Hold me close until the morning",
        type: "say_it_back",
      },
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
    })
    await submitPostStudyAttempt({
      actor: learnerActor,
      body: {
        attempt_number: 1,
        exercise_id: "stu:stu_2:translation_choice:es",
        idempotency_key: "study-attempt-complete-choice",
        selected_option_id: "opt_a",
        type: "translation_choice",
      },
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
    })
    await exec(`
      UPDATE song_study_review_state
      SET due_at = '2100-01-01T00:00:00.000Z'
      WHERE user_id = ?1
        AND post_id = ?2
    `, [LEARNER_ID, POST_ID])
    await exec("UPDATE song_study_session SET status = 'expired' WHERE user_id = ?1 AND post_id = ?2", [LEARNER_ID, POST_ID])

    const payload = await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
      targetLanguage: "es",
    })

    expect(payload.access).toBe("ready")
    expect(payload.exercise_count).toBe(0)
    expect(payload.exercises).toEqual([])
    expect(payload.session).toMatchObject({
      due_count: 0,
      next_due_at: 4102444800,
      served_count: 0,
      total_units: 3,
    })
  })

  test("keeps due reviews hidden until the re-serving rollout flag is enabled", async () => {
    await seedSongPost()
    await seedReadyPack()

    await submitPostStudyAttempt({
      actor: learnerActor,
      body: {
        attempt_number: 1,
        exercise_id: "stu:stu_1:say_it_back:en",
        idempotency_key: "study-review-prereq-say-1",
        transcript: "I was lost in the midnight waves",
        type: "say_it_back",
      },
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
    })

    await submitPostStudyAttempt({
      actor: learnerActor,
      body: {
        attempt_number: 1,
        exercise_id: "stu:stu_2:say_it_back:en",
        idempotency_key: "study-review-prereq-say-2",
        transcript: "Hold me close until the morning",
        type: "say_it_back",
      },
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
    })

    await submitPostStudyAttempt({
      actor: learnerActor,
      body: {
        attempt_number: 1,
        exercise_id: "stu:stu_2:translation_choice:es",
        idempotency_key: "study-review-prereq-choice-learn",
        selected_option_id: "opt_a",
        type: "translation_choice",
      },
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
    })

    await exec(`
      UPDATE song_study_review_state
      SET due_at = CASE
        WHEN line_id = 'line_002' AND exercise_type = 'translation_choice'
          THEN '2026-06-28T08:00:00.000Z'
        ELSE '2100-01-01T00:00:00.000Z'
      END
      WHERE user_id = ?1
        AND post_id = ?2
    `, [LEARNER_ID, POST_ID])

    const hiddenPayload = await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
      targetLanguage: "es",
    })

    expect(hiddenPayload.access).toBe("ready")
    expect(hiddenPayload.exercise_count).toBe(0)
    expect(hiddenPayload.exercises).toEqual([])
    expect(hiddenPayload.session).toMatchObject({
      due_count: 0,
      next_due_at: 4102444800,
      served_count: 0,
      total_units: 3,
    })

    const duePayload = await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env({ SONG_STUDY_DUE_REVIEW_SERVING_ENABLED: "true" }),
      postId: POST_ID,
      targetLanguage: "es",
    })

    expect(duePayload.access).toBe("ready")
    expect(duePayload.exercise_count).toBe(1)
    expect(duePayload.exercises.map((exercise) => exercise.id)).toEqual(["stu:stu_2:translation_choice:es"])
    expect(duePayload.exercises[0]).not.toHaveProperty("correct_option_id")
    expect(duePayload.session).toMatchObject({
      due_count: 1,
      served_count: 1,
      total_units: 3,
    })

    // Once selected into a server-owned session, the card remains valid even if
    // the rollout flag changes between the GET and attempt POST.
    const reviewAttempt = await submitPostStudyAttempt({
      actor: learnerActor,
      body: {
        attempt_number: 1,
        exercise_id: "stu:stu_2:translation_choice:es",
        idempotency_key: "study-review-choice-due",
        selected_option_id: "opt_a",
        type: "translation_choice",
      },
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env({ SONG_STUDY_DUE_REVIEW_SERVING_ENABLED: "true" }),
      postId: POST_ID,
    })
    expect(reviewAttempt.outcome).toBe("correct")

    const attempts = await client!.execute({
      sql: `
        SELECT attempt_number, idempotency_key
        FROM song_study_attempt
        WHERE user_id = ?1
          AND exercise_id = 'stu:stu_2:translation_choice:es'
        ORDER BY created_at ASC, idempotency_key ASC
      `,
      args: [LEARNER_ID],
    })
    expect(attempts.rows.map((row) => ({
      attempt_number: Number(row.attempt_number),
      idempotency_key: String(row.idempotency_key),
    }))).toEqual([
      {
        attempt_number: 1,
        idempotency_key: "study-review-prereq-choice-learn",
      },
      {
        attempt_number: 1,
        idempotency_key: "study-review-choice-due",
      },
    ])
  })

  test("serves due reviews before new cards when due-review serving is enabled", async () => {
    await seedSongPost()
    await seedReadyPack()

    await submitPostStudyAttempt({
      actor: learnerActor,
      body: {
        attempt_number: 1,
        exercise_id: "stu:stu_2:translation_choice:es",
        idempotency_key: "study-due-first-prereq-choice",
        selected_option_id: "opt_a",
        type: "translation_choice",
      },
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
    })
    await exec(`
      UPDATE song_study_review_state
      SET due_at = '2026-06-28T08:00:00.000Z'
      WHERE user_id = ?1
        AND post_id = ?2
        AND line_id = 'line_002'
        AND exercise_type = 'translation_choice'
    `, [LEARNER_ID, POST_ID])

    await exec("UPDATE song_study_session SET status = 'expired' WHERE user_id = ?1 AND post_id = ?2", [LEARNER_ID, POST_ID])
    const payload = await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env({ SONG_STUDY_DUE_REVIEW_SERVING_ENABLED: "true" }),
      postId: POST_ID,
      targetLanguage: "es",
    })

    expect(payload.access).toBe("ready")
    expect(payload.exercises.map((exercise) => `${exercise.line_id}:${exercise.type}`)).toEqual([
      "line_002:translation_choice",
      "line_001:say_it_back",
      "line_002:say_it_back",
    ])
  })

  test("rejects conflicting idempotency-key reuse", async () => {
    await seedSongPost()
    await seedReadyPack()

    await submitPostStudyAttempt({
      actor: learnerActor,
      body: {
        attempt_number: 1,
        exercise_id: "stu:stu_2:translation_choice:es",
        idempotency_key: "study-attempt-conflict",
        selected_option_id: "opt_a",
        type: "translation_choice",
      },
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
    })

    await expect(submitPostStudyAttempt({
      actor: learnerActor,
      body: {
        attempt_number: 1,
        exercise_id: "stu:stu_2:translation_choice:es",
        idempotency_key: "study-attempt-conflict",
        selected_option_id: "opt_b",
        type: "translation_choice",
      },
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
    })).rejects.toThrow(/idempotency_key/)
  })

  test("say-it-back returns token feedback and stores only the final transcript", async () => {
    await seedSongPost()
    await seedReadyPack()

    const result = await submitPostStudyAttempt({
      actor: learnerActor,
      body: {
        attempt_number: 1,
        exercise_id: "stu:stu_1:say_it_back:en",
        idempotency_key: "study-attempt-say-1",
        transcript: "I was in the midnight waves",
        type: "say_it_back",
      },
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
    })

    expect(result.outcome).toBe("incorrect")
    expect(result.next_review_hint).toBe("again")
    expect(result.feedback?.missing).toContain("lost")

    const row = await client!.execute("SELECT transcript FROM song_study_attempt LIMIT 1")
    expect(row.rows[0]?.transcript).toBe("I was in the midnight waves")
    const state = await client!.execute("SELECT state, lapses FROM song_study_review_state LIMIT 1")
    expect(state.rows[0]).toMatchObject({ lapses: 1, state: "learning" })
  })

  test("say-it-back accepts common article and plural recall variants", async () => {
    await seedSongPost()
    await seedReadyPack()

    const result = await submitPostStudyAttempt({
      actor: learnerActor,
      body: {
        attempt_number: 1,
        exercise_id: "stu:stu_1:say_it_back:en",
        idempotency_key: "study-attempt-say-tolerant",
        transcript: "I was lost in midnight wave",
        type: "say_it_back",
      },
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
    })

    expect(result.outcome).toBe("correct")
    expect(result.next_review_hint).toBe("good")
    expect(result.feedback).toBeUndefined()
  })

  test("say-it-back accepts a phonetic near-miss as hard without token feedback", async () => {
    await seedSongPost()
    await seedReadyPack()

    const result = await submitPostStudyAttempt({
      actor: learnerActor,
      body: {
        attempt_number: 1,
        exercise_id: "stu:stu_1:say_it_back:en",
        idempotency_key: "study-attempt-say-phonetic",
        transcript: "I was lost in the midnight waved",
        type: "say_it_back",
      },
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
    })

    expect(result.outcome).toBe("correct")
    expect(result.next_review_hint).toBe("hard")
    expect(result.feedback).toBeUndefined()

    const row = await client!.execute("SELECT feedback_json, fsrs_rating FROM song_study_attempt LIMIT 1")
    expect(row.rows[0]).toMatchObject({ feedback_json: null, fsrs_rating: "hard" })
  })

  test("say-it-back keeps clearly wrong recall on again", async () => {
    await seedSongPost()
    await seedReadyPack()

    const result = await submitPostStudyAttempt({
      actor: learnerActor,
      body: {
        attempt_number: 1,
        exercise_id: "stu:stu_1:say_it_back:en",
        idempotency_key: "study-attempt-say-wrong",
        transcript: "blue road",
        type: "say_it_back",
      },
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
    })

    expect(result.outcome).toBe("incorrect")
    expect(result.next_review_hint).toBe("again")
    const state = await client!.execute("SELECT state, lapses FROM song_study_review_state LIMIT 1")
    expect(state.rows[0]).toMatchObject({ lapses: 1, state: "learning" })
  })

  test("say-it-back uses strict fallback normalization for non-English source lyrics", async () => {
    await seedNonEnglishSongPost()

    const payload = await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
      targetLanguage: "en",
    })
    expect(payload.access).toBe("ready")
    expect(payload.exercises[0]).toMatchObject({
      reference_text: "perdido en olas",
      type: "say_it_back",
    })
    const exerciseId = payload.exercises[0]?.id ?? ""

    const result = await submitPostStudyAttempt({
      actor: learnerActor,
      body: {
        attempt_number: 1,
        exercise_id: exerciseId,
        idempotency_key: "study-attempt-say-spanish-fallback",
        transcript: "perdido en ola",
        type: "say_it_back",
      },
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
    })

    expect(result.outcome).toBe("incorrect")
    expect(result.next_review_hint).toBe("again")
    expect(result.feedback).toMatchObject({
      extra: ["ola"],
      missing: ["olas"],
    })
  })

  test("say-it-back grades partial recall for space-less source scripts", async () => {
    await seedJapaneseSongPost()

    const payload = await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
      targetLanguage: "en",
    })

    expect(payload.access).toBe("ready")
    expect(payload.exercises[0]).toMatchObject({
      reference_text: "夜の波に迷った",
      type: "say_it_back",
    })

    const result = await submitPostStudyAttempt({
      actor: learnerActor,
      body: {
        attempt_number: 1,
        exercise_id: payload.exercises[0]?.id ?? "",
        idempotency_key: "study-attempt-say-japanese-partial",
        transcript: "夜の波",
        type: "say_it_back",
      },
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
    })

    expect(result.outcome).toBe("incorrect")
    expect(result.feedback?.matched?.length ?? 0).toBeGreaterThan(0)
    expect(result.feedback?.missing?.length ?? 0).toBeGreaterThan(0)
  })

  test("say-it-back review state is shared across target languages", async () => {
    await seedSongPost()
    await seedReadyPack()

    await submitPostStudyAttempt({
      actor: learnerActor,
      body: {
        attempt_number: 1,
        exercise_id: "stu:stu_1:say_it_back:en",
        idempotency_key: "study-attempt-say-shared",
        transcript: "I was lost in the midnight waves",
        type: "say_it_back",
      },
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
    })

    const rows = await client!.execute(`
      SELECT exercise_type, target_language, reps
      FROM song_study_review_state
      WHERE user_id = ?1 AND post_id = ?2 AND line_id = 'line_001'
      ORDER BY target_language ASC
    `, [LEARNER_ID, POST_ID])

    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]).toMatchObject({
      exercise_type: "say_it_back",
      target_language: "en",
      reps: 1,
    })
  })

  test("review state schedules future due dates and records repeated reviews", async () => {
    await seedSongPost()
    await seedReadyPack()

    await submitPostStudyAttempt({
      actor: learnerActor,
      body: {
        attempt_number: 1,
        exercise_id: "stu:stu_1:say_it_back:en",
        idempotency_key: "study-attempt-review-schedule-1",
        transcript: "I was lost in the midnight waves",
        type: "say_it_back",
      },
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
    })

    const first = await client!.execute(`
      SELECT due_at, stability
      FROM song_study_review_state
      WHERE user_id = ?1 AND post_id = ?2 AND line_id = 'line_001'
      LIMIT 1
    `, [LEARNER_ID, POST_ID])
    expect(Date.parse(String(first.rows[0]?.due_at ?? ""))).toBeGreaterThan(Date.parse(NOW))

    await exec("UPDATE song_study_session SET status = 'expired' WHERE user_id = ?1 AND post_id = ?2", [LEARNER_ID, POST_ID])
    await exec(`
      UPDATE song_study_review_state SET due_at = '2026-06-28T08:00:00.000Z'
      WHERE user_id = ?1 AND post_id = ?2 AND line_id = 'line_001'
    `, [LEARNER_ID, POST_ID])

    await submitPostStudyAttempt({
      actor: learnerActor,
      body: {
        attempt_number: 1,
        exercise_id: "stu:stu_1:say_it_back:en",
        idempotency_key: "study-attempt-review-schedule-2",
        transcript: "I was lost in the midnight waves",
        type: "say_it_back",
      },
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env({ SONG_STUDY_DUE_REVIEW_SERVING_ENABLED: "true" }),
      postId: POST_ID,
    })

    const second = await client!.execute(`
      SELECT due_at, reps, stability
      FROM song_study_review_state
      WHERE user_id = ?1 AND post_id = ?2 AND line_id = 'line_001'
      LIMIT 1
    `, [LEARNER_ID, POST_ID])
    expect(Number(second.rows[0]?.reps ?? 0)).toBe(2)
    expect(Number(second.rows[0]?.stability ?? 0)).toBeGreaterThan(0)
    expect(Date.parse(String(second.rows[0]?.due_at ?? ""))).toBeGreaterThan(Date.parse(NOW))
  })

  test("transcription gates entitlement before calling STT", async () => {
    await seedSongPost("locked")

    let fetchCalled = false
    await withMockedFetch(() => (async () => {
      fetchCalled = true
      return new Response("unexpected", { status: 500 })
    }) as typeof fetch, async () => {
      await expect(transcribePostStudyAudio({
        actor: learnerActor,
        communityId: COMMUNITY_ID,
        communityRepository: repo,
        env: env(),
        file: new File([new Uint8Array([1, 2, 3])], "attempt.webm", { type: "audio/webm" }),
        postId: POST_ID,
      })).rejects.toThrow(/entitled/)
    })

    expect(fetchCalled).toBe(false)
  })

  test("transcription is blocked before STT when study is disabled", async () => {
    await setStudyEnabled(false)
    await seedSongPost()

    let fetchCalled = false
    await withMockedFetch(() => (async () => {
      fetchCalled = true
      return new Response("unexpected", { status: 500 })
    }) as typeof fetch, async () => {
      await expect(transcribePostStudyAudio({
        actor: learnerActor,
        communityId: COMMUNITY_ID,
        communityRepository: repo,
        env: env(),
        file: new File([new Uint8Array([1, 2, 3])], "attempt.webm", { type: "audio/webm" }),
        postId: POST_ID,
      })).rejects.toThrow(/disabled/)
    })

    expect(fetchCalled).toBe(false)
  })

  test("transcription reports a study-scoped missing ElevenLabs key", async () => {
    const missingCredentialEnv = await createEmptyCredentialEnv()
    await seedSongPost()

    let fetchCalled = false
    await withMockedFetch(() => (async () => {
      fetchCalled = true
      return new Response("unexpected", { status: 500 })
    }) as typeof fetch, async () => {
      await expect(transcribePostStudyAudio({
        actor: learnerActor,
        communityId: COMMUNITY_ID,
        communityRepository: repo,
        env: missingCredentialEnv,
        file: new File([new Uint8Array([1, 2, 3])], "attempt.webm", { type: "audio/webm" }),
        postId: POST_ID,
      })).rejects.toThrow(/say-it-back transcription/)
    })

    expect(fetchCalled).toBe(false)
  })

  test("transcription accepts MediaRecorder audio/webm;codecs=opus (base type gate)", async () => {
    await setStudyEnabled(true)
    await seedSongPost()

    let err: unknown
    await withMockedFetch(() => (async () => new Response("unexpected", { status: 500 })) as typeof fetch, async () => {
      try {
        await transcribePostStudyAudio({
          actor: learnerActor,
          communityId: COMMUNITY_ID,
          communityRepository: repo,
          env: env(),
          file: new File([new Uint8Array([1, 2, 3])], "say-it-back.webm", { type: "audio/webm;codecs=opus" }),
          postId: POST_ID,
        })
      } catch (caught) {
        err = caught
      }
    })

    // The codec-parameterized MediaRecorder type must clear the mime gate (it may
    // still fail later on ElevenLabs config, but never on the unsupported-type check).
    expect(String((err as Error | undefined)?.message ?? "")).not.toContain("audio file type is not supported")
  })

  test("attempts are blocked without writes when study is disabled", async () => {
    await setStudyEnabled(false)
    await seedSongPost()
    await seedReadyPack()

    await expect(submitPostStudyAttemptRaw({
      actor: learnerActor,
      body: {
        attempt_number: 1,
        exercise_id: "stu:stu_1:say_it_back:en",
        idempotency_key: "study-attempt-disabled",
        session_id: "sts_disabled",
        transcript: "I was lost in the midnight waves",
        type: "say_it_back",
      },
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
    })).rejects.toThrow(/disabled/)

    const attempts = await client!.execute("SELECT COUNT(*) AS count FROM song_study_attempt")
    expect(Number(attempts.rows[0]?.count ?? 0)).toBe(0)
  })

  test("missing generated pack lazily creates say-it-back exercises from gated lyrics", async () => {
    await seedSongPost()

    const payload = await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
      targetLanguage: "es",
    })

    expect(payload.access).toBe("ready")
    expect(payload.exercise_count).toBe(1)
    expect(payload.exercises[0]).toMatchObject({
      line_id: "line_001",
      line_index: 0,
      prompt_text: "I was lost in the midnight waves",
      reference_text: "I was lost in the midnight waves",
      type: "say_it_back",
    })
    const packs = await client!.execute("SELECT COUNT(*) AS count FROM song_study_unit")
    expect(Number(packs.rows[0]?.count ?? 0)).toBe(1)
  })

  test("lazy generation creates translation-choice exercises from validated provider output", async () => {
    await seedMultilineSongPost()

    const generationEnv = env({
      OPENROUTER_API_KEY: "test-openrouter-key",
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_TRANSLATION_MODEL: "test/study-generator",
    })
    let fetchCalledByGet = false
    const firstPayload = await withMockedFetch(() => (async () => {
      fetchCalledByGet = true
      return new Response("unexpected", { status: 500 })
    }) as typeof fetch, async () => getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: generationEnv,
      postId: POST_ID,
      targetLanguage: "es",
    }))

    expect(firstPayload.access).toBe("ready")
    expect(firstPayload.exercise_count).toBe(2)
    expect(firstPayload.exercises.every((exercise) => exercise.type === "say_it_back")).toBe(true)
    expect(fetchCalledByGet).toBe(false)
    const processingRows = await client!.execute("SELECT COUNT(*) AS count FROM song_study_unit_localization WHERE status = 'processing'")
    expect(Number(processingRows.rows[0]?.count ?? 0)).toBe(2)

    const jobResult = await withMockedFetch(() => (async () => {
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                lines: [
                  {
                    line_id: "line_001",
                    source_text: "I was lost in the midnight waves",
                    translation: "Me perdí en las olas de medianoche",
                    explanation: "Esta opción conserva el sentido de perderse en las olas.",
                    distractors: [
                      "Encontré mi camino al amanecer",
                      "Corrí lejos de la ciudad",
                      "Dormí bajo las estrellas",
                    ],
                  },
                  {
                    line_id: "line_002",
                    source_text: "Hold me close until the morning",
                    translation: "Abrázame fuerte hasta la mañana",
                    explanation: "Esta opción expresa cercanía hasta la mañana.",
                    distractors: [
                      "Déjame ir antes del amanecer",
                      "Canta conmigo toda la noche",
                      "Espera hasta que cambie el viento",
                    ],
                  },
                ],
              }),
            },
          },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch, async () => runStudyGenerationJob({
      env: generationEnv,
      targetLanguage: "es",
    }))

    expect(jobResult).toBe("ready:es")
    const readyRun = await client!.execute(`
      SELECT status, completed_at
      FROM song_study_generation_run
      WHERE post_id = ?1 AND target_language = 'es'
    `, [POST_ID])
    expect(readyRun.rows[0]?.status).toBe("ready")
    expect(typeof readyRun.rows[0]?.completed_at).toBe("string")

    const payload = await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: generationEnv,
      postId: POST_ID,
      targetLanguage: "es",
    })

    expect(payload.access).toBe("ready")
    expect(payload.exercise_count).toBe(4)
    expect(payload.exercises.map((exercise) => exercise.type)).toEqual([
      "say_it_back",
      "say_it_back",
      "translation_choice",
      "translation_choice",
    ])
    const choice = payload.exercises.find((exercise) => exercise.type === "translation_choice")
    expect(choice).toMatchObject({
      line_id: "line_001",
      prompt_text: "I was lost in the midnight waves",
      question: "Choose the best translation.",
      type: "translation_choice",
    })
    expect(JSON.stringify(payload)).toContain("Me perdí en las olas de medianoche")
    expect(JSON.stringify(payload)).not.toContain("correct_option_id")

    const rows = await client!.execute(`
      SELECT correct_option_id, translation_text, explanation_text
      FROM song_study_unit_localization
      ORDER BY target_language ASC
    `)
    expect(rows.rows.some((row) => row.correct_option_id && row.translation_text)).toBe(true)
    expect(rows.rows.some((row) => row.explanation_text)).toBe(true)
  })

  test("lazy generation keeps valid chunks when another chunk fails validation", async () => {
    await seedMultilineSongPost()

    const generationEnv = env({
      OPENROUTER_API_KEY: "test-openrouter-key",
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_STUDY_GENERATION_CHUNK_SIZE: "1",
    })

    await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: generationEnv,
      postId: POST_ID,
      targetLanguage: "es",
    })

    let callCount = 0
    const jobResult = await withMockedFetch(() => (async () => {
      callCount += 1
      if (callCount === 1) {
        return new Response(JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  lines: [
                    {
                      line_id: "line_001",
                      source_text: "I was lost in the midnight waves",
                      translation: "Me perdí en las olas de medianoche",
                      explanation: "Esta opción conserva el sentido de perderse.",
                      distractors: [
                        "Me encontré junto a las olas de medianoche",
                        "Me perdí entre luces al amanecer",
                        "Nadé tranquilo bajo la luna",
                      ],
                    },
                  ],
                }),
              },
            },
          ],
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ lines: [] }) } }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch, async () => runStudyGenerationJob({
      env: generationEnv,
      targetLanguage: "es",
    }))

    expect(callCount).toBe(2)
    expect(jobResult).toContain("ready_partial:es")
    expect(jobResult).toContain("schema_shape")

    const payload = await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: generationEnv,
      postId: POST_ID,
      targetLanguage: "es",
    })

    expect(payload.access).toBe("ready")
    expect(payload.exercises.map((exercise) => exercise.type)).toEqual([
      "say_it_back",
      "say_it_back",
      "translation_choice",
    ])
    const statusRows = await client!.execute(`
      SELECT status, COUNT(*) AS count
      FROM song_study_unit_localization
      GROUP BY status
      ORDER BY status
    `)
    expect(statusRows.rows).toEqual([
      { status: "ready", count: 1 },
      { status: "unavailable", count: 1 },
    ])
  })

  test("lazy generation keeps valid lines when another line in the same chunk fails validation", async () => {
    await seedMultilineSongPost()

    const generationEnv = env({
      OPENROUTER_API_KEY: "test-openrouter-key",
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_STUDY_GENERATION_CHUNK_SIZE: "10",
    })

    await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: generationEnv,
      postId: POST_ID,
      targetLanguage: "es",
    })

    let callCount = 0
    const jobResult = await withMockedFetch(() => (async () => {
      callCount += 1
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                lines: [
                  {
                    line_id: "line_001",
                    source_text: "I was lost in the midnight waves",
                    translation: "Me perdí en las olas de medianoche",
                    explanation: "Esta opción conserva el sentido de perderse.",
                    distractors: [
                      "Me encontré junto a las olas de medianoche",
                      "Me perdí entre luces al amanecer",
                      "Nadé tranquilo bajo la luna",
                    ],
                  },
                  {
                    line_id: "line_002",
                    source_text: "Hold me close until the morning",
                    translation: "Abrázame fuerte hasta la mañana",
                    explanation: "Esta línea falla por distractores iguales a la respuesta.",
                    distractors: [
                      "Abrázame fuerte hasta la mañana",
                      "Abrázame fuerte hasta la mañana",
                      "Abrázame fuerte hasta la mañana",
                    ],
                  },
                ],
              }),
            },
          },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch, async () => runStudyGenerationJob({
      env: generationEnv,
      targetLanguage: "es",
    }))

    expect(callCount).toBe(1)
    expect(jobResult).toContain("ready_partial:es")
    expect(jobResult).toContain("skipped=1")
    expect(jobResult).toContain("skip_errors=schema_invalid_distractors")

    const payload = await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: generationEnv,
      postId: POST_ID,
      targetLanguage: "es",
    })

    expect(payload.access).toBe("ready")
    expect(payload.exercises.map((exercise) => exercise.type)).toEqual([
      "say_it_back",
      "say_it_back",
      "translation_choice",
    ])
  })

  test("rejects a line whose echoed source_text belongs to a different line (chunk drift)", async () => {
    await seedMultilineSongPost()

    const generationEnv = env({
      OPENROUTER_API_KEY: "test-openrouter-key",
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_STUDY_GENERATION_CHUNK_SIZE: "10",
    })

    await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: generationEnv,
      postId: POST_ID,
      targetLanguage: "es",
    })

    // line_001 echoes line_002's source text — the off-by-one drift. Its translation
    // ("Abrázame fuerte…") is actually line_002's answer, so serving it would be a wrong key.
    const jobResult = await withMockedFetch(() => (async () => {
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                lines: [
                  {
                    line_id: "line_001",
                    source_text: "Hold me close until the morning",
                    translation: "Abrázame fuerte hasta la mañana",
                    explanation: "Traducción desalineada respecto a la línea solicitada.",
                    distractors: [
                      "Déjame ir antes del amanecer",
                      "Canta conmigo toda la noche",
                      "Espera hasta que cambie el viento",
                    ],
                  },
                  {
                    line_id: "line_002",
                    source_text: "Hold me close until the morning",
                    translation: "Abrázame fuerte hasta la mañana",
                    explanation: "Esta opción expresa cercanía hasta la mañana.",
                    distractors: [
                      "Déjame ir antes del amanecer",
                      "Canta conmigo toda la noche",
                      "Espera hasta que cambie el viento",
                    ],
                  },
                ],
              }),
            },
          },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch, async () => runStudyGenerationJob({
      env: generationEnv,
      targetLanguage: "es",
    }))

    expect(jobResult).toContain("ready_partial:es")
    expect(jobResult).toContain("skipped=1")
    expect(jobResult).toContain("skip_errors=schema_source_mismatch")

    const payload = await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: generationEnv,
      postId: POST_ID,
      targetLanguage: "es",
    })

    // No MCQ for the drifted line_001; only the correctly-aligned line_002 gets one.
    const choiceLineIds = payload.exercises
      .filter((exercise) => exercise.type === "translation_choice")
      .map((exercise) => exercise.line_id)
    expect(choiceLineIds).toEqual(["line_002"])
    expect(JSON.stringify(payload)).not.toContain("correct_option_id")

    const statusRows = await client!.execute(`
      SELECT u.line_id, l.status
      FROM song_study_unit u
      JOIN song_study_unit_localization l ON l.unit_id = u.id
      WHERE l.target_language = 'es'
      ORDER BY u.line_index
    `)
    expect(statusRows.rows).toEqual([
      { line_id: "line_001", status: "unavailable" },
      { line_id: "line_002", status: "ready" },
    ])
  })

  test("lazy generation falls back to say-it-back when provider output is invalid", async () => {
    await seedMultilineSongPost()
    const generationEnv = env({
      OPENROUTER_API_KEY: "test-openrouter-key",
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
    })

    await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: generationEnv,
      postId: POST_ID,
      targetLanguage: "es",
    })

    await withMockedFetch(() => (async () => {
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ lines: [] }) } }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch, async () => runStudyGenerationJob({
      env: generationEnv,
      targetLanguage: "es",
    }))

    const payload = await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: generationEnv,
      postId: POST_ID,
      targetLanguage: "es",
    })

    expect(payload.access).toBe("ready")
    expect(payload.exercise_count).toBe(2)
    expect(payload.exercises.every((exercise) => exercise.type === "say_it_back")).toBe(true)
  })

  test("lazy generation does not re-mark current unavailable localizations as processing", async () => {
    await seedMultilineSongPost()
    const generationEnv = env({
      OPENROUTER_API_KEY: "test-openrouter-key",
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
    })

    await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: generationEnv,
      postId: POST_ID,
      targetLanguage: "es",
    })

    await withMockedFetch(() => (async () => {
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ lines: [] }) } }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch, async () => runStudyGenerationJob({
      env: generationEnv,
      targetLanguage: "es",
    }))

    const unavailableBefore = await client!.execute("SELECT COUNT(*) AS count FROM song_study_unit_localization WHERE status = 'unavailable'")
    expect(Number(unavailableBefore.rows[0]?.count ?? 0)).toBe(2)
    await exec(`
      UPDATE community_jobs
      SET status = 'succeeded',
          result_ref = 'ready:es'
      WHERE job_type = 'song_study_generate'
    `)

    const payload = await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: generationEnv,
      postId: POST_ID,
      targetLanguage: "es",
    })

    expect(payload.access).toBe("ready")
    expect(payload.exercises.every((exercise) => exercise.type === "say_it_back")).toBe(true)
    const statusRows = await client!.execute(`
      SELECT status, COUNT(*) AS count
      FROM song_study_unit_localization
      GROUP BY status
      ORDER BY status
    `)
    expect(statusRows.rows).toEqual([{ status: "unavailable", count: 2 }])
    const jobRows = await client!.execute("SELECT COUNT(*) AS count FROM community_jobs WHERE job_type = 'song_study_generate'")
    expect(Number(jobRows.rows[0]?.count ?? 0)).toBe(1)
    const runRows = await client!.execute("SELECT status, error_code FROM song_study_generation_run")
    expect(runRows.rows).toEqual([{ error_code: "generation_failed", status: "unavailable" }])
  })

  test("converges an exhausted generation job instead of leaving study processing forever", async () => {
    await seedMultilineSongPost()
    const generationEnv = env({
      OPENROUTER_API_KEY: "test-openrouter-key",
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
    })

    await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: generationEnv,
      postId: POST_ID,
      targetLanguage: "es",
    })
    await exec(`
      UPDATE community_jobs
      SET status = 'failed',
          attempt_count = 8,
          error_code = 'worker_terminated',
          available_at = NULL
      WHERE job_type = 'song_study_generate'
    `)

    await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: generationEnv,
      postId: POST_ID,
      targetLanguage: "es",
    })

    const runRows = await client!.execute(`
      SELECT status, error_code, completed_at
      FROM song_study_generation_run
    `)
    expect(runRows.rows[0]?.status).toBe("unavailable")
    expect(runRows.rows[0]?.error_code).toBe("worker_terminated")
    expect(typeof runRows.rows[0]?.completed_at).toBe("string")
    const localizationRows = await client!.execute(`
      SELECT status, COUNT(*) AS count
      FROM song_study_unit_localization
      GROUP BY status
    `)
    expect(localizationRows.rows).toEqual([{ count: 2, status: "unavailable" }])
    const jobRows = await client!.execute("SELECT COUNT(*) AS count FROM community_jobs WHERE job_type = 'song_study_generate'")
    expect(Number(jobRows.rows[0]?.count ?? 0)).toBe(1)
  })

  test("lazy generation rejects answer-equal and duplicate distractors", async () => {
    await seedMultilineSongPost()
    const generationEnv = env({
      OPENROUTER_API_KEY: "test-openrouter-key",
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
    })

    await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: generationEnv,
      postId: POST_ID,
      targetLanguage: "es",
    })

    await withMockedFetch(() => (async () => {
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                lines: [
                  {
                    line_id: "line_001",
                    source_text: "I was lost in the midnight waves",
                    translation: "Me perdí en las olas de medianoche",
                    explanation: "Explica el sentido de estar perdido.",
                    distractors: [
                      "Me perdí en las olas de medianoche",
                      "Me perdí en las olas de medianoche",
                      "Me perdí en las olas de medianoche",
                    ],
                  },
                ],
              }),
            },
          },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch, async () => runStudyGenerationJob({
      env: generationEnv,
      targetLanguage: "es",
    }))

    const payload = await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: generationEnv,
      postId: POST_ID,
      targetLanguage: "es",
    })

    expect(payload.access).toBe("ready")
    expect(payload.exercises.every((exercise) => exercise.type === "say_it_back")).toBe(true)
    const localizations = await client!.execute("SELECT COUNT(*) AS count FROM song_study_unit_localization WHERE status = 'ready'")
    expect(Number(localizations.rows[0]?.count ?? 0)).toBe(0)
  })

  test("lazy generation regenerates stale unavailable localizations", async () => {
    await seedSongPost()
    await seedReadyPack()
    const generationEnv = env({
      OPENROUTER_API_KEY: "test-openrouter-key",
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
    })
    await exec(`
      INSERT INTO song_study_unit_localization (
        id, unit_id, target_language, localization_version, status,
        max_attempts, created_at, updated_at
      )
      VALUES ('sul_1_es_stale', 'stu_1', 'es', 0, 'unavailable', 1, ?1, ?1)
    `, [NOW])
    await exec(`
      UPDATE song_study_unit_localization
      SET localization_version = 0,
          status = 'unavailable',
          question = NULL,
          translation_text = NULL,
          options_json = NULL,
          correct_option_id = NULL,
          explanation_text = NULL,
          generated_at = NULL
      WHERE target_language = 'es'
    `)

    const firstPayload = await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: generationEnv,
      postId: POST_ID,
      targetLanguage: "es",
    })
    expect(firstPayload.access).toBe("ready")
    expect(firstPayload.exercises.every((exercise) => exercise.type === "say_it_back")).toBe(true)

    await withMockedFetch(() => (async () => {
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                lines: [
                  {
                    line_id: "line_001",
                    source_text: "I was lost in the midnight waves",
                    translation: "Me perdí en las olas de medianoche",
                    explanation: "Esta opción conserva el sentido de perderse.",
                    distractors: [
                      "Me encontré junto a las olas de medianoche",
                      "Me perdí en las luces de medianoche",
                      "Me perdí en las olas de la mañana",
                    ],
                  },
                  {
                    line_id: "line_002",
                    source_text: "Hold me close until the morning",
                    translation: "Abrázame fuerte hasta la mañana",
                    explanation: "Esta opción expresa cercanía hasta la mañana.",
                    distractors: [
                      "Déjame ir antes del amanecer",
                      "Abrázame fuerte hasta la noche",
                      "Llámame fuerte hasta la mañana",
                    ],
                  },
                ],
              }),
            },
          },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch, async () => runStudyGenerationJob({
      env: generationEnv,
      targetLanguage: "es",
    }))

    const payload = await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: generationEnv,
      postId: POST_ID,
      targetLanguage: "es",
    })

    expect(payload.access).toBe("ready")
    expect(payload.exercises.some((exercise) => exercise.type === "translation_choice")).toBe(true)
    const rows = await client!.execute(`
      SELECT COUNT(*) AS ready_count, MIN(localization_version) AS min_version
      FROM song_study_unit_localization
      WHERE target_language = 'es' AND status = 'ready'
    `)
    expect(Number(rows.rows[0]?.ready_count ?? 0)).toBe(2)
    expect(Number(rows.rows[0]?.min_version ?? 0)).toBe(5)
  })

  test("canonicalizes regional target languages before enqueueing generation", async () => {
    await seedMultilineSongPost()

    const payload = await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env({
        OPENROUTER_API_KEY: "test-openrouter-key",
        OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      }),
      postId: POST_ID,
      targetLanguage: "ES-MX",
    })

    expect(payload.access).toBe("ready")
    expect(payload.target_language).toBe("es")
    const rows = await client!.execute("SELECT DISTINCT target_language FROM song_study_unit_localization")
    expect(rows.rows.map((row) => row.target_language)).toEqual(["es"])
  })

  test("rejects unsupported target languages before creating generation rows", async () => {
    await seedMultilineSongPost()

    await expect(getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env({
        OPENROUTER_API_KEY: "test-openrouter-key",
        OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      }),
      postId: POST_ID,
      targetLanguage: "tlh",
    })).rejects.toThrow("target_language is not supported")

    const localizations = await client!.execute("SELECT COUNT(*) AS count FROM song_study_unit_localization")
    expect(Number(localizations.rows[0]?.count ?? 0)).toBe(0)
  })

  test("concurrent first reads create study units idempotently", async () => {
    await seedMultilineSongPost()

    const [left, right] = await Promise.all([
      getPostStudyPayload({
        actor: learnerActor,
        communityId: COMMUNITY_ID,
        communityRepository: repo,
        env: env(),
        postId: POST_ID,
        targetLanguage: "es",
      }),
      getPostStudyPayload({
        actor: authorActor,
        communityId: COMMUNITY_ID,
        communityRepository: repo,
        env: env(),
        postId: POST_ID,
        targetLanguage: "es",
      }),
    ])

    expect(left.access).toBe("ready")
    expect(right.access).toBe("ready")
    const units = await client!.execute("SELECT COUNT(*) AS count, COUNT(DISTINCT line_id) AS distinct_lines FROM song_study_unit")
    expect(Number(units.rows[0]?.count ?? 0)).toBe(2)
    expect(Number(units.rows[0]?.distinct_lines ?? 0)).toBe(2)
  })

  test("generation cap blocks a new target language before provider calls", async () => {
    await seedMultilineSongPost()
    await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env({
        OPENROUTER_API_KEY: "test-openrouter-key",
        OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
        SONG_STUDY_GENERATION_TARGET_LANGUAGE_LIMIT: "1",
      }),
      postId: POST_ID,
      targetLanguage: "es",
    })

    let fetchCalled = false
    await expect(withMockedFetch(() => (async () => {
      fetchCalled = true
      return new Response("unexpected", { status: 500 })
    }) as typeof fetch, async () => getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env({
        OPENROUTER_API_KEY: "test-openrouter-key",
        OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
        SONG_STUDY_GENERATION_TARGET_LANGUAGE_LIMIT: "1",
      }),
      postId: POST_ID,
      targetLanguage: "fr",
    }))).rejects.toThrow("Song study translation generation limit exceeded")
    expect(fetchCalled).toBe(false)
  })
})

describe("post study same-language suppression", () => {
  // A same-language translation row is deliberately degenerate: it "translates"
  // an English line into English. Markers let us prove the read path hides it.
  async function seedSameLanguageUnits(sourceLanguage: string): Promise<void> {
    await exec(`
      INSERT INTO song_study_unit (
        id, post_id, line_id, line_index, source_language, prompt_text,
        reference_text, say_it_back_status, unit_version, max_attempts,
        created_at, updated_at
      )
      VALUES
        ('stu_1', ?1, 'line_001', 0, ?2, 'I was lost in the midnight waves',
         'I was lost in the midnight waves', 'ready', 2, 2, ?3, ?3),
        ('stu_2', ?1, 'line_002', 1, ?2, 'Hold me close until the morning',
         'Hold me close until the morning', 'ready', 2, 2, ?3, ?3)
    `, [POST_ID, sourceLanguage, NOW])
    await exec(`
      INSERT INTO song_study_unit_localization (
        id, unit_id, target_language, localization_version, status,
        question, translation_text, options_json, correct_option_id,
        explanation_text, max_attempts, generated_at, created_at, updated_at
      )
      VALUES (
        'sul_2_en', 'stu_2', 'en', 4, 'ready',
        'Choose the best translation.',
        'SAME_LANG_TRANSLATION_MARKER', ?1, 'opt_a',
        'Paraphrase explanation marker.', 2, ?2, ?2, ?2
      )
    `, [
      JSON.stringify([
        { id: "opt_a", text: "SAME_LANG_TRANSLATION_MARKER" },
        { id: "opt_b", text: "SAME_LANG_DISTRACTOR_B" },
        { id: "opt_c", text: "SAME_LANG_DISTRACTOR_C" },
      ]),
      NOW,
    ])
  }

  async function seedEnglishRegionalSongPost(): Promise<void> {
    await exec(`
      INSERT INTO posts (
        post_id, community_id, author_user_id, identity_mode, post_type,
        status, song_mode, title, lyrics, source_language, rights_basis,
        analysis_state, content_safety_state, age_gate_policy, created_at,
        updated_at, access_mode, asset_id, visibility, song_title, song_cover_art_ref
      )
      VALUES (?1, ?2, ?3, 'public', 'song', 'published', 'original',
              'Midnight Waves', 'I was lost in the midnight waves', 'en-US',
              'original', 'allow', 'safe', 'none', ?4, ?4, 'public', 'ast_song',
              'public', 'Midnight Waves', 'ipfs://cover')
    `, [POST_ID, COMMUNITY_ID, AUTHOR_ID, NOW])
  }

  test("hides an existing ready en localization when target language equals source", async () => {
    await seedSongPost()
    await seedSameLanguageUnits("en")

    const payload = await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
      targetLanguage: "en",
    })

    expect(payload.access).toBe("ready")
    expect(payload.exercise_count).toBe(2)
    expect(payload.exercises.map((exercise) => exercise.type)).toEqual(["say_it_back", "say_it_back"])
    const serialized = JSON.stringify(payload)
    expect(serialized).not.toContain("translation_choice")
    expect(serialized).not.toContain("SAME_LANG_TRANSLATION_MARKER")
    expect(serialized).not.toContain("SAME_LANG_DISTRACTOR_B")
  })

  test("treats a regional source (en-US) as the same language as an en target", async () => {
    await seedEnglishRegionalSongPost()
    await seedSameLanguageUnits("en-US")

    const payload = await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
      targetLanguage: "en",
    })

    expect(payload.access).toBe("ready")
    expect(payload.exercises.every((exercise) => exercise.type === "say_it_back")).toBe(true)
    expect(JSON.stringify(payload)).not.toContain("SAME_LANG_TRANSLATION_MARKER")
  })

  test("skips a queued same-language generation job without calling the model", async () => {
    await seedSongPost()

    let fetchCalled = false
    const generationEnv = env({
      OPENROUTER_API_KEY: "test-openrouter-key",
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_TRANSLATION_MODEL: "test/study-generator",
    })
    const jobResult = await withMockedFetch(() => (async () => {
      fetchCalled = true
      return new Response("unexpected", { status: 500 })
    }) as typeof fetch, async () => runStudyGenerationJob({
      env: generationEnv,
      targetLanguage: "en",
    }))

    expect(jobResult).toBe("skipped:same_language")
    expect(fetchCalled).toBe(false)
    const localizations = await client!.execute("SELECT COUNT(*) AS count FROM song_study_unit_localization")
    expect(Number(localizations.rows[0]?.count ?? 0)).toBe(0)
  })

  test("rejects a same-language translation_choice attempt as not found", async () => {
    await seedSongPost()
    await seedSameLanguageUnits("en")

    await expect(submitPostStudyAttempt({
      actor: learnerActor,
      body: {
        attempt_number: 1,
        exercise_id: "stu:stu_2:translation_choice:en",
        idempotency_key: "same-language-attempt",
        selected_option_id: "opt_a",
        type: "translation_choice",
      },
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
    })).rejects.toThrow(/Study exercise not found/)

    const attempts = await client!.execute("SELECT COUNT(*) AS count FROM song_study_attempt")
    expect(Number(attempts.rows[0]?.count ?? 0)).toBe(0)
  })

  test("still serves cross-language (en source, es target) translation_choice", async () => {
    await seedSongPost()
    await seedReadyPack()

    const payload = await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
      targetLanguage: "es",
    })

    expect(payload.access).toBe("ready")
    expect(new Set(payload.exercises.map((exercise) => exercise.type))).toEqual(
      new Set(["translation_choice", "say_it_back"]),
    )
    const translationChoice = payload.exercises.find((exercise) => exercise.type === "translation_choice")
    expect(translationChoice).toBeDefined()
    expect(translationChoice?.line_id).toBe("line_002")
    expect(JSON.stringify(payload)).toContain("Abrázame fuerte hasta la mañana")
  })

  async function seedNullSourceSongPost(): Promise<void> {
    await exec(`
      INSERT INTO posts (
        post_id, community_id, author_user_id, identity_mode, post_type,
        status, song_mode, title, lyrics, source_language, rights_basis,
        analysis_state, content_safety_state, age_gate_policy, created_at,
        updated_at, access_mode, asset_id, visibility, song_title, song_cover_art_ref
      )
      VALUES (?1, ?2, ?3, 'public', 'song', 'published', 'original',
              'Midnight Waves', 'I was lost in the midnight waves', NULL,
              'original', 'allow', 'safe', 'none', ?4, ?4, 'public', 'ast_song',
              'public', 'Midnight Waves', 'ipfs://cover')
    `, [POST_ID, COMMUNITY_ID, AUTHOR_ID, NOW])
  }

  test("suppresses en translation when source_language is null (assumed English pilot source)", async () => {
    await seedNullSourceSongPost()
    await seedSameLanguageUnits("en")

    const payload = await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
      targetLanguage: "en",
    })

    expect(payload.access).toBe("ready")
    expect(payload.exercises.every((exercise) => exercise.type === "say_it_back")).toBe(true)
    expect(JSON.stringify(payload)).not.toContain("translation_choice")
    expect(JSON.stringify(payload)).not.toContain("SAME_LANG_TRANSLATION_MARKER")
  })

  test("still offers cross-language translation for a null source with a non-English target", async () => {
    await seedNullSourceSongPost()
    await seedReadyPack()

    const payload = await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
      postId: POST_ID,
      targetLanguage: "es",
    })

    expect(payload.access).toBe("ready")
    const translationChoice = payload.exercises.find((exercise) => exercise.type === "translation_choice")
    expect(translationChoice).toBeDefined()
    expect(JSON.stringify(payload)).toContain("Abrázame fuerte hasta la mañana")
  })
})

describe("post study unit punctuation canonicalization", () => {
  async function seedSongPostWithLyrics(lyrics: string): Promise<void> {
    await exec(`
      INSERT INTO posts (
        post_id, community_id, author_user_id, identity_mode, post_type,
        status, song_mode, title, lyrics, source_language, rights_basis,
        analysis_state, content_safety_state, age_gate_policy, created_at,
        updated_at, access_mode, asset_id, visibility, song_title, song_cover_art_ref
      )
      VALUES (?1, ?2, ?3, 'public', 'song', 'published', 'original',
              'Midnight Waves', ?4, 'en',
              'original', 'allow', 'safe', 'none', ?5, ?5, 'public', 'ast_song',
              'public', 'Midnight Waves', 'ipfs://cover')
    `, [POST_ID, COMMUNITY_ID, AUTHOR_ID, lyrics, NOW])
  }

  async function getExercisePromptTexts(
    targetLanguage = "es",
    envOverrides: Partial<Env> = {},
  ): Promise<string[]> {
    const payload = await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(envOverrides),
      postId: POST_ID,
      targetLanguage,
    })
    return payload.exercises.map((exercise) => exercise.prompt_text)
  }

  test("strips trailing comma/period/dash at unit creation but keeps ? and !", async () => {
    await seedSongPostWithLyrics(
      "Blues have overtaken me,\n" +
      "The shadows have followed me.\n" +
      "The music has captured me -\n" +
      "Why did you leave me?\n" +
      "Do not go!",
    )

    const prompts = await getExercisePromptTexts("es", {
      SONG_STUDY_DUE_REVIEW_SERVING_ENABLED: "true",
    })

    expect(prompts).toEqual([
      "Blues have overtaken me",
      "The shadows have followed me",
      "The music has captured me",
      "Why did you leave me?",
      "Do not go!",
    ])
    expect(prompts.every((text) => !/[,;:]$/u.test(text))).toBe(true)
  })

  test("re-splits stale units to canonicalize stored text while preserving review state", async () => {
    await seedSongPostWithLyrics("Blues have overtaken me,")
    // A pre-canonicalization (v1) unit whose stored text still carries the comma.
    await exec(`
      INSERT INTO song_study_unit (
        id, post_id, line_id, line_index, source_language, prompt_text,
        reference_text, say_it_back_status, unit_version, max_attempts,
        created_at, updated_at
      )
      VALUES ('stu_stale', ?1, 'line_001', 0, 'en',
              'Blues have overtaken me,', 'Blues have overtaken me,',
              'ready', 1, 2, ?2, ?2)
    `, [POST_ID, NOW])
    // Per-user FSRS state for that line must survive the re-split (keyed by line_id).
    await exec(`
      INSERT INTO song_study_review_state (
        user_id, post_id, line_id, exercise_type, target_language, state,
        stability, difficulty, due_at, last_reviewed_at, reps, lapses,
        fsrs_params_version, updated_at
      )
      VALUES (?1, ?2, 'line_001', 'say_it_back', 'en', 'review',
              4.2, 5.0, ?3, ?3, 3, 1, 1, ?3)
    `, [LEARNER_ID, POST_ID, NOW])

    const prompts = await getExercisePromptTexts("es", {
      SONG_STUDY_DUE_REVIEW_SERVING_ENABLED: "true",
    })
    expect(prompts).toEqual(["Blues have overtaken me"])

    const unit = await client!.execute(
      "SELECT id, prompt_text, reference_text, unit_version FROM song_study_unit WHERE post_id = ?1 AND line_id = 'line_001'",
      [POST_ID],
    )
    expect(unit.rows).toHaveLength(1)
    // Same primary key kept (upsert), so FK localizations / exercise ids stay valid.
    expect(unit.rows[0]?.id).toBe("stu_stale")
    expect(unit.rows[0]?.prompt_text).toBe("Blues have overtaken me")
    expect(unit.rows[0]?.reference_text).toBe("Blues have overtaken me")
    expect(Number(unit.rows[0]?.unit_version ?? 0)).toBe(2)

    const review = await client!.execute(
      "SELECT reps, lapses, state FROM song_study_review_state WHERE post_id = ?1 AND line_id = 'line_001' AND exercise_type = 'say_it_back'",
      [POST_ID],
    )
    expect(review.rows).toHaveLength(1)
    expect(Number(review.rows[0]?.reps ?? 0)).toBe(3)
    expect(Number(review.rows[0]?.lapses ?? 0)).toBe(1)
    expect(review.rows[0]?.state).toBe("review")
  })

  test("heals stale units during capability resolution without opening the study route", async () => {
    await seedSongPostWithLyrics("Blues have overtaken me,")
    await exec(`
      INSERT INTO song_study_unit (
        id, post_id, line_id, line_index, source_language, prompt_text,
        reference_text, say_it_back_status, unit_version, max_attempts,
        created_at, updated_at
      )
      VALUES ('stu_stale', ?1, 'line_001', 0, 'en',
              'Blues have overtaken me,', 'Blues have overtaken me,',
              'ready', 1, 2, ?2, ?2)
    `, [POST_ID, NOW])

    await resolvePostStudyCapability({
      artifactWriteClient: client!,
      client: client!,
      env: env(),
      hasActiveElevenLabsCredential: async () => true,
      post: {
        access_mode: "public",
        asset_id: "ast_song",
        author_user_id: AUTHOR_ID,
        community_id: COMMUNITY_ID,
        lyrics: "Blues have overtaken me,",
        post_id: POST_ID,
        post_type: "song",
        source_language: "en",
      },
      targetLanguage: "en",
      viewerUserId: LEARNER_ID,
    })

    const unit = await client!.execute(
      "SELECT prompt_text, unit_version FROM song_study_unit WHERE post_id = ?1 AND line_id = 'line_001'",
      [POST_ID],
    )
    expect(unit.rows[0]?.prompt_text).toBe("Blues have overtaken me")
    expect(Number(unit.rows[0]?.unit_version ?? 0)).toBe(2)
  })

  test("re-queues stale localization packs during capability resolution", async () => {
    await seedSongPostWithLyrics("I was lost in the midnight waves")
    await exec(`
      INSERT INTO song_study_unit (
        id, post_id, line_id, line_index, source_language, prompt_text,
        reference_text, say_it_back_status, unit_version, max_attempts,
        created_at, updated_at
      )
      VALUES ('stu_current', ?1, 'line_001', 0, 'en',
              'I was lost in the midnight waves', 'I was lost in the midnight waves',
              'ready', 2, 2, ?2, ?2)
    `, [POST_ID, NOW])
    await exec(`
      INSERT INTO song_study_unit_localization (
        id, unit_id, target_language, localization_version, status,
        question, translation_text, options_json, correct_option_id,
        max_attempts, generated_at, created_at, updated_at
      )
      VALUES ('sul_old', 'stu_current', 'es', 4, 'ready',
              'Choose the best translation.', 'traducción vieja', ?1, 'opt_a',
              2, ?2, ?2, ?2)
    `, [JSON.stringify([
      { id: "opt_a", text: "traducción vieja" },
      { id: "opt_b", text: "otra" },
      { id: "opt_c", text: "tercera" },
    ]), NOW])

    await resolvePostStudyCapability({
      artifactWriteClient: client!,
      client: client!,
      env: env({ OPENROUTER_API_KEY: "test-openrouter-key" }),
      hasActiveElevenLabsCredential: async () => false,
      post: {
        access_mode: "public",
        asset_id: "ast_song",
        author_user_id: AUTHOR_ID,
        community_id: COMMUNITY_ID,
        lyrics: "I was lost in the midnight waves",
        post_id: POST_ID,
        post_type: "song",
        source_language: "en",
      },
      targetLanguage: "es",
      viewerUserId: LEARNER_ID,
    })

    const localization = await client!.execute(
      "SELECT status, localization_version FROM song_study_unit_localization WHERE id = 'sul_old'",
    )
    expect(localization.rows[0]?.status).toBe("processing")
    expect(Number(localization.rows[0]?.localization_version ?? 0)).toBe(5)
    const jobs = await client!.execute(
      "SELECT COUNT(*) AS count FROM community_jobs WHERE job_type = 'song_study_generate' AND subject_id = ?1",
      [`${POST_ID}:es`],
    )
    expect(Number(jobs.rows[0]?.count ?? 0)).toBe(1)
  })

  test("deletes stale units the re-split no longer produces and cascades their localizations", async () => {
    // Post now yields only line_001, but stale (v1) units + a localization exist for a
    // line the current lyrics no longer produce (edited lyrics / heuristic change).
    await seedSongPostWithLyrics("I was lost in the midnight waves")
    await exec(`
      INSERT INTO song_study_unit (
        id, post_id, line_id, line_index, source_language, prompt_text,
        reference_text, say_it_back_status, unit_version, max_attempts,
        created_at, updated_at
      )
      VALUES
        ('stu_keep', ?1, 'line_001', 0, 'en', 'I was lost in the midnight waves',
         'I was lost in the midnight waves', 'ready', 1, 2, ?2, ?2),
        ('stu_drop', ?1, 'line_002', 1, 'en', 'A line that no longer exists',
         'A line that no longer exists', 'ready', 1, 2, ?2, ?2)
    `, [POST_ID, NOW])
    await exec(`
      INSERT INTO song_study_unit_localization (
        id, unit_id, target_language, localization_version, status,
        question, translation_text, options_json, correct_option_id,
        explanation_text, max_attempts, generated_at, created_at, updated_at
      )
      VALUES ('sul_drop_es', 'stu_drop', 'es', 4, 'ready',
              'Choose the best translation.', 'Una línea que ya no existe', ?1,
              'opt_a', 'explicación', 2, ?2, ?2, ?2)
    `, [
      JSON.stringify([
        { id: "opt_a", text: "Una línea que ya no existe" },
        { id: "opt_b", text: "Otra opción" },
        { id: "opt_c", text: "Tercera opción" },
      ]),
      NOW,
    ])

    const prompts = await getExercisePromptTexts()
    expect(prompts).toEqual(["I was lost in the midnight waves"])

    const units = await client!.execute("SELECT line_id FROM song_study_unit WHERE post_id = ?1", [POST_ID])
    expect(units.rows.map((row) => row.line_id)).toEqual(["line_001"])
    const orphanLocalizations = await client!.execute(
      "SELECT COUNT(*) AS count FROM song_study_unit_localization WHERE unit_id = 'stu_drop'",
    )
    expect(Number(orphanLocalizations.rows[0]?.count ?? 0)).toBe(0)
  })

  test("treats old-version localizations as stale and re-queues generation", async () => {
    await seedMultilineSongPost()
    // Two current-version units with COMPLETE es localizations at the previous
    // localization version — bumping the version must force a regeneration.
    await exec(`
      INSERT INTO song_study_unit (
        id, post_id, line_id, line_index, source_language, prompt_text,
        reference_text, say_it_back_status, unit_version, max_attempts,
        created_at, updated_at
      )
      VALUES
        ('stu_1', ?1, 'line_001', 0, 'en', 'I was lost in the midnight waves',
         'I was lost in the midnight waves', 'ready', 2, 2, ?2, ?2),
        ('stu_2', ?1, 'line_002', 1, 'en', 'Hold me close until the morning',
         'Hold me close until the morning', 'ready', 2, 2, ?2, ?2)
    `, [POST_ID, NOW])
    for (const unitId of ["stu_1", "stu_2"]) {
      await exec(`
        INSERT INTO song_study_unit_localization (
          id, unit_id, target_language, localization_version, status,
          question, translation_text, options_json, correct_option_id,
          explanation_text, max_attempts, generated_at, created_at, updated_at
        )
        VALUES (?1, ?2, 'es', 4, 'ready',
                'Choose the best translation.', 'traducción vieja', ?3,
                'opt_a', 'explicación', 2, ?4, ?4, ?4)
      `, [`sul_${unitId}_es_old`, unitId, JSON.stringify([
        { id: "opt_a", text: "traducción vieja" },
        { id: "opt_b", text: "otra" },
        { id: "opt_c", text: "tercera" },
      ]), NOW])
    }

    await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env({
        OPENROUTER_API_KEY: "test-openrouter-key",
        OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      }),
      postId: POST_ID,
      targetLanguage: "es",
    })

    const processing = await client!.execute(
      "SELECT COUNT(*) AS count FROM song_study_unit_localization WHERE target_language = 'es' AND status = 'processing'",
    )
    expect(Number(processing.rows[0]?.count ?? 0)).toBe(2)
  })
})
