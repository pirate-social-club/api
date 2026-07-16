import { afterEach, describe, expect, test } from "bun:test"
import { createClient, type Client } from "@libsql/client"
import type { Hex } from "viem"

import type { StorySettlementPlanResult } from "../../story/story-settlement-wallet-coordinator-do"
import { beginPurchaseSettlementEffectAttempt } from "./settlement-effects"
import {
  claimStorySettlementCoordinatorPlan,
  mirrorStorySettlementCoordinatorPlan,
} from "./story-settlement-coordinator-mirror"

const clients: Client[] = []
const PLAN_REF = `0x${"11".repeat(32)}` as Hex
const STEP_REF = `0x${"22".repeat(32)}` as Hex
const CALL_IDENTITY = `0x${"33".repeat(32)}` as Hex
const TX_HASH = `0x${"44".repeat(32)}` as Hex
const BLOCK_HASH = `0x${"55".repeat(32)}` as Hex

async function database(): Promise<Client> {
  const client = createClient({ url: ":memory:" })
  clients.push(client)
  await client.batch([
    `CREATE TABLE purchase_settlement_effects (
      purchase_settlement_effect_id TEXT PRIMARY KEY, community_id TEXT NOT NULL, quote_id TEXT NOT NULL,
      purchase_id TEXT NOT NULL, effect_kind TEXT NOT NULL, effect_key TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL, failure_disposition TEXT,
      broadcast_tx_ref TEXT, settlement_ref TEXT, provider_receipt_ref TEXT, tax_receipt_ref TEXT,
      metadata_json TEXT, failure_reason TEXT, coordinator_plan_ref TEXT, coordinator_state TEXT,
      coordinator_version INTEGER, reconciliation_reason TEXT, last_reconciled_at TEXT,
      finality_confirmed_at TEXT, attempt_count INTEGER NOT NULL DEFAULT 1, submitted_at TEXT,
      confirmed_at TEXT, failed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE purchase_settlement_transactions (
      purchase_settlement_transaction_id TEXT PRIMARY KEY, purchase_settlement_effect_id TEXT NOT NULL,
      step_key TEXT NOT NULL, step_kind TEXT NOT NULL, ordinal INTEGER NOT NULL,
      call_identity_hash TEXT NOT NULL, coordinator_step_ref TEXT NOT NULL UNIQUE, state TEXT NOT NULL,
      chain_id INTEGER, signer_address TEXT, nonce INTEGER, tx_hash TEXT, block_number INTEGER,
      block_hash TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, last_error_code TEXT,
      prepared_at TEXT, broadcast_at TEXT, mined_at TEXT, confirmed_at TEXT, updated_at TEXT NOT NULL
    )`,
  ])
  return client
}

afterEach(() => {
  for (const client of clients.splice(0)) client.close()
})

async function effect(client: Client) {
  return beginPurchaseSettlementEffectAttempt({
    client,
    communityId: "community_1",
    quoteId: "quote_1",
    purchaseId: "purchase_1",
    effectKind: "story_entitlement_mint",
    effectKey: "asset_1:7:0xbuyer",
    idempotencyKey: "quote_1:story_entitlement:asset_1:7:0xbuyer",
    now: "2026-07-16T10:00:00.000Z",
  })
}

function plan(version: number, state: "pending" | "confirmed", stepState: "broadcast" | "confirmed"): StorySettlementPlanResult {
  return {
    planRef: PLAN_REF,
    state,
    version,
    steps: [{
      stepRef: STEP_REF,
      callIdentity: CALL_IDENTITY,
      ordinal: 0,
      state: stepState,
      version,
      nonce: 19,
      transactionHash: TX_HASH,
      receipt: stepState === "confirmed"
        ? { status: "success", blockNumber: 123n, blockHash: BLOCK_HASH }
        : null,
      attemptCount: 2,
      repairState: null,
      lastErrorCode: null,
    }],
  }
}

