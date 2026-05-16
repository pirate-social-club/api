import { describe, expect, test } from "bun:test"
import {
  derivePurchaseAllocationLegId,
  derivePurchaseEntitlementId,
  derivePurchaseIdForQuote,
} from "../src/lib/communities/commerce/purchase-settlement-ids"

describe("purchase settlement ids", () => {
  test("derives stable local purchase ids from quote ids", () => {
    expect(derivePurchaseIdForQuote("quo_abc123")).toBe("pur_abc123")
  })

  test("derives stable allocation leg ids from purchase ids and positions", () => {
    expect(derivePurchaseAllocationLegId("pur_abc123", 2)).toBe("pal_abc123_2")
  })

  test("derives stable entitlement ids from purchase ids", () => {
    expect(derivePurchaseEntitlementId("pur_abc123")).toBe("ent_abc123")
  })
})
