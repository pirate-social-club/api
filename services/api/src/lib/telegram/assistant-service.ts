import type { Env } from "../../env"
import type { CommunityAssistantRepository } from "../communities/assistant-policy/access"
import { sendCommunityAssistantGroupMessage } from "../communities/assistant-policy/chat-service"
import { HttpError, rateLimited } from "../errors"
import { makeId, nowIso } from "../helpers"
import { getControlPlaneClient } from "../runtime-deps"
import { getTelegramLinkedChatBotContext } from "./community-chat-service"

const TELEGRAM_MESSAGE_LIMIT = 4096
const TELEGRAM_SAFE_MESSAGE_LIMIT = 3900
const TELEGRAM_GROUP_RATE_LIMIT_WINDOW_MS = 60_000
const TELEGRAM_GROUP_USER_RATE_LIMIT = 5
const TELEGRAM_GROUP_CHAT_RATE_LIMIT = 20
const TELEGRAM_GROUP_COMMUNITY_RATE_LIMIT = 60

export type TelegramAssistantTriggerType =
  | "ask_command"
  | "ask_command_mention"
  | "reply_to_bot"

export type TelegramAssistantGroupAnswer = {
  text: string
}

export function telegramText(value: string): string {
  if (value.length <= TELEGRAM_MESSAGE_LIMIT) {
    return value
  }
  return `${value.slice(0, TELEGRAM_SAFE_MESSAGE_LIMIT)}\n\n[Answer truncated. Open Pirate for the full context.]`
}

async function insertTelegramAssistantEvent(input: {
  env: Env
  communityId: string
  telegramChatId: string
  telegramMessageId: number
  telegramUserId: string | null
  triggerType: TelegramAssistantTriggerType
  prompt: string
  now: string
}): Promise<string> {
  const eventId = makeId("tae")
  await getControlPlaneClient(input.env).execute({
    sql: `
      INSERT INTO telegram_assistant_events (
        event_id, community_id, telegram_chat_id, telegram_message_id, telegram_user_id,
        user_id, trigger_type, prompt, assistant_message_ref, status, error_message,
        created_at, completed_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5,
        NULL, ?6, ?7, NULL, 'received', NULL,
        ?8, NULL
      )
    `,
    args: [
      eventId,
      input.communityId,
      input.telegramChatId,
      input.telegramMessageId,
      input.telegramUserId,
      input.triggerType,
      input.prompt,
      input.now,
    ],
  })
  return eventId
}

async function updateTelegramAssistantEvent(input: {
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

async function enforceTelegramGroupAssistantRateLimit(input: {
  env: Env
  eventId: string
  communityId: string
  telegramChatId: string
  telegramUserId: string | null
  now: string
}): Promise<void> {
  const parsedNow = Date.parse(input.now)
  const since = new Date(
    Number.isFinite(parsedNow)
      ? parsedNow - TELEGRAM_GROUP_RATE_LIMIT_WINDOW_MS
      : Date.now() - TELEGRAM_GROUP_RATE_LIMIT_WINDOW_MS,
  ).toISOString()
  const result = await getControlPlaneClient(input.env).execute({
    sql: `
      SELECT
        COALESCE(SUM(CASE WHEN community_id = ?2 THEN 1 ELSE 0 END), 0) AS community_count,
        COALESCE(SUM(CASE WHEN telegram_chat_id = ?3 THEN 1 ELSE 0 END), 0) AS chat_count,
        COALESCE(SUM(CASE WHEN telegram_user_id = ?4 THEN 1 ELSE 0 END), 0) AS user_count
      FROM telegram_assistant_events
      WHERE created_at >= ?5
        AND event_id <> ?1
        AND (
          community_id = ?2
          OR telegram_chat_id = ?3
          OR (?4 IS NOT NULL AND telegram_user_id = ?4)
        )
    `,
    args: [
      input.eventId,
      input.communityId,
      input.telegramChatId,
      input.telegramUserId,
      since,
    ],
  })
  const row = result.rows[0]
  const communityCount = Number(row?.community_count ?? 0)
  const chatCount = Number(row?.chat_count ?? 0)
  const userCount = Number(row?.user_count ?? 0)
  if (input.telegramUserId && userCount >= TELEGRAM_GROUP_USER_RATE_LIMIT) {
    throw rateLimited("Community assistant Telegram user rate limit reached", { scope: "telegram_user" })
  }
  if (chatCount >= TELEGRAM_GROUP_CHAT_RATE_LIMIT) {
    throw rateLimited("Community assistant Telegram chat rate limit reached", { scope: "telegram_chat" })
  }
  if (communityCount >= TELEGRAM_GROUP_COMMUNITY_RATE_LIMIT) {
    throw rateLimited("Community assistant Telegram community rate limit reached", { scope: "community" })
  }
}

function groupFailureMessage(error: unknown): string {
  if (error instanceof HttpError && error.status === 404) {
    return "Community assistant is not enabled. In Pirate, open Mod > Assistant, turn it on, and save settings before using /ask in Telegram."
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

function assistantErrorLogFields(error: unknown): Record<string, unknown> {
  return {
    error: error instanceof Error ? error.message : String(error),
    errorName: error instanceof Error ? error.name : null,
    httpStatus: error instanceof HttpError ? error.status : null,
    httpCode: error instanceof HttpError ? error.code : null,
  }
}

export async function answerTelegramGroupAssistantPrompt(input: {
  env: Env
  communityRepository: CommunityAssistantRepository
  telegramChatId: string
  telegramMessageId: number
  telegramUserId: string | null
  triggerType: TelegramAssistantTriggerType
  prompt: string
}): Promise<TelegramAssistantGroupAnswer | null> {
  const linkedChat = await getTelegramLinkedChatBotContext({
    env: input.env,
    telegramChatId: input.telegramChatId,
  })
  if (!linkedChat) {
    return null
  }

  const now = nowIso()
  const eventId = await insertTelegramAssistantEvent({
    env: input.env,
    communityId: linkedChat.communityId,
    telegramChatId: input.telegramChatId,
    telegramMessageId: input.telegramMessageId,
    telegramUserId: input.telegramUserId,
    triggerType: input.triggerType,
    prompt: input.prompt,
    now,
  })

  try {
    await enforceTelegramGroupAssistantRateLimit({
      env: input.env,
      eventId,
      communityId: linkedChat.communityId,
      telegramChatId: input.telegramChatId,
      telegramUserId: input.telegramUserId,
      now,
    })
    const answer = await sendCommunityAssistantGroupMessage({
      env: input.env,
      communityRepository: input.communityRepository,
      communityId: linkedChat.communityId,
      message: input.prompt,
    })
    await updateTelegramAssistantEvent({
      env: input.env,
      eventId,
      status: "answered",
      assistantMessageRef: answer.provider_message_id,
    })
    return { text: telegramText(answer.content) }
  } catch (error) {
    const status = error instanceof HttpError && error.status === 429 ? "rate_limited" : "failed"
    console.warn("[telegram-assistant] group prompt failed", {
      ...assistantErrorLogFields(error),
      communityId: linkedChat.communityId,
      eventId,
      promptLength: input.prompt.length,
      status,
      telegramChatId: input.telegramChatId,
      telegramMessageId: input.telegramMessageId,
      telegramUserId: input.telegramUserId,
      triggerType: input.triggerType,
    })
    await updateTelegramAssistantEvent({
      env: input.env,
      eventId,
      status,
      errorMessage: error instanceof Error ? error.message : String(error),
    })
    return { text: groupFailureMessage(error) }
  }
}
