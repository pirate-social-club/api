import { describe, expect, test } from "bun:test"
import {
  validateCommunityAssistantPolicySettings,
  type CommunityAssistantPolicySettingsInput,
} from "./validation"

function validPolicy(
  overrides: Partial<CommunityAssistantPolicySettingsInput> = {},
): CommunityAssistantPolicySettingsInput {
  return {
    enabled: true,
    displayName: "Harbor Guide",
    shortBio: "Answers questions about this community.",
    systemPrompt: "Follow community rules.",
    defaultPrompt: "Ask about this community.",
    starterPrompts: [
      "What are the community rules?",
      "Summarize the top threads this week.",
    ],
    selectedModelId: "mistralai/mistral-small-3.2-24b-instruct",
    openRouterKeyStatus: {
      connectedAt: "2026-05-22T00:00:00.000Z",
      kind: "connected",
      last4: "9abc",
    },
    elevenLabsKeyStatus: {
      connectedAt: "2026-05-22T00:00:00.000Z",
      kind: "connected",
      last4: "labs",
    },
    contextMode: "live_sql",
    actionMode: "answer_only",
    requireModeratorApprovalForWrites: true,
    retentionDays: 180,
    maxContextThreads: 8,
    maxLookbackDays: 30,
    perUserDailyMessageCap: 40,
    voiceMode: "off",
    sttProvider: "elevenlabs",
    sttModel: "scribe_v2",
    ttsProvider: "elevenlabs",
    ttsVoice: "voice_123",
    ...overrides,
  }
}

function expectValid(input: unknown = validPolicy()): CommunityAssistantPolicySettingsInput {
  const result = validateCommunityAssistantPolicySettings(input)
  if (!result.valid) {
    throw new Error(`Expected policy to be valid: ${result.errors.join("; ")}`)
  }
  return result.data
}

function expectInvalid(input: unknown, messagePart: string): string[] {
  const result = validateCommunityAssistantPolicySettings(input)
  expect(result.valid).toBe(false)
  if (result.valid) {
    throw new Error("Expected policy to be invalid")
  }
  expect(result.errors.some((error) => error.includes(messagePart))).toBe(true)
  return result.errors
}

