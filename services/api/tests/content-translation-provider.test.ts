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
  })) as unknown as typeof fetch, run)
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

  test("uses an adaptive completion budget for long source text", async () => {
    let requestPayload: Record<string, unknown> | null = null
    await withMockedFetch(() => (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestPayload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                source_language: "ja",
                target_locale: "en",
                outcome: "translated",
                translated_title: null,
                translated_body: "Hello world",
                translated_caption: null,
              }),
            },
          },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }), async () => {
      await requestContentTranslation({
        env,
        sourceLanguage: "ja",
        targetLocale: "en",
        sourceText: {
          body: "こんにちは世界".repeat(300),
        },
      })

      expect(requestPayload?.max_completion_tokens).toBeGreaterThan(1024)
    })
  })

  test("rejects malformed provider JSON with a stable error", async () => {
    await withMockedOpenRouterContent("{\n  \"", async () => {
      await expect(requestContentTranslation({
        env,
        sourceLanguage: "ja",
        targetLocale: "en",
        sourceText: {
          body: "こんにちは世界",
        },
      })).rejects.toThrow("OpenRouter translation response was malformed JSON")
    })
  })

  test("retries malformed provider JSON once with the max completion budget", async () => {
    const maxCompletionTokens: unknown[] = []
    await withMockedFetch(() => (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
      maxCompletionTokens.push(payload.max_completion_tokens)
      const content = maxCompletionTokens.length === 1
        ? "{\n  \"translated_body\": \"truncated"
        : JSON.stringify({
          source_language: "ja",
          target_locale: "en",
          outcome: "translated",
          translated_title: null,
          translated_body: "Hello world",
          translated_caption: null,
        })
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content,
            },
          },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }), async () => {
      const result = await requestContentTranslation({
        env,
        sourceLanguage: "ja",
        targetLocale: "en",
        sourceText: {
          body: "こんにちは世界",
        },
      })

      expect(result.translatedBody).toBe("Hello world")
      expect(maxCompletionTokens).toEqual([1024, 4096])
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
