import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import type { Env } from "../../src/env"
import hnsEdgeAlerts from "../../src/routes/hns-edge-alerts"

function app() {
  const app = new Hono<{ Bindings: Env }>()
  app.route("/internal/hns-edge-alerts", hnsEdgeAlerts)
  return app
}

function request(token = "edge-secret", body: unknown = { text: "deployment drift" }) {
  return new Request("http://example.test/internal/hns-edge-alerts", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })
}

const env = {
  HNS_EDGE_ALERT_TOKEN: "edge-secret",
  ENVIRONMENT: "test",
  OPS_ALERT_WEBHOOK_URL: "https://ops.example/hook",
} as Env

describe("HNS edge alert ingress", () => {
  it("rejects a missing or invalid bearer token", async () => {
    const response = await app().fetch(request("wrong"), env)
    expect(response.status).toBe(401)
  })

  it("validates the alert body", async () => {
    const response = await app().fetch(request("edge-secret", { text: "" }), env)
    expect(response.status).toBe(400)
  })

  it("forwards an authenticated alert through the configured ops sink", async () => {
    const originalFetch = globalThis.fetch
    let forwarded: unknown
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      forwarded = JSON.parse(String(init?.body))
      return new Response(null, { status: 204 })
    }) as typeof fetch
    try {
      const response = await app().fetch(request(), env)
      expect(response.status).toBe(202)
      expect(await response.json()).toEqual({ accepted: true })
      expect(forwarded).toMatchObject({ text: expect.stringContaining("deployment drift") })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("fails closed when no alert sink delivers the message", async () => {
    const response = await app().fetch(request(), {
      ...env,
      OPS_ALERT_WEBHOOK_URL: undefined,
    })
    expect(response.status).toBe(503)
  })
})
