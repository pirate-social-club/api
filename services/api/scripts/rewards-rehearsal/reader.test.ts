import { describe, expect, it } from "bun:test"

import { REWARD_VAULT_TRACE_OPTIONS } from "../../src/lib/rewards/reward-vault-revert-evidence"
import {
  ALLOWED_RPC_HOSTS,
  REHEARSAL_REQUIRED_RETENTION_BLOCKS,
  RehearsalRpcReader,
  RehearsalRpcError,
  assertAllowedRpcUrl,
} from "./reader"

const URL_OK = "https://sepolia.base.org/v1?key=SUPERSECRETAPIKEY"
const BLOCK_HASH = `0x${"ab".repeat(32)}`
const PROBE_TX = `0x${"11".repeat(32)}`
const VAULT_PROBE = "0x000000000000000000000000000000000000beef"

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
    const block = await reader.latestConfirmedBlock()
    await reader.getCode("0x000000000000000000000000000000000000beef", block)
    await reader.assertSnapshotIntact()
    expect(reader.readsWereHashPinned).toBe(true)
  })

  it("reports hash-pinned only after reads actually completed", async () => {
    const reader = make(happy())
    // No reads yet: an initial capability assumption is not evidence.
    expect(reader.readsWereHashPinned).toBe(false)
  })
})

/** Fails the first eth_getCode with a chosen shape, then behaves. */
const failingCode = (failure: () => Response | Promise<Response>, calls?: Call[]) => {
  let first = true
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; id: number }
    calls?.push({ body: body as unknown as Record<string, unknown>, init: init ?? {} })
    if (body.method === "eth_getCode" && first) {
      first = false
      return await failure()
    }
    const map: Record<string, unknown> = {
      eth_chainId: "0x14a34",
      eth_getBlockByNumber: { number: "0x10", hash: BLOCK_HASH },
      eth_getCode: "0x6080",
      eth_call: `0x${"0".repeat(64)}`,
      eth_getBalance: "0x1",
      eth_blockNumber: "0x100",
    }
    return new Response(JSON.stringify(ok(body.id, map[body.method])), { status: 200 })
  }) as unknown as typeof fetch
}

const rpcErrorResponse = (code: number) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, error: { code, message: "nope" } }), {
    status: 200,
  })

describe("degradation is narrow", () => {
  const VAULT_ADDR = "0x000000000000000000000000000000000000beef"

  it.each([
    ["HTTP 500", () => new Response("boom", { status: 500 })],
    ["HTTP 429 rate limit", () => new Response("slow down", { status: 429 })],
    ["HTTP 401 auth failure", () => new Response("nope", { status: 401 })],
    ["execution revert (-32000)", () => rpcErrorResponse(-32000)],
    ["execution revert (3)", () => rpcErrorResponse(3)],
    ["malformed JSON", () => new Response("{not json", { status: 200 })],
    ["batch response", () => new Response(JSON.stringify([ok(2, "0x1")]), { status: 200 })],
  ])("never downgrades on %s", async (_label, failure) => {
    const reader = make(failingCode(failure))
    const block = await reader.latestConfirmedBlock()
    await expect(reader.getCode(VAULT_ADDR, block)).rejects.toThrow(RehearsalRpcError)
    // Still believes hash tags work; nothing was silently relaxed.
    expect(reader.readsWereHashPinned).toBe(false)
  })

  it("never downgrades on a transport failure or timeout", async () => {
    const reader = make(
      failingCode(() => {
        throw new Error("socket hang up")
      }),
    )
    const block = await reader.latestConfirmedBlock()
    await expect(reader.getCode(VAULT_ADDR, block)).rejects.toThrow(/failed, timed out/u)
  })

  it.each([-32601, -32602])("downgrades only for capability error %i", async (code) => {
    const calls: Call[] = []
    const reader = make(failingCode(() => rpcErrorResponse(code), calls))
    const block = await reader.latestConfirmedBlock()
    const code_ = await reader.getCode(VAULT_ADDR, block)
    expect(code_).toBe("0x6080")
    expect(reader.readsWereHashPinned).toBe(false)
    const retried = calls.filter((call) => call.body.method === "eth_getCode")
    expect((retried[1]!.body.params as unknown[])[1]).toBe("0x10")
  })

  it("does not fall back to fixed depth on a non-capability finalized failure", async () => {
    const reader = make(
      stubFetch((method, id) => {
        if (method === "eth_getBlockByNumber") {
          return { jsonrpc: "2.0", id, error: { code: -32000, message: "busy" } }
        }
        return ok(id, "0x14a34")
      }),
    )
    await expect(reader.latestConfirmedBlock()).rejects.toThrow(/code -32000/u)
    expect(reader.confirmationPolicy.kind).toBe("finalized-tag")
  })
})

