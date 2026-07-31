import type { ActorContext, AdminActorContext } from "../auth-middleware"
import { getCommunityRepository } from "../communities/db-community-repository"
import { conflictError, notFoundError, providerUnavailable } from "../errors"
import { makeId, nowIso } from "../helpers"
import {
  getPostStudyPayload,
  submitPostStudyAttempt,
  transcribePostStudyAudio,
  type SongStudyAttemptResult,
} from "../posts/post-study-service"
import { publicCommunityId, publicPostId } from "../public-ids"
import { rowValue } from "../sql-row"
import { getControlPlaneClient, withBackgroundControlPlaneClients } from "../runtime-deps"
import type { Env } from "../../env"
import {
  downloadTelegramFile,
  getTelegramFile,
  sendTelegramMessage,
} from "./bot-api"
import {
  decryptActiveCommunityTelegramBotOrNull,
  type TelegramCommunityBotCredential,
} from "./community-bot-service"
import type { TelegramWebhookMessage } from "./webhook-parsing"
import { inferTelegramAudioMimeType, telegramIdentifier } from "./webhook-parsing"
import { isTelegramStudyVoiceEnabled } from "./study-voice-admission"

const VOICE_INTENT_TTL_MS = 10 * 60 * 1000
const VOICE_PROCESSING_LEASE_MS = 2 * 60 * 1000
const VOICE_PROCESSING_MAX_ATTEMPTS = 3

