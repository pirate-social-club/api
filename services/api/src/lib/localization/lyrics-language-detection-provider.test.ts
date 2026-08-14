import { describe, expect, test } from "bun:test"
import { mockFetch } from "../../test-helpers/fetch"
import type { Env } from "../../env"
import { requestLyricsLanguageDetection } from "./lyrics-language-detection-provider"

const env = {
  OPENROUTER_API_KEY: "sk-test",
} as Env

function providerResponse(value: unknown): Response {
  return Response.json({ choices: [{ message: { content: JSON.stringify(value) } }] })
}

describe("lyrics language detection provider", () => {
  test("sends lyrics alone and normalizes the returned locale", async () => {
    let requestBody: Record<string, unknown> | null = null
    const result = await requestLyricsLanguageDetection({
      env,
      fetcher: mockFetch(async (_input, init) => {
        requestBody = JSON.parse(String(init?.body ?? "")) as Record<string, unknown>
        return providerResponse({
          lyrics_language: "es-ES",
          lyrics_language_confidence: 0.94,
          lyrics_language_reliable: true,
        })
      }),
      lyrics: "No puedo dejarte ir",
    })

    expect(result.language).toBe("es")
    expect(result.reliable).toBe(true)
    const messages = (requestBody as unknown as Record<string, unknown>).messages as Array<{ role: string; content: string }>
    expect(messages[1]?.content).toBe("No puedo dejarte ir")
    expect(messages).toHaveLength(2)
  })

  test("fails closed when the provider abstains", async () => {
    const result = await requestLyricsLanguageDetection({
      env,
      fetcher: mockFetch(async () => providerResponse({
        lyrics_language: null,
        lyrics_language_confidence: null,
        lyrics_language_reliable: false,
      })),
      lyrics: "♪ ♪ ♪",
    })
    expect(result.language).toBeNull()
    expect(result.reliable).toBe(false)
  })

  test("enforces the server confidence floor even when the provider claims reliability", async () => {
    const result = await requestLyricsLanguageDetection({
      env,
      fetcher: mockFetch(async () => providerResponse({
        lyrics_language: "en",
        lyrics_language_confidence: 0.31,
        lyrics_language_reliable: true,
      })),
      lyrics: "The morning comes back again",
    })
    expect(result.confidence).toBe(0.31)
    expect(result.reliable).toBe(false)
  })

  test("rejects malformed provider fields instead of writing metadata", async () => {
    await expect(requestLyricsLanguageDetection({
      env,
      fetcher: mockFetch(async () => providerResponse({
        lyrics_language: "en",
        lyrics_language_confidence: 2,
        lyrics_language_reliable: true,
      })),
      lyrics: "The morning comes",
    })).rejects.toThrow("invalid confidence")
  })
})
