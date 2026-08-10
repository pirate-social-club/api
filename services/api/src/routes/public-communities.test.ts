import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { communityPreviewUnavailableResponse } from "./public-communities"

describe("public community preview degradation", () => {
  test("returns a retryable uncacheable 503 instead of a success-shaped preview", async () => {
    const app = new Hono()
    app.get("/preview", (c) => communityPreviewUnavailableResponse(c))

    const response = await app.request("http://pirate.test/preview")

    expect(response.status).toBe(503)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("cdn-cache-control")).toBe("no-store")
    expect(await response.json()).toEqual({
      error: "community_preview_unavailable",
      message: "Community preview is temporarily unavailable",
      retryable: true,
    })
  })
})
