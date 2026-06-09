import { describe, expect, test } from "bun:test"
import { AbiCoder, type JsonRpcProvider } from "ethers"
import type { Env } from "../src/env"
import { ensureStoryEntitlementMinterAuthorized } from "../src/lib/story/story-runtime-authorization"

const boolCoder = AbiCoder.defaultAbiCoder()

function fakeProvider(isSettlementMinter: boolean) {
  return {
    call: async () => boolCoder.encode(["bool"], [isSettlementMinter]),
    resolveName: async (name: string) => name,
  }
}

function baseEnv(): Env {
  return {
    STORY_PURCHASE_ENTITLEMENT_TOKEN_CONTRACT: "0x1111111111111111111111111111111111111111",
  } as Env
}

describe("story runtime authorization", () => {
  test("does not owner-bootstrap missing settlement minter grants after controller migration", async () => {
    await expect(ensureStoryEntitlementMinterAuthorized({
      env: {
        ...baseEnv(),
        STORY_ENTITLEMENT_CLASS_CONFIGURER_CONTRACT: "0x3333333333333333333333333333333333333333",
      },
      provider: fakeProvider(false) as unknown as JsonRpcProvider,
      minterAddress: "0x2222222222222222222222222222222222222222",
    })).rejects.toThrow(
      "story_runtime_authorization_missing_cold_owner_grant:setSettlementMinter:0x2222222222222222222222222222222222222222",
    )
  })

  test("keeps legacy owner-bootstrap behavior before controller migration", async () => {
    await expect(ensureStoryEntitlementMinterAuthorized({
      env: baseEnv(),
      provider: fakeProvider(false) as unknown as JsonRpcProvider,
      minterAddress: "0x2222222222222222222222222222222222222222",
    })).rejects.toThrow("STORY_CONTRACT_OWNER_PRIVATE_KEY missing/invalid")
  })

  test("returns without bootstrap when the settlement minter grant already exists", async () => {
    await expect(ensureStoryEntitlementMinterAuthorized({
      env: {
        ...baseEnv(),
        STORY_ENTITLEMENT_CLASS_CONFIGURER_CONTRACT: "0x3333333333333333333333333333333333333333",
      },
      provider: fakeProvider(true) as unknown as JsonRpcProvider,
      minterAddress: "0x2222222222222222222222222222222222222222",
    })).resolves.toBeUndefined()
  })
})
