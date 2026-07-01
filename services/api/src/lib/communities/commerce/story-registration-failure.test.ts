import { describe, expect, test } from "bun:test"

import {
  classifyStoryRegistrationFailure,
  sanitizeStoryRegistrationFailure,
  storyRegistrationFailureMessage,
} from "./story-registration-failure"

const RAW_RPC_FAILURE =
  'royalty_registration_failed:Failed to register IP Asset: Failed to mint and register IP and attach PIL terms: ' +
  'The contract function "mintAndRegisterIpAndAttachPILTerms" reverted with the following reason: RPC Request failed. ' +
  "Contract Call: address: 0xcC2E862bCee5B6036Db0de6E06Ae87e524a79fd8"

describe("storyRegistrationFailureMessage", () => {
  test("never leaks raw SDK/contract/RPC text to the user", () => {
    const message = storyRegistrationFailureMessage(RAW_RPC_FAILURE)
    expect(message).toBe(
      "Story registration is temporarily unavailable, so this asset was not published. Please try again in a few minutes.",
    )
    expect(message).not.toContain("mintAndRegisterIpAndAttachPILTerms")
    expect(message).not.toContain("0xcC2E862")
    expect(message).not.toContain("RPC Request failed")
  })

  test("insufficient funds and gas-policy failures stay generic (no raw text)", () => {
    for (const raw of [
      "royalty_registration_failed:The total cost (gas * gas fee + value) ... exceeds the balance of the account",
      "royalty_registration_failed:story_royalty_gas_limit_exceeds_policy:2415000:2000000",
    ]) {
      const message = storyRegistrationFailureMessage(raw)
      expect(message).toContain("temporarily unavailable")
      expect(message).not.toContain("exceeds the balance")
      expect(message).not.toContain("story_royalty_gas_limit_exceeds_policy")
    }
  })

  test("config-missing gets a distinct, non-retry message", () => {
    const message = storyRegistrationFailureMessage("royalty_registration_failed:story_royalty_config_missing")
    expect(message).toContain("not configured")
    expect(message).not.toContain("try again")
  })

  test("null/empty error still yields a safe message", () => {
    expect(storyRegistrationFailureMessage(null)).toContain("temporarily unavailable")
  })
})

describe("classifyStoryRegistrationFailure", () => {
  test("classifies each family", () => {
    expect(classifyStoryRegistrationFailure(RAW_RPC_FAILURE)).toBe("transient")
    expect(classifyStoryRegistrationFailure("... exceeds the balance of the account")).toBe("insufficient_funds")
    expect(classifyStoryRegistrationFailure("story_royalty_gas_limit_exceeds_policy:1:2")).toBe("gas_policy")
    expect(classifyStoryRegistrationFailure("story_royalty_config_missing")).toBe("config_missing")
    expect(classifyStoryRegistrationFailure(null)).toBe("transient")
  })
})

describe("sanitizeStoryRegistrationFailure", () => {
  test("collapses whitespace and truncates to 600 chars for logs", () => {
    expect(sanitizeStoryRegistrationFailure("  a\n  b\t c  ")).toBe("a b c")
    expect(sanitizeStoryRegistrationFailure(null)).toBeNull()
    const long = "x".repeat(700)
    const out = sanitizeStoryRegistrationFailure(long)!
    expect(out.endsWith("...")).toBe(true)
    expect(out.length).toBe(603)
  })
})
