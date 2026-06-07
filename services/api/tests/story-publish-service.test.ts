import { describe, expect, test } from "bun:test"
import { classifyExistingEntitlementClassForPublish } from "../src/lib/story/story-publish-service"

const assetVersionId = "0x1111111111111111111111111111111111111111111111111111111111111111" as const

describe("classifyExistingEntitlementClassForPublish", () => {
  test("treats an empty inactive class as missing", () => {
    expect(classifyExistingEntitlementClassForPublish({
      existingAssetVersionId: "0x0000000000000000000000000000000000000000000000000000000000000000",
      existingCdrVaultUuid: 0,
      existingActive: false,
      assetVersionId,
      cdrVaultUuid: 6737,
    })).toBe("missing")
  })

  test("treats an active matching class as already configured", () => {
    expect(classifyExistingEntitlementClassForPublish({
      existingAssetVersionId: assetVersionId.toUpperCase(),
      existingCdrVaultUuid: 6737n,
      existingActive: true,
      assetVersionId,
      cdrVaultUuid: 6737,
    })).toBe("matching")
  })

  test("rejects an active class with different parameters", () => {
    expect(() => classifyExistingEntitlementClassForPublish({
      existingAssetVersionId: assetVersionId,
      existingCdrVaultUuid: 9999,
      existingActive: true,
      assetVersionId,
      cdrVaultUuid: 6737,
    })).toThrow("story_entitlement_class_mismatch")
  })
})
