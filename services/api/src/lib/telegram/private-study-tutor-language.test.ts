import { describe, expect, test } from "bun:test"
import {
  privateStudyTutorLanguageInstruction,
} from "./private-study-tutor-service"
import {
  STUDY_HELPER_LANGUAGES,
  studyHelperLanguageName,
} from "./study-preference-service"

describe("private study tutor language instructions", () => {
  test("names every supported helper language explicitly", () => {
    const expected = {
      ar: "Arabic",
      en: "English",
      ka: "Georgian",
      ru: "Russian",
      zh: "Simplified Chinese",
    } as const

    for (const language of STUDY_HELPER_LANGUAGES) {
      const instruction = privateStudyTutorLanguageInstruction(language)

      expect(studyHelperLanguageName(language)).toBe(expected[language])
      expect(instruction).toContain(`Reply entirely in ${expected[language]}.`)
      expect(instruction).toContain("keep quoted study text in its original language")
    }
  })
})
