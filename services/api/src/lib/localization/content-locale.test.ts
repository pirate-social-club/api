import { describe, expect, test } from "bun:test"
import { detectSourceLanguageFromText } from "./content-locale"

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
})
