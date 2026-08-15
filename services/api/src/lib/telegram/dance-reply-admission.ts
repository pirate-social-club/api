import { DANCE_ATTEMPT_MAX_BYTES } from "../dance/attempt-session-repository"
import {
  telegramIdentifier,
  telegramMessageHasForwardingMetadata,
  telegramVideoReplyAttachment,
  type TelegramVideoReplyAttachment,
  type TelegramWebhookMessage,
} from "./webhook-parsing"

export type TelegramDanceReplyRejection =
  | "not_private"
  | "sender_mismatch"
  | "prompt_mismatch"
  | "forwarded"
  | "media_invalid"
  | "media_too_large"

export type TelegramDanceReplyAdmission = {
  attachment: TelegramVideoReplyAttachment
  captureMode: "telegram_video" | "telegram_document"
}

export function admitTelegramDanceReply(input: {
  message: TelegramWebhookMessage
  expectedBotUserId: string
  expectedChatId: string
  expectedPromptMessageId: number
  expectedSenderId: string
}):
  | { ok: true; value: TelegramDanceReplyAdmission }
  | { ok: false; reason: TelegramDanceReplyRejection } {
  const message = input.message
  if (
    message.chat?.type !== "private"
    || telegramIdentifier(message.chat.id) !== input.expectedChatId
  ) {
    return { ok: false, reason: "not_private" }
  }
  if (telegramIdentifier(message.from?.id) !== input.expectedSenderId) {
    return { ok: false, reason: "sender_mismatch" }
  }
  if (
    message.reply_to_message?.message_id !== input.expectedPromptMessageId
    || telegramIdentifier(message.reply_to_message.from?.id) !== input.expectedBotUserId
    || message.reply_to_message.from?.is_bot !== true
  ) {
    return { ok: false, reason: "prompt_mismatch" }
  }
  if (telegramMessageHasForwardingMetadata(message)) {
    return { ok: false, reason: "forwarded" }
  }
  const attachment = telegramVideoReplyAttachment(message)
  if (!attachment) return { ok: false, reason: "media_invalid" }
  if (
    attachment.reportedSizeBytes !== null
    && attachment.reportedSizeBytes > DANCE_ATTEMPT_MAX_BYTES
  ) {
    return { ok: false, reason: "media_too_large" }
  }
  return {
    ok: true,
    value: {
      attachment,
      captureMode: attachment.deliveryMode === "video"
        ? "telegram_video"
        : "telegram_document",
    },
  }
}
