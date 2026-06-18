import { describe, expect, test } from "bun:test"
import { assertPurchaseQuoteConsumable } from "./settlement-service"

/**
 * Buffer-safety regression for the finalizeLocalPurchaseSettlement quote-consumption
 * guard. The blocker was a `quoteUpdate.rowsAffected === 0` branch INSIDE the write tx
 * (a buffered D1 write tx can't surface rowsAffected mid-flight). That branch is now a
 * pre-tx eligibility check on the authoritative quote status; the tx body is write-only
 * and idempotency is carried by the deterministic purchaseId + purchases PK. These
 * tests pin the exact consumable/​non-consumable decision the branch used to make.
 */
describe("assertPurchaseQuoteConsumable (settlement buffer-safety)", () => {
  test("allows an active quote (will be consumed by the conditional UPDATE)", () => {
    expect(() => assertPurchaseQuoteConsumable("active")).not.toThrow()
  })

  test("allows an already-consumed quote (idempotent re-settlement)", () => {
    expect(() => assertPurchaseQuoteConsumable("consumed")).not.toThrow()
  })

  test("rejects terminal states", () => {
    expect(() => assertPurchaseQuoteConsumable("expired")).toThrow(/could not be consumed/i)
    expect(() => assertPurchaseQuoteConsumable("failed")).toThrow(/could not be consumed/i)
  })

  test("rejects a missing quote (null / undefined status)", () => {
    expect(() => assertPurchaseQuoteConsumable(null)).toThrow(/could not be consumed/i)
    expect(() => assertPurchaseQuoteConsumable(undefined)).toThrow(/could not be consumed/i)
  })
})
