import { describe, expect, test } from "bun:test"

import {
  assertRewardSettlementAddress,
  assertRewardSettlementSyncTarget,
  deriveRewardSettlementAddress,
} from "./reward-settlement-signer-provisioning"

const TEST_PRIVATE_KEY = `0x${"01".padStart(64, "0")}`
const TEST_ADDRESS = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf"

describe("reward settlement signer provisioning", () => {
  test("derives the public address without returning the private key", () => {
    expect(deriveRewardSettlementAddress(TEST_PRIVATE_KEY)).toBe(TEST_ADDRESS)
  })

  test("accepts a private key only when it matches the versioned address", () => {
    expect(assertRewardSettlementAddress({ privateKey: TEST_PRIVATE_KEY, expectedAddress: TEST_ADDRESS.toLowerCase() })).toBe(TEST_ADDRESS)
    expect(() => assertRewardSettlementAddress({
      privateKey: TEST_PRIVATE_KEY,
      expectedAddress: "0x0000000000000000000000000000000000000001",
    })).toThrow("reward_settlement_private_key_does_not_match_versioned_address")
  })

  test("rejects malformed key material before invoking a secret sink", () => {
    expect(() => deriveRewardSettlementAddress("not-a-private-key")).toThrow(
      "PIRATE_REWARDS_SETTLEMENT_OPERATOR_PRIVATE_KEY_must_be_a_32_byte_hex_private_key",
    )
  })

  test("requires an explicit confirmation and matching Infisical environment for production", () => {
    expect(assertRewardSettlementSyncTarget({
      environment: "staging",
      infisicalEnvironment: "staging",
      confirmProduction: false,
    })).toBe("staging")
    expect(assertRewardSettlementSyncTarget({
      environment: "production",
      infisicalEnvironment: "prod",
      confirmProduction: true,
    })).toBe("production")
    expect(() => assertRewardSettlementSyncTarget({
      environment: "production",
      infisicalEnvironment: "prod",
      confirmProduction: false,
    })).toThrow("production_reward_signer_sync_requires_confirmation")
    expect(() => assertRewardSettlementSyncTarget({
      environment: "production",
      infisicalEnvironment: "staging",
      confirmProduction: true,
    })).toThrow("infisical_environment_must_be_production")
  })
})
