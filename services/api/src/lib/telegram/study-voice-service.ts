import type { ActorContext, AdminActorContext } from "../auth-middleware"
import { getCommunityRepository } from "../communities/db-community-repository"
import { conflictError, HttpError, notFoundError, providerUnavailable } from "../errors"
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
  sendTelegramVoice,
} from "./bot-api"
import {
  synthesizeCommunityStudySpeechForCommunity,
  TELEGRAM_ELEVENLABS_TTS_OUTPUT_FORMAT,
} from "../communities/assistant-policy/speech-service"
import { getCommunityAssistantVoicePolicyForCommunity } from "../communities/assistant-policy/service"
import { getTelegramStudyCopy } from "./study-copy"
import { telegramStudyTutorButtons } from "./chat-study-playback-service"
import { isStudyHelperLanguage, type StudyDeliveryMode } from "./study-preference-service"
import {
  decryptActiveCommunityTelegramBotOrNull,
  type TelegramCommunityBotCredential,
} from "./community-bot-service"
import { resolveTelegramAccount } from "./join-request-service"
import type { TelegramWebhookMessage } from "./webhook-parsing"
import { inferTelegramAudioMimeType, telegramIdentifier } from "./webhook-parsing"
import { isTelegramStudyVoiceEnabled } from "./study-voice-admission"

const VOICE_INTENT_TTL_MS = 30 * 60 * 1000
const VOICE_PROCESSING_LEASE_MS = 2 * 60 * 1000
const VOICE_PROCESSING_MAX_ATTEMPTS = 3
const DEFAULT_TELEGRAM_STUDY_TTS_DAILY_CHAR_BUDGET = 50_000

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
  promptSentAt: string | null
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
    promptSentAt: stringOrNull(rowValue(row, "prompt_sent_at")),
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

type PreparedTelegramStudyVoiceIntent = {
  attemptNumber: number
  bot: TelegramCommunityBotCredential
  chatStudySessionId: string | null
  communityId: string
  createdAt: string
  exerciseId: string
  expiresAt: string
  idempotencyKey: string
  intentId: string
  postId: string
  referenceText: string
  studySessionId: string
  targetLanguage: string
  telegramUserId: string
  userId: string
  deliveryMode: StudyDeliveryMode
  localizationNoticeSent?: boolean
  promptPrefix?: string | null
}

type TelegramStudyLessonNext = NonNullable<NonNullable<SongStudyAttemptResult["lesson"]>["next"]>

type VoiceIntentExecutor = Pick<ReturnType<typeof getControlPlaneClient>, "execute">

async function prepareTelegramStudyVoiceIntent(input: {
  actor: ActorContext | AdminActorContext
  chatStudySessionId?: string | null
  communityId: string
  env: Env
  exerciseId: string
  lessonNext?: TelegramStudyLessonNext
  postId: string
  sessionRevision?: number | null
  studySessionId?: string | null
  targetLanguage?: string | null
  telegramUserId?: string | null
  deliveryMode?: StudyDeliveryMode
  promptPrefix?: string | null
}): Promise<PreparedTelegramStudyVoiceIntent> {
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
  const chatTelegramUserId = stringOrNull(input.telegramUserId)
  if (chatTelegramUserId) {
    const resolved = await resolveTelegramAccount({
      env: input.env,
      telegramUserId: chatTelegramUserId,
    })
    if (resolved?.userId !== input.actor.userId) {
      throw conflictError("Telegram chat identity does not match this Pirate user")
    }
  }
  const telegramUserId = chatTelegramUserId
    ?? await telegramUserIdForPirateUser(input.env, input.actor.userId)
  if (!telegramUserId) {
    throw conflictError("Telegram account is not linked to this Pirate user")
  }

  let attemptNumber: number
  let referenceText: string
  let studySessionId: string
  let targetLanguage: string
  if (input.lessonNext && input.studySessionId) {
    const prompt = input.lessonNext.prompt
    const promptReferenceText = "reference_text" in prompt && typeof prompt.reference_text === "string"
      ? prompt.reference_text
      : null
    if (
      input.lessonNext.exercise_id !== input.exerciseId
      || input.lessonNext.type !== "say_it_back"
      || prompt.id !== input.exerciseId
      || prompt.type !== "say_it_back"
      || !promptReferenceText
    ) {
      throw conflictError("This say-it-back exercise is not currently eligible")
    }
    attemptNumber = input.lessonNext.presentation_number
    referenceText = promptReferenceText
    studySessionId = input.studySessionId
    targetLanguage = input.targetLanguage ?? "en"
  } else {
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
    attemptNumber = exercise.presentation_count + 1
    referenceText = exercise.reference_text
    studySessionId = study.session.id
    targetLanguage = study.target_language ?? input.targetLanguage ?? "en"
  }

  const createdAt = nowIso()
  const expiresAt = new Date(Date.parse(createdAt) + VOICE_INTENT_TTL_MS).toISOString()
  const intentId = makeId("tsv")
  // Voice intents predate a revision column. Keep the prompt's revision in the
  // durable idempotency key so a later Telegram action cannot overwrite the
  // revision that this voice message was shown under.
  const idempotencyKey = `telegram-study:${intentId}${input.sessionRevision === null || input.sessionRevision === undefined ? "" : `:r${input.sessionRevision}`}`
  return {
    attemptNumber,
    bot,
    chatStudySessionId: input.chatStudySessionId ?? null,
    communityId: input.communityId,
    createdAt,
    exerciseId: input.exerciseId,
    expiresAt,
    idempotencyKey,
    intentId,
    postId: input.postId,
    referenceText,
    studySessionId,
    targetLanguage,
    telegramUserId,
    userId: input.actor.userId,
    deliveryMode: input.deliveryMode ?? "text",
    promptPrefix: input.promptPrefix ?? null,
  }
}

