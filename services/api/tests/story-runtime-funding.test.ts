import { describe, expect, test } from "bun:test"
import { Wallet } from "ethers"
import type { Env } from "../src/env"
import {
  listStoryRuntimeSignerAddresses,
} from "../src/lib/story/story-runtime-funding"

const operatorPrivateKey = "0x2000000000000000000000000000000000000000000000000000000000000002"
const cdrWriterPrivateKey = "0x3000000000000000000000000000000000000000000000000000000000000003"
const settlementPrivateKey = "0x4000000000000000000000000000000000000000000000000000000000000004"
const entitlementClassConfigurerPrivateKey = "0x5000000000000000000000000000000000000000000000000000000000000005"

function baseEnv(): Env {
  return {
    STORY_OPERATOR_PRIVATE_KEY: operatorPrivateKey,
    STORY_CDR_WRITER_PRIVATE_KEY: cdrWriterPrivateKey,
    MUSIC_PURCHASE_STORY_SETTLEMENT_PRIVATE_KEY: settlementPrivateKey,
    STORY_ENTITLEMENT_CLASS_CONFIGURER_PRIVATE_KEY: entitlementClassConfigurerPrivateKey,
  } as Env
}

describe("story runtime funding", () => {
  test("defaults to the steady-state Story runtime signers", () => {
    const signers = listStoryRuntimeSignerAddresses(baseEnv())

    expect(signers.map((entry) => entry.name)).toEqual([
      "story-operator",
      "story-cdr-writer",
      "story-settlement",
    ])
  })

  test("resolves the optional entitlement class configurer signer when requested", () => {
    const signers = listStoryRuntimeSignerAddresses(baseEnv(), [
      "story-entitlement-class-configurer",
    ])

    expect(signers).toEqual([
      {
        name: "story-entitlement-class-configurer",
        address: new Wallet(entitlementClassConfigurerPrivateKey).address,
      },
    ])
  })
})
