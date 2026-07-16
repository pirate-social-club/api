import { afterEach, describe, expect, test } from "bun:test"
import { createClient, type Client } from "@libsql/client"
import { confirmBuyerFundingForSettlement, type BuyerFundingReceipt } from "./funding-proof-service"

// Regression: a buyer funding tx must be single-use across quotes. Use the real
// effect store here: mock.module is process-global in Bun and previously replaced
// settlement-effects underneath its own tests when the full unit suite ran.

const RECEIPT: BuyerFundingReceipt = {
  txRef: "0xtx",
  fromAddress: "0xfrom",
  toAddress: "0xto",
  tokenAddress: "0xtoken",
  amountAtomic: "1000000",
  chainRef: "eip155:1",
}

const clients: Client[] = []

async function createFundingClient(input: { quoteId: string }): Promise<Client> {
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
      attempt_count INTEGER NOT NULL DEFAULT 1,
      submitted_at TEXT,
      confirmed_at TEXT,
      failed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  await client.execute(`
    CREATE TABLE purchase_quotes (
      quote_id TEXT PRIMARY KEY,
      community_id TEXT NOT NULL,
      status TEXT NOT NULL,
      funding_locked_at TEXT,
      updated_at TEXT NOT NULL
    )
  `)
  await client.execute({
    sql: "INSERT INTO purchase_quotes (quote_id, community_id, status, updated_at) VALUES (?1, 'cmt_1', 'active', ?2)",
    args: [input.quoteId, "2026-07-02T00:00:00.000Z"],
  })
  return client
}

async function insertConfirmedFundingEffect(input: { client: Client; quoteId: string }): Promise<void> {
  await input.client.execute({
    sql: `
      INSERT INTO purchase_settlement_effects (
        purchase_settlement_effect_id, community_id, quote_id, purchase_id,
        effect_kind, effect_key, idempotency_key, status, metadata_json,
        attempt_count, submitted_at, confirmed_at, created_at, updated_at
      ) VALUES (
        ?1, 'cmt_1', ?2, 'pur_1', 'buyer_funding_receipt', ?3,
        ?4, 'confirmed', ?5, 1, ?6, ?6, ?6, ?6
      )
    `,
    args: [
      `pse_${input.quoteId}`,
      input.quoteId,
      RECEIPT.txRef,
      `${input.quoteId}:buyer_funding:${RECEIPT.txRef}`,
      JSON.stringify(RECEIPT),
      "2026-07-02T00:00:00.000Z",
    ],
  })
}

afterEach(() => {
  for (const client of clients.splice(0)) client.close()
})

function settle(client: Client, quoteId: string) {
  return confirmBuyerFundingForSettlement({
    env: {} as never,
    client,
    communityId: "cmt_1",
    quote: { quote_id: quoteId } as never,
    purchaseId: "pur_1",
    buyerAddress: "0xbuyer",
    fundingTxRef: RECEIPT.txRef,
    now: "2026-07-02T00:05:00.000Z",
  })
}

describe("confirmBuyerFundingForSettlement — funding tx single-use", () => {
  test("rejects a funding tx already confirmed for a different quote", async () => {
    const client = await createFundingClient({ quoteId: "quote_mine" })
    await insertConfirmedFundingEffect({ client, quoteId: "quote_other" })

    await expect(settle(client, "quote_mine")).rejects.toThrow(/already been used/)
  })

  test("allows the same quote idempotently and freezes its expiry", async () => {
    const client = await createFundingClient({ quoteId: "quote_mine" })
    await insertConfirmedFundingEffect({ client, quoteId: "quote_mine" })

    await expect(settle(client, "quote_mine")).resolves.toMatchObject({ txRef: RECEIPT.txRef })
    const quote = await client.execute("SELECT funding_locked_at FROM purchase_quotes WHERE quote_id = 'quote_mine'")
    expect(quote.rows[0]?.funding_locked_at).toBe("2026-07-02T00:05:00.000Z")
  })
})
