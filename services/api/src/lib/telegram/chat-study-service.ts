import type { ActorContext } from "../auth-middleware"
import { getCommunityRepository } from "../communities/db-community-repository"
import { openCommunityReadClient } from "../communities/community-read-access"
import { isCommunityStudyEnabled } from "../communities/community-study-policy-service"
import { hasActiveCommunityElevenLabsCredential } from "../communities/assistant-policy/credential-service"
import { makeId, nowIso } from "../helpers"
import {
  getPostStudyPayload,
  submitPostStudyAttempt,
  type SongStudyAttemptResult,
  type SongStudyPayload,
} from "../posts/post-study-service"
import type { StudyPost } from "../posts/post-study-access"
import {
  isSameLanguageStudyPair,
} from "../posts/post-study-localization-service"
import {
  splitLyricsForStudy,
  STUDY_UNIT_GENERATION_VERSION,
} from "../posts/post-study-unit-service"
import { rowValue } from "../sql-row"
import type { ReadClient } from "../sql-client"
import { getControlPlaneClient } from "../runtime-deps"
import { resolveRewardCampaignConfig } from "../rewards/reward-campaign-config"
import { learnerVisibleRewardCampaignSql } from "../rewards/reward-campaign-visibility"
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
import { createTelegramChatStudyVoiceIntent } from "./study-voice-service"
import { getTelegramStudyCopy, STUDY_LANGUAGE_BUTTONS } from "./study-copy"
import { resolveRuntimeUiLocale } from "./telegram-locale"
import {
  getUserStudyPreference,
  isStudyDeliveryMode,
  isStudyHelperLanguage,
  STUDY_DELIVERY_MODES,
  type StudyDeliveryMode,
  type StudyHelperLanguage,
  upsertUserStudyPreference,
} from "./study-preference-service"
import { isTelegramStudyVoiceEnabled } from "./study-voice-admission"
import { armPrivateStudyAskMode } from "./private-study-tutor-service"
import {
  parseTelegramStudyAskTutorCallback,
  parseTelegramStudyPlaybackCallback,
  sendTelegramStudySongPlayback,
  telegramStudyAskTutorButton,
} from "./chat-study-playback-service"
import {
  telegramIdentifier,
  type TelegramWebhookCallbackQuery,
} from "./webhook-parsing"

const CHAT_STUDY_TTL_MS = 30 * 60 * 1000
const CALLBACK_PROCESSING_LEASE_MS = 2 * 60 * 1000
const CHAT_STUDY_SONG_QUERY_PAGE_SIZE = 40
const CHAT_STUDY_SONG_PAGE_SIZE = 8
const PREVIOUS_PAGE_INDEX = 98
const NEXT_PAGE_INDEX = 99
const CALLBACK_PREFIX = "study"
const LOCALIZATION_CHECK_PREFIX = "study-check"

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
  dailyRewardCents?: number
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

function localizationCheckData(sessionId: string): string {
  return `${LOCALIZATION_CHECK_PREFIX}:${sessionId}`
}

function orderedLanguageButtons(suggested: StudyHelperLanguage | null) {
  return suggested
    ? [...STUDY_LANGUAGE_BUTTONS].sort((left, right) => Number(right.code === suggested) - Number(left.code === suggested))
    : STUDY_LANGUAGE_BUTTONS
}

function languagePickerMarkup(
  token: string,
  buttons: typeof STUDY_LANGUAGE_BUTTONS,
  suggested: StudyHelperLanguage | null,
  language: StudyHelperLanguage,
) {
  const copy = getTelegramStudyCopy(language)
  return {
    inline_keyboard: buttons.map(({ code, label }, index) => [{
      callback_data: callbackData(token, index),
      text: code === suggested ? `${label} · ${copy.suggested}` : label,
    }]),
  }
}

function deliveryPickerMarkup(token: string, language: StudyHelperLanguage) {
  const copy = getTelegramStudyCopy(language)
  const labels = [copy.deliveryAudio, copy.deliveryText, copy.deliveryBoth]
  return { inline_keyboard: labels.map((text, index) => [{ callback_data: callbackData(token, index), text }]) }
}

function settingsMenuMarkup(token: string, language: StudyHelperLanguage) {
  const copy = getTelegramStudyCopy(language)
  return {
    inline_keyboard: [
      [{ callback_data: callbackData(token, 0), text: copy.settingsLanguage }],
      [{ callback_data: callbackData(token, 1), text: copy.settingsPromptFormat }],
    ],
  }
}

export function telegramStudySongSelectionIndex(page: number, pageIndex: number): number {
  return page * CHAT_STUDY_SONG_PAGE_SIZE + pageIndex
}

function formatUsdCents(cents: number): string {
  const dollars = cents / 100
  return `$${Number.isInteger(dollars) ? dollars.toFixed(0) : dollars.toFixed(2)}`
}

function songButtonText(song: ReadySong): string {
  const reward = song.dailyRewardCents
    ? ` · earn up to ${formatUsdCents(song.dailyRewardCents)}/day`
    : ""
  return `${song.title.slice(0, Math.max(1, 60 - reward.length))}${reward}`
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
        callback_data: callbackData(token, offset),
        text: songButtonText(song),
      }]),
      ...(navigation.length > 0 ? [navigation] : []),
    ],
  }
}

