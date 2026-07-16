import { describe, expect, test } from "bun:test"
import {
  classifyStuckSettlementEffect,
  isTransactionHash,
  selectSettlementTransactionHash,
} from "./stuck-settlement-classifier"
import {
  assertExpectedChainId,
  buildStuckEffectsSelect,
  parseArgs,
  selectEffectTransactionHash,
} from "../list-stuck-story-settlement-effects"

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

  test("builds a bounded read-only funding and Story query", () => {
    const sql = buildStuckEffectsSelect({ cutoff: "2026-07-16T00:00:00.000Z", limit: 25 })
    expect(sql).toStartWith("SELECT ")
    expect(sql).toContain("status = 'submitted'")
    expect(sql).toContain("story_parent_royalty_vault_transfer")
    expect(sql).toContain("buyer_funding_receipt")
    expect(sql).toContain("effect_key")
    expect(sql).toContain("LIMIT 25")
    expect(sql).not.toMatch(/\b(?:UPDATE|INSERT|DELETE|REPLACE|DROP|ALTER)\b/)
  })

  test("uses the buyer-supplied funding hash before local confirmation exists", () => {
    expect(selectEffectTransactionHash({
      effect_kind: "buyer_funding_receipt",
      effect_key: ` ${HASH} `,
      settlement_ref: null,
      provider_receipt_ref: null,
    })).toBe(HASH)
    expect(selectEffectTransactionHash({
      effect_kind: "story_royalty_payment",
      effect_key: "royalty:asset",
      settlement_ref: HASH,
      provider_receipt_ref: null,
    })).toBe(HASH)
  })

  test("defaults to staging and rejects unsafe environment names", () => {
    expect(parseArgs([]).env).toBe("staging")
    expect(parseArgs([]).fundingChainId).toBe(84532)
    expect(parseArgs([]).storyChainId).toBe(1315)
    expect(() => parseArgs(["--env", "prod"])).toThrow("--env must be production or staging")
    expect(() => parseArgs(["--funding-chain-id", "base"])).toThrow("--funding-chain-id must be a positive integer")
  })

  test("fails closed when an RPC serves the wrong chain", () => {
    expect(() => assertExpectedChainId({ label: "funding", expectedChainId: 84532, actualChainId: 8453 }))
      .toThrow("funding_rpc_chain_mismatch:expected_84532:actual_8453")
    expect(() => assertExpectedChainId({ label: "story", expectedChainId: 1315, actualChainId: 1315 }))
      .not.toThrow()
  })
})