async function persistTelegramStudyVoiceIntent(
  executor: VoiceIntentExecutor,
  intent: PreparedTelegramStudyVoiceIntent,
): Promise<void> {
  const active = await executor.execute({
      sql: `
        SELECT status
        FROM telegram_study_voice_intents
        WHERE telegram_community_bot_id = ?1
          AND telegram_user_id = ?2
          AND status IN ('pending', 'processing')
        LIMIT 1
      `,
      args: [intent.bot.id, intent.telegramUserId],
    })
  const activeStatus = stringOrNull(rowValue(active.rows[0], "status"))
  if (activeStatus === "processing") {
    throw conflictError("A Telegram study voice attempt is already being graded")
  }
  await executor.execute({
      sql: `
        UPDATE telegram_study_voice_intents
        SET status = 'canceled',
            updated_at = ?3
        WHERE telegram_community_bot_id = ?1
          AND telegram_user_id = ?2
          AND status = 'pending'
      `,
      args: [intent.bot.id, intent.telegramUserId, intent.createdAt],
    })
  await executor.execute({
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
        intent.intentId,
        intent.bot.id,
        intent.telegramUserId,
        intent.userId,
        intent.communityId,
        intent.postId,
        intent.exerciseId,
        intent.targetLanguage,
        intent.studySessionId,
        intent.attemptNumber,
        intent.idempotencyKey,
        intent.expiresAt,
        intent.createdAt,
        intent.chatStudySessionId,
      ],
    })
}

