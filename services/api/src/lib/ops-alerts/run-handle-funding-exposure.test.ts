import { describe, expect, it } from "bun:test"

import { buildLegacyHandleFundingExposureAlert } from "./run"

describe("legacy paid-handle exposure alert", () => {
  it("fires on the first legacy handle receipt", () => {
    expect(buildLegacyHandleFundingExposureAlert({
      row: {
        receipt_count: 1,
        first_seen: "2026-08-13T10:00:00.000Z",
        last_seen: "2026-08-13T10:00:00.000Z",
      },
    })).toEqual({
      key: "legacy_handle_funding_exposure",
      severity: "high",
      title: "A paid handle claim used the legacy funding path",
      count: 1,
      community_ids: [],
      details: {
        first_seen: "2026-08-13T10:00:00.000Z",
        last_seen: "2026-08-13T10:00:00.000Z",
      },
    })
  })

  it("stays quiet with an empty legacy rail", () => {
    expect(buildLegacyHandleFundingExposureAlert({
      row: { receipt_count: 0 },
    })).toBeNull()
  })
})
