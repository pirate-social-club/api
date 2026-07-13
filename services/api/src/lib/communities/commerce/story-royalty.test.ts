import { describe, expect, test } from "bun:test"
import {
  assertAssetReadyForStoryRoyaltyCommerce,
  ensureAssetReadyForStoryRoyaltyCommerce,
} from "./story-royalty"
import type { Env } from "../../../env"

const productionEnv = { ENVIRONMENT: "production" }

const readyAsset = {
  asset_kind: "song_audio" as const,
  story_ip_id: "0x1111111111111111111111111111111111111111",
  story_royalty_registration_status: "registered" as const,
  story_status: "published" as const,
  locked_delivery_status: "ready" as const,
  royalty_allocation_status: "none" as const,
}

describe("assertAssetReadyForStoryRoyaltyCommerce", () => {
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

  test("local Story fallback bypasses allocation verification for fake Story paths only", () => {
    const localFallbackAsset = {
      ...readyAsset,
      story_ip_id: null,
      story_royalty_registration_status: "pending" as const,
      royalty_allocation_status: "none" as const,
    }

    expect(() => assertAssetReadyForStoryRoyaltyCommerce(
      localFallbackAsset,
      { ENVIRONMENT: "test" },
    )).not.toThrow()

    expect(() => assertAssetReadyForStoryRoyaltyCommerce({
      ...localFallbackAsset,
      royalty_allocation_status: "verification_pending" as const,
    }, { ENVIRONMENT: "test" })).not.toThrow()

    expect(() => assertAssetReadyForStoryRoyaltyCommerce({
      ...readyAsset,
      locked_delivery_status: "none" as const,
      royalty_allocation_status: "verification_pending" as const,
    }, { ENVIRONMENT: "test" })).not.toThrow()

    expect(() => assertAssetReadyForStoryRoyaltyCommerce({
      ...readyAsset,
      story_status: "none" as const,
      royalty_allocation_status: "verification_pending" as const,
    }, { ENVIRONMENT: "test" })).toThrow("Asset royalty allocation is not verified")
  })

  test("still rejects missing Story royalty registration", () => {
    expect(() => assertAssetReadyForStoryRoyaltyCommerce({
      ...readyAsset,
      story_royalty_registration_status: "pending",
    }, productionEnv)).toThrow("Asset is not ready for Story royalty commerce")
  })
})

describe("ensureAssetReadyForStoryRoyaltyCommerce", () => {
  const pendingAsset = {
    asset_id: "asset_pending",
    community_id: "community_pending",
    asset_kind: "song_audio" as const,
    story_ip_id: "0x1111111111111111111111111111111111111111",
    story_royalty_registration_status: "registered" as const,
    story_status: "published" as const,
    locked_delivery_status: "ready" as const,
    royalty_allocation_status: "verification_pending" as const,
  }
  const client = {} as Parameters<typeof ensureAssetReadyForStoryRoyaltyCommerce>[0]["client"]
  const vaultReader = {} as NonNullable<Parameters<typeof ensureAssetReadyForStoryRoyaltyCommerce>[0]["vaultReader"]>

  test("verifies the requested pending asset at the quote boundary", async () => {
    const calls: Array<{ assetId: string; communityId: string }> = []
    const asset = await ensureAssetReadyForStoryRoyaltyCommerce({
      asset: pendingAsset,
      client,
      env: productionEnv as Env,
      vaultReader,
      verifyAllocation: async (input) => {
        calls.push({ assetId: input.assetId, communityId: input.communityId })
        return { status: "verified", assetId: input.assetId, checkedRows: 1, totalSupply: "100", decimals: 0 }
      },
    })

    expect(calls).toEqual([{ assetId: "asset_pending", communityId: "community_pending" }])
    expect(asset.royalty_allocation_status).toBe("verified")
  })

  test("still fails closed when targeted verification remains pending", async () => {
    await expect(ensureAssetReadyForStoryRoyaltyCommerce({
      asset: pendingAsset,
      client,
      env: productionEnv as Env,
      vaultReader,
      verifyAllocation: async (input) => ({
        status: "pending",
        assetId: input.assetId,
        checkedRows: 0,
        reason: "royalty_vault_balance_mismatch",
      }),
    })).rejects.toThrow("Asset royalty allocation is not verified")
  })
})
