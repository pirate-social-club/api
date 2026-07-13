import type { Env } from "../../env"
import { decodePublicCommunityId } from "../public-ids"
import type { TelegramAssistantTriggerType } from "./assistant-service"
import {
  telegramBotUserId,
  telegramBotUsername,
  type TelegramBotCredential,
} from "./bot-api"
import type { TelegramCommunityBotCredential } from "./community-bot-service"

export type TelegramWebhookUpdate = {
  message?: TelegramWebhookMessage
  chat_join_request?: TelegramWebhookChatJoinRequest
}

export type TelegramWebhookMessage = {
  message_id?: number
  message_thread_id?: number
  text?: string
  from?: { id?: number | string; is_bot?: boolean; username?: string; language_code?: string }
  chat?: { id?: number | string; type?: string }
  voice?: TelegramWebhookAudioAttachment
  audio?: TelegramWebhookAudioAttachment
  reply_to_message?: {
    message_id?: number
    from?: { id?: number | string; is_bot?: boolean; username?: string; language_code?: string }
  }
  chat_shared?: {
    request_id?: number
    chat_id?: number | string
    title?: string
    username?: string
  }
}

type TelegramWebhookAudioAttachment = {
  file_id?: string
  file_unique_id?: string
  file_name?: string
  mime_type?: string
  duration?: number
  file_size?: number
}

export type TelegramWebhookChatJoinRequest = {
  chat?: { id?: number | string; type?: string; title?: string; username?: string }
  from?: { id?: number | string; is_bot?: boolean; username?: string; language_code?: string }
  user_chat_id?: number | string
  date?: number
  bio?: string
}

type TelegramGroupAssistantTrigger = {
  prompt: string
  triggerType: TelegramAssistantTriggerType
}

export type TelegramAssistantVoiceTrigger = {
  fileId: string
  fileName: string
  fileSize: number | null
  mimeType: string
  triggerType: TelegramAssistantTriggerType
}

export function telegramIdentifier(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return String(value)
  }
  if (typeof value === "string" && value.trim()) {
    return value.trim()
  }
  return null
}

