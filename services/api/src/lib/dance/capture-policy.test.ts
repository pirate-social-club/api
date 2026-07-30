import { describe, expect, test } from "bun:test"

import { isDanceCaptureEnabled } from "./capture-policy"

describe("dance capture rollout policy", () => {
  test("fails closed unless explicitly true", () => {
    expect(isDanceCaptureEnabled({})).toBe(false)
    expect(isDanceCaptureEnabled({ DANCE_CAPTURE_ENABLED: "false" })).toBe(false)
    expect(isDanceCaptureEnabled({ DANCE_CAPTURE_ENABLED: "1" })).toBe(false)
    expect(isDanceCaptureEnabled({ DANCE_CAPTURE_ENABLED: " TRUE " })).toBe(true)
  })
})
