import { describe, expect, test } from "bun:test"
import { inferNamespaceStatusKind } from "./verify.js"

describe("inferNamespaceStatusKind", () => {
  test("treats nv_ ids as verification records", () => {
    expect(inferNamespaceStatusKind("nv_123")).toBe("verification")
  })

  test("defaults other ids to sessions", () => {
    expect(inferNamespaceStatusKind("nvs_123")).toBe("session")
  })
})
