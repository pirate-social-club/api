import { describe, expect, test } from "bun:test"

import { moderationSeverityFromProviderResult } from "./post-service"

describe("moderationSeverityFromProviderResult", () => {
  test("treats safety-critical visual reason codes as high priority", () => {
    for (const code of ["hate_symbols", "weapons"]) {
      expect(moderationSeverityFromProviderResult({
        visual_policy: {
          decision: {
            reasonCodes: [code],
          },
        },
      })).toBe("high")
    }
  })

  test("treats ordinary visual reason codes as medium priority", () => {
    expect(moderationSeverityFromProviderResult({
      visual_policy: {
        decision: {
          reasonCodes: ["adult_platform_watermark"],
        },
      },
    })).toBe("medium")
  })

  test("falls back to low priority when no categories or reason codes are present", () => {
    expect(moderationSeverityFromProviderResult({
      visual_policy: {
        decision: {
          reasonCodes: [],
        },
      },
    })).toBe("low")
  })
})
