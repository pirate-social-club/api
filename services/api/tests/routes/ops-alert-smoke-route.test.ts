import { describe, expect, test } from "bun:test"
import { app } from "../../src/index"
import type { Env } from "../../src/types"

const ADMIN_TOKEN = "test-admin-token"

function envWithEmail(send: NonNullable<Env["OPS_ALERT_EMAIL"]>["send"]): Env {
  return {
    ENVIRONMENT: "staging",
    PIRATE_ADMIN_TOKEN: ADMIN_TOKEN,
    OPS_ALERT_EMAIL_FROM: "alerts@pirate.sc",
    OPS_ALERT_EMAIL_TO: "piratesocialclub@proton.me",
    OPS_ALERT_EMAIL: { send },
  } as Env
}

describe("POST /__debug/ops-alert", () => {
  test("reports successful alert delivery", async () => {
    const response = await app.request("http://pirate.test/__debug/ops-alert", {
      method: "POST",
      headers: { "x-admin-token": ADMIN_TOKEN },
    }, envWithEmail(async () => ({ messageId: "message-1" })))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })

  test("fails visibly when alert delivery fails", async () => {
    const response = await app.request("http://pirate.test/__debug/ops-alert", {
      method: "POST",
      headers: { "x-admin-token": ADMIN_TOKEN },
    }, envWithEmail(async () => {
      throw new Error("account daily sending quota exceeded")
    }))

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      ok: false,
      error: "ops_alert_delivery_failed",
    })
  })

  test("stays unavailable in production", async () => {
    const response = await app.request("http://pirate.test/__debug/ops-alert", {
      method: "POST",
    }, { ENVIRONMENT: "production" } as Env)

    expect(response.status).toBe(404)
  })

  test("rejects unauthenticated staging callers without sending an alert", async () => {
    let sends = 0
    const response = await app.request("http://pirate.test/__debug/ops-alert", {
      method: "POST",
    }, envWithEmail(async () => {
      sends += 1
      return { messageId: "message-unexpected" }
    }))

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: "unauthorized" })
    expect(sends).toBe(0)
  })
})
