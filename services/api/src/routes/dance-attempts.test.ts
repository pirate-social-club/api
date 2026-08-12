import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Hono } from "hono"

import type { Env } from "../env"
import { signDanceGraderRequest } from "../lib/dance/grader-callback-auth"
import { errorResponse } from "../lib/errors"
import danceAttempts, {
  setDanceAttemptRouteServicesForTests,
} from "./dance-attempts"

const now = Date.parse("2026-07-30T00:00:00.000Z")
const env: Env = {
  DANCE_CAPTURE_ENABLED: "true",
  DANCE_GRADER_CALLBACK_HMAC_KEY: "callback-secret-at-least-32-bytes",
  DANCE_GRADER_CALLBACK_KEY_VERSION: "v1",
}

function stableJson(value: Record<string, unknown>): string {
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${JSON.stringify(value[key])}`
  ).join(",")}}`
}

function app() {
  const value = new Hono<{ Bindings: Env }>()
  value.route("/dance-attempts", danceAttempts)
  value.onError((error, c) => {
    const response = errorResponse(error)
    return c.json(response.body, response.status as 400)
  })
  return value
}

afterEach(() => setDanceAttemptRouteServicesForTests(null))

describe("dance attempt callback", () => {
  test("requires authentication for attempt reads", async () => {
    const response = await app().request(
      "http://test/dance-attempts/dat_1",
      {},
      env,
    )
    expect(response.status).toBe(401)
  })

  test("authenticates exact bytes and forwards parsed terminal facts", async () => {
    const sessionId = "dse_1"
    const unsigned = {
      subject: sessionId,
      outcome: "failed",
      reason: "scoring_unavailable",
      completed_at: Math.floor(now / 1000),
    }
    const body = JSON.stringify({
      ...unsigned,
      result_digest: createHash("sha256").update(stableJson(unsigned)).digest("hex"),
    })
    const calls: unknown[] = []
    setDanceAttemptRouteServicesForTests({
      now: () => now,
      finalizeDanceAttempt: async (input) => {
        calls.push(input)
        return { kind: "finalized", status: "failed" }
      },
    })
    const path = `/dance-attempts/${sessionId}/callback`
    const timestamp = Math.floor(now / 1000)
    const signature = signDanceGraderRequest({
      key: env.DANCE_GRADER_CALLBACK_HMAC_KEY!,
      method: "POST",
      path,
      timestamp,
      subject: sessionId,
      body: new TextEncoder().encode(body),
    })
    const response = await app().request(`http://test${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-dance-grader-key-version": "v1",
        "x-dance-grader-timestamp": String(timestamp),
        "x-dance-grader-signature": signature,
      },
      body,
    }, env)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      id: sessionId,
      status: "failed",
      idempotent: false,
    })
    expect(calls).toHaveLength(1)
  })

  test("rejects a subject/path mismatch before finalization", async () => {
    setDanceAttemptRouteServicesForTests({
      now: () => now,
      finalizeDanceAttempt: async () => {
        throw new Error("must not finalize")
      },
    })
    const response = await app().request(
      "http://test/dance-attempts/dse_1/callback",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subject: "dse_other" }),
      },
      env,
    )
    expect(response.status).toBe(400)
  })
})
