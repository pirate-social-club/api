import { describe, expect, test } from "bun:test"
import { requestLinkSummary } from "../src/lib/posts/link-enrichment/summary-provider"

describe("requestLinkSummary", () => {
  test("returns validated OpenRouter summary output", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []

    const result = await requestLinkSummary({
      env: {
        OPENROUTER_API_KEY: "or-test",
        OPENROUTER_BASE_URL: "https://openrouter.test/v1",
        OPENROUTER_LINK_SUMMARY_MODEL: "test/summary-model",
      },
      title: "Article title",
      publisher: "Example News",
      publishedAt: "2026-05-02T09:00:00.000Z",
      markdown: "# Article title\n\nThe article body.",
      fetcher: (async (input, init) => {
        calls.push({
          url: String(input),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        })
        return new Response(JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary_paragraph: "A neutral paragraph summary.",
                  short_summary: "A short summary.",
                  key_points: ["First point.", "Second point.", "Third point."],
                }),
              },
            },
          ],
        }), {
          headers: { "content-type": "application/json" },
        })
      }) as typeof fetch,
    })

    expect(calls[0]?.url).toBe("https://openrouter.test/v1/chat/completions")
    expect(calls[0]?.body.model).toBe("test/summary-model")
    const messages = calls[0]?.body.messages as Array<{ content?: string }> | undefined
    expect(messages?.[0]?.content).toContain("3-8 words, 72 characters or less")
    expect(messages?.[0]?.content).toContain("Do not write bullet sentences")
    expect(messages?.[0]?.content).toContain("30 words or fewer")
    expect(messages?.[0]?.content).toContain("not duplicate the full paragraph")
    expect(result.provider).toBe("openrouter")
    expect(result.model).toBe("test/summary-model")
    expect(result.summaryParagraph).toBe("A neutral paragraph summary.")
    expect(result.shortSummary).toBe("A short summary.")
    expect(result.keyPoints).toEqual(["First point.", "Second point.", "Third point."])
  })

  test("rejects malformed key points", async () => {
    await expect(requestLinkSummary({
      env: {
        OPENROUTER_API_KEY: "or-test",
        OPENROUTER_BASE_URL: "https://openrouter.test/v1",
      },
      title: null,
      publisher: null,
      publishedAt: null,
      markdown: "Body",
      fetcher: (async () => new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary_paragraph: "A neutral paragraph summary.",
                short_summary: "A short summary.",
                key_points: ["Only one point."],
              }),
            },
          },
        ],
      }), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
    })).rejects.toThrow("expected exactly three key_points")
  })

  test("rejects overlong key points instead of truncating them", async () => {
    await expect(requestLinkSummary({
      env: {
        OPENROUTER_API_KEY: "or-test",
        OPENROUTER_BASE_URL: "https://openrouter.test/v1",
      },
      title: null,
      publisher: null,
      publishedAt: null,
      markdown: "Body",
      fetcher: (async () => new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary_paragraph: "A neutral paragraph summary.",
                short_summary: "A short summary.",
                key_points: [
                  "A".repeat(73),
                  "Second point.",
                  "Third point.",
                ],
              }),
            },
          },
        ],
      }), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
    })).rejects.toThrow("key_points too long")
  })
})
