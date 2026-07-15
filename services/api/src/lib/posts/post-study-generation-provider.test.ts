import { afterEach, describe, expect, spyOn, test } from "bun:test"
import type { Env } from "../../env"
import { requestStudyPackGeneration } from "./post-study-generation-provider"

const nativeFetch = globalThis.fetch
const nativeSetTimeout = globalThis.setTimeout

afterEach(() => {
  globalThis.fetch = nativeFetch
})

describe("requestStudyPackGeneration", () => {
  test("uses a finite timeout when hosted timeout configuration is absent", async () => {
    const scheduledDelays: number[] = []
    const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((...args: Parameters<typeof setTimeout>) => {
      scheduledDelays.push(Number(args[1]))
      return nativeSetTimeout(...args)
    }) as typeof setTimeout)
    globalThis.fetch = (async () => Response.json({
      choices: [{
        message: {
          content: JSON.stringify({
            lines: [{
              distractors: ["Distractor one", "Distractor two", "Distractor three"],
              explanation: "A concise explanation",
              line_id: "line-1",
              source_text: "Hello world",
              translation: "Hola mundo",
            }],
          }),
        },
      }],
    })) as typeof fetch

    try {
      const result = await requestStudyPackGeneration({
        env: { OPENROUTER_API_KEY: "test-key" } as Env,
        lines: [{ lineId: "line-1", text: "Hello world" }],
        sourceLanguage: "en",
        targetLanguage: "es",
      })

      expect(result.lines).toHaveLength(1)
      expect(scheduledDelays).toContain(30_000)
    } finally {
      timeoutSpy.mockRestore()
    }
  })
})
