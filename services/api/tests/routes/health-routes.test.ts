import { describe, expect, test } from "bun:test"
import { app } from "../../src/index"

describe("health route", () => {
  test("GET /health returns ok", async () => {
    const response = await app.request("http://pirate.test/health")

    expect(response.status).toBe(200)
    const body = await response.json() as { ok: boolean }
    expect(body).toEqual({ ok: true })
  })

  test("CORS denies cross-origin access when no origins are configured", async () => {
    const response = await app.request("http://pirate.test/health", {
      headers: { origin: "https://app.pirate.test" },
    })

    expect(response.headers.get("access-control-allow-origin")).toBeNull()
  })

  test("CORS allows public API access when explicitly configured", async () => {
    const response = await app.request("http://pirate.test/health", {
      headers: { origin: "https://app.pirate.test" },
    }, {
      CORS_ALLOWED_ORIGINS: "*",
    })

    expect(response.headers.get("access-control-allow-origin")).toBe("*")
  })

  test("CORS can be scoped to configured origins", async () => {
    const allowed = await app.request("http://pirate.test/health", {
      headers: { origin: "https://app.pirate.test" },
    }, {
      CORS_ALLOWED_ORIGINS: "https://app.pirate.test, https://admin.pirate.test",
    })
    const denied = await app.request("http://pirate.test/health", {
      headers: { origin: "https://evil.test" },
    }, {
      CORS_ALLOWED_ORIGINS: "https://app.pirate.test, https://admin.pirate.test",
    })

    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://app.pirate.test")
    expect(denied.headers.get("access-control-allow-origin")).toBeNull()
  })
})
