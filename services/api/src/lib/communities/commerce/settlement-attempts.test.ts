import { afterEach, describe, expect, test } from "bun:test"
import { createClient, type Client } from "@libsql/client"

import { reservePurchaseSettlementAttempt } from "./settlement-attempts"

const clients: Client[] = []

async function database(): Promise<Client> {
  const client = createClient({ url: ":memory:" })
  clients.push(client)
  await client.execute(`CREATE TABLE purchase_settlement_attempts (
    attempt_id TEXT PRIMARY KEY, quote_id TEXT NOT NULL UNIQUE, purchase_id TEXT NOT NULL,
    community_id TEXT NOT NULL, settlement_wallet_attachment_id TEXT NOT NULL,
    settlement_tx_ref TEXT, status TEXT NOT NULL, failure_reason TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`)
  return client
}

afterEach(() => {
  for (const client of clients.splice(0)) client.close()
})

const base = {
  communityId: "community_1",
  quoteId: "quote_1",
  purchaseId: "purchase_1",
  settlementWalletAttachmentId: "wallet_1",
  settlementTxRef: "0xfunding",
  now: "2026-07-17T12:00:00.000Z",
}

describe("purchase settlement attempt reservation", () => {
  test("a coordinator-owned attempt can re-enter without refreshing its legacy lease", async () => {
    const client = await database()
    await reservePurchaseSettlementAttempt({ ...base, client, coordinatorOwned: false })
    expect(await reservePurchaseSettlementAttempt({
      ...base,
      client,
      coordinatorOwned: true,
      now: "2026-07-17T12:01:00.000Z",
    })).toBe("reserved")
    const result = await client.execute("SELECT attempt_count, updated_at FROM purchase_settlement_attempts")
    expect(result.rows[0]).toMatchObject({ attempt_count: 1, updated_at: base.now })
  })

  test("a fresh legacy attempt remains fenced", async () => {
    const client = await database()
    await reservePurchaseSettlementAttempt({ ...base, client, coordinatorOwned: false })
    await expect(reservePurchaseSettlementAttempt({
      ...base,
      client,
      coordinatorOwned: false,
      now: "2026-07-17T12:01:00.000Z",
    })).rejects.toThrow("Purchase settlement is already in progress")
  })
})