async function deliverTelegramStudyVoicePrompt(input: {
  chatSessionGuard?: {
    actionToken: string
    exerciseId: string
    sessionId: string
    studySessionId: string
  }
  env: Env
  includeDisclosure: boolean
  intent: PreparedTelegramStudyVoiceIntent
  progressLabel?: string | null
}): Promise<void> {
  const client = getControlPlaneClient(input.env)
  const language = isStudyHelperLanguage(input.intent.targetLanguage) ? input.intent.targetLanguage : "en"
  const copy = getTelegramStudyCopy(language)
  const instruction = [input.progressLabel, copy.sayThis]
    .filter((value): value is string => Boolean(value))
    .join("\n\n")
  const text = [input.intent.promptPrefix, instruction, input.intent.referenceText]
    .filter((value): value is string => Boolean(value))
  const disclosure = copy.disclosure
  if (input.includeDisclosure) {
    text.push(disclosure)
  }
  let promptMessageId: number | null = null
  let deliveryWarning: string | null = null
  let deliveryWarningCode: string | null = null
  try {
    if (input.intent.deliveryMode !== "audio") {
      const sent = await sendTelegramMessage(input.intent.bot, {
        chat_id: input.intent.telegramUserId,
        text: text.join("\n\n"),
        ...(input.intent.chatStudySessionId
          ? {
            reply_markup: {
              inline_keyboard: telegramStudyTutorButtons(input.intent.chatStudySessionId, language),
            },
          }
          : {}),
      })
      promptMessageId = sent.message_id
    }
    if (input.intent.deliveryMode !== "text") {
      try {
        const audio = await cachedStudyPromptAudio({ env: input.env, intent: input.intent })
        const sent = await sendTelegramVoice(input.intent.bot, {
          chat_id: input.intent.telegramUserId,
          voice: new File([audio], "study-prompt.ogg", { type: "audio/ogg" }),
          ...(input.intent.deliveryMode === "audio" ? {
            caption: [input.intent.promptPrefix, instruction, input.includeDisclosure ? disclosure : null]
              .filter((value): value is string => Boolean(value))
              .join("\n\n"),
          } : {}),
        })
        promptMessageId ??= sent.message_id
      } catch (error) {
        deliveryWarning = error instanceof Error ? error.message : String(error)
        deliveryWarningCode = deliveryWarning.includes("telegram_study_tts_daily_budget_exceeded")
          ? "telegram_study_tts_daily_budget_exceeded"
          : deliveryWarning.includes("telegram_study_tts_cache_read_failed")
            ? "telegram_study_tts_cache_read_failed"
            : "telegram_prompt_audio_fell_back_to_text"
        if (promptMessageId === null) {
          const fallback = await sendTelegramMessage(input.intent.bot, {
            chat_id: input.intent.telegramUserId,
            text: text.join("\n\n"),
          })
          promptMessageId = fallback.message_id
        }
      }
    }
    const deliveredAt = nowIso()
    const expiresAt = new Date(Date.parse(deliveredAt) + VOICE_INTENT_TTL_MS).toISOString()
    const tx = await client.transaction("write")
    try {
      let extendIntent = !input.chatSessionGuard
      if (input.chatSessionGuard) {
        const refreshed = await tx.execute({
          sql: `
            UPDATE telegram_chat_study_sessions
            SET expires_at = ?5, prompt_message_id = ?6, updated_at = ?7
            WHERE chat_study_session_id = ?1
              AND action_token = ?2
              AND action_kind = 'await_voice'
              AND current_exercise_id = ?3
              AND study_session_id = ?4
              AND status = 'active'
          `,
          args: [input.chatSessionGuard.sessionId, input.chatSessionGuard.actionToken,
            input.chatSessionGuard.exerciseId, input.chatSessionGuard.studySessionId,
            expiresAt, promptMessageId, deliveredAt],
        })
        extendIntent = (refreshed.rowsAffected ?? 0) === 1
      }
      await tx.execute({
        sql: `
          UPDATE telegram_study_voice_intents
          SET prompt_delivery_status = 'sent', prompt_message_id = ?2,
              prompt_sent_at = ?3,
              expires_at = CASE WHEN ?6 = 1 THEN ?7 ELSE expires_at END,
              last_error_code = ?4, last_error_message = ?5, updated_at = ?3
          WHERE intent_id = ?1
        `,
        args: [input.intent.intentId, promptMessageId, deliveredAt,
          deliveryWarningCode,
          deliveryWarning, extendIntent ? 1 : 0, expiresAt],
      })
      await tx.commit()
    } catch (error) {
      await tx.rollback().catch(() => undefined)
      throw error
    } finally {
      tx.close()
    }
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
      args: [input.intent.intentId, error instanceof Error ? error.message : String(error), nowIso()],
    })
    throw providerUnavailable("Telegram study prompt delivery is uncertain", {
      intent: input.intent.intentId,
      cause: error instanceof Error ? error.message : String(error),
    }, false)
  }
}

async function cachedStudyPromptAudio(input: {
  env: Env
  intent: PreparedTelegramStudyVoiceIntent
}): Promise<ArrayBuffer> {
  const communityRepository = getCommunityRepository(input.env)
  const policy = await getCommunityAssistantVoicePolicyForCommunity({
    env: input.env,
    communityRepository,
    communityId: input.intent.communityId,
  })
  const voiceId = policy.ttsVoice.trim()
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(
    `${voiceId}\n${input.intent.referenceText}`,
  ))
  const key = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  const request = new Request(`https://telegram-study-audio.invalid/${key}.ogg`)
  const cache = typeof caches === "undefined"
    ? null
    : await caches.open("telegram-study-audio").catch(() => null)
  const cached = cache ? await cache.match(request).catch(() => undefined) : undefined
  if (cached) return cached.arrayBuffer()
  const durableKey = `v1/${key}.ogg`
  const durable = input.env.TELEGRAM_STUDY_TTS_CACHE
  const durableCached = durable
    ? await durable.get(durableKey).catch((error) => {
        throw providerUnavailable("telegram_study_tts_cache_read_failed", {
          cause: error instanceof Error ? error.message : String(error),
        }, false)
      })
    : null
  if (durableCached) {
    const audio = await durableCached.arrayBuffer()
    if (cache) {
      await cache.put(request, new Response(audio, {
        headers: { "cache-control": "public, max-age=2592000", "content-type": "audio/ogg" },
      })).catch(() => undefined)
    }
    return audio
  }
  await consumeTelegramStudyTtsBudget({
    characterCount: input.intent.referenceText.length,
    communityId: input.intent.communityId,
    env: input.env,
  })
  const speech = await synthesizeCommunityStudySpeechForCommunity({
    env: input.env,
    communityRepository,
    communityId: input.intent.communityId,
    outputFormat: TELEGRAM_ELEVENLABS_TTS_OUTPUT_FORMAT,
    text: input.intent.referenceText,
  })
  if (durable) {
    await durable.put(durableKey, speech.audio, {
      httpMetadata: { contentType: "audio/ogg" },
      customMetadata: { voiceId },
    }).catch((error) => {
      console.warn("[telegram-study] durable TTS cache write failed", {
        communityId: input.intent.communityId,
        error: error instanceof Error ? error.message : String(error),
        key: durableKey,
      })
    })
  }
  if (cache) {
    await cache.put(request, new Response(speech.audio, {
      headers: { "cache-control": "public, max-age=2592000", "content-type": "audio/ogg" },
    })).catch(() => undefined)
  }
  return speech.audio
}

