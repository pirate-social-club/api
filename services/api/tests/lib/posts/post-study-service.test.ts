import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createClient, type Client } from "@libsql/client"
import type { ShardQueryResult, ShardResult, ShardRpc, ShardSqlStatement } from "@pirate/api-shared"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { ActorContext } from "../../../src/lib/auth-middleware"
import { buildLocalCommunityDbUrl, ensureCommunityDbSchema } from "../../../src/lib/communities/community-local-db"
import type { CommunityDatabaseBindingRepository } from "../../../src/lib/communities/community-repository-types"
import { runCommunityJob } from "../../../src/lib/communities/jobs/handlers"
import { getPostStudyPayload, submitPostStudyAttempt, transcribePostStudyAudio } from "../../../src/lib/posts/post-study-service"
import type { Env } from "../../../src/types"
import { splitSqlStatements, toSqliteCompatibleStatements } from "../../../shared/sql-migration"
import { withMockedFetch } from "../../helpers"

const COMMUNITY_ID = "cmt_study"
const POST_ID = "pst_song"
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

let rootDir: string | null = null
let client: Client | null = null
let controlClient: Client | null = null

function env(overrides: Partial<Env> = {}): Env {
  if (!rootDir) throw new Error("test root not initialized")
  return {
    COMMUNITY_D1_SHARD: makeLocalCommunityShard() as never,
    CONTROL_PLANE_DATABASE_URL: `file:${join(rootDir, "control-plane.db")}`,
    ENVIRONMENT: "test",
    LOCAL_COMMUNITY_DB_ROOT: rootDir,
    ...overrides,
  } as Env
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
      const results: ShardQueryResult[] = []
      for (const statement of input.statements) {
        results.push(await client.execute({ sql: statement.sql, args: (statement.args ?? []) as never[] }))
      }
      return { ok: true, value: results }
    },
  } as ShardRpc
}

async function runStudyGenerationJob(input: {
  env: Env
  postId?: string
  targetLanguage?: string
}): Promise<string | null> {
  return runCommunityJob({
    env: input.env,
    communityRepository: repo as never,
    job: {
      job_id: "cjb_study_test",
      community_id: COMMUNITY_ID,
      job_type: "song_study_generate",
      subject_type: "post_study",
      subject_id: `${input.postId ?? POST_ID}:${input.targetLanguage ?? "es"}`,
      status: "queued",
      payload_json: JSON.stringify({
        post_id: input.postId ?? POST_ID,
        target_language: input.targetLanguage ?? "es",
      }),
      result_ref: null,
      error_code: null,
      attempt_count: 0,
      available_at: null,
      created_at: NOW,
      updated_at: NOW,
    },
  })
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
}

async function clearElevenLabsCredential(): Promise<void> {
  await execControl("DELETE FROM community_assistant_credentials WHERE community_id = ?1 AND provider = 'elevenlabs'", [COMMUNITY_ID])
}

beforeEach(async () => {
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
    expect(payload.exercise_count).toBe(0)
    expect(payload.exercises).toEqual([])
    expect(payload.unavailable_reason).toBeUndefined()
    const processingRows = await client!.execute("SELECT COUNT(*) AS count FROM song_study_unit_localization WHERE status = 'processing'")
    expect(Number(processingRows.rows[0]?.count ?? 0)).toBe(2)
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

  test("records attempts server-side and replays idempotent retries without double-writing", async () => {
    await seedSongPost()
    await seedReadyPack()

    const first = await submitPostStudyAttempt({
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
    })
    const retry = await submitPostStudyAttempt({
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
    })

    expect(first).toEqual({
      attempts_remaining: 1,
      correct_option_id: "opt_a",
      exercise_id: "stu:stu_2:translation_choice:es",
      next_review_hint: "good",
      object: "song_study_attempt_result",
      outcome: "correct",
    })
    expect(retry).toEqual(first)

    const count = await client!.execute("SELECT COUNT(*) AS count FROM song_study_attempt")
    expect(Number(count.rows[0]?.count ?? 0)).toBe(1)
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
    expect(result.next_review_hint).toBe("hard")
    expect(result.feedback?.missing).toContain("lost")

    const row = await client!.execute("SELECT transcript FROM song_study_attempt LIMIT 1")
    expect(row.rows[0]?.transcript).toBe("I was in the midnight waves")
    const state = await client!.execute("SELECT state, lapses FROM song_study_review_state LIMIT 1")
    expect(state.rows[0]).toMatchObject({ lapses: 0, state: "review" })
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
    expect(result.feedback).toEqual({
      extra: [],
      matched: ["i", "was", "lost", "in", "midnight", "wave"],
      missing: [],
    })
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
    expect(result.next_review_hint).toBe("hard")
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

    await submitPostStudyAttempt({
      actor: learnerActor,
      body: {
        attempt_number: 2,
        exercise_id: "stu:stu_1:say_it_back:en",
        idempotency_key: "study-attempt-review-schedule-2",
        transcript: "I was lost in the midnight waves",
        type: "say_it_back",
      },
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
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
    await clearElevenLabsCredential()
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

    await expect(submitPostStudyAttempt({
      actor: learnerActor,
      body: {
        attempt_number: 1,
        exercise_id: "stu:stu_1:say_it_back:en",
        idempotency_key: "study-attempt-disabled",
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
      "translation_choice",
      "say_it_back",
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
      "translation_choice",
      "say_it_back",
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
      "translation_choice",
      "say_it_back",
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
    const translationChoice = payload.exercises.find((exercise) => exercise.type === "translation_choice")
    expect(translationChoice).toBeDefined()
    expect(translationChoice?.line_id).toBe("line_002")
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

  async function getExercisePromptTexts(targetLanguage = "es"): Promise<string[]> {
    const payload = await getPostStudyPayload({
      actor: learnerActor,
      communityId: COMMUNITY_ID,
      communityRepository: repo,
      env: env(),
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

    const prompts = await getExercisePromptTexts()

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

    const prompts = await getExercisePromptTexts()
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
