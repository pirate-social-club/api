import { describe, expect, test } from "bun:test"

import {
  LitChipotleClient,
  LitChipotleError,
  litChipotleRetryableStatus,
} from "./lit-chipotle-client"

const SECRET = "usage-key-must-never-appear"

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function success(result: unknown = { signedTx: "0x1234" }): Response {
  return response(200, { response: result, logs: "potentially sensitive", has_error: false })
}

describe("LitChipotleClient", () => {
  test("invokes the default platform fetch without binding it to the client", async () => {
    const originalFetch = globalThis.fetch
    let observedThis: unknown = "not-called"
    globalThis.fetch = (async function (this: unknown) {
      observedThis = this
      return success()
    }) as typeof fetch

    try {
      const client = new LitChipotleClient({ usageApiKey: SECRET })
      await client.execute({ ipfsId: "QmPinned", jsParams: null })
      expect(observedThis).toBeUndefined()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("sends the usage key only in the header and maps ipfsId to ipfs_id", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = []
    const client = new LitChipotleClient({
      usageApiKey: SECRET,
      fetchImpl: (async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} })
        return success()
      }) as typeof fetch,
    })

    await client.execute({ ipfsId: "QmPinned", jsParams: { operationId: "0xabc" } })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe("https://api.chipotle.litprotocol.com/core/v1/lit_action")
    expect(new Headers(requests[0]?.init.headers).get("X-Api-Key")).toBe(SECRET)
    expect(requests[0]?.init.redirect).toBe("manual")
    const body = String(requests[0]?.init.body)
    expect(body).not.toContain(SECRET)
    expect(JSON.parse(body)).toEqual({
      ipfs_id: "QmPinned",
      js_params: { operationId: "0xabc" },
    })
  })

  test("retries 429, 5xx, and network errors with exponential backoff", async () => {
    const outcomes: Array<Response | Error> = [
      response(429, { error: "busy" }),
      new Error(`network failure containing ${SECRET}`),
      response(503, { error: `upstream containing ${SECRET}` }),
      success("ok"),
    ]
    const delays: number[] = []
    const client = new LitChipotleClient({
      usageApiKey: SECRET,
      maxAttempts: 4,
      retryBaseMs: 10,
      sleep: async (milliseconds) => { delays.push(milliseconds) },
      fetchImpl: (async () => {
        const outcome = outcomes.shift()
        if (outcome instanceof Error) throw outcome
        return outcome!
      }) as typeof fetch,
    })

    expect(await client.execute({ code: "async function main() {}", jsParams: null })).toBe("ok")
    expect(delays).toEqual([10, 20, 40])
  })

  test("reports only a fixed network failure category", async () => {
    const client = new LitChipotleClient({
      usageApiKey: SECRET,
      maxAttempts: 1,
      fetchImpl: (async () => {
        throw new TypeError(`Network connection lost; sensitive=${SECRET}`)
      }) as typeof fetch,
    })

    let thrown: unknown
    try {
      await client.execute({ ipfsId: "QmPinned", jsParams: null })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(LitChipotleError)
    expect((thrown as LitChipotleError).code).toBe("network")
    expect((thrown as LitChipotleError).transportCategory).toBe("connection_lost")
    expect((thrown as Error).message).toBe("Lit action request failed (connection_lost)")
    expect(String(thrown)).not.toContain(SECRET)
  })

  test("classifies a cross-realm workerd failure without copying its message", async () => {
    const client = new LitChipotleClient({
      usageApiKey: SECRET,
      maxAttempts: 1,
      fetchImpl: (async () => {
        throw { message: `Network connection lost; sensitive=${SECRET}` }
      }) as typeof fetch,
    })

    await expect(client.execute({ ipfsId: "QmPinned", jsParams: null }))
      .rejects.toThrow("Lit action request failed (connection_lost)")
    try {
      await client.execute({ ipfsId: "QmPinned", jsParams: null })
    } catch (error) {
      expect(String(error)).not.toContain(SECRET)
    }
  })

  test("classifies 402 as non-retryable without exposing the key or body", async () => {
    let calls = 0
    const client = new LitChipotleClient({
      usageApiKey: SECRET,
      fetchImpl: (async () => {
        calls += 1
        return response(402, { error: `billing body ${SECRET}` })
      }) as typeof fetch,
    })

    let thrown: unknown
    try {
      await client.execute({ ipfsId: "QmPinned", jsParams: null })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(LitChipotleError)
    expect((thrown as LitChipotleError).code).toBe("billing_required")
    expect(String(thrown)).not.toContain(SECRET)
    expect(calls).toBe(1)
  })

  test("does not retry action errors or expose action logs/output", async () => {
    const client = new LitChipotleClient({
      usageApiKey: SECRET,
      fetchImpl: (async () => response(200, {
        response: `signed material ${SECRET}`,
        logs: `IPFS action fetch failed ${SECRET}`,
        has_error: true,
      })) as typeof fetch,
    })

    await expect(client.execute({ ipfsId: "QmPinned", jsParams: null }))
      .rejects.toThrow("Lit action reported an error")
    try {
      await client.execute({ ipfsId: "QmPinned", jsParams: null })
    } catch (error) {
      expect(String(error)).not.toContain(SECRET)
      expect((error as LitChipotleError).litErrorToken).toBe("action_fetch_failed")
    }
  })

  test("maps HTTP authorization failures to a bounded token without reading the body", async () => {
    const client = new LitChipotleClient({
      usageApiKey: SECRET,
      fetchImpl: (async () => response(403, { error: `raw ${SECRET}` })) as typeof fetch,
    })
    try {
      await client.execute({ ipfsId: "QmPinned", jsParams: null })
      throw new Error("expected rejection")
    } catch (error) {
      expect(error).toBeInstanceOf(LitChipotleError)
      expect((error as LitChipotleError).status).toBe(403)
      expect((error as LitChipotleError).litErrorToken).toBe("unauthorized_action")
      expect(String(error)).not.toContain(SECRET)
    }
  })

  test("rejects redirects without following them or exposing Location", async () => {
    let calls = 0
    const client = new LitChipotleClient({
      usageApiKey: SECRET,
      fetchImpl: (async () => {
        calls += 1
        return new Response(null, {
          status: 307,
          headers: { location: `https://redirect.invalid/${SECRET}` },
        })
      }) as typeof fetch,
    })

    let thrown: unknown
    try {
      await client.execute({ ipfsId: "QmPinned", jsParams: null })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(LitChipotleError)
    expect((thrown as LitChipotleError).transportCategory).toBe("redirect")
    expect((thrown as LitChipotleError).status).toBe(307)
    expect(String(thrown)).not.toContain(SECRET)
    expect(calls).toBe(1)
  })

  test("classifies an aborted request as a retryable timeout", async () => {
    const client = new LitChipotleClient({
      usageApiKey: SECRET,
      timeoutMs: 1,
      maxAttempts: 1,
      fetchImpl: ((_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("request aborted", "AbortError"))
        })
      })) as typeof fetch,
    })

    let thrown: unknown
    try {
      await client.execute({ ipfsId: "QmPinned", jsParams: null })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(LitChipotleError)
    expect((thrown as LitChipotleError).code).toBe("timeout")
    expect((thrown as LitChipotleError).retryable).toBe(true)
  })

  test("requires exactly one immutable action source", async () => {
    const client = new LitChipotleClient({
      usageApiKey: SECRET,
      fetchImpl: (async () => success()) as typeof fetch,
    })
    await expect(client.execute({ jsParams: null } as never)).rejects.toThrow("exactly one")
    await expect(client.execute({ code: "x", ipfsId: "QmX", jsParams: null } as never))
      .rejects.toThrow("exactly one")
  })

  test("requires HTTPS before any request", () => {
    expect(() => new LitChipotleClient({
      usageApiKey: SECRET,
      baseUrl: "http://chipotle.invalid",
    })).toThrow("must use HTTPS")
  })
})

describe("litChipotleRetryableStatus", () => {
  test("matches the documented retry surface", () => {
    expect(litChipotleRetryableStatus(429)).toBe(true)
    expect(litChipotleRetryableStatus(500)).toBe(true)
    expect(litChipotleRetryableStatus(503)).toBe(true)
    expect(litChipotleRetryableStatus(402)).toBe(false)
    expect(litChipotleRetryableStatus(400)).toBe(false)
  })
})