function telegramStudyTtsDailyCharBudget(env: Env): number {
  const configured = Number.parseInt(env.TELEGRAM_STUDY_TTS_DAILY_CHAR_BUDGET?.trim() ?? "", 10)
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_TELEGRAM_STUDY_TTS_DAILY_CHAR_BUDGET
}

async function consumeTelegramStudyTtsBudget(input: {
  characterCount: number
  communityId: string
  env: Env
}): Promise<void> {
  const now = nowIso()
  const usageDay = now.slice(0, 10)
  const result = await getControlPlaneClient(input.env).execute({
    sql: `
      INSERT INTO telegram_study_tts_daily_usage (
        community_id, usage_day, character_count, created_at, updated_at
      )
      SELECT ?1, ?2, ?3, ?4, ?4
      WHERE ?3 <= ?5
      ON CONFLICT(community_id, usage_day) DO UPDATE SET
        character_count = telegram_study_tts_daily_usage.character_count + excluded.character_count,
        updated_at = excluded.updated_at
      WHERE telegram_study_tts_daily_usage.character_count + excluded.character_count <= ?5
      RETURNING character_count
    `,
    args: [input.communityId, usageDay, input.characterCount, now, telegramStudyTtsDailyCharBudget(input.env)],
  })
  if (result.rows.length === 0) {
    throw providerUnavailable("telegram_study_tts_daily_budget_exceeded", {
      communityId: input.communityId,
      usageDay,
    }, false)
  }
}

function intentResource(intent: PreparedTelegramStudyVoiceIntent): TelegramStudyVoiceIntentResource {
  return {
    created: Math.floor(Date.parse(intent.createdAt) / 1000),
    expires_at: Math.floor(Date.parse(intent.expiresAt) / 1000),
    id: intent.intentId,
    object: "telegram_study_voice_intent",
    status: "pending",
  }
}

export async function createTelegramStudyVoiceIntent(input: {
  actor: ActorContext | AdminActorContext
  chatStudySessionId?: string | null
  communityId: string
  env: Env
  exerciseId: string
  postId: string
  targetLanguage?: string | null
  telegramUserId?: string | null
}): Promise<TelegramStudyVoiceIntentResource> {
  const intent = await prepareTelegramStudyVoiceIntent(input)
  const client = getControlPlaneClient(input.env)
  const tx = await client.transaction("write")
  try {
    await persistTelegramStudyVoiceIntent(tx, intent)
    await tx.commit()
  } catch (error) {
    await tx.rollback().catch(() => undefined)
    throw error
  } finally {
    tx.close()
  }

  await deliverTelegramStudyVoicePrompt({
    env: input.env,
    includeDisclosure: true,
    intent,
  })
  return intentResource(intent)
}

