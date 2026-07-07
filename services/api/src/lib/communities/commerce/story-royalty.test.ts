import { describe, expect, test } from "bun:test"
import { assertAssetReadyForStoryRoyaltyCommerce } from "./story-royalty"

const readyAsset = {
  asset_kind: "song_audio" as const,
  story_ip_id: "0x1111111111111111111111111111111111111111",
  story_royalty_registration_status: "registered" as const,
  story_status: "published" as const,
  locked_delivery_status: "ready" as const,
  royalty_allocation_status: "none" as const,
}

describe("assertAssetReadyForStoryRoyaltyCommerce", () => {
  const productionEnv = { ENVIRONMENT: "production" }

  test("allows registered assets without declared royalty allocations", () => {
    expect(() => assertAssetReadyForStoryRoyaltyCommerce(readyAsset, productionEnv)).not.toThrow()
  })

  test("allows allocation-bearing assets only after RT distribution is verified", () => {
    expect(() => assertAssetReadyForStoryRoyaltyCommerce({
      ...readyAsset,
      royalty_allocation_status: "verified",
    }, productionEnv)).not.toThrow()

    expect(() => assertAssetReadyForStoryRoyaltyCommerce({
      ...readyAsset,
      royalty_allocation_status: "verification_pending",
    }, productionEnv)).toThrow("Asset royalty allocation is not verified")
  })

  test("still rejects missing Story royalty registration", () => {
    expect(() => assertAssetReadyForStoryRoyaltyCommerce({
      ...readyAsset,
      story_royalty_registration_status: "pending",
    }, productionEnv)).toThrow("Asset is not ready for Story royalty commerce")
  })
})
