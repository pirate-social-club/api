import { describe, expect, test } from "bun:test"

import {
  normalizeIdentityCountryAlpha2,
  normalizeIdentityCountryCode,
  normalizeIdentityCountryCodes,
} from "../src/lib/identity/country-codes"

describe("identity country code normalization", () => {
  test.each(["XK", "XKK", "KS", "RKS", "XKX", " rks "]) (
    "normalizes Kosovo document code %s to the stored policy value",
    (value) => {
      expect(normalizeIdentityCountryCode(value)).toBe("XKK")
    },
  )

  test.each(["XK", "XKK", "KS", "RKS", "XKX"]) (
    "normalizes Kosovo document code %s to the public alpha-2 value",
    (value) => {
      expect(normalizeIdentityCountryAlpha2(value)).toBe("XK")
    },
  )

  test("deduplicates Kosovo aliases in allowlists", () => {
    expect(normalizeIdentityCountryCodes(["XK", "RKS", "XKK"])).toEqual(["XKK"])
  })

  test("continues rejecting unknown country codes", () => {
    expect(normalizeIdentityCountryCode("ZZZ")).toBeNull()
    expect(normalizeIdentityCountryAlpha2("ZZZ")).toBeNull()
  })
})