export async function createTelegramChatStudyVoiceIntent(input: {
  actor: ActorContext
  chatStudySessionId: string
  communityId: string
  env: Env
  exerciseId: string
  lessonNext?: TelegramStudyLessonNext
  nextActionToken: string
  postId: string
  previousActionToken: string
  sessionRevision?: number | null
  songTitle?: string | null
  studySessionId?: string | null
  targetLanguage?: string | null
  telegramUserId: string
  deliveryMode?: StudyDeliveryMode
  localizationNoticeSent?: boolean
  progressLabel?: string | null
  promptPrefix?: string | null
}): Promise<TelegramStudyVoiceIntentResource> {
  const intent = await prepareTelegramStudyVoiceIntent(input)
  const client = getControlPlaneClient(input.env)
  const tx = await client.transaction("write")
  let includeDisclosure = true
  try {
    const priorPrompt = await tx.execute({
      sql: `
        SELECT 1
        FROM telegram_study_voice_intents
        WHERE telegram_community_bot_id = ?1
          AND telegram_user_id = ?2
          AND chat_study_session_id IS NOT NULL
          AND prompt_delivery_status IN ('sent', 'uncertain')
        LIMIT 1
      `,
      args: [intent.bot.id, intent.telegramUserId],
    })
    includeDisclosure = priorPrompt.rows.length === 0
    await persistTelegramStudyVoiceIntent(tx, intent)
    const updated = await tx.execute({
      sql: `
        UPDATE telegram_chat_study_sessions
        SET status = 'active',
            action_token = ?2,
            action_kind = 'await_voice',
            action_payload_json = ?3,
            study_session_id = ?4,
            current_exercise_id = ?5,
            prompt_message_id = NULL,
            expires_at = ?8,
            updated_at = ?6
        WHERE chat_study_session_id = ?1
          AND action_token = ?7
          AND status IN ('processing', 'active')
      `,
      args: [
        input.chatStudySessionId,
        input.nextActionToken,
        JSON.stringify({
          deliveryMode: input.deliveryMode ?? "text",
          exerciseId: input.exerciseId,
          localizationNoticeSent: input.localizationNoticeSent === true,
          referenceText: intent.referenceText,
          ...(input.sessionRevision !== null && input.sessionRevision !== undefined
            ? { sessionRevision: input.sessionRevision }
            : {}),
          ...(input.songTitle ? { songTitle: input.songTitle } : {}),
          sessionId: intent.studySessionId,
          ...(input.progressLabel ? { progressLabel: input.progressLabel } : {}),
          ...(input.promptPrefix ? { retryFeedback: input.promptPrefix } : {}),
        }),
        intent.studySessionId,
        input.exerciseId,
        nowIso(),
        input.previousActionToken,
        intent.expiresAt,
      ],
    })
    if ((updated.rowsAffected ?? 0) !== 1) {
      throw new Error("Telegram study session is no longer active")
    }
    await tx.commit()
  } catch (error) {
    await tx.rollback().catch(() => undefined)
    throw error
  } finally {
    tx.close()
  }
  await deliverTelegramStudyVoicePrompt({
    chatSessionGuard: {
      actionToken: input.nextActionToken,
      exerciseId: input.exerciseId,
      sessionId: input.chatStudySessionId,
      studySessionId: intent.studySessionId,
    },
    env: input.env,
    includeDisclosure,
    intent,
    progressLabel: input.progressLabel,
  })
  return intentResource(intent)
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
             prompt_sent_at,
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

async function chatStudySessionRevision(input: { env: Env; sessionId: string }): Promise<number | null> {
  const result = await getControlPlaneClient(input.env).execute({
    sql: "SELECT action_payload_json FROM telegram_chat_study_sessions WHERE chat_study_session_id = ?1 LIMIT 1",
    args: [input.sessionId],
  })
  const payload = rowValue(result.rows[0], "action_payload_json")
  if (typeof payload !== "string") return null
  try {
    const parsed = JSON.parse(payload) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const revision = Number((parsed as Record<string, unknown>).sessionRevision)
    return Number.isSafeInteger(revision) && revision >= 0 ? revision : null
  } catch {
    return null
  }
}

function revisionFromVoiceIntent(intent: VoiceIntentRow): number | null {
  const match = intent.idempotencyKey.match(/:r(\d+)$/u)
  if (!match) return null
  const revision = Number(match[1])
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : null
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

async function sendChatStudyRestart(input: {
  bot: TelegramCommunityBotCredential
  chatId: string
  chatStudySessionId: string
  targetLanguage: string
}): Promise<void> {
  const language = isStudyHelperLanguage(input.targetLanguage) ? input.targetLanguage : "en"
  const copy = getTelegramStudyCopy(language)
  await sendTelegramMessage(input.bot, {
    chat_id: input.chatId,
    text: copy.exerciseExpired,
    reply_markup: {
      inline_keyboard: [[{
        callback_data: `study-restart:${input.chatStudySessionId}`,
        text: copy.startAgain,
      }]],
    },
  }).catch((error) => {
    console.warn("[telegram-study] expired chat reply failed", {
      communityId: input.bot.communityId,
      error: error instanceof Error ? error.message : String(error),
    })
  })
}

async function createLegacyRestartSession(input: {
  bot: TelegramCommunityBotCredential
  env: Env
  intent: VoiceIntentRow
  now: string
}): Promise<string> {
  const sessionId = makeId("tcs")
  await getControlPlaneClient(input.env).execute({
    sql: `
      INSERT INTO telegram_chat_study_sessions (
        chat_study_session_id, telegram_community_bot_id, telegram_user_id,
        user_id, community_id, post_id, target_language, status,
        action_token, action_kind, action_payload_json, expires_at,
        created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'failed', ?8, 'none', '{}', ?9, ?9, ?9
      )
    `,
    args: [sessionId, input.bot.id, input.intent.telegramUserId, input.intent.userId,
      input.intent.communityId, input.intent.postId, input.intent.targetLanguage,
      crypto.randomUUID().replaceAll("-", "").slice(0, 18), input.now],
  })
  return sessionId
}

async function recoverExpiredChatVoiceIntent(input: {
  bot: TelegramCommunityBotCredential
  env: Env
  intent: VoiceIntentRow
  now: string
  telegramMessageId: number
  voiceFileId: string
  voiceFileUniqueId: string
}): Promise<{ intent: VoiceIntentRow; leaseId: string } | "restart" | "handled"> {
  if (!input.intent.chatStudySessionId) return "restart"
  const client = getControlPlaneClient(input.env)
  const tx = await client.transaction("write")
  try {
    const sessionResult = await tx.execute({
      sql: `
        SELECT status, action_kind, study_session_id, current_exercise_id,
               community_id, post_id, user_id, telegram_user_id, expires_at
        FROM telegram_chat_study_sessions
        WHERE chat_study_session_id = ?1
          AND telegram_community_bot_id = ?2
          AND telegram_user_id = ?3
        LIMIT 1
      `,
      args: [input.intent.chatStudySessionId, input.bot.id, input.intent.telegramUserId],
    })
    const row = sessionResult.rows[0]
    const recoverable = stringOrNull(rowValue(row, "status")) === "active"
      && stringOrNull(rowValue(row, "action_kind")) === "await_voice"
      && stringOrNull(rowValue(row, "study_session_id")) === input.intent.sessionId
      && stringOrNull(rowValue(row, "current_exercise_id")) === input.intent.exerciseId
      && stringOrNull(rowValue(row, "community_id")) === input.intent.communityId
      && stringOrNull(rowValue(row, "post_id")) === input.intent.postId
      && stringOrNull(rowValue(row, "user_id")) === input.intent.userId
      && stringOrNull(rowValue(row, "telegram_user_id")) === input.intent.telegramUserId
      && Date.parse(stringOrNull(rowValue(row, "expires_at")) ?? "") > Date.parse(input.now)
    if (!recoverable) {
      const expired = await tx.execute({
        sql: `
          UPDATE telegram_study_voice_intents
          SET status = 'expired', telegram_voice_message_id = ?3,
              telegram_voice_file_id = ?4, telegram_voice_file_unique_id = ?5,
              updated_at = ?2
          WHERE intent_id = ?1 AND status = 'pending' AND expires_at <= ?2
        `,
        args: [input.intent.id, input.now, input.telegramMessageId, input.voiceFileId, input.voiceFileUniqueId],
      })
      await tx.commit()
      return (expired.rowsAffected ?? 0) === 1 ? "restart" : "handled"
    }

    const expired = await tx.execute({
      sql: `
        UPDATE telegram_study_voice_intents
        SET status = 'expired', updated_at = ?2
        WHERE intent_id = ?1 AND status = 'pending' AND expires_at <= ?2
      `,
      args: [input.intent.id, input.now],
    })
    if ((expired.rowsAffected ?? 0) !== 1) {
      await tx.commit()
      return "handled"
    }
    const replacementId = makeId("tsv")
    const leaseId = crypto.randomUUID()
    const leaseExpiresAt = new Date(Date.parse(input.now) + VOICE_PROCESSING_LEASE_MS).toISOString()
    const expiresAt = new Date(Date.parse(input.now) + VOICE_INTENT_TTL_MS).toISOString()
    const idempotencyKey = `telegram-study:${replacementId}`
    await tx.execute({
      sql: `
        INSERT INTO telegram_study_voice_intents (
          intent_id, telegram_community_bot_id, telegram_user_id, user_id,
          community_id, post_id, exercise_id, exercise_type, target_language,
          study_session_id, attempt_number, presentation_number, idempotency_key,
          status, prompt_delivery_status, prompt_message_id, prompt_sent_at,
          expires_at, processing_lease_id, processing_lease_expires_at,
          processing_attempt_count, telegram_voice_message_id,
          telegram_voice_file_id, telegram_voice_file_unique_id,
          chat_study_session_id, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'say_it_back', ?8,
          ?9, ?10, ?10, ?11, 'processing', 'sent', ?12, ?13,
          ?14, ?15, ?16, 1, ?17, ?18, ?19, ?20, ?21, ?21
        )
      `,
      args: [replacementId, input.bot.id, input.intent.telegramUserId, input.intent.userId,
        input.intent.communityId, input.intent.postId, input.intent.exerciseId,
        input.intent.targetLanguage, input.intent.sessionId, input.intent.attemptNumber,
        idempotencyKey, input.intent.promptMessageId, input.intent.promptSentAt, expiresAt, leaseId,
        leaseExpiresAt, input.telegramMessageId, input.voiceFileId, input.voiceFileUniqueId,
        input.intent.chatStudySessionId, input.now],
    })
    await tx.execute({
      sql: `
        UPDATE telegram_chat_study_sessions
        SET expires_at = ?2, updated_at = ?3
        WHERE chat_study_session_id = ?1
          AND status = 'active' AND action_kind = 'await_voice'
          AND study_session_id = ?4 AND current_exercise_id = ?5
      `,
      args: [input.intent.chatStudySessionId, expiresAt, input.now, input.intent.sessionId, input.intent.exerciseId],
    })
    await tx.commit()
    return {
      intent: {
        ...input.intent,
        expiresAt,
        id: replacementId,
        idempotencyKey,
        processingAttemptCount: 0,
        processingLeaseExpiresAt: leaseExpiresAt,
        status: "processing",
      },
      leaseId,
    }
  } catch (error) {
    await tx.rollback().catch(() => undefined)
    throw error
  } finally {
    tx.close()
  }
}

async function consumeClaimedVoiceIntent(input: {
  consumedAt: string
  env: Env
  intentId: string
  leaseId: string
}): Promise<void> {
  const client = getControlPlaneClient(input.env)
  const tx = await client.transaction("write")
  try {
    await tx.execute({
      sql: `
        UPDATE telegram_study_voice_intents
        SET status = 'consumed', consumed_at = ?3,
            processing_lease_id = NULL, processing_lease_expires_at = NULL,
            updated_at = ?3
        WHERE intent_id = ?1
          AND status = 'processing'
          AND processing_lease_id = ?2
      `,
      args: [input.intentId, input.leaseId, input.consumedAt],
    })
    const verified = await tx.execute({
      sql: "SELECT status FROM telegram_study_voice_intents WHERE intent_id = ?1 LIMIT 1",
      args: [input.intentId],
    })
    if (stringOrNull(rowValue(verified.rows[0], "status")) !== "consumed") {
      throw new Error("Telegram voice intent could not be consumed")
    }
    await tx.commit()
  } catch (error) {
    await tx.rollback().catch(() => undefined)
    throw error
  } finally {
    tx.close()
  }
}

export async function handleTelegramStudyVoiceMessage(input: {
  bot: TelegramCommunityBotCredential
  env: Env
  message: TelegramWebhookMessage
  onChatStudyAttemptComplete?: (completion: {
    chatId: string
    chatStudySessionId: string
    result: SongStudyAttemptResult
    telegramMessageId: number
    transcript: string
  }) => Promise<void>
  onChatStudyAttemptConflict?: (completion: {
    chatId: string
    chatStudySessionId: string
    lesson: NonNullable<SongStudyAttemptResult["lesson"]>
    telegramMessageId: number
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

  let intent = await findVoiceIntent({
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
  let leaseId: string | null = null
  let claimedByRecovery = false
  if (Date.parse(intent.expiresAt) <= Date.parse(now)) {
    if (!intent.chatStudySessionId) {
      const expired = await getControlPlaneClient(input.env).execute({
        sql: `
          UPDATE telegram_study_voice_intents
          SET status = 'expired', telegram_voice_message_id = ?3,
              telegram_voice_file_id = ?4, telegram_voice_file_unique_id = ?5,
              updated_at = ?2
          WHERE intent_id = ?1 AND status = 'pending'
        `,
        args: [intent.id, now, telegramMessageId, voiceFileId, voiceFileUniqueId],
      })
      if ((expired.rowsAffected ?? 0) === 1) {
        const restartSessionId = await createLegacyRestartSession({
          bot: input.bot,
          env: input.env,
          intent,
          now,
        })
        await sendChatStudyRestart({
          bot: input.bot,
          chatId,
          chatStudySessionId: restartSessionId,
          targetLanguage: intent.targetLanguage,
        })
      }
      return true
    }
    const recovery = await recoverExpiredChatVoiceIntent({
      bot: input.bot,
      env: input.env,
      intent,
      now,
      telegramMessageId,
      voiceFileId,
      voiceFileUniqueId,
    })
    if (recovery === "restart") {
      await sendChatStudyRestart({
        bot: input.bot,
        chatId,
        chatStudySessionId: intent.chatStudySessionId,
        targetLanguage: intent.targetLanguage,
      })
      return true
    }
    if (recovery === "handled") return true
    intent = recovery.intent
    leaseId = recovery.leaseId
    claimedByRecovery = true
  }
  if (leaseId === null
    && intent.status === "processing"
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
  if (intent.status !== "pending" && leaseId === null) {
    return true
  }

  if (leaseId === null) {
    leaseId = crypto.randomUUID()
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
  }
  const claimedLeaseId = leaseId
  const requireLeaseMatch = claimedByRecovery ? 0 : 1

  const processClaimedVoice = async (): Promise<void> => {
    let result: SongStudyAttemptResult
    let transcriptText = ""
    const language = isStudyHelperLanguage(intent.targetLanguage) ? intent.targetLanguage : "en"
    const copy = getTelegramStudyCopy(language)
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
      transcriptText = transcription.text
      const sessionRevision = revisionFromVoiceIntent(intent)
        ?? (intent.chatStudySessionId
          ? await chatStudySessionRevision({ env: input.env, sessionId: intent.chatStudySessionId })
          : null)
      result = await submitPostStudyAttempt({
        actor,
        body: {
          attempt_number: intent.attemptNumber,
          exercise_id: intent.exerciseId,
          idempotency_key: intent.idempotencyKey,
          session_id: intent.sessionId,
          ...(sessionRevision === null ? {} : { session_revision: sessionRevision }),
          transcript: transcriptText,
          type: "say_it_back",
        },
        communityId: intent.communityId,
        communityRepository: getCommunityRepository(input.env),
        env: input.env,
        postId: intent.postId,
      })
      await consumeClaimedVoiceIntent({
        consumedAt: nowIso(),
        env: input.env,
        intentId: intent.id,
        leaseId: claimedLeaseId,
      })
    } catch (error) {
      if (
        error instanceof HttpError
        && error.code === "study_session_revision_conflict"
        && intent.chatStudySessionId
        && input.onChatStudyAttemptConflict
        && error.details?.lesson
        && typeof error.details.lesson === "object"
      ) {
        await consumeClaimedVoiceIntent({
          consumedAt: nowIso(),
          env: input.env,
          intentId: intent.id,
          leaseId: claimedLeaseId,
        })
        await input.onChatStudyAttemptConflict({
          chatId,
          chatStudySessionId: intent.chatStudySessionId,
          lesson: error.details.lesson as NonNullable<SongStudyAttemptResult["lesson"]>,
          telegramMessageId,
        })
        return
      }
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
              AND (?5 = 0 OR processing_lease_id = ?2)
          `,
          args: [intent.id, claimedLeaseId, errorMessage, failedAt, requireLeaseMatch],
        })
        await sendTelegramMessage(input.bot, {
          chat_id: chatId,
          text: intent.chatStudySessionId
            ? copy.voiceTerminalChatFailure
            : copy.voiceTerminalNonChatFailure,
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
            AND (?6 = 0 OR processing_lease_id = ?2)
        `,
        args: [intent.id, claimedLeaseId, errorMessage, failedAt, retryExpiresAt, requireLeaseMatch],
      })
      await sendTelegramMessage(input.bot, {
        chat_id: chatId,
        text: copy.voiceTemporaryFailure,
      }).catch(() => undefined)
      return
    }

    if (intent.chatStudySessionId && input.onChatStudyAttemptComplete) {
      await input.onChatStudyAttemptComplete({
        chatId,
        chatStudySessionId: intent.chatStudySessionId,
        result,
        telegramMessageId,
        transcript: transcriptText,
      }).catch(async (error) => {
        console.warn("[telegram-study] chat continuation failed", {
          communityId: intent.communityId,
          error: error instanceof Error ? error.message : String(error),
          intentId: intent.id,
        })
        await sendTelegramMessage(input.bot, {
          chat_id: chatId,
          text: copy.voiceContinuationFailure,
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
        ? copy.miniAppCorrect
        : copy.miniAppIncorrect,
      ...(studyUrl
        ? {
            reply_markup: {
              inline_keyboard: [[{
                text: copy.continueStudying,
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
