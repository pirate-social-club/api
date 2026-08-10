import { describe, expect, test } from "bun:test"
import {
  detectSourceLanguageFromText,
  normalizeLatinTokenCyrillicLookalikes,
  resolveStoredSourceLanguage,
} from "./content-locale"

describe("detectSourceLanguageFromText", () => {
  // Regression: post_pst_66644f58… ("Arkansas Blues") — a plainly English song whose
  // "I've/we've/…" contractions matched the Turkish rule's "ve" token five times, so with
  // no English rule to compete it was labelled source_language="tr" and its Study broke.
  test("English lyrics rich in 've contractions are not mislabelled Turkish", () => {
    const lyrics = [
      "Blues have overtaken me,",
      "I've been so weary, days I've spent in gloom,",
      "We've asked the good Lord to take the train back,",
      "You've got no time to lose, they've gone down south.",
    ].join("\n")
    expect(detectSourceLanguageFromText([lyrics])).toBe("en")
  })

  test("short English text with contractions still resolves to English", () => {
    expect(detectSourceLanguageFromText(["I've been there and you're not."])).toBe("en")
  })

  test("real Turkish text (space-delimited 've') is still detected as Turkish", () => {
    expect(
      detectSourceLanguageFromText(["Merhaba ve teşekkür ederim, bir şey değil, senin için."]),
    ).toBe("tr")
  })

  test("other Latin-script languages are unaffected", () => {
    expect(detectSourceLanguageFromText(["Hola, gracias por una noche con las estrellas."])).toBe("es")
    expect(detectSourceLanguageFromText(["Bonjour, merci pour une belle journée avec des amis."])).toBe("fr")
  })

  test("non-Latin scripts and empty input keep prior behaviour", () => {
    expect(detectSourceLanguageFromText(["مرحبا بك"])).toBe("ar")
    expect(detectSourceLanguageFromText([null, "", undefined])).toBeNull()
  })

  test("Cyrillic lookalikes inside English words do not label the song Russian", () => {
    const lyrics = [
      "Nothing stops me with onе steady roll",
      "There's no slippin' whеn he once takes hold",
      "Say mum's the word, don't let it out",
    ].join("\n")
    expect(detectSourceLanguageFromText([lyrics])).toBe("en")
    expect(normalizeLatinTokenCyrillicLookalikes(lyrics)).toContain("one steady roll")
    expect(normalizeLatinTokenCyrillicLookalikes(lyrics)).toContain("when he once")
  })

  test("real Cyrillic words remain untouched and Russian still detects", () => {
    const lyrics = "English title\nэто настоящая русская строка песни"
    expect(normalizeLatinTokenCyrillicLookalikes(lyrics)).toBe(lyrics)
    expect(detectSourceLanguageFromText([lyrics])).toBe("ru")
  })

  test("one isolated foreign-script character cannot override English lyrics", () => {
    expect(detectSourceLanguageFromText(["The song is for you and this line has я pasted after it"])).toBe("en")
  })

  test("legacy Russian metadata is corrected only with mixed-token lookalike evidence", () => {
    expect(resolveStoredSourceLanguage("ru", ["There's no slippin' whеn he once takes hold"])).toBe("en")
    expect(resolveStoredSourceLanguage("ru", ["это настоящая русская строка"])).toBe("ru")
    expect(resolveStoredSourceLanguage("ru", ["eto transliterirovannaya russkaya stroka"])).toBe("ru")
    expect(resolveStoredSourceLanguage(null, ["This is clearly an English lyric"])).toBeNull()
  })
})
