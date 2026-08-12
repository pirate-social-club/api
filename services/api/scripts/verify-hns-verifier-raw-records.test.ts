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
        return Response.json({
          root_label: "repair_fixture",
          parent: { raw_records: [{ type: "TXT", txt: ["preserved"] }] },
        })
      },
    })

    expect(result).toEqual({ rootLabel: "repair_fixture", rawRecordCount: 1 })
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
    })).rejects.toThrow("missing parent.raw_records array")
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
    })).rejects.toThrow("returned a different root")
  })
})
