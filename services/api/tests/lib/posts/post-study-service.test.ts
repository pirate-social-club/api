import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createClient, type Client } from "@libsql/client"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { ActorContext } from "../../../src/lib/auth-middleware"
import { buildLocalCommunityDbUrl, ensureCommunityDbSchema } from "../../../src/lib/communities/community-local-db"
import type { CommunityDatabaseBindingRepository } from "../../../src/lib/communities/community-repository-types"
import { getPostStudyPayload, runSongStudyGenerate, submitPostStudyAttempt, transcribePostStudyAudio } from "../../../src/lib/posts/post-study-service"
import type { Env } from "../../../src/types"
import { splitSqlStatements, toSqliteCompatibleStatements } from "../../../shared/sql-migration"
import { withMockedFetch } from "../../helpers"

const COMMUNITY_ID = "cmt_study"
const POST_ID = "pst_song"
const AUTHOR_ID = "usr_author"
const LEARNER_ID = "usr_learner"
const NOW = "2026-06-29T08:00:00.000Z"

const repo: CommunityDatabaseBindingRepository = {
  async getActiveCommunityDbCredential() {
    return null
  },
  async getPrimaryCommunityDatabaseBinding() {
    return null
  },
}

const learnerActor: ActorContext = { authType: "user", userId: LEARNER_ID }
const authorActor: ActorContext = { authType: "user", userId: AUTHOR_ID }

let rootDir: string | null = null
let client: Client | null = null

function env(overrides: Partial<Env> = {}): Env {
  if (!rootDir) throw new Error("test root not initialized")
  return {
    ENVIRONMENT: "test",
    LOCAL_COMMUNITY_DB_ROOT: rootDir,
    ...overrides,
  } as Env
}

async function exec(sql: string, args: unknown[] = []): Promise<void> {
  if (!client) throw new Error("test db not initialized")
  await client.execute({ sql, args: args as never[] })
}

async function runStudyGenerationJob(input: {
  env: Env
  postId?: string
  targetLanguage?: string
}): Promise<string | null> {
  return runSongStudyGenerate({
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
       'ready', 1, 2, ?2, ?2),
      ('stu_2', ?1, 'line_002', 1, 'en',
       'Hold me close until the morning',
       'Hold me close until the morning',
       'ready', 1, 2, ?2, ?2)
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

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "pirate-study-"))
  await mkdir(rootDir, { recursive: true })
  client = createClient({ url: buildLocalCommunityDbUrl(rootDir, COMMUNITY_ID) })
  await ensureCommunityDbSchema(client)
  await applyStudyMigration()
  await seedCommunity()
}, 120_000)

afterEach(async () => {
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
    expect(payload.study_pack_version).toBe(1)
    const serialized = JSON.stringify(payload)
    expect(serialized).toContain("opt_a")
    expect(serialized).not.toContain("correct_option_id")
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

  test("review state schedules future due dates and grows stability", async () => {
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
    const firstDue = Date.parse(String(first.rows[0]?.due_at ?? ""))
    const firstStability = Number(first.rows[0]?.stability ?? 0)
    expect(firstDue).toBeGreaterThan(Date.parse(NOW))

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
    expect(Number(second.rows[0]?.stability ?? 0)).toBeGreaterThan(firstStability)
    expect(Date.parse(String(second.rows[0]?.due_at ?? ""))).toBeGreaterThan(firstDue)
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
    expect(jobResult).toContain("schema_mismatch")

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
    expect(Number(rows.rows[0]?.min_version ?? 0)).toBe(2)
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
