import { describe, expect, test } from "bun:test"
import { KARAOKE_TRANSPORT_PROTOCOL_VERSION } from "@pirate-social-club/karaoke-runtime"
import type { Env } from "../../src/env"
import {
  issueKaraokeGatewayToken,
  KARAOKE_GATEWAY_TOKEN_VERSION,
} from "../../src/lib/karaoke/gateway-token"
import karaokeSessions from "../../src/routes/karaoke-sessions"

const SECRET = "karaoke-gateway-test-secret-at-least-32-characters"
const NOW_SECONDS = Math.floor(Date.now() / 1000)

async function token(overrides: Partial<Parameters<typeof issueKaraokeGatewayToken>[0]["claims"]> = {}): Promise<string> {
  return await issueKaraokeGatewayToken({
    secret: SECRET,
    claims: {
      attemptId: "attempt-1",
      communityId: "community-1",
      expiresAt: NOW_SECONDS + 60,
      issuedAt: NOW_SECONDS,
      nonce: "nonce-1",
      postId: "post-1",
      protocolVersion: KARAOKE_TRANSPORT_PROTOCOL_VERSION,
      sessionId: "session-1",
      subject: "user-1",
      tokenVersion: KARAOKE_GATEWAY_TOKEN_VERSION,
      ...overrides,
    },
  })
}

