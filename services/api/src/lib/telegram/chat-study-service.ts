import type { ActorContext } from "../auth-middleware"
import { getCommunityRepository } from "../communities/db-community-repository"
import { openCommunityReadClient } from "../communities/community-read-access"
import { isCommunityStudyEnabled } from "../communities/community-study-policy-service"
import { makeId, nowIso } from "../helpers"
import {
  getPostStudyPayload,
  resolvePostStudyCapability,
  submitPostStudyAttempt,
  type SongStudyAttemptResult,
  type SongStudyPayload,
} from "../posts/post-study-service"
import { getStudyPostById } from "../posts/post-study-access"
import { normalizeStudyTargetLanguage } from "../posts/post-study-localization-service"
import { rowValue } from "../sql-row"
import { getControlPlaneClient } from "../runtime-deps"
import type { Env } from "../../env"
import {
  answerTelegramCallbackQuery,
  editTelegramMessageText,
  sendTelegramMessage,
} from "./bot-api"
import type { TelegramCommunityBotCredential } from "./community-bot-service"
import { resolveTelegramAccount } from "./join-request-service"
import {
  createTelegramOnboardingIntent,
  telegramOnboardingWebAppReplyMarkup,
} from "./onboarding-service"
import { createTelegramStudyVoiceIntent } from "./study-voice-service"
import { isTelegramStudyVoiceEnabled } from "./study-voice-admission"
import {
  telegramIdentifier,
  type TelegramWebhookCallbackQuery,
} from "./webhook-parsing"

const CHAT_STUDY_TTL_MS = 30 * 60 * 1000
const CALLBACK_PROCESSING_LEASE_MS = 2 * 60 * 1000
const CHAT_STUDY_SONG_LIMIT = 40
const CHAT_STUDY_SONG_PAGE_SIZE = 8
const PREVIOUS_PAGE_INDEX = 98
const NEXT_PAGE_INDEX = 99
const CALLBACK_PREFIX = "study"

type ChatStudyActionKind = "select_song" | "answer_choice" | "await_voice" | "none"

type ChatStudySession = {
  actionKind: ChatStudyActionKind
  actionPayload: Record<string, unknown>
  actionToken: string
  communityId: string
  id: string
  postId: string | null
  status: string
  targetLanguage: string
  telegramUserId: string
  userId: string
}

type ReadySong = {
  postId: string
  title: string
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function parseSession(row: unknown): ChatStudySession | null {
  const id = stringOrNull(rowValue(row, "chat_study_session_id"))
  const communityId = stringOrNull(rowValue(row, "community_id"))
  const telegramUserId = stringOrNull(rowValue(row, "telegram_user_id"))
  const userId = stringOrNull(rowValue(row, "user_id"))
  const actionToken = stringOrNull(rowValue(row, "action_token"))
  const actionKind = stringOrNull(rowValue(row, "action_kind")) as ChatStudyActionKind | null
  const status = stringOrNull(rowValue(row, "status"))
  const targetLanguage = stringOrNull(rowValue(row, "target_language"))
  if (!id || !communityId || !telegramUserId || !userId || !actionToken || !actionKind || !status || !targetLanguage) {
    return null
  }
  return {
    actionKind,
    actionPayload: parseJsonObject(rowValue(row, "action_payload_json")),
    actionToken,
    communityId,
    id,
    postId: stringOrNull(rowValue(row, "post_id")),
    status,
    targetLanguage,
    telegramUserId,
    userId,
  }
}

function actionToken(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 18)
}

function callbackData(token: string, index: number): string {
  return `${CALLBACK_PREFIX}:${token}:${index}`
}

function songPickerMarkup(songs: ReadySong[], token: string, page: number) {
  const start = page * CHAT_STUDY_SONG_PAGE_SIZE
  const pageSongs = songs.slice(start, start + CHAT_STUDY_SONG_PAGE_SIZE)
  const navigation: Array<{ callback_data: string; text: string }> = []
  if (page > 0) {
    navigation.push({ callback_data: callbackData(token, PREVIOUS_PAGE_INDEX), text: "Previous" })
  }
  if (start + CHAT_STUDY_SONG_PAGE_SIZE < songs.length) {
    navigation.push({ callback_data: callbackData(token, NEXT_PAGE_INDEX), text: "Next" })
  }
  return {
    inline_keyboard: [
      ...pageSongs.map((song, offset) => [{
        callback_data: callbackData(token, start + offset),
        text: song.title.slice(0, 60),
      }]),
      ...(navigation.length > 0 ? [navigation] : []),
    ],
  }
}

