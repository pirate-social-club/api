import { describe, expect, test } from "bun:test"
import {
  resolveStoryRuntimeSignerMinBalanceWei,
  resolveStoryRuntimeSignerTargetBalanceWei,
} from "./story-runtime-config"

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
