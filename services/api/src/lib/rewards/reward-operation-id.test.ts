import { describe, expect, test } from "bun:test"

import { rewardOperationId } from "./reward-operation-id"

describe("rewardOperationId", () => {
  test.each([
    [
      "rpe_0123456789abcdef0123456789abcdef",
      "0x566277c126ff70156eceee8d4f46b24e0c251d46600efbabedf2caae037eef7e",
    ],
    [
      "rcf_0123456789abcdef0123456789abcdef",
      "0x5c15c36f5a33442b3053f8d71f2ae558e11284c5a61697a1d48aaed7b2617b49",
    ],
  ])("matches the pinned UTF-8 keccak256 vector for %s", (effectId, expected) => {
    expect(rewardOperationId(effectId)).toBe(expected)
  })

  test("does not normalize case or whitespace", () => {
    const canonical = rewardOperationId("rpe_abcdef")
    expect(rewardOperationId("RPE_abcdef")).not.toBe(canonical)
    expect(rewardOperationId("rpe_abcdef ")).not.toBe(canonical)
  })

  test("rejects an empty effect ID", () => {
    expect(() => rewardOperationId("")).toThrow("Reward settlement effect ID is required")
  })
})