function parseCallbackData(value: unknown): { index: number; token: string } | null {
  if (typeof value !== "string" || value.length > 64) return null
  const match = value.match(/^study:([a-f0-9]{18}):([0-9]{1,2})$/u)
  if (!match) return null
  const index = Number(match[2])
  return Number.isSafeInteger(index) ? { index, token: match[1]! } : null
}

async function listReadySongs(input: {
  actor: ActorContext
  communityId: string
  env: Env
  targetLanguage: string
}): Promise<ReadySong[]> {
  const repository = getCommunityRepository(input.env)
  const db = await openCommunityReadClient(input.env, repository, input.communityId)
  try {
    if (!await isCommunityStudyEnabled({ executor: db.client, communityId: input.communityId })) {
      return []
    }
    const rows = await db.client.execute({
      sql: `
        SELECT post_id
        FROM posts
        WHERE community_id = ?1
          AND post_type = 'song'
          AND status = 'published'
          AND visibility = 'public'
        ORDER BY created_at DESC, post_id DESC
        LIMIT ${CHAT_STUDY_SONG_LIMIT}
      `,
      args: [input.communityId],
    })
    const ready: ReadySong[] = []
    for (const row of rows.rows) {
      const postId = stringOrNull(rowValue(row, "post_id"))
      if (!postId) continue
      const post = await getStudyPostById(db.client, postId)
      if (!post) continue
      const capability = await resolvePostStudyCapability({
        client: db.client,
        env: input.env,
        post,
        targetLanguage: input.targetLanguage,
        viewerUserId: input.actor.userId,
      })
      if (capability?.status !== "ready") continue
      ready.push({
        postId,
        title: post.song_title?.trim() || post.title?.trim() || "Untitled song",
      })
      if (ready.length >= CHAT_STUDY_SONG_LIMIT) break
    }
    return ready
  } finally {
    db.close()
  }
}

async function replaceActiveSession(input: {
  actionKind: ChatStudyActionKind
  actionPayload: Record<string, unknown>
  bot: TelegramCommunityBotCredential
  env: Env
  postId?: string | null
  status: "selecting" | "active" | "processing" | "completed" | "failed"
  targetLanguage: string
  telegramUserId: string
  userId: string
}): Promise<ChatStudySession> {
  const client = getControlPlaneClient(input.env)
  const createdAt = nowIso()
  const id = makeId("tcs")
  const token = actionToken()
  const expiresAt = new Date(Date.parse(createdAt) + CHAT_STUDY_TTL_MS).toISOString()
  const tx = await client.transaction("write")
  try {
    await tx.execute({
      sql: `
        UPDATE telegram_chat_study_sessions
        SET status = 'canceled', action_kind = 'none', updated_at = ?3
        WHERE telegram_community_bot_id = ?1
          AND telegram_user_id = ?2
          AND status IN ('selecting', 'active', 'processing')
      `,
      args: [input.bot.id, input.telegramUserId, createdAt],
    })
    await tx.execute({
      sql: `
        INSERT INTO telegram_chat_study_sessions (
          chat_study_session_id, telegram_community_bot_id, telegram_user_id,
          user_id, community_id, post_id, target_language, status,
          action_token, action_kind, action_payload_json, expires_at,
          created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
          ?9, ?10, ?11, ?12, ?13, ?13
        )
      `,
      args: [
        id,
        input.bot.id,
        input.telegramUserId,
        input.userId,
        input.bot.communityId,
        input.postId ?? null,
        input.targetLanguage,
        input.status,
        token,
        input.actionKind,
        JSON.stringify(input.actionPayload),
        expiresAt,
        createdAt,
      ],
    })
    await tx.commit()
  } catch (error) {
    await tx.rollback().catch(() => undefined)
    throw error
  } finally {
    tx.close()
  }
  return {
    actionKind: input.actionKind,
    actionPayload: input.actionPayload,
    actionToken: token,
    communityId: input.bot.communityId,
    id,
    postId: input.postId ?? null,
    status: input.status,
    targetLanguage: input.targetLanguage,
    telegramUserId: input.telegramUserId,
    userId: input.userId,
  }
}

