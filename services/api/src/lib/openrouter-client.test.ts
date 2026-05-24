import { describe, expect, test } from "bun:test"
import { requestOpenRouterChatCompletion } from "./openrouter-client"

describe("requestOpenRouterChatCompletion", () => {
  test("includes response details when OpenRouter returns invalid JSON", async () => {
    const fetcher: typeof fetch = async () => new Response("<html>timeout</html>", {
      headers: { "content-type": "text/html" },
      status: 200,
    })

    await expect(requestOpenRouterChatCompletion({
      apiKey: "sk-or-test",
      body: { model: "openrouter/free", messages: [] },
      errorLabel: "community assistant",
      fetcher,
    })).rejects.toThrow(
      "OpenRouter community assistant response was not valid JSON (http_200, content-type text/html, body <html>timeout</html>)",
    )
  })
})
