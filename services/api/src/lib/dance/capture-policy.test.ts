import { describe, expect, test } from "bun:test"

import {
  isDanceCaptureEnabled,
  isDanceChoreographyEnabled,
} from "./capture-policy"

describe("dance capture rollout policy", () => {
  test("fails closed unless explicitly true", () => {
    expect(isDanceCaptureEnabled({})).toBe(false)
    expect(isDanceCaptureEnabled({ DANCE_CAPTURE_ENABLED: "false" })).toBe(false)
    expect(isDanceCaptureEnabled({ DANCE_CAPTURE_ENABLED: "1" })).toBe(false)
    expect(isDanceCaptureEnabled({ DANCE_CAPTURE_ENABLED: " TRUE " })).toBe(true)
  })

  test("keeps choreography reads dark unless explicitly enabled", () => {
    expect(isDanceChoreographyEnabled({})).toBe(false)
    expect(isDanceChoreographyEnabled({ DANCE_CHOREOGRAPHY_ENABLED: "true" })).toBe(true)
  })
})