async function runTelegramChatStudyStart(input: {
  bot: TelegramCommunityBotCredential
  chatId: string
  env: Env
  targetLanguage?: string | null
  telegramUserId: string
}): Promise<boolean> {
  if (!isTelegramStudyVoiceEnabled(input.env, input.bot.communityId)) return false
  const account = await resolveTelegramAccount({
    env: input.env,
    telegramUserId: input.telegramUserId,
  })
  if (!account) {
    const onboarding = await createTelegramOnboardingIntent({
      env: input.env,
      communityId: input.bot.communityId,
      telegramCommunityBotId: input.bot.id,
      telegramUserId: input.telegramUserId,
      privateChatId: input.chatId,
      source: "dm",
    }).catch(() => null)
    await sendTelegramMessage(input.bot, {
      chat_id: input.chatId,
      text: "Link your Telegram account before studying here.",
      ...(onboarding
        ? { reply_markup: telegramOnboardingWebAppReplyMarkup(onboarding.web_app_url) }
        : {}),
    })
    return true
  }
  const actor: ActorContext = { authType: "user", userId: account.userId }
  let targetLanguage = "en"
  try {
    targetLanguage = normalizeStudyTargetLanguage(input.targetLanguage)
  } catch {
    // Telegram language codes are advisory; an unknown client locale should
    // not prevent a learner from starting the English study surface.
  }
  const songs = await listReadySongs({
    actor,
    communityId: input.bot.communityId,
    env: input.env,
    targetLanguage,
  })
  if (songs.length === 0) {
    await sendTelegramMessage(input.bot, {
      chat_id: input.chatId,
      text: "No songs are ready to study in this community yet.",
    })
    return true
  }
  const session = await replaceActiveSession({
    actionKind: "select_song",
    actionPayload: { page: 0, songs },
    bot: input.bot,
    env: input.env,
    status: "selecting",
    targetLanguage,
    telegramUserId: input.telegramUserId,
    userId: account.userId,
  })
  await sendTelegramMessage(input.bot, {
    chat_id: input.chatId,
    text: "Choose a song to study:",
    reply_markup: songPickerMarkup(songs, session.actionToken, 0),
  })
  return true
}

async function claimStudyMessageDelivery(input: {
  bot: TelegramCommunityBotCredential
  env: Env
  messageId: number
  telegramUserId: string
}): Promise<"claimed" | "processing" | "consumed"> {
  const now = nowIso()
  const leaseExpiresAt = new Date(Date.parse(now) + CALLBACK_PROCESSING_LEASE_MS).toISOString()
  const result = await getControlPlaneClient(input.env).execute({
    sql: `
      INSERT INTO telegram_chat_study_message_deliveries (
        telegram_community_bot_id, telegram_user_id, telegram_message_id,
        status, processing_lease_expires_at, received_at, updated_at
      ) VALUES (?1, ?2, ?3, 'processing', ?5, ?4, ?4)
      ON CONFLICT (
        telegram_community_bot_id, telegram_user_id, telegram_message_id
      ) DO UPDATE SET
        status = 'processing',
        processing_lease_expires_at = excluded.processing_lease_expires_at,
        last_error_message = NULL,
        updated_at = excluded.updated_at
      WHERE telegram_chat_study_message_deliveries.status = 'failed'
         OR (
           telegram_chat_study_message_deliveries.status = 'processing'
           AND telegram_chat_study_message_deliveries.processing_lease_expires_at <= excluded.updated_at
         )
    `,
    args: [input.bot.id, input.telegramUserId, input.messageId, now, leaseExpiresAt],
  })
  if ((result.rowsAffected ?? 0) === 1) return "claimed"

  const existing = await getControlPlaneClient(input.env).execute({
    sql: `
      SELECT status
      FROM telegram_chat_study_message_deliveries
      WHERE telegram_community_bot_id = ?1
        AND telegram_user_id = ?2
        AND telegram_message_id = ?3
      LIMIT 1
    `,
    args: [input.bot.id, input.telegramUserId, input.messageId],
  })
  return existing.rows[0]?.status === "consumed" ? "consumed" : "processing"
}

