import { describe, expect, it } from "bun:test"

import {
  ALLOWED_RPC_HOSTS,
  RehearsalRpcReader,
  RehearsalRpcError,
  assertAllowedRpcUrl,
} from "./reader"

const URL_OK = "https://sepolia.base.org/v1?key=SUPERSECRETAPIKEY"
const BLOCK_HASH = `0x${"ab".repeat(32)}`

type Call = { body: Record<string, unknown>; init: RequestInit }

const stubFetch = (
  handler: (method: string, id: number) => unknown,
  options: { calls?: Call[]; headers?: Record<string, string> } = {},
) =>
  (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; id: number }
    options.calls?.push({ body: body as unknown as Record<string, unknown>, init: init ?? {} })
    const result = handler(body.method, body.id)
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json", ...options.headers },
    })
  }) as unknown as typeof fetch

const ok = (id: number, result: unknown) => ({ jsonrpc: "2.0", id, result })

const happy = (calls?: Call[]) =>
  stubFetch((method, id) => {
    if (method === "eth_chainId") return ok(id, "0x14a34")
    if (method === "eth_getBlockByNumber") return ok(id, { number: "0x10", hash: BLOCK_HASH })
    if (method === "eth_getCode") return ok(id, "0x6080")
    if (method === "eth_call") return ok(id, `0x${"0".repeat(64)}`)
    if (method === "eth_getBalance") return ok(id, "0x1")
    return ok(id, "0x0")
  }, { calls })

const make = (fetchImpl: typeof fetch) =>
  RehearsalRpcReader.create({ rpcUrl: URL_OK, fetchImpl })

describe("assertAllowedRpcUrl", () => {
  it("accepts a source-controlled host", () => {
    expect(assertAllowedRpcUrl(URL_OK).host).toBe("sepolia.base.org")
  })

  it.each([
    "http://sepolia.base.org",
    "ws://sepolia.base.org",
    "https://evil.example.com",
    "not a url",
  ])("rejects %p", (url) => {
    expect(() => assertAllowedRpcUrl(url)).toThrow(RehearsalRpcError)
  })

  it("never puts the URL or its query in the error", () => {
    try {
      assertAllowedRpcUrl("https://evil.example.com/v1?key=SUPERSECRETAPIKEY")
      throw new Error("should have thrown")
    } catch (error) {
      const message = (error as Error).message
      expect(message).not.toContain("SUPERSECRETAPIKEY")
      expect(message).not.toContain("/v1")
      expect(message).toContain("evil.example.com")
    }
  })

  it("pins hosts in source, not from a caller", () => {
    expect(ALLOWED_RPC_HOSTS).toContain("sepolia.base.org")
  })
})

describe("RehearsalRpcReader transport", () => {
  it("validates the URL before construction", () => {
    expect(() =>
      RehearsalRpcReader.create({ rpcUrl: "https://evil.example.com", fetchImpl: happy() }),
    ).toThrow(RehearsalRpcError)
  })

  it("exposes its validated host for evidence", () => {
    expect(make(happy()).host).toBe("sepolia.base.org")
  })

  it("refuses to follow redirects and bounds the request", async () => {
    const calls: Call[] = []
    await make(happy(calls)).chainId()
    expect(calls[0]!.init.redirect).toBe("error")
    expect(calls[0]!.init.signal).toBeDefined()
  })

  it("uses monotonic request ids", async () => {
    const calls: Call[] = []
    const reader = make(happy(calls))
    await reader.chainId()
    await reader.chainId()
    expect(calls.map((call) => call.body.id)).toEqual([1, 2])
  })

  it("rejects a mismatched response id", async () => {
    await expect(make(stubFetch((_m, id) => ok(id + 99, "0x1"))).chainId()).rejects.toThrow(
      /response id did not match/u,
    )
  })

  it("rejects a bad jsonrpc version", async () => {
    await expect(
      make(stubFetch((_m, id) => ({ jsonrpc: "1.0", id, result: "0x1" }))).chainId(),
    ).rejects.toThrow(/bad jsonrpc version/u)
  })

  it("rejects a batch response", async () => {
    await expect(
      make(stubFetch((_m, id) => [ok(id, "0x1")] as unknown)).chainId(),
    ).rejects.toThrow(/batch response/u)
  })

  it("rejects a JSON-RPC error without echoing its message", async () => {
    await expect(
      make(
        stubFetch((_m, id) => ({
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: "failed for https://sepolia.base.org/v1?key=SUPERSECRETAPIKEY" },
        })),
      ).chainId(),
    ).rejects.toThrow(/code -32000/u)

    try {
      await make(
        stubFetch((_m, id) => ({
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: "key=SUPERSECRETAPIKEY" },
        })),
      ).chainId()
    } catch (error) {
      expect((error as Error).message).not.toContain("SUPERSECRETAPIKEY")
    }
  })

  it("rejects a missing result", async () => {
    await expect(
      make(stubFetch((_m, id) => ({ jsonrpc: "2.0", id }))).chainId(),
    ).rejects.toThrow(/returned no result/u)
  })

  it.each(["0xzz", "1234", "", "0x01x"])("rejects malformed hex quantity %p", async (value) => {
    await expect(make(stubFetch((_m, id) => ok(id, value))).chainId()).rejects.toThrow(
      RehearsalRpcError,
    )
  })

  it("rejects an oversized response by declared content-length", async () => {
    const oversized = stubFetch((_m, id) => ok(id, "0x1"), {
      headers: { "content-length": String(1024 * 1024) },
    })
    await expect(make(oversized).chainId()).rejects.toThrow(/size ceiling/u)
  })

  it("decodes the chain id", async () => {
    expect(await make(happy()).chainId()).toBe(84532)
  })

  it("pins reads by block hash with requireCanonical", async () => {
    const calls: Call[] = []
    const reader = make(happy(calls))
    const block = await reader.latestConfirmedBlock()
    await reader.getCode("0x000000000000000000000000000000000000beef", block)
    const codeCall = calls.find((call) => call.body.method === "eth_getCode")!
    expect((codeCall.body.params as unknown[])[1]).toEqual({
      blockHash: BLOCK_HASH,
      requireCanonical: true,
    })
    expect(reader.readsWereHashPinned).toBe(true)
  })

  it("uses the finalized tag for the confirmed block", async () => {
    const calls: Call[] = []
    await make(happy(calls)).latestConfirmedBlock()
    const blockCall = calls.find((call) => call.body.method === "eth_getBlockByNumber")!
    expect((blockCall.body.params as unknown[])[0]).toBe("finalized")
  })

  it("rejects a malformed block hash", async () => {
    const bad = stubFetch((method, id) =>
      method === "eth_getBlockByNumber" ? ok(id, { number: "0x10", hash: "0xnope" }) : ok(id, "0x1"),
    )
    await expect(make(bad).latestConfirmedBlock()).rejects.toThrow(/malformed block hash/u)
  })

  it("requires a snapshot before it can be asserted intact", async () => {
    await expect(make(happy()).assertSnapshotIntact()).rejects.toThrow(/no snapshot/u)
  })

  it("is a no-op when reads were hash-pinned", async () => {
    const reader = make(happy())
    await reader.latestConfirmedBlock()
    await reader.assertSnapshotIntact()
    expect(reader.readsWereHashPinned).toBe(true)
  })
})
