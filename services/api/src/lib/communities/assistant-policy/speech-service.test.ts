import { describe, expect, test } from "bun:test"
import {
  isClearSpeechLanguageMismatch,
  normalizeSpeechLanguageCode,
  STUDY_TRANSCRIPTION_LANGUAGE_MISMATCH_MIN_PROBABILITY,
} from "./speech-service"

describe("speech language metadata", () => {
  test("normalizes ISO-639 and locale-shaped source language values", () => {
    expect(normalizeSpeechLanguageCode("en-US")).toBe("en")
    expect(normalizeSpeechLanguageCode("eng")).toBe("en")
    expect(normalizeSpeechLanguageCode("zh_Hans")).toBe("zh")
    expect(normalizeSpeechLanguageCode("source")).toBeNull()
    expect(normalizeSpeechLanguageCode("")).toBeNull()
  })

  test("requires a high-confidence detected language mismatch", () => {
    expect(isClearSpeechLanguageMismatch({
      detectedLanguage: "th",
      expectedLanguage: "en-US",
      probability: STUDY_TRANSCRIPTION_LANGUAGE_MISMATCH_MIN_PROBABILITY,
    })).toBe(true)
    expect(isClearSpeechLanguageMismatch({
      detectedLanguage: "th",
      expectedLanguage: "en",
      probability: 0.79,
    })).toBe(false)
    expect(isClearSpeechLanguageMismatch({
      detectedLanguage: "th",
      expectedLanguage: "en",
      probability: null,
    })).toBe(false)
    expect(isClearSpeechLanguageMismatch({
      detectedLanguage: "eng",
      expectedLanguage: "en",
      probability: 0.99,
    })).toBe(false)
  })
})
