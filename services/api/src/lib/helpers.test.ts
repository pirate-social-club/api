import { describe, expect, test } from "bun:test"
import { genericDigitalGoodsEnabled } from "./helpers"

describe("generic digital goods writer flag", () => {
  test("fails closed when unset or false", () => {
    expect(genericDigitalGoodsEnabled({})).toBe(false)
    expect(genericDigitalGoodsEnabled({ GENERIC_DIGITAL_GOODS_ENABLED: "false" })).toBe(false)
  })

  test("accepts the shared env flag spellings", () => {
    for (const value of ["1", "true", "TRUE", "yes", "on"]) {
      expect(genericDigitalGoodsEnabled({ GENERIC_DIGITAL_GOODS_ENABLED: value })).toBe(true)
    }
  })
})