async function finishStudyMessageDelivery(input: {
  bot: TelegramCommunityBotCredential
  env: Env
  error?: unknown
  messageId: number
  telegramUserId: string
}): Promise<void> {
  const now = nowIso()
  await getControlPlaneClient(input.env).execute({
    sql: `
      UPDATE telegram_chat_study_message_deliveries
      SET status = ?4,
          processing_lease_expires_at = NULL,
          last_error_message = ?5,
          consumed_at = CASE WHEN ?4 = 'consumed' THEN ?6 ELSE consumed_at END,
          updated_at = ?6
      WHERE telegram_community_bot_id = ?1
        AND telegram_user_id = ?2
        AND telegram_message_id = ?3
    `,
    args: [
      input.bot.id,
      input.telegramUserId,
      input.messageId,
      input.error ? "failed" : "consumed",
      input.error instanceof Error ? input.error.message : input.error ? String(input.error) : null,
      now,
    ],
  })
}

export async function startTelegramChatStudy(input: {
  bot: TelegramCommunityBotCredential
  chatId: string
  env: Env
  requestMessageId?: number | null
  targetLanguage?: string | null
  telegramUserId: string
}): Promise<boolean> {
  if (!isTelegramStudyVoiceEnabled(input.env, input.bot.communityId)) return false
  const requestMessageId = Number(input.requestMessageId)
  const hasDeliveryId = Number.isSafeInteger(requestMessageId)
  const deliveryClaim = hasDeliveryId
    ? await claimStudyMessageDelivery({
      bot: input.bot,
      env: input.env,
      messageId: requestMessageId,
      telegramUserId: input.telegramUserId,
    })
    : "claimed"
  if (deliveryClaim === "consumed") {
    await sendTelegramMessage(input.bot, {
      chat_id: input.chatId,
      text: "That study menu was already used. Send /study to choose a song again.",
    })
    return true
  }
  if (deliveryClaim === "processing") return true
  try {
    const handled = await runTelegramChatStudyStart(input)
    if (hasDeliveryId) {
      await finishStudyMessageDelivery({
        bot: input.bot,
        env: input.env,
        messageId: requestMessageId,
        telegramUserId: input.telegramUserId,
      })
    }
    return handled
  } catch (error) {
    if (hasDeliveryId) {
      await finishStudyMessageDelivery({
        bot: input.bot,
        env: input.env,
        error,
        messageId: requestMessageId,
        telegramUserId: input.telegramUserId,
      }).catch(() => undefined)
    }
    throw error
  }
}

async function updateSessionAction(input: {
  actionKind: ChatStudyActionKind
  actionPayload: Record<string, unknown>
  env: Env
  exerciseId?: string | null
  promptMessageId?: number | null
  session: ChatStudySession
  status?: "active" | "processing" | "completed" | "failed"
  studySessionId?: string | null
}): Promise<string> {
  const token = actionToken()
  const updatedAt = nowIso()
  const updated = await getControlPlaneClient(input.env).execute({
    sql: `
      UPDATE telegram_chat_study_sessions
      SET status = ?2,
          action_token = ?3,
          action_kind = ?4,
          action_payload_json = ?5,
          study_session_id = ?6,
          current_exercise_id = ?7,
          prompt_message_id = ?8,
          completed_at = CASE WHEN ?2 = 'completed' THEN ?9 ELSE completed_at END,
          updated_at = ?9
      WHERE chat_study_session_id = ?1
        AND status IN ('processing', 'active')
    `,
    args: [
      input.session.id,
      input.status ?? "active",
      token,
      input.actionKind,
      JSON.stringify(input.actionPayload),
      input.studySessionId ?? null,
      input.exerciseId ?? null,
      input.promptMessageId ?? null,
      updatedAt,
    ],
  })
  if ((updated.rowsAffected ?? 0) !== 1) {
    throw new Error("Telegram study session is no longer active")
  }
  input.session.actionKind = input.actionKind
  input.session.actionPayload = input.actionPayload
  input.session.actionToken = token
  input.session.status = input.status ?? "active"
  return token
}

function eligibleExercise(study: SongStudyPayload): SongStudyPayload["exercises"][number] | null {
  return study.exercises.find((exercise) =>
    !exercise.mastered && exercise.presentation_count < exercise.max_attempts
  ) ?? null
}

