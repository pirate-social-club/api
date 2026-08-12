import { describe, expect, test } from "bun:test"
import { STUDY_HELPER_LANGUAGES } from "./study-preference-service"
import { getTelegramStudyCopy, STUDY_LANGUAGE_BUTTONS } from "./study-copy"

describe("Telegram study language buttons", () => {
  test("offers every supported helper language exactly once", () => {
    const buttonCodes = STUDY_LANGUAGE_BUTTONS.map(({ code }) => code)

    expect(new Set(buttonCodes).size).toBe(buttonCodes.length)
    expect([...buttonCodes].sort()).toEqual([...STUDY_HELPER_LANGUAGES].sort())
  })

  test("all helper languages provide the complete lesson presentation copy", () => {
    for (const language of STUDY_HELPER_LANGUAGES) {
      const copy = getTelegramStudyCopy(language)

      expect(copy.incorrect.length).toBeGreaterThan(0)
      expect(copy.correct.length).toBeGreaterThan(0)
      expect(copy.youSaid.length).toBeGreaterThan(0)
      expect(copy.questionsRemaining({ count: 4 })).toContain("4")
      expect(copy.reviewMarker.length).toBeGreaterThan(0)
      expect(copy.lessonComplete.length).toBeGreaterThan(0)
      expect(copy.scoreLine({ correct: 8, total: 10 })).toContain("8/10")
      expect(copy.streakLine({ days: 6 })).toContain("6")
      expect(copy.voiceTemporaryFailure.length).toBeGreaterThan(0)
      expect(copy.voiceTerminalChatFailure.length).toBeGreaterThan(0)
      expect(copy.voiceTerminalNonChatFailure.length).toBeGreaterThan(0)
      expect(copy.voiceContinuationFailure.length).toBeGreaterThan(0)
    }
  })
})
