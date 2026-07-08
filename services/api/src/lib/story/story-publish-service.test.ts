import { describe, expect, test } from "bun:test"
import { publishedAssetVersionMatches, type PublishedAssetVersionSnapshot } from "./story-publish-service"

const expected = {
  publisherAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  cdrVaultUuid: 5151,
  namespace: `0x${"11".repeat(32)}`,
  contentHash: `0x${"22".repeat(32)}`,
  storageRefHash: `0x${"33".repeat(32)}`,
  entitlementTokenId: 12345n,
  readConditionAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  writeConditionAddress: "0xcccccccccccccccccccccccccccccccccccccccc",
}

function existing(overrides: Partial<PublishedAssetVersionSnapshot> = {}): PublishedAssetVersionSnapshot {
  return {
    publisher: expected.publisherAddress,
    cdrVaultUuid: BigInt(expected.cdrVaultUuid),
    namespace: expected.namespace.toUpperCase(),
    contentHash: expected.contentHash.toUpperCase(),
    storageRefHash: expected.storageRefHash.toUpperCase(),
    entitlementTokenId: expected.entitlementTokenId,
    readCondition: expected.readConditionAddress,
    writeCondition: expected.writeConditionAddress,
    active: true,
    exists: true,
    ...overrides,
  }
}

describe("publishedAssetVersionMatches", () => {
  test("accepts an already-published asset version only when every coordinate matches", () => {
    expect(publishedAssetVersionMatches({
      existing: existing(),
      expected,
    })).toBe(true)
  })

  test("rejects missing or different published-version coordinates", () => {
    expect(publishedAssetVersionMatches({
      existing: existing({ exists: false }),
      expected,
    })).toBe(false)
    expect(publishedAssetVersionMatches({
      existing: existing({ cdrVaultUuid: 5152n }),
      expected,
    })).toBe(false)
    expect(publishedAssetVersionMatches({
      existing: existing({ storageRefHash: `0x${"44".repeat(32)}` }),
      expected,
    })).toBe(false)
    expect(publishedAssetVersionMatches({
      existing: existing({ readCondition: "0xdddddddddddddddddddddddddddddddddddddddd" }),
      expected,
    })).toBe(false)
  })
})
