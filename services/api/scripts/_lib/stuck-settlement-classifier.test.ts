import { describe, expect, test } from "bun:test"
import {
  classifyStuckSettlementEffect,
  isTransactionHash,
  selectSettlementTransactionHash,
} from "./stuck-settlement-classifier"
import { buildStuckEffectsSelect, parseArgs } from "../list-stuck-story-settlement-effects"

const HASH = `0x${"1".repeat(64)}`

describe("stuck settlement classifier", () => {
  test("prefers the provider receipt reference and normalizes blanks", () => {
    expect(selectSettlementTransactionHash({ settlementRef: HASH, providerReceiptRef: ` ${HASH} ` })).toBe(HASH)
    expect(selectSettlementTransactionHash({ settlementRef: " ", providerReceiptRef: null })).toBeNull()
  })

  test("rejects missing and malformed transaction references", () => {
    expect(classifyStuckSettlementEffect({ transactionHash: null })).toBe("ambiguous_no_transaction_reference")
    expect(classifyStuckSettlementEffect({ transactionHash: "0x1234" })).toBe("invalid_transaction_reference")
    expect(isTransactionHash(HASH)).toBe(true)
  })

  test("classifies successful and reverted receipts", () => {
    expect(classifyStuckSettlementEffect({
      transactionHash: HASH,
      evidence: { hash: HASH, transaction: null, receipt: { status: 1, blockNumber: 10, blockHash: HASH } },
    })).toBe("chain_confirmed_local_stuck")
    expect(classifyStuckSettlementEffect({
      transactionHash: HASH,
      evidence: { hash: HASH, transaction: null, receipt: { status: 0, blockNumber: 10, blockHash: HASH } },
    })).toBe("chain_reverted_local_stuck")
  })

  test("distinguishes pending from absent transactions without authorizing retry", () => {
    expect(classifyStuckSettlementEffect({
      transactionHash: HASH,
      evidence: { hash: HASH, receipt: null, transaction: { from: "0xabc", nonce: 7, blockNumber: null } },
    })).toBe("chain_pending")
    expect(classifyStuckSettlementEffect({
      transactionHash: HASH,
      evidence: { hash: HASH, receipt: null, transaction: null },
    })).toBe("chain_transaction_not_found")
  })

  test("builds a bounded read-only Story query", () => {
    const sql = buildStuckEffectsSelect({ cutoff: "2026-07-16T00:00:00.000Z", limit: 25 })
    expect(sql).toStartWith("SELECT ")
    expect(sql).toContain("status = 'submitted'")
    expect(sql).toContain("story_parent_royalty_vault_transfer")
    expect(sql).toContain("LIMIT 25")
    expect(sql).not.toMatch(/\b(?:UPDATE|INSERT|DELETE|REPLACE|DROP|ALTER)\b/)
  })

  test("defaults to staging and rejects unsafe environment names", () => {
    expect(parseArgs([]).env).toBe("staging")
    expect(() => parseArgs(["--env", "prod"])).toThrow("--env must be production or staging")
  })
})
