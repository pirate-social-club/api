import { describe, expect, test } from "bun:test"
import { preparedLockedDeliveryMatches, type PreparedLockedDeliveryCoordinates } from "./asset-delivery"

const expected = {
  storyAssetVersionId: `0x${"11".repeat(32)}`,
  storyNamespace: `0x${"22".repeat(32)}`,
  storyEntitlementTokenId: "12345",
  storyReadCondition: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  storyWriteCondition: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  lockedDeliveryRef: "locked-assets/cmt_test/ast_test/payload.bin",
}

function prepared(overrides: Partial<PreparedLockedDeliveryCoordinates> = {}): PreparedLockedDeliveryCoordinates {
  return {
    ...expected,
    storyCdrVaultUuid: 4242,
    lockedDeliveryStorageRef: "locked-assets/cmt_test/ast_test/payload.bin",
    lockedDeliveryMetadataJson: JSON.stringify({ algorithm: "AES-GCM", iv_b64: "iv", mime_type: "audio/wav" }),
    ...overrides,
  }
}

describe("preparedLockedDeliveryMatches", () => {
  test("accepts persisted CDR coordinates that can be reused on retry", () => {
    expect(preparedLockedDeliveryMatches({
      prepared: prepared(),
      expected,
    })).toBe(true)
  })

  test("rejects missing or mismatched CDR coordinates so retry does not reuse the wrong vault", () => {
    expect(preparedLockedDeliveryMatches({
      prepared: null,
      expected,
    })).toBe(false)
    expect(preparedLockedDeliveryMatches({
      prepared: prepared({ storyCdrVaultUuid: 0 }),
      expected,
    })).toBe(false)
    expect(preparedLockedDeliveryMatches({
      prepared: prepared({ storyAssetVersionId: `0x${"33".repeat(32)}` }),
      expected,
    })).toBe(false)
    expect(preparedLockedDeliveryMatches({
      prepared: prepared({ lockedDeliveryStorageRef: "" }),
      expected,
    })).toBe(false)
    expect(preparedLockedDeliveryMatches({
      prepared: prepared({ lockedDeliveryMetadataJson: "" }),
      expected,
    })).toBe(false)
  })
})
