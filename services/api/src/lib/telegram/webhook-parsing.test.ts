import { describe, expect, test } from "bun:test"
import type { TelegramCommunityBotCredential } from "./community-bot-service"
import {
  parseCommunityJoinPayload,
  parseCommunityStartPayload,
  parseDirectAssistantPrompt,
  parseDirectAssistantVoiceTrigger,
  parseGroupAssistantTrigger,
  parseGroupAssistantVoiceTrigger,
  parseStartToken,
  telegramIdentifier,
  telegramLanguageCode,
} from "./webhook-parsing"

const bot: TelegramCommunityBotCredential = {
  id: "tgbot_test",
  communityId: "cmt_test",
  token: "123456:test-token",
  userId: 123456,
  username: "PirateAssistantBot",
  webhookId: "test-webhook",
  webhookSecret: "test-secret",
}

describe("Telegram webhook primitive parsing", () => {
  test("accepts only safe identifiers and non-empty language codes", () => {
    expect(telegramIdentifier(123456)).toBe("123456")
    expect(telegramIdentifier("  -100123  ")).toBe("-100123")
    expect(telegramIdentifier(Number.MAX_SAFE_INTEGER + 1)).toBeNull()
    expect(telegramIdentifier(1.5)).toBeNull()
    expect(telegramIdentifier("   ")).toBeNull()
    expect(telegramLanguageCode("  en-US ")).toBe("en-US")
    expect(telegramLanguageCode(null)).toBeNull()
  })

  test("separates setup, join, and legacy community start payloads", () => {
    expect(parseStartToken("/start@PirateAssistantBot join_com_cmt_test")).toBe("join_com_cmt_test")
    expect(parseStartToken("/start too many tokens")).toBeNull()
    expect(parseCommunityJoinPayload("join_com_cmt_test")).toBe("cmt_test")
    expect(parseCommunityJoinPayload("com_cmt_test")).toBeNull()
    expect(parseCommunityStartPayload("c_com_cmt_test")).toBe("cmt_test")
    expect(parseCommunityStartPayload("tgsetup_token")).toBeNull()
    expect(parseCommunityStartPayload("join_com_cmt_test")).toBeNull()
    expect(parseCommunityStartPayload("https%3A%2F%2Fexample.com")).toBeNull()
  })
})

describe("Telegram assistant trigger parsing", () => {
  test("accepts commands for this bot and rejects commands for another bot", () => {
    expect(parseGroupAssistantTrigger(bot, {
      chat: { type: "supergroup" },
      text: "/ask@PirateAssistantBot explain this",
    })).toEqual({
      prompt: "explain this",
      triggerType: "ask_command_mention",
    })
    expect(parseGroupAssistantTrigger(bot, {
      chat: { type: "group" },
      text: "/ask@AnotherBot explain this",
    })).toBeNull()
    expect(parseDirectAssistantPrompt(bot, {
      chat: { type: "private" },
      text: "/ask @PirateAssistantBot explain this",
    })).toBe("explain this")
    expect(parseDirectAssistantPrompt(bot, {
      chat: { type: "private" },
      text: "/unknown command",
    })).toBeNull()
  })

  test("requires a reply to this bot for implicit group text and voice", () => {
    const matchingReply = {
      chat: { type: "group" },
      reply_to_message: { from: { id: 123456, is_bot: true } },
    } as const
    expect(parseGroupAssistantTrigger(bot, {
      ...matchingReply,
      text: "what happened?",
    })).toEqual({
      prompt: "what happened?",
      triggerType: "reply_to_bot",
    })
    expect(parseGroupAssistantTrigger(bot, {
      chat: { type: "group" },
      reply_to_message: { from: { id: 999999, is_bot: true } },
      text: "what happened?",
    })).toBeNull()
    expect(parseGroupAssistantVoiceTrigger(bot, {
      ...matchingReply,
      voice: { file_id: " voice-file ", file_size: 42 },
    })).toEqual({
      fileId: "voice-file",
      fileName: "telegram-voice.oga",
      fileSize: 42,
      mimeType: "audio/ogg",
      triggerType: "reply_to_bot",
    })
  })

  test("accepts direct voice only in private chats and infers a useful MIME type", () => {
    expect(parseDirectAssistantVoiceTrigger({
      chat: { type: "private" },
      audio: {
        file_id: "audio-file",
        file_name: "clip.MP3",
        mime_type: "application/octet-stream",
      },
    })).toEqual({
      fileId: "audio-file",
      fileName: "clip.MP3",
      fileSize: null,
      mimeType: "audio/mpeg",
      triggerType: "reply_to_bot",
    })
    expect(parseDirectAssistantVoiceTrigger({
      chat: { type: "group" },
      voice: { file_id: "voice-file" },
    })).toBeNull()
  })
})
