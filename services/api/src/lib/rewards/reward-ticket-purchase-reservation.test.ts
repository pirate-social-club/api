import { describe, expect, test } from "bun:test"

import type { Client, InStatement, QueryResult, Transaction } from "../sql-client"
import { reserveRewardTicketPurchase } from "./reward-ticket-purchase-reservation"

const drawingRow = (commitmentStatus: string) => ({
  reward_ticket_pool_drawing_id: "rtd_1",
  reward_ticket_pool_id: "rtp_1",
  status: "commit_pending",
  commitment_batch_id: "rtcb_1",
  commitment_status: commitmentStatus,
  pool_status: "active",
  funded_cents: "100",
  reserved_cents: "0",
  fulfilled_cents: "0",
  refunded_cents: "0",
})

function fakeClient(commitmentStatus: string): { client: Client; statements: string[]; rolledBack: boolean } {
  const statements: string[] = []
  let rolledBack = false
  const tx: Transaction = {
    async execute(statement: InStatement | string): Promise<QueryResult> {
      const sql = typeof statement === "string" ? statement : statement.sql
      statements.push(sql)
      if (sql.includes("FROM reward_ticket_purchase_effects")) return { rows: [] }
      if (sql.includes("FROM reward_ticket_pool_drawings")) return { rows: [drawingRow(commitmentStatus)] }
      return { rows: [], rowsAffected: 1 }
    },
    async batch(): Promise<QueryResult[]> { return [] },
    async commit(): Promise<void> {},
    async rollback(): Promise<void> { rolledBack = true },
    close(): void {},
  }
  const client = {
    async execute(): Promise<QueryResult> { return { rows: [] } },
    async batch(): Promise<QueryResult[]> { return [] },
    async transaction(): Promise<Transaction> { return tx },
  } as Client
  return { client, statements, get rolledBack() { return rolledBack } }
}

const input = {
  poolDrawingId: "rtd_1",
  idempotencyKey: "purchase:rtd_1",
  expectedTicketCount: 1,
  reservedCents: "100",
  recipientAddress: "0x2000000000000000000000000000000000000002",
  priceQuoteId: "quote_1",
  now: "2026-08-13T23:01:00.000Z",
}

describe("reward ticket purchase reservation commitment gate", () => {
  test("refuses purchase_pending when the commitment is not published", async () => {
    const fake = fakeClient("pending")
    await expect(reserveRewardTicketPurchase({ ...input, client: fake.client })).rejects
      .toThrow("reward ticket beneficiary commitment is not published")
    expect(fake.rolledBack).toBe(true)
    expect(fake.statements.some((sql) => sql.includes("INSERT INTO reward_ticket_purchase_effects"))).toBe(false)
  })

  test("allows the reservation only after a published commitment", async () => {
    const fake = fakeClient("published")
    const reservation = await reserveRewardTicketPurchase({ ...input, client: fake.client })
    expect(reservation).toMatchObject({
      poolDrawingId: "rtd_1",
      status: "reserved",
      reservedCents: "100",
    })
    expect(fake.statements.some((sql) => sql.includes("INSERT INTO reward_ticket_purchase_effects"))).toBe(true)
    expect(fake.statements.some((sql) => sql.includes("status = 'purchase_pending'"))).toBe(true)
  })
})