function feedbackText(result: SongStudyAttemptResult): string {
  if (result.outcome === "correct") return "Correct."
  const missing = result.feedback?.missing?.length
    ? ` Missing: ${result.feedback.missing.join(", ")}.`
    : ""
  const extra = result.feedback?.extra?.length
    ? ` Extra: ${result.feedback.extra.join(", ")}.`
    : ""
  return `Not quite.${missing}${extra}`
}

async function sendCompletion(input: {
  bot: TelegramCommunityBotCredential
  chatId: string
  env: Env
  result?: SongStudyAttemptResult
  session: ChatStudySession
  study: SongStudyPayload
}): Promise<void> {
  await updateSessionAction({
    actionKind: "none",
    actionPayload: {},
    env: input.env,
    session: input.session,
    status: "completed",
    studySessionId: input.study.session?.id ?? null,
  })
  const progress = input.result?.study_progress
  const resultSession = input.result?.session
  const score = progress
    ? `${progress.study_correct_count}/${progress.study_target_count}`
    : resultSession
      ? `${resultSession.first_pass_correct_count}/${resultSession.required_correct_count}`
      : null
  const streak = progress
    ? `\nStreak: ${progress.current_streak} day${progress.current_streak === 1 ? "" : "s"}`
    : ""
  const summary = score ? `\n\nScore: ${score}${streak}` : ""
  await sendTelegramMessage(input.bot, {
    chat_id: input.chatId,
    text: `Study complete: ${input.study.title}${summary}`,
  })
}

async function presentNextExercise(input: {
  bot: TelegramCommunityBotCredential
  chatId: string
  env: Env
  lastResult?: SongStudyAttemptResult
  session: ChatStudySession
}): Promise<void> {
  if (!input.session.postId) throw new Error("Chat study session has no song")
  const actor: ActorContext = { authType: "user", userId: input.session.userId }
  const study = await getPostStudyPayload({
    actor,
    communityId: input.session.communityId,
    communityRepository: getCommunityRepository(input.env),
    env: input.env,
    postId: input.session.postId,
    targetLanguage: input.session.targetLanguage,
  })
  const exercise = study.access === "ready" ? eligibleExercise(study) : null
  if (input.lastResult) {
    await sendTelegramMessage(input.bot, {
      chat_id: input.chatId,
      text: feedbackText(input.lastResult),
    })
  }
  if (!exercise) {
    await sendCompletion({ ...input, result: input.lastResult, study })
    return
  }
  if (exercise.type === "translation_choice") {
    const token = await updateSessionAction({
      actionKind: "answer_choice",
      actionPayload: {
        attemptNumber: exercise.presentation_count + 1,
        exerciseId: exercise.id,
        optionIds: exercise.options.map((option) => option.id),
        optionTexts: exercise.options.map((option) => option.text),
        promptText: exercise.prompt_text,
        question: exercise.question,
        sessionId: study.session?.id,
      },
      env: input.env,
      exerciseId: exercise.id,
      session: input.session,
      studySessionId: study.session?.id ?? null,
    })
    const sent = await sendTelegramMessage(input.bot, {
      chat_id: input.chatId,
      text: `${exercise.question}\n\n${exercise.prompt_text}`,
      reply_markup: {
        inline_keyboard: exercise.options.map((option, index) => [{
          callback_data: callbackData(token, index),
          text: option.text.slice(0, 60),
        }]),
      },
    })
    await getControlPlaneClient(input.env).execute({
      sql: `
        UPDATE telegram_chat_study_sessions
        SET prompt_message_id = ?2, updated_at = ?3
        WHERE chat_study_session_id = ?1
      `,
      args: [input.session.id, sent.message_id, nowIso()],
    })
    return
  }
  await createTelegramStudyVoiceIntent({
    actor,
    chatStudySessionId: input.session.id,
    communityId: input.session.communityId,
    env: input.env,
    exerciseId: exercise.id,
    postId: input.session.postId,
    targetLanguage: input.session.targetLanguage,
    telegramUserId: input.session.telegramUserId,
  })
  await updateSessionAction({
    actionKind: "await_voice",
    actionPayload: { exerciseId: exercise.id },
    env: input.env,
    exerciseId: exercise.id,
    session: input.session,
    studySessionId: study.session?.id ?? null,
  })
}

