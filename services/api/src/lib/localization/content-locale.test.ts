import { describe, expect, test } from "bun:test"
import { detectSourceLanguageFromText } from "./content-locale"

describe("detectSourceLanguageFromText", () => {
  test("defaults ordinary English text to English", () => {
    expect(detectSourceLanguageFromText([
      "The festival guide covers dates, tickets, local context, and transport advice.",
    ])).toBe("en")
  })

  test("does not let one Cyrillic word dominate English text", () => {
    expect(detectSourceLanguageFromText([
      [
        "This is a long English post about a local music festival with practical information.",
        "It includes lineup notes, venue context, ticket details, and a short transport reminder.",
        "The author mentions the Russian word привет once while the surrounding text remains English.",
      ].join(" "),
    ])).toBe("en")
  })

  test("detects dominant Cyrillic text as Russian", () => {
    expect(detectSourceLanguageFromText([
      "Привет, это короткий пост о фестивале и музыке в городе.",
    ])).toBe("ru")
  })

  test("ignores URLs, markdown targets, mentions, and hashtags before Latin word-list detection", () => {
    expect(detectSourceLanguageFromText([
      [
        "Read the event notes at https://example.com/path and https://music.example.com/lineup.",
        "More links: [artist page](https://resident.example.com/profile) and www.example.com.",
        "@promoter #music The actual prose is English and should not become Portuguese from .com URLs.",
      ].join(" "),
    ])).toBe("en")
  })

  test("detects Latin-script languages when signals are dense enough", () => {
    expect(detectSourceLanguageFromText([
      "Olá, você não está só. Obrigado para todos com uma grande comunidade.",
    ])).toBe("pt-BR")
  })

  test("returns null when no letters remain after sanitization", () => {
    expect(detectSourceLanguageFromText([
      "https://example.com @user #tag",
    ])).toBeNull()
  })
})
