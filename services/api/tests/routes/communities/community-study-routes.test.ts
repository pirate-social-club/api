import { afterEach, describe, expect, test } from "bun:test"
import { createClient, type Client } from "@libsql/client"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { app } from "../../../src/index"
import { buildLocalCommunityDbUrl, ensureCommunityDbSchema } from "../../../src/lib/communities/community-local-db"
import { splitSqlStatements, toSqliteCompatibleStatements } from "../../../shared/sql-migration"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import { exchangeJwt } from "./community-routes-test-helpers"
import { encryptTelegramBotToken } from "../../../src/lib/telegram/bot-credential-crypto"
import { encryptCredentialSecret } from "../../../src/lib/crypto/credential-secret"

let cleanup: (() => Promise<void>) | null = null

afterEach(async () => {
  resetRuntimeCaches()
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

async function applyStudyMigration(client: Client): Promise<void> {
  const studyExisting = await client.execute("PRAGMA table_info(song_study_unit)")
  if (studyExisting.rows.length === 0) {
    await applyMigrationFile(client, "../../../test-fixtures/db/community-template/migrations/1109_song_study.sql")
  }

  const communityColumns = await client.execute("PRAGMA table_info(communities)")
  if (!communityColumns.rows.some((row) => String(row.name) === "study_enabled")) {
    await applyMigrationFile(client, "../../../test-fixtures/db/community-template/migrations/1115_community_study_enabled.sql")
  }

  const streakExisting = await client.execute("PRAGMA table_info(song_engagement_days)")
  if (streakExisting.rows.length === 0) {
    await applyMigrationFile(client, "../../../test-fixtures/db/community-template/migrations/1119_song_streaks.sql")
  }

  const attemptColumns = await client.execute("PRAGMA table_info(song_study_attempt)")
  if (!attemptColumns.rows.some((row) => String(row.name) === "study_session_id")) {
    await applyMigrationFile(client, "../../../test-fixtures/db/community-template/migrations/1118_song_study_review_sessions.sql")
    await applyMigrationFile(client, "../../../test-fixtures/db/community-template/migrations/1121_song_study_attempt_identity.sql")
    await applyMigrationFile(client, "../../../test-fixtures/db/community-template/migrations/1142_song_study_sessions.sql")
  }
}

async function applyMigrationFile(client: Client, relativePath: string): Promise<void> {
  const path = fileURLToPath(new URL(relativePath, import.meta.url))
  const raw = await readFile(path, "utf8")
  for (const statement of splitSqlStatements(raw)) {
    for (const sqliteStatement of toSqliteCompatibleStatements(statement)) {
      await client.execute(sqliteStatement)
    }
  }
}

async function seedStudySong(input: {
  communityDbRoot: string
  communityId: string
}): Promise<void> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })
  try {
    await ensureCommunityDbSchema(client)
    await applyStudyMigration(client)
    const now = "2026-06-29T08:00:00.000Z"
    await client.execute({
      sql: `
        INSERT INTO communities (
          community_id, display_name, status, artist_governance_state,
          membership_mode, default_age_gate_policy, donation_policy_mode,
          donation_partner_status, governance_mode, created_by_user_id,
          created_at, updated_at, study_enabled
        )
        VALUES (?1, 'Study Route Club', 'active', 'fan_run', 'open', 'none',
                'none', 'unconfigured', 'centralized', 'route_author', ?2, ?2, 1)
      `,
      args: [input.communityId, now],
    })
    await client.execute({
      sql: `
        INSERT INTO posts (
          post_id, community_id, author_user_id, identity_mode, post_type,
          status, song_mode, title, lyrics, source_language, rights_basis,
          analysis_state, content_safety_state, age_gate_policy, created_at,
          updated_at, access_mode, asset_id, visibility, song_title, song_cover_art_ref
        )
        VALUES ('pst_study_route_song', ?1, 'route_author', 'public', 'song',
                'published', 'original', 'Route Song',
                'Line one for route study
Line two for route study',
                'en', 'original', 'allow', 'safe', 'none', ?2, ?2,
                'public', 'ast_route_song', 'public', 'Route Song', 'ipfs://study-route-cover')
      `,
      args: [input.communityId, now],
    })
  } finally {
    client.close()
  }
}