describe("snapshot revalidation checks the captured block", () => {
  const VAULT_ADDR = "0x000000000000000000000000000000000000beef"

  it("passes when the head advances but the captured block stays canonical", async () => {
    const calls: Call[] = []
    let head = 0x10
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; id: number; params: unknown[] }
      calls.push({ body: body as unknown as Record<string, unknown>, init: init ?? {} })
      if (body.method === "eth_getCode" && calls.filter((c) => c.body.method === "eth_getCode").length === 1) {
        return rpcErrorResponse(-32601)
      }
      if (body.method === "eth_getBlockByNumber") {
        // The head advances between calls, but the finalized block captured at
        // the start — and the captured height — keep the same hash.
        head += 5
        return new Response(
          JSON.stringify(ok(body.id, { number: "0x10", hash: BLOCK_HASH })),
          { status: 200 },
        )
      }
      const map: Record<string, unknown> = {
        eth_chainId: "0x14a34",
        eth_getCode: "0x6080",
        eth_blockNumber: `0x${head.toString(16)}`,
      }
      return new Response(JSON.stringify(ok(body.id, map[body.method])), { status: 200 })
    }) as unknown as typeof fetch

    const reader = make(fetchImpl)
    const block = await reader.latestConfirmedBlock()
    await reader.getCode(VAULT_ADDR, block)
    expect(reader.readsWereHashPinned).toBe(false)
    await reader.assertSnapshotIntact()

    // Revalidation asked for the ORIGINAL height, not a fresh confirmed block.
    const blockCalls = calls.filter((call) => call.body.method === "eth_getBlockByNumber")
    expect((blockCalls.at(-1)!.body.params as unknown[])[0]).toBe("0x10")
  })

  it("fails when the captured height now holds a different hash", async () => {
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; id: number; params: unknown[] }
      if (body.method === "eth_getCode" && String(init?.body).includes("blockHash")) {
        return rpcErrorResponse(-32601)
      }
      if (body.method === "eth_getBlockByNumber") {
        const hash = body.params[0] === "finalized" ? BLOCK_HASH : `0x${"cd".repeat(32)}`
        return new Response(JSON.stringify(ok(body.id, { number: "0x10", hash })), { status: 200 })
      }
      const map: Record<string, unknown> = { eth_chainId: "0x14a34", eth_getCode: "0x6080" }
      return new Response(JSON.stringify(ok(body.id, map[body.method])), { status: 200 })
    }) as unknown as typeof fetch

    const reader = make(fetchImpl)
    const block = await reader.latestConfirmedBlock()
    await reader.getCode(VAULT_ADDR, block)
    await expect(reader.assertSnapshotIntact()).rejects.toThrow(/reorganised/u)
  })
})

