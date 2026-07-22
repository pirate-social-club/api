import { describe, expect, test } from "bun:test"
import { parseListLimit } from "./list-limit"

// Regression: an absent `limit` query param arrives as null/undefined/"" and
// Number("") is 0 — a finite value — so the previous `Number(value ?? "")` +
// Number.isFinite guard never reached its default and the clamp floored every
// unparameterized list read to a single item.
const ABSENT_VALUES: Array<string | null | undefined> = [undefined, null, "", "   "]

// One case per production call site, so the shared parser covers the two that
// remain inline in route handlers.
const CALL_SITES = [
  { name: "comment lists/replies/context", options: { fallback: 25, max: 100 } },
  { name: "profile activity", options: { fallback: 20, max: 50 } },
  { name: "notifications feed", options: { fallback: 25, max: 100 } },
  { name: "community membership requests", options: { fallback: 25, max: 100 } },
]

describe("parseListLimit", () => {
  for (const callSite of CALL_SITES) {
    describe(callSite.name, () => {
      test("returns the default when the limit is absent or blank", () => {
        for (const value of ABSENT_VALUES) {
          expect(parseListLimit(value, callSite.options)).toBe(callSite.options.fallback)
        }
      })

      test("returns the default when the limit is not a number", () => {
        expect(parseListLimit("abc", callSite.options)).toBe(callSite.options.fallback)
        expect(parseListLimit("NaN", callSite.options)).toBe(callSite.options.fallback)
        expect(parseListLimit("Infinity", callSite.options)).toBe(callSite.options.fallback)
      })

      test("never returns fewer than one item", () => {
        expect(parseListLimit("0", callSite.options)).toBe(1)
        expect(parseListLimit("-5", callSite.options)).toBe(1)
      })

      test("clamps to the maximum", () => {
        expect(parseListLimit("100000", callSite.options)).toBe(callSite.options.max)
      })

      test("honours an explicit in-range limit", () => {
        expect(parseListLimit("7", callSite.options)).toBe(7)
        expect(parseListLimit(" 7 ", callSite.options)).toBe(7)
        expect(parseListLimit("7.9", callSite.options)).toBe(7)
      })
    })
  }

  test("respects a custom minimum", () => {
    expect(parseListLimit("0", { fallback: 25, max: 100, min: 5 })).toBe(5)
  })
})
