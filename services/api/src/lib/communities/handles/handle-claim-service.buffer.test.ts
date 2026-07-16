import { describe, expect, test } from "bun:test"
import { applyHandleClaimWrites } from "./handle-claim-service"
import { reserveCommunityHandleOnClient } from "./handle-reservation-service"
import type { Client } from "../../sql-client"

/**
 * Buffer-safety regression for reserveCommunityHandleOnClient. Under the D1 buffering
 * client a SELECT inside a write tx sees nothing until commit, so the namespace
 * policy + blocking-handle reads must run on the base client BEFORE the tx, the tx
 * body must be a single INSERT, and the created row is read back AFTER commit. The
 * recording client routes canned rows by SQL and records base vs in-tx statements;
 * the test fails if a read leaks into the tx.
 */
const POLICY_ROW = {
  community_id: "cmt_h",
  namespace_id: "ns_h",
  display_label: "Club",
  normalized_label: "club",
  route_family: null,
  namespace_handle_policy_id: "nhp_h",
  policy_template: "standard",
  pricing_model: null,
  claims_enabled: 1,
  claim_gate_mode: "none",
  claim_gate_expression_ref: null,
  claim_gate_expression_json: null,
  eligibility_timing: "claim_time",
  settings_json: null,
  updated_at: null,
}

const HANDLE_ROW = {
  community_handle_id: "ch_new",
  community_id: "cmt_h",
  user_id: "usr_h",
  namespace_id: "ns_h",
  label_normalized: "alice",
  label_display: "alice",
  status: "reserved",
  issuance_source: "admin_grant",
  price_cents: 0,
  currency: "USD",
  created_at: "2026-06-17T00:00:00.000Z",
  updated_at: "2026-06-17T00:00:00.000Z",
}

function recordingClient() {
  const baseSqls: string[] = []
  const txSqls: string[] = []
  const route = (sql: string) => {
    if (/namespace_bindings/i.test(sql)) return [POLICY_ROW]
    if (/community_handle_id\s*=\s*\?1/i.test(sql)) return [HANDLE_ROW] // post-commit readback
    if (/label_normalized/i.test(sql)) return [] // blocking-handle lookup → none
    return []
  }
  const client = {
    execute: async (statement: { sql: string } | string) => {
      const sql = typeof statement === "string" ? statement : statement.sql
      baseSqls.push(sql)
      return { rows: route(sql) }
    },
    transaction: async (_mode: "write" | "read") => ({
      execute: async (statement: { sql: string } | string) => {
        txSqls.push(typeof statement === "string" ? statement : statement.sql)
        return { rows: [] }
      },
      commit: async () => {},
      rollback: async () => {},
      close: () => {},
    }),
  } as unknown as Client
  return { client, baseSqls, txSqls }
}

const hasRead = (sqls: string[]) =>
  sqls.some((s) => /pragma/i.test(s)) || sqls.some((s) => /^\s*select\b/i.test(s))

describe("reserveCommunityHandleOnClient (buffer-safe)", () => {
  test("policy + blocking reads pre-tx; tx is INSERT-only; readback post-commit", async () => {
    const { client, baseSqls, txSqls } = recordingClient()
    const handle = await reserveCommunityHandleOnClient(client, {
      communityId: "cmt_h",
      userId: "usr_h",
      desired: { labelNormalized: "alice", labelDisplay: "alice" },
    })

    expect(handle).toBe(HANDLE_ROW)
    // The policy + blocking lookups ran on the base client (pre-tx).
    expect(baseSqls.some((s) => /namespace_bindings/i.test(s))).toBe(true)
    expect(baseSqls.some((s) => /label_normalized/i.test(s))).toBe(true)
    // No read leaked into the buffered tx; only the INSERT ran there.
    expect(hasRead(txSqls)).toBe(false)
    expect(txSqls.length).toBe(1)
    expect(txSqls[0]).toMatch(/insert\s+into\s+community_handles/i)
    // The readback ran on the base client after the tx.
    expect(baseSqls.some((s) => /community_handle_id\s*=\s*\?1/i.test(s))).toBe(true)
  })
})

const claimWritesInput = {
  communityId: "cmt_h",
  userId: "usr_h",
  quoteId: "hcq_1",
  namespaceId: "ns_h",
  namespaceNormalizedLabel: "club",
  labelNormalized: "alice",
  labelDisplay: "alice",
  priceCents: 0,
  pricingModel: null,
  pricingTier: null,
  settlementWalletAttachmentId: null,
  protocolOwnerWalletAttachmentId: null,
  fundingTxRef: null,
  settlementTxRef: null,
  protocolIssuanceRequired: false,
  protocolOwner: null,
  now: "2026-06-17T00:00:00.000Z",
}

describe("applyHandleClaimWrites (buffer-safe)", () => {
  test("tx body is write-only (INSERT handle + UPDATE quote); readback post-commit", async () => {
    const { client, baseSqls, txSqls } = recordingClient()
    const handle = await applyHandleClaimWrites(client, claimWritesInput)

    expect(handle).toBe(HANDLE_ROW)
    // No read leaked into the buffered tx.
    expect(hasRead(txSqls)).toBe(false)
    expect(txSqls.some((s) => /insert\s+into\s+community_handles/i.test(s))).toBe(true)
    expect(txSqls.some((s) => /update\s+community_handle_claim_quotes/i.test(s))).toBe(true)
    // No protocol issuance write when not required.
    expect(txSqls.some((s) => /community_handle_protocol_issuances/i.test(s))).toBe(false)
    // The hydrated readback ran on the base client AFTER the tx.
    expect(baseSqls.some((s) => /community_handle_id\s*=\s*\?1/i.test(s))).toBe(true)
  })

  test("protocol issuance required → tx also writes the issuance, still no in-tx read", async () => {
    const { client, txSqls } = recordingClient()
    await applyHandleClaimWrites(client, {
      ...claimWritesInput,
      protocolIssuanceRequired: true,
      protocolOwner: { walletAttachmentId: "wal_1", scriptPubkeyHex: "00aa" },
    })

    expect(hasRead(txSqls)).toBe(false)
    expect(txSqls.some((s) => /insert\s+into\s+community_handle_protocol_issuances/i.test(s))).toBe(true)
  })
})
