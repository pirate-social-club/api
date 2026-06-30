import { describe, expect, test } from "bun:test"

import {
  BOOKING_REVIEW_SMOKE_USAGE,
  buildOperatorAuthorization,
  parseExpectedReviewVersion,
  parseLimit,
  parseReviewResolution,
} from "../scripts/smoke-booking-settlement-review"

describe("smoke-booking-settlement-review script guards", () => {
  test("documents safe list/get mode and explicit resolve mode", () => {
    expect(BOOKING_REVIEW_SMOKE_USAGE).toContain("list pending reviews")
    expect(BOOKING_REVIEW_SMOKE_USAGE).toContain("--resolve")
    expect(BOOKING_REVIEW_SMOKE_USAGE).toContain("--expected-review-version")
    expect(BOOKING_REVIEW_SMOKE_USAGE).toContain("PIRATE_BOOKING_SETTLEMENT_OPERATOR_CREDENTIAL")
  })

  test("builds operator authorization without accepting malformed credentials", () => {
    expect(buildOperatorAuthorization("opc_123.secret")).toBe("Operator opc_123.secret")
    expect(buildOperatorAuthorization("  opc_123.secret-token_1  ")).toBe("Operator opc_123.secret-token_1")
    expect(() => buildOperatorAuthorization("")).toThrow("operator credential")
    expect(() => buildOperatorAuthorization("Bearer token")).toThrow("operator credential")
    expect(() => buildOperatorAuthorization("opc_missing_secret")).toThrow("operator credential")
  })

  test("parses review resolutions", () => {
    expect(parseReviewResolution("completed")).toBe("completed")
    expect(parseReviewResolution("no_show_host")).toBe("no_show_host")
    expect(parseReviewResolution("no_show_booker")).toBe("no_show_booker")
    expect(() => parseReviewResolution("refunded")).toThrow("--resolution")
    expect(() => parseReviewResolution(null)).toThrow("--resolution")
  })

  test("parses expected review version CAS values", () => {
    expect(parseExpectedReviewVersion("0")).toBe(0)
    expect(parseExpectedReviewVersion("2")).toBe(2)
    expect(() => parseExpectedReviewVersion("-1")).toThrow("--expected-review-version")
    expect(() => parseExpectedReviewVersion("1.5")).toThrow("--expected-review-version")
    expect(() => parseExpectedReviewVersion(null)).toThrow("--expected-review-version")
  })

  test("parses optional list limit", () => {
    expect(parseLimit(null)).toBeNull()
    expect(parseLimit("1")).toBe(1)
    expect(parseLimit("100")).toBe(100)
    expect(() => parseLimit("0")).toThrow("--limit")
    expect(() => parseLimit("101")).toThrow("--limit")
    expect(() => parseLimit("1.5")).toThrow("--limit")
  })
})

