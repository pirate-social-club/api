import { describe, expect, test } from "bun:test"
import { verifyHnsVerifierRawRecords } from "./verify-hns-verifier-raw-records"

describe("verifyHnsVerifierRawRecords", () => {
  test("uses one authenticated read-only parent observation and accepts raw records", async () => {
    const requests: Request[] = []
    const result = await verifyHnsVerifierRawRecords({
      baseUrl: "https://verifier.test/hns/",
      authToken: "observer-token",
      rootLabel: "repair_fixture",
      fetchImpl: async (input, init) => {
        const request = new Request(input, init)
        requests.push(request)
        return new Response(JSON.stringify({
          root_label: "repair_fixture",
          parent: { raw_records: [{ type: "TXT", txt: ["preserved"] }] },
        }), { headers: { "content-type": "application/json", "x-verifier-commit": "deadbeef" } })
      },
    })

    expect(result).toEqual({
      rootLabel: "repair_fixture",
      rawRecordCount: 1,
      freshness: "unknown",
      chainAnchorAgeSeconds: null,
      verifierCommit: "deadbeef",
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.method).toBe("GET")
    expect(requests[0]?.url).toBe("https://verifier.test/hns/observe-root-parent?root_label=repair_fixture")
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer observer-token")
  })

  test("fails closed when raw_records is absent", async () => {
    await expect(verifyHnsVerifierRawRecords({
      baseUrl: "https://verifier.test/hns",
      authToken: "observer-token",
      rootLabel: "repair_fixture",
      fetchImpl: async () => Response.json({
        root_label: "repair_fixture",
        parent: { nameservers: [] },
      }),
    })).rejects.toThrow("[shape] is missing parent.raw_records array")
  })

  test("fails without accepting a different root", async () => {
    await expect(verifyHnsVerifierRawRecords({
      baseUrl: "https://verifier.test/hns",
      authToken: "observer-token",
      rootLabel: "repair_fixture",
      fetchImpl: async () => Response.json({
        root_label: "healthy_fixture",
        parent: { raw_records: [] },
      }),
    })).rejects.toThrow("[shape] returned a different root")
  })

  test("identifies authentication failures and includes the verifier response", async () => {
    await expect(verifyHnsVerifierRawRecords({
      baseUrl: "https://verifier.test/hns",
      authToken: "observer-token",
      rootLabel: "repair_fixture",
      fetchImpl: async () => new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    })).rejects.toThrow("[auth] failed with HTTP 401: {\"error\":\"Unauthorized\"}")
  })

  test("identifies upstream RPC failures separately from authentication", async () => {
    await expect(verifyHnsVerifierRawRecords({
      baseUrl: "https://verifier.test/hns",
      authToken: "observer-token",
      rootLabel: "repair_fixture",
      fetchImpl: async () => Response.json({ error: "HNS chain RPC quota exhausted" }, { status: 503 }),
    })).rejects.toThrow("[upstream_rpc] failed with HTTP 503: {\"error\":\"HNS chain RPC quota exhausted\"}")
  })

  test("identifies transport failures as upstream RPC failures", async () => {
    await expect(verifyHnsVerifierRawRecords({
      baseUrl: "https://verifier.test/hns",
      authToken: "observer-token",
      rootLabel: "repair_fixture",
      fetchImpl: async () => { throw new Error("connect ECONNREFUSED") },
    })).rejects.toThrow("[upstream_rpc] request failed: connect ECONNREFUSED")
  })

  test("reports stale chain observations without changing the raw-record contract", async () => {
    const result = await verifyHnsVerifierRawRecords({
      baseUrl: "https://verifier.test/hns",
      authToken: "observer-token",
      rootLabel: "repair_fixture",
      nowMs: Date.parse("2026-08-13T12:00:00.000Z"),
      fetchImpl: async () => Response.json({
        root_label: "repair_fixture",
        observed_at: "2026-08-13T12:00:00.000Z",
        chain_anchor: { median_time: Math.floor(Date.parse("2026-08-13T10:00:00.000Z") / 1_000) },
        parent: { raw_records: [] },
      }),
    })

    expect(result.freshness).toBe("stale")
    expect(result.chainAnchorAgeSeconds).toBe(7_200)
  })
})