export function telegramLanguageCode(value: unknown): string | null {
  if (typeof value !== "string") {
    return null
  }
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

export function parseStartToken(text: string | undefined): string | null {
  const match = text?.trim().match(/^\/start(?:@[A-Za-z0-9_]{5,32})?(?:\s+(\S+))?$/u)
  return match?.[1] ?? null
}

export function parseCommunityStartPayload(payload: string | null): string | null {
  const trimmed = payload?.trim()
  if (!trimmed || trimmed.startsWith("tgsetup_") || trimmed.startsWith("join_")) {
    return null
  }
  const encodedCommunityId = trimmed.startsWith("c_")
    ? trimmed.slice(2)
    : trimmed
  if (!encodedCommunityId) {
    return null
  }
  try {
    const decoded = decodeURIComponent(encodedCommunityId)
    if (
      !decoded.startsWith("com_")
      && !decoded.startsWith("cmt_")
      && !decoded.startsWith("@")
    ) {
      return null
    }
    return decodePublicCommunityId(decoded)
  } catch {
    return null
  }
}

export function parseCommunityJoinPayload(payload: string | null): string | null {
  const trimmed = payload?.trim()
  const prefix = "join_"
  if (!trimmed?.startsWith(prefix)) {
    return null
  }
  const encodedCommunityId = trimmed.slice(prefix.length)
  if (!encodedCommunityId) {
    return null
  }
  try {
    return decodePublicCommunityId(decodeURIComponent(encodedCommunityId))
  } catch {
    return null
  }
}

function isTelegramGroupChat(type: string | undefined): boolean {
  return type === "group" || type === "supergroup"
}

function sameTelegramUsername(left: string | null, right: string | undefined): boolean {
  return Boolean(left && right && left.toLowerCase() === right.replace(/^@/, "").toLowerCase())
}

function isReplyToThisBot(bot: Env | TelegramBotCredential, message: TelegramWebhookMessage): boolean {
  const replyFrom = message.reply_to_message?.from
  if (!replyFrom?.is_bot) {
    return false
  }
  const replyFromId = telegramIdentifier(replyFrom.id)
  if (replyFromId) {
    try {
      return replyFromId === String(telegramBotUserId(bot))
    } catch {
      return false
    }
  }
  return sameTelegramUsername(telegramBotUsername(bot), replyFrom.username)
}

export function parseGroupAssistantTrigger(
  bot: Env | TelegramBotCredential,
  message: TelegramWebhookMessage,
): TelegramGroupAssistantTrigger | null {
  if (!isTelegramGroupChat(message.chat?.type)) {
    return null
  }
  const text = message.text?.trim()
  if (!text) {
    return null
  }
  const commandMatch = text.match(/^\/ask(?:@([A-Za-z0-9_]{5,32}))?(?:\s+([\s\S]+))?$/u)
  if (commandMatch) {
    const mentionedUsername = commandMatch[1]
    if (mentionedUsername && !sameTelegramUsername(telegramBotUsername(bot), mentionedUsername)) {
      return null
    }
    let prompt = commandMatch[2]?.trim()
    let triggerType: TelegramAssistantTriggerType = mentionedUsername ? "ask_command_mention" : "ask_command"
    if (!mentionedUsername && prompt) {
      const leadingMention = prompt.match(/^@([A-Za-z0-9_]{5,32})(?:\s+([\s\S]+))?$/u)
      if (leadingMention && sameTelegramUsername(telegramBotUsername(bot), leadingMention[1])) {
        prompt = leadingMention[2]?.trim()
        triggerType = "ask_command_mention"
      }
    }
    if (!prompt) {
      return null
    }
    return {
      prompt,
      triggerType,
    }
  }
  if (!text.startsWith("/") && isReplyToThisBot(bot, message)) {
    return {
      prompt: text,
      triggerType: "reply_to_bot",
    }
  }
  return null
}

function telegramAttachmentFileId(attachment: TelegramWebhookAudioAttachment | undefined): string | null {
  const fileId = attachment?.file_id
  return typeof fileId === "string" && fileId.trim() ? fileId.trim() : null
}

function telegramAttachmentFileSize(attachment: TelegramWebhookAudioAttachment | undefined): number | null {
  const fileSize = attachment?.file_size
  return typeof fileSize === "number" && Number.isFinite(fileSize) && fileSize >= 0 ? fileSize : null
}

export function inferTelegramAudioMimeType(input: {
  explicitMimeType?: string
  fallback: string
  fileName?: string
}): string {
  const explicit = input.explicitMimeType?.trim().toLowerCase()
  if (explicit && explicit !== "application/octet-stream") {
    return explicit
  }
  const name = input.fileName?.trim().toLowerCase() ?? ""
  if (name.endsWith(".oga") || name.endsWith(".ogg") || name.endsWith(".opus")) return "audio/ogg"
  if (name.endsWith(".mp3")) return "audio/mpeg"
  if (name.endsWith(".m4a")) return "audio/x-m4a"
  if (name.endsWith(".wav")) return "audio/wav"
  if (name.endsWith(".webm")) return "audio/webm"
  return input.fallback
}

function parseTelegramAssistantVoiceAttachment(message: TelegramWebhookMessage): TelegramAssistantVoiceTrigger | null {
  const voiceFileId = telegramAttachmentFileId(message.voice)
  if (voiceFileId) {
    return {
      fileId: voiceFileId,
      fileName: "telegram-voice.oga",
      fileSize: telegramAttachmentFileSize(message.voice),
      mimeType: inferTelegramAudioMimeType({
        explicitMimeType: message.voice?.mime_type,
        fallback: "audio/ogg",
        fileName: "telegram-voice.oga",
      }),
      triggerType: "reply_to_bot",
    }
  }
  const audioFileId = telegramAttachmentFileId(message.audio)
  if (!audioFileId) {
    return null
  }
  const fileName = typeof message.audio?.file_name === "string" && message.audio.file_name.trim()
    ? message.audio.file_name.trim()
    : "telegram-audio.bin"
  return {
    fileId: audioFileId,
    fileName,
    fileSize: telegramAttachmentFileSize(message.audio),
    mimeType: inferTelegramAudioMimeType({
      explicitMimeType: message.audio?.mime_type,
      fallback: "application/octet-stream",
      fileName,
    }),
    triggerType: "reply_to_bot",
  }
}

export function parseGroupAssistantVoiceTrigger(
  bot: Env | TelegramBotCredential,
  message: TelegramWebhookMessage,
): TelegramAssistantVoiceTrigger | null {
  if (!isTelegramGroupChat(message.chat?.type) || !isReplyToThisBot(bot, message)) {
    return null
  }
  return parseTelegramAssistantVoiceAttachment(message)
}

export function parseDirectAssistantVoiceTrigger(
  message: TelegramWebhookMessage,
): TelegramAssistantVoiceTrigger | null {
  if (!isPrivateChat(message.chat?.type)) {
    return null
  }
  return parseTelegramAssistantVoiceAttachment(message)
}

export function isPrivateChat(type: string | undefined): boolean {
  return type === "private"
}

export function isCommunityBot(
  bot: Env | TelegramCommunityBotCredential,
): bot is TelegramCommunityBotCredential {
  return "id" in bot
}

export function parseDirectAssistantPrompt(
  bot: TelegramCommunityBotCredential,
  message: TelegramWebhookMessage,
): string | null {
  const text = message.text?.trim()
  if (!text) {
    return null
  }
  const commandMatch = text.match(/^\/ask(?:@([A-Za-z0-9_]{5,32}))?(?:\s+([\s\S]+))?$/u)
  if (commandMatch) {
    const mentionedUsername = commandMatch[1]
    if (mentionedUsername && !sameTelegramUsername(telegramBotUsername(bot), mentionedUsername)) {
      return null
    }
    let prompt = commandMatch[2]?.trim()
    if (!mentionedUsername && prompt) {
      const leadingMention = prompt.match(/^@([A-Za-z0-9_]{5,32})(?:\s+([\s\S]+))?$/u)
      if (leadingMention && sameTelegramUsername(telegramBotUsername(bot), leadingMention[1])) {
        prompt = leadingMention[2]?.trim()
      }
    }
    return prompt || null
  }
  if (text.startsWith("/")) {
    return null
  }
  return text
}