describe("provider qualification", () => {
  const errorFor = (id: number, code: number) =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message: "nope" } }), {
      status: 200,
    })

  const qualifying = (overrides: Record<string, (id: number) => Response> = {}) =>
    (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; id: number }
      const override = overrides[body.method]
      if (override) return override(body.id)
      const map: Record<string, unknown> = {
        eth_chainId: "0x14a34",
        eth_getBlockByNumber: {
          number: "0x40000",
          hash: BLOCK_HASH,
          transactions: [{ hash: PROBE_TX }],
        },
        eth_getCode: "0x6080",
        debug_traceTransaction: { type: "CALL", from: "0x00000000000000000000000000000000000000ab", to: VAULT_PROBE, output: "0x" },
      }
      return new Response(JSON.stringify(ok(body.id, map[body.method])), { status: 200 })
    }) as unknown as typeof fetch

  it("qualifies an endpoint with every required capability", async () => {
    const q = await make(qualifying()).qualifyProvider(84532)
    expect(q.qualified).toBe(true)
    expect(q.supportsBlockHashTags).toBe(true)
    expect(q.supportsDebugTrace).toBe(true)
    expect(q.historicalBlockReadable).toBe(true)
    expect(q.host).toBe("sepolia.base.org")
    expect(q.probedBlockHash).toBe(BLOCK_HASH)
    expect(q.failures).toEqual([])
  })

  it("REFUSES an endpoint without debug_traceTransaction", async () => {
    // The quiet failure: without this, capacity deferrals silently become
    // reconciliation cases and the fairness measurement measures nothing.
    await expect(
      make(qualifying({ debug_traceTransaction: (id) => errorFor(id, -32601) })).qualifyProvider(
        84532,
      ),
    ).rejects.toThrow(/cannot trace a confirmed transaction/u)
  })

  it("REFUSES a provider that recognizes the method but will not trace", async () => {
    // -32000 also means "tracing disabled on your plan" or "method
    // restricted". Method recognition is not entitlement.
    await expect(
      make(qualifying({ debug_traceTransaction: (id) => errorFor(id, -32000) })).qualifyProvider(
        84532,
      ),
    ).rejects.toThrow(/cannot trace a confirmed transaction/u)
  })

  it("REFUSES a provider that answers with the default opcode tracer", async () => {
    // structLogs/gas/failed is the opcode tracer. A provider can support it
    // while rejecting callTracer, which is the mode production actually uses.
    await expect(
      make(
        qualifying({
          debug_traceTransaction: (id) =>
            new Response(
              JSON.stringify(ok(id, { gas: 21000, failed: false, structLogs: [] })),
              { status: 200 },
            ),
        }),
      ).qualifyProvider(84532),
    ).rejects.toThrow(/callTracer result/u)
  })

  it("sends the exact production trace options", async () => {
    const sent: unknown[] = []
    await make(
      (async (_u: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { method: string; id: number; params: unknown[] }
        if (body.method === "debug_traceTransaction") sent.push(body.params[1])
        const map: Record<string, unknown> = {
          eth_chainId: "0x14a34",
          eth_getBlockByNumber: { number: "0x40000", hash: BLOCK_HASH, transactions: [{ hash: PROBE_TX }] },
          eth_getCode: "0x6080",
          debug_traceTransaction: { type: "CALL", from: "0x00000000000000000000000000000000000000ab" },
        }
        return new Response(JSON.stringify(ok(body.id, map[body.method])), { status: 200 })
      }) as unknown as typeof fetch,
    ).qualifyProvider(84532)
    expect(sent).toEqual([REWARD_VAULT_TRACE_OPTIONS])
  })

  it("REFUSES a provider returning a null trace for a confirmed transaction", async () => {
    await expect(
      make(
        qualifying({
          debug_traceTransaction: (id) =>
            new Response(JSON.stringify({ jsonrpc: "2.0", id, result: null }), { status: 200 }),
        }),
      ).qualifyProvider(84532),
    ).rejects.toThrow(/callTracer result/u)
  })

  it("traces a real confirmed transaction and records which one", async () => {
    const q = await make(qualifying()).qualifyProvider(84532)
    expect(q.tracedTransactionHash).toBe(PROBE_TX)
    expect(q.supportsDebugTrace).toBe(true)
  })

  it("accepts a reviewed probe transaction hash", async () => {
    const reviewed = `0x${"22".repeat(32)}`
    const seen: string[] = []
    const q = await make(
      (async (_u: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { method: string; id: number; params: unknown[] }
        if (body.method === "debug_traceTransaction") seen.push(String(body.params[0]))
        const map: Record<string, unknown> = {
          eth_chainId: "0x14a34",
          eth_getBlockByNumber: { number: "0x40000", hash: BLOCK_HASH, transactions: [{ hash: PROBE_TX }] },
          eth_getCode: "0x6080",
          debug_traceTransaction: { type: "CALL", from: "0x00000000000000000000000000000000000000ab", to: VAULT_PROBE, output: "0x" },
        }
        return new Response(JSON.stringify(ok(body.id, map[body.method])), { status: 200 })
      }) as unknown as typeof fetch,
    ).qualifyProvider(84532, { probeTransactionHash: reviewed })
    expect(seen).toEqual([reviewed])
    expect(q.tracedTransactionHash).toBe(reviewed)
  })

  it("walks back past empty blocks to find a transaction to trace", async () => {
    const heights: string[] = []
    const q = await make(
      (async (_u: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { method: string; id: number; params: unknown[] }
        if (body.method === "eth_getBlockByNumber") {
          const tag = String(body.params[0])
          const full = body.params[1] === true
          if (full) heights.push(tag)
          // The confirmed block and the one below it are empty.
          const empty = full && (tag === "0x40000" || tag === "0x3ffff")
          return new Response(
            JSON.stringify(
              ok(body.id, {
                number: "0x40000",
                hash: BLOCK_HASH,
                transactions: empty ? [] : [{ hash: PROBE_TX }],
              }),
            ),
            { status: 200 },
          )
        }
        const map: Record<string, unknown> = {
          eth_chainId: "0x14a34",
          eth_getCode: "0x6080",
          debug_traceTransaction: { type: "CALL", from: "0x00000000000000000000000000000000000000ab", to: VAULT_PROBE, output: "0x" },
        }
        return new Response(JSON.stringify(ok(body.id, map[body.method])), { status: 200 })
      }) as unknown as typeof fetch,
    ).qualifyProvider(84532)
    expect(heights.slice(0, 3)).toEqual(["0x40000", "0x3ffff", "0x3fffe"])
    expect(q.tracedTransactionHash).toBe(PROBE_TX)
  })

  it("refuses an endpoint without EIP-1898 block-hash tags", async () => {
    await expect(
      make(qualifying({ eth_getCode: (id) => errorFor(id, -32602) })).qualifyProvider(84532),
    ).rejects.toThrow(/EIP-1898/u)
  })

  it("refuses an endpoint on the wrong chain", async () => {
    await expect(
      make(
        qualifying({
          eth_chainId: (id) =>
            new Response(JSON.stringify({ jsonrpc: "2.0", id, result: "0x2105" }), { status: 200 }),
        }),
      ).qualifyProvider(84532),
    ).rejects.toThrow(/chain id is 8453/u)
  })

  it("propagates a transport failure on the EIP-1898 probe", async () => {
    await expect(
      make(
        qualifying({
          eth_getCode: () => {
            throw new Error("socket hang up")
          },
        }),
      ).qualifyProvider(84532),
    ).rejects.toThrow(/failed, timed out/u)
  })

  describe("the trace probe must not read failure as support", () => {
    it("propagates a transport failure", async () => {
      await expect(
        make(
          qualifying({
            debug_traceTransaction: () => {
              throw new Error("socket hang up")
            },
          }),
        ).qualifyProvider(84532),
      ).rejects.toThrow(/failed, timed out/u)
    })

    it("propagates an HTTP failure", async () => {
      await expect(
        make(
          qualifying({ debug_traceTransaction: () => new Response("nope", { status: 502 }) }),
        ).qualifyProvider(84532),
      ).rejects.toThrow(/HTTP 502/u)
    })

    it("propagates a rate limit", async () => {
      await expect(
        make(
          qualifying({ debug_traceTransaction: () => new Response("slow", { status: 429 }) }),
        ).qualifyProvider(84532),
      ).rejects.toThrow(/HTTP 429/u)
    })

    it("propagates malformed JSON", async () => {
      await expect(
        make(
          qualifying({ debug_traceTransaction: () => new Response("{nope", { status: 200 }) }),
        ).qualifyProvider(84532),
      ).rejects.toThrow(/not valid JSON/u)
    })

    it("propagates a mismatched response id", async () => {
      await expect(
        make(
          qualifying({
            debug_traceTransaction: (id) =>
              new Response(JSON.stringify(ok(id + 99, { failed: false })), { status: 200 }),
          }),
        ).qualifyProvider(84532),
      ).rejects.toThrow(/response id did not match/u)
    })
  })

  describe("retention is probed at the required depth", () => {
    it("probes confirmedBlock - rehearsalRequiredRetentionBlocks, not the head", async () => {
      const seen: string[] = []
      const q = await make(
        (async (_u: string | URL | Request, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body)) as { method: string; id: number; params: unknown[] }
          if (body.method === "eth_getBlockByNumber" && body.params[1] === false) {
            seen.push(String(body.params[0]))
          }
          const map: Record<string, unknown> = {
            eth_chainId: "0x14a34",
            eth_getBlockByNumber: {
              number: "0x40000",
              hash: BLOCK_HASH,
              transactions: [{ hash: PROBE_TX }],
            },
            eth_getCode: "0x6080",
            debug_traceTransaction: { type: "CALL", from: "0x00000000000000000000000000000000000000ab", to: VAULT_PROBE, output: "0x" },
          }
          return new Response(JSON.stringify(ok(body.id, map[body.method])), { status: 200 })
        }) as unknown as typeof fetch,
      ).qualifyProvider(84532)

      const expectedDepth = 0x40000 - REHEARSAL_REQUIRED_RETENTION_BLOCKS
      expect(q.testedHistoricalBlock).toBe(expectedDepth)
      expect(q.rehearsalRequiredRetentionBlocks).toBe(REHEARSAL_REQUIRED_RETENTION_BLOCKS)
      expect(seen).toContain(`0x${expectedDepth.toString(16)}`)
    })

    it("refuses a provider that prunes below the required depth", async () => {
      await expect(
        make(
          (async (_u: string | URL | Request, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body)) as {
              method: string
              id: number
              params: unknown[]
            }
            if (body.method === "eth_getBlockByNumber") {
              // The retention probe is the only full=false lookup at a height.
              if (body.params[1] === false && body.params[0] !== "finalized") {
                // Pruned: a valid null result.
                return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: null }), {
                  status: 200,
                })
              }
              return new Response(
                JSON.stringify(
                  ok(body.id, {
                    number: "0x40000",
                    hash: BLOCK_HASH,
                    transactions: [{ hash: PROBE_TX }],
                  }),
                ),
                { status: 200 },
              )
            }
            const map: Record<string, unknown> = {
              eth_chainId: "0x14a34",
              eth_getCode: "0x6080",
              debug_traceTransaction: { type: "CALL", from: "0x00000000000000000000000000000000000000ab", to: VAULT_PROBE, output: "0x" },
            }
            return new Response(JSON.stringify(ok(body.id, map[body.method])), { status: 200 })
          }) as unknown as typeof fetch,
        ).qualifyProvider(84532),
      ).rejects.toThrow(/does not retain block/u)
    })

    it("propagates a transport failure rather than calling it a retention failure", async () => {
      await expect(
        make(
          (async (_u: string | URL | Request, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body)) as {
              method: string
              id: number
              params: unknown[]
            }
            if (body.method === "eth_getBlockByNumber") {
              if (body.params[1] === false && body.params[0] !== "finalized") {
                return new Response("boom", { status: 500 })
              }
              return new Response(
                JSON.stringify(
                  ok(body.id, {
                    number: "0x40000",
                    hash: BLOCK_HASH,
                    transactions: [{ hash: PROBE_TX }],
                  }),
                ),
                { status: 200 },
              )
            }
            const map: Record<string, unknown> = {
              eth_chainId: "0x14a34",
              eth_getCode: "0x6080",
              debug_traceTransaction: { type: "CALL", from: "0x00000000000000000000000000000000000000ab", to: VAULT_PROBE, output: "0x" },
            }
            return new Response(JSON.stringify(ok(body.id, map[body.method])), { status: 200 })
          }) as unknown as typeof fetch,
        ).qualifyProvider(84532),
      ).rejects.toThrow(/HTTP 500/u)
    })
  })

  it("records when the evidence was captured", async () => {
    const q = await make(qualifying()).qualifyProvider(84532, {
      now: () => new Date("2026-07-26T12:00:00.000Z"),
    })
    expect(q.capturedAt).toBe("2026-07-26T12:00:00.000Z")
  })
})
