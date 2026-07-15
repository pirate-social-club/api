import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { notFoundError } from "./errors"
import {
  errorCodeForResponse,
  isAuthenticatedWriteFailure,
  requestCorrelationMiddleware,
  resolveRequestId,
  type RequestCorrelationEnv,
} from "./request-correlation"
import { apiErrorHandler } from "../routes/api-error-handler"

function testApp(): Hono<RequestCorrelationEnv> {
  const app = new Hono<RequestCorrelationEnv>()
  app.use("*", requestCorrelationMiddleware)
  app.get("/ok", (c) => c.json({ ok: true }))
  app.get("/raw", () => Response.json({ ok: true }))
  app.get("/boom", () => {
    throw notFoundError("Missing")
  })
  app.notFound((c) => c.json({ code: "not_found", message: "Not found" }, 404))
  app.onError(apiErrorHandler)
  return app
}

describe("request correlation", () => {
  test("uses cf-ray for success, raw, thrown-error, and not-found responses", async () => {
    const app = testApp()
    for (const path of ["/ok", "/raw", "/boom", "/missing"]) {
      const response = await app.request(path, { headers: { "cf-ray": "ray-123" } })
      expect(response.headers.get("x-request-id"), path).toBe("ray-123")
    }

    const errorBody = await (await app.request("/boom", {
      headers: { "cf-ray": "ray-123" },
    })).json() as { request_id?: string }
    expect(errorBody.request_id).toBe("ray-123")
  })

  test("does not trust a client-supplied x-request-id", async () => {
    const app = testApp()
    const response = await app.request("/ok", {
      headers: { "x-request-id": "client-controlled" },
    })
    expect(response.headers.get("x-request-id")).not.toBe("client-controlled")
    expect(response.headers.get("x-request-id")).toBeTruthy()
  })

  test("uses a UUID when cf-ray is absent", () => {
    const requestId = resolveRequestId(new Request("https://api.example/health"))
    expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  })
})

describe("authenticated write-failure telemetry classification", () => {
  const actor = { userId: "user-1", authType: "user" as const }

  test("includes only authenticated 4xx writes", () => {
    expect(isAuthenticatedWriteFailure({ actor, method: "POST", status: 403 })).toBe(true)
    expect(isAuthenticatedWriteFailure({ actor, method: "DELETE", status: 404 })).toBe(true)
    expect(isAuthenticatedWriteFailure({ actor: undefined, method: "POST", status: 403 })).toBe(false)
    expect(isAuthenticatedWriteFailure({ actor, method: "GET", status: 403 })).toBe(false)
    expect(isAuthenticatedWriteFailure({ actor, method: "POST", status: 500 })).toBe(false)
    expect(isAuthenticatedWriteFailure({ actor, method: "POST", status: 302 })).toBe(false)
  })

  test("extracts bounded JSON error codes and falls back by status", async () => {
    expect(await errorCodeForResponse(Response.json({ code: "eligibility_failed" }, { status: 403 })))
      .toBe("eligibility_failed")
    expect(await errorCodeForResponse(Response.json({ error_code: "pool_exhausted" }, { status: 409 })))
      .toBe("pool_exhausted")
    expect(await errorCodeForResponse(new Response("nope", { status: 429 }))).toBe("http_429")
    expect(await errorCodeForResponse(Response.json({ code: "x".repeat(20_000) }, { status: 400 })))
      .toBe("http_400")
  })
})
