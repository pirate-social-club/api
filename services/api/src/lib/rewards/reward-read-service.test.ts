import { describe, expect, test } from "bun:test"

import { summarizePendingProviderRows } from "./reward-read-service"

describe("reward pending provider summary", () => {
  test("aggregates multiple required providers without using an active cashout identity", () => {
    expect(summarizePendingProviderRows([
      {
        provider: "self",
        pending_count: 2,
        conditional_cents: 70,
        earliest_expires_at: "2026-08-15T10:00:00.000Z",
      },
      {
        provider: "very",
        pending_count: 1,
        conditional_cents: 100,
        earliest_expires_at: "2026-08-14T10:00:00.000Z",
      },
      {
        provider: "zkpassport",
        pending_count: 1,
        conditional_cents: 40,
        earliest_expires_at: null,
      },
    ])).toEqual({
      count: 4,
      conditional_cents: 210,
      earliest_expires_at: 1_786_701_600,
      provider_requirements: [
        {
          provider: "self",
          count: 2,
          conditional_cents: 70,
          earliest_expires_at: 1_786_788_000,
        },
        {
          provider: "very",
          count: 1,
          conditional_cents: 100,
          earliest_expires_at: 1_786_701_600,
        },
        {
          provider: "zkpassport",
          count: 1,
          conditional_cents: 40,
          earliest_expires_at: null,
        },
      ],
    })
  })
})