describe("validateCommunityAssistantPolicySettings", () => {
  test("accepts a complete valid policy", () => {
    expectValid()
  })

  test("rejects a non-object policy", () => {
    expectInvalid(null, "assistant policy settings must be an object")
  })

  test("trims and accepts a display name up to 64 characters", () => {
    const data = expectValid(validPolicy({ displayName: ` ${"a".repeat(64)} ` }))

    expect(data.displayName).toBe("a".repeat(64))
  })

  test("rejects a missing display name", () => {
    expectInvalid({ ...validPolicy(), displayName: "   " }, "displayName is required")
  })

  test("rejects a display name over 64 characters", () => {
    expectInvalid(validPolicy({ displayName: "a".repeat(65) }), "displayName must be at most 64 characters")
  })

  test("accepts a short bio up to 280 characters", () => {
    expectValid(validPolicy({ shortBio: "a".repeat(280) }))
  })

  test("rejects a short bio over 280 characters", () => {
    expectInvalid(validPolicy({ shortBio: "a".repeat(281) }), "shortBio must be at most 280 characters")
  })

  test("accepts a system prompt up to 8000 characters", () => {
    expectValid(validPolicy({ systemPrompt: "a".repeat(8000) }))
  })

  test("rejects a system prompt over 8000 characters", () => {
    expectInvalid(validPolicy({ systemPrompt: "a".repeat(8001) }), "systemPrompt must be at most 8000 characters")
  })

  test("accepts a default prompt up to 1000 characters", () => {
    expectValid(validPolicy({ defaultPrompt: "a".repeat(1000) }))
  })

  test("rejects a default prompt over 1000 characters", () => {
    expectInvalid(validPolicy({ defaultPrompt: "a".repeat(1001) }), "defaultPrompt must be at most 1000 characters")
  })

  test("accepts at most 5 starter prompts with 200 characters each", () => {
    expectValid(validPolicy({
      starterPrompts: [
        "a".repeat(200),
        "b".repeat(200),
        "c".repeat(200),
        "d".repeat(200),
        "e".repeat(200),
      ],
    }))
  })

  test("rejects more than 5 starter prompts", () => {
    expectInvalid(validPolicy({
      starterPrompts: ["one", "two", "three", "four", "five", "six"],
    }), "starterPrompts must contain at most 5 items")
  })

  test("rejects starter prompts over 200 characters", () => {
    expectInvalid(validPolicy({
      starterPrompts: ["a".repeat(201)],
    }), "starterPrompts[0] must be at most 200 characters")
  })

  test("accepts and trims a selected model id", () => {
    const data = expectValid(validPolicy({ selectedModelId: " openrouter/model " }))

    expect(data.selectedModelId).toBe("openrouter/model")
  })

  test("rejects an empty selected model id", () => {
    expectInvalid(validPolicy({ selectedModelId: " " }), "selectedModelId is required")
  })

  test("accepts enabled assistants with a connected key", () => {
    expectValid(validPolicy({ enabled: true, openRouterKeyStatus: { kind: "connected", last4: "abcd" } }))
  })

  test("accepts disabled assistants without a key", () => {
    expectValid(validPolicy({ enabled: false, openRouterKeyStatus: { kind: "missing" } }))
  })

  test("rejects enabled assistants without a connected key", () => {
    expectInvalid(validPolicy({ openRouterKeyStatus: { kind: "missing" } }), "enabled assistant requires a connected OpenRouter key")
  })

  test("rejects enabled assistants with an invalid key", () => {
    expectInvalid(validPolicy({
      openRouterKeyStatus: { kind: "invalid", last4: "9abc", message: "Rejected" },
    }), "enabled assistant requires a connected OpenRouter key")
  })

  test("rejects malformed key status", () => {
    expectInvalid({
      ...validPolicy(),
      openRouterKeyStatus: { kind: "connected", last4: "" },
    }, "openRouterKeyStatus.last4 is required for connected keys")
  })

  test("accepts all context modes", () => {
    expectValid(validPolicy({ contextMode: "live_sql" }))
    expectValid(validPolicy({ contextMode: "summary_cache" }))
    expectValid(validPolicy({ contextMode: "hybrid_vector" }))
  })

  test("rejects invalid context mode", () => {
    expectInvalid({ ...validPolicy(), contextMode: "semantic_only" }, "contextMode must be one of")
  })

  test("accepts all action modes", () => {
    expectValid(validPolicy({ actionMode: "answer_only" }))
    expectValid(validPolicy({ actionMode: "draft_only" }))
    expectValid(validPolicy({ actionMode: "confirmed_writes" }))
  })

  test("rejects invalid action mode", () => {
    expectInvalid({ ...validPolicy(), actionMode: "autonomous_writes" }, "actionMode must be one of")
  })

  test("accepts retention days from 1 to 3650", () => {
    expectValid(validPolicy({ retentionDays: 1 }))
    expectValid(validPolicy({ retentionDays: 3650 }))
  })

  test("rejects retention days outside 1 to 3650", () => {
    expectInvalid(validPolicy({ retentionDays: 0 }), "retentionDays must be an integer from 1 to 3650")
    expectInvalid(validPolicy({ retentionDays: 3651 }), "retentionDays must be an integer from 1 to 3650")
  })

  test("accepts max context threads from 1 to 50", () => {
    expectValid(validPolicy({ maxContextThreads: 1 }))
    expectValid(validPolicy({ maxContextThreads: 50 }))
  })

  test("rejects max context threads outside 1 to 50", () => {
    expectInvalid(validPolicy({ maxContextThreads: 0 }), "maxContextThreads must be an integer from 1 to 50")
    expectInvalid(validPolicy({ maxContextThreads: 51 }), "maxContextThreads must be an integer from 1 to 50")
  })

  test("accepts null or bounded max lookback days", () => {
    expectValid(validPolicy({ maxLookbackDays: null }))
    expectValid(validPolicy({ maxLookbackDays: 1 }))
    expectValid(validPolicy({ maxLookbackDays: 365 }))
  })

  test("rejects max lookback days outside 1 to 365", () => {
    expectInvalid(validPolicy({ maxLookbackDays: 0 }), "maxLookbackDays must be null or an integer from 1 to 365")
    expectInvalid(validPolicy({ maxLookbackDays: 366 }), "maxLookbackDays must be null or an integer from 1 to 365")
  })

  test("accepts null or bounded per-user daily message cap", () => {
    expectValid(validPolicy({ perUserDailyMessageCap: null }))
    expectValid(validPolicy({ perUserDailyMessageCap: 1 }))
    expectValid(validPolicy({ perUserDailyMessageCap: 10000 }))
  })

  test("rejects per-user daily message cap outside 1 to 10000", () => {
    expectInvalid(validPolicy({ perUserDailyMessageCap: 0 }), "perUserDailyMessageCap must be null or an integer from 1 to 10000")
    expectInvalid(validPolicy({ perUserDailyMessageCap: 10001 }), "perUserDailyMessageCap must be null or an integer from 1 to 10000")
  })

  test("requires moderator approval for confirmed writes", () => {
    expectValid(validPolicy({
      actionMode: "confirmed_writes",
      requireModeratorApprovalForWrites: true,
    }))
    expectInvalid(validPolicy({
      actionMode: "confirmed_writes",
      requireModeratorApprovalForWrites: false,
    }), "confirmed writes require moderator approval")
  })

  test("allows draft mode without moderator write approval", () => {
    expectValid(validPolicy({
      actionMode: "draft_only",
      requireModeratorApprovalForWrites: false,
    }))
  })

  test("accepts all voice modes", () => {
    expectValid(validPolicy({ voiceMode: "off" }))
    expectValid(validPolicy({ voiceMode: "transcription_only" }))
    expectValid(validPolicy({ voiceMode: "voice_replies" }))
    expectValid(validPolicy({ voiceMode: "text_and_voice_replies" }))
  })

  test("rejects invalid voice mode", () => {
    expectInvalid({ ...validPolicy(), voiceMode: "phone_call" }, "voiceMode must be one of")
  })

  test("accepts all STT providers", () => {
    expectValid(validPolicy({ sttProvider: "elevenlabs" }))
    expectValid(validPolicy({ sttProvider: "mistral" }))
    expectValid(validPolicy({ sttProvider: "openai" }))
    expectValid(validPolicy({ sttProvider: "none" }))
  })

  test("rejects invalid STT provider", () => {
    expectInvalid({ ...validPolicy(), sttProvider: "deepgram" }, "sttProvider must be one of")
  })

  test("accepts all TTS providers", () => {
    expectValid(validPolicy({ ttsProvider: "elevenlabs" }))
    expectValid(validPolicy({ ttsProvider: "none" }))
  })

  test("rejects invalid TTS provider", () => {
    expectInvalid({ ...validPolicy(), ttsProvider: "google" }, "ttsProvider must be one of")
  })

  test("accepts sttModel up to 128 characters", () => {
    expectValid(validPolicy({ sttModel: "a".repeat(128) }))
  })

  test("rejects sttModel over 128 characters", () => {
    expectInvalid(validPolicy({ sttModel: "a".repeat(129) }), "sttModel must be at most 128 characters")
  })

  test("accepts ttsVoice up to 128 characters", () => {
    expectValid(validPolicy({ ttsVoice: "a".repeat(128) }))
  })

  test("rejects ttsVoice over 128 characters", () => {
    expectInvalid(validPolicy({ ttsVoice: "a".repeat(129) }), "ttsVoice must be at most 128 characters")
  })

  test("requires ElevenLabs STT when voice input is enabled", () => {
    expectInvalid(validPolicy({
      voiceMode: "transcription_only",
      sttProvider: "none",
    }), "enabled voice requires ElevenLabs speech-to-text")
    expectInvalid(validPolicy({
      voiceMode: "transcription_only",
      sttProvider: "mistral",
      sttModel: "voxtral-mini-latest",
    }), "enabled voice requires ElevenLabs speech-to-text")
    expectInvalid(validPolicy({
      voiceMode: "transcription_only",
      sttProvider: "openai",
      sttModel: "whisper-1",
    }), "enabled voice requires ElevenLabs speech-to-text")
  })

  test("requires an ElevenLabs key when voice is enabled", () => {
    expectInvalid(validPolicy({
      elevenLabsKeyStatus: { kind: "missing" },
      voiceMode: "transcription_only",
    }), "enabled voice requires a connected ElevenLabs key")
  })

  test("requires TTS provider and voice for voice replies", () => {
    expectInvalid(validPolicy({
      voiceMode: "voice_replies",
      ttsProvider: "none",
    }), "voice replies require a text-to-speech provider")
    expectInvalid(validPolicy({
      voiceMode: "voice_replies",
      ttsVoice: " ",
    }), "voice replies require a text-to-speech voice")
    expectInvalid(validPolicy({
      voiceMode: "text_and_voice_replies",
      ttsProvider: "none",
    }), "voice replies require a text-to-speech provider")
    expectInvalid(validPolicy({
      voiceMode: "text_and_voice_replies",
      ttsVoice: " ",
    }), "voice replies require a text-to-speech voice")
  })
})
