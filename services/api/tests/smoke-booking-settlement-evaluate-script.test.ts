import { describe, expect, test } from "bun:test";

import {
  BOOKING_SETTLEMENT_EVALUATE_SMOKE_USAGE,
  parseExpectedOutcome,
} from "../scripts/smoke-booking-settlement-evaluate";

describe("smoke-booking-settlement-evaluate script guards", () => {
  test("documents fail-closed one-booking evaluation", () => {
    expect(BOOKING_SETTLEMENT_EVALUATE_SMOKE_USAGE).toContain("--booking-id");
    expect(BOOKING_SETTLEMENT_EVALUATE_SMOKE_USAGE).toContain("--expect-outcome");
    expect(BOOKING_SETTLEMENT_EVALUATE_SMOKE_USAGE).toContain("--now-from-slot-end");
    expect(BOOKING_SETTLEMENT_EVALUATE_SMOKE_USAGE).toContain("--allow-money-movement");
    expect(BOOKING_SETTLEMENT_EVALUATE_SMOKE_USAGE).toContain("Defaults to expect an ambiguous outcome");
  });

  test("defaults to ambiguous and rejects unknown expected outcomes", () => {
    expect(parseExpectedOutcome(null)).toBe("ambiguous");
    expect(parseExpectedOutcome("ambiguous")).toBe("ambiguous");
    expect(parseExpectedOutcome("completed")).toBe("completed");
    expect(parseExpectedOutcome("no_show_host")).toBe("no_show_host");
    expect(parseExpectedOutcome("no_show_booker")).toBe("no_show_booker");
    expect(() => parseExpectedOutcome("settled")).toThrow("--expect-outcome");
  });
});