describe("Story settlement coordinator shard mirror", () => {
  test("claims durable coordinator ownership before any remote admission is required", async () => {
    const client = await database()
    const row = await effect(client)
    await claimStorySettlementCoordinatorPlan({
      client,
      planRef: PLAN_REF,
      effects: [row],
      now: "2026-07-16T10:00:01.000Z",
    })
    const claimed = await client.execute("SELECT coordinator_plan_ref, coordinator_version, status FROM purchase_settlement_effects")
    expect(claimed.rows[0]).toMatchObject({
      coordinator_plan_ref: PLAN_REF,
      coordinator_version: 0,
      status: "submitted",
    })
  })

  test("mirrors confirmed finality and repairs a same-version transaction-write crash", async () => {
    const client = await database()
    const row = await effect(client)
    await claimStorySettlementCoordinatorPlan({ client, planRef: PLAN_REF, effects: [row], now: "2026-07-16T10:00:01.000Z" })
    const binding = { effect: { ...row, coordinator_plan_ref: PLAN_REF, coordinator_version: 0 }, steps: [{ callIdentity: CALL_IDENTITY, stepKind: "story_entitlement_mint" as const }] }
    const confirmed = plan(8, "confirmed", "confirmed")
    await mirrorStorySettlementCoordinatorPlan({
      client, chainId: 1315, signerAddress: "0x0000000000000000000000000000000000000001",
      plan: confirmed, bindings: [binding], now: "2026-07-16T10:02:00.000Z",
    })
    await client.execute("DELETE FROM purchase_settlement_transactions")
    await mirrorStorySettlementCoordinatorPlan({
      client, chainId: 1315, signerAddress: "0x0000000000000000000000000000000000000001",
      plan: confirmed, bindings: [binding], now: "2026-07-16T10:02:01.000Z",
    })

    const mirrored = await client.execute("SELECT status, coordinator_version, finality_confirmed_at, settlement_ref FROM purchase_settlement_effects")
    expect(mirrored.rows[0]).toMatchObject({ status: "confirmed", coordinator_version: 8, settlement_ref: TX_HASH })
    expect(mirrored.rows[0]?.finality_confirmed_at).toBeTruthy()
    const transactions = await client.execute("SELECT state, nonce, tx_hash, block_number, block_hash, attempt_count FROM purchase_settlement_transactions")
    expect(transactions.rows).toEqual([expect.objectContaining({
      state: "confirmed", nonce: 19, tx_hash: TX_HASH, block_number: 123, block_hash: BLOCK_HASH, attempt_count: 2,
    })])
  })

  test("an older coordinator observation cannot overwrite newer mirrored evidence", async () => {
    const client = await database()
    const row = await effect(client)
    await claimStorySettlementCoordinatorPlan({ client, planRef: PLAN_REF, effects: [row], now: "2026-07-16T10:00:01.000Z" })
    const binding = { effect: { ...row, coordinator_plan_ref: PLAN_REF, coordinator_version: 0 }, steps: [{ callIdentity: CALL_IDENTITY, stepKind: "story_entitlement_mint" as const }] }
    await mirrorStorySettlementCoordinatorPlan({
      client, chainId: 1315, signerAddress: "0x0000000000000000000000000000000000000001",
      plan: plan(8, "confirmed", "confirmed"), bindings: [binding], now: "2026-07-16T10:02:00.000Z",
    })
    await mirrorStorySettlementCoordinatorPlan({
      client, chainId: 1315, signerAddress: "0x0000000000000000000000000000000000000001",
      plan: plan(7, "pending", "broadcast"), bindings: [binding], now: "2026-07-16T10:03:00.000Z",
    })
    const effectRow = await client.execute("SELECT status, coordinator_version, settlement_ref FROM purchase_settlement_effects")
    expect(effectRow.rows[0]).toMatchObject({ status: "confirmed", coordinator_version: 8, settlement_ref: TX_HASH })
    const transaction = await client.execute("SELECT state, block_hash FROM purchase_settlement_transactions")
    expect(transaction.rows[0]).toMatchObject({ state: "confirmed", block_hash: BLOCK_HASH })
  })
})