type VoiceIntentRow = {
  attemptNumber: number
  chatStudySessionId: string | null
  communityId: string
  exerciseId: string
  expiresAt: string
  id: string
  idempotencyKey: string
  postId: string
  processingAttemptCount: number
  processingLeaseExpiresAt: string | null
  promptMessageId: number | null
  sessionId: string
  status: string
  targetLanguage: string
  telegramUserId: string
  userId: string
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function numberOrNull(value: unknown): number | null {
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : null
}

function serializeIntentRow(row: unknown): VoiceIntentRow | null {
  const id = stringOrNull(rowValue(row, "intent_id"))
  const userId = stringOrNull(rowValue(row, "user_id"))
  const telegramUserId = stringOrNull(rowValue(row, "telegram_user_id"))
  const communityId = stringOrNull(rowValue(row, "community_id"))
  const postId = stringOrNull(rowValue(row, "post_id"))
  const exerciseId = stringOrNull(rowValue(row, "exercise_id"))
  const sessionId = stringOrNull(rowValue(row, "study_session_id"))
  const targetLanguage = stringOrNull(rowValue(row, "target_language"))
  const idempotencyKey = stringOrNull(rowValue(row, "idempotency_key"))
  const status = stringOrNull(rowValue(row, "status"))
  const expiresAt = stringOrNull(rowValue(row, "expires_at"))
  const attemptNumber = numberOrNull(rowValue(row, "attempt_number"))
  const processingAttemptCount = numberOrNull(rowValue(row, "processing_attempt_count"))
  if (
    !id
    || !userId
    || !telegramUserId
    || !communityId
    || !postId
    || !exerciseId
    || !sessionId
    || !targetLanguage
    || !idempotencyKey
    || !status
    || !expiresAt
    || !attemptNumber
    || processingAttemptCount === null
  ) {
    return null
  }
  return {
    attemptNumber,
    chatStudySessionId: stringOrNull(rowValue(row, "chat_study_session_id")),
    communityId,
    exerciseId,
    expiresAt,
    id,
    idempotencyKey,
    postId,
    processingAttemptCount,
    processingLeaseExpiresAt: stringOrNull(rowValue(row, "processing_lease_expires_at")),
    promptMessageId: numberOrNull(rowValue(row, "prompt_message_id")),
    sessionId,
    status,
    targetLanguage,
    telegramUserId,
    userId,
  }
}

async function telegramUserIdForPirateUser(env: Env, userId: string): Promise<string | null> {
  const result = await getControlPlaneClient(env).execute({
    sql: `
      SELECT telegram_user_id
      FROM telegram_accounts
      WHERE user_id = ?1
      LIMIT 1
    `,
    args: [userId],
  })
  return stringOrNull(rowValue(result.rows[0], "telegram_user_id"))
}

export type TelegramStudyVoiceIntentResource = {
  created: number
  expires_at: number
  id: string
  object: "telegram_study_voice_intent"
  status: "pending"
}

export async function createTelegramStudyVoiceIntent(input: {
  actor: ActorContext | AdminActorContext
  chatStudySessionId?: string | null
  communityId: string
  env: Env
  exerciseId: string
  postId: string
  targetLanguage?: string | null
}): Promise<TelegramStudyVoiceIntentResource> {
  if (!isTelegramStudyVoiceEnabled(input.env, input.communityId)) {
    throw conflictError("Telegram study voice messages are not enabled for this community")
  }
  const bot = await decryptActiveCommunityTelegramBotOrNull({
    env: input.env,
    communityId: input.communityId,
  })
  if (!bot) {
    throw notFoundError("Active community Telegram bot not found")
  }
  const telegramUserId = await telegramUserIdForPirateUser(input.env, input.actor.userId)
  if (!telegramUserId) {
    throw conflictError("Telegram account is not linked to this Pirate user")
  }

  const study = await getPostStudyPayload({
    actor: input.actor,
    communityId: input.communityId,
    communityRepository: getCommunityRepository(input.env),
    env: input.env,
    postId: input.postId,
    targetLanguage: input.targetLanguage,
  })
  const exercise = study.exercises.find((candidate) => candidate.id === input.exerciseId)
  if (
    study.access !== "ready"
    || !study.session?.id
    || !exercise
    || exercise.type !== "say_it_back"
    || exercise.mastered
    || exercise.presentation_count >= exercise.max_attempts
  ) {
    throw conflictError("This say-it-back exercise is not currently eligible")
  }

  const createdAt = nowIso()
  const expiresAt = new Date(Date.parse(createdAt) + VOICE_INTENT_TTL_MS).toISOString()
  const intentId = makeId("tsv")
  const idempotencyKey = `telegram-study:${intentId}`
  const attemptNumber = exercise.presentation_count + 1
  const client = getControlPlaneClient(input.env)
  const tx = await client.transaction("write")
  try {
    const active = await tx.execute({
      sql: `
        SELECT status
        FROM telegram_study_voice_intents
        WHERE telegram_community_bot_id = ?1
          AND telegram_user_id = ?2
          AND status IN ('pending', 'processing')
        LIMIT 1
      `,
      args: [bot.id, telegramUserId],
    })
    const activeStatus = stringOrNull(rowValue(active.rows[0], "status"))
    if (activeStatus === "processing") {
      throw conflictError("A Telegram study voice attempt is already being graded")
    }
    await tx.execute({
      sql: `
        UPDATE telegram_study_voice_intents
        SET status = 'canceled',
            updated_at = ?3
        WHERE telegram_community_bot_id = ?1
          AND telegram_user_id = ?2
          AND status = 'pending'
      `,
      args: [bot.id, telegramUserId, createdAt],
    })
    await tx.execute({
      sql: `
        INSERT INTO telegram_study_voice_intents (
          intent_id, telegram_community_bot_id, telegram_user_id, user_id,
          community_id, post_id, exercise_id, exercise_type, target_language,
          study_session_id, attempt_number, presentation_number, idempotency_key,
          status, prompt_delivery_status, expires_at, created_at, updated_at,
          chat_study_session_id
        ) VALUES (
          ?1, ?2, ?3, ?4,
          ?5, ?6, ?7, 'say_it_back', ?8,
          ?9, ?10, ?10, ?11,
          'pending', 'sending', ?12, ?13, ?13, ?14
        )
      `,
      args: [
        intentId,
        bot.id,
        telegramUserId,
        input.actor.userId,
        input.communityId,
        input.postId,
        exercise.id,
        study.target_language ?? input.targetLanguage ?? "en",
        study.session.id,
        attemptNumber,
        idempotencyKey,
        expiresAt,
        createdAt,
        input.chatStudySessionId ?? null,
      ],
    })
    await tx.commit()
  } catch (error) {
    await tx.rollback().catch(() => undefined)
    throw error
  } finally {
    tx.close()
  }

  try {
    const sent = await sendTelegramMessage(bot, {
      chat_id: telegramUserId,
      text: [
        "Say this line back:",
        exercise.reference_text,
        "Your voice message is received by this community's independently operated Telegram bot and sent to Pirate for grading.",
      ].join("\n\n"),
    })
    await client.execute({
      sql: `
        UPDATE telegram_study_voice_intents
        SET prompt_delivery_status = 'sent',
            prompt_message_id = ?2,
            prompt_sent_at = ?3,
            updated_at = ?3
        WHERE intent_id = ?1
      `,
      args: [intentId, sent.message_id, nowIso()],
    })
  } catch (error) {
    await client.execute({
      sql: `
        UPDATE telegram_study_voice_intents
        SET prompt_delivery_status = 'uncertain',
            last_error_code = 'telegram_prompt_send_uncertain',
            last_error_message = ?2,
            updated_at = ?3
        WHERE intent_id = ?1
      `,
      args: [intentId, error instanceof Error ? error.message : String(error), nowIso()],
    })
    throw providerUnavailable("Telegram study prompt delivery is uncertain", {
      intent: intentId,
    }, false)
  }

  return {
    created: Math.floor(Date.parse(createdAt) / 1000),
    expires_at: Math.floor(Date.parse(expiresAt) / 1000),
    id: intentId,
    object: "telegram_study_voice_intent",
    status: "pending",
  }
}

async function findVoiceIntent(input: {
  botId: string
  env: Env
  telegramUserId: string
}): Promise<VoiceIntentRow | null> {
  const result = await getControlPlaneClient(input.env).execute({
    sql: `
      SELECT intent_id, telegram_user_id, user_id, community_id, post_id,
             exercise_id, target_language, study_session_id, attempt_number,
             idempotency_key, status, prompt_message_id, expires_at,
             processing_attempt_count, processing_lease_expires_at,
             chat_study_session_id
      FROM telegram_study_voice_intents
      WHERE telegram_community_bot_id = ?1
        AND telegram_user_id = ?2
        AND status IN ('pending', 'processing')
      ORDER BY created_at DESC, intent_id DESC
      LIMIT 1
    `,
    args: [input.botId, input.telegramUserId],
  })
  return serializeIntentRow(result.rows[0])
}

async function isKnownVoiceDelivery(input: {
  botId: string
  env: Env
  telegramMessageId: number
  telegramUserId: string
  voiceFileUniqueId: string
}): Promise<boolean> {
  const result = await getControlPlaneClient(input.env).execute({
    sql: `
      SELECT intent_id
      FROM telegram_study_voice_intents
      WHERE telegram_community_bot_id = ?1
        AND telegram_user_id = ?2
        AND (
          telegram_voice_message_id = ?3
          OR telegram_voice_file_unique_id = ?4
        )
      LIMIT 1
    `,
    args: [
      input.botId,
      input.telegramUserId,
      input.telegramMessageId,
      input.voiceFileUniqueId,
    ],
  })
  return Boolean(stringOrNull(rowValue(result.rows[0], "intent_id")))
}

async function sendExpiredMessage(bot: TelegramCommunityBotCredential, chatId: string): Promise<void> {
  await sendTelegramMessage(bot, {
    chat_id: chatId,
    text: "This study exercise expired. Send /study to start again.",
  }).catch((error) => {
    console.warn("[telegram-study] expired reply failed", {
      communityId: bot.communityId,
      error: error instanceof Error ? error.message : String(error),
    })
  })
}

export async function handleTelegramStudyVoiceMessage(input: {
  bot: TelegramCommunityBotCredential
  env: Env
  message: TelegramWebhookMessage
  onChatStudyAttemptComplete?: (completion: {
    chatId: string
    chatStudySessionId: string
    result: SongStudyAttemptResult
  }) => Promise<void>
  waitUntil?: (promise: Promise<void>) => void
}): Promise<boolean> {
  const chatId = telegramIdentifier(input.message.chat?.id)
  const telegramUserId = telegramIdentifier(input.message.from?.id)
  const voiceFileId = stringOrNull(input.message.voice?.file_id)
  const voiceFileUniqueId = stringOrNull(input.message.voice?.file_unique_id)
  const telegramMessageId = numberOrNull(input.message.message_id)
  if (!chatId || !telegramUserId || !voiceFileId || !voiceFileUniqueId || telegramMessageId === null) {
    return false
  }
  if (!isTelegramStudyVoiceEnabled(input.env, input.bot.communityId)) return false
  if (await isKnownVoiceDelivery({
    botId: input.bot.id,
    env: input.env,
    telegramMessageId,
    telegramUserId,
    voiceFileUniqueId,
  })) {
    return true
  }

  const intent = await findVoiceIntent({
    botId: input.bot.id,
    env: input.env,
    telegramUserId,
  })
  if (!intent) return false
  const now = nowIso()
  if (
    intent.communityId !== input.bot.communityId
  ) {
    return false
  }
  if (Date.parse(intent.expiresAt) <= Date.parse(now)) {
    const expired = await getControlPlaneClient(input.env).execute({
      sql: `
        UPDATE telegram_study_voice_intents
        SET status = 'expired',
            telegram_voice_message_id = ?3,
            telegram_voice_file_id = ?4,
            telegram_voice_file_unique_id = ?5,
            updated_at = ?2
        WHERE intent_id = ?1 AND status = 'pending'
      `,
      args: [intent.id, now, telegramMessageId, voiceFileId, voiceFileUniqueId],
    })
    if ((expired.rowsAffected ?? 0) === 1) {
      await sendExpiredMessage(input.bot, chatId)
    }
    return true
  }
  if (
    intent.status === "processing"
    && intent.processingLeaseExpiresAt
    && Date.parse(intent.processingLeaseExpiresAt) <= Date.parse(now)
  ) {
    const reclaimed = await getControlPlaneClient(input.env).execute({
      sql: `
        UPDATE telegram_study_voice_intents
        SET status = 'pending',
            processing_lease_id = NULL,
            processing_lease_expires_at = NULL,
            updated_at = ?3
        WHERE intent_id = ?1
          AND status = 'processing'
          AND processing_lease_expires_at = ?2
          AND processing_lease_expires_at <= ?3
      `,
      args: [intent.id, intent.processingLeaseExpiresAt, now],
    })
    if ((reclaimed.rowsAffected ?? 0) === 1) {
      intent.status = "pending"
    }
  }
  if (intent.status !== "pending") {
    return true
  }

  const leaseId = crypto.randomUUID()
  const leaseExpiresAt = new Date(Date.parse(now) + VOICE_PROCESSING_LEASE_MS).toISOString()
  const claim = await getControlPlaneClient(input.env).execute({
    sql: `
      UPDATE telegram_study_voice_intents
      SET status = 'processing',
          processing_lease_id = ?2,
          processing_lease_expires_at = ?3,
          processing_attempt_count = processing_attempt_count + 1,
          telegram_voice_message_id = ?4,
          telegram_voice_file_id = ?5,
          telegram_voice_file_unique_id = ?6,
          updated_at = ?7
      WHERE intent_id = ?1
        AND status = 'pending'
        AND expires_at > ?7
        AND processing_attempt_count < ${VOICE_PROCESSING_MAX_ATTEMPTS}
    `,
    args: [
      intent.id,
      leaseId,
      leaseExpiresAt,
      telegramMessageId,
      voiceFileId,
      voiceFileUniqueId,
      now,
    ],
  })
  if (claim.rowsAffected !== 1) return true

  const processClaimedVoice = async (): Promise<void> => {
    let result: SongStudyAttemptResult
    try {
      const telegramFile = await getTelegramFile(input.bot, voiceFileId)
      if (!telegramFile.file_path?.trim()) {
        throw providerUnavailable("Telegram voice file is not available")
      }
      const download = await downloadTelegramFile(input.bot, telegramFile.file_path)
      const mimeType = inferTelegramAudioMimeType({
        explicitMimeType: input.message.voice?.mime_type ?? download.contentType ?? undefined,
        fallback: "audio/ogg",
        fileName: telegramFile.file_path,
      })
      const actor: ActorContext = { authType: "user", userId: intent.userId }
      const transcription = await transcribePostStudyAudio({
        actor,
        communityId: intent.communityId,
        communityRepository: getCommunityRepository(input.env),
        env: input.env,
        file: new File([download.bytes], "telegram-study-voice.oga", { type: mimeType }),
        postId: intent.postId,
      })
      result = await submitPostStudyAttempt({
        actor,
        body: {
          attempt_number: intent.attemptNumber,
          exercise_id: intent.exerciseId,
          idempotency_key: intent.idempotencyKey,
          session_id: intent.sessionId,
          transcript: transcription.text,
          type: "say_it_back",
        },
        communityId: intent.communityId,
        communityRepository: getCommunityRepository(input.env),
        env: input.env,
        postId: intent.postId,
      })
      await getControlPlaneClient(input.env).execute({
        sql: `
          UPDATE telegram_study_voice_intents
          SET status = 'consumed',
              consumed_at = ?3,
              processing_lease_id = NULL,
              processing_lease_expires_at = NULL,
              updated_at = ?3
          WHERE intent_id = ?1
            AND status = 'processing'
            AND processing_lease_id = ?2
        `,
        args: [intent.id, leaseId, nowIso()],
      })
    } catch (error) {
      const processingAttemptCount = intent.processingAttemptCount + 1
      const errorMessage = error instanceof Error ? error.message : String(error)
      const failedAt = nowIso()
      if (processingAttemptCount >= VOICE_PROCESSING_MAX_ATTEMPTS) {
        await getControlPlaneClient(input.env).execute({
          sql: `
            UPDATE telegram_study_voice_intents
            SET status = 'failed',
                processing_lease_id = NULL,
                processing_lease_expires_at = NULL,
                last_error_code = 'voice_processing_attempts_exhausted',
                last_error_message = ?3,
                failed_at = ?4,
                updated_at = ?4
            WHERE intent_id = ?1
              AND status = 'processing'
              AND processing_lease_id = ?2
          `,
          args: [intent.id, leaseId, errorMessage, failedAt],
        })
        await sendTelegramMessage(input.bot, {
          chat_id: chatId,
          text: intent.chatStudySessionId
            ? "I could not grade this exercise after several tries. Send /study to start again."
            : "I could not grade this exercise after several tries. Reopen study to start it again.",
        }).catch(() => undefined)
        return
      }
      const retryExpiresAt = new Date(Date.now() + VOICE_INTENT_TTL_MS).toISOString()
      await getControlPlaneClient(input.env).execute({
        sql: `
          UPDATE telegram_study_voice_intents
          SET status = 'pending',
              processing_lease_id = NULL,
              processing_lease_expires_at = NULL,
              telegram_voice_message_id = NULL,
              telegram_voice_file_id = NULL,
              telegram_voice_file_unique_id = NULL,
              expires_at = CASE WHEN expires_at < ?5 THEN ?5 ELSE expires_at END,
              last_error_code = 'voice_processing_failed',
              last_error_message = ?3,
              updated_at = ?4
          WHERE intent_id = ?1
            AND status = 'processing'
            AND processing_lease_id = ?2
        `,
        args: [intent.id, leaseId, errorMessage, failedAt, retryExpiresAt],
      })
      await sendTelegramMessage(input.bot, {
        chat_id: chatId,
        text: "I could not grade that recording. Send another voice message to try again.",
      }).catch(() => undefined)
      return
    }

    if (intent.chatStudySessionId && input.onChatStudyAttemptComplete) {
      await input.onChatStudyAttemptComplete({
        chatId,
        chatStudySessionId: intent.chatStudySessionId,
        result,
      }).catch(async (error) => {
        console.warn("[telegram-study] chat continuation failed", {
          communityId: intent.communityId,
          error: error instanceof Error ? error.message : String(error),
          intentId: intent.id,
        })
        await sendTelegramMessage(input.bot, {
          chat_id: chatId,
          text: "Your answer was saved, but I could not continue the session. Send /study to resume.",
        }).catch(() => undefined)
      })
      return
    }

    const webOrigin = input.env.PIRATE_WEB_PUBLIC_ORIGIN?.trim().replace(/\/+$/u, "")
    const studyUrl = webOrigin
      ? `${webOrigin}/tg/c/${encodeURIComponent(publicCommunityId(intent.communityId))}/p/${encodeURIComponent(publicPostId(intent.postId))}/study`
      : null
    await sendTelegramMessage(input.bot, {
      chat_id: chatId,
      text: result.outcome === "correct"
        ? "Correct. Continue studying in the Mini App."
        : "Not quite. Continue studying to review the line.",
      ...(studyUrl
        ? {
            reply_markup: {
              inline_keyboard: [[{
                text: "Continue studying",
                web_app: { url: studyUrl },
              }]],
            },
          }
        : {}),
    }).catch((error) => {
      console.warn("[telegram-study] result reply failed", {
        communityId: intent.communityId,
        error: error instanceof Error ? error.message : String(error),
        intentId: intent.id,
      })
    })
  }

  if (input.waitUntil) {
    input.waitUntil(withBackgroundControlPlaneClients(processClaimedVoice))
    return true
  }
  await processClaimedVoice()
  return true
}
