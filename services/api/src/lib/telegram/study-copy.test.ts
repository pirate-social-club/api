import { describe, expect, test } from "bun:test"
import { STUDY_HELPER_LANGUAGES } from "./study-preference-service"
import { STUDY_LANGUAGE_BUTTONS } from "./study-copy"

describe("Telegram study language buttons", () => {
  test("offers every supported helper language exactly once", () => {
    const buttonCodes = STUDY_LANGUAGE_BUTTONS.map(({ code }) => code)

    expect(new Set(buttonCodes).size).toBe(buttonCodes.length)
    expect([...buttonCodes].sort()).toEqual([...STUDY_HELPER_LANGUAGES].sort())
  })
})
