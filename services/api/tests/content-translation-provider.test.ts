import { describe, expect, test } from "bun:test"
import { requestContentTranslation } from "../src/lib/localization/content-translation-provider"
import type { Env } from "../src/types"
import { withMockedFetch } from "./helpers"

const env: Env = {
  OPENROUTER_API_KEY: "test-openrouter-key",
}

async function withMockedOpenRouterContent<T>(content: unknown, run: () => Promise<T>): Promise<T> {
  return await withMockedFetch(() => (async () => new Response(JSON.stringify({
    choices: [
      {
        message: {
          content: typeof content === "string" ? content : JSON.stringify(content),
        },
      },
    ],
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch, run)
}

describe("requestContentTranslation", () => {
  test("returns validated translation provider output", async () => {
    await withMockedOpenRouterContent({
      source_language: "ja",
      target_locale: "en",
      outcome: "translated",
      translated_title: "Hello",
      translated_body: "Hello world",
      translated_caption: null,
    }, async () => {
      const result = await requestContentTranslation({
        env,
        sourceLanguage: "ja",
        targetLocale: "en",
        sourceText: {
          title: "こんにちは",
          body: "こんにちは世界",
          caption: null,
        },
      })

      expect(result.outcome).toBe("translated")
      expect(result.sourceLanguage).toBe("ja")
      expect(result.targetLocale).toBe("en")
      expect(result.translatedBody).toBe("Hello world")
    })
  })

  test("rejects responses for a different target locale", async () => {
    await withMockedOpenRouterContent({
      source_language: "ja",
      target_locale: "fr",
      outcome: "translated",
      translated_title: "Bonjour",
      translated_body: "Bonjour le monde",
      translated_caption: null,
    }, async () => {
      await expect(requestContentTranslation({
        env,
        sourceLanguage: "ja",
        targetLocale: "en",
        sourceText: {
          body: "こんにちは世界",
        },
      })).rejects.toThrow("target_locale mismatch")
    })
  })

  test("rejects malformed translated fields", async () => {
    await withMockedOpenRouterContent({
      source_language: "ja",
      target_locale: "en",
      outcome: "translated",
      translated_title: "Hello",
      translated_body: { text: "Hello world" },
      translated_caption: null,
    }, async () => {
      await expect(requestContentTranslation({
        env,
        sourceLanguage: "ja",
        targetLocale: "en",
        sourceText: {
          body: "こんにちは世界",
        },
      })).rejects.toThrow("invalid translated_body")
    })
  })
})