function studyPostFromRow(row: unknown): StudyPost | null {
  const postId = stringOrNull(rowValue(row, "post_id"))
  const communityId = stringOrNull(rowValue(row, "community_id"))
  if (!postId || !communityId) return null
  return {
    access_mode: stringOrNull(rowValue(row, "access_mode")) as StudyPost["access_mode"],
    age_gate_policy: (stringOrNull(rowValue(row, "age_gate_policy")) ?? "none") as StudyPost["age_gate_policy"],
    asset_id: stringOrNull(rowValue(row, "asset_id")),
    author_user_id: stringOrNull(rowValue(row, "author_user_id")),
    community_id: communityId,
    lyrics: stringOrNull(rowValue(row, "lyrics")),
    post_id: postId,
    post_type: stringOrNull(rowValue(row, "post_type")) ?? "",
    song_cover_art_ref: stringOrNull(rowValue(row, "song_cover_art_ref")),
    song_artifact_bundle_id: stringOrNull(rowValue(row, "song_artifact_bundle_id")),
    song_title: stringOrNull(rowValue(row, "song_title")),
    source_language: stringOrNull(rowValue(row, "source_language")),
    status: stringOrNull(rowValue(row, "status")) ?? "",
    title: stringOrNull(rowValue(row, "title")),
    visibility: stringOrNull(rowValue(row, "visibility")) ?? "public",
  }
}

async function activeCampaignRewards(input: {
  env: Env
  postIds: string[]
}): Promise<Map<string, number>> {
  if (input.postIds.length === 0 || !resolveRewardCampaignConfig(input.env).enabled) return new Map()
  const placeholders = input.postIds.map((_, index) => `?${index + 2}`).join(", ")
  const result = await getControlPlaneClient(input.env).execute({
    sql: `
      SELECT post_id, daily_reward_cents
      FROM reward_campaigns
      WHERE ${learnerVisibleRewardCampaignSql({ nowParameter: "?1" })}
        AND eligible_activity IN ('study', 'either')
        AND post_id IN (${placeholders})
    `,
    args: [nowIso(), ...input.postIds],
  })
  return new Map(result.rows.flatMap((row) => {
    const postId = stringOrNull(rowValue(row, "post_id"))
    const dailyRewardCents = Number(rowValue(row, "daily_reward_cents"))
    return postId && Number.isSafeInteger(dailyRewardCents) && dailyRewardCents > 0
      ? [[postId, dailyRewardCents] as const]
      : []
  }))
}