async function loadSessionByAction(input: {
  bot: TelegramCommunityBotCredential
  env: Env
  telegramUserId: string
  token: string
}): Promise<ChatStudySession | null> {
  const now = nowIso()
  const staleProcessingBefore = new Date(
    Date.parse(now) - CALLBACK_PROCESSING_LEASE_MS,
  ).toISOString()
  const result = await getControlPlaneClient(input.env).execute({
    sql: `
      SELECT chat_study_session_id, telegram_user_id, user_id, community_id,
             post_id, target_language, status, action_token, action_kind,
             action_payload_json
      FROM telegram_chat_study_sessions
      WHERE telegram_community_bot_id = ?1
        AND telegram_user_id = ?2
        AND action_token = ?3
        AND (
          status IN ('selecting', 'active')
          OR (status = 'processing' AND updated_at <= ?5)
        )
        AND expires_at > ?4
      LIMIT 1
    `,
    args: [input.bot.id, input.telegramUserId, input.token, now, staleProcessingBefore],
  })
  return parseSession(result.rows[0])
}

async function claimCallback(input: {
  bot: TelegramCommunityBotCredential
  callbackQueryId: string
  env: Env
  sessionId: string
}): Promise<boolean> {
  const now = nowIso()
  const leaseExpiresAt = new Date(Date.parse(now) + CALLBACK_PROCESSING_LEASE_MS).toISOString()
  const result = await getControlPlaneClient(input.env).execute({
    sql: `
      INSERT INTO telegram_chat_study_callback_deliveries (
        callback_query_id, chat_study_session_id, telegram_community_bot_id,
        status, processing_lease_expires_at, received_at, updated_at
      ) VALUES (?1, ?2, ?3, 'processing', ?5, ?4, ?4)
      ON CONFLICT(callback_query_id) DO UPDATE SET
        status = 'processing',
        processing_lease_expires_at = excluded.processing_lease_expires_at,
        last_error_message = NULL,
        updated_at = excluded.updated_at
      WHERE telegram_chat_study_callback_deliveries.status = 'failed'
         OR (
           telegram_chat_study_callback_deliveries.status = 'processing'
           AND telegram_chat_study_callback_deliveries.processing_lease_expires_at <= excluded.updated_at
         )
    `,
    args: [input.callbackQueryId, input.sessionId, input.bot.id, now, leaseExpiresAt],
  })
  return (result.rowsAffected ?? 0) === 1
}

async function finishCallback(input: {
  callbackQueryId: string
  env: Env
  error?: unknown
}): Promise<void> {
  const now = nowIso()
  await getControlPlaneClient(input.env).execute({
    sql: `
      UPDATE telegram_chat_study_callback_deliveries
      SET status = ?2,
          processing_lease_expires_at = NULL,
          last_error_message = ?3,
          consumed_at = CASE WHEN ?2 = 'consumed' THEN ?4 ELSE consumed_at END,
          updated_at = ?4
      WHERE callback_query_id = ?1
    `,
    args: [
      input.callbackQueryId,
      input.error ? "failed" : "consumed",
      input.error instanceof Error ? input.error.message : input.error ? String(input.error) : null,
      now,
    ],
  })
}

async function claimSessionAction(input: {
  env: Env
  session: ChatStudySession
}): Promise<boolean> {
  const now = nowIso()
  const staleProcessingBefore = new Date(
    Date.parse(now) - CALLBACK_PROCESSING_LEASE_MS,
  ).toISOString()
  const claimed = await getControlPlaneClient(input.env).execute({
    sql: `
      UPDATE telegram_chat_study_sessions
      SET status = 'processing', updated_at = ?3
      WHERE chat_study_session_id = ?1
        AND action_token = ?2
        AND (
          status IN ('selecting', 'active')
          OR (status = 'processing' AND updated_at <= ?4)
        )
    `,
    args: [input.session.id, input.session.actionToken, now, staleProcessingBefore],
  })
  return (claimed.rowsAffected ?? 0) === 1
}

async function releaseSessionAction(input: {
  env: Env
  session: ChatStudySession
}): Promise<void> {
  await getControlPlaneClient(input.env).execute({
    sql: `
      UPDATE telegram_chat_study_sessions
      SET status = ?3, updated_at = ?4
      WHERE chat_study_session_id = ?1
        AND action_token = ?2
        AND status = 'processing'
    `,
    args: [
      input.session.id,
      input.session.actionToken,
      input.session.status === "selecting" ? "selecting" : "active",
      nowIso(),
    ],
  })
}

