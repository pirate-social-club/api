import { describe, expect, test } from "bun:test"
import { allocationAttributionHeaders } from "./allocation-attribution"

describe("allocationAttributionHeaders", () => {
  test("identifies the consumer and carries the GitHub run id when available", () => {
    expect(allocationAttributionHeaders("api-script:smoke-community", {
      GITHUB_RUN_ID: "123456",
    })).toEqual({
      "x-pirate-allocation-source": "api-script:smoke-community",
      "x-pirate-allocation-run-id": "123456",
    })
  })

  test("omits an absent run id without weakening the source label", () => {
    expect(allocationAttributionHeaders("api-script:smoke-community", {})).toEqual({
      "x-pirate-allocation-source": "api-script:smoke-community",
    })
  })

  test("rejects a blank source", () => {
    expect(() => allocationAttributionHeaders(" ", {})).toThrow("source must be non-empty")
  })
})
