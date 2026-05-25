import { describe, expect, test } from "bun:test"
import { requestOpenRouterChatCompletion } from "./openrouter-client"

describe("requestOpenRouterChatCompletion", () => {
  test("retries transient empty OpenRouter JSON responses", async () => {
    let calls = 0
    const fetcher: typeof fetch = async () => {
      calls += 1
      if (calls === 1) {
        return new Response("", {
          headers: { "content-type": "application/json" },
          status: 200,
        })
      }
      return Response.json({
        choices: [{
          message: { content: "OK" },
        }],
      })
    }

    const result = await requestOpenRouterChatCompletion({
      apiKey: "sk-or-test",
      body: { model: "openrouter/free", messages: [] },
      errorLabel: "community assistant",
      fetcher,
    })

    expect(calls).toBe(2)
    expect(result.content).toBe("OK")
  })

  test("includes response details when OpenRouter returns invalid JSON", async () => {
    let calls = 0
    const fetcher: typeof fetch = async () => new Response("<html>timeout</html>", {
        headers: { "content-type": "text/html" },
        status: 200,
      })

    await expect(requestOpenRouterChatCompletion({
      apiKey: "sk-or-test",
      body: { model: "openrouter/free", messages: [] },
      errorLabel: "community assistant",
      fetcher: async (...args) => {
        calls += 1
        return fetcher(...args)
      },
    })).rejects.toThrow(
      "OpenRouter community assistant response was not valid JSON (http_200, content-type text/html, body <html>timeout</html>)",
    )
    expect(calls).toBe(2)
  })
})
