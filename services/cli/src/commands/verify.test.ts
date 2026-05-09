import { describe, expect, test } from "bun:test"
import { inferNamespaceStatusKind, namespaceFamilyForRootInput } from "./verify.js"

describe("inferNamespaceStatusKind", () => {
  test("treats nv_ ids as verification records", () => {
    expect(inferNamespaceStatusKind("nv_123")).toBe("verification")
  })

  test("defaults other ids to sessions", () => {
    expect(inferNamespaceStatusKind("nvs_123")).toBe("session")
  })
})

describe("namespaceFamilyForRootInput", () => {
  test("uses @ as the Spaces namespace marker", () => {
    expect(namespaceFamilyForRootInput("@human")).toBe("spaces")
    expect(namespaceFamilyForRootInput("human")).toBe("hns")
    expect(namespaceFamilyForRootInput(".human")).toBe("hns")
  })
})
