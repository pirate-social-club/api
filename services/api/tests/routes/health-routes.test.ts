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

  test("CORS allows HNS web origins without explicit configuration", async () => {
    const appHost = await app.request("http://pirate.test/health", {
      headers: { origin: "https://app.pirate" },
    })
    const importedRoot = await app.request("http://pirate.test/health", {
      headers: { origin: "https://xn--pokmon-dva" },
    })
    const profileHost = await app.request("http://pirate.test/health", {
      headers: { origin: "https://blackbeard.pirate" },
    })

    expect(appHost.headers.get("access-control-allow-origin")).toBe("https://app.pirate")
    expect(importedRoot.headers.get("access-control-allow-origin")).toBe("https://xn--pokmon-dva")
    expect(profileHost.headers.get("access-control-allow-origin")).toBe("https://blackbeard.pirate")
  })

  test("CORS does not treat ordinary web origins as HNS origins", async () => {
    const response = await app.request("http://pirate.test/health", {
      headers: { origin: "https://evil.com" },
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

  test("CORS preflight allows binary artifact PUT uploads", async () => {
    const response = await app.request("http://pirate.test/communities/com_test/song-artifact-uploads/sau_test/content", {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "PUT",
        "access-control-request-headers": "content-type,authorization",
      },
    }, {
      CORS_ALLOWED_ORIGINS: "http://localhost:5173",
    })

    expect(response.status).toBe(204)
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5173")
    expect(response.headers.get("access-control-allow-methods")).toContain("PUT")
  })
})
