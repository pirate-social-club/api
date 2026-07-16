import { afterEach, describe, expect, test } from "bun:test"
import { createClient, type Client } from "@libsql/client"
import {
  beginPurchaseSettlementEffectAttempt,
  failPurchaseSettlementEffect,
} from "./settlement-effects"

const clients: Client[] = []

async function createEffectClient(): Promise<Client> {
  const client = createClient({ url: ":memory:" })
  clients.push(client)
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
      attempt_count INTEGER NOT NULL DEFAULT 1,
      submitted_at TEXT,
      confirmed_at TEXT,
      failed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  return client
}

afterEach(() => {
  for (const client of clients.splice(0)) client.close()
})

function begin(client: Client, idempotencyKey: string, now: string) {
  return beginPurchaseSettlementEffectAttempt({
    client,
    communityId: "cmt_1",
    quoteId: "quo_1",
    purchaseId: "pur_1",
    effectKind: "story_parent_royalty_vault_transfer",
    effectKey: `asset_1:${idempotencyKey}`,
    idempotencyKey,
    now,
  })
}

describe("purchase settlement effect failure fencing", () => {
  test("creates coordinator-owned effects with the plan fence in the insert", async () => {
    const client = await createEffectClient()
    const planRef = `0x${"12".repeat(32)}`
    const created = await beginPurchaseSettlementEffectAttempt({
      client,
      communityId: "cmt_1",
      quoteId: "quo_1",
      purchaseId: "pur_1",
      effectKind: "story_royalty_payment",
      effectKey: "asset_1",
      idempotencyKey: "coordinator-owned",
      coordinatorPlanRef: planRef,
      now: "2026-07-16T00:00:00.000Z",
    })
    expect(created).toMatchObject({
      status: "submitted",
      coordinator_plan_ref: planRef,
      coordinator_state: "pending",
      coordinator_version: 0,
    })
  })

  test("only an explicit pre-broadcast failure is reclaimable", async () => {
    const client = await createEffectClient()
    await begin(client, "safe-retry", "2026-07-16T00:00:00.000Z")
    await failPurchaseSettlementEffect({
      client,
      idempotencyKey: "safe-retry",
      failureReason: "simulation reverted",
      disposition: "failed_prebroadcast",
      now: "2026-07-16T00:00:01.000Z",
    })

    await expect(begin(client, "safe-retry", "2026-07-16T00:05:00.000Z")).resolves.toMatchObject({
      status: "submitted",
      failure_disposition: null,
      attempt_count: 2,
    })
  })

  test("ambiguous and legacy failures remain reconciliation-only", async () => {
    const client = await createEffectClient()
    await begin(client, "ambiguous", "2026-07-16T00:00:00.000Z")
    const txHash = `0x${"ab".repeat(32)}`
    await failPurchaseSettlementEffect({
      client,
      idempotencyKey: "ambiguous",
      failureReason: "receipt timeout",
      broadcastTxRef: txHash,
      now: "2026-07-16T00:00:01.000Z",
    })

    await expect(begin(client, "ambiguous", "2026-07-16T00:05:00.000Z"))
      .rejects.toThrow("requires reconciliation")
    const row = await client.execute("SELECT failure_disposition, broadcast_tx_ref FROM purchase_settlement_effects")
    expect(row.rows[0]).toMatchObject({
      failure_disposition: "reconciliation_required",
      broadcast_tx_ref: txHash,
    })
  })
})
