import { describe, expect, test } from "bun:test"
import { Wallet } from "ethers"
import type { Env } from "../src/env"
import {
  resolveStoryDeliveryPreflightConfig,
  shouldRunStoryDeliveryRuntimePreflight,
} from "../src/lib/story/story-delivery-preflight"

const ownerPrivateKey = "0x1000000000000000000000000000000000000000000000000000000000000001"
const operatorPrivateKey = "0x2000000000000000000000000000000000000000000000000000000000000002"
const accessPrivateKey = "0x3000000000000000000000000000000000000000000000000000000000000003"
const settlementPrivateKey = "0x4000000000000000000000000000000000000000000000000000000000000004"
const entitlementClassConfigurerPrivateKey = "0x5000000000000000000000000000000000000000000000000000000000000005"

function baseEnv(): Env {
  return {
    ENVIRONMENT: "staging",
    STORY_CONTRACT_OWNER_PRIVATE_KEY: ownerPrivateKey,
    STORY_OPERATOR_PRIVATE_KEY: operatorPrivateKey,
    STORY_ACCESS_CONTROLLER_PRIVATE_KEY: accessPrivateKey,
    MUSIC_PURCHASE_STORY_SETTLEMENT_PRIVATE_KEY: settlementPrivateKey,
    STORY_PURCHASE_ENTITLEMENT_TOKEN_CONTRACT: "0x1111111111111111111111111111111111111111",
    STORY_PIRATE_SIGNER_REGISTRY_CONTRACT: "0x2222222222222222222222222222222222222222",
    STORY_TOKEN_GATE_CONDITION_CONTRACT: "0x3333333333333333333333333333333333333333",
    STORY_SIGNED_ACCESS_CONDITION_CONTRACT: "0x4444444444444444444444444444444444444444",
    STORY_ASSET_PUBLISH_COORDINATOR_CONTRACT: "0x5555555555555555555555555555555555555555",
    STORY_MARKETPLACE_SETTLEMENT_CONTRACT: "0x6666666666666666666666666666666666666666",
  } as Env
}

describe("story delivery runtime preflight", () => {
  test("skips local and test environments", () => {
    expect(shouldRunStoryDeliveryRuntimePreflight({ ENVIRONMENT: "test" })).toBe(false)
    expect(shouldRunStoryDeliveryRuntimePreflight({ ENVIRONMENT: "development" })).toBe(false)
    expect(shouldRunStoryDeliveryRuntimePreflight({ ENVIRONMENT: "staging" })).toBe(true)
  })

  test("resolves owner, runtime signer, and contract address config", () => {
    const config = resolveStoryDeliveryPreflightConfig(baseEnv())

    expect(config.ownerAddress).toBe(new Wallet(ownerPrivateKey).address)
    expect(config.operatorAddress).toBe(new Wallet(operatorPrivateKey).address)
    expect(config.accessSignerAddress).toBe(new Wallet(accessPrivateKey).address)
    expect(config.settlementAddress).toBe(new Wallet(settlementPrivateKey).address)
    expect(config.entitlementClassConfigurerContract).toBeNull()
    expect(config.entitlementClassConfigurerAddress).toBeNull()
    expect(config.contracts).toEqual({
      purchaseEntitlementToken: "0x1111111111111111111111111111111111111111",
      pirateSignerRegistry: "0x2222222222222222222222222222222222222222",
      tokenGateCondition: "0x3333333333333333333333333333333333333333",
      signedAccessConditionV1: "0x4444444444444444444444444444444444444444",
      assetPublishCoordinatorV1: "0x5555555555555555555555555555555555555555",
      marketplaceSettlementV1: "0x6666666666666666666666666666666666666666",
    })
    expect(config.fingerprint).toContain(config.ownerAddress)
  })

  test("resolves configured delivery owner address without requiring owner private key", () => {
    const ownerAddress = new Wallet(ownerPrivateKey).address
    const config = resolveStoryDeliveryPreflightConfig({
      ...baseEnv(),
      STORY_CONTRACT_OWNER_PRIVATE_KEY: undefined,
      STORY_DELIVERY_OWNER_ADDRESS: ownerAddress,
      STORY_ENTITLEMENT_CLASS_CONFIGURER_CONTRACT: "0x7777777777777777777777777777777777777777",
      STORY_ENTITLEMENT_CLASS_CONFIGURER_PRIVATE_KEY: entitlementClassConfigurerPrivateKey,
    })

    expect(config.ownerAddress).toBe(ownerAddress)
    expect(config.fingerprint).toContain(ownerAddress)
  })

  test("resolves entitlement class configurer controller config", () => {
    const config = resolveStoryDeliveryPreflightConfig({
      ...baseEnv(),
      STORY_DELIVERY_OWNER_ADDRESS: new Wallet(ownerPrivateKey).address,
      STORY_CONTRACT_OWNER_PRIVATE_KEY: undefined,
      STORY_ENTITLEMENT_CLASS_CONFIGURER_CONTRACT: "0x7777777777777777777777777777777777777777",
      STORY_ENTITLEMENT_CLASS_CONFIGURER_PRIVATE_KEY: entitlementClassConfigurerPrivateKey,
      STORY_ENTITLEMENT_CLASS_CONFIGURER_ADDRESS: new Wallet(entitlementClassConfigurerPrivateKey).address,
    })

    expect(config.entitlementClassConfigurerContract).toBe("0x7777777777777777777777777777777777777777")
    expect(config.entitlementClassConfigurerAddress).toBe(new Wallet(entitlementClassConfigurerPrivateKey).address)
    expect(config.fingerprint).toContain("0x7777777777777777777777777777777777777777")
    expect(config.fingerprint).toContain(config.entitlementClassConfigurerAddress)
  })

  test("fails before RPC work when required signer config is missing", () => {
    expect(() => resolveStoryDeliveryPreflightConfig({
      ...baseEnv(),
      STORY_CONTRACT_OWNER_PRIVATE_KEY: undefined,
    })).toThrow("STORY_CONTRACT_OWNER_PRIVATE_KEY missing/invalid")

    expect(() => resolveStoryDeliveryPreflightConfig({
      ...baseEnv(),
      STORY_CONTRACT_OWNER_PRIVATE_KEY: undefined,
      STORY_DELIVERY_OWNER_ADDRESS: new Wallet(ownerPrivateKey).address,
    })).toThrow("STORY_CONTRACT_OWNER_PRIVATE_KEY missing/invalid")

    expect(() => resolveStoryDeliveryPreflightConfig({
      ...baseEnv(),
      MUSIC_PURCHASE_STORY_SETTLEMENT_PRIVATE_KEY: undefined,
    })).toThrow("MUSIC_PURCHASE_STORY_SETTLEMENT_PRIVATE_KEY missing/invalid")

    expect(() => resolveStoryDeliveryPreflightConfig({
      ...baseEnv(),
      STORY_ENTITLEMENT_CLASS_CONFIGURER_CONTRACT: "0x7777777777777777777777777777777777777777",
      STORY_ENTITLEMENT_CLASS_CONFIGURER_PRIVATE_KEY: undefined,
    })).toThrow("STORY_ENTITLEMENT_CLASS_CONFIGURER_PRIVATE_KEY missing/invalid")
  })
})
