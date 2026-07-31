import type { Env } from "../../env"
import { providerUnavailable } from "../errors"

const TELEGRAM_API_TIMEOUT_MS = 5_000
const TELEGRAM_FILE_TIMEOUT_MS = 30_000

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
  can_post_messages?: boolean
}

export type TelegramFile = {
  file_id: string
  file_unique_id?: string
  file_size?: number
  file_path?: string
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

/**
 * Marks an error as "the request may have reached Telegram".
 *
 * A timeout or network failure is NOT evidence that nothing was sent: the
 * request can be delivered and processed while the response is lost. Treating
 * it as a clean failure is how a retry duplicates a channel post — observed on
 * staging, where two sends timed out, both actually posted, and the retries
 * posted them a second time.
 *
 * A response whose payload says `ok: false` is the opposite: Telegram answered
 * and refused, so no message exists and retrying is safe.
 */
export const TELEGRAM_DISPATCH_UNCERTAIN = "telegram_dispatch_uncertain"

function dispatchUncertain(error: Error): Error {
  ;(error as Error & { [TELEGRAM_DISPATCH_UNCERTAIN]?: true })[TELEGRAM_DISPATCH_UNCERTAIN] = true
  return error
}

/** True when the request may have been received by Telegram despite the error. */
export function isTelegramDispatchUncertain(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && (error as Record<string, unknown>)[TELEGRAM_DISPATCH_UNCERTAIN] === true,
  )
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
    // The request left this Worker; its outcome is unknown. Callers that create
    // side effects on Telegram MUST treat this as uncertain, not as a failure.
    throw dispatchUncertain(providerUnavailable(error instanceof Error && error.name === "AbortError"
      ? `Telegram ${method} timed out`
      : `Telegram ${method} failed`))
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

async function callTelegramBotApiMultipart<T>(
  bot: Env | TelegramBotCredential,
  method: string,
  body: FormData,
): Promise<T> {
  const token = telegramBotToken(bot)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TELEGRAM_API_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      body,
      signal: controller.signal,
    })
  } catch (error) {
    // The request left this Worker; its outcome is unknown. Callers that create
    // side effects on Telegram MUST treat this as uncertain, not as a failure.
    throw dispatchUncertain(providerUnavailable(error instanceof Error && error.name === "AbortError"
      ? `Telegram ${method} timed out`
      : `Telegram ${method} failed`))
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

function encodeTelegramFilePath(filePath: string): string {
  const trimmed = filePath.trim().replace(/^\/+/, "")
  if (!trimmed) {
    throw providerUnavailable("Telegram file path is missing")
  }
  return trimmed.split("/").map(encodeURIComponent).join("/")
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

export function answerTelegramCallbackQuery(
  bot: Env | TelegramBotCredential,
  body: {
    callback_query_id: string
    text?: string
    show_alert?: boolean
  },
): Promise<boolean> {
  return callTelegramBotApi(bot, "answerCallbackQuery", body)
}

type TelegramInlineReplyMarkup = {
  inline_keyboard: Array<Array<Record<string, unknown>>>
}

export function sendTelegramPhoto(
  bot: Env | TelegramBotCredential,
  body: {
    chat_id: number | string
    photo: string
    caption?: string
    reply_markup?: TelegramInlineReplyMarkup
  },
): Promise<{ message_id: number }> {
  return callTelegramBotApi(bot, "sendPhoto", body)
}

export function sendTelegramVideo(
  bot: Env | TelegramBotCredential,
  body: {
    chat_id: number | string
    video: string
    caption?: string
    reply_markup?: TelegramInlineReplyMarkup
  },
): Promise<{ message_id: number }> {
  return callTelegramBotApi(bot, "sendVideo", body)
}

export function editTelegramMessageText(
  bot: Env | TelegramBotCredential,
  body: {
    chat_id: number | string
    message_id: number
    text: string
    reply_markup?: TelegramInlineReplyMarkup
  },
): Promise<{ message_id: number } | true> {
  return callTelegramBotApi(bot, "editMessageText", body)
}

export function editTelegramMessageCaption(
  bot: Env | TelegramBotCredential,
  body: {
    chat_id: number | string
    message_id: number
    caption: string
    reply_markup?: TelegramInlineReplyMarkup
  },
): Promise<{ message_id: number } | true> {
  return callTelegramBotApi(bot, "editMessageCaption", body)
}

/**
 * Delete one or more Telegram messages.
 *
 * `deleteMessages` is preferable to calling `deleteMessage` repeatedly for
 * cleanup: Telegram treats missing message ids as skipped and still returns
 * success. That makes a cleanup retry safe when the first response was lost.
 */
export function deleteTelegramMessages(
  bot: Env | TelegramBotCredential,
  body: {
    chat_id: number | string
    message_ids: number[]
  },
): Promise<true> {
  return callTelegramBotApi(bot, "deleteMessages", body)
}

export function setTelegramChatMenuButton(
  bot: Env | TelegramBotCredential,
  body: {
    chat_id?: number | string
    menu_button: {
      type: "commands" | "default" | "web_app"
      text?: string
      web_app?: {
        url: string
      }
    }
  },
): Promise<boolean> {
  return callTelegramBotApi<boolean>(bot, "setChatMenuButton", body)
}

export function sendTelegramVoice(
  bot: Env | TelegramBotCredential,
  body: {
    chat_id: number | string
    message_thread_id?: number
    voice: File
    caption?: string
    reply_parameters?: {
      message_id: number
    }
  },
): Promise<{ message_id: number }> {
  const form = new FormData()
  form.set("chat_id", String(body.chat_id))
  form.set("voice", body.voice)
  if (typeof body.message_thread_id === "number") {
    form.set("message_thread_id", String(body.message_thread_id))
  }
  if (body.caption?.trim()) {
    form.set("caption", body.caption.trim())
  }
  if (body.reply_parameters) {
    form.set("reply_parameters", JSON.stringify(body.reply_parameters))
  }
  return callTelegramBotApiMultipart(bot, "sendVoice", form)
}

export function getTelegramBotProfile(bot: Env | TelegramBotCredential): Promise<TelegramBotProfile> {
  return callTelegramBotApi<TelegramBotProfile>(bot, "getMe", {})
}

export function getTelegramFile(bot: Env | TelegramBotCredential, fileId: string): Promise<TelegramFile> {
  return callTelegramBotApi<TelegramFile>(bot, "getFile", { file_id: fileId })
}

export async function downloadTelegramFile(
  bot: Env | TelegramBotCredential,
  filePath: string,
  options?: { maximumBytes?: number },
): Promise<{ bytes: ArrayBuffer; contentType: string | null }> {
  const token = telegramBotToken(bot)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TELEGRAM_FILE_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(`https://api.telegram.org/file/bot${token}/${encodeTelegramFilePath(filePath)}`, {
      method: "GET",
      signal: controller.signal,
    })
  } catch (error) {
    throw providerUnavailable(error instanceof Error && error.name === "AbortError"
      ? "Telegram file download timed out"
      : "Telegram file download failed")
  } finally {
    clearTimeout(timeout)
  }
  if (!response.ok) {
    throw providerUnavailable(`Telegram file download failed with http_${response.status}`)
  }
  const maximumBytes = options?.maximumBytes
  if (
    maximumBytes !== undefined
    && (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
  ) {
    throw providerUnavailable("Telegram file download byte limit is invalid")
  }
  const contentLength = response.headers.get("content-length")
  if (
    maximumBytes !== undefined
    && contentLength !== null
    && Number.isSafeInteger(Number(contentLength))
    && Number(contentLength) > maximumBytes
  ) {
    await response.body?.cancel().catch(() => undefined)
    throw providerUnavailable("Telegram file exceeds the download byte limit")
  }
  if (maximumBytes === undefined) {
    return {
      bytes: await response.arrayBuffer(),
      contentType: response.headers.get("content-type"),
    }
  }
  if (!response.body) {
    throw providerUnavailable("Telegram file download response is empty")
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      totalBytes += next.value.byteLength
      if (totalBytes > maximumBytes) {
        await reader.cancel().catch(() => undefined)
        throw providerUnavailable("Telegram file exceeds the download byte limit")
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return {
    bytes: bytes.buffer,
    contentType: response.headers.get("content-type"),
  }
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
