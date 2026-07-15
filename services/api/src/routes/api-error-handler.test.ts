import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { notFoundError } from "../lib/errors"
import { requestCorrelationMiddleware, type RequestCorrelationEnv } from "../lib/request-correlation"
import { apiErrorHandler } from "./api-error-handler"

function appThrowing(error: Error): Hono<RequestCorrelationEnv> {
  const app = new Hono<RequestCorrelationEnv>()
  app.use("*", requestCorrelationMiddleware)
  app.get("/boom", () => {
    throw error
  })
  app.onError(apiErrorHandler)
  return app
}

describe("apiErrorHandler", () => {
  test("sanitizes unknown errors and never echoes the raw message", async () => {
    const app = appThrowing(new Error("connect failed: libsql://shard-42.internal?authToken=secret"))
    const response = await app.request("/boom")
    expect(response.status).toBe(500)
    const body = await response.json() as Record<string, unknown>
    expect(body.code).toBe("internal_error")
    expect(body.message).toBe("Internal server error")
    expect(body.retryable).toBe(true)
    expect(JSON.stringify(body)).not.toContain("shard-42")
  })

  test("uses cf-ray as the request id in body and header", async () => {
    const app = appThrowing(new Error("boom"))
    const response = await app.request("/boom", { headers: { "cf-ray": "8f3a2b1c9d0e4f5a-VIE" } })
    const body = await response.json() as Record<string, unknown>
    expect(body.request_id).toBe("8f3a2b1c9d0e4f5a-VIE")
    expect(response.headers.get("x-request-id")).toBe("8f3a2b1c9d0e4f5a-VIE")
  })

  test("generates a request id when cf-ray is absent", async () => {
    const app = appThrowing(new Error("boom"))
    const response = await app.request("/boom")
    const body = await response.json() as Record<string, unknown>
    expect(typeof body.request_id).toBe("string")
    expect((body.request_id as string).length).toBeGreaterThan(0)
    expect(response.headers.get("x-request-id")).toBe(body.request_id)
  })

  test("preserves typed HttpError responses and adds the request id", async () => {
    const app = appThrowing(notFoundError("Community not found"))
    const response = await app.request("/boom", { headers: { "cf-ray": "ray-123" } })
    expect(response.status).toBe(404)
    const body = await response.json() as Record<string, unknown>
    expect(body.code).toBe("not_found")
    expect(body.message).toBe("Community not found")
    expect(body.request_id).toBe("ray-123")
    expect(response.headers.get("x-request-id")).toBe("ray-123")
  })
})
