import { describe, expect, test } from "bun:test"

import { DANCE_ATTEMPT_MAX_BYTES } from "../dance/attempt-session-repository"
import { admitTelegramDanceReply } from "./dance-reply-admission"
import type { TelegramWebhookMessage } from "./webhook-parsing"

function reply(overrides: Partial<TelegramWebhookMessage> = {}): TelegramWebhookMessage {
  return {
    message_id: 102,
    chat: { id: 200, type: "private" },
    from: { id: 300 },
    reply_to_message: {
      message_id: 101,
      from: { id: 400, is_bot: true },
    },
    video: {
      file_id: "file-1",
      file_unique_id: "unique-1",
      mime_type: "video/mp4",
      file_size: 1_024,
      duration: 12,
    },
    ...overrides,
  }
}

function admit(message: TelegramWebhookMessage) {
  return admitTelegramDanceReply({
    message,
    expectedBotUserId: "400",
    expectedChatId: "200",
    expectedPromptMessageId: 101,
    expectedSenderId: "300",
  })
}

describe("Telegram dance reply admission", () => {
  test("admits an exactly bound private video reply", () => {
    expect(admit(reply())).toMatchObject({
      ok: true,
      value: {
        captureMode: "telegram_video",
        attachment: { fileId: "file-1", fileUniqueId: "unique-1" },
      },
    })
  })

  test("derives document capture mode on a video document", () => {
    expect(admit(reply({
      video: undefined,
      document: {
        file_id: "file-2",
        file_unique_id: "unique-2",
        file_name: "dance.mp4",
        mime_type: "video/mp4",
      },
    }))).toMatchObject({ ok: true, value: { captureMode: "telegram_document" } })
  })

  test("rejects chat, sender, prompt, bot, and forwarding mismatches", () => {
    expect(admit(reply({ chat: { id: 200, type: "group" } }))).toEqual({ ok: false, reason: "not_private" })
    expect(admit(reply({ from: { id: 301 } }))).toEqual({ ok: false, reason: "sender_mismatch" })
    expect(admit(reply({ reply_to_message: { message_id: 99, from: { id: 400, is_bot: true } } })))
      .toEqual({ ok: false, reason: "prompt_mismatch" })
    expect(admit(reply({ reply_to_message: { message_id: 101, from: { id: 401, is_bot: true } } })))
      .toEqual({ ok: false, reason: "prompt_mismatch" })
    expect(admit(reply({ forward_date: 1_700_000_000 }))).toEqual({ ok: false, reason: "forwarded" })
  })

  test("rejects invalid and oversized media before download", () => {
    expect(admit(reply({ video: undefined }))).toEqual({ ok: false, reason: "media_invalid" })
    expect(admit(reply({ video: {
      file_id: "large",
      file_unique_id: "large-unique",
      file_size: DANCE_ATTEMPT_MAX_BYTES + 1,
    } }))).toEqual({ ok: false, reason: "media_too_large" })
  })
})
