import { afterEach, describe, expect, mock, test } from "bun:test"

import { downloadTelegramFile } from "./bot-api"

const bot = { token: "123:test-token" }
const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("Telegram file download boundary", () => {
  test("rejects a reported oversize response before reading its body", async () => {
    const cancel = mock(() => undefined)
    const body = new ReadableStream<Uint8Array>({ cancel })
    globalThis.fetch = mock(async () => new Response(body, {
      headers: {
        "content-length": "101",
        "content-type": "video/mp4",
      },
    })) as typeof fetch

    await expect(downloadTelegramFile(bot, "videos/attempt.mp4", {
      maximumBytes: 100,
    })).rejects.toThrow("download byte limit")
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  test("enforces the byte ceiling while streaming when content-length is absent", async () => {
    globalThis.fetch = mock(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(60))
        controller.enqueue(new Uint8Array(41))
        controller.close()
      },
    }), {
      headers: { "content-type": "video/mp4" },
    })) as typeof fetch

    await expect(downloadTelegramFile(bot, "videos/attempt.mp4", {
      maximumBytes: 100,
    })).rejects.toThrow("download byte limit")
  })

  test("returns a bounded streamed response", async () => {
    globalThis.fetch = mock(async () => new Response(new Uint8Array([1, 2, 3]), {
      headers: {
        "content-length": "3",
        "content-type": "video/mp4",
      },
    })) as typeof fetch

    const result = await downloadTelegramFile(bot, "videos/attempt.mp4", {
      maximumBytes: 3,
    })
    expect([...new Uint8Array(result.bytes)]).toEqual([1, 2, 3])
    expect(result.contentType).toBe("video/mp4")
  })
})
