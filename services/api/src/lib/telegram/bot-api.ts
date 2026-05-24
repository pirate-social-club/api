import type { Env } from "../../env"
import { providerUnavailable } from "../errors"

const TELEGRAM_API_TIMEOUT_MS = 5_000

type TelegramApiResponse<T> =
  | { ok: true; result: T }
  | { ok: false; description?: string }

export type TelegramChat = {
  id: number | string
  type: string
  title?: string
  username?: string
}

export type TelegramBotCredential = {
  token: string
  userId?: number | string | null
  username?: string | null
}

export type TelegramBotProfile = {
  id: number
  is_bot: boolean
  first_name: string
  username?: string
}

export type TelegramChatMember = {
  status: string
  can_invite_users?: boolean
}

function isTelegramBotCredential(input: Env | TelegramBotCredential): input is TelegramBotCredential {
  return typeof (input as TelegramBotCredential).token === "string"
}

function telegramBotToken(input: Env | TelegramBotCredential): string {
  const token = (isTelegramBotCredential(input) ? input.token : input.TELEGRAM_BOT_TOKEN)?.trim()
  if (!token) {
    throw providerUnavailable("Telegram bot token is not configured")
  }
  return token
}

export function telegramBotUsername(input: Env | TelegramBotCredential): string | null {
  const username = (isTelegramBotCredential(input) ? input.username : input.TELEGRAM_BOT_USERNAME)?.trim().replace(/^@/, "")
  return username || null
}

export function telegramBotUserId(input: Env | TelegramBotCredential): number {
  const explicitUserId = isTelegramBotCredential(input) ? input.userId : null
  const id = explicitUserId == null ? telegramBotToken(input).split(":", 1)[0] : String(explicitUserId)
  const parsed = Number(id)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw providerUnavailable("Telegram bot token is not configured")
  }
  return parsed
}

async function callTelegramBotApi<T>(
  bot: Env | TelegramBotCredential,
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  const token = telegramBotToken(bot)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TELEGRAM_API_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (error) {
    throw providerUnavailable(error instanceof Error && error.name === "AbortError"
      ? `Telegram ${method} timed out`
      : `Telegram ${method} failed`)
  } finally {
    clearTimeout(timeout)
  }
  const payload = await response.json().catch(() => null) as TelegramApiResponse<T> | null
  if (!response.ok || !payload?.ok) {
    const description = payload && "description" in payload ? payload.description : null
    throw providerUnavailable(description || `Telegram ${method} failed`)
  }
  return payload.result
}

export function sendTelegramMessage(
  bot: Env | TelegramBotCredential,
  body: {
    chat_id: number | string
    message_thread_id?: number
    text: string
    reply_parameters?: {
      message_id: number
    }
    reply_markup?: unknown
  },
): Promise<{ message_id: number }> {
  return callTelegramBotApi(bot, "sendMessage", body)
}

export function getTelegramBotProfile(bot: Env | TelegramBotCredential): Promise<TelegramBotProfile> {
  return callTelegramBotApi<TelegramBotProfile>(bot, "getMe", {})
}

export function getTelegramChatMember(
  bot: Env | TelegramBotCredential,
  chatId: number | string,
  userId: number | string,
): Promise<TelegramChatMember> {
  return callTelegramBotApi<TelegramChatMember>(bot, "getChatMember", {
    chat_id: chatId,
    user_id: userId,
  })
}

export function getTelegramChat(bot: Env | TelegramBotCredential, chatId: number | string): Promise<TelegramChat> {
  return callTelegramBotApi<TelegramChat>(bot, "getChat", { chat_id: chatId })
}

export function approveTelegramChatJoinRequest(
  bot: Env | TelegramBotCredential,
  body: {
    chat_id: number | string
    user_id: number | string
  },
): Promise<boolean> {
  return callTelegramBotApi<boolean>(bot, "approveChatJoinRequest", body)
}

export function setTelegramWebhook(
  bot: Env | TelegramBotCredential,
  body: {
    url: string
    secret_token?: string
    allowed_updates?: string[]
    drop_pending_updates?: boolean
  },
): Promise<boolean> {
  return callTelegramBotApi<boolean>(bot, "setWebhook", body)
}

export function deleteTelegramWebhook(
  bot: Env | TelegramBotCredential,
  body: {
    drop_pending_updates?: boolean
  } = {},
): Promise<boolean> {
  return callTelegramBotApi<boolean>(bot, "deleteWebhook", body)
}