describe("community study routes", () => {
  test("GET /communities/:communityId/posts/:postId/study is registered and returns a gated study payload", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "study-route-reader")
    const communityId = "cmt_study_route"
    await seedStudySong({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
    })
    await ctx.client.execute({
      sql: `
        INSERT INTO users (
          user_id, verification_state, capability_provider,
          verification_capabilities_json, verified_at,
          created_at, updated_at
        )
        VALUES (
          'route_author', 'verified', 'self', '["unique_human"]',
          '2026-06-29T08:00:00.000Z',
          '2026-06-29T08:00:00.000Z',
          '2026-06-29T08:00:00.000Z'
        )
        ON CONFLICT (user_id) DO NOTHING
      `,
    })
    await ctx.client.execute({
      sql: `
        INSERT INTO communities (
          community_id, creator_user_id, display_name, description,
          membership_mode, status, provisioning_state, transfer_state,
          route_slug, created_at, updated_at
        )
        VALUES (
          ?1, 'route_author', 'Study Route Club', NULL,
          'open', 'active', 'active', 'none',
          NULL, '2026-06-29T08:00:00.000Z', '2026-06-29T08:00:00.000Z'
        )
      `,
      args: [communityId],
    })
    await ctx.client.execute({
      sql: `
        INSERT INTO community_assistant_credentials (
          community_assistant_credential_id, community_id, provider, encrypted_secret,
          key_last4, encryption_key_version, status, created_at, revoked_at,
          rotated_from, actor_user_id
        )
        VALUES (
          'cac_study_route_elevenlabs', ?1, 'elevenlabs', 'test-encrypted-key',
          'labs', 1, 'active', '2026-06-29T08:00:00.000Z', NULL, NULL,
          'route_author'
        )
      `,
      args: [communityId],
    })

    const response = await app.request(
      `http://pirate.test/communities/${communityId}/posts/pst_study_route_song/study?target_language=es`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )

    expect(response.status).toBe(200)
    const body = await json(response) as {
      access?: string
      exercise_count?: number
      exercises?: Array<{ type?: string }>
      object?: string
    }
    expect(body.object).toBe("song_study_payload")
    expect(body.access).toBe("ready")
    expect(body.exercise_count).toBe(2)
    expect(body.exercises?.every((exercise) => exercise.type === "say_it_back")).toBe(true)
  }, 120_000)

  test("creates a server-derived native Telegram voice intent and sends its prompt once", async () => {
    const wrapKey = "ab".repeat(32)
    const ctx = await createRouteTestContext({
      CREDENTIAL_WRAP_KEY: wrapKey,
      CREDENTIAL_WRAP_KEY_VERSION: "1",
      TELEGRAM_STUDY_VOICE_COMMUNITY_IDS: "cmt_study_route_telegram_voice",
      TELEGRAM_STUDY_VOICE_ENABLED: "true",
    })
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "study-route-telegram-voice")
    const communityId = "cmt_study_route_telegram_voice"
    await seedStudySong({ communityDbRoot: ctx.communityDbRoot, communityId })
    const now = "2026-06-29T08:00:00.000Z"
    await ctx.client.execute({
      sql: `
        INSERT INTO users (
          user_id, verification_state, capability_provider,
          verification_capabilities_json, verified_at, created_at, updated_at
        ) VALUES (
          'route_author', 'verified', 'self', '["unique_human"]', ?1, ?1, ?1
        ) ON CONFLICT (user_id) DO NOTHING
      `,
      args: [now],
    })
    await ctx.client.execute({
      sql: `
        INSERT INTO communities (
          community_id, creator_user_id, display_name, membership_mode, status,
          provisioning_state, transfer_state, created_at, updated_at
        ) VALUES (?1, 'route_author', 'Voice Study', 'open', 'active',
                  'active', 'none', ?2, ?2)
      `,
      args: [communityId, now],
    })
    await ctx.client.execute({
      sql: `
        INSERT INTO community_assistant_credentials (
          community_assistant_credential_id, community_id, provider, encrypted_secret,
          key_last4, encryption_key_version, status, created_at, actor_user_id
        ) VALUES (
          'cac_study_voice_elevenlabs', ?1, 'elevenlabs', ?3,
          'labs', 1, 'active', ?2, 'route_author'
        )
      `,
      args: [
        communityId,
        now,
        encryptCredentialSecret({ plaintext: "elevenlabs-study-test-key", wrapKey }),
      ],
    })
    await ctx.client.execute({
      sql: `
        INSERT INTO auth_provider_links (
          auth_provider_link_id, user_id, provider, provider_subject, provider_user_ref,
          status, linked_at, created_at, updated_at
        ) VALUES ('apl_study_voice_telegram', ?1, 'telegram', '787878', 'student',
                  'active', ?2, ?2, ?2)
      `,
      args: [session.userId, now],
    })
    await ctx.client.execute({
      sql: `
        INSERT INTO telegram_accounts (
          telegram_user_id, user_id, username, first_seen_at, last_seen_at, updated_at
        ) VALUES ('787878', ?1, 'student', ?2, ?2, ?2)
      `,
      args: [session.userId, now],
    })
    const botToken = "987654:telegramstudyvoicetoken1234567890"
    await ctx.client.execute({
      sql: `
        INSERT INTO telegram_community_bots (
          telegram_community_bot_id, community_id, encrypted_bot_token, token_last4,
          encryption_key_version, telegram_bot_user_id, bot_username, bot_display_name,
          webhook_id, webhook_secret, webhook_status, status, created_at, updated_at,
          actor_user_id
        ) VALUES (
          'tcb_study_voice', ?1, ?2, '7890', 1, '987654',
          'VoiceStudyBot', 'Voice study bot', 'tgb_study_voice', 'voice-secret',
          'active', 'active', ?3, ?3, 'route_author'
        )
      `,
      args: [
        communityId,
        encryptTelegramBotToken({ plaintextToken: botToken, wrapKey }),
        now,
      ],
    })

    const studyResponse = await app.request(
      `http://pirate.test/communities/${communityId}/posts/pst_study_route_song/study?target_language=es`,
      { headers: { authorization: `Bearer ${session.accessToken}` } },
      ctx.env,
    )
    const study = await json(studyResponse) as {
      exercises: Array<{ id: string; reference_text?: string; type: string }>
    }
    const exercise = study.exercises.find((item) => item.type === "say_it_back")
    const nextExercise = study.exercises.filter((item) => item.type === "say_it_back")[1]
    expect(exercise).toBeTruthy()
    expect(nextExercise).toBeTruthy()

    ctx.env.TELEGRAM_STUDY_VOICE_ENABLED = "false"
    const disabledVoiceIntent = await app.request(
      `http://pirate.test/communities/${communityId}/posts/pst_study_route_song/study/telegram_voice_intents`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ exercise_id: exercise!.id }),
      },
      ctx.env,
    )
    expect(disabledVoiceIntent.status).toBe(409)
    ctx.env.TELEGRAM_STUDY_VOICE_ENABLED = "true"

    const untrustedCoordinates = await app.request(
      `http://pirate.test/communities/${communityId}/posts/pst_study_route_song/study/telegram_voice_intents`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          attempt_number: 99,
          exercise_id: "exercise_from_another_session",
          session_id: "sts_attacker_supplied",
        }),
      },
      ctx.env,
    )
    expect(untrustedCoordinates.status).toBe(409)
    const intentsBeforeEligibleCreation = await ctx.client.execute(
      "SELECT intent_id FROM telegram_study_voice_intents",
    )
    expect(intentsBeforeEligibleCreation.rows).toHaveLength(0)

    const originalFetch = globalThis.fetch
    const telegramRequests: Request[] = []
    let transcriptionRequests = 0
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      if (request.url.endsWith("/getFile")) {
        telegramRequests.push(request)
        return Response.json({
          ok: true,
          result: { file_path: "voice/study-answer.oga" },
        })
      }
      if (request.url.includes("/file/bot") && request.url.endsWith("/voice/study-answer.oga")) {
        return new Response(new Uint8Array([79, 103, 103, 83]), {
          headers: { "content-type": "audio/ogg" },
        })
      }
      if (request.url === "https://api.elevenlabs.io/v1/speech-to-text") {
        transcriptionRequests += 1
        if (transcriptionRequests === 1) {
          return new Response("temporary transcription failure", { status: 503 })
        }
        const form = await request.formData()
        expect(form.get("file")).toBeInstanceOf(File)
        expect((form.get("file") as File).type).toBe("audio/ogg")
        return Response.json({
          confidence: 0.99,
          language_code: "es",
          text: exercise!.reference_text,
        })
      }
      telegramRequests.push(request)
      return new Response(JSON.stringify({
        ok: true,
        result: { message_id: 321 },
      }), { headers: { "content-type": "application/json" } })
    }) as typeof fetch
    try {
      const response = await app.request(
        `http://pirate.test/communities/${communityId}/posts/pst_study_route_song/study/telegram_voice_intents`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${session.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            exercise_id: exercise!.id,
            target_language: "es",
          }),
        },
        ctx.env,
      )
      expect(response.status).toBe(201)
      const body = await json(response) as { object: string; status: string }
      expect(body).toMatchObject({
        object: "telegram_study_voice_intent",
        status: "pending",
      })
      expect(telegramRequests).toHaveLength(1)
      expect(telegramRequests[0]!.url).toBe(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
      )
      const stored = await ctx.client.execute({
        sql: `
          SELECT status, prompt_delivery_status, prompt_message_id,
                 study_session_id, idempotency_key
          FROM telegram_study_voice_intents
          WHERE telegram_community_bot_id = 'tcb_study_voice'
        `,
      })
      expect(stored.rows[0]).toMatchObject({
        prompt_delivery_status: "sent",
        prompt_message_id: 321,
        status: "pending",
      })
      expect(String(stored.rows[0]?.study_session_id)).toStartWith("sts_")
      expect(String(stored.rows[0]?.idempotency_key)).toStartWith("telegram-study:")
      await ctx.client.execute({
        sql: `
          INSERT INTO telegram_community_bots (
            telegram_community_bot_id, community_id, encrypted_bot_token, token_last4,
            encryption_key_version, telegram_bot_user_id, bot_username, bot_display_name,
            webhook_id, webhook_secret, webhook_status, status, created_at, updated_at,
            actor_user_id
          ) VALUES (
            'tcb_study_voice_replaced', ?1, ?2, '7890', 1, '987655',
            'OldVoiceStudyBot', 'Old voice study bot', 'tgb_study_voice_replaced',
            'old-voice-secret', 'disabled', 'revoked', ?3, ?3, 'route_author'
          )
        `,
        args: [
          communityId,
          encryptTelegramBotToken({ plaintextToken: "987655:telegramstudyoldtoken1234567890", wrapKey }),
          now,
        ],
      })
      await ctx.client.execute({
        sql: `
          INSERT INTO telegram_study_voice_intents (
            intent_id, telegram_community_bot_id, telegram_user_id, user_id,
            community_id, post_id, exercise_id, exercise_type, target_language,
            study_session_id, attempt_number, presentation_number, idempotency_key,
            status, prompt_delivery_status, expires_at, created_at, updated_at
          )
          SELECT
            'tsv_other_bot', 'tcb_study_voice_replaced', telegram_user_id, user_id,
            community_id, post_id, exercise_id, exercise_type, target_language,
            study_session_id, attempt_number, presentation_number, 'telegram-study:other-bot',
            'pending', 'sent', expires_at, created_at, updated_at
          FROM telegram_study_voice_intents
          WHERE telegram_community_bot_id = 'tcb_study_voice'
        `,
      })
      await ctx.client.execute({
        sql: `
          UPDATE telegram_study_voice_intents
          SET status = 'processing',
              processing_lease_id = 'abandoned-lease',
              processing_lease_expires_at = '2020-01-01T00:00:00.000Z'
          WHERE telegram_community_bot_id = 'tcb_study_voice'
        `,
      })

      const voiceUpdate = {
        update_id: 9001,
        message: {
          chat: { id: 787878, type: "private" },
          date: 1785499200,
          from: { id: 787878, is_bot: false },
          message_id: 654,
          voice: {
            duration: 2,
            file_id: "voice-study-file",
            file_unique_id: "voice-study-unique",
          },
        },
      }
      const webhook = await app.request(
        "http://pirate.test/telegram/community-bots/tgb_study_voice/webhook",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-telegram-bot-api-secret-token": "voice-secret",
          },
          body: JSON.stringify(voiceUpdate),
        },
        ctx.env,
      )
      expect(webhook.status).toBe(200)
      const retryable = await ctx.client.execute({
        sql: `
          SELECT status, expires_at
          FROM telegram_study_voice_intents
          WHERE telegram_community_bot_id = 'tcb_study_voice'
        `,
      })
      expect(retryable.rows[0]?.status).toBe("pending")
      expect(Date.parse(String(retryable.rows[0]?.expires_at))).toBeGreaterThan(Date.now())
      const communityClient = createClient({
        url: buildLocalCommunityDbUrl(ctx.communityDbRoot, communityId),
      })
      const attemptsAfterTranscriptionFailure = await communityClient.execute({
        sql: "SELECT idempotency_key FROM song_study_attempt WHERE user_id = ?1",
        args: [session.userId],
      })
      expect(attemptsAfterTranscriptionFailure.rows).toHaveLength(0)

      const retryVoiceUpdate = {
        ...voiceUpdate,
        update_id: 9002,
        message: {
          ...voiceUpdate.message,
          message_id: 655,
          voice: {
            ...voiceUpdate.message.voice,
            file_id: "voice-study-file-retry",
            file_unique_id: "voice-study-unique-retry",
          },
        },
      }
      const backgroundTasks: Promise<void>[] = []
      const executionCtx = {
        passThroughOnException() {},
        waitUntil(promise: Promise<void>) {
          backgroundTasks.push(promise)
        },
      } as ExecutionContext
      const webhookRequest = () => app.fetch(
        new Request("http://pirate.test/telegram/community-bots/tgb_study_voice/webhook", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-telegram-bot-api-secret-token": "voice-secret",
          },
          body: JSON.stringify(retryVoiceUpdate),
        }),
        ctx.env,
        executionCtx,
      )
      const [retryWebhook, concurrentDuplicateWebhook] = await Promise.all([
        webhookRequest(),
        webhookRequest(),
      ])
      expect(retryWebhook.status).toBe(200)
      expect(concurrentDuplicateWebhook.status).toBe(200)
      expect(backgroundTasks).toHaveLength(1)
      await Promise.all(backgroundTasks)
      expect(transcriptionRequests).toBe(2)
      const consumed = await ctx.client.execute({
        sql: `
          SELECT status, telegram_voice_message_id, telegram_voice_file_unique_id
          FROM telegram_study_voice_intents
          WHERE telegram_community_bot_id = 'tcb_study_voice'
        `,
      })
      expect(consumed.rows[0]).toMatchObject({
        status: "consumed",
        telegram_voice_file_unique_id: "voice-study-unique-retry",
        telegram_voice_message_id: 655,
      })
      const otherBotIntent = await ctx.client.execute({
        sql: "SELECT status FROM telegram_study_voice_intents WHERE intent_id = 'tsv_other_bot'",
      })
      expect(otherBotIntent.rows[0]?.status).toBe("pending")
      try {
        const attempts = await communityClient.execute({
          sql: `
            SELECT idempotency_key, exercise_type
            FROM song_study_attempt
            WHERE user_id = ?1
          `,
          args: [session.userId],
        })
        expect(attempts.rows).toHaveLength(1)
        expect(String(attempts.rows[0]?.idempotency_key)).toStartWith("telegram-study:")
        expect(String(attempts.rows[0]?.exercise_type)).toBe("say_it_back")
      } finally {
        communityClient.close()
      }

      const nextIntentResponse = await app.request(
        `http://pirate.test/communities/${communityId}/posts/pst_study_route_song/study/telegram_voice_intents`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${session.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            exercise_id: nextExercise!.id,
            target_language: "es",
          }),
        },
        ctx.env,
      )
      expect(nextIntentResponse.status).toBe(201)
      await ctx.client.execute({
        sql: `
          UPDATE telegram_study_voice_intents
          SET expires_at = '2020-01-01T00:00:00.000Z'
          WHERE telegram_community_bot_id = 'tcb_study_voice'
            AND status = 'pending'
        `,
      })
      const expiredVoiceUpdate = {
        ...voiceUpdate,
        update_id: 9003,
        message: {
          ...voiceUpdate.message,
          message_id: 656,
          voice: {
            ...voiceUpdate.message.voice,
            file_id: "voice-study-file-expired",
            file_unique_id: "voice-study-unique-expired",
          },
        },
      }
      const requestsBeforeExpiredReply = telegramRequests.length
      const expiredWebhook = await app.request(
        "http://pirate.test/telegram/community-bots/tgb_study_voice/webhook",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-telegram-bot-api-secret-token": "voice-secret",
          },
          body: JSON.stringify(expiredVoiceUpdate),
        },
        ctx.env,
      )
      expect(expiredWebhook.status).toBe(200)
      const expiredIntent = await ctx.client.execute({
        sql: `
          SELECT status
          FROM telegram_study_voice_intents
          WHERE telegram_community_bot_id = 'tcb_study_voice'
            AND telegram_voice_message_id = 656
        `,
      })
      expect(expiredIntent.rows[0]?.status).toBe("expired")
      expect(telegramRequests.length).toBe(requestsBeforeExpiredReply + 1)

      const expiredRedelivery = await app.request(
        "http://pirate.test/telegram/community-bots/tgb_study_voice/webhook",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-telegram-bot-api-secret-token": "voice-secret",
          },
          body: JSON.stringify(expiredVoiceUpdate),
        },
        ctx.env,
      )
      expect(expiredRedelivery.status).toBe(200)
      expect(telegramRequests.length).toBe(requestsBeforeExpiredReply + 1)
    } finally {
      globalThis.fetch = originalFetch
    }
  }, 120_000)

  test("POST /communities/:communityId/posts/:postId/study/attempts exposes debug timing as headers only", async () => {
    const ctx = await createRouteTestContext({ SONG_STUDY_ATTEMPT_TIMING_LOGS: "true" })
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "study-route-attempt-timing")
    const communityId = "cmt_study_route_attempt_timing"
    await seedStudySong({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
    })
    await ctx.client.execute({
      sql: `
        INSERT INTO users (
          user_id, verification_state, capability_provider,
          verification_capabilities_json, verified_at,
          created_at, updated_at
        )
        VALUES (
          'route_author', 'verified', 'self', '["unique_human"]',
          '2026-06-29T08:00:00.000Z',
          '2026-06-29T08:00:00.000Z',
          '2026-06-29T08:00:00.000Z'
        )
        ON CONFLICT (user_id) DO NOTHING
      `,
    })
    await ctx.client.execute({
      sql: `
        INSERT INTO communities (
          community_id, creator_user_id, display_name, description,
          membership_mode, status, provisioning_state, transfer_state,
          route_slug, created_at, updated_at
        )
        VALUES (
          ?1, 'route_author', 'Study Route Club', NULL,
          'open', 'active', 'active', 'none',
          NULL, '2026-06-29T08:00:00.000Z', '2026-06-29T08:00:00.000Z'
        )
      `,
      args: [communityId],
    })
    await ctx.client.execute({
      sql: `
        INSERT INTO community_assistant_credentials (
          community_assistant_credential_id, community_id, provider, encrypted_secret,
          key_last4, encryption_key_version, status, created_at, revoked_at,
          rotated_from, actor_user_id
        )
        VALUES (
          'cac_study_route_timing_elevenlabs', ?1, 'elevenlabs', 'test-encrypted-key',
          'labs', 1, 'active', '2026-06-29T08:00:00.000Z', NULL, NULL,
          'route_author'
        )
      `,
      args: [communityId],
    })

    const studyResponse = await app.request(
      `http://pirate.test/communities/${communityId}/posts/pst_study_route_song/study?target_language=es`,
      { headers: { authorization: `Bearer ${session.accessToken}` } },
      ctx.env,
    )
    const studyBody = await json(studyResponse) as {
      exercises?: Array<{ id: string; reference_text?: string; type?: string }>
      session?: { id?: string | null }
    }
    const exercise = studyBody.exercises?.find((item) => item.type === "say_it_back")
    expect(exercise).toBeTruthy()

    const response = await app.request(
      `http://pirate.test/communities/${communityId}/posts/pst_study_route_song/study/attempts`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          "content-type": "application/json",
        },
        method: "POST",
        body: JSON.stringify({
          attempt_number: 1,
          exercise_id: exercise!.id,
          idempotency_key: "study-route-attempt-timing",
          session_id: studyBody.session?.id,
          transcript: exercise!.reference_text,
          type: "say_it_back",
        }),
      },
      ctx.env,
    )

    expect(response.status).toBe(200)
    const timingHeader = response.headers.get("x-song-study-attempt-timing")
    expect(timingHeader).toBeTruthy()
    const timing = JSON.parse(timingHeader ?? "{}") as { total_ms?: number; write_tx_ms?: number }
    expect(typeof timing.total_ms).toBe("number")
    expect(typeof timing.write_tx_ms).toBe("number")
    expect(response.headers.get("server-timing")).toContain("song-study-attempt")

    const body = await json(response) as Record<string, unknown>
    expect(body.object).toBe("song_study_attempt_result")
    expect(body["x-song-study-attempt-timing"]).toBeUndefined()
    expect(body["timing"]).toBeUndefined()
  }, 120_000)

  test("GET /communities/:communityId/posts/:postId/streaks/leaderboard returns active entries and viewer standing", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "study-route-streak-reader")
    const communityId = "cmt_study_route_streaks"
    await seedStudySong({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
    })
    await ctx.client.execute({
      sql: `
        INSERT INTO users (
          user_id, verification_state, capability_provider,
          verification_capabilities_json, verified_at,
          created_at, updated_at
        )
        VALUES (
          'route_author', 'verified', 'self', '["unique_human"]',
          '2026-06-29T08:00:00.000Z',
          '2026-06-29T08:00:00.000Z',
          '2026-06-29T08:00:00.000Z'
        )
        ON CONFLICT (user_id) DO NOTHING
      `,
    })
    await ctx.client.execute({
      sql: `
        INSERT INTO communities (
          community_id, creator_user_id, display_name, description,
          membership_mode, status, provisioning_state, transfer_state,
          route_slug, created_at, updated_at
        )
        VALUES (
          ?1, 'route_author', 'Study Route Club', NULL,
          'open', 'active', 'active', 'none',
          NULL, '2026-06-29T08:00:00.000Z', '2026-06-29T08:00:00.000Z'
        )
      `,
      args: [communityId],
    })

    const today = new Date().toISOString().slice(0, 10)
    const communityClient = createClient({
      url: buildLocalCommunityDbUrl(ctx.communityDbRoot, communityId),
    })
    try {
      await communityClient.execute({
        sql: `
          INSERT INTO community_memberships (
            membership_id, community_id, user_id, status, joined_at, created_at, updated_at
          )
          VALUES ('mbr_streak_reader', ?1, ?2, 'member', ?3, ?3, ?3)
        `,
        args: [communityId, session.userId, "2026-06-29T08:00:00.000Z"],
      })
      await communityClient.execute({
        sql: `
          INSERT INTO song_streaks (
            user_id, post_id, community_id, current_streak, best_streak,
            last_qualified_date, streak_started_date, total_qualified_days,
            created_at, updated_at
          )
          VALUES (?1, 'pst_study_route_song', ?2, 3, 5, ?3, ?3, 8, ?4, ?4)
        `,
        args: [session.userId, communityId, today, "2026-06-29T08:00:00.000Z"],
      })
      await communityClient.execute({
        sql: `
          INSERT INTO song_engagement_days (
            user_id, post_id, community_id, activity_date,
            study_attempt_count, study_correct_count, study_target_count,
            karaoke_pass_count, qualified, created_at, updated_at
          )
          VALUES (?1, 'pst_study_route_song', ?2, ?3, 3, 2, 5, 0, 0, ?4, ?4)
        `,
        args: [session.userId, communityId, today, "2026-06-29T08:00:00.000Z"],
      })
    } finally {
      communityClient.close()
    }

    const response = await app.request(
      `http://pirate.test/communities/${communityId}/posts/pst_study_route_song/streaks/leaderboard?limit=10`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )

    expect(response.status).toBe(200)
    const body = await json(response) as {
      entries?: Array<{
        current_streak?: number
        identity?: { user_id?: string }
        is_viewer?: boolean
        rank?: number
      }>
      object?: string
      total_active_streaks?: number
      viewer?: {
        alive?: boolean
        current_streak?: number
        qualified_today?: boolean
        study_attempts_today?: number
        study_target_today?: number
      }
    }
    expect(body.object).toBe("song_streak_leaderboard")
    expect(body.total_active_streaks).toBe(1)
    expect(body.entries?.map((entry) => ({
      current_streak: entry.current_streak,
      identity: { user_id: entry.identity?.user_id },
      is_viewer: entry.is_viewer,
      rank: entry.rank,
    }))).toEqual([{
      current_streak: 3,
      identity: { user_id: session.userId },
      is_viewer: true,
      rank: 1,
    }])
    expect(body.viewer).toMatchObject({
      alive: true,
      current_streak: 3,
      qualified_today: false,
      study_attempts_today: 3,
      study_target_today: 5,
    })
  }, 120_000)
})
