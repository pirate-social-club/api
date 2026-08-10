import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

import type { Env } from "../env"
import { errorResponse } from "../lib/errors"
import danceSessions from "./dance-sessions"

const env: Env = { DANCE_CAPTURE_ENABLED: "true" }

function app() {
  const value = new Hono<{ Bindings: Env }>()
  value.route("/dance-sessions", danceSessions)
  value.onError((error, c) => {
    const response = errorResponse(error)
    return c.json(response.body, response.status as 400)
  })
  return value
}

describe("dance session routes", () => {
  test("requires authentication for session reads", async () => {
    const response = await app().request(
      "http://test/dance-sessions/dse_1",
      {},
      env,
    )
    expect(response.status).toBe(401)
  })

  test("requires authentication for cancellation", async () => {
    const response = await app().request(
      "http://test/dance-sessions/dse_1/cancel",
      { method: "POST" },
      env,
    )
    expect(response.status).toBe(401)
  })
})
