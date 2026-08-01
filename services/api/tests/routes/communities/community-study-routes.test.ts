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
import { handleTelegramChatStudyCallback } from "../../../src/lib/telegram/chat-study-service"
import { createTelegramStudyVoiceIntent } from "../../../src/lib/telegram/study-voice-service"

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

async function seedReadyTranslationExercises(input: {
  communityDbRoot: string
  communityId: string
}): Promise<void> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })
  const now = "2026-06-29T08:00:00.000Z"
  try {
    await client.execute({
      sql: `
        INSERT INTO song_study_unit (
          id, post_id, line_id, line_index, source_language, prompt_text,
          reference_text, say_it_back_status, unit_version, max_attempts,
          created_at, updated_at
        ) VALUES
          ('stu_chat_1', 'pst_study_route_song', 'line_chat_1', 0, 'en',
           'Line one for route study', 'Line one for route study',
           'unavailable', 2, 2, ?1, ?1),
          ('stu_chat_2', 'pst_study_route_song', 'line_chat_2', 1, 'en',
           'Line two for route study', 'Line two for route study',
           'unavailable', 2, 2, ?1, ?1)
      `,
      args: [now],
    })
    for (const [index, unitId] of ["stu_chat_1", "stu_chat_2"].entries()) {
      await client.execute({
        sql: `
          INSERT INTO song_study_unit_localization (
            id, unit_id, target_language, localization_version, status,
            question, translation_text, options_json, correct_option_id,
            explanation_text, max_attempts, generated_at, created_at, updated_at
          ) VALUES (?1, ?2, 'es', 5, 'ready',
                    'Choose the best translation.',
                    ?3, ?4, ?5, 'Server-owned explanation.', 1, ?6, ?6, ?6)
        `,
        args: [
          `sul_chat_${index + 1}`,
          unitId,
          `Traducción correcta ${index + 1}`,
          JSON.stringify([
            { id: `opt_chat_${index + 1}_correct`, text: `Traducción correcta ${index + 1}` },
            { id: `opt_chat_${index + 1}_wrong`, text: `Traducción incorrecta ${index + 1}` },
          ]),
          `opt_chat_${index + 1}_correct`,
          now,
        ],
      })
    }
    await client.execute({
      sql: `
        INSERT INTO song_study_generation_run (
          id, post_id, target_language, generation_version, status,
          attempt_count, created_at, updated_at, completed_at
        ) VALUES (
          'sgr_chat_es', 'pst_study_route_song', 'es', 5, 'ready',
          1, ?1, ?1, ?1
        )
      `,
      args: [now],
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

  test("runs song selection and multiple choice entirely in a community bot chat", async () => {
    const wrapKey = "cd".repeat(32)
    const communityId = "cmt_chat_native_study"
    const botToken = "765432:telegramchatstudytoken1234567890"
    const ctx = await createRouteTestContext({
      CREDENTIAL_WRAP_KEY: wrapKey,
      CREDENTIAL_WRAP_KEY_VERSION: "1",
      PIRATE_WEB_PUBLIC_ORIGIN: "https://pirate.test",
      TELEGRAM_STUDY_VOICE_COMMUNITY_IDS: communityId,
      TELEGRAM_STUDY_VOICE_ENABLED: "true",
    })
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "chat-native-study")
    await seedStudySong({ communityDbRoot: ctx.communityDbRoot, communityId })
    await seedReadyTranslationExercises({ communityDbRoot: ctx.communityDbRoot, communityId })
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
        ) VALUES (?1, 'route_author', 'Chat Study', 'open', 'active',
                  'active', 'none', ?2, ?2)
      `,
      args: [communityId, now],
    })
    await ctx.client.execute({
      sql: `
        INSERT INTO auth_provider_links (
          auth_provider_link_id, user_id, provider, provider_subject,
          provider_user_ref, status, linked_at, created_at, updated_at
        ) VALUES (
          'apl_chat_study', ?1, 'telegram', '454545', 'chat_student',
          'active', ?2, ?2, ?2
        )
      `,
      args: [session.userId, now],
    })
    await ctx.client.execute({
      sql: `
        INSERT INTO telegram_accounts (
          telegram_user_id, user_id, username, first_seen_at, last_seen_at, updated_at
        ) VALUES ('454545', ?1, 'chat_student', ?2, ?2, ?2)
      `,
      args: [session.userId, now],
    })
    await ctx.client.execute({
      sql: `
        INSERT INTO telegram_community_bots (
          telegram_community_bot_id, community_id, encrypted_bot_token, token_last4,
          encryption_key_version, telegram_bot_user_id, bot_username, bot_display_name,
          webhook_id, webhook_secret, webhook_status, status, created_at, updated_at,
          actor_user_id
        ) VALUES (
          'tcb_chat_study', ?1, ?2, '7890', 1, '765432',
          'ChatStudyBot', 'Chat study bot', 'tgb_chat_study', 'chat-study-secret',
          'active', 'active', ?3, ?3, 'route_author'
        )
      `,
      args: [
        communityId,
        encryptTelegramBotToken({ plaintextToken: botToken, wrapKey }),
        now,
      ],
    })
    const originalFetch = globalThis.fetch
    const telegramBodies: Array<Record<string, unknown>> = []
    let messageId = 700
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      if (request.url.startsWith(`https://api.telegram.org/bot${botToken}/`)) {
        telegramBodies.push(await request.json() as Record<string, unknown>)
        return Response.json({ ok: true, result: request.url.endsWith("/answerCallbackQuery") ? true : { message_id: messageId++ } })
      }
      return originalFetch(input, init)
    }) as typeof fetch
    const webhook = (body: unknown) => app.request(
      "http://pirate.test/telegram/community-bots/tgb_chat_study/webhook",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "chat-study-secret",
        },
        body: JSON.stringify(body),
      },
      ctx.env,
    )
    try {
      ctx.env.TELEGRAM_STUDY_VOICE_ENABLED = "false"
      const gatedStart = await webhook({
        update_id: 5000,
        message: {
          chat: { id: 454545, type: "private" },
          date: 1785499199,
          from: { id: 454545, is_bot: false, language_code: "es" },
          message_id: 599,
          text: "/start",
        },
      })
      expect(gatedStart.status).toBe(200)
      const gatedWelcome = telegramBodies.find((body) => typeof body.reply_markup === "object")
      const gatedMarkup = gatedWelcome?.reply_markup as {
        inline_keyboard?: Array<Array<{ callback_data?: string }>>
      }
      expect(gatedMarkup.inline_keyboard?.flat().some((button) => button.callback_data === "menu:study")).toBe(false)
      const gatedSessions = await ctx.client.execute(
        "SELECT chat_study_session_id FROM telegram_chat_study_sessions",
      )
      expect(gatedSessions.rows).toHaveLength(0)
      ctx.env.TELEGRAM_STUDY_VOICE_ENABLED = "true"
      telegramBodies.length = 0

      const start = await webhook({
        update_id: 5001,
        message: {
          chat: { id: 454545, type: "private" },
          date: 1785499200,
          from: { id: 454545, is_bot: false, language_code: "es" },
          message_id: 600,
          text: "/start",
        },
      })
      expect(start.status).toBe(200)
      expect(telegramBodies.some((body) => body.text === "Choose a song to study:")).toBe(false)
      const welcome = telegramBodies.find((body) => typeof body.text === "string")
      const welcomeMarkup = welcome?.reply_markup as {
        inline_keyboard?: Array<Array<{ callback_data?: string; text?: string }>>
      }
      expect(welcomeMarkup.inline_keyboard?.flat().some((button) => button.callback_data === "menu:study")).toBe(true)
      expect(welcomeMarkup.inline_keyboard?.flat().some((button) => button.callback_data === "menu:assistant")).toBe(false)
      const sessionsAfterStart = await ctx.client.execute(
        "SELECT chat_study_session_id FROM telegram_chat_study_sessions",
      )
      expect(sessionsAfterStart.rows).toHaveLength(0)

      const privateSongClient = createClient({
        url: buildLocalCommunityDbUrl(ctx.communityDbRoot, communityId),
      })
      await privateSongClient.execute(
        "UPDATE posts SET visibility = 'members_only' WHERE post_id = 'pst_study_route_song'",
      )
      privateSongClient.close()

      telegramBodies.length = 0
      const menuStudy = await webhook({
        update_id: 5002,
        callback_query: {
          id: "menu-study-callback",
          data: "menu:study",
          from: { id: 454545, is_bot: false, language_code: "es" },
          message: { chat: { id: 454545, type: "private" }, message_id: 600 },
        },
      })
      expect(menuStudy.status).toBe(200)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(telegramBodies.some((body) => body.text === "Choose a song to study:")).toBe(false)
      expect(telegramBodies.some((body) => body.text === "No songs are ready to study in this community yet.")).toBe(true)
      expect(telegramBodies.some((body) => String(body.text).includes("Route Song"))).toBe(false)

      telegramBodies.length = 0
      const repeatedMenuStudy = await webhook({
        update_id: 5003,
        callback_query: {
          id: "menu-study-callback-repeat",
          data: "menu:study",
          from: { id: 454545, is_bot: false, language_code: "es" },
          message: { chat: { id: 454545, type: "private" }, message_id: 600 },
        },
      })
      expect(repeatedMenuStudy.status).toBe(200)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(telegramBodies.some((body) => body.text === "That study menu was already used. Send /study to choose a song again.")).toBe(true)

      const publicSongClient = createClient({
        url: buildLocalCommunityDbUrl(ctx.communityDbRoot, communityId),
      })
      await publicSongClient.execute(
        "UPDATE posts SET visibility = 'public' WHERE post_id = 'pst_study_route_song'",
      )
      publicSongClient.close()

      telegramBodies.length = 0
      const studyUpdate = {
        update_id: 5004,
        message: {
          chat: { id: 454545, type: "private" },
          date: 1785499201,
          from: { id: 454545, is_bot: false, language_code: "es" },
          message_id: 601,
          text: "/study",
        },
      }
      const [study, studyRedelivery] = await Promise.all([
        webhook(studyUpdate),
        webhook(studyUpdate),
      ])
      expect(study.status).toBe(200)
      expect(studyRedelivery.status).toBe(200)
      expect(telegramBodies.filter((body) => body.text === "Choose a song to study:")).toHaveLength(1)
      expect(telegramBodies.some((body) => body.text === "That study menu was already used. Send /study to choose a song again.")).toBe(false)
      const studyDeliveries = await ctx.client.execute(
        "SELECT status FROM telegram_chat_study_message_deliveries",
      )
      expect(studyDeliveries.rows).toHaveLength(2)
      expect(studyDeliveries.rows.every((row) => row.status === "consumed")).toBe(true)
      const picker = telegramBodies.find((body) => body.text === "Choose a song to study:")
      expect(picker).toBeTruthy()
      const pickerMarkup = picker?.reply_markup as {
        inline_keyboard?: Array<Array<{ callback_data?: string }>>
      }
      const songCallback = pickerMarkup.inline_keyboard?.[0]?.[0]?.callback_data
      expect(songCallback).toMatch(/^study:[a-f0-9]{18}:0$/)
      expect(songCallback!.length).toBeLessThanOrEqual(64)
      expect(songCallback).not.toContain("pst_")

      await handleTelegramChatStudyCallback({
        bot: {
          communityId,
          id: "tcb_other_sovereign_bot",
          token: botToken,
          userId: "765433",
          username: "OtherStudyBot",
          webhookId: "tgb_other_study",
          webhookSecret: "other-study-secret",
        },
        callback: {
          id: "callback-wrong-bot",
          data: songCallback,
          from: { id: 454545, is_bot: false, language_code: "es" },
          message: {
            chat: { id: 454545, type: "private" },
            message_id: 700,
          },
        },
        env: ctx.env,
      })
      const stillSelecting = await ctx.client.execute({
        sql: `
          SELECT status
          FROM telegram_chat_study_sessions
          WHERE telegram_community_bot_id = 'tcb_chat_study'
            AND status = 'selecting'
        `,
      })
      expect(stillSelecting.rows[0]?.status).toBe("selecting")

      const select = await webhook({
        update_id: 5002,
        callback_query: {
          id: "callback-select-song",
          data: songCallback,
          from: { id: 454545, is_bot: false, language_code: "es" },
          message: {
            chat: { id: 454545, type: "private" },
            message_id: 700,
          },
        },
      })
      expect(select.status).toBe(200)
      const exercisePrompt = [...telegramBodies].reverse().find((body) =>
        typeof body.text === "string" && body.text.includes("Choose the best translation.")
      )
      expect(exercisePrompt).toBeTruthy()
      const answerMarkup = exercisePrompt?.reply_markup as {
        inline_keyboard?: Array<Array<{ callback_data?: string; text?: string }>>
      }
      const answerButtons = answerMarkup.inline_keyboard?.flat() ?? []
      const correctButton = answerButtons.find((button) => button.text === "Traducción correcta 1")
      expect(correctButton?.callback_data).toMatch(/^study:[a-f0-9]{18}:[0-9]{1,2}$/)
      expect(correctButton?.callback_data).not.toContain("opt_chat")
      expect(JSON.stringify(answerMarkup)).not.toContain("correct_option")

      const answerUpdate = {
        update_id: 5003,
        callback_query: {
          id: "callback-answer-once",
          data: correctButton!.callback_data,
          from: { id: 454545, is_bot: false, language_code: "es" },
          message: {
            chat: { id: 454545, type: "private" },
            message_id: 701,
          },
        },
      }
      const competingTap = {
        ...answerUpdate,
        callback_query: {
          ...answerUpdate.callback_query,
          id: "callback-answer-competing-tap",
        },
      }
      const [answer, redelivery, competing] = await Promise.all([
        webhook(answerUpdate),
        webhook(answerUpdate),
        webhook(competingTap),
      ])
      expect(answer.status).toBe(200)
      expect(redelivery.status).toBe(200)
      expect(competing.status).toBe(200)

      const attemptsClient = createClient({
        url: buildLocalCommunityDbUrl(ctx.communityDbRoot, communityId),
      })
      try {
        const attempts = await attemptsClient.execute({
          sql: `
            SELECT idempotency_key, selected_option_id
            FROM song_study_attempt
            WHERE user_id = ?1
          `,
          args: [session.userId],
        })
        expect(attempts.rows).toHaveLength(1)
        expect(String(attempts.rows[0]?.idempotency_key)).toStartWith("telegram-chat-study:")
        expect(attempts.rows[0]?.selected_option_id).toBe("opt_chat_1_correct")
      } finally {
        attemptsClient.close()
      }
      const callbacks = await ctx.client.execute({
        sql: `
          SELECT status
          FROM telegram_chat_study_callback_deliveries
          WHERE callback_query_id = 'callback-answer-once'
        `,
      })
      expect(callbacks.rows).toHaveLength(1)
      expect(callbacks.rows[0]?.status).toBe("consumed")
      const secondPrompt = [...telegramBodies].reverse().find((body) =>
        typeof body.text === "string" && body.text.includes("Line two for route study")
      )
      const secondMarkup = secondPrompt?.reply_markup as {
        inline_keyboard?: Array<Array<{ callback_data?: string; text?: string }>>
      }
      const secondWrong = secondMarkup.inline_keyboard?.flat().find((button) =>
        button.text === "Traducción incorrecta 2"
      )
      expect(secondWrong?.callback_data).toMatch(/^study:[a-f0-9]{18}:[0-9]{1,2}$/)
      const secondAnswer = await webhook({
        update_id: 5004,
        callback_query: {
          id: "callback-answer-second",
          data: secondWrong!.callback_data,
          from: { id: 454545, is_bot: false, language_code: "es" },
          message: {
            chat: { id: 454545, type: "private" },
            message_id: 702,
          },
        },
      })
      expect(secondAnswer.status).toBe(200)
      expect(telegramBodies.some((body) =>
        typeof body.text === "string"
        && body.text.includes("❌ Traducción incorrecta 2")
        && body.text.includes("✅ Correct answer: Traducción correcta 2")
      )).toBe(true)
      const retryPrompt = [...telegramBodies].reverse().find((body) =>
        typeof body.text === "string"
        && body.text.includes("Line two for route study")
        && typeof body.reply_markup === "object"
      )
      const retryMarkup = retryPrompt?.reply_markup as {
        inline_keyboard?: Array<Array<{ callback_data?: string; text?: string }>>
      }
      const retryCorrect = retryMarkup.inline_keyboard?.flat().find((button) =>
        button.text === "Traducción correcta 2"
      )
      expect(retryCorrect?.callback_data).toMatch(/^study:[a-f0-9]{18}:[0-9]{1,2}$/)
      const retryAnswer = await webhook({
        update_id: 5005,
        callback_query: {
          id: "callback-answer-second-retry",
          data: retryCorrect!.callback_data,
          from: { id: 454545, is_bot: false, language_code: "es" },
          message: {
            chat: { id: 454545, type: "private" },
            message_id: 703,
          },
        },
      })
      expect(retryAnswer.status).toBe(200)
      expect(telegramBodies.some((body) =>
        typeof body.text === "string"
        && body.text.startsWith("Study complete: Route Song")
        && body.text.includes("Score:")
      )).toBe(true)
      const completed = await ctx.client.execute({
        sql: `
          SELECT status
          FROM telegram_chat_study_sessions
          WHERE telegram_community_bot_id = 'tcb_chat_study'
            AND status = 'completed'
        `,
      })
      expect(completed.rows[0]?.status).toBe("completed")
    } finally {
      globalThis.fetch = originalFetch
    }
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
    let forceTranscriptionFailure = false
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
        if (transcriptionRequests === 1 || forceTranscriptionFailure) {
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
      const voicePrompt = await telegramRequests[0]!.clone().json() as { text?: string }
      expect(voicePrompt.text).toContain("community bot owner can access and listen")
      expect(voicePrompt.text).toContain("Pirate also receives this recording")
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
          SELECT status, expires_at, telegram_voice_message_id,
                 telegram_voice_file_id, telegram_voice_file_unique_id
          FROM telegram_study_voice_intents
          WHERE telegram_community_bot_id = 'tcb_study_voice'
        `,
      })
      expect(retryable.rows[0]?.status).toBe("pending")
      expect(Date.parse(String(retryable.rows[0]?.expires_at))).toBeGreaterThan(Date.now())
      expect(retryable.rows[0]?.telegram_voice_message_id).toBeNull()
      expect(retryable.rows[0]?.telegram_voice_file_id).toBeNull()
      expect(retryable.rows[0]?.telegram_voice_file_unique_id).toBeNull()
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

      await ctx.client.execute({
        sql: "DELETE FROM telegram_accounts WHERE telegram_user_id = '787878'",
      })
      await ctx.client.execute({
        sql: `
          INSERT INTO telegram_accounts (
            telegram_user_id, user_id, username, first_seen_at, last_seen_at, updated_at
          ) VALUES ('787879', ?1, 'other_student_account', ?2, ?2, ?2)
        `,
        args: [session.userId, now],
      })
      const nextIntent = await createTelegramStudyVoiceIntent({
        actor: { authType: "user", userId: session.userId },
        communityId,
        env: ctx.env,
        exerciseId: nextExercise!.id,
        postId: "pst_study_route_song",
        targetLanguage: "es",
        telegramUserId: "787878",
      })
      expect(nextIntent.status).toBe("pending")
      const chatOriginIntent = await ctx.client.execute({
        sql: `
          SELECT telegram_user_id
          FROM telegram_study_voice_intents
          WHERE intent_id = ?1
        `,
        args: [nextIntent.id],
      })
      expect(chatOriginIntent.rows[0]?.telegram_user_id).toBe("787878")
      await ctx.client.execute({
        sql: `
          UPDATE telegram_study_voice_intents
          SET processing_attempt_count = 2
          WHERE telegram_community_bot_id = 'tcb_study_voice'
            AND status = 'pending'
        `,
      })
      forceTranscriptionFailure = true
      const terminalVoiceUpdate = {
        ...voiceUpdate,
        update_id: 9003,
        message: {
          ...voiceUpdate.message,
          message_id: 656,
          voice: {
            ...voiceUpdate.message.voice,
            file_id: "voice-study-file-terminal",
            file_unique_id: "voice-study-unique-terminal",
          },
        },
      }
      const terminalWebhook = await app.request(
        "http://pirate.test/telegram/community-bots/tgb_study_voice/webhook",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-telegram-bot-api-secret-token": "voice-secret",
          },
          body: JSON.stringify(terminalVoiceUpdate),
        },
        ctx.env,
      )
      expect(terminalWebhook.status).toBe(200)
      const terminalIntent = await ctx.client.execute({
        sql: `
          SELECT status, processing_attempt_count, last_error_code
          FROM telegram_study_voice_intents
          WHERE telegram_community_bot_id = 'tcb_study_voice'
            AND telegram_voice_message_id = 656
        `,
      })
      expect(terminalIntent.rows[0]).toMatchObject({
        last_error_code: "voice_processing_attempts_exhausted",
        processing_attempt_count: 3,
        status: "failed",
      })
      forceTranscriptionFailure = false
      await ctx.client.execute({
        sql: "DELETE FROM telegram_accounts WHERE telegram_user_id = '787879'",
      })
      await ctx.client.execute({
        sql: `
          INSERT INTO telegram_accounts (
            telegram_user_id, user_id, username, first_seen_at, last_seen_at, updated_at
          ) VALUES ('787878', ?1, 'student', ?2, ?2, ?2)
        `,
        args: [session.userId, now],
      })

      const expiringIntentResponse = await app.request(
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
      expect(expiringIntentResponse.status).toBe(201)
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
        update_id: 9004,
        message: {
          ...voiceUpdate.message,
          message_id: 657,
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
            AND telegram_voice_message_id = 657
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
            timezone, timezone_updated_at, active_until_at,
            created_at, updated_at
          )
          VALUES (?1, 'pst_study_route_song', ?2, 3, 5, ?3, ?3, 8, 'UTC', ?4, ?5, ?4, ?4)
        `,
        args: [
          session.userId,
          communityId,
          today,
          "2026-06-29T08:00:00.000Z",
          new Date(Date.now() + 86_400_000).toISOString(),
        ],
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
      rank: 1,
      study_attempts_today: 3,
      study_target_today: 5,
    })
  }, 120_000)
})