describe("karaoke WebSocket gateway", () => {
  test("verifies the capability and forwards only trusted identity headers", async () => {
    let forwarded: Request | null = null
    const env = {
      ENVIRONMENT: "test",
      KARAOKE_GATEWAY_SIGNING_KEY: SECRET,
      PIRATE_WEB_PUBLIC_ORIGIN: "https://web.example",
      KARAOKE_SESSION_RUNTIME: {
        idFromName(name: string) {
          return name
        },
        get() {
          return {
            async fetch(input: RequestInfo | URL, init?: RequestInit) {
              forwarded = new Request(input, init)
              return new Response(null, { status: 204 })
            },
          }
        },
      },
    } as unknown as Env
    const capability = await token()
    const response = await karaokeSessions.request(
      `https://api.example/session-1/websocket?token=${encodeURIComponent(capability)}`,
      {
        headers: {
          "cf-ray": "request-1",
          origin: "https://web.example",
          upgrade: "websocket",
        },
      },
      env,
    )

    expect(response.status).toBe(204)
    expect(forwarded).not.toBeNull()
    const forwardedRequest = forwarded as unknown as Request
    expect(forwardedRequest.url).toBe("https://karaoke-runtime.internal/websocket")
    expect(forwardedRequest.headers.get("x-karaoke-session-id")).toBe("session-1")
    expect(forwardedRequest.headers.get("x-karaoke-attempt-id")).toBe("attempt-1")
    expect(forwardedRequest.headers.get("x-karaoke-subject")).toBe("user-1")
    expect(forwardedRequest.headers.get("x-karaoke-nonce")).toBe("nonce-1")
    expect(forwardedRequest.headers.get("x-karaoke-request-id")).toBe("request-1")
    expect(forwardedRequest.url.includes(capability)).toBe(false)
  })

  test("rejects disallowed origins before touching the Durable Object", async () => {
    let calls = 0
    const env = {
      ENVIRONMENT: "production",
      KARAOKE_GATEWAY_SIGNING_KEY: SECRET,
      PIRATE_WEB_PUBLIC_ORIGIN: "https://web.example",
      KARAOKE_SESSION_RUNTIME: {
        idFromName(name: string) {
          return name
        },
        get() {
          calls += 1
          return { fetch: async () => new Response(null, { status: 204 }) }
        },
      },
    } as unknown as Env
    const response = await karaokeSessions.request(
      `https://api.example/session-1/websocket?token=${encodeURIComponent(await token())}`,
      { headers: { origin: "https://web.example.attacker", upgrade: "websocket" } },
      env,
    )

    expect(response.status).toBe(403)
    expect(calls).toBe(0)
  })

  test("rejects a token bound to another session", async () => {
    const env = {
      ENVIRONMENT: "test",
      KARAOKE_GATEWAY_SIGNING_KEY: SECRET,
      PIRATE_WEB_PUBLIC_ORIGIN: "https://web.example",
      KARAOKE_SESSION_RUNTIME: {},
    } as unknown as Env
    const response = await karaokeSessions.request(
      `https://api.example/session-1/websocket?token=${encodeURIComponent(await token({ sessionId: "session-2" }))}`,
      { headers: { origin: "https://web.example", upgrade: "websocket" } },
      env,
    )

    expect(response.status).toBe(403)
    expect(response.headers.get("x-request-id")).toBeTruthy()
  })

  test("rejects requests missing the WebSocket upgrade header", async () => {
    let calls = 0
    const env = {
      ENVIRONMENT: "test",
      KARAOKE_GATEWAY_SIGNING_KEY: SECRET,
      PIRATE_WEB_PUBLIC_ORIGIN: "https://web.example",
      KARAOKE_SESSION_RUNTIME: {
        idFromName(name: string) { return name },
        get() { calls += 1; return { fetch: async () => new Response(null, { status: 204 }) } },
      },
    } as unknown as Env
    const response = await karaokeSessions.request(
      `https://api.example/session-1/websocket?token=${encodeURIComponent(await token())}`,
      { headers: { origin: "https://web.example" } },
      env,
    )

    expect(response.status).toBe(426)
    expect(response.headers.get("x-request-id")).toBeTruthy()
    expect(calls).toBe(0)
  })

  test("rejects requests with an empty token before consulting the DO", async () => {
    let calls = 0
    const env = {
      ENVIRONMENT: "test",
      KARAOKE_GATEWAY_SIGNING_KEY: SECRET,
      PIRATE_WEB_PUBLIC_ORIGIN: "https://web.example",
      KARAOKE_SESSION_RUNTIME: {
        idFromName(name: string) { return name },
        get() { calls += 1; return { fetch: async () => new Response(null, { status: 204 }) } },
      },
    } as unknown as Env
    const response = await karaokeSessions.request(
      "https://api.example/session-1/websocket?token=",
      { headers: { origin: "https://web.example", upgrade: "websocket" } },
      env,
    )

    expect(response.status).toBe(401)
    expect(calls).toBe(0)
  })

  test("rejects a token signed with a different secret", async () => {
    let calls = 0
    const env = {
      ENVIRONMENT: "test",
      KARAOKE_GATEWAY_SIGNING_KEY: "another-signing-secret-that-is-also-32-chars",
      PIRATE_WEB_PUBLIC_ORIGIN: "https://web.example",
      KARAOKE_SESSION_RUNTIME: {
        idFromName(name: string) { return name },
        get() { calls += 1; return { fetch: async () => new Response(null, { status: 204 }) } },
      },
    } as unknown as Env
    const response = await karaokeSessions.request(
      `https://api.example/session-1/websocket?token=${encodeURIComponent(await token())}`,
      { headers: { origin: "https://web.example", upgrade: "websocket" } },
      env,
    )

    expect(response.status).toBe(401)
    expect(calls).toBe(0)
  })

  test("rejects an expired token with token_expired code", async () => {
    const env = {
      ENVIRONMENT: "test",
      KARAOKE_GATEWAY_SIGNING_KEY: SECRET,
      PIRATE_WEB_PUBLIC_ORIGIN: "https://web.example",
      KARAOKE_SESSION_RUNTIME: {
        idFromName(name: string) { return name },
        get() { return { fetch: async () => new Response(null, { status: 204 }) } },
      },
    } as unknown as Env
    const response = await karaokeSessions.request(
      `https://api.example/session-1/websocket?token=${encodeURIComponent(await token({ expiresAt: NOW_SECONDS - 5, issuedAt: NOW_SECONDS - 65 }))}`,
      { headers: { origin: "https://web.example", upgrade: "websocket" } },
      env,
    )

    expect(response.status).toBe(401)
    const body = await response.json() as { code: string }
    expect(body.code).toBe("karaoke_gateway_token_expired")
  })

  test("rejects a token issued in the future beyond clock skew", async () => {
    const env = {
      ENVIRONMENT: "test",
      KARAOKE_GATEWAY_SIGNING_KEY: SECRET,
      PIRATE_WEB_PUBLIC_ORIGIN: "https://web.example",
      KARAOKE_SESSION_RUNTIME: {
        idFromName(name: string) { return name },
        get() { return { fetch: async () => new Response(null, { status: 204 }) } },
      },
    } as unknown as Env
    const response = await karaokeSessions.request(
      `https://api.example/session-1/websocket?token=${encodeURIComponent(await token({ issuedAt: NOW_SECONDS + 120, expiresAt: NOW_SECONDS + 180 }))}`,
      { headers: { origin: "https://web.example", upgrade: "websocket" } },
      env,
    )

    expect(response.status).toBe(401)
    const body = await response.json() as { code: string }
    expect(body.code).toBe("karaoke_gateway_token_issued_in_future")
  })

  test("rejects a token whose lifetime exceeds the maximum allowed TTL", async () => {
    const env = {
      ENVIRONMENT: "test",
      KARAOKE_GATEWAY_SIGNING_KEY: SECRET,
      PIRATE_WEB_PUBLIC_ORIGIN: "https://web.example",
      KARAOKE_SESSION_RUNTIME: {
        idFromName(name: string) { return name },
        get() { return { fetch: async () => new Response(null, { status: 204 }) } },
      },
    } as unknown as Env
    const response = await karaokeSessions.request(
      `https://api.example/session-1/websocket?token=${encodeURIComponent(await token({ issuedAt: NOW_SECONDS, expiresAt: NOW_SECONDS + 7200 }))}`,
      { headers: { origin: "https://web.example", upgrade: "websocket" } },
      env,
    )

    expect(response.status).toBe(401)
    const body = await response.json() as { code: string }
    expect(body.code).toBe("karaoke_gateway_token_lifetime_exceeded")
  })

  test("rejects a tampered token signature", async () => {
    const env = {
      ENVIRONMENT: "test",
      KARAOKE_GATEWAY_SIGNING_KEY: SECRET,
      PIRATE_WEB_PUBLIC_ORIGIN: "https://web.example",
      KARAOKE_SESSION_RUNTIME: {
        idFromName(name: string) { return name },
        get() { return { fetch: async () => new Response(null, { status: 204 }) } },
      },
    } as unknown as Env
    const good = await token()
    const [header, payload, signature] = good.split(".")
    const tamperedSignature = signature === "AAAA" ? "BBBB" : "AAAA"
    const tampered = `${header}.${payload}.${tamperedSignature}`

    const response = await karaokeSessions.request(
      `https://api.example/session-1/websocket?token=${encodeURIComponent(tampered)}`,
      { headers: { origin: "https://web.example", upgrade: "websocket" } },
      env,
    )

    expect(response.status).toBe(401)
    const body = await response.json() as { code: string }
    expect(body.code).toBe("karaoke_gateway_invalid_token")
  })

  test("rejects a token that names an unsupported protocol version", async () => {
    const env = {
      ENVIRONMENT: "test",
      KARAOKE_GATEWAY_SIGNING_KEY: SECRET,
      PIRATE_WEB_PUBLIC_ORIGIN: "https://web.example",
      KARAOKE_SESSION_RUNTIME: {
        idFromName(name: string) { return name },
        get() { return { fetch: async () => new Response(null, { status: 204 }) } },
      },
    } as unknown as Env
    const response = await karaokeSessions.request(
      `https://api.example/session-1/websocket?token=${encodeURIComponent(await token({ protocolVersion: 99 as typeof KARAOKE_TRANSPORT_PROTOCOL_VERSION }))}`,
      { headers: { origin: "https://web.example", upgrade: "websocket" } },
      env,
    )

    expect(response.status).toBe(401)
    const body = await response.json() as { code: string }
    expect(body.code).toBe("karaoke_gateway_unsupported_protocol_version")
  })

  test("returns 503 when the runtime namespace is not bound", async () => {
    const env = {
      ENVIRONMENT: "production",
      KARAOKE_GATEWAY_SIGNING_KEY: SECRET,
      PIRATE_WEB_PUBLIC_ORIGIN: "https://web.example",
    } as unknown as Env
    const response = await karaokeSessions.request(
      `https://api.example/session-1/websocket?token=${encodeURIComponent(await token())}`,
      { headers: { origin: "https://web.example", upgrade: "websocket" } },
      env,
    )

    expect(response.status).toBe(503)
    const body = await response.json() as { code: string }
    expect(body.code).toBe("karaoke_runtime_unavailable")
  })
})