export async function handleTelegramChatStudyCallback(input: {
  bot: TelegramCommunityBotCredential
  callback: TelegramWebhookCallbackQuery
  env: Env
}): Promise<boolean> {
  const parsed = parseCallbackData(input.callback.data)
  if (!parsed) return false
  const callbackQueryId = stringOrNull(input.callback.id)
  const telegramUserId = telegramIdentifier(input.callback.from?.id)
  const chatId = telegramIdentifier(input.callback.message?.chat?.id)
  if (!callbackQueryId || !telegramUserId || !chatId) return true
  if (!isTelegramStudyVoiceEnabled(input.env, input.bot.communityId)) {
    await answerTelegramCallbackQuery(input.bot, {
      callback_query_id: callbackQueryId,
      text: "Study is not available here yet.",
    }).catch(() => undefined)
    return true
  }
  const session = await loadSessionByAction({
    bot: input.bot,
    env: input.env,
    telegramUserId,
    token: parsed.token,
  })
  if (!session || session.communityId !== input.bot.communityId) {
    await answerTelegramCallbackQuery(input.bot, {
      callback_query_id: callbackQueryId,
      text: "This button expired. Send /study to continue.",
    }).catch(() => undefined)
    return true
  }
  if (!await claimCallback({
    bot: input.bot,
    callbackQueryId,
    env: input.env,
    sessionId: session.id,
  })) {
    await answerTelegramCallbackQuery(input.bot, {
      callback_query_id: callbackQueryId,
    }).catch(() => undefined)
    return true
  }
  if (!await claimSessionAction({ env: input.env, session })) {
    await finishCallback({ callbackQueryId, env: input.env })
    await answerTelegramCallbackQuery(input.bot, {
      callback_query_id: callbackQueryId,
      text: "That answer was already handled. Send /study if you need a new session.",
    }).catch(() => undefined)
    return true
  }
  await answerTelegramCallbackQuery(input.bot, {
    callback_query_id: callbackQueryId,
  }).catch(() => undefined)
  try {
    if (session.actionKind === "select_song") {
      const songs = Array.isArray(session.actionPayload.songs)
        ? session.actionPayload.songs.flatMap((value) => {
            if (!value || typeof value !== "object") return []
            const postId = stringOrNull((value as Record<string, unknown>).postId)
            const title = stringOrNull((value as Record<string, unknown>).title)
            return postId && title ? [{ postId, title }] : []
          })
        : []
      const currentPage = Number(session.actionPayload.page)
      if (
        (parsed.index === PREVIOUS_PAGE_INDEX || parsed.index === NEXT_PAGE_INDEX)
        && Number.isSafeInteger(currentPage)
      ) {
        const maxPage = Math.max(0, Math.ceil(songs.length / CHAT_STUDY_SONG_PAGE_SIZE) - 1)
        const page = parsed.index === NEXT_PAGE_INDEX
          ? Math.min(maxPage, currentPage + 1)
          : Math.max(0, currentPage - 1)
        const token = await updateSessionAction({
          actionKind: "select_song",
          actionPayload: { page, songs },
          env: input.env,
          session,
          status: "active",
        })
        const callbackMessageId = Number(input.callback.message?.message_id)
        if (Number.isSafeInteger(callbackMessageId)) {
          await editTelegramMessageText(input.bot, {
            chat_id: chatId,
            message_id: callbackMessageId,
            text: "Choose a song to study:",
            reply_markup: songPickerMarkup(songs, token, page),
          })
        } else {
          await sendTelegramMessage(input.bot, {
            chat_id: chatId,
            text: "Choose a song to study:",
            reply_markup: songPickerMarkup(songs, token, page),
          })
        }
        await finishCallback({ callbackQueryId, env: input.env })
        return true
      }
      const postId = songs[parsed.index]?.postId
      if (!postId) throw new Error("Song choice is no longer available")
      session.postId = postId
      const selected = await getControlPlaneClient(input.env).execute({
        sql: `
          UPDATE telegram_chat_study_sessions
          SET post_id = ?2, status = 'active', updated_at = ?3
          WHERE chat_study_session_id = ?1
            AND action_token = ?4
            AND action_kind = 'select_song'
            AND status = 'processing'
        `,
        args: [session.id, postId, nowIso(), session.actionToken],
      })
      if ((selected.rowsAffected ?? 0) !== 1) {
        throw new Error("Song choice is no longer active")
      }
      await presentNextExercise({
        bot: input.bot,
        chatId,
        env: input.env,
        session,
      })
    } else if (session.actionKind === "answer_choice") {
      const optionIds = Array.isArray(session.actionPayload.optionIds)
        ? session.actionPayload.optionIds.filter((value): value is string => typeof value === "string")
        : []
      const selectedOptionId = optionIds[parsed.index]
      const optionTexts = Array.isArray(session.actionPayload.optionTexts)
        ? session.actionPayload.optionTexts.filter((value): value is string => typeof value === "string")
        : []
      const exerciseId = stringOrNull(session.actionPayload.exerciseId)
      const studySessionId = stringOrNull(session.actionPayload.sessionId)
      const attemptNumber = Number(session.actionPayload.attemptNumber)
      if (!session.postId || !selectedOptionId || !exerciseId || !studySessionId || !Number.isSafeInteger(attemptNumber)) {
        throw new Error("Study answer is no longer available")
      }
      const result = await submitPostStudyAttempt({
        actor: { authType: "user", userId: session.userId },
        body: {
          attempt_number: attemptNumber,
          exercise_id: exerciseId,
          idempotency_key: `telegram-chat-study:${session.id}:${session.actionToken}`,
          selected_option_id: selectedOptionId,
          session_id: studySessionId,
          type: "translation_choice",
        },
        communityId: session.communityId,
        communityRepository: getCommunityRepository(input.env),
        env: input.env,
        postId: session.postId,
      })
      const callbackMessageId = Number(input.callback.message?.message_id)
      const selectedText = optionTexts[parsed.index]
      const correctOptionId = stringOrNull(result.correct_option_id)
      const correctText = correctOptionId
        ? optionTexts[optionIds.indexOf(correctOptionId)]
        : null
      const question = stringOrNull(session.actionPayload.question)
      const promptText = stringOrNull(session.actionPayload.promptText)
      if (Number.isSafeInteger(callbackMessageId) && selectedText && question && promptText) {
        const correction = result.outcome !== "correct" && correctText
          ? `\n✅ Correct answer: ${correctText}`
          : ""
        await editTelegramMessageText(input.bot, {
          chat_id: chatId,
          message_id: callbackMessageId,
          text: `${question}\n\n${promptText}\n\n${result.outcome === "correct" ? "✅" : "❌"} ${selectedText}${correction}`,
          reply_markup: { inline_keyboard: [] },
        }).catch(() => undefined)
      }
      await presentNextExercise({
        bot: input.bot,
        chatId,
        env: input.env,
        lastResult: result,
        session,
      })
    }
    await finishCallback({ callbackQueryId, env: input.env })
  } catch (error) {
    await releaseSessionAction({ env: input.env, session }).catch(() => undefined)
    await finishCallback({ callbackQueryId, env: input.env, error })
    await sendTelegramMessage(input.bot, {
      chat_id: chatId,
      text: "I couldn't process that answer. Send /study to restart.",
    }).catch(() => undefined)
    throw error
  }
  return true
}

export async function continueTelegramChatStudyAfterVoice(input: {
  bot: TelegramCommunityBotCredential
  chatId: string
  chatStudySessionId: string
  env: Env
  result: SongStudyAttemptResult
}): Promise<void> {
  const query = await getControlPlaneClient(input.env).execute({
    sql: `
      SELECT chat_study_session_id, telegram_user_id, user_id, community_id,
             post_id, target_language, status, action_token, action_kind,
             action_payload_json
      FROM telegram_chat_study_sessions
      WHERE chat_study_session_id = ?1
        AND telegram_community_bot_id = ?2
        AND status = 'active'
      LIMIT 1
    `,
    args: [input.chatStudySessionId, input.bot.id],
  })
  const session = parseSession(query.rows[0])
  if (!session || session.actionKind !== "await_voice") return
  await presentNextExercise({
    bot: input.bot,
    chatId: input.chatId,
    env: input.env,
    lastResult: input.result,
    session,
  })
}
