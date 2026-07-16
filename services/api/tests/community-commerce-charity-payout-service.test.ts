import { afterEach, describe, expect, test } from "bun:test"
import { createClient } from "@libsql/client"
import {
  executeCharityPayoutsForSettlement,
  setCommunityCommerceCharityPayoutExecutorForTests,
} from "../src/lib/communities/commerce/charity-payout-service"

afterEach(() => {
  setCommunityCommerceCharityPayoutExecutorForTests(null)
})

async function createSettlementClient() {
  const client = createClient({ url: ":memory:" })
  await client.execute(`
    CREATE TABLE donation_partners (
      donation_partner_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      provider_partner_ref TEXT,
      payout_destination_ref TEXT,
      review_status TEXT NOT NULL,
      status TEXT NOT NULL
    )
  `)
  await client.execute(`
    CREATE TABLE purchase_settlement_effects (
      purchase_settlement_effect_id TEXT PRIMARY KEY,
      community_id TEXT NOT NULL,
      quote_id TEXT NOT NULL,
      purchase_id TEXT NOT NULL,
      effect_kind TEXT NOT NULL,
      effect_key TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      failure_disposition TEXT,
      broadcast_tx_ref TEXT,
      settlement_ref TEXT,
      provider_receipt_ref TEXT,
      tax_receipt_ref TEXT,
      metadata_json TEXT,
      failure_reason TEXT,
      coordinator_plan_ref TEXT,
      coordinator_state TEXT,
      coordinator_version INTEGER,
      reconciliation_reason TEXT,
      last_reconciled_at TEXT,
      finality_confirmed_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      submitted_at TEXT,
      confirmed_at TEXT,
      failed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  await client.execute({
    sql: `
      INSERT INTO donation_partners (
        donation_partner_id, provider, provider_partner_ref, payout_destination_ref,
        review_status, status
      ) VALUES (
        'don_hp', 'endaoment', 'heal-palestine', '0x1111111111111111111111111111111111111111',
        'approved', 'active'
      )
    `,
    args: [],
  })
  return client
}

describe("community commerce charity payouts", () => {
  test("reuses confirmed payout effects on retry without executing provider twice", async () => {
    const client = await createSettlementClient()
    try {
      let callCount = 0
      setCommunityCommerceCharityPayoutExecutorForTests(async (input) => {
        callCount += 1
        expect(input.idempotencyKey).toBe("quo_abc:charity:don_hp:10")
        return {
          settlementRef: "endaoment:settlement:hp-1",
          providerReceiptRef: "endaoment:receipt:hp-1",
          taxReceiptRef: "endaoment:tax:hp-1",
        }
      })

      const allocation = {
        recipient_type: "charity" as const,
        recipient_ref: "don_hp",
        waterfall_position: 10,
        share_bps: 1000,
        amount_usd: 0.5,
        settlement_strategy: "provider_payout" as const,
      }
      const first = await executeCharityPayoutsForSettlement({
        env: {},
        client,
        communityId: "cmt_hp",
        quoteId: "quo_abc",
        purchaseId: "pur_abc",
        settlementToken: "WIP",
        allocations: [allocation],
        now: "2026-04-21T00:00:00.000Z",
      })
      const second = await executeCharityPayoutsForSettlement({
        env: {},
        client,
        communityId: "cmt_hp",
        quoteId: "quo_abc",
        purchaseId: "pur_abc",
        settlementToken: "WIP",
        allocations: [allocation],
        now: "2026-04-21T00:01:00.000Z",
      })

      expect(callCount).toBe(1)
      expect(first.get("charity:don_hp:10")?.settlementRef).toBe("endaoment:settlement:hp-1")
      expect(second.get("charity:don_hp:10")?.settlementRef).toBe("endaoment:settlement:hp-1")

      const effects = await client.execute("SELECT status, attempt_count, settlement_ref FROM purchase_settlement_effects")
      expect(effects.rows).toEqual([
        {
          status: "confirmed",
          attempt_count: 1,
          settlement_ref: "endaoment:settlement:hp-1",
        },
      ])
    } finally {
      client.close()
    }
  })
})
