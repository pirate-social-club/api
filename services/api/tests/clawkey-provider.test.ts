import { describe, expect, test } from "bun:test"
import { __testOnly, getClawkeyProvider } from "../src/lib/agents/clawkey-provider"
import { withMockedFetch } from "./helpers"

describe("ClawKey provider URL resolution", () => {
  test("keeps the /v1 prefix when joining register init path", () => {
    const url = __testOnly.resolveClawkeyUrl(
      { CLAWKEY_API_URL: "https://api.ag9.ai/v1" } as any,
      "/agent/register/init",
    )

    expect(url.toString()).toBe("https://api.ag9.ai/v1/agent/register/init")
  })

  test("keeps the /v1 prefix when joining status path", () => {
    const url = __testOnly.resolveClawkeyUrl(
      { CLAWKEY_API_URL: "https://api.ag9.ai/v1" } as any,
      "/agent/register/cks_123/status",
    )

    expect(url.toString()).toBe("https://api.ag9.ai/v1/agent/register/cks_123/status")
  })
})

describe("ClawKey provider requests", () => {
  test("startRegistration posts to the v1 init endpoint", async () => {
    await withMockedFetch(() => (async (input, init) => {
      expect(String(input)).toBe("https://api.ag9.ai/v1/agent/register/init")
      expect(init?.method).toBe("POST")
      return new Response(JSON.stringify({
        sessionId: "cks_123",
        registrationUrl: "https://clawkey.ai/register/cks_123",
      }), {
        status: 201,
        headers: { "content-type": "application/json" },
      })
    }), async () => {
      const provider = getClawkeyProvider({ CLAWKEY_API_URL: "https://api.ag9.ai/v1" } as any)
      const started = await provider.startRegistration({
        deviceId: "dev_123",
        publicKey: "pub_123",
        message: "clawkey-register-1",
        signature: "sig_123",
        timestamp: 1,
      })

      expect(started.sessionId).toBe("cks_123")
      expect(started.registrationUrl).toBe("https://clawkey.ai/register/cks_123")
    })
  })
})
