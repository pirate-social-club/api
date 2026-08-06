import { describe, expect, test } from "bun:test"
import { STUDY_HELPER_LANGUAGES } from "./study-preference-service"
import { getTelegramStudyCopy, STUDY_LANGUAGE_BUTTONS } from "./study-copy"

describe("Telegram study language buttons", () => {
  test("offers every supported helper language exactly once", () => {
    const buttonCodes = STUDY_LANGUAGE_BUTTONS.map(({ code }) => code)

    expect(new Set(buttonCodes).size).toBe(buttonCodes.length)
    expect([...buttonCodes].sort()).toEqual([...STUDY_HELPER_LANGUAGES].sort())
  })

  test("all helper languages distinguish deferred retries from an exhausted card", () => {
    for (const language of STUDY_HELPER_LANGUAGES) {
      const copy = getTelegramStudyCopy(language)

      expect(copy.notQuite.length).toBeGreaterThan(0)
      expect(copy.returnsLater.length).toBeGreaterThan(0)
      expect(copy.attemptsRemaining({ count: 2 })).toContain("2")
      expect(copy.attemptsRemaining({ count: 0 })).toContain("0")
      expect(copy.youSaid.length).toBeGreaterThan(0)
      expect(copy.lineWas.length).toBeGreaterThan(0)
      expect(copy.nothingDetected.length).toBeGreaterThan(0)
    }
  })
})
