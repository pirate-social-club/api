function directAssistantPreviewText(input: {
  content: string
  locale: RuntimeUiLocaleCode
}): string {
  return telegramText(input.content.trim())
}

function directAssistantPreviewLimitText(input: {
  limitScope: "community" | "user"
  locale: RuntimeUiLocaleCode
}): string {
  const copy = getTelegramCopy(input.locale).privateAssistant
  return input.limitScope === "user"
    ? copy.previewUserCapReached
    : copy.previewCommunityCapReached
}

function directAssistantPreviewUnavailableText(input: {
  locale: RuntimeUiLocaleCode
}): string {
  const copy = getTelegramCopy(input.locale).privateAssistant
  return copy.previewUnavailable
}

async function insertDirectAssistantPreviewEvent(input: {
  env: Env
  communityId: string
  telegramChatId: string
  telegramMessageId: number
  telegramUserId: string
  prompt: string
  now: string
}): Promise<string> {
  const eventId = makeId("tae")
  await getControlPlaneClient(input.env).execute({
    sql: `
      INSERT INTO telegram_assistant_events (
        event_id, community_id, telegram_chat_id, telegram_message_id, telegram_user_id,
        user_id, channel, trigger_type, prompt, assistant_message_ref, status, error_message,
        created_at, completed_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5,
        NULL, 'private_preview', 'reply_to_bot', ?6, NULL, 'received', NULL,
        ?7, NULL
      )
    `,
    args: [
      eventId,
      input.communityId,
      input.telegramChatId,
      input.telegramMessageId,
      input.telegramUserId,
      input.prompt,
      input.now,
    ],
  })
  return eventId
}

async function updateDirectAssistantPreviewEvent(input: {
  env: Env
  eventId: string
  status: "answered" | "failed" | "rate_limited"
  assistantMessageRef?: string | null
  errorMessage?: string | null
}): Promise<void> {
  await getControlPlaneClient(input.env).execute({
    sql: `
      UPDATE telegram_assistant_events
      SET status = ?2,
          assistant_message_ref = ?3,
          error_message = ?4,
          completed_at = ?5
      WHERE event_id = ?1
    `,
    args: [
      input.eventId,
      input.status,
      input.assistantMessageRef ?? null,
      input.errorMessage ?? null,
      nowIso(),
    ],
  })
}

async function directAssistantPreviewLimitReached(input: {
  env: Env
  communityId: string
  eventId: string
  telegramUserId: string
  now: string
  userDailyLimit: number
}): Promise<"community" | "user" | null> {
  const parsedNow = Date.parse(input.now)
  const since = new Date(
    Number.isFinite(parsedNow)
      ? parsedNow - TELEGRAM_DIRECT_PREVIEW_WINDOW_MS
      : Date.now() - TELEGRAM_DIRECT_PREVIEW_WINDOW_MS,
  ).toISOString()
  const result = await getControlPlaneClient(input.env).execute({
    sql: `
      SELECT
        COALESCE(SUM(CASE WHEN telegram_user_id = ?3 THEN 1 ELSE 0 END), 0) AS user_count,
        COUNT(*) AS community_count
      FROM telegram_assistant_events
      WHERE community_id = ?2
        AND channel = 'private_preview'
        AND created_at >= ?4
        AND event_id <> ?1
    `,
    args: [
      input.eventId,
      input.communityId,
      input.telegramUserId,
      since,
    ],
  })
  const row = result.rows[0]
  const userCount = Number(row?.user_count ?? 0)
  const communityCount = Number(row?.community_count ?? 0)
  if (userCount >= input.userDailyLimit) {
    return "user"
  }
  if (communityCount >= TELEGRAM_DIRECT_PREVIEW_COMMUNITY_DAILY_LIMIT) {
    return "community"
  }
  return null
}

