import { afterEach, describe, expect, test } from "bun:test"
import { createClient, type Client } from "@libsql/client"

import type { Env } from "../../../env"
import type { AssetRow } from "./row-types"
import { coordinateStorySettlement } from "./story-settlement-coordinator-service"

const clients: Client[] = []
const PRIVATE_KEY = `0x${"05".padStart(64, "0")}`

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

function asset(): AssetRow {
  return {
    asset_id: "asset_1",
    access_mode: "locked",
    story_ip_id: "0x0000000000000000000000000000000000000011",
    story_entitlement_token_id: "7",
    story_derivative_parent_ip_ids_json: "[]",
    story_royalty_policy: "0xBe54FB168b3c982b7AaE60dB6CF75Bd8447b390E",
    creator_user_id: "creator_1",
    display_title: "Sold video",
  } as unknown as AssetRow
}

function env(admissionEnabled: boolean): Env {
  const stub = {
    lookup: async () => null,
    admit: async () => { throw new Error("coordinator RPC timeout") },
  }
  return {
    STORY_CHAIN_ID: "1315",
    STORY_SETTLEMENT_COORDINATOR_ADMISSION_ENABLED: admissionEnabled ? "true" : "false",
    STORY_SETTLEMENT_COORDINATOR_ADMISSION_COMMUNITY_IDS: "community_1",
    STORY_SETTLEMENT_FEE_POLICY_VERSION: "aeneid-fees-v1",
    STORY_SETTLEMENT_FINALITY_POLICY_VERSION: "aeneid-finality-v1",
    STORY_COORDINATOR_SIGNER_PRIVATE_KEY: PRIVATE_KEY,
    STORY_SETTLEMENT_WALLET_COORDINATOR: {
      getByName: () => stub,
    } as unknown as Env["STORY_SETTLEMENT_WALLET_COORDINATOR"],
  } as Env
}

describe("Story settlement coordinator admission fence", () => {
  test("an uncertain admission stays pending after every effect durably claims the plan", async () => {
    const client = await database()
    const result = await coordinateStorySettlement({
      env: env(true),
      client,
      communityId: "community_1",
      quoteId: "quote_1",
      purchaseId: "purchase_1",
      asset: asset(),
      buyerAddress: "0x0000000000000000000000000000000000000022",
      purchaseRef: `0x${"66".repeat(32)}`,
      amount: 100n,
      now: "2026-07-16T12:00:00.000Z",
    })
    expect(result.kind).toBe("pending")
    const effects = await client.execute("SELECT status, coordinator_plan_ref, coordinator_version FROM purchase_settlement_effects ORDER BY effect_kind")
    expect(effects.rows).toHaveLength(2)
    expect(effects.rows.every((row) => row.status === "submitted")).toBe(true)
    const refs = new Set(effects.rows.map((row) => row.coordinator_plan_ref))
    expect(refs.size).toBe(1)
    expect([...refs][0]).toBe(result.kind === "pending" ? result.planRef : null)
    expect(effects.rows.every((row) => row.coordinator_version === 0)).toBe(true)
  })

  test("disabling new admission cannot release an already claimed effect to legacy execution", async () => {
    const client = await database()
    const request = {
      client,
      communityId: "community_1",
      quoteId: "quote_1",
      purchaseId: "purchase_1",
      asset: asset(),
      buyerAddress: "0x0000000000000000000000000000000000000022",
      purchaseRef: `0x${"66".repeat(32)}` as const,
      amount: 100n,
      now: "2026-07-16T12:00:00.000Z",
    }
    await coordinateStorySettlement({ ...request, env: env(true) })
    const retry = await coordinateStorySettlement({ ...request, env: env(false), now: "2026-07-16T12:01:00.000Z" })
    expect(retry.kind).toBe("pending")
    const effects = await client.execute("SELECT status, coordinator_plan_ref FROM purchase_settlement_effects")
    expect(effects.rows.every((row) => row.status === "submitted" && Boolean(row.coordinator_plan_ref))).toBe(true)
  })

  test("an enabled flag does not admit a community outside the allowlist", async () => {
    const client = await database()
    const result = await coordinateStorySettlement({
      env: env(true),
      client,
      communityId: "community_2",
      quoteId: "quote_1",
      purchaseId: "purchase_1",
      asset: asset(),
      buyerAddress: "0x0000000000000000000000000000000000000022",
      purchaseRef: `0x${"66".repeat(32)}`,
      amount: 100n,
      now: "2026-07-16T12:00:00.000Z",
    })
    expect(result.kind).toBe("not_coordinator_owned")
    const effects = await client.execute("SELECT coordinator_plan_ref FROM purchase_settlement_effects")
    expect(effects.rows).toHaveLength(0)
  })
})
