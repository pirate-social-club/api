import { describe, expect, test } from "bun:test"
import {
  STORY_DELIVERY_CONTRACTS,
  resolveStoryDeliveryContracts,
  resolveStoryRuntimeSignerMinBalanceWei,
  resolveStoryRuntimeSignerTargetBalanceWei,
} from "./story-runtime-config"

describe("Story delivery contract config", () => {
  test("uses configured delivery contract addresses when present", () => {
    const contracts = resolveStoryDeliveryContracts({
      STORY_ASSET_PUBLISH_COORDINATOR_CONTRACT: "0x0000000000000000000000000000000000000001",
      STORY_ENTITLEMENT_CLASS_CONFIGURER_CONTRACT: "0x0000000000000000000000000000000000000002",
      STORY_MARKETPLACE_SETTLEMENT_CONTRACT: "0x0000000000000000000000000000000000000003",
      STORY_PIRATE_SIGNER_REGISTRY_CONTRACT: "0x0000000000000000000000000000000000000004",
      STORY_PURCHASE_ENTITLEMENT_TOKEN_CONTRACT: "0x0000000000000000000000000000000000000005",
    })

    expect(contracts.assetPublishCoordinatorV1).toBe("0x0000000000000000000000000000000000000001")
    expect(contracts.purchaseEntitlementClassConfigurer).toBe("0x0000000000000000000000000000000000000002")
    expect(contracts.marketplaceSettlementV1).toBe("0x0000000000000000000000000000000000000003")
    expect(contracts.pirateSignerRegistry).toBe("0x0000000000000000000000000000000000000004")
    expect(contracts.purchaseEntitlementToken).toBe("0x0000000000000000000000000000000000000005")
  })

  test("falls back to checked-in defaults for missing or invalid overrides", () => {
    const contracts = resolveStoryDeliveryContracts({
      STORY_ASSET_PUBLISH_COORDINATOR_CONTRACT: "not-an-address",
      STORY_ENTITLEMENT_CLASS_CONFIGURER_CONTRACT: "",
      STORY_MARKETPLACE_SETTLEMENT_CONTRACT: undefined,
      STORY_PIRATE_SIGNER_REGISTRY_CONTRACT: undefined,
      STORY_PURCHASE_ENTITLEMENT_TOKEN_CONTRACT: "0x0000000000000000000000000000000000000006",
    })

    expect(contracts.assetPublishCoordinatorV1).toBe(STORY_DELIVERY_CONTRACTS.assetPublishCoordinatorV1)
    expect(contracts.purchaseEntitlementClassConfigurer).toBe(STORY_DELIVERY_CONTRACTS.purchaseEntitlementClassConfigurer)
    expect(contracts.marketplaceSettlementV1).toBe(STORY_DELIVERY_CONTRACTS.marketplaceSettlementV1)
    expect(contracts.pirateSignerRegistry).toBe(STORY_DELIVERY_CONTRACTS.pirateSignerRegistry)
    expect(contracts.purchaseEntitlementToken).toBe("0x0000000000000000000000000000000000000006")
  })
})

describe("Story runtime signer funding config", () => {
  test("defaults to the operational funding floor and target", () => {
    expect(resolveStoryRuntimeSignerMinBalanceWei({})).toBe(250_000_000_000_000_000n)
    expect(resolveStoryRuntimeSignerTargetBalanceWei({})).toBe(500_000_000_000_000_000n)
  })

  test("never resolves a target below the configured floor", () => {
    const env = {
      STORY_RUNTIME_SIGNER_MIN_BALANCE_WEI: "700000000000000000",
      STORY_RUNTIME_SIGNER_TARGET_BALANCE_WEI: "500000000000000000",
    }

    expect(resolveStoryRuntimeSignerTargetBalanceWei(env)).toBe(700_000_000_000_000_000n)
  })
})
