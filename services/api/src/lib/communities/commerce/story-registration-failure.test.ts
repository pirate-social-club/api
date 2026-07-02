import { describe, expect, test } from "bun:test"

import {
  classifyStoryRegistrationFailure,
  isStoryRegistrationFailureRetryable,
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

  test("insufficient-funds failures do NOT tell the user to retry (operator-side)", () => {
    const raw =
      "royalty_registration_failed:Story runtime signer funding below floor: " +
      "story-operator:0xc77Ad4de7d179FFFBa417cA24c055d86Af69F4BB:0.4877<0.5"
    const message = storyRegistrationFailureMessage(raw)
    expect(message).toContain("operator funding issue")
    expect(message).not.toContain("try again")
    // raw wallet/balance detail must never surface to the user
    expect(message).not.toContain("0xc77Ad4de")
    expect(message).not.toContain("funding below floor")
    expect(message).not.toContain("0.4877")
  })

  test("also classifies 'exceeds the balance' as insufficient funds (no retry prompt)", () => {
    const message = storyRegistrationFailureMessage(
      "royalty_registration_failed:The total cost (gas * gas fee + value) ... exceeds the balance of the account",
    )
    expect(message).toContain("operator funding issue")
    expect(message).not.toContain("try again")
    expect(message).not.toContain("exceeds the balance")
  })

  test("gas-policy failures do NOT tell the user to retry (config-side)", () => {
    const message = storyRegistrationFailureMessage(
      "royalty_registration_failed:story_royalty_gas_limit_exceeds_policy:2415000:2000000",
    )
    expect(message).toContain("configuration issue")
    expect(message).not.toContain("try again")
    expect(message).not.toContain("story_royalty_gas_limit_exceeds_policy")
  })

  test("config-missing gets a distinct, non-retry message", () => {
    const message = storyRegistrationFailureMessage("royalty_registration_failed:story_royalty_config_missing")
    expect(message).toContain("not configured")
    expect(message).not.toContain("try again")
  })

  test("transient (RPC) failure keeps the retry prompt", () => {
    expect(storyRegistrationFailureMessage(RAW_RPC_FAILURE)).toContain("try again in a few minutes")
  })

  test("null/empty error still yields a safe retryable message", () => {
    expect(storyRegistrationFailureMessage(null)).toContain("temporarily unavailable")
  })
})

describe("isStoryRegistrationFailureRetryable", () => {
  test("only transient failures are retryable", () => {
    expect(isStoryRegistrationFailureRetryable("transient")).toBe(true)
    expect(isStoryRegistrationFailureRetryable("insufficient_funds")).toBe(false)
    expect(isStoryRegistrationFailureRetryable("gas_policy")).toBe(false)
    expect(isStoryRegistrationFailureRetryable("config_missing")).toBe(false)
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
