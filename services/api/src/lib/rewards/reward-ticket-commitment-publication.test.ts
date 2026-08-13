import { describe, expect, test } from "bun:test"

import type { Client, InStatement, QueryResult, Transaction } from "../sql-client"
import { publishRewardTicketCommitment } from "./reward-ticket-commitment-publication"

function fakeClient(status: string, drawingStatus = "commit_pending") {
  const statements: string[] = []
  let committed = false
  let rolledBack = false
  const tx: Transaction = {
    async execute(statement: InStatement | string): Promise<QueryResult> {
      const sql = typeof statement === "string" ? statement : statement.sql
      statements.push(sql)
      if (sql.includes("FROM reward_ticket_beneficiary_commitment_batches")) {
        return {
          rows: [{
            reward_ticket_beneficiary_commitment_batch_id: "rtcb_1",
            status,
            publication_reference: status === "published" ? "beacon:141" : null,
            publication_tx_hash: status === "published" ? "0x" + "1".repeat(64) : null,
            publication_block_number: status === "published" ? "77" : null,
            published_at: status === "published" ? "2026-08-13T23:02:00.000Z" : null,
            reward_ticket_pool_drawing_id: "rtd_1",
            drawing_status: drawingStatus,
          }],
        }
      }
      return { rows: [], rowsAffected: 1 }
    },
    async batch(): Promise<QueryResult[]> { return [] },
    async commit(): Promise<void> { committed = true },
    async rollback(): Promise<void> { rolledBack = true },
    close(): void {},
  }
  return {
    statements,
    client: {
      async execute(): Promise<QueryResult> { return { rows: [] } },
      async batch(): Promise<QueryResult[]> { return [] },
      async transaction(): Promise<Transaction> { return tx },
    } as Client,
    get committed() { return committed },
    get rolledBack() { return rolledBack },
  }
}

const input = {
  commitmentBatchId: "rtcb_1",
  publicationReference: "beacon:141",
  publicationTxHash: "0x" + "2".repeat(64),
  publicationBlockNumber: 88,
  publishedAt: "2026-08-13T23:02:00.000Z",
}

describe("reward ticket commitment publication", () => {
  test("publishes pending evidence and records committed_at", async () => {
    const fake = fakeClient("pending")
    const result = await publishRewardTicketCommitment({ ...input, client: fake.client })
    expect(result).toMatchObject({
      commitmentBatchId: "rtcb_1",
      status: "published",
      publicationReference: "beacon:141",
      publicationBlockNumber: "88",
    })
    expect(fake.statements.some((sql) => sql.includes("status = 'published'"))).toBe(true)
    expect(fake.statements.some((sql) => sql.includes("SET committed_at"))).toBe(true)
    expect(fake.committed).toBe(true)
  })

  test("is idempotent for an already-published batch", async () => {
    const fake = fakeClient("published")
    const result = await publishRewardTicketCommitment({ ...input, client: fake.client })
    expect(result).toMatchObject({
      commitmentBatchId: "rtcb_1",
      status: "published",
      publicationReference: "beacon:141",
      publicationBlockNumber: "77",
    })
    expect(fake.statements.some((sql) => sql.includes("UPDATE reward_ticket_beneficiary_commitment_batches"))).toBe(false)
  })

  test("fails closed for terminal or out-of-order publication", async () => {
    const terminal = fakeClient("failed")
    await expect(publishRewardTicketCommitment({ ...input, client: terminal.client })).rejects
      .toThrow("cannot publish from failed")
    expect(terminal.rolledBack).toBe(true)

    const wrongDrawing = fakeClient("pending", "entry_open")
    await expect(publishRewardTicketCommitment({ ...input, client: wrongDrawing.client })).rejects
      .toThrow("not awaiting publication")
  })

  test("rejects malformed publication evidence before opening a transaction", async () => {
    const fake = fakeClient("pending")
    await expect(publishRewardTicketCommitment({
      ...input,
      publicationTxHash: "not-a-hash",
      client: fake.client,
    })).rejects.toThrow("transaction hash is invalid")
    expect(fake.statements).toHaveLength(0)
  })
})
