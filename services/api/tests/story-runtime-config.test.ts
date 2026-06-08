import { describe, expect, test } from "bun:test"
import type { Env } from "../src/env"
import {
  STORY_DELIVERY_CONTRACTS,
  resolveStoryDeliveryContracts,
} from "../src/lib/story/story-runtime-config"

describe("story runtime config", () => {
  test("uses default delivery contracts when overrides are empty", () => {
    expect(resolveStoryDeliveryContracts({} as Env)).toEqual(STORY_DELIVERY_CONTRACTS)
  })

  test("accepts delivery contract overrides", () => {
    const contracts = resolveStoryDeliveryContracts({
      STORY_PURCHASE_ENTITLEMENT_TOKEN_CONTRACT: "0x1111111111111111111111111111111111111111",
      STORY_PIRATE_SIGNER_REGISTRY_CONTRACT: "0x2222222222222222222222222222222222222222",
      STORY_TOKEN_GATE_CONDITION_CONTRACT: "0x3333333333333333333333333333333333333333",
      STORY_SIGNED_ACCESS_CONDITION_CONTRACT: "0x4444444444444444444444444444444444444444",
      STORY_ASSET_PUBLISH_COORDINATOR_CONTRACT: "0x5555555555555555555555555555555555555555",
      STORY_MARKETPLACE_SETTLEMENT_CONTRACT: "0x6666666666666666666666666666666666666666",
    } as Env)

    expect(contracts).toEqual({
      purchaseEntitlementToken: "0x1111111111111111111111111111111111111111",
      pirateSignerRegistry: "0x2222222222222222222222222222222222222222",
      tokenGateCondition: "0x3333333333333333333333333333333333333333",
      signedAccessConditionV1: "0x4444444444444444444444444444444444444444",
      assetPublishCoordinatorV1: "0x5555555555555555555555555555555555555555",
      marketplaceSettlementV1: "0x6666666666666666666666666666666666666666",
    })
  })

  test("rejects malformed delivery contract overrides", () => {
    expect(() => resolveStoryDeliveryContracts({
      STORY_PURCHASE_ENTITLEMENT_TOKEN_CONTRACT: "not-an-address",
    } as Env)).toThrow("STORY_PURCHASE_ENTITLEMENT_TOKEN_CONTRACT missing/invalid")
  })
})