export async function sendDirectAssistantPreviewResponse(input: {
  env: Env
  bot: TelegramCommunityBotCredential
  chatId: string
  telegramMessageId: number
  telegramUserId: string
  locale: RuntimeUiLocaleCode
  policy: CommunityAssistantPolicy
  prompt: string
}): Promise<void> {
  const now = nowIso()
  const eventId = await insertDirectAssistantPreviewEvent({
    env: input.env,
    communityId: input.bot.communityId,
    telegramChatId: input.chatId,
    telegramMessageId: input.telegramMessageId,
    telegramUserId: input.telegramUserId,
    prompt: input.prompt,
    now,
  })

  try {
    const limitScope = await directAssistantPreviewLimitReached({
      env: input.env,
      communityId: input.bot.communityId,
      eventId,
      telegramUserId: input.telegramUserId,
      now,
      userDailyLimit: input.policy.telegramPreviewDailyCap,
    })
    if (limitScope) {
      await updateDirectAssistantPreviewEvent({
        env: input.env,
        eventId,
        status: "rate_limited",
        errorMessage: limitScope === "user"
          ? "Telegram direct preview daily limit reached"
          : "Telegram direct preview community daily limit reached",
      })
      await safeSendTelegramMessage(input.bot, {
        chat_id: input.chatId,
        text: directAssistantPreviewLimitText({
          limitScope,
          locale: input.locale,
        }),
      })
      return
    }

    const answer = await sendCommunityAssistantGroupMessage({
      env: input.env,
      communityRepository: getCommunityRepository(input.env),
      communityId: input.bot.communityId,
      message: input.prompt,
    })
    await updateDirectAssistantPreviewEvent({
      env: input.env,
      eventId,
      status: "answered",
      assistantMessageRef: answer.provider_message_id,
    })
    await safeSendTelegramMessage(input.bot, {
      chat_id: input.chatId,
      text: directAssistantPreviewText({
        content: answer.content,
        locale: input.locale,
      }),
    })
  } catch (error) {
    console.warn("[telegram-assistant] direct preview failed", {
      ...telegramRouteErrorLogFields(error),
      communityId: input.bot.communityId,
      eventId,
      promptLength: input.prompt.length,
      telegramChatId: input.chatId,
      telegramCommunityBotId: input.bot.id,
      telegramUserId: input.telegramUserId,
    })
    await updateDirectAssistantPreviewEvent({
      env: input.env,
      eventId,
      status: "failed",
      errorMessage: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined)
    await safeSendTelegramMessage(input.bot, {
      chat_id: input.chatId,
      text: directAssistantPreviewUnavailableText({
        locale: input.locale,
      }),
    })
  }
}

function directAssistantLinkText(input: {
  env: Env
  communityId: string
  reason: "unlinked" | "not_member"
}): string {
  const url = communityTelegramJoinUrl(input.env, input.communityId)
  const body = directAssistantLinkBody(input.reason)
  return url ? `${body}\n${url}` : body
}

function directAssistantLinkBody(reason: "unlinked" | "not_member"): string {
  return reason === "unlinked"
    ? "Open Pirate to link this Telegram account before messaging the community assistant."
    : "Verify and join this community to use the full assistant."
}

export async function sendDirectAssistantOnboardingPrompt(input: {
  env: Env
  bot: TelegramCommunityBotCredential
  chatId: string
  telegramUserId: string
  reason: "unlinked" | "not_member"
}): Promise<void> {
  try {
    const intent = await createTelegramOnboardingIntent({
      env: input.env,
      communityId: input.bot.communityId,
      telegramCommunityBotId: input.bot.id,
      telegramUserId: input.telegramUserId,
      privateChatId: input.chatId,
      source: "dm",
    })
    await safeSendTelegramMessage(input.bot, {
      chat_id: input.chatId,
      text: directAssistantLinkBody(input.reason),
      reply_markup: telegramOnboardingWebAppReplyMarkup(intent.web_app_url),
    })
  } catch {
    await safeSendTelegramMessage(input.bot, {
      chat_id: input.chatId,
      text: directAssistantLinkText({
        env: input.env,
        communityId: input.bot.communityId,
        reason: input.reason,
      }),
    })
  }
}

export async function getTelegramDirectAssistantPolicy(input: {
  env: Env
  communityId: string
}): Promise<CommunityAssistantPolicy> {
  const policy = await getCommunityAssistantRuntimePolicyForCommunity({
    env: input.env,
    communityRepository: getCommunityRepository(input.env),
    communityId: input.communityId,
  })
  if (!policy.telegramPrivateAssistantEnabled) {
    throw notFoundError("Telegram private assistant is not enabled")
  }
  return policy
}

export function directAssistantFailureMessage(error: unknown): string {
  if (error instanceof HttpError && error.status === 404) {
    return "Community assistant is not enabled. In Pirate, open Mod > Assistant, turn it on, and save settings before messaging this bot."
  }
  if (error instanceof HttpError && error.status === 400) {
    return "Community assistant is missing required setup. In Pirate, check Mod > Assistant for the OpenRouter key, model, and saved assistant settings."
  }
  if (error instanceof HttpError && error.status === 429) {
    return "Community assistant is rate limited right now. Try again later."
  }
  if (error instanceof HttpError && error.status === 502) {
    return "The assistant model provider failed to respond. Try again, or choose a different model in Pirate under Mod > Assistant."
  }
  return "Community assistant is unavailable right now. Try again later."
}

export function telegramRouteErrorLogFields(error: unknown): Record<string, unknown> {
  return {
    error: error instanceof Error ? error.message : String(error),
    errorName: error instanceof Error ? error.name : null,
    httpStatus: error instanceof HttpError ? error.status : null,
    httpCode: error instanceof HttpError ? error.code : null,
  }
}

export async function safeSendTelegramMessage(
  bot: Env | TelegramBotCredential,
  body: Parameters<typeof sendTelegramMessage>[1],
): Promise<boolean> {
  try {
    await sendTelegramMessage(bot, body)
    return true
  } catch (error) {
    console.warn("[telegram-webhook] sendMessage failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

export async function safeSetTelegramChatMenuButton(
  bot: Env | TelegramBotCredential,
  body: Parameters<typeof setTelegramChatMenuButton>[1],
): Promise<boolean> {
  try {
    await setTelegramChatMenuButton(bot, body)
    return true
  } catch (error) {
    console.warn("[telegram-webhook] setChatMenuButton failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

async function safeSendTelegramVoice(
  bot: Env | TelegramBotCredential,
  body: Parameters<typeof sendTelegramVoice>[1],
  logContext: Record<string, unknown> = {},
): Promise<boolean> {
  try {
    await sendTelegramVoice(bot, body)
    return true
  } catch (error) {
    console.warn("[telegram-webhook] sendVoice failed", {
      ...logContext,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

function telegramFileNameFromPath(filePath: string | undefined, fallback: string): string {
  const name = filePath?.split("/").pop()?.trim()
  return name || fallback
}

export async function transcribeTelegramGroupAssistantVoice(input: {
  env: Env
  bot: Env | TelegramCommunityBotCredential
  telegramChatId: string
  trigger: TelegramAssistantVoiceTrigger
}): Promise<string | null> {
  const linkedChat = await getTelegramLinkedChatBotContext({
    env: input.env,
    telegramChatId: input.telegramChatId,
  })
  if (!linkedChat) {
    return null
  }

  return transcribeTelegramAssistantVoiceForCommunity({
    env: input.env,
    bot: input.bot,
    communityId: linkedChat.communityId,
    trigger: input.trigger,
  })
}

export async function transcribeTelegramAssistantVoiceForCommunity(input: {
  env: Env
  bot: Env | TelegramCommunityBotCredential
  communityId: string
  trigger: TelegramAssistantVoiceTrigger
}): Promise<string | null> {
  const logContext = {
    communityId: input.communityId,
    fileId: input.trigger.fileId,
    initialFileSize: input.trigger.fileSize,
    initialMimeType: input.trigger.mimeType,
    triggerType: input.trigger.triggerType,
  }
  console.info("[telegram-assistant] voice STT start", logContext)
  try {
    if (
      input.trigger.fileSize !== null
      && input.trigger.fileSize > COMMUNITY_ASSISTANT_MAX_TRANSCRIPTION_AUDIO_BYTES
    ) {
      throw badRequestError("audio file must be at most 20MB")
    }

    const telegramFile = await getTelegramFile(input.bot, input.trigger.fileId)
    const fileSize = typeof telegramFile.file_size === "number" && Number.isFinite(telegramFile.file_size)
      ? telegramFile.file_size
      : input.trigger.fileSize
    if (fileSize !== null && fileSize > COMMUNITY_ASSISTANT_MAX_TRANSCRIPTION_AUDIO_BYTES) {
      throw badRequestError("audio file must be at most 20MB")
    }
    if (!telegramFile.file_path?.trim()) {
      throw badRequestError("Telegram audio file is not available")
    }

    const download = await downloadTelegramFile(input.bot, telegramFile.file_path)
    const fileName = telegramFileNameFromPath(telegramFile.file_path, input.trigger.fileName)
    const mimeType = inferTelegramAudioMimeType({
      explicitMimeType: input.trigger.mimeType === "application/octet-stream"
        ? download.contentType ?? undefined
        : input.trigger.mimeType,
      fallback: download.contentType ?? input.trigger.mimeType,
      fileName,
    })
    const transcript = await transcribeCommunityAssistantAudioForCommunity({
      env: input.env,
      communityRepository: getCommunityRepository(input.env),
      communityId: input.communityId,
      file: new File([download.bytes], fileName, { type: mimeType }),
    })
    const prompt = transcript.text.trim()
    console.info("[telegram-assistant] voice STT success", {
      ...logContext,
      durationSeconds: transcript.duration_seconds,
      fileSize,
      languageCode: transcript.language_code,
      languageProbability: transcript.language_probability,
      model: transcript.model,
      promptLength: prompt.length,
      resolvedMimeType: mimeType,
    })
    return prompt || null
  } catch (error) {
    console.warn("[telegram-assistant] voice STT failed", {
      ...logContext,
      ...telegramRouteErrorLogFields(error),
    })
    throw error
  }
}

export async function maybeSendTelegramAssistantVoiceReplyForCommunity(input: {
  answerText: string
  bot: Env | TelegramCommunityBotCredential
  chatId: string
  communityId: string
  env: Env
  message: TelegramWebhookMessage
  messageThreadId?: number
  sendTextBeforeVoice?: () => Promise<boolean>
}): Promise<boolean> {
  const communityRepository = getCommunityRepository(input.env)
  let policy
  try {
    policy = await getCommunityAssistantRuntimePolicyForCommunity({
      env: input.env,
      communityRepository,
      communityId: input.communityId,
    })
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      return false
    }
    throw error
  }
  if (
    policy.voiceMode !== "voice_replies"
    && policy.voiceMode !== "text_and_voice_replies"
    || policy.ttsProvider !== "elevenlabs"
    || !policy.ttsVoice.trim()
  ) {
    return false
  }

  const logContext = {
    communityId: input.communityId,
    messageId: input.message.message_id ?? null,
    outputFormat: TELEGRAM_ELEVENLABS_TTS_OUTPUT_FORMAT,
    telegramChatId: input.chatId,
    textLength: input.answerText.length,
    ttsProvider: policy.ttsProvider,
    ttsVoice: policy.ttsVoice,
    voiceMode: policy.voiceMode,
  }
  const textSent = policy.voiceMode === "text_and_voice_replies" && input.sendTextBeforeVoice
    ? await input.sendTextBeforeVoice()
    : false
  let speech
  try {
    console.info("[telegram-assistant] voice TTS start", logContext)
    speech = await synthesizeCommunityAssistantSpeechForCommunity({
      env: input.env,
      communityRepository,
      communityId: input.communityId,
      outputFormat: TELEGRAM_ELEVENLABS_TTS_OUTPUT_FORMAT,
      text: input.answerText,
    })
    console.info("[telegram-assistant] voice TTS success", {
      ...logContext,
      audioBytes: speech.audio.byteLength,
      characterCount: speech.characterCount,
      contentType: speech.contentType,
      model: speech.model,
      requestId: speech.requestId,
      voiceId: speech.voiceId,
    })
  } catch (error) {
    console.warn("[telegram-webhook] assistant TTS failed", {
      ...logContext,
      ...telegramRouteErrorLogFields(error),
    })
    return textSent
  }

  const sent = await safeSendTelegramVoice(input.bot, {
    chat_id: input.chatId,
    ...(typeof input.messageThreadId === "number" ? { message_thread_id: input.messageThreadId } : {}),
    voice: new File([speech.audio], "assistant-reply.ogg", {
      type: speech.contentType || "audio/ogg",
    }),
    reply_parameters: {
      message_id: input.message.message_id!,
    },
  }, logContext)
  console.info("[telegram-assistant] voice reply send result", {
    ...logContext,
    sent,
    textSent,
  })
  return sent || textSent
}

export async function maybeSendTelegramAssistantVoiceReply(input: {
  answerText: string
  bot: Env | TelegramCommunityBotCredential
  env: Env
  message: TelegramWebhookMessage
  sendTextBeforeVoice?: () => Promise<boolean>
  telegramChatId: string
}): Promise<boolean> {
  const linkedChat = await getTelegramLinkedChatBotContext({
    env: input.env,
    telegramChatId: input.telegramChatId,
  })
  if (!linkedChat) {
    return false
  }
  return maybeSendTelegramAssistantVoiceReplyForCommunity({
    answerText: input.answerText,
    bot: input.bot,
    chatId: input.telegramChatId,
    communityId: linkedChat.communityId,
    env: input.env,
    message: input.message,
    messageThreadId: input.message.message_thread_id,
    sendTextBeforeVoice: input.sendTextBeforeVoice,
  })
}

export async function telegramUserCanAccessCommunity(input: {
  env: Env
  communityId: string
  userId: string
}): Promise<boolean> {
  const communityRepository = getCommunityRepository(input.env)
  const db = await openCommunityReadClient(input.env, communityRepository, input.communityId)
  try {
    const membership = await getCommunityMembershipState(db.client, input.communityId, input.userId)
    return canAccessCommunity(membership)
  } finally {
    db.close()
  }
}
import type { Env } from "../env"
import { getCommunityRepository } from "../lib/communities/db-community-repository"
import { publicCommunityId } from "../lib/public-ids"
import {
  downloadTelegramFile,
  getTelegramFile,
  sendTelegramMessage,
  sendTelegramVoice,
  setTelegramChatMenuButton,
  type TelegramBotCredential,
} from "../lib/telegram/bot-api"
import { createTelegramOnboardingIntent, telegramOnboardingWebAppReplyMarkup } from "../lib/telegram/onboarding-service"
import { telegramText } from "../lib/telegram/assistant-service"
import {
  COMMUNITY_ASSISTANT_MAX_TRANSCRIPTION_AUDIO_BYTES,
  synthesizeCommunityAssistantSpeechForCommunity,
  TELEGRAM_ELEVENLABS_TTS_OUTPUT_FORMAT,
  transcribeCommunityAssistantAudioForCommunity,
} from "../lib/communities/assistant-policy/speech-service"
import {
  getCommunityAssistantRuntimePolicyForCommunity,
  type CommunityAssistantPolicy,
} from "../lib/communities/assistant-policy/service"
import { openCommunityReadClient } from "../lib/communities/community-read-access"
import { canAccessCommunity } from "../lib/communities/membership/membership-state-store"
import {
  sendCommunityAssistantGroupMessage,
} from "../lib/communities/assistant-policy/chat-service"
import { makeId, nowIso } from "../lib/helpers"
import { getControlPlaneClient } from "../lib/runtime-deps"
import { getTelegramCopy } from "../lib/telegram/telegram-copy"
import type { RuntimeUiLocaleCode } from "../lib/telegram/telegram-locale"
import { getTelegramLinkedChatBotContext } from "../lib/telegram/community-chat-service"
import type { TelegramCommunityBotCredential } from "../lib/telegram/community-bot-service"
import {
  inferTelegramAudioMimeType,
  type TelegramAssistantVoiceTrigger,
  type TelegramWebhookMessage,
} from "../lib/telegram/webhook-parsing"
import { badRequestError, HttpError, notFoundError } from "../lib/errors"
import { getCommunityMembershipState } from "../lib/communities/membership/membership-state-store"

const TELEGRAM_DIRECT_PREVIEW_COMMUNITY_DAILY_LIMIT = 1000
const TELEGRAM_DIRECT_PREVIEW_WINDOW_MS = 24 * 60 * 60 * 1000

function communityTelegramJoinUrl(env: Env, communityId: string): string | null {
  const origin = env.PIRATE_WEB_PUBLIC_ORIGIN?.trim().replace(/\/+$/u, "")
  return origin ? `${origin}/tg/c/${encodeURIComponent(publicCommunityId(communityId))}` : null
}
