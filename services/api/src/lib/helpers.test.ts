import { describe, expect, test } from "bun:test"
import { genericDigitalGoodsEnabled } from "./helpers"

describe("generic digital goods writer flag", () => {
  test("fails closed when unset or false", () => {
    expect(genericDigitalGoodsEnabled({})).toBe(false)
    expect(genericDigitalGoodsEnabled({ GENERIC_DIGITAL_GOODS_ENABLED: "false" })).toBe(false)
  })

  test("accepts the shared env flag spellings only when enablement is attested", () => {
    for (const value of ["1", "true", "TRUE", "yes", "on"]) {
      expect(genericDigitalGoodsEnabled({
        GENERIC_DIGITAL_GOODS_ENABLED: value,
        GENERIC_DIGITAL_GOODS_ENABLEMENT_READY: "true",
        CONTENT_SOURCE_BROKER: {},
        CONTENT_SOURCE_BROKER_SHARED_SECRET: "fixture-broker-secret",
      })).toBe(true)
    }
  })

  test("fails closed when the attestation or broker configuration is incomplete", () => {
    const enabled = {
      GENERIC_DIGITAL_GOODS_ENABLED: "true",
      GENERIC_DIGITAL_GOODS_ENABLEMENT_READY: "true",
      CONTENT_SOURCE_BROKER: {},
      CONTENT_SOURCE_BROKER_SHARED_SECRET: "fixture-broker-secret",
    }

    expect(genericDigitalGoodsEnabled({ ...enabled, GENERIC_DIGITAL_GOODS_ENABLEMENT_READY: "false" })).toBe(false)
    expect(genericDigitalGoodsEnabled({ ...enabled, CONTENT_SOURCE_BROKER: undefined })).toBe(false)
    expect(genericDigitalGoodsEnabled({ ...enabled, CONTENT_SOURCE_BROKER_SHARED_SECRET: " " })).toBe(false)
  })
})