// Batched equivalent of resolvePostStudyCapability (post-study-service.ts).
// Keep both paths aligned; the cross-path capability matrix test guards their parity.
export async function batchReadyPostIds(input: {
  client: ReadClient
  credentialAvailable: boolean
  posts: StudyPost[]
  targetLanguage: string
  viewerUserId: string
}): Promise<Set<string>> {
  if (input.posts.length === 0) return new Set()
  const placeholders = input.posts.map((_, index) => `?${index + 3}`).join(", ")
  const result = await input.client.execute({
    sql: `
      SELECT p.post_id,
        CASE WHEN COALESCE(p.access_mode, 'public') <> 'locked'
          OR p.author_user_id = ?2
          OR EXISTS (
            SELECT 1 FROM purchase_entitlements entitlement
            WHERE entitlement.community_id = p.community_id
              AND entitlement.buyer_user_id = ?2
              AND entitlement.target_ref = p.asset_id
              AND entitlement.entitlement_kind = 'asset_access'
              AND entitlement.status = 'active'
          ) THEN 1 ELSE 0 END AS accessible,
        EXISTS (SELECT 1 FROM song_study_unit unit WHERE unit.post_id = p.post_id) AS has_units,
        EXISTS (
          SELECT 1 FROM song_study_unit unit
          WHERE unit.post_id = p.post_id AND unit.unit_version < ${STUDY_UNIT_GENERATION_VERSION}
        ) AS has_stale_units,
        EXISTS (
          SELECT 1 FROM song_study_unit unit
          WHERE unit.post_id = p.post_id AND unit.say_it_back_status = 'ready'
        ) AS has_say_it_back,
        EXISTS (
          SELECT 1
          FROM song_study_unit unit
          JOIN song_study_unit_localization localization ON localization.unit_id = unit.id
          WHERE unit.post_id = p.post_id
            AND localization.target_language = ?1
            AND localization.status = 'ready'
            AND localization.translation_text IS NOT NULL
            AND localization.options_json IS NOT NULL
            AND localization.correct_option_id IS NOT NULL
        ) AS has_translation
      FROM posts p
      WHERE p.post_id IN (${placeholders})
    `,
    args: [input.targetLanguage, input.viewerUserId, ...input.posts.map((post) => post.post_id)],
  })
  const rows = new Map(result.rows.flatMap((row) => {
    const postId = stringOrNull(rowValue(row, "post_id"))
    return postId ? [[postId, row] as const] : []
  }))
  return new Set(input.posts.flatMap((post) => {
    const row = rows.get(post.post_id)
    if (!row || Number(rowValue(row, "accessible")) !== 1) return []
    const unitsCurrent = Number(rowValue(row, "has_units")) === 1
      && Number(rowValue(row, "has_stale_units")) === 0
    const ready = unitsCurrent
      ? (
          (input.credentialAvailable && Number(rowValue(row, "has_say_it_back")) === 1)
          || (
            !isSameLanguageStudyPair(post.source_language, input.targetLanguage)
            && Number(rowValue(row, "has_translation")) === 1
          )
        )
      : input.credentialAvailable && splitLyricsForStudy(post.lyrics).length > 0
    return ready ? [post.post_id] : []
  }))
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
    const ready: ReadySong[] = []
    let cursorCreatedAt: string | null = null
    let cursorPostId: string | null = null
    const credentialAvailable = await hasActiveCommunityElevenLabsCredential({
      env: input.env,
      communityId: input.communityId,
    })
    while (true) {
      const rows = await db.client.execute({
        sql: `
          SELECT post_id, community_id, author_user_id, post_type, status, visibility,
                 lyrics, title, song_title, song_cover_art_ref, song_artifact_bundle_id, source_language,
                 access_mode, age_gate_policy, asset_id, created_at
          FROM posts
          WHERE community_id = ?1
            AND post_type = 'song'
            AND status = 'published'
            AND visibility = 'public'
            AND (?2 IS NULL OR created_at < ?2 OR (created_at = ?2 AND post_id < ?3))
          ORDER BY created_at DESC, post_id DESC
          LIMIT ${CHAT_STUDY_SONG_QUERY_PAGE_SIZE}
        `,
        args: [input.communityId, cursorCreatedAt, cursorPostId],
      })
      const posts = rows.rows.flatMap((row) => {
        const post = studyPostFromRow(row)
        return post ? [post] : []
      })
      const [readyPostIds, rewards] = await Promise.all([
        batchReadyPostIds({
          client: db.client,
          credentialAvailable,
          posts,
          targetLanguage: input.targetLanguage,
          viewerUserId: input.actor.userId,
        }),
        activeCampaignRewards({ env: input.env, postIds: posts.map((post) => post.post_id) }),
      ])
      posts.forEach((post) => {
        if (!readyPostIds.has(post.post_id)) return
        const dailyRewardCents = rewards.get(post.post_id)
        ready.push({
          ...(dailyRewardCents ? { dailyRewardCents } : {}),
          postId: post.post_id,
          title: post.song_title?.trim() || post.title?.trim() || "Untitled song",
        })
      })
      if (rows.rows.length < CHAT_STUDY_SONG_QUERY_PAGE_SIZE) break
      const last = rows.rows.at(-1)
      cursorCreatedAt = stringOrNull(rowValue(last, "created_at"))
      cursorPostId = stringOrNull(rowValue(last, "post_id"))
      if (!cursorCreatedAt || !cursorPostId) break
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

async function sendSongPicker(input: {
  accountUserId: string
  bot: TelegramCommunityBotCredential
  chatId: string
  env: Env
  preference: { deliveryMode: StudyDeliveryMode; helperLanguage: StudyHelperLanguage }
  telegramUserId: string
}): Promise<void> {
  const actor: ActorContext = { authType: "user", userId: input.accountUserId }
  const songs = await listReadySongs({ actor, communityId: input.bot.communityId, env: input.env, targetLanguage: input.preference.helperLanguage })
  const copy = getTelegramStudyCopy(input.preference.helperLanguage)
  if (songs.length === 0) {
    await sendTelegramMessage(input.bot, { chat_id: input.chatId, text: copy.noSongs })
    return
  }
  const session = await replaceActiveSession({
    actionKind: "select_song", actionPayload: { deliveryMode: input.preference.deliveryMode, page: 0, songs }, bot: input.bot,
    env: input.env, status: "selecting", targetLanguage: input.preference.helperLanguage,
    telegramUserId: input.telegramUserId, userId: input.accountUserId,
  })
  const sent = await sendTelegramMessage(input.bot, { chat_id: input.chatId, text: copy.chooseSong, reply_markup: songPickerMarkup(songs, session.actionToken, 0) })
  await recordSessionPromptDelivery({
    actionToken: session.actionToken,
    env: input.env,
    messageId: sent.message_id,
    sessionId: session.id,
  })
}

async function runTelegramChatStudyStart(input: {
  bot: TelegramCommunityBotCredential
  chatId: string
  env: Env
  forcePreferences?: boolean
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
  const preference = await getUserStudyPreference(input.env, account.userId)
  if (preference && input.forcePreferences) {
    const copy = getTelegramStudyCopy(preference.helperLanguage)
    const session = await replaceActiveSession({
      actionKind: "select_song",
      actionPayload: { preferenceStep: "settings_menu" },
      bot: input.bot,
      env: input.env,
      status: "selecting",
      targetLanguage: preference.helperLanguage,
      telegramUserId: input.telegramUserId,
      userId: account.userId,
    })
    const sent = await sendTelegramMessage(input.bot, {
      chat_id: input.chatId,
      text: copy.settingsTitle,
      reply_markup: settingsMenuMarkup(session.actionToken, preference.helperLanguage),
    })
    await recordSessionPromptDelivery({ actionToken: session.actionToken, env: input.env, messageId: sent.message_id, sessionId: session.id })
    return true
  }
  if (!preference) {
    const suggestedLanguage = resolveRuntimeUiLocale(input.targetLanguage)
    const initialLanguage = suggestedLanguage ?? "en"
    const buttons = orderedLanguageButtons(suggestedLanguage)
    const copy = getTelegramStudyCopy(initialLanguage)
    const session = await replaceActiveSession({
      actionKind: "select_song", actionPayload: {
        currentDeliveryMode: "both",
        languageOptions: buttons.map(({ code }) => code),
        preferenceFlow: "first_run",
        preferenceStep: "language",
      }, bot: input.bot,
      env: input.env, status: "selecting", targetLanguage: initialLanguage,
      telegramUserId: input.telegramUserId, userId: account.userId,
    })
    const sent = await sendTelegramMessage(input.bot, {
      chat_id: input.chatId,
      text: copy.chooseLanguage,
      reply_markup: languagePickerMarkup(session.actionToken, buttons, suggestedLanguage, initialLanguage),
    })
    await recordSessionPromptDelivery({ actionToken: session.actionToken, env: input.env, messageId: sent.message_id, sessionId: session.id })
    return true
  }
  await sendSongPicker({ accountUserId: account.userId, bot: input.bot, chatId: input.chatId, env: input.env, preference, telegramUserId: input.telegramUserId })
  return true
}

async function recordSessionPromptDelivery(input: {
  actionToken: string
  env: Env
  messageId: number
  sessionId: string
}): Promise<void> {
  const deliveredAt = nowIso()
  const expiresAt = new Date(Date.parse(deliveredAt) + CHAT_STUDY_TTL_MS).toISOString()
  await getControlPlaneClient(input.env).execute({
    sql: `
      UPDATE telegram_chat_study_sessions
      SET prompt_message_id = ?3, expires_at = ?4, updated_at = ?5
      WHERE chat_study_session_id = ?1
        AND action_token = ?2
        AND status IN ('selecting', 'active', 'processing')
    `,
    args: [input.sessionId, input.actionToken, input.messageId, expiresAt, deliveredAt],
  })
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
  forcePreferences?: boolean
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
  const expiresAt = new Date(Date.parse(updatedAt) + CHAT_STUDY_TTL_MS).toISOString()
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
          expires_at = CASE WHEN ?2 IN ('active', 'processing') THEN ?10 ELSE expires_at END,
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
      expiresAt,
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

function feedbackText(input: {
  result: SongStudyAttemptResult
  study: SongStudyPayload
  transcript?: string
}): string {
  const { result } = input
  const language = (isStudyHelperLanguage(input.study.target_language) ? input.study.target_language : "en")
  const copy = getTelegramStudyCopy(language)
  if (result.outcome === "correct") return copy.correct
  if (input.transcript !== undefined) {
    const attempted = input.study.exercises.find((exercise) => exercise.id === result.exercise_id)
    if (attempted?.type === "say_it_back") {
      return `${copy.notQuite}\n\n${copy.lineWas}${copy.labelSeparator} “${attempted.reference_text}”\n${copy.youSaid}${copy.labelSeparator} “${input.transcript || copy.nothingDetected}”`
    }
  }
  const details = [
    result.feedback?.missing?.length ? `${copy.missing}${copy.labelSeparator} ${result.feedback.missing.join(", ")}` : null,
    result.feedback?.extra?.length ? `${copy.extra}${copy.labelSeparator} ${result.feedback.extra.join(", ")}` : null,
  ].filter((value): value is string => Boolean(value))
  return [copy.notQuite, ...details].join("\n")
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
    text: `${getTelegramStudyCopy(isStudyHelperLanguage(input.study.target_language) ? input.study.target_language : "en").complete}: ${input.study.title}${summary}`,
  })
}

async function presentNextExercise(input: {
  bot: TelegramCommunityBotCredential
  chatId: string
  env: Env
  lastResult?: SongStudyAttemptResult
  replyToMessageId?: number | null
  suppressIncorrectFeedback?: boolean
  session: ChatStudySession
  transcript?: string
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
  const language = isStudyHelperLanguage(input.session.targetLanguage) ? input.session.targetLanguage : "en"
  const copy = getTelegramStudyCopy(language)
  let localizationNoticeSent = input.session.actionPayload.localizationNoticeSent === true
  if (study.translation_status === "processing" && !localizationNoticeSent) {
    await sendTelegramMessage(input.bot, {
      chat_id: input.chatId,
      text: copy.pendingLocalization,
      reply_markup: { inline_keyboard: [[{ callback_data: localizationCheckData(input.session.id), text: copy.checkAgain }]] },
    })
    localizationNoticeSent = true
  }
  const exercise = study.access === "ready" ? eligibleExercise(study) : null
  if (input.lastResult && !(input.suppressIncorrectFeedback && input.lastResult.outcome !== "correct")) {
    // Grading runs in a deferred task, so its reply can land after a later
    // message. Anchoring it to the voice message keeps the thread unambiguous.
    await sendTelegramMessage(input.bot, {
      chat_id: input.chatId,
      text: feedbackText({ result: input.lastResult, study, transcript: input.transcript }),
      ...(input.replyToMessageId ? { reply_parameters: { message_id: input.replyToMessageId } } : {}),
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
        deliveryMode: isStudyDeliveryMode(input.session.actionPayload.deliveryMode) ? input.session.actionPayload.deliveryMode : "text",
        localizationNoticeSent,
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
        inline_keyboard: [
          ...exercise.options.map((option, index) => [{
            callback_data: callbackData(token, index),
            text: option.text.slice(0, 60),
          }]),
          [telegramStudyAskTutorButton(input.session.id, language)],
        ],
      },
    })
    await recordSessionPromptDelivery({ actionToken: token, env: input.env, messageId: sent.message_id, sessionId: input.session.id })
    return
  }
  const nextToken = actionToken()
  await createTelegramChatStudyVoiceIntent({
    actor,
    chatStudySessionId: input.session.id,
    communityId: input.session.communityId,
    env: input.env,
    exerciseId: exercise.id,
    nextActionToken: nextToken,
    postId: input.session.postId,
    previousActionToken: input.session.actionToken,
    targetLanguage: input.session.targetLanguage,
    telegramUserId: input.session.telegramUserId,
    deliveryMode: isStudyDeliveryMode(input.session.actionPayload.deliveryMode) ? input.session.actionPayload.deliveryMode : "text",
    localizationNoticeSent,
  })
  input.session.actionKind = "await_voice"
  input.session.actionPayload = {
    deliveryMode: isStudyDeliveryMode(input.session.actionPayload.deliveryMode) ? input.session.actionPayload.deliveryMode : "text",
    exerciseId: exercise.id,
    localizationNoticeSent,
  }
  input.session.actionToken = nextToken
  input.session.status = "active"
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
      SET status = 'processing', expires_at = ?5, updated_at = ?3
      WHERE chat_study_session_id = ?1
        AND action_token = ?2
        AND (
          status IN ('selecting', 'active')
          OR (status = 'processing' AND updated_at <= ?4)
        )
    `,
    args: [input.session.id, input.session.actionToken, now, staleProcessingBefore, new Date(Date.parse(now) + CHAT_STUDY_TTL_MS).toISOString()],
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
  const askSessionId = parseTelegramStudyAskTutorCallback(input.callback.data)
  if (askSessionId) {
    const callbackQueryId = stringOrNull(input.callback.id)
    const telegramUserId = telegramIdentifier(input.callback.from?.id)
    const chatId = telegramIdentifier(input.callback.message?.chat?.id)
    if (!callbackQueryId || !telegramUserId || !chatId) return true
    const result = await getControlPlaneClient(input.env).execute({
      sql: `
        SELECT chat_study_session_id, telegram_user_id, user_id, community_id,
               post_id, target_language, status, action_token, action_kind,
               action_payload_json
        FROM telegram_chat_study_sessions
        WHERE chat_study_session_id = ?1
          AND telegram_community_bot_id = ?2
          AND telegram_user_id = ?3
          AND status IN ('active', 'processing')
          AND expires_at > ?4
        LIMIT 1
      `,
      args: [askSessionId, input.bot.id, telegramUserId, nowIso()],
    })
    const session = parseSession(result.rows[0])
    if (!session || session.communityId !== input.bot.communityId) {
      await answerTelegramCallbackQuery(input.bot, { callback_query_id: callbackQueryId }).catch(() => undefined)
      return true
    }
    // Arming never disturbs the exercise: the pending answer stays valid, and
    // the flag is consumed by the next message whatever it turns out to be.
    await armPrivateStudyAskMode({ env: input.env, sessionId: session.id })
    const language = isStudyHelperLanguage(session.targetLanguage) ? session.targetLanguage : "en"
    await answerTelegramCallbackQuery(input.bot, {
      callback_query_id: callbackQueryId,
      text: getTelegramStudyCopy(language).askPrompt,
    }).catch(() => undefined)
    await sendTelegramMessage(input.bot, {
      chat_id: chatId,
      text: getTelegramStudyCopy(language).askPrompt,
    }).catch(() => undefined)
    return true
  }
  const playbackSessionId = parseTelegramStudyPlaybackCallback(input.callback.data)
  if (playbackSessionId) {
    const callbackQueryId = stringOrNull(input.callback.id)
    const telegramUserId = telegramIdentifier(input.callback.from?.id)
    const chatId = telegramIdentifier(input.callback.message?.chat?.id)
    if (!callbackQueryId || !telegramUserId || !chatId) return true
    const result = await getControlPlaneClient(input.env).execute({
      sql: `
        SELECT chat_study_session_id, telegram_user_id, user_id, community_id,
               post_id, target_language, status, action_token, action_kind,
               action_payload_json
        FROM telegram_chat_study_sessions
        WHERE chat_study_session_id = ?1
          AND telegram_community_bot_id = ?2
          AND telegram_user_id = ?3
          AND status IN ('active', 'processing')
          AND expires_at > ?4
        LIMIT 1
      `,
      args: [playbackSessionId, input.bot.id, telegramUserId, nowIso()],
    })
    const session = parseSession(result.rows[0])
    if (!session?.postId || session.communityId !== input.bot.communityId) {
      await answerTelegramCallbackQuery(input.bot, { callback_query_id: callbackQueryId }).catch(() => undefined)
      return true
    }
    if (!await claimCallback({ bot: input.bot, callbackQueryId, env: input.env, sessionId: session.id })) {
      await answerTelegramCallbackQuery(input.bot, { callback_query_id: callbackQueryId }).catch(() => undefined)
      return true
    }
    await answerTelegramCallbackQuery(input.bot, { callback_query_id: callbackQueryId }).catch(() => undefined)
    try {
      await sendTelegramStudySongPlayback({
        actor: { authType: "user", userId: session.userId },
        bot: input.bot,
        chatId,
        env: input.env,
        postId: session.postId,
      })
      await finishCallback({ callbackQueryId, env: input.env })
    } catch (error) {
      await finishCallback({ callbackQueryId, env: input.env, error }).catch(() => undefined)
      throw error
    }
    return true
  }
  const restartMatch = typeof input.callback.data === "string"
    ? input.callback.data.match(/^study-restart:(tcs_[A-Za-z0-9_-]+)$/u)
    : null
  if (restartMatch) {
    const callbackQueryId = stringOrNull(input.callback.id)
    const telegramUserId = telegramIdentifier(input.callback.from?.id)
    const chatId = telegramIdentifier(input.callback.message?.chat?.id)
    if (!callbackQueryId || !telegramUserId || !chatId) return true
    if (!isTelegramStudyVoiceEnabled(input.env, input.bot.communityId)) {
      await answerTelegramCallbackQuery(input.bot, {
        callback_query_id: callbackQueryId,
        text: getTelegramStudyCopy("en").studyUnavailable,
      }).catch(() => undefined)
      return true
    }
    const result = await getControlPlaneClient(input.env).execute({
      sql: `
        SELECT chat_study_session_id, telegram_user_id, user_id, community_id,
               post_id, target_language, status, action_token, action_kind,
               action_payload_json
        FROM telegram_chat_study_sessions
        WHERE chat_study_session_id = ?1
          AND telegram_community_bot_id = ?2
          AND telegram_user_id = ?3
        LIMIT 1
      `,
      args: [restartMatch[1], input.bot.id, telegramUserId],
    })
    const session = parseSession(result.rows[0])
    if (!session || session.communityId !== input.bot.communityId) {
      await answerTelegramCallbackQuery(input.bot, { callback_query_id: callbackQueryId }).catch(() => undefined)
      return true
    }
    if (!await claimCallback({ bot: input.bot, callbackQueryId, env: input.env, sessionId: session.id })) {
      await answerTelegramCallbackQuery(input.bot, { callback_query_id: callbackQueryId }).catch(() => undefined)
      return true
    }
    await answerTelegramCallbackQuery(input.bot, { callback_query_id: callbackQueryId }).catch(() => undefined)
    try {
      await runTelegramChatStudyStart({
        bot: input.bot,
        chatId,
        env: input.env,
        targetLanguage: session.targetLanguage,
        telegramUserId,
      })
      await finishCallback({ callbackQueryId, env: input.env })
    } catch (error) {
      await finishCallback({ callbackQueryId, env: input.env, error }).catch(() => undefined)
      throw error
    }
    return true
  }
  const checkMatch = typeof input.callback.data === "string"
    ? input.callback.data.match(/^study-check:(tcs_[A-Za-z0-9_-]+)$/u)
    : null
  if (checkMatch) {
    const callbackQueryId = stringOrNull(input.callback.id)
    const telegramUserId = telegramIdentifier(input.callback.from?.id)
    const chatId = telegramIdentifier(input.callback.message?.chat?.id)
    if (!callbackQueryId || !telegramUserId || !chatId) return true
    const result = await getControlPlaneClient(input.env).execute({
      sql: `
        SELECT chat_study_session_id, telegram_user_id, user_id, community_id,
               post_id, target_language, status, action_token, action_kind, action_payload_json
        FROM telegram_chat_study_sessions
        WHERE chat_study_session_id = ?1 AND telegram_community_bot_id = ?2
          AND telegram_user_id = ?3
        LIMIT 1
      `,
      args: [checkMatch[1], input.bot.id, telegramUserId],
    })
    const session = parseSession(result.rows[0])
    const language = session && isStudyHelperLanguage(session.targetLanguage) ? session.targetLanguage : "en"
    const copy = getTelegramStudyCopy(language)
    if (!session?.postId) {
      await answerTelegramCallbackQuery(input.bot, { callback_query_id: callbackQueryId, text: copy.buttonExpired }).catch(() => undefined)
      return true
    }
    if (!await claimCallback({ bot: input.bot, callbackQueryId, env: input.env, sessionId: session.id })) {
      await answerTelegramCallbackQuery(input.bot, { callback_query_id: callbackQueryId }).catch(() => undefined)
      return true
    }
    if (!["active", "processing"].includes(session.status)) {
      await answerTelegramCallbackQuery(input.bot, { callback_query_id: callbackQueryId, text: copy.buttonExpired }).catch(() => undefined)
      await finishCallback({ callbackQueryId, env: input.env })
      return true
    }
    try {
      const study = await getPostStudyPayload({
        actor: { authType: "user", userId: session.userId }, communityId: session.communityId,
        communityRepository: getCommunityRepository(input.env), env: input.env, postId: session.postId,
        targetLanguage: session.targetLanguage,
      })
      const ready = study.translation_status === "ready"
      await answerTelegramCallbackQuery(input.bot, { callback_query_id: callbackQueryId, text: ready ? copy.translationsReady : copy.pendingLocalization }).catch(() => undefined)
      if (ready) {
        await sendTelegramMessage(input.bot, { chat_id: chatId, text: copy.translationsReady }).catch(() => undefined)
      }
      await finishCallback({ callbackQueryId, env: input.env })
    } catch (error) {
      await finishCallback({ callbackQueryId, env: input.env, error }).catch(() => undefined)
      throw error
    }
    return true
  }
  const parsed = parseCallbackData(input.callback.data)
  if (!parsed) return false
  const callbackQueryId = stringOrNull(input.callback.id)
  const telegramUserId = telegramIdentifier(input.callback.from?.id)
  const chatId = telegramIdentifier(input.callback.message?.chat?.id)
  if (!callbackQueryId || !telegramUserId || !chatId) return true
  if (!isTelegramStudyVoiceEnabled(input.env, input.bot.communityId)) {
    await answerTelegramCallbackQuery(input.bot, {
      callback_query_id: callbackQueryId,
      text: getTelegramStudyCopy("en").studyUnavailable,
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
      text: getTelegramStudyCopy("en").buttonExpired,
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
      text: getTelegramStudyCopy(isStudyHelperLanguage(session.targetLanguage) ? session.targetLanguage : "en").alreadyHandled,
    }).catch(() => undefined)
    return true
  }
  await answerTelegramCallbackQuery(input.bot, {
    callback_query_id: callbackQueryId,
  }).catch(() => undefined)
  try {
    if (session.actionKind === "select_song" && session.actionPayload.preferenceStep === "settings_menu") {
      const preference = await getUserStudyPreference(input.env, session.userId)
      if (!preference) throw new Error("Study preferences are no longer available")
      if (parsed.index === 0) {
        const buttons = orderedLanguageButtons(null)
        const token = await updateSessionAction({
          actionKind: "select_song",
          actionPayload: {
            currentDeliveryMode: preference.deliveryMode,
            languageOptions: buttons.map(({ code }) => code),
            preferenceFlow: "preferences",
            preferenceStep: "language",
          },
          env: input.env,
          session,
          status: "active",
        })
        const sent = await sendTelegramMessage(input.bot, {
          chat_id: chatId,
          text: getTelegramStudyCopy(preference.helperLanguage).chooseLanguage,
          reply_markup: languagePickerMarkup(token, buttons, null, preference.helperLanguage),
        })
        await recordSessionPromptDelivery({ actionToken: token, env: input.env, messageId: sent.message_id, sessionId: session.id })
      } else if (parsed.index === 1) {
        const token = await updateSessionAction({
          actionKind: "select_song",
          actionPayload: { helperLanguage: preference.helperLanguage, preferenceStep: "delivery" },
          env: input.env,
          session,
          status: "active",
        })
        const sent = await sendTelegramMessage(input.bot, {
          chat_id: chatId,
          text: getTelegramStudyCopy(preference.helperLanguage).chooseDelivery,
          reply_markup: deliveryPickerMarkup(token, preference.helperLanguage),
        })
        await recordSessionPromptDelivery({ actionToken: token, env: input.env, messageId: sent.message_id, sessionId: session.id })
      } else {
        throw new Error("Study settings choice is no longer available")
      }
    } else if (session.actionKind === "select_song" && session.actionPayload.preferenceStep === "language") {
      const languageOptions = Array.isArray(session.actionPayload.languageOptions)
        ? session.actionPayload.languageOptions.filter(isStudyHelperLanguage)
        : STUDY_LANGUAGE_BUTTONS.map(({ code }) => code)
      const language = languageOptions[parsed.index]
      if (!language) throw new Error("Study language choice is no longer available")
      if (session.actionPayload.preferenceFlow === "first_run") {
        const preference = await upsertUserStudyPreference({
          deliveryMode: "both",
          env: input.env,
          helperLanguage: language,
          userId: session.userId,
        })
        await sendSongPicker({ accountUserId: session.userId, bot: input.bot, chatId, env: input.env, preference, telegramUserId })
        await finishCallback({ callbackQueryId, env: input.env })
        return true
      }
      const deliveryMode = isStudyDeliveryMode(session.actionPayload.currentDeliveryMode)
        ? session.actionPayload.currentDeliveryMode
        : "both"
      const preference = await upsertUserStudyPreference({
        deliveryMode,
        env: input.env,
        helperLanguage: language,
        userId: session.userId,
      })
      await sendSongPicker({ accountUserId: session.userId, bot: input.bot, chatId, env: input.env, preference, telegramUserId })
    } else if (session.actionKind === "select_song" && session.actionPayload.preferenceStep === "delivery") {
      const helperLanguage = session.actionPayload.helperLanguage
      const deliveryMode = STUDY_DELIVERY_MODES[parsed.index]
      if (!isStudyHelperLanguage(helperLanguage) || !isStudyDeliveryMode(deliveryMode)) {
        throw new Error("Study delivery choice is no longer available")
      }
      const preference = await upsertUserStudyPreference({ deliveryMode, env: input.env, helperLanguage, userId: session.userId })
      await sendSongPicker({ accountUserId: session.userId, bot: input.bot, chatId, env: input.env, preference, telegramUserId })
    } else if (session.actionKind === "select_song") {
      const songs = Array.isArray(session.actionPayload.songs)
        ? session.actionPayload.songs.flatMap((value) => {
            if (!value || typeof value !== "object") return []
            const postId = stringOrNull((value as Record<string, unknown>).postId)
            const title = stringOrNull((value as Record<string, unknown>).title)
            const dailyRewardCents = Number((value as Record<string, unknown>).dailyRewardCents)
            return postId && title
              ? [{
                  ...(Number.isSafeInteger(dailyRewardCents) && dailyRewardCents > 0 ? { dailyRewardCents } : {}),
                  postId,
                  title,
                }]
              : []
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
            text: getTelegramStudyCopy(session.targetLanguage as StudyHelperLanguage).chooseSong,
            reply_markup: songPickerMarkup(songs, token, page),
          })
        } else {
          await sendTelegramMessage(input.bot, {
            chat_id: chatId,
            text: getTelegramStudyCopy(session.targetLanguage as StudyHelperLanguage).chooseSong,
            reply_markup: songPickerMarkup(songs, token, page),
          })
        }
        await finishCallback({ callbackQueryId, env: input.env })
        return true
      }
      const selectedIndex = telegramStudySongSelectionIndex(currentPage, parsed.index)
      const postId = songs[selectedIndex]?.postId
      if (!postId) throw new Error("Song choice is no longer available")
      const preference = await getUserStudyPreference(input.env, session.userId)
      const helperLanguage = preference?.helperLanguage ?? (isStudyHelperLanguage(session.targetLanguage) ? session.targetLanguage : "en")
      const deliveryMode = preference?.deliveryMode ?? "text"
      session.postId = postId
      session.targetLanguage = helperLanguage
      session.actionPayload = { deliveryMode }
      const selected = await getControlPlaneClient(input.env).execute({
        sql: `
          UPDATE telegram_chat_study_sessions
          SET post_id = ?2, target_language = ?3, action_payload_json = ?4,
              status = 'active', updated_at = ?5
          WHERE chat_study_session_id = ?1
            AND action_token = ?6
            AND action_kind = 'select_song'
            AND status = 'processing'
        `,
        args: [session.id, postId, helperLanguage, JSON.stringify({ deliveryMode }), nowIso(), session.actionToken],
      })
      if ((selected.rowsAffected ?? 0) !== 1) {
        throw new Error("Song choice is no longer active")
      }
      await sendTelegramStudySongPlayback({
        actor: { authType: "user", userId: session.userId },
        bot: input.bot,
        chatId,
        env: input.env,
        postId,
      }).catch((error) => {
        console.warn("[telegram-study] song playback omitted", {
          communityId: session.communityId,
          error: error instanceof Error ? error.message : String(error),
          postId,
        })
      })
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
        const copy = getTelegramStudyCopy(isStudyHelperLanguage(session.targetLanguage) ? session.targetLanguage : "en")
        const correction = result.outcome !== "correct" && correctText
          ? `\n✅ ${copy.correctAnswer}${copy.labelSeparator} ${correctText}`
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
        suppressIncorrectFeedback: true,
      })
    }
    await finishCallback({ callbackQueryId, env: input.env })
  } catch (error) {
    await releaseSessionAction({ env: input.env, session }).catch(() => undefined)
    await finishCallback({ callbackQueryId, env: input.env, error })
    await sendTelegramMessage(input.bot, {
      chat_id: chatId,
      text: getTelegramStudyCopy(isStudyHelperLanguage(session.targetLanguage) ? session.targetLanguage : "en").processingError,
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
  replyToMessageId?: number | null
  result: SongStudyAttemptResult
  transcript: string
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
        AND expires_at > ?3
      LIMIT 1
    `,
    args: [input.chatStudySessionId, input.bot.id, nowIso()],
  })
  const session = parseSession(query.rows[0])
  if (!session || session.actionKind !== "await_voice") return
  await presentNextExercise({
    bot: input.bot,
    chatId: input.chatId,
    env: input.env,
    lastResult: input.result,
    replyToMessageId: input.replyToMessageId,
    session,
    transcript: input.transcript,
  })
}
