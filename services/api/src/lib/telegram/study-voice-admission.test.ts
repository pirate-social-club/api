import { describe, expect, test } from "bun:test"
import { isTelegramStudyVoiceEnabled } from "./study-voice-admission"

describe("isTelegramStudyVoiceEnabled", () => {
  test("fails closed unless both the global gate and community allowlist admit the voice loop", () => {
    expect(isTelegramStudyVoiceEnabled({}, "cmt_one")).toBe(false)
    expect(isTelegramStudyVoiceEnabled({
      TELEGRAM_STUDY_VOICE_ENABLED: "true",
    }, "cmt_one")).toBe(false)
    expect(isTelegramStudyVoiceEnabled({
      TELEGRAM_STUDY_VOICE_COMMUNITY_IDS: "cmt_one",
      TELEGRAM_STUDY_VOICE_ENABLED: "false",
    }, "cmt_one")).toBe(false)
    expect(isTelegramStudyVoiceEnabled({
      TELEGRAM_STUDY_VOICE_COMMUNITY_IDS: "cmt_other, cmt_one",
      TELEGRAM_STUDY_VOICE_ENABLED: "true",
    }, "cmt_one")).toBe(true)
  })
})
